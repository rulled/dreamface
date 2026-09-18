import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FEATURES, mergeFeatures, readFeatures, writeFeatures } from '../features.js';

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

test('mergeFeatures fills in defaults and keeps stored overrides', () => {
  assert.deepEqual(mergeFeatures(undefined), { ...DEFAULT_FEATURES });
  assert.deepEqual(mergeFeatures('nonsense'), { ...DEFAULT_FEATURES });
  const merged = mergeFeatures({ chunkedPlanning: true });
  assert.equal(merged.chunkedPlanning, true);
  assert.equal(merged.phase0Trace, true);
});

test('only the read-only phase 0 tracing ships enabled', () => {
  for (const [flag, value] of Object.entries(DEFAULT_FEATURES)) {
    if (flag === 'phase0Trace') {
      assert.equal(value, true, 'phase 0 tracing is read-only instrumentation');
    } else {
      assert.equal(value, false, `${flag} changes runtime behavior and must default off`);
    }
  }
});

test('readFeatures and writeFeatures round-trip through storage', async () => {
  const storage = createFakeStorage();
  const initial = await readFeatures(storage);
  assert.equal(initial.chunkedPlanning, false);

  const updated = await writeFeatures({ chunkedPlanning: true }, storage);
  assert.equal(updated.chunkedPlanning, true);
  assert.equal((await readFeatures(storage)).chunkedPlanning, true);

  await writeFeatures({ chunkedPlanning: false, phase0Trace: false }, storage);
  const restored = await readFeatures(storage);
  assert.equal(restored.chunkedPlanning, false);
  assert.equal(restored.phase0Trace, false);
});
