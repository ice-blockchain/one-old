// src/shared/auth/__tests__/start-revalidation.test.ts
// The SessionStart side: decide, CHARGE THE CADENCE, then fire the worker
// detached — and report every exit by name.
//
// Two properties here are not stylistic and each has a measured incident behind
// it. The ORDER (stamp, then spawn) is what stops an unwritable state directory
// turning a once-a-day background call into one per session per project against
// a 60/min per-user server budget. The DETACHMENT is what keeps a 10 000 ms
// probe timeout — 220x the whole 150 ms p95 SessionStart dispatch budget — off
// the critical path; the hooks-fast lane measured 927.91 ms → 238.33 ms at the
// OS process boundary when it removed the last blocking spawn from this path,
// and `detached: true` + `stdio: 'ignore'` + `unref()` is what banks that.
//
// The spawn is always INJECTED. Nothing in this file starts a real process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeSimpleAuth } from '../simple-auth';
import { readRevalidationState, revalidationStatePath, type RevalidationState } from '../revalidation-state';
import { startAuthRevalidation } from '../start-revalidation';

const NOW_MS = Date.parse('2026-08-08T10:00:00Z');
const NOW_ISO = '2026-08-08T10:00:00Z';

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
  /** The cadence record as it stood AT THE MOMENT OF THE SPAWN. */
  readonly stateAtSpawn: RevalidationState | null;
}

interface Fixture {
  readonly env: NodeJS.ProcessEnv;
  readonly worker: string;
  readonly statePath: string;
  readonly calls: SpawnCall[];
  unrefs: number;
  readonly spawnDetached: never;
  readonly dispose: () => void;
}

function fixture(over: { authenticated?: boolean; authEnforced?: boolean } = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-start-revalidation-'));
  const env = {
    ...process.env,
    TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json'),
    TRAFFIC_ONE_AUTH: over.authEnforced === false ? '0' : '1',
  };
  if (over.authenticated !== false) writeSimpleAuth('sk-live', env);
  const worker = path.join(dir, 'revalidate.js');
  fs.writeFileSync(worker, '// fixture worker — never executed by this file\n', 'utf8');

  const calls: SpawnCall[] = [];
  const fx: Fixture = {
    env,
    worker,
    statePath: revalidationStatePath(env),
    calls,
    unrefs: 0,
    spawnDetached: ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options, stateAtSpawn: readRevalidationState(env) });
      return { unref: () => { fx.unrefs += 1; } };
    }) as never,
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
  return fx;
}

/** A durable refusal of the cadence record only: see revalidation-state.test.ts. */
function refuseStamp(statePath: string): void {
  fs.rmSync(statePath, { force: true });
  fs.mkdirSync(statePath, { recursive: true });
}

// ── the three silent skips ──────────────────────────────────────────────────

test('nothing is started when auth is not enforced, or when there is no key to revalidate', () => {
  const off = fixture({ authEnforced: false });
  try {
    assert.deepEqual(startAuthRevalidation(off.env, { spawnDetached: off.spawnDetached, workerPath: off.worker, nowMs: NOW_MS }), {
      start: { kind: 'skipped', reason: 'auth-not-enforced' },
      advisory: null,
    });
    assert.equal(off.calls.length, 0);
  } finally { off.dispose(); }

  const anon = fixture({ authenticated: false });
  try {
    // The pure-local gate is already sending this session to the wizard; there
    // is no key to ask the authority about.
    assert.deepEqual(startAuthRevalidation(anon.env, { spawnDetached: anon.spawnDetached, workerPath: anon.worker, nowMs: NOW_MS }), {
      start: { kind: 'skipped', reason: 'not-authenticated' },
      advisory: null,
    });
    assert.equal(anon.calls.length, 0);
    assert.equal(fs.existsSync(anon.statePath), false, 'a machine with no key must not accrue a cadence history');
  } finally { anon.dispose(); }
});

