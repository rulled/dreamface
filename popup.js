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
  maxDurationSeconds: DEFAULT_MAX_DURATION_SECONDS,
};
const MAX_AUDIO_PREVIEW_ITEMS = 5;
const VIDEO_GRID_COLUMNS = 5;
const VIDEO_GRID_ROWS = 3;
const VIDEO_PAGE_SIZE = VIDEO_GRID_COLUMNS * VIDEO_GRID_ROWS;

let foundVideos = [];
let batches = [];
let latestRunState = null;
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

const stopBtn = document.getElementById('stopBtn');
const backBtn = document.getElementById('backBtn');
const resumeBtn = document.getElementById('resumeBtn');
const creationsBtn = document.getElementById('creationsBtn');
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
const monitorDetails = document.querySelector('.debug-panel');

function isActiveRunPhase(phase) {
  return ['preparing', 'normalizing', 'ready', 'running', 'downloading', 'stopping'].includes(phase);
}

const PHASE_LABEL = {
  idle: 'ожидание',
  preparing: 'готовим очередь',
  normalizing: 'обрабатываем аудио',
  ready: 'очередь готова',
  running: 'генерируем на dreamface',
  downloading: 'скачиваем результаты',
  stopping: 'останавливаем очередь',
  finished: 'все задачи завершены',
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
  finished: 'готово',
  failed: 'остановлено',
};

const PLACEHOLDER_REASONS = new Set([
  'ожидание',
  'ожидание...',
  'подготовка очереди...',
  'запуск нормализации...',
]);

function getMonitorKickerLabel(state) {
  if (state?.phase === 'failed' && state.recoverable && state.interrupted) {
    return 'пауза';
  }
  return KICKER_LABEL[state?.phase] || 'обработка';
}

