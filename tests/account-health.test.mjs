import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOAD_BACKOFF_MS,
  MAX_COOLDOWN_MS,
  QUOTA_LEDGER_TTL_MS,
  QUOTA_RESET_GUARD_MS,
  REJECT_COOLDOWN_MS,
  blockedUntil,
  createAccountHealth,
  describeBlocked,
  describeQuota,
  isBlocked,
  ledgerQuota,
  markQuotaUnreliable,
  normalizeHealth,
  noteQuota,
  pruneHealthMap,
  quotaExhausted,
  quotaLedgerUsable,
  quotaUnlimited,
  recordBulkRejection,
  recordBulkSuccess,
} from '../account-health.js';

const NOW = 1_700_000_000_000;
const PRO = { total: 10, remaining: 4 };
const SPENT = { total: 10, remaining: 0 };
const PREMIUM = { total: 1, remaining: 1 };

test('garbage normalizes to an idle record and the premium sentinel is not a limit', () => {
  assert.deepEqual(normalizeHealth('nope'), createAccountHealth());
  assert.equal(isBlocked(createAccountHealth(), NOW), false);
  assert.equal(quotaUnlimited(PREMIUM), true);
  assert.equal(quotaExhausted(PREMIUM), false);
  assert.equal(quotaExhausted(SPENT), true);
  assert.equal(quotaExhausted({ total: 10, remaining: 1 }), false);
});

test('an unread counter is not evidence of an unlimited plan', () => {
  assert.equal(quotaUnlimited({ total: 0, remaining: 0 }), false, 'never read');
  assert.equal(quotaUnlimited(null), false);
  assert.equal(quotaUnlimited(undefined), false);
  assert.equal(quotaUnlimited({ total: 1, remaining: 1 }), true, 'the premium sentinel');
  assert.equal(quotaUnlimited({ total: 10, remaining: 4 }), false);
});

test('a rejected submit with a spent quota does not penalize the account', () => {
  const health = recordBulkRejection(createAccountHealth({ tier: 'pro' }), {
    now: NOW, quota: SPENT, runningWorkIds: ['w1'], random: () => 0,
  });
  assert.equal(health.reason, 'quota_exhausted');
  assert.equal(health.rejectStreak, 0);
  assert.equal(health.cooldownUntil, 0);
  assert.equal(isBlocked(health, NOW), false);
  assert.deepEqual(health.quota, { total: 10, remaining: 0, at: NOW });
});

test('a rejection under load backs off briefly without escalating the streak', () => {
  const first = recordBulkRejection(createAccountHealth(), { now: NOW, quota: PRO, runningWorkIds: ['a', 'b'], random: () => 0 });
  const second = recordBulkRejection(first, { now: NOW, quota: PRO, runningWorkIds: ['a'], random: () => 0 });
  assert.equal(second.reason, 'bulk_rejected_under_load');
  assert.equal(second.rejectStreak, 0);
  assert.equal(blockedUntil(second) - NOW, LOAD_BACKOFF_MS);
  assert.ok(LOAD_BACKOFF_MS < REJECT_COOLDOWN_MS);
});

test('an unexplained rejection cools down exponentially up to the cap', () => {
  let health = createAccountHealth();
  const waits = [];
  for (let index = 0; index < 8; index += 1) {
    const now = NOW + index * 10_000_000;
    health = recordBulkRejection(health, { now, quota: PRO, runningWorkIds: [], random: () => 0 });
    waits.push(health.cooldownUntil - now);
  }
  assert.deepEqual(waits.slice(0, 3), [REJECT_COOLDOWN_MS, 2 * REJECT_COOLDOWN_MS, 4 * REJECT_COOLDOWN_MS]);
  assert.equal(health.reason, 'bulk_rejected');
  assert.equal(health.bulk, 'degraded');
  assert.equal(waits[waits.length - 1], MAX_COOLDOWN_MS);
});

test('a success clears the cooldown and records the quota it consumed', () => {
  const rejected = recordBulkRejection(createAccountHealth(), { now: NOW, quota: SPENT, random: () => 0 });
  const recovered = recordBulkSuccess(rejected, { now: NOW + 1000, tier: 'pro', quota: PRO });
  assert.equal(recovered.bulk, 'ok');
  assert.equal(recovered.rejectStreak, 0);
  assert.equal(isBlocked(recovered, NOW + 1000), false);
  assert.equal(recovered.quota.remaining, 4);
  assert.equal(recovered.dispatchesSinceQuota, 1);
  assert.equal(recovered.lastDispatchAt, NOW + 1000);
});

test('an increase our own dispatch explains is not a reset, even when the server lags', () => {
  const base = { ...createAccountHealth({ tier: 'pro' }), quota: { total: 10, remaining: 5, at: NOW }, updatedAt: NOW };
  // Our batch consumed one credit: the counter must read 4, and reading 4 is no roll-over.
  const consumed = noteQuota(recordBulkSuccess(base, { now: NOW + 1000, quota: { total: 10, remaining: 4 } }), { total: 10, remaining: 4, now: NOW + 9000 });
  assert.equal(consumed.reset, false);
  // The server reported the pre-submit value again: still not a roll-over inside the guard window.
  const late = noteQuota(recordBulkSuccess(base, { now: NOW + 1000, quota: { total: 10, remaining: 5 } }), { total: 10, remaining: 5, now: NOW + 9000 });
  assert.equal(late.reset, false);
  assert.equal(late.health.quota.remaining, 5);
});

