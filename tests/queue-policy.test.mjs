import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_RETRY_DELAY_MS,
  AUTO_RESUME_MAX_DELAY_MS,
  QUOTA_RETRY_DELAY_MS,
  QUOTA_RETRY_MAX_DELAY_MS,
  autoResumeDelayMs,
  hasRemainingWork,
  ipBackoffTriggered,
  orderUnitsForDispatch,
  pickCandidate,
  rankCandidates,
  shouldAutoResume,
  simulatePlan,
} from '../queue-policy.js';

const unit = (id, durations, extra = {}) => ({
  id,
  audios: durations.map((sec, index) => ({ fileName: `${id}-${index}.mp3`, durationMs: sec * 1000 })),
  ...extra,
});

const runningState = () => ({
  mode: 'bulk',
  phase: 'finished',
  queuePlan: [unit('a', [10]), unit('b', [10])],
  nextTaskIndex: 1,
  interruptionReason: 'user_stopped',
});

test('a stopped or legacy queue is never resumed by a timer', () => {
  assert.equal(shouldAutoResume(runningState(), {}), false, 'user stop must win');
  assert.equal(shouldAutoResume({ ...runningState(), interruptionReason: '' }, {}), true);
  assert.equal(shouldAutoResume({ ...runningState(), interruptionReason: '', mode: 'legacy' }, {}), false);
  assert.equal(shouldAutoResume({ ...runningState(), interruptionReason: '' }, { stopRequested: true }), false);
  assert.equal(shouldAutoResume({ ...runningState(), interruptionReason: '', nextTaskIndex: 2 }, {}), false);
  assert.equal(shouldAutoResume(null, {}), false);
});

test('hasRemainingWork compares the cursor with the plan', () => {
  assert.equal(hasRemainingWork({ queuePlan: [1, 2, 3], nextTaskIndex: 2 }), true);
  assert.equal(hasRemainingWork({ queuePlan: [1, 2, 3], nextTaskIndex: 3 }), false);
  assert.equal(hasRemainingWork({}), false);
});

test('a blocked account yields its cooldown, quota-only yields the quota fallback', () => {
  const now = 1_000_000;
  assert.equal(autoResumeDelayMs({ now, quotaOnly: false }), ACCOUNT_RETRY_DELAY_MS);
  assert.equal(autoResumeDelayMs({ now, quotaOnly: true }), QUOTA_RETRY_DELAY_MS);
  assert.equal(autoResumeDelayMs({ now, retryAt: now + 30_000, quotaOnly: true }), 32_000);
  assert.equal(autoResumeDelayMs({ now, retryAt: now - 5_000, quotaOnly: true }), QUOTA_RETRY_DELAY_MS);
  assert.equal(autoResumeDelayMs({ now, retryAt: now + 5 * 60 * 60 * 1000 }), AUTO_RESUME_MAX_DELAY_MS);
});

test('LPT puts the longest required audio first and stays deterministic', () => {
  const plan = [unit('short', [5, 5]), unit('long', [90]), unit('medium', [30, 30]), unit('longer', [90, 1])];
  const ordered = orderUnitsForDispatch(plan);
  // Equal R_u is broken by total audio: 91s before 90s before 60s before 10s.
  assert.deepEqual(ordered.map((u) => u.id), ['longer', 'long', 'medium', 'short']);
  assert.deepEqual(ordered.map((u) => u.sourceIndex), [3, 1, 2, 0]);
  // Ties fall back to total audio, then to the source position, so the order never flaps.
  const equal = orderUnitsForDispatch([unit('a', [10, 1]), unit('b', [10, 5]), unit('c', [10, 5])]);
  assert.deepEqual(equal.map((u) => u.id), ['b', 'c', 'a']);
  assert.deepEqual(orderUnitsForDispatch([]), []);
  assert.deepEqual(orderUnitsForDispatch(undefined), []);
});

test('ordering does not mutate the incoming plan', () => {
  const plan = [unit('a', [1]), unit('b', [60])];
  const ordered = orderUnitsForDispatch(plan);
  assert.deepEqual(plan.map((u) => u.id), ['a', 'b']);
  assert.equal(plan[0].sourceIndex, undefined);
  assert.equal(ordered[0].sourceIndex, 1);
});

const account = (accountId, extra = {}) => ({
  accountId,
  limitSec: 600,
  // tier is intentionally absent: the comparator derives it from the pool
  load: 0,
  metered: false,
  remaining: 1,
  quotaClass: 1,
  score: 0,
  ...extra,
});

test('an account carrying a foreign backlog loses to a fresh one, even when it is unlimited', () => {
  const loaded = account('premium-loaded', { load: 69, tier: 2 });
  const freshPro = account('pro-fresh', { load: 0, tier: 1, metered: true, remaining: 10, quotaClass: 0 });
  assert.deepEqual(rankCandidates([loaded, freshPro]).map((c) => c.accountId), ['pro-fresh', 'premium-loaded']);
});

