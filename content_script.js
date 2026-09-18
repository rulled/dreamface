// Простой helper для отправки логов в общий dm-debug-log (виден в popup).
// Эквивалент console.log, но дополнительно пишет в storage через background.
function dmLog(level, ...args) {
  const fnLevel = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  console[fnLevel]('[cs]', ...args);
  try {
    chrome.runtime.sendMessage({
      action: 'dm.log',
      payload: { src: 'cs', level: fnLevel, args: args.map((a) => {
        if (a instanceof Error) return a.message;
        if (typeof a === 'object' && a !== null) {
          try { return JSON.parse(JSON.stringify(a)); } catch { return String(a); }
        }
        return a;
      }) },
    }).catch(() => {});
  } catch {}
}

let serverLimitHit = false;
let serverSuccessHit = false;
let avatarAddSuccessHit = false;
let activeTaskCancelled = false;
let videoUploadJobActive = false;
let lastSubmitDetail = null;
let lastKnownRunningWorkIds = [];
// имя текущего аудио-файла, который мы заливаем на dreamface прямо сейчас.
// Заполняется executeTaskOnPage перед кликом generate, чтобы обработчик
// DreamFaceTaskSuccess сразу сохранил его в submitMeta (иначе после reload
// страницы или потери map в памяти имя теряется и при скачивании получаем uuid).
let pendingAudioFileName = '';
let pendingBorderCropPx = 0;
// мета submit-ов для chapter markers: animateImageId → { audioMs, sourceVideoUrl, videoMs, ... }
const submitMetaByAnimateId = new Map();
// зеркало по workId (заполняется когда executeTaskOnPage резолвит workId)
const submitMetaByWorkId = new Map();
// последний снэпшот items с recent_creation_list. Содержит { id (workId),
// animate_id, work_name, web_work_status } для актуальных работ на /creation.
// Используется перехватчиком кнопки Download для маппинга карточек на workId.
//
// СИНХРОННОЕ ПЕРСИСТЕНТНОЕ ХРАНЕНИЕ через document.documentElement.dataset.
// Это нужно потому что:
//   1. content_script может быть инжектнут несколько раз в одной странице
//      (SPA-навигация, race conditions при загрузке). Каждый инжект — новый
//      isolated world module scope; module-level vars сбрасываются.
//   2. patched <a>.click срабатывает СИНХРОННО, нам нужен мгновенный доступ
//      к snapshot без await chrome.storage.local.get.
// Решение: храним JSON в dataset (общий для всех инжектов одной страницы).
let lastCreationsApiItems = [];
const DATASET_SNAPSHOT_KEY = 'dfCreationsSnapshot';

// Sync восстановление из dataset
try {
  const raw = document.documentElement.dataset[DATASET_SNAPSHOT_KEY] || '';
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      lastCreationsApiItems = parsed;
      console.log(`[dreamface] sync-restored creations snapshot: ${parsed.length} items`);
    }
  }
} catch {}

function persistCreationsSnapshot() {
  try {
    document.documentElement.dataset[DATASET_SNAPSHOT_KEY] = JSON.stringify(
      lastCreationsApiItems.map((it) => ({
        id: it.id,
        animate_id: it.animate_id,
        work_name: it.work_name,
        web_work_status: it.web_work_status,
      }))
    );
  } catch {}
}
const MIN_DURATION_SECONDS = 2;
const DEFAULT_MAX_DURATION_SECONDS = 180;
const AVATAR_DISPLAY_LIMIT = 200;
const CREATIONS_SNAPSHOT_LIMIT = 500;

// persist submitMeta в chrome.storage.local, чтобы маркеры работали после
// refresh страницы / закрытия вкладки. Ключи в storage:
//   dreamfaceSubmitMetaByAnimate = { animateId: meta, ... }
//   dreamfaceSubmitMetaByWork    = { workId: meta, ... }
const SUBMIT_META_STORAGE_ANIMATE = 'dreamfaceSubmitMetaByAnimate';
const SUBMIT_META_STORAGE_WORK = 'dreamfaceSubmitMetaByWork';
const SUBMIT_META_MAX_ENTRIES = 5000;
const PADDED_VIDEO_MARKERS_KEY = 'dreamfacePaddedVideoMarkers';
const AVATAR_BORDER_PX = 64;
let mediaTransformModulePromise = null;

const processingSettingsHydrationPromise = Promise.resolve();

// Подгружаем существующий стор сразу при старте
const submitMetaHydrationPromise = chrome.storage.local.get([SUBMIT_META_STORAGE_ANIMATE, SUBMIT_META_STORAGE_WORK]).then((res) => {
  const animateStore = res[SUBMIT_META_STORAGE_ANIMATE] || {};
  const workStore = res[SUBMIT_META_STORAGE_WORK] || {};
  let restored = 0;
  for (const [id, meta] of Object.entries(animateStore)) {
    const current = submitMetaByAnimateId.get(id);
    const currentIsPlaceholder = current
      && !current.audioFileName
      && !Number(current.borderCropPx)
      && !Number.isFinite(current.audioMs);
    if (meta && (!current || currentIsPlaceholder || Number(meta.capturedAt || 0) > Number(current.capturedAt || 0))) {
      submitMetaByAnimateId.set(id, meta);
      restored++;
    }
  }
  for (const [id, meta] of Object.entries(workStore)) {
    const current = submitMetaByWorkId.get(id);
    const currentIsPlaceholder = current
      && !current.audioFileName
      && !Number(current.borderCropPx)
      && !Number.isFinite(current.audioMs);
    if (meta && (!current || currentIsPlaceholder || Number(meta.capturedAt || 0) > Number(current.capturedAt || 0))) {
      submitMetaByWorkId.set(id, meta);
    }
  }
  if (restored > 0) {
    console.log(`[dreamface] submit meta restored from storage (${restored} animate, ${submitMetaByWorkId.size} work)`);
  }
}).catch(() => {});

function persistSubmitMeta() {
  const toRecentObject = (map) => Object.fromEntries(
    [...map.entries()]
      .sort(([, a], [, b]) => Number(b?.capturedAt || 0) - Number(a?.capturedAt || 0))
      .slice(0, SUBMIT_META_MAX_ENTRIES),
  );
  const animateStore = toRecentObject(submitMetaByAnimateId);
  const workStore = toRecentObject(submitMetaByWorkId);
  chrome.storage.local.set({
    [SUBMIT_META_STORAGE_ANIMATE]: animateStore,
    [SUBMIT_META_STORAGE_WORK]: workStore,
  }).catch(() => {});
}

// Обогащение submitMetaByWorkId из api items recent_creation_list.
//
// Когда recent_creation_list возвращает работы, мы хотим иметь возможность
// сопоставить их с ранее сохранённой по animate_id мета. Это нужно для случаев:
//   а) пользователь скачивает старую работу через нативную кнопку (наш batch
//      ещё ничего не положил по workId);
//   б) очередь генерации прошла, но storage был очищен — submitMetaByWorkId
//      пустой, при этом submitMetaByAnimateId ещё может содержать meta;
//   в) перехват нативной кнопки Download — там у нас нет batch-конфига.
//
// Дополнительно сохраняем глобальный снимок последних item'ов, чтобы перехват
// мог разрешить workId по элементу карточки.
function enrichSubmitMetaFromApiItems(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  // обновляем глобальный snapshot — мержим по workId, новые перезаписывают старые
  const byId = new Map();
  for (const it of lastCreationsApiItems) {
    if (it?.id) byId.set(String(it.id), it);
  }
  for (const it of items) {
    if (it?.id) {
      const id = String(it.id);
      byId.delete(id);
      byId.set(id, it);
    }
  }
  lastCreationsApiItems = Array.from(byId.values()).slice(-CREATIONS_SNAPSHOT_LIMIT);
  persistCreationsSnapshot();



  let changed = false;
  for (const item of items) {
    if (!item) continue;
    const workId = String(item.id || '').trim();
    if (!workId) continue;
    const animateId = item.animate_id ? String(item.animate_id) : '';
    let meta = submitMetaByWorkId.get(workId) || null;

    if (!meta && animateId) {
      const fromAnimate = submitMetaByAnimateId.get(animateId);
      if (fromAnimate) {
        meta = { ...fromAnimate };
        submitMetaByWorkId.set(workId, meta);
        changed = true;
      }
    }

    if (!meta) {
      // создаём минимальную запись чтобы хотя бы фиксировать work_name → workId связь
      meta = {
        animateImageId: animateId || '',
        audioMs: null,
        videoMs: null,
        sourceVideoUrl: null,
        audioFileName: '',
        borderCropPx: 0,
        workName: item.work_name || '',
        capturedAt: Date.now(),
      };
      submitMetaByWorkId.set(workId, meta);
      changed = true;
    } else if (!meta.workName && item.work_name) {
      meta.workName = item.work_name;
      changed = true;
    }
  }
  if (changed) {
    persistSubmitMeta();
  }
}

