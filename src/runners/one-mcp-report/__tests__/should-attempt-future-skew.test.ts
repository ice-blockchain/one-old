// src/runners/one-mcp-report/__tests__/should-attempt-future-skew.test.ts
// The retry policy is a BLOCK bought by recency, so a stamp ahead of `nowMs`
// used to suppress the report's next attempt permanently.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FAILED_RETRY_MS, QUEUED_RETRY_MS } from '../../../config/reporting';
import { STATE_TIMESTAMP_FUTURE_SKEW_MS } from '../../../config/state';
import { shouldAttempt } from '../shouldAttempt';

const NOW = 1_700_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

test('a recent attempt still suppresses the retry (the control)', () => {
  assert.equal(shouldAttempt({ status: 'failed', lastAttemptAt: iso(NOW - 1_000) }, NOW), false);
  assert.equal(shouldAttempt({ status: 'queued', queuedAt: iso(NOW - 1_000) }, NOW), false);
});

test('an attempt older than its retry window releases it (the control)', () => {
  assert.equal(shouldAttempt({ status: 'failed', lastAttemptAt: iso(NOW - FAILED_RETRY_MS - 1_000) }, NOW), true);
  assert.equal(shouldAttempt({ status: 'queued', queuedAt: iso(NOW - QUEUED_RETRY_MS - 1_000) }, NOW), true);
});

test('a future-stamped attempt does not suppress the retry forever', () => {
  const ahead = iso(NOW + 24 * 60 * 60 * 1000);
  assert.equal(shouldAttempt({ status: 'failed', lastAttemptAt: ahead }, NOW), true,
    'a day-ahead stamp made `nowMs - last` negative, so neither retry window could ever elapse');
  assert.equal(shouldAttempt({ status: 'queued', queuedAt: ahead }, NOW), true);
  assert.equal(shouldAttempt({ status: 'pending', lastAttemptAt: ahead }, NOW), true);
});

test('a stamp inside the skew allowance is still treated as a recent attempt', () => {
  const jitter = iso(NOW + STATE_TIMESTAMP_FUTURE_SKEW_MS - 1_000);
  assert.equal(shouldAttempt({ status: 'failed', lastAttemptAt: jitter }, NOW), false,
    'ordinary jitter must not turn into a retry storm');
});

// Non-vacuity: `shouldAttempt` returns true for a great many reasons (absent
// status, unparseable stamp, unknown status). These pin that the `true` above
// is the RETRY WINDOW deciding, by showing the same status object flips to
// false the moment its date becomes usable and recent.
test('the true/false split is decided by the date, not by the status shape', () => {
  const base = { status: 'failed' as const };
  assert.equal(shouldAttempt({ ...base, lastAttemptAt: iso(NOW + 24 * 60 * 60 * 1000) }, NOW), true);
  assert.equal(shouldAttempt({ ...base, lastAttemptAt: iso(NOW - 1_000) }, NOW), false);
  assert.equal(shouldAttempt({ ...base, lastAttemptAt: 'not-a-date' }, NOW), true, 'unparseable is its own pre-existing arm');
  assert.equal(shouldAttempt({ status: 'ok', lastAttemptAt: iso(NOW + 24 * 60 * 60 * 1000) }, NOW), false,
    'a succeeded report is never re-attempted, whatever its date says');
});
