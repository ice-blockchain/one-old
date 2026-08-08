import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { AUTH_OFFLINE_GRACE_MS } from '../../../config/auth';
import { STATE_TIMESTAMP_FUTURE_SKEW_MS } from '../../../config/state';
import { CURSOR_MODELS_TTL_MS } from '../../materialize/cursor-models';
import type { KeyValidation } from '../../../runners/auth/validate-key';
import { offlineGraceVerdict, type AuthValidationFailure } from '../offline-grace';
import { writeSimpleAuth } from '../simple-auth';

// Compile-time pin (checked by `npm run typecheck`, not at runtime): the two
// arms this module switches on are EXACTLY the two the validator can report. A
// third validate-key reason — or a rename of either — fails to typecheck here
// instead of silently falling into the graced branch or the refused one.
type ValidatorFailure = Extract<KeyValidation, { ok: false }>['reason'];
const FAILURE_UNION_MATCHES: [
  ValidatorFailure extends AuthValidationFailure ? true : false,
  AuthValidationFailure extends ValidatorFailure ? true : false,
] = [true, true];

const VALIDATED_AT = '2026-07-15T00:00:00Z';
const VALIDATED_AT_MS = Date.parse(VALIDATED_AT);

function withStore<T>(fn: (env: NodeJS.ProcessEnv, file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-offlinegrace-'));
  const file = path.join(dir, 'one.json');
  const env = { TRAFFIC_ONE_STATE_PATH: file } as NodeJS.ProcessEnv;
  try {
    return fn(env, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The record writeSimpleAuth produces, with the validation instant pinned so a
// test can place `now` relative to it. Written through the canonical envelope
// shape rather than by re-stamping, because `updatedAt` is the whole input.
function seedValidatedKey(file: string, apiKey: string, updatedAt: string = VALIDATED_AT): void {
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 3,
    auth: { version: 1, authenticated: true, apiKey, updatedAt },
    codeGraphProvider: null,
  }, null, 2)}\n`, 'utf8');
}

test('the grace window is the same seven days the repo already grants a cached remote-authoritative capture', () => {
  assert.equal(FAILURE_UNION_MATCHES.length, 2);
  assert.equal(
    AUTH_OFFLINE_GRACE_MS,
    CURSOR_MODELS_TTL_MS,
    'AUTH_OFFLINE_GRACE_MS is borrowed from CURSOR_MODELS_TTL_MS — change both or neither',
  );
});

test('a REJECTED key is never graced, however fresh and however matching the cached record', () => {
  withStore((env, file) => {
    seedValidatedKey(file, 'sk-revoked');
    // Same key, validated one second ago: every other condition for grace holds.
    const verdict = offlineGraceVerdict('invalid-api-key', 'sk-revoked', VALIDATED_AT_MS + 1_000, env);
    assert.equal(
      verdict.granted,
      false,
      'the validator ANSWERED no; being offline afterwards cannot make that answer less true',
    );
    assert.equal(verdict.granted === false && verdict.reason, 'authoritative-rejection');
  });
});

test('an UNREACHABLE validator is answered from this machine\'s record of the same key', () => {
  withStore((env, file) => {
    seedValidatedKey(file, 'sk-validated');
    const verdict = offlineGraceVerdict(
      'auth-endpoint-unreachable',
      'sk-validated',
      VALIDATED_AT_MS + AUTH_OFFLINE_GRACE_MS - 1,
      env,
    );
    assert.equal(verdict.granted, true);
    assert.equal(verdict.granted === true && verdict.ageMs, AUTH_OFFLINE_GRACE_MS - 1);
  });
});

// The same claim against the record the PRODUCT writes, rather than against the
// envelope this file hand-rolls: writeSimpleAuth is the only writer, and it is
// called only after validateApiKey returned ok, so its `updatedAt` is what the
// window is measured from.
test('the record the real writer produces is the record grace reads', () => {
  withStore((env) => {
    writeSimpleAuth('sk-validated', env);
    assert.equal(offlineGraceVerdict('auth-endpoint-unreachable', 'sk-validated', Date.now(), env).granted, true);
  });
});

test('grace ends exactly at the window and does not resume', () => {
  withStore((env, file) => {
    seedValidatedKey(file, 'sk-validated');
    for (const at of [AUTH_OFFLINE_GRACE_MS, AUTH_OFFLINE_GRACE_MS + 1, AUTH_OFFLINE_GRACE_MS * 10]) {
      const verdict = offlineGraceVerdict('auth-endpoint-unreachable', 'sk-validated', VALIDATED_AT_MS + at, env);
      assert.equal(verdict.granted, false, `age ${at} must be outside the window`);
      assert.equal(verdict.granted === false && verdict.reason, 'grace-expired');
    }
  });
});

test('a key this machine never validated gets no grace, and neither does a different one', () => {
  withStore((env, file) => {
    const now = VALIDATED_AT_MS + 1_000;
    const empty = offlineGraceVerdict('auth-endpoint-unreachable', 'sk-never-seen', now, env);
    assert.equal(empty.granted === false && empty.reason, 'no-cached-validation');

    seedValidatedKey(file, 'sk-validated');
    for (const submitted of ['sk-other', 'sk-validated-2', 'SK-VALIDATED', '', '   ']) {
      const verdict = offlineGraceVerdict('auth-endpoint-unreachable', submitted, now, env);
      assert.equal(verdict.granted, false, `"${submitted}" must not match the cached key`);
      assert.equal(verdict.granted === false && verdict.reason, 'different-key');
    }
    // …and the exact key still is, so the loop above is not passing vacuously.
    // A padded spelling counts as the same key: the intake path trims before it
    // validates (routes.ts's api-key branch, then validateApiKey), so treating
    // ' sk-validated ' as a different key would refuse grace to the very
    // submission the validator would have accepted.
    for (const submitted of ['sk-validated', ' sk-validated ']) {
      assert.equal(offlineGraceVerdict('auth-endpoint-unreachable', submitted, now, env).granted, true, submitted);
    }
  });
});

test('an unreadable one.json envelope is an unknown, not a cached validation', () => {
  withStore((env, file) => {
    // schemaVersion 4 is newer than supported: readSimpleAuth fails closed, so
    // the auth bytes on disk are present but are not evidence of anything.
    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: 4,
      auth: { version: 1, authenticated: true, apiKey: 'sk-validated', updatedAt: VALIDATED_AT },
    }, null, 2)}\n`, 'utf8');
    const verdict = offlineGraceVerdict('auth-endpoint-unreachable', 'sk-validated', VALIDATED_AT_MS + 1_000, env);
    assert.equal(verdict.granted === false && verdict.reason, 'no-cached-validation');
  });
});

