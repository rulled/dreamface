const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const RUN_STATE_KEY = 'dreamfaceRunState';
const DOWNLOADS_STORAGE_KEY = 'dreamfaceDownloads';
const DEFAULT_MAX_DURATION_SECONDS = 180;
const CREATIONS_URL = 'https://www.dreamfaceapp.com/creation?type=Avatar+Video';
const CREATIONS_URL_PATTERNS = [
  'https://tools.dreamfaceapp.com/user*',
  'https://tools.dreamfaceapp.com/*/user*',
  'https://tools.dreamfaceapp.com/creation*',
  'https://tools.dreamfaceapp.com/*/creation*',
  'https://dreamfaceapp.com/user*',
  'https://dreamfaceapp.com/*/user*',
  'https://dreamfaceapp.com/creation*',
  'https://dreamfaceapp.com/*/creation*',
  'https://www.dreamfaceapp.com/user*',
  'https://www.dreamfaceapp.com/*/user*',
  'https://www.dreamfaceapp.com/creation*',
  'https://www.dreamfaceapp.com/*/creation*',
];
const DREAMFACE_URL_PATTERNS = [
  'https://dreamfaceapp.com/*',
  'https://www.dreamfaceapp.com/*',
  'https://tools.dreamfaceapp.com/*',
];

let offscreenCreationPromise = null;
let creationsTabPromise = null;
let runStateMutationChain = Promise.resolve();

console.log('[bg] service worker loaded, build:', 'download-manager-v2');

// =========================================================================
// DEBUG LOG (видимый в popup → секция "лог")
// =========================================================================
//
// Ring-buffer в chrome.storage.local под ключом dmDebugLog. Каждая запись:
// { ts, src, level, msg }. Размер ~250 последних. Пишут все компоненты:
// background, content_script (через action 'dm.log'), offscreen, injected
// (через content_script bridge).

const DM_DEBUG_LOG_KEY = 'dmDebugLog';
const DM_DEBUG_LOG_MAX = 250;
let dmDebugLogBuffer = [];
let dmDebugLogFlushTimer = null;

async function dmLog(src, level, ...args) {
  const msg = args.map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  const entry = { ts: Date.now(), src, level, msg: msg.slice(0, 1000) };
  // console тоже выводим
  const prefix = `[${src}]`;
  if (level === 'error') console.error(prefix, ...args);
  else if (level === 'warn') console.warn(prefix, ...args);
  else console.log(prefix, ...args);

  dmDebugLogBuffer.push(entry);
  if (dmDebugLogFlushTimer) return;
  dmDebugLogFlushTimer = setTimeout(async () => {
    dmDebugLogFlushTimer = null;
    const toFlush = dmDebugLogBuffer.splice(0);
    if (toFlush.length === 0) return;
    try {
      const data = await chrome.storage.local.get(DM_DEBUG_LOG_KEY);
      const log = Array.isArray(data[DM_DEBUG_LOG_KEY]) ? data[DM_DEBUG_LOG_KEY] : [];
      log.push(...toFlush);
      if (log.length > DM_DEBUG_LOG_MAX) log.splice(0, log.length - DM_DEBUG_LOG_MAX);
      await chrome.storage.local.set({ [DM_DEBUG_LOG_KEY]: log });
      chrome.runtime.sendMessage({ action: 'dm.logUpdate' }).catch(() => {});
    } catch {}
  }, 200);
}

// =========================================================================
// FILENAME FORCING (chrome.downloads подменяет filename для blob:URL — форсим)
// =========================================================================
const forcedFilenameByDownloadId = new Map();
const forcedFilenameByBlobUrl = new Map();

// URL'ы, которые мы САМИ инициировали через chrome.downloads.download (DownloadManager).
// chrome.downloads.onCreated сработает на них тоже, и без этого мы бы поймали
// собственный download и попытались бы его cancel — рекурсия.
const dmOwnUrls = new Set();

if (chrome.downloads?.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    const byId = forcedFilenameByDownloadId.get(downloadItem.id);
    const byUrl = forcedFilenameByBlobUrl.get(downloadItem.url);
    const forced = byId || byUrl || null;
    if (forced) {
      console.log('[bg] onDeterminingFilename: overriding to', forced,
        '(chrome wanted:', downloadItem.filename, ')');
      forcedFilenameByDownloadId.delete(downloadItem.id);
      forcedFilenameByBlobUrl.delete(downloadItem.url);
      suggest({ filename: forced, conflictAction: 'uniquify' });
      return;
    }
    suggest();
  });
}

function sanitizeFileNameForDownload(name) {
  let s = String(name || 'video');
  try { s = s.normalize('NFC'); } catch {}
  s = s
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\-\s]+/, '');
  if (s.length > 180) s = s.slice(0, 180);
  if (!s) s = 'video';
  s = s.replace(/\.(mp3|wav|m4a|ogg|aac|flac|mp4)$/i, '') + '.mp4';
  return s;
}

// =========================================================================
// RUN STATE (legacy — для очереди генерации, не трогаем)
// =========================================================================

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

async function getStoredRunState() {
  const data = await chrome.storage.local.get(RUN_STATE_KEY);
  return data[RUN_STATE_KEY] || createIdleRunState();
}

async function persistRunState(state) {
  await chrome.storage.local.set({ [RUN_STATE_KEY]: state });
  chrome.runtime.sendMessage({ action: 'runStateUpdate', state }).catch(() => {});
}

function serializeRunStateMutation(operation) {
  const result = runStateMutationChain.then(operation, operation);
  runStateMutationChain = result.catch(() => {});
  return result;
}

