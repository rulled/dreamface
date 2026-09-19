import { compactRaw, createTraceWriter } from './trace.js';
import { DEFAULT_FEATURES, mergeFeatures } from './features.js';
import {
  ACCOUNT_RETRY_DELAY_MS,
  AUTO_RESUME_MAX_DELAY_MS,
  accountTier,
  autoResumeDelayMs,
  estimatePlan,
  fastestMsPerWork,
  ipBackoffTriggered,
  orderUnitsForDispatch,
  rankCandidates,
  shouldAutoResume,
  simulatePlan,
  summarizePlan,
} from './queue-policy.js';
import {
  createAccountHealth,
  describeBlocked,
  describeQuota,
  isBlocked,
  ledgerQuota,
  markQuotaUnreliable,
  noteDrain,
  normalizeHealthMap,
  noteQuota,
  pruneHealthMap,
  quotaExhausted,
  quotaLedgerUsable,
  quotaUnlimited,
  recordBulkRejection,
  recordBulkSuccess,
} from './account-health.js';

const RUN_DB_NAME = 'dreamface-run-db';
const RUN_DB_VERSION = 4;
const RUN_STORE_NAME = 'audioTasks';
const INPUT_STORE_NAME = 'inputFiles';
const ENGINE_STATUS_PREFIX = '[engine]';
const MP3_MIME = 'audio/mpeg';
const CREATIONS_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_DURATION_SECONDS = 2;
const DEFAULT_MAX_DURATION_SECONDS = 180;
const OVERLAP_SECONDS = 5;
const TRANSIENT_TASK_RETRY_LIMIT = 2;
const TRANSIENT_TASK_RETRY_BASE_DELAY_MS = 5000;
const BULK_WATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TERMINAL_WATCH_STATUSES = new Set([
  'complete', 'failed', 'cancelled', 'rejected', 'submission_failed', 'submission_cancelled',
]);

let ffmpeg = null;
let ffmpegLoadPromise = null;
let mediaTransformModulePromise = null;
let runState = createIdleRunState();
let currentRunToken = 0;
let stopRequested = false;
let bulkWatcherPromise = null;
let dreamFaceApiModulePromise = null;
let initializationError = null;
let initializationRetryPromise = null;
const accountMutationLocks = new Map();
let runAdmissionToken = null;
// per-run cache of the account's template + SCRIPT preset (see the connect block in the attempt)
const runConnectCache = new Map();
// accounts whose subscription counter proved wrong during this run (rejection it cannot explain)
const runUntrusted = new Set();
// rejections seen this run, for the shared-IP pause
const runRejections = [];
// how many quota-only waits this run already scheduled (30 min, then hourly)
let quotaWaitCount = 0;
// accounts measured by the last probe round, used to preview the plan without new calls
let lastProbeSnapshot = [];
const processedBlobLeases = new Map();

// Phase 0 instrumentation (read-only) plus the per-phase feature gates. Flags live in
// chrome.storage, which offscreen documents cannot reach, so they are read through the
// background and merged against defaults here.
const phase0 = createTraceWriter();
let featureFlags = { ...DEFAULT_FEATURES };

function featureEnabled(name) {
  return featureFlags[name] === true;
}

void (async () => {
  try {
    const response = await callBackground('dfGetFeatures');
    featureFlags = mergeFeatures(response?.features);
  } catch (_) {
    featureFlags = { ...DEFAULT_FEATURES };
  }
  phase0.setEnabled(featureFlags.phase0Trace !== false);
  phase0.record({ type: 'features', ...featureFlags });
})();

// ---------------------------------------------------------------- account health (phase 1)
const accountHealthCache = new Map();
let accountHealthLoaded = false;

function getAccountHealth(accountId) {
  return accountHealthCache.get(String(accountId)) || createAccountHealth();
}

async function loadAccountHealth(accounts = []) {
  if (!featureEnabled('accountHealth') || accountHealthLoaded) return;
  accountHealthLoaded = true;
  try {
    const response = await callBackground('dfGetAccountHealth');
    const pruned = pruneHealthMap(normalizeHealthMap(response?.health), {
      accountIds: accounts.map((item) => String(item?.accountId || '')).filter(Boolean),
    });
    accountHealthCache.clear();
    for (const [accountId, health] of Object.entries(pruned)) accountHealthCache.set(accountId, health);
  } catch (_) {
    // health is an optimization: never block a run because it could not be loaded
  }
}

async function persistAccountHealth(accountId) {
  if (!featureEnabled('accountHealth')) return;
  const health = accountHealthCache.get(String(accountId));
  if (!health) return;
  await callBackground('dfPatchAccountHealth', { accountId: String(accountId), health }).catch(() => {});
}

function noteAccountDrain(accountId, options = {}) {
  if (!featureEnabled('accountHealth') || !accountId) return null;
  const id = String(accountId);
  const health = noteDrain(accountHealthCache.get(id), options);
  accountHealthCache.set(id, health);
  void persistAccountHealth(id);
  return health;
}

function noteAccountSuccess(accountId, tier = '', quota = null) {
  if (!featureEnabled('accountHealth') || !accountId) return;
  const id = String(accountId);
  accountHealthCache.set(id, recordBulkSuccess(accountHealthCache.get(id), { tier, quota }));
  void persistAccountHealth(id);
}

async function noteAccountRejection(accountId, options = {}) {
  if (!featureEnabled('accountHealth') || !accountId) return null;
  const id = String(accountId);
  const health = recordBulkRejection(accountHealthCache.get(id), options);
  accountHealthCache.set(id, health);
  await persistAccountHealth(id);
  return health;
}

// The submission quota is the only rejection signal phase 2 found actionable: "Account Limit
// Reached" arrives exactly when get_batch_times reports remaining = 0, and the same account
// accepts batches again once the counter recovers. Recording every reading makes the recovery
// (an increase) its own trace event, which is how the quota period gets measured.
function noteAccountQuota(accountId, quota) {
  if (!featureEnabled('accountHealth') || !accountId || !quota) return null;
  const id = String(accountId);
  const { health, reset, previous } = noteQuota(accountHealthCache.get(id), quota);
  accountHealthCache.set(id, health);
  const changed = reset
    || previous.total !== health.quota.total
    || previous.remaining !== health.quota.remaining;
  if (reset) {
    phase0.record({
      type: 'quota_reset',
      accountId: id,
      tier: health.tier,
      from: Number(previous.remaining || 0),
      to: Number(health.quota.remaining || 0),
      total: Number(health.quota.total || 0),
      sinceMs: previous.at ? Math.max(0, Date.now() - previous.at) : 0,
    });
  }
  if (changed) void persistAccountHealth(id);
  return health;
}

let autoResumeTimer = null;

function scheduleAutoResume(delayMs) {
  if (!featureEnabled('accountHealth')) return 0;
  if (autoResumeTimer) {
    clearTimeout(autoResumeTimer);
    autoResumeTimer = null;
  }
  const delay = Math.max(5000, Math.min(Number(delayMs) || ACCOUNT_RETRY_DELAY_MS, AUTO_RESUME_MAX_DELAY_MS));
  autoResumeTimer = setTimeout(() => {
    autoResumeTimer = null;
    if (isBusyPhase(runState.phase)) return;
    // A timer must not resurrect a queue the operator stopped, nor a legacy one.
    if (!shouldAutoResume(runState, { stopRequested })) return;
    const token = acquireRunAdmission();
    if (!token) return;
    runState.warnings = [...runState.warnings, `авто-возобновление очереди через ${Math.round(delay / 1000)} с`];
    void resumeRun({}, token).catch(() => releaseRunAdmission(token));
  }, delay);
  return delay;
}

async function phase0ProbeRunning(accountId, phase, principalKey = '') {
  if (!accountId) return;
  try {
    const binding = await getAccountBinding(accountId, principalKey);
    const [running, quota] = await Promise.all([
      binding.client.getRunningWorks(),
      binding.client.getBatchTimes().catch(() => null),
    ]);
    const ids = Array.isArray(running?.workIds) ? running.workIds.map(String) : [];
    if (quota) {
      noteAccountQuota(accountId, quota);
      refreshProbeCache(accountId, { runningWorks: { workIds: ids }, quota });
    }
    phase0.record({ type: 'running_probe', accountId, phase, count: ids.length, ids, quota });
  } catch (error) {
    phase0.record({ type: 'running_probe', accountId, phase, error: error?.message || String(error) });
  }
}

async function phase0RecordRunEnd(reason = '') {
  phase0.record({
    type: 'run_end',
    phase: runState.phase,
    reason: reason || runState.interruptionReason || '',
    recoverable: Boolean(runState.recoverable),
    total: Number(runState.total || 0),
    nextTaskIndex: Number(runState.nextTaskIndex || 0),
    uncertain: (runState.queuePlan || []).filter(isSubmissionUncertain).length,
    rejected: (runState.queuePlan || []).filter((unit) => (
      unit.submissionPhase === 'rejected_confirmed' && Number(unit.acceptedCount || 0) === 0
    )).length,
  });
  await phase0.flush();
}

function acquireRunAdmission() {
  if (runAdmissionToken) return null;
  runAdmissionToken = Symbol('run-admission');
  return runAdmissionToken;
}

function releaseRunAdmission(token) {
  if (runAdmissionToken === token) runAdmissionToken = null;
}

async function withAccountMutationLock(accountId, callback) {
  if (!accountId) throw new Error('DreamFace mutation account is required');
  const previous = accountMutationLocks.get(accountId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  accountMutationLocks.set(accountId, current);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (accountMutationLocks.get(accountId) === current) accountMutationLocks.delete(accountId);
  }
}

function isBusyPhase(phase) {
  return ['preparing', 'normalizing', 'ready', 'running', 'downloading', 'stopping'].includes(phase);
}

function createIdleRunState() {
  return {
    phase: 'idle',
    mode: 'legacy',
    runId: null,
    tabId: null,
    total: 0,
    current: 0,
    currentTaskName: '',
    statusText: 'ожидание...',
    warnings: [],
    failures: [],
    skipped: [],
    summary: {
      totalInputFiles: 0,
      totalGeneratedTasks: 0,
      keptFiles: [],
      paddedFiles: [],
      splitFiles: [],
      repairedFiles: [],
      failedFiles: [],
    },
    normalization: {
      processedCount: 0,
      totalCount: 0,
      generatedTasks: 0,
      currentFile: '',
    },
    startedAt: null,
    finishedAt: null,
    maxDurationSeconds: DEFAULT_MAX_DURATION_SECONDS,
    autoNormalize: true,
    overlapEnabled: false,
    interrupted: false,
    recoverable: false,
    interruptionReason: '',
    queuePlan: [],
    plan: null,
    planSummary: '',
    bulkContext: null,
    nextTaskIndex: 0,
    downloadPlan: {
      expectedFileNames: [],
      expectedWorkIds: [],
      lastStatus: 'idle',
      lastMessage: '',
      pendingFiles: [],
      downloadedCount: 0,
      matchedCount: 0,
      totalExpected: 0,
      checkedAt: '',
      checkedOnUrl: '',
    },
  };
}

function cloneState() {
  return JSON.parse(JSON.stringify(runState));
}

function setStatusText(text) {
  runState.statusText = text;
}

async function pushState() {
  await chrome.runtime.sendMessage({
    action: 'engine.persistRunState',
    state: cloneState(),
  });
}

function mergeState(patch) {
  runState = {
    ...runState,
    ...patch,
  };

  return pushState();
}

