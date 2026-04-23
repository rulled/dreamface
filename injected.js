// --- START OF FILE injected.js ---

(function() {
  const LIMIT_TOKENS = [
    '10 tasks',
    'processing your existing',
    'limit reached',
  ];
  const RECENT_CREATIONS_PATH = '/dw-server/work/v2/get_recent_creation_list';
  const BATCH_WORK_STATUS_PATH = '/dw-server/work/batch_get_work_status';
  const RUNNING_WORKS_PATH = '/dw-server/work/get_user_running_works/';

  const originalFetch = window.fetch;
  let recentCreationsTemplate = null;
  let batchWorkStatusTemplate = null;
  let runningWorksTemplate = null;
  let submitContext = null;

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

  function rememberBatchWorkStatusTemplate(args) {
    const snapshot = getFetchInitSnapshot(args);
    const body = tryParseJson(snapshot.body);
    if (!body || !body.account_id || !Array.isArray(body.ids)) {
      return;
    }

    batchWorkStatusTemplate = {
      headers: snapshot.headers,
      body,
      referrer: snapshot.referrer || location.href,
      credentials: snapshot.credentials || 'include',
      mode: snapshot.mode || 'cors',
      url: snapshot.url,
    };
  }

  function rememberSubmitContext(args) {
    const snapshot = getFetchInitSnapshot(args);
    const body = tryParseJson(snapshot.body);
    const accountId = body?.user?.account_id;
    if (!accountId) {
      return;
    }

    submitContext = {
      headers: snapshot.headers,
      referrer: snapshot.referrer || location.href,
      credentials: snapshot.credentials || 'include',
      mode: snapshot.mode || 'cors',
      accountId,
      url: `${location.origin}${RUNNING_WORKS_PATH}${accountId}`,
    };
  }

  function rememberRunningWorksTemplate(args) {
    const snapshot = getFetchInitSnapshot(args);
    const accountId = String(snapshot.url || '').split(RUNNING_WORKS_PATH)[1] || '';
    if (!accountId) {
      return;
    }

    runningWorksTemplate = {
      headers: snapshot.headers,
      referrer: snapshot.referrer || location.href,
      credentials: snapshot.credentials || 'include',
      mode: snapshot.mode || 'cors',
      accountId,
      url: snapshot.url,
    };
  }

  function getRunningWorksContext() {
    const accountId = runningWorksTemplate?.accountId
      || recentCreationsTemplate?.body?.account_id
      || batchWorkStatusTemplate?.body?.account_id
      || submitContext?.accountId;

    if (!accountId) {
      return null;
    }

    const template = runningWorksTemplate
      || submitContext
      || recentCreationsTemplate
      || batchWorkStatusTemplate;

    return {
      headers: template?.headers || {},
      referrer: template?.referrer || location.href,
      credentials: template?.credentials || 'include',
      mode: template?.mode || 'cors',
      accountId,
      url: runningWorksTemplate?.url || `${location.origin}${RUNNING_WORKS_PATH}${accountId}`,
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

  async function fetchBatchWorkStatus(ids) {
    const safeIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (safeIds.length === 0) {
      return {
        status_code: 'THS12140000000',
        status_msg: 'Success',
        data: [],
      };
    }

    const template = batchWorkStatusTemplate || recentCreationsTemplate;
    if (!template) {
      throw new Error('batch work status request template unavailable');
    }

    const headers = new Headers(template.headers || {});
    if (!headers.has('accept')) {
      headers.set('accept', 'application/json');
    }
    headers.set('content-type', 'application/json');
    if (!headers.has('dream-face-web')) {
      headers.set('dream-face-web', 'dream-face-web');
    }

    const payload = {
      account_id: template.body?.account_id,
      ids: safeIds,
    };

    if (!payload.account_id) {
      throw new Error('account_id is missing for batch work status');
    }

    const endpointUrl = batchWorkStatusTemplate?.url && batchWorkStatusTemplate.url.includes(BATCH_WORK_STATUS_PATH)
      ? batchWorkStatusTemplate.url
      : `${location.origin}${BATCH_WORK_STATUS_PATH}`;

    const response = await originalFetch(endpointUrl, {
      method: 'POST',
      headers,
      referrer: template.referrer || location.href,
      body: JSON.stringify(payload),
      mode: template.mode || 'cors',
      credentials: template.credentials || 'include',
    });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(body?.status_msg || `batch work status request failed: ${response.status}`);
    }

    if (!body || body.status_msg !== 'Success') {
      throw new Error(body?.status_msg || 'batch work status response is not successful');
    }

    return body;
  }

  async function fetchRunningWorks() {
    const context = getRunningWorksContext();
    if (!context) {
      throw new Error('running works request template unavailable');
    }

    const headers = new Headers(context.headers || {});
    if (!headers.has('accept')) {
      headers.set('accept', 'application/json');
    }
    if (!headers.has('dream-face-web')) {
      headers.set('dream-face-web', 'dream-face-web');
    }

    const response = await originalFetch(context.url, {
      method: 'GET',
      headers,
      referrer: context.referrer || location.href,
      mode: context.mode || 'cors',
      credentials: context.credentials || 'include',
    });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(body?.status_msg || `running works request failed: ${response.status}`);
    }

    if (!body || body.status_msg !== 'Success') {
      throw new Error(body?.status_msg || 'running works response is not successful');
    }

    return body;
  }

  function looksLikeSubmitSuccess(body) {
    if (!body) return false;

    if (looksLikeSubmitLimit(body)) return false;

    if (body.status_msg === 'Success' || body.status_msg === 'success') return true;
    if (body.status === 'Success' || body.status === 'success' || body.status === 'SUCCESS') return true;
    if (body.success === true) return true;
    if (body.code === 0 || body.code === '0') return true;

    return Boolean(
      body?.data?.animate_image_id
      || body?.data?.work_id
      || body?.data?.workId
      || body?.data?.id
    );
  }

  function looksLikeSubmitLimit(body) {
    const jsonString = JSON.stringify(body || {}).toLowerCase();
    return LIMIT_TOKENS.some((token) => jsonString.includes(token));
  }

  function emitSubmitSignals(body) {
    if (looksLikeSubmitLimit(body)) {
      window.dispatchEvent(new CustomEvent('DreamFaceLimitHit'));
      return;
    }

    if (looksLikeSubmitSuccess(body)) {
      window.dispatchEvent(new CustomEvent('DreamFaceTaskSuccess', {
        detail: {
          animateImageId: body?.data?.animate_image_id || '',
        },
      }));
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

  window.addEventListener('DreamFaceBatchWorkStatusRequest', async (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId;

    if (!requestId) {
      return;
    }

    try {
      const body = await fetchBatchWorkStatus(detail.ids);
      window.dispatchEvent(new CustomEvent('DreamFaceBatchWorkStatusResponse', {
        detail: {
          requestId,
          ok: true,
          body,
        },
      }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('DreamFaceBatchWorkStatusResponse', {
        detail: {
          requestId,
          ok: false,
          error: error?.message || String(error),
        },
      }));
    }
  });

  window.addEventListener('DreamFaceRunningWorksRequest', async (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId;

    if (!requestId) {
      return;
    }

    try {
      const body = await fetchRunningWorks();
      window.dispatchEvent(new CustomEvent('DreamFaceRunningWorksResponse', {
        detail: {
          requestId,
          ok: true,
          body,
        },
      }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('DreamFaceRunningWorksResponse', {
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
    const isBatchWorkStatus = url.includes(BATCH_WORK_STATUS_PATH);
    const isRunningWorks = url.includes(RUNNING_WORKS_PATH);

    if (isSubmit) {
      rememberSubmitContext(args);
    }
    if (isRecentCreations) {
      rememberRecentCreationsTemplate(args);
    }
    if (isBatchWorkStatus) {
      rememberBatchWorkStatusTemplate(args);
    }
    if (isRunningWorks) {
      rememberRunningWorksTemplate(args);
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
