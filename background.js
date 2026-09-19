const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const RUN_STATE_KEY = 'dreamfaceRunState';
const DOWNLOADS_STORAGE_KEY = 'dreamfaceDownloads';
const PADDED_VIDEO_MARKERS_KEY = 'dreamfacePaddedVideoMarkers';
const DREAMFACE_ACCOUNTS_KEY = 'dreamfaceAccounts';
const ACCOUNT_HEALTH_KEY = 'dreamfaceAccountHealth';
const FEATURES_KEY = 'dreamfaceFeatures';
const AVATAR_CACHE_KEY = 'dreamfaceAvatarCache';
const AVATAR_CACHE_LIMIT = 2000;
const BULK_WATCH_ALARM = 'bulk-watch';
const BULK_WATCH_STORAGE_KEY = 'dreamfaceBulkWatchUnits';
const PADDED_VIDEO_MARKERS_LIMIT = 500;
const DEFAULT_MAX_DURATION_SECONDS = 180;
const CREATIONS_URL = 'https://www.dreamfaceapp.com/creation?type=Avatar+Video';
const BULK_RELAY_URL = `${CREATIONS_URL}#dreamface-extension-relay`;
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
const OFFSCREEN_DOCUMENT_URL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

let offscreenCreationPromise = null;
let restartRecoveryPromise = null;
let restartRecoveryStatus = {
  state: 'not_started',
  triggers: [],
  startedAt: null,
  finishedAt: null,
  watcherCount: 0,
  watcherAlarmEnabled: false,
  offscreenRequiredReasons: [],
  offscreenEnsured: false,
  error: '',
};
let bulkRelayTabId = null;
let bulkWatchMutationChain = Promise.resolve();
const DREAMFACE_RELAY_PATH_RE = /\/(?:[a-z]{2}\/)?(?:avatar(?:-bulk)?|creation)(?:\/|\?|#|$)/i;

function withBulkWatchMutation(callback) {
  const run = bulkWatchMutationChain.then(callback, callback);
  bulkWatchMutationChain = run.catch(() => {});
  return run;
}
let paddedVideoMarkerWrite = Promise.resolve();

function parseStoredAccountSession(account) {
  try {
    return account?.sessionRaw ? JSON.parse(account.sessionRaw) : null;
  } catch {
    return null;
  }
}

function getAccountIdentity(account) {
  const session = parseStoredAccountSession(account);
  const thirdPlatform = String(session?.thirdPlatform || account?.thirdPlatform || '').trim();
  const thirdId = String(session?.thirdId || account?.thirdId || '').trim();
  const userId = String(session?.userId || account?.userId || '').trim();
  const accountId = String(session?.accountId || account?.accountId || '').trim();
  const principalKey = thirdPlatform && thirdId
    ? `${thirdPlatform.toLowerCase()}:${thirdId.toLowerCase()}`
    : (userId ? `user:${userId.toLowerCase()}` : `account:${accountId}`);
  return { principalKey, thirdPlatform, thirdId, userId, accountId };
}

function getStoredAccountAuth(account) {
  const session = parseStoredAccountSession(account);
  const token = String(session?.token || account?.token || '');
  const userId = String(session?.userId || account?.userId || '');
  const accountId = String(session?.accountId || account?.accountId || '');
  const clientId = String(account?.clientId || '');
  if (!token || !userId || !accountId || !clientId) {
    throw new Error('account session is incomplete');
  }
  return { token, userId, accountId, clientId };
}

function validateCapturedAccount(account) {
  if (!account || typeof account !== 'object' || Array.isArray(account)) {
    throw new Error('captured account is invalid');
  }
  const sessionRaw = String(account.sessionRaw || '');
  const clientId = String(account.clientId || '').trim();
  if (!sessionRaw || !clientId) throw new Error('captured account session is incomplete');
  let session;
  try {
    session = JSON.parse(sessionRaw);
  } catch {
    throw new Error('captured account session contains invalid JSON');
  }
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new Error('captured account session is invalid');
  }
  const token = String(session.token || '').trim();
  const userId = String(session.userId || '').trim();
  const accountId = String(session.accountId || '').trim();
  if (!token || !userId || !accountId) throw new Error('captured account credentials are incomplete');
  if (account.userId && String(account.userId).trim() !== userId) {
    throw new Error('captured account userId does not match the session');
  }
  if (account.accountId && String(account.accountId).trim() !== accountId) {
    throw new Error('captured account accountId does not match the session');
  }
  return {
    ...account,
    sessionRaw,
    clientId,
    token,
    userId,
    accountId,
    ...getAccountIdentity({ ...account, sessionRaw, userId, accountId }),
  };
}

async function diagnoseStoredAccount(account) {
  const auth = getStoredAccountAuth(account);
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'dream-face-web': 'dream-face-web',
    token: auth.token,
    'client-id': auth.clientId,
  };
  const requestJson = async (path, options = {}) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const requestHeaders = { ...headers, ...(options.headers || {}) };
      if (!options.body) delete requestHeaders['content-type'];
      const response = await fetch(`https://www.dreamfaceapp.com${path}`, {
        ...options,
        headers: requestHeaders,
        credentials: 'include',
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch {}
      if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
      if (!payload) throw new Error(`${path}: invalid JSON response`);
      const status = payload.status_msg || payload.statusMsg || payload.status || '';
      if (status && !/^success$/i.test(String(status))) throw new Error(`${path}: ${status}`);
      return payload;
    } finally {
      clearTimeout(timeoutId);
    }
  };
  const post = (path, body) => requestJson(path, { method: 'POST', body: JSON.stringify(body) });
  const [running, quota, rights, templateResponse] = await Promise.all([
    requestJson(`/dw-server/work/get_user_running_works/${encodeURIComponent(auth.accountId)}`),
    requestJson(`/dw-server/face/get_batch_times?user_id=${encodeURIComponent(auth.userId)}&account_id=${encodeURIComponent(auth.accountId)}&work_type=AVATAR_VIDEO`),
    post('/df-subscribe/subscribe/get_user_rights', { userId: auth.userId, accountId: auth.accountId }),
    requestJson('/dw-server/sys_config/query/template_config'),
  ]);
  let config = {};
  try {
    const raw = templateResponse?.data?.value;
    config = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  } catch {}
  const audioLimit = config.audioLimit || {};
  const tier = rights.vipLabel ? (rights.vipLevel === 'normal' ? 'pro' : 'premium') : 'free';
  const maxDurationSeconds = Number(audioLimit[tier]);
  if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
    throw new Error(`DreamFace audioLimit.${tier} unavailable`);
  }
  const quotaData = quota.data || {};
  const quotaTotal = Number(quotaData.total_times);
  const quotaRemaining = Number(quotaData.remaining_times);
  return {
    accountId: auth.accountId,
    ok: true,
    runningWorks: Array.isArray(running.data) ? running.data.length : 0,
    quota: {
      total: Number.isFinite(quotaTotal) && quotaTotal >= 0 ? quotaTotal : null,
      remaining: Number.isFinite(quotaRemaining) && quotaRemaining >= 0 ? quotaRemaining : null,
    },
    maxDurationSeconds,
    planName: tier === 'premium' ? 'Premium' : (tier === 'pro' ? 'Pro' : 'Free'),
    durationSource: 'dreamface-api',
    vipLevel: rights.vipLevel || '',
    audioLimit: {
      free: Number(audioLimit.free || 0),
      pro: Number(audioLimit.pro || 0),
      premium: Number(audioLimit.premium || 0),
    },
  };
}

