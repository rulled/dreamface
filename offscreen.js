const RUN_DB_NAME = 'dreamface-run-db';
const RUN_DB_VERSION = 4;
const RUN_STORE_NAME = 'audioTasks';
const INPUT_STORE_NAME = 'inputFiles';
const ENGINE_STATUS_PREFIX = '[engine]';
const MP3_MIME = 'audio/mpeg';
const CREATIONS_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_DURATION_SECONDS = 2;
const DEFAULT_MAX_DURATION_SECONDS = 180;
const OVERLAP_SECONDS = 5;
const TRANSIENT_TASK_RETRY_LIMIT = 2;
const TRANSIENT_TASK_RETRY_BASE_DELAY_MS = 5000;
const BULK_WATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let ffmpeg = null;
let ffmpegLoadPromise = null;
let mediaTransformModulePromise = null;
let runState = createIdleRunState();
let currentRunToken = 0;
let stopRequested = false;
let bulkAccountBusy = false;
let bulkWatcherPromise = null;
let bulkAccountMutex = Promise.resolve();
let runAdmissionToken = null;

function acquireRunAdmission() {
  if (runAdmissionToken) return null;
  runAdmissionToken = Symbol('run-admission');
  return runAdmissionToken;
}

function releaseRunAdmission(token) {
  if (runAdmissionToken === token) runAdmissionToken = null;
}

async function withBulkAccountLock(callback) {
  const previous = bulkAccountMutex;
  let release;
  bulkAccountMutex = new Promise((resolve) => { release = resolve; });
  await previous;
  bulkAccountBusy = true;
  try {
    return await callback();
  } finally {
    bulkAccountBusy = false;
    release();
  }
}

function isBusyPhase(phase) {
  return ['preparing', 'normalizing', 'ready', 'running', 'downloading', 'stopping'].includes(phase);
}

