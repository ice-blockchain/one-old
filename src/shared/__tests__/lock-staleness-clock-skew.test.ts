// One assertion per hand-rolled staleness site, in the shape of
// process-liveness-eperm.test.ts: a cross-cutting pin for a predicate that is
// deliberately copied rather than shared.
//
// The defect these pin is a SUBTRACTION. Every one of these sites spells its
// freshness test `now - stamp`, and a stamp written AHEAD of now makes that
// difference NEGATIVE — not merely fresh but MAXIMALLY fresh, forever. A
// staleness window (`age > STALE`) therefore never opens and the lock is never
// reclaimable; a freshness window (`age <= TTL`) never closes and whatever it
// gates is blocked for good. Measured on the two owner-stamped directory locks
// before the fix: a future-stamped owner with a PROVABLY dead pid burned the
// full 1000ms acquisition timeout and threw, where the past-stamped control was
// reclaimed in 0.49ms. After the fix: 0.65ms.
//
// Each test below goes red if — and only if — its own site is reverted to the
// raw subtraction. The negative rows at the end are the other half of the
// contract: the pid check still governs, so a LIVE owner keeps its lock no
// matter what its stamp says, and this is not a general weakening.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  EXHAUSTED_MODEL_TTL_MS,
  exhaustedModelsForRole,
  recordExhaustedModel,
} from '../../modules/agent-model/exhausted-models';
import { acquireQaRunLock } from '../../runners/qa-evidence/lock';
import { qaDir } from '../../runners/qa-evidence/run-context';
import { removeCodexOneMcpServerRegistration } from '../codex-mcp';
import { acquireCacheLock } from '../one-mcp/cache-lock';
import { updateOneSettings, oneSettingsPath } from '../one-settings';
import { currentHostModelTarget } from '../current-model-tiers';
import { ensureRunModelPolicy, runModelPolicyPath } from '../run-model-policy';
import { observeCodexChildModel } from '../state/codex-model-observation';
import { withProjectStateLock } from '../state/project-state-lock';
import { withProjectPrefsLock } from '../state/local-prefs/prefs-store';
import { ensureOnboardingServer } from '../onboarding-server/ensure';
import { serverLockPath } from '../onboarding-server/registry';
import { resolveTrafficOneEnv } from '../state/traffic-one-paths';

