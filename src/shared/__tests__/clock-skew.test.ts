// src/shared/__tests__/clock-skew.test.ts
// The classification primitive, and the DIRECTION TABLE that justifies it being
// a classifier rather than a predicate.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STATE_TIMESTAMP_FUTURE_SKEW_MS } from '../../config/state';
import { trustworthyAgeMs, trustworthyAgeSince } from '../clock-skew';
import { ageAttestsLiveness } from '../state/run-agent/session-identity';

const SKEW = STATE_TIMESTAMP_FUTURE_SKEW_MS;

test('an ordinary past age passes through unchanged', () => {
  assert.equal(trustworthyAgeMs(0), 0);
  assert.equal(trustworthyAgeMs(1), 1);
  assert.equal(trustworthyAgeMs(90 * 60 * 1000), 90 * 60 * 1000);
});

test('a future age inside the skew allowance clamps to zero', () => {
  assert.equal(trustworthyAgeMs(-1), 0, 'a millisecond of jitter is not a broken clock');
  assert.equal(trustworthyAgeMs(-(SKEW - 1)), 0);
  assert.equal(trustworthyAgeMs(-SKEW), 0, 'the allowance is inclusive');
});

test('a future age beyond the skew allowance is unusable', () => {
  assert.equal(trustworthyAgeMs(-(SKEW + 1)), null, 'one millisecond past the allowance');
  assert.equal(trustworthyAgeMs(-(24 * 60 * 60 * 1000)), null);
});

test('a non-finite age is unusable', () => {
  assert.equal(trustworthyAgeMs(Number.POSITIVE_INFINITY), null, 'the absent-stamp convention');
  assert.equal(trustworthyAgeMs(Number.NEGATIVE_INFINITY), null);
  assert.equal(trustworthyAgeMs(Number.NaN), null);
});

test('trustworthyAgeSince subtracts, and rejects an unusable stamp', () => {
  const now = 1_700_000_000_000;
  assert.equal(trustworthyAgeSince(now - 5_000, now), 5_000);
  assert.equal(trustworthyAgeSince(now + SKEW, now), 0, 'inside the allowance');
  assert.equal(trustworthyAgeSince(now + SKEW + 1, now), null, 'beyond it');
  assert.equal(trustworthyAgeSince(Number.NaN, now), null);
});

// Non-vacuity for the whole file: a `trustworthyAgeMs` that returned null for
// EVERYTHING would satisfy every "unusable" assertion above. The pass-through
// and clamp cases are what stop that, and this pins the pair together.
test('the classifier is not degenerate in either direction', () => {
  const usable = [0, 1, -1, -SKEW, 1_000, 10 * 60 * 1000].map(trustworthyAgeMs);
  assert.ok(usable.every((v) => v !== null), 'usable ages must not be rejected');
  const unusable = [-(SKEW + 1), Number.POSITIVE_INFINITY, Number.NaN].map(trustworthyAgeMs);
  assert.ok(unusable.every((v) => v === null), 'unusable ages must not be accepted');
});

// The rule has exactly one implementation. `ageAttestsLiveness` predates this
// module and its boundary is asserted independently in liveness-decay.test.ts;
// if the two ever disagree, one of them grew a second definition of "future".
test('ageAttestsLiveness agrees with the classifier at every boundary', () => {
  const max = 30 * 60 * 1000;
  for (const age of [-(SKEW + 1), -SKEW, -1, 0, max - 1, max, max + 1, Number.POSITIVE_INFINITY, Number.NaN]) {
    const viaClassifier = (() => {
      const a = trustworthyAgeMs(age);
      return a !== null && a <= max;
    })();
    assert.equal(ageAttestsLiveness(age, max), viaClassifier, `disagreement at age ${age}`);
  }
});

// ── The direction table ──────────────────────────────────────────────────────
// The reason this module classifies instead of deciding. Each row is a REAL
// shape from the sweep: the same unusable age has to produce opposite booleans
// depending on what freshness buys at the site, so no single shared predicate
// could have served them all. A blanket "future ⇒ stale" edit would have been
// correct at rows 1 and 4 and WRONG at rows 2 and 3.
const DIRECTIONS: readonly {
  site: string;
  buys: string;
  fold: (age: number | null, threshold: number) => boolean;
  wantOnFuture: boolean;
  why: string;
}[] = [
  {
    site: 'deploy-gate: lastSecurityCheckAt / lastShipperApprovalAt',
    buys: 'PERMISSION to publish to production',
    fold: (age, t) => age !== null && age < t,
    wantOnFuture: false,
    why: 'an untrustworthy clock must not authorize a deploy',
  },
  {
    site: 'session-start-lib: self-heal cooldown locks',
    buys: 'a BLOCK on re-running the heal',
    fold: (age, t) => age !== null && age < t,
    wantOnFuture: false,
    why: 'the block lifts, so the heal is reachable again',
  },
  {
    site: 'one-mcp-report shouldAttempt: lastAttemptAt',
    buys: 'a BLOCK on retrying the report',
    fold: (age, t) => age === null || age > t,
    wantOnFuture: true,
    why: 'the retry fires instead of being suppressed forever',
  },
  {
    site: 'locks.ts: owned-dir lock sentinel',
    buys: 'the HOLDER keeping a lock rivals must wait for',
    fold: (age, t) => age === null || age > t,
    wantOnFuture: true,
    why: 'the lock becomes reclaimable instead of immortal',
  },
];

test('each site folds an unusable age in its own safe direction', () => {
  const threshold = 10 * 60 * 1000;
  const future = trustworthyAgeMs(-(SKEW + 60_000));
  assert.equal(future, null, 'the shared input really is unusable');
  for (const row of DIRECTIONS) {
    assert.equal(row.fold(future, threshold), row.wantOnFuture, `${row.site}: ${row.why}`);
  }
  // ...and every row still behaves normally on a trustworthy age, so the table
  // is not just asserting that `null` is special.
  const recent = trustworthyAgeMs(1_000);
  const old = trustworthyAgeMs(threshold + 1_000);
  for (const row of DIRECTIONS) {
    const blocksOnRecent = row.fold(recent, threshold);
    const blocksOnOld = row.fold(old, threshold);
    assert.notEqual(blocksOnRecent, blocksOnOld, `${row.site}: the threshold must still discriminate`);
  }
});

test('the table covers both folds, so it cannot be trivially satisfied', () => {
  assert.ok(DIRECTIONS.some((r) => r.wantOnFuture), 'at least one site must ALLOW on an unusable clock');
  assert.ok(DIRECTIONS.some((r) => !r.wantOnFuture), 'at least one site must REFUSE on an unusable clock');
});