test('within a tier, free quota wins and metered credits are spent last', () => {
  const proRich = account('pro-rich', { metered: true, remaining: 10, quotaClass: 0, load: 0 });
  const proReserve = account('pro-reserve', { metered: true, remaining: 2, quotaClass: 0, load: 0 });
  const premium = account('premium', { load: 5 });
  assert.deepEqual(
    rankCandidates([proRich, premium, proReserve]).map((c) => c.accountId),
    ['premium', 'pro-rich', 'pro-reserve'],
  );
  // The last credits are still usable when nothing else can take the unit.
  assert.deepEqual(rankCandidates([proReserve]).map((c) => c.accountId), ['pro-reserve']);
});

test('a candidate without an explicit quotaClass is still ranked as metered', () => {
  const bare = { accountId: 'pro-bare', limitSec: 180, load: 0, metered: true, remaining: 9, score: 0 };
  const premium = { accountId: 'premium', limitSec: 600, load: 0, metered: false, score: 0 };
  assert.deepEqual(rankCandidates([bare, premium]).map((c) => c.accountId), ['premium', 'pro-bare']);
  assert.deepEqual(simulatePlan([unit('u', [5])], [bare, premium]).assignments.map((a) => a.accountId), ['premium']);
});

test('an account that cannot fit the audio, or has no quota left, is not a candidate', () => {
  const shortOnly = account('premium-short', { limitSec: 180 });
  const long = unit('long', [500]);
  const plan = simulatePlan([long], [shortOnly, account('premium-long', { load: 1 })]);
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0].accountId, 'premium-long');
  assert.equal(plan.deferred.length, 0);
  const tooLong = unit('too-long', [900]);
  const impossible = simulatePlan([tooLong], [shortOnly, account('premium-long')]);
  assert.equal(impossible.assignments.length, 0);
  assert.equal(impossible.deferred[0].reason, 'no_account_supports_duration');
});

test('the plan spends one credit per unit and reports what is left', () => {
  const pool = [
    account('premium', { load: 0 }),
    account('pro-a', { metered: true, remaining: 2, quotaClass: 0 }),
  ];
  const units = [unit('u1', [10]), unit('u2', [10]), unit('u3', [10])];
  const plan = simulatePlan(units, pool);
  assert.equal(plan.assignments.length, 3);
  assert.equal(plan.creditsSpent, 0, 'unlimited quota absorbs the whole batch');
  assert.equal(plan.accounts.length, 1);
  assert.equal(plan.accounts[0].accountId, 'premium');
  assert.equal(plan.accounts[0].units, 3);
  // Once the unlimited account is gone, metered credits are the only option and are counted.
  const proOnly = simulatePlan(units, [{
    accountId: 'pro-a', limitSec: 180, tier: 1, load: 0, metered: true, remaining: 2, quotaClass: 0, score: 0,
  }]);
  assert.equal(proOnly.creditsSpent, 2);
  assert.equal(proOnly.creditsLeft['pro-a'], 0);
  assert.equal(proOnly.deferred.length, 1);
  assert.equal(proOnly.deferred[0].reason, 'no_account_with_quota');
});

test('the plan escalates to the metered account when the unlimited one is backlogged', () => {
  const pool = [
    account('premium', { load: 40, tier: 2 }),
    account('pro-a', { metered: true, remaining: 5, quotaClass: 0, load: 2 }),
  ];
  const plan = simulatePlan([unit('u1', [10])], pool);
  assert.equal(plan.assignments[0].accountId, 'pro-a');
  assert.equal(plan.creditsSpent, 1);
  assert.equal(plan.estimates.backloggedAccounts, 0, 'nothing was assigned to the backlogged account');
  // detection plus this unit's own turnaround at the fallback rate (5.7 s/work)
  assert.equal(plan.estimates.tailSec, 66);
  assert.equal(plan.estimates.maxObservedLoad, 40, 'the side-stepped backlog stays visible');
});

test('an account that turns work around much slower than its peers drops to tier 2', () => {
  const pool = [
    account('fast-a', { msPerWork: 15000, drainSamples: 3, load: 0 }),
    account('fast-b', { msPerWork: 20000, drainSamples: 3, load: 0 }),
    account('slow', { msPerWork: 180000, drainSamples: 3, load: 0 }),
  ];
  assert.deepEqual(rankCandidates(pool).map((c) => c.accountId), ['fast-a', 'fast-b', 'slow']);
  // A single sample is not enough to condemn an account, and the rule needs a baseline.
  const unproven = [account('unknown', { msPerWork: 180000, drainSamples: 1, load: 0 }), account('known', { msPerWork: 15000, drainSamples: 3, load: 0 })];
  assert.deepEqual(rankCandidates(unproven).map((c) => c.accountId), ['known', 'unknown']);
  assert.equal(rankCandidates([account('lonely', { msPerWork: 180000, drainSamples: 3, load: 0 })]).length, 1);
});