async function mutateStoredRunState(mutator) {
  return serializeRunStateMutation(async () => {
    const state = await getStoredRunState();
    const shouldPersist = await mutator(state);
    if (shouldPersist === false) return state;
    await persistRunState(state);
    return state;
  });
}

async function bumpDownloadProgress() {
  const state = await getStoredRunState();
  if (!state) return;
  const plan = state.downloadPlan || {};
  state.downloadPlan = {
    ...plan,
    downloadedCount: Number(plan.downloadedCount || 0) + 1,
    lastStatus: 'in_progress',
  };
  await persistRunState(state);
}

// =========================================================================
// DOWNLOAD MANAGER
// =========================================================================
//
// Единый менеджер скачиваний:
//   - per-workId persistent state в chrome.storage.local
//   - семафор fetch=6, mux=1 (через offscreen.muxOne)
//   - retry с backoff, fetch timeout, download timeout
//   - throttled persist + broadcast
//   - chrome.alarms keep-alive пока есть активная работа
//   - восстановление статусов после рестарта SW

const DM_TTL_MS = 30 * 24 * 3600 * 1000;
const DM_DOWNLOAD_WAIT_TIMEOUT_MS = 300000;
const DM_NETWORK_CONCURRENCY = 6;
const DM_CHAPTER_CONCURRENCY = 1;
const DM_MAX_ATTEMPTS = 3;
const DM_PERSIST_THROTTLE_MS = 300;
const DM_HEARTBEAT_ALARM = 'dm-heartbeat';
const DM_RETRY_BACKOFF_BASE_MS = 1500;
const DREAMFACE_DOWNLOAD_HOST_RE = /^dreamface-resource\.oss-[^.]+\.aliyuncs\.com$/i;

// in-memory state: workId → entry
const dmEntries = new Map();
const dmQueue = []; // workId[]
let dmNetworkActive = 0;
let dmChapterActive = 0;
let dmLoadPromise = null;
let dmPersistTimer = null;
let dmKeepAliveActive = false;
let dmRunProgressTimer = null;
let dmPendingRunId = '';

function dmIsAllowedDownloadUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && DREAMFACE_DOWNLOAD_HOST_RE.test(url.hostname);
  } catch {
    return false;
  }
}

