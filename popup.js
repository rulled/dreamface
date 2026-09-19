const SETTINGS_KEY = 'audioProcessingSettings';
const RUN_DB_NAME = 'dreamface-run-db';
const RUN_DB_VERSION = 4;
const RUN_STORE_NAME = 'audioTasks';
const INPUT_STORE_NAME = 'inputFiles';
const DEFAULT_MAX_DURATION_SECONDS = 180;
const EXTENDED_MAX_DURATION_SECONDS = 600;
const DEFAULT_SETTINGS = {
  autoNormalize: true,
  overlapEnabled: false,
  preLoopEnabled: false,
  addBorderEnabled: false,
  maxDurationSeconds: DEFAULT_MAX_DURATION_SECONDS,
};
const MAX_AUDIO_PREVIEW_ITEMS = 5;
const VIDEO_GRID_COLUMNS = 5;
const VIDEO_GRID_ROWS = 3;
const VIDEO_PAGE_SIZE = VIDEO_GRID_COLUMNS * VIDEO_GRID_ROWS;

let foundVideos = [];
let batches = [];
let latestRunState = null;
let latestWatchUnits = [];
let downloadsState = [];
let savedAccounts = [];
let monitorRefreshTimer = null;
let settingsSavePromise = Promise.resolve();
let latestActiveTabContext = {
  id: null,
  url: '',
  isDreamFace: false,
  isCreations: false,
};

const setupView = document.getElementById('setup-view');
const monitorView = document.getElementById('monitor-view');
const scanBtn = document.getElementById('scanBtn');
const scanBtnLabel = document.getElementById('scanBtnLabel');
const uploadVideosBtn = document.getElementById('uploadVideosBtn');
const startBtn = document.getElementById('startBtn');
const queuePreview = document.getElementById('queuePreview');
const statusText = document.getElementById('statusText');
const batchesList = document.getElementById('batchesList');
const addBatchBtn = document.getElementById('addBatchBtn');
const loadingContainer = document.getElementById('loadingContainer');
const postScanContainer = document.getElementById('postScanContainer');
const durationModeToggle = document.getElementById('durationModeToggle');
const durationModeSubtitle = document.getElementById('durationModeSubtitle');
const autoNormalizeToggle = document.getElementById('autoNormalizeToggle');
const overlapToggle = document.getElementById('overlapToggle');
const overlapSubtitle = document.getElementById('overlapSubtitle');
const preLoopToggle = document.getElementById('preLoopToggle');
const addBorderToggle = document.getElementById('addBorderToggle');
const addBorderSubtitle = document.getElementById('addBorderSubtitle');
const captureAccountBtn = document.getElementById('captureAccountBtn');
const diagnoseAccountsBtn = document.getElementById('diagnoseAccountsBtn');
const accountsList = document.getElementById('accountsList');

const stopBtn = document.getElementById('stopBtn');
const backBtn = document.getElementById('backBtn');
const resumeBtn = document.getElementById('resumeBtn');
const retryDownloadsBtn = document.getElementById('retryDownloadsBtn');
const stopNote = document.getElementById('stopNote');
const monitorTitle = document.getElementById('monitorTitle');
const monitorPreparation = document.getElementById('monitorPreparation');
const monitorProgressLabel = document.getElementById('monitorProgressLabel');
const monitorStages = document.getElementById('monitorStages');
const monitorAccounts = document.getElementById('monitorAccounts');
const monitorError = document.getElementById('monitorError');
const monitorKicker = document.getElementById('monitorKicker');
const monitorPhase = document.getElementById('monitorPhase');
const monitorFileName = document.getElementById('monitorFileName');
const monitorProgressFill = document.getElementById('monitorProgressFill');
// monitorProgressText удалён из DOM после редизайна — числа теперь в monitorHeadline*.
// Оставляем переменную для обратной совместимости со старым кодом, но допускаем null.
const monitorProgressText = document.getElementById('monitorProgressText');
const monitorHeadlineNum = document.getElementById('monitorHeadlineNum');
const monitorHeadlineOf = document.getElementById('monitorHeadlineOf');
const monitorPhaseDot = document.getElementById('monitorPhaseDot');
const monitorGroups = document.getElementById('monitorGroups');
const monitorAdvancedVisual = document.getElementById('monitorAdvancedVisual');
const monitorLog = document.getElementById('monitorLog');
const monitorVisual = document.getElementById('monitorVisual');
const monitorSummary = document.getElementById('monitorSummary');
const monitorAlert = document.getElementById('monitorAlert');

function isActiveRunPhase(phase) {
  return ['preparing', 'normalizing', 'ready', 'running', 'downloading', 'stopping'].includes(phase);
}

const PHASE_LABEL = {
  idle: 'ожидание',
  preparing: 'готовим очередь',
  normalizing: 'обрабатываем аудио',
  ready: 'очередь готова',
  running: 'отправляем в DreamFace',
  downloading: 'скачиваем результаты',
  stopping: 'останавливаем очередь',
  stopped: 'отправка остановлена',
  finished: 'отправка завершена',
  failed: 'обработка прервалась',
};

const KICKER_LABEL = {
  idle: 'обработка',
  preparing: 'обработка',
  normalizing: 'обработка',
  ready: 'обработка',
  running: 'обработка',
  downloading: 'обработка',
  stopping: 'обработка',
  stopped: 'остановлено',
  finished: 'готово',
  failed: 'остановлено',
};

const PLACEHOLDER_REASONS = new Set([
  'ожидание',
  'ожидание...',
  'подготовка очереди...',
  'запуск нормализации...',
]);

function isUserStoppedRun(state) {
  return Boolean(
    state
    && (state.phase === 'stopped'
      || ['user_stopped', 'stopped_with_submission_uncertain'].includes(state.interruptionReason)
      || /остановлен[ао]? пользователем|stopped by (?:the )?user/i.test(state.statusText || '')),
  );
}

function isSubmissionUncertainRun(state) {
  return ['bulk_submission_uncertain', 'completed_with_submission_uncertain', 'stopped_with_submission_uncertain']
    .includes(state?.interruptionReason);
}

function getMonitorKickerLabel(state) {
  if (isUserStoppedRun(state)) {
    return KICKER_LABEL.stopped;
  }
  if (state?.phase === 'failed' && state.recoverable && state.interrupted) {
    return 'пауза';
  }
  return KICKER_LABEL[state?.phase] || 'обработка';
}

function getMonitorPhaseLabel(state) {
  if (!state) {
    return PHASE_LABEL.idle;
  }
  if (isUserStoppedRun(state)) {
    return PHASE_LABEL.stopped;
  }
  const base = PHASE_LABEL[state.phase] || state.phase || PHASE_LABEL.idle;
  if (state.phase === 'failed' && state.recoverable && state.interrupted) {
    return state.statusText && !PLACEHOLDER_REASONS.has(state.statusText.trim())
      ? state.statusText
      : 'ждём восстановления связи';
  }
  const reason = (state.statusText || '').trim();
  if (!reason || PLACEHOLDER_REASONS.has(reason)) {
    return base;
  }
  if (reason === base) {
    return base;
  }
  return `${base} · ${reason}`;
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
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
}

