// The ABSENT-or-UNUSABLE stamp, which lock-staleness-clock-skew.test.ts left
// open at three sites and was right to: a stamp no clock could have produced and
// NO STAMP AT ALL are different inputs, and a fold measured on one is not
// evidence about the other. This file measures the other one, per site, and the
// three verdicts are NOT the same because the consequences are not the same.
//
// The shape at issue is a lock record that PARSES and carries a usable pid but
// whose stamp is missing or non-numeric, so the age clause has nothing to say:
//
//   ensure.ts               `Number.isFinite(claimedAt) && (...)`  ⇒ no opinion
//   run-model-policy.ts     `if (!at) return false;`               ⇒ fail closed
//   codex-model-observation `if (!at) return false;`               ⇒ fail closed
//
// MEASURED (this file, node v26.5.0, macOS):
//   - ensure.ts, live-looking pid + absent stamp: 0 launches and a START_TIMEOUT
//     throw after the full 1000ms wait window (1022.31ms), EVERY call, FOREVER —
//     the lock lives at ~/.traffic-one/projects/<hash>/onboarding/<host>/
//     server.lock, which has no run-id rotation and outlives reboots, so nothing
//     recovers it but a manual delete. After the fold: 1 launch, 56.69ms end to
//     end (the steal is immediate; what is left is this probe's injected 10ms
//     readiness budget plus one 50ms poll sleep, not lock time).
//   - run-model-policy.ts, ESRCH-dead owner + absent stamp: policy unpublished
//     after burning the full 1000ms POLICY_LOCK_TIMEOUT_MS — but the lock path is
//     `runs/<runId>/model-policy.json.lock`, so the NEXT run id publishes in
//     ~35ms. One run, not the machine.
//   - codex-model-observation.ts, same shape: null observation after the full
//     1000ms LOCK_TIMEOUT_MS (every Codex child in that run then gets
//     `codex-child-model-observation-persist-failed`), and the next run id
//     observes normally.
//
// So ensure.ts is folded and the other two keep their fail-closed answer, for a
// reason stronger than the wedge being smaller: at those two the reclaim is
// `age AND processDefinitelyDead`, and their owner record is published by a
// single writeFileSync inside the mkdir→owner-file gap of a LIVE acquisition.
// Every proper prefix of that record is unparseable JSON (asserted below), so
// "the record does not carry a usable stamp" is indistinguishable from "the
// record is being written right now" — and reclaiming it would hand out two
// leases. At ensure.ts the same fold is safe because the record is written to a
// held fd, so nothing about it is in flight once it parses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { currentHostModelTarget } from '../current-model-tiers';
import { ensureRunModelPolicy, runModelPolicyPath } from '../run-model-policy';
import { POLICY_LOCK_TIMEOUT_MS } from '../run-model-policy-schema';
import { observeCodexChildModel } from '../state/codex-model-observation';
import { ensureOnboardingServer } from '../onboarding-server/ensure';
import { serverLockPath, writeServerRecord } from '../onboarding-server/registry';
import { resolveTrafficOneEnv } from '../state/traffic-one-paths';

