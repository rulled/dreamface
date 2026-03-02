let isRunning = false;
let newTabDetected = false;
let serverLimitHit = false;
let serverSuccessHit = false;

// Глобальное состояние для синхронизации с Popup
let queueState = {
  total: 0,
  current: 0,
  currentFileName: '',
  skipped: []
};

// Глобальное хранилище для очереди, собираемой по частям
let pendingQueue = [];

// Внедряем скрипт-шпион
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
script.onload = function() { this.remove(); };
(document.head || document.documentElement).appendChild(script);

// Слушатели событий от injected.js
window.addEventListener('DreamFaceLimitHit', () => {
  console.log('%c[Content] Лимит!', 'color: red');
  serverLimitHit = true;
  updateStatus('ОШИБКА СЕРВЕРА: Лимит задач! Ждем...');
});

window.addEventListener('DreamFaceTaskSuccess', () => {
  console.log('%c[Content] Успех подтвержден сервером!', 'color: green');
  serverSuccessHit = true;
});

const SEL = {
  videoItem: 'div[class*="_userItem_"], div[class*="userItem"], div[class*="_AvatarCard_"]', 
  
  tabItem: 'div[class*="_tab_"]',
  
  fileInput: 'input[type="file"][accept*=".mp3"]',
  
  audioReady: 'div[class*="_del_"], div[class*="_play_"]',
  
  durationBox: 'div[class*="_tip_"]',
  
  toastError: 'li[role="status"]', 
};


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function dataUrlToFile(dataUrl, fileName, mimeType) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], fileName, { type: mimeType });
}

// Проверка длительности аудио
function getAudioDuration(file) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.onloadedmetadata = function() {
      URL.revokeObjectURL(objectUrl);
      resolve(audio.duration);
    };
    audio.onerror = function() {
      URL.revokeObjectURL(objectUrl);
      resolve(0);
    };
    audio.src = objectUrl;
  });
}

function getElementByText(selector, text) {
  const elements = document.querySelectorAll(selector);
  for (let el of elements) {
    if (el.textContent.trim() === text) return el;
  }
  return null;
}

function findGenerateButton() {
  const buttons = Array.from(document.querySelectorAll('button'));
  return buttons.find(btn => {
    const text = btn.textContent.trim().toLowerCase();
    return text.includes('генерировать') || text.includes('generate');
  });
}

function getValidVideoElements() {
  const candidates = Array.from(document.querySelectorAll(SEL.videoItem));
  return candidates.filter(el => {
    if (el.parentElement.closest(SEL.videoItem)) return false;
    const img = el.querySelector('img');
    return img && (img.src.includes('material') || img.dataset.src?.includes('material'));
  });
}

function isLimitErrorVisible() {
  const toasts = Array.from(document.querySelectorAll(SEL.toastError));
  
  return toasts.some(t => {
    const desc = t.getAttribute('description') || '';
    if (desc.includes('10 tasks') || desc.includes('Processing your existing')) return true;

    const text = t.textContent || '';
    if (text.includes('10 tasks') || text.includes('Processing your existing')) return true;

    return false;
  });
}

function isDurationErrorVisible() {
  const box = document.querySelector(SEL.durationBox);
  if (!box) return false;
  const spans = box.querySelectorAll('span');
  for (const span of spans) {
    if (span.style.color === 'red' || span.style.color === 'rgb(255, 0, 0)') return true;
    if (span.textContent.includes('18') && span.textContent.includes('.')) {
        const val = parseFloat(span.textContent);
        if (val > 180) return true;
    }
  }
  return false;
}

// Отправка обновлений прогресса в popup
function sendScanProgress(iteration, count, maxIterations) {
  chrome.runtime.sendMessage({
    action: 'scanProgress',
    iteration: iteration,
    count: count,
    maxIterations: maxIterations
  }).catch(() => {
    // Popup может быть закрыт, игнорируем ошибку
  });
}

// Принудительная загрузка обложек видео
function forceLoadThumbnails() {
  const validElements = getValidVideoElements();
  let loadedCount = 0;
  let failedCount = 0;
  
  validElements.forEach((el) => {
    const img = el.querySelector('img');
    if (!img) return;
    
    // Проверяем, есть ли у изображения атрибут data-src (lazy loading)
    const dataSrc = img.getAttribute('data-src');
    if (dataSrc && !img.src.includes('material')) {
      // Форсируем замену data-src на src для загрузки
      img.src = dataSrc;
    }
    
    // Проверяем, загружено ли изображение
    if (img.complete && img.naturalHeight !== 0) {
      loadedCount++;
    } else if (!img.complete) {
      // Изображение еще загружается, добавляем обработчик
      img.onload = () => { loadedCount++; };
      img.onerror = () => { failedCount++; };
    }
  });
  
  return { total: validElements.length, loaded: loadedCount, failed: failedCount };
}