// CSS-ограничение: скрываем карточки аватаров после N-й
(function injectAvatarLimitCss() {
  const style = document.createElement('style');
  style.textContent = `
    div[class*="_userItem_"]:nth-child(n + ${AVATAR_DISPLAY_LIMIT + 1}),
    div[class*="userItem"]:nth-child(n + ${AVATAR_DISPLAY_LIMIT + 1}),
    div[class*="_AvatarCard_"]:nth-child(n + ${AVATAR_DISPLAY_LIMIT + 1}) {
      display: none !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
})();

window.addEventListener('DreamFaceLimitHit', () => {
  serverLimitHit = true;
});

// сигналы жизненного цикла submit-fetch. используются в waitForSubmissionOutcomeWithTracker
// чтобы отличить "click потерялся" (fetch не стартовал) от "submit долго".
let lastSubmitFetchStartedAt = 0;
let lastSubmitFetchError = null;
window.addEventListener('DreamFaceSubmitFetchStarted', (event) => {
  const detail = event?.detail || {};
  lastSubmitFetchStartedAt = detail.startedAt || Date.now();
  lastSubmitFetchError = null;
  dmLog(detail.watermarkPatched ? 'log' : 'warn', 'watermark submit patch', {
    patched: Boolean(detail.watermarkPatched),
    reason: detail.watermarkPatchReason || 'unknown',
    workType: detail.workType || '',
    bodyKind: detail.bodyKind || '',
  });
});
window.addEventListener('DreamFaceSubmitFetchFailed', (event) => {
  const detail = event?.detail || {};
  lastSubmitFetchError = detail.status
    ? `submit HTTP ${detail.status}${detail.statusText ? ' ' + detail.statusText : ''}`
    : `submit fetch failed: ${detail.error || 'unknown'}`;
});

window.addEventListener('DreamFaceTaskSuccess', (event) => {
  serverSuccessHit = true;
  const detail = event?.detail || null;
  lastSubmitDetail = detail;

  // регистрируем мету для последующего сопоставления с workId
  if (detail && detail.animateImageId) {
    // если мета уже была — не перезатираем audioFileName случайно
    const existing = submitMetaByAnimateId.get(detail.animateImageId) || {};
    const meta = {
      animateImageId: detail.animateImageId,
      audioMs: Number.isFinite(detail.audioMs) ? detail.audioMs : null,
      sourceVideoUrl: detail.sourceVideoUrl || null,
      traceFaceBox: detail.traceFaceBox || null,
      firstFrameUrl: detail.firstFrameUrl || null,
      audioUrl: detail.audioUrl || null,
      videoMs: existing.videoMs ?? null, // заполним probeSourceVideoDuration ниже
      // имя оригинального файла нужно при скачивании, иначе сайт отдаёт uuid.
      // Берём из текущего request (pendingAudioFileName) или из старой меты,
      // если по этому animateId уже было что-то сохранено.
      audioFileName: pendingAudioFileName || existing.audioFileName || '',
      borderCropPx: Math.max(0, Math.floor(Number(pendingBorderCropPx || existing.borderCropPx) || 0)),
      capturedAt: Date.now(),
    };
    submitMetaByAnimateId.set(detail.animateImageId, meta);
    persistSubmitMeta();
    console.log('[dreamface] submit meta captured', {
      animateImageId: detail.animateImageId,
      audioMs: meta.audioMs,
      sourceVideoUrl: meta.sourceVideoUrl,
      audioFileName: meta.audioFileName,
      borderCropPx: meta.borderCropPx,
    });

    // фоновая проба длительности видео-пресета через <video>.duration
    if (meta.sourceVideoUrl) {
      probeSourceVideoDuration(meta.sourceVideoUrl).then((seconds) => {
        meta.videoMs = Math.round(seconds * 1000);
        persistSubmitMeta();
        console.log('[dreamface] source video duration probed', {
          animateImageId: detail.animateImageId,
          videoMs: meta.videoMs,
        });
      }).catch((err) => {
        console.warn('[dreamface] probe video duration failed', err.message);
      });
    }
  }
});

// --- multi-face модалка: запоминаем выбор пользователя для каждого видео ---
//
// первый раз для конкретного видео — пропускаем, ждём пока юзер сам выберет
// и нажмёт Confirm. Запоминаем индексы выбранных лиц.
//
// повторные показы того же видео — применяем сохранённый выбор + автоклик.
// Юзер может отменить за 1.5 сек: кликнув на любой faceBox или Cancel.
//
// идентификатор видео = src превью-картинки + количество найденных лиц.

const MULTIFACE_STORAGE_KEY = 'dreamfaceMultiFaceMemory';
const MULTIFACE_AUTO_CONFIRM_DELAY_MS = 1500;
let multiFaceMemory = {}; // { fingerprint: { selectedIndices: [], updatedAt } }

chrome.storage.local.get(MULTIFACE_STORAGE_KEY).then((result) => {
  multiFaceMemory = result[MULTIFACE_STORAGE_KEY] || {};
  const keys = Object.keys(multiFaceMemory).length;
  if (keys > 0) {
    console.log(`[dreamface] multi-face memory loaded (${keys} entries)`);
  }
}).catch(() => {});

function persistMultiFaceMemory() {
  chrome.storage.local.set({ [MULTIFACE_STORAGE_KEY]: multiFaceMemory }).catch(() => {});
}

function getMultiFaceFingerprint(modal) {
  const img = modal.querySelector('img[class*="_image_"]');
  const faces = modal.querySelectorAll('button[class*="_faceBox_"]');
  if (!img || !img.src || faces.length === 0) return null;
  return `${img.src}|n=${faces.length}`;
}

function readSelectedFaceIndices(modal) {
  const faces = modal.querySelectorAll('button[class*="_faceBox_"]');
  const indices = [];
  faces.forEach((face, i) => {
    if (face.getAttribute('aria-pressed') === 'true') indices.push(i);
  });
  return indices;
}

function applySelectedFaceIndices(modal, desiredIndices) {
  const faces = modal.querySelectorAll('button[class*="_faceBox_"]');
  const desired = new Set(desiredIndices);
  faces.forEach((face, i) => {
    const isPressed = face.getAttribute('aria-pressed') === 'true';
    const shouldBePressed = desired.has(i);
    if (isPressed !== shouldBePressed) {
      face.click();
    }
  });
}

(function setupMultiFaceMemory() {
  const HANDLED = new WeakSet();

  function handleModal(modal) {
    if (!modal || HANDLED.has(modal)) return;
    if (!modal.querySelector('[class*="_faceBox_"]')) return;
    HANDLED.add(modal);

    // ждём стабилизации (анимация + дефолтный selection)
    setTimeout(() => attachHandlers(modal), 300);
  }

  function attachHandlers(modal) {
    if (!document.body.contains(modal)) return;

    const fingerprint = getMultiFaceFingerprint(modal);
    const confirm = modal.querySelector('button[class*="_confirmButton_"]');
    if (!fingerprint || !confirm) {
      console.warn('[dreamface] multi-face modal: cannot setup', { fingerprint, hasConfirm: !!confirm });
      return;
    }

    const remembered = multiFaceMemory[fingerprint];
    let autoClickTimer = null;
    let userInterrupted = false;

    const cancelAutoClick = (reason) => {
      if (autoClickTimer) {
        clearTimeout(autoClickTimer);
        autoClickTimer = null;
        userInterrupted = true;
        console.log('[dreamface] multi-face auto-confirm cancelled:', reason);
      }
    };

    // листенер на face boxes — отменяет автоклик
    modal.querySelectorAll('button[class*="_faceBox_"]').forEach((face) => {
      face.addEventListener('click', () => cancelAutoClick('faceBox clicked'), { capture: true });
    });

    // листенер на Confirm — запомнить выбор после клика (юзерского или нашего)
    confirm.addEventListener('click', () => {
      const indices = readSelectedFaceIndices(modal);
      if (indices.length === 0) return; // защита от пустого выбора
      multiFaceMemory[fingerprint] = {
        selectedIndices: indices,
        updatedAt: Date.now(),
      };
      persistMultiFaceMemory();
      console.log('[dreamface] multi-face selection saved', { fingerprint, indices });
    }, { capture: true });

    // листенер на close/cancel кнопки — тоже отменяет автоклик
    const closeBtn = modal.querySelector('button[class*="_closeButton_"], button[class*="_mobileBack_"]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => cancelAutoClick('close clicked'), { capture: true });
    }

    // если есть запомнённый выбор — применяем и взводим таймер
    if (remembered && Array.isArray(remembered.selectedIndices)) {
      console.log('[dreamface] multi-face: applying remembered selection', remembered.selectedIndices);
      applySelectedFaceIndices(modal, remembered.selectedIndices);

      autoClickTimer = setTimeout(() => {
        if (userInterrupted || !document.body.contains(modal)) return;
        console.log('[dreamface] multi-face: auto-confirm');
        confirm.click();
      }, MULTIFACE_AUTO_CONFIRM_DELAY_MS);
    } else {
      console.log('[dreamface] multi-face: no memory for this video, waiting for user');
    }
  }

  // первичный скан
  document.querySelectorAll('[class*="_modal_"]').forEach(handleModal);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches('[class*="_modal_"]')) {
          handleModal(node);
        }
        if (node.querySelectorAll) {
          node.querySelectorAll('[class*="_modal_"]').forEach(handleModal);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();

// меряем длительность исходного видео через невидимый <video preload=metadata>.
// CORS не нужен, мы не читаем пиксели — только metadata.
function probeSourceVideoDuration(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.style.display = 'none';
    const cleanup = () => {
      video.removeAttribute('src');
      video.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('probe timeout'));
    }, 15000);
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      const d = video.duration;
      cleanup();
      if (!Number.isFinite(d) || d <= 0) {
        reject(new Error('invalid duration: ' + d));
      } else {
        resolve(d);
      }
    };
    video.onerror = () => {
      clearTimeout(timer);
      const code = video.error?.code;
      cleanup();
      reject(new Error('video error code: ' + code));
    };
    video.src = url;
    document.body.appendChild(video);
  });
}

window.addEventListener('DreamFaceAvatarAdded', () => {
  avatarAddSuccessHit = true;
});

const SEL = {
  videoItem: 'div[class*="_userItem_"], div[class*="userItem"], div[class*="_AvatarCard_"]',
  tabItem: 'div[class*="_tab_"]',
  audioReady: 'div[class*="_del_"], div[class*="_play_"]',
  durationBox: 'div[class*="_tip_"]',
  toastError: 'li[role="status"]',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dataUrlToFile(dataUrl, fileName, mimeType) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], fileName, { type: mimeType });
}

function ensureNotCancelled() {
  if (activeTaskCancelled) {
    const error = new Error('task cancelled');
    error.code = 'task_cancelled';
    throw error;
  }
}

async function waitWithCancellation(ms) {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    ensureNotCancelled();
    await sleep(Math.min(250, deadline - Date.now()));
  }
}

function waitForCondition(check, { timeout = 30000, root = document.body, pollInterval = 250 } = {}) {
  return new Promise((resolve, reject) => {
    let observer = null;
    let intervalId = null;
    let timeoutId = null;
    let settled = false;

    const cleanup = () => {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const tick = () => {
      if (settled) {
        return;
      }

      try {
        ensureNotCancelled();
        const result = check();
        if (result) {
          settled = true;
          cleanup();
          resolve(result);
        }
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    };

    try {
      observer = new MutationObserver(tick);
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    } catch (_) {}

    intervalId = setInterval(tick, pollInterval);
    timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error('timeout'));
    }, timeout);

    tick();
  });
}

function getAudioDuration(file) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.onloadedmetadata = function onLoad() {
      URL.revokeObjectURL(objectUrl);
      resolve(audio.duration || 0);
    };
    audio.onerror = function onError() {
      URL.revokeObjectURL(objectUrl);
      resolve(0);
    };
    audio.src = objectUrl;
  });
}

function getElementByText(selector, text) {
  const elements = document.querySelectorAll(selector);
  for (const el of elements) {
    if (el.textContent.trim() === text) {
      return el;
    }
  }
  return null;
}

function getElementByTextLoose(selector, variants) {
  const wanted = variants.map((variant) => variant.trim().toLowerCase());
  const elements = document.querySelectorAll(selector);

  for (const el of elements) {
    const normalizedText = (el.textContent || '').trim().toLowerCase();
    if (wanted.includes(normalizedText)) {
      return el;
    }
  }

  return null;
}

function getControlText(el) {
  if (!el) {
    return '';
  }

  return [
    el.textContent || '',
    el.getAttribute('aria-label') || '',
    el.getAttribute('title') || '',
    el.getAttribute('value') || '',
  ]
    .join(' ')
    .trim()
    .toLowerCase();
}

function findGenerateButton() {
  const structuralCandidates = [
    '#step3 button',
    'div[id="step3"] button',
    'div[class*="_generate_btn_box_"] button',
    'button[class*="_generate_btn_"]',
  ];

  for (const selector of structuralCandidates) {
    const button = Array.from(document.querySelectorAll(selector)).find((candidate) => isVisibleElement(candidate));
    if (button) {
      return button;
    }
  }

  const buttons = Array.from(document.querySelectorAll('button'));
  return buttons.find((btn) => {
    const text = getControlText(btn);
    return text.includes('генерировать') || text.includes('generate');
  });
}

function getValidVideoElements() {
  const candidates = Array.from(document.querySelectorAll(SEL.videoItem));
  return candidates.filter((el) => {
    if (el.parentElement.closest(SEL.videoItem)) {
      return false;
    }
    const img = el.querySelector('img');
    return img && (img.src.includes('material') || img.dataset.src?.includes('material'));
  });
}

function isVisibleElement(el) {
  if (!el) {
    return false;
  }

  const styles = getComputedStyle(el);
  return styles.display !== 'none'
    && styles.visibility !== 'hidden'
    && styles.opacity !== '0';
}

function looksLikeAudioAccept(acceptValue) {
  const accept = (acceptValue || '').toLowerCase();
  return accept.includes('audio/')
    || accept.includes('.mp3')
    || accept.includes('.wav')
    || accept.includes('.ogg')
    || accept.includes('.aac')
    || accept.includes('.m4a')
    || accept.includes('.flac')
    || accept.includes('.webm')
    || accept.includes('.mp4');
}

function looksLikeVideoAccept(acceptValue) {
  const accept = (acceptValue || '').toLowerCase();
  return accept.includes('video/')
    || accept.includes('.mp4')
    || accept.includes('.mov')
    || accept.includes('.webm')
    || accept.includes('.mkv');
}

function findAudioFileInput() {
  const strictMatch = document.querySelector('input[type="file"][accept*=".mp3"]');
  if (strictMatch) {
    return strictMatch;
  }

  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  const audioInputs = inputs.filter((input) => looksLikeAudioAccept(input.getAttribute('accept')));

  if (audioInputs.length === 1) {
    return audioInputs[0];
  }

  const visibleAudioInputs = audioInputs.filter((input) => isVisibleElement(input) || isVisibleElement(input.parentElement));
  if (visibleAudioInputs.length > 0) {
    return visibleAudioInputs[0];
  }

  return audioInputs[0] || null;
}

function looksLikeImageAccept(acceptValue) {
  const accept = (acceptValue || '').toLowerCase();
  return accept.includes('image/') || accept.includes('.png') || accept.includes('.jpg') || accept.includes('.jpeg');
}

function findVideoUploadInput() {
  const uploadCardInput = document.querySelector('div[class*="_uploadCard_"] input[type="file"]');
  if (uploadCardInput) {
    return uploadCardInput;
  }

  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  return inputs.find((input) => {
    const accept = (input.getAttribute('accept') || '').toLowerCase();
    const isMixedAudioInput = accept.includes('audio/')
      || accept.includes('.mp3')
      || accept.includes('.wav')
      || accept.includes('.ogg')
      || accept.includes('.aac')
      || accept.includes('.flac');
    return !isMixedAudioInput && (looksLikeVideoAccept(accept) || looksLikeImageAccept(accept));
  }) || null;
}

function getVideoThumbnailSource(element) {
  const img = element?.querySelector('img');
  return img?.getAttribute('src') || img?.getAttribute('data-src') || '';
}

function getVideoMarkerKey(source) {
  try {
    const url = new URL(source);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return String(source || '');
  }
}

async function loadPaddedVideoMarkers() {
  const result = await chrome.storage.local.get(PADDED_VIDEO_MARKERS_KEY);
  return result[PADDED_VIDEO_MARKERS_KEY] || {};
}

async function markPaddedVideoSource(source, borderCropPx = AVATAR_BORDER_PX) {
  if (!source) {
    throw new Error('не удалось определить превью загруженного видео');
  }

  const response = await chrome.runtime.sendMessage({
    action: 'engine.markPaddedVideo',
    payload: {
      source: getVideoMarkerKey(source),
      borderCropPx,
    },
  });
  if (!response?.ok) {
    throw new Error(response?.error || 'не удалось сохранить маркер защитной полосы');
  }
}

async function createPaddedVideoFile(file, current, total) {
  sendVideoUploadProgress(`[${current}/${total}] добавление защитной полосы ${file.name}`, current, total, file.name);
  mediaTransformModulePromise ||= import(chrome.runtime.getURL('media-transform.js'));
  const { transformMp4 } = await mediaTransformModulePromise;
  const result = await transformMp4(await file.arrayBuffer(), { padLeftPx: AVATAR_BORDER_PX });
  const baseName = file.name.replace(/\.[^.]+$/, '') || `video-${Date.now()}`;
  return new File([result.bytes], `${baseName}-border-${AVATAR_BORDER_PX}.mp4`, {
    type: 'video/mp4',
    lastModified: file.lastModified || Date.now(),
  });
}

function sendVideoUploadProgress(text, current = 0, total = 0, fileName = '') {
  chrome.runtime.sendMessage({
    action: 'videoUploadProgress',
    text,
    current,
    total,
    fileName,
  }).catch(() => {});
}

function sendVideoUploadCompleted(payload) {
  chrome.runtime.sendMessage({
    action: 'videoUploadCompleted',
    ...payload,
  }).catch(() => {});
}

function getAudioReadyElements() {
  return Array.from(document.querySelectorAll(SEL.audioReady)).filter((el) => isVisibleElement(el) || isVisibleElement(el.parentElement));
}

function getAudioPanelRoot() {
  const candidates = Array.from(document.querySelectorAll('div'))
    .filter((el) => {
      const text = (el.innerText || '').trim();
      return text.includes('Аватар скажет')
        && text.includes('Текст')
        && text.includes('Аудио');
    })
    .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);

  return candidates[0] || document.body;
}

function getAudioPanelSnapshot() {
  const root = getAudioPanelRoot();
  const text = (root.innerText || '').trim();
  const generateButton = findGenerateButton();

  return {
    text,
    readyCount: getAudioReadyElements().length,
    hasSelectedLabel: /выбрано/i.test(text),
    generateEnabled: Boolean(generateButton && !generateButton.disabled),
  };
}

function isExpectedFileVisible(expectedFileName, snapshot = getAudioPanelSnapshot()) {
  if (!expectedFileName) {
    return true;
  }

  return snapshot.text.toLowerCase().includes(String(expectedFileName).trim().toLowerCase());
}

async function waitForAudioReadyCleared(timeout = 10000) {
  const snapshot = getAudioPanelSnapshot();
  if (snapshot.readyCount === 0 && !snapshot.hasSelectedLabel) {
    return true;
  }

  try {
    await waitForCondition(() => (
      (() => {
        const current = getAudioPanelSnapshot();
        return current.readyCount === 0 && !current.hasSelectedLabel ? true : null;
      })()
    ), { timeout });
    return true;
  } catch (_) {
    return false;
  }
}

async function clearExistingAudioSelection() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deleteButton = document.querySelector('div[class*="_del_"]');
    if (!deleteButton) {
      return;
    }

    deleteButton.click();
    const cleared = await waitForAudioReadyCleared(attempt === 0 ? 10000 : 5000);
    if (cleared) {
      return;
    }

    await waitWithCancellation(600);
  }

  throw new Error('не удалось очистить предыдущее аудио');
}

function matchesLimitToastText(value = '') {
  const text = String(value || '').toLowerCase();
  return text.includes('10 tasks')
    || text.includes('processing your existing');
}

function getVisibleLimitToastEntries() {
  return Array.from(document.querySelectorAll(SEL.toastError))
    .filter((node) => isVisibleElement(node))
    .map((node) => {
      const description = (node.getAttribute('description') || '').trim();
      const text = (node.textContent || '').trim();
      return {
        node,
        description,
        text,
        fingerprint: normalizeUiText(`${description} ${text}`),
      };
    })
    .filter((entry) => matchesLimitToastText(entry.description) || matchesLimitToastText(entry.text));
}

function createLimitToastTracker() {
  const baselineEntries = getVisibleLimitToastEntries();
  const baselineNodes = new WeakSet(baselineEntries.map((entry) => entry.node));
  const baselineFingerprints = new Set(
    baselineEntries.map((entry) => entry.fingerprint).filter(Boolean)
  );
  let freshLimitDetected = false;

  const hasFreshLimitToast = () => {
    if (freshLimitDetected) {
      return true;
    }

    const currentEntries = getVisibleLimitToastEntries();
    for (const entry of currentEntries) {
      if (!baselineNodes.has(entry.node)) {
        freshLimitDetected = true;
        return true;
      }

      if (entry.fingerprint && !baselineFingerprints.has(entry.fingerprint)) {
        freshLimitDetected = true;
        return true;
      }
    }

    return false;
  };

  const observer = typeof MutationObserver === 'function' && document.body
    ? new MutationObserver(() => {
      hasFreshLimitToast();
    })
    : null;

  observer?.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  return {
    hasFreshLimitToast,
    disconnect() {
      observer?.disconnect();
    },
  };
}

function getMaxDurationSeconds(request) {
  return Number(request?.maxDurationSeconds) > DEFAULT_MAX_DURATION_SECONDS
    ? Number(request.maxDurationSeconds)
    : DEFAULT_MAX_DURATION_SECONDS;
}

function getSubmissionTimeoutMs(maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS) {
  return maxDurationSeconds > DEFAULT_MAX_DURATION_SECONDS ? 45000 : 20000;
}

function isDurationErrorVisible(maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS) {
  const box = document.querySelector(SEL.durationBox);
  if (!box) {
    return false;
  }

  const spans = box.querySelectorAll('span');
  for (const span of spans) {
    if (span.style.color === 'red' || span.style.color === 'rgb(255, 0, 0)') {
      return true;
    }

    if (span.textContent.includes('.')) {
      const value = parseFloat(span.textContent);
      if (Number.isFinite(value) && value > maxDurationSeconds) {
        return true;
      }
    }
  }

  return false;
}

function getKnownUploadErrorMessage() {
  const candidates = Array.from(document.querySelectorAll('li[role="status"], [role="alert"], div, span'));
  const patterns = [
    'загруженное видео не содержит аудиоданных',
    'uploaded video does not contain audio',
    'does not contain audio',
    'не содержит аудиоданных',
  ];

  for (const node of candidates) {
    const text = (node.textContent || '').trim().toLowerCase();
    if (!text || text.length > 400) {
      continue;
    }

    if (patterns.some((pattern) => text.includes(pattern))) {
      return node.textContent.trim();
    }
  }

  return '';
}

function parseCreationDate(dateText) {
  const raw = (dateText || '').trim();
  if (!raw) {
    return 0;
  }

  const date = new Date(raw.replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

const CREATIONS_TEXT = {
  recent: ['recent 7 days', 'последние 7 дней'],
  select: ['select', 'выбрать'],
  cancel: ['cancel', 'отмена'],
  download: ['download', 'скачать'],
};
const CREATIONS_GENERATING_PATTERNS = [
  /\bgenerating\b/i,
  /генерир/i,
];

function normalizeUiText(value) {
  return (value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isGeneratingUiText(value) {
  const text = normalizeUiText(value);
  if (!text) {
    return false;
  }

  return CREATIONS_GENERATING_PATTERNS.some((pattern) => pattern.test(text));
}

function matchesUiText(value, variants, { allowPrefix = false } = {}) {
  const normalized = normalizeUiText(value);
  if (!normalized) {
    return false;
  }

  return variants.some((variant) => {
    const wanted = normalizeUiText(variant);
    if (!wanted) {
      return false;
    }

    if (normalized === wanted) {
      return true;
    }

    if (!allowPrefix) {
      return false;
    }

    return normalized.startsWith(`${wanted} `)
      || normalized.startsWith(`${wanted}(`)
      || normalized.startsWith(`${wanted}:`);
  });
}

function getNextVisibleSibling(el) {
  let current = el?.nextElementSibling || null;

  while (current) {
    if (isVisibleElement(current)) {
      return current;
    }
    current = current.nextElementSibling;
  }

  return null;
}

function getCreationsHeaderElement() {
  return Array.from(document.querySelectorAll('div, p, span')).find((el) => (
    matchesUiText(el.textContent || '', CREATIONS_TEXT.recent)
  )) || null;
}

function getCreationsListElement() {
  const byClass = document.querySelector('div[class*="_creationList_"]');
  if (byClass) {
    return byClass;
  }

  const header = getCreationsHeaderElement();
  const sibling = getNextVisibleSibling(header);
  if (sibling) {
    return sibling;
  }

  return header?.parentElement?.lastElementChild || null;
}

function getCreationCardNodes() {
  const list = getCreationsListElement();
  if (!list) {
    return [];
  }

  const directChildren = Array.from(list.children);
  if (directChildren.length > 0) {
    return directChildren;
  }

  return Array.from(list.querySelectorAll(':scope > div, :scope > li, :scope > article'));
}

function getCreationsCardsSignature(cards) {
  return cards.map((item) => `${item.name}__${item.dateText}`).join('||');
}

let recentCreationsRequestCounter = 0;

function requestRecentCreationsPage({ page = 1, size = 30 } = {}) {
  return new Promise((resolve, reject) => {
    const requestId = `recent-creations-${Date.now()}-${recentCreationsRequestCounter += 1}`;
    let timeoutId = null;

    const cleanup = () => {
      window.removeEventListener('DreamFaceRecentCreationsResponse', handleResponse);
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const handleResponse = (event) => {
      const detail = event?.detail || {};
      if (detail.requestId !== requestId) {
        return;
      }

      cleanup();
      if (detail.ok) {
        resolve(detail.body || {});
        return;
      }

      reject(new Error(detail.error || 'recent creations request failed'));
    };

    window.addEventListener('DreamFaceRecentCreationsResponse', handleResponse);
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('recent creations request timeout'));
    }, 6000);

    window.dispatchEvent(new CustomEvent('DreamFaceRecentCreationsRequest', {
      detail: {
        requestId,
        page,
        size,
      },
    }));
  });
}

function requestBatchWorkStatus(ids) {
  return new Promise((resolve, reject) => {
    const requestId = `batch-work-status-${Date.now()}-${recentCreationsRequestCounter += 1}`;
    let timeoutId = null;

    const cleanup = () => {
      window.removeEventListener('DreamFaceBatchWorkStatusResponse', handleResponse);
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const handleResponse = (event) => {
      const detail = event?.detail || {};
      if (detail.requestId !== requestId) {
        return;
      }

      cleanup();
      if (detail.ok) {
        resolve(detail.body || {});
        return;
      }

      reject(new Error(detail.error || 'batch work status request failed'));
    };

    window.addEventListener('DreamFaceBatchWorkStatusResponse', handleResponse);
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('batch work status request timeout'));
    }, 6000);

    window.dispatchEvent(new CustomEvent('DreamFaceBatchWorkStatusRequest', {
      detail: {
        requestId,
        ids: Array.isArray(ids) ? ids.filter(Boolean) : [],
      },
    }));
  });
}

function requestBatchDownloadUrls(ids) {
  return new Promise((resolve, reject) => {
    const requestId = `batch-download-url-${Date.now()}-${recentCreationsRequestCounter += 1}`;
    let timeoutId = null;

    const cleanup = () => {
      window.removeEventListener('DreamFaceBatchDownloadUrlResponse', handleResponse);
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
    };

    const handleResponse = (event) => {
      const detail = event?.detail || {};
      if (detail.requestId !== requestId) return;
      cleanup();
      if (detail.ok) resolve(detail.body || {});
      else reject(new Error(detail.error || 'batch download url request failed'));
    };

    window.addEventListener('DreamFaceBatchDownloadUrlResponse', handleResponse);
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('batch download url request timeout'));
    }, 15000);

    window.dispatchEvent(new CustomEvent('DreamFaceBatchDownloadUrlRequest', {
      detail: {
        requestId,
        ids: Array.isArray(ids) ? ids.filter(Boolean) : [],
      },
    }));
  });
}

function requestRunningWorks() {
  return new Promise((resolve, reject) => {
    const requestId = `running-works-${Date.now()}-${recentCreationsRequestCounter += 1}`;
    let timeoutId = null;

    const cleanup = () => {
      window.removeEventListener('DreamFaceRunningWorksResponse', handleResponse);
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const handleResponse = (event) => {
      const detail = event?.detail || {};
      if (detail.requestId !== requestId) {
        return;
      }

      cleanup();
      if (detail.ok) {
        resolve(detail.body || {});
        return;
      }

      reject(new Error(detail.error || 'running works request failed'));
    };

    window.addEventListener('DreamFaceRunningWorksResponse', handleResponse);
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('running works request timeout'));
    }, 6000);

    window.dispatchEvent(new CustomEvent('DreamFaceRunningWorksRequest', {
      detail: { requestId },
    }));
  });
}

// =========================================================================
// BULK RELAY (background/offscreen -> injected.js MAIN world via postMessage)
// =========================================================================
// injected.js слушает window 'message' (marker __dfBulkReq), отвечает __dfBulkRes.
// postMessage структурно клонирует payload -> Blobs (видео/аудио) доходят в MAIN world.
// Channel token снижает риск spoofing/replay, но не является секретом от page scripts.
// Auth = JWT в localStorage (НЕ cookies). Multi-account: swap localStorage-сессии.

const DF_BULK_SESSION_KEY = '49f290d6e8459c53f31f97de37921086';
const DF_BULK_CLIENT_ID_KEY = '19fb90a3b8f09f14a91f48eee48c12af';
const DF_BULK_USER_ID_KEY = '1d5d4096d2b4e7d671adcb4661b5725d';

let bulkRelayCounter = 0;
const DF_BULK_ALLOWED_OPS = new Set([
  'getAuthContext',
  'putUrl',
  'putOssFile',
  'uploadAudio',
  'avatarAdd',
  'listAvatars',
  'listBatchConfig',
  'getBatchConfigDetail',
  'updateBatchConfig',
  'batchCheckText',
  'animateImageBatch',
  'getBatchTimes',
  'getPtVideoInfo',
  'getRunningWorks',
  'getAccountCapabilities',
  'getRecentCreations',
  'getWorkStatuses',
  'getDownloadUrls',
]);
const DF_BULK_CHANNEL_TOKEN = (() => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
})();

function isSameWindowMessage(event) {
  return event.source === window && event.origin === location.origin;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}

function hasOnlyKeys(value, allowedKeys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowedKeys.includes(key));
}

function isValidBulkPayload(op, payload) {
  if (!hasOnlyKeys(payload, [])) {
    switch (op) {
      case 'putUrl':
        return hasExactKeys(payload, ['fileName', 'contentType'])
          && typeof payload.fileName === 'string'
          && typeof payload.contentType === 'string';
      case 'putOssFile':
        return hasOnlyKeys(payload, ['putUrl', 'blob', 'dataUrl', 'contentType'])
          && Object.hasOwn(payload, 'putUrl')
          && Object.hasOwn(payload, 'contentType')
          && (Object.hasOwn(payload, 'blob') || Object.hasOwn(payload, 'dataUrl'))
          && typeof payload.putUrl === 'string'
          && typeof payload.contentType === 'string';
      case 'uploadAudio':
        return hasOnlyKeys(payload, ['blob', 'dataUrl', 'fileName'])
          && Object.hasOwn(payload, 'fileName')
          && (Object.hasOwn(payload, 'blob') || Object.hasOwn(payload, 'dataUrl'))
          && typeof payload.fileName === 'string';
      case 'avatarAdd':
        return hasExactKeys(payload, ['fileUrl']) && typeof payload.fileUrl === 'string';
      case 'listBatchConfig':
        return hasExactKeys(payload, ['configType']) && typeof payload.configType === 'string';
      case 'getBatchConfigDetail':
        return hasExactKeys(payload, ['id']) && ['string', 'number'].includes(typeof payload.id);
      case 'updateBatchConfig':
        return hasExactKeys(payload, ['id', 'name', 'scriptConfigs'])
          && ['string', 'number'].includes(typeof payload.id)
          && typeof payload.name === 'string'
          && Array.isArray(payload.scriptConfigs);
      case 'animateImageBatch':
        return hasOnlyKeys(payload, ['avatarId', 'videoUrl', 'scriptConfigs', 'batchConfigId', 'name', 'templateId'])
          && ['string', 'number'].includes(typeof payload.avatarId)
          && typeof payload.videoUrl === 'string'
          && Array.isArray(payload.scriptConfigs)
          && ['string', 'number'].includes(typeof payload.batchConfigId)
          && (!Object.hasOwn(payload, 'name') || typeof payload.name === 'string')
          && (!Object.hasOwn(payload, 'templateId')
            || typeof payload.templateId === 'string'
            || (typeof payload.templateId === 'number' && Number.isFinite(payload.templateId)));
      case 'getRecentCreations':
        return hasExactKeys(payload, ['page', 'size'])
          && Number.isInteger(payload.page)
          && Number.isInteger(payload.size);
      case 'getWorkStatuses':
      case 'getDownloadUrls':
        return hasExactKeys(payload, ['ids'])
          && Array.isArray(payload.ids)
          && payload.ids.every((id) => typeof id === 'string');
      default:
        return false;
    }
  }
  return [
    'getAuthContext',
    'listAvatars',
    'batchCheckText',
    'getBatchTimes',
    'getPtVideoInfo',
    'getRunningWorks',
    'getAccountCapabilities',
  ].includes(op);
}

const bulkChannelReady = new Promise((resolve, reject) => {
  let timer = null;
  let timeout = null;
  const cleanup = () => {
    window.removeEventListener('message', onMessage);
    if (timer) clearInterval(timer);
    if (timeout) clearTimeout(timeout);
  };
  const onMessage = (event) => {
    if (!isSameWindowMessage(event)) return;
    const data = event.data;
    if (!hasExactKeys(data, ['__dfBulkInitAck', 'channelToken'])
      || data.__dfBulkInitAck !== true
      || data.channelToken !== DF_BULK_CHANNEL_TOKEN) return;
    cleanup();
    resolve();
  };
  const announce = () => {
    window.postMessage({
      __dfBulkInit: true,
      channelToken: DF_BULK_CHANNEL_TOKEN,
    }, location.origin);
  };
  window.addEventListener('message', onMessage);
  announce();
  timer = setInterval(announce, 250);
  timeout = setTimeout(() => {
    cleanup();
    reject(new Error('DreamFace page bridge did not initialize'));
  }, 10000);
});

function getAccountEntitlements(session) {
  const rights = session?.userRights;
  const candidates = [];
  const planValues = [];
  const explicitLimitKeys = new Set([
    'maxdurationseconds',
    'maxvideodurationseconds',
    'maxaudiodurationseconds',
    'avatarvideodurationseconds',
    'videodurationlimit',
    'audiodurationlimit',
  ]);

  const visit = (value, path = '') => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}.${index}`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      const nextPath = `${path}.${key}`.toLowerCase();
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
      if (typeof nested === 'number'
        && explicitLimitKeys.has(normalizedKey)
        && (nested === 180 || nested === 600)) {
        candidates.push(Number(nested));
      }
      if (typeof nested === 'string' && /(plan|tier|subscription|product|membership)/i.test(key)) {
        planValues.push(nested.toLowerCase());
      }
      visit(nested, nextPath);
    }
  };

  visit(rights);
  visit(session);
  if (candidates.length > 0) {
    return {
      planName: 'rights',
      maxDurationSeconds: Math.max(...candidates),
      durationSource: 'userRights',
    };
  }
  const text = planValues.join(' ');
  if (text.includes('premium')) {
    return { planName: 'Premium', maxDurationSeconds: 600, durationSource: 'plan-name' };
  }
  if (/(^|[^a-z])pro([^a-z]|$)/i.test(text)) {
    return { planName: 'Pro', maxDurationSeconds: 180, durationSource: 'plan-name' };
  }
  return { planName: 'Unknown', maxDurationSeconds: 180, durationSource: 'safe-default' };
}