// Beyond STATE_TIMESTAMP_FUTURE_SKEW_MS (5 min), which is the point: inside that
// allowance a negative age is ordinary jitter and clamps to zero, so a stamp
// only becomes UNUSABLE past it.
const FUTURE = () => Date.now() + 10 * 60 * 1000;
const PAST = (ms = 60_000) => Date.now() - ms;

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-skew-${prefix}-`)));
}

/**
 * A pid that has EXITED and been reaped, so `kill(pid, 0)` raises ESRCH.
 *
 * Every "the owner is provably dead" premise below rests on this, so it is
 * ASSERTED rather than assumed: a hard-coded high pid (the idiom elsewhere in
 * this repo) is only probably free, and if it happened to be live these tests
 * would pass for the wrong reason — the reclaim would be refused by the pid
 * check and the staleness fold would never be reached.
 */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid as number;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    throw new Error(`fixture guard: pid ${pid} is not ESRCH-dead (${(error as NodeJS.ErrnoException).code})`);
  }
  throw new Error(`fixture guard: pid ${pid} is still ALIVE; the dead-owner premise is void`);
}

// The owner-stamped directory-lock protocol shared by cache-lock, one-settings,
// prefs-store, codex-mcp and project-state-lock: `<file>.lock/owner-<token>.json`.
function seedOwnerDirLock(lockPath: string, pid: number, createdAt: number, token = 'deadbeef'): void {
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, `owner-${token}.json`), JSON.stringify({ pid, token, createdAt }));
}

function seedEmptyDirLock(lockPath: string, mtimeMs: number): void {
  fs.mkdirSync(lockPath, { recursive: true });
  const when = new Date(mtimeMs);
  fs.utimesSync(lockPath, when, when);
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─────────────────────────────── exhausted-models.ts (3 sites) ───────────────

test('exhausted-models: a future-stamped holder line cannot make a dead holder’s store lock permanent', () => {
  const cwd = tmp('exhausted-holder');
  const runId = 'run-holder';
  const storeFile = path.join(cwd, '.traffic-one', 'runs', runId, 'exhausted-models.json');
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(`${storeFile}.lock`, `${deadPid()} ${FUTURE()} sometoken\n`, 'utf8');

    const models = recordExhaustedModel(cwd, runId, 'senior-backend', 'gpt-5.6-terra-medium');
    assert.deepEqual(models, ['gpt-5.6-terra-medium'], 'the recorder must reclaim and write, not return the busy fallback');
    assert.equal(fs.existsSync(storeFile), true, 'the ledger must actually reach disk');
  } finally {
    cleanup(cwd);
  }
});

test('exhausted-models: a future mtime on an unparseable store lock cannot make it permanent', () => {
  const cwd = tmp('exhausted-mtime');
  const runId = 'run-mtime';
  const storeFile = path.join(cwd, '.traffic-one', 'runs', runId, 'exhausted-models.json');
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const lockPath = `${storeFile}.lock`;
    fs.writeFileSync(lockPath, '', 'utf8'); // truncated: no parseable holder line
    const when = new Date(FUTURE());
    fs.utimesSync(lockPath, when, when);

    assert.deepEqual(
      recordExhaustedModel(cwd, runId, 'senior-backend', 'gpt-5.6-terra-medium'),
      ['gpt-5.6-terra-medium'],
      'a torn lock with an impossible mtime must not outlive its writer',
    );
  } finally {
    cleanup(cwd);
  }
});

test('exhausted-models: a future-stamped condemnation expires instead of condemning the model for the whole run', () => {
  const cwd = tmp('exhausted-ttl');
  const runId = 'run-ttl';
  const storeFile = path.join(cwd, '.traffic-one', 'runs', runId, 'exhausted-models.json');
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, JSON.stringify({
      'senior-backend': [
        { model: 'future-stamped-model', at: new Date(FUTURE()).toISOString() },
        { model: 'genuinely-fresh-model', at: new Date(PAST(1_000)).toISOString() },
      ],
    }), 'utf8');

    // This one folds the OPPOSITE way from the lock sites: freshness BLOCKS here.
    assert.deepEqual(
      exhaustedModelsForRole(cwd, runId, 'senior-backend'),
      ['genuinely-fresh-model'],
      'an age no clock could produce must not keep a model condemned for the entire run',
    );
  } finally {
    cleanup(cwd);
  }
});

// ─────────────────────────────── qa-evidence/lock.ts (1 site) ────────────────

test('qa-evidence: a future mtime on an unreadable runner lock cannot wedge the run directory', () => {
  const projectRoot = tmp('qa-lock');
  try {
    const dir = qaDir(projectRoot, 'run1');
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = path.join(dir, '.runner.lock');
    fs.writeFileSync(lockPath, '{ torn payload'); // unreadable holder ⇒ age is the only evidence
    const when = new Date(FUTURE());
    fs.utimesSync(lockPath, when, when);

    assert.equal(
      acquireQaRunLock(projectRoot, 'run1').ok,
      true,
      'an mtime no clock could produce is as much evidence as no mtime, which this file already reclaims on',
    );
  } finally {
    cleanup(projectRoot);
  }
});

// ─────────────────────────────── codex-mcp.ts (2 sites) ──────────────────────

function codexEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, CODEX_HOME: home };
}

test('codex-mcp: a future-stamped dead owner cannot wedge Codex MCP registration', () => {
  const home = tmp('codex-owner');
  try {
    const cfgPath = path.join(home, 'config.toml');
    seedOwnerDirLock(`${cfgPath}.traffic-one-mcp.lock`, deadPid(), FUTURE());
    assert.equal(
      removeCodexOneMcpServerRegistration(codexEnv(home)),
      'absent',
      'the transaction must take the lock, not report `failed` at the acquisition timeout',
    );
  } finally {
    cleanup(home);
  }
});

// ─────────────────────────────── one-mcp/cache-lock.ts (2 sites) ─────────────

test('one-mcp cache lock: a future-stamped dead owner is reclaimed instead of burning the timeout', () => {
  const dir = tmp('cache-owner');
  try {
    const filePath = path.join(dir, 'cache.json');
    seedOwnerDirLock(`${filePath}.lock`, deadPid(), FUTURE());
    const lock = acquireCacheLock(filePath);
    assert.ok(lock, 'acquisition must succeed rather than refuse at the deadline');
    assert.equal(typeof lock.token, 'string');
    assert.ok(lock.token.length > 0, 'acquisition must succeed rather than refuse at the deadline');
  } finally {
    cleanup(dir);
  }
});

// ─────────────────────────────── one-settings.ts (2 sites) ───────────────────

test('one-settings: a future-stamped dead owner cannot block every settings write', () => {
  const dir = tmp('settings-owner');
  const env = { ...process.env, TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json') };
  try {
    seedOwnerDirLock(`${oneSettingsPath(env)}.lock`, deadPid(), FUTURE());
    updateOneSettings({ codeGraphProvider: 'probe' }, env);
    assert.equal(
      JSON.parse(fs.readFileSync(oneSettingsPath(env), 'utf8')).codeGraphProvider,
      'probe',
      'the settings write must land rather than throw at the lock timeout',
    );
  } finally {
    cleanup(dir);
  }
});

// ─────────────────────────────── run-model-policy.ts (2 sites) ───────────────

function policyFixture<T>(prefix: string, body: (cwd: string, env: NodeJS.ProcessEnv) => T): T {
  const cwd = tmp(prefix);
  const env = {
    ...process.env,
    TRAFFIC_ONE_HOST: 'codex',
    TRAFFIC_ONE_USER_PLAN: 'pro',
    XDG_STATE_HOME: path.join(cwd, 'state'),
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'preferences.json'),
  };
  try {
    return body(cwd, env);
  } finally {
    cleanup(cwd);
  }
}

function codexPolicyState(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const target = currentHostModelTarget('codex', 'pro', env);
  return {
    mode: 'new-project',
    performance: {
      level: 'balanced',
      source: 'prompted',
      target: { plan: 'pro', appliedFingerprint: target.appliedFingerprint, configVersion: target.configVersion },
    },
    team: { mode: 'subagents', approved: true, source: 'prompted' },
  };
}

test('run-model-policy: a future-stamped dead owner cannot stop the run policy from ever being published', () => {
  policyFixture('policy-owner', (cwd, env) => {
    const runId = 'policy-owner';
    const filePath = runModelPolicyPath(cwd, runId);
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: deadPid(), at: FUTURE(), token: 'x' }));

    ensureRunModelPolicy(cwd, runId, 'codex', codexPolicyState(env), env);
    assert.equal(
      fs.existsSync(filePath),
      true,
      'the immutable policy must be publishable; an unpublished policy blocks every parent tool call for the run',
    );
  });
});

test('run-model-policy: an abandoned empty policy lock with a future mtime is still reclaimed', () => {
  policyFixture('policy-empty', (cwd, env) => {
    const runId = 'policy-empty';
    const filePath = runModelPolicyPath(cwd, runId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    seedEmptyDirLock(`${filePath}.lock`, FUTURE());

    ensureRunModelPolicy(cwd, runId, 'codex', codexPolicyState(env), env);
    assert.equal(fs.existsSync(filePath), true);
  });
});

// ─────────────────────────── codex-model-observation.ts (2 sites) ────────────

function observationLockPath(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', runId, 'codex-model-observations.json.lock');
}

test('codex-model-observation: a future-stamped dead owner cannot silence every child observation', () => {
  policyFixture('observation-owner', (cwd, env) => {
    const runId = 'obs-owner';
    assert.ok(ensureRunModelPolicy(cwd, runId, 'codex', codexPolicyState(env), env), 'policy fixture precondition');
    const lockPath = observationLockPath(cwd, runId);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: deadPid(), at: FUTURE(), token: 'x' }));

    assert.notEqual(
      observeCodexChildModel(cwd, runId, { childId: 'child-1', actualModel: 'gpt-5.6-terra', role: 'senior-backend', source: 'SubagentStart' }),
      null,
      'the observation store must be writable; a null verdict is how model verification silently stops',
    );
  });
});

test('codex-model-observation: an abandoned empty store lock with a future mtime is still reclaimed', () => {
  policyFixture('observation-empty', (cwd, env) => {
    const runId = 'obs-empty';
    assert.ok(ensureRunModelPolicy(cwd, runId, 'codex', codexPolicyState(env), env), 'policy fixture precondition');
    seedEmptyDirLock(observationLockPath(cwd, runId), FUTURE());

    assert.notEqual(
      observeCodexChildModel(cwd, runId, { childId: 'child-1', actualModel: 'gpt-5.6-terra', role: 'senior-backend', source: 'SubagentStart' }),
      null,
    );
  });
});

// ─────────────────────────────── project-state-lock.ts (3 sites) ─────────────

function stateLockPath(cwd: string): string {
  return path.join(cwd, '.traffic-one', '.one.json.report-id.lock');
}

test('project-state-lock: a future-stamped dead owner cannot block every canonical state transaction', () => {
  const cwd = tmp('state-owner');
  try {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    seedOwnerDirLock(stateLockPath(cwd), deadPid(), FUTURE());
    assert.equal(
      withProjectStateLock(cwd, () => 'ran'),
      'ran',
      'the transaction must run under the lock instead of throwing at the acquisition timeout',
    );
  } finally {
    cleanup(cwd);
  }
});

test('project-state-lock: a future-stamped orphan .pending dir with a dead owner is still reaped', () => {
  const cwd = tmp('state-pending');
  try {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    const orphan = `${stateLockPath(cwd)}.deadtoken.pending`;
    seedOwnerDirLock(orphan, deadPid(), FUTURE(), 'deadtoken');
    const when = new Date(FUTURE());
    fs.utimesSync(orphan, when, when);

    withProjectStateLock(cwd, () => undefined);
    assert.equal(
      fs.existsSync(orphan),
      false,
      'the 16co litter reaper must not be disabled by an impossible mtime',
    );
  } finally {
    cleanup(cwd);
  }
});

// ─────────────────────────────── onboarding-server/ensure.ts (1 site) ────────

test('onboarding ensure: a future-stamped launch lock whose pid was REUSED is still stolen', () => {
  const cwd = tmp('onboarding');
  const baseEnv = {
    ...process.env,
    XDG_STATE_HOME: path.join(cwd, 'state'),
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'preferences.json'),
    TRAFFIC_ONE_ONBOARDING_NO_SPAWN: '',
  };
  delete (baseEnv as Record<string, unknown>).TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
  try {
    const host = 'claude';
    const env = resolveTrafficOneEnv(cwd, host, baseEnv);
    const lockPath = serverLockPath(cwd, env, host);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    // The orphaned-lock shape: the holder was SIGKILLed so its `finally` never
    // ran, and its pid has since been reused — liveness can never refute it, so
    // the age clause is the only way out.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, at: FUTURE() }));

    let launched = 0;
    try {
      ensureOnboardingServer(cwd, {
        env: baseEnv,
        host,
        isAlive: () => true,
        launch: () => { launched += 1; return 999999; },
        lockWaitTimeoutMs: 60,
        readyTimeoutMs: 10,
      });
    } catch {
      // Both branches end in a START_TIMEOUT here; only `launched` distinguishes them.
    }
    assert.equal(launched, 1, 'onboarding must be able to launch again; otherwise the lock is permanent on this machine');
  } finally {
    cleanup(cwd);
  }
});

// ─────────────────────────── local-prefs/prefs-store.ts (2 sites) ────────────

test('prefs-store: a future-stamped dead owner cannot block every project prefs write', () => {
  const dir = tmp('prefs-owner');
  try {
    const filePath = path.join(dir, 'preferences.json');
    seedOwnerDirLock(`${filePath}.lock`, deadPid(), FUTURE());
    assert.equal(withProjectPrefsLock(filePath, () => 'ran'), 'ran');
  } finally {
    cleanup(dir);
  }
});

// Why the FIVE sibling `reapAbandonedEmptyLock` mtime tests that used to sit
// beside these are absent, and why those five sites keep their raw subtraction.
//
// Written first, they all PASSED with the fix reverted — vacuous. The mechanism,
// measured: `rename(dir, EMPTY dir)` SUCCEEDS on POSIX. The five locks that
// publish through a mkdir-then-rename handshake (cache-lock, one-settings,
// codex-mcp, project-state-lock, prefs-store) therefore never contend with an
// empty canonical lock — the acquiring rename overwrites it — so their empty-dir
// reap is not on the acquisition path and a negative age there costs a retry
// rather than a wedge. The two locks whose CAS is a bare `mkdir` (run-model-
// policy, codex-model-observation) have no such fallback: an empty directory
// makes mkdir fail EEXIST forever, the reclaim IS load-bearing, and those two
// mtime sites are folded and pinned above.
//
// This test states the mechanism so the distinction is not re-litigated: if the
// handshake is ever replaced by a bare mkdir CAS, it fails and the five sites
// must be revisited.
test('an empty canonical lock is overwritten by the rename handshake, not contended', () => {
  const dir = tmp('empty-dir-mechanism');
  try {
    const filePath = path.join(dir, 'cache.json');
    seedEmptyDirLock(`${filePath}.lock`, FUTURE());
    const started = Date.now();
    const lock = acquireCacheLock(filePath);
    assert.ok(lock && lock.token.length > 0);
    assert.ok(
      Date.now() - started < 200,
      'an empty lock directory must not cost a single retry, let alone the reap',
    );
  } finally {
    cleanup(dir);
  }
});
// ─────────────────────────────── the other half of the contract ──────────────
// None of the above may be obtainable by simply weakening the locks. The pid
// check is what decides at every owner-stamped site, so a LIVE owner must keep
// its lock for the full timeout whatever its stamp says.

test('a LIVE owner keeps its lock regardless of stamp direction (cache lock)', () => {
  const dir = tmp('live-cache');
  try {
    for (const [label, createdAt] of [['future', FUTURE()], ['past', PAST()]] as const) {
      const filePath = path.join(dir, `${label}.json`);
      seedOwnerDirLock(`${filePath}.lock`, process.pid, createdAt);
      assert.equal(
        acquireCacheLock(filePath),
        null,
        `a live owner's lock must not be stolen on a ${label} stamp`,
      );
    }
  } finally {
    cleanup(dir);
  }
});

