// --- START OF FILE injected.js ---

(function() {
  const LIMIT_TOKENS = [
    '10 tasks',
    'processing your existing',
    'limit reached',
  ];
  const RECENT_CREATIONS_PATH = '/dw-server/work/v2/get_recent_creation_list';

  const originalFetch = window.fetch;
  let recentCreationsTemplate = null;

  function getUrlFromFetchArg(fetchArg) {
    if (!fetchArg) return '';
    if (typeof fetchArg === 'string') return fetchArg;
    if (fetchArg.url) return fetchArg.url;
    return String(fetchArg);
  }

  function headersToObject(headersLike) {
    if (!headersLike) return {};

    if (headersLike instanceof Headers) {
      return Object.fromEntries(headersLike.entries());
    }

    if (Array.isArray(headersLike)) {
      return Object.fromEntries(headersLike);
    }

    if (typeof headersLike === 'object') {
      return { ...headersLike };
    }

    return {};
  }

  function getFetchInitSnapshot(args) {
    const [input, init = {}] = args;
    const request = input instanceof Request ? input : null;
    const requestHeaders = headersToObject(request?.headers);
    const initHeaders = headersToObject(init?.headers);

    return {
      url: getUrlFromFetchArg(input),
      method: init?.method || request?.method || 'GET',
      headers: { ...requestHeaders, ...initHeaders },
      body: typeof init?.body === 'string' ? init.body : null,
      referrer: init?.referrer || request?.referrer || document.referrer || location.href,
      credentials: init?.credentials || request?.credentials || 'include',
      mode: init?.mode || request?.mode || 'cors',
    };
  }

  function tryParseJson(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function rememberRecentCreationsTemplate(args) {
    const snapshot = getFetchInitSnapshot(args);
    const body = tryParseJson(snapshot.body);
    if (!body || !body.account_id || !body.user_id) {
      return;
    }

    recentCreationsTemplate = {
      headers: snapshot.headers,
      body,
      referrer: snapshot.referrer || location.href,
      credentials: snapshot.credentials || 'include',
      mode: snapshot.mode || 'cors',
      url: snapshot.url,
    };
  }

  async function fetchRecentCreationsPage(page = 1, size = 30) {
    if (!recentCreationsTemplate) {
      throw new Error('recent creations request template unavailable');
    }

    const baseBody = recentCreationsTemplate.body || {};
    const payload = {
      ...baseBody,
      page,
      size,
      is_web: true,
      app_version: baseBody.app_version || '4.7.1',
    };
    const headers = new Headers(recentCreationsTemplate.headers || {});

    if (!headers.has('accept')) {
      headers.set('accept', 'application/json');
    }
    headers.set('content-type', 'application/json');
    if (!headers.has('dream-face-web')) {
      headers.set('dream-face-web', 'dream-face-web');
    }

    const endpointUrl = recentCreationsTemplate.url && recentCreationsTemplate.url.includes(RECENT_CREATIONS_PATH)
      ? recentCreationsTemplate.url
      : `${location.origin}${RECENT_CREATIONS_PATH}`;

    const response = await originalFetch(endpointUrl, {
      method: 'POST',
      headers,
      referrer: recentCreationsTemplate.referrer || location.href,
      body: JSON.stringify(payload),
      mode: recentCreationsTemplate.mode || 'cors',
      credentials: recentCreationsTemplate.credentials || 'include',
    });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(body?.status_msg || `recent creations request failed: ${response.status}`);
    }

    if (!body || body.status_msg !== 'Success') {
      throw new Error(body?.status_msg || 'recent creations response is not successful');
    }

    return body;
  }

  function looksLikeSubmitSuccess(body) {
    if (!body) return false;
    
    // Проверяем status_msg (стандартный формат)
    if (body.status_msg === 'Success' || body.status_msg === 'success') return true;
    
    // Проверяем status (альтернативный формат)
    if (body.status === 'Success' || body.status === 'success' || body.status === 'SUCCESS') return true;
    
    // Проверяем код ответа
    if (body.code === 0 || body.code === '0' || body.code === 200) return true;
    
    // Проверяем success флаг
    if (body.success === true) return true;
    
    return false;
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

  window.addEventListener('DreamFaceRecentCreationsRequest', async (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId;

    if (!requestId) {
      return;
    }

    try {
      const body = await fetchRecentCreationsPage(Number(detail.page) || 1, Number(detail.size) || 30);
      window.dispatchEvent(new CustomEvent('DreamFaceRecentCreationsResponse', {
        detail: {
          requestId,
          ok: true,
          body,
        },
      }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('DreamFaceRecentCreationsResponse', {
        detail: {
          requestId,
          ok: false,
          error: error?.message || String(error),
        },
      }));
    }
  });

  window.fetch = async function(...args) {
    const url = getUrlFromFetchArg(args[0]);
    const isSubmit = url.includes('/task/v2/submit');
    const isAvatarAdd = url.includes('/df-server/avatar/add');
    const isRecentCreations = url.includes(RECENT_CREATIONS_PATH);

    if (isRecentCreations) {
      rememberRecentCreationsTemplate(args);
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
