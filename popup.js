// Global State
let foundVideos = [];
let batches = [];

// UI Elements
const setupView = document.getElementById('setup-view');
const monitorView = document.getElementById('monitor-view');
const scanBtn = document.getElementById('scanBtn');
const startBtn = document.getElementById('startBtn');
const queuePreview = document.getElementById('queuePreview');
const statusText = document.getElementById('statusText');
const batchesList = document.getElementById('batchesList');
const addBatchBtn = document.getElementById('addBatchBtn');
const loadingContainer = document.getElementById('loadingContainer');
const postScanContainer = document.getElementById('postScanContainer'); // Новый контейнер

// Monitor UI
const stopBtn = document.getElementById('stopBtn');
const monitorFileName = document.getElementById('monitorFileName');
const monitorProgressFill = document.getElementById('monitorProgressFill');
const monitorProgressText = document.getElementById('monitorProgressText');
const monitorLog = document.getElementById('monitorLog');

// --- INITIALIZATION ---

document.addEventListener('DOMContentLoaded', async () => {
  // Проверка состояния при открытии
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { action: 'getSyncState' }, (response) => {
      if (!chrome.runtime.lastError && response && response.isRunning) {
        showMonitor(response.queueState);
      }
    });
  }

  // Убрали addNewBatch() отсюда. Теперь чисто при старте.
});

// --- BATCH MANAGEMENT ---

function addNewBatch() {
  const batch = {
    id: Date.now(),
    selectedIndices: [],
    audioFiles: [],
    sortOrder: 'asc'
  };
  batches.push(batch);
  renderBatchUI(batch);
  updateTotalStats();
}

function removeBatch(id) {
  batches = batches.filter(b => b.id !== id);
  const el = document.getElementById(`batch-${id}`);
  if (el) el.remove();
  updateTotalStats();
}

function renderBatchUI(batch) {
  const div = document.createElement('div');
  div.className = 'batch-card';
  div.id = `batch-${batch.id}`;

  // Header
  const header = document.createElement('div');
  header.className = 'batch-header';

  const title = document.createElement('div');
  title.className = 'batch-title';
  title.textContent = `группа #${batches.indexOf(batch) + 1}`;

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove-batch';
  removeBtn.innerHTML = '&times;';
  removeBtn.title = 'удалить группу';
  removeBtn.onclick = () => removeBatch(batch.id);

  header.appendChild(title);
  header.appendChild(removeBtn);
  div.appendChild(header);

  // 1. Video Section
  const vidLabel = document.createElement('span');
  vidLabel.className = 'label';
  vidLabel.textContent = '1. видео';
  div.appendChild(vidLabel);

  const vidGrid = document.createElement('div');
  vidGrid.className = 'video-grid scroll-md3';
  vidGrid.id = `vid-grid-${batch.id}`;

  if (foundVideos.length === 0) {
    vidGrid.innerHTML = '<div class="empty-state">ошибка: видео не найдены</div>';
  } else {
    renderVideoGridForBatch(vidGrid, batch);
  }
  div.appendChild(vidGrid);

  // 2. Audio Section
  const audLabel = document.createElement('span');
  audLabel.className = 'label';
  audLabel.textContent = '2. аудио';
  div.appendChild(audLabel);

  // --- ИЗМЕНЕНИЕ: ГОРИЗОНТАЛЬНЫЙ РЯД (80% / 20%) ---
  const controlsRow = document.createElement('div');
  controlsRow.className = 'controls-row';

  // Контейнер для кнопки выбора и инпута (80%)
  const fileContainer = document.createElement('div');
  fileContainer.className = 'file-input-container';

  const fileBtn = document.createElement('button');
  fileBtn.className = 'file-btn';
  fileBtn.textContent = batch.audioFiles && batch.audioFiles.length > 0
    ? `выбрано: ${batch.audioFiles.length}`
    : 'выбрать (0)';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = '.mp3,.wav,.ogg,.aac,.m4a';

  fileInput.onchange = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    fileBtn.textContent = '...';
    fileBtn.disabled = true;
    batch.audioFiles = [];

    for (const file of files) {
      try {
        const base64 = await readFileAsBase64(file);
        batch.audioFiles.push({ name: file.name, type: file.type, content: base64 });
      } catch (err) {}
    }

    // Сортировка сразу после добавления
    sortAudioBatch(batch);

    fileBtn.textContent = `выбрано: ${files.length}`;
    fileBtn.disabled = false;
    updateTotalStats();
  };

  fileContainer.appendChild(fileBtn);
  fileContainer.appendChild(fileInput);

  // Кнопка сортировки (20%)
  const sortBtn = document.createElement('button');
  sortBtn.className = 'btn-sort';
  sortBtn.textContent = batch.sortOrder === 'asc' ? 'a-z' : 'z-a';
  sortBtn.title = 'сортировка аудио';

  sortBtn.onclick = () => {
    batch.sortOrder = batch.sortOrder === 'asc' ? 'desc' : 'asc';
    sortBtn.textContent = batch.sortOrder === 'asc' ? 'a-z' : 'z-a';

    if (batch.audioFiles && batch.audioFiles.length > 0) {
      sortAudioBatch(batch);
    }
  };

  controlsRow.appendChild(fileContainer);
  controlsRow.appendChild(sortBtn);
  div.appendChild(controlsRow);
  // ----------------------------------------------------

  batchesList.appendChild(div);
}