function createRunId() {
  return `run-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeFileNameStem(fileName) {
  const lastDot = fileName.lastIndexOf('.');
  return lastDot === -1 ? fileName : fileName.slice(0, lastDot);
}

function toMp3Name(fileName) {
  return `${normalizeFileNameStem(fileName)}.mp3`;
}

function formatFailure(fileName, reason) {
  return { fileName, reason };
}

function throwIfStopped(runToken) {
  if (stopRequested || runToken !== currentRunToken) {
    const error = new Error('run_stopped');
    error.code = 'run_stopped';
    throw error;
  }
}

function isSubmissionUncertain(unit) {
  return ['dispatching', 'submission_uncertain', 'requires_review'].includes(unit?.submissionPhase)
    || ['submission_uncertain', 'requires_review'].includes(unit?.status);
}

function setQueueSubmissionPhase(index, unit, submissionPhase, patch = {}) {
  Object.assign(unit, patch, { submissionPhase });
  runState.queuePlan[index] = { ...unit };
}

async function patchWatchSubmissionPhase(watchUnit, submissionPhase, patch = {}) {
  if (!watchUnit) return;
  Object.assign(watchUnit, patch, { submissionPhase, updatedAt: Date.now() });
  await callBackground('dfPatchBulkWatchUnits', { units: [{ ...watchUnit }] });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientTaskMessage(message = '') {
  const normalized = String(message || '').toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized.includes('timeout')
    || normalized.includes('network')
    || normalized.includes('offline')
    || normalized.includes('connection')
    || normalized.includes('internet')
    || normalized.includes('failed to fetch')
    || normalized.includes('load failed')
    || normalized.includes('err_');
}

function isTransientTaskResult(result) {
  if (!result || result.status !== 'error') {
    return false;
  }

  return isTransientTaskMessage(result.message || '');
}

async function waitForRetryDelay(runToken, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    throwIfStopped(runToken);
    await sleep(Math.min(250, deadline - Date.now()));
  }
}

async function openRunDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RUN_DB_NAME, RUN_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RUN_STORE_NAME)) {
        db.createObjectStore(RUN_STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(INPUT_STORE_NAME)) {
        db.createObjectStore(INPUT_STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openRunDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let settled = false;
    let callbackValue;

    transaction.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(callbackValue);
      }
      db.close();
    };

    transaction.onerror = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error || new Error('IndexedDB transaction failed'));
      }
      db.close();
    };

    Promise.resolve(callback(store)).then((value) => {
      callbackValue = value;
    }).catch((error) => {
      if (!settled) {
        settled = true;
        reject(error);
        try { transaction.abort(); } catch {}
      }
    });
  });
}

async function putTaskBlob(record) {
  await withStore(RUN_STORE_NAME, 'readwrite', (store) => {
    store.put(record);
  });
}

async function getTaskBlob(id) {
  return withStore(RUN_STORE_NAME, 'readonly', (store) => new Promise((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Failed to read task blob'));
  }));
}

async function deleteTaskBlob(id) {
  await withStore(RUN_STORE_NAME, 'readwrite', (store) => {
    store.delete(id);
  });
}

async function clearTaskBlobs() {
  await withStore(RUN_STORE_NAME, 'readwrite', (store) => {
    store.clear();
  });
}

async function getInputFileRecord(id) {
  return withStore(INPUT_STORE_NAME, 'readonly', (store) => new Promise((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Failed to read input file'));
  }));
}

async function deleteInputFileRecord(id) {
  await withStore(INPUT_STORE_NAME, 'readwrite', (store) => {
    store.delete(id);
  });
}

async function clearInputFiles() {
  await withStore(INPUT_STORE_NAME, 'readwrite', (store) => {
    store.clear();
  });
}

async function resetRunStateInternal() {
  stopRequested = false;
  currentRunToken += 1;
  runConnectCache.clear();
  runUntrusted.clear();
  runRejections.length = 0;
  quotaWaitCount = 0;
  await clearTaskBlobs().catch(() => {});
  await clearInputFiles().catch(() => {});
  runState = createIdleRunState();
  await pushState();
}

function toRuntimeFile(record) {
  if (!record?.blob) {
    return null;
  }

  return new File([record.blob], record.name, {
    type: record.type || record.blob.type || 'application/octet-stream',
    lastModified: record.lastModified || Date.now(),
  });
}

async function ensureFfmpegLoaded() {
  if (ffmpeg?.loaded) {
    return ffmpeg;
  }

  if (ffmpegLoadPromise) {
    return ffmpegLoadPromise;
  }

  ffmpegLoadPromise = (async () => {
    ffmpeg = new self.FFmpegWASM.FFmpeg();

    ffmpeg.on('log', ({ message }) => {
      if (!message) {
        return;
      }

      // Показываем только критические ошибки, игнорируя предупреждения о конкатенации
      if (message.includes('Error') || message.includes('Invalid')) {
        // Не показываем стандартные предупреждения о конкатенированных файлах
        if (message.includes('invalid concatenated file') || message.includes('Estimating duration')) {
          return;
        }

        setStatusText(`${ENGINE_STATUS_PREFIX} ${message}`);
        pushState().catch(() => {});
      }
    });

    await ffmpeg.load({
      coreURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.js'),
      wasmURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm'),
    });

    return ffmpeg;
  })().finally(() => {
    ffmpegLoadPromise = null;
  });

  return ffmpegLoadPromise;
}

async function resetFfmpeg() {
  if (ffmpeg) {
    try {
      ffmpeg.terminate();
    } catch (_) {}
  }

  ffmpeg = null;
  ffmpegLoadPromise = null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getAudioDuration(file) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = new Audio();
    let settled = false;

    const finish = (duration) => {
      if (settled) {
        return;
      }

      settled = true;
      URL.revokeObjectURL(objectUrl);
      resolve(duration);
    };

    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(audio.duration || 0);
    audio.onerror = () => finish(0);
    audio.src = objectUrl;
  });
}

async function safeDeleteFsFile(path) {
  if (!ffmpeg?.loaded) {
    return;
  }

  try {
    await ffmpeg.deleteFile(path);
  } catch (_) {}
}

async function readUint8Array(fileOrBlob) {
  return new Uint8Array(await fileOrBlob.arrayBuffer());
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob as data URL'));
    reader.readAsDataURL(blob);
  });
}

async function encodeMp3(inputPath, outputPath, args, timeoutMs = 180000) {
  // Принудительно 44100 Hz mono, чтобы избежать 32000 Hz по дефолту ffmpeg.wasm
  // и рассинхрона с downstream pipeline (ffmpeg ругается "Invalid data" на 32k).
  const normalizedArgs = [...args, '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-q:a', '2', outputPath];
  let code = await ffmpeg.exec(normalizedArgs, timeoutMs);

  if (code !== 0) {
    await safeDeleteFsFile(outputPath);
    const fallbackArgs = [...args, '-ar', '44100', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '192k', outputPath];
    code = await ffmpeg.exec(fallbackArgs, timeoutMs);
  }

  if (code !== 0) {
    throw new Error(`FFmpeg returned ${code}`);
  }

  const result = await ffmpeg.readFile(outputPath);
  return new Blob([result.buffer.slice(0)], { type: MP3_MIME });
}

async function transcodeFileToMp3(file, fileName, timeoutMs = 180000) {
  await ensureFfmpegLoaded();

  const inputPath = `input-${Date.now()}-${Math.random().toString(16).slice(2)}.${(file.name.split('.').pop() || 'bin').toLowerCase()}`;
  const outputPath = `output-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`;

  try {
    await ffmpeg.writeFile(inputPath, await readUint8Array(file));
    return await encodeMp3(inputPath, outputPath, ['-i', inputPath], timeoutMs);
  } finally {
    await safeDeleteFsFile(inputPath);
    await safeDeleteFsFile(outputPath);
  }
}

async function repairConcatenatedMp3(file, timeoutMs = 180000) {
  await ensureFfmpegLoaded();

  const inputPath = `repair-in-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`;
  const outputPath = `repair-out-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`;

  try {
    await ffmpeg.writeFile(inputPath, await readUint8Array(file));

    // Используем -err_detect ignore_err для игнорирования ошибок конкатенации
    // и перекодируем в чистый MP3 с корректной структурой.
    // -ar 44100 -ac 1 фиксирует sample_rate, иначе ffmpeg.wasm оставит 32000 Hz
    // от источника, что ломает downstream ffmpeg на "Invalid data".
    const args = [
      '-err_detect', 'ignore_err',
      '-i', inputPath,
      '-ar', '44100',
      '-ac', '1',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-write_xing', '1',
      outputPath,
    ];

    const code = await ffmpeg.exec(args, timeoutMs);

    if (code !== 0) {
      throw new Error(`FFmpeg repair failed with code ${code}`);
    }

    const result = await ffmpeg.readFile(outputPath);
    return new Blob([result.buffer.slice(0)], { type: MP3_MIME });
  } finally {
    await safeDeleteFsFile(inputPath);
    await safeDeleteFsFile(outputPath);
  }
}

function blobToRuntimeFile(blob, name, lastModified = Date.now()) {
  return new File([blob], name, {
    type: blob.type || MP3_MIME,
    lastModified,
  });
}

async function addLeftBorderToVideo(file) {
  mediaTransformModulePromise ||= import(chrome.runtime.getURL('media-transform.js'));
  const { transformMp4 } = await mediaTransformModulePromise;
  const result = await transformMp4(await file.arrayBuffer(), { padLeftPx: 64 });
  const mp4Name = `${normalizeFileNameStem(file.name)}.mp4`;
  return new File([result.bytes], mp4Name, {
    type: 'video/mp4',
    lastModified: file.lastModified || Date.now(),
  });
}

async function padShortFile(file) {
  await ensureFfmpegLoaded();

  const inputPath = `pad-in-${Date.now()}-${Math.random().toString(16).slice(2)}.${(file.name.split('.').pop() || 'bin').toLowerCase()}`;
  const outputPath = `pad-out-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`;

  try {
    await ffmpeg.writeFile(inputPath, await readUint8Array(file));
    return await encodeMp3(inputPath, outputPath, [
      '-i', inputPath,
      '-af', `apad=whole_dur=${MIN_DURATION_SECONDS}`,
      '-t', `${MIN_DURATION_SECONDS}`,
    ]);
  } finally {
    await safeDeleteFsFile(inputPath);
    await safeDeleteFsFile(outputPath);
  }
}

async function splitLongFile(file, maxDurationSeconds, overlapEnabled) {
  await ensureFfmpegLoaded();

  const duration = await getAudioDuration(file);
  const step = overlapEnabled
    ? Math.max(MIN_DURATION_SECONDS, maxDurationSeconds - OVERLAP_SECONDS)
    : maxDurationSeconds;
  const inputPath = `split-in-${Date.now()}-${Math.random().toString(16).slice(2)}.${(file.name.split('.').pop() || 'bin').toLowerCase()}`;
  const stem = normalizeFileNameStem(file.name);
  const outputs = [];

  try {
    await ffmpeg.writeFile(inputPath, await readUint8Array(file));

    let start = 0;
    let part = 1;

    while (start < duration) {
      const remaining = duration - start;
      const chunkDuration = Math.min(maxDurationSeconds, remaining);
      const outputPath = `split-out-${part}-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`;
      const encodeArgs = chunkDuration < MIN_DURATION_SECONDS
        ? [
          '-ss', `${start}`,
          '-t', `${chunkDuration}`,
          '-i', inputPath,
          '-af', `apad=whole_dur=${MIN_DURATION_SECONDS}`,
          '-t', `${MIN_DURATION_SECONDS}`,
        ]
        : [
          '-ss', `${start}`,
          '-t', `${chunkDuration}`,
          '-i', inputPath,
        ];

      try {
        const blob = await encodeMp3(inputPath, outputPath, encodeArgs, 240000);

        outputs.push({
          name: `${stem}__part-${String(part).padStart(3, '0')}.mp3`,
          blob,
          type: MP3_MIME,
        });
      } finally {
        await safeDeleteFsFile(outputPath);
      }

      part += 1;
      start += step;
    }

    return outputs;
  } finally {
    await safeDeleteFsFile(inputPath);
  }
}

function isMp3Like(file) {
  return file.type === MP3_MIME || /\.mp3$/i.test(file.name);
}

async function normalizeFile(file, options, runToken) {
  throwIfStopped(runToken);

  const originalFileName = file.name;
  const originalLastModified = file.lastModified || Date.now();
  const configuredMaxDuration = Number(options?.maxDurationSeconds);
  const maxDurationSeconds = Number.isFinite(configuredMaxDuration) && configuredMaxDuration >= MIN_DURATION_SECONDS
    ? configuredMaxDuration
    : DEFAULT_MAX_DURATION_SECONDS;
  let duration = await getAudioDuration(file);

  // Если MP3 файл не читается (конкатенированный или повреждённый), пробуем восстановить через FFmpeg
  if ((!Number.isFinite(duration) || duration <= 0) && isMp3Like(file)) {
    setStatusText(`${ENGINE_STATUS_PREFIX} восстановление ${file.name}`);
    await pushState();

    try {
      const repairedBlob = await repairConcatenatedMp3(file);
      file = blobToRuntimeFile(repairedBlob, toMp3Name(originalFileName), originalLastModified);
      duration = await getAudioDuration(file);

      // Если восстановление успешно, продолжаем с восстановленным файлом
      if (Number.isFinite(duration) && duration > 0) {
        // Файл был восстановлен, возвращаем соответствующий kind
        if (duration < MIN_DURATION_SECONDS) {
          const paddedBlob = await padShortFile(file);
          return {
            ok: true,
            kind: 'repaired',
            outputs: [{
              name: toMp3Name(file.name),
              blob: paddedBlob,
              type: MP3_MIME,
            }],
          };
        }

        // Файл восстановлен, но теперь нужно проверить другие условия
        if (duration > maxDurationSeconds) {
          const outputs = await splitLongFile(file, maxDurationSeconds, options.overlapEnabled);
          return {
            ok: true,
            kind: 'repaired',
            outputs,
          };
        }

        // Файл в норме после восстановления
        return {
          ok: true,
          kind: 'repaired',
          outputs: [{
            name: toMp3Name(file.name),
            blob: file,
            type: MP3_MIME,
          }],
        };
      }
    } catch (repairError) {
      return {
        ok: false,
        reason: `decode error: repair failed (${repairError.message})`,
      };
    }
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    return {
      ok: false,
      reason: 'decode error',
    };
  }

  if (!options.autoNormalize) {
    if (duration < MIN_DURATION_SECONDS) {
      return { ok: false, reason: `audio shorter than ${MIN_DURATION_SECONDS} seconds and auto-processing is disabled` };
    }

    if (duration > maxDurationSeconds) {
      return { ok: false, reason: `audio longer than ${maxDurationSeconds} seconds and auto-processing is disabled` };
    }

    return {
      ok: true,
      kind: 'kept',
      outputs: [{
        name: file.name,
        blob: file,
        type: file.type || 'application/octet-stream',
      }],
    };
  }

  try {
    if (duration < MIN_DURATION_SECONDS) {
      const paddedBlob = await padShortFile(file);
      return {
        ok: true,
        kind: 'padded',
        outputs: [{
          name: toMp3Name(file.name),
          blob: paddedBlob,
          type: MP3_MIME,
        }],
      };
    }

    if (duration > maxDurationSeconds) {
      const outputs = await splitLongFile(file, maxDurationSeconds, options.overlapEnabled);
      return {
        ok: true,
        kind: 'split',
        outputs,
      };
    }

    if (isMp3Like(file)) {
      // Даже если MP3 валидный и не нуждается в pad/split/transcode,
      // прогоняем через transcodeFileToMp3 чтобы нормализовать sample_rate
      // (иначе расширение вернёт файл как есть, 32000 Hz, и downstream
      // ffmpeg будет ругаться "Invalid data" из-за bit reservoir / frame
      // header mismatches, которые ffmpeg.wasm пишет).
      try {
        const normalizedBlob = await transcodeFileToMp3(file, file.name);
        return {
          ok: true,
          kind: 'kept',
          outputs: [{
            name: file.name,
            blob: normalizedBlob,
            type: MP3_MIME,
          }],
        };
      } catch (transcodeError) {
        // Если перекодирование не получилось — возвращаем как есть,
        // чтобы не сломать обработку полностью
        console.warn('[offscreen] kept→transcode failed, falling back to blob:', transcodeError.message);
        return {
          ok: true,
          kind: 'kept',
          outputs: [{
            name: file.name,
            blob: file,
            type: MP3_MIME,
          }],
        };
      }
    }

    const convertedBlob = await transcodeFileToMp3(file, toMp3Name(file.name));
    return {
      ok: true,
      kind: 'kept',
      outputs: [{
        name: toMp3Name(file.name),
        blob: convertedBlob,
        type: MP3_MIME,
      }],
    };
  } catch (error) {
    await resetFfmpeg();
    return {
      ok: false,
      reason: /AbortError/i.test(error.message) ? 'timeout' : 'transform error',
    };
  }
}

function countInputFiles(batches) {
  return batches.reduce((total, batch) => total + batch.audioFiles.length, 0);
}

function createTaskId(runId, taskIndex) {
  return `${runId}-task-${String(taskIndex).padStart(4, '0')}`;
}

function getVideoSourceIdentity(source) {
  try {
    const url = new URL(source);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return String(source || '');
  }
}

function rebindUploadedVideo(batches, currentBatchIndex, currentSlotIndex, uploadedIndex) {
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const indices = batches[batchIndex].selectedIndices;
    for (let slotIndex = 0; slotIndex < indices.length; slotIndex += 1) {
      if (batchIndex === currentBatchIndex && slotIndex === currentSlotIndex) {
        indices[slotIndex] = uploadedIndex;
      } else if (indices[slotIndex] >= uploadedIndex) {
        indices[slotIndex] += 1;
      }
    }
  }
}

// ============================================================
// PRE-LOOP phase helper
// ============================================================
//
// payload.batches[i].selectedIndices = [videoIndex, videoIndex, ...]
// normalizedByBatch.get(batch.id) = [{ name, blob, type }, ...]
//
// Для каждой ПАРЫ (batch, videoSlot) делаем:
//   1) посчитать maxAudioMs по нормализованным mp3 этой группы
//   2) запросить у content_script (selectVideoSafe + waitForPreviewVideoSrc)
//      sourceUrl + sourceMs исходного видео по текущему индексу слота
//   3) если sourceMs >= maxAudioMs — пропускаем (видео и так длиннее)
//   4) иначе offscreen preLoopVideo → blob
//   5) content_script uploadPreloopedVideo (через DataTransfer в input)
//   6) дождаться появления в библиотеке + ре-скан видео-сетки
//   7) ВЗЯТЬ ИНДЕКС НОВОГО ВИДЕО из свежего скана
//   8) переписать batch.selectedIndices[slotIdx] = newIndex
//
// ВАЖНО: после каждого upload нумерация foundVideos может ПОЛНОСТЬЮ
// поменяться (сайт обычно ставит новое видео в начало). Поэтому работаем
// итеративно: после каждого upload делаем свежий scan и сверяем длину.
async function runPreLoopPhase(payload, normalizedByBatch, runToken) {
  const tabId = runState.tabId;
  if (!tabId) {
    throw new Error('tabId не известен (вкладка dreamface потеряна)');
  }

  setStatusText(`${ENGINE_STATUS_PREFIX} pre-loop: подготовка видео`);
  await pushState();

  for (let bIdx = 0; bIdx < payload.batches.length; bIdx += 1) {
    throwIfStopped(runToken);

    const batch = payload.batches[bIdx];
    const outputs = normalizedByBatch.get(batch.id) || [];

    if (batch.selectedIndices.length === 0 || outputs.length === 0) {
      continue;
    }

    // максимальная длительность аудио в группе (в мс)
    let maxAudioMs = 0;
    for (const out of outputs) {
      const seconds = await getAudioDuration(out.blob).catch(() => 0);
      const ms = Math.round((Number(seconds) || 0) * 1000);
      if (ms > maxAudioMs) maxAudioMs = ms;
    }

    if (maxAudioMs <= 0) {
      console.warn('[offscreen] preLoop: maxAudioMs=0 для группы', batch.id, '— пропускаем');
      continue;
    }

    // обрабатываем каждый слот видео в этой группе
    for (let slotIdx = 0; slotIdx < batch.selectedIndices.length; slotIdx += 1) {
      throwIfStopped(runToken);

      const currentVideoIndex = batch.selectedIndices[slotIdx];

      setStatusText(`${ENGINE_STATUS_PREFIX} pre-loop: группа ${bIdx + 1}, видео ${slotIdx + 1}/${batch.selectedIndices.length}`);
      await pushState();

      // 1) sourceUrl + sourceMs
      let sourceUrl = '';
      let sourceMs = 0;
      try {
        const resp = await callBackground('engine.pageAction', {
          tabId,
          pageAction: 'getVideoSourceUrlByIndex',
          payload: { videoIndex: currentVideoIndex },
        });
        const data = resp.response || {};
        if (!data.ok) {
          throw new Error(data.error || 'getVideoSourceUrlByIndex failed');
        }
        sourceUrl = String(data.url || '');
        sourceMs = Number(data.durationMs) || 0;
      } catch (err) {
        console.warn(`[offscreen] preLoop: не удалось получить sourceUrl для batch=${bIdx} slot=${slotIdx}: ${err.message}`);
        runState.warnings = [
          ...runState.warnings,
          `pre-loop: не удалось узнать исходный mp4 для видео #${currentVideoIndex} (группа ${bIdx + 1}). эта группа пойдёт по стандартному пути.`,
        ];
        await pushState();
        continue;
      }

      // 2) sourceMs >= maxAudioMs — pre-loop не нужен
      if (sourceMs > 0 && sourceMs >= maxAudioMs) {
        console.log(`[offscreen] preLoop: видео #${currentVideoIndex} уже >= аудио (${sourceMs} >= ${maxAudioMs}), пропускаем`);
        continue;
      }

      // 3) offscreen preLoopVideo
      let preLoopResult;
      try {
        preLoopResult = await handlePreLoopVideo({
          sourceUrl,
          targetMs: maxAudioMs,
          sourceMs,
        });
      } catch (err) {
        console.warn('[offscreen] preLoop: handlePreLoopVideo crash', err.message);
        runState.warnings = [
          ...runState.warnings,
          `pre-loop: ошибка склейки для видео #${currentVideoIndex}: ${err.message}`,
        ];
        await pushState();
        continue;
      }

      if (!preLoopResult.ok) {
        console.warn('[offscreen] preLoop: handlePreLoopVideo result not ok', preLoopResult.error);
        runState.warnings = [
          ...runState.warnings,
          `pre-loop: не удалось склеить видео #${currentVideoIndex}: ${preLoopResult.error}`,
        ];
        await pushState();
        continue;
      }

      console.log('[offscreen] preLoop blob ready', {
        bIdx,
        slotIdx,
        currentVideoIndex,
        bytes: preLoopResult.bytes,
        repeats: preLoopResult.repeats,
        mode: preLoopResult.mode,
      });

      // 4) сколько видео в библиотеке СЕЙЧАС (до upload). это позволит
      // найти индекс нового видео потом.
      let videosBefore = [];
      try {
        const respScan0 = await callBackground('engine.pageAction', {
          tabId,
          pageAction: 'scanPageVideos',
          payload: {},
        });
        videosBefore = Array.isArray(respScan0.response?.videos)
          ? respScan0.response.videos
          : [];
      } catch (err) {
        console.warn('[offscreen] preLoop: pre-upload scan fail', err.message);
      }

      // 5) upload в DreamFace
      const preloopFileName = `preloop-${batch.id}-${slotIdx}-${Date.now()}.mp4`;
      try {
        const uploadResp = await callBackground('engine.pageAction', {
          tabId,
          pageAction: 'uploadPreloopedVideo',
          payload: { blobUrl: preLoopResult.blobUrl, fileName: preloopFileName },
        });
        if (!uploadResp.response?.ok) {
          throw new Error(uploadResp.response?.error || 'uploadPreloopedVideo failed');
        }
      } catch (err) {
        console.warn('[offscreen] preLoop: uploadPreloopedVideo crash', err.message);
        runState.warnings = [
          ...runState.warnings,
          `pre-loop: не удалось залить склеенное видео для #${currentVideoIndex}: ${err.message}`,
        ];
        await pushState();
        // освободим blob, который не использовали
        await callBackground('engine.pageAction', {
          tabId, pageAction: 'noop', payload: {},
        }).catch(() => {});
        try {
          await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'revokeBlob',
            payload: { blobUrl: preLoopResult.blobUrl },
          });
        } catch {}
        continue;
      }

      // 6) повторный scan чтобы найти новый индекс
      let newIndex = -1;
      try {
        // даём dreamface несколько секунд чтобы карточка проявилась
        await new Promise((r) => setTimeout(r, 1500));
        const respScan = await callBackground('engine.pageAction', {
          tabId,
          pageAction: 'scanPageVideos',
          payload: {},
        });
        const videosAfter = Array.isArray(respScan.response?.videos)
          ? respScan.response.videos
          : [];
        const beforeSources = new Set(
          videosBefore.map((video) => video?.src).filter(Boolean).map(getVideoSourceIdentity),
        );
        const addedVideos = videosAfter.filter((video) => (
          video?.src && !beforeSources.has(getVideoSourceIdentity(video.src))
        ));
        const candidateIndex = Number(addedVideos[0]?.index);
        if (addedVideos.length === 1 && Number.isInteger(candidateIndex) && candidateIndex >= 0) {
          newIndex = candidateIndex;
        }
      } catch (err) {
        console.warn('[offscreen] preLoop: post-upload scan fail', err.message);
      }

      // освобождаем blob независимо от исхода
      try {
        await handleRevokeBlob({ blobUrl: preLoopResult.blobUrl });
      } catch {}

      if (newIndex < 0) {
        throw new Error(`pre-loop: не удалось однозначно найти залитое видео #${currentVideoIndex}`);
      }

      rebindUploadedVideo(payload.batches, bIdx, slotIdx, newIndex);

      console.log('[offscreen] preLoop: slot перепривязан', {
        bIdx, slotIdx, oldIndex: currentVideoIndex, newIndex,
        updatedSelectedIndices: [...batch.selectedIndices],
      });

      // помечаем batch как pre-looped — пригодится дальше, чтобы
      // выключить hasChapters при скачивании результатов этой группы.
      batch.preLoopApplied = true;
    }
  }
}

async function prepareTasks(payload, runToken) {
  const normalizedByBatch = new Map();
  const summary = {
    totalInputFiles: countInputFiles(payload.batches),
    totalGeneratedTasks: 0,
    keptFiles: [],
    paddedFiles: [],
    splitFiles: [],
    repairedFiles: [],
    failedFiles: [],
  };

  let processedCount = 0;
  let generatedTasks = 0;

  for (const batch of payload.batches) {
    const normalizedOutputs = [];

    for (const fileRef of batch.audioFiles) {
      throwIfStopped(runToken);

      const sourceRecord = await getInputFileRecord(fileRef.id);
      const file = toRuntimeFile(sourceRecord);
      if (!file) {
        summary.failedFiles.push(formatFailure(fileRef.name || 'unknown', 'source file missing'));
        runState.failures = [...runState.failures, `${fileRef.name || 'unknown'}: source file missing`];
        processedCount += 1;
        runState.normalization.processedCount = processedCount;
        runState.summary = summary;
        await pushState();
        continue;
      }

      runState.phase = 'normalizing';
      runState.normalization.currentFile = file.name;
      runState.normalization.processedCount = processedCount;
      runState.normalization.totalCount = summary.totalInputFiles;
      runState.normalization.generatedTasks = generatedTasks;
      setStatusText(`${ENGINE_STATUS_PREFIX} подготовка ${file.name}`);
      await pushState();

      const result = await normalizeFile(file, payload.options, runToken);
      processedCount += 1;
      await deleteInputFileRecord(fileRef.id);

      if (!result.ok) {
        summary.failedFiles.push(formatFailure(file.name, result.reason));
        runState.failures = [...runState.failures, `${file.name}: ${result.reason}`];
      } else {
        normalizedOutputs.push(...result.outputs);
        generatedTasks += result.outputs.length;

        if (result.kind === 'kept') {
          summary.keptFiles.push(file.name);
        } else if (result.kind === 'padded') {
          summary.paddedFiles.push(file.name);
        } else if (result.kind === 'split') {
          summary.splitFiles.push({
            fileName: file.name,
            parts: result.outputs.length,
          });
        } else if (result.kind === 'repaired') {
          summary.repairedFiles.push(file.name);
        }
      }

      runState.normalization.processedCount = processedCount;
      runState.normalization.generatedTasks = generatedTasks;
      runState.summary = summary;
      await pushState();
    }

    normalizedByBatch.set(batch.id, normalizedOutputs);
  }

  // ============================================================
  // PRE-LOOP фаза: если опция включена, делаем локально склейку видео
  // forward-only под длительность САМОГО ДЛИННОГО нормализованного аудио
  // в группе, заливаем результат на dreamface как новое видео и подменяем
  // selectedIndices в batch на свежий индекс этого нового видео.
  // ============================================================
  // Делаем это ПОСЛЕ нормализации (мы уже знаем точные mp3 длительности)
  // и ДО сборки queue (чтобы queue.videoIndex сразу указывал на pre-loop'ed).
  if (payload.options?.preLoopEnabled) {
    try {
      await runPreLoopPhase(payload, normalizedByBatch, runToken);
    } catch (error) {
      // pre-loop фолбечится молча: если хоть один видео-слот в группе
      // не удалось pre-loop'ить — конкретно эта группа пойдёт по СТАРОМУ
      // пути (через chapter-markers). весь run при этом не падает.
      console.warn('[offscreen] preLoop phase failed:', error.message);
      runState.warnings = [
        ...runState.warnings,
        `pre-loop фаза завершилась с ошибкой: ${error.message}. остальные группы обработаны по стандартному пути.`,
      ];
      await pushState();
    }
  }

  const queue = [];
  let queueIndex = 1;

  // snapshot групп для monitor UI — индекс, id, размер группы, первые имена
  // (имена нужны на случай если юзер захочет понять "какая это группа")
  const batchesMeta = [];

  for (let bIdx = 0; bIdx < payload.batches.length; bIdx += 1) {
    const batch = payload.batches[bIdx];
    const outputs = normalizedByBatch.get(batch.id) || [];

    if (batch.selectedIndices.length === 0 || outputs.length === 0) {
      batchesMeta.push({
        batchId: batch.id,
        batchIndex: bIdx,
        videoCount: batch.selectedIndices.length,
        audioCount: batch.audioFiles.length,
        taskCount: 0,
        sampleAudioNames: batch.audioFiles.slice(0, 2).map((f) => f.name),
      });
      continue;
    }

    let videoPointer = 0;
    const batchStartQueueIndex = queue.length;

    for (const output of outputs) {
      const taskId = createTaskId(runState.runId, queueIndex);
      await putTaskBlob({
        id: taskId,
        runId: runState.runId,
        name: output.name,
        type: output.type || MP3_MIME,
        blob: output.blob,
      });

      queue.push({
        id: taskId,
        displayIndex: queueIndex,
        fileName: output.name,
        mimeType: output.type || MP3_MIME,
        videoIndex: batch.selectedIndices[videoPointer],
        workId: '',
        animateImageId: '',
        borderCropPx: Math.max(0, Math.floor(Number(batch.selectedBorderCropPx?.[videoPointer]) || 0)),
        // привязка к группе для UI
        batchId: batch.id,
        batchIndex: bIdx,
      });

      queueIndex += 1;
      videoPointer = (videoPointer + 1) % batch.selectedIndices.length;
    }

    batchesMeta.push({
      batchId: batch.id,
      batchIndex: bIdx,
      videoCount: batch.selectedIndices.length,
      audioCount: batch.audioFiles.length,
      taskCount: queue.length - batchStartQueueIndex,
      sampleAudioNames: batch.audioFiles.slice(0, 2).map((f) => f.name),
    });
  }

  summary.totalGeneratedTasks = queue.length;
  // batchesMeta уезжает в summary, чтобы попасть в runState через стандартный pushState
  summary.batches = batchesMeta;
  return { queue, summary };
}

