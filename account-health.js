// Per-account submission health for the bulk queue.
//
// Phase 2 traced the rejection cause to the ground: "Account Limit Reached" is the account's
// submission quota (`get_batch_times.remaining_times`) hitting zero. The two pro accounts
// rejected 19/19 attempts with running_works = 0 on 18.09 (quota spent), then accepted 11
// batches on 19.09 once the quota came back — same tier, same 180 s limit. So a rejection is
// *not* a permanent account trait and must not quarantine an account for a day.
//
// The model therefore separates three cases:
//   - quota exhausted  -> not the account's fault; skip it while remaining is 0 (self-healing)
//   - rejection with quota left, works already running -> load; short backoff, no escalation
//   - rejection with quota left and nothing running -> unexplained; cooldown doubles per streak
//
// Everything here is pure; persistence lives in the background.

export const ACCOUNT_HEALTH_KEY = 'dreamfaceAccountHealth';
export const REJECT_COOLDOWN_MS = 5 * 60 * 1000;
export const MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const LOAD_BACKOFF_MS = 60 * 1000;
export const COOLDOWN_JITTER_RATIO = 0.15;
export const HEALTH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// A quota increase is only evidence of a server-side roll-over when it is not explained by our
// own accepted batches. Inside this window after a dispatch the reading is never treated as a
// reset: the counter is read again moments after a submit, and the server may still report the
// pre-submit value.
export const QUOTA_RESET_GUARD_MS = 10 * 60 * 1000;

// Premium accounts answer get_batch_times with total = 1 / remaining = 1 while accepting any
// number of batches, i.e. the counter does not apply to them.
export const QUOTA_SENTINEL_TOTAL = 1;

export const BULK_STATES = Object.freeze(['unknown', 'ok', 'degraded']);
export const SINGLE_STATES = Object.freeze(['unknown', 'ok', 'degraded']);
export const REJECTION_REASONS = Object.freeze([
  'quota_exhausted',
  'bulk_rejected_under_load',
  'bulk_rejected',
]);

export function createAccountHealth(patch = {}) {
  return {
    bulk: 'unknown',
    single: 'unknown',
    rejectStreak: 0,
    cooldownUntil: 0,
    reason: '',
    sampleError: '',
    tier: '',
    quota: { total: 0, remaining: 0, at: 0 },
    dispatchesSinceQuota: 0,
    lastDispatchAt: 0,
    quotaUnreliable: false,
    updatedAt: 0,
    ...patch,
  };
}

export function normalizeQuota(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { total: 0, remaining: 0, at: 0 };
  return {
    total: Math.max(0, Number(raw.total) || 0),
    remaining: Math.max(0, Number(raw.remaining) || 0),
    at: Math.max(0, Number(raw.at) || 0),
  };
}

export function normalizeHealth(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createAccountHealth();
  return {
    bulk: BULK_STATES.includes(raw.bulk) ? raw.bulk : 'unknown',
    single: SINGLE_STATES.includes(raw.single) ? raw.single : 'unknown',
    rejectStreak: Math.max(0, Number(raw.rejectStreak) || 0),
    cooldownUntil: Math.max(0, Number(raw.cooldownUntil) || 0),
    reason: String(raw.reason || ''),
    sampleError: String(raw.sampleError || '').slice(0, 200),
    tier: String(raw.tier || ''),
    quota: normalizeQuota(raw.quota),
    dispatchesSinceQuota: Math.max(0, Number(raw.dispatchesSinceQuota) || 0),
    lastDispatchAt: Math.max(0, Number(raw.lastDispatchAt) || 0),
    quotaUnreliable: raw.quotaUnreliable === true,
    updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
  };
}

export function normalizeHealthMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [accountId, health] of Object.entries(raw)) {
    if (!accountId) continue;
    out[accountId] = normalizeHealth(health);
  }
  return out;
}

// The counter only limits accounts whose total is above the premium sentinel.
export function quotaUnlimited(quota) {
  const normalized = normalizeQuota(quota);
  return normalized.total <= QUOTA_SENTINEL_TOTAL;
}

