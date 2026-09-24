// Setup-view persistence: the video/audio selection the operator builds before a run.
//
// Chrome tears the popup document down as soon as it loses focus, so the queue builder keeps
// its own snapshot. Selection metadata (videos + which ones each group picked + audio file
// metadata) goes to chrome.storage.local; audio bytes go to a dedicated IndexedDB database —
// chrome.storage cannot hold Blobs and base64 would blow its quota. The run pipeline keeps its
// own copy of the audio in dreamface-run-db, which is why this store is separate: no shared
// version to keep in lockstep with the engine.
//
// Videos are persisted by identity (URL without query/hash) rather than by grid index: the
// DreamFace list reorders whenever a new avatar is uploaded, and re-scanning remaps identities
// onto the fresh indices.

export const SETUP_STATE_KEY = 'bulkSetupState';
export const SETUP_STATE_VERSION = 1;
export const SETUP_DB_NAME = 'dreamface-setup-db';
export const SETUP_DB_VERSION = 1;
export const SETUP_AUDIO_STORE = 'audioFiles';

export function videoIdentity(source) {
  try {
    const url = new URL(source);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return String(source || '');
  }
}

function toStoredVideo(video) {
  return {
    avatarId: String(video?.avatarId || ''),
    videoUrl: String(video?.videoUrl || ''),
    src: String(video?.src || ''),
    name: String(video?.name || ''),
    isDefault: Boolean(video?.isDefault),
  };
}

function toStoredBatch(batch, videos, audioIdOf) {
  return {
    id: batch.id,
    videoPage: Math.max(0, Number(batch.videoPage) || 0),
    sortOrder: batch.sortOrder === 'desc' ? 'desc' : 'asc',
    audioExpanded: Boolean(batch.audioExpanded),
    selectedVideoKeys: (batch.selectedIndices || [])
      .map((index) => videoIdentity(videos[index]?.src))
      .filter(Boolean),
    audios: (batch.audioFiles || []).map((file) => ({
      id: audioIdOf(file),
      name: file.name,
      type: file.type || 'application/octet-stream',
      lastModified: Number(file.lastModified) || Date.now(),
      size: Number(file.size) || 0,
    })),
  };
}

export function serializeSetupState({ videos = [], batches = [], audioIdOf }) {
  return {
    version: SETUP_STATE_VERSION,
    savedAt: Date.now(),
    videos: (Array.isArray(videos) ? videos : []).map(toStoredVideo),
    batches: (Array.isArray(batches) ? batches : []).map((batch) => toStoredBatch(batch, videos, audioIdOf)),
  };
}

export function collectAudioIds(snapshot) {
  const ids = new Set();
  for (const batch of snapshot?.batches || []) {
    for (const audio of batch.audios || []) {
      if (audio?.id) ids.add(audio.id);
    }
  }
  return ids;
}

// Audio entries whose blob never made it to IndexedDB are dropped: a group with a file the run
// cannot read would fail at prepare time, which is worse than losing that row up front.
export function hydrateSetupState(snapshot, { audioRecords, makeFile } = {}) {
  const records = audioRecords instanceof Map ? audioRecords : new Map();
  const videos = (snapshot?.videos || []).map(toStoredVideo);
  const indexByKey = new Map();
  videos.forEach((video, index) => {
    const key = videoIdentity(video.src);
    if (key && !indexByKey.has(key)) indexByKey.set(key, index);
  });

  const batches = (snapshot?.batches || []).map((stored) => {
    const indices = [...new Set((stored.selectedVideoKeys || [])
      .map((key) => indexByKey.get(videoIdentity(key)))
      .filter((index) => Number.isInteger(index)))];

    const audioFiles = [];
    for (const entry of stored.audios || []) {
      const record = records.get(entry.id);
      if (!record?.blob) continue;
      audioFiles.push(makeFile({ ...entry, blob: record.blob }));
    }

    return {
      id: Number.isFinite(Number(stored.id)) ? Number(stored.id) : Date.now() + Math.floor(Math.random() * 1000),
      selectedIndices: indices,
      selectedAvatars: indices.map((index) => videos[index]),
      audioFiles,
      sortOrder: stored.sortOrder === 'desc' ? 'desc' : 'asc',
      audioExpanded: Boolean(stored.audioExpanded),
      videoPage: Math.max(0, Number(stored.videoPage) || 0),
    };
  });

  return { videos, batches };
}

export async function readSetupSnapshot(storage) {
  const data = await storage.get(SETUP_STATE_KEY);
  const snapshot = data?.[SETUP_STATE_KEY];
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (Number(snapshot.version) !== SETUP_STATE_VERSION) return null;
  return snapshot;
}

export async function writeSetupSnapshot(storage, snapshot) {
  await storage.set({ [SETUP_STATE_KEY]: snapshot });
}

export async function clearSetupSnapshot(storage) {
  await storage.remove(SETUP_STATE_KEY);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

export function openSetupDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SETUP_DB_NAME, SETUP_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SETUP_AUDIO_STORE)) {
        db.createObjectStore(SETUP_AUDIO_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
}

async function withAudioStore(mode, callback) {
  const db = await openSetupDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SETUP_AUDIO_STORE, mode);
    const store = transaction.objectStore(SETUP_AUDIO_STORE);
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

export async function loadStoredAudioIds() {
  const keys = await withAudioStore('readonly', (store) => requestToPromise(store.getAllKeys()));
  return new Set(keys);
}

export async function loadStoredAudioRecords() {
  const records = await withAudioStore('readonly', (store) => requestToPromise(store.getAll()));
  return new Map(records.map((record) => [record.id, record]));
}

export function putAudioRecord(record) {
  return withAudioStore('readwrite', (store) => requestToPromise(store.put(record)));
}

export function deleteAudioRecords(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return Promise.resolve();
  return withAudioStore('readwrite', (store) => {
    ids.forEach((id) => store.delete(id));
  });
}

export function clearAudioRecords() {
  return withAudioStore('readwrite', (store) => {
    store.clear();
  });
}