async function callBackground(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...payload });

  if (!response?.ok) {
    throw new Error(response?.error || `Failed action: ${action}`);
  }

  return response;
}

function getDreamFaceApiModule() {
  dreamFaceApiModulePromise ||= import('./dreamface-api.js');
  return dreamFaceApiModulePromise;
}

function toAccountMetadata(account) {
  if (!account) return null;
  const {
    sessionRaw: _sessionRaw,
    token: _token,
    clientId: _clientId,
    userId: _userId,
    ...metadata
  } = account;
  return metadata;
}

async function getAccountBinding(accountId, principalKey = '') {
  const response = await callBackground('dfGetAccountCredential', { accountId, principalKey });
  const credential = response.account;
  const { createDreamFaceClient } = await getDreamFaceApiModule();
  const client = createDreamFaceClient(credential);
  const auth = client.getAuthContext();
  return {
    client,
    account: {
      ...toAccountMetadata(credential),
      accountId: auth.accountId,
      principalKey: auth.principalKey,
    },
  };
}

async function getCachedAvatarId(videoUrl, accountId) {
  const response = await chrome.runtime.sendMessage({
    action: 'dfGetAvatarCache', videoUrl, accountId,
  }).catch(() => null);
  return response?.ok ? response.avatarId : null;
}

async function setCachedAvatarId(videoUrl, accountId, avatarId) {
  await chrome.runtime.sendMessage({
    action: 'dfSetAvatarCache', videoUrl, accountId, avatarId,
  }).catch(() => {});
}

async function invalidateCachedAvatarId(videoUrl, accountId) {
  await chrome.runtime.sendMessage({
    action: 'dfDeleteAvatarCache', videoUrl, accountId,
  }).catch(() => {});
}

// ------------------------------------------------------- account probing (phase 2)
//
// Every dispatch used to re-probe every account with getAccountCapabilities (rights +
// template config) plus getRunningWorks — roughly eleven requests per attempt for four
// accounts. Capabilities change on a subscription's timescale, so they are cached for
// CAPABILITIES_TTL_MS; load and quota are cached for LOAD_PROBE_TTL_MS because dispatch is
// sequential. One getBatchTimes per probe now feeds the quota gate, the trace and the health
// model instead of being fetched again before every submit.
const CAPABILITIES_TTL_MS = 45 * 1000;
const LOAD_PROBE_TTL_MS = 8 * 1000;
const accountProbeCache = new Map();

function getProbeCacheEntry(accountId) {
  const id = String(accountId);
  if (!accountProbeCache.has(id)) accountProbeCache.set(id, { accountId: id });
  return accountProbeCache.get(id);
}

// A probe older than LOAD_PROBE_TTL_MS does not yet contain our own accepted batches; applying
// them locally keeps a failed post-submit refresh from advertising an idle account.
function noteOwnDispatch(accountId, workCount) {
  if (!featureEnabled('accountSnapshot')) return;
  const entry = accountProbeCache.get(String(accountId));
  if (!entry?.load) return;
  const added = Math.max(0, Number(workCount) || 0);
  entry.load = {
    ...entry.load,
    workIds: [...entry.load.workIds, ...Array(added).fill('self')],
    quota: entry.load.quota && entry.load.quota.total > 1 && entry.load.quota.remaining > 0
      ? { ...entry.load.quota, remaining: entry.load.quota.remaining - 1 }
      : entry.load.quota,
  };
}

function refreshProbeCache(accountId, { runningWorks, quota } = {}) {
  const id = String(accountId);
  const entry = getProbeCacheEntry(id);
  const workIds = Array.isArray(runningWorks?.workIds) ? runningWorks.workIds.map(String) : null;
  entry.load = {
    at: Date.now(),
    workIds: workIds || entry.load?.workIds || [],
    quota: quota
      ? { total: Number(quota.total) || 0, remaining: Number(quota.remaining) || 0 }
      : entry.load?.quota || null,
  };
}

// Heavy site calls (quota, capabilities) are paced: a cold pool of 11 accounts issuing four
// requests each in one burst made the site drop some of them, which surfaced as an unknown quota.
const HEAVY_CALL_LIMIT = 4;
let heavyCallsInFlight = 0;
const heavyCallQueue = [];

function withHeavyCallSlot(task) {
  const run = () => {
    heavyCallsInFlight += 1;
    return Promise.resolve()
      .then(task)
      .finally(() => {
        heavyCallsInFlight -= 1;
        const next = heavyCallQueue.shift();
        if (next) next();
      });
  };
  if (heavyCallsInFlight < HEAVY_CALL_LIMIT) return run();
  return new Promise((resolve, reject) => {
    heavyCallQueue.push(() => run().then(resolve, reject));
  });
}

async function readQuotaWithRetry(client) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const quota = await withHeavyCallSlot(() => client.getBatchTimes());
      if (quota) return quota;
    } catch (_) {
      // fall through to the retry
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function probeAccount(binding, accountId) {
  const entry = getProbeCacheEntry(accountId);
  const now = Date.now();
  const snapshotEnabled = featureEnabled('accountSnapshot');
  const loadFresh = snapshotEnabled && entry.load && now - entry.load.at <= LOAD_PROBE_TTL_MS;
  const capsFresh = snapshotEnabled && entry.capabilities && now - entry.capabilitiesAt <= CAPABILITIES_TTL_MS;
  // The ledger covers the counter between readings: get_batch_times is the slowest call in a
  // selection round (0.6-0.9 s for the whole pool), and our own acks keep it accurate.
  const health = getAccountHealth(accountId);
  const ledger = featureEnabled('quotaLedger') && quotaLedgerUsable(health, now) ? ledgerQuota(health) : null;
  if (loadFresh && capsFresh && (ledger || entry.load?.quota)) {
    return { load: { ...entry.load, quota: ledger || entry.load.quota }, capabilities: entry.capabilities, cached: true, quotaRead: false };
  }

  const loadPromise = loadFresh
    ? Promise.resolve(entry.load)
    : binding.client.getRunningWorks().then((running) => {
      if (!Array.isArray(running?.workIds)) throw new Error('DreamFace running works unavailable');
      return { at: Date.now(), workIds: running.workIds.map(String), quota: null };
    });
  const quotaPromise = ledger ? Promise.resolve(null) : readQuotaWithRetry(binding.client);
  const capsPromise = capsFresh
    ? Promise.resolve(entry.capabilities)
    : withHeavyCallSlot(() => binding.client.getAccountCapabilities());

  const [load, freshQuota, capabilities] = await Promise.all([loadPromise, quotaPromise, capsPromise]);
  entry.load = {
    at: load.at,
    workIds: load.workIds,
    quota: freshQuota
      ? { total: Number(freshQuota.total) || 0, remaining: Number(freshQuota.remaining) || 0 }
      : (ledger || load.quota || entry.load?.quota || null),
  };
  if (!capsFresh) {
    entry.capabilities = capabilities;
    entry.capabilitiesAt = Date.now();
  }
  return { load: entry.load, capabilities: entry.capabilities, cached: false, quotaRead: Boolean(freshQuota) };
}

async function selectLeastLoadedAccount(
  requiredDurationSeconds = 0,
  plannedLoads = new Map(),
  sourceVideoUrl = '',
  excludedAccountIds = new Set(),
  source = 'selection',
) {
  const listed = await callBackground('dfListAccounts');
  const accounts = Array.isArray(listed.accounts) ? listed.accounts.map(toAccountMetadata) : [];
  if (accounts.length === 0) throw new Error('DreamFace account is not authenticated');
  await loadAccountHealth(accounts);

  const now = Date.now();
  const healthEnabled = featureEnabled('accountHealth');
  const healthBlocked = [];
  const quotaBlocked = [];
  let attemptedAccountCount = 0;
  let unavailableAccountCount = 0;
  let availableMaximumSeconds = 0;

  const probed = await Promise.all(accounts.map(async (account) => {
    const listedAccountId = String(account.accountId || '');
    if (excludedAccountIds.has(listedAccountId)) return null;
    if (runUntrusted.has(listedAccountId)) {
      phase0.recordOnce(`untrusted:${runState.runId || ''}:${listedAccountId}`, {
        type: 'account_probe',
        source,
        accountId: listedAccountId,
        skipped: 'quota_unreliable',
        requiredDurationSeconds,
      });
      return null;
    }
    if (healthEnabled && isBlocked(getAccountHealth(listedAccountId), now)) {
      healthBlocked.push({ accountId: listedAccountId, health: getAccountHealth(listedAccountId) });
      return null;
    }
    attemptedAccountCount += 1;
    try {
      const binding = await getAccountBinding(account.accountId, account.principalKey);
      const accountId = String(binding.account.accountId || listedAccountId);
      if (excludedAccountIds.has(accountId)) return null;
      const { load, capabilities, quotaRead, cached } = await probeAccount(binding, accountId);
      const effectiveAccount = { ...account, ...binding.account, ...capabilities };
      noteAccountQuota(accountId, load.quota);
      phase0.recordOnce(`caps:${runState.runId || ''}:${accountId}`, {
        type: 'capabilities',
        accountId,
        tier: effectiveAccount.tier || '',
        planName: effectiveAccount.planName || '',
        limitSec: Number(effectiveAccount.maxDurationSeconds || 0),
        audioLimit: effectiveAccount.audioLimit || null,
        vipLabel: Boolean(effectiveAccount.vipLabel),
        vipLevel: effectiveAccount.vipLevel || '',
        vipType: effectiveAccount.vipType || '',
        expiresDate: Number(effectiveAccount.expiresDate || 0),
        quota: load.quota,
      });
      const hasCachedAvatar = sourceVideoUrl
        ? Boolean(await getCachedAvatarId(sourceVideoUrl, accountId))
        : false;
      return {
        account: effectiveAccount,
        accountId,
        load: load.workIds.length,
        quota: load.quota,
        // read = the site was asked for the counter, ledger/cache = the ledger covered it,
        // unavailable = it was asked and did not answer (never silently treated as unlimited)
        quotaSource: quotaRead ? 'read' : (load.quota ? (cached ? 'cache' : 'ledger') : 'unavailable'),
        hasCachedAvatar,
      };
    } catch (error) {
      unavailableAccountCount += 1;
      phase0.recordOnce(`probeerr:${runState.runId || ''}:${listedAccountId}`, {
        type: 'probe_error',
        source,
        accountId: listedAccountId,
        error: error?.message || String(error),
      });
      return null;
    }
  }));

  // The ranking itself lives in queue-policy.js so the plan preview and the live selector can
  // never disagree: backlog tier, then unlimited quota, then credit headroom, then load.
  const tierEnabled = featureEnabled('backlogTier');
  const poolContext = { tierEnabled, fastestMsPerWork: 0 };
  const mapped = probed.filter(Boolean).map((candidate) => {
    const health = getAccountHealth(candidate.accountId);
    // Metering follows the *plan* (capabilities), not the counter answer: a premium account whose
    // quota read failed must stay usable, while a Pro account whose read failed must not spend
    // credits nobody can account for.
    const premiumPlan = String(candidate.account?.tier || '') === 'premium';
    return {
      ...candidate,
      metered: !premiumPlan,
      quotaKnown: Boolean(candidate.quota),
      remaining: Number(candidate.quota?.remaining || 0),
      msPerWork: Number(health.drain?.msPerWork || 0),
      drainSamples: Number(health.drain?.samples || 0),
      // Base score for the ordering; the reservation and avatar affinity are applied per unit.
      score: candidate.load,
    };
  });
  // The tier is materialised once, against the fastest account in this pool, and then travels with
  // the candidate: every later comparison sees the same value, context or not.
  poolContext.fastestMsPerWork = fastestMsPerWork(mapped);
  for (const candidate of mapped) {
    candidate.tier = tierEnabled ? accountTier(candidate, poolContext) : 1;
  }
  const candidates = rankCandidates(mapped, poolContext);
  lastProbeSnapshot = candidates.map((candidate) => ({
    accountId: candidate.accountId,
    limitSec: Number(candidate.account.maxDurationSeconds || 0),
    tier: candidate.tier,
    load: candidate.load,
    quota: candidate.quota,
    metered: candidate.metered,
    remaining: candidate.remaining,
    // Every field the ranking uses must be here, or the plan would pick differently from the live
    // selector (the first validation run sent the whole batch to a Pro account).
    quotaClass: candidate.metered ? 0 : 1,
    quotaKnown: candidate.quotaKnown,
    msPerWork: candidate.msPerWork,
    drainSamples: candidate.drainSamples,
    hasCachedAvatar: candidate.hasCachedAvatar,
    score: candidate.score,
  }));

  let selected = null;
  for (const candidate of candidates) {
    const { account: effectiveAccount, accountId, quota } = candidate;
    const limitSec = Number(effectiveAccount.maxDurationSeconds || 0);
    availableMaximumSeconds = Math.max(availableMaximumSeconds, limitSec);
    if (quotaExhausted(quota)) {
      quotaBlocked.push({ accountId, tier: effectiveAccount.tier || '', quota });
      phase0.record({
        type: 'account_probe',
        source,
        accountId,
        skipped: 'quota_exhausted',
        runningWorks: candidate.load,
        limitSec,
        tier: effectiveAccount.tier || '',
        planName: effectiveAccount.planName || '',
        quota,
        requiredDurationSeconds,
        avatarCached: candidate.hasCachedAvatar,
      });
      continue;
    }
    let reservation = plannedLoads.get(accountId);
    if (!reservation || typeof reservation !== 'object') {
      reservation = { baselineLoad: candidate.load, assigned: Number(reservation) || 0 };
      plannedLoads.set(accountId, reservation);
    }
    const affinityBonus = candidate.hasCachedAvatar ? 2 : 0;
    const fits = limitSec >= requiredDurationSeconds;
    // Metering follows the plan, exactly as in the snapshot mapping: a premium account whose
    // counter read failed is still unlimited, while a Pro account whose read failed must not spend
    // credits nobody can account for — so it is skipped rather than ranked last.
    const metered = String(effectiveAccount.tier || '') !== 'premium';
    if (metered && !quota) {
      quotaBlocked.push({ accountId, tier: effectiveAccount.tier || '', quota });
      phase0.record({
        type: 'account_probe',
        source,
        accountId,
        skipped: 'quota_unknown',
        runningWorks: candidate.load,
        limitSec,
        tier: effectiveAccount.tier || '',
        planName: effectiveAccount.planName || '',
        quota,
        requiredDurationSeconds,
        avatarCached: candidate.hasCachedAvatar,
      });
      continue;
    }
    const built = {
      account: effectiveAccount,
      accountId,
      load: candidate.load,
      planned: reservation.assigned,
      quota,
      // Premium answers the counter with a 1/1 sentinel, i.e. batches are not metered. Metered
      // pro accounts hold 10 credits, so they are only used when nobody else can take the unit.
      quotaClass: metered ? 0 : 1,
      tier: candidate.tier,
      metered,
      remaining: Number(quota?.remaining || 0),
      msPerWork: candidate.msPerWork,
      drainSamples: candidate.drainSamples,
      hasCachedAvatar: candidate.hasCachedAvatar,
      score: Math.max(0, Math.max(candidate.load, reservation.baselineLoad + reservation.assigned) - affinityBonus),
    };
    phase0.record({
      type: 'account_probe',
      source,
      accountId,
      runningWorks: built.load,
      limitSec,
      tier: effectiveAccount.tier || '',
      planName: effectiveAccount.planName || '',
      quota,
      quotaSource: candidate.quotaSource || 'read',
      quotaClass: built.quotaClass,
      msPerWork: built.msPerWork,
      drainSamples: built.drainSamples,
      tier: built.tier,
      planned: built.planned,
      baselineLoad: reservation.baselineLoad,
      requiredDurationSeconds,
      score: built.score,
      avatarCached: built.hasCachedAvatar,
      fits,
    });
    // First fitting candidate in the ranked order wins; no second comparison.
    if (!fits || selected) continue;
    selected = built;
  }

  if (!selected) {
    const allRemainingAccountsUnavailable = attemptedAccountCount > 0
      && unavailableAccountCount === attemptedAccountCount;
    const blockedSummary = describeBlocked(healthBlocked, now);
    const quotaSummary = describeQuota(quotaBlocked, now);
    let message = 'captured DreamFace accounts are unavailable or expired';
    let code = 'accounts_unavailable';
    if (quotaBlocked.length > 0 && candidates.length === quotaBlocked.length) {
      message = `все аккаунты без квоты отправок (${quotaSummary.text})`;
      code = 'all_accounts_quota_exhausted';
    } else if (healthBlocked.length > 0 && attemptedAccountCount === 0) {
      message = `all DreamFace accounts are paused: ${blockedSummary.text}`;
      code = 'all_accounts_quarantined';
    } else if (excludedAccountIds.size > 0 && !allRemainingAccountsUnavailable) {
      message = 'all DreamFace accounts reached their active-work limit for this group';
      code = 'all_accounts_at_limit';
    } else if (availableMaximumSeconds > 0 && availableMaximumSeconds < requiredDurationSeconds) {
      message = `no DreamFace account supports ${Math.ceil(requiredDurationSeconds)}s audio; maximum is ${availableMaximumSeconds}s`;
      code = 'no_account_supports_duration';
    }
    if (quotaBlocked.length > 0 && code !== 'all_accounts_quota_exhausted') {
      message = `${message} | без квоты: ${quotaSummary.text}`;
    }
    const error = new Error(message);
    error.code = code;
    error.quotaBlocked = quotaSummary.rows;
    if (blockedSummary.nextRetryAt > 0) {
      error.retryAt = blockedSummary.nextRetryAt;
      error.blocked = blockedSummary.entries;
    }
    throw error;
  }
  return {
    ...selected.account,
    availableMaximumSeconds,
    quota: selected.quota,
    quotaClass: selected.quotaClass,
    probeLoad: selected.load,
    probeTier: selected.tier,
  };
}

async function activateAccount(accountId, principalKey = '') {
  const binding = await getAccountBinding(accountId, principalKey);
  return {
    ...binding,
    account: {
      ...binding.account,
      rotatedFromAccountId: binding.account.accountId !== accountId ? accountId : '',
    },
  };
}

async function restoreBulkPresetIfNeeded() {
  const context = runState.bulkContext;
  const presetState = context?.presetState || (context?.presetDirty ? 'restore_required' : 'clean');
  if (!context?.batchConfigId || !['dirty', 'restoring', 'restore_required'].includes(presetState)) return;
  if (!context.accountId) throw new Error('dirty preset account is unknown');
  runState.bulkContext = { ...context, presetState: 'restoring' };
  await pushState();
  const { account, client } = await activateAccount(context.accountId, context.principalKey || '');
  try {
    await withAccountMutationLock(account.accountId, async () => {
      await client.updateBatchConfig(
        context.batchConfigId,
        context.batchName || 'Bulk Batch',
        Array.isArray(context.originalScriptConfigs) ? context.originalScriptConfigs : [],
      );
    });
    runState.bulkContext = { ...context, accountId: account.accountId, principalKey: account.principalKey, presetState: 'clean' };
    await pushState();
  } catch (error) {
    runState.bulkContext = { ...runState.bulkContext, presetState: 'restore_required' };
    await pushState().catch(() => {});
    throw error;
  }
}

async function putOssFileDirect(putUrl, blob, contentType) {
  const response = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob,
  });
  if (!response.ok) throw new Error(`OSS upload failed: ${response.status}`);
}

