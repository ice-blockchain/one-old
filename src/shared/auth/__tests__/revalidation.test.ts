// src/shared/auth/__tests__/revalidation.test.ts
// The policy half of session-start revalidation: which of the four fail
// directions one probe result lands in, and whether a session owes a probe at
// all. Nothing here touches the network or spawns anything — that is the whole
// reason the policy was split out of the worker, and this file is the payoff.
//
// Two comments in shipped source name this file by path and claim it pins
// something. Both claims were false when they were written (there was no such
// file); the pins they promise are the first two things below, because each
// names a real invariant: config/auth.ts's borrowed cadence, and the structural
// restatement of the validator's answer that keeps shared/ free of a runtime
// import from runners/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AUTH_OFFLINE_GRACE_MS, AUTH_REVALIDATION_CADENCE_MS } from '../../../config/auth';
import { STATE_TIMESTAMP_FUTURE_SKEW_MS } from '../../../config/state';
import { OVERRIDE_MAX_TTL_MS } from '../../override/token';
import type { KeyValidation } from '../../../runners/auth/validate-key';
import {
  revalidationAction,
  sessionRevalidationPlan,
  type AuthValidationOutcome,
} from '../revalidation';
import type { RevalidationState } from '../revalidation-state';

// Compile-time pin (checked by `npm run typecheck`, not at runtime), the same
// mechanism offline-grace.test.ts uses for AuthValidationFailure. Both
// directions, because they fail differently: a THIRD validator reason breaks the
// first element (the worker would hand `revalidationAction` a value it has no
// arm for), and a renamed or removed reason here breaks the second (the policy
// would switch on a shape the validator never produces). `AuthValidationOutcome`
// exists only so shared/ does not import runners/ at runtime; this is what stops
// the copy drifting from the original.
const OUTCOME_UNION_MATCHES: [
  KeyValidation extends AuthValidationOutcome ? true : false,
  AuthValidationOutcome extends KeyValidation ? true : false,
] = [true, true];

