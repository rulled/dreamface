// Phase 0 trace recorder: read-only instrumentation for the bulk queue.
// Nothing here changes scheduling behavior — it only observes and persists what happened.
//
// Persistence goes through an IndexedDB-backed store (see trace-store.js): the offscreen
// document has no chrome.storage, and the log must survive the offscreen document dying
// mid-run. Export format is NDJSON, one event per line.
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

import {
  createTraceStore,
  TRACE_BYTE_BUDGET,
  TRACE_MAX_LINES,
  TRACE_TRIM_INTERVAL,
} from './trace-store.js';

export const RAW_LIMIT_BYTES = 20_000;
const DEDUPE_CAP = 20_000;

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

export function createTraceWriter(options = {}) {
  const store = options.store || createTraceStore();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxLines = Number(options.maxLines) > 0 ? Number(options.maxLines) : TRACE_MAX_LINES;
  const byteBudget = Number(options.byteBudget) > 0 ? Number(options.byteBudget) : TRACE_BYTE_BUDGET;
  const trimInterval = Number(options.trimInterval) > 0 ? Number(options.trimInterval) : TRACE_TRIM_INTERVAL;

  let enabled = options.enabled !== false;
  let context = {};
  let seq = 0;
  let seqLoaded = false;
  let appended = 0;
  let lastError = '';
  let chain = Promise.resolve();
  const pending = [];
  const seen = new Set();

  async function drain() {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    if (!seqLoaded) {
      try {
        seq = (await store.readMeta()).seq;
        seqLoaded = true;
      } catch (error) {
        lastError = error?.message || String(error);
      }
    }
    for (const item of batch) {
      const line = JSON.stringify({
        seq: ++seq,
        ts: item.ts,
        iso: new Date(item.ts).toISOString(),
        ...item.payload,
      });
      try {
        await store.append(line);
        appended += 1;
        if (lastError) {
          lastError = '';
          await store.saveMeta({ lastError: '' }).catch(() => {});
        }
      } catch (error) {
        // never break a run because tracing failed; the popup surfaces lastError from meta
        lastError = error?.message || String(error);
        await store.saveMeta({ lastError }).catch(() => {});
      }
    }
    try {
      await store.saveMeta({ seq });
      if (appended >= trimInterval) {
        appended = 0;
        await store.trim({ maxLines, byteBudget });
      }
    } catch (error) {
      lastError = error?.message || String(error);
    }
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
    getLastError() {
      return lastError;
    },
    async flush() {
      await chain;
    },
    read(readOptions) {
      return store.read(readOptions);
    },
    async clear() {
      seen.clear();
      await store.clear();
    },
  };
}

export async function readTrace(options = {}) {
  const store = options.store || createTraceStore();
  return store.read(options);
}

export async function clearTrace(options = {}) {
  const store = options.store || createTraceStore();
  await store.clear();
  return true;
}

export { TRACE_MAX_LINES, TRACE_BYTE_BUDGET, TRACE_TRIM_INTERVAL };