function dmCreateEntry(item) {
  const now = Date.now();
  return {
    workId: String(item.workId),
    runId: String(item.runId || ''),
    url: item.url || '',
    fileName: item.fileName || '',
    audioFileName: item.audioFileName || '',
    workName: item.workName || '',
    audioMs: Number.isFinite(item.audioMs) ? Number(item.audioMs) : null,
    videoMs: Number.isFinite(item.videoMs) ? Number(item.videoMs) : null,
    hasChapters: Boolean(item.hasChapters),
    status: 'queued',
    error: '',
    attempts: 0,
    urlAcquiredAt: Number(item.urlAcquiredAt) || now,
    forceUrlRefresh: false,
    downloadId: null,
    savedAs: '',
    bytes: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function dmIsTerminal(status) {
  return status === 'done' || status === 'failed' || status === 'missing' || status === 'interrupted';
}

function dmIsActive(status) {
  return status === 'fetching' || status === 'muxing' || status === 'saving' || status === 'queued';
}

function dmUsesChapters(entry) {
  return entry.hasChapters && Number.isFinite(entry.audioMs)
    && Number.isFinite(entry.videoMs) && entry.videoMs > 0 && entry.audioMs > entry.videoMs;
}

async function dmLoad() {
  if (dmLoadPromise) return dmLoadPromise;
  dmLoadPromise = (async () => {
    try {
      const data = await chrome.storage.local.get(DOWNLOADS_STORAGE_KEY);
      const byWorkId = (data?.[DOWNLOADS_STORAGE_KEY]?.byWorkId) || {};
      const now = Date.now();
      let restored = 0;
      let interrupted = 0;
      const downloadsToWatch = [];
      for (const [workId, entry] of Object.entries(byWorkId)) {
        if (!entry || !workId) continue;
        // TTL
        if (entry.completedAt && now - entry.completedAt > DM_TTL_MS) continue;
        if (!entry.completedAt && now - (entry.updatedAt || entry.createdAt || 0) > DM_TTL_MS) continue;
        if (entry.status === 'queued' || entry.status === 'fetching' || entry.status === 'muxing') {
          entry.status = 'queued';
          entry.forceUrlRefresh = true;
          entry.error = entry.error || 'SW restarted; download requeued';
          entry.updatedAt = now;
          dmQueue.push(String(workId));
        } else if (entry.status === 'saving' && entry.downloadId) {
          downloadsToWatch.push(entry);
        } else if (entry.status === 'saving') {
          entry.status = 'interrupted';
          entry.error = entry.error || 'SW restarted';
          entry.updatedAt = now;
          interrupted++;
        }
        dmEntries.set(String(workId), entry);
        restored++;
      }
      for (const entry of downloadsToWatch) {
        const reconciled = await dmReconcileUncertainDownload(entry, 'SW restarted during download');
        if (!reconciled) {
          dmUpdateEntry(entry.workId, {
            status: 'interrupted',
            error: 'SW restarted; Chrome download is no longer active',
          });
          interrupted++;
        }
      }
      if (restored > 0) {
        console.log(`[dm] loaded ${restored} entries (${interrupted} marked interrupted)`);
      }
      dmSchedulePersist();
      dmUpdateKeepAlive();
      dmTick();
    } catch (err) {
      console.warn('[dm] load failed:', err.message);
    }
  })();
  return dmLoadPromise;
}

function dmSchedulePersist() {
  if (dmPersistTimer) return;
  dmPersistTimer = setTimeout(async () => {
    dmPersistTimer = null;
    const byWorkId = {};
    for (const [workId, entry] of dmEntries.entries()) {
      byWorkId[workId] = entry;
    }
    try {
      await chrome.storage.local.set({ [DOWNLOADS_STORAGE_KEY]: { byWorkId } });
    } catch (err) {
      console.warn('[dm] persist failed:', err.message);
    }
    dmBroadcastNow();
  }, DM_PERSIST_THROTTLE_MS);
}

function dmBroadcastNow() {
  const entries = Array.from(dmEntries.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  chrome.runtime.sendMessage({ action: 'dm.stateUpdate', entries }).catch(() => {});
}

function dmUpdateEntry(workId, patch) {
  const entry = dmEntries.get(String(workId));
  if (!entry) return null;
  Object.assign(entry, patch);
  entry.updatedAt = Date.now();
  dmSchedulePersist();
  if (entry.runId) dmScheduleRunProgressSync(entry.runId);
  return entry;
}

function dmScheduleRunProgressSync(runId) {
  if (!runId) return;
  dmPendingRunId = runId;
  if (dmRunProgressTimer) return;
  dmRunProgressTimer = setTimeout(async () => {
    dmRunProgressTimer = null;
    const pendingRunId = dmPendingRunId;
    dmPendingRunId = '';
    try {
      await mutateStoredRunState((state) => {
        if (state.runId !== pendingRunId) return false;
        const expectedWorkIds = Array.isArray(state.downloadPlan?.expectedWorkIds)
          ? state.downloadPlan.expectedWorkIds.map((id) => String(id || '')).filter(Boolean)
          : [];
        if (expectedWorkIds.length === 0) return false;

        const entries = expectedWorkIds.map((id) => dmEntries.get(id)).filter(Boolean);
        const doneCount = entries.filter((entry) => entry.status === 'done').length;
        const activeCount = entries.filter((entry) => dmIsActive(entry.status)).length;
        const failedCount = entries.filter((entry) => (
          entry.status === 'failed' || entry.status === 'interrupted' || entry.status === 'missing'
        )).length;
        let lastStatus = 'pending';
        let lastMessage = `ожидают скачивания: ${expectedWorkIds.length - doneCount}`;
        if (doneCount === expectedWorkIds.length) {
          lastStatus = 'success';
          lastMessage = `все файлы сохранены: ${doneCount}`;
        } else if (activeCount > 0) {
          lastStatus = 'downloading';
          lastMessage = `скачивание: ${doneCount}/${expectedWorkIds.length}`;
        } else if (failedCount > 0) {
          lastStatus = 'error';
          lastMessage = `сохранено: ${doneCount}; ошибок: ${failedCount}`;
        }
        state.downloadPlan = {
          ...state.downloadPlan,
          lastStatus,
          lastMessage,
          downloadedCount: doneCount,
        };
        state.statusText = lastMessage;
        return true;
      });
    } catch (error) {
      console.warn('[dm] run progress sync failed:', error.message);
    }
  }, 150);
}

function dmUpdateKeepAlive() {
  let hasActive = false;
  for (const entry of dmEntries.values()) {
    if (dmIsActive(entry.status)) { hasActive = true; break; }
  }
  if (hasActive && !dmKeepAliveActive) {
    dmKeepAliveActive = true;
    try { chrome.alarms.create(DM_HEARTBEAT_ALARM, { periodInMinutes: 0.5 }); } catch {}
    console.log('[dm] keep-alive ON');
  } else if (!hasActive && dmKeepAliveActive) {
    dmKeepAliveActive = false;
    try { chrome.alarms.clear(DM_HEARTBEAT_ALARM); } catch {}
    console.log('[dm] keep-alive OFF');
  }
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === DM_HEARTBEAT_ALARM) {
      // просто будит SW, ничего не делаем
    }
  });
}

async function dmEnqueue(items) {
  await dmLoad();
  if (!Array.isArray(items) || items.length === 0) return { ok: true, accepted: 0, skipped: 0 };

  dmLog('bg', 'log', 'dm.enqueue items=', items.length, items.map((i) => ({ workId: i.workId, hasChapters: i.hasChapters, name: i.audioFileName || i.workName, url: (i.url || '').slice(0, 80) })));
  let accepted = 0;
  let skipped = 0;
  const rejected = [];

  for (const item of items) {
    const workId = String(item?.workId || '').trim();
    if (!workId) { skipped++; continue; }
    if (!dmIsAllowedDownloadUrl(item?.url)) {
      dmLog('bg', 'warn', 'dm.enqueue rejected invalid download URL', { workId });
      const failedEntry = dmEntries.get(workId) || dmCreateEntry({ ...item, url: '' });
      failedEntry.runId = String(item.runId || failedEntry.runId || '');
      failedEntry.status = 'failed';
      failedEntry.error = 'download URL is not allowed';
      failedEntry.forceUrlRefresh = true;
      failedEntry.completedAt = Date.now();
      failedEntry.updatedAt = Date.now();
      dmEntries.set(workId, failedEntry);
      rejected.push({ workId, error: 'download URL is not allowed' });
      skipped++;
      continue;
    }
    const existing = dmEntries.get(workId);
    if (existing && existing.status === 'done') {
      if (item.runId) existing.runId = String(item.runId);
      existing.updatedAt = Date.now();
      skipped++;
      continue;
    }
    if (existing && dmIsActive(existing.status)) {
      // уже в работе
      skipped++;
      continue;
    }
    let entry;
    if (existing) {
      // reuse + reset
      entry = existing;
      entry.url = item.url || entry.url;
      entry.urlAcquiredAt = item.url ? Date.now() : Number(entry.urlAcquiredAt || 0);
      entry.forceUrlRefresh = false;
      entry.runId = String(item.runId || entry.runId || '');
      entry.fileName = item.fileName || entry.fileName;
      entry.audioFileName = item.audioFileName || entry.audioFileName;
      entry.workName = item.workName || entry.workName;
      if (Number.isFinite(item.audioMs)) entry.audioMs = Number(item.audioMs);
      if (Number.isFinite(item.videoMs)) entry.videoMs = Number(item.videoMs);
      entry.hasChapters = Boolean(item.hasChapters);
      entry.status = 'queued';
      entry.error = '';
      entry.attempts = 0;
      entry.updatedAt = Date.now();
    } else {
      entry = dmCreateEntry(item);
      dmEntries.set(workId, entry);
    }
    dmQueue.push(workId);
    accepted++;
  }

  dmSchedulePersist();
  const runId = items.map((item) => String(item?.runId || '')).find(Boolean);
  if (runId) dmScheduleRunProgressSync(runId);
  dmUpdateKeepAlive();
  dmTick();
  return { ok: true, accepted, skipped, rejected };
}

