const DREAMFACE_BASE_URL = 'https://www.dreamfaceapp.com';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_SUBMISSION_TIMEOUT_MS = 300_000;
const APP_VERSION = '4.7.1';
const DEFAULT_PT_AUDIO_ID = '0c7f1002c2924806a042c52dcb71f2ce';
const DEFAULT_PT_VOICE_ENGINE = 'onyx-all';

const PATHS = Object.freeze({
  putUrl: '/dw-server/oss/put_url',
  uploadAudio: '/dw-server/phone_file/upload_audio_with_dir',
  avatarAdd: '/df-server/avatar/add',
  avatarList: '/df-server/avatar/list',
  listBatchConfigs: '/dw-server/batch_task/v1/list_avatar_batch_config',
  getBatchConfigDetail: '/dw-server/batch_task/v1/get_avatar_batch_config_detail',
  updateBatchConfig: '/dw-server/batch_task/v1/update_avatar_batch_config',
  checkBatchText: '/dw-server/batch_task/v1/batch_check_text',
  animateImageBatch: '/dw-server/face/animate_image_batch',
  getBatchTimes: '/dw-server/face/get_batch_times',
  getPtVideoInfo: '/df-server/pt/get_pt_video_info',
  getRunningWorks: '/dw-server/work/get_user_running_works/',
  getUserRights: '/df-subscribe/subscribe/get_user_rights',
  getTemplateConfig: '/dw-server/sys_config/query/template_config',
  getRecentCreations: '/dw-server/work/v2/get_recent_creation_list',
  getWorkStatuses: '/dw-server/work/batch_get_work_status',
  getDownloadUrls: '/dw-server/work/get_batch_download_url',
});

function positiveTimeout(value, fallback, label) {
  if (value === undefined) return fallback;
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError(`${label} must be a positive number`);
  }
  return timeout;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`DreamFace ${label} is required`);
  }
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isSuccessMessage(value) {
  return typeof value === 'string' && value.toLowerCase() === 'success';
}

/**
 * Creates a DreamFace client permanently bound to one account credential set.
 * No method reads mutable page storage or automatically retries requests.
 */
