// --- START OF FILE injected.js ---

(function() {
  const LIMIT_TOKENS = [
    '10 tasks',
    'processing your existing',
    'limit reached',
  ];

  const originalFetch = window.fetch;

  function getUrlFromFetchArg(fetchArg) {
    if (!fetchArg) return '';
    if (typeof fetchArg === 'string') return fetchArg;
    if (fetchArg.url) return fetchArg.url;
    return String(fetchArg);
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

  window.fetch = async function(...args) {
    const url = getUrlFromFetchArg(args[0]);
    const isSubmit = url.includes('/task/v2/submit');
    const isAvatarAdd = url.includes('/df-server/avatar/add');

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
