import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  QUARANTINE_MS,
  blockedUntil,
  createAccountHealth,
  describeBlocked,
  isBlocked,
  normalizeHealth,
  normalizeHealthMap,
  pruneHealthMap,
  recordBulkRejection,
  recordBulkSuccess,
  syncHealthWithCapabilities,
} from '../account-health.js';

const NOW = 1_700_000_000_000;

test('unknown accounts are not blocked and normalize garbage to defaults', () => {
  assert.deepEqual(normalizeHealth(undefined), createAccountHealth());
  assert.deepEqual(normalizeHealth('nope'), createAccountHealth());
  assert.deepEqual(normalizeHealth({ bulk: 'banana', rejectStreak: -3 }), createAccountHealth());
  assert.equal(isBlocked(createAccountHealth(), NOW), false);
});

test('normalizeHealthMap drops empty keys and coerces values', () => {
  const map = normalizeHealthMap({ '': { bulk: 'ok' }, acc1: { bulk: 'degraded', rejectStreak: '2' } });
  assert.deepEqual(Object.keys(map), ['acc1']);
  assert.equal(map.acc1.rejectStreak, 2);
});

test('a successful bulk submit clears the streak, cooldown and quarantine', () => {
  const rejected = recordBulkRejection(createAccountHealth(), { now: NOW, random: () => 0 });
  const recovered = recordBulkSuccess(rejected, { now: NOW + 1000, tier: 'premium' });
  assert.equal(recovered.bulk, 'ok');
  assert.equal(recovered.rejectStreak, 0);
  assert.equal(recovered.cooldownUntil, 0);
  assert.equal(recovered.quarantinedUntil, 0);
  assert.equal(recovered.tier, 'premium');
  assert.equal(isBlocked(recovered, NOW + 1000), false);
});

test('the first rejection degrades the account and cools down for the base interval', () => {
  const health = recordBulkRejection(createAccountHealth(), { now: NOW, random: () => 0, runningWorkIds: [] });
  assert.equal(health.bulk, 'degraded');
  assert.equal(health.rejectStreak, 1);
  assert.equal(health.cooldownUntil, NOW + BASE_COOLDOWN_MS);
  assert.equal(health.quarantinedUntil, 0);
  assert.equal(health.reason, 'bulk_rejected_without_running_works');
  assert.equal(isBlocked(health, NOW), true);
  assert.equal(isBlocked(health, NOW + BASE_COOLDOWN_MS + 1), false);
});

test('a second rejection quarantines the account until its tier changes', () => {
  const first = recordBulkRejection(createAccountHealth(), { now: NOW, random: () => 0 });
  const second = recordBulkRejection(first, { now: NOW, random: () => 0 });
  assert.equal(second.bulk, 'quarantined');
  assert.equal(second.rejectStreak, 2);
  assert.equal(second.cooldownUntil, NOW + 2 * BASE_COOLDOWN_MS);
  assert.equal(second.quarantinedUntil, NOW + QUARANTINE_MS);
  assert.equal(blockedUntil(second), NOW + QUARANTINE_MS);
});

test('a rejection with running works is not treated as a capability block', () => {
  const health = recordBulkRejection(createAccountHealth(), { now: NOW, runningWorkIds: ['w1', 'w2'] });
  assert.equal(health.reason, 'bulk_rejected');
});

test('the cooldown backs off exponentially and stays within the cap', () => {
  let health = createAccountHealth();
  const waits = [];
  for (let index = 0; index < 8; index += 1) {
    const now = NOW + index * 10_000_000;
    health = recordBulkRejection(health, { now, random: () => 0 });
    waits.push(health.cooldownUntil - now);
  }
  assert.deepEqual(waits.slice(0, 4), [BASE_COOLDOWN_MS, 2 * BASE_COOLDOWN_MS, 4 * BASE_COOLDOWN_MS, 8 * BASE_COOLDOWN_MS]);
  assert.ok(Math.max(...waits) <= MAX_COOLDOWN_MS, 'cooldown must not exceed the cap');
  assert.equal(waits[waits.length - 1], MAX_COOLDOWN_MS);
});

test('jitter only extends the cooldown, never shortens it', () => {
  const low = recordBulkRejection(createAccountHealth(), { now: NOW, random: () => 0 });
  const high = recordBulkRejection(createAccountHealth(), { now: NOW, random: () => 1 });
  assert.ok(high.cooldownUntil > low.cooldownUntil);
  assert.ok(high.cooldownUntil - NOW < BASE_COOLDOWN_MS * 1.2);
});

test('a tier change resets capability-derived state, an unchanged tier does not', () => {
  const quarantined = recordBulkRejection(
    recordBulkRejection(createAccountHealth({ tier: 'pro' }), { now: NOW }),
    { now: NOW },
  );
  const sameTier = syncHealthWithCapabilities(quarantined, { tier: 'pro', now: NOW });
  assert.equal(sameTier.bulk, 'quarantined');

  const upgraded = syncHealthWithCapabilities(quarantined, { tier: 'premium', now: NOW });
  assert.equal(upgraded.bulk, 'unknown');
  assert.equal(upgraded.rejectStreak, 0);
  assert.equal(upgraded.quarantinedUntil, 0);
  assert.equal(upgraded.tier, 'premium');
  assert.equal(isBlocked(upgraded, NOW), false);
});

test('pruneHealthMap drops unknown accounts and stale entries', () => {
  const map = {
    keep: { ...createAccountHealth({ bulk: 'ok' }), updatedAt: NOW },
    gone: { ...createAccountHealth({ bulk: 'ok' }), updatedAt: NOW },
    stale: { ...createAccountHealth({ bulk: 'ok' }), updatedAt: NOW - 40 * 24 * 60 * 60 * 1000 },
  };
  const pruned = pruneHealthMap(map, { now: NOW, accountIds: ['keep', 'stale'] });
  assert.deepEqual(Object.keys(pruned), ['keep']);
});

test('describeBlocked summarises reasons and the earliest retry time', () => {
  const soon = recordBulkRejection(createAccountHealth(), { now: NOW, random: () => 0, runningWorkIds: [] });
  const later = recordBulkRejection(recordBulkRejection(createAccountHealth(), { now: NOW }), { now: NOW });
  const summary = describeBlocked([
    { accountId: 'aaaaaaaaaaaa', health: later },
    { accountId: 'bbbbbbbbbbbb', health: soon },
  ], NOW);
  assert.equal(summary.nextRetryAt, blockedUntil(soon));
  assert.match(summary.text, /aaaaaaaa:bulk_rejected/);
  assert.match(summary.text, /bbbbbbbb:bulk_rejected_without_running_works/);
  assert.equal(summary.entries.length, 2);
});