// Account health updates arrive from the offscreen document while a run is in flight;
// serializing them keeps read-modify-write from dropping a concurrent update.
let accountHealthChain = Promise.resolve();

function withAccountHealthMutation(callback) {
  const run = accountHealthChain.then(callback, callback);
  accountHealthChain = run.catch(() => {});
  return run;
}

function canonicalizeAccounts(accounts) {
  const byPrincipal = new Map();
  for (const source of Array.isArray(accounts) ? accounts : []) {
    const identity = getAccountIdentity(source);
    if (!identity.principalKey) continue;
    const account = { ...source, ...identity };
    const current = byPrincipal.get(identity.principalKey);
    if (!current || Number(account.capturedAt || 0) >= Number(current.capturedAt || 0)) {
      byPrincipal.set(identity.principalKey, account);
    }
  }
  return [...byPrincipal.values()];
}

function redactStoredAccountCredential(account) {
  const { sessionRaw, token, clientId, ...metadata } = account || {};
  return metadata;
}

async function isTrustedOffscreenSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id || sender.tab) return false;

  const senderUrls = [sender.documentUrl, sender.url].filter(Boolean);
  if (senderUrls.length === 0 || senderUrls.some((url) => url !== OFFSCREEN_DOCUMENT_URL)) return false;
  if (sender.contextType && sender.contextType !== 'OFFSCREEN_DOCUMENT') return false;

  const offscreenUrl = new URL(OFFSCREEN_DOCUMENT_URL);
  const extensionOrigin = `${offscreenUrl.protocol}//${offscreenUrl.host}`;
  if (sender.origin && sender.origin !== extensionOrigin) return false;
  return true;
}

async function getStoredAccountCredential(accountId, principalKey) {
  const stored = await chrome.storage.local.get(DREAMFACE_ACCOUNTS_KEY);
  const accounts = Array.isArray(stored[DREAMFACE_ACCOUNTS_KEY]) ? stored[DREAMFACE_ACCOUNTS_KEY] : [];
  const normalizedAccountId = String(accountId || '').trim();
  const normalizedPrincipalKey = String(principalKey || '').trim();
  if (!normalizedAccountId && !normalizedPrincipalKey) return null;

  const exact = normalizedAccountId
    ? accounts.find((item) => getAccountIdentity(item).accountId === normalizedAccountId) || null
    : null;
  const targetPrincipalKey = exact ? getAccountIdentity(exact).principalKey : normalizedPrincipalKey;
  const canonical = targetPrincipalKey
    ? canonicalizeAccounts(accounts).find((item) => item.principalKey === targetPrincipalKey) || null
    : null;
  const account = canonical || exact;
  if (!account) return null;
  const auth = getStoredAccountAuth(account);
  const toCredential = (source) => ({
    ...redactStoredAccountCredential(source),
    ...getAccountIdentity(source),
    ...getStoredAccountAuth(source),
  });
  return {
    account: { ...toCredential(account), ...auth },
    canonicalAccount: canonical ? toCredential(canonical) : null,
  };
}

function savePaddedVideoMarker(source, borderCropPx) {
  paddedVideoMarkerWrite = paddedVideoMarkerWrite.catch(() => {}).then(async () => {
    const data = await chrome.storage.local.get(PADDED_VIDEO_MARKERS_KEY);
    const markers = data[PADDED_VIDEO_MARKERS_KEY] || {};
    markers[source] = {
      borderCropPx: Math.max(0, Math.floor(Number(borderCropPx) || 0)),
      markedAt: Date.now(),
    };
    await chrome.storage.local.set({
      [PADDED_VIDEO_MARKERS_KEY]: Object.fromEntries(
        Object.entries(markers)
          .sort(([, a], [, b]) => Number(b?.markedAt || 0) - Number(a?.markedAt || 0))
          .slice(0, PADDED_VIDEO_MARKERS_LIMIT),
      ),
    });
  });
  return paddedVideoMarkerWrite;
}

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

async function getStoredRunState() {
  const data = await chrome.storage.local.get(RUN_STATE_KEY);
  return data[RUN_STATE_KEY] || createIdleRunState();
}

