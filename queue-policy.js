// Pure policies for the bulk queue: when an interrupted run may resume on its own, how long to
// wait before retrying blocked accounts, and in which order units are dispatched.
//
// Phase 2 measurements: dispatch is sequential and the run ends with the last unit's render, so
// ordering the longest units first (LPT) shortens the tail that the operator waits through. The
// operator's mental model follows the source folders, so the plan keeps the source position of
// every unit and the monitor renders by it.

export const ACCOUNT_RETRY_DELAY_MS = 60 * 1000;
export const QUOTA_RETRY_DELAY_MS = 30 * 60 * 1000;
export const AUTO_RESUME_MAX_DELAY_MS = 60 * 60 * 1000;

export function hasRemainingWork(state) {
  const total = Array.isArray(state?.queuePlan) ? state.queuePlan.length : 0;
  return Number(state?.nextTaskIndex || 0) < total;
}

// A timer must never resurrect a queue the operator stopped, and legacy (pre-bulk) queues cannot
// be resumed at all.
export function shouldAutoResume(state, options = {}) {
  if (options.stopRequested) return false;
  if (!state || typeof state !== 'object') return false;
  if (state.mode !== 'bulk') return false;
  if (state.interruptionReason === 'user_stopped') return false;
  return hasRemainingWork(state);
}

// Accounts blocked only by an exhausted quota carry no cooldown to wait for (their cooldownUntil
// stays 0), so this case gets its own fallback: the queue re-probes every quota periodically
// instead of waiting for a click.
export function autoResumeDelayMs(options = {}) {
  const now = Number(options.now) || Date.now();
  const retryAt = Number(options.retryAt) || 0;
  if (retryAt > now) return Math.min(retryAt - now + 2000, AUTO_RESUME_MAX_DELAY_MS);
  return options.quotaOnly ? QUOTA_RETRY_DELAY_MS : ACCOUNT_RETRY_DELAY_MS;
}

// R_u: the longest audio inside the unit, i.e. the account limit the unit must fit into.
export function unitRequiredSeconds(unit) {
  return (unit?.audios || []).reduce((max, audio) => Math.max(max, Number(audio?.durationMs || 0) / 1000), 0);
}

export function unitTotalSeconds(unit) {
  return (unit?.audios || []).reduce((sum, audio) => sum + Number(audio?.durationMs || 0) / 1000, 0);
}

// Longest-processing-time-first: the unit with the largest R_u goes first, then the one with more
// total audio, then the earliest source position. Deterministic — equal units keep the order the
// operator built — and every unit is stamped with its sourceIndex for the monitor.
export function orderUnitsForDispatch(units) {
  return (Array.isArray(units) ? units : [])
    .map((unit, sourceIndex) => ({ unit, sourceIndex }))
    .sort((a, b) => {
      const byRequired = unitRequiredSeconds(b.unit) - unitRequiredSeconds(a.unit);
      if (byRequired !== 0) return byRequired;
      const byTotal = unitTotalSeconds(b.unit) - unitTotalSeconds(a.unit);
      if (byTotal !== 0) return byTotal;
      return a.sourceIndex - b.sourceIndex;
    })
    .map(({ unit, sourceIndex }) => ({ ...unit, sourceIndex }));
}