test('a machine inside its cadence spawns nothing and re-stamps nothing', () => {
  const fx = fixture();
  try {
    const first = startAuthRevalidation(fx.env, { spawnDetached: fx.spawnDetached, workerPath: fx.worker, nowMs: NOW_MS });
    assert.deepEqual(first.start, { kind: 'started', reason: 'never-probed' });
    const stamped = fs.readFileSync(fx.statePath, 'utf8');

    const second = startAuthRevalidation(fx.env, {
      spawnDetached: fx.spawnDetached,
      workerPath: fx.worker,
      nowMs: NOW_MS + 60 * 60 * 1000,
    });
    assert.deepEqual(second, { start: { kind: 'skipped', reason: 'within-cadence' }, advisory: null });
    assert.equal(fx.calls.length, 1, 'the second session must not spawn');
    assert.equal(fs.readFileSync(fx.statePath, 'utf8'), stamped, 'and must not push its own cadence slot forward');
  } finally { fx.dispose(); }
});

// ── the order: charge the cadence, THEN spawn ───────────────────────────────

test('the cadence slot is already charged when the worker is spawned', () => {
  const fx = fixture();
  try {
    const result = startAuthRevalidation(fx.env, {
      spawnDetached: fx.spawnDetached,
      workerPath: fx.worker,
      nowMs: NOW_MS,
    });
    assert.deepEqual(result.start, { kind: 'started', reason: 'never-probed' });
    assert.equal(fx.calls.length, 1);
    // Read INSIDE the spawn, not after it. The inverse order — spawn, then
    // stamp — passes every after-the-fact assertion while being the bug: a probe
    // that cannot be recorded is owed again on the very next session.
    assert.deepEqual(
      fx.calls[0]?.stateAtSpawn,
      { attemptedAt: NOW_ISO },
      'the probe must be charged to the cadence BEFORE it is started',
    );
  } finally { fx.dispose(); }
});

test('a cadence stamp that was REFUSED stops the spawn outright', () => {
  const fx = fixture();
  try {
    refuseStamp(fx.statePath);
    const result = startAuthRevalidation(fx.env, {
      spawnDetached: fx.spawnDetached,
      workerPath: fx.worker,
      nowMs: NOW_MS,
    });
    assert.deepEqual(result.start, { kind: 'unavailable', reason: 'stamp-refused' });
    assert.equal(
      fx.calls.length, 0,
      'an unwritable state dir would otherwise spawn a probe per session, per project, against a 60/min per-user budget',
    );
  } finally { fx.dispose(); }
});

// ── detachment ──────────────────────────────────────────────────────────────

test('the worker is fired DETACHED, silent, and unreferenced', () => {
  const fx = fixture();
  try {
    startAuthRevalidation(fx.env, { spawnDetached: fx.spawnDetached, workerPath: fx.worker, nowMs: NOW_MS });
    const call = fx.calls[0];
    assert.ok(call, 'the worker must actually be started — detaching may not become skipping');
    assert.equal(call.command, process.execPath);
    assert.deepEqual(call.args, [fx.worker]);
    // The three options that make it fire-and-forget. Without `detached` the
    // child stays in this process group and the host can take it down with the
    // hook; without `stdio: 'ignore'` the parent holds pipes open and a chatty
    // child can keep it alive; without `unref()` the parent's event loop waits.
    assert.equal(call.options.detached, true, 'the child must leave this process group');
    assert.equal(call.options.stdio, 'ignore', 'inherited pipes would re-couple parent and child');
    assert.equal(fx.unrefs, 1, 'an un-unref\'d child holds the hook process open for the whole 10-second probe');
    assert.equal(
      call.options.timeout, undefined,
      'a parent-side timeout on a child nobody waits for is a claim the parent cannot keep',
    );
    // The plugin root is a stable cwd: the worker touches machine state only,
    // and must not look like it belongs to whichever project started the session.
    assert.equal(call.options.cwd, path.dirname(fx.worker));
  } finally { fx.dispose(); }
});