function createIdleRunState() {
  return {
    phase: 'idle',
    mode: 'legacy',
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
    bulkContext: null,
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

function cloneState() {
  return JSON.parse(JSON.stringify(runState));
}

function setStatusText(text) {
  runState.statusText = text;
}

async function pushState() {
  await chrome.runtime.sendMessage({
    action: 'engine.persistRunState',
    state: cloneState(),
  });
}

function mergeState(patch) {
  runState = {
    ...runState,
    ...patch,
  };

  return pushState();
}

function createRunId() {
  return `run-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeFileNameStem(fileName) {
  const lastDot = fileName.lastIndexOf('.');
  return lastDot === -1 ? fileName : fileName.slice(0, lastDot);
}

function toMp3Name(fileName) {
  return `${normalizeFileNameStem(fileName)}.mp3`;
}

function formatFailure(fileName, reason) {
  return { fileName, reason };
}

function throwIfStopped(runToken) {
  if (stopRequested || runToken !== currentRunToken) {
    const error = new Error('run_stopped');
    error.code = 'run_stopped';
    throw error;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientTaskMessage(message = '') {
  const normalized = String(message || '').toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized.includes('timeout')
    || normalized.includes('network')
    || normalized.includes('offline')
    || normalized.includes('connection')
    || normalized.includes('internet')
    || normalized.includes('failed to fetch')
    || normalized.includes('load failed')
    || normalized.includes('err_');
}

function isTransientTaskResult(result) {
  if (!result || result.status !== 'error') {
    return false;
  }

  return isTransientTaskMessage(result.message || '');
}

async function waitForRetryDelay(runToken, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    throwIfStopped(runToken);
    await sleep(Math.min(250, deadline - Date.now()));
  }
}

async function openRunDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RUN_DB_NAME, RUN_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RUN_STORE_NAME)) {
        db.createObjectStore(RUN_STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(INPUT_STORE_NAME)) {
        db.createObjectStore(INPUT_STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
}

async function withStore(storeName, mode, callback) {
  const db = await openRunDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let settled = false;
    let callbackValue;

    transaction.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(callbackValue);
      }
      db.close();
    };

    transaction.onerror = () => {
      if (!settled) {
        settled = true;
        reject(transaction.error || new Error('IndexedDB transaction failed'));
      }
      db.close();
    };

    Promise.resolve(callback(store)).then((value) => {
      callbackValue = value;
    }).catch((error) => {
      if (!settled) {
        settled = true;
        reject(error);
        try { transaction.abort(); } catch {}
      }
    });
  });
}

async function putTaskBlob(record) {
  await withStore(RUN_STORE_NAME, 'readwrite', (store) => {
    store.put(record);
  });
}

async function getTaskBlob(id) {
  return withStore(RUN_STORE_NAME, 'readonly', (store) => new Promise((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Failed to read task blob'));
  }));
}

async function deleteTaskBlob(id) {
  await withStore(RUN_STORE_NAME, 'readwrite', (store) => {
    store.delete(id);
  });
}

async function clearTaskBlobs() {
  await withStore(RUN_STORE_NAME, 'readwrite', (store) => {
    store.clear();
  });
}

async function getInputFileRecord(id) {
  return withStore(INPUT_STORE_NAME, 'readonly', (store) => new Promise((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Failed to read input file'));
  }));
}

async function deleteInputFileRecord(id) {
  await withStore(INPUT_STORE_NAME, 'readwrite', (store) => {
    store.delete(id);
  });
}

async function clearInputFiles() {
  await withStore(INPUT_STORE_NAME, 'readwrite', (store) => {
    store.clear();
  });
}

async function resetRunStateInternal() {
  stopRequested = false;
  currentRunToken += 1;
  await clearTaskBlobs().catch(() => {});
  await clearInputFiles().catch(() => {});
  runState = createIdleRunState();
  await pushState();
}

function toRuntimeFile(record) {
  if (!record?.blob) {
    return null;
  }

  return new File([record.blob], record.name, {
    type: record.type || record.blob.type || 'application/octet-stream',
    lastModified: record.lastModified || Date.now(),
  });
}

async function ensureFfmpegLoaded() {
  if (ffmpeg?.loaded) {
    return ffmpeg;
  }

  if (ffmpegLoadPromise) {
    return ffmpegLoadPromise;
  }

  ffmpegLoadPromise = (async () => {
    ffmpeg = new self.FFmpegWASM.FFmpeg();

    ffmpeg.on('log', ({ message }) => {
      if (!message) {
        return;
      }

      // Показываем только критические ошибки, игнорируя предупреждения о конкатенации
      if (message.includes('Error') || message.includes('Invalid')) {
        // Не показываем стандартные предупреждения о конкатенированных файлах
        if (message.includes('invalid concatenated file') || message.includes('Estimating duration')) {
          return;
        }

        setStatusText(`${ENGINE_STATUS_PREFIX} ${message}`);
        pushState().catch(() => {});
      }
    });

    await ffmpeg.load({
      coreURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.js'),
      wasmURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm'),
    });

    return ffmpeg;
  })().finally(() => {
    ffmpegLoadPromise = null;
  });

  return ffmpegLoadPromise;
}

async function resetFfmpeg() {
  if (ffmpeg) {
    try {
      ffmpeg.terminate();
    } catch (_) {}
  }

  ffmpeg = null;
  ffmpegLoadPromise = null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getAudioDuration(file) {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = new Audio();
    let settled = false;

    const finish = (duration) => {
      if (settled) {
        return;
      }

      settled = true;
      URL.revokeObjectURL(objectUrl);
      resolve(duration);
    };

    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(audio.duration || 0);
    audio.onerror = () => finish(0);
    audio.src = objectUrl;
  });
}

async function safeDeleteFsFile(path) {
  if (!ffmpeg?.loaded) {
    return;
  }

  try {
    await ffmpeg.deleteFile(path);
  } catch (_) {}
}

async function readUint8Array(fileOrBlob) {
  return new Uint8Array(await fileOrBlob.arrayBuffer());
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob as data URL'));
    reader.readAsDataURL(blob);
  });
}

async function encodeMp3(inputPath, outputPath, args, timeoutMs = 180000) {
  const vbrArgs = [...args, '-c:a', 'libmp3lame', '-q:a', '2', outputPath];
  let code = await ffmpeg.exec(vbrArgs, timeoutMs);

  if (code !== 0) {
    await safeDeleteFsFile(outputPath);
    code = await ffmpeg.exec([...args, '-c:a', 'libmp3lame', '-b:a', '192k', outputPath], timeoutMs);
  }

  if (code !== 0) {
    throw new Error(`FFmpeg returned ${code}`);
  }

  const result = await ffmpeg.readFile(outputPath);
  return new Blob([result.buffer.slice(0)], { type: MP3_MIME });
}

async function transcodeFileToMp3(file, fileName, timeoutMs = 180000) {
  await ensureFfmpegLoaded();

  const inputPath = `input-${Date.now()}-${Math.random().toString(16).slice(2)}.${(file.name.split('.').pop() || 'bin').toLowerCase()}`;
  const outputPath = `output-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`;

  try {
    await ffmpeg.writeFile(inputPath, await readUint8Array(file));
    return await encodeMp3(inputPath, outputPath, ['-i', inputPath], timeoutMs);
  } finally {
    await safeDeleteFsFile(inputPath);
    await safeDeleteFsFile(outputPath);
  }
}

async function repairConcatenatedMp3(file, timeoutMs = 180000) {
  await ensureFfmpegLoaded();

  const inputPath = `repair-in-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`;
  const outputPath = `repair-out-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`;

  try {
    await ffmpeg.writeFile(inputPath, await readUint8Array(file));

    // Используем -err_detect ignore_err для игнорирования ошибок конкатенации
    // и перекодируем в чистый MP3 с корректной структурой
    const args = [
      '-err_detect', 'ignore_err',
      '-i', inputPath,
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-write_xing', '1',
      outputPath,
    ];

    const code = await ffmpeg.exec(args, timeoutMs);

    if (code !== 0) {
      throw new Error(`FFmpeg repair failed with code ${code}`);
    }

    const result = await ffmpeg.readFile(outputPath);
    return new Blob([result.buffer.slice(0)], { type: MP3_MIME });
  } finally {
    await safeDeleteFsFile(inputPath);
    await safeDeleteFsFile(outputPath);
  }
}

function blobToRuntimeFile(blob, name, lastModified = Date.now()) {
  return new File([blob], name, {
    type: blob.type || MP3_MIME,
    lastModified,
  });
}

async function addLeftBorderToVideo(file) {
  mediaTransformModulePromise ||= import(chrome.runtime.getURL('media-transform.js'));
  const { transformMp4 } = await mediaTransformModulePromise;
  const result = await transformMp4(await file.arrayBuffer(), { padLeftPx: 64 });
  const mp4Name = `${normalizeFileNameStem(file.name)}.mp4`;
  return new File([result.bytes], mp4Name, {
    type: 'video/mp4',
    lastModified: file.lastModified || Date.now(),
  });
}

async function padShortFile(file) {
  await ensureFfmpegLoaded();

  const inputPath = `pad-in-${Date.now()}-${Math.random().toString(16).slice(2)}.${(file.name.split('.').pop() || 'bin').toLowerCase()}`;
  const outputPath = `pad-out-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`;

  try {
    await ffmpeg.writeFile(inputPath, await readUint8Array(file));
    return await encodeMp3(inputPath, outputPath, [
      '-i', inputPath,
      '-af', `apad=whole_dur=${MIN_DURATION_SECONDS}`,
      '-t', `${MIN_DURATION_SECONDS}`,
    ]);
  } finally {
    await safeDeleteFsFile(inputPath);
    await safeDeleteFsFile(outputPath);
  }
}

async function splitLongFile(file, maxDurationSeconds, overlapEnabled) {
  await ensureFfmpegLoaded();

  const duration = await getAudioDuration(file);
  const step = overlapEnabled
    ? Math.max(MIN_DURATION_SECONDS, maxDurationSeconds - OVERLAP_SECONDS)
    : maxDurationSeconds;
  const inputPath = `split-in-${Date.now()}-${Math.random().toString(16).slice(2)}.${(file.name.split('.').pop() || 'bin').toLowerCase()}`;
  const stem = normalizeFileNameStem(file.name);
  const outputs = [];

  try {
    await ffmpeg.writeFile(inputPath, await readUint8Array(file));

    let start = 0;
    let part = 1;

    while (start < duration) {
      const remaining = duration - start;
      const chunkDuration = Math.min(maxDurationSeconds, remaining);
      const outputPath = `split-out-${part}-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`;
      const encodeArgs = chunkDuration < MIN_DURATION_SECONDS
        ? [
          '-ss', `${start}`,
          '-t', `${chunkDuration}`,
          '-i', inputPath,
          '-af', `apad=whole_dur=${MIN_DURATION_SECONDS}`,
          '-t', `${MIN_DURATION_SECONDS}`,
        ]
        : [
          '-ss', `${start}`,
          '-t', `${chunkDuration}`,
          '-i', inputPath,
        ];

      try {
        const blob = await encodeMp3(inputPath, outputPath, encodeArgs, 240000);

        outputs.push({
          name: `${stem}__part-${String(part).padStart(3, '0')}.mp3`,
          blob,
          type: MP3_MIME,
        });
      } finally {
        await safeDeleteFsFile(outputPath);
      }

      part += 1;
      start += step;
    }

    return outputs;
  } finally {
    await safeDeleteFsFile(inputPath);
  }
}

function isMp3Like(file) {
  return file.type === MP3_MIME || /\.mp3$/i.test(file.name);
}

async function normalizeFile(file, options, runToken) {
  throwIfStopped(runToken);

  const originalFileName = file.name;
  const originalLastModified = file.lastModified || Date.now();
  const configuredMaxDuration = Number(options?.maxDurationSeconds);
  const maxDurationSeconds = Number.isFinite(configuredMaxDuration) && configuredMaxDuration >= MIN_DURATION_SECONDS
    ? configuredMaxDuration
    : DEFAULT_MAX_DURATION_SECONDS;
  let duration = await getAudioDuration(file);

  // Если MP3 файл не читается (конкатенированный или повреждённый), пробуем восстановить через FFmpeg
  if ((!Number.isFinite(duration) || duration <= 0) && isMp3Like(file)) {
    setStatusText(`${ENGINE_STATUS_PREFIX} восстановление ${file.name}`);
    await pushState();

    try {
      const repairedBlob = await repairConcatenatedMp3(file);
      file = blobToRuntimeFile(repairedBlob, toMp3Name(originalFileName), originalLastModified);
      duration = await getAudioDuration(file);

      // Если восстановление успешно, продолжаем с восстановленным файлом
      if (Number.isFinite(duration) && duration > 0) {
        // Файл был восстановлен, возвращаем соответствующий kind
        if (duration < MIN_DURATION_SECONDS) {
          const paddedBlob = await padShortFile(file);
          return {
            ok: true,
            kind: 'repaired',
            outputs: [{
              name: toMp3Name(file.name),
              blob: paddedBlob,
              type: MP3_MIME,
            }],
          };
        }

        // Файл восстановлен, но теперь нужно проверить другие условия
        if (duration > maxDurationSeconds) {
          const outputs = await splitLongFile(file, maxDurationSeconds, options.overlapEnabled);
          return {
            ok: true,
            kind: 'repaired',
            outputs,
          };
        }

        // Файл в норме после восстановления
        return {
          ok: true,
          kind: 'repaired',
          outputs: [{
            name: toMp3Name(file.name),
            blob: file,
            type: MP3_MIME,
          }],
        };
      }
    } catch (repairError) {
      return {
        ok: false,
        reason: `decode error: repair failed (${repairError.message})`,
      };
    }
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    return {
      ok: false,
      reason: 'decode error',
    };
  }

  if (!options.autoNormalize) {
    if (duration < MIN_DURATION_SECONDS) {
      return { ok: false, reason: `audio shorter than ${MIN_DURATION_SECONDS} seconds and auto-processing is disabled` };
    }

    if (duration > maxDurationSeconds) {
      return { ok: false, reason: `audio longer than ${maxDurationSeconds} seconds and auto-processing is disabled` };
    }

    return {
      ok: true,
      kind: 'kept',
      outputs: [{
        name: file.name,
        blob: file,
        type: file.type || 'application/octet-stream',
      }],
    };
  }

  try {
    if (duration < MIN_DURATION_SECONDS) {
      const paddedBlob = await padShortFile(file);
      return {
        ok: true,
        kind: 'padded',
        outputs: [{
          name: toMp3Name(file.name),
          blob: paddedBlob,
          type: MP3_MIME,
        }],
      };
    }

    if (duration > maxDurationSeconds) {
      const outputs = await splitLongFile(file, maxDurationSeconds, options.overlapEnabled);
      return {
        ok: true,
        kind: 'split',
        outputs,
      };
    }

    if (isMp3Like(file)) {
      return {
        ok: true,
        kind: 'kept',
        outputs: [{
          name: file.name,
          blob: file,
          type: MP3_MIME,
        }],
      };
    }

    const convertedBlob = await transcodeFileToMp3(file, toMp3Name(file.name));
    return {
      ok: true,
      kind: 'kept',
      outputs: [{
        name: toMp3Name(file.name),
        blob: convertedBlob,
        type: MP3_MIME,
      }],
    };
  } catch (error) {
    await resetFfmpeg();
    return {
      ok: false,
      reason: /AbortError/i.test(error.message) ? 'timeout' : 'transform error',
    };
  }
}

function countInputFiles(batches) {
  return batches.reduce((total, batch) => total + batch.audioFiles.length, 0);
}

function createTaskId(runId, taskIndex) {
  return `${runId}-task-${String(taskIndex).padStart(4, '0')}`;
}

function getVideoSourceIdentity(source) {
  try {
    const url = new URL(source);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return String(source || '');
  }
}

function rebindUploadedVideo(batches, currentBatchIndex, currentSlotIndex, uploadedIndex) {
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const indices = batches[batchIndex].selectedIndices;
    for (let slotIndex = 0; slotIndex < indices.length; slotIndex += 1) {
      if (batchIndex === currentBatchIndex && slotIndex === currentSlotIndex) {
        indices[slotIndex] = uploadedIndex;
      } else if (indices[slotIndex] >= uploadedIndex) {
        indices[slotIndex] += 1;
      }
    }
  }
}

// ============================================================
// PRE-LOOP phase helper
// ============================================================
//
// payload.batches[i].selectedIndices = [videoIndex, videoIndex, ...]
// normalizedByBatch.get(batch.id) = [{ name, blob, type }, ...]
//
// Для каждой ПАРЫ (batch, videoSlot) делаем:
//   1) посчитать maxAudioMs по нормализованным mp3 этой группы
//   2) запросить у content_script (selectVideoSafe + waitForPreviewVideoSrc)
//      sourceUrl + sourceMs исходного видео по текущему индексу слота
//   3) если sourceMs >= maxAudioMs — пропускаем (видео и так длиннее)
//   4) иначе offscreen preLoopVideo → blob
//   5) content_script uploadPreloopedVideo (через DataTransfer в input)
//   6) дождаться появления в библиотеке + ре-скан видео-сетки
//   7) ВЗЯТЬ ИНДЕКС НОВОГО ВИДЕО из свежего скана
//   8) переписать batch.selectedIndices[slotIdx] = newIndex
//
// ВАЖНО: после каждого upload нумерация foundVideos может ПОЛНОСТЬЮ
// поменяться (сайт обычно ставит новое видео в начало). Поэтому работаем
// итеративно: после каждого upload делаем свежий scan и сверяем длину.
async function runPreLoopPhase(payload, normalizedByBatch, runToken) {
  const tabId = runState.tabId;
  if (!tabId) {
    throw new Error('tabId не известен (вкладка dreamface потеряна)');
  }

  setStatusText(`${ENGINE_STATUS_PREFIX} pre-loop: подготовка видео`);
  await pushState();

  for (let bIdx = 0; bIdx < payload.batches.length; bIdx += 1) {
    throwIfStopped(runToken);

    const batch = payload.batches[bIdx];
    const outputs = normalizedByBatch.get(batch.id) || [];

    if (batch.selectedIndices.length === 0 || outputs.length === 0) {
      continue;
    }

    // максимальная длительность аудио в группе (в мс)
    let maxAudioMs = 0;
    for (const out of outputs) {
      const seconds = await getAudioDuration(out.blob).catch(() => 0);
      const ms = Math.round((Number(seconds) || 0) * 1000);
      if (ms > maxAudioMs) maxAudioMs = ms;
    }

    if (maxAudioMs <= 0) {
      console.warn('[offscreen] preLoop: maxAudioMs=0 для группы', batch.id, '— пропускаем');
      continue;
    }

    // обрабатываем каждый слот видео в этой группе
    for (let slotIdx = 0; slotIdx < batch.selectedIndices.length; slotIdx += 1) {
      throwIfStopped(runToken);

      const currentVideoIndex = batch.selectedIndices[slotIdx];

      setStatusText(`${ENGINE_STATUS_PREFIX} pre-loop: группа ${bIdx + 1}, видео ${slotIdx + 1}/${batch.selectedIndices.length}`);
      await pushState();

      // 1) sourceUrl + sourceMs
      let sourceUrl = '';
      let sourceMs = 0;
      try {
        const resp = await callBackground('engine.pageAction', {
          tabId,
          pageAction: 'getVideoSourceUrlByIndex',
          payload: { videoIndex: currentVideoIndex },
        });
        const data = resp.response || {};
        if (!data.ok) {
          throw new Error(data.error || 'getVideoSourceUrlByIndex failed');
        }
        sourceUrl = String(data.url || '');
        sourceMs = Number(data.durationMs) || 0;
      } catch (err) {
        console.warn(`[offscreen] preLoop: не удалось получить sourceUrl для batch=${bIdx} slot=${slotIdx}: ${err.message}`);
        runState.warnings = [
          ...runState.warnings,
          `pre-loop: не удалось узнать исходный mp4 для видео #${currentVideoIndex} (группа ${bIdx + 1}). эта группа пойдёт по стандартному пути.`,
        ];
        await pushState();
        continue;
      }

      // 2) sourceMs >= maxAudioMs — pre-loop не нужен
      if (sourceMs > 0 && sourceMs >= maxAudioMs) {
        console.log(`[offscreen] preLoop: видео #${currentVideoIndex} уже >= аудио (${sourceMs} >= ${maxAudioMs}), пропускаем`);
        continue;
      }

      // 3) offscreen preLoopVideo
      let preLoopResult;
      try {
        preLoopResult = await handlePreLoopVideo({
          sourceUrl,
          targetMs: maxAudioMs,
          sourceMs,
        });
      } catch (err) {
        console.warn('[offscreen] preLoop: handlePreLoopVideo crash', err.message);
        runState.warnings = [
          ...runState.warnings,
          `pre-loop: ошибка склейки для видео #${currentVideoIndex}: ${err.message}`,
        ];
        await pushState();
        continue;
      }

      if (!preLoopResult.ok) {
        console.warn('[offscreen] preLoop: handlePreLoopVideo result not ok', preLoopResult.error);
        runState.warnings = [
          ...runState.warnings,
          `pre-loop: не удалось склеить видео #${currentVideoIndex}: ${preLoopResult.error}`,
        ];
        await pushState();
        continue;
      }

      console.log('[offscreen] preLoop blob ready', {
        bIdx,
        slotIdx,
        currentVideoIndex,
        bytes: preLoopResult.bytes,
        repeats: preLoopResult.repeats,
        mode: preLoopResult.mode,
      });

      // 4) сколько видео в библиотеке СЕЙЧАС (до upload). это позволит
      // найти индекс нового видео потом.
      let videosBefore = [];
      try {
        const respScan0 = await callBackground('engine.pageAction', {
          tabId,
          pageAction: 'scanPageVideos',
          payload: {},
        });
        videosBefore = Array.isArray(respScan0.response?.videos)
          ? respScan0.response.videos
          : [];
      } catch (err) {
        console.warn('[offscreen] preLoop: pre-upload scan fail', err.message);
      }

      // 5) upload в DreamFace
      const preloopFileName = `preloop-${batch.id}-${slotIdx}-${Date.now()}.mp4`;
      try {
        const uploadResp = await callBackground('engine.pageAction', {
          tabId,
          pageAction: 'uploadPreloopedVideo',
          payload: { blobUrl: preLoopResult.blobUrl, fileName: preloopFileName },
        });
        if (!uploadResp.response?.ok) {
          throw new Error(uploadResp.response?.error || 'uploadPreloopedVideo failed');
        }
      } catch (err) {
        console.warn('[offscreen] preLoop: uploadPreloopedVideo crash', err.message);
        runState.warnings = [
          ...runState.warnings,
          `pre-loop: не удалось залить склеенное видео для #${currentVideoIndex}: ${err.message}`,
        ];
        await pushState();
        // освободим blob, который не использовали
        await callBackground('engine.pageAction', {
          tabId, pageAction: 'noop', payload: {},
        }).catch(() => {});
        try {
          await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'revokeBlob',
            payload: { blobUrl: preLoopResult.blobUrl },
          });
        } catch {}
        continue;
      }

      // 6) повторный scan чтобы найти новый индекс
      let newIndex = -1;
      try {
        // даём dreamface несколько секунд чтобы карточка проявилась
        await new Promise((r) => setTimeout(r, 1500));
        const respScan = await callBackground('engine.pageAction', {
          tabId,
          pageAction: 'scanPageVideos',
          payload: {},
        });
        const videosAfter = Array.isArray(respScan.response?.videos)
          ? respScan.response.videos
          : [];
        const beforeSources = new Set(
          videosBefore.map((video) => video?.src).filter(Boolean).map(getVideoSourceIdentity),
        );
        const addedVideos = videosAfter.filter((video) => (
          video?.src && !beforeSources.has(getVideoSourceIdentity(video.src))
        ));
        const candidateIndex = Number(addedVideos[0]?.index);
        if (addedVideos.length === 1 && Number.isInteger(candidateIndex) && candidateIndex >= 0) {
          newIndex = candidateIndex;
        }
      } catch (err) {
        console.warn('[offscreen] preLoop: post-upload scan fail', err.message);
      }

      // освобождаем blob независимо от исхода
      try {
        await handleRevokeBlob({ blobUrl: preLoopResult.blobUrl });
      } catch {}

      if (newIndex < 0) {
        throw new Error(`pre-loop: не удалось однозначно найти залитое видео #${currentVideoIndex}`);
      }

      rebindUploadedVideo(payload.batches, bIdx, slotIdx, newIndex);

      console.log('[offscreen] preLoop: slot перепривязан', {
        bIdx, slotIdx, oldIndex: currentVideoIndex, newIndex,
        updatedSelectedIndices: [...batch.selectedIndices],
      });

      // помечаем batch как pre-looped — пригодится дальше, чтобы
      // выключить hasChapters при скачивании результатов этой группы.
      batch.preLoopApplied = true;
    }
  }
}

