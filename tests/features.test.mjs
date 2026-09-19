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

test('the validated dispatch path ships enabled, unvalidated phases stay off', () => {
  // Phase 0 tracing is read-only; everything that the 19.09 runs validated ships on: the health
  // gate, the probe snapshot, the quota ledger, the backlog tier, LPT order and the plan preview.
  for (const flag of ['phase0Trace', 'accountHealth', 'accountSnapshot', 'lptOrder', 'quotaLedger', 'backlogTier', 'planPreview']) {
    assert.equal(DEFAULT_FEATURES[flag], true, `${flag} is part of the validated dispatch path`);
  }
  for (const flag of ['ossUploadCache', 'workLedger', 'chunkedPlanning']) {
    assert.equal(DEFAULT_FEATURES[flag], false, `${flag} changes runtime behavior and must default off`);
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