async function dmRetry(workId) {
  await dmLoad();
  let retried = 0;
  if (workId) {
    const entry = dmEntries.get(String(workId));
    if (entry && dmIsTerminal(entry.status) && entry.status !== 'done') {
      entry.status = 'queued';
      entry.error = '';
      entry.attempts = 0;
      entry.forceUrlRefresh = true;
      entry.updatedAt = Date.now();
      dmQueue.push(entry.workId);
      retried = 1;
    }
  } else {
    for (const entry of dmEntries.values()) {
      if (entry.status === 'failed' || entry.status === 'interrupted' || entry.status === 'missing') {
        entry.status = 'queued';
        entry.error = '';
        entry.attempts = 0;
        entry.forceUrlRefresh = true;
        entry.updatedAt = Date.now();
        dmQueue.push(entry.workId);
        retried++;
      }
    }
  }
  dmSchedulePersist();
  dmUpdateKeepAlive();
  dmTick();
  return { ok: true, retried };
}

function dmRemoveEntry(workId) {
  dmEntries.delete(String(workId));
  dmSchedulePersist();
}

function dmClearCompleted() {
  let removed = 0;
  for (const [workId, entry] of dmEntries.entries()) {
    if (entry.status === 'done') {
      dmEntries.delete(workId);
      removed++;
    }
  }
  dmSchedulePersist();
  return { ok: true, removed };
}

function dmTick() {
  while (dmNetworkActive < DM_NETWORK_CONCURRENCY && dmQueue.length > 0) {
    for (let index = dmQueue.length - 1; index >= 0; index -= 1) {
      if (dmEntries.get(dmQueue[index])?.status !== 'queued') {
        dmQueue.splice(index, 1);
      }
    }
    if (dmQueue.length === 0) return;

    const queueIndex = dmQueue.findIndex((workId) => {
      const queuedEntry = dmEntries.get(workId);
      return queuedEntry?.status === 'queued'
        && (!dmUsesChapters(queuedEntry) || dmChapterActive < DM_CHAPTER_CONCURRENCY);
    });
    if (queueIndex < 0) return;

    const [workId] = dmQueue.splice(queueIndex, 1);
    const entry = dmEntries.get(workId);
    if (!entry || entry.status !== 'queued') continue;
    const usesChapters = dmUsesChapters(entry);
    dmNetworkActive++;
    if (usesChapters) dmChapterActive++;
    dmProcess(entry).catch((err) => {
      console.error('[dm] process crashed for', workId, err);
    }).finally(() => {
      dmNetworkActive = Math.max(0, dmNetworkActive - 1);
      if (usesChapters) dmChapterActive = Math.max(0, dmChapterActive - 1);
      dmUpdateKeepAlive();
      dmTick();
    });
  }
}

function dmComputeFileName(entry) {
  const base = entry.audioFileName || entry.workName || entry.fileName || entry.workId;
  return sanitizeFileNameForDownload(base);
}

async function dmReconcileUncertainDownload(entry, errorMessage) {
  if (!entry.downloadId) return false;

  const [download] = await chrome.downloads.search({ id: entry.downloadId }).catch(() => []);
  if (download?.state === 'complete') {
    dmUpdateEntry(entry.workId, {
      status: 'done',
      error: '',
      completedAt: Date.now(),
    });
    return true;
  }

  if (download?.state !== 'in_progress') {
    dmUpdateEntry(entry.workId, { downloadId: null });
    return false;
  }

  dmUpdateEntry(entry.workId, {
    status: 'saving',
    error: `${errorMessage}; Chrome download is still in progress`,
  });
  dmWaitForComplete(entry.downloadId, DM_DOWNLOAD_WAIT_TIMEOUT_MS).then(() => {
    dmUpdateEntry(entry.workId, {
      status: 'done',
      error: '',
      completedAt: Date.now(),
    });
    dmUpdateKeepAlive();
  }).catch((error) => {
    dmUpdateEntry(entry.workId, {
      status: 'interrupted',
      error: error.message || String(error),
    });
    dmUpdateKeepAlive();
  });
  return true;
}