test('a record stamped further ahead than any clock justifies grants NO window, not an unbounded one', () => {
  withStore((env, file) => {
    seedValidatedKey(file, 'sk-validated');
    // `now` before the stamp by more than the future-skew allowance: the age is
    // negative, which every `age < WINDOW` test reads as maximally fresh.
    const now = VALIDATED_AT_MS - STATE_TIMESTAMP_FUTURE_SKEW_MS - 1;
    const verdict = offlineGraceVerdict('auth-endpoint-unreachable', 'sk-validated', now, env);
    assert.equal(verdict.granted, false, 'a future-dated validation must not open the window');
    assert.equal(verdict.granted === false && verdict.reason, 'untrustworthy-stamp');
    // The same record, an ordinary tick of jitter ahead, IS ordinary freshness.
    const jitter = offlineGraceVerdict('auth-endpoint-unreachable', 'sk-validated', VALIDATED_AT_MS - 1_000, env);
    assert.equal(jitter.granted, true);
    assert.equal(jitter.granted === true && jitter.ageMs, 0, 'skew inside the allowance clamps to zero, never negative');
  });
});

test('an unparseable validation timestamp is an unusable age, not a fresh one', () => {
  withStore((env, file) => {
    seedValidatedKey(file, 'sk-validated', 'whenever');
    const verdict = offlineGraceVerdict('auth-endpoint-unreachable', 'sk-validated', Date.now(), env);
    assert.equal(verdict.granted === false && verdict.reason, 'untrustworthy-stamp');
  });
});

test('a granted verdict writes nothing — the window runs from the last REAL validation', () => {
  withStore((env, file) => {
    // The seeded validation instant is deliberately in the past rather than
    // "now": writeSimpleAuth stamps whole seconds, so a re-stamp inside the same
    // second reproduces the file byte-for-byte and a comparison against a
    // just-written baseline passes with the defect present. Measured — the first
    // form of this test survived exactly that mutation.
    seedValidatedKey(file, 'sk-validated');
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(
      offlineGraceVerdict('auth-endpoint-unreachable', 'sk-validated', VALIDATED_AT_MS + 60_000, env).granted,
      true,
    );
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      before,
      'a grace-accept that re-stamped updatedAt would let a resubmission hold the window open forever',
    );
  });
});