async function prepareBulkPlan(payload, runToken) {
  const queue = [];
  const consumedInputIds = [];
  const summary = {
    totalInputFiles: countInputFiles(payload.batches),
    totalGeneratedTasks: 0,
    keptFiles: [],
    paddedFiles: [],
    splitFiles: [],
    repairedFiles: [],
    failedFiles: [],
    batches: [],
  };
  let processedCount = 0;
  let taskIndex = 1;

  for (let batchIndex = 0; batchIndex < payload.batches.length; batchIndex += 1) {
    const batch = payload.batches[batchIndex];
    const audioTasks = [];

    for (let sourceIndex = 0; sourceIndex < (batch.audioFiles || []).length; sourceIndex += 1) {
      const fileRef = batch.audioFiles[sourceIndex];
      throwIfStopped(runToken);
      const sourceRecord = await getInputFileRecord(fileRef.id);
      const file = toRuntimeFile(sourceRecord);
      if (!file) {
        const name = fileRef.name || 'unknown';
        summary.failedFiles.push(formatFailure(name, 'source file missing'));
        runState.failures = [...runState.failures, `${name}: source file missing`];
        continue;
      }

      runState.phase = 'normalizing';
      runState.normalization.currentFile = file.name;
      setStatusText(`${ENGINE_STATUS_PREFIX} подготовка ${file.name}`);
      await pushState();

      const result = await normalizeFile(file, payload.options, runToken);
      processedCount += 1;

      if (!result.ok) {
        summary.failedFiles.push(formatFailure(file.name, result.reason));
        runState.failures = [...runState.failures, `${file.name}: ${result.reason}`];
      } else {
        for (const output of result.outputs) {
          const id = createTaskId(runState.runId, taskIndex);
          const runtimeFile = blobToRuntimeFile(output.blob, output.name);
          const durationMs = Math.max(0, (await getAudioDuration(runtimeFile)) * 1000);
          await putTaskBlob({ id, runId: runState.runId, name: output.name, type: output.type || MP3_MIME, blob: output.blob, durationMs });
          audioTasks.push({ id, fileName: output.name, mimeType: output.type || MP3_MIME, durationMs, sourceIndex });
          taskIndex += 1;
        }
        summary.totalGeneratedTasks += result.outputs.length;
        if (result.kind === 'kept') summary.keptFiles.push(file.name);
        else if (result.kind === 'padded') summary.paddedFiles.push(file.name);
        else if (result.kind === 'repaired') summary.repairedFiles.push(file.name);
        else if (result.kind === 'split') summary.splitFiles.push({ fileName: file.name, parts: result.outputs.length });
      }
      consumedInputIds.push(fileRef.id);

      runState.normalization.processedCount = processedCount;
      runState.normalization.generatedTasks = summary.totalGeneratedTasks;
      runState.summary = summary;
      await pushState();
    }

    const videos = batch.selectedAvatars || [];
    const assigned = videos.map(() => []);
    for (const audio of audioTasks) {
      if (videos.length > 0) assigned[audio.sourceIndex % videos.length].push(audio);
    }

    for (let slotIndex = 0; slotIndex < videos.length; slotIndex += 1) {
      if (assigned[slotIndex].length === 0) continue;
      const pageIndex = Number(batch.selectedIndices?.[slotIndex]);
      queue.push({
        id: `${runState.runId}-bulk-${String(queue.length + 1).padStart(3, '0')}`,
        batchId: batch.id,
        batchIndex,
        video: videos[slotIndex],
        // The index of this avatar in the page grid, so the download can learn the source length.
        videoIndex: Number.isInteger(pageIndex) ? pageIndex : -1,
        audios: assigned[slotIndex],
        workIds: [],
        submissionPhase: 'preparing',
      });
    }

    summary.batches.push({
      batchId: batch.id,
      batchIndex,
      videoCount: videos.length,
      audioCount: audioTasks.length,
      taskCount: audioTasks.length,
      sampleAudioNames: audioTasks.slice(0, 2).map((item) => item.fileName),
    });
  }

  return { queue, summary, consumedInputIds };
}

async function getLongestInputDurationSeconds(batches, runToken) {
  let longest = 0;
  for (const batch of batches || []) {
    for (const fileRef of batch.audioFiles || []) {
      throwIfStopped(runToken);
      const file = toRuntimeFile(await getInputFileRecord(fileRef.id));
      if (file) longest = Math.max(longest, await getAudioDuration(file));
    }
  }
  return longest;
}

async function getBulkWatchUnits() {
  const resp = await callBackground('dfGetBulkWatchUnits');
  const units = Array.isArray(resp?.units) ? resp.units : [];
  for (const unit of units) {
    if (unit.submissionPhase === 'dispatching') {
      unit.submissionPhase = 'submission_uncertain';
      unit.status = 'submission_uncertain';
      unit.lastError ||= 'Submission outcome was not persisted before the executor stopped';
      unit.updatedAt = Date.now();
    }
  }
  const now = Date.now();
  for (const unit of units) {
    // A unit that never finished correlating or downloading would otherwise keep the 1-minute
    // watcher alarm alive forever, paying a creations + statuses round trip per tick.
    if (unit.status === 'pending' || unit.status === 'submission_uncertain' || unit.status === 'requires_review') {
      const age = now - Number(unit.submittedAt ? new Date(unit.submittedAt).getTime() : (unit.createdAt || 0));
      if (Number.isFinite(age) && age > BULK_WATCH_MAX_AGE_MS) {
        unit.status = 'failed';
        unit.submissionPhase = unit.submissionPhase === 'requires_review' ? 'requires_review' : 'abandoned';
        unit.lastError ||= 'наблюдение прекращено: истёк срок отслеживания';
        unit.updatedAt = now;
        await callBackground('dfPatchBulkWatchUnits', { units: [{ ...unit }] }).catch(() => {});
      }
    }
  }
  const expiredTerminalUnits = units.filter((unit) => (
    unit.status !== 'pending'
    && unit.status !== 'submission_uncertain'
    && now - Number(unit.updatedAt || unit.createdAt || 0) > BULK_WATCH_MAX_AGE_MS
  ));
  for (const unit of expiredTerminalUnits) await removeBulkWatchUnit(unit.id);
  const expiredIds = new Set(expiredTerminalUnits.map((unit) => unit.id));
  return units.filter((unit) => !expiredIds.has(unit.id));
}

async function enrichWatchUnitPrincipals(units) {
  const cache = new Map();
  for (const unit of units) {
    if (unit.principalKey && !/^(account|user):/i.test(unit.principalKey)) continue;
    if (!cache.has(unit.accountId)) {
      const binding = await activateAccount(unit.accountId).catch(() => null);
      cache.set(unit.accountId, binding?.account?.principalKey || `account:${unit.accountId}`);
    }
    unit.principalKey = cache.get(unit.accountId);
  }
  return units;
}

function reconcileDuplicateWatchClaims(units) {
  const claimed = new Set();
  for (const unit of units.slice().sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt))) {
    unit.workIds = (unit.workIds || []).map((id) => {
      if (!id || !claimed.has(String(id))) {
        if (id) claimed.add(String(id));
        return id;
      }
      unit.enqueuedWorkIds = (unit.enqueuedWorkIds || []).filter((item) => item !== id);
      unit.failedWorkIds = (unit.failedWorkIds || []).filter((item) => item !== id);
      return '';
    });
  }
}

// The server fills audio longer than the source video by ping-ponging it (forward videoMs, then
// reversed videoMs, and so on). Chapter markers are only useful when we know that source length,
// so the page is asked once per run and per avatar slot: asking per unit would add one round trip
// for every (audio, avatar) pair of a matrix batch.
const sourceVideoMsByRun = new Map();

async function readSourceVideoMs(videoIndex) {
  const index = Number(videoIndex);
  if (!runState.tabId || !Number.isInteger(index) || index < 0) {
    return 0;
  }
  const cacheKey = `${runState.runId}:${index}`;
  if (sourceVideoMsByRun.has(cacheKey)) {
    return sourceVideoMsByRun.get(cacheKey);
  }
  let ms = 0;
  try {
    const resp = await callBackground('engine.pageAction', {
      tabId: runState.tabId,
      pageAction: 'getVideoSourceUrlByIndex',
      payload: { videoIndex: index },
    });
    const data = resp?.response || {};
    if (data.ok) {
      ms = Math.max(0, Math.round(Number(data.durationMs) || 0));
    }
  } catch (_) {
    // The grid may be gone (closed tab, changed page): chapters are then simply not marked.
    ms = 0;
  }
  sourceVideoMsByRun.set(cacheKey, ms);
  return ms;
}

async function addBulkWatchUnit(unit) {
  const watchUnit = {
    ...unit,
    workIds: Array(unit.expectedFileNames.length).fill(''),
    enqueuedWorkIds: [],
    failedWorkIds: [],
    baselineWorkIds: Array.isArray(unit.baselineWorkIds) ? unit.baselineWorkIds : [],
    correlationDeadline: unit.correlationDeadline || new Date(Date.now() + (30 * 60 * 1000)).toISOString(),
    status: unit.status || 'pending',
    submissionPhase: unit.submissionPhase || 'correlating',
    targetCount: Math.max(0, Number(unit.targetCount ?? unit.expectedFileNames.length)),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await callBackground('dfUpsertBulkWatchUnit', { unit: watchUnit });
  return watchUnit;
}

async function removeBulkWatchUnit(id) {
  await callBackground('dfRemoveBulkWatchUnit', { id });
}

function assignCreationItemsToWatchUnits(units, items, allAccountUnits = units) {
  const candidates = (items || [])
    .filter((item) => item?.id && item?.work_name && item.work_type === 'AVATAR_VIDEO')
    .sort((a, b) => toEpochMs(a.create_time) - toEpochMs(b.create_time));
  const candidateById = new Map(candidates.map((item) => [String(item.id), item]));

  for (const unit of units) {
    const baselineIds = new Set((unit.baselineWorkIds || []).map(String));
    const minTime = new Date(unit.submittedAt).getTime() - 30000;
    const maxTime = unit.correlationDeadline ? new Date(unit.correlationDeadline).getTime() : Infinity;
    unit.workIds = (unit.workIds || Array(unit.expectedFileNames.length).fill('')).map((id, index) => {
      if (!id) return '';
      const item = candidateById.get(String(id));
      const itemTime = toEpochMs(item?.create_time);
      const valid = item
        && item.work_name === unit.expectedFileNames[index]
        && !baselineIds.has(String(id))
        && itemTime >= minTime
        && itemTime <= maxTime;
      if (valid) return String(id);
      unit.enqueuedWorkIds = (unit.enqueuedWorkIds || []).filter((entry) => entry !== id);
      unit.failedWorkIds = (unit.failedWorkIds || []).filter((entry) => entry !== id);
      return '';
    });
  }

  const claimed = new Set(allAccountUnits.flatMap((unit) => unit.workIds || []).filter(Boolean));

  for (const unit of units.slice().sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt))) {
    const minTime = new Date(unit.submittedAt).getTime() - 30000;
    const maxTime = unit.correlationDeadline ? new Date(unit.correlationDeadline).getTime() : Infinity;
    const baselineIds = new Set(unit.baselineWorkIds || []);
    unit.workIds ||= Array(unit.expectedFileNames.length).fill('');
    for (let index = 0; index < unit.expectedFileNames.length; index += 1) {
      if (unit.workIds.filter(Boolean).length >= Number(unit.targetCount || unit.expectedFileNames.length)) break;
      if (unit.workIds[index]) continue;
      const match = candidates.find((item) => (
        !claimed.has(String(item.id))
        && !baselineIds.has(String(item.id))
        && item.work_name === unit.expectedFileNames[index]
        && toEpochMs(item.create_time) >= minTime
        && toEpochMs(item.create_time) <= maxTime
      ));
      if (!match) continue;
      unit.workIds[index] = String(match.id);
      claimed.add(String(match.id));
    }
  }
}

function toEpochMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

async function watchAccountUnits(accountId, units, allAccountUnits) {
  const { account, client } = await activateAccount(accountId, units[0]?.principalKey || '');
  if (account.accountId !== accountId) {
    for (const unit of units) unit.accountId = account.accountId;
  }
  let allItems = [];
  const oldestSubmitMs = Math.min(...units.map((unit) => new Date(unit.submittedAt).getTime()).filter(Number.isFinite));
  for (let page = 1; ; page += 1) {
    const result = await client.getRecentCreations(page, 100);
    const pageItems = result?.items || [];
    allItems = allItems.concat(pageItems);
    const pageTimes = pageItems.map((item) => toEpochMs(item?.create_time)).filter((time) => time > 0);
    const oldestPageItemMs = pageTimes.length > 0 ? Math.min(...pageTimes) : Infinity;
    if (page * 100 >= Number(result?.count || 0)
      || pageItems.length === 0
      || (Number.isFinite(oldestSubmitMs) && oldestPageItemMs < oldestSubmitMs - 30000)) break;
  }
  assignCreationItemsToWatchUnits(units, allItems, allAccountUnits);
  for (const unit of units) {
    if (isSubmissionUncertain(unit)
      && (unit.workIds || []).filter(Boolean).length >= Number(unit.targetCount || unit.expectedFileNames.length)) {
      unit.submissionPhase = 'correlating';
      unit.status = 'pending';
    }
    unit.watcherStats = {
      checkedAt: new Date().toISOString(),
      scanned: allItems.length,
      matched: (unit.workIds || []).filter(Boolean).length,
      sampleNames: allItems.slice(0, 3).map((item) => item.work_name || item.name || '').filter(Boolean),
    };
    unit.lastError = '';
  }

  let dmState = await callBackground('dm.getState').catch(() => ({ entries: [] }));
  let dmStatusById = new Map((dmState.entries || []).map((entry) => [String(entry.workId), entry.status]));
  const terminalDownloadFailures = new Set(['failed', 'interrupted', 'missing']);
  for (const unit of units) {
    unit.enqueuedWorkIds = (unit.enqueuedWorkIds || []).filter((id) => dmStatusById.has(String(id)));
  }

  const discoveredIds = units.flatMap((unit) => unit.workIds || []).filter(Boolean);
  const statusResult = await client.getWorkStatuses(discoveredIds);
  const statusById = new Map((statusResult?.statuses || []).map((row) => [String(row.id), Number(row.web_work_status)]));
  for (const item of allItems) {
    if (item?.id && !statusById.has(String(item.id))) statusById.set(String(item.id), Number(item.web_work_status));
  }

  const readyIds = [];
  for (const unit of units) {
    const enqueued = new Set(unit.enqueuedWorkIds || []);
    const failed = new Set(unit.failedWorkIds || []);
    const statusCounts = {};
    for (const id of unit.workIds || []) {
      const status = statusById.get(String(id));
      const statusKey = status === undefined || Number.isNaN(status) ? 'unknown' : String(status);
      statusCounts[statusKey] = (statusCounts[statusKey] || 0) + 1;
      if (status === 200 && !enqueued.has(id)) readyIds.push(id);
      if ((status === -1 || status === -2) && !failed.has(id)) failed.add(id);
    }
    unit.failedWorkIds = [...failed];
    unit.watcherStats = {
      ...unit.watcherStats,
      statuses: statusCounts,
      ready: (unit.workIds || []).filter((id) => statusById.get(String(id)) === 200).length,
      requestedUrls: 0,
      receivedUrls: 0,
    };
  }

  for (const unit of units) {
    for (const id of unit.workIds || []) {
      if (!id) continue;
      const status = statusById.get(String(id));
      const statusKey = status === undefined || Number.isNaN(status) ? 'unknown' : String(status);
      phase0.recordOnce(`work:${id}:${statusKey}`, {
        type: 'work_status',
        workId: id,
        unitId: unit.id,
        accountId: unit.accountId,
        submittedAt: unit.submittedAt || '',
        status: statusKey === 'unknown' ? 'unknown' : Number(status),
      });
    }
  }

  if (readyIds.length > 0) {
    const downloadResult = await client.getDownloadUrls([...new Set(readyIds)]);
    const urlById = new Map((downloadResult?.urls || []).filter((item) => item?.id && item?.url).map((item) => [String(item.id), item.url]));
    const queueItems = [];
    const queueRefs = [];
    for (const unit of units) {
      const enqueued = new Set(unit.enqueuedWorkIds || []);
      const unitReadyIds = unit.workIds.filter((id) => readyIds.includes(id));
      unit.watcherStats.requestedUrls = unitReadyIds.length;
      unit.watcherStats.receivedUrls = unitReadyIds.filter((id) => urlById.has(id)).length;
      for (let index = 0; index < unit.workIds.length; index += 1) {
        const id = unit.workIds[index];
        const url = urlById.get(id);
        if (!id || !url || enqueued.has(id)) continue;
        const audioMs = Math.max(0, Math.round(Number((unit.audioDurationsMs || [])[index] || 0)));
        const videoMs = Math.max(0, Math.round(Number(unit.sourceVideoMs || 0)));
        queueItems.push({
          workId: id,
          runId: unit.runId || '',
          accountId: unit.accountId || '',
          watchUnitId: unit.id || '',
          workName: unit.expectedFileNames[index] || id,
          audioFileName: unit.expectedFileNames[index] || '',
          url,
          audioMs: audioMs || null,
          videoMs: videoMs || null,
          // Chapters describe a ping-pong that only exists when the audio outlasts the source.
          hasChapters: Boolean(audioMs > 0 && videoMs > 0 && audioMs > videoMs),
        });
        queueRefs.push({ unit, id });
      }
    }
    if (queueItems.length > 0) {
      await callBackground('dm.enqueue', { payload: { items: queueItems } });
      for (const { unit, id } of queueRefs) {
        unit.enqueuedWorkIds = [...new Set([...(unit.enqueuedWorkIds || []), id])];
      }
      dmState = await callBackground('dm.getState').catch(() => ({ entries: [] }));
      dmStatusById = new Map((dmState.entries || []).map((entry) => [String(entry.workId), entry.status]));
    }
  }

  for (const unit of units) {
    const wasSubmissionUncertain = isSubmissionUncertain(unit);
    const wasRequiresReview = unit.submissionPhase === 'requires_review' || unit.status === 'requires_review';
    const doneIds = (unit.workIds || []).filter((id) => dmStatusById.get(String(id)) === 'done');
    const downloadFailedIds = (unit.workIds || []).filter((id) => terminalDownloadFailures.has(dmStatusById.get(String(id))));
    const targetCount = Number(unit.targetCount || unit.expectedFileNames.length);
    const hasAllWorkIds = (unit.workIds || []).filter(Boolean).length >= targetCount;
    if (doneIds.length >= targetCount) {
      if (unit.status !== 'complete') {
        const submittedMs = Date.parse(unit.submittedAt || '');
        const elapsedMs = Number.isFinite(submittedMs) ? Date.now() - submittedMs : 0;
        phase0.recordOnce(`drain:${unit.id}`, {
          type: 'drain_sample',
          unitId: unit.id,
          accountId: unit.accountId,
          probeLoad: Number(unit.probeLoad || 0),
          works: doneIds.length,
          elapsedMs: elapsedMs || null,
        });
        // Trains the ranking: the measured turnaround is what separates a fast account from a slow
        // one whose queue merely looks empty.
        if (elapsedMs && unit.accountId) {
          void noteAccountDrain(unit.accountId, { elapsedMs, works: doneIds.length });
        }
      }
      unit.status = 'complete';
    }
    else if (!wasSubmissionUncertain
      && doneIds.length + (unit.failedWorkIds || []).length + downloadFailedIds.length >= targetCount) unit.status = 'failed';
    else if (!hasAllWorkIds && unit.correlationDeadline && Date.now() > new Date(unit.correlationDeadline).getTime()) {
      unit.status = wasSubmissionUncertain ? 'requires_review' : 'failed';
      if (wasSubmissionUncertain) unit.submissionPhase = 'requires_review';
    } else {
      unit.status = wasRequiresReview ? 'requires_review' : wasSubmissionUncertain ? 'submission_uncertain' : 'pending';
      if (wasRequiresReview) unit.submissionPhase = 'requires_review';
      else if (wasSubmissionUncertain) unit.submissionPhase = 'submission_uncertain';
    }
    unit.updatedAt = Date.now();
  }
}