test('the pick is the first fitting candidate in the ranked order, never a slower account', () => {
  // The 15:47 run: the slow account had the lowest load (score 0) and got promoted by a comparison
  // that had lost the pool context. The ranked order must decide.
  const pool = [
    account('fast-busy', { msPerWork: 30000, drainSamples: 3, load: 4, score: 4 }),
    account('slow-idle', { msPerWork: 300000, drainSamples: 3, load: 0, score: 0 }),
  ];
  const ranked = rankCandidates(pool);
  assert.equal(ranked[0].accountId, 'fast-busy');
  assert.equal(pickCandidate(ranked, { requiredSeconds: 10, ranked: true }).accountId, 'fast-busy');
  assert.equal(pickCandidate(pool, { requiredSeconds: 10 }).accountId, 'fast-busy');
  // If only the slow account can take the unit, it is used — the tier is a preference, not a ban.
  assert.equal(pickCandidate(pool, { requiredSeconds: 300 }).accountId, 'fast-busy');
  assert.equal(pickCandidate([pool[1]], { requiredSeconds: 10 }).accountId, 'slow-idle');
  assert.equal(pickCandidate(pool, { requiredSeconds: 900 }), null);
  // An account with no quota left is never picked, however fast it is.
  const drained = [account('fast-empty', { msPerWork: 20000, drainSamples: 3, metered: true, remaining: 0, quotaClass: 0, load: 0 })];
  assert.equal(pickCandidate(drained, { requiredSeconds: 10 }), null);
});

test('an unmeasured metered account is never used, an unmeasured premium one still is', () => {
  // Metering comes from the plan, so a failed counter read must not block a premium account and
  // must block a Pro account: nobody can tell how many of its credits a dispatch would spend.
  const unknownPro = account('pro-unknown', { metered: true, remaining: 0, quotaClass: 0, load: 0 });
  const unknownPremium = account('premium-unknown', { metered: false, remaining: 0, quotaClass: 1, load: 0 });
  assert.equal(pickCandidate([unknownPro], { requiredSeconds: 10 }), null);
  assert.equal(pickCandidate([unknownPremium], { requiredSeconds: 10 }).accountId, 'premium-unknown');
  assert.deepEqual(rankCandidates([unknownPro, unknownPremium]).map((c) => c.accountId), ['premium-unknown', 'pro-unknown']);
});

test('the tail forecast follows the observed turnaround of the assigned account', () => {
  const pool = [account('slow', { msPerWork: 150000, drainSamples: 3, load: 0 })];
  const plan = simulatePlan([unit('u1', [10]), unit('u2', [10])], pool);
  assert.equal(plan.assignments.length, 2);
  assert.equal(plan.estimates.tailSec, 60 + 2 * 150, 'two works at the account rate plus detection');
  // With no measurements the fallback rate applies, so the forecast is never silently optimistic.
  const unknown = simulatePlan([unit('u1', [10])], [account('fresh', { load: 0 })]);
  assert.equal(unknown.estimates.tailSec, Math.round(60 + 5.7));
});

test('the shared-IP pause needs rejections on different accounts inside the window', () => {
  const now = 1_000_000;
  assert.equal(ipBackoffTriggered([{ at: now - 1000, accountId: 'a' }], { now }).triggered, false);
  assert.equal(ipBackoffTriggered([{ at: now - 1000, accountId: 'a' }, { at: now - 2000, accountId: 'a' }], { now }).triggered, false);
  const two = ipBackoffTriggered([{ at: now - 1000, accountId: 'a' }, { at: now - 2000, accountId: 'b' }], { now });
  assert.equal(two.triggered, true);
  assert.equal(two.pauseMs, 180000);
  // Old rejections do not count.
  assert.equal(ipBackoffTriggered([{ at: now - 120000, accountId: 'a' }, { at: now - 119000, accountId: 'b' }], { now }).triggered, false);
});

test('a quota-only wait escalates from half an hour to hourly', () => {
  const now = 1_000_000;
  assert.equal(autoResumeDelayMs({ now, quotaOnly: true, quotaWaitAttempt: 1 }), QUOTA_RETRY_DELAY_MS);
  assert.equal(autoResumeDelayMs({ now, quotaOnly: true, quotaWaitAttempt: 2 }), QUOTA_RETRY_DELAY_MS);
  assert.equal(autoResumeDelayMs({ now, quotaOnly: true, quotaWaitAttempt: 3 }), QUOTA_RETRY_MAX_DELAY_MS);
  assert.equal(autoResumeDelayMs({ now, quotaOnly: false, quotaWaitAttempt: 3 }), ACCOUNT_RETRY_DELAY_MS);
});
