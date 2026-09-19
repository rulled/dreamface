// Per-account submission health for the bulk queue (phase 1).
//
// Phase 0 measured the server rejecting accounts with "Account Limit Reached" while
// running_works was 0 (38/38 rejections), so the blocker is a per-account capability or
// quota, not concurrency. A rejected account still looks "least loaded" to a greedy
// scorer, which is why it kept being picked first and cost a full setup (preset, avatar,
// uploads) per doomed attempt.
//
// Health is therefore tracked per capability (bulk / single) and consulted *before* any
// probing or upload work. Everything here is pure; persistence lives in the background.

export const ACCOUNT_HEALTH_KEY = 'dreamfaceAccountHealth';
export const BASE_COOLDOWN_MS = 15 * 60 * 1000;
export const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const QUARANTINE_STREAK = 2;
export const QUARANTINE_MS = 24 * 60 * 60 * 1000;
export const HEALTH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const COOLDOWN_JITTER_RATIO = 0.1;

export const BULK_STATES = Object.freeze(['unknown', 'ok', 'degraded', 'quarantined']);
export const SINGLE_STATES = Object.freeze(['unknown', 'ok', 'degraded']);

export function createAccountHealth(patch = {}) {
  return {
    bulk: 'unknown',
    single: 'unknown',
    rejectStreak: 0,
    cooldownUntil: 0,
    quarantinedUntil: 0,
    reason: '',
    sampleError: '',
    tier: '',
    updatedAt: 0,
    ...patch,
  };
}

export function normalizeHealth(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createAccountHealth();
  return {
    bulk: BULK_STATES.includes(raw.bulk) ? raw.bulk : 'unknown',
    single: SINGLE_STATES.includes(raw.single) ? raw.single : 'unknown',
    rejectStreak: Math.max(0, Number(raw.rejectStreak) || 0),
    cooldownUntil: Math.max(0, Number(raw.cooldownUntil) || 0),
    quarantinedUntil: Math.max(0, Number(raw.quarantinedUntil) || 0),
    reason: String(raw.reason || ''),
    sampleError: String(raw.sampleError || ''),
    tier: String(raw.tier || ''),
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

export function blockedUntil(health) {
  const normalized = normalizeHealth(health);
  return Math.max(normalized.cooldownUntil, normalized.quarantinedUntil);
}

export function isBlocked(health, now = Date.now()) {
  return blockedUntil(health) > now;
}

export function recordBulkSuccess(health, options = {}) {
  const now = Number(options.now) || Date.now();
  const current = normalizeHealth(health);
  return normalizeHealth({
    ...current,
    bulk: 'ok',
    rejectStreak: 0,
    cooldownUntil: 0,
    quarantinedUntil: 0,
    reason: '',
    sampleError: '',
    tier: String(options.tier || current.tier || ''),
    updatedAt: now,
  });
}

// A bulk rejection with zero running works proves the account is not concurrency-limited;
// the cooldown then doubles per consecutive rejection and the account is quarantined after
// QUARANTINE_STREAK of them, until its tier (capabilities) changes.
export function recordBulkRejection(health, options = {}) {
  const now = Number(options.now) || Date.now();
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const current = normalizeHealth(health);
  const streak = current.rejectStreak + 1;
  const backoff = Math.min(BASE_COOLDOWN_MS * 2 ** (streak - 1), MAX_COOLDOWN_MS);
  const quarantined = streak >= QUARANTINE_STREAK;
  const concurrencyFree = Array.isArray(options.runningWorkIds) && options.runningWorkIds.length === 0;
  return normalizeHealth({
    ...current,
    bulk: quarantined ? 'quarantined' : 'degraded',
    rejectStreak: streak,
    cooldownUntil: now + backoff + Math.round(backoff * COOLDOWN_JITTER_RATIO * random()),
    quarantinedUntil: quarantined ? now + QUARANTINE_MS : current.quarantinedUntil,
    reason: concurrencyFree ? 'bulk_rejected_without_running_works' : 'bulk_rejected',
    sampleError: String(options.sampleError || current.sampleError || '').slice(0, 200),
    tier: String(options.tier || current.tier || ''),
    updatedAt: now,
  });
}

// A changed tier means a different capability set (this is what un-quarantines an account
// after an upgrade), so capability-derived state is dropped.
export function syncHealthWithCapabilities(health, options = {}) {
  const now = Number(options.now) || Date.now();
  const current = normalizeHealth(health);
  const tier = String(options.tier || '');
  if (!tier || tier === current.tier) return { ...current, tier: tier || current.tier };
  return { ...createAccountHealth({ tier }), updatedAt: now };
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
  const entries = (Array.isArray(blocked) ? blocked : []).map((item) => ({
    accountId: String(item.accountId || ''),
    reason: normalizeHealth(item.health).reason || 'cooldown',
    tier: normalizeHealth(item.health).tier,
    until: blockedUntil(item.health),
    waitSec: Math.max(0, Math.round((blockedUntil(item.health) - now) / 1000)),
  }));
  const nextRetryAt = entries.reduce((min, entry) => (min === 0 ? entry.until : Math.min(min, entry.until)), 0);
  return {
    entries,
    nextRetryAt,
    text: entries.map((entry) => `${entry.accountId.slice(0, 8)}:${entry.reason}${entry.waitSec ? `(${entry.waitSec}s)` : ''}`).join(', '),
  };
}