async function withInputStore(mode, callback) {
  const db = await openRunDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(INPUT_STORE_NAME, mode);
    const store = transaction.objectStore(INPUT_STORE_NAME);
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

async function clearInputFiles() {
  await withInputStore('readwrite', (store) => {
    store.clear();
  });
}

async function saveSelectedFilesToDb(validBatches) {
  await clearInputFiles();

  const batchesWithRefs = [];

  for (const batch of validBatches) {
    const audioFiles = [];

    for (const file of batch.audioFiles) {
      const id = `input-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      await withInputStore('readwrite', (store) => {
        store.put({
          id,
          name: file.name,
          type: file.type || 'application/octet-stream',
          lastModified: file.lastModified || Date.now(),
          blob: file,
        });
      });

      audioFiles.push({
        id,
        name: file.name,
        type: file.type || 'application/octet-stream',
        lastModified: file.lastModified || Date.now(),
        size: file.size || 0,
      });
    }

    batchesWithRefs.push({
      id: batch.id,
      selectedAvatars: batch.selectedAvatars.map((avatar) => ({ ...avatar })),
      audioFiles,
    });
  }

  return batchesWithRefs;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getConciseMessage(value, fallback = '', maxLength = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return {
    ...DEFAULT_SETTINGS,
    ...(data[SETTINGS_KEY] || {}),
  };
}

function getSelectedMaxDurationSeconds() {
  return durationModeToggle.checked ? EXTENDED_MAX_DURATION_SECONDS : DEFAULT_MAX_DURATION_SECONDS;
}

function updateAudioModeCopy() {
  const maxDurationSeconds = getSelectedMaxDurationSeconds();
  durationModeSubtitle.textContent = durationModeToggle.checked
    ? 'вкл. используется расширенный лимит до 600 секунд'
    : 'выкл. используется стандартный лимит до 180 секунд';
  overlapSubtitle.textContent = `добавляет перекрытие при нарезке аудио длиннее ${maxDurationSeconds} секунд`;
}

function updateBorderModeCopy() {
  if (addBorderSubtitle && addBorderToggle) {
    addBorderSubtitle.textContent = addBorderToggle.checked
      ? 'вкл. загружает в DreamFace видео с полосой слева'
      : 'выкл. загружает исходное видео без дополнительной полосы';
  }
}

function renderAccounts(accounts) {
  savedAccounts = Array.isArray(accounts) ? accounts : [];
  if (!accountsList) return;
  accountsList.innerHTML = '';
  if (!Array.isArray(accounts) || accounts.length === 0) {
    accountsList.innerHTML = '<div class="empty-state">сохранённых аккаунтов нет — используется текущий вход</div>';
    return;
  }
  for (const account of accounts) {
    const row = document.createElement('div');
    row.className = 'audio-item';
    const name = document.createElement('div');
    name.className = 'audio-item-name';
    const duration = Number(account.maxDurationSeconds || 180);
    const rawIdentity = account.thirdId || account.userId || account.accountId;
    const identityLabel = String(rawIdentity).includes('@')
      ? String(rawIdentity).replace(/^(.{3}).*(@.*)$/, '$1***$2')
      : rawIdentity;
    name.textContent = `${identityLabel} · ${account.planName || 'Unknown'} · ${duration}s`;
    name.title = identityLabel;
    const durationSelect = document.createElement('select');
    durationSelect.className = 'mini-btn';
    durationSelect.setAttribute('aria-label', `лимит аккаунта ${identityLabel}`);
    durationSelect.innerHTML = '<option value="30">30s</option><option value="180">180s</option><option value="600">600s</option>';
    durationSelect.value = String([30, 180, 600].includes(duration) ? duration : 180);
    durationSelect.disabled = account.durationSource === 'dreamface-api';
    durationSelect.onchange = async () => {
      const response = await chrome.runtime.sendMessage({
        action: 'dfUpdateAccount',
        accountId: account.accountId,
        principalKey: account.principalKey,
        maxDurationSeconds: Number(durationSelect.value),
      });
      if (response?.ok) renderAccounts(response.accounts);
    };
    const remove = document.createElement('button');
    remove.className = 'audio-remove';
    remove.type = 'button';
    remove.innerHTML = '<span aria-hidden="true">×</span>';
    remove.setAttribute('aria-label', `удалить аккаунт ${identityLabel}`);
    remove.onclick = async () => {
      const response = await chrome.runtime.sendMessage({
        action: 'dfRemoveAccount',
        accountId: account.accountId,
        principalKey: account.principalKey,
      });
      if (response?.ok) renderAccounts(response.accounts);
    };
    row.appendChild(name);
    row.appendChild(durationSelect);
    row.appendChild(remove);
    accountsList.appendChild(row);
  }
}

async function loadAccounts() {
  const response = await chrome.runtime.sendMessage({ action: 'dfListAccounts' }).catch(() => null);
  if (response?.ok) {
    renderAccounts(response.accounts);
    renderCurrentRunMonitor();
  }
}

function updateScanButtonLabel() {
  if (scanBtnLabel) {
    scanBtnLabel.textContent = foundVideos.length > 0 ? 'пересканировать' : 'сканировать';
  }
}

function getVideoIdentity(source) {
  try {
    const url = new URL(source);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return String(source || '');
  }
}

function getBatchSelectedVideoPreviews(batch, limit = 3) {
  return (batch.selectedIndices || [])
    .map((index) => ({ index, video: foundVideos[index] }))
    .filter((item) => item.video)
    .slice(0, limit);
}

function getVideoPageCount() {
  return Math.max(1, Math.ceil(foundVideos.length / VIDEO_PAGE_SIZE));
}

function clampBatchVideoPage(batch) {
  batch.videoPage = Math.min(
    Math.max(0, Number(batch.videoPage || 0)),
    Math.max(0, getVideoPageCount() - 1),
  );
}

function getBatchVideoPageRange(batch) {
  clampBatchVideoPage(batch);
  const start = batch.videoPage * VIDEO_PAGE_SIZE;
  const end = Math.min(foundVideos.length, start + VIDEO_PAGE_SIZE);
  return { start, end };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ? tab : null;
}

function isDreamFaceUrl(url = '') {
  return /dreamfaceapp\.com/i.test(url || '');
}

function isCreationsUrl(url = '') {
  if (!isDreamFaceUrl(url)) {
    return false;
  }

  const normalized = String(url || '').toLowerCase();
  if (!/\/([a-z]{2}\/)?(creation|user)([/?#]|$)/i.test(normalized)) {
    return false;
  }

  if (!normalized.includes('type=')) {
    return true;
  }

  return /type=avatar(?:\+|%20)video/i.test(normalized);
}

function createTabContext(tab) {
  const url = tab?.url || '';
  return {
    id: tab?.id || null,
    url,
    isDreamFace: isDreamFaceUrl(url),
    isCreations: isCreationsUrl(url),
  };
}

async function refreshActiveTabContext({ rerender = true } = {}) {
  const tab = await getActiveTab().catch(() => null);
  latestActiveTabContext = createTabContext(tab);

  if (rerender && latestRunState) {
    renderRunState(latestRunState);
  }

  return latestActiveTabContext;
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function formatPendingFilesList(items, limit = 4) {
  const files = Array.isArray(items) ? items.filter(Boolean) : [];
  if (files.length === 0) {
    return '';
  }

  const visible = files.slice(0, limit).join(', ');
  return files.length > limit ? `${visible} и ещё ${files.length - limit}` : visible;
}

function getExpectedCreationsTotal(state) {
  if (!state) {
    return 0;
  }

  const explicitTotal = Number(state.downloadPlan?.totalExpected || 0);
  if (explicitTotal > 0) {
    return explicitTotal;
  }

  return Array.isArray(state.downloadPlan?.expectedFileNames)
    ? state.downloadPlan.expectedFileNames.length
    : 0;
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

function resetSetupState() {
  foundVideos = [];
  batches = [];
  latestRunState = null;
  batchesList.innerHTML = '';
  if (monitorSummary) monitorSummary.innerHTML = '';
  if (monitorVisual) monitorVisual.innerHTML = '';
  if (monitorAdvancedVisual) monitorAdvancedVisual.innerHTML = '';
  if (monitorGroups) {
    monitorGroups.innerHTML = '';
    monitorGroups.hidden = true;
  }
  if (monitorAlert) {
    monitorAlert.innerHTML = '';
    monitorAlert.classList.remove('active');
  }
  if (monitorPhase) monitorPhase.textContent = PHASE_LABEL.idle;
  if (monitorPhaseDot) monitorPhaseDot.dataset.phase = 'idle';
  if (monitorFileName) {
    monitorFileName.textContent = '—';
    monitorFileName.removeAttribute('title');
  }
  if (monitorProgressFill) monitorProgressFill.style.width = '0%';
  if (monitorProgressText) monitorProgressText.textContent = '0 / 0';
  if (monitorHeadlineNum) monitorHeadlineNum.textContent = '0';
  if (monitorHeadlineOf) monitorHeadlineOf.textContent = 'из 0';
  postScanContainer.style.display = 'none';
  loadingContainer.classList.remove('active');
  updateResumeButton(null);
  updateScanButtonLabel();
  updateTotalStats();
  showSetup();
}

async function resetExtensionState(statusMessage = 'ожидание...') {
  const response = await chrome.runtime.sendMessage({ action: 'engine.resetRunState' }).catch((error) => ({
    ok: false,
    error: error.message,
  }));

  if (!response?.ok) {
    throw new Error(response?.error || 'не удалось сбросить состояние расширения');
  }

  resetSetupState();
  statusText.textContent = statusMessage;
}

async function updateStoredRunState(mutator) {
  if (!latestRunState) {
    return null;
  }

  const nextState = cloneState(latestRunState);
  mutator(nextState);
  latestRunState = nextState;
  renderRunState(nextState);
  await chrome.runtime.sendMessage({ action: 'engine.persistRunState', state: nextState }).catch(() => {});
  return nextState;
}

function getCreationsLogText(state) {
  if (!canUseCreations(state)) {
    if (canResumeRun(state)) {
      const reason = (state?.statusText || '').trim();
      return reason && !PLACEHOLDER_REASONS.has(reason)
        ? `обработка приостановлена: ${reason}. нажмите «возобновить», когда связь восстановится.`
        : 'обработка приостановлена. нажмите «возобновить», когда связь восстановится.';
    }

    const fallback = (state?.statusText || '').trim();
    if (fallback && !PLACEHOLDER_REASONS.has(fallback)) {
      return fallback;
    }
    return state?.phase ? PHASE_LABEL[state.phase] || 'ожидание' : 'ничего не запущено';
  }

  const status = state.downloadPlan?.lastStatus || 'idle';
  const lastMessage = state.downloadPlan?.lastMessage || '';

  if (status === 'success') {
    return lastMessage || 'скачивание запущено — браузер сохраняет файлы из Creations.';
  }

  if (status === 'failed') {
    return lastMessage || 'DreamFace завершил генерацию с ошибкой.';
  }

  if (!latestActiveTabContext.isCreations) {
    return 'генерация завершена. откройте вкладку Creations, чтобы скачать результаты.';
  }

  if (status === 'pending') {
    return lastMessage || 'часть результатов ещё генерируется. подождите и нажмите «проверить снова».';
  }

  if (status === 'partial') {
    return lastMessage || 'не все результаты готовы. подождите и нажмите «проверить снова».';
  }

  if (status === 'error') {
    return lastMessage || 'не удалось проверить Creations. попробуйте ещё раз.';
  }

  return 'вкладка Creations открыта. нажмите «проверить результаты», чтобы найти готовое.';
}

function buildCreationsCheckMessage(result) {
  const totalExpected = Number(result?.totalExpected || 0);
  const matchedCount = Number(result?.matchedCount || 0);
  const pending = Array.isArray(result?.pending) ? result.pending.filter(Boolean) : [];

  if (result?.status === 'pending') {
    const pendingText = formatPendingFilesList(pending);
    return pendingText
      ? `ещё не готовы: ${pendingText}`
      : `ещё не готовы результаты: ${matchedCount} / ${totalExpected}`;
  }

  if (result?.status === 'partial') {
    const pendingText = formatPendingFilesList(pending);
    return pendingText
      ? `ещё не готовы: ${pendingText}`
      : `ещё готовы не все результаты: ${matchedCount} / ${totalExpected}`;
  }

  if (result?.status === 'ready') {
    return `все результаты готовы: ${matchedCount} из ${totalExpected}`;
  }

  return result?.message || 'не удалось проверить результаты в Creations';
}

function buildCreationsDownloadMessage(result) {
  const pending = Array.isArray(result?.pending) ? result.pending.filter(Boolean) : [];
  const downloadedCount = Number(result?.downloadedCount || 0);

  if (result?.status === 'success') {
    return `скачивание запущено: ${downloadedCount}`;
  }

  if (result?.status === 'partial') {
    const pendingText = formatPendingFilesList(pending);
    return pendingText
      ? `скачивание отменено: ещё не готовы ${pendingText}`
      : 'скачивание отменено: готовы не все результаты';
  }

  return result?.message || 'не удалось запустить скачивание';
}

function parseQueueAudioName(fileName = '') {
  const name = String(fileName || '').trim();
  const match = name.match(/^(.*)__part-(\d+)\.mp3$/i);
  if (match) {
    return {
      baseName: `${match[1]}.mp3`,
      partLabel: Number(match[2]),
      isPart: true,
    };
  }

  return {
    baseName: name,
    partLabel: null,
    isPart: false,
  };
}

function getVideoAvatarHtml(videoIndex) {
  const video = foundVideos[videoIndex];
  if (video?.src) {
    return `<span class="route-avatar"><img src="${escapeHtml(video.src)}" alt=""></span>`;
  }

  return `<span class="route-avatar">#${Number(videoIndex) + 1}</span>`;
}

function buildQueueGroups(state) {
  const queue = Array.isArray(state?.queuePlan) ? state.queuePlan : [];
  const groups = new Map();

  queue.forEach((task, index) => {
    const parsed = parseQueueAudioName(task.fileName);
    if (!groups.has(parsed.baseName)) {
      groups.set(parsed.baseName, []);
    }

    groups.get(parsed.baseName).push({
      ...task,
      queueIndex: index,
      partLabel: parsed.partLabel,
      isPart: parsed.isPart,
    });
  });

  return Array.from(groups.entries()).map(([baseName, tasks]) => ({ baseName, tasks }));
}

function getFocusedQueueGroups(groups, focusIndex, limit = 4) {
  if (!Array.isArray(groups) || groups.length <= limit) {
    return Array.isArray(groups) ? groups : [];
  }

  const safeFocusIndex = Math.max(0, Number(focusIndex || 0));
  const activeGroupIndex = groups.findIndex((group) => (
    group.tasks.some((task) => task.queueIndex >= safeFocusIndex)
  ));
  const anchor = activeGroupIndex === -1 ? groups.length - 1 : activeGroupIndex;
  const start = Math.min(
    Math.max(0, anchor - 1),
    Math.max(0, groups.length - limit),
  );

  return groups.slice(start, start + limit);
}

function renderMonitorGroups(state) {
  if (!monitorGroups) {
    return;
  }

  const queue = Array.isArray(state?.queuePlan) ? state.queuePlan : [];
  const batchesMeta = Array.isArray(state?.summary?.batches) ? state.summary.batches : [];

  // если у нас нет ни тасков с batchId, ни batchesMeta — нет смысла показывать блок
  const hasBatchInfo = batchesMeta.length > 0 || queue.some((t) => t && t.batchId !== undefined);
  if (!hasBatchInfo) {
    monitorGroups.innerHTML = '';
    monitorGroups.hidden = true;
    return;
  }

  // прогресс по группам считается из queue + nextTaskIndex
  const completedTasks = Math.min(queue.length, Number(state.nextTaskIndex || 0));
  const currentIndex = Math.max(0, Number(state.current || 0) - 1);

  // если batchesMeta пуст (старые run'ы) — собираем фолбек из тасков
  let groups = batchesMeta.slice();
  if (groups.length === 0) {
    const map = new Map();
    queue.forEach((task) => {
      const key = task.batchId ?? `idx-${task.batchIndex ?? 0}`;
      if (!map.has(key)) {
        map.set(key, {
          batchId: task.batchId ?? null,
          batchIndex: task.batchIndex ?? map.size,
          taskCount: 0,
          videoCount: 0,
          audioCount: 0,
          sampleAudioNames: [],
        });
      }
      map.get(key).taskCount += 1;
    });
    groups = Array.from(map.values());
  }

  // нормализуем порядок — по batchIndex
  groups.sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0));

  const totalGroups = groups.length;
  let activeGroupIndex = -1;

  const itemsHtml = groups.map((group, idx) => {
    const tasksInGroup = queue.filter((task) => {
      if (group.batchId !== null && task.batchId !== undefined) {
        return task.batchId === group.batchId;
      }
      return task.batchIndex === group.batchIndex;
    });

    const total = tasksInGroup.length || Number(group.taskCount || 0);
    let done = 0;
    let isActive = false;
    tasksInGroup.forEach((task) => {
      const qIndex = queue.indexOf(task);
      if (qIndex < completedTasks) {
        done += 1;
      } else if (qIndex === currentIndex || qIndex === Number(state.nextTaskIndex || 0)) {
        isActive = true;
      }
    });

    if (isActive && activeGroupIndex === -1) {
      activeGroupIndex = idx;
    }

    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const stateClass = total === 0
      ? 'empty'
      : done >= total
        ? 'done'
        : isActive
          ? 'active'
          : done > 0
            ? 'partial'
            : 'pending';

    const subtitle = [
      group.videoCount ? `видео: ${group.videoCount}` : '',
      group.audioCount ? `аудио: ${group.audioCount}` : '',
    ].filter(Boolean).join(' · ') || 'нет задач';

    return `
      <div class="monitor-group ${stateClass}" data-batch-index="${group.batchIndex}">
        <div class="monitor-group-head">
          <span class="monitor-group-title">группа ${idx + 1}</span>
          <span class="monitor-group-count">${done} / ${total}</span>
        </div>
        <div class="monitor-group-sub">${escapeHtml(subtitle)}</div>
        <div class="monitor-group-bar">
          <div class="monitor-group-fill" style="width:${percent}%"></div>
        </div>
      </div>
    `;
  }).join('');

  const headLabel = totalGroups > 0
    ? `${Math.max(1, activeGroupIndex + 1)} / ${totalGroups}`
    : '0 / 0';

  monitorGroups.innerHTML = `
    <div class="monitor-groups-head">
      <span class="monitor-groups-title">группы</span>
      <span class="monitor-groups-count">${escapeHtml(headLabel)}</span>
    </div>
    <div class="monitor-groups-list">${itemsHtml}</div>
  `;
  monitorGroups.hidden = false;
}

function renderMonitorVisual(state) {
  // после редизайна основной блок очереди живёт в details (#monitorAdvancedVisual).
  // старый #monitorVisual оставлен в DOM скрытым для обратной совместимости.
  const target = monitorAdvancedVisual || monitorVisual;
  if (!target) {
    return;
  }

  if (!state || state.phase === 'idle') {
    target.innerHTML = '';
    if (monitorVisual && monitorVisual !== target) monitorVisual.innerHTML = '';
    return;
  }

  const queue = Array.isArray(state.queuePlan) ? state.queuePlan : [];
  const totalTasks = Number(state.total || queue.length || state.summary?.totalGeneratedTasks || 0);
  const completedTasks = Math.min(totalTasks, Number(state.nextTaskIndex || 0));
  const displayProgress = Math.min(totalTasks, Math.max(completedTasks, Number(state.current || 0)));
  const splitCount = Array.isArray(state.summary?.splitFiles) ? state.summary.splitFiles.length : 0;
  const generatedTasks = Number(state.summary?.totalGeneratedTasks || totalTasks || 0);
  const progressLabel = totalTasks > 0 ? `${displayProgress}/${totalTasks}` : '0/0';
  const creationReady = getExpectedCreationsTotal(state) > 0
    ? `${Number(state.downloadPlan?.matchedCount || 0)}/${getExpectedCreationsTotal(state)}`
    : '—';
  const allGroups = buildQueueGroups(state);
  const focusedGroups = getFocusedQueueGroups(allGroups, Number(state.nextTaskIndex || 0), 4);
  const nextTasks = queue
    .slice(Math.max(0, Number(state.nextTaskIndex || 0)), Math.max(0, Number(state.nextTaskIndex || 0)) + 4);

  const routeItems = focusedGroups.map((group) => {
    const visibleTasks = group.tasks.slice(0, 10);
    const chips = visibleTasks.map((task) => {
      const chipState = task.queueIndex < completedTasks
        ? 'done'
        : (task.queueIndex === Number(state.current || 0) - 1 ? 'current' : '');
      const partLabel = task.partLabel ? `p${task.partLabel}` : `#${task.queueIndex + 1}`;
      return `
        <span class="part-chip ${chipState}">
          ${getVideoAvatarHtml(task.videoIndex)}
          <span>${escapeHtml(partLabel)}</span>
        </span>
      `;
    }).join('');
    const hiddenCount = Math.max(0, group.tasks.length - visibleTasks.length);
    const tail = hiddenCount > 0 ? `<span class="part-chip">+${hiddenCount}</span>` : '';

    return `
      <div class="audio-route">
        <div class="audio-route-top">
          <div class="audio-route-name" title="${escapeHtml(group.baseName)}">${escapeHtml(group.baseName)}</div>
          <div class="audio-route-meta">${group.tasks.length} ${group.tasks.length === 1 ? 'задача' : 'частей'}</div>
        </div>
        <div class="part-strip scroll-muted">${chips}${tail}</div>
      </div>
    `;
  }).join('');

  const nextItems = nextTasks.map((task, offset) => {
    const parsed = parseQueueAudioName(task.fileName);
    return `
      <div class="queue-lane-item">
        <span class="queue-lane-index">${Number(state.nextTaskIndex || 0) + offset + 1}</span>
        ${getVideoAvatarHtml(task.videoIndex)}
        <span class="queue-lane-name">${escapeHtml(parsed.isPart ? `${parsed.baseName} · part ${parsed.partLabel}` : parsed.baseName)}</span>
      </div>
    `;
  }).join('');

  target.innerHTML = `
    <div class="monitor-stats">
      <div class="monitor-stat">
        <div class="monitor-stat-value">${escapeHtml(progressLabel)}</div>
        <div class="monitor-stat-label">в очереди</div>
      </div>
      <div class="monitor-stat">
        <div class="monitor-stat-value">${generatedTasks}</div>
        <div class="monitor-stat-label" title="задач после нарезки длинного аудио">задач из аудио</div>
      </div>
      <div class="monitor-stat">
        <div class="monitor-stat-value">${escapeHtml(creationReady)}</div>
        <div class="monitor-stat-label">готово в creations</div>
      </div>
    </div>

    <div class="route-panel">
      <div class="route-head">
        <div class="route-title">карта аудио и аватаров</div>
        <div class="route-note">нарезано: ${splitCount} · ${focusedGroups.length}/${allGroups.length || 0}</div>
      </div>
      <div class="audio-route-list">
        ${routeItems || '<div class="empty-state">карта появится, как только аудио подготовится</div>'}
      </div>
    </div>

    <div class="route-panel">
      <div class="route-head">
        <div class="route-title">следующие задачи</div>
        <div class="route-note">ближайшие 4</div>
      </div>
      <div class="queue-lane">
        ${nextItems || '<div class="empty-state">впереди ничего нет — очередь закончилась или ещё готовится</div>'}
      </div>
    </div>
  `;
}

async function performScan() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    statusText.textContent = 'активная вкладка не найдена';
    return false;
  }

  loadingContainer.classList.add('active');
  scanBtn.disabled = true;
  if (uploadVideosBtn) {
    uploadVideosBtn.disabled = true;
  }
  statusText.textContent = '';

  const response = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { action: 'scanBulkAvatars' }, (scanResponse) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      resolve({ ok: true, data: scanResponse });
    });
  });

  loadingContainer.classList.remove('active');
  scanBtn.disabled = false;
  if (uploadVideosBtn) {
    uploadVideosBtn.disabled = false;
  }

  if (!response.ok || !response.data?.ok || !Array.isArray(response.data.videos)) {
    statusText.textContent = response.data?.error || 'видео не найдены. откройте Avatar или Creation в DreamFace';
    return false;
  }

  const nextVideos = response.data.videos;
  const nextIndexByIdentity = new Map(nextVideos.map((video, index) => [getVideoIdentity(video.src), index]));
  batches.forEach((batch) => {
    batch.selectedIndices = (batch.selectedIndices || [])
      .map((index) => nextIndexByIdentity.get(getVideoIdentity(foundVideos[index]?.src)))
      .filter((index) => Number.isInteger(index));
    clampBatchVideoPage(batch);
    batch.selectedAvatars = batch.selectedIndices.map((index) => nextVideos[index]).filter(Boolean);
  });
  foundVideos = nextVideos;
  statusText.textContent = `найдено видео: ${foundVideos.length}`;
  postScanContainer.style.display = 'flex';

  if (batches.length === 0) {
    addNewBatch();
  } else {
    refreshAllGrids();
    updateTotalStats();
  }

  return true;
}