// codex-model-observation.ts's LOCK_TIMEOUT_MS is private; this is the same
// 1_000ms, asserted as a floor so the burn is measured rather than assumed.
const OBSERVATION_LOCK_TIMEOUT_MS = 1_000;

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-w6-${prefix}-`)));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * A pid that has EXITED and been reaped, so `kill(pid, 0)` raises ESRCH.
 *
 * Same fixture guard as lock-staleness-clock-skew.test.ts, for the same reason:
 * every "provably dead owner" premise below is ASSERTED, because a hard-coded
 * high pid that happened to be live would make these tests pass for the wrong
 * reason — the reclaim would be refused by the pid check and the stamp fold
 * would never be reached.
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

// ─────────────────────── the writer's own producible shapes ──────────────────

// The load-bearing reachability fact for all three verdicts. Both lock writers
// publish their record in ONE call — `writeSync(fd, JSON.stringify(...))` at
// ensure.ts, `writeFileSync(ownerPath, JSON.stringify(...), {flag:'wx'})` at the
// other two — so the only partial artifact a killed writer can leave is a byte
// PREFIX of that JSON. No prefix parses, which means no writer in this tree can
// produce the shape the three folds above disagree about: a record that PARSES
// with a usable pid and no usable stamp. It has to come from outside (a foreign
// tool, a restore, a hand edit, a future format), and that is exactly why the
// question is answered on CONSEQUENCE rather than on likelihood.
test('no writer in this tree can produce a parseable lock record with an unusable stamp', () => {
  const records = [
    JSON.stringify({ pid: 4242, at: Date.now() }), // ensure.ts
    JSON.stringify({ pid: 4242, at: Date.now(), token: 'abc' }), // both owner-record locks
  ];
  let checked = 0;
  for (const record of records) {
    for (let end = 1; end < record.length; end += 1) {
      const torn = record.slice(0, end);
      assert.throws(
        () => JSON.parse(torn) as unknown,
        `a torn write must never parse, or "no usable stamp" would be a reachable state: ${torn}`,
      );
      checked += 1;
    }
    const whole = JSON.parse(record) as { pid: number; at: number };
    assert.equal(Number.isFinite(whole.at), true, 'the complete record always carries a finite stamp');
  }
  // A `throws` loop that never ran would assert nothing.
  assert.ok(checked > 50, `the prefix sweep must actually run: ${checked} prefixes checked`);
});

// ─────────────────────── onboarding-server/ensure.ts ─────────────────────────

interface OnboardingProbe {
  launched: number;
  elapsedMs: number;
  code: string | null;
}

// A real ensureOnboardingServer call against a seeded launch lock. `isAlive` is
// deliberately NOT injected: the wedge premise is a lock whose pid genuinely
// answers `kill(pid, 0)` — the orphaned-lock-with-REUSED-pid case — so the
// fixtures below use this test process's own pid, which is really alive, and
// deadPid(), which is really ESRCH-dead. `launch` is counted rather than run,
// because a duplicate detached server is the cost being weighed, not something
// to actually pay in a unit test.
function onboardingProbe(
  prefix: string,
  seed: (lockPath: string) => void,
  lockWaitTimeoutMs = 1_000,
): OnboardingProbe {
  const cwd = tmp(prefix);
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_STATE_HOME: path.join(cwd, 'state'),
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'preferences.json'),
  };
  delete baseEnv.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
  try {
    const host = 'claude';
    const env = resolveTrafficOneEnv(cwd, host, baseEnv);
    const lockPath = serverLockPath(cwd, env, host);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    seed(lockPath);
    let launched = 0;
    let code: string | null = null;
    const started = performance.now();
    try {
      ensureOnboardingServer(cwd, {
        env: baseEnv,
        host,
        launch: () => { launched += 1; return 999_999; },
        lockWaitTimeoutMs,
        readyTimeoutMs: 10,
      });
    } catch (error) {
      // Both the stolen and the waited-out path end in START_TIMEOUT here (no
      // record is ever published), so only `launched` distinguishes them.
      code = (error as NodeJS.ErrnoException).code || 'THROWN';
    }
    return { launched, elapsedMs: performance.now() - started, code };
  } finally {
    cleanup(cwd);
  }
}

test('onboarding ensure: a launch lock with NO usable stamp and a live-looking pid is still stealable', (t) => {
  // The escape the age clause is the ONLY one for: the pid answers `kill(pid,0)`
  // because it was REUSED after the holder was SIGKILLed, so liveness can never
  // refute it. With no usable stamp the age clause abstains, and this lock — in
  // the per-project HOME state root, with no run-id rotation and no reaper — is
  // then permanent for this project+host.
  for (const [label, at] of [
    ['absent', undefined],
    ['non-numeric', 'whenever'],
  ] as const) {
    const probe = onboardingProbe(`ensure-${label}`, (lockPath) => {
      fs.writeFileSync(lockPath, JSON.stringify(at === undefined ? { pid: process.pid } : { pid: process.pid, at }));
    });
    t.diagnostic(`${label} stamp + live pid: launched=${probe.launched} elapsed=${probe.elapsedMs.toFixed(2)}ms code=${probe.code}`);
    assert.equal(
      probe.launched,
      1,
      `a ${label} stamp must not make a launch lock permanent: onboarding never launches again for this project+host`,
    );
  }
  // Today's only escape, for contrast: the pid check. A record with the same
  // unusable stamp and a provably dead pid was always stolen, which is why the
  // defect needs pid REUSE and is narrow rather than absent.
  const dead = onboardingProbe('ensure-dead-pid', (lockPath) => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid() }));
  });
  t.diagnostic(`absent stamp + ESRCH-dead pid: launched=${dead.launched} elapsed=${dead.elapsedMs.toFixed(2)}ms`);
  assert.equal(dead.launched, 1, 'a dead holder is stolen from on the pid check alone, stamp or no stamp');
});

test('onboarding ensure: a LIVE holder keeps its launch lock on every stamp a real clock could write', (t) => {
  // The other half of the contract. Unlike the two owner-record locks, THIS
  // site's fold is an OR — `deadPid || ageClause` — so the pid check does NOT
  // govern it and "not a general weakening" cannot be asserted for arbitrary
  // stamps. What it must hold for is every stamp a real clock could produce:
  // inside the stale window, and inside the future-skew allowance where a
  // negative age is ordinary jitter. Both keep the lease for the full window.
  for (const [label, offset] of [
    ['1s in the past (inside LOCK_STALE_MS)', -1_000],
    ['60s ahead (inside STATE_TIMESTAMP_FUTURE_SKEW_MS)', 60_000],
  ] as const) {
    const probe = onboardingProbe('ensure-live-holder', (lockPath) => {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() + offset }));
    }, 300);
    t.diagnostic(`live holder, stamp ${label}: launched=${probe.launched} elapsed=${probe.elapsedMs.toFixed(2)}ms code=${probe.code}`);
    assert.equal(probe.launched, 0, `a live launcher's lock must not be stolen on a stamp ${label}`);
    assert.equal(probe.code, 'START_TIMEOUT', 'the waiter must time out retryably rather than double-launch');
  }
  // And the age rule itself is untouched: a live pid past LOCK_STALE_MS is
  // stolen from exactly as before, which is what makes the orphaned-lock case
  // recoverable at all when the stamp IS usable.
  const aged = onboardingProbe('ensure-aged', (lockPath) => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
  });
  assert.equal(aged.launched, 1, 'a stamp older than LOCK_STALE_MS is stale whatever the pid says');
});

