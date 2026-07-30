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
  const BATCH_DOWNLOAD_URL_PATH = '/dw-server/work/get_batch_download_url';

  const originalFetch = window.fetch;
  let recentCreationsTemplate = null;
  let batchWorkStatusTemplate = null;
  let runningWorksTemplate = null;
  let submitContext = null;
  // последний submit payload, чтобы прицепить аудио/видео мету к response
  let lastSubmitPayload = null;

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

    // вытаскиваем аудио/видео мету для chapters даже если accountId отсутствует
    lastSubmitPayload = extractSubmitMeta(body);

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

  // вытащить поля submit-payload, которые нужны для chapter markers
  function extractSubmitMeta(body) {
    if (!body || typeof body !== 'object') return null;
    const video = body?.media?.videos?.[0] || null;
    const audio = body?.media?.audios?.[0] || null;
    const audioStart = Number(audio?.audio_start_time);
    const audioEnd = Number(audio?.audio_end_time);
    const audioMs = Number.isFinite(audioStart) && Number.isFinite(audioEnd)
      ? Math.max(0, audioEnd - audioStart)
      : null;

    return {
      sourceVideoUrl: video?.url || null,
      traceFaceBox: Array.isArray(video?.trace_face_box) ? video.trace_face_box : null,
      firstFrameUrl: video?.first_frame_image_url || null,
      audioUrl: audio?.url || null,
      audioMs,
      audioStartMs: Number.isFinite(audioStart) ? audioStart : null,
      audioEndMs: Number.isFinite(audioEnd) ? audioEnd : null,
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

  async function fetchBatchDownloadUrls(ids) {
    const safeIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (safeIds.length === 0) {
      return { status_code: 'THS12140000000', status_msg: 'Success', data: [] };
    }

    // используем шаблон от batch_work_status (тот же домен/headers/cookies)
    const template = batchWorkStatusTemplate || recentCreationsTemplate;
    if (!template) {
      throw new Error('batch download url template unavailable');
    }

    const headers = new Headers(template.headers || {});
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    headers.set('content-type', 'application/json');
    if (!headers.has('dream-face-web')) headers.set('dream-face-web', 'dream-face-web');

    const response = await originalFetch(`${location.origin}${BATCH_DOWNLOAD_URL_PATH}`, {
      method: 'POST',
      headers,
      referrer: template.referrer || location.href,
      body: JSON.stringify({ ids: safeIds }),
      mode: template.mode || 'cors',
      credentials: template.credentials || 'include',
    });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(body?.status_msg || `batch download url request failed: ${response.status}`);
    }
    if (!body || body.status_msg !== 'Success') {
      throw new Error(body?.status_msg || 'batch download url response is not successful');
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

  // Extract normalized workId from response body with priority order
  function extractNormalizedWorkId(body) {
    if (!body?.data) return '';
    return (
      String(body.data.work_id || '').trim() ||
      String(body.data.workId || '').trim() ||
      String(body.data.id || '').trim() ||
      ''
    );
  }

  function emitSubmitSignals(body) {
    if (looksLikeSubmitLimit(body)) {
      window.dispatchEvent(new CustomEvent('DreamFaceLimitHit'));
      return;
    }

    if (looksLikeSubmitSuccess(body)) {
      const meta = lastSubmitPayload || {};
      const normalizedWorkId = extractNormalizedWorkId(body);
      window.dispatchEvent(new CustomEvent('DreamFaceTaskSuccess', {
        detail: {
          animateImageId: body?.data?.animate_image_id || '',
          workId: normalizedWorkId,
          // мета для chapter markers
          audioMs: meta.audioMs ?? null,
          sourceVideoUrl: meta.sourceVideoUrl || null,
          traceFaceBox: meta.traceFaceBox || null,
          firstFrameUrl: meta.firstFrameUrl || null,
          audioUrl: meta.audioUrl || null,
        },
      }));
      lastSubmitPayload = null;
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
        const data = body?.data || {};
        const avatarId = String(data.avatar_id || data.avatarId || data.material_id || data.materialId || data.id || '').trim();
        const detail = { avatarId };
        if (data.url) detail.url = String(data.url).trim();
        if (data.cover) detail.cover = String(data.cover).trim();
        if (data.cover_url) detail.cover = String(data.cover_url).trim();
        if (data.material_url) detail.url = String(data.material_url).trim();
        
        window.dispatchEvent(new CustomEvent('DreamFaceAvatarAdded', {
          detail,
        }));
      }
    }).catch(() => {
      if (response.ok) {
        window.dispatchEvent(new CustomEvent('DreamFaceAvatarAdded', {
          detail: { avatarId: '' },
        }));
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

  window.addEventListener('DreamFaceBatchDownloadUrlRequest', async (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId;
    if (!requestId) return;

    try {
      const body = await fetchBatchDownloadUrls(detail.ids);
      window.dispatchEvent(new CustomEvent('DreamFaceBatchDownloadUrlResponse', {
        detail: { requestId, ok: true, body },
      }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('DreamFaceBatchDownloadUrlResponse', {
        detail: { requestId, ok: false, error: error?.message || String(error) },
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

  // ============================================================
  // Patch HTMLAnchorElement.prototype.click — перехват single download
  // ============================================================
  //
  // Сайт скачивает single hover-download так:
  //   const a = document.createElement('a');
  //   a.href = ossUrl;
  //   a.download = 'd10.mp3.mp4';
  //   a.click();
  //
  // Через document.addEventListener('click', ...) мы не успеваем
  // preventDefault асинхронно. Поэтому патчим click синхронно: если href
  // содержит dreamface OSS — отправляем сигнал в content_script (через
  // CustomEvent) и НЕ вызываем оригинальный click. Сайт думает что юзер
  // нажал, но скачивания нет. Content_script ловит сигнал и шлёт в dm.enqueue.
  //
  // Если сигнал не обработан (например content_script не загружен или
  // не на /creation) — детект через флаг ответа, после чего разрешаем
  // оригинальный click чтобы юзер всё-таки получил файл.

  // Регулярка для UUID в OSS URL — это НЕ animate_id, а work_origin_uuid
  // (внутренний идентификатор raw mp4). Использовать для маппинга нельзя.
  const DREAMFACE_OSS_HOST_RE = /^https:\/\/dreamface-resource\.oss-[^.]+\.aliyuncs\.com\//i;
  const DREAMFACE_OSS_UUID_RE = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/i;

  // Извлекаем имя файла из URL query response-content-disposition.
  // Сайт прокидывает реальное имя через OSS Content-Disposition; UUID
  // в path — это work_origin_uuid (бесполезен для нашего маппинга),
  // а вот filename*= содержит work_name + .mp4 (например "d10.mp3.mp4").
  function extractFileNameFromOssUrl(url) {
    try {
      const u = new URL(url);
      const disp = u.searchParams.get('response-content-disposition') || '';
      const m = disp.match(/filename\*?=(?:UTF-8'')?([^;&]+)/i);
      if (m) {
        let name = decodeURIComponent(m[1].replace(/^"|"$/g, ''));
        return name;
      }
    } catch {}
    return '';
  }

  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function patchedAnchorClick(...args) {
    try {
      const href = this.href || '';
      const downloadAttr = this.getAttribute('download') || '';
      if (downloadAttr && DREAMFACE_OSS_HOST_RE.test(href)) {
        const ossUuid = (href.match(DREAMFACE_OSS_UUID_RE) || [])[1] || '';
        const fileNameFromOss = extractFileNameFromOssUrl(href);
        // синхронно спрашиваем content_script примет ли он перехват
        const detail = {
          href,
          download: downloadAttr,
          handled: false,
          ossUuid,           // origin uuid (для логов/диагностики)
          fileName: fileNameFromOss, // правильное имя из OSS Content-Disposition
        };
        const event = new CustomEvent('DreamFaceAnchorClickIntercept', { detail });
        window.dispatchEvent(event);
        if (detail.handled) {
          // content_script взял на себя — не вызываем оригинальный click
          return;
        }
        // не обработан — fallthrough к нативному click
      }
    } catch (err) {
      // на всякий — никогда не блокируем нативный flow
      console.warn('[df-injected] anchor click patch error:', err.message);
    }
    return originalAnchorClick.apply(this, args);
  };
})();
