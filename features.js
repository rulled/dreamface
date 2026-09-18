// Feature flags for the scheduler rework.
//
// Every behavior-changing phase ships behind a flag that defaults to OFF, so the
// current (pre-rework) path stays the default until the phase is validated.
// Phase 0 tracing is read-only instrumentation, hence ON by default.

export const FEATURES_KEY = 'dreamfaceFeatures';

export const DEFAULT_FEATURES = Object.freeze({
  phase0Trace: true,
  chunkedPlanning: false,
  weightedScore: false,
  aimdSlots: false,
  parallelDispatch: false,
  dynamicSplit: false,
  avatarWarmup: false,
});

export function mergeFeatures(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { ...DEFAULT_FEATURES };
  return { ...DEFAULT_FEATURES, ...stored };
}

function defaultStorage() {
  return typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
}

export async function readFeatures(storage) {
  const store = storage || defaultStorage();
  if (!store) return { ...DEFAULT_FEATURES };
  const stored = await Promise.resolve(store.get(FEATURES_KEY)).catch(() => null);
  return mergeFeatures(stored?.[FEATURES_KEY]);
}

export async function writeFeatures(patch, storage) {
  const store = storage || defaultStorage();
  const next = { ...(await readFeatures(store)), ...(patch || {}) };
  if (store) {
    await Promise.resolve(store.set({ [FEATURES_KEY]: next })).catch(() => {});
  }
  return next;
}
