// src/runners/auth/__tests__/revalidate.test.ts
// The background worker's arms, with the probe INJECTED. Nothing in this file
// opens a socket: the worker is spawned detached with stdio 'ignore' and has no
// channel back to a human, so every conclusion it reaches has to be written
// down or it never happened — and what it wrote down is exactly what these
// tests read.
//
// The refusals are injected as the real thing rather than mocked: a settings
// lock held by a live owner (which is what `clearAuthentication` returns false
// for), and a sidecar path that is not a writable file (which is what an
// unwritable machine dir looks like to the atomic writer). Both are DURABLE —
// retrying inside one run answers the same — so a boolean is the whole channel,
// and the point of this file is that no arm mints a success over one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readUnknownAuthGate401, recordUnknownAuthGate401 } from '../../../shared/auth/auth-gate-drift';
import { machineSidecarPath } from '../../../shared/auth/machine-sidecar';
import { readSimpleAuth } from '../../../shared/auth/simple-auth';
import { readRevalidationState, revalidationStatePath } from '../../../shared/auth/revalidation-state';
import { UPDATES_STORE_FILE, readUpdatesStore, recordUpdatesPage } from '../../../shared/auth/updates-store';
import { runAuthRevalidation } from '../revalidate';
import type { AuthProbe, AuthProbeOptions, probeAuthenticatedUpdates } from '../validate-key';

const VALIDATED_AT = '2026-07-15T00:00:00Z';
const VALIDATED_AT_MS = Date.parse(VALIDATED_AT);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface ProbeCall {
  readonly apiKey: string;
  readonly options: AuthProbeOptions;
}

interface Fixture {
  readonly env: NodeJS.ProcessEnv;
  readonly settings: string;
  readonly statePath: string;
  readonly storePath: string;
  readonly probeCalls: ProbeCall[];
  readonly dispose: () => void;
}