async function runBulkWatcher({ allowDuringRun = false } = {}) {
  if (!allowDuringRun && runState.phase === 'running') return { ok: true, skipped: 'run-active' };
  if (bulkWatcherPromise) return bulkWatcherPromise;
  bulkWatcherPromise = (async () => {
    const units = await enrichWatchUnitPrincipals(await getBulkWatchUnits());
    const queueById = new Map((runState.queuePlan || []).map((unit) => [String(unit.id), unit]));
    for (const unit of units) {
      const queueUnit = queueById.get(String(unit.id));
      if (!isSubmissionUncertain(queueUnit)) continue;
      unit.status = 'submission_uncertain';
      unit.submissionPhase = 'submission_uncertain';
      unit.lastError ||= queueUnit.lastError || 'Submission outcome is unknown after executor restart';
    }
    // `status` is the authority on whether a unit is still worth polling. A finished unit keeps
    // the last submission phase it was given ('correlating'), so matching on the phase as well
    // made every completed unit — including those of older runs — get re-scanned and
    // re-statused on every tick: a finished queue of 73 units re-read 181 works per tick.
    const pendingUnits = units.filter((unit) => {
      if (TERMINAL_WATCH_STATUSES.has(unit.status)) return false;
      if (unit.status === 'requires_review') return (unit.workIds || []).some(Boolean);
      return unit.status === 'pending' || unit.status === 'submission_uncertain';
    });
    reconcileDuplicateWatchClaims(pendingUnits);
    const byAccount = new Map();
    for (const unit of pendingUnits) {
      const key = unit.principalKey || `account:${unit.accountId}`;
      if (!byAccount.has(key)) byAccount.set(key, []);
      byAccount.get(key).push(unit);
    }
    const errors = [];
    for (const [, accountUnits] of byAccount) {
      try {
        await watchAccountUnits(accountUnits[0].accountId, accountUnits, accountUnits);
      } catch (error) {
        errors.push(error.message || String(error));
        for (const unit of accountUnits) {
          unit.lastError = error.message || String(error);
          unit.updatedAt = Date.now();
        }
      }
    }
    await callBackground('dfPatchBulkWatchUnits', { units: pendingUnits });
    return {
      ok: errors.length === 0,
      pending: pendingUnits.filter((unit) => unit.status === 'pending' || unit.status === 'submission_uncertain').length,
      errors,
    };
  })().finally(() => {
    bulkWatcherPromise = null;
  });
  return bulkWatcherPromise;
}

async function processBulkQueue(queue, runToken, startIndex = 0) {
  const expectedFiles = queue.flatMap((unit) => unit.audios.map((audio) => audio.fileName));
  runState.queuePlan = queue.map((unit) => ({ ...unit, audios: unit.audios.map((audio) => ({ ...audio })) }));
  runState.nextTaskIndex = startIndex;
  runState.total = expectedFiles.length;
  runState.phase = 'running';
  runState.downloadPlan = {
    ...runState.downloadPlan,
    expectedFileNames: expectedFiles,
    expectedWorkIds: queue.flatMap((unit) => unit.workIds || []),
    totalExpected: expectedFiles.length,
    lastStatus: 'watching',
  };
  await pushState();

  let completedAudioCount = queue.slice(0, startIndex).reduce((sum, unit) => (
    unit.status === 'submitted'
      || unit.submissionPhase === 'accepted'
      ? sum + Number(unit.acceptedCount ?? unit.audios.length)
      : sum
  ), 0);
  runState.current = completedAudioCount;
  const plannedLoads = new Map();

  for (let index = startIndex; index < queue.length; index += 1) {
    throwIfStopped(runToken);
    const unit = queue[index];
    if (isSubmissionUncertain(unit)) {
      runState.nextTaskIndex = index + 1;
      runState.recoverable = index + 1 < queue.length;
      runState.warnings = [...runState.warnings, `${unit.video.name}: отправка не повторена (${unit.submissionPhase || unit.status})`];
      await pushState();
      continue;
    }
    if (unit.submissionPhase === 'accepted' || unit.submissionPhase === 'rejected_confirmed' || unit.status === 'submitted') {
      const acceptedCount = unit.submissionPhase === 'rejected_confirmed'
        ? 0
        : Number(unit.acceptedCount ?? unit.audios.length);
      if (acceptedCount === unit.audios.length) {
        for (const audio of unit.audios) await deleteTaskBlob(audio.id);
      }
      completedAudioCount += acceptedCount;
      runState.current = completedAudioCount;
      runState.nextTaskIndex = index + 1;
      runState.queuePlan[index] = { ...unit, status: unit.status };
      await pushState();
      continue;
    }

    const requiredDurationSeconds = unit.audios.reduce((max, audio) => Math.max(max, Number(audio.durationMs || 0) / 1000), 0);
    const excludedAccountIds = new Set((unit.retryExcludedAccountIds || []).map(String));
    const attemptIndex = (unit.retryExcludedAccountIds || []).length + 1;
    const attemptStartedAt = Date.now();
    let probeMs = 0;
    let connectMs = 0;
    let prepMs = 0;
    let submitMs = 0;
    let ackMs = 0;
    const recordAttemptEnd = (outcome, patch = {}) => {
      phase0.record({
        type: 'attempt_end',
        unitId: unit.id,
        attemptIndex,
        outcome,
        accountId: patch.accountId || unit.accountId || '',
        requiredDurationSeconds: Math.round(requiredDurationSeconds * 1000) / 1000,
        totalMs: Date.now() - attemptStartedAt,
        probeMs,
        connectMs,
        prepMs,
        uploadMs: patch.uploadMs ?? 0,
        submitMs: patch.submitMs ?? submitMs,
        ackMs,
        ...patch,
      });
    };
    phase0.record({
      type: 'attempt_start',
      unitId: unit.id,
      attemptIndex,
      requiredDurationSeconds: Math.round(requiredDurationSeconds * 1000) / 1000,
      audios: unit.audios.length,
      excludedCount: excludedAccountIds.size,
      presetAccountId: unit.accountId || '',
    });
    let selectedAccount;
    let client;
    const selectionStartedAt = Date.now();
    if (unit.accountId) {
      const binding = await activateAccount(unit.accountId, unit.principalKey || '');
      selectedAccount = binding.account;
      client = binding.client;
      unit.accountId = selectedAccount.accountId;
      unit.principalKey = selectedAccount.principalKey;
      runState.queuePlan[index] = { ...unit };
      await pushState();
      throwIfStopped(runToken);
      const { capabilities, load } = await probeAccount(binding, selectedAccount.accountId);
      throwIfStopped(runToken);
      selectedAccount = { ...selectedAccount, ...capabilities, quota: load.quota };
      noteAccountQuota(selectedAccount.accountId, load.quota);
    } else {
      try {
        selectedAccount = await selectLeastLoadedAccount(
          requiredDurationSeconds,
          plannedLoads,
          unit.video.videoUrl,
          excludedAccountIds,
        );
      } catch (error) {
        const capacityCodes = ['all_accounts_at_limit', 'all_accounts_quarantined', 'all_accounts_quota_exhausted', 'ip_backoff'];
        if (!capacityCodes.includes(error.code)) throw error;
        probeMs = Date.now() - selectionStartedAt;
        unit.retryExcludedAccountIds = [];
        unit.status = 'retry_wait';
        unit.submissionPhase = error.code === 'all_accounts_quota_exhausted'
          ? 'quota_wait_pending'
          : 'account_limit_retry_pending';
        unit.lastError = error.message;
        runState.queuePlan[index] = { ...unit };
        runState.nextTaskIndex = index;
        await pushState();
        // A spent quota has no cooldown to wait for, so it gets its own fallback window; a live
        // cooldown yields its exact expiry.
        const quotaOnly = error.code === 'all_accounts_quota_exhausted';
        if (quotaOnly) quotaWaitCount += 1;
        const waitMs = autoResumeDelayMs({ retryAt: error.retryAt, quotaOnly, quotaWaitAttempt: quotaWaitCount });
        const scheduledSec = Math.round(scheduleAutoResume(waitMs) / 1000);
        recordAttemptEnd(error.code === 'all_accounts_quota_exhausted'
          ? 'quota_exhausted'
          : error.code === 'all_accounts_quarantined' ? 'accounts_paused' : 'accounts_at_limit', {
          error: error.message,
          quotaBlocked: error.quotaBlocked || null,
        });
        const hint = scheduledSec > 0
          ? `авто-возобновление через ${scheduledSec} с или нажмите «возобновить»`
          : 'дождитесь освобождения слота и нажмите «возобновить»';
        const retryError = new Error(`${error.message}. ${hint}`);
        retryError.code = error.code;
        throw retryError;
      }
      throwIfStopped(runToken);
      unit.accountId = selectedAccount.accountId;
      unit.principalKey = selectedAccount.principalKey;
      const reservation = plannedLoads.get(unit.accountId) || {
        baselineLoad: Number(unit.assignmentBaselineLoad || 0),
        assigned: 0,
      };
      reservation.assigned += unit.audios.length;
      plannedLoads.set(unit.accountId, reservation);
      unit.assignmentBaselineLoad = reservation.baselineLoad;
      runState.queuePlan[index] = { ...unit, accountId: unit.accountId, principalKey: unit.principalKey, status: 'assigned' };
      await pushState();
      throwIfStopped(runToken);
    }
    probeMs = Date.now() - selectionStartedAt;
    const connectStartedAt = Date.now();
    if (!client) ({ client } = await activateAccount(unit.accountId, selectedAccount.principalKey));
    throwIfStopped(runToken);
    // The template and the SCRIPT batch preset do not change inside a run (the preset is written
    // and restored around every dispatch), so they are read once per account instead of ~1.1s of
    // three requests on every attempt.
    let connect = runConnectCache.get(unit.accountId);
    if (!connect) {
      const template = await client.getPtVideoInfo();
      throwIfStopped(runToken);
      const configResult = await client.listBatchConfigs('SCRIPT');
      throwIfStopped(runToken);
      const batchConfig = configResult?.configs?.[0];
      if (!batchConfig?.id) throw new Error(`DreamFace SCRIPT batch preset not found for ${unit.accountId}`);
      const detailResult = await client.getBatchConfigDetail(batchConfig.id);
      throwIfStopped(runToken);
      const originalConfig = detailResult?.config || {};
      connect = {
        templateId: template.templateId,
        batchConfigId: batchConfig.id,
        batchName: batchConfig.name || 'Bulk Batch',
        originalScriptConfigs: Array.isArray(originalConfig.script_configs) ? originalConfig.script_configs : [],
      };
      runConnectCache.set(unit.accountId, connect);
    }
    const context = {
      accountId: unit.accountId,
      principalKey: selectedAccount.principalKey,
      templateId: connect.templateId,
      batchConfigId: connect.batchConfigId,
      batchName: connect.batchName,
      originalScriptConfigs: connect.originalScriptConfigs,
      presetState: 'clean',
    };
    connectMs = Date.now() - connectStartedAt;
    setQueueSubmissionPhase(index, unit, 'preparing');
    runState.bulkContext = context;
    runState.currentTaskName = unit.video.name;
    setStatusText(`[${index + 1}/${queue.length}] подготовка аватара ${unit.video.name}`);
    await pushState();
    throwIfStopped(runToken);
    if (!unit.video.videoUrl) throw new Error(`${unit.video.name || 'video'}: DreamFace video URL missing`);
    const avatarStartedAt = Date.now();
    let avatarId = await getCachedAvatarId(unit.video.videoUrl, unit.accountId);
    throwIfStopped(runToken);
    let avatar;
    const usedCache = Boolean(avatarId);
    if (avatarId) {
      avatar = { avatarId };
      setStatusText(`[${index + 1}/${queue.length}] аватар ${unit.video.name}: кэш (уже зарегистрирован)`);
    } else {
      avatar = await client.addAvatar(unit.video.videoUrl);
      throwIfStopped(runToken);
      await setCachedAvatarId(unit.video.videoUrl, unit.accountId, avatar.avatarId);
      throwIfStopped(runToken);
    }
    phase0.record({
      type: 'avatar',
      unitId: unit.id,
      accountId: unit.accountId,
      cached: usedCache,
      latencyMs: Date.now() - avatarStartedAt,
    });
    prepMs = Date.now() - avatarStartedAt;

    const scriptConfigs = [];
    let uploadMsTotal = 0;
    for (let audioIndex = 0; audioIndex < unit.audios.length; audioIndex += 1) {
      throwIfStopped(runToken);
      const audio = unit.audios[audioIndex];
      const record = await getTaskBlob(audio.id);
      throwIfStopped(runToken);
      if (!record?.blob) throw new Error(`${audio.fileName}: normalized blob missing`);
      setStatusText(`[${index + 1}/${queue.length}] аудио ${audioIndex + 1}/${unit.audios.length}: ${audio.fileName}`);
      await pushState();
      throwIfStopped(runToken);
      const uploadStartedAt = Date.now();
      const uploaded = await client.uploadAudio(record.blob, audio.fileName);
      const uploadMs = Date.now() - uploadStartedAt;
      uploadMsTotal += uploadMs;
      phase0.record({
        type: 'upload',
        unitId: unit.id,
        accountId: unit.accountId,
        fileName: audio.fileName,
        bytes: Number(record.blob?.size || 0),
        latencyMs: uploadMs,
      });
      throwIfStopped(runToken);
      scriptConfigs.push({
        type: 'AUDIO',
        audio_config: {
          file_name: audio.fileName,
          audio_url: uploaded.filePath,
          audio_start_time: 0,
          audio_end_time: Number(audio.durationMs || record.durationMs || 0),
        },
      });
    }

    const batchName = context.batchName || 'Bulk Batch';
    let submitted;
    let watchUnit;
    let dispatchStarted = false;
    let retryAfterAccountLimit = false;
    const prepareAccountLimitRetry = async (error) => {
      if (retryAfterAccountLimit) return;
      retryAfterAccountLimit = true;
      const failedAccountId = String(unit.accountId);
      phase0.record({
        type: 'limit_hit',
        unitId: unit.id,
        accountId: failedAccountId,
        taskCount: unit.audios.length,
        error: error?.message || String(error),
        apiStatus: error?.apiStatus || '',
      });
      // Phase 2: "Account Limit Reached" is the submit quota running out, not concurrency —
      // the counter read here is what tells the two apart. A rejection with remaining = 0 is
      // not the account's fault and must not put it on a cooldown; a rejection with quota left
      // while works are already running is load, which earns only a short backoff.
      const [runningAtReject, quotaAtReject] = await Promise.all([
        client.getRunningWorks().catch(() => null),
        client.getBatchTimes().catch(() => null),
      ]);
      const runningIds = Array.isArray(runningAtReject?.workIds) ? runningAtReject.workIds.map(String) : null;
      if (runningIds || quotaAtReject) {
        phase0.record({
          type: 'running_probe',
          accountId: failedAccountId,
          phase: 'limit_hit',
          count: runningIds ? runningIds.length : null,
          ids: runningIds || [],
          quota: quotaAtReject,
        });
      }
      if (quotaAtReject) noteAccountQuota(failedAccountId, quotaAtReject);
      const quotaSpent = quotaExhausted(quotaAtReject);
      // A rejection the counter cannot explain means the counter is not the whole story: the
      // account is dropped for the rest of the run and its quota is read for real from now on,
      // instead of probing it with submissions that burn credits.
      if (!quotaSpent) {
        runUntrusted.add(failedAccountId);
        phase0.record({
          type: 'quota_unreliable',
          accountId: failedAccountId,
          quota: quotaAtReject,
          error: error?.apiStatus || error?.message || '',
        });
      }
      await noteAccountRejection(failedAccountId, {
        runningWorkIds: runningIds,
        quota: quotaAtReject,
        sampleError: error?.apiStatus || error?.message || '',
        tier: selectedAccount?.tier || '',
      });
      runRejections.push({ at: Date.now(), accountId: failedAccountId });
      recordAttemptEnd('limit_rejected', {
        accountId: failedAccountId,
        uploadMs: uploadMsTotal,
        submitMs,
        runningWorksAtReject: runningIds ? runningIds.length : null,
        quotaAtReject,
        rejectReason: quotaSpent ? 'quota_exhausted' : (runningIds && runningIds.length > 0 ? 'bulk_rejected_under_load' : 'bulk_rejected'),
      });
      const reservation = plannedLoads.get(failedAccountId);
      if (reservation && typeof reservation === 'object') {
        reservation.assigned = Math.max(0, Number(reservation.assigned || 0) - unit.audios.length);
      }
      unit.retryExcludedAccountIds = [...new Set([...(unit.retryExcludedAccountIds || []), failedAccountId])];
      unit.accountId = '';
      unit.principalKey = '';
      unit.status = 'retrying';
      unit.submissionPhase = 'account_limit_retry_pending';
      unit.acceptedCount = 0;
      unit.targetCount = unit.audios.length;
      unit.lastError = quotaSpent
        ? `Account ${failedAccountId}: submit quota exhausted (${quotaAtReject.remaining}/${quotaAtReject.total}); retrying this group on another account`
        : `Account ${failedAccountId} reached its active-work limit; retrying this group on another account`;
      delete unit.dispatchStartedAt;
      delete unit.submissionResult;
      runState.queuePlan[index] = { ...unit };
      runState.warnings = [...runState.warnings, quotaSpent
        ? `${unit.video.name}: квота отправок исчерпана на ${failedAccountId}, группа перенаправляется`
        : `${unit.video.name}: лимит активных работ на ${failedAccountId}, группа перенаправляется`];
      // Several rejections on different accounts inside a minute look like a per-IP rate limit:
      // pausing beats hammering.
      const ip = ipBackoffTriggered(runRejections);
      if (ip.triggered) {
        phase0.record({ type: 'ip_backoff', pauseMs: ip.pauseMs, accounts: ip.accounts, rejections: ip.recent });
        const scheduledSec = Math.round(scheduleAutoResume(ip.pauseMs) / 1000);
        runState.warnings = [...runState.warnings,
          `отказы на ${ip.accounts.length} аккаунтах за минуту — пауза ${Math.round(ip.pauseMs / 1000)} с`];
        await pushState();
        if (watchUnit) await removeBulkWatchUnit(watchUnit.id);
        const pauseError = new Error(`отказы на нескольких аккаунтах подряд: пауза ${Math.round(ip.pauseMs / 1000)} с`
          + (scheduledSec > 0 ? `, авто-возобновление через ${scheduledSec} с` : ''));
        pauseError.code = 'ip_backoff';
        pauseError.retryAt = Date.now() + ip.pauseMs;
        throw pauseError;
      }
      await pushState();
      if (watchUnit) await removeBulkWatchUnit(watchUnit.id);
    };
    await withAccountMutationLock(unit.accountId, async () => {
      try {
        runState.bulkContext = { ...context, presetState: 'dirty' };
        await pushState();
        throwIfStopped(runToken);
        // The quota read by the selection probe (adjusted by our own dispatches) is the value
        // before this submit; re-reading it here would be a third request per attempt.
        const quotaBefore = getProbeCacheEntry(unit.accountId).load?.quota || null;
        await client.updateBatchConfig(context.batchConfigId, batchName, scriptConfigs);
        throwIfStopped(runToken);
        try {
          await client.checkBatchText();
          throwIfStopped(runToken);
          const baseline = await client.getRunningWorks();
          throwIfStopped(runToken);
          const recentBaseline = await client.getRecentCreations(1, 100);
          throwIfStopped(runToken);
          unit.baselineWorkIds = [
            ...(baseline?.workIds || []),
            ...(recentBaseline?.items || []).map((item) => String(item?.id || '')).filter(Boolean),
          ];
          unit.submittedAt = new Date().toISOString();
          unit.correlationDeadline = new Date(Date.now() + (30 * 60 * 1000)).toISOString();
          watchUnit = await addBulkWatchUnit({
            id: unit.id,
            runId: runState.runId,
            accountId: unit.accountId,
            principalKey: selectedAccount.principalKey,
            expectedFileNames: unit.audios.map((audio) => audio.fileName),
            // Per-work durations, in the same order as expectedFileNames: the results download
            // needs them to mark where the server ping-pongs the source video.
            audioDurationsMs: unit.audios.map((audio) => Math.max(0, Math.round(Number(audio.durationMs || 0)))),
            sourceVideoMs: await readSourceVideoMs(unit.videoIndex),
            submittedAt: unit.submittedAt,
            correlationDeadline: unit.correlationDeadline,
            baselineWorkIds: unit.baselineWorkIds || [],
            // the account's queue depth when this work joined it: the drain telemetry compares
            // it with the completion time to calibrate the backlog threshold
            probeLoad: Number(selectedAccount?.probeLoad || 0),
            targetCount: unit.audios.length,
            status: 'pending',
            submissionPhase: 'ready_to_dispatch',
          });
          setQueueSubmissionPhase(index, unit, 'ready_to_dispatch', { status: 'pending' });
          await pushState();
          try {
            throwIfStopped(runToken);
          } catch (error) {
            setQueueSubmissionPhase(index, unit, 'cancelled_before_dispatch', {
              status: 'cancelled',
              lastError: 'Run stopped before DreamFace submission',
            });
            await pushState();
            await patchWatchSubmissionPhase(watchUnit, 'cancelled_before_dispatch', {
              status: 'cancelled',
              targetCount: 0,
              lastError: 'Run stopped before DreamFace submission',
            });
            throw error;
          }
          setQueueSubmissionPhase(index, unit, 'dispatching', { status: 'submitting', dispatchStartedAt: new Date().toISOString() });
          await pushState();
          await patchWatchSubmissionPhase(watchUnit, 'dispatching', { status: 'pending', dispatchStartedAt: unit.dispatchStartedAt });
          dispatchStarted = true;
          const submitStartedAt = Date.now();
          submitted = await client.animateImageBatch({
            avatarId: avatar.avatarId,
            videoUrl: unit.video.videoUrl,
            scriptConfigs,
            batchConfigId: context.batchConfigId,
            name: batchName,
            templateId: context.templateId,
          });
          submitMs = Date.now() - submitStartedAt;
          if (submitted.successCount > 0) {
            const submissionPhase = submitted.successCount < scriptConfigs.length ? 'requires_review' : 'accepted';
            setQueueSubmissionPhase(index, unit, submissionPhase, {
              status: submitted.successCount < scriptConfigs.length ? 'partial' : 'submitted',
              acceptedCount: submitted.successCount,
              targetCount: submitted.successCount,
              submissionResult: submitted,
            });
            await patchWatchSubmissionPhase(watchUnit, 'correlating', {
              status: 'pending',
              submissionResult: submitted,
              targetCount: submitted.successCount,
            }).catch((error) => {
              runState.warnings = [...runState.warnings, `не удалось сразу сохранить watcher отправки: ${error.message || String(error)}`];
            });
          } else {
            setQueueSubmissionPhase(index, unit, 'rejected_confirmed', {
              status: 'rejected',
              acceptedCount: 0,
              targetCount: unit.audios.length,
              submissionResult: submitted,
            });
            await patchWatchSubmissionPhase(watchUnit, 'rejected_confirmed', {
              status: 'rejected',
              submissionResult: submitted,
              lastError: 'DreamFace confirmed zero successful submissions',
              targetCount: unit.audios.length,
            }).catch((error) => {
              runState.warnings = [...runState.warnings, `не удалось сразу сохранить watcher отказа: ${error.message || String(error)}`];
            });
          }
          // One combined read replaces the separate quotaAfter + runningAfter calls: it feeds the
          // ack trace, the health model and the probe cache used by the next selection.
          const [runningAfter, quotaAfter] = await Promise.all([
            client.getRunningWorks().catch(() => null),
            client.getBatchTimes().catch(() => null),
          ]);
          const runningAfterIds = Array.isArray(runningAfter?.workIds) ? runningAfter.workIds.map(String) : null;
          phase0.record({
            type: 'dispatch_ack',
            unitId: unit.id,
            accountId: unit.accountId,
            accountPrincipal: selectedAccount.principalKey || '',
            taskCount: scriptConfigs.length,
            maxDurSec: Math.round(requiredDurationSeconds * 1000) / 1000,
            uploadMs: uploadMsTotal,
            submitMs,
            avatarCached: usedCache,
            quotaBefore,
            quotaAfter,
            successCount: submitted.successCount,
            failCount: submitted.failCount,
            runningAfter: runningAfterIds ? runningAfterIds.length : null,
            ...compactRaw(submitted.raw),
          });
          if (runningAfterIds) {
            phase0.record({
              type: 'running_probe',
              accountId: unit.accountId,
              phase: 't+0',
              count: runningAfterIds.length,
              ids: runningAfterIds,
            });
          }
          // Own delta first: even if the refresh below failed, the cached load still reflects
          // the batch we just accepted instead of advertising an idle account.
          noteOwnDispatch(unit.accountId, submitted.successCount);
          refreshProbeCache(unit.accountId, { runningWorks: runningAfter, quota: quotaAfter });
          if (submitted.successCount > 0) {
            noteAccountSuccess(unit.accountId, selectedAccount.tier, quotaAfter);
            quotaWaitCount = 0;
          }
          const probeAccountId = unit.accountId;
          const probePrincipal = selectedAccount.principalKey || '';
          ackMs = Date.now() - submitStartedAt - submitMs;
          recordAttemptEnd('accepted', {
            accountId: unit.accountId,
            uploadMs: uploadMsTotal,
            submitMs,
            successCount: submitted.successCount,
            failCount: submitted.failCount,
          });
          setTimeout(() => { void phase0ProbeRunning(probeAccountId, 't+30', probePrincipal); }, 30000);
          await pushState().catch((error) => {
            runState.warnings = [...runState.warnings, `не удалось сразу сохранить результат отправки: ${error.message || String(error)}`];
          });
        } catch (error) {
          if (submitted) throw error;
          if (error.code === 'account_limit_reached') {
            await prepareAccountLimitRetry(error);
            return;
          }
          // A failed attempt may mean the preset or the session moved under us, so the cached
          // connect context is dropped and read again on the retry.
          runConnectCache.delete(unit.accountId);
          recordAttemptEnd(error.code === 'run_stopped' ? 'stopped' : 'error', {
            accountId: unit.accountId,
            error: error?.message || String(error),
          });
          if (dispatchStarted && usedCache) {
            await invalidateCachedAvatarId(unit.video.videoUrl, unit.accountId);
            runState.warnings = [...runState.warnings, `кэш аватара инвалидирован для ${unit.video.name} на ${unit.accountId}: ${error.message}`];
          }
          if (watchUnit) {
            const stoppedBeforeDispatch = !dispatchStarted && error.code === 'run_stopped';
            const submissionPhase = dispatchStarted
              ? 'submission_uncertain'
              : stoppedBeforeDispatch ? 'cancelled_before_dispatch' : 'ready_to_dispatch';
            setQueueSubmissionPhase(index, unit, submissionPhase, {
              status: dispatchStarted ? 'submission_uncertain' : stoppedBeforeDispatch ? 'cancelled' : 'ready',
              lastError: error.message || String(error),
            });
            await Promise.allSettled([
              pushState(),
              patchWatchSubmissionPhase(watchUnit, submissionPhase, {
                status: dispatchStarted ? 'submission_uncertain' : stoppedBeforeDispatch ? 'cancelled' : 'ready',
                targetCount: stoppedBeforeDispatch ? 0 : watchUnit.targetCount,
                lastError: error.message || String(error),
                submissionError: dispatchStarted ? {
                  message: error.message || String(error),
                  recordedAt: new Date().toISOString(),
                } : undefined,
              }),
            ]);
          }
          throw error;
        }
        throwIfStopped(runToken);
      } catch (error) {
        if (error.code !== 'account_limit_reached') throw error;
        await prepareAccountLimitRetry(error);
      } finally {
        runState.bulkContext = { ...runState.bulkContext, presetState: 'restoring' };
        await pushState().catch(() => {});
        let presetState = 'restore_required';
        await client.updateBatchConfig(
          context.batchConfigId,
          batchName,
          context.originalScriptConfigs || [],
        ).then(() => {
          presetState = 'clean';
        }).catch((error) => {
          runState.warnings = [...runState.warnings, `не удалось восстановить preset ${unit.accountId}: ${error.message}`];
        });
        runState.bulkContext = { ...runState.bulkContext, presetState };
        await pushState();
      }
    });
    if (runState.bulkContext?.presetState === 'restore_required') {
      throw new Error('DreamFace preset restoration failed; run can be resumed after connection recovery');
    }
    if (retryAfterAccountLimit) {
      setStatusText(`[${index + 1}/${queue.length}] лимит аккаунта, выбираем другой`);
      await pushState();
      index -= 1;
      continue;
    }
    if (submitted.successCount !== scriptConfigs.length) {
      runState.warnings = [...runState.warnings, `bulk submit accepted ${submitted.successCount}/${scriptConfigs.length}; failed ${submitted.failCount || 0}`];
    }
    if (submitted.successCount === 0) {
      runState.failures = [...runState.failures, `${unit.video.name}: DreamFace rejected all submissions`];
    }

    completedAudioCount += submitted.successCount;
    runState.current = completedAudioCount;
    runState.nextTaskIndex = index + 1;
    runState.queuePlan[index] = { ...unit, accountId: unit.accountId, submittedAt: unit.submittedAt, workIds: [] };
    await pushState();

    unit.workIds = [];
    if (submitted.successCount === unit.audios.length) {
      for (const audio of unit.audios) await deleteTaskBlob(audio.id);
    }

    runState.queuePlan[index] = { ...unit, workIds: [...unit.workIds] };
    runState.downloadPlan = {
      ...runState.downloadPlan,
      expectedWorkIds: runState.queuePlan.flatMap((item) => item.workIds || []),
    };
    setStatusText(`[${index + 1}/${queue.length}] bulk OK: ${unit.audios.length}`);
    await pushState();
    await runBulkWatcher({ allowDuringRun: true }).catch(() => {});
  }

  const uncertainCount = runState.queuePlan.filter(isSubmissionUncertain).length;
  const rejectedCount = runState.queuePlan.filter((unit) => (
    unit.submissionPhase === 'rejected_confirmed' && Number(unit.acceptedCount || 0) === 0
  )).length;
  const reviewCount = uncertainCount + rejectedCount;
  if (reviewCount > 0) {
    runState.phase = 'finished';
    runState.interrupted = true;
    runState.recoverable = false;
    runState.interruptionReason = uncertainCount > 0
      ? 'completed_with_submission_uncertain'
      : 'completed_with_rejected_submissions';
    runState.finishedAt = new Date().toISOString();
    runState.downloadPlan = {
      ...runState.downloadPlan,
      lastStatus: 'requires_review',
      lastMessage: `безопасная очередь завершена; групп для проверки: ${reviewCount}`,
    };
    setStatusText(runState.downloadPlan.lastMessage);
    await phase0RecordRunEnd('requires_review');
    await pushState();
    return;
  }
  await finishRun('Отправка завершена. Ожидаем результаты DreamFace.');
}

