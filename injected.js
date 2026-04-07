// --- START OF FILE injected.js ---

(function() {
  const LIMIT_TOKENS = [
    '10 tasks',
    'processing your existing',
    'limit reached',
  ];

  const originalFetch = window.fetch;

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

  window.fetch = async function(...args) {
    const url = getUrlFromFetchArg(args[0]);
    const isSubmit = containsPath(url, '/task/v2/submit');
    const isAvatarAdd = containsPath(url, '/df-server/avatar/add');

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