async function prepareTasks(payload, runToken) {
  const normalizedByBatch = new Map();
  const summary = {
    totalInputFiles: countInputFiles(payload.batches),
    totalGeneratedTasks: 0,
    keptFiles: [],
    paddedFiles: [],
    splitFiles: [],
    repairedFiles: [],
    failedFiles: [],
  };

  let processedCount = 0;
  let generatedTasks = 0;

  for (const batch of payload.batches) {
    const normalizedOutputs = [];

    for (const fileRef of batch.audioFiles) {
      throwIfStopped(runToken);

      const sourceRecord = await getInputFileRecord(fileRef.id);
      const file = toRuntimeFile(sourceRecord);
      if (!file) {
        summary.failedFiles.push(formatFailure(fileRef.name || 'unknown', 'source file missing'));
        runState.failures = [...runState.failures, `${fileRef.name || 'unknown'}: source file missing`];
        processedCount += 1;
        runState.normalization.processedCount = processedCount;
        runState.summary = summary;
        await pushState();
        continue;
      }

      runState.phase = 'normalizing';
      runState.normalization.currentFile = file.name;
      runState.normalization.processedCount = processedCount;
      runState.normalization.totalCount = summary.totalInputFiles;
      runState.normalization.generatedTasks = generatedTasks;
      setStatusText(`${ENGINE_STATUS_PREFIX} подготовка ${file.name}`);
      await pushState();

      const result = await normalizeFile(file, payload.options, runToken);
      processedCount += 1;
      await deleteInputFileRecord(fileRef.id);

      if (!result.ok) {
        summary.failedFiles.push(formatFailure(file.name, result.reason));
        runState.failures = [...runState.failures, `${file.name}: ${result.reason}`];
      } else {
        normalizedOutputs.push(...result.outputs);
        generatedTasks += result.outputs.length;

        if (result.kind === 'kept') {
          summary.keptFiles.push(file.name);
        } else if (result.kind === 'padded') {
          summary.paddedFiles.push(file.name);
        } else if (result.kind === 'split') {
          summary.splitFiles.push({
            fileName: file.name,
            parts: result.outputs.length,
          });
        } else if (result.kind === 'repaired') {
          summary.repairedFiles.push(file.name);
        }
      }

      runState.normalization.processedCount = processedCount;
      runState.normalization.generatedTasks = generatedTasks;
      runState.summary = summary;
      await pushState();
    }

    normalizedByBatch.set(batch.id, normalizedOutputs);
  }

  // ============================================================
  // PRE-LOOP фаза: если опция включена, делаем локально склейку видео
  // forward-only под длительность САМОГО ДЛИННОГО нормализованного аудио
  // в группе, заливаем результат на dreamface как новое видео и подменяем
  // selectedIndices в batch на свежий индекс этого нового видео.
  // ============================================================
  // Делаем это ПОСЛЕ нормализации (мы уже знаем точные mp3 длительности)
  // и ДО сборки queue (чтобы queue.videoIndex сразу указывал на pre-loop'ed).
  if (payload.options?.preLoopEnabled) {
    try {
      await runPreLoopPhase(payload, normalizedByBatch, runToken);
    } catch (error) {
      // pre-loop фолбечится молча: если хоть один видео-слот в группе
      // не удалось pre-loop'ить — конкретно эта группа пойдёт по СТАРОМУ
      // пути (через chapter-markers). весь run при этом не падает.
      console.warn('[offscreen] preLoop phase failed:', error.message);
      runState.warnings = [
        ...runState.warnings,
        `pre-loop фаза завершилась с ошибкой: ${error.message}. остальные группы обработаны по стандартному пути.`,
      ];
      await pushState();
    }
  }

  const queue = [];
  let queueIndex = 1;

  // snapshot групп для monitor UI — индекс, id, размер группы, первые имена
  // (имена нужны на случай если юзер захочет понять "какая это группа")
  const batchesMeta = [];

  for (let bIdx = 0; bIdx < payload.batches.length; bIdx += 1) {
    const batch = payload.batches[bIdx];
    const outputs = normalizedByBatch.get(batch.id) || [];

    if (batch.selectedIndices.length === 0 || outputs.length === 0) {
      batchesMeta.push({
        batchId: batch.id,
        batchIndex: bIdx,
        videoCount: batch.selectedIndices.length,
        audioCount: batch.audioFiles.length,
        taskCount: 0,
        sampleAudioNames: batch.audioFiles.slice(0, 2).map((f) => f.name),
      });
      continue;
    }

    let videoPointer = 0;
    const batchStartQueueIndex = queue.length;

    for (const output of outputs) {
      const taskId = createTaskId(runState.runId, queueIndex);
      await putTaskBlob({
        id: taskId,
        runId: runState.runId,
        name: output.name,
        type: output.type || MP3_MIME,
        blob: output.blob,
      });

      queue.push({
        id: taskId,
        displayIndex: queueIndex,
        fileName: output.name,
        mimeType: output.type || MP3_MIME,
        videoIndex: batch.selectedIndices[videoPointer],
        workId: '',
        animateImageId: '',
        borderCropPx: Math.max(0, Math.floor(Number(batch.selectedBorderCropPx?.[videoPointer]) || 0)),
        // привязка к группе для UI
        batchId: batch.id,
        batchIndex: bIdx,
      });

      queueIndex += 1;
      videoPointer = (videoPointer + 1) % batch.selectedIndices.length;
    }

    batchesMeta.push({
      batchId: batch.id,
      batchIndex: bIdx,
      videoCount: batch.selectedIndices.length,
      audioCount: batch.audioFiles.length,
      taskCount: queue.length - batchStartQueueIndex,
      sampleAudioNames: batch.audioFiles.slice(0, 2).map((f) => f.name),
    });
  }

  summary.totalGeneratedTasks = queue.length;
  // batchesMeta уезжает в summary, чтобы попасть в runState через стандартный pushState
  summary.batches = batchesMeta;
  return { queue, summary };
}

async function callBackground(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...payload });

  if (!response?.ok) {
    throw new Error(response?.error || `Failed action: ${action}`);
  }

  return response;
}

async function callBulkOp(op, payload = {}) {
  const response = await callBackground('dfBulkOp', { op, payload });
  return response.data;
}

async function getCachedAvatarId(videoUrl, accountId) {
  const response = await chrome.runtime.sendMessage({
    action: 'dfGetAvatarCache', videoUrl, accountId,
  }).catch(() => null);
  return response?.ok ? response.avatarId : null;
}

async function setCachedAvatarId(videoUrl, accountId, avatarId) {
  await chrome.runtime.sendMessage({
    action: 'dfSetAvatarCache', videoUrl, accountId, avatarId,
  }).catch(() => {});
}

async function invalidateCachedAvatarId(videoUrl, accountId) {
  await chrome.runtime.sendMessage({
    action: 'dfDeleteAvatarCache', videoUrl, accountId,
  }).catch(() => {});
}

async function capturePageSession() {
  return chrome.runtime.sendMessage({ action: 'dfCaptureAccount' }).catch(() => null);
}

async function selectLeastLoadedAccount(requiredDurationSeconds = 0, plannedLoads = new Map(), sourceVideoUrl = '') {
  const listed = await callBackground('dfListAccounts');
  const captured = await callBackground('dfCaptureAccount').catch(() => null);
  const accounts = Array.isArray(listed.accounts) ? [...listed.accounts] : [];
  if (captured?.hasAuth && captured.accountId) {
    const savedIndex = accounts.findIndex((account) => account.principalKey === captured.principalKey);
    const saved = savedIndex >= 0 ? accounts[savedIndex] : null;
    const current = {
      ...captured,
      ...(saved?.durationSource === 'manual' ? {
        maxDurationSeconds: saved.maxDurationSeconds,
        durationSource: 'manual',
      } : {}),
      capturedAt: Date.now(),
    };
    if (savedIndex >= 0) accounts[savedIndex] = current;
    else accounts.push(current);
  }
  if (accounts.length === 0) throw new Error('DreamFace account is not authenticated');

  let selected = null;
  let fallback = null;
  for (const account of accounts) {
    try {
      await callBackground('dfSwitchAccount', { session: account });
      const auth = await callBulkOp('getAuthContext');
      if (!auth?.hasAuth || auth.accountId !== account.accountId) {
        throw new Error(`DreamFace account ${account.accountId} switch verification failed`);
      }
      const capabilities = await callBulkOp('getAccountCapabilities');
      const effectiveAccount = { ...account, ...auth, ...capabilities };
      const running = await callBulkOp('getRunningWorks');
      const load = Array.isArray(running?.workIds) ? running.workIds.length : Number.MAX_SAFE_INTEGER;
      let reservation = plannedLoads.get(effectiveAccount.accountId);
      if (!reservation || typeof reservation !== 'object') {
        reservation = { baselineLoad: load, assigned: Number(reservation || 0) };
        plannedLoads.set(effectiveAccount.accountId, reservation);
      }
      const hasCachedAvatar = sourceVideoUrl
        ? Boolean(await getCachedAvatarId(sourceVideoUrl, effectiveAccount.accountId))
        : false;
      const affinityBonus = hasCachedAvatar ? 2 : 0;
      const candidate = {
        account: effectiveAccount,
        load,
        planned: reservation.assigned,
        hasCachedAvatar,
        score: Math.max(0, Math.max(load, reservation.baselineLoad + reservation.assigned) - affinityBonus),
      };
      if (!fallback
        || Number(effectiveAccount.maxDurationSeconds || 0) > Number(fallback.account.maxDurationSeconds || 0)
        || (Number(effectiveAccount.maxDurationSeconds || 0) === Number(fallback.account.maxDurationSeconds || 0) && candidate.score < fallback.score)) {
        fallback = candidate;
      }
      if (Number(effectiveAccount.maxDurationSeconds || 0) >= requiredDurationSeconds
        && (!selected || candidate.score < selected.score)) {
        selected = candidate;
      }
    } catch (_) {}
  }

  selected ||= fallback;
  if (!selected) throw new Error('captured DreamFace accounts are unavailable or expired');
  await callBackground('dfSwitchAccount', { session: selected.account });
  const selectedAuth = await callBulkOp('getAuthContext');
  if (!selectedAuth?.hasAuth || selectedAuth.accountId !== selected.account.accountId) {
    throw new Error(`DreamFace account ${selected.account.accountId} switch verification failed`);
  }
  await callBackground('dfSaveAccount', { account: selected.account }).catch(() => {});
  return selected.account;
}

async function activateAccount(accountId, principalKey = '') {
  const captured = await callBackground('dfCaptureAccount').catch(() => null);
  let account = captured?.hasAuth
    && (captured.accountId === accountId || (principalKey && captured.principalKey === principalKey))
    ? captured
    : null;
  let canonicalAccount = null;
  if (!account) {
    const response = await callBackground('dfGetAccountSession', { accountId, principalKey }).catch(() => null);
    canonicalAccount = response?.canonicalAccount || null;
    account = canonicalAccount || response?.account || null;
  }
  if (!account) throw new Error(`DreamFace account ${accountId} is not saved`);
  await callBackground('dfSwitchAccount', { session: account });
  const auth = await callBulkOp('getAuthContext');
  if (!auth?.hasAuth
    || auth.accountId !== account.accountId
    || (account.principalKey && auth.principalKey !== account.principalKey)) {
    throw new Error(`DreamFace account ${accountId} switch failed`);
  }
  return { ...account, ...auth, rotatedFromAccountId: canonicalAccount?.accountId !== accountId ? accountId : '' };
}

async function activateBulkRunAccount(requiredDurationSeconds = 0) {
  if (!runState.bulkContext?.accountId) {
    const selected = await selectLeastLoadedAccount(requiredDurationSeconds);
    const auth = await callBulkOp('getAuthContext');
    if (!auth?.hasAuth) throw new Error('DreamFace account is not authenticated');
    runState.bulkContext = {
      accountId: selected?.accountId || auth.accountId,
      maxDurationSeconds: Number(selected?.maxDurationSeconds || 180),
    };
    await pushState();
    return auth;
  }

  const listed = await callBackground('dfListAccounts');
  const saved = (listed.accounts || []).find((account) => account.accountId === runState.bulkContext.accountId);
  if (saved) await callBackground('dfSwitchAccount', { session: saved });
  const auth = await callBulkOp('getAuthContext');
  if (!auth?.hasAuth || auth.accountId !== runState.bulkContext.accountId) {
    throw new Error(`DreamFace account ${runState.bulkContext.accountId} is unavailable or expired`);
  }
  return auth;
}

async function restoreBulkPresetIfNeeded() {
  const context = runState.bulkContext;
  if (!context?.presetDirty || !context.batchConfigId) return;
  if (!context.accountId) throw new Error('dirty preset account is unknown');
  await activateAccount(context.accountId);
  await callBulkOp('updateBatchConfig', {
    id: context.batchConfigId,
    name: context.batchName || 'Bulk Batch',
    scriptConfigs: Array.isArray(context.originalScriptConfigs) ? context.originalScriptConfigs : [],
  });
  runState.bulkContext = { ...context, presetDirty: false };
  await pushState();
}

async function putOssFileDirect(putUrl, blob, contentType) {
  const response = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: blob,
  });
  if (!response.ok) throw new Error(`OSS upload failed: ${response.status}`);
}

async function uploadAudioDirect(blob, fileName, auth) {
  const form = new FormData();
  form.append('file', blob, fileName);
  form.append('userId', auth.userId);
  form.append('ossDir', 'AVATAR_AUDIO');
  const response = await fetch('https://www.dreamfaceapp.com/dw-server/phone_file/upload_audio_with_dir', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'dream-face-web': 'dream-face-web',
      token: auth.token,
      'client-id': auth.clientId,
    },
    body: form,
    credentials: 'include',
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || parsed?.status_msg !== 'Success' || !parsed?.data?.file_path) {
    throw new Error(parsed?.status_msg || `audio upload failed: ${response.status}`);
  }
  return { filePath: parsed.data.file_path };
}

async function prepareBulkPlan(payload, runToken) {
  const queue = [];
  const consumedInputIds = [];
  const summary = {
    totalInputFiles: countInputFiles(payload.batches),
    totalGeneratedTasks: 0,
    keptFiles: [],
    paddedFiles: [],
    splitFiles: [],
    repairedFiles: [],
    failedFiles: [],
    batches: [],
  };
  let processedCount = 0;
  let taskIndex = 1;

  for (let batchIndex = 0; batchIndex < payload.batches.length; batchIndex += 1) {
    const batch = payload.batches[batchIndex];
    const audioTasks = [];

    for (let sourceIndex = 0; sourceIndex < (batch.audioFiles || []).length; sourceIndex += 1) {
      const fileRef = batch.audioFiles[sourceIndex];
      throwIfStopped(runToken);
      const sourceRecord = await getInputFileRecord(fileRef.id);
      const file = toRuntimeFile(sourceRecord);
      if (!file) {
        const name = fileRef.name || 'unknown';
        summary.failedFiles.push(formatFailure(name, 'source file missing'));
        runState.failures = [...runState.failures, `${name}: source file missing`];
        continue;
      }

      runState.phase = 'normalizing';
      runState.normalization.currentFile = file.name;
      setStatusText(`${ENGINE_STATUS_PREFIX} подготовка ${file.name}`);
      await pushState();

      const result = await normalizeFile(file, payload.options, runToken);
      processedCount += 1;

      if (!result.ok) {
        summary.failedFiles.push(formatFailure(file.name, result.reason));
        runState.failures = [...runState.failures, `${file.name}: ${result.reason}`];
      } else {
        for (const output of result.outputs) {
          const id = createTaskId(runState.runId, taskIndex);
          const runtimeFile = blobToRuntimeFile(output.blob, output.name);
          const durationMs = Math.max(0, (await getAudioDuration(runtimeFile)) * 1000);
          await putTaskBlob({ id, runId: runState.runId, name: output.name, type: output.type || MP3_MIME, blob: output.blob, durationMs });
          audioTasks.push({ id, fileName: output.name, mimeType: output.type || MP3_MIME, durationMs, sourceIndex });
          taskIndex += 1;
        }
        summary.totalGeneratedTasks += result.outputs.length;
        if (result.kind === 'kept') summary.keptFiles.push(file.name);
        else if (result.kind === 'padded') summary.paddedFiles.push(file.name);
        else if (result.kind === 'repaired') summary.repairedFiles.push(file.name);
        else if (result.kind === 'split') summary.splitFiles.push({ fileName: file.name, parts: result.outputs.length });
      }
      consumedInputIds.push(fileRef.id);

      runState.normalization.processedCount = processedCount;
      runState.normalization.generatedTasks = summary.totalGeneratedTasks;
      runState.summary = summary;
      await pushState();
    }

    const videos = batch.selectedAvatars || [];
    const assigned = videos.map(() => []);
    for (const audio of audioTasks) {
      if (videos.length > 0) assigned[audio.sourceIndex % videos.length].push(audio);
    }

    for (let videoIndex = 0; videoIndex < videos.length; videoIndex += 1) {
      if (assigned[videoIndex].length === 0) continue;
      queue.push({
        id: `${runState.runId}-bulk-${String(queue.length + 1).padStart(3, '0')}`,
        batchId: batch.id,
        batchIndex,
        video: videos[videoIndex],
        audios: assigned[videoIndex],
        workIds: [],
      });
    }

    summary.batches.push({
      batchId: batch.id,
      batchIndex,
      videoCount: videos.length,
      audioCount: audioTasks.length,
      taskCount: audioTasks.length,
      sampleAudioNames: audioTasks.slice(0, 2).map((item) => item.fileName),
    });
  }

  return { queue, summary, consumedInputIds };
}

