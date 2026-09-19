// Feature flags for the scheduler rework.
//
// Phase 0 tracing is read-only instrumentation. The scheduler phases ship behind flags so
// a bad phase can be rolled back without a rebuild; accountHealth / accountSnapshot are ON
// because they are the validated dispatch path (see PRODUCT notes and the phase 2 trace).

export const FEATURES_KEY = 'dreamfaceFeatures';

// Retired in phase 0 as unmeasurable or counter-productive: aimdSlots, weightedScore,
// dynamicSplit, avatarWarmup — they are gone from the code, not just switched off.
//
// Read once per offscreen document at startup (see the loader at the top of offscreen.js), so a
// flag change needs the extension reloaded to take effect.
//
// The remaining flags were decided by measurement: accountHealth / accountSnapshot are the
// validated dispatch path (phase 2 trace: 18 attempts for 18 units, 0 rejections, 57 -> 16.9 MiB),
// lptOrder shortens the render tail, and chunkedPlanning / ossUploadCache / workLedger are still
// unproven — chunking additionally multiplies the submit count on quota-metered accounts.
export const DEFAULT_FEATURES = Object.freeze({
  phase0Trace: true,
  accountHealth: true,
  accountSnapshot: true,
  // Validated by the 19.09 control run: longest audio first, cheapest connect per account,
  // quota-gated dispatch, and a plan computed before the first upload.
  lptOrder: true,
  quotaLedger: true,
  backlogTier: true,
  planPreview: true,
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
