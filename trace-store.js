// Phase 0 trace storage: dedicated IndexedDB database.
//
// Why not chrome.storage: offscreen documents only receive the chrome.runtime API —
// chrome.storage is undefined there, so a writer living in offscreen cannot persist
// through it. IndexedDB is available (the engine already keeps blobs in one) and the
// database is shared between the popup and the offscreen document (same extension origin).
//
// Every request handler is attached in the same task that creates the transaction; the
// transaction's completion resolves the promise with the captured result. Attaching a
// success handler after the transaction already completed would never fire.

export const TRACE_DB_NAME = 'dreamface-phase0-trace';
export const TRACE_DB_VERSION = 1;
export const TRACE_MAX_LINES = 2000;
export const TRACE_BYTE_BUDGET = 5_000_000;
export const TRACE_TRIM_INTERVAL = 32;

const LINE_STORE = 'lines';
const META_STORE = 'meta';
const META_KEY = 'state';

// rows are ordered oldest -> newest; returns how many of the oldest must be dropped
// so that the retained log fits both the line cap and the byte budget.
export function trimPlan(rows, options = {}) {
  const maxLines = Number(options.maxLines) > 0 ? Number(options.maxLines) : TRACE_MAX_LINES;
  const byteBudget = Number(options.byteBudget) > 0 ? Number(options.byteBudget) : TRACE_BYTE_BUDGET;
  const list = Array.isArray(rows) ? rows : [];
  let count = list.length;
  let bytes = list.reduce((sum, row) => sum + Number(row.len || 0), 0);
  let drop = 0;
  while (drop < list.length && (count > maxLines || (bytes > byteBudget && count > 1))) {
    bytes -= Number(list[drop].len || 0);
    count -= 1;
    drop += 1;
  }
  return { drop, bytes, count };
}

export function createTraceStore(options = {}) {
  const idb = options.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  const dbName = options.dbName || TRACE_DB_NAME;
  let dbPromise = null;

  function openDb() {
    if (!idb) return Promise.reject(new Error('indexedDB is unavailable in this context'));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = idb.open(dbName, TRACE_DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(LINE_STORE)) db.createObjectStore(LINE_STORE, { autoIncrement: true });
          if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('trace database open failed'));
      });
    }
    return dbPromise;
  }

  // work(stores) may return an IDBRequest (its result becomes the value) or a plain value.
  async function runTx(names, mode, work) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      const stores = names.map((name) => tx.objectStore(name));
      let value;
      let failed = false;
      let request;
      try {
        request = work(...stores);
      } catch (error) {
        reject(error);
        return;
      }
      if (request && typeof request === 'object' && 'onsuccess' in request) {
        request.onsuccess = () => { value = request.result; };
        request.onerror = () => {
          failed = true;
          reject(request.error || new Error('trace database request failed'));
        };
      } else {
        value = request;
      }
      tx.oncomplete = () => { if (!failed) resolve(value); };
      tx.onerror = () => { if (!failed) reject(tx.error || new Error('trace database transaction failed')); };
      tx.onabort = () => { if (!failed) reject(tx.error || new Error('trace database transaction aborted')); };
    });
  }

  async function readMeta() {
    const value = await runTx([META_STORE], 'readonly', (store) => store.get(META_KEY));
    return {
      seq: Number(value?.seq) || 0,
      dropped: Number(value?.dropped) || 0,
      lastError: String(value?.lastError || ''),
    };
  }

  async function saveMeta(patch) {
    const current = await readMeta();
    const next = { ...current, ...(patch || {}) };
    await runTx([META_STORE], 'readwrite', (store) => store.put(next, META_KEY));
    return next;
  }

  function readAll() {
    return runTx([LINE_STORE], 'readonly', (store) => store.getAll());
  }

  async function append(line) {
    await runTx([LINE_STORE], 'readwrite', (store) => store.add({ line, len: line.length + 1 }));
  }

  async function read(readOptions = {}) {
    const rows = (await readAll()) || [];
    const meta = await readMeta();
    const limit = Number(readOptions.limit) > 0 ? Number(readOptions.limit) : 0;
    const visible = limit > 0 ? rows.slice(-limit) : rows;
    return {
      lines: visible.map((row) => row.line),
      dropped: meta.dropped,
      seq: meta.seq,
      lastError: meta.lastError,
      bytes: rows.reduce((sum, row) => sum + Number(row.len || 0), 0),
    };
  }

  async function trim(trimOptions = {}) {
    const rows = (await readAll()) || [];
    if (rows.length === 0) return 0;
    const keys = await runTx([LINE_STORE], 'readonly', (store) => store.getAllKeys());
    const deleteKeys = (keys || []).slice(0, trimPlan(rows, trimOptions).drop);
    if (deleteKeys.length === 0) return 0;
    await runTx([LINE_STORE], 'readwrite', (store) => {
      for (const key of deleteKeys) store.delete(key);
      return deleteKeys.length;
    });
    const meta = await readMeta();
    await saveMeta({ dropped: meta.dropped + deleteKeys.length });
    return deleteKeys.length;
  }

  async function clear() {
    await runTx([LINE_STORE, META_STORE], 'readwrite', (lines, meta) => {
      lines.clear();
      meta.clear();
      return true;
    });
  }

  return { append, read, readMeta, saveMeta, trim, clear };
}