async function requestBulkOp(op, payload, timeoutMs = 120000) {
  if (!DF_BULK_ALLOWED_OPS.has(op)) {
    throw new Error(`unknown bulk op: ${op}`);
  }
  if (!isValidBulkPayload(op, payload)) {
    throw new Error(`invalid payload for bulk op: ${op}`);
  }

  await bulkChannelReady;
  return new Promise((resolve, reject) => {
    bulkRelayCounter += 1;
    const requestId = `df-bulk-${crypto.randomUUID()}-${bulkRelayCounter}`;
    let timer = null;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      if (timer) { clearTimeout(timer); timer = null; }
    };
    const onMessage = (event) => {
      if (!isSameWindowMessage(event)) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || data.__dfBulkRes !== true
        || data.channelToken !== DF_BULK_CHANNEL_TOKEN
        || data.requestId !== requestId
        || typeof data.ok !== 'boolean') return;
      const expectedKeys = data.ok
        ? ['__dfBulkRes', 'channelToken', 'requestId', 'ok', 'data']
        : ['__dfBulkRes', 'channelToken', 'requestId', 'ok', 'error'];
      if (!hasExactKeys(data, expectedKeys) || (!data.ok && typeof data.error !== 'string')) return;
      cleanup();
      if (data.ok) resolve(data.data);
      else reject(new Error(data.error || `bulk op ${op} failed`));
    };
    window.addEventListener('message', onMessage);
    timer = setTimeout(() => { cleanup(); reject(new Error(`bulk op ${op} timeout`)); }, timeoutMs);
    window.postMessage({
      __dfBulkReq: true,
      channelToken: DF_BULK_CHANNEL_TOKEN,
      requestId,
      op,
      payload,
    }, location.origin);
  });
}

function readPageAuthSession() {
  try {
    const sessionRaw = localStorage.getItem(DF_BULK_SESSION_KEY) || '';
    let session = null;
    try { session = sessionRaw ? JSON.parse(sessionRaw) : null; } catch {}
    const clientId = localStorage.getItem(DF_BULK_CLIENT_ID_KEY) || '';
    const userId = localStorage.getItem(DF_BULK_USER_ID_KEY) || (session && session.userId) || '';
    const accountId = (session && session.accountId) || '';
    const token = (session && session.token) || '';
    const thirdPlatform = String(session?.thirdPlatform || '').trim();
    const thirdId = String(session?.thirdId || '').trim();
    const principalKey = thirdPlatform && thirdId
      ? `${thirdPlatform.toLowerCase()}:${thirdId.toLowerCase()}`
      : (userId ? `user:${String(userId).toLowerCase()}` : `account:${accountId}`);
    const hasAuth = Boolean(token && clientId && userId && accountId);
    return {
      ok: hasAuth,
      hasAuth,
      sessionRaw,
      clientId,
      userId,
      accountId,
      token,
      thirdPlatform,
      thirdId,
      principalKey,
      ...getAccountEntitlements(session),
    };
  } catch (error) {
    return { ok: false, hasAuth: false, error: error.message || String(error) };
  }
}