async function stopPageExecutor(tabId) {
  if (!tabId) {
    return;
  }

  try {
    await callBackground('engine.pageAction', {
      tabId,
      pageAction: 'cancelActiveTask',
      payload: {},
    });
  } catch (_) {}
}

async function failRun(message, interruptionReason = '') {
  const remainingTasks = Array.isArray(runState.queuePlan)
    ? Math.max(0, runState.queuePlan.length - Number(runState.nextTaskIndex || 0))
    : 0;
  runState.phase = 'failed';
  runState.interrupted = Boolean(interruptionReason);
  runState.recoverable = runState.interrupted && remainingTasks > 0;
  runState.interruptionReason = interruptionReason;
  runState.finishedAt = new Date().toISOString();
  if (runState.interrupted) {
    runState.downloadPlan = {
      ...runState.downloadPlan,
      lastStatus: 'interrupted',
      lastMessage: message,
    };
  }
  setStatusText(message);
  await phase0RecordRunEnd(interruptionReason || 'failed');
  await pushState();
}

async function finishRun(message) {
  runState.phase = 'finished';
  runState.interrupted = false;
  runState.recoverable = false;
  runState.interruptionReason = '';
  runState.finishedAt = new Date().toISOString();
  setStatusText(message);
  await phase0RecordRunEnd('completed');
  await pushState();
}

async function finishStoppedRun() {
  const uncertainCount = (runState.queuePlan || []).filter(isSubmissionUncertain).length;
  const nextIndex = Number(runState.nextTaskIndex || 0);
  const hasSafeRemaining = (runState.queuePlan || []).slice(nextIndex).some((unit) => !isSubmissionUncertain(unit)
    && unit.submissionPhase !== 'accepted'
    && unit.submissionPhase !== 'rejected_confirmed');
  runState.phase = 'finished';
  runState.interrupted = true;
  runState.recoverable = hasSafeRemaining;
  runState.interruptionReason = uncertainCount > 0 ? 'stopped_with_submission_uncertain' : 'user_stopped';
  runState.finishedAt = new Date().toISOString();
  runState.downloadPlan = {
    ...runState.downloadPlan,
    lastStatus: uncertainCount > 0 ? 'submission_uncertain' : 'stopped',
    lastMessage: uncertainCount > 0
      ? `остановлено; отправок с неизвестным результатом: ${uncertainCount}`
      : 'обработка остановлена пользователем',
  };
  setStatusText(runState.downloadPlan.lastMessage);
  await phase0RecordRunEnd(runState.interruptionReason);
  await pushState();
}

async function failBulkRun(error) {
  const uncertainCount = (runState.queuePlan || []).filter(isSubmissionUncertain).length;
  if (uncertainCount === 0) {
    await failRun(`ошибка движка: ${error.message}`, 'bulk_failure');
    return;
  }
  await failRun(
    `ошибка после начала отправки; результат ${uncertainCount} отправок неизвестен и отслеживается без повтора: ${error.message}`,
    'bulk_submission_uncertain',
  );
}

async function runCreationsDownload(expectedFileNames) {
  if (expectedFileNames.length === 0) {
    return { ok: false, error: 'нет результатов для скачивания' };
  }

  runState.phase = 'downloading';
  runState.currentTaskName = expectedFileNames[expectedFileNames.length - 1] || '';
  setStatusText(`${ENGINE_STATUS_PREFIX} проверка результатов в Creations`);
  await pushState();

  try {
    const creationsTab = await callBackground('engine.ensureCreationsTab');
    const pageResponse = await callBackground('engine.pageAction', {
      tabId: creationsTab.tab.id,
      pageAction: 'downloadCreationsIfReady',
      payload: {
        expectedFileNames,
        expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
          ? [...runState.downloadPlan.expectedWorkIds]
          : [],
        startedAt: runState.startedAt,
      },
    });

    const result = pageResponse.response || {};
    if (result.status === 'success') {
      runState.downloadPlan = {
        ...runState.downloadPlan,
        expectedFileNames: [...expectedFileNames],
        expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
          ? [...runState.downloadPlan.expectedWorkIds]
          : [],
        lastStatus: 'success',
        lastMessage: `скачивание запущено: ${result.downloadedCount}`,
        pendingFiles: [],
        downloadedCount: result.downloadedCount || 0,
        matchedCount: Number(result.matchedCount || result.downloadedCount || expectedFileNames.length || 0),
      };
      setStatusText(`скачивание запущено: ${result.downloadedCount}`);
      await pushState();
      return { ok: true, result };
    }

    if (result.status === 'partial') {
      const pendingFiles = Array.isArray(result.pending) ? result.pending : [];
      const message = pendingFiles.length > 0
        ? `скачивание запущено: ${result.downloadedCount}; ещё не готовы: ${pendingFiles.slice(0, 6).join(', ')}`
        : `скачивание запущено: ${result.downloadedCount}`;

      runState.downloadPlan = {
        ...runState.downloadPlan,
        expectedFileNames: [...expectedFileNames],
        expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
          ? [...runState.downloadPlan.expectedWorkIds]
          : [],
        lastStatus: 'partial',
        lastMessage: message,
        pendingFiles,
        downloadedCount: result.downloadedCount || 0,
        matchedCount: Number(result.matchedCount || result.downloadedCount || 0),
      };
      runState.warnings = [...runState.warnings, message];
      setStatusText(message);
      await pushState();
      return { ok: true, result: { ...result, message } };
    }

    if (result.status === 'pending') {
      const pendingFiles = Array.isArray(result.pending) ? result.pending : [];
      const message = pendingFiles.length > 0
        ? `ещё не готовы: ${pendingFiles.slice(0, 6).join(', ')}`
        : 'результаты ещё не готовы';

      runState.downloadPlan = {
        ...runState.downloadPlan,
        expectedFileNames: [...expectedFileNames],
        expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
          ? [...runState.downloadPlan.expectedWorkIds]
          : [],
        lastStatus: 'pending',
        lastMessage: message,
        pendingFiles,
        downloadedCount: 0,
        matchedCount: Number(result.matchedCount || 0),
      };
      setStatusText(message);
      await pushState();
      return { ok: true, result: { ...result, message } };
    }

    if (result.status === 'failed') {
      const message = result.message || 'DreamFace завершил генерацию с ошибкой';
      runState.warnings = [...runState.warnings, message];
      runState.downloadPlan = {
        ...runState.downloadPlan,
        expectedFileNames: [...expectedFileNames],
        expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
          ? [...runState.downloadPlan.expectedWorkIds]
          : [],
        lastStatus: 'failed',
        lastMessage: message,
        pendingFiles: [],
        downloadedCount: Number(result.downloadedCount || 0),
        matchedCount: Number(result.matchedCount || result.downloadedCount || 0),
      };
      setStatusText(message);
      await pushState();
      return { ok: false, error: message, result };
    }

    const message = result.message || 'не удалось скачать результаты';
    runState.warnings = [...runState.warnings, message];
    runState.downloadPlan = {
      ...runState.downloadPlan,
      expectedFileNames: [...expectedFileNames],
      expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
        ? [...runState.downloadPlan.expectedWorkIds]
        : [],
      lastStatus: 'error',
      lastMessage: message,
      pendingFiles: [],
      downloadedCount: 0,
    };
    setStatusText(`не удалось скачать результаты: ${message}`);
    await pushState();
    return { ok: false, error: message };
  } catch (error) {
    const message = error.message || String(error);
    runState.warnings = [...runState.warnings, `autodownload: ${message}`];
    runState.downloadPlan = {
      ...runState.downloadPlan,
      expectedFileNames: [...expectedFileNames],
      expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
        ? [...runState.downloadPlan.expectedWorkIds]
        : [],
      lastStatus: 'error',
      lastMessage: message,
      pendingFiles: [],
      downloadedCount: 0,
    };
    setStatusText(`не удалось скачать результаты: ${message}`);
    await pushState();
    return { ok: false, error: message };
  }
}