function getMonitorPhaseLabel(state) {
  if (!state) {
    return PHASE_LABEL.idle;
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
      selectedIndices: [...batch.selectedIndices],
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

function updateScanButtonLabel() {
  if (scanBtnLabel) {
    scanBtnLabel.textContent = foundVideos.length > 0 ? 'пересканировать' : 'сканировать';
  }
}

function getBatchSelectedVideoPreviews(batch, limit = 3) {
  return batch.selectedIndices
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
  if (!/\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(creation|user)([/?#]|$)/i.test(normalized)) {
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
  if (monitorLog) monitorLog.textContent = 'ничего не запущено';
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
  updateCreationsButton(null);
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
  const response = await chrome.runtime.sendMessage({
    action: 'engine.updateDownloadPlan',
    payload: {
      runId: latestRunState.runId,
      downloadPlan: nextState.downloadPlan,
      statusText: nextState.statusText,
    },
  }).catch(() => null);
  if (!response?.ok || !response.state) {
    return latestRunState;
  }
  latestRunState = response.state;
  renderRunState(latestRunState);
  return latestRunState;
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
    chrome.tabs.sendMessage(tab.id, { action: 'scanPageVideos' }, (scanResponse) => {
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

  if (!response.ok || !response.data || !response.data.videos) {
    statusText.textContent = 'видео не найдены. обновите страницу';
    return false;
  }

  foundVideos = response.data.videos;
  batches.forEach((batch) => {
    batch.selectedIndices = batch.selectedIndices.filter((index) => index >= 0 && index < foundVideos.length);
    clampBatchVideoPage(batch);
  });
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

async function saveSettings() {
  updateAudioModeCopy();
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      maxDurationSeconds: getSelectedMaxDurationSeconds(),
      autoNormalize: autoNormalizeToggle.checked,
      overlapEnabled: overlapToggle.checked,
      preLoopEnabled: preLoopToggle ? preLoopToggle.checked : false,
    },
  });
}

function addNewBatch() {
  const batch = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    selectedIndices: [],
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
    item.innerHTML = `<img src="${vid.src}" loading="lazy" decoding="async" alt="">`;

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
      avatar.innerHTML = `<img src="${video.src}" alt="">`;
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

  if (foundVideos.length > 0) {
    clampBatchVideoPage(batch);
    const { start, end } = getBatchVideoPageRange(batch);
    const totalPages = getVideoPageCount();
    if (totalPages > 1) {
      const videoPager = document.createElement('div');
      videoPager.className = 'video-pager';

      const prevBtn = document.createElement('button');
      prevBtn.className = 'mini-btn mini-btn-icon';
      prevBtn.type = 'button';
      prevBtn.innerHTML = '<span aria-hidden="true">‹</span>';
      prevBtn.setAttribute('aria-label', 'предыдущая страница видео');
      prevBtn.title = 'предыдущая страница видео';
      prevBtn.disabled = batch.videoPage === 0;
      prevBtn.onclick = () => {
        if (batch.videoPage === 0) {
          return;
        }
        batch.videoPage -= 1;
        rerenderBatches();
      };
      videoPager.appendChild(prevBtn);

      const pageInfo = document.createElement('div');
      pageInfo.className = 'video-page-info';
      pageInfo.textContent = `${start + 1}-${end} из ${foundVideos.length} · стр. ${batch.videoPage + 1}/${totalPages}`;
      videoPager.appendChild(pageInfo);

      const nextBtn = document.createElement('button');
      nextBtn.className = 'mini-btn mini-btn-icon';
      nextBtn.type = 'button';
      nextBtn.innerHTML = '<span aria-hidden="true">›</span>';
      nextBtn.setAttribute('aria-label', 'следующая страница видео');
      nextBtn.title = 'следующая страница видео';
      nextBtn.disabled = batch.videoPage >= totalPages - 1;
      nextBtn.onclick = () => {
        if (batch.videoPage >= totalPages - 1) {
          return;
        }
        batch.videoPage += 1;
        rerenderBatches();
      };
      videoPager.appendChild(nextBtn);

      videoHead.appendChild(videoPager);
    }
  }

  videoSection.appendChild(videoHead);

  const vidGrid = document.createElement('div');
  vidGrid.className = 'video-grid';
  vidGrid.id = `vid-grid-${batch.id}`;

  if (foundVideos.length === 0) {
    vidGrid.innerHTML = '<div class="empty-state">ошибка: видео не найдены</div>';
  } else {
    renderVideoGridForBatch(vidGrid, batch);
  }
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
  const nextTask = state?.queuePlan?.[Number(state?.nextTaskIndex || 0)];
  const needsReconciliation = nextTask?.submissionStatus === 'submitting'
    || nextTask?.submissionStatus === 'reconciliation_required';

  return Boolean(
    state
    && state.phase === 'failed'
    && state.interrupted
    && state.recoverable
    && Array.isArray(state.queuePlan)
    && state.queuePlan.length > 0
    && Number(state.nextTaskIndex || 0) < state.queuePlan.length
    && !needsReconciliation
  );
}

function updateCreationsButton(state) {
  if (!canUseCreations(state)) {
    creationsBtn.style.display = 'none';
    creationsBtn.disabled = true;
    creationsBtn.textContent = 'проверить результаты';
    creationsBtn.dataset.intent = 'check';
    return;
  }

  creationsBtn.style.display = 'block';

  const status = state.downloadPlan?.lastStatus || 'idle';
  const totalExpected = getExpectedCreationsTotal(state);
  const matchedCount = Number(state.downloadPlan?.matchedCount || 0);

  creationsBtn.disabled = false;

  // 1. Files are downloaded → re-download.
  if (status === 'success') {
    const count = Math.min(totalExpected || matchedCount, Number(state.downloadPlan?.downloadedCount || totalExpected || matchedCount));
    creationsBtn.textContent = count > 0 ? `скачать снова (${count})` : 'скачать снова';
    creationsBtn.dataset.intent = 'redownload';
    return;
  }

  // 2. All ready, not yet downloaded → primary download action.
  if (status === 'ready' && totalExpected > 0) {
    creationsBtn.textContent = `скачать (${totalExpected})`;
    creationsBtn.dataset.intent = 'download';
    return;
  }

  // 3. Anything else (idle / pending / partial / error) → unified "check again".
  if (matchedCount > 0 && totalExpected > 0) {
    creationsBtn.textContent = `проверить снова (${matchedCount} / ${totalExpected})`;
  } else if (status === 'idle') {
    creationsBtn.textContent = 'проверить результаты';
  } else {
    creationsBtn.textContent = 'проверить снова';
  }
  creationsBtn.dataset.intent = 'check';
}

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

function openMonitorDetails() {
  if (!monitorDetails) return;
  monitorDetails.open = true;
  monitorDetails.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

function renderRunState(state) {
  latestRunState = state;

  if (!state || state.phase === 'idle') {
    showSetup();
    if (monitorKicker) monitorKicker.textContent = KICKER_LABEL.idle;
    if (monitorPhase) monitorPhase.textContent = PHASE_LABEL.idle;
    if (monitorPhaseDot) monitorPhaseDot.dataset.phase = 'idle';
    if (monitorFileName) {
      monitorFileName.textContent = '—';
      monitorFileName.removeAttribute('title');
    }
    if (monitorHeadlineNum) monitorHeadlineNum.textContent = '0';
    if (monitorHeadlineOf) monitorHeadlineOf.textContent = 'из 0';
    if (monitorProgressFill) monitorProgressFill.style.width = '0%';
    if (monitorProgressText) monitorProgressText.textContent = '0 / 0';
    if (monitorGroups) {
      monitorGroups.innerHTML = '';
      monitorGroups.hidden = true;
    }
    if (monitorLog) monitorLog.textContent = 'ничего не запущено';
    if (monitorSummary) monitorSummary.innerHTML = '';
    renderMonitorAlert(null);
    renderMonitorVisual(null);
    updateResumeButton(null);
    updateCreationsButton(null);
    return;
  }

  showMonitor();

  const isNormalizing = state.phase === 'preparing' || state.phase === 'normalizing' || state.phase === 'ready';
  const progressCurrent = isNormalizing
    ? (state.normalization?.processedCount || 0)
    : (state.current || 0);
  const progressTotal = isNormalizing
    ? (state.normalization?.totalCount || 0)
    : (state.total || 0);
  const progressPercent = progressTotal > 0 ? Math.min(100, Math.round((progressCurrent / progressTotal) * 100)) : 0;

  if (monitorKicker) monitorKicker.textContent = getMonitorKickerLabel(state);
  if (monitorPhase) monitorPhase.textContent = getMonitorPhaseLabel(state);
  if (monitorPhaseDot) monitorPhaseDot.dataset.phase = state.phase || 'idle';
  const fileLabel = isNormalizing
    ? (state.normalization?.currentFile || 'готовим файлы')
    : (state.currentTaskName || 'ждём следующую задачу');
  if (monitorFileName) {
    monitorFileName.textContent = fileLabel;
    monitorFileName.title = fileLabel;
  }
  if (monitorProgressFill) monitorProgressFill.style.width = `${progressPercent}%`;
  if (monitorProgressText) {
    monitorProgressText.textContent = progressTotal > 0
      ? `${progressCurrent} / ${progressTotal}`
      : '0 / 0';
  }
  if (monitorHeadlineNum) monitorHeadlineNum.textContent = String(progressCurrent || 0);
  if (monitorHeadlineOf) monitorHeadlineOf.textContent = `из ${progressTotal || 0}`;
  if (monitorLog) monitorLog.textContent = getCreationsLogText(state);
  if (stopBtn) stopBtn.disabled = !isActiveRunPhase(state.phase);
  if (backBtn) backBtn.disabled = isActiveRunPhase(state.phase);
  updateResumeButton(state);
  updateCreationsButton(state);

  renderMonitorAlert(state);
  renderMonitorGroups(state);
  renderMonitorVisual(state);
  renderSummary(state);
}

async function initialize() {
  const settings = await getSettings();
  durationModeToggle.checked = Number(settings.maxDurationSeconds) === EXTENDED_MAX_DURATION_SECONDS;
  autoNormalizeToggle.checked = settings.autoNormalize;
  overlapToggle.checked = settings.overlapEnabled;
  if (preLoopToggle) preLoopToggle.checked = Boolean(settings.preLoopEnabled);
  updateAudioModeCopy();
  updateScanButtonLabel();
  await refreshActiveTabContext({ rerender: false });

  await chrome.runtime.sendMessage({ action: 'engine.ensure' }).catch(() => {});
  const response = await chrome.runtime.sendMessage({ action: 'engine.getRunState' }).catch(() => null);
  if (response?.ok && response.state) {
    renderRunState(response.state);
  }
  // Загружаем актуальное состояние скачиваний
  loadDownloadsState().catch(() => {});
  loadDebugLog().catch(() => {});
}

// ============================================================
// Debug log
// ============================================================
let debugLogEntries = [];
async function loadDebugLog() {
  try {
    const r = await chrome.runtime.sendMessage({ action: 'dm.getDebugLog' });
    if (r?.ok && Array.isArray(r.log)) {
      debugLogEntries = r.log;
      renderDebugLog();
    }
  } catch {}
}

function renderDebugLog() {
  const list = document.getElementById('debugLogList');
  const summary = document.getElementById('debugLogSummary');
  if (!list) return;
  if (summary) summary.textContent = String(debugLogEntries.length);
  list.innerHTML = '';
  const tail = debugLogEntries.slice(-120); // последние 120
  for (const e of tail) {
    const row = document.createElement('div');
    row.className = 'debug-log-row is-' + (e.level || 'log');
    const ts = new Date(e.ts || Date.now()).toISOString().slice(11, 23);
    row.innerHTML = `<span class="ts">${ts}</span><span class="src">[${e.src}]</span>${escapeHtml(e.msg || '')}`;
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.addEventListener('DOMContentLoaded', () => {
  const refreshBtn = document.getElementById('debugLogRefreshBtn');
  const clearBtn = document.getElementById('debugLogClearBtn');
  const copyBtn = document.getElementById('debugLogCopyBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadDebugLog());
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'dm.clearDebugLog' });
    await loadDebugLog();
  });
  if (copyBtn) copyBtn.addEventListener('click', () => {
    const text = debugLogEntries.map((e) => {
      const ts = new Date(e.ts || 0).toISOString();
      return `${ts} [${e.src}] [${e.level}] ${e.msg}`;
    }).join('\n');
    navigator.clipboard?.writeText(text).then(() => {
      copyBtn.textContent = 'скопировано';
      setTimeout(() => { copyBtn.textContent = 'скопировать'; }, 1500);
    }).catch(() => {});
  });

  // дополнительная кнопка-фолбек: "скачать .txt" — на случай если
  // буфер обмена не сработал. кнопка ищется по id, если её нет в html
  // (старая версия popup'а) — тихо не делаем ничего.
  const downloadBtn = document.getElementById('debugLogDownloadBtn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      const text = debugLogEntries.map((e) => {
        const ts = new Date(e.ts || 0).toISOString();
        return `${ts} [${e.src}] [${e.level}] ${e.msg}`;
      }).join('\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dreamface-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 500);
    });
  }

  // Пока debug-panel открыта, поллим лог каждые 1.5с — даже если
  // dm.logUpdate broadcast потерялся (например когда SW спал). Это
  // гарантирует что юзер ВИДИТ актуальный лог сразу как открывает панель.
  const debugPanel = document.querySelector('.debug-panel');
  let debugPollTimer = null;
  const startDebugPolling = () => {
    if (debugPollTimer) return;
    debugPollTimer = setInterval(() => {
      if (!debugPanel || !debugPanel.open) {
        clearInterval(debugPollTimer);
        debugPollTimer = null;
        return;
      }
      loadDebugLog().catch(() => {});
    }, 1500);
  };
  if (debugPanel) {
    debugPanel.addEventListener('toggle', () => {
      if (debugPanel.open) {
        loadDebugLog().catch(() => {});
        startDebugPolling();
      } else if (debugPollTimer) {
        clearInterval(debugPollTimer);
        debugPollTimer = null;
      }
    });
    if (debugPanel.open) {
      loadDebugLog().catch(() => {});
      startDebugPolling();
    }
  }
});

document.addEventListener('DOMContentLoaded', initialize);
window.addEventListener('focus', () => {
  refreshActiveTabContext().catch(() => {});
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refreshActiveTabContext().catch(() => {});
  }
});

durationModeToggle.addEventListener('change', saveSettings);
autoNormalizeToggle.addEventListener('change', saveSettings);
overlapToggle.addEventListener('change', saveSettings);
if (preLoopToggle) preLoopToggle.addEventListener('change', saveSettings);
addBatchBtn.addEventListener('click', addNewBatch);

monitorAlert?.addEventListener('click', (event) => {
  const trigger = event.target instanceof Element
    ? event.target.closest('[data-monitor-details]')
    : null;
  if (!trigger) return;
  openMonitorDetails();
});

scanBtn.addEventListener('click', async () => {
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
    chrome.tabs.sendMessage(tab.id, { action: 'startMultiVideoUploadPicker' }, (pageResponse) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }

      resolve(pageResponse || { ok: true });
    });
  });

  uploadVideosBtn.disabled = false;
  scanBtn.disabled = false;

  if (!response?.ok) {
    statusText.textContent = response?.error || 'не удалось открыть выбор видео на странице';
    return;
  }

  statusText.textContent = 'окно выбора видео открыто. после загрузки список обновится автоматически';
});