function writePageAuthSession(session) {
  try {
    if (session && session.sessionRaw != null) {
      if (session.sessionRaw) localStorage.setItem(DF_BULK_SESSION_KEY, session.sessionRaw);
      else localStorage.removeItem(DF_BULK_SESSION_KEY);
    }
    if (session && Object.hasOwn(session, 'clientId')) {
      if (session.clientId) localStorage.setItem(DF_BULK_CLIENT_ID_KEY, session.clientId);
      else localStorage.removeItem(DF_BULK_CLIENT_ID_KEY);
    }
    if (session && Object.hasOwn(session, 'userId')) {
      if (session.userId) localStorage.setItem(DF_BULK_USER_ID_KEY, session.userId);
      else localStorage.removeItem(DF_BULK_USER_ID_KEY);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'dfBulkOp') {
    requestBulkOp(request.op, request.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (request.action === 'dfCaptureAccount') {
    sendResponse(readPageAuthSession());
    return false;
  }
  if (request.action === 'dfSwitchAccount') {
    sendResponse(writePageAuthSession(request.session || {}));
    return false;
  }
  if (request.action === 'scanBulkAvatars') {
    requestBulkOp('listAvatars', {})
      .then((data) => sendResponse({ ok: true, videos: data.avatars || [], accountId: data.accountId || '' }))
      .catch((error) => sendResponse({ ok: false, videos: [], error: error.message || String(error) }));
    return true;
  }
  return false;
});

function extractRunningWorkIds(body) {
  const ids = Array.isArray(body?.data) ? body.data : [];
  return ids.map((id) => String(id || '').trim()).filter(Boolean);
}

async function captureRunningWorksSnapshot() {
  try {
    const body = await requestRunningWorks();
    const ids = extractRunningWorkIds(body);
    lastKnownRunningWorkIds = [...ids];
    return { ok: true, ids };
  } catch (error) {
    return {
      ok: false,
      ids: [],
      error: error?.message || String(error),
    };
  }
}

async function resolveSubmittedWorkId(beforeIds, {
  baselineTrusted = true,
  timeoutMs = 10000,
  pollIntervalMs = 1200,
} = {}) {
  const baseline = new Set((Array.isArray(beforeIds) ? beforeIds : []).map((id) => String(id || '').trim()).filter(Boolean));
  const deadline = Date.now() + timeoutMs;
  let lastIds = Array.isArray(beforeIds) ? [...beforeIds] : [];

  while (Date.now() < deadline) {
    ensureNotCancelled();

    try {
      const body = await requestRunningWorks();
      const ids = extractRunningWorkIds(body);
      lastIds = ids;
      lastKnownRunningWorkIds = [...ids];

      const diff = ids.filter((id) => !baseline.has(id));
      if (baselineTrusted && diff.length >= 1) {
        return {
          workId: diff.length === 1 ? diff[0] : '',
          ambiguous: diff.length > 1,
          candidateIds: [...diff],
          allIds: ids,
        };
      }

      if (!baselineTrusted && ids.length === 1) {
        return {
          workId: ids[0],
          inferred: true,
          ambiguous: false,
          candidateIds: [...ids],
          allIds: ids,
        };
      }
    } catch (_) {}

    await waitWithCancellation(Math.min(pollIntervalMs, Math.max(250, deadline - Date.now())));
  }

  return {
    workId: '',
    ambiguous: false,
    candidateIds: [],
    allIds: lastIds,
  };
}

function isRecentCreationItemReady(item) {
  const status = Number(item?.web_work_status);
  return status === 200;
}

function isRecentCreationItemFailed(item) {
  const status = Number(item?.web_work_status);
  return status === -1 || status === -2;
}

function getRecentCreationFailureMessage(items) {
  const failedItems = Array.isArray(items) ? items.filter(isRecentCreationItemFailed) : [];
  if (failedItems.length === 0) {
    return '';
  }

  const names = failedItems.map((item) => item.work_name).filter(Boolean).slice(0, 6);
  const statuses = new Set(failedItems.map((item) => Number(item.web_work_status)));
  const reason = statuses.size > 1
    ? 'DreamFace завершил часть заданий с ошибкой или по timeout'
    : (statuses.has(-2) ? 'время ожидания задания истекло' : 'DreamFace завершил задание с ошибкой');
  return names.length > 0 ? `${reason}: ${names.join(', ')}` : reason;
}

function getApiMatchingCreationItems(items, expectedFileNames, startedAt, expectedWorkIds = []) {
  const minDateMs = startedAt
    ? Math.max(0, new Date(startedAt).getTime() - (5 * 60 * 1000))
    : 0;
  const filteredItems = Array.isArray(items)
    ? items.filter((item) => (
      item
      && item.work_name
      && item.work_type === 'AVATAR_VIDEO'
      && (!minDateMs || Number(item.create_time) >= minDateMs)
    ))
    : [];
  const expectedRefs = expectedFileNames.map((name, index) => ({
    name,
    workId: String(expectedWorkIds[index] || '').trim(),
  }));
  const itemsById = new Map(
    filteredItems
      .filter((item) => item?.id)
      .map((item) => [String(item.id), item])
  );
  const itemsByName = new Map();
  const readyItems = [];
  const readyFiles = [];
  const pending = [];
  const pendingItems = [];
  const pendingWorkIds = [];
  const failed = [];
  const failedItems = [];
  const failedWorkIds = [];
  const usedIds = new Set();

  filteredItems
    .slice()
    .sort((a, b) => Number(b.create_time || 0) - Number(a.create_time || 0))
    .forEach((item) => {
      const name = item.work_name;
      if (!itemsByName.has(name)) {
        itemsByName.set(name, []);
      }
      itemsByName.get(name).push(item);
    });

  expectedRefs.forEach((ref) => {
    if (ref.workId) {
      const item = itemsById.get(ref.workId);
      if (item && item.work_name === ref.name && isRecentCreationItemReady(item)) {
        readyItems.push(item);
        readyFiles.push(ref.name);
        usedIds.add(ref.workId);
        return;
      }

      if (item && item.work_name === ref.name) {
        if (isRecentCreationItemFailed(item)) {
          failed.push(ref.name);
          failedItems.push(item);
          failedWorkIds.push(ref.workId);
          return;
        }
        pending.push(ref.name);
        pendingItems.push(item);
        pendingWorkIds.push(ref.workId);
        return;
      }

      // If the tracked work id resolves to a different file name,
      // treat that mapping as stale and fall back to name-based matching.
    }

    const match = (itemsByName.get(ref.name) || []).find((item) => !usedIds.has(String(item.id || '')));
    if (match && isRecentCreationItemReady(match)) {
      readyItems.push(match);
      readyFiles.push(ref.name);
      if (match.id) {
        usedIds.add(String(match.id));
      }
      return;
    }

    if (match && isRecentCreationItemFailed(match)) {
      failed.push(ref.name);
      failedItems.push(match);
      if (match.id) {
        failedWorkIds.push(String(match.id));
        usedIds.add(String(match.id));
      }
      return;
    }

    pending.push(ref.name);
    if (match) {
      pendingItems.push(match);
      if (match.id) {
        pendingWorkIds.push(String(match.id));
      }
    }
  });

  return {
    ready: pending.length === 0 && failed.length === 0,
    items: readyItems,
    readyFiles,
    pending,
    pendingItems,
    pendingWorkIds: Array.from(new Set(pendingWorkIds.filter(Boolean))),
    failed,
    failedItems,
    failedWorkIds: Array.from(new Set(failedWorkIds.filter(Boolean))),
  };
}

function haveAllTrackedWorkIds(aggregatedItems, expectedWorkIds) {
  const trackedIds = Array.isArray(expectedWorkIds)
    ? expectedWorkIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];

  if (trackedIds.length === 0) {
    return false;
  }

  const itemIds = new Set(
    (Array.isArray(aggregatedItems) ? aggregatedItems : [])
      .map((item) => String(item?.id || '').trim())
      .filter(Boolean)
  );

  return trackedIds.every((id) => itemIds.has(id));
}

async function getCreationsApiStatus(request, { maxPages = 3, pageSize = 30 } = {}) {
  const expectedFileNames = Array.isArray(request?.expectedFileNames)
    ? request.expectedFileNames.filter(Boolean)
    : [];
  const expectedWorkIds = Array.isArray(request?.expectedWorkIds)
    ? request.expectedWorkIds.map((id) => String(id || '').trim())
    : [];

  if (expectedFileNames.length === 0) {
    return {
      status: 'error',
      message: 'нет ожидаемых файлов для Creations',
      items: [],
      pendingItems: [],
      pendingWorkIds: [],
    };
  }

  let aggregatedItems = [];
  let totalCount = 0;
  let selection = {
    ready: false,
    items: [],
    readyFiles: [],
    pending: [...expectedFileNames],
    pendingItems: [],
    pendingWorkIds: [],
    failed: [],
    failedItems: [],
    failedWorkIds: [],
  };

  for (let page = 1; page <= maxPages; page += 1) {
    const body = await requestRecentCreationsPage({ page, size: pageSize });
    const data = body?.data || {};
    const list = Array.isArray(data.list) ? data.list : [];
    totalCount = Number(data.count) || totalCount;
    aggregatedItems = aggregatedItems.concat(list);
    enrichSubmitMetaFromApiItems(list);
    selection = getApiMatchingCreationItems(aggregatedItems, expectedFileNames, request.startedAt, expectedWorkIds);

    if (selection.ready) {
      return {
        status: 'ready',
        matchedCount: selection.readyFiles.length,
        totalExpected: expectedFileNames.length,
        readyFiles: [...selection.readyFiles],
        pending: [],
        items: aggregatedItems,
        pendingItems: [],
        expectedFileNames: [...expectedFileNames],
        expectedWorkIds: [...expectedWorkIds],
        pendingWorkIds: [],
        startedAt: request.startedAt,
        source: 'api',
      };
    }

    if (haveAllTrackedWorkIds(aggregatedItems, expectedWorkIds)) {
      break;
    }

    if (page * pageSize >= totalCount || list.length === 0) {
      break;
    }
  }

  if (selection.failed.length > 0) {
    return {
      status: 'failed',
      message: getRecentCreationFailureMessage(selection.failedItems),
      matchedCount: selection.readyFiles.length,
      totalExpected: expectedFileNames.length,
      readyFiles: [...selection.readyFiles],
      readyWorkIds: selection.items.map((item) => String(item.id || '')).filter(Boolean),
      pending: [...selection.pending],
      items: aggregatedItems,
      pendingItems: [...selection.pendingItems],
      expectedFileNames: [...expectedFileNames],
      expectedWorkIds: [...expectedWorkIds],
      pendingWorkIds: [...selection.pendingWorkIds],
      failed: [...selection.failed],
      failedItems: [...selection.failedItems],
      failedWorkIds: [...selection.failedWorkIds],
      startedAt: request.startedAt,
      source: 'api',
    };
  }

  if (selection.readyFiles.length === 0 && selection.pending.length > 0) {
    return {
      status: 'pending',
      pending: [...selection.pending],
      matchedCount: 0,
      totalExpected: expectedFileNames.length,
      readyFiles: [],
      items: aggregatedItems,
      pendingItems: [...selection.pendingItems],
      expectedFileNames: [...expectedFileNames],
      expectedWorkIds: [...expectedWorkIds],
      pendingWorkIds: [...selection.pendingWorkIds],
      startedAt: request.startedAt,
      source: 'api',
    };
  }

  if (selection.readyFiles.length > 0) {
    return {
      status: 'partial',
      pending: [...selection.pending],
      matchedCount: selection.readyFiles.length,
      totalExpected: expectedFileNames.length,
      readyFiles: [...selection.readyFiles],
      items: aggregatedItems,
      pendingItems: [...selection.pendingItems],
      expectedFileNames: [...expectedFileNames],
      expectedWorkIds: [...expectedWorkIds],
      pendingWorkIds: [...selection.pendingWorkIds],
      startedAt: request.startedAt,
      source: 'api',
    };
  }

  return {
    status: 'error',
    message: 'recent creations API returned no usable matches',
    items: aggregatedItems,
    pendingItems: [],
    pendingWorkIds: [],
    source: 'api',
  };
}

function mergeBatchStatusesIntoCreationsItems(items, statusRows) {
  const statusMap = new Map(
    (Array.isArray(statusRows) ? statusRows : [])
      .filter((row) => row && row.id)
      .map((row) => [row.id, Number(row.web_work_status)])
  );

  return (Array.isArray(items) ? items : []).map((item) => (
    statusMap.has(item.id)
      ? { ...item, web_work_status: statusMap.get(item.id) }
      : item
  ));
}

async function waitForCreationsApiReady(request, {
  timeoutMs = 12000,
  maxPages = 3,
  pageSize = 30,
  pollIntervalMs = 1800,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await getCreationsApiStatus(request, { maxPages, pageSize });

  while (Date.now() < deadline) {
    if (snapshot.status === 'ready' || snapshot.status === 'failed') {
      return snapshot;
    }

    const pendingIds = Array.from(new Set([
      ...((snapshot.pendingWorkIds || []).map((id) => String(id || '').trim()).filter(Boolean)),
      ...((snapshot.pendingItems || []).map((item) => item?.id).filter(Boolean)),
    ]));
    const pendingNames = Array.isArray(snapshot.pending) ? [...snapshot.pending] : [];

    if (pendingIds.length === 0 || pendingNames.length === 0) {
      break;
    }

    const body = await requestBatchWorkStatus(pendingIds);
    const statusRows = Array.isArray(body?.data) ? body.data : [];
    let baseSnapshot = snapshot;
    let mergedItems = mergeBatchStatusesIntoCreationsItems(snapshot.items, statusRows);
    const hasMissingTrackedRows = statusRows.some((row) => row?.id && !(snapshot.items || []).some((item) => item?.id === row.id));

    if (hasMissingTrackedRows) {
      try {
        const refreshedSnapshot = await getCreationsApiStatus(request, { maxPages, pageSize });
        baseSnapshot = refreshedSnapshot;
        mergedItems = mergeBatchStatusesIntoCreationsItems(refreshedSnapshot.items, statusRows);
      } catch {}
    }

    const selection = getApiMatchingCreationItems(
      mergedItems,
      baseSnapshot.expectedFileNames || request.expectedFileNames,
      baseSnapshot.startedAt || request.startedAt,
      baseSnapshot.expectedWorkIds || request.expectedWorkIds,
    );

    snapshot = {
      ...baseSnapshot,
      status: selection.failed.length > 0
        ? 'failed'
        : (selection.ready ? 'ready' : (selection.readyFiles.length > 0 ? 'partial' : 'pending')),
      message: selection.failed.length > 0 ? getRecentCreationFailureMessage(selection.failedItems) : '',
      matchedCount: selection.readyFiles.length,
      totalExpected: Array.isArray(baseSnapshot.expectedFileNames || request.expectedFileNames)
        ? (baseSnapshot.expectedFileNames || request.expectedFileNames).length
        : 0,
      readyFiles: [...selection.readyFiles],
      pending: [...selection.pending],
      items: mergedItems,
      pendingItems: [...selection.pendingItems],
      pendingWorkIds: [...selection.pendingWorkIds],
      failed: [...selection.failed],
      failedItems: [...selection.failedItems],
      failedWorkIds: [...selection.failedWorkIds],
    };

    if (snapshot.status === 'ready' || snapshot.status === 'failed') {
      return snapshot;
    }

    await waitWithCancellation(Math.min(pollIntervalMs, Math.max(250, deadline - Date.now())));
  }

  return snapshot;
}

function getScrollContainerForElement(el) {
  let current = el;

  while (current && current !== document.body && current !== document.documentElement) {
    const styles = getComputedStyle(current);
    const overflowY = `${styles.overflowY} ${styles.overflow}`.toLowerCase();
    if ((overflowY.includes('auto') || overflowY.includes('scroll'))
      && current.scrollHeight > current.clientHeight + 16) {
      return current;
    }
    current = current.parentElement;
  }

  return document.scrollingElement || document.documentElement;
}

async function advanceCreationsList(cardsBefore = null) {
  const cards = Array.isArray(cardsBefore) ? cardsBefore : getCreationCards();
  const list = getCreationsListElement();
  if (!list || cards.length === 0) {
    return false;
  }

  const scrollContainer = getScrollContainerForElement(list);
  const lastCard = cards[cards.length - 1]?.card;
  const beforeTop = scrollContainer.scrollTop;
  const beforeHeight = scrollContainer.scrollHeight;
  const beforeCount = cards.length;

  if (lastCard instanceof HTMLElement) {
    lastCard.scrollIntoView({ block: 'end', inline: 'nearest' });
  }

  if (scrollContainer === document.body
    || scrollContainer === document.documentElement
    || scrollContainer === document.scrollingElement) {
    window.scrollTo({
      top: Math.max(beforeTop + Math.max(400, window.innerHeight * 0.85), document.body.scrollTop),
      behavior: 'auto',
    });
  } else {
    scrollContainer.scrollTo({
      top: beforeTop + Math.max(400, scrollContainer.clientHeight * 0.85),
      behavior: 'auto',
    });
  }

  await waitWithCancellation(700);

  const cardsAfter = getCreationCards();
  return cardsAfter.length > beforeCount
    || scrollContainer.scrollTop !== beforeTop
    || scrollContainer.scrollHeight !== beforeHeight;
}

async function ensureCreationsCardsLoaded(request, { timeoutMs = 6000, maxScrollPasses = 3 } = {}) {
  const expectedFileNames = Array.isArray(request?.expectedFileNames)
    ? request.expectedFileNames.filter(Boolean)
    : [];

  let cards = getCreationCards();
  let selection = getLatestMatchingCreationCards(expectedFileNames, request?.startedAt);
  let lastSignature = getCreationsCardsSignature(cards);
  let stableIterations = 0;
  let scrollPasses = 0;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (selection.ready && selection.cards.length > 0) {
      return selection;
    }

    if (scrollPasses >= Math.max(0, Number(maxScrollPasses) || 0)) {
      break;
    }

    const advanced = await advanceCreationsList(cards);
    scrollPasses += 1;
    cards = getCreationCards();
    selection = getLatestMatchingCreationCards(expectedFileNames, request?.startedAt);

    const currentSignature = getCreationsCardsSignature(cards);
    if (currentSignature === lastSignature && !advanced) {
      stableIterations += 1;
      if (stableIterations >= 2) {
        break;
      }
    } else {
      stableIterations = 0;
      lastSignature = currentSignature;
    }
  }

  return selection;
}

function getCreationCards() {
  const cardNodes = getCreationCardNodes();
  if (cardNodes.length === 0) {
    return [];
  }

  return cardNodes.map((card) => {
    const paragraphs = Array.from(card.querySelectorAll('p'));
    const nameEl = card.querySelector('p[class*="_name_"]')
      || paragraphs.find((p) => {
        const text = (p.textContent || '').trim();
        return text && !isGeneratingUiText(text) && !/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(text);
      });
    const dateEl = paragraphs.find((p) => {
      const text = (p.getAttribute('title') || p.textContent || '').trim();
      return /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(text);
    });

    const name = (nameEl?.textContent || card.querySelector('img[alt]')?.getAttribute('alt') || '').trim();
    const dateText = (dateEl?.getAttribute('title') || dateEl?.textContent || '').trim();
    const generatingOverlay = Array.from(card.querySelectorAll('div[class*="_generating_"], p[class*="_generating_"]'))
      .some((el) => isVisibleElement(el));

    return {
      card,
      name,
      dateText,
      dateMs: parseCreationDate(dateText),
      generating: generatingOverlay || isGeneratingUiText(card.textContent || ''),
      selected: Boolean(card.querySelector('div[class*="_selected_"]')),
    };
  }).filter((item) => item.name);
}

function getLatestMatchingCreationCards(expectedFileNames, startedAt) {
  const minDateMs = startedAt
    ? Math.max(0, new Date(startedAt).getTime() - (5 * 60 * 1000))
    : 0;
  const expectedCounts = new Map();

  expectedFileNames.forEach((name) => {
    expectedCounts.set(name, (expectedCounts.get(name) || 0) + 1);
  });

  const cards = getCreationCards().filter((item) => !minDateMs || !item.dateMs || item.dateMs >= minDateMs);
  const readyCards = [];
  const pending = [];

  expectedCounts.forEach((count, name) => {
    const matches = cards
      .filter((item) => item.name === name)
      .sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));

    const currentRunMatches = matches.slice(0, count);
    if (currentRunMatches.length < count || currentRunMatches.some((item) => item.generating)) {
      pending.push(name);
      return;
    }

    readyCards.push(...currentRunMatches);
  });

  return {
    ready: pending.length === 0,
    cards: readyCards,
    pending,
  };
}