async function processQueue(queue, runToken, startIndex = 0) {
  runState.total = queue.length;
  runState.summary.totalGeneratedTasks = queue.length;
  runState.queuePlan = queue.map((task) => ({ ...task }));
  runState.nextTaskIndex = startIndex;

  if (startIndex === 0) {
    runState.phase = 'ready';
    runState.current = 0;
    setStatusText(`${ENGINE_STATUS_PREFIX} нормализация завершена. задач: ${queue.length}`);
    await pushState();
  } else {
    runState.phase = 'ready';
    runState.current = startIndex;
    setStatusText(`${ENGINE_STATUS_PREFIX} возобновление очереди с ${startIndex + 1} задачи`);
    await pushState();
  }

  if (queue.length === 0) {
    await finishRun('нет задач для запуска');
    return;
  }

  runState.phase = 'running';
  runState.interrupted = false;
  runState.recoverable = false;
  runState.interruptionReason = '';
  runState.downloadPlan = {
    ...runState.downloadPlan,
    expectedFileNames: queue.map((task) => task.fileName).filter(Boolean),
    expectedWorkIds: queue.map((task) => task.workId || ''),
    lastStatus: 'ready',
    lastMessage: '',
    pendingFiles: [],
    downloadedCount: 0,
    matchedCount: 0,
    totalExpected: queue.length,
    checkedAt: '',
    checkedOnUrl: '',
  };
  await pushState();

  for (let index = startIndex; index < queue.length; index += 1) {
    throwIfStopped(runToken);

    const task = queue[index];
    const tabSnapshot = await callBackground('engine.getTabSnapshot', { tabId: runState.tabId });
    if (!tabSnapshot.tab) {
      await failRun('целевая вкладка закрыта. очередь остановлена.', 'target_tab_removed');
      return;
    }

    if (tabSnapshot.tab.discarded) {
      await failRun('вкладка DreamFace выгружена браузером. очередь остановлена.', 'target_tab_discarded');
      return;
    }

    const record = await getTaskBlob(task.id);
    if (!record) {
      runState.failures = [...runState.failures, `${task.fileName}: blob missing`];
      runState.nextTaskIndex = index + 1;
      await pushState();
      continue;
    }

    runState.current = index + 1;
    runState.currentTaskName = task.fileName;
    setStatusText(`[${index + 1}/${queue.length}] загрузка ${task.fileName}`);
    await pushState();

    let taskHandled = false;

    for (let attempt = 0; attempt <= TRANSIENT_TASK_RETRY_LIMIT; attempt += 1) {
      throwIfStopped(runToken);

      let pageResponse;

      try {
        const audioDataUrl = await blobToDataUrl(record.blob);
        pageResponse = await callBackground('engine.pageAction', {
          tabId: runState.tabId,
          pageAction: 'executeTaskOnPage',
          payload: {
            fileName: record.name,
            mimeType: record.type,
            audioDataUrl,
            videoIndex: task.videoIndex,
            borderCropPx: task.borderCropPx,
            taskLabel: `[${index + 1}/${queue.length}]`,
            maxDurationSeconds: runState.maxDurationSeconds,
          },
        });
      } catch (error) {
        const message = /message channel closed before a response was received/i.test(error.message || '')
          ? 'связь со страницей потеряна. обработка прервана, очередь не завершена.'
          : `связь со страницей потеряна: ${error.message}`;
        await failRun(message, 'page_executor_disconnected');
        return;
      }

      const result = pageResponse.response || {};

      if (result.status === 'success') {
        task.workId = result.workId || task.workId || '';
        task.animateImageId = result.animateImageId || task.animateImageId || '';
        if (result.recoveredAfter === 'limit') {
          runState.warnings = [
            ...runState.warnings,
            `${task.fileName}: submit подтвердился через running works после сигнала limit`,
          ];
        } else if (result.recoveredAfter === 'timeout') {
          runState.warnings = [
            ...runState.warnings,
            `${task.fileName}: submit подтвердился через running works после timeout`,
          ];
        }
        if (result.workIdAmbiguous) {
          runState.warnings = [
            ...runState.warnings,
            `${task.fileName}: найдено несколько кандидатов work id, использован первый`,
          ];
        } else if (!task.workId) {
          runState.warnings = [
            ...runState.warnings,
            `${task.fileName}: work id не определился, останется fallback через Creations`,
          ];
        }
        if (Array.isArray(runState.queuePlan) && runState.queuePlan[index]) {
          runState.queuePlan[index] = {
            ...runState.queuePlan[index],
            workId: task.workId,
            animateImageId: task.animateImageId,
          };
        }
        runState.downloadPlan = {
          ...runState.downloadPlan,
          expectedWorkIds: queue.map((queueTask) => queueTask.workId || ''),
        };
        await deleteTaskBlob(task.id);
        runState.nextTaskIndex = index + 1;
        setStatusText(`[${index + 1}/${queue.length}] OK`);
        taskHandled = true;
        break;
      }

      if (result.status === 'submitted_unknown') {
        await deleteTaskBlob(task.id);
        runState.nextTaskIndex = index + 1;
        const message = `${task.fileName}: ${result.message || 'подтверждение отправки не получено вовремя'}`;
        runState.warnings = [...runState.warnings, message];
        setStatusText(`[${index + 1}/${queue.length}] без подтверждения, проверим в Creations`);
        taskHandled = true;
        break;
      }

      if (result.status === 'submission_unconfirmed') {
        runState.warnings = [
          ...runState.warnings,
          `${task.fileName}: ${result.message || 'submit не подтвержден'}`,
        ];
        await pushState();
        await failRun(
          `отправка ${task.fileName} не подтверждена. очередь приостановлена, чтобы не пропустить аудио. проверьте сайт и нажмите "возобновить".`,
          'submission_unconfirmed',
        );
        return;
      }

      if (result.status === 'skipped_short' || result.status === 'skipped_long') {
        await deleteTaskBlob(task.id);
        runState.nextTaskIndex = index + 1;
        const reason = result.status === 'skipped_short'
          ? `< ${MIN_DURATION_SECONDS} сек`
          : `> ${runState.maxDurationSeconds} сек`;
        runState.skipped = [...runState.skipped, `${task.fileName} (${reason})`];
        setStatusText(`[${index + 1}/${queue.length}] пропуск ${reason}`);
        taskHandled = true;
        break;
      }

      if (result.status === 'stopped') {
        throwIfStopped(runToken);
      }

      if (isTransientTaskResult(result)) {
        const message = result.message || 'timeout';
        if (attempt < TRANSIENT_TASK_RETRY_LIMIT) {
          const nextAttempt = attempt + 2;
          const totalAttempts = TRANSIENT_TASK_RETRY_LIMIT + 1;
          setStatusText(`[${index + 1}/${queue.length}] сеть нестабильна, повтор ${nextAttempt}/${totalAttempts}`);
          await pushState();
          await waitForRetryDelay(runToken, TRANSIENT_TASK_RETRY_BASE_DELAY_MS * (attempt + 1));
          continue;
        }

        runState.warnings = [
          ...runState.warnings,
          `${task.fileName}: временный сбой сети (${message})`,
        ];
        await pushState();
        await failRun(
          `соединение нестабильно. очередь приостановлена на ${task.fileName}. восстановите интернет и нажмите "возобновить".`,
          'transient_network_failure',
        );
        return;
      }

      await deleteTaskBlob(task.id);
      runState.nextTaskIndex = index + 1;
      const message = result.message || 'page task failed';
      runState.failures = [...runState.failures, `${task.fileName}: ${message}`];
      setStatusText(`[${index + 1}/${queue.length}] ошибка: ${message}`);
      taskHandled = true;
      break;
    }

    if (!taskHandled) {
      return;
    }

    await pushState();
  }

  runState.current = queue.length;
  runState.nextTaskIndex = queue.length;
  await finishRun('очередь завершена. откройте страницу Creations вручную и нажмите "проверить результаты"');
}

async function triggerCreationsDownload() {
  const expectedFileNames = Array.isArray(runState.downloadPlan?.expectedFileNames)
    ? runState.downloadPlan.expectedFileNames.filter(Boolean)
    : [];

  if (expectedFileNames.length === 0) {
    return { ok: false, error: 'нет результатов для Creations' };
  }

  const downloadResult = await runCreationsDownload(expectedFileNames);
  if (!downloadResult.ok || downloadResult.result?.status !== 'success') {
    runState.phase = 'finished';
    await pushState();
    return { ok: downloadResult.ok, state: cloneState(), error: downloadResult.error || '' };
  }

  runState.phase = 'finished';
  await pushState();
  return { ok: true, state: cloneState() };
}

async function resetRunState() {
  if (isBusyPhase(runState.phase)) {
    return { ok: false, error: 'engine is busy' };
  }

  try {
    await restoreBulkPresetIfNeeded();
  } catch (error) {
    return { ok: false, error: `DreamFace preset must be restored before reset: ${error.message || String(error)}` };
  }
  await resetRunStateInternal();
  initializationError = null;
  return { ok: true, state: cloneState() };
}

async function startRun(payload, admissionToken) {
  await restoreBulkPresetIfNeeded();
  if (autoResumeTimer) {
    clearTimeout(autoResumeTimer);
    autoResumeTimer = null;
  }
  currentRunToken += 1;
  const runToken = currentRunToken;
  stopRequested = false;

  await clearTaskBlobs();
  runConnectCache.clear();
  runUntrusted.clear();
  runRejections.length = 0;
  quotaWaitCount = 0;

  sourceVideoMsByRun.clear();
  runState = createIdleRunState();
  runState.mode = payload.mode === 'bulk' ? 'bulk' : 'legacy';
  runState.phase = 'preparing';
  runState.runId = createRunId();
  runState.tabId = payload.tabId;
  runState.startedAt = new Date().toISOString();
  runState.maxDurationSeconds = Number(payload.options?.maxDurationSeconds) > DEFAULT_MAX_DURATION_SECONDS
    ? Number(payload.options.maxDurationSeconds)
    : DEFAULT_MAX_DURATION_SECONDS;
  runState.autoNormalize = payload.options.autoNormalize;
  runState.overlapEnabled = payload.options.overlapEnabled;
  runState.normalization.totalCount = countInputFiles(payload.batches);
  runState.queuePlan = [];
  runState.nextTaskIndex = 0;
  runState.recoverable = false;
  setStatusText(`${ENGINE_STATUS_PREFIX} подготовка очереди`);
  await pushState();

  try {
    phase0.setContext({ runId: runState.runId, mode: runState.mode });
    if (runState.mode === 'bulk') {
      // Choose the least-loaded account WITHOUT filtering by raw input duration.
      // The raw longest input (e.g. 897s) may exceed every account's limit (e.g. 600s);
      // filtering by it aborted the run before normalizeFile could split long audios.
      // Instead, drive the split target from the MAX duration supported across all
      // accounts so normalizeFile slices long inputs into chunks every qualifying
      // account can accept, and per-unit dispatch (selectLeastLoadedAccount) succeeds.
      const selected = await selectLeastLoadedAccount(0, new Map(), '', new Set(), 'preflight');
      const splitTarget = Math.max(
        Number(selected.availableMaximumSeconds || 0),
        Number(selected.maxDurationSeconds || 0),
        DEFAULT_MAX_DURATION_SECONDS,
      );
      runState.bulkContext = { accountId: selected.accountId, maxDurationSeconds: splitTarget, presetState: 'clean' };
      runState.maxDurationSeconds = splitTarget;
      payload.options = { ...payload.options, maxDurationSeconds: splitTarget };
      await pushState();
    }
    phase0.record({
      type: 'run_start',
      batches: Array.isArray(payload.batches) ? payload.batches.length : 0,
      audios: countInputFiles(payload.batches),
      videos: (payload.batches || []).reduce((sum, batch) => sum + (batch.selectedAvatars || []).length, 0),
      splitTarget: runState.maxDurationSeconds,
      overlap: Boolean(runState.overlapEnabled),
      autoNormalize: Boolean(runState.autoNormalize),
    });
    const { queue, summary, consumedInputIds = [] } = runState.mode === 'bulk'
      ? await prepareBulkPlan(payload, runToken)
      : await prepareTasks(payload, runToken);
    // LPT is a dispatch-order decision, not a display one: `sourceIndex` keeps the operator's
    // order available to the monitor while the queue itself runs longest-first.
    const dispatchQueue = runState.mode === 'bulk' && featureEnabled('lptOrder')
      ? orderUnitsForDispatch(queue)
      : queue;
    // Plan preview: the same ranking, run over the whole queue against the snapshot the preflight
    // just took, so the shipments are known before the first upload — and so the estimate of
    // credits and tail is part of the log.
    if (runState.mode === 'bulk' && featureEnabled('planPreview') && lastProbeSnapshot.length > 0) {
      const tierEnabled = featureEnabled('backlogTier');
      runState.plan = simulatePlan(dispatchQueue, lastProbeSnapshot, { tierEnabled });
      // The forecast needs the avatar cache, which only the engine can read: 13 of 18 registrations
      // were cold on the 15:30 run and cost ~24 s of the dispatch.
      const unitById = new Map(dispatchQueue.map((item) => [item.id, item]));
      const coldPairs = (await Promise.all(runState.plan.assignments.map(async (assignment) => {
        const videoUrl = unitById.get(assignment.unitId)?.video?.videoUrl;
        if (!videoUrl) return false;
        return !await getCachedAvatarId(videoUrl, assignment.accountId);
      }))).filter(Boolean).length;
      runState.plan.estimates = estimatePlan(
        { ...runState.plan, pool: lastProbeSnapshot },
        { coldAvatarPairs: coldPairs },
      );
      runState.plan.estimates.coldAvatarPairs = coldPairs;
      runState.planSummary = summarizePlan(runState.plan);
      phase0.record({
        type: 'run_plan',
        creditsSpent: runState.plan.creditsSpent,
        creditsLeft: runState.plan.creditsLeft,
        accounts: runState.plan.accounts,
        deferred: runState.plan.deferred,
        estimates: runState.plan.estimates,
        assignments: runState.plan.assignments.slice(0, 60),
      });
      setStatusText(runState.planSummary);
    }
    runState.summary = summary;
    runState.queuePlan = dispatchQueue.map((item) => ({ ...item }));
    await pushState();
    if (runState.mode === 'bulk') {
      for (const id of consumedInputIds) await deleteInputFileRecord(id);
    }
    if (dispatchQueue.length === 0) {
      // A run that never dispatches anything is a failure, not a finished submission: the operator
      // would otherwise wait for results that were never requested. Seen live when every input
      // failed to prepare (two "source file missing" failures reported as "Отправка завершена").
      await failRun(runState.failures.length > 0
        ? `нечего отправлять: не подготовлено ни одного файла (ошибок: ${runState.failures.length})`
        : 'нечего отправлять: очередь пуста');
      return;
    }
    if (runState.mode === 'bulk') {
      await processBulkQueue(dispatchQueue, runToken);
    } else {
      await processQueue(dispatchQueue, runToken);
    }
  } catch (error) {
    if (error.code === 'run_stopped') {
      await finishStoppedRun();
      return;
    }

    if (runState.mode === 'bulk') await failBulkRun(error);
    else await failRun(`ошибка движка: ${error.message}`);
  } finally {
    stopRequested = false;
    if (runState.phase === 'finished') {
      await clearInputFiles().catch(() => {});
    }
    releaseRunAdmission(admissionToken);
  }
}

async function resumeRun(payload = {}, admissionToken) {
  if (isBusyPhase(runState.phase)) {
    releaseRunAdmission(admissionToken);
    return { ok: false, error: 'engine is already busy' };
  }

  if (runState.mode !== 'bulk') {
    releaseRunAdmission(admissionToken);
    return { ok: false, error: 'legacy-очередь нельзя возобновить после bulk-миграции; запустите её заново' };
  }

  if (!Array.isArray(runState.queuePlan) || runState.queuePlan.length === 0) {
    releaseRunAdmission(admissionToken);
    return { ok: false, error: 'очередь для возобновления не найдена' };
  }

  if (Number(runState.nextTaskIndex || 0) >= runState.queuePlan.length) {
    releaseRunAdmission(admissionToken);
    return { ok: false, error: 'в очереди не осталось задач для возобновления' };
  }

  if (payload.tabId) {
    runState.tabId = payload.tabId;
  }

  currentRunToken += 1;
  const runToken = currentRunToken;
  stopRequested = false;
  runState.finishedAt = null;
  runState.interrupted = false;
  runState.recoverable = false;
  runState.interruptionReason = '';
  setStatusText(`${ENGINE_STATUS_PREFIX} возобновление очереди`);
  await pushState();

  try {
    await restoreBulkPresetIfNeeded();
  } catch (error) {
    await failRun(`не удалось восстановить DreamFace preset: ${error.message}`, 'bulk_preset_restore_failed');
    releaseRunAdmission(admissionToken);
    return { ok: false, error: error.message };
  }

  const processor = runState.mode === 'bulk' ? processBulkQueue : processQueue;
  processor(runState.queuePlan, runToken, Number(runState.nextTaskIndex || 0)).catch(async (error) => {
    if (error.code === 'run_stopped') await finishStoppedRun();
    else if (runState.mode === 'bulk') await failBulkRun(error);
    else await failRun(`ошибка движка: ${error.message}`);
  }).finally(() => {
    releaseRunAdmission(admissionToken);
  });

  return { ok: true, state: cloneState() };
}

async function stopRun() {
  if (!isBusyPhase(runState.phase)) {
    return { ok: true, alreadyStopped: true, state: cloneState() };
  }
  if (autoResumeTimer) {
    clearTimeout(autoResumeTimer);
    autoResumeTimer = null;
  }
  stopRequested = true;
  runState.phase = 'stopping';
  setStatusText('остановка...');
  await pushState();
  await resetFfmpeg();
  await stopPageExecutor(runState.tabId);
  return { ok: true };
}

async function handleTabLifecycle(payload) {
  if (runState.mode === 'bulk') {
    return;
  }

  if (!runState.runId || payload.tabId !== runState.tabId) {
    return;
  }

  if (payload.event === 'removed' && runState.phase !== 'finished' && runState.phase !== 'failed') {
    stopRequested = true;
    await failRun('целевая вкладка закрыта. очередь остановлена.', 'target_tab_removed');
    return;
  }

  if (payload.event === 'updated' && payload.changeInfo) {
    if (payload.changeInfo.discarded === true && runState.phase === 'running') {
      stopRequested = true;
      await stopPageExecutor(runState.tabId);
      await failRun('вкладка DreamFace выгружена браузером. очередь остановлена.', 'target_tab_discarded');
      return;
    }

    if (payload.changeInfo.url && !/dreamfaceapp\.com/i.test(payload.changeInfo.url) && runState.phase === 'running') {
      stopRequested = true;
      await stopPageExecutor(runState.tabId);
      await failRun('страница DreamFace была заменена. очередь остановлена.', 'target_tab_navigated');
    }
  }
}

// ---------- DOWNLOAD WITH CHAPTERS ----------
// Качаем готовый mp4 с DreamFace OSS, если есть мета (audioMs+videoMs)
// и аудио длиннее видео — добавляем chapter markers через ffmpeg -c copy.
// Иначе — просто сохраняем как есть. Имя — work_name + .mp4.

function safeFileName(name) {
  // нормализуем unicode (NFC) — иначе кириллица в decomposed-форме
  // может ломать chrome.downloads
  let s = String(name || 'video');
  try {
    s = s.normalize('NFC');
  } catch {}

  // убираем все control + path separators + windows-запрещённые
  s = s
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    // нулевая ширина и прочие невидимые
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // не должен начинаться с точки/дефиса (chrome может посчитать «скрытым»)
  s = s.replace(/^[.\-\s]+/, '');

  // лимит длины (FS: ~255, оставляем запас под .mp4)
  if (s.length > 180) {
    s = s.slice(0, 180);
  }

  return s || 'video';
}

// uuid вида 2657386b-c91c-4df7-8169-b839df9c6c2e
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeUuid(name) {
  const cleaned = String(name || '').trim().replace(/\.(mp4|mp3|wav|m4a|ogg|aac|flac)$/i, '');
  return UUID_RE.test(cleaned);
}

// Возвращает имя для скачиваемого файла. Приоритет:
//   1) audioFileName (имя оригинального аудио из очереди)
//   2) workName, если оно не похоже на uuid и не пустое
//   3) workId (последний фолбек)
function pickDownloadBaseName({ audioFileName, workName, workId }) {
  const audioName = String(audioFileName || '').trim();
  if (audioName) {
    return audioName;
  }
  const api = String(workName || '').trim();
  if (api && !looksLikeUuid(api)) {
    return api;
  }
  return String(workId || 'video').trim() || 'video';
}

function buildChaptersFfmetadata({ audioMs, videoMs }) {
  const lines = [';FFMETADATA1', 'title=dreamface lipsync'];
  let t = 0;
  let k = 0;
  while (t < audioMs) {
    const segEnd = Math.min(t + videoMs, audioMs);
    const title = k === 0
      ? 'forward 1'
      : (k % 2 ? `reverse ${Math.ceil(k / 2)}` : `forward ${k / 2 + 1}`);
    lines.push('');
    lines.push('[CHAPTER]');
    lines.push('TIMEBASE=1/1000');
    lines.push(`START=${Math.round(t)}`);
    lines.push(`END=${Math.round(segEnd)}`);
    lines.push(`title=${title}`);
    t += videoMs;
    k += 1;
  }
  return lines.join('\n') + '\n';
}