export function quotaExhausted(quota) {
  const normalized = normalizeQuota(quota);
  return normalized.total > QUOTA_SENTINEL_TOTAL && normalized.remaining <= 0;
}

// The ledger: between two readings the only thing that moves a metered counter is our own
// accepted batches, so the usable value is the last reading minus what we submitted since. The
// reading itself is refreshed on dispatch acks and rejections, so in steady state the selector
// stops asking the site for quotas at all.
export const QUOTA_LEDGER_TTL_MS = 15 * 60 * 1000;

export function quotaLedgerUsable(health, now = Date.now()) {
  const normalized = normalizeHealth(health);
  if (!normalized.quota.at) return false;
  if (normalized.quotaUnreliable) return false;
  return now - normalized.quota.at <= QUOTA_LEDGER_TTL_MS;
}

export function ledgerQuota(health) {
  const normalized = normalizeHealth(health);
  if (!normalized.quota.total) return null;
  if (quotaUnlimited(normalized.quota)) return { ...normalized.quota };
  return {
    ...normalized.quota,
    remaining: Math.max(0, normalized.quota.remaining - normalized.dispatchesSinceQuota),
  };
}

// A rejection that the counter cannot explain: the account stops being trusted for this run and
// gets a real reading before the next decision.
export function markQuotaUnreliable(health, options = {}) {
  const now = Number(options.now) || Date.now();
  const current = normalizeHealth(health);
  return normalizeHealth({
    ...current,
    quotaUnreliable: true,
    reason: 'quota_unreliable',
    sampleError: String(options.sampleError || current.sampleError || '').slice(0, 200),
    updatedAt: now,
  });
}

export function blockedUntil(health) {
  return normalizeHealth(health).cooldownUntil;
}

export function isBlocked(health, now = Date.now()) {
  return blockedUntil(health) > now;
}

// Records the last observed quota and reports an increase that our own accepted batches do not
// explain — the only observable signal that the account's quota window rolled over.
export function noteQuota(health, options = {}) {
  const now = Number(options.now) || Date.now();
  const current = normalizeHealth(health);
  const previous = current.quota;
  const next = normalizeQuota({ total: options.total, remaining: options.remaining, at: now });
  if (next.total === 0 && next.remaining === 0) return { health: current, reset: false, previous };
  const metered = next.total > QUOTA_SENTINEL_TOTAL && previous.total > QUOTA_SENTINEL_TOTAL;
  const withinDispatchWindow = current.lastDispatchAt > 0
    && now - current.lastDispatchAt <= QUOTA_RESET_GUARD_MS;
  // Our own batches are missing from an older reading, so they are added back before comparing:
  // an account at 5 that we submitted one batch to is expected to read 4, not 5. The delta is a
  // filter, not a detector — an increase is still required, or under-consumption would look like
  // a roll-over.
  const expectedRemaining = Math.max(0, previous.remaining - current.dispatchesSinceQuota);
  const reset = metered
    && !withinDispatchWindow
    && next.remaining > previous.remaining
    && next.remaining > expectedRemaining;
  return {
    health: {
      ...current,
      quota: next,
      dispatchesSinceQuota: metered ? 0 : current.dispatchesSinceQuota,
      updatedAt: now,
    },
    reset,
    previous,
    delta: next.remaining - previous.remaining,
  };
}

export function recordBulkSuccess(health, options = {}) {
  const now = Number(options.now) || Date.now();
  const current = normalizeHealth(health);
  const noted = options.quota ? noteQuota(current, { ...options.quota, now }).health : current;
  return normalizeHealth({
    ...noted,
    bulk: 'ok',
    rejectStreak: 0,
    cooldownUntil: 0,
    reason: '',
    sampleError: '',
    tier: String(options.tier || current.tier || ''),
    // A successful submit proves the counter is usable again.
    quotaUnreliable: false,
    // Our own consumption has to be remembered: the next quota reading may predate this batch.
    dispatchesSinceQuota: (options.quota ? noted.dispatchesSinceQuota : current.dispatchesSinceQuota) + 1,
    lastDispatchAt: now,
    updatedAt: now,
  });
}