async function getLongestInputDurationSeconds(batches, runToken) {
  let longest = 0;
  for (const batch of batches || []) {
    for (const fileRef of batch.audioFiles || []) {
      throwIfStopped(runToken);
      const file = toRuntimeFile(await getInputFileRecord(fileRef.id));
      if (file) longest = Math.max(longest, await getAudioDuration(file));
    }
  }
  return longest;
}

async function getBulkWatchUnits() {
  const resp = await callBackground('dfGetBulkWatchUnits');
  const units = Array.isArray(resp?.units) ? resp.units : [];
  const now = Date.now();
  const expiredTerminalUnits = units.filter((unit) => (
    unit.status !== 'pending'
    && now - Number(unit.updatedAt || unit.createdAt || 0) > BULK_WATCH_MAX_AGE_MS
  ));
  for (const unit of expiredTerminalUnits) await removeBulkWatchUnit(unit.id);
  const expiredIds = new Set(expiredTerminalUnits.map((unit) => unit.id));
  return units.filter((unit) => !expiredIds.has(unit.id));
}

async function enrichWatchUnitPrincipals(units) {
  const cache = new Map();
  for (const unit of units) {
    if (unit.principalKey && !/^(account|user):/i.test(unit.principalKey)) continue;
    if (!cache.has(unit.accountId)) {
      const response = await callBackground('dfGetAccountSession', { accountId: unit.accountId }).catch(() => null);
      cache.set(unit.accountId, response?.account?.principalKey || `account:${unit.accountId}`);
    }
    unit.principalKey = cache.get(unit.accountId);
  }
  return units;
}

function reconcileDuplicateWatchClaims(units) {
  const claimed = new Set();
  for (const unit of units.slice().sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt))) {
    unit.workIds = (unit.workIds || []).map((id) => {
      if (!id || !claimed.has(String(id))) {
        if (id) claimed.add(String(id));
        return id;
      }
      unit.enqueuedWorkIds = (unit.enqueuedWorkIds || []).filter((item) => item !== id);
      unit.failedWorkIds = (unit.failedWorkIds || []).filter((item) => item !== id);
      return '';
    });
  }
}

async function addBulkWatchUnit(unit) {
  const watchUnit = {
    ...unit,
    workIds: Array(unit.expectedFileNames.length).fill(''),
    enqueuedWorkIds: [],
    failedWorkIds: [],
    baselineWorkIds: Array.isArray(unit.baselineWorkIds) ? unit.baselineWorkIds : [],
    correlationDeadline: unit.correlationDeadline || new Date(Date.now() + (30 * 60 * 1000)).toISOString(),
    status: 'pending',
    targetCount: Math.max(0, Number(unit.targetCount ?? unit.expectedFileNames.length)),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await callBackground('dfUpsertBulkWatchUnit', { unit: watchUnit });
  return watchUnit;
}

async function removeBulkWatchUnit(id) {
  await callBackground('dfRemoveBulkWatchUnit', { id });
}

function assignCreationItemsToWatchUnits(units, items, allAccountUnits = units) {
  const candidates = (items || [])
    .filter((item) => item?.id && item?.work_name && item.work_type === 'AVATAR_VIDEO')
    .sort((a, b) => toEpochMs(a.create_time) - toEpochMs(b.create_time));
  const candidateById = new Map(candidates.map((item) => [String(item.id), item]));

  for (const unit of units) {
    const baselineIds = new Set((unit.baselineWorkIds || []).map(String));
    const minTime = new Date(unit.submittedAt).getTime() - 30000;
    const maxTime = unit.correlationDeadline ? new Date(unit.correlationDeadline).getTime() : Infinity;
    unit.workIds = (unit.workIds || Array(unit.expectedFileNames.length).fill('')).map((id, index) => {
      if (!id) return '';
      const item = candidateById.get(String(id));
      const itemTime = toEpochMs(item?.create_time);
      const valid = item
        && item.work_name === unit.expectedFileNames[index]
        && !baselineIds.has(String(id))
        && itemTime >= minTime
        && itemTime <= maxTime;
      if (valid) return String(id);
      unit.enqueuedWorkIds = (unit.enqueuedWorkIds || []).filter((entry) => entry !== id);
      unit.failedWorkIds = (unit.failedWorkIds || []).filter((entry) => entry !== id);
      return '';
    });
  }

  const claimed = new Set(allAccountUnits.flatMap((unit) => unit.workIds || []).filter(Boolean));

  for (const unit of units.slice().sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt))) {
    const minTime = new Date(unit.submittedAt).getTime() - 30000;
    const maxTime = unit.correlationDeadline ? new Date(unit.correlationDeadline).getTime() : Infinity;
    const baselineIds = new Set(unit.baselineWorkIds || []);
    unit.workIds ||= Array(unit.expectedFileNames.length).fill('');
    for (let index = 0; index < unit.expectedFileNames.length; index += 1) {
      if (unit.workIds.filter(Boolean).length >= Number(unit.targetCount || unit.expectedFileNames.length)) break;
      if (unit.workIds[index]) continue;
      const match = candidates.find((item) => (
        !claimed.has(String(item.id))
        && !baselineIds.has(String(item.id))
        && item.work_name === unit.expectedFileNames[index]
        && toEpochMs(item.create_time) >= minTime
        && toEpochMs(item.create_time) <= maxTime
      ));
      if (!match) continue;
      unit.workIds[index] = String(match.id);
      claimed.add(String(match.id));
    }
  }
}

function toEpochMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

async function watchAccountUnits(accountId, units, allAccountUnits) {
  const activeAccount = await activateAccount(accountId, units[0]?.principalKey || '');
  if (activeAccount.accountId !== accountId) {
    for (const unit of units) unit.accountId = activeAccount.accountId;
  }
  let allItems = [];
  const oldestSubmitMs = Math.min(...units.map((unit) => new Date(unit.submittedAt).getTime()).filter(Number.isFinite));
  for (let page = 1; ; page += 1) {
    const result = await callBulkOp('getRecentCreations', { page, size: 100 });
    const pageItems = result?.items || [];
    allItems = allItems.concat(pageItems);
    const pageTimes = pageItems.map((item) => toEpochMs(item?.create_time)).filter((time) => time > 0);
    const oldestPageItemMs = pageTimes.length > 0 ? Math.min(...pageTimes) : Infinity;
    if (page * 100 >= Number(result?.count || 0)
      || pageItems.length === 0
      || (Number.isFinite(oldestSubmitMs) && oldestPageItemMs < oldestSubmitMs - 30000)) break;
  }
  assignCreationItemsToWatchUnits(units, allItems, allAccountUnits);
  for (const unit of units) {
    unit.watcherStats = {
      checkedAt: new Date().toISOString(),
      scanned: allItems.length,
      matched: (unit.workIds || []).filter(Boolean).length,
      sampleNames: allItems.slice(0, 3).map((item) => item.work_name || item.name || '').filter(Boolean),
    };
    unit.lastError = '';
  }

  const dmState = await callBackground('dm.getState').catch(() => ({ entries: [] }));
  const dmStatusById = new Map((dmState.entries || []).map((entry) => [String(entry.workId), entry.status]));
  const terminalDownloadFailures = new Set(['failed', 'interrupted', 'missing']);
  for (const unit of units) {
    unit.enqueuedWorkIds = (unit.enqueuedWorkIds || []).filter((id) => dmStatusById.has(String(id)));
  }

  const discoveredIds = units.flatMap((unit) => unit.workIds || []).filter(Boolean);
  const statusResult = await callBulkOp('getWorkStatuses', { ids: discoveredIds });
  const statusById = new Map((statusResult?.statuses || []).map((row) => [String(row.id), Number(row.web_work_status)]));
  for (const item of allItems) {
    if (item?.id && !statusById.has(String(item.id))) statusById.set(String(item.id), Number(item.web_work_status));
  }

  const readyIds = [];
  for (const unit of units) {
    const enqueued = new Set(unit.enqueuedWorkIds || []);
    const failed = new Set(unit.failedWorkIds || []);
    const statusCounts = {};
    for (const id of unit.workIds || []) {
      const status = statusById.get(String(id));
      const statusKey = status === undefined || Number.isNaN(status) ? 'unknown' : String(status);
      statusCounts[statusKey] = (statusCounts[statusKey] || 0) + 1;
      if (status === 200 && !enqueued.has(id)) readyIds.push(id);
      if ((status === -1 || status === -2) && !failed.has(id)) failed.add(id);
    }
    unit.failedWorkIds = [...failed];
    unit.watcherStats = {
      ...unit.watcherStats,
      statuses: statusCounts,
      ready: (unit.workIds || []).filter((id) => statusById.get(String(id)) === 200).length,
      requestedUrls: 0,
      receivedUrls: 0,
    };
  }

  if (readyIds.length > 0) {
    const downloadResult = await callBulkOp('getDownloadUrls', { ids: [...new Set(readyIds)] });
    const urlById = new Map((downloadResult?.urls || []).filter((item) => item?.id && item?.url).map((item) => [String(item.id), item.url]));
    const queueItems = [];
    const queueRefs = [];
    for (const unit of units) {
      const enqueued = new Set(unit.enqueuedWorkIds || []);
      const unitReadyIds = unit.workIds.filter((id) => readyIds.includes(id));
      unit.watcherStats.requestedUrls = unitReadyIds.length;
      unit.watcherStats.receivedUrls = unitReadyIds.filter((id) => urlById.has(id)).length;
      for (let index = 0; index < unit.workIds.length; index += 1) {
        const id = unit.workIds[index];
        const url = urlById.get(id);
        if (!id || !url || enqueued.has(id)) continue;
        queueItems.push({
          workId: id,
          runId: unit.runId || '',
          accountId: unit.accountId || '',
          watchUnitId: unit.id || '',
          workName: unit.expectedFileNames[index] || id,
          audioFileName: unit.expectedFileNames[index] || '',
          url,
          audioMs: null,
          videoMs: null,
          hasChapters: false,
        });
        queueRefs.push({ unit, id });
      }
    }
    if (queueItems.length > 0) {
      await callBackground('dm.enqueue', { payload: { items: queueItems } });
      for (const { unit, id } of queueRefs) {
        unit.enqueuedWorkIds = [...new Set([...(unit.enqueuedWorkIds || []), id])];
      }
    }
  }

  for (const unit of units) {
    const doneIds = (unit.workIds || []).filter((id) => dmStatusById.get(String(id)) === 'done');
    const downloadFailedIds = (unit.workIds || []).filter((id) => terminalDownloadFailures.has(dmStatusById.get(String(id))));
    const targetCount = Number(unit.targetCount || unit.expectedFileNames.length);
    if (doneIds.length >= targetCount) unit.status = 'complete';
    else if (doneIds.length + (unit.failedWorkIds || []).length + downloadFailedIds.length >= targetCount) unit.status = 'failed';
    else if (unit.correlationDeadline && Date.now() > new Date(unit.correlationDeadline).getTime()) unit.status = 'failed';
    else unit.status = 'pending';
    unit.updatedAt = Date.now();
  }
}

async function runBulkWatcher({ allowDuringRun = false } = {}) {
  if (!allowDuringRun && runState.phase === 'running') return { ok: true, skipped: 'run-active' };
  if (bulkWatcherPromise) return bulkWatcherPromise;
  bulkWatcherPromise = withBulkAccountLock(async () => {
    const original = await capturePageSession();
    try {
    const units = await enrichWatchUnitPrincipals(await getBulkWatchUnits());
    const pendingUnits = units.filter((unit) => unit.status === 'pending');
    reconcileDuplicateWatchClaims(pendingUnits);
    const byAccount = new Map();
    for (const unit of pendingUnits) {
      const key = unit.principalKey || `account:${unit.accountId}`;
      if (!byAccount.has(key)) byAccount.set(key, []);
      byAccount.get(key).push(unit);
    }
    const errors = [];
    for (const [, accountUnits] of byAccount) {
      try {
        await watchAccountUnits(accountUnits[0].accountId, accountUnits, accountUnits);
      } catch (error) {
        errors.push(error.message || String(error));
        for (const unit of accountUnits) {
          unit.lastError = error.message || String(error);
          unit.updatedAt = Date.now();
        }
      }
    }
    await callBackground('dfPatchBulkWatchUnits', { units: pendingUnits });
    return {
      ok: errors.length === 0,
      pending: pendingUnits.filter((unit) => unit.status === 'pending').length,
      errors,
    };
    } finally {
      if (original) {
        const restore = await callBackground('dfSwitchAccount', { session: original }).catch((error) => ({ ok: false, error: error.message }));
        const restored = await capturePageSession();
        if (!restore?.ok
          || Boolean(restored?.hasAuth) !== Boolean(original.hasAuth)
          || (original.hasAuth && restored?.accountId !== original.accountId)) {
          throw new Error(restore?.error || 'watcher could not restore original DreamFace session');
        }
      }
    }
  }).finally(() => {
    bulkWatcherPromise = null;
  });
  return bulkWatcherPromise;
}

