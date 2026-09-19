// Pure policies for the bulk queue: when an interrupted run may resume on its own, how long to
// wait before retrying blocked accounts, and in which order units are dispatched.
//
// Phase 2 measurements: dispatch is sequential and the run ends with the last unit's render, so
// ordering the longest units first (LPT) shortens the tail that the operator waits through. The
// operator's mental model follows the source folders, so the plan keeps the source position of
// every unit and the monitor renders by it.

export const ACCOUNT_RETRY_DELAY_MS = 60 * 1000;
export const QUOTA_RETRY_DELAY_MS = 30 * 60 * 1000;
export const QUOTA_RETRY_MAX_DELAY_MS = 60 * 60 * 1000;
export const AUTO_RESUME_MAX_DELAY_MS = 60 * 60 * 1000;

// An account whose running works exceed this is considered backlogged. Calibration from the
// 19.09 runs: our own load reached 18 works on one account and drained during the dispatch,
// while a 69-work foreign backlog delayed 8 units by 392 s.
export const BACKLOG_TIER2_WORKS = 25;
// The last credits of a metered account are kept for later runs and for premium outages; they
// are only spent when nothing else can take the unit.
export const CREDIT_RESERVE = 2;
// Estimation constants for the plan preview (measured: 67 s of spans + 27 s of gaps for 18
// units, ~5.7 s per foreign work drained, ~60 s of status detection).
export const ESTIMATE = Object.freeze({
  perUnitMs: 4000,
  perGapMs: 1500,
  avatarRegistrationMs: 2000,
  detectionMs: 60000,
  drainPerWorkSec: 5.7,
});

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
// stays 0), so this case gets its own fallback: re-probe every 30 min, then hourly after the
// second attempt — repeated half-hour cycles against an outside spender are wasteful.
export function autoResumeDelayMs(options = {}) {
  const now = Number(options.now) || Date.now();
  const retryAt = Number(options.retryAt) || 0;
  if (retryAt > now) return Math.min(retryAt - now + 2000, AUTO_RESUME_MAX_DELAY_MS);
  if (!options.quotaOnly) return ACCOUNT_RETRY_DELAY_MS;
  return Number(options.quotaWaitAttempt) > 2 ? QUOTA_RETRY_MAX_DELAY_MS : QUOTA_RETRY_DELAY_MS;
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

// ---------------------------------------------------------------- dispatch ranking (pure)
//
// A candidate is whatever the selector measured for one account:
//   { accountId, load, limitSec, metered, remaining, quotaClass?, blocked?, unavailable? }
// The ranking is shared by the live selector and by the plan simulation, so a preview and a run
// can never disagree about who would be picked.

export function accountTier(load) {
  return Number(load) > BACKLOG_TIER2_WORKS ? 2 : 1;
}

// For a metered account this is the state *after* the hypothetical submit: spending the last
// credits costs the reserve, so those accounts rank below the ones with credits to spare.
export function creditClass(candidate) {
  if (!candidate || !candidate.metered) return 1;
  return Number(candidate.remaining) - 1 > CREDIT_RESERVE ? 1 : 0;
}

// Order: fresh accounts before backlogged ones (a foreign queue is what delays our tail), then
// unlimited quota before metered credits, then credits with headroom before the reserve, then the
// least loaded.
export function compareCandidates(a, b) {
  const tierA = a.tier || accountTier(a.load);
  const tierB = b.tier || accountTier(b.load);
  if (tierA !== tierB) return tierA - tierB;
  // Derived, not assumed: a caller that forgets to carry quotaClass must not silently rank a
  // metered account like an unlimited one (that is how a plan preview once disagreed with a run).
  const quotaA = Number.isFinite(a.quotaClass) ? Number(a.quotaClass) : (a.metered ? 0 : 1);
  const quotaB = Number.isFinite(b.quotaClass) ? Number(b.quotaClass) : (b.metered ? 0 : 1);
  if (quotaA !== quotaB) return quotaB - quotaA;
  const creditA = creditClass(a);
  const creditB = creditClass(b);
  if (creditA !== creditB) return creditB - creditA;
  const scoreA = Number(a.score || 0);
  const scoreB = Number(b.score || 0);
  if (scoreA !== scoreB) return scoreA - scoreB;
  return String(a.accountId).localeCompare(String(b.accountId));
}

export function rankCandidates(candidates) {
  return (Array.isArray(candidates) ? candidates : []).filter(Boolean).sort(compareCandidates);
}

function candidateCanTake(candidate, requiredSeconds) {
  if (!candidate || candidate.blocked || candidate.unavailable) return false;
  if (Number(candidate.limitSec || 0) < requiredSeconds) return false;
  if (candidate.metered && Number(candidate.remaining || 0) <= 0) return false;
  return true;
}

// Dry run of the very same ranking over the whole queue: who would take which unit, how many
// metered credits that would spend, what is left, and how long the tail is expected to be.
export function simulatePlan(units, candidates, options = {}) {
  const pool = (Array.isArray(candidates) ? candidates : []).map((candidate) => ({ ...candidate }));
  const assignments = [];
  const deferred = [];
  const byAccount = new Map();

  for (const unit of Array.isArray(units) ? units : []) {
    const requiredSeconds = unitRequiredSeconds(unit);
    const works = Math.max(1, (unit?.audios || []).length);
    const eligible = pool.filter((candidate) => candidateCanTake(candidate, requiredSeconds));
    if (eligible.length === 0) {
      deferred.push({
        unitId: unit?.id || '',
        requiredSeconds,
        reason: pool.some((candidate) => Number(candidate.limitSec || 0) >= requiredSeconds)
          ? 'no_account_with_quota'
          : 'no_account_supports_duration',
      });
      continue;
    }
    const chosen = rankCandidates(eligible)[0];
    chosen.load = Number(chosen.load || 0) + works;
    chosen.tier = accountTier(chosen.load);
    if (chosen.metered) chosen.remaining = Math.max(0, Number(chosen.remaining || 0) - 1);
    assignments.push({ unitId: unit?.id || '', accountId: chosen.accountId, works, requiredSeconds });
    const entry = byAccount.get(chosen.accountId) || {
      accountId: chosen.accountId,
      units: 0,
      works: 0,
      metered: Boolean(chosen.metered),
      creditsSpent: 0,
      loadStart: Number(candidates.find((c) => c.accountId === chosen.accountId)?.load || 0),
      loadEnd: 0,
      tierEnd: 1,
    };
    entry.units += 1;
    entry.works += works;
    if (chosen.metered) entry.creditsSpent += 1;
    entry.loadEnd = chosen.load;
    entry.tierEnd = chosen.tier;
    byAccount.set(chosen.accountId, entry);
  }

  const accounts = [...byAccount.values()];
  const creditsSpent = accounts.reduce((sum, entry) => sum + (entry.metered ? entry.creditsSpent : 0), 0);
  const creditsLeft = Object.fromEntries(pool
    .filter((candidate) => candidate.metered)
    .map((candidate) => [candidate.accountId, Number(candidate.remaining || 0)]));
  // Backlogged accounts are the whole tail story: their queue drains before our render starts.
  const backlogged = accounts
    .filter((entry) => entry.tierEnd === 2 || accountTier(entry.loadStart) === 2)
    .map((entry) => Math.max(entry.loadStart, entry.loadEnd));
  const worstBacklog = backlogged.length > 0 ? Math.max(...backlogged) : 0;
  const coldAvatarPairs = Number(options.coldAvatarPairs || 0);
  const observedLoads = pool.map((candidate) => Number(candidate.load || 0));
  return {
    assignments,
    deferred,
    accounts,
    creditsSpent,
    creditsLeft,
    estimates: {
      dispatchSec: Math.round((assignments.length * (ESTIMATE.perUnitMs + ESTIMATE.perGapMs)
        + coldAvatarPairs * ESTIMATE.avatarRegistrationMs) / 1000),
      tailSec: Math.round(ESTIMATE.detectionMs / 1000 + worstBacklog * ESTIMATE.drainPerWorkSec),
      backloggedAccounts: backlogged.length,
      // The worst queue seen in the pool, whether or not it was used: the operator should know a
      // backlog was side-stepped.
      maxObservedLoad: observedLoads.length > 0 ? Math.max(...observedLoads) : 0,
    },
  };
}

export function summarizePlan(plan) {
  if (!plan || plan.assignments.length === 0) return 'план: размещать нечего';
  const perAccount = plan.accounts
    .map((entry) => `${entry.accountId.slice(0, 6)}:${entry.units}`)
    .join(' ');
  const deferred = plan.deferred.length > 0 ? `, отложено ${plan.deferred.length}` : '';
  return `план: ${plan.assignments.length} юнитов → ${perAccount} · кредитов Pro ${plan.creditsSpent}`
    + ` · прогноз ${plan.estimates.dispatchSec} с + хвост ~${Math.round(plan.estimates.tailSec / 60)} мин${deferred}`;
}

// Every account shares one IP, so several rejections across *different* accounts inside a minute
// look like a per-IP rate limit rather than an account problem. Dispatch pauses instead of
// hammering: this is the difference between backing off and getting blocked.
export const IP_BACKOFF_WINDOW_MS = 60 * 1000;
export const IP_BACKOFF_MIN_ACCOUNTS = 2;
export const IP_BACKOFF_PAUSE_MS = 3 * 60 * 1000;

export function ipBackoffTriggered(rejections, options = {}) {
  const now = Number(options.now) || Date.now();
  const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : IP_BACKOFF_WINDOW_MS;
  const minAccounts = Number(options.minAccounts) > 0 ? Number(options.minAccounts) : IP_BACKOFF_MIN_ACCOUNTS;
  const pauseMs = Number(options.pauseMs) > 0 ? Number(options.pauseMs) : IP_BACKOFF_PAUSE_MS;
  const recent = (Array.isArray(rejections) ? rejections : [])
    .filter((entry) => entry && now - Number(entry.at || 0) <= windowMs);
  const accounts = new Set(recent.map((entry) => String(entry.accountId || '')).filter(Boolean));
  return { triggered: accounts.size >= minAccounts, pauseMs, accounts: [...accounts], recent: recent.length };
}