// Один проход скачивания одного entry. Не управляет семафором — это делает dmTick.
//
// Архитектурный комментарий:
// - В SW (Service Worker) НЕТ URL.createObjectURL, нет Blob URL APIs. Поэтому
//   blob:URL создаётся в offscreen.js (handleMuxOne) и возвращается строкой сюда.
//   SW делает chrome.downloads.download({url: blobUrl, ...}), а после завершения
//   шлёт offscreen 'revokeBlob' для освобождения памяти.
// - Direct path (нет chapters, либо audioMs <= videoMs) — отдаём прямой OSS URL
//   chrome.downloads.download БЕЗ форсирования имени (OSS сам отдаёт
//   Content-Disposition с правильным именем файла). Это убирает конфликт с
//   chrome онlooks за наш filename vs server-предложенный.
async function dmProcess(entry) {
  let muxedBlobUrl = null;
  try {
    if (entry.forceUrlRefresh || entry.attempts > 0) {
      const creationsTab = await ensureCreationsTab();
      const refreshed = await sendPageAction(creationsTab.id, 'getDownloadUrlByWorkId', {
        workId: entry.workId,
      });
      if (!refreshed?.ok || !dmIsAllowedDownloadUrl(refreshed.url)) {
        throw new Error(refreshed?.error || 'failed to refresh signed download URL');
      }
      entry.url = refreshed.url;
      entry.urlAcquiredAt = Date.now();
      entry.forceUrlRefresh = false;
      dmSchedulePersist();
    }
    if (!dmIsAllowedDownloadUrl(entry.url)) {
      throw new Error('download URL is not allowed');
    }

    const useChapters = dmUsesChapters(entry);
    dmLog('bg', 'log', 'dm.process start', { workId: entry.workId, name: entry.audioFileName || entry.workName, hasChapters: entry.hasChapters, path: useChapters ? 'chapters' : 'direct' });
    if (useChapters) {
      // ===== chapters path: fetch+mux+blob в offscreen → save =====
      dmUpdateEntry(entry.workId, { status: 'fetching' });

      await ensureOffscreenDocument();
      const muxResp = await forwardToOffscreen({
        action: 'muxOne',
        payload: {
          url: entry.url,
          audioMs: entry.audioMs,
          videoMs: entry.videoMs,
          hasChapters: true,
        },
      });

      if (!muxResp?.ok || !muxResp.blobUrl) {
        throw new Error('mux failed: ' + (muxResp?.error || 'no blobUrl returned'));
      }
      muxedBlobUrl = muxResp.blobUrl;
      const finalBytes = muxResp.bytes || 0;
      const chaptersMade = muxResp.chapters || 0;

      dmUpdateEntry(entry.workId, { status: 'saving', bytes: finalBytes });

      const fileName = dmComputeFileName(entry);
      const downloadId = await dmStartDownload(muxedBlobUrl, fileName, /*forceFilename=*/true);
      dmUpdateEntry(entry.workId, { status: 'saving', downloadId, savedAs: fileName });
      await dmWaitForComplete(downloadId, DM_DOWNLOAD_WAIT_TIMEOUT_MS);
      dmUpdateEntry(entry.workId, {
        status: 'done',
        downloadId,
        savedAs: fileName,
        completedAt: Date.now(),
        error: chaptersMade > 0 ? '' : 'saved without chapters (mux skipped)',
      });
      dmLog('bg', 'log', 'dm.saved chapters', { workId: entry.workId, fileName, chapters: chaptersMade });
    } else {
      // ===== direct path: отдаём прямой OSS URL в chrome.downloads =====
      // Не форсим filename — OSS уже шлёт правильный Content-Disposition.
      dmUpdateEntry(entry.workId, { status: 'saving' });

      const downloadId = await dmStartDownload(entry.url, /*fileName=*/null, /*forceFilename=*/false);
      dmUpdateEntry(entry.workId, {
        status: 'saving',
        downloadId,
        savedAs: entry.audioFileName || entry.workName || '',
      });
      await dmWaitForComplete(downloadId, DM_DOWNLOAD_WAIT_TIMEOUT_MS);
      dmUpdateEntry(entry.workId, {
        status: 'done',
        downloadId,
        savedAs: entry.audioFileName || entry.workName || '',
        completedAt: Date.now(),
      });
      dmLog('bg', 'log', 'dm.saved direct', { workId: entry.workId });
    }
  } catch (err) {
    const errMsg = err?.message || String(err);
    if (await dmReconcileUncertainDownload(entry, errMsg)) return;

    entry.attempts = (entry.attempts || 0) + 1;
    dmLog('bg', 'warn', 'dm.attempt', entry.attempts, 'failed for', entry.workId, errMsg);
    // USER_CANCELED — пользователь / chrome сам отменил, retry бесполезен
    const isUserCanceled = /USER_CANCELED|user_canceled/i.test(errMsg);
    if (!isUserCanceled && entry.attempts < DM_MAX_ATTEMPTS) {
      // backoff
      const delay = DM_RETRY_BACKOFF_BASE_MS * entry.attempts;
      dmUpdateEntry(entry.workId, { status: 'queued', error: errMsg });
      setTimeout(() => {
        // повторно ставим в очередь, если за это время ничего не сделали
        const e = dmEntries.get(entry.workId);
        if (e && e.status === 'queued') {
          dmQueue.push(entry.workId);
          dmUpdateKeepAlive();
          dmTick();
        }
      }, delay);
    } else {
      dmUpdateEntry(entry.workId, { status: 'failed', error: errMsg, completedAt: Date.now() });
    }
  } finally {
    // освобождаем blob:URL в offscreen — chrome.downloads уже забрал данные
    if (muxedBlobUrl) {
      forwardToOffscreen({ action: 'revokeBlob', payload: { blobUrl: muxedBlobUrl } }).catch(() => {});
    }
  }
}