async function getCreationsSelectionSnapshot(request, {
  loadMore = false,
  timeoutMs = 6000,
  maxScrollPasses = 3,
} = {}) {
  const expectedFileNames = Array.isArray(request.expectedFileNames)
    ? request.expectedFileNames.filter(Boolean)
    : [];

  if (expectedFileNames.length === 0) {
    return {
      status: 'error',
      message: 'нет ожидаемых файлов для Creations',
    };
  }

  const list = getCreationsListElement();
  if (!list) {
    return {
      status: 'error',
      message: 'список Creations не найден',
    };
  }

  const selection = loadMore
    ? await ensureCreationsCardsLoaded(request, { timeoutMs, maxScrollPasses })
    : getLatestMatchingCreationCards(expectedFileNames, request.startedAt);
  if (selection.cards.length === 0 && selection.pending.length > 0) {
    return {
      status: 'pending',
      pending: [...selection.pending],
      matchedCount: selection.cards.length,
      totalExpected: expectedFileNames.length,
    };
  }

  if (!selection.ready) {
    return {
      status: 'partial',
      selection,
      pending: [...selection.pending],
      matchedCount: selection.cards.length,
      totalExpected: expectedFileNames.length,
    };
  }

  return {
    status: 'ready',
    selection,
    matchedCount: selection.cards.length,
    totalExpected: expectedFileNames.length,
  };
}

function getCreationsStatusRank(status) {
  switch (status) {
    case 'failed':
      return 4;
    case 'ready':
      return 3;
    case 'partial':
      return 2;
    case 'pending':
      return 1;
    case 'error':
    default:
      return 0;
  }
}

function shouldPreferCreationsSnapshot(candidate, baseline) {
  if (!candidate) {
    return false;
  }

  if (!baseline) {
    return true;
  }

  const candidateRank = getCreationsStatusRank(candidate.status);
  const baselineRank = getCreationsStatusRank(baseline.status);
  if (candidateRank !== baselineRank) {
    return candidateRank > baselineRank;
  }

  return Number(candidate.matchedCount || 0) > Number(baseline.matchedCount || 0);
}

function toComparableCreationsSnapshot(result, source) {
  if (!result) {
    return null;
  }

  return {
    ...result,
    source: result.source || source,
    matchedCount: Number(result.matchedCount || 0),
    totalExpected: Number(result.totalExpected || 0),
    readyFiles: Array.isArray(result.readyFiles) ? [...result.readyFiles] : [],
    pending: Array.isArray(result.pending) ? [...result.pending] : [],
  };
}

async function checkCreationsStatus(request) {
  let bestSnapshot = null;

  try {
    const apiSnapshot = await getCreationsApiStatus(request, { maxPages: 3, pageSize: 30 });
    bestSnapshot = toComparableCreationsSnapshot(apiSnapshot, 'api');
    if (bestSnapshot?.status === 'ready' || bestSnapshot?.status === 'failed') {
      return bestSnapshot;
    }
  } catch {}

  let snapshot = await getCreationsSelectionSnapshot(request, {
    loadMore: false,
  });
  let comparableSnapshot = toComparableCreationsSnapshot({
    ...snapshot,
    readyFiles: snapshot.selection?.cards?.map((item) => item.name) || [],
  }, 'ui');
  if (shouldPreferCreationsSnapshot(comparableSnapshot, bestSnapshot)) {
    bestSnapshot = comparableSnapshot;
  }

  if (snapshot.status !== 'ready') {
    snapshot = await getCreationsSelectionSnapshot(request, {
      loadMore: true,
      timeoutMs: 5000,
      maxScrollPasses: 3,
    });
    comparableSnapshot = toComparableCreationsSnapshot({
      ...snapshot,
      readyFiles: snapshot.selection?.cards?.map((item) => item.name) || [],
    }, 'ui');
    if (shouldPreferCreationsSnapshot(comparableSnapshot, bestSnapshot)) {
      bestSnapshot = comparableSnapshot;
    }
  }

  if (bestSnapshot) {
    return bestSnapshot;
  }

  return toComparableCreationsSnapshot({
    ...snapshot,
    readyFiles: snapshot.selection?.cards?.map((item) => item.name) || [],
  }, 'ui') || {
    status: 'error',
    message: 'не удалось определить статус Creations',
    matchedCount: 0,
    totalExpected: Array.isArray(request?.expectedFileNames) ? request.expectedFileNames.length : 0,
    readyFiles: [],
    pending: Array.isArray(request?.expectedFileNames) ? [...request.expectedFileNames] : [],
    source: 'ui',
  };
}

function getCreationsToolbarControls() {
  return Array.from(document.querySelectorAll('div[class*="_select_btn_"], div[class*="_select_content_"], button, span'))
    .filter((el) => isVisibleElement(el));
}

function resolveCreationsToolbarControl(node) {
  if (!(node instanceof HTMLElement)) {
    return null;
  }

  if (node.matches('button, div[class*="_select_btn_"]')) {
    return node;
  }

  const ancestor = node.closest('button, div[class*="_select_btn_"]');
  if (ancestor instanceof HTMLElement) {
    return ancestor;
  }

  const descendant = node.querySelector('button, div[class*="_select_btn_"]');
  return descendant instanceof HTMLElement ? descendant : null;
}

function findCreationsToolbarControl(labels) {
  const variants = Array.isArray(labels) ? labels : [labels];
  if (variants.filter(Boolean).length === 0) {
    return null;
  }

  const matched = getCreationsToolbarControls().find((el) => (
    matchesUiText(el.textContent || '', variants, { allowPrefix: true })
  ));

  return resolveCreationsToolbarControl(matched);
}

async function closeOpenCreationsDialog() {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog || !isVisibleElement(dialog)) {
    return;
  }

  const closeControl = dialog.querySelector('div[class*="_closeContainer_"], button[aria-label*="close" i]');
  if (closeControl instanceof HTMLElement) {
    closeControl.click();
  } else {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  await waitForCondition(() => {
    const activeDialog = document.querySelector('[role="dialog"]');
    return !activeDialog || !isVisibleElement(activeDialog) ? true : null;
  }, { timeout: 5000 });
}

function isToolbarControlEnabled(control) {
  if (!control) {
    return false;
  }

  const className = typeof control.className === 'string' ? control.className : '';
  return !className.includes('_disable_delete_');
}

async function ensureCreationsSelectMode() {
  await closeOpenCreationsDialog();

  if (findCreationsToolbarControl(CREATIONS_TEXT.cancel)) {
    return;
  }

  const selectControl = findCreationsToolbarControl(CREATIONS_TEXT.select);
  if (!selectControl) {
    throw new Error('кнопка выбора не найдена');
  }

  selectControl.click();
  await waitForCondition(() => (findCreationsToolbarControl(CREATIONS_TEXT.cancel) ? true : null), { timeout: 5000 });
}

async function selectCreationCards(cards) {
  for (const item of cards) {
    ensureNotCancelled();

    let currentCard = getCreationCards().find((card) => (
      card.name === item.name && card.dateText === item.dateText
    ));

    if (!currentCard) {
      await ensureCreationsCardsLoaded({
        expectedFileNames: [item.name],
        startedAt: item.dateText || undefined,
      }, { timeoutMs: 4000 });
      currentCard = getCreationCards().find((card) => (
        card.name === item.name && card.dateText === item.dateText
      ));
    }

    if (!currentCard) {
      throw new Error(`карточка не найдена: ${item.name}`);
    }

    if (currentCard.selected) {
      continue;
    }

    currentCard.card.scrollIntoView({ block: 'center', inline: 'nearest' });
    currentCard.card.click();
    await waitForCondition(() => {
      const refreshed = getCreationCards().find((card) => (
        card.name === item.name && card.dateText === item.dateText
      ));

      return refreshed?.selected ? true : null;
    }, { timeout: 2000 });
  }
}

async function waitForCreationsDownload(request) {
  await Promise.allSettled([processingSettingsHydrationPromise, submitMetaHydrationPromise]);
  const expectedFileNames = Array.isArray(request.expectedFileNames)
    ? request.expectedFileNames.filter(Boolean)
    : [];

  if (expectedFileNames.length === 0) {
    return { status: 'error', message: 'нет ожидаемых файлов для Creations' };
  }

  const timeoutMs = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : 30 * 60 * 1000;
  await waitForCondition(() => (getCreationsListElement() ? true : null), {
    timeout: timeoutMs,
    root: document.body,
    pollInterval: 1000,
  });

  const deadline = Date.now() + timeoutMs;
  let readySelection = null;
  let apiReadyFiles = null;
  let lastPending = [...expectedFileNames];

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1000, deadline - Date.now());
    try {
      const apiSnapshot = await waitForCreationsApiReady(request, {
        timeoutMs: Math.min(12000, remainingMs),
        maxPages: 3,
        pageSize: 30,
      });
      if (apiSnapshot.status === 'ready' && Array.isArray(apiSnapshot.readyFiles) && apiSnapshot.readyFiles.length > 0) {
        apiReadyFiles = [...apiSnapshot.readyFiles];
        lastPending = [];
        break;
      }

      if (apiSnapshot.status === 'failed') {
        if (Array.isArray(apiSnapshot.readyFiles) && apiSnapshot.readyFiles.length > 0) {
          return downloadCreationsIfReady(request);
        }
        return apiSnapshot;
      }

      if (Array.isArray(apiSnapshot.pending) && apiSnapshot.pending.length > 0) {
        lastPending = [...apiSnapshot.pending];
      }
    } catch {
      const selection = await ensureCreationsCardsLoaded(request, {
        timeoutMs: Math.min(4000, remainingMs),
        maxScrollPasses: 3,
      });

      if (selection.ready && selection.cards.length > 0) {
        readySelection = selection;
        break;
      }

      lastPending = [...selection.pending];
    }

    await waitWithCancellation(Math.min(1500, remainingMs));
  }

  const selectionRequest = apiReadyFiles
    ? { ...request, expectedFileNames: apiReadyFiles }
    : request;

  if (!readySelection && apiReadyFiles) {
    const finalSelection = await getCreationsSelectionSnapshot(selectionRequest, {
      loadMore: false,
    });
    if (finalSelection.status === 'ready') {
      readySelection = finalSelection.selection;
    } else {
      const loadedSelection = await ensureCreationsCardsLoaded(selectionRequest, {
        timeoutMs: 4000,
        maxScrollPasses: 3,
      });
      if (loadedSelection.ready && loadedSelection.cards.length > 0) {
        readySelection = loadedSelection;
      }
    }
  }

  if (!readySelection) {
    return {
      status: 'error',
      message: `не удалось дождаться карточек: ${lastPending.join(', ') || 'timeout'}`,
    };
  }

  await closeOpenCreationsDialog();

  // Сначала пробуем наш путь: запрос API готовых items + offscreen
  try {
    const finalApiSnapshot = await getCreationsApiStatus(selectionRequest, { maxPages: 3, pageSize: 30 });
    const expectedWorkIdSet = new Set(
      (Array.isArray(selectionRequest.expectedWorkIds) ? selectionRequest.expectedWorkIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    );
    const expectedFileNameSet = new Set(
      (Array.isArray(selectionRequest.expectedFileNames) ? selectionRequest.expectedFileNames : [])
        .filter(Boolean)
    );

    const readyItems = Array.isArray(finalApiSnapshot?.items)
      ? finalApiSnapshot.items.filter((it) => {
          if (!it || !it.work_name) return false;
          if (Number(it.web_work_status) !== 200) return false;
          return expectedWorkIdSet.size > 0
            ? expectedWorkIdSet.has(String(it.id || ''))
            : expectedFileNameSet.has(it.work_name);
        })
      : [];
    console.log('[dreamface] waitForCreationsDownload: expected workIds=', expectedWorkIdSet.size,
      'expected names=', expectedFileNameSet.size, 'ready to download=', readyItems.length);

    if (readyItems.length > 0) {
      const result = await downloadReadyItemsLocally(readyItems);
      if (result.ok) {
        return {
          status: 'success',
          downloadedCount: result.downloaded.length,
          files: result.downloaded.map((d) => d.workName),
        };
      }
      if (result.requiresLocalProcessing) {
        return { status: 'error', message: `локальная обработка обязательна: ${result.reason}` };
      }
      console.warn('[dreamface] local download failed, evaluating safe fallback:', result.reason);
    }
  } catch (err) {
    console.warn('[dreamface] api snapshot for chapters failed:', err.message);
    return { status: 'error', message: `не удалось проверить необходимость локальной обработки: ${err.message}` };
  }

  // Fallback на сайтовую кнопку
  await ensureCreationsSelectMode();
  await waitWithCancellation(300);

  const finalSelection = await ensureCreationsCardsLoaded(selectionRequest, {
    timeoutMs: 4000,
    maxScrollPasses: 3,
  });
  if (!finalSelection.ready || finalSelection.cards.length === 0) {
    return {
      status: 'error',
      message: `не удалось собрать карточки: ${finalSelection.pending.join(', ') || 'empty selection'}`,
    };
  }

  await selectCreationCards(finalSelection.cards);

  const downloadControl = await waitForCondition(() => {
    const control = findCreationsToolbarControl(CREATIONS_TEXT.download);
    return isToolbarControlEnabled(control) ? control : null;
  }, { timeout: 5000 });

  if (!downloadControl) {
    return { status: 'error', message: 'кнопка скачивания не найдена' };
  }

  // помечаем кнопку как программный клик, иначе наш перехватчик заблокирует
  downloadControl.dataset.dmProgrammatic = '1';
  downloadControl.click();
  await waitWithCancellation(1000);

  return {
    status: 'success',
    downloadedCount: finalSelection.cards.length,
    files: finalSelection.cards.map((item) => item.name),
  };
}

// Для каждого ready-item получаем download URL и ставим локальную обработку
// в очередь. Items с chapters никогда не уходят в site-button fallback.
async function downloadReadyItemsLocally(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  await Promise.allSettled([
    Promise.resolve(),
    submitMetaHydrationPromise,
  ]);

  const queueNameByWorkId = new Map();
  try {
    const runStateResponse = await chrome.runtime.sendMessage({ action: 'engine.getRunState' });
    const queuePlan = Array.isArray(runStateResponse?.state?.queuePlan)
      ? runStateResponse.state.queuePlan
      : [];
    for (const task of queuePlan) {
      const fileName = String(task?.fileName || '');
      if (task?.workId && fileName) {
        queueNameByWorkId.set(String(task.workId), fileName);
      }
    }
  } catch (err) {
    console.warn('[dreamface] failed to fetch queuePlan for download metadata:', err.message);
  }

  const requiresKnownProcessing = items.some((item) => {
    const workId = String(item?.id || '');
    const animateId = String(item?.animate_id || '');
    const meta = submitMetaByWorkId.get(workId) || submitMetaByAnimateId.get(animateId);
    return Boolean(meta
      && Number.isFinite(meta.audioMs)
      && Number.isFinite(meta.videoMs)
      && meta.videoMs > 0
      && meta.audioMs > meta.videoMs);
  });
  const ids = items.map((it) => String(it?.id || '')).filter(Boolean);
  if (ids.length === 0) {
    return { ok: false, reason: 'no ids', requiresLocalProcessing: requiresKnownProcessing };
  }

  let urlBody;
  try {
    urlBody = await requestBatchDownloadUrls(ids);
  } catch (err) {
    console.warn('[dreamface] batch download url failed', err.message);
    return {
      ok: false,
      reason: 'url request failed: ' + err.message,
      requiresLocalProcessing: requiresKnownProcessing,
    };
  }

  const urlMap = new Map();
  for (const entry of (urlBody?.data || [])) {
    if (entry?.id && entry?.url) urlMap.set(String(entry.id), entry.url);
  }
  if (urlMap.size === 0) {
    return { ok: false, reason: 'no urls returned', requiresLocalProcessing: requiresKnownProcessing };
  }

  console.log('[dreamface] submitMetaByWorkId snapshot:',
    Array.from(submitMetaByWorkId.entries()).map(([k, v]) => ({
      workId: k, audioMs: v.audioMs, videoMs: v.videoMs, animateImageId: v.animateImageId,
    }))
  );
  console.log('[dreamface] submitMetaByAnimateId snapshot:',
    Array.from(submitMetaByAnimateId.entries()).map(([k, v]) => ({
      animateImageId: k, audioMs: v.audioMs, videoMs: v.videoMs,
    }))
  );
  // дубль в persist-лог (виден в popup → debug-panel), чтобы не потеряться
  // когда popup закрывается во время скачивания.
  dmLog('log', 'submitMetaByWorkId size', submitMetaByWorkId.size,
    'animate size', submitMetaByAnimateId.size);

  const payload = [];
  for (const item of items) {
    const workId = String(item?.id || '');
    const url = urlMap.get(workId);
    if (!url) continue;
    let meta = submitMetaByWorkId.get(workId) || null;

    // fallback: попробовать найти по animate_id из API item
    if (!meta && item?.animate_id) {
      meta = submitMetaByAnimateId.get(item.animate_id) || null;
      if (meta) {
        console.log('[dreamface] meta found via animate_id fallback', { workId, animateId: item.animate_id });
        submitMetaByWorkId.set(workId, meta); // кешируем
        persistSubmitMeta();
      }
    }

    if (!meta) {
      console.warn('[dreamface] no submit meta for workId', workId,
        'item.animate_id=', item?.animate_id, 'work_name=', item?.work_name);
    }

    // имя файла приоритет:
    //   1) audioFileName из submitMeta (свежий submit с правильным именем)
    //   2) имя из текущей queuePlan по workId (свежий run в storage)
    //   3) work_name из API сайта (часто uuid — не годится для пользователя)
    //   4) workId как фолбек
    const metaName = (meta?.audioFileName || '').trim();
    const queueName = (queueNameByWorkId.get(workId) || '').trim();
    const apiName = (item.work_name || '').trim();
    const audioFileName = metaName || queueName || '';
    const resolvedName = audioFileName || apiName || workId;

    // апсейв имени обратно в meta, чтобы при следующем скачивании не лазить в queuePlan
    if (!metaName && queueName && meta) {
      meta.audioFileName = queueName;
      submitMetaByWorkId.set(workId, meta);
      persistSubmitMeta();
    }

    payload.push({
      workId,
      workName: resolvedName,
      // прокидываем явно для offscreen, чтобы он не зависел от эвристик имени
      audioFileName: audioFileName || '',
      url,
      audioMs: meta?.audioMs ?? null,
      videoMs: meta?.videoMs ?? null,
      hasChapters: Boolean(meta && Number.isFinite(meta.audioMs) && Number.isFinite(meta.videoMs) && meta.videoMs > 0 && meta.audioMs > meta.videoMs),
    });
  }

  if (payload.length === 0) {
    return { ok: false, reason: 'no items resolved', requiresLocalProcessing: requiresKnownProcessing };
  }
  const requiresLocalProcessing = payload.some((item) => item.hasChapters);
  if (payload.length !== ids.length) {
    return {
      ok: false,
      reason: `download URL missing for ${ids.length - payload.length} item(s)`,
      requiresLocalProcessing: requiresKnownProcessing || requiresLocalProcessing,
    };
  }

  // Единая точка скачивания — DownloadManager в background. Он сам:
  //   - разруливает direct vs local processing path,
  //   - держит семафор fetch=6,
  //   - персистит per-workId статус,
  //   - делает retry с backoff,
  //   - поднимает alarms keep-alive чтобы SW не уснул на больших батчах.
  // UI прогресс получает через dm.stateUpdate broadcast.
  console.log('[dreamface] dm.enqueue total=', payload.length,
    'withChapters=', payload.filter((p) => p.hasChapters).length);
  // дубль в persist-лог, чтобы видно было в popup даже после закрытия page-console
  dmLog('log', 'dm.enqueue prepared', {
    total: payload.length,
    withChapters: payload.filter((p) => p.hasChapters).length,
    items: payload.map((p) => ({
      workId: p.workId,
      name: p.audioFileName || p.workName,
      audioMs: p.audioMs,
      videoMs: p.videoMs,
      hasChapters: p.hasChapters,
    })),
  });

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'dm.enqueue',
      payload: { items: payload },
    });
    if (response?.ok) {
      // Оптимистично возвращаем что все встали в очередь. Реальный прогресс
      // через dm.stateUpdate в popup. Имена с .mp4 для UI-логов.
      return {
        ok: true,
        downloaded: payload.map((p) => ({
          workId: p.workId,
          workName: p.workName,
          fileName: (p.audioFileName || p.workName || p.workId) + '.mp4',
          pending: true,
        })),
        failed: [],
        enqueued: response.accepted || 0,
        skipped: response.skipped || 0,
      };
    }
    console.warn('[dreamface] dm.enqueue rejected:', response?.error);
    return {
      ok: false,
      reason: response?.error || 'dm.enqueue failed',
      requiresLocalProcessing,
    };
  } catch (err) {
    console.warn('[dreamface] dm.enqueue channel error:', err.message);
    return {
      ok: false,
      reason: 'channel error: ' + err.message,
      requiresLocalProcessing,
    };
  }
}

