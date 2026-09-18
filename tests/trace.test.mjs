import test from 'node:test';
import assert from 'node:assert/strict';
import { compactRaw, clearTrace, createTraceWriter, readTrace, toJsonl } from '../trace.js';
import { trimPlan } from '../trace-store.js';

// In-memory stand-in for the IndexedDB store: same interface, no browser required.
function createFakeStore() {
  let rows = [];
  let meta = { seq: 0, dropped: 0, lastError: '' };
  return {
    rows: () => rows.map((row) => row.line),
    setLastError(value) { meta.lastError = value; },
    async append(line) { rows.push({ line, len: line.length + 1 }); },
    async read(readOptions = {}) {
      const limit = Number(readOptions.limit) > 0 ? Number(readOptions.limit) : 0;
      const visible = limit > 0 ? rows.slice(-limit) : rows;
      return {
        lines: visible.map((row) => row.line),
        dropped: meta.dropped,
        seq: meta.seq,
        lastError: meta.lastError,
        bytes: rows.reduce((sum, row) => sum + row.len, 0),
      };
    },
    async readMeta() { return { ...meta }; },
    async saveMeta(patch) { meta = { ...meta, ...(patch || {}) }; return meta; },
    async trim() { return 0; },
    async clear() { rows = []; meta = { seq: 0, dropped: 0, lastError: '' }; },
  };
}

test('trimPlan drops the oldest lines past the line cap', () => {
  const rows = [{ len: 10 }, { len: 10 }, { len: 10 }, { len: 10 }, { len: 10 }];
  assert.deepEqual(trimPlan(rows, { maxLines: 3, byteBudget: 10_000 }), { drop: 2, bytes: 30, count: 3 });
});

test('trimPlan drops the oldest lines past the byte budget', () => {
  const rows = [{ len: 10 }, { len: 10 }, { len: 3 }];
  assert.deepEqual(trimPlan(rows, { maxLines: 100, byteBudget: 10 }), { drop: 2, bytes: 3, count: 1 });
});

test('trimPlan keeps the newest line even when it alone exceeds the budget', () => {
  const rows = [{ len: 999 }];
  assert.deepEqual(trimPlan(rows, { maxLines: 100, byteBudget: 10 }), { drop: 0, bytes: 999, count: 1 });
});

test('toJsonl renders one JSON object per line and ends with a newline', () => {
  assert.equal(toJsonl(['{"a":1}', '{"b":2}']), '{"a":1}\n{"b":2}\n');
  assert.equal(toJsonl([]), '');
});

test('compactRaw keeps a small payload intact', () => {
  const raw = { success_count: 3, data: { fail_count: 0 } };
  assert.deepEqual(compactRaw(raw), { raw, rawBytes: JSON.stringify(raw).length, rawTruncated: false });
});

test('compactRaw truncates a large payload and still reports the real size', () => {
  const payload = { blob: 'x'.repeat(500) };
  const result = compactRaw(payload, 100);
  assert.equal(result.rawTruncated, true);
  assert.equal(result.raw.length, 100);
  assert.equal(result.rawBytes, JSON.stringify(payload).length);
});

test('writer appends every record in order with a monotonic seq', async () => {
  const store = createFakeStore();
  const writer = createTraceWriter({ store, now: () => 1000 });
  writer.setContext({ runId: 'run-1' });
  writer.record({ type: 'run_start', batches: 2 });
  writer.record({ type: 'limit_hit', accountId: 'a1' });
  await writer.flush();

  const [first, second] = store.rows().map((line) => JSON.parse(line));
  assert.equal(first.type, 'run_start');
  assert.equal(first.runId, 'run-1');
  assert.equal(first.seq, 1);
  assert.equal(first.ts, 1000);
  assert.equal(second.type, 'limit_hit');
  assert.equal(second.seq, 2);
  assert.equal(second.accountId, 'a1');
});

test('seq continues from the stored counter after a writer restart', async () => {
  const store = createFakeStore();
  const first = createTraceWriter({ store, now: () => 1000 });
  first.record({ type: 'run_start' });
  await first.flush();
  await store.saveMeta({ seq: 41 });

  const second = createTraceWriter({ store, now: () => 2000 });
  second.record({ type: 'run_end' });
  await second.flush();

  const seqs = store.rows().map((line) => JSON.parse(line).seq);
  assert.deepEqual(seqs, [1, 42]);
});

test('records written before a clear stay gone', async () => {
  const store = createFakeStore();
  const writer = createTraceWriter({ store, now: () => 3000 });
  writer.record({ type: 'run_start' });
  await writer.flush();

  await clearTrace({ store });
  writer.record({ type: 'run_end' });
  await writer.flush();

  const lines = (await readTrace({ store })).lines;
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).type, 'run_end');
});

test('recordOnce keeps only the first event for a key', async () => {
  const store = createFakeStore();
  const writer = createTraceWriter({ store, now: () => 4000 });
  assert.equal(writer.recordOnce('work:w1:5', { type: 'work_status', workId: 'w1', status: 5 }), true);
  assert.equal(writer.recordOnce('work:w1:5', { type: 'work_status', workId: 'w1', status: 5 }), false);
  assert.equal(writer.recordOnce('work:w1:200', { type: 'work_status', workId: 'w1', status: 200 }), true);
  await writer.flush();

  assert.equal(store.rows().length, 2);
});

test('a disabled writer records nothing', async () => {
  const store = createFakeStore();
  const writer = createTraceWriter({ store, enabled: false, now: () => 5000 });
  assert.equal(writer.record({ type: 'run_start' }), false);
  await writer.flush();
  assert.equal(store.rows().length, 0);

  writer.setEnabled(true);
  assert.equal(writer.record({ type: 'run_start' }), true);
  await writer.flush();
  assert.equal(store.rows().length, 1);
});

test('a failing store is reported instead of breaking the caller', async () => {
  const store = createFakeStore();
  store.append = async () => { throw new Error('quota exceeded'); };
  const writer = createTraceWriter({ store, now: () => 6000 });
  assert.equal(writer.record({ type: 'run_start' }), true);
  await writer.flush();

  assert.equal(writer.getLastError(), 'quota exceeded');
  assert.equal((await readTrace({ store })).lastError, 'quota exceeded');
});

test('readTrace reports the log size and clearTrace empties it', async () => {
  const store = createFakeStore();
  const writer = createTraceWriter({ store, now: () => 7000 });
  writer.record({ type: 'run_start' });
  writer.record({ type: 'run_end' });
  await writer.flush();

  const before = await readTrace({ store });
  assert.equal(before.lines.length, 2);
  assert.ok(before.bytes > 0);

  await clearTrace({ store });
  const after = await readTrace({ store });
  assert.deepEqual(after.lines, []);
  assert.equal(after.bytes, 0);
});
