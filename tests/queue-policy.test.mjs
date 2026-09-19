import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_RETRY_DELAY_MS,
  AUTO_RESUME_MAX_DELAY_MS,
  QUOTA_RETRY_DELAY_MS,
  autoResumeDelayMs,
  hasRemainingWork,
  orderUnitsForDispatch,
  shouldAutoResume,
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