export function recordBulkRejection(health, options = {}) {
  const now = Number(options.now) || Date.now();
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const current = normalizeHealth(health);
  const noted = options.quota ? noteQuota(current, { ...options.quota, now }).health : current;
  const sampleError = String(options.sampleError || current.sampleError || '').slice(0, 200);
  const tier = String(options.tier || current.tier || '');

  // A rejected submission whose quota was already spent teaches nothing about the account.
  if (options.quota && quotaExhausted(noted.quota)) {
    return normalizeHealth({
      ...noted, reason: 'quota_exhausted', sampleError, tier, updatedAt: now,
    });
  }

  const worksRunning = Array.isArray(options.runningWorkIds) ? options.runningWorkIds.length : null;
  if (worksRunning !== null && worksRunning > 0) {
    return normalizeHealth({
      ...noted,
      reason: 'bulk_rejected_under_load',
      cooldownUntil: now + LOAD_BACKOFF_MS + Math.round(LOAD_BACKOFF_MS * COOLDOWN_JITTER_RATIO * random()),
      sampleError,
      tier,
      updatedAt: now,
    });
  }

  const streak = current.rejectStreak + 1;
  const backoff = Math.min(REJECT_COOLDOWN_MS * 2 ** (streak - 1), MAX_COOLDOWN_MS);
  return normalizeHealth({
    ...noted,
    bulk: 'degraded',
    rejectStreak: streak,
    cooldownUntil: now + backoff + Math.round(backoff * COOLDOWN_JITTER_RATIO * random()),
    reason: 'bulk_rejected',
    sampleError,
    tier,
    updatedAt: now,
  });
}

export function pruneHealthMap(map, options = {}) {
  const now = Number(options.now) || Date.now();
  const maxAgeMs = Number(options.maxAgeMs) > 0 ? Number(options.maxAgeMs) : HEALTH_MAX_AGE_MS;
  const accountIds = options.accountIds ? new Set([...options.accountIds].map(String)) : null;
  const out = {};
  for (const [accountId, health] of Object.entries(normalizeHealthMap(map))) {
    if (accountIds && !accountIds.has(String(accountId))) continue;
    if (health.updatedAt && now - health.updatedAt > maxAgeMs) continue;
    out[accountId] = health;
  }
  return out;
}

export function describeBlocked(blocked, now = Date.now()) {
  const entries = (Array.isArray(blocked) ? blocked : []).map((item) => {
    const health = normalizeHealth(item.health);
    return {
      accountId: String(item.accountId || ''),
      reason: health.reason || 'cooldown',
      tier: health.tier,
      until: blockedUntil(health),
      waitSec: Math.max(0, Math.round((blockedUntil(health) - now) / 1000)),
    };
  });
  const nextRetryAt = entries.reduce((min, entry) => (min === 0 ? entry.until : Math.min(min, entry.until)), 0);
  return {
    entries,
    nextRetryAt,
    text: entries
      .map((entry) => `${entry.accountId.slice(0, 8)}:${entry.reason}${entry.waitSec ? `(${entry.waitSec}s)` : ''}`)
      .join(', '),
  };
}

export function describeQuota(accounts, now = Date.now()) {
  const rows = (Array.isArray(accounts) ? accounts : []).map((item) => {
    const quota = normalizeQuota(item.quota);
    return {
      accountId: String(item.accountId || ''),
      tier: String(item.tier || ''),
      total: quota.total,
      remaining: quota.remaining,
      unlimited: quotaUnlimited(quota),
      exhausted: quotaExhausted(quota),
      staleMs: quota.at ? Math.max(0, now - quota.at) : 0,
    };
  });
  const exhausted = rows.filter((row) => row.exhausted);
  return {
    rows,
    exhausted,
    text: rows
      .map((row) => `${row.accountId.slice(0, 8)}:${row.unlimited ? 'unlimited' : `${row.remaining}/${row.total}`}`)
      .join(', '),
  };
}
