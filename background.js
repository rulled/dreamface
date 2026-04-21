const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const RUN_STATE_KEY = 'dreamfaceRunState';
const DEFAULT_MAX_DURATION_SECONDS = 180;
const CREATIONS_URL = 'https://www.dreamfaceapp.com/ru/creation?type=Avatar+Video';
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

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });

  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (offscreenCreationPromise) {
    return offscreenCreationPromise;
  }

  offscreenCreationPromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['WORKERS', 'BLOBS'],
    justification: 'Normalize audio in a persistent extension context and keep queue execution alive when the popup closes.',
  }).catch(async (error) => {
    if (String(error?.message || error).includes('Only a single offscreen document')) {
      return;
    }

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

async function sendPageAction(tabId, action, payload = {}) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { action, ...payload }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

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
  if (!existing) {
    throw new Error('tab not found');
  }

  if (existing.status === 'complete') {
    return existing;
  }

  return new Promise((resolve, reject) => {
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      chrome.tabs.onUpdated.removeListener(handleUpdate);
      chrome.tabs.onRemoved.removeListener(handleRemoved);
    };

    const handleRemoved = (removedTabId) => {
      if (removedTabId !== tabId) {
        return;
      }

      cleanup();
      reject(new Error('tab removed'));
    };

    const handleUpdate = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) {
        return;
      }

      if (changeInfo.status === 'complete') {
        cleanup();
        resolve(tab);
      }
    };

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('tab load timeout'));
    }, timeoutMs);

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
    tab = await chrome.tabs.create({
      url: CREATIONS_URL,
      active: false,
    });
  }

  tab = await waitForTabComplete(tab.id);

  return {
    id: tab.id,
    url: tab.url,
    status: tab.status,
    discarded: Boolean(tab.discarded),
  };
}

function notifyDreamFaceTabs(message) {
  chrome.tabs.query({ url: DREAMFACE_URL_PATTERNS }, (tabs) => {
    tabs.forEach((tab) => {
      if (!tab.id) {
        return;
      }

      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target === 'offscreen') {
    return false;
  }

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

      case 'engine.getTabSnapshot': {
        const tab = await chrome.tabs.get(request.tabId).catch(() => null);
        sendResponse({
          ok: true,
          tab: tab ? {
            id: tab.id,
            url: tab.url,
            status: tab.status,
            discarded: Boolean(tab.discarded),
          } : null,
        });
        return;
      }

      case 'engine.ensureCreationsTab': {
        const tab = await ensureCreationsTab();
        sendResponse({ ok: true, tab });
        return;
      }

      default:
        sendResponse({ ok: false, error: `Unknown action: ${request.action}` });
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});

chrome.tabs.onCreated.addListener(() => {
  notifyDreamFaceTabs({ action: 'newTabOpened' });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.runtime.sendMessage({
    target: 'offscreen',
    action: 'tabLifecycle',
    payload: {
      event: 'removed',
      tabId,
    },
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.status && typeof changeInfo.discarded === 'undefined' && !changeInfo.url) {
    return;
  }

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
  await persistRunState(createIdleRunState());
  await ensureOffscreenDocument().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument().catch(() => {});
});
