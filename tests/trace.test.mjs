import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendLine,
  clearTrace,
  compactRaw,
  createTraceWriter,
  readTrace,
  toJsonl,
  TRACE_KEY,
} from '../trace.js';

function createFakeStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      return { [key]: structuredClone(data[key]) };
    },
    async set(patch) {
      for (const [key, value] of Object.entries(patch)) data[key] = structuredClone(value);
    },
  };
}

test('appendLine drops the oldest lines once the line cap is hit', () => {
  let lines = [];
  let dropped = 0;
  for (let index = 0; index < 5; index += 1) {
    const result = appendLine(lines, `line-${index}`, { maxLines: 3, byteBudget: 10000 });
    lines = result.lines;
    dropped += result.dropped;
  }
  assert.deepEqual(lines, ['line-2', 'line-3', 'line-4']);
  assert.equal(dropped, 2);
});

test('appendLine keeps the newest lines that fit the byte budget', () => {
  const result = appendLine(['0123456789', '0123456789'], 'newest', { maxLines: 100, byteBudget: 10 });
  assert.deepEqual(result.lines, ['newest']);
  assert.equal(result.dropped, 2);
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

test('writer appends every record to storage in order', async () => {
  const storage = createFakeStorage();
  const writer = createTraceWriter({ storage, now: () => 1000 });
  writer.setContext({ runId: 'run-1' });
  writer.record({ type: 'run_start', batches: 2 });
  writer.record({ type: 'limit_hit', accountId: 'a1' });
  await writer.flush();

  const stored = storage.data[TRACE_KEY];
  assert.equal(stored.lines.length, 2);
  const [first, second] = stored.lines.map((line) => JSON.parse(line));
  assert.equal(first.type, 'run_start');
  assert.equal(first.runId, 'run-1');
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(second.accountId, 'a1');
});

test('writer appends to an existing log instead of clobbering it', async () => {
  const storage = createFakeStorage({
    [TRACE_KEY]: { lines: ['{"seq":1,"type":"old"}'], dropped: 0, seq: 1, revision: 'rev-1' },
  });
  const writer = createTraceWriter({ storage, now: () => 2000 });
  writer.record({ type: 'run_start' });
  await writer.flush();

  const stored = storage.data[TRACE_KEY];
  assert.equal(stored.lines.length, 2);
  assert.equal(JSON.parse(stored.lines[0]).type, 'old');
  assert.equal(JSON.parse(stored.lines[1]).type, 'run_start');
  assert.equal(JSON.parse(stored.lines[1]).seq, 2);
});

test('writer drops its in-memory log when storage was cleared externally', async () => {
  const storage = createFakeStorage();
  const writer = createTraceWriter({ storage, now: () => 3000 });
  writer.record({ type: 'run_start' });
  await writer.flush();

  await clearTrace({ storage });
  writer.record({ type: 'run_end' });
  await writer.flush();

  const stored = storage.data[TRACE_KEY];
  assert.equal(stored.lines.length, 1);
  assert.equal(JSON.parse(stored.lines[0]).type, 'run_end');
});

test('recordOnce keeps only the first event for a key', async () => {
  const storage = createFakeStorage();
  const writer = createTraceWriter({ storage, now: () => 4000 });
  assert.equal(writer.recordOnce('work:w1:5', { type: 'work_status', workId: 'w1', status: 5 }), true);
  assert.equal(writer.recordOnce('work:w1:5', { type: 'work_status', workId: 'w1', status: 5 }), false);
  assert.equal(writer.recordOnce('work:w1:200', { type: 'work_status', workId: 'w1', status: 200 }), true);
  await writer.flush();

  assert.equal(storage.data[TRACE_KEY].lines.length, 2);
});

test('a disabled writer records nothing but keeps an empty log', async () => {
  const storage = createFakeStorage();
  const writer = createTraceWriter({ storage, enabled: false, now: () => 5000 });
  writer.setEnabled(false);
  assert.equal(writer.record({ type: 'run_start' }), false);
  await writer.flush();
  assert.equal(storage.data[TRACE_KEY], undefined);

  writer.setEnabled(true);
  assert.equal(writer.record({ type: 'run_start' }), true);
  await writer.flush();
  assert.equal(storage.data[TRACE_KEY].lines.length, 1);
});

test('readTrace reports the log size and clearTrace empties it', async () => {
  const storage = createFakeStorage();
  const writer = createTraceWriter({ storage, now: () => 6000 });
  writer.record({ type: 'run_start' });
  writer.record({ type: 'run_end' });
  await writer.flush();

  const before = await readTrace({ storage });
  assert.equal(before.lines.length, 2);
  assert.ok(before.bytes > 0);

  await clearTrace({ storage });
  const after = await readTrace({ storage });
  assert.deepEqual(after.lines, []);
  assert.equal(after.bytes, 0);
});
