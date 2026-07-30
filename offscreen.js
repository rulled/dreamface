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
const CAPACITY_RETRY_MIN_DELAY_MS = 10000;
const CAPACITY_RETRY_MAX_DELAY_MS = 30000;
const DOWNLOAD_FETCH_TIMEOUT_MS = 120000;
const MAX_PRE_LOOP_UPLOAD_BYTES = 95 * 1024 * 1024;

let ffmpeg = null;
let ffmpegLoadPromise = null;
let ffmpegLogBuffer = [];
let runState = createIdleRunState();
let currentRunToken = 0;
let stopRequested = false;
let initializationPromise = null;
const preLoopTransfers = new Map();

function isBusyPhase(phase) {
  return ['preparing', 'normalizing', 'ready', 'running', 'downloading', 'stopping'].includes(phase);
}

function createIdleRunState() {
  return {
    phase: 'idle',
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

function hydrateRunState(storedState) {
  const idleState = createIdleRunState();
  const queuePlan = Array.isArray(storedState.queuePlan) ? storedState.queuePlan : [];
  
  // Safety Phase A: Ensure all queue tasks have submissionStatus
  // - Tasks without submissionStatus or with 'pending' before any click are treated as pending
  // - Legacy tasks without submissionStatus are treated as pending only if not currently uncertain task
  const normalizedQueuePlan = queuePlan.map((task) => {
    if (!task) return task;
    if (task.submissionStatus) return task;
    // Legacy task without submissionStatus - treat as pending only if before any click
    return { ...task, submissionStatus: 'pending' };
  });

  return {
    ...idleState,
    ...storedState,
    summary: { ...idleState.summary, ...storedState.summary },
    normalization: { ...idleState.normalization, ...storedState.normalization },
    downloadPlan: { ...idleState.downloadPlan, ...storedState.downloadPlan },
    warnings: Array.isArray(storedState.warnings) ? storedState.warnings : [],
    failures: Array.isArray(storedState.failures) ? storedState.failures : [],
    skipped: Array.isArray(storedState.skipped) ? storedState.skipped : [],
    queuePlan: normalizedQueuePlan,
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

async function initializeRunState() {
  const response = await chrome.runtime.sendMessage({ action: 'engine.getRunState' });
  const storedState = response?.state;

  if (!storedState?.runId) {
    await pushState();
    return;
  }

  runState = hydrateRunState(storedState);
  if (!isBusyPhase(runState.phase)) {
    return;
  }

  if (runState.phase === 'downloading') {
    runState.phase = 'finished';
    runState.interrupted = false;
    runState.recoverable = false;
    runState.interruptionReason = '';
    runState.finishedAt = new Date().toISOString();
    runState.downloadPlan.lastStatus = 'interrupted';
    runState.downloadPlan.lastMessage = 'контекст скачивания перезапущен; проверьте результаты ещё раз';
    setStatusText('контекст скачивания перезапущен; проверьте результаты ещё раз');
    await pushState();
    return;
  }

  const remainingTasks = Math.max(
    0,
    runState.queuePlan.length - Number(runState.nextTaskIndex || 0),
  );
  runState.phase = 'failed';
  runState.interrupted = true;
  runState.recoverable = remainingTasks > 0;
  runState.interruptionReason = 'offscreen_recreated';
  runState.finishedAt = new Date().toISOString();
  setStatusText(remainingTasks > 0
    ? 'контекст обработки перезапущен. очередь можно возобновить.'
    : 'контекст обработки перезапущен до подготовки очереди. запустите обработку заново.');
  await pushState();
}

function createRunId() {
  return `run-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function createPreLoopTransfer(bytes) {
  const transferId = `preloop-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  preLoopTransfers.set(transferId, bytes);
  setTimeout(() => preLoopTransfers.delete(transferId), 10 * 60 * 1000);
  return transferId;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function getPreLoopTransferChunk(payload) {
  const transferId = String(payload?.transferId || '');
  const offset = Math.max(0, Number(payload?.offset) || 0);
  const chunkSize = Math.min(1024 * 1024, Math.max(1, Number(payload?.chunkSize) || 1024 * 1024));
  const bytes = preLoopTransfers.get(transferId);
  if (!bytes) return { ok: false, error: 'pre-loop transfer not found' };

  const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
  return {
    ok: true,
    base64: bytesToBase64(chunk),
    nextOffset: offset + chunk.length,
    done: offset + chunk.length >= bytes.length,
    totalBytes: bytes.length,
  };
}

function releasePreLoopTransfer(payload) {
  const transferId = String(payload?.transferId || '');
  return { ok: preLoopTransfers.delete(transferId) };
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

function getCapacityRetryDelayMs() {
  return CAPACITY_RETRY_MIN_DELAY_MS + Math.floor(
    Math.random() * (CAPACITY_RETRY_MAX_DELAY_MS - CAPACITY_RETRY_MIN_DELAY_MS + 1),
  );
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

    transaction.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(undefined);
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
      if (!settled) {
        settled = true;
        resolve(value);
      }
    }).catch((error) => {
      if (!settled) {
        settled = true;
        reject(error);
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
      ffmpegLogBuffer.push(message);
      if (ffmpegLogBuffer.length > 80) {
        ffmpegLogBuffer.splice(0, ffmpegLogBuffer.length - 80);
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
  const vbrArgs = [...args, '-c:a', 'libmp3lame', '-q:a', '2', outputPath];
  let code = await ffmpeg.exec(vbrArgs, timeoutMs);

  if (code !== 0) {
    await safeDeleteFsFile(outputPath);
    code = await ffmpeg.exec([...args, '-c:a', 'libmp3lame', '-b:a', '192k', outputPath], timeoutMs);
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
    // и перекодируем в чистый MP3 с корректной структурой
    const args = [
      '-err_detect', 'ignore_err',
      '-i', inputPath,
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
  const maxDurationSeconds = Number(options?.maxDurationSeconds) > DEFAULT_MAX_DURATION_SECONDS
    ? Number(options.maxDurationSeconds)
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
//
function createUnsafePreLoopError(message) {
  const error = new Error(message);
  error.code = 'unsafe_preloop_remap';
  return error;
}

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
         runState.warnings = [
          ...runState.warnings,
          `pre-loop: не удалось зафиксировать библиотеку перед upload для видео #${currentVideoIndex}.`,
        ];
        await pushState();
        releasePreLoopTransfer({ transferId: preLoopResult.transferId });
        continue;
      }

      if (videosBefore.length === 0) {
        runState.warnings = [
          ...runState.warnings,
          `pre-loop: scan перед upload вернул пустой список для видео #${currentVideoIndex}.`,
        ];
        await pushState();
        releasePreLoopTransfer({ transferId: preLoopResult.transferId });
        continue;
      }

      // 5) upload в DreamFace
      const preloopFileName = `preloop-${batch.id}-${slotIdx}-${Date.now()}.mp4`;
      let uploadDetail = null;
      try {
        const uploadResp = await callBackground('engine.pageAction', {
          tabId,
          pageAction: 'uploadPreloopedVideo',
          payload: { transferId: preLoopResult.transferId, fileName: preloopFileName },
        });
        if (!uploadResp.response?.ok) {
          throw new Error(uploadResp.response?.error || 'uploadPreloopedVideo failed');
        }
        uploadDetail = uploadResp.response.avatarDetail || null;
      } catch (err) {
        console.warn('[offscreen] preLoop: uploadPreloopedVideo crash', err.message);
        runState.warnings = [
          ...runState.warnings,
          `pre-loop: не удалось залить склеенное видео для #${currentVideoIndex}: ${err.message}`,
        ];
        await pushState();
        releasePreLoopTransfer({ transferId: preLoopResult.transferId });
        continue;
      }

      // 6) повторный scan: после подтверждённого upload допускается только
      // однозначное новое видео и точная перепривязка остальных source.
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
        const sourcesBefore = new Set(videosBefore.map((video) => video.src).filter(Boolean));
        let uploadedCandidates = videosAfter.filter((video) => video.src && !sourcesBefore.has(video.src));
        const uploadedCover = String(uploadDetail?.cover || '').trim();
        if (uploadedCover) {
          const coverMatches = uploadedCandidates.filter((video) => video.src === uploadedCover);
          if (coverMatches.length > 0) uploadedCandidates = coverMatches;
        }
        if (uploadedCandidates.length !== 1 || !Number.isInteger(uploadedCandidates[0].index)) {
          throw createUnsafePreLoopError(
            `после upload найдено новых video candidates: ${uploadedCandidates.length}; точный source не определён`,
          );
        }
        newIndex = uploadedCandidates[0].index;

        const sourceByOldIndex = new Map(videosBefore.map((video) => [video.index, video.src]));
        for (let targetBatchIndex = 0; targetBatchIndex < payload.batches.length; targetBatchIndex += 1) {
          const targetBatch = payload.batches[targetBatchIndex];
          for (let targetSlotIndex = 0; targetSlotIndex < targetBatch.selectedIndices.length; targetSlotIndex += 1) {
            if (targetBatchIndex === bIdx && targetSlotIndex === slotIdx) continue;
            const source = sourceByOldIndex.get(targetBatch.selectedIndices[targetSlotIndex]);
            const matches = videosAfter.filter((video) => video.src === source);
            if (!source || matches.length !== 1 || !Number.isInteger(matches[0].index)) {
              throw createUnsafePreLoopError(
                `не удалось перепривязать группу ${targetBatchIndex + 1}, video slot ${targetSlotIndex + 1} после upload`,
              );
            }
            targetBatch.selectedIndices[targetSlotIndex] = matches[0].index;
          }
        }
      } catch (err) {
        if (err.code === 'unsafe_preloop_remap') throw err;
        throw createUnsafePreLoopError(`post-upload scan failed: ${err.message}`);
      }

      if (newIndex < 0) {
        throw createUnsafePreLoopError(
          `pre-loop upload завершён, но новое видео для #${currentVideoIndex} не найдено. очередь остановлена, чтобы не выбрать чужое видео.`,
        );
      }

      batch.selectedIndices[slotIdx] = newIndex;

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
      if (error.code === 'unsafe_preloop_remap') {
        throw error;
      }
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
        submissionStatus: 'pending', // Safety Phase A: initially pending
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
  await pushState();
}

async function finishRun(message) {
  runState.phase = 'finished';
  runState.interrupted = false;
  runState.recoverable = false;
  runState.interruptionReason = '';
  runState.finishedAt = new Date().toISOString();
  setStatusText(message);
  await pushState();
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
    if (result.status === 'success' || result.status === 'downloading') {
      runState.downloadPlan = {
        ...runState.downloadPlan,
        expectedFileNames: [...expectedFileNames],
        expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
          ? [...runState.downloadPlan.expectedWorkIds]
          : [],
        lastStatus: result.status,
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

function syncDownloadPlanFromQueue(queue) {
  const submittedTasks = queue.filter((task) => (
    task.submissionStatus === 'submitted' && task.workId && task.fileName
  ));
  runState.downloadPlan = {
    ...runState.downloadPlan,
    expectedFileNames: submittedTasks.map((task) => task.fileName),
    expectedWorkIds: submittedTasks.map((task) => task.workId),
    totalExpected: submittedTasks.length,
  };
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
    expectedFileNames: [],
    expectedWorkIds: [],
    lastStatus: 'ready',
    lastMessage: '',
    pendingFiles: [],
    downloadedCount: 0,
    matchedCount: 0,
    totalExpected: 0,
    checkedAt: '',
    checkedOnUrl: '',
  };
  syncDownloadPlanFromQueue(queue);
  await pushState();

  for (let index = startIndex; index < queue.length; index += 1) {
    throwIfStopped(runToken);

    const task = queue[index];
    
    // Safety Phase A: refuse to resume tasks with unsafe submissionStatus
    if (task.submissionStatus === 'submitting' || task.submissionStatus === 'reconciliation_required') {
      await failRun(
        `задача ${task.fileName} имеет unsafe статус submission (${task.submissionStatus}).`
        + ' Очередь остановлена, чтобы не попытаться повторно отправить при неуверенном статусе.',
        'unsafe_resubmit_attempt',
      );
      return;
    }

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
      task.submissionStatus = 'failed';
      if (runState.queuePlan[index]) {
        runState.queuePlan[index] = { ...runState.queuePlan[index], submissionStatus: 'failed' };
      }
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

    let transientAttempt = 0;
    while (true) {
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
            taskLabel: `[${index + 1}/${queue.length}]`,
            maxDurationSeconds: runState.maxDurationSeconds,
            runId: runState.runId,
            taskId: task.id,
          },
        });
      } catch (error) {
        if (stopRequested || runToken !== currentRunToken) {
          throwIfStopped(runToken);
        }
        task.submissionStatus = 'reconciliation_required';
        if (Array.isArray(runState.queuePlan) && runState.queuePlan[index]) {
          runState.queuePlan[index] = {
            ...runState.queuePlan[index],
            submissionStatus: 'reconciliation_required',
          };
        }
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
        task.submissionStatus = 'submitted';
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
            submissionStatus: 'submitted',
          };
        }
        syncDownloadPlanFromQueue(queue);
        await deleteTaskBlob(task.id);
        runState.nextTaskIndex = index + 1;
        setStatusText(`[${index + 1}/${queue.length}] OK`);
        taskHandled = true;
        break;
      }

      if (result.status === 'submitted_unknown') {
        task.submissionStatus = 'reconciliation_required';
        if (runState.queuePlan[index]) {
          runState.queuePlan[index] = {
            ...runState.queuePlan[index],
            submissionStatus: 'reconciliation_required',
          };
        }
        const message = `${task.fileName}: ${result.message || 'подтверждение отправки не получено вовремя'}`;
        runState.warnings = [...runState.warnings, message];
        await failRun(message, 'submission_unconfirmed');
        return;
      }

      if (result.status === 'submission_unconfirmed') {
        task.submissionStatus = 'reconciliation_required';
        task.candidateWorkIds = Array.isArray(result.candidateWorkIds)
          ? [...result.candidateWorkIds]
          : [];
        if (Array.isArray(runState.queuePlan) && runState.queuePlan[index]) {
          runState.queuePlan[index] = {
            ...runState.queuePlan[index],
            submissionStatus: 'reconciliation_required',
            candidateWorkIds: [...task.candidateWorkIds],
          };
        }
        runState.warnings = [
          ...runState.warnings,
          `${task.fileName}: ${result.message || 'submit не подтвержден'}`,
        ];
        await pushState();
        await failRun(
          `отправка ${task.fileName} не подтверждена. Проверьте Creations перед новым запуском, чтобы не создать дубликат.`,
          'submission_unconfirmed',
        );
        return;
      }

      if (result.status === 'capacity_wait') {
        task.submissionStatus = 'pending';
        task.capacityWaitAttempts = Number(task.capacityWaitAttempts || 0) + 1;
        if (Array.isArray(runState.queuePlan) && runState.queuePlan[index]) {
          runState.queuePlan[index] = {
            ...runState.queuePlan[index],
            submissionStatus: 'pending',
            baselineRunningWorkIds: [],
            submissionStartedAt: null,
            capacityWaitAttempts: task.capacityWaitAttempts,
          };
        }
        const message = result.message || 'DreamFace достиг лимита одновременно обрабатываемых работ';
        const retryDelayMs = getCapacityRetryDelayMs();
        setStatusText(
          `[${index + 1}/${queue.length}] ${message}. Повтор ${task.capacityWaitAttempts} через ${Math.ceil(retryDelayMs / 1000)} сек`,
        );
        await pushState();
        await waitForRetryDelay(runToken, retryDelayMs);
        continue;
      }

      if (result.status === 'skipped_short' || result.status === 'skipped_long') {
        task.submissionStatus = 'skipped';
        if (runState.queuePlan[index]) {
          runState.queuePlan[index] = { ...runState.queuePlan[index], submissionStatus: 'skipped' };
        }
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
        if (runState.queuePlan[index]?.submissionStatus === 'submitting') {
          task.submissionStatus = 'reconciliation_required';
          runState.queuePlan[index] = {
            ...runState.queuePlan[index],
            submissionStatus: 'reconciliation_required',
          };
          await failRun(
            `остановка произошла после попытки отправки ${task.fileName}; проверьте Creations перед возобновлением`,
            'submission_unconfirmed',
          );
          return;
        }
        throwIfStopped(runToken);
      }

      if (isTransientTaskResult(result)) {
        const message = result.message || 'timeout';
        if (transientAttempt < TRANSIENT_TASK_RETRY_LIMIT) {
          const nextAttempt = transientAttempt + 2;
          const totalAttempts = TRANSIENT_TASK_RETRY_LIMIT + 1;
          setStatusText(`[${index + 1}/${queue.length}] сеть нестабильна, повтор ${nextAttempt}/${totalAttempts}`);
          await pushState();
          await waitForRetryDelay(runToken, TRANSIENT_TASK_RETRY_BASE_DELAY_MS * (transientAttempt + 1));
          transientAttempt += 1;
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
      task.submissionStatus = 'failed';
      if (runState.queuePlan[index]) {
        runState.queuePlan[index] = { ...runState.queuePlan[index], submissionStatus: 'failed' };
      }
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
  if (!downloadResult.ok || !['success', 'downloading'].includes(downloadResult.result?.status)) {
    runState.phase = 'finished';
    await pushState();
    return { ok: downloadResult.ok, state: cloneState(), error: downloadResult.error || '' };
  }

  return { ok: true, state: cloneState() };
}

async function resetRunState() {
  if (isBusyPhase(runState.phase)) {
    return { ok: false, error: 'engine is busy' };
  }

  await resetRunStateInternal();
  return { ok: true, state: cloneState() };
}

async function startRun(payload) {
  currentRunToken += 1;
  const runToken = currentRunToken;
  stopRequested = false;
  runState.phase = 'preparing';

  await clearTaskBlobs();

  runState = createIdleRunState();
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
    const { queue, summary } = await prepareTasks(payload, runToken);
    runState.summary = summary;
    await pushState();
    await processQueue(queue, runToken);
  } catch (error) {
    if (error.code === 'run_stopped') {
      await finishRun('обработка остановлена пользователем');
      return;
    }

    await failRun(`ошибка движка: ${error.message}`);
  } finally {
    stopRequested = false;
    await clearInputFiles().catch(() => {});
  }
}

async function resumeRun(payload = {}) {
  if (isBusyPhase(runState.phase)) {
    return { ok: false, error: 'engine is already busy' };
  }

  if (!Array.isArray(runState.queuePlan) || runState.queuePlan.length === 0) {
    return { ok: false, error: 'очередь для возобновления не найдена' };
  }

  if (Number(runState.nextTaskIndex || 0) >= runState.queuePlan.length) {
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

  processQueue(runState.queuePlan, runToken, Number(runState.nextTaskIndex || 0)).catch(async (error) => {
    if (error.code === 'run_stopped') {
      await finishRun('обработка остановлена пользователем');
      return;
    }

    await failRun(`ошибка движка: ${error.message}`);
  });

  return { ok: true, state: cloneState() };
}

async function stopRun() {
  stopRequested = true;
  runState.phase = 'stopping';
  setStatusText('остановка...');
  await pushState();
  await resetFfmpeg();
  await stopPageExecutor(runState.tabId);
  return { ok: true };
}

async function handleTabLifecycle(payload) {
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

// Новый чистый action: принимает arrayBuffer + audioMs/videoMs, возвращает blob:URL.
// SW не может вызывать URL.createObjectURL — поэтому blob:URL создаём ЗДЕСЬ (в offscreen),
// и возвращаем строку URL. Затем SW вызывает chrome.downloads.download({url: blobUrl, ...}).
// blob:URL валиден для всего extension origin, его можно скачать из любого контекста.
//
// После завершения скачивания SW шлёт {action:'revokeBlob', payload:{blobUrl}} чтобы
// освободить blob из памяти (см. handleRevokeBlob).
async function handleMuxOne(payload) {
  const url = String(payload?.url || '');
  const audioMs = Number(payload?.audioMs);
  const videoMs = Number(payload?.videoMs);
  const hasChapters = Boolean(payload?.hasChapters);
  if (!url) {
    return { ok: false, error: 'download URL is missing' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`fetch ${response.status} ${response.statusText}`);
    }

    let outBytes = new Uint8Array(await response.arrayBuffer());
    let chapters = 0;
    if (hasChapters && Number.isFinite(audioMs) && Number.isFinite(videoMs) && videoMs > 0 && audioMs > videoMs) {
      try {
        outBytes = await withFfmpegMutex(() => muxChaptersInMp4(outBytes, audioMs, videoMs));
        chapters = Math.ceil(audioMs / videoMs);
      } catch (err) {
        console.error('[offscreen] mux failed:', err.message);
        return { ok: false, error: `chapter mux failed: ${err.message}` };
      }
    }
    const blob = new Blob([outBytes], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    return { ok: true, blobUrl, bytes: outBytes.byteLength, chapters };
  } catch (err) {
    console.error('[offscreen] muxOne failed:', err.message);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timeoutId);
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
    if (result.bytes.byteLength > MAX_PRE_LOOP_UPLOAD_BYTES) {
      console.warn('[offscreen] preLoop blob слишком большой, отдаём ошибку', {
        bytes: result.bytes.byteLength,
        limit: MAX_PRE_LOOP_UPLOAD_BYTES,
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

    const transferId = createPreLoopTransfer(result.bytes);
    return {
      ok: true,
      transferId,
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
async function probeMp4DurationMs(bytes, timeoutMs = 15000) {
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('output duration probe timeout')), timeoutMs);
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        const durationMs = Math.round(Number(video.duration) * 1000);
        if (!Number.isFinite(durationMs) || durationMs <= 0) {
          reject(new Error('output duration is invalid'));
          return;
        }
        resolve(durationMs);
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`output video metadata error: ${video.error?.code || 'unknown'}`));
      };
      video.src = blobUrl;
    });
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(blobUrl);
  }
}

async function validatePreLoopOutput(bytes, targetMs, sourceMs) {
  const actualMs = await probeMp4DurationMs(bytes);
  const toleranceMs = 1000;
  if (actualMs + toleranceMs < targetMs) {
    throw new Error(`pre-loop output too short: ${actualMs}ms < ${targetMs}ms`);
  }
  if (actualMs > targetMs + sourceMs + toleranceMs) {
    throw new Error(`pre-loop output unexpectedly long: ${actualMs}ms`);
  }
  return actualMs;
}

async function preLoopVideoMp4(srcBytes, targetMs, sourceMsHint) {
  await ensureFfmpegLoaded();

  const tag = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const inPath = `preloop-in-${tag}.mp4`;
  const outPath = `preloop-out-${tag}.mp4`;
  const compressedPath = `preloop-compressed-${tag}.mp4`;

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
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ];

  try {
    const code = await ffmpeg.exec(copyArgs, 90000);
    if (code === 0) {
      const buf = await ffmpeg.readFile(outPath);
      const bytes = new Uint8Array(buf.buffer.slice(0));
      if (bytes.byteLength <= MAX_PRE_LOOP_UPLOAD_BYTES) {
        const actualMs = await validatePreLoopOutput(bytes, targetMs, sourceMs);
        await safeDeleteFsFile(inPath);
        await safeDeleteFsFile(outPath);
        console.log('[offscreen] preLoop done via stream_copy', { repeats, sourceMs, finalMs: actualMs, bytes: bytes.byteLength });
        return { bytes, repeats, mode: 'copy', sourceMs, finalMs: actualMs };
      }
      console.warn('[offscreen] preLoop stream_copy exceeds upload limit; retrying with re-encode', {
        bytes: bytes.byteLength,
        limit: MAX_PRE_LOOP_UPLOAD_BYTES,
      });
    } else {
      console.warn('[offscreen] preLoop stream_copy non-zero exit:', code);
    }
  } catch (err) {
    console.warn('[offscreen] preLoop stream_copy threw:', err.message);
  }

  // прибираем кривой out (если остался) перед re-encode
  await safeDeleteFsFile(outPath);

  // === path 2: compress source once, then loop via stream-copy ===
  // Перекодирование уже повторённого output масштабировалось с target duration
  // и упиралось в timeout на длинных видео. Исходник сжимаем один раз; его
  // аудиодорожка для lipsync не нужна. Затем повторяем компактный video stream.
  const isLongOutput = finalMs >= 120000;
  const reencodePreset = 'veryfast';
  const reencodeCrf = isLongOutput ? '27' : '26';
  const reArgs = [
    '-y',
    '-i', inPath,
    '-map', '0:v:0',
    '-an',
    '-c:v', 'libx264',
    '-preset', reencodePreset,
    '-crf', reencodeCrf,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    compressedPath,
  ];

  try {
    ffmpegLogBuffer = [];
    const reencodeStartedAt = Date.now();
    const reencodeTimeoutMs = Math.min(
      15 * 60 * 1000,
      Math.max(4 * 60 * 1000, Math.ceil(sourceMs * 5)),
    );
    const code = await ffmpeg.exec(reArgs, reencodeTimeoutMs);
    if (code !== 0) {
      const elapsedSeconds = Math.round((Date.now() - reencodeStartedAt) / 1000);
      const logTail = ffmpegLogBuffer.slice(-8).join(' | ');
      await safeDeleteFsFile(inPath);
      await safeDeleteFsFile(outPath);
      await safeDeleteFsFile(compressedPath);
      throw new Error(
        `ffmpeg re-encode ${reencodePreset}/CRF${reencodeCrf} returned ${code} after ${elapsedSeconds}s`
        + ` (timeout ${Math.round(reencodeTimeoutMs / 1000)}s)`
        + (logTail ? `: ${logTail}` : ''),
      );
    }
    const loopCode = await ffmpeg.exec([
      '-y',
      '-stream_loop', streamLoopArg,
      '-i', compressedPath,
      '-map', '0:v:0',
      '-c:v', 'copy',
      '-an',
      '-movflags', '+faststart',
      outPath,
    ], 90000);
    if (loopCode !== 0) {
      throw new Error(`ffmpeg compressed-source loop returned ${loopCode}`);
    }
    const buf = await ffmpeg.readFile(outPath);
    const bytes = new Uint8Array(buf.buffer.slice(0));
    if (bytes.byteLength > MAX_PRE_LOOP_UPLOAD_BYTES) {
      throw new Error(
        `compressed pre-loop still exceeds upload limit: ${Math.round(bytes.byteLength / (1024 * 1024))} MB`,
      );
    }
    const actualMs = await validatePreLoopOutput(bytes, targetMs, sourceMs);
    await safeDeleteFsFile(inPath);
    await safeDeleteFsFile(outPath);
    await safeDeleteFsFile(compressedPath);
    console.log('[offscreen] preLoop done via source re-encode', { repeats, sourceMs, finalMs: actualMs, bytes: bytes.byteLength });
    return { bytes, repeats, mode: 'reencode-source', sourceMs, finalMs: actualMs };
  } catch (err) {
    await safeDeleteFsFile(inPath);
    await safeDeleteFsFile(outPath);
    await safeDeleteFsFile(compressedPath);
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
  const blobUrl = payload?.blobUrl;
  if (!blobUrl) return { ok: false, error: 'no blobUrl' };
  try { URL.revokeObjectURL(blobUrl); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target !== 'offscreen') {
    return false;
  }

  (async () => {
    await initializationPromise;

    switch (request.action) {
      case 'prepareRun':
        if (isBusyPhase(runState.phase)) {
          sendResponse({ ok: false, error: 'engine is already busy' });
          return;
        }

        startRun(request.payload).catch(async (error) => {
          await failRun(`ошибка движка: ${error.message}`);
        });
        sendResponse({ ok: true });
        return;

      case 'stopRun':
        sendResponse(await stopRun());
        return;

      case 'resumeRun':
        sendResponse(await resumeRun(request.payload));
        return;

      case 'downloadCreations':
        sendResponse(await triggerCreationsDownload());
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

      case 'getPreLoopChunk':
        sendResponse(getPreLoopTransferChunk(request.payload));
        return;

      case 'mirrorSubmissionCheckpoint': {
        const taskIndex = runState.queuePlan.findIndex((task) => task.id === request.payload?.taskId);
        if (taskIndex < 0) {
          sendResponse({ ok: false, error: 'checkpoint task not found in offscreen state' });
          return;
        }
        runState.queuePlan[taskIndex] = {
          ...runState.queuePlan[taskIndex],
          submissionStatus: 'submitting',
          baselineRunningWorkIds: Array.isArray(request.payload?.baselineRunningWorkIds)
            ? [...request.payload.baselineRunningWorkIds]
            : [],
          submissionStartedAt: request.payload?.submissionStartedAt || new Date().toISOString(),
        };
        sendResponse({ ok: true });
        return;
      }

      case 'releasePreLoopTransfer':
        sendResponse(releasePreLoopTransfer(request.payload));
        return;

      case 'revokeBlob':
        sendResponse(handleRevokeBlob(request.payload));
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
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});

initializationPromise = initializeRunState().catch((error) => {
  console.error('[offscreen] state restore failed:', error.message);
});