async function persistRunState(state) {
  await chrome.storage.local.set({ [RUN_STATE_KEY]: state });
  chrome.runtime.sendMessage({ action: 'runStateUpdate', state }).catch(() => {});
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
//   - семафор jobs=6, WebCodecs transform=1 (через offscreen.muxOne)
//   - retry с backoff, fetch timeout, download timeout
//   - throttled persist + broadcast
//   - chrome.alarms keep-alive пока есть активная работа
//   - восстановление статусов после рестарта SW

const DM_TTL_MS = 30 * 24 * 3600 * 1000;
const DM_FETCH_TIMEOUT_MS = 120000;
const DM_DOWNLOAD_WAIT_TIMEOUT_MS = 300000;
const DM_NETWORK_CONCURRENCY = 6;
const DM_MAX_ATTEMPTS = 3;
const DM_PERSIST_THROTTLE_MS = 300;
const DM_HEARTBEAT_ALARM = 'dm-heartbeat';
const DM_RETRY_ALARM = 'dm-retry';
const DM_RETRY_BACKOFF_BASE_MS = 1500;
const DM_FINGERPRINT_VERSION = 1;

// in-memory state: workId → entry
const dmEntries = new Map();
const dmQueue = []; // workId[]
let dmNetworkActive = 0;
let dmLoadPromise = null;
let dmPersistPromise = Promise.resolve();
let dmPersistTimer = null;
let dmKeepAliveActive = false;
const dmRecoveredDownloadIds = new Set();

function dmNormalizeDuration(value) {
  return Number.isFinite(value) ? Math.round(Number(value)) : null;
}

function dmBuildFingerprint(item) {
  const workId = String(item?.workId || '').trim();
  return JSON.stringify({
    version: DM_FINGERPRINT_VERSION,
    workId,
    accountId: String(item?.accountId || ''),
    fileName: sanitizeFileNameForDownload(
      item?.audioFileName || item?.workName || item?.fileName || workId,
    ),
    hasChapters: Boolean(item?.hasChapters),
    audioMs: dmNormalizeDuration(item?.audioMs),
    videoMs: dmNormalizeDuration(item?.videoMs),
  });
}

function dmCreateEntry(item) {
  const now = Date.now();
  return {
    workId: String(item.workId),
    runId: item.runId || '',
    accountId: item.accountId || '',
    watchUnitId: item.watchUnitId || '',
    url: item.url || '',
    fileName: item.fileName || '',
    audioFileName: item.audioFileName || '',
    workName: item.workName || '',
    audioMs: Number.isFinite(item.audioMs) ? Number(item.audioMs) : null,
    videoMs: Number.isFinite(item.videoMs) ? Number(item.videoMs) : null,
    hasChapters: Boolean(item.hasChapters),
    fingerprint: dmBuildFingerprint(item),
    fingerprintVersion: DM_FINGERPRINT_VERSION,
    pendingReplacement: null,
    status: 'queued',
    error: '',
    attempts: 0,
    downloadId: null,
    savedAs: '',
    bytes: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    nextRetryAt: null,
    dispatchStartedAt: null,
    blobLeaseId: '',
  };
}

function dmIsTerminal(status) {
  return status === 'done' || status === 'failed' || status === 'missing'
    || status === 'interrupted' || status === 'uncertain';
}

function dmIsActive(status) {
  return status === 'fetching' || status === 'muxing' || status === 'dispatching' || status === 'saving'
    || status === 'queued' || status === 'retry_wait';
}

async function dmLoad() {
  if (dmLoadPromise) return dmLoadPromise;
  dmLoadPromise = (async () => {
    const data = await chrome.storage.local.get(DOWNLOADS_STORAGE_KEY);
    const storedDownloads = data?.[DOWNLOADS_STORAGE_KEY];
    const byWorkId = storedDownloads?.byWorkId || {};
    if (!byWorkId || typeof byWorkId !== 'object' || Array.isArray(byWorkId)) {
      throw new Error('stored download state is malformed');
    }
    const restoredEntries = new Map();
    const restoredQueue = [];
    const now = Date.now();
    let restored = 0;
    let requeued = 0;
    for (const [workId, storedEntry] of Object.entries(byWorkId)) {
      if (!storedEntry || typeof storedEntry !== 'object' || Array.isArray(storedEntry) || !workId) continue;
      if (storedEntry.completedAt && now - storedEntry.completedAt > DM_TTL_MS) continue;
      if (!storedEntry.completedAt && now - (storedEntry.updatedAt || storedEntry.createdAt || 0) > DM_TTL_MS) continue;
      const entry = {
        ...storedEntry,
        workId: String(workId),
        fingerprint: storedEntry.fingerprint || dmBuildFingerprint(storedEntry),
        fingerprintVersion: DM_FINGERPRINT_VERSION,
        pendingReplacement: storedEntry.pendingReplacement || null,
        dispatchStartedAt: storedEntry.dispatchStartedAt || null,
        blobLeaseId: storedEntry.blobLeaseId || '',
      };
      if (entry.status === 'queued' || entry.status === 'fetching' || entry.status === 'muxing') {
        entry.status = 'queued';
        entry.error = 'recovered before download dispatch';
        entry.updatedAt = now;
        restoredQueue.push(entry.workId);
        requeued++;
      } else if (entry.status === 'dispatching' || (entry.status === 'saving' && !entry.downloadId)) {
        entry.status = 'uncertain';
        entry.error = 'download dispatch outcome is unknown after service-worker restart';
        entry.completedAt = now;
        entry.updatedAt = now;
      }
      restoredEntries.set(entry.workId, entry);
      restored++;
    }
    dmEntries.clear();
    for (const [workId, entry] of restoredEntries) dmEntries.set(workId, entry);
    dmQueue.splice(0, dmQueue.length, ...restoredQueue);
    if (restored > 0) console.log(`[dm] loaded ${restored} entries (${requeued} safely requeued)`);
  })().catch((error) => {
    dmLoadPromise = null;
    throw error;
  });
  return dmLoadPromise;
}

function dmPersistNow() {
  if (dmPersistTimer) {
    clearTimeout(dmPersistTimer);
    dmPersistTimer = null;
  }
  const byWorkId = {};
  for (const [workId, entry] of dmEntries.entries()) {
    byWorkId[workId] = { ...entry };
  }
  const persist = dmPersistPromise.catch(() => {}).then(async () => {
    await chrome.storage.local.set({ [DOWNLOADS_STORAGE_KEY]: { byWorkId } });
    dmBroadcastNow();
  });
  dmPersistPromise = persist;
  return persist;
}

function dmSchedulePersist() {
  if (dmPersistTimer) return;
  dmPersistTimer = setTimeout(() => {
    dmPersistTimer = null;
    dmPersistNow().catch((error) => {
      console.error('[dm] persist failed:', error.message || String(error));
    });
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
  return entry;
}

function dmUpdateKeepAlive() {
  let hasActive = false;
  for (const entry of dmEntries.values()) {
    if (dmIsActive(entry.status) && entry.status !== 'retry_wait') { hasActive = true; break; }
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

async function dmScheduleRetryAlarm() {
  let nextRetryAt = Infinity;
  for (const entry of dmEntries.values()) {
    if (entry.status !== 'retry_wait') continue;
    const retryAt = Number(entry.nextRetryAt);
    if (Number.isFinite(retryAt) && retryAt > 0) nextRetryAt = Math.min(nextRetryAt, retryAt);
  }
  if (!Number.isFinite(nextRetryAt)) {
    await chrome.alarms.clear(DM_RETRY_ALARM);
    return;
  }
  await chrome.alarms.create(DM_RETRY_ALARM, { when: Math.max(Date.now(), nextRetryAt) });
}

async function dmRecoverRetries() {
  const now = Date.now();
  let recovered = 0;
  for (const entry of dmEntries.values()) {
    if (entry.status !== 'retry_wait') continue;
    const retryAt = Number(entry.nextRetryAt);
    if (Number.isFinite(retryAt) && retryAt > now) continue;
    entry.status = 'queued';
    entry.nextRetryAt = null;
    entry.updatedAt = now;
    if (!dmQueue.includes(entry.workId)) dmQueue.push(entry.workId);
    recovered++;
  }
  if (recovered > 0) await dmPersistNow();
  await dmScheduleRetryAlarm();
  dmUpdateKeepAlive();
  dmTick();
}

function isAllowedDownloadUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    const host = url.hostname.toLowerCase();
    return host === 'dreamfaceapp.com' || host.endsWith('.dreamfaceapp.com')
      || host === 'aliyuncs.com' || host.endsWith('.aliyuncs.com');
  } catch {
    return false;
  }
}

async function getBulkWatchUnitsFromStorage() {
  const stored = await chrome.storage.local.get(BULK_WATCH_STORAGE_KEY);
  const units = stored[BULK_WATCH_STORAGE_KEY];
  if (units !== undefined && !Array.isArray(units)) {
    throw new Error('stored bulk watch units are malformed');
  }
  return units || [];
}

async function syncBulkWatchAlarm(units = null) {
  const currentUnits = units || await getBulkWatchUnitsFromStorage();
  if (currentUnits.some((unit) => (
    unit?.status === 'pending'
    || unit?.status === 'submission_uncertain'
    || unit?.status === 'correlating'
    || (unit?.status === 'requires_review' && (unit?.workIds || []).some(Boolean))
  ))) {
    const alarm = await chrome.alarms.get(BULK_WATCH_ALARM);
    if (!alarm) await chrome.alarms.create(BULK_WATCH_ALARM, { periodInMinutes: 1 });
    return true;
  }
  await chrome.alarms.clear(BULK_WATCH_ALARM);
  return false;
}

async function handleBulkWatchAlarm() {
  const units = await getBulkWatchUnitsFromStorage();
  if (!await syncBulkWatchAlarm(units)) return;
  await forwardToOffscreen({ action: 'bulkWatcherTick' });
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === DM_HEARTBEAT_ALARM) {
      // просто будит SW, ничего не делаем
    }
    if (alarm?.name === DM_RETRY_ALARM) {
      dmLoad().then(dmRecoverRetries).catch((error) => {
        console.error('[dm] retry alarm failed:', error.message || String(error));
      });
    }
    if (alarm?.name === BULK_WATCH_ALARM) {
      handleBulkWatchAlarm().catch((error) => {
        console.error('[bg] bulk watcher tick failed:', error.message || String(error));
      });
    }
  });
}