// Умная загрузка обложек с наблюдением за viewport
async function smartLoadThumbnails() {
  const validElements = getValidVideoElements();
  const loadedImages = new Set();
  
  console.log('[Thumbnails] Начало умной загрузки обложек...');
  
  // Создаем IntersectionObserver для отслеживания элементов в viewport
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target.querySelector('img');
        if (img && !loadedImages.has(img)) {
          loadedImages.add(img);
          
          // Форсируем загрузку
          const dataSrc = img.getAttribute('data-src');
          if (dataSrc && !img.src.includes('material')) {
            img.src = dataSrc;
          }
        }
      }
    });
  }, {
    rootMargin: '200px' // Загружаем изображения на 200px до viewport
  });
  
  // Добавляем все элементы в наблюдатель
  validElements.forEach(el => observer.observe(el));
  
  // Ждем немного, чтобы Observer сработал
  await sleep(300);
  
  // Останавливаем наблюдение
  observer.disconnect();
  
  const stats = forceLoadThumbnails();
  console.log(`[Thumbnails] Статистика: всего ${stats.total}, загружено ${stats.loaded}, ошибок ${stats.failed}`);
  
  return stats;
}

// Динамическое сканирование видео с автоскроллом и умной загрузкой обложек
async function dynamicScanVideos(sendResponse) {
  const MAX_ITERATIONS = 50; // Максимальное количество итераций скролла
  const SCROLL_DELAY = 800;   // Задержка между скроллами (ms)
  const STABLE_COUNT = 3;     // Сколько раз подряд одинаковый счетчик
  
  let previousCount = 0;
  let stableIterations = 0;
  let iteration = 0;
  
  console.log('[Scan] Начало динамического сканирования...');
  sendScanProgress(0, 0, MAX_ITERATIONS);
  
  while (iteration < MAX_ITERATIONS) {
    const validElements = getValidVideoElements();
    const currentCount = validElements.length;
    
    // Скроллим вниз для загрузки новых элементов
    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: 'smooth'
    });
    
    // Форсируем загрузку обложек ближайших элементов
    await smartLoadThumbnails();
    
    console.log(`[Scan] Итерация ${iteration + 1}/${MAX_ITERATIONS}: найдено ${currentCount} видео`);
    
    // Отправляем прогресс каждые 2 итерации
    if (iteration % 2 === 0) {
      sendScanProgress(iteration + 1, currentCount, MAX_ITERATIONS);
    }
    
    // Проверяем, стабилен ли счетчик
    if (currentCount === previousCount) {
      stableIterations++;
      if (stableIterations >= STABLE_COUNT) {
        console.log('[Scan] Счетчик стабилен (3 итерации подряд), сканирование завершено');
        break;
      }
    } else {
      stableIterations = 0;
      previousCount = currentCount;
    }
    
    // Обновляем список видео в реальном времени (опционально можно отправлять промежуточные результаты)
    if (iteration % 5 === 0) {
      const videos = [];
      validElements.forEach((el, index) => {
        const img = el.querySelector('img');
        if (img) {
          const src = img.getAttribute('src') || img.getAttribute('data-src');
          videos.push({ index, src });
        }
      });
      console.log(`[Scan] Промежуточный результат: ${videos.length} видео`);
    }
    
    iteration++;
    await sleep(SCROLL_DELAY);
  }
  
  // Финальный сбор всех видео с форсированной загрузкой обложек
  const finalStats = forceLoadThumbnails();
  await sleep(500); // Ждем завершения загрузки изображений
  
  const finalElements = getValidVideoElements();
  const videos = [];
  let skippedWithoutCover = 0;
  
  finalElements.forEach((el, index) => {
    const img = el.querySelector('img');
    if (img) {
      const src = img.getAttribute('src') || img.getAttribute('data-src');
      // Проверяем, что обложка действительно загружена или имеет валидный URL
      if (src && (src.includes('material') || img.complete)) {
        videos.push({ index, src });
      } else {
        skippedWithoutCover++;
      }
    }
  });
  
  console.log(`[Scan] Сканирование завершено! Найдено ${videos.length} видео (пропущено без обложек: ${skippedWithoutCover}) за ${iteration} итераций`);
  console.log(`[Scan] Загружено обложек: ${finalStats.loaded}/${finalStats.total}`);
  
  // Возвращаемся в начало страницы
  window.scrollTo({ top: 0, behavior: 'smooth' });
  
  sendResponse({
    videos,
    iterations: iteration,
    totalScanned: videos.length
  });
}


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 1. Запрос состояния при открытии Popup
  if (request.action === 'getSyncState') {
    sendResponse({
      isRunning: isRunning,
      queueState: queueState
    });
    return true;
  }

  if (request.action === 'newTabOpened') {
    newTabDetected = true;
    return;
  }

  if (request.action === 'scanPageVideos') {
    dynamicScanVideos(sendResponse);
    return true;
  }

  // --- НОВЫЕ КОМАНДЫ ДЛЯ ЧАНКОВ ---

  // Очистка буфера перед новой загрузкой
  if (request.action === 'resetQueue') {
    pendingQueue = [];
    sendResponse({ status: 'cleared' });
    return true;
  }

  // Прием части задач
  if (request.action === 'appendQueue') {
    if (request.tasks && Array.isArray(request.tasks)) {
      pendingQueue.push(...request.tasks);
    }
    sendResponse({ status: 'appended', currentLength: pendingQueue.length });
    return true;
  }

  // Запуск обработки того, что накопилось в pendingQueue
  if (request.action === 'startQueueProcessing') {
    if (isRunning) return;

    // Используем накопленную очередь
    const queueToProcess = pendingQueue.length > 0 ? pendingQueue : request.queue;

    if (!queueToProcess || queueToProcess.length === 0) {
        updateStatus('ошибка: очередь пуста');
        return;
    }

    isRunning = true;
    queueState = {
      total: queueToProcess.length,
      current: 0,
      currentFileName: 'Запуск...',
      skipped: []
    };

    processQueue(queueToProcess);
    sendResponse({ status: 'started' });
  }
  // --------------------------------

  if (request.action === 'stopQueue') {
    isRunning = false;
    updateStatus('остановлено пользователем');
    sendResponse({ status: 'stopped' });
  }
});

