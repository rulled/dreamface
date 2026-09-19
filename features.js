// Feature flags for the scheduler rework.
//
// Every behavior-changing phase ships behind a flag that defaults to OFF, so the
// current (pre-rework) path stays the default until the phase is validated.
// Phase 0 tracing is read-only instrumentation, hence ON by default.

export const FEATURES_KEY = 'dreamfaceFeatures';

// Phase 0 measurements retired aimdSlots / weightedScore / dynamicSplit / avatarWarmup:
// "Account Limit Reached" arrives with zero running works, remaining_times never moves,
// and the encoder already emits ~100 kbps mono.
export const DEFAULT_FEATURES = Object.freeze({
  phase0Trace: true,
  accountHealth: false,
  accountSnapshot: false,
  ossUploadCache: false,
  workLedger: false,
  chunkedPlanning: false,
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

// Writes are serialized: read-modify-write from two contexts at once (popup + offscreen)
// would otherwise drop one of the updates.
let writeChain = Promise.resolve();

export function writeFeatures(patch, storage) {
  const store = storage || defaultStorage();
  const run = writeChain.then(async () => {
    const next = { ...(await readFeatures(store)), ...(patch || {}) };
    if (store) {
      await Promise.resolve(store.set({ [FEATURES_KEY]: next })).catch(() => {});
    }
    return next;
  });
  writeChain = run.catch(() => {});
  return run;
}