async function dmEnqueue(items) {
  await dmLoad();
  if (!Array.isArray(items) || items.length === 0) return { ok: true, accepted: 0, skipped: 0 };

  const invalidItemIndex = items.findIndex((item) => (
    !item || typeof item !== 'object' || Array.isArray(item)
    || !['string', 'number'].includes(typeof item.workId)
    || (typeof item.workId === 'number' && !Number.isFinite(item.workId))
    || !String(item.workId).trim()
    || !isAllowedDownloadUrl(item.url)
  ));
  if (invalidItemIndex !== -1) {
    dmLog('bg', 'warn', 'dm.enqueue rejected malformed item', { index: invalidItemIndex });
    return { ok: false, accepted: 0, skipped: items.length, error: `invalid download item at index ${invalidItemIndex}` };
  }

  dmLog('bg', 'log', 'dm.enqueue items=', items.length, items.map((i) => ({ workId: i.workId, hasChapters: i.hasChapters, name: i.audioFileName || i.workName, url: (i.url || '').slice(0, 80) })));
  let accepted = 0;
  let skipped = 0;

  for (const item of items) {
    const workId = String(item?.workId || '').trim();
    if (!workId) { skipped++; continue; }
    const existing = dmEntries.get(workId);
    const fingerprint = dmBuildFingerprint(item);
    const processingChanged = existing && existing.fingerprint !== fingerprint;
    if (existing && existing.status === 'done' && !processingChanged) {
      skipped++;
      continue;
    }
    if (existing && dmIsActive(existing.status)) {
      if (processingChanged) {
        existing.pendingReplacement = {
          item: { ...item, workId },
          fingerprint,
          requestedAt: Date.now(),
        };
        existing.updatedAt = Date.now();
        accepted++;
      } else {
        skipped++;
      }
      continue;
    }
    let entry;
    if (existing) {
      // reuse + reset
      entry = existing;
      entry.url = item.url || entry.url;
      entry.runId = item.runId || entry.runId || '';
      entry.accountId = item.accountId || entry.accountId || '';
      entry.watchUnitId = item.watchUnitId || entry.watchUnitId || '';
      entry.fileName = item.fileName || entry.fileName;
      entry.audioFileName = item.audioFileName || entry.audioFileName;
      entry.workName = item.workName || entry.workName;
      if (Number.isFinite(item.audioMs)) entry.audioMs = Number(item.audioMs);
      if (Number.isFinite(item.videoMs)) entry.videoMs = Number(item.videoMs);
      entry.hasChapters = Boolean(item.hasChapters);
      entry.fingerprint = fingerprint;
      entry.fingerprintVersion = DM_FINGERPRINT_VERSION;
      entry.pendingReplacement = null;
      entry.status = 'queued';
      entry.error = '';
      entry.attempts = 0;
      entry.downloadId = null;
      entry.savedAs = '';
      entry.bytes = 0;
      entry.completedAt = null;
      entry.nextRetryAt = null;
      entry.dispatchStartedAt = null;
      entry.blobLeaseId = '';
      entry.updatedAt = Date.now();
    } else {
      entry = dmCreateEntry(item);
      dmEntries.set(workId, entry);
    }
    dmQueue.push(workId);
    accepted++;
  }

  await dmPersistNow();
  dmUpdateKeepAlive();
  dmTick();
  return { ok: true, accepted, skipped };
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
      entry.downloadId = null;
      entry.savedAs = '';
      entry.bytes = 0;
      entry.completedAt = null;
      entry.nextRetryAt = null;
      entry.dispatchStartedAt = null;
      entry.blobLeaseId = '';
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
        entry.downloadId = null;
        entry.savedAs = '';
        entry.bytes = 0;
        entry.completedAt = null;
        entry.nextRetryAt = null;
        entry.dispatchStartedAt = null;
        entry.blobLeaseId = '';
        entry.updatedAt = Date.now();
        dmQueue.push(entry.workId);
        retried++;
      }
    }
  }
  await dmPersistNow();
  dmUpdateKeepAlive();
  dmTick();
  return { ok: true, retried };
}

function dmRemoveEntry(workId) {
  dmEntries.delete(String(workId));
  dmSchedulePersist();
  dmScheduleRetryAlarm().catch(() => {});
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
    const workId = dmQueue.shift();
    const entry = dmEntries.get(workId);
    if (!entry || entry.status !== 'queued') continue;
    dmNetworkActive++;
    dmProcess(entry).catch((err) => {
      console.error('[dm] process crashed for', workId, err);
    }).finally(() => {
      dmNetworkActive = Math.max(0, dmNetworkActive - 1);
      const current = dmEntries.get(workId);
      const pending = current?.pendingReplacement || null;
      if (pending && dmIsTerminal(current.status)) {
        current.pendingReplacement = null;
        current.updatedAt = Date.now();
        dmPersistNow().then(() => dmEnqueue([pending.item])).catch((error) => {
          dmLog('bg', 'error', 'pending re-enqueue failed', workId, error.message);
        });
      } else {
        dmUpdateKeepAlive();
        dmTick();
      }
    });
  }
}

function dmComputeFileName(entry) {
  const base = entry.audioFileName || entry.workName || entry.fileName || entry.workId;
  return sanitizeFileNameForDownload(base);
}