async function processQueue(queue) {
  updateStatus(`очередь: ${queue.length} видео`);

  for (let i = 0; i < queue.length; i++) {
    if (!isRunning) break;

    const task = queue[i];

    // Обновляем глобальное состояние
    queueState.current = i + 1;
    queueState.currentFileName = task.audio.name;

    const progressStr = `[${i + 1}/${queue.length}]`;
    updateStatus(`${progressStr} ${task.audio.name}`);
    newTabDetected = false;
    serverLimitHit = false;
    serverSuccessHit = false;

    // Отправляем обновление в Popup
    chrome.runtime.sendMessage({ action: 'syncStateUpdate', queueState: queueState }).catch(()=>{});

    try {
      const result = await performTask(task, progressStr);

      if (result === 'skipped_long' || result === 'skipped_short') {
        const reason = result === 'skipped_short' ? '< 2 сек' : '> 180 сек';
        queueState.skipped.push(`${task.audio.name} (${reason})`);
        updateStatus(`${progressStr} ПРОПУСК ${reason}`);
        await sleep(1500);
      } else {
        updateStatus(`${progressStr} ОК, следующая...`);
        await sleep(2000);
      }

    } catch (err) {
      console.error(err);
      if (err.message && err.message.includes('Extension context invalidated')) {
          alert('Расширение обновилось. Пожалуйста, перезагрузите страницу!');
          isRunning = false;
          return;
      }
      updateStatus(`ошибка: ${err.message}`);
      await sleep(3000);
    }
  }

  if (isRunning) {
    // ФОРМИРОВАНИЕ ФИНАЛЬНОГО ОТЧЕТА
    let finalMsg = 'очередь завершена.';
    if (queueState.skipped.length > 0) {
      finalMsg += `\n\nПропущено (${queueState.skipped.length}):\n`;
      finalMsg += queueState.skipped.map(s => `• ${s}`).join('\n');
    }

    updateStatus(finalMsg);
    chrome.runtime.sendMessage({ action: 'queueFinished', skipped: queueState.skipped }).catch(()=>{});
  }
  isRunning = false;
  // Сбрасываем состояние после завершения
  queueState.currentFileName = 'Завершено';
  chrome.runtime.sendMessage({ action: 'syncStateUpdate', queueState: queueState }).catch(()=>{});
}