function renderVideoGridForBatch(container, batch) {
  container.innerHTML = '';

  foundVideos.forEach((vid, index) => {
    const item = document.createElement('div');
    item.className = 'video-item';
    item.dataset.index = index;
    item.innerHTML = `<img src="${vid.src}" loading="eager" decoding="async">`;

    // Check selection
    const queuePos = batch.selectedIndices.indexOf(index);
    if (queuePos !== -1) {
      item.classList.add('selected');
      const badge = document.createElement('div');
      badge.className = 'video-number-badge';
      badge.textContent = queuePos + 1;
      item.appendChild(badge);
    }

    item.onclick = () => {
      const idx = batch.selectedIndices.indexOf(index);
      if (idx === -1) {
        batch.selectedIndices.push(index);
      } else {
        batch.selectedIndices.splice(idx, 1);
      }
      renderVideoGridForBatch(container, batch);
      updateTotalStats();
    };

    container.appendChild(item);
  });
}

function refreshAllGrids() {
  batches.forEach(batch => {
    const container = document.getElementById(`vid-grid-${batch.id}`);
    if (container) renderVideoGridForBatch(container, batch);
  });
}

function updateTotalStats() {
  let totalTasks = 0;
  batches.forEach(b => {
    if (b.selectedIndices.length > 0 && b.audioFiles.length > 0) {
      totalTasks += b.audioFiles.length;
    }
  });

  if (totalTasks > 0) {
    queuePreview.textContent = `всего задач: ${totalTasks}`;
    startBtn.disabled = false;
  } else {
    queuePreview.textContent = 'добавьте видео и аудио';
    startBtn.disabled = true;
  }

  const titles = document.querySelectorAll('.batch-title');
  titles.forEach((t, i) => t.textContent = `группа #${i + 1}`);
}

function sortAudioBatch(batch) {
  batch.audioFiles.sort((a, b) => {
    if (batch.sortOrder === 'asc') {
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    } else {
      return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' });
    }
  });
}


// --- GLOBAL EVENTS ---

addBatchBtn.addEventListener('click', addNewBatch);

scanBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  loadingContainer.classList.add('active');
  scanBtn.disabled = true;
  if (statusText) statusText.textContent = '';

  // Если это повторное сканирование, мы не сбрасываем батчи, но обновляем видео

  chrome.tabs.sendMessage(tab.id, { action: 'scanPageVideos' }, (response) => {
    loadingContainer.classList.remove('active');
    scanBtn.disabled = false;

    if (chrome.runtime.lastError || !response || !response.videos) {
      if (statusText) statusText.textContent = 'видео не найдены. обновите страницу';
      return;
    }

    foundVideos = response.videos;
    if (statusText) statusText.textContent = `найдено: ${foundVideos.length}`;

    // --- ИЗМЕНЕНИЕ: ПОКАЗЫВАЕМ ИНТЕРФЕЙС ПОСЛЕ СКАНА ---
    postScanContainer.style.display = 'block';

    // Если список групп пуст (первый скан), добавляем первую группу
    if (batches.length === 0) {
        addNewBatch();
    } else {
        refreshAllGrids();
    }
  });
});