async function downloadCreationsIfReady(request) {
  await Promise.allSettled([processingSettingsHydrationPromise, submitMetaHydrationPromise]);
  let apiSnapshot = null;
  let apiSnapshotError = null;

  try {
    apiSnapshot = await getCreationsApiStatus(request, { maxPages: 3, pageSize: 30 });
  } catch (error) {
    apiSnapshotError = error;
  }

  if (apiSnapshot?.status === 'failed' && (!Array.isArray(apiSnapshot.readyFiles) || apiSnapshot.readyFiles.length === 0)) {
    return apiSnapshot;
  }

  const selectionRequest = apiSnapshot && Array.isArray(apiSnapshot.readyFiles) && apiSnapshot.readyFiles.length > 0
    ? {
        ...request,
        expectedFileNames: apiSnapshot.readyFiles,
        expectedWorkIds: Array.isArray(apiSnapshot.readyWorkIds) ? apiSnapshot.readyWorkIds : [],
      }
    : request;
  let snapshot = await getCreationsSelectionSnapshot(selectionRequest, {
    loadMore: false,
  });

  if (snapshot.status !== 'ready') {
    snapshot = await getCreationsSelectionSnapshot(selectionRequest, {
      loadMore: true,
      timeoutMs: 4000,
      maxScrollPasses: 3,
    });
  }
  if (snapshot.status === 'error') {
    return snapshot;
  }

  if (snapshot.status === 'pending') {
    if (apiSnapshot?.status === 'partial' || apiSnapshot?.status === 'ready') {
      return apiSnapshot;
    }
    return snapshot;
  }

  await closeOpenCreationsDialog();

  // Новый путь: качаем сами через offscreen + WebCodecs/ffmpeg processing.
  // Берём ТОЛЬКО те items, которые в expected (иначе огребём все 200+ работ юзера).
  const expectedWorkIdSet = new Set(
    (Array.isArray(request.expectedWorkIds) ? request.expectedWorkIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  );
  const expectedFileNameSet = new Set(
    (Array.isArray(request.expectedFileNames) ? request.expectedFileNames : [])
      .filter(Boolean)
  );

  const readyItems = Array.isArray(apiSnapshot?.items)
    ? apiSnapshot.items.filter((it) => {
        if (!it || !it.work_name) return false;
        if (Number(it.web_work_status) !== 200) return false;
        // если фильтры пустые — не брать ничего, чтобы не качать чужое
        return expectedWorkIdSet.size > 0
          ? expectedWorkIdSet.has(String(it.id || ''))
          : expectedFileNameSet.has(it.work_name);
      })
    : [];

  console.log('[dreamface] downloadCreationsIfReady: expected workIds=', expectedWorkIdSet.size,
    'expected names=', expectedFileNameSet.size, 'ready items to download=', readyItems.length);

  if (readyItems.length > 0) {
    const result = await downloadReadyItemsLocally(readyItems);
    if (result.ok) {
      const downloadedNames = result.downloaded.map((d) => d.workName);
      const effectivePending = apiSnapshot && Array.isArray(apiSnapshot.pending)
        ? [...apiSnapshot.pending]
        : [...(snapshot.pending || [])];

      if (apiSnapshot.status === 'failed') {
        return {
          ...apiSnapshot,
          message: `скачивание запущено: ${downloadedNames.length}; ${apiSnapshot.message}`,
          downloadedCount: downloadedNames.length,
          files: downloadedNames,
        };
      }
      if (effectivePending.length > 0) {
        return {
          status: 'partial',
          downloadedCount: downloadedNames.length,
          files: downloadedNames,
          pending: effectivePending,
        };
      }
      return {
        status: 'success',
        downloadedCount: downloadedNames.length,
        files: downloadedNames,
      };
    }
    if (result.requiresLocalProcessing) {
      return { status: 'error', message: `локальная обработка обязательна: ${result.reason}` };
    }
    console.warn('[dreamface] local download failed, evaluating safe fallback:', result.reason);
  }

  if (!apiSnapshot) {
    return {
      status: 'error',
      message: `не удалось проверить необходимость локальной обработки: ${apiSnapshotError?.message || 'API недоступен'}`,
    };
  }

  // Fallback на сайтовую кнопку
  await ensureCreationsSelectMode();
  await waitWithCancellation(300);
  await selectCreationCards(snapshot.selection.cards);

  const downloadControl = await waitForCondition(() => {
    const control = findCreationsToolbarControl(CREATIONS_TEXT.download);
    return isToolbarControlEnabled(control) ? control : null;
  }, { timeout: 5000 });

  if (!downloadControl) {
    return { status: 'error', message: 'кнопка скачивания не найдена' };
  }

  downloadControl.dataset.dmProgrammatic = '1';
  downloadControl.click();
  await waitWithCancellation(1000);

  const effectivePending = apiSnapshot && Array.isArray(apiSnapshot.pending)
    ? [...apiSnapshot.pending]
    : [...(snapshot.pending || [])];
  const shouldReturnPartial = snapshot.status === 'partial' || effectivePending.length > 0;

  if (apiSnapshot.status === 'failed') {
    return {
      ...apiSnapshot,
      message: `скачивание запущено: ${snapshot.selection.cards.length}; ${apiSnapshot.message}`,
      downloadedCount: snapshot.selection.cards.length,
      files: snapshot.selection.cards.map((item) => item.name),
    };
  }

  if (shouldReturnPartial) {
    return {
      status: 'partial',
      downloadedCount: snapshot.selection.cards.length,
      files: snapshot.selection.cards.map((item) => item.name),
      pending: effectivePending,
    };
  }

  return {
    status: 'success',
    downloadedCount: snapshot.selection.cards.length,
    files: snapshot.selection.cards.map((item) => item.name),
  };
}

function sendScanProgress(iteration, count, maxIterations) {
  chrome.runtime.sendMessage({
    action: 'scanProgress',
    iteration,
    count,
    maxIterations,
  }).catch(() => {});
}

function forceLoadThumbnails(maxElements = AVATAR_DISPLAY_LIMIT) {
  const validElements = getValidVideoElements().slice(0, maxElements);
  let loadedCount = 0;
  let failedCount = 0;

  validElements.forEach((el) => {
    const img = el.querySelector('img');
    if (!img) {
      return;
    }

    const dataSrc = img.getAttribute('data-src');
    if (dataSrc && !img.src.includes('material')) {
      img.src = dataSrc;
    }

    if (img.complete && img.naturalHeight !== 0) {
      loadedCount += 1;
    } else if (!img.complete) {
      img.onload = () => { loadedCount += 1; };
      img.onerror = () => { failedCount += 1; };
    }
  });

  return { total: validElements.length, loaded: loadedCount, failed: failedCount };
}

async function smartLoadThumbnails(maxElements = 200) {
  const allElements = getValidVideoElements();
  const validElements = allElements.slice(0, maxElements);
  const loadedImages = new Set();

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) {
        return;
      }

      const img = entry.target.querySelector('img');
      if (!img || loadedImages.has(img)) {
        return;
      }

      loadedImages.add(img);
      const dataSrc = img.getAttribute('data-src');
      if (dataSrc && !img.src.includes('material')) {
        img.src = dataSrc;
      }
    });
  }, {
    rootMargin: '200px',
  });

  validElements.forEach((el) => observer.observe(el));
  await sleep(300);
  observer.disconnect();
  return forceLoadThumbnailsForElements(validElements);
}

function forceLoadThumbnailsForElements(elements) {
  let loadedCount = 0;
  let failedCount = 0;

  elements.forEach((el) => {
    const img = el.querySelector('img');
    if (!img) {
      return;
    }

    const dataSrc = img.getAttribute('data-src');
    if (dataSrc && !img.src.includes('material')) {
      img.src = dataSrc;
    }

    if (img.complete && img.naturalHeight !== 0) {
      loadedCount += 1;
    } else if (!img.complete) {
      img.onload = () => { loadedCount += 1; };
      img.onerror = () => { failedCount += 1; };
    }
  });

  return { total: elements.length, loaded: loadedCount, failed: failedCount };
}

async function dynamicScanVideos(sendResponse) {
  const MAX_SCAN_VIDEOS = 200;
  const MAX_ITERATIONS = 50;
  const SCROLL_DELAY = 800;
  const STABLE_COUNT = 3;

  let previousCount = 0;
  let stableIterations = 0;
  let iteration = 0;

  sendScanProgress(0, 0, MAX_ITERATIONS);

  while (iteration < MAX_ITERATIONS) {
    const validElements = getValidVideoElements();
    const currentCount = Math.min(validElements.length, MAX_SCAN_VIDEOS);

    // Остановить скролл если набрали достаточно
    if (validElements.length >= MAX_SCAN_VIDEOS) {
      sendScanProgress(iteration + 1, MAX_SCAN_VIDEOS, MAX_ITERATIONS);
      break;
    }

    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: 'smooth',
    });

    await smartLoadThumbnails(MAX_SCAN_VIDEOS);

    if (iteration % 2 === 0) {
      sendScanProgress(iteration + 1, currentCount, MAX_ITERATIONS);
    }

    if (currentCount === previousCount) {
      stableIterations += 1;
      if (stableIterations >= STABLE_COUNT) {
        break;
      }
    } else {
      stableIterations = 0;
      previousCount = currentCount;
    }

    iteration += 1;
    await sleep(SCROLL_DELAY);
  }

  forceLoadThumbnailsForElements(getValidVideoElements().slice(0, MAX_SCAN_VIDEOS));
  await sleep(500);

  const videos = [];
  const paddedVideoMarkers = await loadPaddedVideoMarkers().catch(() => ({}));
  let skippedWithoutCover = 0;

  const allElements = getValidVideoElements().slice(0, MAX_SCAN_VIDEOS);
  allElements.forEach((el, index) => {
    const img = el.querySelector('img');
    if (!img) {
      return;
    }

    const src = getVideoThumbnailSource(el);
    if (src && (src.includes('material') || img.complete)) {
      const marker = paddedVideoMarkers[getVideoMarkerKey(src)];
      videos.push({
        index,
        src,
        borderCropPx: Math.max(0, Math.floor(Number(marker?.borderCropPx ?? marker) || 0)),
      });
    } else {
      skippedWithoutCover += 1;
    }
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });
  sendResponse({
    videos,
    iterations: iteration,
    skippedWithoutCover,
    totalScanned: videos.length,
  });
}

async function selectVideoSafe(index) {
  const items = getValidVideoElements();
  if (!items[index]) {
    throw new Error(`видео #${index} недоступно`);
  }

  const wrapper = items[index];
  const img = wrapper.querySelector('img');

  const isSelected = () => {
    if (img && img.className.includes('selected')) {
      return true;
    }
    if (wrapper.className.includes('selected')) {
      return true;
    }
    if (img) {
      const styles = getComputedStyle(img);
      if (styles.borderColor !== 'rgb(0, 0, 0)' && styles.borderWidth !== '0px') {
        return true;
      }
    }
    return false;
  };

  if (isSelected()) {
    return;
  }

  if (img) {
    img.click();
  } else {
    wrapper.click();
  }

  await waitForCondition(() => (isSelected() ? true : null), { timeout: 5000 });
}

async function waitForUploadReady(expectedFileName = '') {
  return waitForCondition(() => {
    const knownError = getKnownUploadErrorMessage();
    if (knownError) {
      return { status: 'upload_error', message: knownError };
    }

    const snapshot = getAudioPanelSnapshot();
    if (
      snapshot.readyCount > 0
      && snapshot.hasSelectedLabel
      && isExpectedFileVisible(expectedFileName, snapshot)
    ) {
      return { status: 'ready' };
    }

    return null;
  }, { timeout: 90000 });
}

async function waitForGenerateEnabled() {
  return waitForCondition(() => {
    const btn = findGenerateButton();
    if (btn && !btn.disabled) {
      return btn;
    }
    return null;
  }, { timeout: 30000 });
}

// Обнаруживает видимую модалку/диалог, который может перехватить click Generate.
// возвращает { blocked: true/false, message } — если blocked=false, продолжаем
// как обычно; если true — content_script вернёт submission_unconfirmed с
// причиной для нормального retry на уровне offscreen.
function findBlockingModal() {
  const selectors = [
    // shadcn/radix dialogs
    '[role="dialog"][data-state="open"]',
    '[role="alertdialog"][data-state="open"]',
    // старые CSS-modules
    'div[class*="_modal_"]',
    'div[class*="_dialog_"]',
  ];
  const candidates = [];
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (isVisibleElement(el)) candidates.push(el);
    }
  }
  // самый большой = наиболее вероятно overlay
  candidates.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return (br.width * br.height) - (ar.width * ar.height);
  });
  return candidates[0] || null;
}

async function handleBlockingModalBeforeSubmit() {
  const modal = findBlockingModal();
  if (!modal) return { blocked: false };

  // Если это multi-face модалка — попробуем разрулить: применить сохранённый
  // выбор + кликнуть Confirm. Если memory нет — блокируем flow.
  const faceBoxes = modal.querySelectorAll('button[class*="_faceBox_"]');
  const confirmBtn = modal.querySelector('button[class*="_confirmButton_"]');

  if (faceBoxes.length > 0 && confirmBtn) {
    const fingerprint = getMultiFaceFingerprint(modal);
    const remembered = fingerprint ? multiFaceMemory[fingerprint] : null;
    if (remembered && Array.isArray(remembered.selectedIndices)) {
      console.warn('[dreamface] preflight: multi-face модалка активна, применяю запомнённый выбор', remembered.selectedIndices);
      applySelectedFaceIndices(modal, remembered.selectedIndices);
      await waitWithCancellation(400);
      confirmBtn.click();
      // ждём закрытия модалки до 3 секунд
      const closed = await waitForCondition(
        () => (document.body.contains(modal) && isVisibleElement(modal) ? null : true),
        { timeout: 3000 },
      ).catch(() => false);
      if (!closed) {
        return {
          blocked: true,
          message: 'multi-face модалка не закрылась после auto-confirm',
        };
      }
      return { blocked: false };
    }
    return {
      blocked: true,
      message: `multi-face модалка требует ручного выбора лица (найдено ${faceBoxes.length} лиц${fingerprint ? '' : ', fingerprint неопределён'})`,
    };
  }

  // не multi-face но какая-то модалка перекрывает страницу.
  // например "buy credits" / re-auth / duration warning.
  const modalText = (modal.innerText || '').trim().slice(0, 200);
  return {
    blocked: true,
    message: `модалка перекрывает click Generate: ${modalText || '<без текста>'}`,
  };
}

