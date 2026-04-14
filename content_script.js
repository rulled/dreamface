let newTabDetected = false;
let serverLimitHit = false;
let serverSuccessHit = false;
let avatarAddSuccessHit = false;
let activeTaskCancelled = false;
let videoUploadJobActive = false;
const MIN_DURATION_SECONDS = 2;
const DEFAULT_MAX_DURATION_SECONDS = 180;
const AVATAR_DISPLAY_LIMIT = 200;

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

const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
script.onload = function onLoad() {
  this.remove();
};
(document.head || document.documentElement).appendChild(script);

window.addEventListener('DreamFaceLimitHit', () => {
  serverLimitHit = true;
});

window.addEventListener('DreamFaceTaskSuccess', () => {
  serverSuccessHit = true;
});

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

function findGenerateButton() {
  const buttons = Array.from(document.querySelectorAll('button'));
  return buttons.find((btn) => {
    const text = btn.textContent.trim().toLowerCase();
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
    const accept = input.getAttribute('accept') || '';
    return looksLikeVideoAccept(accept) || (looksLikeImageAccept(accept) && looksLikeVideoAccept(accept));
  }) || null;
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

function isLimitErrorVisible() {
  const toasts = Array.from(document.querySelectorAll(SEL.toastError));

  return toasts.some((toast) => {
    const desc = toast.getAttribute('description') || '';
    const text = toast.textContent || '';
    return desc.includes('10 tasks')
      || desc.includes('Processing your existing')
      || text.includes('10 tasks')
      || text.includes('Processing your existing');
  });
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

async function ensureCreationsCardsLoaded(request, { timeoutMs = 6000 } = {}) {
  const expectedFileNames = Array.isArray(request?.expectedFileNames)
    ? request.expectedFileNames.filter(Boolean)
    : [];

  let cards = getCreationCards();
  let selection = getLatestMatchingCreationCards(expectedFileNames, request?.startedAt);
  let lastSignature = getCreationsCardsSignature(cards);
  let stableIterations = 0;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (selection.ready && selection.cards.length > 0) {
      return selection;
    }

    const advanced = await advanceCreationsList(cards);
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

async function getCreationsSelectionSnapshot(request, { loadMore = false, timeoutMs = 6000 } = {}) {
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
    ? await ensureCreationsCardsLoaded(request, { timeoutMs })
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

async function checkCreationsStatus(request) {
  const snapshot = await getCreationsSelectionSnapshot(request, {
    loadMore: true,
    timeoutMs: 5000,
  });

  if (snapshot.status === 'error' || snapshot.status === 'pending') {
    return snapshot;
  }

  if (snapshot.status === 'partial') {
    return {
      status: 'partial',
      matchedCount: snapshot.selection.cards.length,
      totalExpected: snapshot.totalExpected,
      readyFiles: snapshot.selection.cards.map((item) => item.name),
      pending: [...snapshot.pending],
    };
  }

  return {
    status: 'ready',
    matchedCount: snapshot.selection.cards.length,
    totalExpected: snapshot.totalExpected,
    readyFiles: snapshot.selection.cards.map((item) => item.name),
    pending: [],
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

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1000, deadline - Date.now());
    const selection = await ensureCreationsCardsLoaded(request, {
      timeoutMs: Math.min(12000, remainingMs),
    });

    if (selection.ready && selection.cards.length > 0) {
      readySelection = selection;
      break;
    }

    await waitWithCancellation(Math.min(1500, remainingMs));
  }

  if (!readySelection) {
    const finalPending = getLatestMatchingCreationCards(expectedFileNames, request.startedAt);
    return {
      status: 'error',
      message: `не удалось дождаться карточек: ${finalPending.pending.join(', ') || 'timeout'}`,
    };
  }

  await closeOpenCreationsDialog();
  await ensureCreationsSelectMode();
  await waitWithCancellation(300);

  const finalSelection = await ensureCreationsCardsLoaded(request, { timeoutMs: 12000 });
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

  downloadControl.click();
  await waitWithCancellation(1000);

  return {
    status: 'success',
    downloadedCount: finalSelection.cards.length,
    files: finalSelection.cards.map((item) => item.name),
  };
}

async function downloadCreationsIfReady(request) {
  const snapshot = await getCreationsSelectionSnapshot(request, {
    loadMore: true,
    timeoutMs: 12000,
  });
  if (snapshot.status === 'error') {
    return snapshot;
  }

  if (snapshot.status === 'pending') {
    return snapshot;
  }

  await closeOpenCreationsDialog();
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

  downloadControl.click();
  await waitWithCancellation(1000);

  if (snapshot.status === 'partial') {
    return {
      status: 'partial',
      downloadedCount: snapshot.selection.cards.length,
      files: snapshot.selection.cards.map((item) => item.name),
      pending: [...snapshot.pending],
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

function forceLoadThumbnails() {
  const validElements = getValidVideoElements();
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
  let skippedWithoutCover = 0;

  const allElements = getValidVideoElements().slice(0, MAX_SCAN_VIDEOS);
  allElements.forEach((el, index) => {
    const img = el.querySelector('img');
    if (!img) {
      return;
    }

    const src = img.getAttribute('src') || img.getAttribute('data-src');
    if (src && (src.includes('material') || img.complete)) {
      videos.push({ index, src });
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

async function uploadSingleVideoToDreamFace(file, current, total) {
  const input = findVideoUploadInput();
  if (!input) {
    throw new Error('поле загрузки видео не найдено');
  }

  const previousCount = getValidVideoElements().length;
  avatarAddSuccessHit = false;
  sendVideoUploadProgress(`[${current}/${total}] загрузка видео ${file.name}`, current, total, file.name);

  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  await waitForVideoUploadOutcome(previousCount, file);
  sendVideoUploadProgress(`[${current}/${total}] видео загружено: ${file.name}`, current, total, file.name);
  await waitWithCancellation(800);

  return { status: 'success' };
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

async function startMultiVideoUploadPicker() {
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
        await uploadSingleVideoToDreamFace(file, index + 1, files.length);
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

async function waitForSubmissionOutcome(maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS) {
  const startedAt = Date.now();
  const timeoutMs = getSubmissionTimeoutMs(maxDurationSeconds);
  
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

    const onSuccess = () => resolveOnce({ status: 'success' });
    const onLimit = () => resolveOnce({ status: 'limit' });

    window.addEventListener('DreamFaceTaskSuccess', onSuccess, { once: true });
    window.addEventListener('DreamFaceLimitHit', onLimit, { once: true });

    intervalId = setInterval(() => {
      try {
        ensureNotCancelled();

        if (serverSuccessHit || newTabDetected) {
          resolveOnce({ status: 'success' });
          return;
        }

        if (serverLimitHit || isLimitErrorVisible()) {
          resolveOnce({ status: 'limit' });
          return;
        }

        const generateButton = findGenerateButton();
        if (
          generateButton
          && generateButton.disabled
          && Date.now() - startedAt > 3500
          && !serverLimitHit
          && !isLimitErrorVisible()
        ) {
          resolveOnce({ status: 'success' });
        }
      } catch (error) {
        rejectOnce(error);
      }
    }, 200);

    timeoutId = setTimeout(() => {
      resolveOnce({ status: 'timeout' });
    }, timeoutMs);
  });
}

async function executeTaskOnPage(request) {
  activeTaskCancelled = false;
  newTabDetected = false;
  serverLimitHit = false;
  serverSuccessHit = false;
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

  const delBtn = document.querySelector('div[class*="_del_"]');
  if (delBtn) {
    delBtn.click();
    const cleared = await waitForAudioReadyCleared();
    if (!cleared) {
      await waitWithCancellation(1200);
    }
  }

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

  while (true) {
    ensureNotCancelled();

    newTabDetected = false;
    serverLimitHit = false;
    serverSuccessHit = false;

    generateButton.click();

    const submissionOutcome = await waitForSubmissionOutcome(maxDurationSeconds);
    
    if (submissionOutcome.status === 'success') {
      return { status: 'success' };
    }

    if (submissionOutcome.status === 'limit') {
      await waitWithCancellation(30000);
      generateButton = await waitForGenerateEnabled();
      continue;
    }

    if (submissionOutcome.status === 'timeout') {
      return {
        status: 'submitted_unknown',
        message: 'подтверждение отправки не получено вовремя',
      };
    }
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'newTabOpened') {
    newTabDetected = true;
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'scanPageVideos') {
    dynamicScanVideos(sendResponse);
    return true;
  }

  if (request.action === 'startMultiVideoUploadPicker') {
    startMultiVideoUploadPicker().catch((error) => {
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

  return false;
});
