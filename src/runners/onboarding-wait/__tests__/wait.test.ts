import { test } from 'node:test';
import assert from 'node:assert/strict';

import { waitForOnboarding } from '../index';

// Deterministic seams: a fake clock that advances `step` ms per read, and a no-op
// sleep — so the polling loop is exercised without a real timer or state IO.
function fakeNow(step: number): () => number {
  let t = 0;
  return () => (t += step);
}

test('waitForOnboarding: returns "complete" immediately when onboarding is already done', () => {
  const r = waitForOnboarding('/proj', { isComplete: () => true, now: () => 0, sleep: () => {} });
  assert.equal(r, 'complete');
});

test('waitForOnboarding: returns "pending" once the deadline passes and it never completes', () => {
  const r = waitForOnboarding('/proj', {
    isComplete: () => false,
    timeoutMs: 100,
    intervalMs: 10,
    now: fakeNow(30),
    sleep: () => {},
  });
  assert.equal(r, 'pending');
});

test('waitForOnboarding: returns "complete" when setup finishes mid-wait (after a few polls)', () => {
  let polls = 0;
  const r = waitForOnboarding('/proj', {
    isComplete: () => (++polls >= 3),
    timeoutMs: 10_000,
    intervalMs: 10,
    now: fakeNow(5),
    sleep: () => {},
  });
  assert.equal(r, 'complete');
  assert.equal(polls, 3);
});