// Один проход скачивания одного entry. Не управляет семафором — это делает dmTick.
//
// Архитектурный комментарий:
// - В SW (Service Worker) НЕТ URL.createObjectURL, нет Blob URL APIs. Поэтому
//   blob:URL создаётся в offscreen.js (handleMuxOne) и возвращается строкой сюда.
//   SW делает chrome.downloads.download({url: blobUrl, ...}), а после завершения
//   шлёт offscreen 'revokeBlob' для освобождения памяти.
// - Direct path (нет chapters/crop) — отдаём прямой OSS URL, но всегда
//   форсируем безопасное имя с .mp4: часть OSS-ответов не содержит расширение.
async function dmProcess(entry) {
  const useChapters = entry.hasChapters && Number.isFinite(entry.audioMs)
    && Number.isFinite(entry.videoMs) && entry.videoMs > 0 && entry.audioMs > entry.videoMs;
  const requiresProcessing = useChapters;

  dmLog('bg', 'log', 'dm.process start', {
    workId: entry.workId,
    name: entry.audioFileName || entry.workName,
    hasChapters: entry.hasChapters,
    path: requiresProcessing ? 'processed' : 'direct',
  });

  let muxedBlobUrl = null;
  let blobLeaseId = '';
  try {
    if (requiresProcessing) {
      // ===== processed path: fetch in SW → physical crop/chapter mux in offscreen → save =====
      dmUpdateEntry(entry.workId, { status: 'fetching' });

      await ensureOffscreenDocument();
      dmUpdateEntry(entry.workId, { status: 'muxing' });
      const muxResp = await forwardToOffscreen({
        action: 'muxOne',
        payload: {
          url: entry.url,
          fetchTimeoutMs: DM_FETCH_TIMEOUT_MS,
          audioMs: entry.audioMs,
          videoMs: entry.videoMs,
          hasChapters: useChapters,
          workId: entry.workId,
        },
      });

      if (!muxResp?.ok || !muxResp.blobUrl) {
        throw new Error('video processing failed: ' + (muxResp?.error || 'no blobUrl returned'));
      }
      muxedBlobUrl = muxResp.blobUrl;
      blobLeaseId = String(muxResp.blobLeaseId || '');
      const finalBytes = muxResp.bytes || 0;
      const chaptersMade = muxResp.chapters || 0;

      const fileName = dmComputeFileName(entry);
      dmUpdateEntry(entry.workId, {
        status: 'dispatching',
        bytes: finalBytes,
        blobLeaseId,
        dispatchStartedAt: Date.now(),
        savedAs: fileName,
      });
      await dmPersistNow();
      const downloadId = await dmStartDownload(muxedBlobUrl, fileName, /*forceFilename=*/true);
      dmUpdateEntry(entry.workId, { status: 'saving', downloadId });
      await dmPersistNow();
      await dmWaitForComplete(downloadId, DM_DOWNLOAD_WAIT_TIMEOUT_MS);
      dmUpdateEntry(entry.workId, {
        status: 'done',
        downloadId,
        savedAs: fileName,
        completedAt: Date.now(),
        error: useChapters && chaptersMade === 0 ? 'saved without chapters (mux skipped)' : '',
      });
      dmLog('bg', 'log', 'dm.saved processed', {
        workId: entry.workId,
        fileName,
        chapters: chaptersMade,
      });
    } else {
      // ===== direct path: отдаём прямой OSS URL в chrome.downloads =====
      const fileName = dmComputeFileName(entry);
      dmUpdateEntry(entry.workId, {
        status: 'dispatching',
        dispatchStartedAt: Date.now(),
        savedAs: fileName,
      });
      await dmPersistNow();
      const downloadId = await dmStartDownload(entry.url, fileName, /*forceFilename=*/true);
      dmUpdateEntry(entry.workId, { status: 'saving', downloadId });
      await dmPersistNow();
      await dmWaitForComplete(downloadId, DM_DOWNLOAD_WAIT_TIMEOUT_MS);
      dmUpdateEntry(entry.workId, {
        status: 'done',
        downloadId,
        savedAs: fileName,
        completedAt: Date.now(),
      });
      dmLog('bg', 'log', 'dm.saved direct', { workId: entry.workId, fileName });
    }
  } catch (err) {
    entry.attempts = (entry.attempts || 0) + 1;
    const errMsg = err?.message || String(err);
    dmLog('bg', 'warn', 'dm.attempt', entry.attempts, 'failed for', entry.workId, errMsg);
    if (entry.downloadId) {
      let downloadItem;
      try {
        [downloadItem] = await chrome.downloads.search({ id: entry.downloadId });
      } catch (searchError) {
        dmUpdateEntry(entry.workId, {
          status: 'saving',
          error: `download state unknown: ${searchError.message || String(searchError)}`,
        });
        const blobUrlToRevoke = muxedBlobUrl;
        const leaseToRevoke = blobLeaseId;
        muxedBlobUrl = null;
        blobLeaseId = '';
        dmWatchRecoveredDownload(entry, blobUrlToRevoke, leaseToRevoke);
        return;
      }
      if (!downloadItem) {
        dmUpdateEntry(entry.workId, {
          status: 'saving',
          error: 'download state unknown: Chrome returned no matching download',
        });
        const blobUrlToRevoke = muxedBlobUrl;
        const leaseToRevoke = blobLeaseId;
        muxedBlobUrl = null;
        blobLeaseId = '';
        dmWatchRecoveredDownload(entry, blobUrlToRevoke, leaseToRevoke);
        return;
      }
      if (downloadItem?.state === 'complete') {
        dmUpdateEntry(entry.workId, {
          status: 'done',
          savedAs: entry.savedAs || dmComputeFileName(entry),
          completedAt: Date.now(),
          error: '',
        });
        return;
      }
      if (downloadItem?.state === 'in_progress') {
        dmUpdateEntry(entry.workId, { status: 'saving', error: errMsg });
        const blobUrlToRevoke = muxedBlobUrl;
        const leaseToRevoke = blobLeaseId;
        muxedBlobUrl = null;
        blobLeaseId = '';
        dmWatchRecoveredDownload(entry, blobUrlToRevoke, leaseToRevoke);
        return;
      }
    }
    // USER_CANCELED — пользователь / chrome сам отменил, retry бесполезен
    const isUserCanceled = /USER_CANCELED|user_canceled/i.test(errMsg);
    if (!isUserCanceled && entry.attempts < DM_MAX_ATTEMPTS) {
      // backoff
      const delay = DM_RETRY_BACKOFF_BASE_MS * entry.attempts;
      const nextRetryAt = Date.now() + delay;
      dmUpdateEntry(entry.workId, {
        status: 'retry_wait',
        downloadId: null,
        error: errMsg,
        nextRetryAt,
      });
      await dmPersistNow();
      await dmScheduleRetryAlarm();
    } else {
      dmUpdateEntry(entry.workId, {
        status: 'failed',
        error: errMsg,
        completedAt: Date.now(),
        nextRetryAt: null,
      });
      await dmScheduleRetryAlarm();
    }
  } finally {
    // освобождаем blob:URL в offscreen — chrome.downloads уже забрал данные
    if (muxedBlobUrl) {
      forwardToOffscreen({ action: 'revokeBlob', payload: { blobUrl: muxedBlobUrl, blobLeaseId } }).catch(() => {});
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
    const cleanup = () => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      forcedFilenameByDownloadId.delete(downloadId);
    };
    const onChanged = (delta) => {
      if (!delta || delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      } else if (delta.state?.current === 'interrupted') {
        if (settled) return;
        settled = true;
        cleanup();
        const reason = delta.error?.current || 'interrupted';
        dmLog('bg', 'warn', 'download.onChanged interrupted', { downloadId, delta: JSON.parse(JSON.stringify(delta || {})) });
        reject(new Error('download interrupted: ' + reason));
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('download wait timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }, ([item] = []) => {
      if (settled || chrome.runtime.lastError || !item) return;
      if (item.state === 'complete') {
        settled = true;
        cleanup();
        resolve();
      } else if (item.state === 'interrupted') {
        settled = true;
        cleanup();
        const reason = item.error || 'interrupted';
        reject(new Error('download interrupted: ' + reason));
      }
    });
  });
}

async function dmRecoveryScan() {
  // Для done/saving entries сверяем реальное состояние Chrome download.
  for (const entry of dmEntries.values()) {
    if ((entry.status === 'done' || entry.status === 'saving') && entry.downloadId) {
      try {
        const [item] = await chrome.downloads.search({ id: entry.downloadId });
        if (item?.state === 'complete') {
          entry.status = 'done';
          entry.error = '';
          entry.completedAt = entry.completedAt || Date.now();
          entry.updatedAt = Date.now();
        } else if (entry.status === 'saving' && item?.state === 'in_progress') {
          dmWatchRecoveredDownload(entry, '', entry.blobLeaseId || '');
        } else if (!item && entry.status === 'saving') {
          entry.error = 'download recovery state unknown: Chrome returned no matching download';
          entry.updatedAt = Date.now();
          dmWatchRecoveredDownload(entry, '', entry.blobLeaseId || '');
        } else if (!item || item.state === 'interrupted') {
          entry.status = entry.status === 'done' ? 'missing' : 'interrupted';
          entry.error = item?.error || 'file not found in chrome downloads';
          entry.updatedAt = Date.now();
        }
      } catch (error) {
        if (entry.status === 'saving') {
          entry.error = `download recovery state unknown: ${error.message || String(error)}`;
          entry.updatedAt = Date.now();
          dmWatchRecoveredDownload(entry, '', entry.blobLeaseId || '');
        }
      }
    }
  }
  const retainedLeaseIds = [...dmEntries.values()]
    .filter((entry) => entry.blobLeaseId && (
      entry.status === 'dispatching'
      || entry.status === 'saving'
      || entry.status === 'uncertain'
    ))
    .map((entry) => entry.blobLeaseId);
  await forwardToOffscreen({
    action: 'reconcileBlobLeases',
    payload: { retainedLeaseIds },
  }).catch((error) => {
    console.warn('[dm] blob lease reconciliation failed:', error.message || String(error));
  });
  dmSchedulePersist();
  dmUpdateKeepAlive();
  await dmRecoverRetries();
}