async function performTask(task, prefix) {
  const file = await dataUrlToFile(task.audio.content, task.audio.name, task.audio.type);

  // --- ПРОВЕРКА ДЛИТЕЛЬНОСТИ ---
  updateStatus(`${prefix} проверка аудио...`);
  const duration = await getAudioDuration(file);
  console.log(`Audio duration: ${duration}s`);

  if (duration < 2) {
    console.warn(`Аудио слишком короткое: ${duration} сек`);
    return 'skipped_short';
  }

  // ИСПРАВЛЕНО: Лимит 180 секунд (3 минуты) вместо 300
  if (duration > 180) {
    console.warn(`Аудио слишком длинное: ${duration} сек`);
    return 'skipped_long';
  }

  const audioTab = getElementByText(SEL.tabItem, 'Аудио');
  if (audioTab && audioTab.getAttribute('data-state') !== 'true') {
    audioTab.click();
    await sleep(500);
  }

  await selectVideoSafe(task.videoIndex);

  const delBtn = document.querySelector('div[class*="_del_"]');
  if (delBtn) {
    delBtn.click();
    await sleep(800);
  }

  const fileInput = document.querySelector(SEL.fileInput);
  if (!fileInput) throw new Error('поле загрузки файла не найдено');

  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  fileInput.dispatchEvent(new Event('input', { bubbles: true }));
  
  updateStatus(`${prefix} загрузка аудио...`);
  
  let retries = 0;
  while (!document.querySelector(SEL.audioReady)) {
    await sleep(500);
    retries++;
    if (retries > 120) throw new Error('таймаут загрузки аудио');
    if (!isRunning) return;
  }
  
  await sleep(1500);

  if (isDurationErrorVisible()) {
    console.warn('обнаружено слишком длинное аудио');
    return 'skipped_long';
  }

  let genBtn = findGenerateButton();
  if (!genBtn) throw new Error('кнопка не найдена');
  
  retries = 0;
  while (genBtn.disabled) {
    await sleep(500);
    retries++;
    genBtn = findGenerateButton();
    if (retries > 60) throw new Error('кнопка генерировать не активна');
    if (!isRunning) return;
  }

  while (true) {
    if (!isRunning) return;

    newTabDetected = false;
    serverLimitHit = false;
    serverSuccessHit = false; // Сброс перед нажатием

    updateStatus(`${prefix} нажата "Генерировать"...`);
    genBtn.click();

    // Ждем реакции
    for (let k = 0; k < 20; k++) {
      await sleep(500);

      // 1. УСПЕХ: Сетевой ответ Success (Самый быстрый и надежный)
      if (serverSuccessHit) {
        console.log('Выход из цикла: получен Success от сервера');
        return 'success';
      }

      // 2. УСПЕХ: Новая вкладка
      if (newTabDetected) {
        return 'success';
      }

      // 3. УСПЕХ: Кнопка заблокирована (если прошло время и нет ошибок)
      if (genBtn.disabled && k > 6 && !serverLimitHit && !isLimitErrorVisible()) {
         // Ждем еще чуть-чуть для верности, вдруг прилетит ответ
         await sleep(1000);
         if (!serverLimitHit) return 'success';
      }

      // 4. ОШИБКА: Лимит
      if (serverLimitHit || isLimitErrorVisible()) {
        console.warn('лимит задач');
        updateStatus(`${prefix} лимит 10 задач, ждем 30 сек...`);

        for(let w=0; w<30; w++) {
          if(!isRunning) return;
          await sleep(1000);
        }

        // После ожидания нужно снова нажать, поэтому break внутреннего цикла
        serverLimitHit = false;
        k = 999; // прерываем цикл ожидания реакции
        genBtn = findGenerateButton(); // Обновляем ссылку
        if (!genBtn) throw new Error('кнопка пропала');
      }
    }
    
  }
}

async function selectVideoSafe(index) {
  const items = getValidVideoElements();
  if (!items[index]) throw new Error(`видео #${index} недоступно`);
  
  const wrapper = items[index];
  const img = wrapper.querySelector('img');
  
  const isSelected = () => {
    if (img && img.className.includes('selected')) return true;
    if (wrapper.className.includes('selected')) return true;
    if (img && getComputedStyle(img).borderColor !== 'rgb(0, 0, 0)' && getComputedStyle(img).borderWidth !== '0px') return true;
    return false;
  };

  if (isSelected()) return;

  if (img) img.click(); else wrapper.click();
  
  let retries = 0;
  while (!isSelected()) {
    await sleep(300);
    retries++;
    if (retries > 10) { if (img) img.click(); retries = 0; break; }
    if (!isRunning) return;
  }
}

let toastEl = null;
function updateStatus(text) {
  chrome.runtime.sendMessage({ action: 'statusUpdate', text: text }).catch(()=>{});
  if (!toastEl) {
    toastEl = document.createElement('div');
    // Добавлен white-space: pre-line для поддержки переноса строк
    toastEl.style.cssText = 'position:fixed; bottom:20px; right:20px; background:rgba(0,0,0,0.85); color:#fff; padding:12px 20px; border-radius:8px; z-index:10000; font-family:sans-serif; font-size:14px; border: 1px solid #444; box-shadow: 0 4px 12px rgba(0,0,0,0.5); white-space: pre-line;';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.display = 'block';
  
  // Если это финальное сообщение "ГОТОВО!", показываем его дольше (15 сек), иначе стандартные 5 сек
  if (text.toLowerCase().startsWith('очередь завершена')) {
    setTimeout(() => { toastEl.style.display = 'none'; }, 15000);
  } else if (text === 'queueFinished') {
    // На всякий случай, если где-то остался старый вызов, скрываем через 5 сек
    setTimeout(() => { toastEl.style.display = 'none'; }, 5000);
  }
}
