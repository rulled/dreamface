// Feature flags for the scheduler rework.
//
// Phase 0 tracing is read-only instrumentation. The scheduler phases ship behind flags so
// a bad phase can be rolled back without a rebuild; accountHealth / accountSnapshot are ON
// because they are the validated dispatch path (see PRODUCT notes and the phase 2 trace).

export const FEATURES_KEY = 'dreamfaceFeatures';

// Phase 0 measurements retired aimdSlots / weightedScore / dynamicSplit / avatarWarmup.
// They were replaced by the quota model measured in phase 2: "Account Limit Reached" is the
// per-account submission quota (get_batch_times.remaining_times, pro = 10) reaching zero,
// not concurrency (running_works stays 0) and not a permanent account flag.
export const DEFAULT_FEATURES = Object.freeze({
  phase0Trace: true,
  accountHealth: true,
  accountSnapshot: true,
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