async function processBulkQueue(queue, runToken, startIndex = 0) {
  const expectedFiles = queue.flatMap((unit) => unit.audios.map((audio) => audio.fileName));
  runState.queuePlan = queue.map((unit) => ({ ...unit, audios: unit.audios.map((audio) => ({ ...audio })) }));
  runState.nextTaskIndex = startIndex;
  runState.total = expectedFiles.length;
  runState.phase = 'running';
  runState.downloadPlan = {
    ...runState.downloadPlan,
    expectedFileNames: expectedFiles,
    expectedWorkIds: queue.flatMap((unit) => unit.workIds || []),
    totalExpected: expectedFiles.length,
    lastStatus: 'watching',
  };
  await pushState();

  let completedAudioCount = queue.slice(0, startIndex).reduce((sum, unit) => sum + unit.audios.length, 0);
  runState.current = completedAudioCount;
  const plannedLoads = new Map();

  for (let index = startIndex; index < queue.length; index += 1) {
    throwIfStopped(runToken);
    const unit = queue[index];
    if (unit.status === 'submitting' || unit.status === 'partial') {
      await failRun(
        `${unit.video.name}: статус bulk-отправки неизвестен. проверьте Creations перед повторным запуском, чтобы избежать дублей.`,
        'bulk_submission_uncertain',
      );
      return;
    }
    if (unit.status === 'submitted') {
      for (const audio of unit.audios) await deleteTaskBlob(audio.id);
      completedAudioCount += unit.audios.length;
      runState.current = completedAudioCount;
      runState.nextTaskIndex = index + 1;
      runState.queuePlan[index] = { ...unit, status: unit.status };
      await pushState();
      continue;
    }

    await withBulkAccountLock(async () => {
    const requiredDurationSeconds = unit.audios.reduce((max, audio) => Math.max(max, Number(audio.durationMs || 0) / 1000), 0);
    let selectedAccount;
    if (unit.accountId) {
      selectedAccount = await activateAccount(unit.accountId);
      throwIfStopped(runToken);
      const capabilities = await callBulkOp('getAccountCapabilities');
      throwIfStopped(runToken);
      selectedAccount = { ...selectedAccount, ...capabilities };
    } else {
      selectedAccount = await selectLeastLoadedAccount(requiredDurationSeconds, plannedLoads, unit.video.videoUrl);
      throwIfStopped(runToken);
      unit.accountId = selectedAccount.accountId;
      const reservation = plannedLoads.get(unit.accountId) || {
        baselineLoad: Number(unit.assignmentBaselineLoad || 0),
        assigned: 0,
      };
      reservation.assigned += unit.audios.length;
      plannedLoads.set(unit.accountId, reservation);
      unit.assignmentBaselineLoad = reservation.baselineLoad;
      runState.queuePlan[index] = { ...unit, accountId: unit.accountId, status: 'assigned' };
      await pushState();
      throwIfStopped(runToken);
    }
    await activateAccount(unit.accountId);
    throwIfStopped(runToken);
    const unitAuth = await callBulkOp('getAuthContext');
    throwIfStopped(runToken);
    const template = await callBulkOp('getPtVideoInfo');
    throwIfStopped(runToken);
    const configResult = await callBulkOp('listBatchConfig', { configType: 'SCRIPT' });
    throwIfStopped(runToken);
    const batchConfig = configResult?.configs?.[0];
    if (!batchConfig?.id) throw new Error(`DreamFace SCRIPT batch preset not found for ${unit.accountId}`);
    const detailResult = await callBulkOp('getBatchConfigDetail', { id: batchConfig.id });
    throwIfStopped(runToken);
    const originalConfig = detailResult?.config || {};
    const context = {
      accountId: unit.accountId,
      templateId: template.templateId,
      batchConfigId: batchConfig.id,
      batchName: batchConfig.name || 'Bulk Batch',
      originalScriptConfigs: Array.isArray(originalConfig.script_configs) ? originalConfig.script_configs : [],
      presetDirty: false,
    };
    runState.bulkContext = context;
    runState.currentTaskName = unit.video.name;
    setStatusText(`[${index + 1}/${queue.length}] подготовка аватара ${unit.video.name}`);
    await pushState();
    throwIfStopped(runToken);
    if (!unit.video.videoUrl) throw new Error(`${unit.video.name || 'video'}: DreamFace video URL missing`);
    let avatarId = await getCachedAvatarId(unit.video.videoUrl, unit.accountId);
    throwIfStopped(runToken);
    let avatar;
    const usedCache = Boolean(avatarId);
    if (avatarId) {
      avatar = { avatarId };
      setStatusText(`[${index + 1}/${queue.length}] аватар ${unit.video.name}: кэш (уже зарегистрирован)`);
    } else {
      avatar = await callBulkOp('avatarAdd', { fileUrl: unit.video.videoUrl });
      throwIfStopped(runToken);
      await setCachedAvatarId(unit.video.videoUrl, unit.accountId, avatar.avatarId);
      throwIfStopped(runToken);
    }

    const scriptConfigs = [];
    for (let audioIndex = 0; audioIndex < unit.audios.length; audioIndex += 1) {
      throwIfStopped(runToken);
      const audio = unit.audios[audioIndex];
      const record = await getTaskBlob(audio.id);
      throwIfStopped(runToken);
      if (!record?.blob) throw new Error(`${audio.fileName}: normalized blob missing`);
      setStatusText(`[${index + 1}/${queue.length}] аудио ${audioIndex + 1}/${unit.audios.length}: ${audio.fileName}`);
      await pushState();
      throwIfStopped(runToken);
      const uploaded = await uploadAudioDirect(record.blob, audio.fileName, unitAuth);
      throwIfStopped(runToken);
      scriptConfigs.push({
        type: 'AUDIO',
        audio_config: {
          file_name: audio.fileName,
          audio_url: uploaded.filePath,
          audio_start_time: 0,
          audio_end_time: Number(audio.durationMs || record.durationMs || 0),
        },
      });
    }

    const batchName = context.batchName || 'Bulk Batch';
    runState.bulkContext = { ...context, presetDirty: true };
    await pushState();
    throwIfStopped(runToken);
    await callBulkOp('updateBatchConfig', { id: context.batchConfigId, name: batchName, scriptConfigs });
    throwIfStopped(runToken);
    let submitted;
    let watchUnit;
    try {
      await callBulkOp('batchCheckText');
      throwIfStopped(runToken);
      unit.status = 'submitting';
      const baseline = await callBulkOp('getRunningWorks');
      throwIfStopped(runToken);
      const recentBaseline = await callBulkOp('getRecentCreations', { page: 1, size: 100 });
      throwIfStopped(runToken);
      unit.baselineWorkIds = [
        ...(baseline?.workIds || []),
        ...(recentBaseline?.items || []).map((item) => String(item?.id || '')).filter(Boolean),
      ];
      unit.submittedAt = new Date().toISOString();
      unit.correlationDeadline = new Date(Date.now() + (30 * 60 * 1000)).toISOString();
      watchUnit = await addBulkWatchUnit({
        id: unit.id,
        runId: runState.runId,
        accountId: unit.accountId,
        principalKey: selectedAccount.principalKey,
        expectedFileNames: unit.audios.map((audio) => audio.fileName),
        submittedAt: unit.submittedAt,
        correlationDeadline: unit.correlationDeadline,
        baselineWorkIds: unit.baselineWorkIds || [],
        targetCount: unit.audios.length,
      });
      try {
        throwIfStopped(runToken);
      } catch (error) {
        await callBackground('dfPatchBulkWatchUnits', { units: [{
          ...watchUnit,
          status: 'submission_cancelled',
          lastError: 'Run stopped before DreamFace submission',
          updatedAt: Date.now(),
        }] });
        throw error;
      }
      runState.queuePlan[index] = { ...unit, status: 'submitting', accountId: unit.accountId };
      await pushState();
      try {
        throwIfStopped(runToken);
      } catch (error) {
        await callBackground('dfPatchBulkWatchUnits', { units: [{
          ...watchUnit,
          status: 'submission_cancelled',
          lastError: 'Run stopped before DreamFace submission',
          updatedAt: Date.now(),
        }] });
        throw error;
      }
      try {
        submitted = await callBulkOp('animateImageBatch', {
          avatarId: avatar.avatarId,
          videoUrl: unit.video.videoUrl,
          scriptConfigs,
          batchConfigId: context.batchConfigId,
          name: batchName,
          templateId: context.templateId,
        });
      } catch (error) {
        if (usedCache) {
          await invalidateCachedAvatarId(unit.video.videoUrl, unit.accountId);
          runState.warnings = [...runState.warnings, `кэш аватара инвалидирован для ${unit.video.name} на ${unit.accountId}: ${error.message}`];
        }
        await callBackground('dfPatchBulkWatchUnits', { units: [{
          ...watchUnit,
          status: 'submission_uncertain',
          lastError: error.message || String(error),
          submissionError: {
            message: error.message || String(error),
            recordedAt: new Date().toISOString(),
          },
          updatedAt: Date.now(),
        }] });
        throw error;
      }
      if (submitted.successCount === 0) {
        await callBackground('dfPatchBulkWatchUnits', { units: [{
          ...watchUnit,
          status: 'submission_failed',
          submissionResult: submitted,
          lastError: 'DreamFace confirmed zero successful submissions',
          updatedAt: Date.now(),
        }] });
      }
      if (submitted.successCount > 0) {
        await addBulkWatchUnit({
          id: unit.id,
          runId: runState.runId,
          accountId: unit.accountId,
          principalKey: selectedAccount.principalKey,
          expectedFileNames: unit.audios.map((audio) => audio.fileName),
          submittedAt: unit.submittedAt,
          correlationDeadline: unit.correlationDeadline,
          baselineWorkIds: unit.baselineWorkIds || [],
          targetCount: submitted.successCount,
        });
      }
      throwIfStopped(runToken);
    } finally {
      let presetRestored = false;
      await callBulkOp('updateBatchConfig', {
        id: context.batchConfigId,
        name: batchName,
        scriptConfigs: context.originalScriptConfigs || [],
      }).then(() => {
        presetRestored = true;
      }).catch((error) => {
        runState.warnings = [...runState.warnings, `не удалось восстановить preset ${unit.accountId}: ${error.message}`];
      });
      runState.bulkContext = { ...runState.bulkContext, presetDirty: !presetRestored };
      await pushState();
    }
    if (runState.bulkContext?.presetDirty) {
      throw new Error('DreamFace preset restoration failed; run can be resumed after connection recovery');
    }
    if (submitted.successCount !== scriptConfigs.length) {
      unit.status = 'partial';
      runState.queuePlan[index] = { ...unit, status: 'partial' };
      await pushState();
      throw new Error(`bulk submit accepted ${submitted.successCount}/${scriptConfigs.length}; failed ${submitted.failCount || 0}`);
    }
    unit.status = 'submitted';

    completedAudioCount += unit.audios.length;
    runState.current = completedAudioCount;
    runState.nextTaskIndex = index + 1;
    runState.queuePlan[index] = { ...unit, status: 'submitted', accountId: unit.accountId, submittedAt: unit.submittedAt, workIds: [] };
    await pushState();

    unit.workIds = [];
    for (const audio of unit.audios) await deleteTaskBlob(audio.id);

    runState.queuePlan[index] = { ...unit, status: 'submitted', workIds: [...unit.workIds] };
    runState.downloadPlan = {
      ...runState.downloadPlan,
      expectedWorkIds: runState.queuePlan.flatMap((item) => item.workIds || []),
    };
    setStatusText(`[${index + 1}/${queue.length}] bulk OK: ${unit.audios.length}`);
    await pushState();
    });
    await runBulkWatcher({ allowDuringRun: true }).catch(() => {});
  }

  await finishRun('Отправка завершена. Ожидаем результаты DreamFace.');
}

async function stopPageExecutor(tabId) {
  if (!tabId) {
    return;
  }

  try {
    await callBackground('engine.pageAction', {
      tabId,
      pageAction: 'cancelActiveTask',
      payload: {},
    });
  } catch (_) {}
}

async function failRun(message, interruptionReason = '') {
  const remainingTasks = Array.isArray(runState.queuePlan)
    ? Math.max(0, runState.queuePlan.length - Number(runState.nextTaskIndex || 0))
    : 0;
  runState.phase = 'failed';
  runState.interrupted = Boolean(interruptionReason);
  runState.recoverable = runState.interrupted && remainingTasks > 0;
  runState.interruptionReason = interruptionReason;
  runState.finishedAt = new Date().toISOString();
  if (runState.interrupted) {
    runState.downloadPlan = {
      ...runState.downloadPlan,
      lastStatus: 'interrupted',
      lastMessage: message,
    };
  }
  setStatusText(message);
  await pushState();
}

async function finishRun(message) {
  runState.phase = 'finished';
  runState.interrupted = false;
  runState.recoverable = false;
  runState.interruptionReason = '';
  runState.finishedAt = new Date().toISOString();
  setStatusText(message);
  await pushState();
}