test('onboarding ensure: the openSync→writeSync gap of a LIVE acquisition is ALREADY stealable, and this fold is not what opens it', (t) => {
  // The trap the .pending reaper found next door, asked here before making
  // anything more stealable: is there a window in which the lock artifact exists
  // but its owner has not published yet, and does deleting it break the real
  // acquirer? There is — `openSync(lockPath,'wx')` creates an EMPTY file before
  // `writeSync` fills it — but it is not opened by this fold: an empty file does
  // not parse, so `holderPid` stays 0 and the lock was ALWAYS stolen there. The
  // fold only reaches records that DO parse.
  const empty = onboardingProbe('gap-empty', (lockPath) => { fs.writeFileSync(lockPath, ''); });
  t.diagnostic(`empty (in-flight) lock file: launched=${empty.launched} elapsed=${empty.elapsedMs.toFixed(2)}ms`);
  assert.equal(empty.launched, 1, 'an empty lock file is stolen on the unparseable path, before and after this fold');

  // And the reason that is survivable here while the .pending reap was not: the
  // in-flight acquirer holds an OPEN FD, so a thief's unlink cannot make its own
  // publication fail. The reaper's victim published by RENAME into the directory
  // that had been deleted, which is what threw ENOENT out of a hook.
  const dir = tmp('gap-fd');
  try {
    const lockPath = path.join(dir, 'server.lock');
    const fd = fs.openSync(lockPath, 'wx');
    fs.unlinkSync(lockPath); // the thief, mid-acquisition
    assert.doesNotThrow(() => {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
    }, 'writing to a held fd survives the unlink: the stolen-from acquirer does not throw, it duplicates');
  } finally {
    cleanup(dir);
  }
});

