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

let ffmpeg = null;
let ffmpegLoadPromise = null;
let runState = createIdleRunState();
let currentRunToken = 0;
let stopRequested = false;

function isBusyPhase(phase) {
  return ['preparing', 'normalizing', 'ready', 'running', 'downloading', 'stopping'].includes(phase);
}

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

    transaction.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(undefined);
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
      if (!settled) {
        settled = true;
        resolve(value);
      }
    }).catch((error) => {
      if (!settled) {
        settled = true;
        reject(error);
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
  const maxDurationSeconds = Number(options?.maxDurationSeconds) > DEFAULT_MAX_DURATION_SECONDS
    ? Number(options.maxDurationSeconds)
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

  const queue = [];
  let queueIndex = 1;

  for (const batch of payload.batches) {
    const outputs = normalizedByBatch.get(batch.id) || [];

    if (batch.selectedIndices.length === 0 || outputs.length === 0) {
      continue;
    }

    let videoPointer = 0;

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
      });

      queueIndex += 1;
      videoPointer = (videoPointer + 1) % batch.selectedIndices.length;
    }
  }

  summary.totalGeneratedTasks = queue.length;
  return { queue, summary };
}

async function callBackground(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...payload });

  if (!response?.ok) {
    throw new Error(response?.error || `Failed action: ${action}`);
  }

  return response;
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

  await resetRunStateInternal();
  return { ok: true, state: cloneState() };
}

async function resetRunState() {
  if (isBusyPhase(runState.phase)) {
    return { ok: false, error: 'engine is busy' };
  }

  await resetRunStateInternal();
  return { ok: true, state: cloneState() };
}

async function startRun(payload) {
  currentRunToken += 1;
  const runToken = currentRunToken;
  stopRequested = false;

  await clearTaskBlobs();

  runState = createIdleRunState();
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

  try {
    const { queue, summary } = await prepareTasks(payload, runToken);
    runState.summary = summary;
    await pushState();
    await processQueue(queue, runToken);
  } catch (error) {
    if (error.code === 'run_stopped') {
      await finishRun('обработка остановлена пользователем');
      return;
    }

    await failRun(`ошибка движка: ${error.message}`);
  } finally {
    stopRequested = false;
    await clearInputFiles().catch(() => {});
  }
}

async function resumeRun(payload = {}) {
  if (isBusyPhase(runState.phase)) {
    return { ok: false, error: 'engine is already busy' };
  }

  if (!Array.isArray(runState.queuePlan) || runState.queuePlan.length === 0) {
    return { ok: false, error: 'очередь для возобновления не найдена' };
  }

  if (Number(runState.nextTaskIndex || 0) >= runState.queuePlan.length) {
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

  processQueue(runState.queuePlan, runToken, Number(runState.nextTaskIndex || 0)).catch(async (error) => {
    if (error.code === 'run_stopped') {
      await finishRun('обработка остановлена пользователем');
      return;
    }

    await failRun(`ошибка движка: ${error.message}`);
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.target !== 'offscreen') {
    return false;
  }

  (async () => {
    switch (request.action) {
      case 'prepareRun':
        if (isBusyPhase(runState.phase)) {
          sendResponse({ ok: false, error: 'engine is already busy' });
          return;
        }

        startRun(request.payload).catch(async (error) => {
          await failRun(`ошибка движка: ${error.message}`);
        });
        sendResponse({ ok: true });
        return;

      case 'stopRun':
        sendResponse(await stopRun());
        return;

      case 'resumeRun':
        sendResponse(await resumeRun(request.payload));
        return;

      case 'downloadCreations':
        sendResponse(await triggerCreationsDownload());
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
    sendResponse({ ok: false, error: error.message || String(error) });
  });

  return true;
});

pushState().catch(() => {});