test('an unexplained increase after the guard window is reported as a reset', () => {
  const drained = {
    ...createAccountHealth({ tier: 'pro' }),
    quota: { total: 10, remaining: 0, at: NOW },
    dispatchesSinceQuota: 2,
    lastDispatchAt: NOW,
    updatedAt: NOW,
  };
  const rolled = noteQuota(drained, { total: 10, remaining: 7, now: NOW + QUOTA_RESET_GUARD_MS + 1 });
  assert.equal(rolled.reset, true);
  assert.equal(rolled.previous.remaining, 0);
  assert.equal(rolled.health.quota.remaining, 7);
  assert.equal(rolled.health.dispatchesSinceQuota, 0);

  // A drop is never a reset, and the explanation delta still applies after the window.
  const dropped = noteQuota(drained, { total: 10, remaining: 0, now: NOW + QUOTA_RESET_GUARD_MS + 1 });
  assert.equal(dropped.reset, false);
  const explained = noteQuota(
    { ...drained, quota: { total: 10, remaining: 5, at: NOW } },
    { total: 10, remaining: 5, now: NOW + QUOTA_RESET_GUARD_MS + 1 },
  );
  assert.equal(explained.reset, false);
});

test('the premium sentinel never reports a reset', () => {
  const noted = noteQuota(
    { ...createAccountHealth({ tier: 'premium' }), quota: { total: 1, remaining: 1, at: NOW }, lastDispatchAt: NOW - 20 * 60 * 1000 },
    { total: 1, remaining: 1, now: NOW },
  );
  assert.equal(noted.reset, false);
});

test('pruning, blocked summaries and quota summaries describe real state', () => {
  const map = {
    keep: { ...recordBulkRejection(createAccountHealth(), { now: NOW, quota: PRO, runningWorkIds: [], random: () => 0 }), updatedAt: NOW },
    gone: { ...createAccountHealth({ bulk: 'ok' }), updatedAt: NOW },
    stale: { ...createAccountHealth({ bulk: 'ok' }), updatedAt: NOW - 40 * 24 * 60 * 60 * 1000 },
  };
  const pruned = pruneHealthMap(map, { now: NOW, accountIds: ['keep', 'stale'] });
  assert.deepEqual(Object.keys(pruned), ['keep']);

  const summary = describeBlocked([{ accountId: 'aaaaaaaaaaaa', health: pruned.keep }], NOW);
  assert.equal(summary.nextRetryAt, blockedUntil(pruned.keep));
  assert.match(summary.text, /aaaaaaaa:bulk_rejected\(300s\)/);

  const quotas = describeQuota([
    { accountId: 'pro', tier: 'pro', quota: SPENT },
    { accountId: 'premium', tier: 'premium', quota: PREMIUM },
  ], NOW);
  assert.equal(quotas.exhausted.length, 1);
  assert.equal(quotas.text, 'pro:0/10, premium:unlimited');
});

test('the ledger subtracts our own dispatches from the last reading', () => {
  const base = { ...createAccountHealth({ tier: 'pro' }), quota: { total: 10, remaining: 6, at: NOW }, updatedAt: NOW };
  assert.equal(ledgerQuota(base).remaining, 6);
  const afterTwo = { ...base, dispatchesSinceQuota: 2 };
  assert.equal(ledgerQuota(afterTwo).remaining, 4);
  assert.equal(ledgerQuota({ ...base, dispatchesSinceQuota: 9 }).remaining, 0, 'never negative');
  // The premium sentinel never moves, so our own batches do not change what it reports.
  const premium = { ...createAccountHealth({ tier: 'premium' }), quota: { total: 1, remaining: 1, at: NOW }, dispatchesSinceQuota: 40 };
  assert.equal(ledgerQuota(premium).remaining, 1);
  assert.equal(ledgerQuota(createAccountHealth()), null, 'no reading yet means no ledger');
});

test('a stale or distrusted ledger forces a real reading', () => {
  const fresh = { ...createAccountHealth(), quota: { total: 10, remaining: 4, at: NOW } };
  assert.equal(quotaLedgerUsable(fresh, NOW + 1000), true);
  assert.equal(quotaLedgerUsable(fresh, NOW + QUOTA_LEDGER_TTL_MS + 1), false, 'stale reading');
  assert.equal(quotaLedgerUsable(createAccountHealth(), NOW), false, 'never read');
  const distrusted = markQuotaUnreliable(fresh, { now: NOW });
  assert.equal(distrusted.quotaUnreliable, true);
  assert.equal(distrusted.reason, 'quota_unreliable');
  assert.equal(quotaLedgerUsable(distrusted, NOW + 1000), false);
  assert.equal(ledgerQuota(distrusted).remaining, 4, 'the reading is still reported, just not trusted');
  // A later accepted submit proves the counter works again.
  assert.equal(recordBulkSuccess(distrusted, { now: NOW + 5000 }).quotaUnreliable, false);
});