const VALIDATED_AT = '2026-07-15T00:00:00Z';
const VALIDATED_AT_MS = Date.parse(VALIDATED_AT);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** An isolated machine, following the sibling tests in this directory. */
function machine(): { env: NodeJS.ProcessEnv; file: string; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-revalidation-'));
  const file = path.join(dir, 'one.json');
  return {
    env: { ...process.env, TRAFFIC_ONE_STATE_PATH: file },
    file,
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// The canonical envelope with the validation instant pinned, so a test can place
// `now` relative to it. Same shape offline-grace.test.ts seeds, because it is the
// same record: the grace window this module delegates to is measured from it.
function seedValidatedKey(file: string, apiKey: string, updatedAt: string = VALIDATED_AT): void {
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 3,
    auth: { version: 1, authenticated: true, apiKey, updatedAt },
    codeGraphProvider: null,
  }, null, 2)}\n`, 'utf8');
}

function state(over: Partial<RevalidationState> & { attemptedAt: string }): RevalidationState {
  return over;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── the borrowed constants ──────────────────────────────────────────────────

test('the cadence is the same 24 hours this repo already bounds an enforcement hole with', () => {
  assert.equal(OUTCOME_UNION_MATCHES.length, 2);
  assert.equal(
    AUTH_REVALIDATION_CADENCE_MS,
    OVERRIDE_MAX_TTL_MS,
    'AUTH_REVALIDATION_CADENCE_MS is borrowed from OVERRIDE_MAX_TTL_MS — a deliberate override of a gate'
    + ' and a stale answer from the gate\'s authority are the same hole seen from two sides. Change both or neither',
  );
  // Strictly below, not "at most": at equality a record that fell out of grace
  // is retried by a probe scheduled for the same instant, so the ordering the
  // product depends on would rest on which comparison ran first.
  assert.ok(
    AUTH_REVALIDATION_CADENCE_MS < AUTH_OFFLINE_GRACE_MS,
    `the cadence (${AUTH_REVALIDATION_CADENCE_MS} ms) must stay STRICTLY BELOW the offline grace window`
    + ` (${AUTH_OFFLINE_GRACE_MS} ms), or the record falls out of grace before the product ever retries`
    + ' the probe that could have refreshed it',
  );
});

// ── revalidationAction: the four fail directions ────────────────────────────

test('an ok probe is a CONFIRM, decided before any local record is consulted', () => {
  const m = machine();
  try {
    // No one.json at all. A confirm that needed the local record would answer
    // something else here, so this also pins that the ok arm short-circuits.
    assert.deepEqual(revalidationAction({ ok: true }, 'sk-live', VALIDATED_AT_MS, m.env), { kind: 'confirm' });
    assert.equal(fs.existsSync(m.file), false, 'deciding must not create the record it did not read');
  } finally { m.dispose(); }
});

test('an authoritative rejection is a REVOKE, however fresh and however matching the record', () => {
  const m = machine();
  try {
    seedValidatedKey(m.file, 'sk-live');
    // Validated one second ago, same key: every condition for grace holds, and
    // grace is still not on the table — the gate ANSWERED about this key.
    assert.deepEqual(
      revalidationAction({ ok: false, reason: 'invalid-api-key' }, 'sk-live', VALIDATED_AT_MS + 1_000, m.env),
      { kind: 'revoke' },
    );
  } finally { m.dispose(); }
});

test('an unreachable endpoint inside the window is GRACE, carrying the age the judge measured', () => {
  const m = machine();
  try {
    seedValidatedKey(m.file, 'sk-live');
    const action = revalidationAction(
      { ok: false, reason: 'auth-endpoint-unreachable' },
      'sk-live',
      VALIDATED_AT_MS + HOUR_MS,
      m.env,
    );
    assert.deepEqual(action, { kind: 'grace', ageMs: HOUR_MS });
  } finally { m.dispose(); }
});

test('an unreachable endpoint beyond the window is UNCONFIRMED, and clears nothing', () => {
  const m = machine();
  try {
    seedValidatedKey(m.file, 'sk-live');
    const before = fs.readFileSync(m.file, 'utf8');
    for (const at of [AUTH_OFFLINE_GRACE_MS, AUTH_OFFLINE_GRACE_MS + 1, AUTH_OFFLINE_GRACE_MS * 10]) {
      assert.deepEqual(
        revalidationAction({ ok: false, reason: 'auth-endpoint-unreachable' }, 'sk-live', VALIDATED_AT_MS + at, m.env),
        { kind: 'unconfirmed' },
        `age ${at} is outside the window`,
      );
    }
    // Beyond the window is fail-OPEN-but-say-so, never a stricter fail-closed:
    // clearing here is a brick, because the wizard's way back in runs the same
    // validator that just failed to answer.
    assert.equal(fs.readFileSync(m.file, 'utf8'), before, 'the stored key must survive an unanswered probe');
  } finally { m.dispose(); }
});

test('a probe whose subject changed underneath it lands on UNCONFIRMED and writes nothing', () => {
  const m = machine();
  try {
    // The record now holds a DIFFERENT key: the user re-authenticated while the
    // 10-second probe was in flight. `key` is what the probe carried, so the
    // grace judge's "same key?" arm answers the strictly better question — did
    // the subject of this probe survive it?
    seedValidatedKey(m.file, 'sk-new');
    const before = fs.readFileSync(m.file, 'utf8');
    assert.deepEqual(
      revalidationAction({ ok: false, reason: 'auth-endpoint-unreachable' }, 'sk-old', VALIDATED_AT_MS + 1_000, m.env),
      { kind: 'unconfirmed' },
      'a probe about a key nobody holds any more cannot grant that key a grace window',
    );
    assert.equal(
      fs.readFileSync(m.file, 'utf8'),
      before,
      'and it must not touch the record it is no longer about — the freshly stored key is not its business',
    );
  } finally { m.dispose(); }
});

// ── sessionRevalidationPlan: due, why, and what to say ──────────────────────

test('a machine that has never probed is due, with nothing to say', () => {
  const m = machine();
  try {
    assert.deepEqual(
      sessionRevalidationPlan('sk-live', null, VALIDATED_AT_MS, m.env),
      { due: true, dueReason: 'never-probed', advisory: null },
    );
  } finally { m.dispose(); }
});

test('an unresolved revocation is due IMMEDIATELY, ahead of the cadence, and says so', () => {
  const m = machine();
  try {
    seedValidatedKey(m.file, 'sk-live');
    // Probed ONE SECOND ago. Every cadence test in this file says "not due" for
    // a stamp this fresh, so this is the reading-order assertion: a rejected key
    // that is still granting access must not wait out a cadence period.
    const now = VALIDATED_AT_MS + HOUR_MS;
    const plan = sessionRevalidationPlan('sk-live', state({
      attemptedAt: isoAt(now - 1_000),
      outcome: 'revoke-refused',
      outcomeAt: isoAt(now - 1_000),
    }), now, m.env);

    assert.equal(plan.due, true, 'a key the server REJECTED that is still stored must be retried this session');
    assert.equal(plan.dueReason, 'unresolved-revocation');
    assert.ok(plan.advisory, 'the one state the product must not sit on silently');
    assert.match(plan.advisory ?? '', /REJECTED/, 'the advisory must name what happened, not just that something did');
    // Neither advisory names the key, not even a suffix: both strings land in
    // agent-visible context, which is transcribed into logs and pasted issues.
    assert.doesNotMatch(plan.advisory ?? '', /sk-live/, 'an advisory must never carry bytes of a bearer credential');
  } finally { m.dispose(); }
});

test('an unreachable history beyond grace is due ahead of the cadence, and says how long', () => {
  const m = machine();
  try {
    seedValidatedKey(m.file, 'sk-live');
    const now = VALIDATED_AT_MS + 9 * DAY_MS;
    const outcomeAt = isoAt(VALIDATED_AT_MS + 2 * DAY_MS);
    // Again a one-second-old attempt, so "due" here can only come from the
    // beyond-grace arm and not from the cadence below it.
    const plan = sessionRevalidationPlan('sk-live', state({
      attemptedAt: isoAt(now - 1_000),
      outcome: 'unreachable',
      outcomeAt,
    }), now, m.env);

    assert.equal(plan.due, true);
    assert.equal(plan.dueReason, 'unconfirmed-beyond-grace');
    assert.match(plan.advisory ?? '', /for 7 days/, 'the age is measured from the last CONCLUDED probe, not from now');
    assert.doesNotMatch(plan.advisory ?? '', /sk-live/);

    // The same shape INSIDE the window is silent and not due — without this the
    // assertion above would pass for a module that flagged every unreachable
    // history forever.
    const inside = sessionRevalidationPlan('sk-live', state({
      attemptedAt: isoAt(VALIDATED_AT_MS + HOUR_MS - 1_000),
      outcome: 'unreachable',
      outcomeAt: isoAt(VALIDATED_AT_MS + HOUR_MS - 1_000),
    }), VALIDATED_AT_MS + HOUR_MS, m.env);
    assert.deepEqual(inside, { due: false, dueReason: 'within-cadence', advisory: null });
  } finally { m.dispose(); }
});

test('a stamp dated further ahead than any clock justifies is DUE, not silent forever', () => {
  const m = machine();
  try {
    seedValidatedKey(m.file, 'sk-live');
    const now = VALIDATED_AT_MS + DAY_MS;
    // This is an ACTION BLOCKED BY FRESHNESS, so clock-skew.ts's prescription
    // folds an unusable age to ALLOW. The other fold — treating it as fresh —
    // is a one-line edit that suppresses revalidation on this machine forever,
    // which is an unbounded bypass of the entire lane rather than a bug in it.
    const future = sessionRevalidationPlan('sk-live', state({
      attemptedAt: isoAt(now + STATE_TIMESTAMP_FUTURE_SKEW_MS + 1_000),
    }), now, m.env);
    assert.equal(future.due, true, 'a future-dated stamp must not suppress the probe');
    assert.equal(future.dueReason, 'untrustworthy-stamp');
    assert.equal(future.advisory, null, 'a broken clock is not something to tell the user about mid-session');

    // An unparseable stamp is the same unusable age by the other route.
    assert.equal(sessionRevalidationPlan('sk-live', state({ attemptedAt: 'whenever' }), now, m.env).due, true);

    // …and ordinary jitter inside the allowance is still ordinary freshness, so
    // the two assertions above are not just "everything is due".
    const jitter = sessionRevalidationPlan('sk-live', state({ attemptedAt: isoAt(now + 1_000) }), now, m.env);
    assert.deepEqual(jitter, { due: false, dueReason: 'within-cadence', advisory: null });
  } finally { m.dispose(); }
});

test('the cadence opens exactly at AUTH_REVALIDATION_CADENCE_MS and stays open', () => {
  const m = machine();
  try {
    seedValidatedKey(m.file, 'sk-live');
    const now = VALIDATED_AT_MS + 30 * DAY_MS;
    const at = (ageMs: number) => sessionRevalidationPlan('sk-live', state({ attemptedAt: isoAt(now - ageMs) }), now, m.env);

    assert.deepEqual(at(AUTH_REVALIDATION_CADENCE_MS - 1_000), { due: false, dueReason: 'within-cadence', advisory: null });
    assert.deepEqual(at(AUTH_REVALIDATION_CADENCE_MS), { due: true, dueReason: 'cadence-elapsed', advisory: null });
    assert.deepEqual(at(AUTH_REVALIDATION_CADENCE_MS * 10), { due: true, dueReason: 'cadence-elapsed', advisory: null });
  } finally { m.dispose(); }
});

test('a concluded outcome that resolved itself does not keep re-opening the cadence', () => {
  const m = machine();
  try {
    seedValidatedKey(m.file, 'sk-live');
    const now = VALIDATED_AT_MS + DAY_MS;
    // `confirmed` and `revoked` are settled: neither is a state the session
    // surface has anything to say about, and neither shortens the cadence.
    for (const outcome of ['confirmed', 'confirmed-stamp-refused', 'revoked'] as const) {
      assert.deepEqual(
        sessionRevalidationPlan('sk-live', state({
          attemptedAt: isoAt(now - 1_000),
          outcome,
          outcomeAt: isoAt(now - 1_000),
        }), now, m.env),
        { due: false, dueReason: 'within-cadence', advisory: null },
        outcome,
      );
    }
  } finally { m.dispose(); }
});