export function createDreamFaceClient(credentials, options = {}) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new TypeError('DreamFace credentials are required');
  }

  const auth = Object.freeze({
    token: requiredString(credentials.token, 'token'),
    clientId: requiredString(credentials.clientId, 'clientId'),
    userId: requiredString(credentials.userId, 'userId'),
    accountId: requiredString(credentials.accountId, 'accountId'),
    thirdPlatform: optionalString(credentials.thirdPlatform),
    thirdId: optionalString(credentials.thirdId),
  });
  const principalKey = auth.thirdPlatform && auth.thirdId
    ? `${auth.thirdPlatform.toLowerCase()}:${auth.thirdId.toLowerCase()}`
    : `user:${auth.userId.toLowerCase()}`;

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');

  const baseUrl = new URL(options.baseUrl || DREAMFACE_BASE_URL).origin;
  const timeoutMs = positiveTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const uploadTimeoutMs = positiveTimeout(options.uploadTimeoutMs, DEFAULT_UPLOAD_TIMEOUT_MS, 'uploadTimeoutMs');
  const submissionTimeoutMs = positiveTimeout(options.submissionTimeoutMs, DEFAULT_SUBMISSION_TIMEOUT_MS, 'submissionTimeoutMs');
  const fetchCredentials = options.fetchCredentials || 'omit';
  if (!['omit', 'same-origin', 'include'].includes(fetchCredentials)) {
    throw new TypeError('fetchCredentials must be omit, same-origin, or include');
  }

  function apiHeaders(json = true) {
    const headers = new Headers({
      accept: 'application/json',
      'dream-face-web': 'dream-face-web',
      token: auth.token,
      'client-id': auth.clientId,
    });
    if (json) headers.set('content-type', 'application/json');
    return headers;
  }

  async function timedFetch(url, init, requestTimeoutMs, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await fetchImpl(url, {
        ...init,
        credentials: fetchCredentials,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`DreamFace ${label} timed out`);
      throw new Error(`DreamFace ${label} request failed`);
    } finally {
      clearTimeout(timer);
    }
  }

  function assertApiSuccess(parsed, label) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`DreamFace ${label} returned invalid JSON`);
    }
    const message = parsed.status_msg ?? parsed.statusMsg ?? parsed.status;
    if (message !== undefined && message !== null && message !== '' && !isSuccessMessage(message)) {
      const error = new Error(`DreamFace ${label} not success: ${message}`);
      error.code = /account limit reached/i.test(String(message)) ? 'account_limit_reached' : 'api_rejected';
      error.apiStatus = String(message);
      throw error;
    }
    return parsed;
  }

  async function requestJson(path, { method = 'GET', body, timeout = timeoutMs, label = path } = {}) {
    const response = await timedFetch(`${baseUrl}${path}`, {
      method,
      headers: apiHeaders(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }, timeout, label);

    let parsed;
    try {
      parsed = await response.json();
    } catch (_) {
      if (!response.ok) throw new Error(`DreamFace ${label} failed with HTTP ${response.status}`);
      throw new Error(`DreamFace ${label} returned invalid JSON`);
    }
    if (!response.ok) {
      try {
        assertApiSuccess(parsed, label);
      } catch (error) {
        error.httpStatus = response.status;
        throw error;
      }
      throw new Error(`DreamFace ${label} failed with HTTP ${response.status}`);
    }
    return assertApiSuccess(parsed, label);
  }

  async function postJson(path, body, requestOptions) {
    return requestJson(path, { ...requestOptions, method: 'POST', body });
  }

  async function postForm(path, form, label) {
    const response = await timedFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: apiHeaders(false),
      body: form,
    }, uploadTimeoutMs, label);

    let parsed;
    try {
      parsed = await response.json();
    } catch (_) {
      if (!response.ok) throw new Error(`DreamFace ${label} failed with HTTP ${response.status}`);
      throw new Error(`DreamFace ${label} returned invalid JSON`);
    }
    if (!response.ok) {
      try {
        assertApiSuccess(parsed, label);
      } catch (error) {
        error.httpStatus = response.status;
        throw error;
      }
      throw new Error(`DreamFace ${label} failed with HTTP ${response.status}`);
    }
    return assertApiSuccess(parsed, label);
  }

  function getAuthContext() {
    return {
      ...auth,
      principalKey,
      hasAuth: true,
    };
  }

  async function getAccountCapabilities() {
    const [rights, templateResponse] = await Promise.all([
      postJson(PATHS.getUserRights, { userId: auth.userId, accountId: auth.accountId }, { label: 'getAccountCapabilities rights' }),
      requestJson(PATHS.getTemplateConfig, { label: 'getAccountCapabilities config' }),
    ]);
    let config;
    try {
      const rawConfig = templateResponse?.data?.value;
      config = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
    } catch (_) {
      throw new Error('DreamFace account capabilities contain invalid configuration JSON');
    }
    const audioLimit = config?.audioLimit;
    if (!audioLimit || typeof audioLimit !== 'object' || Array.isArray(audioLimit)) {
      throw new Error('DreamFace account capabilities are missing audio limits');
    }
    const tier = rights.vipLabel ? (rights.vipLevel === 'normal' ? 'pro' : 'premium') : 'free';
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

  async function getBatchTimes() {
    const query = new URLSearchParams({
      user_id: auth.userId,
      account_id: auth.accountId,
      work_type: 'AVATAR_VIDEO',
    });
    const parsed = await requestJson(`${PATHS.getBatchTimes}?${query}`, { label: 'getBatchTimes' });
    return {
      total: parsed.data?.total_times || 0,
      remaining: parsed.data?.remaining_times || 0,
    };
  }

  async function getPtVideoInfo() {
    const parsed = await postJson(PATHS.getPtVideoInfo, {
      user_id: auth.userId,
      account_id: auth.accountId,
      app_version: APP_VERSION,
    }, { label: 'getPtVideoInfo' });
    const templates = parsed.data?.template_list || parsed.template_list || [];
    if (!Array.isArray(templates) || templates.length === 0) {
      throw new Error('DreamFace getPtVideoInfo returned no templates');
    }
    const dynamicTemplate = templates.find((template) => (
      /dynamic/i.test(`${template?.name || ''} ${template?.animate_channel || ''}`)
    ));
    const templateId = optionalString((dynamicTemplate || templates[0])?.id);
    if (!templateId) throw new Error('DreamFace getPtVideoInfo returned a template without id');
    return {
      templateId,
      templates,
    };
  }

  async function getRunningWorks() {
    const parsed = await requestJson(`${PATHS.getRunningWorks}${encodeURIComponent(auth.accountId)}`, {
      label: 'getRunningWorks',
    });
    return { workIds: parsed.data || [] };
  }

  async function listAvatars(limit = 200) {
    const normalizedLimit = Number(limit);
    if (!Number.isInteger(normalizedLimit) || normalizedLimit < 0) {
      throw new TypeError('listAvatars limit must be a non-negative integer');
    }
    const parsed = await postJson(PATHS.avatarList, {
      user_id: auth.userId,
      account_id: auth.accountId,
      name: '',
      themes: ['DEFAULT'],
    }, { label: 'listAvatars' });
    const candidates = [parsed.avatars, parsed.data, parsed.data?.avatars, parsed.data?.list];
    const source = candidates.find((value) => Array.isArray(value) && value.length > 0) || [];
    const avatars = source
      .filter((avatar) => avatar?.id && avatar?.path && avatar?.type === 'VIDEO')
      .slice(0, normalizedLimit)
      .map((avatar) => ({
        avatarId: avatar.id,
        videoUrl: avatar.path,
        src: avatar.cover_path || avatar.path,
        name: avatar.name || 'Uploaded Avatar',
        isDefault: Boolean(avatar.is_default),
      }));
    return { accountId: auth.accountId, avatars };
  }

  async function createPutUrl(fileName, contentType) {
    const parsed = await postJson(PATHS.putUrl, {
      user_id: auth.userId,
      file_name: requiredString(fileName, 'fileName'),
      content_type: requiredString(contentType, 'contentType'),
      dir: 'WEB_ANIMATE_MATERIAL',
    }, { label: 'createPutUrl' });
    if (!parsed.data?.put_url || !parsed.data?.file_url) {
      throw new Error('DreamFace createPutUrl response is missing upload URLs');
    }
    return {
      putUrl: parsed.data.put_url,
      fileUrl: parsed.data.file_url,
      contentType: parsed.data.content_type || contentType,
    };
  }

  async function putOssFile(putUrl, blob, contentType) {
    if (!(blob instanceof Blob)) throw new TypeError('putOssFile blob is required');
    const response = await timedFetch(requiredString(putUrl, 'putUrl'), {
      method: 'PUT',
      headers: { 'Content-Type': requiredString(contentType, 'contentType') },
      body: blob,
    }, uploadTimeoutMs, 'putOssFile');
    if (!response.ok) throw new Error(`DreamFace putOssFile failed with HTTP ${response.status}`);
    return { ok: true };
  }

  async function uploadAudio(blob, fileName) {
    if (!(blob instanceof Blob)) throw new TypeError('uploadAudio blob is required');
    const form = new FormData();
    form.append('file', blob, requiredString(fileName, 'fileName'));
    form.append('userId', auth.userId);
    form.append('ossDir', 'AVATAR_AUDIO');
    const parsed = await postForm(PATHS.uploadAudio, form, 'uploadAudio');
    if (!parsed.data?.file_path) throw new Error('DreamFace uploadAudio response is missing file_path');
    return { filePath: parsed.data.file_path };
  }

  async function addAvatar(fileUrl) {
    const form = new FormData();
    form.append('user_id', auth.userId);
    form.append('account_id', auth.accountId);
    form.append('url', requiredString(fileUrl, 'fileUrl'));
    form.append('type', 'VIDEO');
    form.append('support_multi_face', 'true');
    const parsed = await postForm(PATHS.avatarAdd, form, 'addAvatar');
    if (!parsed.avatar?.id) throw new Error('DreamFace addAvatar response is missing avatar.id');
    return { avatarId: parsed.avatar.id, avatar: parsed.avatar };
  }

  async function listBatchConfigs(configType = 'SCRIPT') {
    const parsed = await postJson(PATHS.listBatchConfigs, {
      account_id: auth.accountId,
      config_type: configType || 'SCRIPT',
    }, { label: 'listBatchConfigs' });
    const data = parsed.data || {};
    return { configs: Array.isArray(data.configs) ? data.configs : (Array.isArray(data) ? data : []) };
  }

  async function getBatchConfigDetail(id) {
    const parsed = await postJson(PATHS.getBatchConfigDetail, { id }, { label: 'getBatchConfigDetail' });
    return { config: parsed.data || null };
  }

  async function updateBatchConfig(id, name, scriptConfigs) {
    const body = {
      id,
      account_id: auth.accountId,
      type: 'SCRIPT',
      script_configs: scriptConfigs,
    };
    if (name) body.name = name;
    await postJson(PATHS.updateBatchConfig, body, { label: 'updateBatchConfig' });
    return { ok: true };
  }

  async function checkBatchText() {
    await postJson(PATHS.checkBatchText, { texts: [] }, { label: 'checkBatchText' });
    return { ok: true };
  }

  async function animateImageBatch(params) {
    const avatarId = params?.avatarId;
    const videoUrl = params?.videoUrl;
    const scriptConfigs = params?.scriptConfigs || [];
    const batchConfigId = params?.batchConfigId;
    if (!avatarId || !videoUrl || !batchConfigId || !Array.isArray(scriptConfigs) || scriptConfigs.length === 0) {
      throw new Error('animateImageBatch requires avatarId, videoUrl, batchConfigId, and scriptConfigs');
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
    const parsed = await postJson(PATHS.animateImageBatch, {
      aigc_img_no_save_flag: false,
      template_id: requiredString(params.templateId, 'templateId'),
      app_version: APP_VERSION,
      timestamp: Date.now(),
      user_id: auth.userId,
      account_id: auth.accountId,
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
    }, { timeout: submissionTimeoutMs, label: 'animateImageBatch' });
    const successCount = Number(parsed.data?.success_count);
    const failCount = Number(parsed.data?.fail_count);
    if (!Number.isInteger(successCount) || successCount < 0
      || !Number.isInteger(failCount) || failCount < 0
      || successCount + failCount !== scriptConfigs.length) {
      const error = new Error('DreamFace animateImageBatch returned invalid result counters');
      error.code = 'submission_result_invalid';
      throw error;
    }
    return {
      successCount,
      failCount,
      raw: parsed,
    };
  }

  async function getRecentCreations(page = 1, size = 50) {
    const parsed = await postJson(PATHS.getRecentCreations, {
      user_id: auth.userId,
      account_id: auth.accountId,
      page,
      size,
      is_web: true,
      app_version: APP_VERSION,
    }, { label: 'getRecentCreations' });
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

  async function getWorkStatuses(ids) {
    const safeIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (safeIds.length === 0) return { statuses: [] };
    const parsed = await postJson(PATHS.getWorkStatuses, {
      account_id: auth.accountId,
      ids: safeIds,
    }, { label: 'getWorkStatuses' });
    const statuses = Array.isArray(parsed.data) ? parsed.data : [];
    return {
      statuses: statuses.map((item) => ({
        ...item,
        id: item.id || item.work_id || item.workId,
        web_work_status: item.web_work_status ?? item.workStatus ?? item.status,
      })),
    };
  }

  async function getDownloadUrls(ids) {
    const safeIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (safeIds.length === 0) return { urls: [] };
    const parsed = await postJson(PATHS.getDownloadUrls, { ids: safeIds }, { label: 'getDownloadUrls' });
    const urls = Array.isArray(parsed.data) ? parsed.data : [];
    return {
      urls: urls.map((item) => ({
        ...item,
        id: item.id || item.work_id || item.workId,
        url: item.url || item.download_url || item.downloadUrl || item.file_url || item.fileUrl || '',
      })),
    };
  }

  return Object.freeze({
    getAuthContext,
    getAccountCapabilities,
    getBatchTimes,
    getPtVideoInfo,
    getRunningWorks,
    listAvatars,
    createPutUrl,
    putOssFile,
    uploadAudio,
    addAvatar,
    listBatchConfigs,
    getBatchConfigDetail,
    updateBatchConfig,
    checkBatchText,
    animateImageBatch,
    getRecentCreations,
    getWorkStatuses,
    getDownloadUrls,
  });
}