test('a LIVE owner keeps its lock regardless of stamp direction (prefs lock)', () => {
  const dir = tmp('live-prefs');
  try {
    for (const [label, createdAt] of [['future', FUTURE()], ['past', PAST()]] as const) {
      const filePath = path.join(dir, `${label}.json`);
      seedOwnerDirLock(`${filePath}.lock`, process.pid, createdAt);
      assert.equal(
        withProjectPrefsLock(filePath, () => 'ran'),
        undefined,
        `a live owner's lock must not be stolen on a ${label} stamp`,
      );
    }
  } finally {
    cleanup(dir);
  }
});

test('a LIVE qa-evidence holder still owns its run directory on a future mtime', () => {
  const projectRoot = tmp('live-qa');
  try {
    const dir = qaDir(projectRoot, 'run1');
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = path.join(dir, '.runner.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const when = new Date(FUTURE());
    fs.utimesSync(lockPath, when, when);

    assert.equal(acquireQaRunLock(projectRoot, 'run1').ok, false, 'a readable live holder is decided by its pid, not its mtime');
  } finally {
    cleanup(projectRoot);
  }
});

test('a genuinely fresh condemnation is not expired by the trustworthy-age fold', () => {
  const cwd = tmp('ttl-negative');
  const runId = 'run-ttl-neg';
  const storeFile = path.join(cwd, '.traffic-one', 'runs', runId, 'exhausted-models.json');
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(storeFile, JSON.stringify({
      'senior-backend': [
        { model: 'inside-ttl', at: new Date(now - (EXHAUSTED_MODEL_TTL_MS - 1_000)).toISOString() },
        { model: 'outside-ttl', at: new Date(now - (EXHAUSTED_MODEL_TTL_MS + 1_000)).toISOString() },
        // Inside the 5-minute skew allowance: ordinary jitter, clamps to age 0.
        { model: 'slightly-ahead', at: new Date(now + 1_000).toISOString() },
      ],
    }), 'utf8');

    assert.deepEqual(
      exhaustedModelsForRole(cwd, runId, 'senior-backend', now),
      ['inside-ttl', 'slightly-ahead'],
      'only an age no clock could produce expires early; jitter and a live TTL are untouched',
    );
  } finally {
    cleanup(cwd);
  }
});

test('an owner-less .pending staging dir is NOT reaped on an untrustworthy age alone', () => {
  const cwd = tmp('pending-negative');
  try {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    // The mkdir→owner-file gap of a LIVE acquisition. With no readable owner and
    // no usable age there is no evidence of death, and removing it would make
    // the real acquirer's rename fail ENOENT and throw out of a hook.
    const inflight = `${stateLockPath(cwd)}.inflight.pending`;
    fs.mkdirSync(inflight, { recursive: true });
    const when = new Date(FUTURE());
    fs.utimesSync(inflight, when, when);

    withProjectStateLock(cwd, () => undefined);
    assert.equal(fs.existsSync(inflight), true, 'an unusable age may not stand in for the age floor with no pid to govern it');
  } finally {
    cleanup(cwd);
  }
});