function fixture(over: { apiKey?: string; validatedAt?: string; authEnforced?: boolean; authenticated?: boolean } = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-revalidate-'));
  const settings = path.join(dir, 'one.json');
  const env = {
    ...process.env,
    TRAFFIC_ONE_STATE_PATH: settings,
    TRAFFIC_ONE_AUTH: over.authEnforced === false ? '0' : '1',
  };
  if (over.authenticated !== false) {
    // Hand-rolled rather than written through writeSimpleAuth, because the
    // validation instant is an input here: the grace window is measured from it,
    // and the confirm arm's re-stamp is only visible against an older one.
    fs.writeFileSync(settings, `${JSON.stringify({
      schemaVersion: 3,
      auth: {
        version: 1,
        authenticated: true,
        apiKey: over.apiKey ?? 'sk-live',
        updatedAt: over.validatedAt ?? VALIDATED_AT,
      },
      codeGraphProvider: null,
    }, null, 2)}\n`, 'utf8');
  }
  return {
    env,
    settings,
    statePath: revalidationStatePath(env),
    storePath: machineSidecarPath(UPDATES_STORE_FILE, env),
    probeCalls: [],
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** A probe double. `typeof probeAuthenticatedUpdates`, so its shape cannot drift. */
function probing(fx: Fixture, answer: AuthProbe): typeof probeAuthenticatedUpdates {
  return async (apiKey: string, options: AuthProbeOptions = {}) => {
    fx.probeCalls.push({ apiKey, options });
    return answer;
  };
}

const UNREACHABLE: AuthProbe = { validation: { ok: false, reason: 'auth-endpoint-unreachable' } };
const REJECTED: AuthProbe = { validation: { ok: false, reason: 'invalid-api-key' } };

function confirmed(items: Array<{ id: string; title: string }>, nextCursor?: string): AuthProbe {
  return {
    validation: { ok: true },
    result: { structuredContent: { items, ...(nextCursor ? { nextCursor } : {}), hasMore: Boolean(nextCursor) } },
  };
}

/**
 * Hold the canonical settings lock the way another writer would: a lock
 * directory whose single owner record names a LIVE pid and a fresh instant, so
 * the acquisition loop cannot reap it and every settings mutation inside the
 * window is refused rather than clobbering the file.
 */
function holdSettingsLock(settings: string): () => void {
  const lockPath = `${settings}.lock`;
  const token = 'abcdef0123';
  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(lockPath, `owner-${token}.json`),
    JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
    'utf8',
  );
  return () => fs.rmSync(lockPath, { recursive: true, force: true });
}

/** A durable refusal of one sidecar: see shared/auth/__tests__/revalidation-state.test.ts. */
function refuseWrites(file: string): void {
  fs.rmSync(file, { force: true, recursive: true });
  fs.mkdirSync(file, { recursive: true });
}

// ── the two arms that never reach the network ───────────────────────────────

test('the worker asks nobody anything when auth is off or this machine has no key', async () => {
  const off = fixture({ authEnforced: false });
  try {
    assert.deepEqual(
      await runAuthRevalidation(off.env, { probe: probing(off, confirmed([])) }),
      { ran: false, reason: 'auth-not-enforced' },
    );
    assert.equal(off.probeCalls.length, 0, 'a disabled gate must not spend a request from the per-user budget');
  } finally { off.dispose(); }

  const anon = fixture({ authenticated: false });
  try {
    assert.deepEqual(
      await runAuthRevalidation(anon.env, { probe: probing(anon, confirmed([])) }),
      { ran: false, reason: 'not-authenticated' },
    );
    assert.equal(anon.probeCalls.length, 0);
  } finally { anon.dispose(); }
});

// ── confirm ─────────────────────────────────────────────────────────────────

test('a confirmed key is re-stamped, and the feed that rode along is persisted', async () => {
  const fx = fixture();
  try {
    const run = await runAuthRevalidation(fx.env, {
      probe: probing(fx, confirmed([{ id: '1', title: 'Hello' }, { id: '2', title: 'Again' }], 'cur1')),
      nowMs: () => VALIDATED_AT_MS + HOUR_MS,
    });

    assert.deepEqual(run, { ran: true, outcome: 'confirmed', fetched: 2, feedWritten: true, recorded: true });
    // The re-stamp is what makes the offline window mean "seven days since the
    // endpoint last confirmed this key" rather than "seven days since the user
    // typed it in".
    assert.notEqual(readSimpleAuth(fx.env)?.updatedAt, VALIDATED_AT, 'a successful validation must advance auth.updatedAt');
    assert.equal(readSimpleAuth(fx.env)?.apiKey, 'sk-live', 'and must not change the key it re-stamped');
    assert.deepEqual(readUpdatesStore(fx.env).items.map((item) => item.id), ['1', '2']);
    assert.equal(readUpdatesStore(fx.env).cursor, 'cur1');
    assert.deepEqual(readRevalidationState(fx.env)?.outcome, 'confirmed');
    assert.equal(readUnknownAuthGate401(fx.env), null);
  } finally { fx.dispose(); }
});

test('a later understood probe clears a previously recorded unknown 401 code', async () => {
  const fx = fixture();
  try {
    assert.equal(recordUnknownAuthGate401('some_future_code', fx.env, VALIDATED_AT_MS), true);
    assert.equal(readUnknownAuthGate401(fx.env)?.code, 'some_future_code');
    await runAuthRevalidation(fx.env, {
      probe: probing(fx, confirmed([])),
      nowMs: () => VALIDATED_AT_MS + HOUR_MS,
    });
    assert.equal(readUnknownAuthGate401(fx.env), null, 'a confirmation this client understood retires the drift record');
  } finally { fx.dispose(); }
});

test('a re-stamp that was REFUSED is a different outcome from a confirmation', async () => {
  const fx = fixture();
  const release = holdSettingsLock(fx.settings);
  try {
    const run = await runAuthRevalidation(fx.env, {
      probe: probing(fx, confirmed([{ id: '1', title: 'Hello' }])),
      nowMs: () => VALIDATED_AT_MS + HOUR_MS,
    });

    // `confirmed-stamp-refused`, not `confirmed`: an un-advanced auth.updatedAt
    // means the grace window is still running from the PREVIOUS confirmation,
    // and a caller that could not tell the two apart would believe the window
    // had just restarted.
    assert.equal(run.ran === true && run.outcome, 'confirmed-stamp-refused');
    assert.equal(readSimpleAuth(fx.env)?.updatedAt, VALIDATED_AT, 'the record really was not advanced');
    // The key is still good, so the feed it returned is still this user's.
    assert.equal(run.ran === true && run.fetched, 1);
    assert.equal(run.ran === true && run.feedWritten, true);
  } finally {
    release();
    fx.dispose();
  }
});

test('a page the store REFUSED is reported as nothing fetched, not as N items persisted', async () => {
  const fx = fixture();
  try {
    refuseWrites(fx.storePath);
    const run = await runAuthRevalidation(fx.env, {
      probe: probing(fx, confirmed([{ id: '1', title: 'Hello' }, { id: '2', title: 'Again' }], 'cur1')),
      nowMs: () => VALIDATED_AT_MS + HOUR_MS,
    });

    // `fetched` is a claim about DISK. It used to be `page.items.length`
    // returned one line after `recordUpdatesPage`'s boolean was thrown away, so
    // a refused write reported two items persisted and the next probe resumed
    // from a cursor that was never stored.
    assert.equal(run.ran === true && run.fetched, 0, 'nothing reached the store, so nothing was fetched');
    assert.equal(run.ran === true && run.feedWritten, false, 'and the refusal itself has to be visible');
    // The credential verdict is untouched by a feed that would not persist.
    assert.equal(run.ran === true && run.outcome, 'confirmed');
    assert.deepEqual(readUpdatesStore(fx.env).items, []);
  } finally { fx.dispose(); }
});

test('a confirmed probe with an empty, un-advancing page owes the store no write at all', async () => {
  const fx = fixture();
  try {
    const run = await runAuthRevalidation(fx.env, {
      probe: probing(fx, confirmed([])),
      nowMs: () => VALIDATED_AT_MS + HOUR_MS,
    });
    assert.equal(run.ran === true && run.fetched, 0);
    // `null`, not `false`: nothing was refused, because a write that would only
    // re-stamp `fetchedAt` is not free on a path that runs on every machine.
    assert.equal(run.ran === true && run.feedWritten, null);
    assert.equal(fs.existsSync(fx.storePath), false, 'an empty page must not create the store file');
  } finally { fx.dispose(); }
});

test('the stored cursor is handed back to the next probe verbatim', async () => {
  const fx = fixture();
  try {
    await runAuthRevalidation(fx.env, {
      probe: probing(fx, confirmed([{ id: '1', title: 'Hello' }], 'cur1')),
      nowMs: () => VALIDATED_AT_MS + HOUR_MS,
    });
    await runAuthRevalidation(fx.env, {
      probe: probing(fx, confirmed([{ id: '2', title: 'Again' }])),
      nowMs: () => VALIDATED_AT_MS + 2 * HOUR_MS,
    });

    assert.equal(fx.probeCalls[0]?.options.cursor, undefined, 'a cold machine reads the feed from the top');
    assert.equal(
      fx.probeCalls[1]?.options.cursor, 'cur1',
      'the cursor is server-issued, user-bound and opaque: this client hands back the exact bytes it was handed',
    );
    assert.deepEqual(readUpdatesStore(fx.env).items.map((item) => item.id), ['1', '2'], 'pages ACCUMULATE');
  } finally { fx.dispose(); }
});

// ── revoke ──────────────────────────────────────────────────────────────────

test('a rejected key is cleared, and its feed goes with it', async () => {
  const fx = fixture();
  try {
    recordUpdatesPage({ items: [{ id: '1', title: 'Hello' }], nextCursor: 'cur1', hasMore: true }, VALIDATED_AT_MS, fx.env);
    const run = await runAuthRevalidation(fx.env, {
      probe: probing(fx, REJECTED),
      nowMs: () => VALIDATED_AT_MS + HOUR_MS,
    });

    assert.deepEqual(run, { ran: true, outcome: 'revoked', fetched: 0, feedWritten: true, recorded: true });
    assert.equal(readSimpleAuth(fx.env), null, 'the wizard re-opens because the record is gone');
    // The feed belongs to the identity behind the key that was just rejected —
    // both the prose and the user-bound cursor.
    assert.deepEqual(readUpdatesStore(fx.env), { items: [], shown: [] });
  } finally { fx.dispose(); }
});

test('a clear that was REFUSED is never recorded as a revocation', async () => {
  const fx = fixture();
  const release = holdSettingsLock(fx.settings);
  try {
    const run = await runAuthRevalidation(fx.env, {
      probe: probing(fx, REJECTED),
      nowMs: () => VALIDATED_AT_MS + HOUR_MS,
    });

    // This is the security-critical arm. `revoked` here would mean the product
    // believed a rejected key had been removed while it was still on disk and
    // still granting access — and `revoke-refused` is what re-opens the cadence
    // immediately and raises the session advisory instead of waiting a day.
    assert.equal(run.ran === true && run.outcome, 'revoke-refused');
    assert.notEqual(run.ran === true && run.outcome, 'revoked');
    assert.equal(readSimpleAuth(fx.env)?.apiKey, 'sk-live', 'the rejected key really is still stored');
    assert.equal(readRevalidationState(fx.env)?.outcome, 'revoke-refused', 'and the next session must read that');
  } finally {
    release();
    fx.dispose();
  }
});

test('a feed that could not be cleared after a revocation is REPORTED, not swallowed', async () => {
  const fx = fixture();
  try {
    // The auth clear succeeds; only the feed sidecar refuses. Leaving it on disk
    // hands one user's announcements to whoever signs in next and keeps
    // replaying a cursor bound to the old user — a cross-user exposure that was
    // silent, because this call's boolean was dropped on the floor.
    refuseWrites(fx.storePath);
    const run = await runAuthRevalidation(fx.env, {
      probe: probing(fx, REJECTED),
      nowMs: () => VALIDATED_AT_MS + HOUR_MS,
    });

    assert.equal(run.ran === true && run.feedWritten, false);
    // The credential verdict stays its own fact: the key WAS cleared, so telling
    // the user it is still granting access would be a different lie.
    assert.equal(run.ran === true && run.outcome, 'revoked');
    assert.equal(readSimpleAuth(fx.env), null);
  } finally { fx.dispose(); }
});

// ── the two indeterminate arms ──────────────────────────────────────────────

test('an unanswered probe inside the grace window writes nothing but the outcome', async () => {
  const fx = fixture({ validatedAt: new Date(VALIDATED_AT_MS).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  try {
    const before = fs.readFileSync(fx.settings, 'utf8');
    const run = await runAuthRevalidation(fx.env, {
      probe: probing(fx, UNREACHABLE),
      nowMs: () => VALIDATED_AT_MS + HOUR_MS,
    });

    assert.deepEqual(run, { ran: true, outcome: 'unreachable', fetched: 0, feedWritten: null, recorded: true });
    assert.equal(fs.readFileSync(fx.settings, 'utf8'), before, 're-stamping on a grace accept turns a bounded window into an unbounded one');
    assert.equal(fs.existsSync(fx.storePath), false, 'an unanswered probe carries no feed to store');
  } finally { fx.dispose(); }
});

test('an unanswered probe BEYOND the window keeps the key, and still records only the outcome', async () => {
  const fx = fixture();
  try {
    const before = fs.readFileSync(fx.settings, 'utf8');
    const run = await runAuthRevalidation(fx.env, {
      probe: probing(fx, UNREACHABLE),
      nowMs: () => VALIDATED_AT_MS + 8 * DAY_MS,
    });

    // Clearing beyond the window is not a stricter fail-closed, it is a brick:
    // the wizard's way back in runs the same validator that just failed to
    // answer, so a paying user offline would lose access AND the way to restore it.
    assert.deepEqual(run, { ran: true, outcome: 'unreachable', fetched: 0, feedWritten: null, recorded: true });
    assert.equal(fs.readFileSync(fx.settings, 'utf8'), before);
    assert.equal(readSimpleAuth(fx.env)?.apiKey, 'sk-live');
  } finally { fx.dispose(); }
});

// ── the outcome record is the only channel this process has ─────────────────

test('an outcome that could not be recorded does not read as a recorded one', async () => {
  const fx = fixture();
  try {
    refuseWrites(fx.statePath);
    const run = await runAuthRevalidation(fx.env, {
      probe: probing(fx, UNREACHABLE),
      nowMs: () => VALIDATED_AT_MS + HOUR_MS,
    });
    assert.equal(run.ran === true && run.recorded, false);
    assert.equal(run.ran === true && run.outcome, 'unreachable', 'the verdict is still reached; only the writing down failed');
  } finally { fx.dispose(); }
});