async function muxChaptersInMp4(mp4Bytes, audioMs, videoMs) {
  await ensureFfmpegLoaded();

  const inPath = `in-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`;
  const metaPath = `meta-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
  const outPath = `out-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`;

  try {
    await ffmpeg.writeFile(inPath, mp4Bytes);
    const ffmeta = buildChaptersFfmetadata({ audioMs, videoMs });
    await ffmpeg.writeFile(metaPath, new TextEncoder().encode(ffmeta));

    const code = await ffmpeg.exec([
      '-y',
      '-i', inPath,
      '-i', metaPath,
      '-map_metadata', '1',
      '-map_chapters', '1',
      '-c', 'copy',
      outPath,
    ], 120000);

    if (code !== 0) {
      throw new Error(`ffmpeg mux returned ${code}`);
    }

    const buf = await ffmpeg.readFile(outPath);
    return new Uint8Array(buf.buffer.slice(0));
  } finally {
    await safeDeleteFsFile(inPath);
    await safeDeleteFsFile(metaPath);
    await safeDeleteFsFile(outPath);
  }
}

async function downloadOneWithChapters(item) {
  const { workId, workName, url, audioMs, videoMs, hasChapters, audioFileName } = item;
  console.log('[offscreen] downloading', { workId, workName, audioFileName, hasChapters, audioMs, videoMs, urlPrefix: url.slice(0, 80) });

  // Качаем оригинальный mp4
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error('fetch network error: ' + err.message);
  }
  if (!response.ok) {
    throw new Error(`fetch ${response.status} ${response.statusText}`);
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  console.log('[offscreen] mp4 fetched', { workId, bytes: buf.length });

  let finalBytes = buf;
  let chaptersAdded = 0;

  if (hasChapters && Number.isFinite(audioMs) && Number.isFinite(videoMs) && videoMs > 0) {
    try {
      finalBytes = await withFfmpegMutex(() => muxChaptersInMp4(buf, audioMs, videoMs));
      chaptersAdded = Math.ceil(audioMs / videoMs);
      console.log('[offscreen] chapters added', { workId, chaptersAdded, audioMs, videoMs });
    } catch (err) {
      console.warn('[offscreen] mux failed, saving without chapters:', err.message);
      finalBytes = buf;
      chaptersAdded = 0;
    }
  }

  const blob = new Blob([finalBytes], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  // имя для .mp4 формируем по приоритету:
  //   1) audioFileName (имя оригинального аудио — то, что юзер видит в очереди)
  //   2) workName из API (может быть uuid — но если это не похоже на uuid, используем)
  //   3) workId как последний фолбек
  const baseName = pickDownloadBaseName({ audioFileName, workName, workId });
  const fileName = safeFileName(baseName).replace(/\.(mp3|wav|m4a|ogg|aac|flac|mp4)$/i, '') + '.mp4';

  // chrome.downloads недоступен из offscreen → отдаём blob:URL в background.
  // blob:URL валиден в любом контексте того же extension origin; SW МОЖЕТ передать его
  // в chrome.downloads.download. Если не сработает — фоллбек через ArrayBuffer→content_script.
  console.log('[offscreen] handing blob to background', { workId, fileName, bytes: finalBytes.length, blobUrl: blobUrl.slice(0, 60) });
  const ack = await chrome.runtime.sendMessage({
    action: 'engine.saveDownload',
    payload: { blobUrl, fileName },
  });
  if (!ack || !ack.ok) {
    URL.revokeObjectURL(blobUrl);
    throw new Error('saveDownload failed: ' + (ack?.error || 'unknown'));
  }

  // освобождаем blob НЕМЕДЛЕННО — chrome.downloads уже принял blob:URL
  // и держит его внутри. Раньше держали 60с «на всякий случай», что приводило
  // к удержанию ~60МБ × N файлов в RAM offscreen document и деградации скорости.
  try {
    URL.revokeObjectURL(blobUrl);
  } catch {}

  return { workId, workName, fileName, bytes: finalBytes.length, chaptersAdded };
}

// ffmpeg.wasm — один инстанс на offscreen document. muxChaptersInMp4 НЕ thread-safe
// (общая FS + общий heap), поэтому все вызовы должны быть строго последовательными.
// Реализуем простой promise-based mutex.
let ffmpegMutexChain = Promise.resolve();
function withFfmpegMutex(taskFn) {
  const run = ffmpegMutexChain.then(() => taskFn(), () => taskFn());
  // следующий ждёт окончания текущего (успех/ошибка), но цепочка не падает
  ffmpegMutexChain = run.catch(() => {});
  return run;
}

// Принимает signed URL + transform metadata, возвращает blob:URL.
// SW не может вызывать URL.createObjectURL — поэтому blob:URL создаём ЗДЕСЬ (в offscreen),
// и возвращаем строку URL. Затем SW вызывает chrome.downloads.download({url: blobUrl, ...}).
// blob:URL валиден для всего extension origin, его можно скачать из любого контекста.
//
// После завершения скачивания SW шлёт {action:'revokeBlob', payload:{blobUrl}} чтобы
// освободить blob из памяти (см. handleRevokeBlob).
async function handleMuxOne(payload) {
  const buf = payload?.buffer;
  const url = String(payload?.url || '');
  const audioMs = Number(payload?.audioMs);
  const videoMs = Number(payload?.videoMs);
  const hasChapters = Boolean(payload?.hasChapters);
  if (!url && (!buf || (!(buf instanceof ArrayBuffer) && !(buf?.byteLength >= 0)))) {
    return { ok: false, error: 'video source missing' };
  }
  try {
    let outBytes;
    if (url) {
      const controller = new AbortController();
      const timeoutMs = Math.max(1000, Number(payload?.fetchTimeoutMs) || 120000);
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`fetch ${response.status} ${response.statusText}`);
        }
        outBytes = new Uint8Array(await response.arrayBuffer());
      } finally {
        clearTimeout(timeoutId);
      }
    } else {
      outBytes = new Uint8Array(buf);
    }
    let chapters = 0;
    if (hasChapters && Number.isFinite(audioMs) && Number.isFinite(videoMs) && videoMs > 0 && audioMs > videoMs) {
      try {
        outBytes = await withFfmpegMutex(() => muxChaptersInMp4(outBytes, audioMs, videoMs));
        chapters = Math.ceil(audioMs / videoMs);
      } catch (err) {
        throw new Error(`chapter mux failed: ${err.message}`);
      }
    }
    const blob = new Blob([outBytes], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    const blobLeaseId = crypto.randomUUID();
    processedBlobLeases.set(blobLeaseId, {
      blobUrl,
      createdAt: Date.now(),
      workId: String(payload?.workId || ''),
    });
    return { ok: true, blobUrl, blobLeaseId, bytes: outBytes.byteLength, chapters };
  } catch (err) {
    console.error('[offscreen] muxOne failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ---------- PRE-LOOP VIDEO UNDER LONGEST AUDIO ----------
// Идея: на старте группы (1 видео + N аудио) посчитать max(audioMs),
// скачать исходное видео по OSS-URL, локально через ffmpeg.wasm склеить
// его само с собой встык столько раз, сколько нужно, чтобы суммарная
// длительность >= maxAudioMs. Только forward, никакого реверса.
// На выходе — Blob mp4 + blob:URL для дальнейшей передачи в content_script.
//
// Стратегия:
//   1) сначала пытаемся через -stream_loop N -c copy (быстро, без перекода).
//   2) если ffmpeg вернёт ошибку (несовпадение GOP, не выровнен keyframe и т.д.),
//      пересборка через -c:v libx264 -preset ultrafast -c:a aac.
//
// Возвращает: { ok, blobUrl, bytes, repeats, mode: 'copy'|'reencode', sourceMs, finalMs }
async function handlePreLoopVideo(payload) {
  const sourceUrl = String(payload?.sourceUrl || '');
  const targetMs = Number(payload?.targetMs);
  const sourceMsHint = Number(payload?.sourceMs);

  if (!sourceUrl) {
    return { ok: false, error: 'sourceUrl missing' };
  }
  if (!Number.isFinite(targetMs) || targetMs <= 0) {
    return { ok: false, error: 'invalid targetMs' };
  }

  console.log('[offscreen] preLoop start', { sourceUrl: sourceUrl.slice(0, 80), targetMs, sourceMsHint });

  // 1) fetch исходного видео
  let srcBytes;
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`fetch ${response.status} ${response.statusText}`);
    }
    srcBytes = new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    return { ok: false, error: `fetch source failed: ${err.message}` };
  }

  console.log('[offscreen] preLoop source fetched', { bytes: srcBytes.length });

  try {
    const result = await withFfmpegMutex(() => preLoopVideoMp4(srcBytes, targetMs, sourceMsHint));

    // dreamface режет upload видео где-то в районе 100 MB. если размер
    // pre-loop'ed файла слишком большой — не отдаём blob:URL вообще,
    // вызов runPreLoopPhase увидит ok=false и оставит группу на старом
    // пути (chapter-markers).
    const MAX_UPLOAD_BYTES = 95 * 1024 * 1024; // 95 MB — запас под лимит
    if (result.bytes.byteLength > MAX_UPLOAD_BYTES) {
      console.warn('[offscreen] preLoop blob слишком большой, отдаём ошибку', {
        bytes: result.bytes.byteLength,
        limit: MAX_UPLOAD_BYTES,
        mode: result.mode,
        repeats: result.repeats,
      });
      return {
        ok: false,
        error: `pre-loop файл получился слишком большим: ${Math.round(result.bytes.byteLength / (1024 * 1024))} MB (лимит ~95 MB). видео не залито, группа пойдёт по стандартному пути.`,
        bytes: result.bytes.byteLength,
        repeats: result.repeats,
        mode: result.mode,
      };
    }

    const blob = new Blob([result.bytes], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    return {
      ok: true,
      blobUrl,
      bytes: result.bytes.byteLength,
      repeats: result.repeats,
      mode: result.mode,
      sourceMs: result.sourceMs,
      finalMs: result.finalMs,
    };
  } catch (err) {
    console.error('[offscreen] preLoop failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Сама pre-loop логика. Возвращает { bytes, repeats, mode, sourceMs, finalMs }.
async function preLoopVideoMp4(srcBytes, targetMs, sourceMsHint) {
  await ensureFfmpegLoaded();

  const tag = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const inPath = `preloop-in-${tag}.mp4`;
  const outPath = `preloop-out-${tag}.mp4`;

  await ffmpeg.writeFile(inPath, srcBytes);

  // оценка длительности исходника. сначала верим хинту от content_script
  // (там делается через невидимый <video preload=metadata>, точно).
  // если хинта нет — пробуем ffprobe-like через ffmpeg.
  let sourceMs = Number(sourceMsHint);
  if (!Number.isFinite(sourceMs) || sourceMs <= 0) {
    sourceMs = await probeVideoDurationMs(inPath).catch(() => 0);
  }
  if (!Number.isFinite(sourceMs) || sourceMs <= 0) {
    await safeDeleteFsFile(inPath);
    throw new Error('не удалось определить длительность исходного видео');
  }

  // сколько раз надо повторить (включая первое воспроизведение)
  const repeats = Math.max(1, Math.ceil(targetMs / sourceMs));
  const finalMs = repeats * sourceMs;
  // -stream_loop принимает число ДОПОЛНИТЕЛЬНЫХ повторов (loops после первого);
  // т.е. для repeats=1 → loop=0, для repeats=4 → loop=3.
  const streamLoopArg = String(repeats - 1);

  // === path 1: try stream_copy (быстро, без перекода) ===
  const copyArgs = [
    '-y',
    '-stream_loop', streamLoopArg,
    '-i', inPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ];

  try {
    const code = await ffmpeg.exec(copyArgs, 90000);
    if (code === 0) {
      const buf = await ffmpeg.readFile(outPath);
      const bytes = new Uint8Array(buf.buffer.slice(0));
      await safeDeleteFsFile(inPath);
      await safeDeleteFsFile(outPath);
      console.log('[offscreen] preLoop done via stream_copy', { repeats, sourceMs, finalMs, bytes: bytes.byteLength });
      return { bytes, repeats, mode: 'copy', sourceMs, finalMs };
    }
    console.warn('[offscreen] preLoop stream_copy non-zero exit:', code);
  } catch (err) {
    console.warn('[offscreen] preLoop stream_copy threw:', err.message);
  }

  // прибираем кривой out (если остался) перед re-encode
  await safeDeleteFsFile(outPath);

  // === path 2: re-encode ===
  // libx264 preset=veryfast + CRF=26. ultrafast давал слишком жирный файл
  // (нет motion estimation → битрейт безумный), и dreamface режет upload
  // на ~100 MB. veryfast/CRF=26 даёт визуально близкое качество при
  // 3-5x меньшем размере, при этом всё ещё быстрый (доли секунды на 30s mp4
  // на m1/intel-десктопе).
  const reArgs = [
    '-y',
    '-stream_loop', streamLoopArg,
    '-i', inPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '26',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outPath,
  ];

  try {
    const code = await ffmpeg.exec(reArgs, 240000);
    if (code !== 0) {
      await safeDeleteFsFile(inPath);
      await safeDeleteFsFile(outPath);
      throw new Error(`ffmpeg re-encode returned ${code}`);
    }
    const buf = await ffmpeg.readFile(outPath);
    const bytes = new Uint8Array(buf.buffer.slice(0));
    await safeDeleteFsFile(inPath);
    await safeDeleteFsFile(outPath);
    console.log('[offscreen] preLoop done via re-encode', { repeats, sourceMs, finalMs, bytes: bytes.byteLength });
    return { bytes, repeats, mode: 'reencode', sourceMs, finalMs };
  } catch (err) {
    await safeDeleteFsFile(inPath);
    await safeDeleteFsFile(outPath);
    throw err;
  }
}

// Прокинуть исходник через ffmpeg только чтобы прочитать длительность.
// Используется как фолбек, когда content_script не передал sourceMs.
// Запускаем ffmpeg с -t 0 в /dev/null-аналог — он напечатает Duration в логах,
// но они нам недоступны из JS из-за конфигурации логгера. Поэтому
// используем неприятный, но рабочий трюк: ffprobe-эмуляция через -f null - .
// Если не сработает — вернётся 0, и preLoopVideoMp4 кинет ошибку.
async function probeVideoDurationMs(inPath) {
  // ffmpeg.wasm не имеет ffprobe. Используем -hide_banner + -i + -f null,
  // но получить длительность программно из вывода не выйдет напрямую.
  // Проще — попросить vendored ffmpeg вывести метаданные через -loglevel info
  // и парсить. На практике сложно. Возвращаем 0 → форсим хинт с верхнего слоя.
  return 0;
}

// Освободить blob:URL после того как chrome.downloads его подхватил.
function handleRevokeBlob(payload) {
  const blobLeaseId = String(payload?.blobLeaseId || '');
  const lease = blobLeaseId ? processedBlobLeases.get(blobLeaseId) : null;
  const blobUrl = lease?.blobUrl || payload?.blobUrl;
  if (!blobUrl) return { ok: false, error: 'no blobUrl' };
  try {
    URL.revokeObjectURL(blobUrl);
    if (blobLeaseId) processedBlobLeases.delete(blobLeaseId);
    return { ok: true };
  }
  catch (err) { return { ok: false, error: err.message }; }
}

function handleReconcileBlobLeases(payload) {
  const retained = new Set(Array.isArray(payload?.retainedLeaseIds) ? payload.retainedLeaseIds : []);
  let revoked = 0;
  for (const [blobLeaseId, lease] of processedBlobLeases) {
    if (retained.has(blobLeaseId)) continue;
    URL.revokeObjectURL(lease.blobUrl);
    processedBlobLeases.delete(blobLeaseId);
    revoked += 1;
  }
  return { ok: true, retained: retained.size, revoked };
}

// LEGACY: оставлен как shim для обратной совместимости. Реальная логика
// батч-скачивания теперь живёт в background DownloadManager. Сюда продолжают
// прилетать запросы только если очень старый content_script ещё дёргает старый action.
const CHAPTERS_POOL_CONCURRENCY = 1;

async function handleDownloadWithChapters(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) {
    return { ok: false, error: 'no items' };
  }

  const downloaded = [];
  const failed = [];
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      try {
        const result = await downloadOneWithChapters(item);
        downloaded.push(result);
        // прогресс в runState для UI
        try {
          await chrome.runtime.sendMessage({ action: 'engine.bumpDownloadProgress' });
        } catch {}
      } catch (err) {
        console.error('[offscreen] download failed', item.workName, err.message);
        failed.push({ workId: item.workId, workName: item.workName, error: err.message });
      }
    }
  }

  const n = Math.max(1, Math.min(CHAPTERS_POOL_CONCURRENCY, items.length));
  const workers = [];
  for (let i = 0; i < n; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return {
    ok: downloaded.length > 0,
    downloaded,
    failed,
    error: downloaded.length === 0 ? 'all downloads failed' : undefined,
  };
}

async function restoreRunState() {
  const response = await chrome.runtime.sendMessage({ action: 'engine.getRunState' });
  const saved = response?.state;
  if (!saved?.runId) {
    await pushState();
    return;
  }

  const idle = createIdleRunState();
  runState = {
    ...idle,
    ...saved,
    queuePlan: Array.isArray(saved.queuePlan) ? saved.queuePlan : [],
    summary: { ...idle.summary, ...(saved.summary || {}) },
    normalization: { ...idle.normalization, ...(saved.normalization || {}) },
    downloadPlan: { ...idle.downloadPlan, ...(saved.downloadPlan || {}) },
  };
  runState.bulkContext = runState.bulkContext ? {
    ...runState.bulkContext,
    presetState: runState.bulkContext.presetState
      || (runState.bulkContext.presetDirty ? 'restore_required' : 'clean'),
  } : null;
  runState.queuePlan = runState.queuePlan.map((unit) => {
    if (unit.submissionPhase !== 'dispatching' && unit.status !== 'submitting') return unit;
    return {
      ...unit,
      status: 'submission_uncertain',
      submissionPhase: 'submission_uncertain',
      lastError: unit.lastError || 'Executor stopped after dispatch began; submission outcome is unknown',
    };
  });

  const presetState = runState.bulkContext?.presetState || 'clean';
  if (['dirty', 'restoring', 'restore_required'].includes(presetState)) {
    try {
      await restoreBulkPresetIfNeeded();
    } catch (error) {
      runState.warnings = [...runState.warnings, `startup preset restore failed: ${error.message || String(error)}`];
      await pushState().catch(() => {});
      throw error;
    }
  }

  if (['preparing', 'normalizing', 'ready', 'running', 'stopping'].includes(runState.phase)) {
    const remainingTasks = Math.max(0, runState.queuePlan.length - Number(runState.nextTaskIndex || 0));
    runState.phase = 'failed';
    runState.interrupted = true;
    runState.recoverable = runState.mode === 'bulk' && remainingTasks > 0;
    runState.interruptionReason = 'offscreen_restarted';
    runState.finishedAt = new Date().toISOString();
    runState.statusText = runState.mode === 'legacy'
      ? 'legacy-очередь создана до bulk-миграции и не может быть возобновлена. запустите её заново.'
      : remainingTasks > 0
      ? `offscreen перезапущен. очередь можно возобновить, осталось: ${remainingTasks}`
      : 'offscreen перезапущен до сохранения очереди. запустите обработку заново.';
    runState.downloadPlan = {
      ...runState.downloadPlan,
      lastStatus: 'interrupted',
      lastMessage: runState.statusText,
    };
  } else if (runState.phase === 'downloading') {
    runState.phase = 'finished';
    runState.statusText = 'offscreen перезапущен; состояние скачиваний сохранено в download manager';
  }

  await pushState();
}

const initializationPromise = restoreRunState().catch((error) => {
  console.error('[offscreen] run state restore failed:', error.message);
  initializationError = error;
});

async function ensureInitialized() {
  await initializationPromise;
  if (!initializationError) return;
  if (!initializationRetryPromise) {
    initializationRetryPromise = restoreRunState().then(() => {
      initializationError = null;
    }).catch((error) => {
      initializationError = error;
      throw error;
    }).finally(() => {
      initializationRetryPromise = null;
    });
  }
  await initializationRetryPromise;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target !== 'offscreen') {
    return false;
  }

  const needsRunAdmission = request.action === 'prepareRun' || request.action === 'resumeRun';
  const admissionToken = needsRunAdmission ? acquireRunAdmission() : null;
  if (needsRunAdmission && !admissionToken) {
    sendResponse({ ok: false, error: 'engine is already busy' });
    return false;
  }

  (async () => {
    await initializationPromise;
    if (request.action !== 'bulkWatcherTick' || !initializationError) {
      await ensureInitialized();
    }
    switch (request.action) {
      case 'prepareRun':
        if (isBusyPhase(runState.phase)) {
          releaseRunAdmission(admissionToken);
          sendResponse({ ok: false, error: 'engine is already busy' });
          return;
        }

        startRun(request.payload, admissionToken).catch(async (error) => {
          releaseRunAdmission(admissionToken);
          await failRun(`ошибка движка: ${error.message}`);
        });
        sendResponse({ ok: true });
        return;

      case 'stopRun':
        sendResponse(await stopRun());
        return;

      case 'resumeRun':
        sendResponse(await resumeRun(request.payload, admissionToken));
        return;

      case 'downloadCreations':
        sendResponse(await triggerCreationsDownload());
        return;

      case 'bulkWatcherTick':
        sendResponse(await runBulkWatcher());
        return;

      case 'downloadWithChapters':
        // LEGACY: новый поток идёт через background DownloadManager (dm.enqueue).
        // Этот ветка осталась как фоллбек на случай если что-то ещё дёргает старый action.
        sendResponse({ ok: true, started: true, total: request.payload?.items?.length || 0 });
        handleDownloadWithChapters(request.payload).then((result) => {
          console.log('[offscreen] LEGACY chapters batch done:',
            'downloaded=', result.downloaded?.length,
            'failed=', result.failed?.length);
        }).catch((err) => {
          console.error('[offscreen] LEGACY chapters batch crashed:', err.message);
        });
        return;

      case 'muxOne':
        sendResponse(await handleMuxOne(request.payload));
        return;

      case 'preLoopVideo':
        sendResponse(await handlePreLoopVideo(request.payload));
        return;

      case 'revokeBlob':
        sendResponse(handleRevokeBlob(request.payload));
        return;

      case 'reconcileBlobLeases':
        sendResponse(handleReconcileBlobLeases(request.payload));
        return;

      case 'resetRunState':
        sendResponse(await resetRunState());
        return;

      case 'tabLifecycle':
        await handleTabLifecycle(request.payload);
        sendResponse({ ok: true });
        return;

      case 'ping':
        sendResponse({ ok: true, runState: cloneState() });
        return;

      default:
        sendResponse({ ok: false, error: `Unknown offscreen action: ${request.action}` });
    }
  })().catch((error) => {
    releaseRunAdmission(admissionToken);
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});