async function waitForAudioInputReady() {
  return waitForCondition(() => {
    const input = findAudioFileInput();
    return input || null;
  }, { timeout: 15000 });
}

function getVideoUploadTimeoutMs(file) {
  const fileSizeMb = Math.max(1, Math.ceil((file?.size || 0) / (1024 * 1024)));
  return Math.max(90000, Math.min(6 * 60 * 1000, fileSizeMb * 3000));
}

function isProbablyVideoFile(file) {
  const type = (file?.type || '').toLowerCase();
  const name = (file?.name || '').toLowerCase();
  return type.startsWith('video/')
    || /\.(mp4|mov|webm|avi|mkv|m4v)$/i.test(name);
}

async function waitForVideoUploadOutcome(previousCount, file) {
  const timeoutMs = getVideoUploadTimeoutMs(file);
  return waitForCondition(() => {
    ensureNotCancelled();

    if (avatarAddSuccessHit) {
      return { status: 'success' };
    }

    const currentCount = getValidVideoElements().length;
    if (currentCount > previousCount) {
      return { status: 'success' };
    }

    return null;
  }, {
    timeout: timeoutMs,
    root: document.body,
    pollInterval: 500,
  });
}

async function waitForNewVideoSource(previousSources, file) {
  const timeoutMs = getVideoUploadTimeoutMs(file);
  return waitForCondition(() => {
    const candidateElements = getValidVideoElements();
    forceLoadThumbnailsForElements(candidateElements.slice(0, 20));
    const addedSources = candidateElements
      .map(getVideoThumbnailSource)
      .filter((source) => source && !previousSources.has(getVideoMarkerKey(source)));
    return addedSources.length === 1 ? addedSources[0] : null;
  }, {
    timeout: timeoutMs,
    root: document.body,
    pollInterval: 500,
  });
}

async function uploadSingleVideoToDreamFace(file, current, total, { identifySource = false } = {}) {
  const input = findVideoUploadInput();
  if (!input) {
    throw new Error('загрузка видео доступна на странице Avatar или Avatar Bulk; язык сайта не важен');
  }

  const videoElementsBefore = getValidVideoElements();
  const previousCount = videoElementsBefore.length;
  const previousSources = new Set(
    videoElementsBefore.map(getVideoThumbnailSource).filter(Boolean).map(getVideoMarkerKey),
  );
  avatarAddSuccessHit = false;
  sendVideoUploadProgress(`[${current}/${total}] загрузка видео ${file.name}`, current, total, file.name);

  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  await waitForVideoUploadOutcome(previousCount, file);
  const uploadedSource = identifySource
    ? await waitForNewVideoSource(previousSources, file)
    : '';
  sendVideoUploadProgress(`[${current}/${total}] видео загружено: ${file.name}`, current, total, file.name);
  await waitWithCancellation(800);

  return { status: 'success', uploadedSource };
}

async function pickFilesForDreamFaceUpload(input) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      input.removeEventListener('change', handleChange, true);
      window.removeEventListener('focus', handleFocus, true);
    };

    const finish = (files) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(files);
    };

    const fail = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const handleChange = (event) => {
      if (event.target !== input) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();

      const files = Array.from(input.files || []).filter(isProbablyVideoFile);
      input.value = '';
      finish(files);
    };

    const handleFocus = () => {
      setTimeout(() => {
        if (!settled) {
          finish([]);
        }
      }, 600);
    };

    input.addEventListener('change', handleChange, true);
    window.addEventListener('focus', handleFocus, true);

    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
      } else {
        input.click();
      }
    } catch (error) {
      fail(error);
    }
  });
}

async function startMultiVideoUploadPicker({ addBorderEnabled = false } = {}) {
  if (videoUploadJobActive) {
    throw new Error('загрузка видео уже выполняется');
  }

  const input = findVideoUploadInput();
  if (!input) {
    throw new Error('поле загрузки видео не найдено');
  }

  const originalMultiple = input.multiple;
  const originalAccept = input.getAttribute('accept') || '';

  input.multiple = true;
  input.setAttribute('multiple', '');
  input.setAttribute('accept', 'video/*,.mp4,.mov,.webm,.avi,.mkv,.m4v');
  videoUploadJobActive = true;

  try {
    sendVideoUploadProgress('выберите одно или несколько видео...', 0, 0, '');
    const files = await pickFilesForDreamFaceUpload(input);

    if (files.length === 0) {
      sendVideoUploadCompleted({
        canceled: true,
        uploadedCount: 0,
        failedCount: 0,
      });
      return { ok: true, status: 'canceled' };
    }

    let uploadedCount = 0;
    const failures = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      try {
        const uploadFile = addBorderEnabled
          ? await createPaddedVideoFile(file, index + 1, files.length)
          : file;
        const uploadResult = await uploadSingleVideoToDreamFace(uploadFile, index + 1, files.length, {
          identifySource: addBorderEnabled,
        });
        if (addBorderEnabled) {
          await markPaddedVideoSource(uploadResult.uploadedSource).catch((error) => {
            failures.push(`${file.name}: видео загружено, но маркер полосы не сохранён: ${error.message || String(error)}`);
          });
        }
        uploadedCount += 1;
      } catch (error) {
        failures.push(`${file.name}: ${error.message || String(error)}`);
        sendVideoUploadProgress(`[${index + 1}/${files.length}] ошибка загрузки ${file.name}`, index + 1, files.length, file.name);
      }
    }

    sendVideoUploadCompleted({
      canceled: false,
      uploadedCount,
      failedCount: failures.length,
      failures,
      error: failures[0] || '',
    });

    return {
      ok: true,
      status: failures.length > 0 ? 'partial' : 'success',
      uploadedCount,
      failedCount: failures.length,
      failures,
    };
  } finally {
    videoUploadJobActive = false;
    input.multiple = originalMultiple;
    if (!originalMultiple) {
      input.removeAttribute('multiple');
    }
    if (originalAccept) {
      input.setAttribute('accept', originalAccept);
    } else {
      input.removeAttribute('accept');
    }
  }
}

function waitForWindowEvent(eventName, timeout = 12000) {
  return new Promise((resolve, reject) => {
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      window.removeEventListener(eventName, handleEvent);
    };

    const handleEvent = () => {
      cleanup();
      resolve(true);
    };

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`${eventName} timeout`));
    }, timeout);

    window.addEventListener(eventName, handleEvent, { once: true });
  });
}

async function waitForSubmissionOutcomeWithTracker(
  maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS,
  timeoutMs = getSubmissionTimeoutMs(maxDurationSeconds),
  limitToastTracker = null,
  {
    clickAt = Date.now(),
    fetchStartTimeoutMs = 3500,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let intervalId = null;
    let timeoutId = null;

    const cleanup = () => {
      finished = true;
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      window.removeEventListener('DreamFaceTaskSuccess', onSuccess);
      window.removeEventListener('DreamFaceLimitHit', onLimit);
    };

    const resolveOnce = (value) => {
      if (finished) {
        return;
      }
      cleanup();
      resolve(value);
    };

    const rejectOnce = (error) => {
      if (finished) {
        return;
      }
      cleanup();
      reject(error);
    };

    const onSuccess = (event) => resolveOnce({
      status: 'success',
      animateImageId: event?.detail?.animateImageId || '',
    });
    const onLimit = () => resolveOnce({ status: 'limit' });

    window.addEventListener('DreamFaceTaskSuccess', onSuccess, { once: true });
    window.addEventListener('DreamFaceLimitHit', onLimit, { once: true });

    intervalId = setInterval(() => {
      try {
        ensureNotCancelled();

        if (serverSuccessHit) {
          resolveOnce({ status: 'success' });
          return;
        }

        if (serverLimitHit || limitToastTracker?.hasFreshLimitToast()) {
          resolveOnce({ status: 'limit' });
          return;
        }

        // fetch стартанул и упал сетевой ошибкой / HTTP-статусом
        if (lastSubmitFetchError && lastSubmitFetchStartedAt >= clickAt) {
          resolveOnce({
            status: 'fetch_failed',
            reason: lastSubmitFetchError,
          });
          return;
        }

        // click не дошёл до сети: за fetchStartTimeoutMs после клика
        // не было ни одного /task/v2/submit fetch. значит кнопка мертва.
        if (
          Date.now() - clickAt > fetchStartTimeoutMs
          && lastSubmitFetchStartedAt < clickAt
        ) {
          resolveOnce({ status: 'not_started' });
          return;
        }
      } catch (error) {
        rejectOnce(error);
      }
    }, 200);

    timeoutId = setTimeout(() => {
      // если fetch стартовал — это реально серверный timeout;
      // если не стартовал — считаем "not_started" (dm может пере-кликнуть)
      if (lastSubmitFetchStartedAt >= clickAt) {
        resolveOnce({ status: 'timeout' });
      } else {
        resolveOnce({ status: 'not_started' });
      }
    }, timeoutMs);
  });
}

async function verifySubmittedWorkAfterOutcome(runningWorksBefore, {
  timeoutMs = 10000,
  pollIntervalMs = 1200,
} = {}) {
  const workResolution = await resolveSubmittedWorkId(runningWorksBefore.ids, {
    baselineTrusted: Boolean(runningWorksBefore.ok),
    timeoutMs,
    pollIntervalMs,
  });

  return {
    submitted: Boolean(workResolution.workId) && !workResolution.ambiguous,
    ...workResolution,
  };
}