async function runCreationsDownload(expectedFileNames) {
  if (expectedFileNames.length === 0) {
    return { ok: false, error: 'нет результатов для скачивания' };
  }

  runState.phase = 'downloading';
  runState.currentTaskName = expectedFileNames[expectedFileNames.length - 1] || '';
  setStatusText(`${ENGINE_STATUS_PREFIX} проверка результатов в Creations`);
  await pushState();

  try {
    const creationsTab = await callBackground('engine.ensureCreationsTab');
    const pageResponse = await callBackground('engine.pageAction', {
      tabId: creationsTab.tab.id,
      pageAction: 'downloadCreationsIfReady',
      payload: {
        expectedFileNames,
        expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
          ? [...runState.downloadPlan.expectedWorkIds]
          : [],
        startedAt: runState.startedAt,
      },
    });

    const result = pageResponse.response || {};
    if (result.status === 'success') {
      runState.downloadPlan = {
        ...runState.downloadPlan,
        expectedFileNames: [...expectedFileNames],
        expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
          ? [...runState.downloadPlan.expectedWorkIds]
          : [],
        lastStatus: 'success',
        lastMessage: `скачивание запущено: ${result.downloadedCount}`,
        pendingFiles: [],
        downloadedCount: result.downloadedCount || 0,
        matchedCount: Number(result.matchedCount || result.downloadedCount || expectedFileNames.length || 0),
      };
      setStatusText(`скачивание запущено: ${result.downloadedCount}`);
      await pushState();
      return { ok: true, result };
    }

    if (result.status === 'partial') {
      const pendingFiles = Array.isArray(result.pending) ? result.pending : [];
      const message = pendingFiles.length > 0
        ? `скачивание запущено: ${result.downloadedCount}; ещё не готовы: ${pendingFiles.slice(0, 6).join(', ')}`
        : `скачивание запущено: ${result.downloadedCount}`;

      runState.downloadPlan = {
        ...runState.downloadPlan,
        expectedFileNames: [...expectedFileNames],
        expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
          ? [...runState.downloadPlan.expectedWorkIds]
          : [],
        lastStatus: 'partial',
        lastMessage: message,
        pendingFiles,
        downloadedCount: result.downloadedCount || 0,
        matchedCount: Number(result.matchedCount || result.downloadedCount || 0),
      };
      runState.warnings = [...runState.warnings, message];
      setStatusText(message);
      await pushState();
      return { ok: true, result: { ...result, message } };
    }

    if (result.status === 'pending') {
      const pendingFiles = Array.isArray(result.pending) ? result.pending : [];
      const message = pendingFiles.length > 0
        ? `ещё не готовы: ${pendingFiles.slice(0, 6).join(', ')}`
        : 'результаты ещё не готовы';

      runState.downloadPlan = {
        ...runState.downloadPlan,
        expectedFileNames: [...expectedFileNames],
        expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
          ? [...runState.downloadPlan.expectedWorkIds]
          : [],
        lastStatus: 'pending',
        lastMessage: message,
        pendingFiles,
        downloadedCount: 0,
        matchedCount: Number(result.matchedCount || 0),
      };
      setStatusText(message);
      await pushState();
      return { ok: true, result: { ...result, message } };
    }

    if (result.status === 'failed') {
      const message = result.message || 'DreamFace завершил генерацию с ошибкой';
      runState.warnings = [...runState.warnings, message];
      runState.downloadPlan = {
        ...runState.downloadPlan,
        expectedFileNames: [...expectedFileNames],
        expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
          ? [...runState.downloadPlan.expectedWorkIds]
          : [],
        lastStatus: 'failed',
        lastMessage: message,
        pendingFiles: [],
        downloadedCount: Number(result.downloadedCount || 0),
        matchedCount: Number(result.matchedCount || result.downloadedCount || 0),
      };
      setStatusText(message);
      await pushState();
      return { ok: false, error: message, result };
    }

    const message = result.message || 'не удалось скачать результаты';
    runState.warnings = [...runState.warnings, message];
    runState.downloadPlan = {
      ...runState.downloadPlan,
      expectedFileNames: [...expectedFileNames],
      expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
        ? [...runState.downloadPlan.expectedWorkIds]
        : [],
      lastStatus: 'error',
      lastMessage: message,
      pendingFiles: [],
      downloadedCount: 0,
    };
    setStatusText(`не удалось скачать результаты: ${message}`);
    await pushState();
    return { ok: false, error: message };
  } catch (error) {
    const message = error.message || String(error);
    runState.warnings = [...runState.warnings, `autodownload: ${message}`];
    runState.downloadPlan = {
      ...runState.downloadPlan,
      expectedFileNames: [...expectedFileNames],
      expectedWorkIds: Array.isArray(runState.downloadPlan?.expectedWorkIds)
        ? [...runState.downloadPlan.expectedWorkIds]
        : [],
      lastStatus: 'error',
      lastMessage: message,
      pendingFiles: [],
      downloadedCount: 0,
    };
    setStatusText(`не удалось скачать результаты: ${message}`);
    await pushState();
    return { ok: false, error: message };
  }
}

async function processQueue(queue, runToken, startIndex = 0) {
  runState.total = queue.length;
  runState.summary.totalGeneratedTasks = queue.length;
  runState.queuePlan = queue.map((task) => ({ ...task }));
  runState.nextTaskIndex = startIndex;

  if (startIndex === 0) {
    runState.phase = 'ready';
    runState.current = 0;
    setStatusText(`${ENGINE_STATUS_PREFIX} нормализация завершена. задач: ${queue.length}`);
    await pushState();
  } else {
    runState.phase = 'ready';
    runState.current = startIndex;
    setStatusText(`${ENGINE_STATUS_PREFIX} возобновление очереди с ${startIndex + 1} задачи`);
    await pushState();
  }

  if (queue.length === 0) {
    await finishRun('нет задач для запуска');
    return;
  }

  runState.phase = 'running';
  runState.interrupted = false;
  runState.recoverable = false;
  runState.interruptionReason = '';
  runState.downloadPlan = {
    ...runState.downloadPlan,
    expectedFileNames: queue.map((task) => task.fileName).filter(Boolean),
    expectedWorkIds: queue.map((task) => task.workId || ''),
    lastStatus: 'ready',
    lastMessage: '',
    pendingFiles: [],
    downloadedCount: 0,
    matchedCount: 0,
    totalExpected: queue.length,
    checkedAt: '',
    checkedOnUrl: '',
  };
  await pushState();

  for (let index = startIndex; index < queue.length; index += 1) {
    throwIfStopped(runToken);

    const task = queue[index];
    const tabSnapshot = await callBackground('engine.getTabSnapshot', { tabId: runState.tabId });
    if (!tabSnapshot.tab) {
      await failRun('целевая вкладка закрыта. очередь остановлена.', 'target_tab_removed');
      return;
    }

    if (tabSnapshot.tab.discarded) {
      await failRun('вкладка DreamFace выгружена браузером. очередь остановлена.', 'target_tab_discarded');
      return;
    }

    const record = await getTaskBlob(task.id);
    if (!record) {
      runState.failures = [...runState.failures, `${task.fileName}: blob missing`];
      runState.nextTaskIndex = index + 1;
      await pushState();
      continue;
    }

    runState.current = index + 1;
    runState.currentTaskName = task.fileName;
    setStatusText(`[${index + 1}/${queue.length}] загрузка ${task.fileName}`);
    await pushState();

    let taskHandled = false;

    for (let attempt = 0; attempt <= TRANSIENT_TASK_RETRY_LIMIT; attempt += 1) {
      throwIfStopped(runToken);

      let pageResponse;

      try {
        const audioDataUrl = await blobToDataUrl(record.blob);
        pageResponse = await callBackground('engine.pageAction', {
          tabId: runState.tabId,
          pageAction: 'executeTaskOnPage',
          payload: {
            fileName: record.name,
            mimeType: record.type,
            audioDataUrl,
            videoIndex: task.videoIndex,
            borderCropPx: task.borderCropPx,
            taskLabel: `[${index + 1}/${queue.length}]`,
            maxDurationSeconds: runState.maxDurationSeconds,
          },
        });
      } catch (error) {
        const message = /message channel closed before a response was received/i.test(error.message || '')
          ? 'связь со страницей потеряна. обработка прервана, очередь не завершена.'
          : `связь со страницей потеряна: ${error.message}`;
        await failRun(message, 'page_executor_disconnected');
        return;
      }

      const result = pageResponse.response || {};

      if (result.status === 'success') {
        task.workId = result.workId || task.workId || '';
        task.animateImageId = result.animateImageId || task.animateImageId || '';
        if (result.recoveredAfter === 'limit') {
          runState.warnings = [
            ...runState.warnings,
            `${task.fileName}: submit подтвердился через running works после сигнала limit`,
          ];
        } else if (result.recoveredAfter === 'timeout') {
          runState.warnings = [
            ...runState.warnings,
            `${task.fileName}: submit подтвердился через running works после timeout`,
          ];
        }
        if (result.workIdAmbiguous) {
          runState.warnings = [
            ...runState.warnings,
            `${task.fileName}: найдено несколько кандидатов work id, использован первый`,
          ];
        } else if (!task.workId) {
          runState.warnings = [
            ...runState.warnings,
            `${task.fileName}: work id не определился, останется fallback через Creations`,
          ];
        }
        if (Array.isArray(runState.queuePlan) && runState.queuePlan[index]) {
          runState.queuePlan[index] = {
            ...runState.queuePlan[index],
            workId: task.workId,
            animateImageId: task.animateImageId,
          };
        }
        runState.downloadPlan = {
          ...runState.downloadPlan,
          expectedWorkIds: queue.map((queueTask) => queueTask.workId || ''),
        };
        await deleteTaskBlob(task.id);
        runState.nextTaskIndex = index + 1;
        setStatusText(`[${index + 1}/${queue.length}] OK`);
        taskHandled = true;
        break;
      }

      if (result.status === 'submitted_unknown') {
        await deleteTaskBlob(task.id);
        runState.nextTaskIndex = index + 1;
        const message = `${task.fileName}: ${result.message || 'подтверждение отправки не получено вовремя'}`;
        runState.warnings = [...runState.warnings, message];
        setStatusText(`[${index + 1}/${queue.length}] без подтверждения, проверим в Creations`);
        taskHandled = true;
        break;
      }

      if (result.status === 'submission_unconfirmed') {
        runState.warnings = [
          ...runState.warnings,
          `${task.fileName}: ${result.message || 'submit не подтвержден'}`,
        ];
        await pushState();
        await failRun(
          `отправка ${task.fileName} не подтверждена. очередь приостановлена, чтобы не пропустить аудио. проверьте сайт и нажмите "возобновить".`,
          'submission_unconfirmed',
        );
        return;
      }

      if (result.status === 'skipped_short' || result.status === 'skipped_long') {
        await deleteTaskBlob(task.id);
        runState.nextTaskIndex = index + 1;
        const reason = result.status === 'skipped_short'
          ? `< ${MIN_DURATION_SECONDS} сек`
          : `> ${runState.maxDurationSeconds} сек`;
        runState.skipped = [...runState.skipped, `${task.fileName} (${reason})`];
        setStatusText(`[${index + 1}/${queue.length}] пропуск ${reason}`);
        taskHandled = true;
        break;
      }

      if (result.status === 'stopped') {
        throwIfStopped(runToken);
      }

      if (isTransientTaskResult(result)) {
        const message = result.message || 'timeout';
        if (attempt < TRANSIENT_TASK_RETRY_LIMIT) {
          const nextAttempt = attempt + 2;
          const totalAttempts = TRANSIENT_TASK_RETRY_LIMIT + 1;
          setStatusText(`[${index + 1}/${queue.length}] сеть нестабильна, повтор ${nextAttempt}/${totalAttempts}`);
          await pushState();
          await waitForRetryDelay(runToken, TRANSIENT_TASK_RETRY_BASE_DELAY_MS * (attempt + 1));
          continue;
        }

        runState.warnings = [
          ...runState.warnings,
          `${task.fileName}: временный сбой сети (${message})`,
        ];
        await pushState();
        await failRun(
          `соединение нестабильно. очередь приостановлена на ${task.fileName}. восстановите интернет и нажмите "возобновить".`,
          'transient_network_failure',
        );
        return;
      }

      await deleteTaskBlob(task.id);
      runState.nextTaskIndex = index + 1;
      const message = result.message || 'page task failed';
      runState.failures = [...runState.failures, `${task.fileName}: ${message}`];
      setStatusText(`[${index + 1}/${queue.length}] ошибка: ${message}`);
      taskHandled = true;
      break;
    }

    if (!taskHandled) {
      return;
    }

    await pushState();
  }

  runState.current = queue.length;
  runState.nextTaskIndex = queue.length;
  await finishRun('очередь завершена. откройте страницу Creations вручную и нажмите "проверить результаты"');
}

async function triggerCreationsDownload() {
  const expectedFileNames = Array.isArray(runState.downloadPlan?.expectedFileNames)
    ? runState.downloadPlan.expectedFileNames.filter(Boolean)
    : [];

  if (expectedFileNames.length === 0) {
    return { ok: false, error: 'нет результатов для Creations' };
  }

  const downloadResult = await runCreationsDownload(expectedFileNames);
  if (!downloadResult.ok || downloadResult.result?.status !== 'success') {
    runState.phase = 'finished';
    await pushState();
    return { ok: downloadResult.ok, state: cloneState(), error: downloadResult.error || '' };
  }

  runState.phase = 'finished';
  await pushState();
  return { ok: true, state: cloneState() };
}

async function resetRunState() {
  if (isBusyPhase(runState.phase)) {
    return { ok: false, error: 'engine is busy' };
  }

  await resetRunStateInternal();
  return { ok: true, state: cloneState() };
}

async function startRun(payload, admissionToken) {
  currentRunToken += 1;
  const runToken = currentRunToken;
  stopRequested = false;

  await clearTaskBlobs();

  runState = createIdleRunState();
  runState.mode = payload.mode === 'bulk' ? 'bulk' : 'legacy';
  runState.phase = 'preparing';
  runState.runId = createRunId();
  runState.tabId = payload.tabId;
  runState.startedAt = new Date().toISOString();
  runState.maxDurationSeconds = Number(payload.options?.maxDurationSeconds) > DEFAULT_MAX_DURATION_SECONDS
    ? Number(payload.options.maxDurationSeconds)
    : DEFAULT_MAX_DURATION_SECONDS;
  runState.autoNormalize = payload.options.autoNormalize;
  runState.overlapEnabled = payload.options.overlapEnabled;
  runState.normalization.totalCount = countInputFiles(payload.batches);
  runState.queuePlan = [];
  runState.nextTaskIndex = 0;
  runState.recoverable = false;
  setStatusText(`${ENGINE_STATUS_PREFIX} подготовка очереди`);
  await pushState();
  const originalSession = await capturePageSession();

  try {
    if (runState.mode === 'bulk') {
      const longestInput = await getLongestInputDurationSeconds(payload.batches, runToken);
      await withBulkAccountLock(async () => {
        const selected = await selectLeastLoadedAccount(longestInput);
        const auth = await callBulkOp('getAuthContext');
        if (!auth?.hasAuth) throw new Error('DreamFace account is not authenticated');
        const selectedLimit = Number(selected.maxDurationSeconds || DEFAULT_MAX_DURATION_SECONDS);
        runState.bulkContext = { accountId: selected.accountId || auth.accountId, maxDurationSeconds: selectedLimit };
        runState.maxDurationSeconds = selectedLimit;
        payload.options = { ...payload.options, maxDurationSeconds: selectedLimit };
        await pushState();
      });
    }
    const { queue, summary, consumedInputIds = [] } = runState.mode === 'bulk'
      ? await prepareBulkPlan(payload, runToken)
      : await prepareTasks(payload, runToken);
    runState.summary = summary;
    runState.queuePlan = queue.map((item) => ({ ...item }));
    await pushState();
    if (runState.mode === 'bulk') {
      for (const id of consumedInputIds) await deleteInputFileRecord(id);
    }
    if (runState.mode === 'bulk') {
      await processBulkQueue(queue, runToken);
    } else {
      await processQueue(queue, runToken);
    }
  } catch (error) {
    if (error.code === 'run_stopped') {
      await finishRun('обработка остановлена пользователем');
      return;
    }

    await failRun(`ошибка движка: ${error.message}`, runState.mode === 'bulk' ? 'bulk_failure' : '');
  } finally {
    stopRequested = false;
    if (runState.mode === 'bulk' && originalSession) {
      await withBulkAccountLock(async () => {
        await callBackground('dfSwitchAccount', { session: originalSession });
        const restored = await capturePageSession();
        if (Boolean(restored?.hasAuth) !== Boolean(originalSession.hasAuth)
          || (originalSession.hasAuth && restored?.accountId !== originalSession.accountId)) {
          throw new Error('failed to restore original DreamFace session after run');
        }
      }).catch((error) => {
        runState.warnings = [...runState.warnings, error.message || String(error)];
        pushState().catch(() => {});
      });
    }
    if (runState.phase === 'finished') {
      await clearInputFiles().catch(() => {});
    }
    releaseRunAdmission(admissionToken);
  }
}

