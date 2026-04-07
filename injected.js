// --- START OF FILE injected.js ---

(function() {
  const WEB_MODE = 'web';
  const APPLE_EXPERIMENTAL_MODE = 'apple_experimental';
  const APPLE_APP_VERSION = '6.24.10';
  const APPLE_SYSTEM_NAME = 'iPadOS';
  const APPLE_SYSTEM_VERSION = '16.6';
  const APPLE_MODEL_NAME = 'iPad Pro (12.9-inch) (3rd generation)';
  const LIMIT_TOKENS = [
    '10 tasks',
    'processing your existing',
    'limit reached',
  ];

  const originalFetch = window.fetch;
  let submitMode = WEB_MODE;

  function normalizeMode(mode) {
    return mode === APPLE_EXPERIMENTAL_MODE ? APPLE_EXPERIMENTAL_MODE : WEB_MODE;
  }

  function getUrlFromFetchArg(fetchArg) {
    if (!fetchArg) {
      return '';
    }

    if (typeof fetchArg === 'string') {
      return fetchArg;
    }

    if (fetchArg.url) {
      return fetchArg.url;
    }

    return String(fetchArg);
  }

  function containsPath(url, pathPart) {
    return typeof url === 'string' && url.includes(pathPart);
  }

  function looksLikeSubmitSuccess(body) {
    return Boolean(body && (body.status_msg === 'Success' || body.status_msg === 'success'));
  }

  function looksLikeSubmitLimit(body) {
    const jsonString = JSON.stringify(body || {}).toLowerCase();
    return LIMIT_TOKENS.some((token) => jsonString.includes(token));
  }

  function emitSubmitSignals(body) {
    if (looksLikeSubmitSuccess(body)) {
      window.dispatchEvent(new CustomEvent('DreamFaceTaskSuccess'));
    }

    if (looksLikeSubmitLimit(body)) {
      window.dispatchEvent(new CustomEvent('DreamFaceLimitHit'));
    }
  }

  function processSubmitResponse(response) {
    response.clone().json().then((body) => {
      emitSubmitSignals(body);
    }).catch(() => {});
  }

  function processAvatarAddResponse(response) {
    response.clone().json().then((body) => {
      const jsonString = JSON.stringify(body || {}).toLowerCase();
      const looksSuccessful = response.ok
        && !jsonString.includes('error')
        && !jsonString.includes('fail');

      if (looksSuccessful) {
        window.dispatchEvent(new CustomEvent('DreamFaceAvatarAdded'));
      }
    }).catch(() => {
      if (response.ok) {
        window.dispatchEvent(new CustomEvent('DreamFaceAvatarAdded'));
      }
    });
  }

  async function readJsonBodySafe(response) {
    try {
      return await response.clone().json();
    } catch (_) {
      return null;
    }
  }

  async function readRequestBodyText(fetchArg, fetchInit) {
    if (fetchInit && typeof fetchInit.body === 'string') {
      return fetchInit.body;
    }

    if (fetchInit && fetchInit.body && typeof fetchInit.body.toString === 'function') {
      const asString = fetchInit.body.toString();
      if (typeof asString === 'string' && asString !== '[object Object]') {
        return asString;
      }
    }

    if (typeof Request !== 'undefined' && fetchArg instanceof Request) {
      try {
        return await fetchArg.clone().text();
      } catch (_) {
        return '';
      }
    }

    return '';
  }

  function buildExperimentalHeaders(fetchArg, fetchInit) {
    const baseHeaders = new Headers(
      (fetchInit && fetchInit.headers)
      || (typeof Request !== 'undefined' && fetchArg instanceof Request ? fetchArg.headers : undefined)
      || {},
    );

    baseHeaders.set('Platform-Type', 'APPLE');
    baseHeaders.set('System-Name', APPLE_SYSTEM_NAME);
    baseHeaders.set('System-Version', APPLE_SYSTEM_VERSION);
    baseHeaders.set('App-Version', APPLE_APP_VERSION);
    baseHeaders.set('Model-Name', APPLE_MODEL_NAME);

    return baseHeaders;
  }

  function cloneInitFromRequest(fetchArg, fetchInit) {
    if (fetchInit) {
      return { ...fetchInit };
    }

    if (typeof Request !== 'undefined' && fetchArg instanceof Request) {
      return {
        method: fetchArg.method,
        credentials: fetchArg.credentials,
        cache: fetchArg.cache,
        mode: fetchArg.mode,
        redirect: fetchArg.redirect,
        referrer: fetchArg.referrer,
        referrerPolicy: fetchArg.referrerPolicy,
        integrity: fetchArg.integrity,
        keepalive: fetchArg.keepalive,
      };
    }

    return {};
  }

  function patchSubmitPayloadForExperimentalMode(payload) {
    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    const nextPayload = { ...payload };
    const nextUser = { ...(nextPayload.user || {}) };

    // DreamFace has switched between snake_case and camelCase keys over time.
    nextUser.platform_type = 'APPLE';
    nextUser.platformType = 'APPLE';
    if (!nextUser.app_version && !nextUser.appVersion) {
      nextUser.app_version = APPLE_APP_VERSION;
    }

    nextPayload.user = nextUser;
    return nextPayload;
  }

  async function tryExperimentalSubmit(fetchArg, fetchInit) {
    const submitUrl = getUrlFromFetchArg(fetchArg);
    const bodyText = await readRequestBodyText(fetchArg, fetchInit);
    if (!bodyText) {
      return null;
    }

    let parsedBody = null;
    try {
      parsedBody = JSON.parse(bodyText);
    } catch (_) {
      return null;
    }

    const patchedBody = patchSubmitPayloadForExperimentalMode(parsedBody);
    const experimentalInit = cloneInitFromRequest(fetchArg, fetchInit);
    experimentalInit.method = (experimentalInit.method || 'POST').toUpperCase();
    experimentalInit.headers = buildExperimentalHeaders(fetchArg, fetchInit);
    experimentalInit.body = JSON.stringify(patchedBody);

    let experimentalResponse = null;
    try {
      experimentalResponse = await originalFetch(submitUrl, experimentalInit);
    } catch (_) {
      return null;
    }

    const responseBody = await readJsonBodySafe(experimentalResponse);
    if (responseBody) {
      emitSubmitSignals(responseBody);
      if (looksLikeSubmitSuccess(responseBody) || looksLikeSubmitLimit(responseBody)) {
        return experimentalResponse;
      }
    } else if (experimentalResponse.ok) {
      processSubmitResponse(experimentalResponse);
      return experimentalResponse;
    }

    return null;
  }

  window.addEventListener('DreamFaceSetSubmitMode', (event) => {
    submitMode = normalizeMode(event?.detail?.mode);
  });

  window.fetch = async function(...args) {
    const url = getUrlFromFetchArg(args[0]);
    const isSubmit = containsPath(url, '/task/v2/submit');
    const isAvatarAdd = containsPath(url, '/df-server/avatar/add');

    if (isSubmit && submitMode === APPLE_EXPERIMENTAL_MODE) {
      const experimentalResponse = await tryExperimentalSubmit(args[0], args[1]);
      if (experimentalResponse) {
        return experimentalResponse;
      }
    }

    const response = await originalFetch(...args);

    if (isSubmit) {
      processSubmitResponse(response);
    }

    if (isAvatarAdd) {
      processAvatarAddResponse(response);
    }

    return response;
  };
})();