// ── every exit is a NAMED outcome ───────────────────────────────────────────

test('a damaged install is reported as worker-missing, and does not spend a cadence slot', () => {
  const fx = fixture();
  try {
    const result = startAuthRevalidation(fx.env, {
      spawnDetached: fx.spawnDetached,
      workerPath: path.join(path.dirname(fx.worker), 'absent.js'),
      nowMs: NOW_MS,
    });
    assert.deepEqual(result.start, { kind: 'unavailable', reason: 'worker-missing' });
    assert.equal(fx.calls.length, 0);
    // A missing runner is not a probe. Charging one would make the machine wait
    // out a full cadence before it next tried to revalidate a key it never asked
    // about — and this outcome used to be indistinguishable from an opt-out at
    // every call site, which is the lesson one-mcp-sync.ts paid for.
    assert.equal(readRevalidationState(fx.env), null, 'a probe that never started must not consume the cadence');
  } finally { fx.dispose(); }
});

test('a refused spawn is reported by name, and DOES keep the slot it charged', () => {
  const fx = fixture();
  try {
    const throwing = (() => { throw new Error('EAGAIN'); }) as never;
    const result = startAuthRevalidation(fx.env, { spawnDetached: throwing, workerPath: fx.worker, nowMs: NOW_MS });
    assert.deepEqual(result.start, { kind: 'unavailable', reason: 'spawn-refused' });
    // Deliberate, and the direction the order argument chooses: the charge is
    // made before the spawn, so a fork that cannot happen waits for the next
    // cadence period rather than being retried on every session start.
    assert.deepEqual(readRevalidationState(fx.env), { attemptedAt: NOW_ISO });
  } finally { fx.dispose(); }
});

test('`started` carries WHY it started, and the advisory describes the last CONCLUDED probe', () => {
  const fx = fixture();
  try {
    // A rejection the previous run could not apply. The session must both probe
    // again immediately and say something — "we probed because the cadence
    // elapsed" and "we probed because a revocation could not be applied" are the
    // same event with very different meanings in a diagnostic.
    fs.writeFileSync(fx.statePath, `${JSON.stringify({
      version: 1,
      attemptedAt: NOW_ISO,
      outcome: 'revoke-refused',
      outcomeAt: NOW_ISO,
    })}\n`, 'utf8');

    const result = startAuthRevalidation(fx.env, {
      spawnDetached: fx.spawnDetached,
      workerPath: fx.worker,
      nowMs: NOW_MS + 1_000,
    });
    assert.deepEqual(result.start, { kind: 'started', reason: 'unresolved-revocation' });
    assert.match(result.advisory ?? '', /REJECTED/);
    assert.doesNotMatch(result.advisory ?? '', /sk-live/, 'the advisory must never carry bytes of the key');
    assert.equal(fx.calls.length, 1, 'an unresolved revocation is due immediately, not after a cadence period');
  } finally { fx.dispose(); }
});

test('the advisory survives every arm that reached the plan, including the unavailable ones', () => {
  const fx = fixture();
  try {
    fs.writeFileSync(fx.statePath, `${JSON.stringify({
      version: 1,
      attemptedAt: NOW_ISO,
      outcome: 'revoke-refused',
      outcomeAt: NOW_ISO,
    })}\n`, 'utf8');
    // A damaged install is exactly when the user most needs to be told the key
    // was rejected and could not be removed; the advisory is independent of
    // whether this session managed to start a probe.
    const result = startAuthRevalidation(fx.env, {
      spawnDetached: fx.spawnDetached,
      workerPath: path.join(path.dirname(fx.worker), 'absent.js'),
      nowMs: NOW_MS + 1_000,
    });
    assert.deepEqual(result.start, { kind: 'unavailable', reason: 'worker-missing' });
    assert.match(result.advisory ?? '', /REJECTED/);
  } finally { fx.dispose(); }
});