async function executeTaskOnPage(request) {
  activeTaskCancelled = false;
  serverLimitHit = false;
  serverSuccessHit = false;
  // запоминаем имя файла глобально, чтобы обработчик DreamFaceTaskSuccess
  // (он триггерится синхронно от fetch) сразу сохранил его в submitMeta.
  pendingAudioFileName = request.fileName || '';
  pendingBorderCropPx = Math.max(0, Math.floor(Number(request.borderCropPx) || 0));
  const maxDurationSeconds = getMaxDurationSeconds(request);

  const file = request.audioDataUrl
    ? await dataUrlToFile(request.audioDataUrl, request.fileName, request.mimeType || 'application/octet-stream')
    : new File([request.audioBlob], request.fileName, {
      type: request.mimeType || 'application/octet-stream',
    });

  const duration = await getAudioDuration(file);
  if (duration > 0 && duration < MIN_DURATION_SECONDS) {
    return { status: 'skipped_short' };
  }

  if (duration > maxDurationSeconds) {
    return { status: 'skipped_long' };
  }

  const audioTab = getElementByTextLoose(SEL.tabItem, ['Аудио', 'Audio']);
  if (audioTab && audioTab.getAttribute('data-state') !== 'true') {
    audioTab.click();
    await waitWithCancellation(500);
  }

  await selectVideoSafe(request.videoIndex);

  await clearExistingAudioSelection();

  const fileInput = await waitForAudioInputReady();
  if (!fileInput) {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
      .map((input) => input.getAttribute('accept') || '(no accept)')
      .join(', ');
    throw new Error(`поле загрузки аудио не найдено. input accept: ${inputs || 'none'}`);
  }

  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  fileInput.dispatchEvent(new Event('input', { bubbles: true }));

  const uploadResult = await waitForUploadReady(request.fileName);
  if (uploadResult.status === 'upload_error') {
    return {
      status: 'error',
      message: uploadResult.message,
    };
  }

  await waitWithCancellation(1500);

  if (isDurationErrorVisible(maxDurationSeconds)) {
    return { status: 'skipped_long' };
  }

  let generateButton = await waitForGenerateEnabled();

  // сколько раз пере-кликнуть Generate если click не породил ни одного submit fetch.
  // это спасает от ситуации: vue задизейблилась / event handler отвалился /
  // страница в поломанном состоянии из-за re-auth.
  const MAX_CLICK_RETRIES = 2;
  let clickRetries = 0;

  while (true) {
    ensureNotCancelled();

    serverLimitHit = false;
    serverSuccessHit = false;
    lastSubmitDetail = null;
    lastSubmitFetchStartedAt = 0;
    lastSubmitFetchError = null;
    const runningWorksBefore = await captureRunningWorksSnapshot();
    const limitToastTracker = createLimitToastTracker();

    // preflight: если открыта модалка (multi-face или ещё какая), click Generate
    // пойдёт "в кнопку под модалкой" — vue его молча съест. попытаемся закрыть
    // модалку или подождать пока сама закроется.
    const modalStatus = await handleBlockingModalBeforeSubmit();
    if (modalStatus.blocked) {
      return {
        status: 'submission_unconfirmed',
        message: modalStatus.message || 'модалка блокирует click Generate',
      };
    }

    const clickAt = Date.now();
    const wasDisabledBeforeClick = Boolean(generateButton.disabled);
    window.dispatchEvent(new CustomEvent('DreamFaceExtensionSubmitArm', {
      detail: { timeoutMs: 10000 },
    }));
    generateButton.click();

    let submissionOutcome;
    try {
      submissionOutcome = await waitForSubmissionOutcomeWithTracker(
        maxDurationSeconds,
        getSubmissionTimeoutMs(maxDurationSeconds),
        limitToastTracker,
        { clickAt, fetchStartTimeoutMs: 3500 },
      );
    } finally {
      limitToastTracker.disconnect();
    }

    // click потерялся — vue не среагировал на клик, fetch не начался.
    // пробуем ещё раз с пере-поиском кнопки; если ретраи кончились —
    // возвращаем детальную ошибку чтобы очередь встала осмысленно.
    if (submissionOutcome.status === 'not_started') {
      if (clickRetries < MAX_CLICK_RETRIES) {
        clickRetries += 1;
        console.warn('[dreamface] generate click did not produce submit fetch — retry', {
          attempt: clickRetries,
          wasDisabledBeforeClick,
          buttonNowDisabled: Boolean(generateButton?.disabled),
        });
        // ждём немного чтобы страница успокоилась
        await waitWithCancellation(1500);
        try {
          generateButton = await waitForGenerateEnabled();
        } catch (err) {
          return {
            status: 'submission_unconfirmed',
            message: `Generate button не активна после ${clickRetries} попыток: ${err.message}`,
          };
        }
        continue;
      }
      return {
        status: 'submission_unconfirmed',
        message: `клик Generate не запустил submit-запрос после ${MAX_CLICK_RETRIES + 1} попыток (кнопка "мёртвая"). ${wasDisabledBeforeClick ? 'кнопка была disabled перед кликом' : 'страница в поломанном состоянии — возможно, дреймфейс перезагружает сессию'}`,
      };
    }

    // fetch ушёл, но упал (сеть / 4xx / 5xx). не крутим retry click —
    // это уже ответственность сервера / сети. отдаём подробность.
    if (submissionOutcome.status === 'fetch_failed') {
      return {
        status: 'submission_unconfirmed',
        message: `submit-запрос упал: ${submissionOutcome.reason || 'unknown'}`,
      };
    }

    if (submissionOutcome.status === 'success') {
      const workResolution = await resolveSubmittedWorkId(runningWorksBefore.ids, {
        baselineTrusted: Boolean(runningWorksBefore.ok),
        timeoutMs: 10000,
        pollIntervalMs: 1200,
      });

      const animateImageId = submissionOutcome.animateImageId || lastSubmitDetail?.animateImageId || '';
      const workId = workResolution.workId || '';

      // связываем submit-мету с workId — пригодится при скачивании для chapters
      // и проставляем audioFileName из текущего request — это имя оригинального
      // аудио, оно нужно при скачивании, т.к. сайт отдаёт uuid вместо нормального имени
      if (animateImageId && submitMetaByAnimateId.has(animateImageId)) {
        const meta = submitMetaByAnimateId.get(animateImageId);
        if (request.fileName && !meta.audioFileName) {
          meta.audioFileName = request.fileName;
        }
        meta.borderCropPx = pendingBorderCropPx;
        if (workId) {
          submitMetaByWorkId.set(workId, meta);
        }
        persistSubmitMeta();
        console.log('[dreamface] submit meta linked to workId', {
          workId,
          animateImageId,
          audioMs: meta.audioMs,
          videoMs: meta.videoMs,
          audioFileName: meta.audioFileName,
        });
      } else if (workId && request.fileName) {
        // нет animate-меты (редкий случай), но есть workId и имя файла —
        // создадим минимальную мету только с именем для именования при скачивании
        submitMetaByWorkId.set(workId, {
          audioFileName: request.fileName,
          borderCropPx: pendingBorderCropPx,
          capturedAt: Date.now(),
        });
        persistSubmitMeta();
      }

      return {
        status: 'success',
        animateImageId,
        workId,
        workIdAmbiguous: Boolean(workResolution.ambiguous),
      };
    }

    if (submissionOutcome.status === 'limit' || submissionOutcome.status === 'timeout') {
      const recoveredSubmission = await verifySubmittedWorkAfterOutcome(runningWorksBefore, {
        timeoutMs: submissionOutcome.status === 'timeout' ? 15000 : 10000,
        pollIntervalMs: 1200,
      });

      if (recoveredSubmission.submitted) {
        const animateImageId = submissionOutcome.animateImageId || lastSubmitDetail?.animateImageId || '';
        const workId = recoveredSubmission.workId || '';
        if (animateImageId && submitMetaByAnimateId.has(animateImageId)) {
          const meta = submitMetaByAnimateId.get(animateImageId);
          if (request.fileName && !meta.audioFileName) {
            meta.audioFileName = request.fileName;
          }
          meta.borderCropPx = pendingBorderCropPx;
          if (workId) {
            submitMetaByWorkId.set(workId, meta);
          }
          persistSubmitMeta();
        } else if (workId && request.fileName) {
          submitMetaByWorkId.set(workId, {
            audioFileName: request.fileName,
            borderCropPx: pendingBorderCropPx,
            capturedAt: Date.now(),
          });
          persistSubmitMeta();
        }
        return {
          status: 'success',
          animateImageId,
          workId,
          workIdAmbiguous: Boolean(recoveredSubmission.ambiguous),
          recoveredAfter: submissionOutcome.status,
        };
      }

      if (recoveredSubmission.ambiguous) {
        return {
          status: 'submitted_unknown',
          message: 'после клика появилось несколько новых running works; нельзя надежно сопоставить задачу',
        };
      }
    }

    if (submissionOutcome.status === 'limit') {
      await waitWithCancellation(30000);
      generateButton = await waitForGenerateEnabled();
      continue;
    }

    if (submissionOutcome.status === 'timeout') {
      return {
        status: 'submission_unconfirmed',
        message: 'подтверждение отправки не получено вовремя',
      };
    }
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scanPageVideos') {
    dynamicScanVideos(sendResponse);
    return true;
  }

  if (request.action === 'startMultiVideoUploadPicker') {
    startMultiVideoUploadPicker({ addBorderEnabled: request.addBorderEnabled === true }).catch((error) => {
      sendVideoUploadCompleted({
        canceled: false,
        uploadedCount: 0,
        failedCount: 1,
        failures: [error.message || String(error)],
        error: error.message || String(error),
      });
    });
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === 'cancelActiveTask') {
    activeTaskCancelled = true;
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'executeTaskOnPage') {
    executeTaskOnPage(request).then((result) => {
      sendResponse(result);
    }).catch((error) => {
      if (error.code === 'task_cancelled') {
        sendResponse({ status: 'stopped' });
        return;
      }

      sendResponse({
        status: 'error',
        message: error.message || String(error),
      });
    });
    return true;
  }

  if (request.action === 'waitForCreationsDownload') {
    waitForCreationsDownload(request).then((result) => {
      sendResponse(result);
    }).catch((error) => {
      sendResponse({
        status: 'error',
        message: error.message || String(error),
      });
    });
    return true;
  }

  if (request.action === 'downloadCreationsIfReady') {
    downloadCreationsIfReady(request).then((result) => {
      sendResponse(result);
    }).catch((error) => {
      sendResponse({
        status: 'error',
        message: error.message || String(error),
      });
    });
    return true;
  }

  if (request.action === 'checkCreationsStatus') {
    Promise.resolve(checkCreationsStatus(request)).then((result) => {
      sendResponse(result);
    }).catch((error) => {
      sendResponse({
        status: 'error',
        message: error.message || String(error),
      });
    });
    return true;
  }

  // ============================================================
  // PRE-LOOP support: вытащить sourceUrl исходного видео + durationMs
  // ============================================================
  // Шаги:
  //   1) selectVideoSafe(index) — кликнуть нужную ячейку.
  //   2) дождаться в DOM <video src="https://...aliyuncs..."> в превью-плеере.
  //   3) сделать metadata-probe длительности.
  if (request.action === 'getVideoSourceUrlByIndex') {
    (async () => {
      try {
        const index = Number(request.videoIndex);
        if (!Number.isInteger(index) || index < 0) {
          throw new Error('некорректный videoIndex');
        }
        await selectVideoSafe(index);
        const url = await waitForPreviewVideoSrc(8000);
        if (!url) {
          throw new Error('не удалось получить mp4-URL исходного видео из превью');
        }
        let durationMs = 0;
        try {
          const seconds = await probeSourceVideoDuration(url);
          durationMs = Math.round(seconds * 1000);
        } catch (err) {
          console.warn('[dreamface] preLoop: probe duration fail', err.message);
        }
        sendResponse({ ok: true, url, durationMs });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  // ============================================================
  // PRE-LOOP support: залить pre-loop'ed mp4 (через blob:URL из offscreen)
  // в DreamFace как новый источник, дождаться появления в библиотеке,
  // вернуть индекс новой ячейки.
  // ============================================================
  if (request.action === 'uploadPreloopedVideo') {
    (async () => {
      try {
        const blobUrl = String(request.blobUrl || '');
        const fileName = String(request.fileName || `preloop-${Date.now()}.mp4`);
        if (!blobUrl) throw new Error('blobUrl пустой');

        const blob = await fetch(blobUrl).then((r) => r.blob());
        const file = new File([blob], fileName, { type: 'video/mp4' });

        // переиспользуем уже отлаженный upload-флоу.
        await uploadSingleVideoToDreamFace(file, 1, 1);

        // даём UI чуть-чуть отрендерить новую карточку (обычно она появляется
        // в самом конце сетки или в начале — зависит от сортировки сайта).
        await waitWithCancellation(800);

        // принудительно загружаем превью всех элементов, чтобы scan мог взять
        // карточку нового видео (иначе у новой ячейки img.src=пустой/placeholder).
        forceLoadThumbnails(AVATAR_DISPLAY_LIMIT);

        // ищем индекс новой ячейки. сайт показывает новое видео первым
        // в списке (порядок 'недавние'). если порядок поменялся — пробуем
        // искать по уникальному имени файла в alt/title (на текущий момент
        // не пишет, поэтому полагаемся на инкремент длины списка).
        // ВНИМАНИЕ: index в getValidVideoElements может меняться от запуска
        // к запуску (новые видео сверху). offscreen после upload должен
        // вызвать scanPageVideos и взять index из свежего списка.
        sendResponse({ ok: true, status: 'success' });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
    })();
    return true;
  }

  return false;
});

// Ждём появления <video src="https://..."> в DOM после selectVideoSafe.
// Возвращает строку URL или '' если не нашли за timeout.
async function waitForPreviewVideoSrc(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    ensureNotCancelled();
    const videos = Array.from(document.querySelectorAll('video'));
    for (const v of videos) {
      const src = v.currentSrc || v.src || '';
      // нас интересуют только настоящие OSS-URL'ы, не blob:/data:
      if (src && /^https?:\/\/.+(aliyuncs\.com|dreamfaceapp\.com)/i.test(src)) {
        return src;
      }
    }
    await sleep(150);
  }
  return '';
}

// ============================================================
// Toast «нативный download перехвачен в DownloadManager»
// ============================================================
//
// background.js слушает chrome.downloads.onCreated и перехватывает single
// download с dreamface OSS URL'ов (cancel + dm.enqueue). После успешного
// enqueue он шлёт нам уведомление чтобы показать toast.
//
// Multi-select на dreamfaceapp.com использует blob:URL (сайт сам качает байты
// и оборачивает) — этот случай мы не перехватываем. Пользователь может
// использовать popup-кнопку «скачать» для multi с гарантированными метаданными.

const DM_INTERCEPT_TOAST_ID = 'dreamface-dm-toast';
let dmInterceptToastTimer = null;

function showDmInterceptToast(message) {
  let toast = document.getElementById(DM_INTERCEPT_TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = DM_INTERCEPT_TOAST_ID;
    toast.style.cssText = [
      'position:fixed',
      'bottom:24px',
      'right:24px',
      'z-index:2147483647',
      'background:#1f2937',
      'color:#f9fafb',
      'padding:10px 14px',
      'border-radius:8px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'font-size:13px',
      'box-shadow:0 8px 24px rgba(0,0,0,0.32)',
      'max-width:360px',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  if (dmInterceptToastTimer) clearTimeout(dmInterceptToastTimer);
  dmInterceptToastTimer = setTimeout(() => {
    if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
    dmInterceptToastTimer = null;
  }, 4000);
}

// Listener для уведомлений от background об успешном перехвате.
chrome.runtime.onMessage.addListener((request) => {
  if (request?.action === 'dm.notifyIntercepted') {
    const fn = request.payload?.fileName || 'файл';
    const hasMeta = request.payload?.hasMeta;
    const tail = hasMeta ? ' с метаданными' : '';
    showDmInterceptToast(`скачивание перехвачено: ${fn}${tail}`);
  }
  // не отдаём sendResponse — это broadcast
  return false;
});

// ============================================================
// DOM-перехват клика на hover-кнопку Download в карточке /creation
// ============================================================
//
// Структура карточки (определено через playwright inspect):
//
//   <div class="_card_dog8w_1">
//     <div class="_img_box_dog8w_8">
//       <img alt="d10.mp3" src="...uuid_image.jpg">     ← work_name + animate_id
//       <div class="_operate_1jvc3_1 _buttons_dog8w_13">
//         <div class="_buttons_1jvc3_9">
//           <div class="_button_1jvc3_9">[svg arrow-down]</div>  ← DOWNLOAD кнопка
//           <button>[svg trash]</button>                          ← delete
//         </div>
//
// Сайт при клике на download-div строит <a href="OSS_URL" download="..."> и
// клик на нём — chrome качает через свой download manager (медленно).
//
// Multi-select (Скачать в toolbar) сайт делает свой собственный fetch + blob
// flow (быстрее), и НЕ требует нашего вмешательства — там всё уже работает.

// При загрузке content_script на /creation/user странице — заранее наполняем
// lastCreationsApiItems через recent_creation_list, чтобы hover-interceptor мог
// сразу резолвить workId из карточек.
async function primeCreationsApiSnapshot() {
  try {
    if (!/\/(creation|user)/i.test(location.pathname)) return;
    dmLog('log', 'primeCreationsApiSnapshot: start');
    // ждём injected.js до 10с (он патчит fetch и через какое-то время сайт сам делает запрос)
    // Берём большую первую страницу (100) — чтобы покрыть и старые работы юзера.
    let attempts = 0;
    while (attempts < 25) {
      attempts++;
      try {
        const body = await requestRecentCreationsPage({ page: 1, size: 100 });
        const list = Array.isArray(body?.data?.list) ? body.data.list : [];
        if (list.length > 0) {
          enrichSubmitMetaFromApiItems(list);
          dmLog('log', 'primeCreationsApiSnapshot: ok', { items: lastCreationsApiItems.length, attempts });
          return;
        }
      } catch (err) {
        // injected ещё не готов / template не захвачен — ждём
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    dmLog('warn', 'primeCreationsApiSnapshot: failed after', attempts, 'attempts');
  } catch {}
}

// Обновление snapshot в фоне (если устарел): каждый раз когда юзер делает что-то
// на странице — мы можем подтянуть свежий список. Не критично если упадёт.
let lastSnapshotRefreshAt = 0;
async function refreshCreationsSnapshot() {
  if (Date.now() - lastSnapshotRefreshAt < 5000) return; // не чаще раза в 5с
  lastSnapshotRefreshAt = Date.now();
  try {
    // тянем сразу несколько страниц, чтобы получить шире набор работ
    let totalAdded = 0;
    for (let page = 1; page <= 3; page++) {
      const body = await requestRecentCreationsPage({ page, size: 100 });
      const list = Array.isArray(body?.data?.list) ? body.data.list : [];
      if (list.length === 0) break;
      enrichSubmitMetaFromApiItems(list);
      totalAdded += list.length;
      if (list.length < 100) break;
    }
    dmLog('log', 'refreshCreationsSnapshot: ok', { totalAdded, snapshotSize: lastCreationsApiItems.length });
  } catch (err) {
    dmLog('warn', 'refreshCreationsSnapshot: failed', err.message);
  }
}

function installHoverDownloadInterceptor() {
  // защита от двойной установки при повторной инжекции content_script (SPA)
  if (document.documentElement.dataset.dmHoverInstalled === '1') {
    dmLog('log', 'hover-download interceptor already installed, skip');
    return;
  }
  document.documentElement.dataset.dmHoverInstalled = '1';
  dmLog('log', 'installing hover-download interceptor', { url: location.href });
  submitMetaHydrationPromise.finally(() => primeCreationsApiSnapshot());

  // Главный механизм: patched HTMLAnchorElement.click в injected.js шлёт
  // CustomEvent('DreamFaceAnchorClickIntercept') СИНХРОННО. Мы синхронно
  // решаем — берём ли скачивание на себя. Если да: preventDefault() и
  // асинхронно делаем dm.enqueue. Если нет: сайт получит свой нативный click.
  window.addEventListener('DreamFaceAnchorClickIntercept', (event) => {
    let detail;
    let safeDetail;
    try {
      detail = event.detail;
      if (!detail || typeof detail !== 'object'
        || typeof detail.href !== 'string'
        || typeof detail.download !== 'string'
        || typeof detail.ossUuid !== 'string'
        || typeof detail.fileName !== 'string') return;
      const url = new URL(detail.href);
      const hostname = url.hostname.toLowerCase();
      const isAllowedHost = hostname === 'dreamfaceapp.com'
        || hostname.endsWith('.dreamfaceapp.com')
        || hostname === 'aliyuncs.com'
        || hostname.endsWith('.aliyuncs.com');
      if (url.protocol !== 'https:' || !isAllowedHost) return;
      safeDetail = {
        href: url.href,
        download: detail.download,
        ossUuid: detail.ossUuid,
        fileName: detail.fileName,
      };
    } catch {
      return;
    }

    dmLog('log', 'anchor-click event received', {
      ossUuid: safeDetail.ossUuid, fileName: safeDetail.fileName, download: safeDetail.download.slice(0, 80),
      snapshotSize: lastCreationsApiItems.length,
    });

    // Маппинг: имя файла из OSS Content-Disposition (например "d10.mp3.mp4")
    // → ищем item с work_name="d10.mp3" (work_name без .mp4 расширения).
    const fileBase = safeDetail.fileName.replace(/\.mp4$/i, '');
    const matchingApiItems = lastCreationsApiItems.filter((it) => {
      if (!it?.work_name) return false;
      return it.work_name === fileBase || it.work_name === safeDetail.fileName;
    });
    const apiItem = matchingApiItems.length === 1 ? matchingApiItems[0] : null;

    if (!apiItem || !apiItem.id) {
      if (matchingApiItems.length === 0) {
        refreshCreationsSnapshot();
      }
      dmLog('warn', 'anchor-click: work_name unresolved, fallthrough',
        { fileName: safeDetail.fileName, fileBase, matches: matchingApiItems.length,
          snapshotSize: lastCreationsApiItems.length, sampleNames: lastCreationsApiItems.slice(0, 5).map((it) => it.work_name) });
      return;
    }

    // После передачи DownloadManager нативный путь больше нельзя запускать:
    // потерянный runtime-ответ не означает, что enqueue не был принят.
    event.preventDefault();
    if (!event.defaultPrevented) return;
    Promise.allSettled([processingSettingsHydrationPromise, submitMetaHydrationPromise]).then(() => {
      const workId = String(apiItem.id);
      const workName = apiItem.work_name;
      const animateId = String(apiItem.animate_id || '');
      dmLog('log', 'anchor-click intercepted', { workId, workName, animateId });

      // Используем готовый URL из <a href> напрямую — сайт уже получил OSS-подписанный URL.
      // Если у нас есть мета (audioMs/videoMs) — добавим chapters; иначе direct.
      let meta = submitMetaByWorkId.get(workId) || null;
      if (!meta && animateId) {
        const fromAnimate = submitMetaByAnimateId.get(animateId);
        if (fromAnimate) {
          meta = { ...fromAnimate };
          submitMetaByWorkId.set(workId, meta);
          persistSubmitMeta();
        }
      }
      const audioFileName = (meta?.audioFileName || '').trim();
      const items = [{
        workId,
        workName: audioFileName || workName,
        audioFileName: audioFileName || '',
        url: safeDetail.href,
        audioMs: meta?.audioMs ?? null,
        videoMs: meta?.videoMs ?? null,
        hasChapters: Boolean(meta && Number.isFinite(meta.audioMs) && Number.isFinite(meta.videoMs)
          && meta.videoMs > 0 && meta.audioMs > meta.videoMs),
      }];

      // асинхронный dm.enqueue
      chrome.runtime.sendMessage({
        action: 'dm.enqueue',
        payload: { items },
      }).then((resp) => {
        if (resp?.ok) {
          const tail = items[0].hasChapters ? ' с метаданными' : '';
          showDmInterceptToast(`в очередь: ${items[0].workName}${tail}`);
        } else {
          showDmInterceptToast('ошибка постановки в очередь');
          dmLog('error', 'dm.enqueue rejected', resp?.error || 'unknown error');
        }
      }).catch((err) => {
        console.error('[dreamface] dm.enqueue failed:', err);
        showDmInterceptToast('ошибка: ' + err.message);
        dmLog('error', 'dm.enqueue outcome unknown; native fallback suppressed', err.message);
      });
    });
  });
}

// installation: при загрузке DOM и при SPA-навигации
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installHoverDownloadInterceptor);
} else {
  installHoverDownloadInterceptor();
}
