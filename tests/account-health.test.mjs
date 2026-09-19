import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOAD_BACKOFF_MS,
  MAX_COOLDOWN_MS,
  REJECT_COOLDOWN_MS,
  blockedUntil,
  createAccountHealth,
  describeBlocked,
  describeQuota,
  isBlocked,
  normalizeHealth,
  noteQuota,
  pruneHealthMap,
  quotaExhausted,
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

test('a success clears the cooldown and a quota increase is reported as a reset', () => {
  const rejected = recordBulkRejection(createAccountHealth(), { now: NOW, quota: SPENT, random: () => 0 });
  const recovered = recordBulkSuccess(rejected, { now: NOW + 1000, tier: 'pro', quota: PRO });
  assert.equal(recovered.bulk, 'ok');
  assert.equal(recovered.rejectStreak, 0);
  assert.equal(isBlocked(recovered, NOW + 1000), false);
  assert.equal(recovered.quota.remaining, 4);

  const grown = noteQuota({ ...recovered, quota: { total: 10, remaining: 2, at: NOW } }, { total: 10, remaining: 6, now: NOW + 5000 });
  assert.equal(grown.reset, true);
  const drained = noteQuota({ ...recovered, quota: { total: 10, remaining: 6, at: NOW } }, { total: 10, remaining: 3, now: NOW + 5000 });
  assert.equal(drained.reset, false);
  const same = noteQuota({ ...recovered, quota: { total: 10, remaining: 0, at: NOW } }, { total: 10, remaining: 0, now: NOW + 5000 });
  assert.equal(same.reset, false);
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