function saveSettings() {
  updateAudioModeCopy();
  updateBorderModeCopy();
  const nextSettings = {
    maxDurationSeconds: getSelectedMaxDurationSeconds(),
    autoNormalize: autoNormalizeToggle.checked,
    overlapEnabled: overlapToggle.checked,
    preLoopEnabled: preLoopToggle ? preLoopToggle.checked : false,
    addBorderEnabled: addBorderToggle ? addBorderToggle.checked : false,
  };
  settingsSavePromise = settingsSavePromise.catch(() => {}).then(() => chrome.storage.local.set({
    [SETTINGS_KEY]: nextSettings,
  }));
  return settingsSavePromise;
}

function addNewBatch() {
  const batch = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    selectedIndices: [],
    selectedAvatars: [],
    audioFiles: [],
    sortOrder: 'asc',
    audioExpanded: false,
    videoPage: 0,
  };
  batches.push(batch);
  rerenderBatches();
  updateTotalStats();
}

function removeBatch(id) {
  batches = batches.filter((batch) => batch.id !== id);
  rerenderBatches();
  updateTotalStats();
}

function sortAudioBatch(batch) {
  batch.audioFiles.sort((a, b) => {
    if (batch.sortOrder === 'asc') {
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function renderVideoGridForBatch(container, batch) {
  container.innerHTML = '';
  const { start, end } = getBatchVideoPageRange(batch);

  foundVideos.slice(start, end).forEach((vid, localIndex) => {
    const index = start + localIndex;
    const item = document.createElement('button');
    item.className = 'video-item';
    item.type = 'button';
    item.dataset.index = index;
    const image = document.createElement('img');
    image.src = vid.src;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.alt = '';
    item.appendChild(image);

    const queuePos = batch.selectedIndices.indexOf(index);
    const isSelected = queuePos !== -1;
    item.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    item.setAttribute(
      'aria-label',
      isSelected
        ? `видео ${index + 1}, выбрано (позиция ${queuePos + 1})`
        : `видео ${index + 1}`,
    );
    if (isSelected) {
      item.classList.add('selected');
      const badge = document.createElement('div');
      badge.className = 'video-number-badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = queuePos + 1;
      item.appendChild(badge);
    }

    item.onclick = () => {
      const existingIndex = batch.selectedIndices.indexOf(index);
      if (existingIndex === -1) {
        batch.selectedIndices.push(index);
      } else {
        batch.selectedIndices.splice(existingIndex, 1);
      }
      batch.selectedAvatars = batch.selectedIndices.map((selectedIndex) => foundVideos[selectedIndex]).filter(Boolean);
      rerenderBatches();
      updateTotalStats();
      // Restore focus after re-render so keyboard users keep their place.
      const restored = document.querySelector(`#batch-${batch.id} .video-item[data-index="${index}"]`);
      if (restored instanceof HTMLElement) {
        restored.focus({ preventScroll: true });
      }
    };

    container.appendChild(item);
  });
}

function refreshAllGrids() {
  rerenderBatches();
}

function renderBatchUI(batch) {
  const div = document.createElement('div');
  div.className = 'batch-card';
  div.id = `batch-${batch.id}`;

  const header = document.createElement('div');
  header.className = 'batch-header';

  const heading = document.createElement('div');
  heading.className = 'batch-heading';

  const titleRow = document.createElement('div');
  titleRow.className = 'batch-title-row';

  const title = document.createElement('h3');
  title.className = 'batch-title';
  title.textContent = `группа #${batches.indexOf(batch) + 1}`;
  titleRow.appendChild(title);

  const avatars = document.createElement('div');
  avatars.className = 'batch-avatars';
  const previewVideos = getBatchSelectedVideoPreviews(batch);
  if (previewVideos.length > 0) {
    previewVideos.forEach(({ video }) => {
      const avatar = document.createElement('div');
      avatar.className = 'batch-avatar';
      const image = document.createElement('img');
      image.src = video.src;
      image.alt = '';
      avatar.appendChild(image);
      avatars.appendChild(avatar);
    });

    const hiddenCount = Math.max(0, batch.selectedIndices.length - previewVideos.length);
    if (hiddenCount > 0) {
      const more = document.createElement('div');
      more.className = 'batch-avatar-empty';
      more.textContent = `+${hiddenCount}`;
      avatars.appendChild(more);
    }
    titleRow.appendChild(avatars);
  }
  heading.appendChild(titleRow);

  const meta = document.createElement('div');
  meta.className = 'batch-meta';
  meta.textContent = `${batch.selectedIndices.length} видео • ${batch.audioFiles.length} аудио`;
  heading.appendChild(meta);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove-batch';
  removeBtn.type = 'button';
  removeBtn.innerHTML = '<span aria-hidden="true">&times;</span>';
  removeBtn.setAttribute('aria-label', `удалить группу ${batches.indexOf(batch) + 1}`);
  removeBtn.title = 'удалить группу';
  removeBtn.onclick = () => removeBatch(batch.id);

  header.appendChild(heading);
  header.appendChild(removeBtn);
  div.appendChild(header);

  const videoSection = document.createElement('div');
  videoSection.className = 'batch-section';

  const videoHead = document.createElement('div');
  videoHead.className = 'batch-section-head';

  const vidLabel = document.createElement('div');
  vidLabel.className = 'batch-section-label';
  vidLabel.textContent = 'Видео для группы';
  videoHead.appendChild(vidLabel);

  if (foundVideos.length > VIDEO_PAGE_SIZE) {
    clampBatchVideoPage(batch);
    const totalPages = getVideoPageCount();
    const pager = document.createElement('div');
    pager.className = 'video-pager';
    const previous = document.createElement('button');
    previous.className = 'mini-btn mini-btn-icon';
    previous.type = 'button';
    previous.textContent = '‹';
    previous.disabled = batch.videoPage === 0;
    previous.onclick = () => { batch.videoPage -= 1; rerenderBatches(); };
    const info = document.createElement('div');
    info.className = 'video-page-info';
    info.textContent = `${batch.videoPage + 1}/${totalPages}`;
    const next = document.createElement('button');
    next.className = 'mini-btn mini-btn-icon';
    next.type = 'button';
    next.textContent = '›';
    next.disabled = batch.videoPage >= totalPages - 1;
    next.onclick = () => { batch.videoPage += 1; rerenderBatches(); };
    pager.append(previous, info, next);
    videoHead.appendChild(pager);
  }

  videoSection.appendChild(videoHead);

  const vidGrid = document.createElement('div');
  vidGrid.className = 'video-grid';
  vidGrid.id = `vid-grid-${batch.id}`;
  if (foundVideos.length === 0) vidGrid.innerHTML = '<div class="empty-state">нажмите «сканировать», чтобы загрузить библиотеку DreamFace</div>';
  else renderVideoGridForBatch(vidGrid, batch);
  videoSection.appendChild(vidGrid);
  div.appendChild(videoSection);

  const audioSection = document.createElement('div');
  audioSection.className = 'batch-section';

  const audioHead = document.createElement('div');
  audioHead.className = 'batch-section-head';

  const audLabel = document.createElement('div');
  audLabel.className = 'batch-section-label';
  audLabel.textContent = 'Аудио';
  audioHead.appendChild(audLabel);

  const sortBtn = document.createElement('button');
  sortBtn.className = 'mini-btn';
  sortBtn.type = 'button';
  sortBtn.textContent = batch.sortOrder === 'asc' ? 'A-Z' : 'Z-A';
  sortBtn.title = 'сортировка аудио';
  sortBtn.onclick = () => {
    batch.sortOrder = batch.sortOrder === 'asc' ? 'desc' : 'asc';
    if (batch.audioFiles.length > 0) {
      sortAudioBatch(batch);
    }
    rerenderBatches();
  };
  audioHead.appendChild(sortBtn);
  audioSection.appendChild(audioHead);

  const audioList = document.createElement('div');
  audioList.className = 'audio-list';

  if (batch.audioFiles.length === 0) {
    audioList.innerHTML = '<div class="empty-state">аудиофайлы пока не добавлены</div>';
  } else {
    const visibleFiles = batch.audioExpanded
      ? batch.audioFiles
      : batch.audioFiles.slice(0, MAX_AUDIO_PREVIEW_ITEMS);

    visibleFiles.forEach((file, actualIndex) => {
      const row = document.createElement('div');
      row.className = 'audio-item';

      const main = document.createElement('div');
      main.className = 'audio-item-main';

      const name = document.createElement('div');
      name.className = 'audio-item-name';
      name.textContent = file.name;
      name.title = file.name;
      main.appendChild(name);

      const actions = document.createElement('div');
      actions.className = 'audio-item-actions';

      const removeAudioBtn = document.createElement('button');
      removeAudioBtn.className = 'audio-remove';
      removeAudioBtn.type = 'button';
      removeAudioBtn.title = 'убрать файл';
      removeAudioBtn.setAttribute('aria-label', `убрать файл ${file.name}`);
      removeAudioBtn.innerHTML = '<span aria-hidden="true">×</span>';
      removeAudioBtn.onclick = () => {
        batch.audioFiles.splice(actualIndex, 1);
        if (batch.audioFiles.length <= MAX_AUDIO_PREVIEW_ITEMS) {
          batch.audioExpanded = false;
        }
        rerenderBatches();
        updateTotalStats();
      };
      actions.appendChild(removeAudioBtn);

      row.appendChild(main);
      row.appendChild(actions);
      audioList.appendChild(row);
    });
  }

  audioSection.appendChild(audioList);

  const hiddenCount = Math.max(0, batch.audioFiles.length - MAX_AUDIO_PREVIEW_ITEMS);
  if (!batch.audioExpanded && hiddenCount > 0) {
    const showMoreBtn = document.createElement('button');
    showMoreBtn.className = 'show-more-btn';
    showMoreBtn.type = 'button';
    showMoreBtn.textContent = `Показать еще ${hiddenCount} файлов`;
    showMoreBtn.onclick = () => {
      batch.audioExpanded = true;
      rerenderBatches();
    };
    audioSection.appendChild(showMoreBtn);
  } else if (batch.audioExpanded && batch.audioFiles.length > MAX_AUDIO_PREVIEW_ITEMS) {
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'show-more-btn';
    collapseBtn.type = 'button';
    collapseBtn.textContent = 'Свернуть список';
    collapseBtn.onclick = () => {
      batch.audioExpanded = false;
      rerenderBatches();
    };
    audioSection.appendChild(collapseBtn);
  }

  const controlsRow = document.createElement('div');
  controlsRow.className = 'controls-row';

  const fileContainer = document.createElement('div');
  fileContainer.className = 'file-input-container';

  const fileBtn = document.createElement('button');
  fileBtn.className = 'file-btn';
  fileBtn.type = 'button';
  fileBtn.textContent = batch.audioFiles.length > 0
    ? 'добавить еще аудио'
    : 'выбрать аудио';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = '.mp3,.wav,.ogg,.aac,.m4a';

  fileInput.onchange = (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) {
      return;
    }

    batch.audioFiles = batch.audioFiles.concat(files);
    batch.audioExpanded = false;
    sortAudioBatch(batch);
    rerenderBatches();
    updateTotalStats();
  };

  fileContainer.appendChild(fileBtn);
  fileContainer.appendChild(fileInput);

  controlsRow.appendChild(fileContainer);
  audioSection.appendChild(controlsRow);
  div.appendChild(audioSection);
  batchesList.appendChild(div);
}

function rerenderBatches() {
  batchesList.innerHTML = '';
  batches.forEach((batch) => renderBatchUI(batch));
}

function updateTotalStats() {
  let totalAudioFiles = 0;
  let readyBatches = 0;

  batches.forEach((batch) => {
    if (batch.selectedIndices.length > 0 && batch.audioFiles.length > 0) {
      readyBatches += 1;
      totalAudioFiles += batch.audioFiles.length;
    }
  });

  if (totalAudioFiles > 0) {
    queuePreview.textContent = `${readyBatches} групп готовы • ${totalAudioFiles} аудио в очереди`;
    startBtn.disabled = false;
  } else {
    queuePreview.textContent = 'добавьте видео и аудио';
    startBtn.disabled = true;
  }

  const titles = document.querySelectorAll('.batch-title');
  titles.forEach((title, index) => {
    title.textContent = `группа #${index + 1}`;
  });
}

function showMonitor() {
  setupView.classList.remove('active');
  monitorView.classList.add('active');
}

function showSetup() {
  monitorView.classList.remove('active');
  setupView.classList.add('active');
}

function hasDownloadPlan(state) {
  return Boolean(state?.downloadPlan?.expectedFileNames?.length);
}

function canUseCreations(state) {
  if (!state || !hasDownloadPlan(state)) {
    return false;
  }

  if (isActiveRunPhase(state.phase)) {
    return false;
  }

  if (state.phase === 'finished') {
    return true;
  }

  if (state.phase === 'failed') {
    const completedAllTasks = Number(state.total || 0) > 0 && Number(state.current || 0) >= Number(state.total || 0);
    return !state.interrupted && completedAllTasks;
  }

  return false;
}

function canResumeRun(state) {
  return Boolean(
    state
    && ['failed', 'finished'].includes(state.phase)
    && state.interrupted
    && state.recoverable
    && Array.isArray(state.queuePlan)
    && state.queuePlan.length > 0
    && Number(state.nextTaskIndex || 0) < state.queuePlan.length,
  );
}

const CREATIONS_URL = 'https://dreamfaceapp.com/creations';

function updateResumeButton(state) {
  if (!canResumeRun(state)) {
    resumeBtn.style.display = 'none';
    resumeBtn.disabled = true;
    resumeBtn.textContent = 'возобновить';
    return;
  }

  resumeBtn.style.display = 'block';
  resumeBtn.disabled = false;
  const remaining = Math.max(0, (state.queuePlan?.length || 0) - Number(state.nextTaskIndex || 0));
  resumeBtn.textContent = remaining > 0 ? `возобновить (${remaining})` : 'возобновить';
}

const ALERT_ICON = {
  pause: '<svg class="alert-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="6" width="3.5" height="12" rx="1"></rect><rect x="13.5" y="6" width="3.5" height="12" rx="1"></rect></svg>',
  error: '<svg class="alert-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4"></path><circle cx="12" cy="16.5" r="0.6" fill="currentColor"></circle><path d="M10.6 4.2 3.2 17.2A1.6 1.6 0 0 0 4.6 19.6h14.8a1.6 1.6 0 0 0 1.4-2.4L13.4 4.2a1.6 1.6 0 0 0-2.8 0Z"></path></svg>',
  warning: '<svg class="alert-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v4"></path><circle cx="12" cy="15.5" r="0.6" fill="currentColor"></circle></svg>',
};

function buildAlertRow({ kind, headline, detail, multi }) {
  const detailHtml = detail
    ? `<div class="alert-detail${multi ? ' multi' : ''}">${detail}</div>`
    : '';
  return `
    <div class="alert-row ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">
      ${ALERT_ICON[kind] || ''}
      <div class="alert-copy">
        <div class="alert-headline">${escapeHtml(headline)}</div>
        ${detailHtml}
      </div>
      <button type="button" class="mini-btn alert-action" data-monitor-details>детали</button>
    </div>
  `;
}

function renderMonitorAlert(state) {
  if (!monitorAlert) return;

  if (!state || state.phase === 'idle') {
    monitorAlert.classList.remove('active');
    monitorAlert.innerHTML = '';
    return;
  }

  const rows = [];
  const summary = state.summary || {};

  // 1. Pause / resumable run — give the resume button its reason inline.
  if (canResumeRun(state)) {
    const remaining = Math.max(0, (state.queuePlan?.length || 0) - Number(state.nextTaskIndex || 0));
    const reason = (state.statusText || '').trim();
    const headline = remaining > 0
      ? `обработка приостановлена · осталось ${remaining}`
      : 'обработка приостановлена';
    const detail = reason && !PLACEHOLDER_REASONS.has(reason)
      ? `${reason} — нажмите «возобновить», когда связь восстановится`
      : 'нажмите «возобновить», когда связь восстановится';
    rows.push(buildAlertRow({ kind: 'pause', headline, detail }));
  }

  // 2. Errors — file failures + queue failures, unified.
  const failedFiles = Array.isArray(summary.failedFiles) ? summary.failedFiles.filter(Boolean) : [];
  const queueFailures = Array.isArray(state.failures) ? state.failures.filter(Boolean) : [];
  const errorCount = failedFiles.length + queueFailures.length;

  if (errorCount > 0) {
    const headline = `ошибок: ${errorCount}`;
    const previewItems = [];
    failedFiles.slice(0, 2).forEach((item) => {
      const name = escapeHtml(item.fileName || 'файл');
      const reason = item.reason ? ` — ${escapeHtml(item.reason)}` : '';
      previewItems.push(`${name}${reason}`);
    });
    if (previewItems.length < 2) {
      queueFailures.slice(0, 2 - previewItems.length).forEach((item) => {
        previewItems.push(escapeHtml(item));
      });
    }
    const detail = previewItems.length > 0
      ? previewItems.join(' · ')
      : 'откройте «детали», чтобы посмотреть список';
    rows.push(buildAlertRow({ kind: 'error', headline, detail, multi: true }));
  }

  // 3. Warnings — only when there's no error row already pulling attention.
  const warnings = Array.isArray(state.warnings) ? state.warnings.filter(Boolean) : [];
  if (warnings.length > 0 && errorCount === 0) {
    const headline = warnings.length === 1
      ? 'предупреждение'
      : `предупреждений: ${warnings.length}`;
    const detail = escapeHtml(warnings[0]);
    rows.push(buildAlertRow({ kind: 'warning', headline, detail }));
  }

  if (rows.length === 0) {
    monitorAlert.classList.remove('active');
    monitorAlert.innerHTML = '';
    return;
  }

  monitorAlert.innerHTML = rows.join('');
  monitorAlert.classList.add('active');
}

function renderSummary(state) {
  if (!state) {
    monitorSummary.innerHTML = '';
    return;
  }

  const parts = [];
  const summary = state.summary || {};

  if (summary.totalInputFiles) {
    parts.push(`<div class="summary-line"><strong>вход:</strong> ${summary.totalInputFiles}</div>`);
  }

  if (state.maxDurationSeconds) {
    parts.push(`<div class="summary-line"><strong>лимит:</strong> ${state.maxDurationSeconds} сек</div>`);
  }

  if (typeof summary.totalGeneratedTasks === 'number') {
    parts.push(`<div class="summary-line"><strong>задач:</strong> ${summary.totalGeneratedTasks}</div>`);
  }

  if ((summary.keptFiles || []).length > 0) {
    parts.push(`<div class="summary-line"><strong>без изменений:</strong> ${summary.keptFiles.length}</div>`);
  }

  if ((summary.paddedFiles || []).length > 0) {
    parts.push(`<div class="summary-line"><strong>добито тишиной:</strong> ${summary.paddedFiles.length}</div>`);
  }

  if ((summary.splitFiles || []).length > 0) {
    const details = summary.splitFiles
      .slice(0, 4)
      .map((item) => `${escapeHtml(item.fileName)} (${item.parts})`)
      .join('<br>');
    parts.push(`<div class="summary-line"><strong>нарезано:</strong> ${summary.splitFiles.length}</div>`);
    parts.push(`<div class="summary-list">${details}</div>`);
  }

  if ((summary.repairedFiles || []).length > 0) {
    const details = summary.repairedFiles
      .slice(0, 6)
      .map((item) => escapeHtml(item))
      .join('<br>');
    parts.push(`<div class="summary-line"><strong>восстановлено:</strong> ${summary.repairedFiles.length}</div>`);
    parts.push(`<div class="summary-list">${details}</div>`);
  }

  if ((summary.failedFiles || []).length > 0) {
    const details = summary.failedFiles
      .slice(0, 6)
      .map((item) => `${escapeHtml(item.fileName)}: ${escapeHtml(item.reason)}`)
      .join('<br>');
    parts.push(`<div class="summary-line summary-error"><strong>ошибки:</strong> ${summary.failedFiles.length}</div>`);
    parts.push(`<div class="summary-list">${details}</div>`);
  }

  if ((state.skipped || []).length > 0) {
    const skipped = state.skipped
      .slice(0, 6)
      .map((item) => escapeHtml(item))
      .join('<br>');
    parts.push(`<div class="summary-line"><strong>пропущено:</strong> ${state.skipped.length}</div>`);
    parts.push(`<div class="summary-list">${skipped}</div>`);
  }

  if ((state.failures || []).length > 0) {
    const failures = state.failures
      .slice(0, 6)
      .map((item) => escapeHtml(item))
      .join('<br>');
    parts.push(`<div class="summary-line summary-error"><strong>ошибки очереди:</strong> ${state.failures.length}</div>`);
    parts.push(`<div class="summary-list">${failures}</div>`);
  }

  if ((state.warnings || []).length > 0) {
    const warnings = state.warnings
      .slice(0, 6)
      .map((item) => escapeHtml(item))
      .join('<br>');
    parts.push(`<div class="summary-line"><strong>предупреждения:</strong> ${state.warnings.length}</div>`);
    parts.push(`<div class="summary-list">${warnings}</div>`);
  }

  if (canResumeRun(state)) {
    const remaining = Math.max(0, (state.queuePlan?.length || 0) - Number(state.nextTaskIndex || 0));
    parts.push(`<div class="summary-line"><strong>можно возобновить:</strong> ${remaining}</div>`);
  }

  if (canUseCreations(state)) {
    const totalExpected = getExpectedCreationsTotal(state);
    const matchedCount = Number(state.downloadPlan?.matchedCount || 0);
    const pendingFiles = Array.isArray(state.downloadPlan?.pendingFiles)
      ? state.downloadPlan.pendingFiles.filter(Boolean)
      : [];
    const pageLabel = latestActiveTabContext.isCreations
      ? 'вы на нужной вкладке'
      : 'откройте вкладку creations';

    parts.push(`<div class="summary-line"><strong>creations:</strong> ${pageLabel}</div>`);

    if (totalExpected > 0) {
      parts.push(`<div class="summary-line"><strong>готово в creations:</strong> ${matchedCount} / ${totalExpected}</div>`);
    }

    if (pendingFiles.length > 0) {
      const details = pendingFiles
        .slice(0, 6)
        .map((item) => escapeHtml(item))
        .join('<br>');
      parts.push(`<div class="summary-line"><strong>ещё не готовы:</strong> ${pendingFiles.length}</div>`);
      parts.push(`<div class="summary-list">${details}</div>`);
    }
  }

  monitorSummary.innerHTML = parts.join('') || '<div class="summary-line">сводка появится, когда очередь начнёт работу</div>';
}

const DM_FAILED_STATUSES = new Set(['failed', 'interrupted', 'missing']);
const DM_ACTIVE_STATUSES = new Set(['queued', 'retry_wait', 'fetching', 'muxing', 'dispatching', 'saving']);
const DM_UNCERTAIN_STATUSES = new Set(['uncertain']);
const WATCH_FAILED_STATUSES = new Set(['failed', 'submission_failed', 'submission_cancelled', 'rejected']);
const WATCH_UNCERTAIN_STATUSES = new Set(['submission_uncertain', 'correlating']);

function getAccountLabel(accountId) {
  const account = savedAccounts.find((item) => String(item.accountId) === String(accountId));
  const raw = account?.thirdId || account?.userId || account?.accountId || accountId || 'аккаунт';
  const value = String(raw);
  if (value.includes('@')) return value.replace(/^(.{2}).*(@.*)$/, '$1***$2');
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function deriveUnitStages(unit, dmByWorkId) {
  const total = Math.max(0, Number(unit.targetCount ?? unit.expectedFileNames?.length ?? 0));
  const workIds = (unit.workIds || []).filter(Boolean).map(String);
  let downloaded = 0;
  let downloading = 0;
  let failed = new Set((unit.failedWorkIds || []).map(String)).size;
  let uncertain = 0;
  let requiresReview = 0;
  let dmReadyCount = 0;

  for (const workId of workIds) {
    if ((unit.failedWorkIds || []).map(String).includes(workId)) continue;
    const entry = dmByWorkId.get(workId);
    if (!entry) continue;
    dmReadyCount += 1;
    if (entry.status === 'done') downloaded += 1;
    else if (DM_FAILED_STATUSES.has(entry.status)) failed += 1;
    else if (DM_UNCERTAIN_STATUSES.has(entry.status)) uncertain += 1;
    else if (DM_ACTIVE_STATUSES.has(entry.status)) downloading += 1;
  }

  if (WATCH_FAILED_STATUSES.has(unit.status)) {
    failed = Math.max(failed, total - downloaded - downloading);
  }

  failed = Math.min(total, failed);
  downloaded = Math.min(total - failed, downloaded);
  downloading = Math.min(total - failed - downloaded, downloading);
  const readyReported = Math.max(0, Number(unit.watcherStats?.ready || 0));
  const ready = Math.min(total - failed - downloaded - downloading, Math.max(0, readyReported - dmReadyCount));
  const unresolved = Math.max(0, total - failed - downloaded - downloading - ready);
  if (WATCH_UNCERTAIN_STATUSES.has(unit.status)) uncertain = unresolved;
  else if (unit.status === 'requires_review') requiresReview = unresolved;
  const processing = Math.max(0, unresolved - uncertain - requiresReview);
  return { total, processing, uncertain, requiresReview, ready, downloading, downloaded, failed };
}

function deriveCurrentRunModel() {
  const runId = latestRunState?.runId;
  const units = runId ? latestWatchUnits.filter((unit) => unit.runId === runId) : [];
  const currentWorkIds = new Set(units.flatMap((unit) => unit.workIds || []).filter(Boolean).map(String));
  const currentDownloads = downloadsState.filter((entry) => (
    (entry.runId && entry.runId === runId) || currentWorkIds.has(String(entry.workId))
  ));
  const dmByWorkId = new Map(currentDownloads.map((entry) => [String(entry.workId), entry]));
  const accounts = new Map();
  const stages = {
    sent: 0,
    processing: 0,
    uncertain: 0,
    requiresReview: 0,
    ready: 0,
    downloading: 0,
    downloaded: 0,
    failed: 0,
  };

  for (const unit of units) {
    const unitStages = deriveUnitStages(unit, dmByWorkId);
    stages.sent += unitStages.total;
    stages.processing += unitStages.processing;
    stages.uncertain += unitStages.uncertain;
    stages.requiresReview += unitStages.requiresReview;
    stages.ready += unitStages.ready;
    stages.downloading += unitStages.downloading;
    stages.downloaded += unitStages.downloaded;
    stages.failed += unitStages.failed;
    const key = String(unit.accountId || 'unknown');
    const row = accounts.get(key) || {
      accountId: key,
      total: 0,
      downloaded: 0,
      failed: 0,
      uncertain: 0,
      requiresReview: 0,
    };
    row.total += unitStages.total;
    row.downloaded += unitStages.downloaded;
    row.failed += unitStages.failed;
    row.uncertain += unitStages.uncertain;
    row.requiresReview += unitStages.requiresReview;
    accounts.set(key, row);
  }

  const expected = Math.max(0, Number(latestRunState?.downloadPlan?.totalExpected || latestRunState?.total || 0));
  if (expected > stages.sent) {
    const unowned = expected - stages.sent;
    stages.sent = expected;
    if (isSubmissionUncertainRun(latestRunState)) stages.uncertain += unowned;
    else if (latestRunState?.phase === 'failed' && !latestRunState?.recoverable) stages.failed += unowned;
    else stages.processing += unowned;
  }
  stages.failed = Math.min(stages.sent, stages.failed);

  return {
    stages,
    accounts: [...accounts.values()],
    currentDownloads,
    remaining: Math.max(0, stages.sent - stages.downloaded - stages.failed),
  };
}

function renderCurrentRunMonitor() {
  if (!latestRunState || latestRunState.phase === 'idle') return;
  const model = deriveCurrentRunModel();
  const labels = [
    ['sent', 'Всего'],
    ['processing', 'В обработке'],
    ['uncertain', 'Уточняется'],
    ['requiresReview', 'Нужна проверка'],
    ['ready', 'Готово'],
    ['downloading', 'Скачивается'],
    ['downloaded', 'Скачано'],
    ['failed', 'Ошибки'],
  ];
  monitorStages.innerHTML = labels.map(([key, label]) => `
    <div class="stage-item${key === 'failed' && model.stages.failed ? ' is-error' : ''}${key === 'requiresReview' && model.stages.requiresReview ? ' is-review' : ''}${key === 'uncertain' && model.stages.uncertain ? ' is-uncertain' : ''}">
      <span class="stage-value">${model.stages[key]}</span>
      <span class="stage-label">${label}</span>
    </div>
  `).join('');

  monitorAccounts.innerHTML = model.accounts.map((row) => {
    const remaining = Math.max(0, row.total - row.downloaded - row.failed);
    const states = [
      row.uncertain ? `уточняется ${row.uncertain}` : '',
      row.requiresReview ? `проверить ${row.requiresReview}` : '',
      row.failed ? `ошибок ${row.failed}` : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="account-progress-row">
        <span class="account-progress-name" title="${escapeHtml(getAccountLabel(row.accountId))}">${escapeHtml(getAccountLabel(row.accountId))}</span>
        <span class="account-progress-counts">${row.downloaded}/${row.total} · осталось ${remaining}</span>
        ${states ? `<span class="account-progress-state${row.failed ? ' has-error' : ''}">${escapeHtml(states)}</span>` : ''}
      </div>
    `;
  }).join('');
  monitorAccounts.hidden = model.accounts.length === 0;

  const failedDownloads = model.currentDownloads.filter((entry) => DM_FAILED_STATUSES.has(entry.status));
  retryDownloadsBtn.hidden = failedDownloads.length === 0;
  retryDownloadsBtn.textContent = failedDownloads.length
    ? `повторить скачивание (${failedDownloads.length})`
    : 'повторить скачивание';

  const notices = [];
  if (model.stages.uncertain > 0 || isSubmissionUncertainRun(latestRunState)) {
    const count = model.stages.uncertain;
    notices.push(`
      <div class="alert-row warning" role="status">
        ${ALERT_ICON.warning}
        <div class="alert-copy">
          <div class="alert-headline">${count ? `отправка уточняется: ${count}` : 'отправка не подтверждена'}</div>
          <div class="alert-detail multi">DreamFace мог принять запрос. Он не будет отправлен повторно автоматически.</div>
        </div>
      </div>
    `);
  }
  if (model.stages.requiresReview > 0) {
    notices.push(`
      <div class="alert-row warning" role="status">
        ${ALERT_ICON.warning}
        <div class="alert-copy">
          <div class="alert-headline">нужна проверка: ${model.stages.requiresReview}</div>
          <div class="alert-detail multi">DreamFace мог принять запрос. Проверьте Creations: повторной отправки не будет.</div>
        </div>
      </div>
    `);
  }
  const errorText = latestRunState.phase === 'failed' && !isSubmissionUncertainRun(latestRunState)
    ? getConciseMessage(latestRunState.statusText, 'Запуск завершился с ошибкой.')
    : '';
  if (errorText) {
    notices.push(`<div class="alert-row error" role="alert"><div class="alert-copy"><div class="alert-headline">${escapeHtml(errorText)}</div></div></div>`);
  }
  monitorError.innerHTML = notices.join('');
  monitorError.classList.toggle('active', notices.length > 0);
  if (isUserStoppedRun(latestRunState)) {
    monitorTitle.textContent = 'Запуск остановлен';
  } else if (model.stages.requiresReview > 0) {
    monitorTitle.textContent = 'Требуется проверка';
  } else if (latestRunState.phase === 'failed') {
    monitorTitle.textContent = 'Ошибка запуска';
  } else {
    monitorTitle.textContent = isActiveRunPhase(latestRunState.phase)
      ? 'Текущий запуск'
      : (model.remaining === 0 ? 'Запуск завершён' : 'Результаты DreamFace');
  }
}

function renderRunState(state) {
  latestRunState = state;
  if (!state || state.phase === 'idle') {
    showSetup();
    updateResumeButton(null);
    return;
  }

  showMonitor();
  const isPreparing = ['preparing', 'normalizing', 'ready'].includes(state.phase);
  const isSubmitting = state.phase === 'running';
  const progressCurrent = isPreparing ? Number(state.normalization?.processedCount || 0) : Number(state.current || 0);
  const progressTotal = isPreparing ? Number(state.normalization?.totalCount || 0) : Number(state.total || 0);
  const progressPercent = progressTotal ? Math.min(100, Math.round((progressCurrent / progressTotal) * 100)) : 0;
  const fileLabel = isPreparing
    ? (state.normalization?.currentFile || 'готовим файлы')
    : (state.currentTaskName || 'ожидаем результаты');

  monitorPreparation.hidden = !(isPreparing || isSubmitting);
  monitorProgressLabel.textContent = isPreparing ? 'Подготовка' : 'Отправка';
  monitorProgressFill.style.width = `${progressPercent}%`;
  monitorProgressText.textContent = `${progressCurrent} / ${progressTotal}`;
  monitorFileName.textContent = fileLabel;
  monitorFileName.title = fileLabel;
  monitorPhase.textContent = getMonitorPhaseLabel(state);
  monitorPhaseDot.dataset.phase = isUserStoppedRun(state) ? 'stopped' : (state.phase || 'idle');
  stopBtn.hidden = !isActiveRunPhase(state.phase);
  stopBtn.disabled = !isActiveRunPhase(state.phase);
  if (stopNote) stopNote.hidden = !isActiveRunPhase(state.phase);
  backBtn.disabled = isActiveRunPhase(state.phase);
  updateResumeButton(state);
  renderCurrentRunMonitor();
}

async function initialize() {
  const settings = await getSettings();
  durationModeToggle.checked = Number(settings.maxDurationSeconds) === EXTENDED_MAX_DURATION_SECONDS;
  autoNormalizeToggle.checked = settings.autoNormalize;
  overlapToggle.checked = settings.overlapEnabled;
  if (preLoopToggle) preLoopToggle.checked = Boolean(settings.preLoopEnabled);
  if (addBorderToggle) addBorderToggle.checked = settings.addBorderEnabled !== false;
  updateAudioModeCopy();
  updateBorderModeCopy();
  updateScanButtonLabel();
  postScanContainer.style.display = 'none';
  await refreshActiveTabContext({ rerender: false });

  await chrome.runtime.sendMessage({ action: 'engine.ensure' }).catch(() => {});
  const response = await chrome.runtime.sendMessage({ action: 'engine.getRunState' }).catch(() => null);
  if (response?.ok && response.state) {
    renderRunState(response.state);
  }
  await Promise.all([loadDownloadsState(), loadAccounts(), refreshWatcherState()]);
  startMonitorRefresh();
}

document.addEventListener('DOMContentLoaded', initialize);
window.addEventListener('focus', () => {
  refreshActiveTabContext().catch(() => {});
  refreshMonitorState().catch(() => {});
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refreshActiveTabContext().catch(() => {});
    refreshMonitorState().catch(() => {});
  }
});

async function refreshWatcherState() {
  if (!latestRunState?.runId) return;
  const response = await chrome.runtime.sendMessage({ action: 'dfGetBulkWatchUnits' }).catch(() => null);
  if (response?.ok && Array.isArray(response.units)) {
    latestWatchUnits = response.units;
    renderCurrentRunMonitor();
  }
}

async function refreshMonitorState() {
  if (!monitorView.classList.contains('active')) return;
  const [runResponse, dmResponse] = await Promise.all([
    chrome.runtime.sendMessage({ action: 'engine.getRunState' }).catch(() => null),
    chrome.runtime.sendMessage({ action: 'dm.getState' }).catch(() => null),
  ]);
  if (runResponse?.ok && runResponse.state) renderRunState(runResponse.state);
  if (dmResponse?.ok && Array.isArray(dmResponse.entries)) downloadsState = dmResponse.entries;
  await refreshWatcherState();
  renderCurrentRunMonitor();
}

function startMonitorRefresh() {
  if (monitorRefreshTimer) clearInterval(monitorRefreshTimer);
  monitorRefreshTimer = setInterval(() => refreshMonitorState().catch(() => {}), 5000);
}

durationModeToggle.addEventListener('change', saveSettings);
autoNormalizeToggle.addEventListener('change', saveSettings);
overlapToggle.addEventListener('change', saveSettings);
if (preLoopToggle) preLoopToggle.addEventListener('change', saveSettings);
if (addBorderToggle) addBorderToggle.addEventListener('change', saveSettings);
addBatchBtn.addEventListener('click', addNewBatch);

captureAccountBtn?.addEventListener('click', async () => {
  captureAccountBtn.disabled = true;
  const captured = await chrome.runtime.sendMessage({ action: 'dfCaptureAccount' }).catch((error) => ({ ok: false, error: error.message }));
  if (!captured?.hasAuth || !captured?.sessionRaw) {
    statusText.textContent = captured?.error || 'войдите в DreamFace на странице Avatar или Creation';
    captureAccountBtn.disabled = false;
    return;
  }
  const saved = await chrome.runtime.sendMessage({ action: 'dfSaveAccount', account: captured }).catch((error) => ({ ok: false, error: error.message }));
  statusText.textContent = saved?.ok ? 'аккаунт сохранён' : (saved?.error || 'не удалось сохранить аккаунт');
  if (saved?.ok) renderAccounts(saved.accounts);
  captureAccountBtn.disabled = false;
});

diagnoseAccountsBtn?.addEventListener('click', async () => {
  diagnoseAccountsBtn.disabled = true;
  statusText.textContent = 'проверяем аккаунты без запуска генерации...';
  const response = await chrome.runtime.sendMessage({ action: 'dfDiagnoseAccounts' }).catch((error) => ({ ok: false, error: error.message }));
  if (!response?.ok) {
    statusText.textContent = response?.error || 'диагностика аккаунтов не удалась';
  } else {
    const healthy = response.diagnostics.filter((item) => item.ok).length;
    const describeAccountQuota = (quota) => {
      const total = Number(quota?.total);
      const remaining = Number(quota?.remaining);
      if (!Number.isFinite(total) || !Number.isFinite(remaining)) return 'квота ?';
      // Premium answers the counter with a 1/1 sentinel: batches are not metered there.
      if (total <= 1) return 'квота без лимита';
      return remaining <= 0 ? `квота исчерпана 0/${total}` : `квота ${remaining}/${total}`;
    };
    const exhausted = response.diagnostics.filter((item) => item.ok
      && Number(item.quota?.total) > 1
      && Number(item.quota?.remaining) <= 0).length;
    const summary = response.diagnostics.map((item) => item.ok
      ? `${item.planName} ${item.maxDurationSeconds}s, активных ${item.runningWorks}, ${describeAccountQuota(item.quota)}`
      : `${item.error || 'invalid'}`).join(' | ');
    statusText.textContent = `аккаунты: ${healthy}/${response.diagnostics.length} доступны. ${summary}${exhausted > 0 ? `. без квоты: ${exhausted} (пропускаются до восстановления)` : ''}`;
  }
  diagnoseAccountsBtn.disabled = false;
});

scanBtn?.addEventListener('click', async () => {
  await performScan();
});

uploadVideosBtn?.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) {
    statusText.textContent = 'активная вкладка не найдена';
    return;
  }

  uploadVideosBtn.disabled = true;
  scanBtn.disabled = true;
  statusText.textContent = 'выберите одно или несколько видео в проводнике...';

  const response = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, {
      action: 'startMultiVideoUploadPicker',
      addBorderEnabled: addBorderToggle ? addBorderToggle.checked : false,
    }, (pageResponse) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      resolve(pageResponse || { ok: true });
    });
  });

  if (!response?.ok) {
    uploadVideosBtn.disabled = false;
    scanBtn.disabled = false;
    statusText.textContent = response?.error || 'не удалось открыть выбор видео на странице';
    return;
  }

  statusText.textContent = 'окно выбора видео открыто. после загрузки список обновится автоматически';
});

startBtn.addEventListener('click', async () => {
  await settingsSavePromise;
  const validBatches = batches
    .filter((batch) => batch.selectedIndices.length > 0 && batch.audioFiles.length > 0)
    .map((batch) => ({
      id: batch.id,
      selectedAvatars: batch.selectedIndices.map((index) => foundVideos[index]).filter(Boolean),
      audioFiles: [...batch.audioFiles],
    }));

  if (validBatches.length === 0) {
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    statusText.textContent = 'активная вкладка не найдена';
    return;
  }

  const settings = await getSettings();
  startBtn.disabled = true;
  statusText.textContent = 'готовим аудио…';
  showMonitor();
  renderRunState({
    phase: 'preparing',
    current: 0,
    total: 0,
    currentTaskName: '',
    statusText: 'подготовка очереди...',
    maxDurationSeconds: settings.maxDurationSeconds,
    normalization: {
      processedCount: 0,
      totalCount: validBatches.reduce((acc, batch) => acc + batch.audioFiles.length, 0),
      generatedTasks: 0,
      currentFile: '',
    },
    summary: {
      totalInputFiles: validBatches.reduce((acc, batch) => acc + batch.audioFiles.length, 0),
      totalGeneratedTasks: 0,
      keptFiles: [],
      paddedFiles: [],
      splitFiles: [],
      repairedFiles: [],
      failedFiles: [],
    },
    skipped: [],
    failures: [],
  });

  let batchesWithRefs;
  try {
    batchesWithRefs = await saveSelectedFilesToDb(validBatches);
  } catch (error) {
    statusText.textContent = `не удалось подготовить файлы: ${error.message}`;
    startBtn.disabled = false;
    showSetup();
    return;
  }

  const response = await chrome.runtime.sendMessage({
    action: 'engine.prepareRun',
    payload: {
      mode: 'bulk',
      tabId: tab.id,
      batches: batchesWithRefs,
      options: settings,
    },
  }).catch((error) => ({ ok: false, error: error.message }));

  if (!response?.ok) {
    statusText.textContent = response?.error || 'не удалось запустить обработку';
    startBtn.disabled = false;
    showSetup();
  }
});

stopBtn.addEventListener('click', async () => {
  monitorPhase.textContent = 'останавливаем очередь…';
  stopBtn.disabled = true;
  await chrome.runtime.sendMessage({ action: 'engine.stopRun' }).catch(() => {});
});

resumeBtn.addEventListener('click', async () => {
  if (!canResumeRun(latestRunState)) {
    return;
  }

  resumeBtn.disabled = true;
  monitorPhase.textContent = 'возобновляем очередь…';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = /dreamfaceapp\.com/i.test(tab?.url || '') ? tab.id : latestRunState?.tabId;

  const response = await chrome.runtime.sendMessage({
    action: 'engine.resumeRun',
    payload: { tabId },
  }).catch((error) => ({
    ok: false,
    error: error.message,
  }));

  if (!response?.ok) {
    monitorPhase.textContent = response?.error || 'не удалось возобновить очередь. попробуйте ещё раз.';
    resumeBtn.disabled = false;
    return;
  }

  const stateResponse = await chrome.runtime.sendMessage({ action: 'engine.getRunState' }).catch(() => null);
  if (stateResponse?.ok && stateResponse.state) {
    renderRunState(stateResponse.state);
  }
});

backBtn.addEventListener('click', () => {
  if (latestRunState && isActiveRunPhase(latestRunState.phase)) {
    return;
  }

  backBtn.disabled = true;
  resetExtensionState('состояние очищено. можно запускать новую очередь.')
    .catch((error) => {
      statusText.textContent = error.message || 'не удалось очистить состояние';
      renderRunState(latestRunState);
    })
    .finally(() => {
      if (!latestRunState || !isActiveRunPhase(latestRunState.phase)) {
        backBtn.disabled = false;
      }
    });
});

retryDownloadsBtn.addEventListener('click', async () => {
  const model = deriveCurrentRunModel();
  const failed = model.currentDownloads.filter((entry) => DM_FAILED_STATUSES.has(entry.status));
  retryDownloadsBtn.disabled = true;
  await Promise.all(failed.map((entry) => chrome.runtime.sendMessage({
    action: 'dm.retry',
    payload: { workId: entry.workId },
  }).catch(() => null)));
  retryDownloadsBtn.disabled = false;
  await refreshMonitorState();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'scanProgress') {
    statusText.textContent = `поиск видео: ${message.count}`;
  }

  if (message.action === 'videoUploadProgress') {
    statusText.textContent = message.text || 'загрузка видео в DreamFace...';
  }

  if (message.action === 'videoUploadCompleted') {
    if (uploadVideosBtn) uploadVideosBtn.disabled = false;
    scanBtn.disabled = false;
    if (message.uploadedCount > 0) {
      const tail = message.failedCount > 0 ? `, ошибок: ${message.failedCount}` : '';
      statusText.textContent = `загружено в DreamFace: ${message.uploadedCount}${tail}`;
      if (setupView.classList.contains('active')) {
        performScan().catch(() => {});
      }
    } else if (message.canceled) {
      statusText.textContent = 'выбор видео отменён';
    } else if (message.failedCount > 0) {
      statusText.textContent = message.error || `не удалось загрузить видео: ${message.failedCount}`;
    }
  }

  if (message.action === 'runStateUpdate' && message.state) {
    renderRunState(message.state);
    refreshWatcherState().catch(() => {});
    if (!isActiveRunPhase(message.state.phase)) {
      startBtn.disabled = false;
      if (message.state.phase === 'finished') {
        statusText.textContent = 'обработка завершена';
      } else if (message.state.phase === 'failed') {
        statusText.textContent = message.state.statusText || 'обработка завершилась с ошибкой';
      }
    }
  }

  if (message.action === 'dm.stateUpdate' && Array.isArray(message.entries)) {
    downloadsState = message.entries;
    renderCurrentRunMonitor();
    refreshWatcherState().catch(() => {});
  }
});

async function loadDownloadsState() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'dm.getState' });
    if (resp?.ok && Array.isArray(resp.entries)) {
      downloadsState = resp.entries;
      renderCurrentRunMonitor();
    }
  } catch (err) {
    console.warn('[popup] dm.getState failed', err);
  }
}
