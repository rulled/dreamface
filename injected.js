// --- START OF FILE injected.js ---

(function() {
  // ============================================================
  // Shared helpers
  // ============================================================
  const RECENT_CREATIONS_PATH = '/dw-server/work/v2/get_recent_creation_list';
  const BATCH_WORK_STATUS_PATH = '/dw-server/work/batch_get_work_status';
  const RUNNING_WORKS_PATH = '/dw-server/work/get_user_running_works/';
  const BATCH_DOWNLOAD_URL_PATH = '/dw-server/work/get_batch_download_url';
  const AVATAR_LIST_DISPLAY_LIMIT = 200;

  const originalFetch = window.fetch;
  let recentCreationsTemplate = null;
  let batchWorkStatusTemplate = null;
  let runningWorksTemplate = null;
  let avatarListCache = null;
  let avatarListCacheGeneration = 0;

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
    if (typeof text !== 'string' || !text.trim()) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  function getAvatarList(payload) {
    const candidates = [payload?.avatars, payload?.data, payload?.data?.avatars, payload?.data?.list];
    return candidates.find((value) => Array.isArray(value) && value.length > 0) || [];
  }

  function toBulkAvatars(source) {
    return source
      .filter((avatar) => avatar?.id && avatar?.path && avatar?.type === 'VIDEO')
      .slice(0, AVATAR_LIST_DISPLAY_LIMIT)
      .map((avatar) => ({
        avatarId: avatar.id,
        videoUrl: avatar.path,
        src: avatar.cover_path || avatar.path,
        name: avatar.name || 'Uploaded Avatar',
        isDefault: Boolean(avatar.is_default),
      }));
  }

  function getAvatarCacheKey(ctx) {
    return `${ctx.userId}:${ctx.accountId}`;
  }

  function invalidateAvatarListCache() {
    avatarListCache = null;
    avatarListCacheGeneration += 1;
  }

  // ============================================================
  // BULK API layer (avatar-bulk endpoint migration)
  // ============================================================
  // Auth: DreamFace uses a JWT in localStorage (NO auth cookie).
  //   localStorage[SESSION_KEY] = {token, userId, accountId, ...}
  //   localStorage[CLIENT_ID_KEY] = client-id
  // Every API request needs headers: token, client-id, dream-face-web, accept, content-type.
  // Reading localStorage fresh per call lets content_script switch accounts
  // by writing a different session object into localStorage.

  const BULK_PATHS = {
    putUrl: '/dw-server/oss/put_url',
    uploadAudio: '/dw-server/phone_file/upload_audio_with_dir',
    avatarAdd: '/df-server/avatar/add',
    avatarList: '/df-server/avatar/list',
    listBatchConfig: '/dw-server/batch_task/v1/list_avatar_batch_config',
    getBatchConfigDetail: '/dw-server/batch_task/v1/get_avatar_batch_config_detail',
    updateBatchConfig: '/dw-server/batch_task/v1/update_avatar_batch_config',
    batchCheckText: '/dw-server/batch_task/v1/batch_check_text',
    animateImageBatch: '/dw-server/face/animate_image_batch',
    getBatchTimes: '/dw-server/face/get_batch_times',
    getPtVideoInfo: '/df-server/pt/get_pt_video_info',
    getRunningWorks: '/dw-server/work/get_user_running_works/',
    getUserRights: '/df-subscribe/subscribe/get_user_rights',
    getTemplateConfig: '/dw-server/sys_config/query/template_config',
  };

  const SESSION_KEY = '49f290d6e8459c53f31f97de37921086';
  const CLIENT_ID_KEY = '19fb90a3b8f09f14a91f48eee48c12af';
  const USER_ID_KEY = '1d5d4096d2b4e7d671adcb4661b5725d';
  const APP_VERSION = '4.7.1';
  const DEFAULT_TEMPLATE_ID = '6606889f54e4e700070db4b1';
  const DEFAULT_PT_AUDIO_ID = '0c7f1002c2924806a042c52dcb71f2ce';
  const DEFAULT_PT_VOICE_ENGINE = 'onyx-all';

  function readLocalStorage(key) {
    try { return localStorage.getItem(key) || ''; } catch { return ''; }
  }

  function getBulkAuthContext() {
    const sessionRaw = readLocalStorage(SESSION_KEY);
    const session = sessionRaw ? tryParseJson(sessionRaw) : null;
    const token = (session && session.token) || '';
    const userId = (session && session.userId) || readLocalStorage(USER_ID_KEY) || '';
    const accountId = (session && session.accountId) || '';
    const clientId = readLocalStorage(CLIENT_ID_KEY) || '';
    const thirdPlatform = String(session?.thirdPlatform || '').trim();
    const thirdId = String(session?.thirdId || '').trim();
    const principalKey = thirdPlatform && thirdId
      ? `${thirdPlatform.toLowerCase()}:${thirdId.toLowerCase()}`
      : (userId ? `user:${String(userId).toLowerCase()}` : `account:${accountId}`);
    return {
      token,
      userId,
      accountId,
      clientId,
      thirdPlatform,
      thirdId,
      principalKey,
      hasAuth: Boolean(token && userId && accountId),
    };
  }

  function requireAuth() {
    const ctx = getBulkAuthContext();
    if (!ctx.hasAuth) {
      throw new Error('bulk auth unavailable: no token/userId/accountId in localStorage');
    }
    return ctx;
  }

  function buildBulkHeaders(ctx, { json = true } = {}) {
    const h = new Headers();
    h.set('accept', 'application/json');
    if (json) h.set('content-type', 'application/json');
    h.set('dream-face-web', 'dream-face-web');
    h.set('token', ctx.token);
    h.set('client-id', ctx.clientId);
    return h;
  }

  function assertBulkSuccess(parsed, label) {
    if (!parsed) throw new Error(`bulk ${label}: empty response`);
    const msg = parsed.status_msg || parsed.statusMsg || parsed.status || '';
    if (msg && msg !== 'Success' && msg !== 'success' && msg !== 'SUCCESS') {
      throw new Error(`bulk ${label} not success: ${msg}`);
    }
    return parsed;
  }

  async function bulkJsonPost(path, body, ctx) {
    const response = await originalFetch(`${location.origin}${path}`, {
      method: 'POST',
      headers: buildBulkHeaders(ctx, { json: true }),
      body: JSON.stringify(body),
      credentials: 'include',
      mode: 'cors',
    });
    const text = await response.text();
    const parsed = tryParseJson(text);
    if (!response.ok) {
      throw new Error(`bulk POST ${path} failed: ${response.status} ${text.slice(0, 200)}`);
    }
    return assertBulkSuccess(parsed, path);
  }

  async function bulkJsonGet(path, ctx) {
    const response = await originalFetch(`${location.origin}${path}`, {
      method: 'GET',
      headers: buildBulkHeaders(ctx, { json: false }),
      credentials: 'include',
      mode: 'cors',
    });
    const text = await response.text();
    const parsed = tryParseJson(text);
    if (!response.ok) {
      throw new Error(`bulk GET ${path} failed: ${response.status}`);
    }
    return assertBulkSuccess(parsed, path);
  }

  async function bulkMultipartPost(path, form, ctx) {
    const response = await originalFetch(`${location.origin}${path}`, {
      method: 'POST',
      headers: buildBulkHeaders(ctx, { json: false }),
      body: form,
      credentials: 'include',
      mode: 'cors',
    });
    const text = await response.text();
    const parsed = tryParseJson(text);
    if (!response.ok) {
      throw new Error(`bulk multipart ${path} failed: ${response.status} ${text.slice(0, 200)}`);
    }
    return assertBulkSuccess(parsed, path);
  }

  async function getPayloadBlob(payload) {
    if (payload.blob instanceof Blob) return payload.blob;
    if (typeof payload.dataUrl !== 'string' || !payload.dataUrl.startsWith('data:')) {
      throw new Error('bulk file payload missing blob/dataUrl');
    }
    return (await originalFetch(payload.dataUrl)).blob();
  }

  // B0. presigned video upload
  async function bulkPutUrl(fileName, contentType) {
    const ctx = requireAuth();
    const parsed = await bulkJsonPost(BULK_PATHS.putUrl, {
      user_id: ctx.userId,
      file_name: fileName,
      content_type: contentType,
      dir: 'WEB_ANIMATE_MATERIAL',
    }, ctx);
    const data = parsed.data || {};
    if (!data.put_url || !data.file_url) {
      throw new Error('put_url response missing put_url/file_url');
    }
    return { putUrl: data.put_url, fileUrl: data.file_url, contentType: data.content_type || contentType };
  }

  async function bulkPutOssFile(putUrl, blob, contentType) {
    const response = await originalFetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: blob,
      mode: 'cors',
    });
    if (!response.ok) {
      throw new Error(`oss put failed: ${response.status}`);
    }
    return { ok: true };
  }

  // B1. audio upload (multipart via API, not presigned)
  async function bulkUploadAudio(blob, fileName) {
    const ctx = requireAuth();
    const form = new FormData();
    form.append('file', blob, fileName);
    form.append('userId', ctx.userId);
    form.append('ossDir', 'AVATAR_AUDIO');
    const parsed = await bulkMultipartPost(BULK_PATHS.uploadAudio, form, ctx);
    const filePath = parsed.data && parsed.data.file_path;
    if (!filePath) {
      throw new Error('upload_audio response missing file_path');
    }
    return { filePath };
  }

  // B2. avatar add (multipart)
  async function bulkAvatarAdd(fileUrl) {
    const ctx = requireAuth();
    const form = new FormData();
    form.append('user_id', ctx.userId);
    form.append('account_id', ctx.accountId);
    form.append('url', fileUrl);
    form.append('type', 'VIDEO');
    form.append('support_multi_face', 'true');
    const parsed = await bulkMultipartPost(BULK_PATHS.avatarAdd, form, ctx);
    const avatar = parsed.avatar;
    if (!avatar || !avatar.id) {
      throw new Error('avatar/add response missing avatar.id');
    }
    invalidateAvatarListCache();
    return { avatarId: avatar.id, avatar };
  }

  async function bulkListAvatars() {
    const ctx = requireAuth();
    const cacheKey = getAvatarCacheKey(ctx);
    if (avatarListCache?.key === cacheKey
      && Date.now() - avatarListCache.updatedAt < 5 * 60 * 1000) {
      return { accountId: ctx.accountId, avatars: avatarListCache.avatars };
    }
    const cacheGeneration = avatarListCacheGeneration;
    const parsed = await bulkJsonPost(BULK_PATHS.avatarList, {
      user_id: ctx.userId,
      account_id: ctx.accountId,
      name: '',
      themes: ['DEFAULT'],
    }, ctx);
    const avatars = toBulkAvatars(getAvatarList(parsed));
    if (cacheGeneration === avatarListCacheGeneration) {
      avatarListCache = { key: cacheKey, avatars, updatedAt: Date.now() };
    }
    return {
      accountId: ctx.accountId,
      avatars,
    };
  }

  // batch config
  async function bulkListBatchConfig(configType) {
    const ctx = requireAuth();
    const parsed = await bulkJsonPost(BULK_PATHS.listBatchConfig, {
      account_id: ctx.accountId,
      config_type: configType || 'SCRIPT',
    }, ctx);
    const data = parsed.data || {};
    const list = Array.isArray(data.configs) ? data.configs : (Array.isArray(data) ? data : []);
    return { configs: list };
  }

  async function bulkGetBatchConfigDetail(id) {
    const ctx = requireAuth();
    const parsed = await bulkJsonPost(BULK_PATHS.getBatchConfigDetail, { id }, ctx);
    return { config: parsed.data || null };
  }

  async function bulkUpdateBatchConfig(id, name, scriptConfigs) {
    const ctx = requireAuth();
    const body = {
      id,
      account_id: ctx.accountId,
      type: 'SCRIPT',
      script_configs: scriptConfigs,
    };
    if (name) body.name = name;
    await bulkJsonPost(BULK_PATHS.updateBatchConfig, body, ctx);
    return { ok: true };
  }

  async function bulkBatchCheckText() {
    const ctx = requireAuth();
    await bulkJsonPost(BULK_PATHS.batchCheckText, { texts: [] }, ctx);
    return { ok: true };
  }

  // E. animate_image_batch (one avatar + N audios -> N works)
  async function bulkAnimateImageBatch(params) {
    const ctx = requireAuth();
    const avatarId = params.avatarId;
    const videoUrl = params.videoUrl;
    const scriptConfigs = params.scriptConfigs || [];
    const batchConfigId = params.batchConfigId;
    const templateId = params.templateId || DEFAULT_TEMPLATE_ID;

    if (!avatarId || !videoUrl || !batchConfigId || scriptConfigs.length === 0) {
      throw new Error('animateImageBatch: avatarId, videoUrl, batchConfigId and non-empty scriptConfigs required');
    }

    const photoInfo = {
      photo_path: '',
      origin_face_locations: [{ left_upper_x: 0, left_upper_y: 0, right_width: 1, down_high: 1 }],
      square_face_locations: [{ left_upper_x: 0, left_upper_y: 0, down_high: 1, right_width: 1 }],
      five_lands: [[[1, 1], [1, 1], [1, 1], [1, 1], [1, 1]]],
      face_nums: 1,
      mask_path: '',
      avatar_id: avatarId,
      is_default_avatar: false,
    };
    const ptInfo = {
      lan: 'all',
      audio_id: DEFAULT_PT_AUDIO_ID,
      context: '',
      voice_engine_id: DEFAULT_PT_VOICE_ENGINE,
      asset_id: '',
      video_url: videoUrl,
      avatar_id: avatarId,
      resolution: 720,
      is_default_avatar: false,
    };
    const body = {
      aigc_img_no_save_flag: false,
      template_id: templateId,
      app_version: APP_VERSION,
      timestamp: Date.now(),
      user_id: ctx.userId,
      account_id: ctx.accountId,
      no_water_mark: 1,
      merge_by_server: false,
      work_type: 'AVATAR_VIDEO',
      photo_info_list: [photoInfo],
      play_types: ['VIDEO', 'PT'],
      pt_infos: [ptInfo],
      ext: { track_info: '{}', sing_title: '', animate_channel: 'dynamic' },
      batch_config: {
        id: batchConfigId,
        name: params.name || 'Bulk Batch',
        type: 'SCRIPT',
        avatar_configs: [],
        script_configs: scriptConfigs,
      },
      task_count: scriptConfigs.length,
    };
    const parsed = await bulkJsonPost(BULK_PATHS.animateImageBatch, body, ctx);
    const data = parsed.data || {};
    return { successCount: data.success_count || 0, failCount: data.fail_count || 0, raw: parsed };
  }

  async function bulkGetBatchTimes() {
    const ctx = requireAuth();
    const qs = `user_id=${encodeURIComponent(ctx.userId)}&account_id=${encodeURIComponent(ctx.accountId)}&work_type=AVATAR_VIDEO`;
    const parsed = await bulkJsonGet(`${BULK_PATHS.getBatchTimes}?${qs}`, ctx);
    const data = parsed.data || {};
    return { total: data.total_times || 0, remaining: data.remaining_times || 0 };
  }

  async function bulkGetPtVideoInfo() {
    const ctx = requireAuth();
    const parsed = await bulkJsonPost(BULK_PATHS.getPtVideoInfo, {
      user_id: ctx.userId,
      account_id: ctx.accountId,
      app_version: APP_VERSION,
    }, ctx);
    const list = (parsed.data && parsed.data.template_list) || parsed.template_list || [];
    let templateId = DEFAULT_TEMPLATE_ID;
    if (Array.isArray(list) && list.length > 0) {
      const dyn = list.find((t) => /dynamic/i.test(`${t?.name || ''} ${t?.animate_channel || ''}`));
      templateId = (dyn || list[0])?.id || templateId;
    }
    return { templateId, templates: list };
  }

  async function bulkGetRunningWorks() {
    const ctx = requireAuth();
    const parsed = await bulkJsonGet(`${BULK_PATHS.getRunningWorks}${ctx.accountId}`, ctx);
    return { workIds: parsed.data || [] };
  }

  async function bulkGetRecentCreations(page = 1, size = 50) {
    const ctx = requireAuth();
    const parsed = await bulkJsonPost(RECENT_CREATIONS_PATH, {
      user_id: ctx.userId,
      account_id: ctx.accountId,
      page,
      size,
      is_web: true,
      app_version: APP_VERSION,
    }, ctx);
    const source = Array.isArray(parsed.data?.list) ? parsed.data.list : [];
    return {
      count: Number(parsed.data?.count || 0),
      items: source.map((item) => ({
        ...item,
        id: item.id || item.work_id || item.workId,
        work_name: item.work_name || item.workName || item.name || '',
        work_type: item.work_type || item.workType || item.type || 'AVATAR_VIDEO',
        web_work_status: item.web_work_status ?? item.workStatus ?? item.status,
        create_time: item.create_time ?? item.createTime ?? item.created_at ?? item.createdAt,
      })),
    };
  }

  async function bulkGetWorkStatuses(ids) {
    const ctx = requireAuth();
    const safeIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (safeIds.length === 0) return { statuses: [] };
    const parsed = await bulkJsonPost(BATCH_WORK_STATUS_PATH, {
      account_id: ctx.accountId,
      ids: safeIds,
    }, ctx);
    return {
      statuses: (Array.isArray(parsed.data) ? parsed.data : []).map((item) => ({
        ...item,
        id: item.id || item.work_id || item.workId,
        web_work_status: item.web_work_status ?? item.workStatus ?? item.status,
      })),
    };
  }

  async function bulkGetDownloadUrls(ids) {
    const ctx = requireAuth();
    const safeIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (safeIds.length === 0) return { urls: [] };
    const parsed = await bulkJsonPost(BATCH_DOWNLOAD_URL_PATH, { ids: safeIds }, ctx);
    return {
      urls: (Array.isArray(parsed.data) ? parsed.data : []).map((item) => ({
        ...item,
        id: item.id || item.work_id || item.workId,
        url: item.url || item.download_url || item.downloadUrl || item.file_url || item.fileUrl || '',
      })),
    };
  }

  async function bulkGetAccountCapabilities() {
    const ctx = requireAuth();
    const [rights, templateResponse] = await Promise.all([
      bulkJsonPost(BULK_PATHS.getUserRights, { userId: ctx.userId, accountId: ctx.accountId }, ctx),
      bulkJsonGet(BULK_PATHS.getTemplateConfig, ctx),
    ]);
    const config = tryParseJson(templateResponse?.data?.value || '') || {};
    const audioLimit = config.audioLimit || {};
    const tier = rights.vipLabel
      ? (rights.vipLevel === 'normal' ? 'pro' : 'premium')
      : 'free';
    const maxDurationSeconds = Number(audioLimit[tier]);
    if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
      throw new Error(`DreamFace audioLimit.${tier} unavailable`);
    }
    return {
      tier,
      planName: tier === 'premium' ? 'Premium' : (tier === 'pro' ? 'Pro' : 'Free'),
      maxDurationSeconds,
      durationSource: 'dreamface-api',
      vipLabel: Boolean(rights.vipLabel),
      vipLevel: rights.vipLevel || '',
      vipType: rights.vipType || '',
      vipProductId: rights.vipProductId || '',
      expiresDate: Number(rights.expiresDate || 0),
      audioLimit: {
        free: Number(audioLimit.free || 0),
        pro: Number(audioLimit.pro || 0),
        premium: Number(audioLimit.premium || 0),
      },
    };
  }

  async function dispatchBulkOp(op, payload) {
    switch (op) {
      case 'getAuthContext': return getBulkAuthContext();
      case 'putUrl': return bulkPutUrl(payload.fileName, payload.contentType);
      case 'putOssFile': return bulkPutOssFile(payload.putUrl, await getPayloadBlob(payload), payload.contentType);
      case 'uploadAudio': return bulkUploadAudio(await getPayloadBlob(payload), payload.fileName);
      case 'avatarAdd': return bulkAvatarAdd(payload.fileUrl);
      case 'listAvatars': return bulkListAvatars();
      case 'listBatchConfig': return bulkListBatchConfig(payload.configType);
      case 'getBatchConfigDetail': return bulkGetBatchConfigDetail(payload.id);
      case 'updateBatchConfig': return bulkUpdateBatchConfig(payload.id, payload.name, payload.scriptConfigs);
      case 'batchCheckText': return bulkBatchCheckText();
      case 'animateImageBatch': return bulkAnimateImageBatch(payload);
      case 'getBatchTimes': return bulkGetBatchTimes();
      case 'getPtVideoInfo': return bulkGetPtVideoInfo();
      case 'getRunningWorks': return bulkGetRunningWorks();
      case 'getAccountCapabilities': return bulkGetAccountCapabilities();
      case 'getRecentCreations': return bulkGetRecentCreations(payload.page, payload.size);
      case 'getWorkStatuses': return bulkGetWorkStatuses(payload.ids);
      case 'getDownloadUrls': return bulkGetDownloadUrls(payload.ids);
      default: throw new Error(`unknown bulk op: ${op}`);
    }
  }

  const BULK_ALLOWED_OPS = new Set([
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
  const handledBulkRequestIds = new Set();
  let bulkChannelToken = '';
  let bulkChannelLocked = false;

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

  window.addEventListener('message', async (event) => {
    if (!isSameWindowMessage(event)) return;
    const req = event.data;
    if (hasExactKeys(req, ['__dfBulkInit', 'channelToken'])
      && req.__dfBulkInit === true
      && typeof req.channelToken === 'string'
      && /^[0-9a-f]{64}$/.test(req.channelToken)) {
      if (!bulkChannelLocked) bulkChannelToken = req.channelToken;
      if (req.channelToken === bulkChannelToken) {
        window.postMessage({
          __dfBulkInitAck: true,
          channelToken: bulkChannelToken,
        }, location.origin);
      }
      return;
    }
    if (!hasExactKeys(req, ['__dfBulkReq', 'channelToken', 'requestId', 'op', 'payload'])
      || req.__dfBulkReq !== true
      || req.channelToken !== bulkChannelToken
      || typeof req.requestId !== 'string'
      || !/^df-bulk-[0-9a-f-]{36}-\d+$/.test(req.requestId)
      || typeof req.op !== 'string'
      || !BULK_ALLOWED_OPS.has(req.op)
      || !isValidBulkPayload(req.op, req.payload)
      || handledBulkRequestIds.has(req.requestId)) return;
    const requestId = req.requestId;
    const op = req.op;
    bulkChannelLocked = true;
    handledBulkRequestIds.add(requestId);
    try {
      const result = await dispatchBulkOp(op, req.payload);
      window.postMessage({
        __dfBulkRes: true,
        channelToken: bulkChannelToken,
        requestId,
        ok: true,
        data: result,
      }, location.origin);
    } catch (error) {
      window.postMessage({
        __dfBulkRes: true,
        channelToken: bulkChannelToken,
        requestId,
        ok: false,
        error: (error && error.message) || String(error),
      }, location.origin);
    }
  });

  // ============================================================
  // Legacy polling: capture request templates + replay helpers
  // (used by content_script creations-download flow; kept for compat)
  // ============================================================
  function rememberRecentCreationsTemplate(args) {
    const snapshot = getFetchInitSnapshot(args);
    const body = tryParseJson(snapshot.body);
    if (!body || !body.account_id || !body.user_id) return;
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
    if (!body || !body.account_id || !Array.isArray(body.ids)) return;
    batchWorkStatusTemplate = {
      headers: snapshot.headers,
      body,
      referrer: snapshot.referrer || location.href,
      credentials: snapshot.credentials || 'include',
      mode: snapshot.mode || 'cors',
      url: snapshot.url,
    };
  }

  function rememberRunningWorksTemplate(args) {
    const snapshot = getFetchInitSnapshot(args);
    const accountId = String(snapshot.url || '').split(RUNNING_WORKS_PATH)[1] || '';
    if (!accountId) return;
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
    const accountId = (runningWorksTemplate && runningWorksTemplate.accountId)
      || (recentCreationsTemplate && recentCreationsTemplate.body && recentCreationsTemplate.body.account_id)
      || (batchWorkStatusTemplate && batchWorkStatusTemplate.body && batchWorkStatusTemplate.body.account_id);
    if (!accountId) return null;
    const template = runningWorksTemplate || recentCreationsTemplate || batchWorkStatusTemplate;
    return {
      headers: (template && template.headers) || {},
      referrer: (template && template.referrer) || location.href,
      credentials: (template && template.credentials) || 'include',
      mode: (template && template.mode) || 'cors',
      accountId,
      url: (runningWorksTemplate && runningWorksTemplate.url) || `${location.origin}${RUNNING_WORKS_PATH}${accountId}`,
    };
  }

  async function fetchRecentCreationsPage(page = 1, size = 30) {
    if (!recentCreationsTemplate) {
      throw new Error('recent creations request template unavailable');
    }
    const baseBody = recentCreationsTemplate.body || {};
    const payload = { ...baseBody, page, size, is_web: true, app_version: baseBody.app_version || APP_VERSION };
    const headers = new Headers(recentCreationsTemplate.headers || {});
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    headers.set('content-type', 'application/json');
    if (!headers.has('dream-face-web')) headers.set('dream-face-web', 'dream-face-web');
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
    if (!response.ok) throw new Error(body?.status_msg || `recent creations request failed: ${response.status}`);
    if (!body || body.status_msg !== 'Success') throw new Error(body?.status_msg || 'recent creations response is not successful');
    return body;
  }

  async function fetchBatchWorkStatus(ids) {
    const safeIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (safeIds.length === 0) {
      return { status_code: 'THS12140000000', status_msg: 'Success', data: [] };
    }
    const template = batchWorkStatusTemplate || recentCreationsTemplate;
    if (!template) throw new Error('batch work status request template unavailable');
    const headers = new Headers(template.headers || {});
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    headers.set('content-type', 'application/json');
    if (!headers.has('dream-face-web')) headers.set('dream-face-web', 'dream-face-web');
    const payload = { account_id: template.body?.account_id, ids: safeIds };
    if (!payload.account_id) throw new Error('account_id is missing for batch work status');
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
    if (!response.ok) throw new Error(body?.status_msg || `batch work status request failed: ${response.status}`);
    if (!body || body.status_msg !== 'Success') throw new Error(body?.status_msg || 'batch work status response is not successful');
    return body;
  }

  async function fetchBatchDownloadUrls(ids) {
    const safeIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (safeIds.length === 0) {
      return { status_code: 'THS12140000000', status_msg: 'Success', data: [] };
    }
    const template = batchWorkStatusTemplate || recentCreationsTemplate;
    if (!template) throw new Error('batch download url template unavailable');
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
    if (!response.ok) throw new Error(body?.status_msg || `batch download url request failed: ${response.status}`);
    if (!body || body.status_msg !== 'Success') throw new Error(body?.status_msg || 'batch download url response is not successful');
    return body;
  }

  async function fetchRunningWorks() {
    const context = getRunningWorksContext();
    if (!context) throw new Error('running works request template unavailable');
    const headers = new Headers(context.headers || {});
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    if (!headers.has('dream-face-web')) headers.set('dream-face-web', 'dream-face-web');
    const response = await originalFetch(context.url, {
      method: 'GET',
      headers,
      referrer: context.referrer || location.href,
      mode: context.mode || 'cors',
      credentials: context.credentials || 'include',
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.status_msg || `running works request failed: ${response.status}`);
    if (!body || body.status_msg !== 'Success') throw new Error(body?.status_msg || 'running works response is not successful');
    return body;
  }

  function processAvatarAddResponse(response) {
    response.clone().json().then((body) => {
      const jsonString = JSON.stringify(body || {}).toLowerCase();
      const looksSuccessful = response.ok && !jsonString.includes('error') && !jsonString.includes('fail');
      if (looksSuccessful) {
        window.dispatchEvent(new CustomEvent('DreamFaceAvatarAdded'));
      }
    }).catch(() => {
      if (response.ok) {
        window.dispatchEvent(new CustomEvent('DreamFaceAvatarAdded'));
      }
    });
  }

  // ============================================================
  // Legacy polling event interface (request/response pairs)
  // ============================================================
  window.addEventListener('DreamFaceRecentCreationsRequest', async (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId;
    if (!requestId) return;
    try {
      const body = await fetchRecentCreationsPage(Number(detail.page) || 1, Number(detail.size) || 30);
      window.dispatchEvent(new CustomEvent('DreamFaceRecentCreationsResponse', { detail: { requestId, ok: true, body } }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('DreamFaceRecentCreationsResponse', { detail: { requestId, ok: false, error: error?.message || String(error) } }));
    }
  });

  window.addEventListener('DreamFaceBatchWorkStatusRequest', async (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId;
    if (!requestId) return;
    try {
      const body = await fetchBatchWorkStatus(detail.ids);
      window.dispatchEvent(new CustomEvent('DreamFaceBatchWorkStatusResponse', { detail: { requestId, ok: true, body } }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('DreamFaceBatchWorkStatusResponse', { detail: { requestId, ok: false, error: error?.message || String(error) } }));
    }
  });

  window.addEventListener('DreamFaceBatchDownloadUrlRequest', async (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId;
    if (!requestId) return;
    try {
      const body = await fetchBatchDownloadUrls(detail.ids);
      window.dispatchEvent(new CustomEvent('DreamFaceBatchDownloadUrlResponse', { detail: { requestId, ok: true, body } }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('DreamFaceBatchDownloadUrlResponse', { detail: { requestId, ok: false, error: error?.message || String(error) } }));
    }
  });

  window.addEventListener('DreamFaceRunningWorksRequest', async (event) => {
    const detail = event?.detail || {};
    const requestId = detail.requestId;
    if (!requestId) return;
    try {
      const body = await fetchRunningWorks();
      window.dispatchEvent(new CustomEvent('DreamFaceRunningWorksResponse', { detail: { requestId, ok: true, body } }));
    } catch (error) {
      window.dispatchEvent(new CustomEvent('DreamFaceRunningWorksResponse', { detail: { requestId, ok: false, error: error?.message || String(error) } }));
    }
  });

  // ============================================================
  // fetch hook: capture polling templates + avatar-add signal
  // ============================================================
  function limitAvatarListPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    if (Array.isArray(payload.avatars)) {
      payload.avatars = payload.avatars.slice(0, AVATAR_LIST_DISPLAY_LIMIT);
    }
    if (Array.isArray(payload.data)) {
      payload.data = payload.data.slice(0, AVATAR_LIST_DISPLAY_LIMIT);
    } else if (Array.isArray(payload.data?.avatars)) {
      payload.data.avatars = payload.data.avatars.slice(0, AVATAR_LIST_DISPLAY_LIMIT);
    } else if (Array.isArray(payload.data?.list)) {
      payload.data.list = payload.data.list.slice(0, AVATAR_LIST_DISPLAY_LIMIT);
    }
    return payload;
  }

  function limitAvatarListResponse(response, cacheKey, cacheGeneration) {
    const originalJson = response.json.bind(response);
    const originalText = response.text.bind(response);
    const originalClone = response.clone.bind(response);
    response.json = async () => {
      const payload = await originalJson();
      const avatars = toBulkAvatars(getAvatarList(payload));
      if (cacheGeneration === avatarListCacheGeneration) {
        avatarListCache = { key: cacheKey, avatars, updatedAt: Date.now() };
      }
      return limitAvatarListPayload(payload);
    };
    response.text = async () => {
      const text = await originalText();
      const payload = tryParseJson(text);
      if (!payload) return text;
      const avatars = toBulkAvatars(getAvatarList(payload));
      if (cacheGeneration === avatarListCacheGeneration) {
        avatarListCache = { key: cacheKey, avatars, updatedAt: Date.now() };
      }
      return JSON.stringify(limitAvatarListPayload(payload));
    };
    response.clone = () => limitAvatarListResponse(originalClone(), cacheKey, cacheGeneration);
    return response;
  }

  window.fetch = async function(...args) {
    const url = getUrlFromFetchArg(args[0]);
    const isAvatarAdd = url.includes('/df-server/avatar/add');
    const isAvatarList = url.includes(BULK_PATHS.avatarList);
    const avatarRequestContext = isAvatarList ? getBulkAuthContext() : null;
    const avatarRequestCacheKey = avatarRequestContext ? getAvatarCacheKey(avatarRequestContext) : '';
    const avatarRequestCacheGeneration = avatarListCacheGeneration;
    const isRecentCreations = url.includes(RECENT_CREATIONS_PATH);
    const isBatchWorkStatus = url.includes(BATCH_WORK_STATUS_PATH);
    const isRunningWorks = url.includes(RUNNING_WORKS_PATH);

    if (isRecentCreations) rememberRecentCreationsTemplate(args);
    if (isBatchWorkStatus) rememberBatchWorkStatusTemplate(args);
    if (isRunningWorks) rememberRunningWorksTemplate(args);

    const response = await originalFetch(...args);

    if (isAvatarList && response.ok) {
      return limitAvatarListResponse(response, avatarRequestCacheKey, avatarRequestCacheGeneration);
    }

    if (isAvatarAdd) {
      invalidateAvatarListCache();
      processAvatarAddResponse(response);
    }

    return response;
  };

  // ============================================================
  // Patch HTMLAnchorElement.prototype.click — intercept single download
  // ============================================================
  const DREAMFACE_OSS_HOST_RE = /^https:\/\/dreamface-resource\.oss-[^.]+\.aliyuncs\.com\//i;
  const DREAMFACE_OSS_UUID_RE = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/i;

  function extractFileNameFromOssUrl(url) {
    try {
      const u = new URL(url);
      const disp = u.searchParams.get('response-content-disposition') || '';
      const m = disp.match(/filename\*?=(?:UTF-8'')?([^;&]+)/i);
      if (m) {
        return decodeURIComponent(m[1].replace(/^"|"$/g, ''));
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
        const detail = {
          href,
          download: downloadAttr,
          ossUuid,
          fileName: fileNameFromOss,
        };
        const event = new CustomEvent('DreamFaceAnchorClickIntercept', {
          cancelable: true,
          detail,
        });
        window.dispatchEvent(event);
        if (event.defaultPrevented) {
          return;
        }
      }
    } catch (err) {
      console.warn('[df-injected] anchor click patch error:', err.message);
    }
    return originalAnchorClick.apply(this, args);
  };
})();