async function resumeRun(payload = {}, admissionToken) {
  if (isBusyPhase(runState.phase)) {
    releaseRunAdmission(admissionToken);
    return { ok: false, error: 'engine is already busy' };
  }

  if (runState.mode !== 'bulk') {
    releaseRunAdmission(admissionToken);
    return { ok: false, error: 'legacy-очередь нельзя возобновить после bulk-миграции; запустите её заново' };
  }

  if (!Array.isArray(runState.queuePlan) || runState.queuePlan.length === 0) {
    releaseRunAdmission(admissionToken);
    return { ok: false, error: 'очередь для возобновления не найдена' };
  }

  if (Number(runState.nextTaskIndex || 0) >= runState.queuePlan.length) {
    releaseRunAdmission(admissionToken);
    return { ok: false, error: 'в очереди не осталось задач для возобновления' };
  }

  if (payload.tabId) {
    runState.tabId = payload.tabId;
  }

  currentRunToken += 1;
  const runToken = currentRunToken;
  stopRequested = false;
  runState.finishedAt = null;
  runState.interrupted = false;
  runState.recoverable = false;
  runState.interruptionReason = '';
  setStatusText(`${ENGINE_STATUS_PREFIX} возобновление очереди`);
  await pushState();
  const originalSession = await capturePageSession();

  try {
    await withBulkAccountLock(() => restoreBulkPresetIfNeeded());
  } catch (error) {
    await failRun(`не удалось восстановить DreamFace preset: ${error.message}`, 'bulk_preset_restore_failed');
    releaseRunAdmission(admissionToken);
    return { ok: false, error: error.message };
  }

  const processor = runState.mode === 'bulk' ? processBulkQueue : processQueue;
  processor(runState.queuePlan, runToken, Number(runState.nextTaskIndex || 0)).catch(async (error) => {
    if (error.code === 'run_stopped') await finishRun('обработка остановлена пользователем');
    else await failRun(`ошибка движка: ${error.message}`, runState.mode === 'bulk' ? 'bulk_failure' : '');
  }).finally(async () => {
    try {
      if (originalSession) {
        await withBulkAccountLock(async () => {
          await callBackground('dfSwitchAccount', { session: originalSession });
          const restored = await capturePageSession();
          if (Boolean(restored?.hasAuth) !== Boolean(originalSession.hasAuth)
            || (originalSession.hasAuth && restored?.accountId !== originalSession.accountId)) {
            throw new Error('failed to restore original DreamFace session after resume');
          }
        }).catch((error) => {
          runState.warnings = [...runState.warnings, error.message || String(error)];
          pushState().catch(() => {});
        });
      }
    } finally {
      releaseRunAdmission(admissionToken);
    }
  });

  return { ok: true, state: cloneState() };
}

async function stopRun() {
  stopRequested = true;
  runState.phase = 'stopping';
  setStatusText('остановка...');
  await pushState();
  await resetFfmpeg();
  await stopPageExecutor(runState.tabId);
  return { ok: true };
}

async function handleTabLifecycle(payload) {
  if (runState.mode === 'bulk') {
    return;
  }

  if (!runState.runId || payload.tabId !== runState.tabId) {
    return;
  }

  if (payload.event === 'removed' && runState.phase !== 'finished' && runState.phase !== 'failed') {
    stopRequested = true;
    await failRun('целевая вкладка закрыта. очередь остановлена.', 'target_tab_removed');
    return;
  }

  if (payload.event === 'updated' && payload.changeInfo) {
    if (payload.changeInfo.discarded === true && runState.phase === 'running') {
      stopRequested = true;
      await stopPageExecutor(runState.tabId);
      await failRun('вкладка DreamFace выгружена браузером. очередь остановлена.', 'target_tab_discarded');
      return;
    }

    if (payload.changeInfo.url && !/dreamfaceapp\.com/i.test(payload.changeInfo.url) && runState.phase === 'running') {
      stopRequested = true;
      await stopPageExecutor(runState.tabId);
      await failRun('страница DreamFace была заменена. очередь остановлена.', 'target_tab_navigated');
    }
  }
}

// ---------- DOWNLOAD WITH CHAPTERS ----------
// Качаем готовый mp4 с DreamFace OSS, если есть мета (audioMs+videoMs)
// и аудио длиннее видео — добавляем chapter markers через ffmpeg -c copy.
// Иначе — просто сохраняем как есть. Имя — work_name + .mp4.

function safeFileName(name) {
  // нормализуем unicode (NFC) — иначе кириллица в decomposed-форме
  // может ломать chrome.downloads
  let s = String(name || 'video');
  try {
    s = s.normalize('NFC');
  } catch {}

  // убираем все control + path separators + windows-запрещённые
  s = s
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    // нулевая ширина и прочие невидимые
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // не должен начинаться с точки/дефиса (chrome может посчитать «скрытым»)
  s = s.replace(/^[.\-\s]+/, '');

  // лимит длины (FS: ~255, оставляем запас под .mp4)
  if (s.length > 180) {
    s = s.slice(0, 180);
  }

  return s || 'video';
}

// uuid вида 2657386b-c91c-4df7-8169-b839df9c6c2e
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeUuid(name) {
  const cleaned = String(name || '').trim().replace(/\.(mp4|mp3|wav|m4a|ogg|aac|flac)$/i, '');
  return UUID_RE.test(cleaned);
}

// Возвращает имя для скачиваемого файла. Приоритет:
//   1) audioFileName (имя оригинального аудио из очереди)
//   2) workName, если оно не похоже на uuid и не пустое
//   3) workId (последний фолбек)
function pickDownloadBaseName({ audioFileName, workName, workId }) {
  const audioName = String(audioFileName || '').trim();
  if (audioName) {
    return audioName;
  }
  const api = String(workName || '').trim();
  if (api && !looksLikeUuid(api)) {
    return api;
  }
  return String(workId || 'video').trim() || 'video';
}

function buildChaptersFfmetadata({ audioMs, videoMs }) {
  const lines = [';FFMETADATA1', 'title=dreamface lipsync'];
  let t = 0;
  let k = 0;
  while (t < audioMs) {
    const segEnd = Math.min(t + videoMs, audioMs);
    const title = k === 0
      ? 'forward 1'
      : (k % 2 ? `reverse ${Math.ceil(k / 2)}` : `forward ${k / 2 + 1}`);
    lines.push('');
    lines.push('[CHAPTER]');
    lines.push('TIMEBASE=1/1000');
    lines.push(`START=${Math.round(t)}`);
    lines.push(`END=${Math.round(segEnd)}`);
    lines.push(`title=${title}`);
    t += videoMs;
    k += 1;
  }
  return lines.join('\n') + '\n';
}

async function muxChaptersInMp4(mp4Bytes, audioMs, videoMs) {
  await ensureFfmpegLoaded();

  const inPath = `in-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`;
  const metaPath = `meta-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`;
  const outPath = `out-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`;

  try {
    await ffmpeg.writeFile(inPath, mp4Bytes);
    const ffmeta = buildChaptersFfmetadata({ audioMs, videoMs });
    await ffmpeg.writeFile(metaPath, new TextEncoder().encode(ffmeta));

    const code = await ffmpeg.exec([
      '-y',
      '-i', inPath,
      '-i', metaPath,
      '-map_metadata', '1',
      '-map_chapters', '1',
      '-c', 'copy',
      outPath,
    ], 120000);

    if (code !== 0) {
      throw new Error(`ffmpeg mux returned ${code}`);
    }

    const buf = await ffmpeg.readFile(outPath);
    return new Uint8Array(buf.buffer.slice(0));
  } finally {
    await safeDeleteFsFile(inPath);
    await safeDeleteFsFile(metaPath);
    await safeDeleteFsFile(outPath);
  }
}