function dmStartDownload(url, fileName, forceFilename) {
  return new Promise((resolve, reject) => {
    const opts = { url, saveAs: false, conflictAction: 'uniquify' };
    if (forceFilename && fileName) {
      opts.filename = fileName;
      forcedFilenameByBlobUrl.set(url, fileName);
    }
    dmOwnUrls.add(url);
    chrome.downloads.download(opts, (id) => {
      if (chrome.runtime.lastError) {
        forcedFilenameByBlobUrl.delete(url);
        dmOwnUrls.delete(url);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (forceFilename && fileName) forcedFilenameByDownloadId.set(id, fileName);
      setTimeout(() => dmOwnUrls.delete(url), 30000);
      resolve(id);
    });
  });
}

function dmWaitForComplete(downloadId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      chrome.downloads.onChanged.removeListener(onChanged);
      if (timer) clearTimeout(timer);
      forcedFilenameByDownloadId.delete(downloadId);
    };
    const complete = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(reason));
    };
    const onChanged = (delta) => {
      if (!delta || delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        complete();
      } else if (delta.state?.current === 'interrupted') {
        const reason = delta.error?.current || 'interrupted';
        dmLog('bg', 'warn', 'download.onChanged interrupted', { downloadId, delta: JSON.parse(JSON.stringify(delta || {})) });
        fail('download interrupted: ' + reason);
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    timer = setTimeout(() => fail('download wait timeout after ' + timeoutMs + 'ms'), timeoutMs);
    chrome.downloads.search({ id: downloadId }, (items) => {
      if (chrome.runtime.lastError || settled) return;
      const item = items?.[0];
      if (item?.state === 'complete') complete();
      if (item?.state === 'interrupted') fail('download interrupted: ' + (item.error || 'interrupted'));
    });
  });
}

async function dmRecoveryScan() {
  // для done entries — проверить что файл реально есть в истории download
  for (const entry of dmEntries.values()) {
    if (entry.status === 'done' && entry.downloadId) {
      try {
        const [item] = await chrome.downloads.search({ id: entry.downloadId });
        if (!item || item.state === 'interrupted') {
          entry.status = 'missing';
          entry.error = 'file not found in chrome downloads';
          entry.updatedAt = Date.now();
        }
      } catch {}
    }
  }
  dmSchedulePersist();
}

function dmGetEntries() {
  return Array.from(dmEntries.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// =========================================================================
// OFFSCREEN
// =========================================================================

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (offscreenCreationPromise) return offscreenCreationPromise;
  offscreenCreationPromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['WORKERS', 'BLOBS'],
    justification: 'Normalize audio in a persistent extension context and keep queue execution alive when the popup closes.',
  }).catch(async (error) => {
    if (String(error?.message || error).includes('Only a single offscreen document')) return;
    throw error;
  }).finally(() => {
    offscreenCreationPromise = null;
  });
  return offscreenCreationPromise;
}

async function forwardToOffscreen(message) {
  await ensureOffscreenDocument();
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ target: 'offscreen', ...message }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// =========================================================================
// LEGACY HELPERS (для существующих actions)
// =========================================================================

async function sendPageAction(tabId, action, payload = {}) {
  let lastError = null;
  const nonRetryableActions = new Set([
    'executeTaskOnPage',
    'uploadPreloopedVideo',
    'downloadCreationsIfReady',
  ]);
  const maxAttempts = nonRetryableActions.has(action) ? 1 : 3;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { action, ...payload }, (response) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          resolve(response);
        });
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error('Failed to send page action');
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const existing = await chrome.tabs.get(tabId).catch(() => null);
  if (!existing) throw new Error('tab not found');
  if (existing.status === 'complete') return existing;
  return new Promise((resolve, reject) => {
    let timeoutId = null;
    const cleanup = () => {
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      chrome.tabs.onUpdated.removeListener(handleUpdate);
      chrome.tabs.onRemoved.removeListener(handleRemoved);
    };
    const handleRemoved = (removedTabId) => {
      if (removedTabId !== tabId) return;
      cleanup();
      reject(new Error('tab removed'));
    };
    const handleUpdate = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') { cleanup(); resolve(tab); }
    };
    timeoutId = setTimeout(() => { cleanup(); reject(new Error('tab load timeout')); }, timeoutMs);
    chrome.tabs.onUpdated.addListener(handleUpdate);
    chrome.tabs.onRemoved.addListener(handleRemoved);
  });
}