test('onboarding ensure: stealing a lock costs a duplicate server only while the victim has NOT published', (t) => {
  // The trade this site accepts — "costing one duplicate server" — is bounded by
  // the reuse re-check that runs after acquisition (`reuseIfLive()` immediately
  // inside the try), and that bound is worth pinning because the whole
  // cost/benefit of both folds here rests on it.
  //
  // Deterministic, not racy: the injected `isAlive` publishes the victim's record
  // the FIRST time the lock's holder pid is checked — i.e. the victim finished
  // publishing while we were deciding its lock was stale. The pre-lock reuse
  // check has already run and seen nothing (no record existed yet), so the only
  // thing that can prevent a second spawn here is the POST-acquisition check.
  const cwd = tmp('ensure-published-victim');
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_STATE_HOME: path.join(cwd, 'state'),
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'preferences.json'),
  };
  delete baseEnv.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
  try {
    const host = 'claude';
    const env = resolveTrafficOneEnv(cwd, host, baseEnv);
    const lockPath = serverLockPath(cwd, env, host);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid })); // stolen by the fold above
    let published = 0;
    let launched = 0;
    const result = ensureOnboardingServer(cwd, {
      env: baseEnv,
      host,
      isAlive: (pid) => {
        if (pid === process.pid && published === 0) {
          published += 1;
          writeServerRecord(cwd, {
            pid: process.pid,
            port: 51234,
            token: 'victim-token',
            url: 'http://127.0.0.1:51234/',
            startedAt: new Date().toISOString(),
            host,
          }, env, host);
        }
        return true;
      },
      launch: () => { launched += 1; return 999_999; },
      lockWaitTimeoutMs: 300,
      readyTimeoutMs: 10,
    });
    t.diagnostic(`victim published mid-steal: launched=${launched} port=${result.port} started=${result.started}`);
    assert.equal(published, 1, 'fixture guard: the victim must have published inside the acquisition window');
    assert.equal(launched, 0, 'a stolen lock must not spawn a second server once the victim has published');
    assert.equal(result.port, 51234, "the victim's live record is what gets returned");
    assert.equal(result.started, false, 'and it is reported as a reuse, not a launch');
  } finally {
    cleanup(cwd);
  }
});

// ───────────────────── run-model-policy.ts / codex-model-observation.ts ──────
// Both keep `if (!at) return false;`. What that costs, measured, and why the
// next run id is the fact that makes it acceptable where ensure.ts's is not.

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

// Both stampless shapes a foreign writer could leave, and the TORN shape a
// killed writer really can: all three are refused, so the fold under test is not
// the only thing holding this path closed.
const STAMPLESS_OWNER_RECORDS: readonly (readonly [string, string])[] = [
  ['absent stamp', JSON.stringify({ pid: 0, token: 'x' })],
  ['non-numeric stamp', JSON.stringify({ pid: 0, at: 'whenever', token: 'x' })],
  ['torn (unparseable) record', '{"pid":0,"at":178'],
];

function withDeadPid(record: string, pid: number): string {
  return record.replace('"pid":0', `"pid":${pid}`);
}