startBtn.addEventListener('click', async () => {
  const validBatches = batches
    .filter((batch) => batch.selectedIndices.length > 0 && batch.audioFiles.length > 0)
    .map((batch) => ({
      id: batch.id,
      selectedIndices: batch.selectedIndices
        .map((selectionIndex) => foundVideos[selectionIndex]?.index)
        .filter((videoIndex) => Number.isInteger(videoIndex)),
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
  monitorLog.textContent = 'останавливаем очередь…';
  stopBtn.disabled = true;
  await chrome.runtime.sendMessage({ action: 'engine.stopRun' }).catch(() => {});
});

resumeBtn.addEventListener('click', async () => {
  if (!canResumeRun(latestRunState)) {
    return;
  }

  resumeBtn.disabled = true;
  monitorLog.textContent = 'возобновляем очередь…';

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
    monitorLog.textContent = response?.error || 'не удалось возобновить очередь. попробуйте ещё раз.';
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

creationsBtn.addEventListener('click', async () => {
  if (!latestRunState || !hasDownloadPlan(latestRunState) || isActiveRunPhase(latestRunState.phase)) {
    return;
  }

  creationsBtn.disabled = true;
  const tabResponse = await chrome.runtime.sendMessage({ action: 'engine.ensureCreationsTab' }).catch((error) => ({
    ok: false,
    error: error.message,
  }));
  const tabContext = tabResponse?.tab || null;
  if (!tabResponse?.ok || !tabContext?.id || !isCreationsUrl(tabContext.url)) {
    monitorLog.textContent = tabResponse?.error || 'не удалось открыть Creations';
    renderRunState(latestRunState);
    return;
  }

  const expectedFileNames = Array.isArray(latestRunState.downloadPlan?.expectedFileNames)
    ? latestRunState.downloadPlan.expectedFileNames.filter(Boolean)
    : [];
  const expectedWorkIds = Array.isArray(latestRunState.downloadPlan?.expectedWorkIds)
    ? [...latestRunState.downloadPlan.expectedWorkIds]
    : [];

  if (expectedFileNames.length === 0) {
    monitorLog.textContent = 'нет файлов для проверки в creations';
    renderRunState(latestRunState);
    return;
  }

  const totalExpected = getExpectedCreationsTotal(latestRunState);

  try {
    monitorLog.textContent = 'ищем готовые файлы в creations…';
    const checkResult = await sendMessageToTab(tabContext.id, {
      action: 'checkCreationsStatus',
      expectedFileNames,
      expectedWorkIds,
      startedAt: latestRunState.startedAt,
    });

    if (checkResult?.status === 'ready') {
      monitorLog.textContent = 'все файлы готовы. запускаем скачивание…';
      const downloadResult = await sendMessageToTab(tabContext.id, {
        action: 'downloadCreationsIfReady',
        expectedFileNames,
        expectedWorkIds,
        startedAt: latestRunState.startedAt,
      });

      const nextMessage = buildCreationsDownloadMessage(downloadResult);
      const nextStatus = downloadResult?.status === 'partial'
        ? 'pending'
        : (downloadResult?.status || 'error');
      await updateStoredRunState((state) => {
        state.downloadPlan = {
          ...state.downloadPlan,
          lastStatus: nextStatus,
          lastMessage: nextMessage,
          pendingFiles: Array.isArray(downloadResult?.pending) ? [...downloadResult.pending] : [],
          downloadedCount: Number(downloadResult?.downloadedCount || 0),
          matchedCount: Number(checkResult?.matchedCount || totalExpected),
          totalExpected,
          checkedAt: new Date().toISOString(),
          checkedOnUrl: tabContext.url,
        };
        state.statusText = nextMessage;
      });

      return;
    }

    const nextMessage = buildCreationsCheckMessage(checkResult);
    await updateStoredRunState((state) => {
      state.downloadPlan = {
        ...state.downloadPlan,
        lastStatus: checkResult?.status === 'partial' ? 'pending' : (checkResult?.status || 'error'),
        lastMessage: nextMessage,
        pendingFiles: Array.isArray(checkResult?.pending) ? [...checkResult.pending] : [],
        matchedCount: Number(checkResult?.matchedCount || 0),
        totalExpected,
        checkedAt: new Date().toISOString(),
        checkedOnUrl: tabContext.url,
      };
      state.statusText = nextMessage;
    });
  } catch (error) {
    const message = error.message || 'не удалось проверить результаты в Creations';
    await updateStoredRunState((state) => {
      state.downloadPlan = {
        ...state.downloadPlan,
        lastStatus: 'error',
        lastMessage: message,
        checkedAt: new Date().toISOString(),
        checkedOnUrl: tabContext.url,
      };
      state.statusText = message;
    });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'scanProgress') {
    statusText.textContent = `поиск видео: ${message.count}`;
  }

  if (message.action === 'videoUploadProgress') {
    statusText.textContent = message.text || 'загрузка видео в DreamFace...';
  }

  if (message.action === 'videoUploadCompleted') {
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
    renderDownloads();
  }

  if (message.action === 'dm.logUpdate') {
    loadDebugLog().catch(() => {});
  }
});

// ============================================================
// Downloads section (DownloadManager UI)
// ============================================================

let downloadsState = [];
let downloadsHideDone = false;

async function loadDownloadsState() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'dm.getState' });
    if (resp?.ok && Array.isArray(resp.entries)) {
      downloadsState = resp.entries;
      renderDownloads();
    }
  } catch (err) {
    console.warn('[popup] dm.getState failed', err);
  }
}

function describeStatus(status) {
  switch (status) {
    case 'queued': return 'в очереди';
    case 'fetching': return 'загрузка';
    case 'muxing': return 'mux';
    case 'saving': return 'сохранение';
    case 'done': return 'готово';
    case 'failed': return 'ошибка';
    case 'interrupted': return 'прервано';
    case 'missing': return 'не найдено';
    default: return status || '';
  }
}

function renderDownloads() {
  const section = document.getElementById('downloadsSection');
  const listEl = document.getElementById('downloadsList');
  const summaryEl = document.getElementById('downloadsSummary');
  const progressEl = document.getElementById('downloadsProgressFill');
  const retryFailedBtn = document.getElementById('downloadsRetryFailedBtn');
  const clearBtn = document.getElementById('downloadsClearCompletedBtn');
  const hideToggleBtn = document.getElementById('downloadsToggleHideDoneBtn');
  if (!section || !listEl) return;

  if (!Array.isArray(downloadsState) || downloadsState.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const total = downloadsState.length;
  const done = downloadsState.filter((e) => e.status === 'done').length;
  const failed = downloadsState.filter((e) => e.status === 'failed' || e.status === 'interrupted' || e.status === 'missing').length;
  const active = downloadsState.filter((e) => e.status === 'fetching' || e.status === 'muxing' || e.status === 'saving' || e.status === 'queued').length;

  if (summaryEl) {
    let summary = `${done}/${total}`;
    if (failed > 0) summary += ` <span class="dl-failed">✕${failed}</span>`;
    if (active > 0) summary += ` · идёт ${active}`;
    summaryEl.innerHTML = summary;
  }
  if (progressEl) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressEl.style.width = pct + '%';
  }
  if (retryFailedBtn) {
    retryFailedBtn.style.display = failed > 0 ? '' : 'none';
    retryFailedBtn.textContent = `повторить ошибки (${failed})`;
  }
  if (hideToggleBtn) {
    hideToggleBtn.textContent = downloadsHideDone ? 'показать готовые' : 'скрыть готовые';
  }

  // фильтр
  const filtered = downloadsHideDone
    ? downloadsState.filter((e) => e.status !== 'done')
    : downloadsState;

  listEl.innerHTML = '';
  for (const entry of filtered) {
    const row = document.createElement('div');
    row.className = 'download-row';
    if (entry.status === 'done') row.classList.add('is-done');
    if (entry.status === 'failed' || entry.status === 'interrupted' || entry.status === 'missing') {
      row.classList.add('is-failed');
    }

    const dot = document.createElement('span');
    dot.className = 'dl-status-dot is-' + entry.status;
    row.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'dl-row-name';
    const displayName = entry.savedAs || entry.audioFileName || entry.workName || entry.fileName || entry.workId;
    name.textContent = displayName;
    if (entry.error) {
      name.classList.add('has-error');
      name.title = entry.error;
    } else {
      name.title = `workId: ${entry.workId}`;
    }
    row.appendChild(name);

    const status = document.createElement('span');
    status.className = 'dl-row-status';
    status.textContent = describeStatus(entry.status);
    row.appendChild(status);

    const retryBtn = document.createElement('button');
    retryBtn.className = 'dl-row-retry';
    retryBtn.type = 'button';
    retryBtn.textContent = '↻';
    retryBtn.title = 'повторить';
    const canRetry = (entry.status === 'failed' || entry.status === 'interrupted' || entry.status === 'missing');
    retryBtn.hidden = !canRetry;
    retryBtn.addEventListener('click', async () => {
      retryBtn.disabled = true;
      try {
        await chrome.runtime.sendMessage({ action: 'dm.retry', payload: { workId: entry.workId } });
      } catch (err) {
        console.warn('[popup] dm.retry failed', err);
      } finally {
        retryBtn.disabled = false;
      }
    });
    row.appendChild(retryBtn);

    listEl.appendChild(row);
  }

  // wire actions один раз
  if (retryFailedBtn && !retryFailedBtn.dataset.wired) {
    retryFailedBtn.dataset.wired = '1';
    retryFailedBtn.addEventListener('click', async () => {
      retryFailedBtn.disabled = true;
      try {
        await chrome.runtime.sendMessage({ action: 'dm.retry', payload: { workId: null } });
      } catch (err) {
        console.warn('[popup] dm.retry all failed', err);
      } finally {
        retryFailedBtn.disabled = false;
      }
    });
  }
  if (clearBtn && !clearBtn.dataset.wired) {
    clearBtn.dataset.wired = '1';
    clearBtn.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ action: 'dm.clearCompleted' });
        await loadDownloadsState();
      } catch (err) {
        console.warn('[popup] dm.clearCompleted failed', err);
      }
    });
  }
  if (hideToggleBtn && !hideToggleBtn.dataset.wired) {
    hideToggleBtn.dataset.wired = '1';
    hideToggleBtn.addEventListener('click', () => {
      downloadsHideDone = !downloadsHideDone;
      renderDownloads();
    });
  }
}