async function ensureCreationsTab() {
  if (creationsTabPromise) return creationsTabPromise;
  creationsTabPromise = (async () => {
    const tabs = await chrome.tabs.query({ url: CREATIONS_URL_PATTERNS });
    let tab = tabs
      .filter((item) => /\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(creation|user)([/?#]|$)/i.test(item.url || ''))
      .sort((a, b) => {
        const aTyped = /type=Avatar(\+|%20)Video/i.test(a.url || '') ? 1 : 0;
        const bTyped = /type=Avatar(\+|%20)Video/i.test(b.url || '') ? 1 : 0;
        return bTyped - aTyped || (b.id || 0) - (a.id || 0);
      })[0];
    if (!tab) {
      tab = await chrome.tabs.create({ url: CREATIONS_URL, active: false });
    }
    tab = await waitForTabComplete(tab.id);
    return {
      id: tab.id,
      url: tab.url,
      status: tab.status,
      discarded: Boolean(tab.discarded),
    };
  })().finally(() => {
    creationsTabPromise = null;
  });
  return creationsTabPromise;
}

// =========================================================================
// NATIVE DOWNLOAD INTERCEPT — отключён
// =========================================================================
//
// Раньше здесь был chrome.downloads.onCreated listener, который пытался
// перехватить нативный <a download> сайта (single hover download). Оказалось
// что это ломает нормальный flow: файлы либо не появляются в Downloads, либо
// идут с uuid-именами (Chrome подменяет имя при retry).
//
// Перехват single download теперь делается в content_script через DOM click
// capture на ._button_1jvc3_9 (hover-кнопка скачивания на карточке), и
// заворачивает скачивание в наш DownloadManager ДО того как сайт построит
// свой <a download> + click.
//
// Multi-select (Скачать в toolbar в select-режиме) использует blob:URL и
// работает быстро через сайтовый flow — мы его НЕ перехватываем.

// =========================================================================
// MESSAGE ROUTER
// =========================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target === 'offscreen') return false;

  (async () => {
    switch (request.action) {
      case 'engine.ensure':
        await ensureOffscreenDocument();
        sendResponse({ ok: true });
        return;

      case 'engine.getRunState':
        sendResponse({ ok: true, state: await getStoredRunState() });
        return;

      case 'engine.prepareRun':
        sendResponse(await forwardToOffscreen({ action: 'prepareRun', payload: request.payload }));
        return;

      case 'engine.stopRun':
        sendResponse(await forwardToOffscreen({ action: 'stopRun' }));
        return;

      case 'engine.resumeRun':
        sendResponse(await forwardToOffscreen({ action: 'resumeRun', payload: request.payload || {} }));
        return;

      case 'engine.downloadCreations':
        sendResponse(await forwardToOffscreen({ action: 'downloadCreations' }));
        return;

      case 'engine.getPreLoopChunk':
        sendResponse(await forwardToOffscreen({ action: 'getPreLoopChunk', payload: request.payload }));
        return;

      case 'engine.releasePreLoopTransfer':
        sendResponse(await forwardToOffscreen({ action: 'releasePreLoopTransfer', payload: request.payload }));
        return;

      // LEGACY actions — теперь маршрутизируются в DownloadManager
      case 'engine.downloadWithChapters':
      case 'engine.downloadDirect': {
        console.warn('[bg] LEGACY action', request.action, '→ DownloadManager');
        const items = Array.isArray(request.payload?.items) ? request.payload.items : [];
        const result = await dmEnqueue(items);
        sendResponse({ ok: true, started: true, total: items.length, ...result });
        return;
      }

      case 'engine.bumpDownloadProgress': {
        try { await bumpDownloadProgress(); sendResponse({ ok: true }); }
        catch (err) { sendResponse({ ok: false, error: err.message }); }
        return;
      }

      case 'engine.saveDownload': {
        // LEGACY: offscreen передаёт blobUrl, нужно сохранить через chrome.downloads.
        try {
          const requestedName = request.payload.fileName;
          const blobUrl = request.payload.blobUrl;
          console.log('[bg] saveDownload (legacy): filename=', requestedName);
          forcedFilenameByBlobUrl.set(blobUrl, requestedName);
          dmOwnUrls.add(blobUrl);
          const downloadId = await new Promise((resolve, reject) => {
            chrome.downloads.download({
              url: blobUrl,
              filename: requestedName,
              saveAs: false,
              conflictAction: 'uniquify',
            }, (id) => {
              if (chrome.runtime.lastError) {
                forcedFilenameByBlobUrl.delete(blobUrl);
                dmOwnUrls.delete(blobUrl);
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                forcedFilenameByDownloadId.set(id, requestedName);
                setTimeout(() => dmOwnUrls.delete(blobUrl), 30000);
                resolve(id);
              }
            });
          });
          sendResponse({ ok: true, downloadId });
        } catch (err) {
          console.error('[bg] saveDownload failed', err);
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }

      case 'engine.persistRunState':
        await serializeRunStateMutation(async () => {
          const incomingState = request.state || createIdleRunState();
          const currentState = await getStoredRunState();
          const currentWorkIds = Array.isArray(currentState.downloadPlan?.expectedWorkIds)
            ? currentState.downloadPlan.expectedWorkIds.map(String)
            : [];
          const incomingWorkIds = Array.isArray(incomingState.downloadPlan?.expectedWorkIds)
            ? incomingState.downloadPlan.expectedWorkIds.map(String)
            : [];
          const sameDownloadSet = currentWorkIds.length === incomingWorkIds.length
            && currentWorkIds.every((workId, index) => workId === incomingWorkIds[index]);
          const preserveDownloadState = currentState.runId
            && currentState.runId === incomingState.runId
            && Boolean(currentState.downloadPlan?.checkedAt)
            && sameDownloadSet;
          const nextState = preserveDownloadState
            ? {
                ...incomingState,
                downloadPlan: currentState.downloadPlan,
                statusText: currentState.statusText,
              }
            : incomingState;
          await persistRunState(nextState);
        });
        sendResponse({ ok: true });
        return;

      case 'engine.updateDownloadPlan': {
        const payload = request.payload || {};
        try {
          const state = await mutateStoredRunState((currentState) => {
            if (!payload.runId || currentState.runId !== payload.runId) {
              throw new Error('run state changed before download update');
            }
            const incomingPlan = payload.downloadPlan || {};
            const preserveCompleted = currentState.downloadPlan?.lastStatus === 'success'
              && incomingPlan.lastStatus !== 'success';
            currentState.downloadPlan = {
              ...currentState.downloadPlan,
              ...incomingPlan,
              ...(preserveCompleted ? {
                lastStatus: currentState.downloadPlan.lastStatus,
                lastMessage: currentState.downloadPlan.lastMessage,
                downloadedCount: currentState.downloadPlan.downloadedCount,
              } : {}),
            };
            if (!preserveCompleted && typeof payload.statusText === 'string') {
              currentState.statusText = payload.statusText;
            }
            return true;
          });
          sendResponse({ ok: true, state });
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
        }
        return;
      }

      case 'engine.resetRunState':
        sendResponse(await forwardToOffscreen({ action: 'resetRunState' }));
        return;

      case 'engine.checkpointSubmission': {
        const payload = request.payload || {};
        let checkpointTask = null;
        try {
          await mutateStoredRunState((state) => {
            if (!payload.runId || state.runId !== payload.runId) {
              throw new Error('run state changed before submission checkpoint');
            }
            const taskIndex = Array.isArray(state.queuePlan)
              ? state.queuePlan.findIndex((task) => task.id === payload.taskId)
              : -1;
            if (taskIndex < 0) {
              throw new Error('submission task not found');
            }
            checkpointTask = {
              ...state.queuePlan[taskIndex],
              submissionStatus: 'submitting',
              baselineRunningWorkIds: Array.isArray(payload.baselineRunningWorkIds)
                ? [...payload.baselineRunningWorkIds]
                : [],
              submissionStartedAt: new Date().toISOString(),
            };
            state.queuePlan[taskIndex] = checkpointTask;
            return true;
          });
        } catch (error) {
          sendResponse({ ok: false, error: error.message });
          return;
        }
        const mirrorResult = await forwardToOffscreen({
          action: 'mirrorSubmissionCheckpoint',
          payload: {
            taskId: payload.taskId,
            baselineRunningWorkIds: checkpointTask.baselineRunningWorkIds,
            submissionStartedAt: checkpointTask.submissionStartedAt,
          },
        });
        if (!mirrorResult?.ok) {
          sendResponse({ ok: false, error: mirrorResult?.error || 'checkpoint mirror failed' });
          return;
        }
        sendResponse({ ok: true });
        return;
      }

      case 'engine.pageAction': {
        const response = await sendPageAction(request.tabId, request.pageAction, request.payload);
        sendResponse({ ok: true, response });
        return;
      }

      case 'engine.getTabSnapshot': {
        const tab = await chrome.tabs.get(request.tabId).catch(() => null);
        sendResponse({
          ok: true,
          tab: tab ? { id: tab.id, url: tab.url, status: tab.status, discarded: Boolean(tab.discarded) } : null,
        });
        return;
      }

      case 'engine.ensureCreationsTab': {
        const tab = await ensureCreationsTab();
        sendResponse({ ok: true, tab });
        return;
      }

      // ============ DOWNLOAD MANAGER actions ============

      case 'dm.enqueue': {
        const items = Array.isArray(request.payload?.items) ? request.payload.items : [];
        const result = await dmEnqueue(items);
        sendResponse(result);
        return;
      }

      case 'dm.retry': {
        const workId = request.payload?.workId || null;
        const result = await dmRetry(workId);
        sendResponse(result);
        return;
      }

      case 'dm.getState': {
        await dmLoad();
        sendResponse({ ok: true, entries: dmGetEntries() });
        return;
      }

      case 'dm.removeEntry': {
        const workId = request.payload?.workId;
        if (workId) dmRemoveEntry(workId);
        sendResponse({ ok: true });
        return;
      }

      case 'dm.clearCompleted': {
        const result = dmClearCompleted();
        sendResponse(result);
        return;
      }

      case 'dm.log': {
        // content_script / popup пишет в debug-лог
        const { src, level, args } = request.payload || {};
        dmLog(src || 'cs', level || 'log', ...(Array.isArray(args) ? args : [args]));
        sendResponse({ ok: true });
        return;
      }

      case 'dm.getDebugLog': {
        const data = await chrome.storage.local.get(DM_DEBUG_LOG_KEY);
        sendResponse({ ok: true, log: data[DM_DEBUG_LOG_KEY] || [] });
        return;
      }

      case 'dm.clearDebugLog': {
        await chrome.storage.local.set({ [DM_DEBUG_LOG_KEY]: [] });
        chrome.runtime.sendMessage({ action: 'dm.logUpdate' }).catch(() => {});
        sendResponse({ ok: true });
        return;
      }


      case 'scanProgress':
      case 'scanResult':
      case 'videoUploadProgress':
      case 'videoUploadCompleted':
        // эти broadcast'ы шлёт content_script для popup; background просто игнорирует
        sendResponse({ ok: true, ignored: true });
        return;

      default:
        console.warn('[bg] unknown action:', request.action);
        sendResponse({ ok: false, error: `Unknown action: ${request.action}` });
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'tabLifecycle',
    payload: { event: 'removed', tabId },
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.status && typeof changeInfo.discarded === 'undefined' && !changeInfo.url) return;
  chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'tabLifecycle',
    payload: {
      event: 'updated',
      tabId,
      changeInfo: {
        status: changeInfo.status || '',
        url: changeInfo.url || '',
        discarded: typeof changeInfo.discarded === 'undefined' ? null : Boolean(changeInfo.discarded),
      },
    },
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(RUN_STATE_KEY);
  if (!stored[RUN_STATE_KEY]) {
    await persistRunState(createIdleRunState());
  }
  await ensureOffscreenDocument().catch(() => {});
  await dmLoad();
  await dmRecoveryScan();
});

chrome.runtime.onStartup.addListener(async () => {
  ensureOffscreenDocument().catch(() => {});
  await dmLoad();
  await dmRecoveryScan();
});

// Eager load on SW load
dmLoad().catch(() => {});