test('run-model-policy: a stampless owner record costs ONE RUN, and the next run id publishes', (t) => {
  policyFixture('policy-absent', (cwd, env) => {
    const state = codexPolicyState(env);
    for (const [label, record] of STAMPLESS_OWNER_RECORDS) {
      const runId = `wedged-${label.replace(/[^a-z]+/gi, '-')}`;
      const filePath = runModelPolicyPath(cwd, runId);
      const lockPath = `${filePath}.lock`;
      fs.mkdirSync(lockPath, { recursive: true });
      fs.writeFileSync(path.join(lockPath, 'owner.json'), withDeadPid(record, deadPid()));

      const started = performance.now();
      const result = ensureRunModelPolicy(cwd, runId, 'codex', state, env);
      const elapsedMs = performance.now() - started;
      t.diagnostic(`${label}, ESRCH-dead owner: published=${result !== null} elapsed=${elapsedMs.toFixed(2)}ms`);
      assert.equal(result, null, `the measured cost of the fail-closed fold on a ${label}`);
      assert.equal(fs.existsSync(filePath), false, 'nothing is published behind an unreclaimable lock');
      assert.ok(
        elapsedMs >= POLICY_LOCK_TIMEOUT_MS,
        `and it is paid in full: ${elapsedMs.toFixed(2)}ms against POLICY_LOCK_TIMEOUT_MS=${POLICY_LOCK_TIMEOUT_MS}`,
      );
    }
    // The fact the verdict rests on: this lock path is per-RUN-ID, so the wedge
    // is bounded by the next parent run. ensure.ts's lock is per project+host in
    // the HOME state root with no rotation at all, which is why the same fold
    // goes the other way there.
    const started = performance.now();
    const fresh = ensureRunModelPolicy(cwd, 'run-after-the-wedge', 'codex', state, env);
    t.diagnostic(`recovery on a NEW run id: published=${fresh !== null} elapsed=${(performance.now() - started).toFixed(2)}ms`);
    assert.ok(fresh, 'a new run id must publish normally: the fail-closed fold is per-run, not per-machine');
  });
});

test('codex-model-observation: a stampless owner record costs ONE RUN of observations, and the next run id observes', (t) => {
  policyFixture('observation-absent', (cwd, env) => {
    const state = codexPolicyState(env);
    const runId = 'obs-stampless';
    assert.ok(ensureRunModelPolicy(cwd, runId, 'codex', state, env), 'policy fixture precondition');
    const lockPath = path.join(cwd, '.traffic-one', 'runs', runId, 'codex-model-observations.json.lock');
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: deadPid(), token: 'x' }));

    const started = performance.now();
    const observation = observeCodexChildModel(cwd, runId, {
      childId: 'child-1',
      actualModel: 'gpt-5.6-terra',
      role: 'senior-backend',
      source: 'SubagentStart',
    });
    const elapsedMs = performance.now() - started;
    t.diagnostic(`absent stamp, ESRCH-dead owner: observation=${observation === null ? 'null' : observation.status} elapsed=${elapsedMs.toFixed(2)}ms`);
    // A null verdict here is what codex-child-model.ts turns into
    // `codex-child-model-observation-persist-failed` — a deny on EVERY tool call
    // of EVERY Codex child in this run, whose prose prescribes a replacement
    // child that would hit the same per-run lock.
    assert.equal(observation, null, 'the measured cost of the fail-closed fold');
    assert.ok(
      elapsedMs >= OBSERVATION_LOCK_TIMEOUT_MS,
      `paid in full: ${elapsedMs.toFixed(2)}ms against LOCK_TIMEOUT_MS=${OBSERVATION_LOCK_TIMEOUT_MS}`,
    );

    const freshRun = 'obs-after-the-wedge';
    assert.ok(ensureRunModelPolicy(cwd, freshRun, 'codex', state, env), 'new-run policy precondition');
    assert.notEqual(
      observeCodexChildModel(cwd, freshRun, {
        childId: 'child-1',
        actualModel: 'gpt-5.6-terra',
        role: 'senior-backend',
        source: 'SubagentStart',
      }),
      null,
      'a new run id observes normally: the fail-closed fold is per-run, not per-machine',
    );
  });
});