function dmWatchRecoveredDownload(entry, blobUrlToRevoke = '', blobLeaseId = '', recoveryAttempt = 0) {
  const downloadId = Number(entry?.downloadId);
  if (!Number.isInteger(downloadId) || dmRecoveredDownloadIds.has(downloadId)) return;
  dmRecoveredDownloadIds.add(downloadId);
  let shouldRewatch = false;
  dmWaitForComplete(downloadId, DM_DOWNLOAD_WAIT_TIMEOUT_MS).then(() => {
    dmUpdateEntry(entry.workId, { status: 'done', completedAt: Date.now(), error: '' });
  }).catch(async (error) => {
    try {
      const [downloadItem] = await chrome.downloads.search({ id: downloadId });
      if (downloadItem?.state === 'complete') {
        dmUpdateEntry(entry.workId, { status: 'done', completedAt: Date.now(), error: '' });
        return;
      }
      if (downloadItem?.state === 'interrupted') {
        dmUpdateEntry(entry.workId, {
          status: 'interrupted',
          error: downloadItem.error || error.message,
        });
        return;
      }
      if (downloadItem?.state === 'in_progress') {
        shouldRewatch = true;
        recoveryAttempt = -1;
        dmUpdateEntry(entry.workId, { status: 'saving', error: error.message });
        return;
      }
    } catch (searchError) {
      dmLog('bg', 'warn', 'recovered download state remains unknown', {
        downloadId,
        error: searchError.message || String(searchError),
      });
    }
    if (recoveryAttempt >= 2) {
      dmUpdateEntry(entry.workId, {
        status: 'uncertain',
        error: `download outcome remained unknown: ${error.message}`,
      });
      return;
    }
    shouldRewatch = true;
    dmUpdateEntry(entry.workId, { status: 'saving', error: error.message });
  }).finally(() => {
    if ((blobUrlToRevoke || blobLeaseId) && !shouldRewatch) {
      forwardToOffscreen({
        action: 'revokeBlob',
        payload: { blobUrl: blobUrlToRevoke, blobLeaseId },
      }).catch(() => {});
      dmUpdateEntry(entry.workId, { blobLeaseId: '' });
    }
    dmRecoveredDownloadIds.delete(downloadId);
    dmUpdateKeepAlive();
    if (shouldRewatch) {
      setTimeout(() => dmWatchRecoveredDownload(
        entry,
        blobUrlToRevoke,
        blobLeaseId,
        recoveryAttempt + 1,
      ), 1000);
    }
  });
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

function getRestartRecoveryStatus() {
  return {
    ...restartRecoveryStatus,
    triggers: [...restartRecoveryStatus.triggers],
    offscreenRequiredReasons: [...restartRecoveryStatus.offscreenRequiredReasons],
  };
}

function getOffscreenRecoveryReasons(runState, watchUnits) {
  const reasons = [];
  const queuePlan = Array.isArray(runState?.queuePlan) ? runState.queuePlan : [];
  const nextTaskIndex = Math.max(0, Number(runState?.nextTaskIndex || 0));
  const hasRemainingBulkWork = runState?.mode === 'bulk' && nextTaskIndex < queuePlan.length;
  const wasInterruptedLocally = ['preparing', 'normalizing', 'ready', 'running', 'stopping']
    .includes(runState?.phase);

  const presetState = runState?.bulkContext?.presetState
    || (runState?.bulkContext?.presetDirty ? 'restore_required' : 'clean');
  if (['dirty', 'restoring', 'restore_required'].includes(presetState)) reasons.push('preset_restore_required');
  if (wasInterruptedLocally || (hasRemainingBulkWork && runState?.recoverable)) {
    reasons.push('recoverable_local_run');
  }
  if (watchUnits.some((unit) => (
    unit?.status === 'pending'
    || unit?.status === 'submission_uncertain'
    || unit?.status === 'correlating'
    || (unit?.status === 'requires_review' && (unit?.workIds || []).some(Boolean))
  ))) {
    reasons.push('observable_watchers');
  }
  return reasons;
}

function recoverAfterRestart(trigger) {
  if (!restartRecoveryStatus.triggers.includes(trigger)) {
    restartRecoveryStatus.triggers = [...restartRecoveryStatus.triggers, trigger];
  }
  if (restartRecoveryPromise) return restartRecoveryPromise;

  restartRecoveryStatus = {
    ...restartRecoveryStatus,
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: '',
  };
  restartRecoveryPromise = (async () => {
    await dmLoad();
    await dmRecoveryScan();

    const [runState, watchUnits] = await Promise.all([
      getStoredRunState(),
      getBulkWatchUnitsFromStorage(),
    ]);
    const watcherAlarmEnabled = await syncBulkWatchAlarm(watchUnits);
    const offscreenRequiredReasons = getOffscreenRecoveryReasons(runState, watchUnits);
    if (offscreenRequiredReasons.length > 0) {
      await ensureOffscreenDocument();
      const initialization = await forwardToOffscreen({ action: 'ping' });
      if (!initialization?.ok) throw new Error(initialization?.error || 'offscreen recovery initialization failed');
    }

    restartRecoveryStatus = {
      ...restartRecoveryStatus,
      state: 'complete',
      finishedAt: new Date().toISOString(),
      watcherCount: watchUnits.length,
      watcherAlarmEnabled,
      offscreenRequiredReasons,
      offscreenEnsured: offscreenRequiredReasons.length > 0,
      error: '',
    };
    console.log('[bg] restart recovery complete', getRestartRecoveryStatus());
    return getRestartRecoveryStatus();
  })().catch((error) => {
    restartRecoveryStatus = {
      ...restartRecoveryStatus,
      state: 'failed',
      finishedAt: new Date().toISOString(),
      error: error.message || String(error),
    };
    console.error('[bg] restart recovery failed:', restartRecoveryStatus.error);
    throw error;
  }).finally(() => {
    restartRecoveryPromise = null;
  });
  return restartRecoveryPromise;
}

// =========================================================================
// LEGACY HELPERS (для существующих actions)
// =========================================================================

async function sendPageAction(tabId, action, payload = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
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
  const tabs = await chrome.tabs.query({ url: CREATIONS_URL_PATTERNS });
  let tab = tabs
    .filter((item) => /\/([a-z]{2}\/)?(creation|user)/i.test(item.url || '') && /type=Avatar(\+|%20)Video/i.test(item.url || ''))
    .sort((a, b) => (b.id || 0) - (a.id || 0))[0];
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
}

async function findBulkTab() {
  if (bulkRelayTabId) {
    let pinned = await chrome.tabs.get(bulkRelayTabId).catch(() => null);
    if (pinned && pinned.url?.includes('#dreamface-extension-relay')) {
      if (pinned.discarded) {
        pinned = await chrome.tabs.reload(pinned.id).then(() => chrome.tabs.get(pinned.id)).catch(() => null);
      }
      if (pinned) return waitForTabComplete(pinned.id);
    }
    bulkRelayTabId = null;
  }
  const tabs = await chrome.tabs.query({ url: DREAMFACE_URL_PATTERNS });
  let tab = tabs.find((item) => item.url?.includes('#dreamface-extension-relay')) || null;
  if (!tab) tab = await chrome.tabs.create({ url: BULK_RELAY_URL, active: false });
  tab = await waitForTabComplete(tab.id);
  if (!DREAMFACE_RELAY_PATH_RE.test(tab.url || '')) return null;
  bulkRelayTabId = tab.id;
  return tab;
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

      case 'engine.getRecoveryStatus':
        sendResponse({ ok: true, recovery: getRestartRecoveryStatus() });
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
        await persistRunState(request.state || createIdleRunState());
        sendResponse({ ok: true });
        return;

      case 'engine.resetRunState':
        sendResponse(await forwardToOffscreen({ action: 'resetRunState' }));
        return;

      case 'engine.pageAction': {
        const response = await sendPageAction(request.tabId, request.pageAction, request.payload);
        sendResponse({ ok: true, response });
        return;
      }

      case 'engine.markPaddedVideo': {
        const source = String(request.payload?.source || '');
        if (!source) {
          sendResponse({ ok: false, error: 'video marker source missing' });
          return;
        }
        await savePaddedVideoMarker(source, request.payload?.borderCropPx);
        sendResponse({ ok: true });
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

      // ============ BULK RELAY actions (offscreen -> avatar-bulk tab) ============
      case 'dfBulkOp': {
        const tab = await findBulkTab();
        if (!tab) { sendResponse({ ok: false, error: 'DreamFace avatar or creation tab not found' }); return; }
        sendResponse(await sendPageAction(tab.id, 'dfBulkOp', { op: request.op, payload: request.payload }));
        return;
      }

      case 'dfCaptureAccount': {
        const tab = await findBulkTab();
        if (!tab) { sendResponse({ ok: false, error: 'DreamFace avatar or creation tab not found' }); return; }
        sendResponse(await sendPageAction(tab.id, 'dfCaptureAccount', {}));
        return;
      }

      case 'dfSaveAccount': {
        let account;
        try {
          const candidate = validateCapturedAccount(request.account);
          const diagnostics = await diagnoseStoredAccount(candidate);
          account = { ...candidate, ...diagnostics };
        } catch (error) {
          sendResponse({
            ok: false,
            code: 'invalid_or_unavailable_credentials',
            error: `${error.message || String(error)}; existing saved account was not changed`,
          });
          return;
        }
        const stored = await chrome.storage.local.get(DREAMFACE_ACCOUNTS_KEY);
        const accounts = Array.isArray(stored[DREAMFACE_ACCOUNTS_KEY]) ? stored[DREAMFACE_ACCOUNTS_KEY] : [];
        const existing = canonicalizeAccounts(accounts).find((item) => item.principalKey === account.principalKey);
        const next = accounts.filter((item) => {
          const identity = getAccountIdentity(item);
          return identity.accountId !== account.accountId && identity.principalKey !== account.principalKey;
        });
        next.push({
          ...account,
          ...(existing?.durationSource === 'manual' && account.durationSource !== 'dreamface-api' ? {
            maxDurationSeconds: existing.maxDurationSeconds,
            durationSource: 'manual',
          } : {}),
          capturedAt: Date.now(),
        });
        await chrome.storage.local.set({ [DREAMFACE_ACCOUNTS_KEY]: next });
        const accountsForResponse = canonicalizeAccounts(next);
        sendResponse({
          ok: true,
          accounts: await isTrustedOffscreenSender(sender)
            ? accountsForResponse
            : accountsForResponse.map(redactStoredAccountCredential),
        });
        return;
      }

      case 'dfListAccounts': {
        const stored = await chrome.storage.local.get(DREAMFACE_ACCOUNTS_KEY);
        const accounts = canonicalizeAccounts(stored[DREAMFACE_ACCOUNTS_KEY]);
        sendResponse({
          ok: true,
          accounts: await isTrustedOffscreenSender(sender) ? accounts : accounts.map(redactStoredAccountCredential),
        });
        return;
      }

      case 'dfGetAccountHealth': {
        const stored = await chrome.storage.local.get(ACCOUNT_HEALTH_KEY);
        sendResponse({ ok: true, health: stored[ACCOUNT_HEALTH_KEY] || {} });
        return;
      }

      case 'dfPatchAccountHealth': {
        if (!request.accountId) {
          sendResponse({ ok: false, error: 'accountId is required' });
          return;
        }
        const health = await withAccountHealthMutation(async () => {
          const stored = await chrome.storage.local.get(ACCOUNT_HEALTH_KEY);
          const current = stored[ACCOUNT_HEALTH_KEY] && typeof stored[ACCOUNT_HEALTH_KEY] === 'object'
            ? stored[ACCOUNT_HEALTH_KEY]
            : {};
          const next = { ...current, [request.accountId]: request.health };
          await chrome.storage.local.set({ [ACCOUNT_HEALTH_KEY]: next });
          return next;
        });
        sendResponse({ ok: true, health });
        return;
      }

      // Offscreen documents only get chrome.runtime, so flags are read through here and
      // merged against defaults by the caller.
      case 'dfGetFeatures': {
        const stored = await chrome.storage.local.get(FEATURES_KEY);
        sendResponse({ ok: true, features: stored[FEATURES_KEY] || {} });
        return;
      }

      case 'dfGetAccountCredential':
      case 'dfGetAccountSession': {
        if (!await isTrustedOffscreenSender(sender)) {
          sendResponse({ ok: false, error: 'account credentials are available only to the offscreen document' });
          return;
        }
        const credential = await getStoredAccountCredential(request.accountId, request.principalKey);
        sendResponse(credential
          ? { ok: true, ...credential }
          : { ok: false, error: 'account session not found' });
        return;
      }

      case 'dfRemoveAccount': {
        const stored = await chrome.storage.local.get(DREAMFACE_ACCOUNTS_KEY);
        const accounts = Array.isArray(stored[DREAMFACE_ACCOUNTS_KEY]) ? stored[DREAMFACE_ACCOUNTS_KEY] : [];
        const targetPrincipal = request.principalKey
          || getAccountIdentity(accounts.find((item) => item.accountId === request.accountId) || {}).principalKey;
        const next = accounts.filter((item) => getAccountIdentity(item).principalKey !== targetPrincipal);
        await chrome.storage.local.set({ [DREAMFACE_ACCOUNTS_KEY]: next });
        const accountsForResponse = canonicalizeAccounts(next);
        sendResponse({
          ok: true,
          accounts: await isTrustedOffscreenSender(sender)
            ? accountsForResponse
            : accountsForResponse.map(redactStoredAccountCredential),
        });
        return;
      }

      case 'dfUpdateAccount': {
        const stored = await chrome.storage.local.get(DREAMFACE_ACCOUNTS_KEY);
        const accounts = Array.isArray(stored[DREAMFACE_ACCOUNTS_KEY]) ? stored[DREAMFACE_ACCOUNTS_KEY] : [];
        const next = accounts.map((item) => (
          (request.principalKey && getAccountIdentity(item).principalKey === request.principalKey)
          || item.accountId === request.accountId
        )
          ? {
            ...item,
            maxDurationSeconds: [30, 180, 600].includes(Number(request.maxDurationSeconds))
              ? Number(request.maxDurationSeconds)
              : 180,
            durationSource: 'manual',
          }
          : item);
        await chrome.storage.local.set({ [DREAMFACE_ACCOUNTS_KEY]: next });
        const accountsForResponse = canonicalizeAccounts(next);
        sendResponse({
          ok: true,
          accounts: await isTrustedOffscreenSender(sender)
            ? accountsForResponse
            : accountsForResponse.map(redactStoredAccountCredential),
        });
        return;
      }

      case 'dfGetAvatarCache': {
        const stored = await chrome.storage.local.get(AVATAR_CACHE_KEY);
        const cache = stored[AVATAR_CACHE_KEY] || {};
        const key = JSON.stringify([request.videoUrl, request.accountId]);
        const entry = cache[key];
        sendResponse({ ok: true, avatarId: entry?.avatarId || null });
        return;
      }

      case 'dfSetAvatarCache': {
        const stored = await chrome.storage.local.get(AVATAR_CACHE_KEY);
        const cache = stored[AVATAR_CACHE_KEY] || {};
        const key = JSON.stringify([request.videoUrl, request.accountId]);
        cache[key] = { avatarId: request.avatarId, registeredAt: Date.now() };
        const entries = Object.entries(cache);
        if (entries.length > AVATAR_CACHE_LIMIT) {
          entries.sort((a, b) => (a[1].registeredAt || 0) - (b[1].registeredAt || 0));
          for (let i = 0; i < entries.length - AVATAR_CACHE_LIMIT; i += 1) delete cache[entries[i][0]];
        }
        await chrome.storage.local.set({ [AVATAR_CACHE_KEY]: cache });
        sendResponse({ ok: true });
        return;
      }

      case 'dfDeleteAvatarCache': {
        const stored = await chrome.storage.local.get(AVATAR_CACHE_KEY);
        const cache = stored[AVATAR_CACHE_KEY] || {};
        const key = JSON.stringify([request.videoUrl, request.accountId]);
        delete cache[key];
        await chrome.storage.local.set({ [AVATAR_CACHE_KEY]: cache });
        sendResponse({ ok: true });
        return;
      }

      case 'dfClearAvatarCache': {
        await chrome.storage.local.set({ [AVATAR_CACHE_KEY]: {} });
        sendResponse({ ok: true });
        return;
      }

      case 'dfGetBulkWatchUnits': {
        const stored = await chrome.storage.local.get(BULK_WATCH_STORAGE_KEY);
        const storedUnits = stored[BULK_WATCH_STORAGE_KEY];
        if (storedUnits !== undefined && !Array.isArray(storedUnits)) {
          sendResponse({ ok: false, error: 'stored bulk watch units are malformed' });
          return;
        }
        const units = storedUnits || [];
        console.log('[bg] dfGetBulkWatchUnits →', units.length, 'units');
        sendResponse({ ok: true, units });
        return;
      }

      case 'dfUpsertBulkWatchUnit': {
        if (!request.unit?.id) {
          sendResponse({ ok: false, error: 'bulk watch unit id is required' });
          return;
        }
        const next = await withBulkWatchMutation(async () => {
          const stored = await chrome.storage.local.get(BULK_WATCH_STORAGE_KEY);
          const storedUnits = stored[BULK_WATCH_STORAGE_KEY];
          if (storedUnits !== undefined && !Array.isArray(storedUnits)) {
            throw new Error('stored bulk watch units are malformed');
          }
          const units = storedUnits || [];
          const updated = units.filter((unit) => unit.id !== request.unit.id);
          updated.push(request.unit);
          await chrome.storage.local.set({ [BULK_WATCH_STORAGE_KEY]: updated });
          await syncBulkWatchAlarm(updated);
          return updated;
        });
        console.log('[bg] dfUpsertBulkWatchUnit ←', request.unit.id, '| total:', next.length);
        sendResponse({ ok: true, units: next });
        return;
      }

      case 'dfRemoveBulkWatchUnit': {
        const next = await withBulkWatchMutation(async () => {
          const stored = await chrome.storage.local.get(BULK_WATCH_STORAGE_KEY);
          const storedUnits = stored[BULK_WATCH_STORAGE_KEY];
          if (storedUnits !== undefined && !Array.isArray(storedUnits)) {
            throw new Error('stored bulk watch units are malformed');
          }
          const units = storedUnits || [];
          const updated = units.filter((unit) => unit.id !== request.id);
          await chrome.storage.local.set({ [BULK_WATCH_STORAGE_KEY]: updated });
          await syncBulkWatchAlarm(updated);
          return updated;
        });
        console.log('[bg] dfRemoveBulkWatchUnit ←', request.id, '| total:', next.length);
        sendResponse({ ok: true, units: next });
        return;
      }

      case 'dfPatchBulkWatchUnits': {
        if (!Array.isArray(request.units)) {
          sendResponse({ ok: false, error: 'bulk watch unit patches must be an array' });
          return;
        }
        const next = await withBulkWatchMutation(async () => {
          const stored = await chrome.storage.local.get(BULK_WATCH_STORAGE_KEY);
          const storedUnits = stored[BULK_WATCH_STORAGE_KEY];
          if (storedUnits !== undefined && !Array.isArray(storedUnits)) {
            throw new Error('stored bulk watch units are malformed');
          }
          const patchById = new Map(request.units.filter((unit) => unit?.id).map((unit) => [unit.id, unit]));
          const updated = (storedUnits || []).map((unit) => patchById.get(unit.id) || unit);
          await chrome.storage.local.set({ [BULK_WATCH_STORAGE_KEY]: updated });
          await syncBulkWatchAlarm(updated);
          return updated;
        });
        console.log('[bg] dfPatchBulkWatchUnits ←', request.units.length, 'patches | total:', next.length, '| watcher:', request.units.map((unit) => ({
          id: unit.id,
          accountId: unit.accountId,
          scanned: unit.watcherStats?.scanned || 0,
          matched: unit.watcherStats?.matched || 0,
          statuses: unit.watcherStats?.statuses || {},
          ready: unit.watcherStats?.ready || 0,
          urls: `${unit.watcherStats?.receivedUrls || 0}/${unit.watcherStats?.requestedUrls || 0}`,
          enqueued: unit.enqueuedWorkIds?.length || 0,
          error: unit.lastError || '',
        })));
        sendResponse({ ok: true, units: next });
        return;
      }

      case 'dfDiagnoseAccounts': {
        const stored = await chrome.storage.local.get(DREAMFACE_ACCOUNTS_KEY);
        const accounts = canonicalizeAccounts(stored[DREAMFACE_ACCOUNTS_KEY]);
        if (accounts.length === 0) {
          sendResponse({ ok: false, error: 'сохранённых аккаунтов нет' });
          return;
        }
        const diagnostics = [];
        for (let index = 0; index < accounts.length; index += 2) {
          const chunk = accounts.slice(index, index + 2);
          const chunkResults = await Promise.all(chunk.map(async (account) => {
            try {
              return await diagnoseStoredAccount(account);
            } catch (error) {
              const message = error?.name === 'AbortError' ? 'DreamFace request timed out' : (error.message || String(error));
              return { accountId: account.accountId, ok: false, error: message };
            }
          }));
          diagnostics.push(...chunkResults);
          }
        sendResponse({ ok: true, diagnostics });
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

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details?.reason === 'install') {
    await persistRunState(createIdleRunState());
  }
  await recoverAfterRestart(`onInstalled:${details?.reason || 'unknown'}`);
});

chrome.runtime.onStartup.addListener(async () => {
  await recoverAfterRestart('onStartup');
});

// Eager recovery also covers service-worker restarts inside a Chrome session.
recoverAfterRestart('top-level').catch(() => {});