async function downloadOneWithChapters(item) {
  const { workId, workName, url, audioMs, videoMs, hasChapters, audioFileName } = item;
  console.log('[offscreen] downloading', { workId, workName, audioFileName, hasChapters, audioMs, videoMs, urlPrefix: url.slice(0, 80) });

  // Качаем оригинальный mp4
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error('fetch network error: ' + err.message);
  }
  if (!response.ok) {
    throw new Error(`fetch ${response.status} ${response.statusText}`);
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  console.log('[offscreen] mp4 fetched', { workId, bytes: buf.length });

  let finalBytes = buf;
  let chaptersAdded = 0;

  if (hasChapters && Number.isFinite(audioMs) && Number.isFinite(videoMs) && videoMs > 0) {
    try {
      finalBytes = await withFfmpegMutex(() => muxChaptersInMp4(buf, audioMs, videoMs));
      chaptersAdded = Math.ceil(audioMs / videoMs);
      console.log('[offscreen] chapters added', { workId, chaptersAdded, audioMs, videoMs });
    } catch (err) {
      console.warn('[offscreen] mux failed, saving without chapters:', err.message);
      finalBytes = buf;
      chaptersAdded = 0;
    }
  }

  const blob = new Blob([finalBytes], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  // имя для .mp4 формируем по приоритету:
  //   1) audioFileName (имя оригинального аудио — то, что юзер видит в очереди)
  //   2) workName из API (может быть uuid — но если это не похоже на uuid, используем)
  //   3) workId как последний фолбек
  const baseName = pickDownloadBaseName({ audioFileName, workName, workId });
  const fileName = safeFileName(baseName).replace(/\.(mp3|wav|m4a|ogg|aac|flac|mp4)$/i, '') + '.mp4';

  // chrome.downloads недоступен из offscreen → отдаём blob:URL в background.
  // blob:URL валиден в любом контексте того же extension origin; SW МОЖЕТ передать его
  // в chrome.downloads.download. Если не сработает — фоллбек через ArrayBuffer→content_script.
  console.log('[offscreen] handing blob to background', { workId, fileName, bytes: finalBytes.length, blobUrl: blobUrl.slice(0, 60) });
  const ack = await chrome.runtime.sendMessage({
    action: 'engine.saveDownload',
    payload: { blobUrl, fileName },
  });
  if (!ack || !ack.ok) {
    URL.revokeObjectURL(blobUrl);
    throw new Error('saveDownload failed: ' + (ack?.error || 'unknown'));
  }

  // освобождаем blob НЕМЕДЛЕННО — chrome.downloads уже принял blob:URL
  // и держит его внутри. Раньше держали 60с «на всякий случай», что приводило
  // к удержанию ~60МБ × N файлов в RAM offscreen document и деградации скорости.
  try {
    URL.revokeObjectURL(blobUrl);
  } catch {}

  return { workId, workName, fileName, bytes: finalBytes.length, chaptersAdded };
}

// ffmpeg.wasm — один инстанс на offscreen document. muxChaptersInMp4 НЕ thread-safe
// (общая FS + общий heap), поэтому все вызовы должны быть строго последовательными.
// Реализуем простой promise-based mutex.
let ffmpegMutexChain = Promise.resolve();
function withFfmpegMutex(taskFn) {
  const run = ffmpegMutexChain.then(() => taskFn(), () => taskFn());
  // следующий ждёт окончания текущего (успех/ошибка), но цепочка не падает
  ffmpegMutexChain = run.catch(() => {});
  return run;
}

// Принимает signed URL + transform metadata, возвращает blob:URL.
// SW не может вызывать URL.createObjectURL — поэтому blob:URL создаём ЗДЕСЬ (в offscreen),
// и возвращаем строку URL. Затем SW вызывает chrome.downloads.download({url: blobUrl, ...}).
// blob:URL валиден для всего extension origin, его можно скачать из любого контекста.
//
// После завершения скачивания SW шлёт {action:'revokeBlob', payload:{blobUrl}} чтобы
// освободить blob из памяти (см. handleRevokeBlob).
async function handleMuxOne(payload) {
  const buf = payload?.buffer;
  const url = String(payload?.url || '');
  const audioMs = Number(payload?.audioMs);
  const videoMs = Number(payload?.videoMs);
  const hasChapters = Boolean(payload?.hasChapters);
  if (!url && (!buf || (!(buf instanceof ArrayBuffer) && !(buf?.byteLength >= 0)))) {
    return { ok: false, error: 'video source missing' };
  }
  try {
    let outBytes;
    if (url) {
      const controller = new AbortController();
      const timeoutMs = Math.max(1000, Number(payload?.fetchTimeoutMs) || 120000);
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`fetch ${response.status} ${response.statusText}`);
        }
        outBytes = new Uint8Array(await response.arrayBuffer());
      } finally {
        clearTimeout(timeoutId);
      }
    } else {
      outBytes = new Uint8Array(buf);
    }
    let chapters = 0;
    if (hasChapters && Number.isFinite(audioMs) && Number.isFinite(videoMs) && videoMs > 0 && audioMs > videoMs) {
      try {
        outBytes = await withFfmpegMutex(() => muxChaptersInMp4(outBytes, audioMs, videoMs));
        chapters = Math.ceil(audioMs / videoMs);
      } catch (err) {
        throw new Error(`chapter mux failed: ${err.message}`);
      }
    }
    const blob = new Blob([outBytes], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    return { ok: true, blobUrl, bytes: outBytes.byteLength, chapters };
  } catch (err) {
    console.error('[offscreen] muxOne failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ---------- PRE-LOOP VIDEO UNDER LONGEST AUDIO ----------
// Идея: на старте группы (1 видео + N аудио) посчитать max(audioMs),
// скачать исходное видео по OSS-URL, локально через ffmpeg.wasm склеить
// его само с собой встык столько раз, сколько нужно, чтобы суммарная
// длительность >= maxAudioMs. Только forward, никакого реверса.
// На выходе — Blob mp4 + blob:URL для дальнейшей передачи в content_script.
//
// Стратегия:
//   1) сначала пытаемся через -stream_loop N -c copy (быстро, без перекода).
//   2) если ffmpeg вернёт ошибку (несовпадение GOP, не выровнен keyframe и т.д.),
//      пересборка через -c:v libx264 -preset ultrafast -c:a aac.
//
// Возвращает: { ok, blobUrl, bytes, repeats, mode: 'copy'|'reencode', sourceMs, finalMs }
async function handlePreLoopVideo(payload) {
  const sourceUrl = String(payload?.sourceUrl || '');
  const targetMs = Number(payload?.targetMs);
  const sourceMsHint = Number(payload?.sourceMs);

  if (!sourceUrl) {
    return { ok: false, error: 'sourceUrl missing' };
  }
  if (!Number.isFinite(targetMs) || targetMs <= 0) {
    return { ok: false, error: 'invalid targetMs' };
  }

  console.log('[offscreen] preLoop start', { sourceUrl: sourceUrl.slice(0, 80), targetMs, sourceMsHint });

  // 1) fetch исходного видео
  let srcBytes;
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`fetch ${response.status} ${response.statusText}`);
    }
    srcBytes = new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    return { ok: false, error: `fetch source failed: ${err.message}` };
  }

  console.log('[offscreen] preLoop source fetched', { bytes: srcBytes.length });

  try {
    const result = await withFfmpegMutex(() => preLoopVideoMp4(srcBytes, targetMs, sourceMsHint));

    // dreamface режет upload видео где-то в районе 100 MB. если размер
    // pre-loop'ed файла слишком большой — не отдаём blob:URL вообще,
    // вызов runPreLoopPhase увидит ok=false и оставит группу на старом
    // пути (chapter-markers).
    const MAX_UPLOAD_BYTES = 95 * 1024 * 1024; // 95 MB — запас под лимит
    if (result.bytes.byteLength > MAX_UPLOAD_BYTES) {
      console.warn('[offscreen] preLoop blob слишком большой, отдаём ошибку', {
        bytes: result.bytes.byteLength,
        limit: MAX_UPLOAD_BYTES,
        mode: result.mode,
        repeats: result.repeats,
      });
      return {
        ok: false,
        error: `pre-loop файл получился слишком большим: ${Math.round(result.bytes.byteLength / (1024 * 1024))} MB (лимит ~95 MB). видео не залито, группа пойдёт по стандартному пути.`,
        bytes: result.bytes.byteLength,
        repeats: result.repeats,
        mode: result.mode,
      };
    }

    const blob = new Blob([result.bytes], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    return {
      ok: true,
      blobUrl,
      bytes: result.bytes.byteLength,
      repeats: result.repeats,
      mode: result.mode,
      sourceMs: result.sourceMs,
      finalMs: result.finalMs,
    };
  } catch (err) {
    console.error('[offscreen] preLoop failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// Сама pre-loop логика. Возвращает { bytes, repeats, mode, sourceMs, finalMs }.
async function preLoopVideoMp4(srcBytes, targetMs, sourceMsHint) {
  await ensureFfmpegLoaded();

  const tag = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const inPath = `preloop-in-${tag}.mp4`;
  const outPath = `preloop-out-${tag}.mp4`;

  await ffmpeg.writeFile(inPath, srcBytes);

  // оценка длительности исходника. сначала верим хинту от content_script
  // (там делается через невидимый <video preload=metadata>, точно).
  // если хинта нет — пробуем ffprobe-like через ffmpeg.
  let sourceMs = Number(sourceMsHint);
  if (!Number.isFinite(sourceMs) || sourceMs <= 0) {
    sourceMs = await probeVideoDurationMs(inPath).catch(() => 0);
  }
  if (!Number.isFinite(sourceMs) || sourceMs <= 0) {
    await safeDeleteFsFile(inPath);
    throw new Error('не удалось определить длительность исходного видео');
  }

  // сколько раз надо повторить (включая первое воспроизведение)
  const repeats = Math.max(1, Math.ceil(targetMs / sourceMs));
  const finalMs = repeats * sourceMs;
  // -stream_loop принимает число ДОПОЛНИТЕЛЬНЫХ повторов (loops после первого);
  // т.е. для repeats=1 → loop=0, для repeats=4 → loop=3.
  const streamLoopArg = String(repeats - 1);

  // === path 1: try stream_copy (быстро, без перекода) ===
  const copyArgs = [
    '-y',
    '-stream_loop', streamLoopArg,
    '-i', inPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ];

  try {
    const code = await ffmpeg.exec(copyArgs, 90000);
    if (code === 0) {
      const buf = await ffmpeg.readFile(outPath);
      const bytes = new Uint8Array(buf.buffer.slice(0));
      await safeDeleteFsFile(inPath);
      await safeDeleteFsFile(outPath);
      console.log('[offscreen] preLoop done via stream_copy', { repeats, sourceMs, finalMs, bytes: bytes.byteLength });
      return { bytes, repeats, mode: 'copy', sourceMs, finalMs };
    }
    console.warn('[offscreen] preLoop stream_copy non-zero exit:', code);
  } catch (err) {
    console.warn('[offscreen] preLoop stream_copy threw:', err.message);
  }

  // прибираем кривой out (если остался) перед re-encode
  await safeDeleteFsFile(outPath);

  // === path 2: re-encode ===
  // libx264 preset=veryfast + CRF=26. ultrafast давал слишком жирный файл
  // (нет motion estimation → битрейт безумный), и dreamface режет upload
  // на ~100 MB. veryfast/CRF=26 даёт визуально близкое качество при
  // 3-5x меньшем размере, при этом всё ещё быстрый (доли секунды на 30s mp4
  // на m1/intel-десктопе).
  const reArgs = [
    '-y',
    '-stream_loop', streamLoopArg,
    '-i', inPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '26',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outPath,
  ];

  try {
    const code = await ffmpeg.exec(reArgs, 240000);
    if (code !== 0) {
      await safeDeleteFsFile(inPath);
      await safeDeleteFsFile(outPath);
      throw new Error(`ffmpeg re-encode returned ${code}`);
    }
    const buf = await ffmpeg.readFile(outPath);
    const bytes = new Uint8Array(buf.buffer.slice(0));
    await safeDeleteFsFile(inPath);
    await safeDeleteFsFile(outPath);
    console.log('[offscreen] preLoop done via re-encode', { repeats, sourceMs, finalMs, bytes: bytes.byteLength });
    return { bytes, repeats, mode: 'reencode', sourceMs, finalMs };
  } catch (err) {
    await safeDeleteFsFile(inPath);
    await safeDeleteFsFile(outPath);
    throw err;
  }
}

// Прокинуть исходник через ffmpeg только чтобы прочитать длительность.
// Используется как фолбек, когда content_script не передал sourceMs.
// Запускаем ffmpeg с -t 0 в /dev/null-аналог — он напечатает Duration в логах,
// но они нам недоступны из JS из-за конфигурации логгера. Поэтому
// используем неприятный, но рабочий трюк: ffprobe-эмуляция через -f null - .
// Если не сработает — вернётся 0, и preLoopVideoMp4 кинет ошибку.
async function probeVideoDurationMs(inPath) {
  // ffmpeg.wasm не имеет ffprobe. Используем -hide_banner + -i + -f null,
  // но получить длительность программно из вывода не выйдет напрямую.
  // Проще — попросить vendored ffmpeg вывести метаданные через -loglevel info
  // и парсить. На практике сложно. Возвращаем 0 → форсим хинт с верхнего слоя.
  return 0;
}

// Освободить blob:URL после того как chrome.downloads его подхватил.
function handleRevokeBlob(payload) {
  const blobUrl = payload?.blobUrl;
  if (!blobUrl) return { ok: false, error: 'no blobUrl' };
  try { URL.revokeObjectURL(blobUrl); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
}

// LEGACY: оставлен как shim для обратной совместимости. Реальная логика
// батч-скачивания теперь живёт в background DownloadManager. Сюда продолжают
// прилетать запросы только если очень старый content_script ещё дёргает старый action.
const CHAPTERS_POOL_CONCURRENCY = 1;

async function handleDownloadWithChapters(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) {
    return { ok: false, error: 'no items' };
  }

  const downloaded = [];
  const failed = [];
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      try {
        const result = await downloadOneWithChapters(item);
        downloaded.push(result);
        // прогресс в runState для UI
        try {
          await chrome.runtime.sendMessage({ action: 'engine.bumpDownloadProgress' });
        } catch {}
      } catch (err) {
        console.error('[offscreen] download failed', item.workName, err.message);
        failed.push({ workId: item.workId, workName: item.workName, error: err.message });
      }
    }
  }

  const n = Math.max(1, Math.min(CHAPTERS_POOL_CONCURRENCY, items.length));
  const workers = [];
  for (let i = 0; i < n; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return {
    ok: downloaded.length > 0,
    downloaded,
    failed,
    error: downloaded.length === 0 ? 'all downloads failed' : undefined,
  };
}

async function restoreRunState() {
  const response = await chrome.runtime.sendMessage({ action: 'engine.getRunState' });
  const saved = response?.state;
  if (!saved?.runId) {
    await pushState();
    return;
  }

  const idle = createIdleRunState();
  runState = {
    ...idle,
    ...saved,
    queuePlan: Array.isArray(saved.queuePlan) ? saved.queuePlan : [],
    summary: { ...idle.summary, ...(saved.summary || {}) },
    normalization: { ...idle.normalization, ...(saved.normalization || {}) },
    downloadPlan: { ...idle.downloadPlan, ...(saved.downloadPlan || {}) },
  };

  if (['preparing', 'normalizing', 'ready', 'running', 'stopping'].includes(runState.phase)) {
    const remainingTasks = Math.max(0, runState.queuePlan.length - Number(runState.nextTaskIndex || 0));
    runState.phase = 'failed';
    runState.interrupted = true;
    runState.recoverable = runState.mode === 'bulk' && remainingTasks > 0;
    runState.interruptionReason = 'offscreen_restarted';
    runState.finishedAt = new Date().toISOString();
    runState.statusText = runState.mode === 'legacy'
      ? 'legacy-очередь создана до bulk-миграции и не может быть возобновлена. запустите её заново.'
      : remainingTasks > 0
      ? `offscreen перезапущен. очередь можно возобновить, осталось: ${remainingTasks}`
      : 'offscreen перезапущен до сохранения очереди. запустите обработку заново.';
    runState.downloadPlan = {
      ...runState.downloadPlan,
      lastStatus: 'interrupted',
      lastMessage: runState.statusText,
    };
  } else if (runState.phase === 'downloading') {
    runState.phase = 'finished';
    runState.statusText = 'offscreen перезапущен; состояние скачиваний сохранено в download manager';
  }

  await pushState();
}

const initializationPromise = restoreRunState().catch((error) => {
  console.error('[offscreen] run state restore failed:', error.message);
  runState = createIdleRunState();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target !== 'offscreen') {
    return false;
  }

  const needsRunAdmission = request.action === 'prepareRun' || request.action === 'resumeRun';
  const admissionToken = needsRunAdmission ? acquireRunAdmission() : null;
  if (needsRunAdmission && !admissionToken) {
    sendResponse({ ok: false, error: 'engine is already busy' });
    return false;
  }

  (async () => {
    await initializationPromise;
    switch (request.action) {
      case 'prepareRun':
        if (isBusyPhase(runState.phase)) {
          releaseRunAdmission(admissionToken);
          sendResponse({ ok: false, error: 'engine is already busy' });
          return;
        }

        startRun(request.payload, admissionToken).catch(async (error) => {
          releaseRunAdmission(admissionToken);
          await failRun(`ошибка движка: ${error.message}`);
        });
        sendResponse({ ok: true });
        return;

      case 'stopRun':
        sendResponse(await stopRun());
        return;

      case 'resumeRun':
        sendResponse(await resumeRun(request.payload, admissionToken));
        return;

      case 'downloadCreations':
        sendResponse(await triggerCreationsDownload());
        return;

      case 'bulkWatcherTick':
        sendResponse(await runBulkWatcher());
        return;

      case 'downloadWithChapters':
        // LEGACY: новый поток идёт через background DownloadManager (dm.enqueue).
        // Этот ветка осталась как фоллбек на случай если что-то ещё дёргает старый action.
        sendResponse({ ok: true, started: true, total: request.payload?.items?.length || 0 });
        handleDownloadWithChapters(request.payload).then((result) => {
          console.log('[offscreen] LEGACY chapters batch done:',
            'downloaded=', result.downloaded?.length,
            'failed=', result.failed?.length);
        }).catch((err) => {
          console.error('[offscreen] LEGACY chapters batch crashed:', err.message);
        });
        return;

      case 'muxOne':
        sendResponse(await handleMuxOne(request.payload));
        return;

      case 'preLoopVideo':
        sendResponse(await handlePreLoopVideo(request.payload));
        return;

      case 'revokeBlob':
        sendResponse(handleRevokeBlob(request.payload));
        return;

      case 'resetRunState':
        sendResponse(await resetRunState());
        return;

      case 'tabLifecycle':
        await handleTabLifecycle(request.payload);
        sendResponse({ ok: true });
        return;

      case 'ping':
        sendResponse({ ok: true, runState: cloneState() });
        return;

      default:
        sendResponse({ ok: false, error: `Unknown offscreen action: ${request.action}` });
    }
  })().catch((error) => {
    releaseRunAdmission(admissionToken);
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});