startBtn.addEventListener('click', async () => {
  const finalQueue = [];
  let globalIdCounter = 1;

  // Формирование очереди (как и было)
  batches.forEach(batch => {
    if (batch.selectedIndices.length === 0 || batch.audioFiles.length === 0) return;

    let videoPointer = 0;
    for (let i = 0; i < batch.audioFiles.length; i++) {
      const vidIndex = batch.selectedIndices[videoPointer];
      finalQueue.push({
        id: globalIdCounter++,
        audio: batch.audioFiles[i],
        videoIndex: vidIndex,
        videoSrc: foundVideos[vidIndex].src
      });
      videoPointer++;
      if (videoPointer >= batch.selectedIndices.length) videoPointer = 0;
    }
  });

  if (finalQueue.length === 0) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Блокируем кнопку, чтобы не нажать дважды
  startBtn.disabled = true;

  try {
    // 1. Очищаем очередь в контент-скрипте
    await chrome.tabs.sendMessage(tab.id, { action: 'resetQueue' });

    // 2. Отправляем задачи частями (по 1 штуке, чтобы точно не превысить лимит)
    // 1 файл ~5-10 МБ Base64, лимит 64 МБ. Отправлять по 1 — безопасно.
    const CHUNK_SIZE = 1;

    for (let i = 0; i < finalQueue.length; i += CHUNK_SIZE) {
      const chunk = finalQueue.slice(i, i + CHUNK_SIZE);

      // Обновляем статус в попапе, чтобы было видно прогресс передачи
      if (statusText) statusText.textContent = `передача данных: ${Math.min(i + CHUNK_SIZE, finalQueue.length)} / ${finalQueue.length}`;

      // Ждем подтверждения приема каждой части
      await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { action: 'appendQueue', tasks: chunk }, (res) => {
           if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
           else resolve(res);
        });
      });
    }

    // 3. Все данные переданы, запускаем монитор и процесс
    showMonitor({ total: finalQueue.length, current: 0, currentFileName: 'Запуск...' });
    chrome.tabs.sendMessage(tab.id, { action: 'startQueueProcessing' });

  } catch (err) {
    console.error(err);
    if (statusText) statusText.textContent = 'ошибка передачи данных. перезагрузите страницу.';
    startBtn.disabled = false;
  }
});


// --- UTILS & MONITOR ---

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showMonitor(state) {
  setupView.classList.remove('active');
  monitorView.classList.add('active');
  if (state) updateMonitorUI(state);
}

function showSetup() {
  monitorView.classList.remove('active');
  setupView.classList.add('active');
}
function updateMonitorUI(state) {
  if (!state) return;
  monitorFileName.textContent = state.currentFileName || 'Обработка...';
  monitorProgressText.textContent = `${state.current} / ${state.total}`;
  const percent = state.total > 0 ? (state.current / state.total) * 100 : 0;
  monitorProgressFill.style.width = `${percent}%`;
}

stopBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: 'stopQueue' });
  monitorLog.textContent = 'остановка...';
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'statusUpdate') {
    if (monitorView.classList.contains('active')) {
      monitorLog.textContent = msg.text;
    } else {
      if (statusText) statusText.textContent = msg.text;
    }
  }
  if (msg.action === 'syncStateUpdate') {
    if (monitorView.classList.contains('active')) updateMonitorUI(msg.queueState);
  }
  if (msg.action === 'queueFinished') {
    alert('все очереди завершены!');
    showSetup();
    if (statusText) statusText.textContent = 'завершено';
  }
});
