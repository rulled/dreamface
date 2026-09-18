// Phase 0 trace recorder: read-only instrumentation for the bulk queue.
// Nothing here changes scheduling behavior — it only observes and persists what happened.
//
// Storage: chrome.storage.local[TRACE_KEY] = { lines, dropped, seq, revision, updatedAt }
//   `lines` holds one JSON string per event, i.e. the export format is exactly NDJSON.
//   `revision` guards against an external clear (popup writes it): the writer re-reads
//   storage before flushing whenever the revision it knows no longer matches.
//
// Event envelope: { seq, ts, iso, runId?, mode?, type, ...payload }
//
// Event types and their payload:
//   run_start     batches, audios, videos, splitTarget, overlap, autoNormalize
//   account_probe source, accountId, runningWorks, limitSec, tier, planName, planned,
//                 baselineLoad, requiredDurationSeconds, score, avatarCached
//   avatar        unitId, accountId, cached, latencyMs
//   upload        unitId, accountId, fileName, bytes, latencyMs
//   dispatch_ack  unitId, accountId, accountPrincipal, taskCount, maxDurSec, uploadMs,
//                 submitMs, avatarCached, quotaBefore, quotaAfter, successCount,
//                 failCount, runningAfter, raw, rawBytes, rawTruncated
//   running_probe accountId, phase ('t+0' | 't+30' | 'limit_hit'), count, ids | error
//   limit_hit     unitId, accountId, taskCount, error, apiStatus
//   work_status   workId, unitId, accountId, submittedAt, status
//   run_end       phase, reason, recoverable, total, nextTaskIndex, uncertain, rejected

export const TRACE_KEY = 'dreamfacePhase0Trace';
export const TRACE_MAX_LINES = 2000;
export const TRACE_BYTE_BUDGET = 5_000_000;
export const RAW_LIMIT_BYTES = 20_000;
const DEDUPE_CAP = 20_000;

export function appendLine(lines, line, options = {}) {
  const maxLines = Number(options.maxLines) > 0 ? Number(options.maxLines) : TRACE_MAX_LINES;
  const byteBudget = Number(options.byteBudget) > 0 ? Number(options.byteBudget) : TRACE_BYTE_BUDGET;
  const next = [...(Array.isArray(lines) ? lines : []), line];
  let bytes = next.reduce((sum, item) => sum + item.length + 1, 0);
  let dropped = 0;
  while (next.length > maxLines || (bytes > byteBudget && next.length > 1)) {
    const removed = next.shift();
    bytes -= removed.length + 1;
    dropped += 1;
  }
  return { lines: next, dropped, bytes };
}

export function toJsonl(lines) {
  const list = Array.isArray(lines) ? lines : [];
  return list.length === 0 ? '' : `${list.join('\n')}\n`;
}

export function compactRaw(value, limit = RAW_LIMIT_BYTES) {
  if (value === undefined || value === null) return { raw: null, rawBytes: 0, rawTruncated: false };
  let text;
  try {
    text = JSON.stringify(value);
  } catch (_) {
    return { raw: null, rawBytes: 0, rawTruncated: true };
  }
  if (typeof text !== 'string') return { raw: null, rawBytes: 0, rawTruncated: true };
  if (text.length <= limit) return { raw: value, rawBytes: text.length, rawTruncated: false };
  return { raw: text.slice(0, limit), rawBytes: text.length, rawTruncated: true };
}

function defaultStorage() {
  return typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
}

function createRevision() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createTraceWriter(options = {}) {
  const store = options.storage || defaultStorage();
  const key = options.key || TRACE_KEY;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxLines = Number(options.maxLines) > 0 ? Number(options.maxLines) : TRACE_MAX_LINES;
  const byteBudget = Number(options.byteBudget) > 0 ? Number(options.byteBudget) : TRACE_BYTE_BUDGET;

  let lines = [];
  let dropped = 0;
  let seq = 0;
  let revision = '';
  let synced = false;
  let enabled = options.enabled !== false;
  let context = {};
  let chain = Promise.resolve();
  const pending = [];
  const seen = new Set();

  async function syncFromStorage() {
    if (!store) return;
    const stored = await Promise.resolve(store.get(key)).catch(() => null);
    const state = stored?.[key];
    const storedRevision = String(state?.revision || '');
    if (synced && storedRevision === revision) return;
    lines = Array.isArray(state?.lines) ? state.lines : [];
    dropped = Number(state?.dropped) || 0;
    if (Number.isFinite(Number(state?.seq))) seq = Math.max(seq, Number(state.seq));
    revision = storedRevision;
    synced = true;
  }

  async function drain() {
    await syncFromStorage();
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    for (const item of batch) {
      // seq is assigned here, after the stored counter was loaded, so it stays
      // monotonic across offscreen restarts; ts stays the event time.
      const line = JSON.stringify({
        seq: ++seq,
        ts: item.ts,
        iso: new Date(item.ts).toISOString(),
        ...item.payload,
      });
      const result = appendLine(lines, line, { maxLines, byteBudget });
      lines = result.lines;
      dropped += result.dropped;
    }
    revision = createRevision();
    if (!store) return;
    await Promise.resolve(store.set({
      [key]: { lines, dropped, seq, revision, updatedAt: now() },
    })).catch(() => {});
  }

  function record(event) {
    if (!enabled || !event) return false;
    pending.push({ ts: now(), payload: { ...context, ...event } });
    chain = chain.then(drain).catch(() => {});
    return true;
  }

  function recordOnce(dedupeKey, event) {
    const dedupe = String(dedupeKey || '');
    if (!dedupe) return record(event);
    if (seen.has(dedupe)) return false;
    if (seen.size >= DEDUPE_CAP) seen.clear();
    seen.add(dedupe);
    return record(event);
  }

  return {
    record,
    recordOnce,
    setContext(patch) {
      context = { ...context, ...(patch || {}) };
    },
    setEnabled(value) {
      enabled = value !== false;
    },
    isEnabled() {
      return enabled;
    },
    async flush() {
      await chain;
    },
    read() {
      return { lines: [...lines], dropped, seq };
    },
    async clear() {
      await syncFromStorage();
      lines = [];
      dropped = 0;
      seen.clear();
      revision = createRevision();
      if (!store) return;
      await Promise.resolve(store.set({
        [key]: { lines: [], dropped: 0, seq, revision, updatedAt: now() },
      })).catch(() => {});
    },
  };
}

export async function readTrace(options = {}) {
  const store = options.storage || defaultStorage();
  const key = options.key || TRACE_KEY;
  if (!store) return { lines: [], dropped: 0, seq: 0, bytes: 0 };
  const stored = await Promise.resolve(store.get(key)).catch(() => null);
  const state = stored?.[key];
  const lines = Array.isArray(state?.lines) ? state.lines : [];
  return {
    lines,
    dropped: Number(state?.dropped) || 0,
    seq: Number(state?.seq) || 0,
    bytes: lines.reduce((sum, line) => sum + line.length + 1, 0),
  };
}

export async function clearTrace(options = {}) {
  const store = options.storage || defaultStorage();
  const key = options.key || TRACE_KEY;
  if (!store) return false;
  await Promise.resolve(store.set({
    [key]: { lines: [], dropped: 0, seq: 0, revision: createRevision(), updatedAt: Date.now() },
  })).catch(() => {});
  return true;
}
