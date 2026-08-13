// src/runners/qa-evidence/__tests__/process-group.test.ts
// A bounded command that is cut short must take its whole process TREE with it.
//
// Nothing this runner bounds is a leaf. `npm test` is a package manager
// wrapping a shell wrapping the suite; `xcodebuild test` owns a simulator;
// `./gradlew` owns a daemon. Every kill on this path used to be a direct-child
// `child.kill`, so a timed-out step killed the wrapper and left the work
// running at `ppid 1` — still bound to its port, still holding its device.
//
// That orphan is not a tidiness problem. It is the mechanism behind the
// incident recorded at plan-guard/plan-readiness/completion.ts:636: a previous
// project's `vite preview` survived its run, kept the port, and every check of
// the NEXT run passed against a different application. A survivor makes the
// evidence of every later run untrustworthy without making any of it look
// wrong.
//
// So the assertion here is deliberately about the GRANDCHILD, not the child. A
// test that only observed the child would have passed for the whole life of the
// defect: measured on darwin, a leader-only SIGKILL leaves the grandchild
// writing at its normal cadence while `close` reports the child gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FORCED_KILL_GRACE_MS, MAX_NATIVE_PROCESS_OUTPUT, runBoundedProcess } from '../native-process';
import { killProcessGroup, REAP_SWEEP_GAP_MS, REAP_SWEEPS } from '../process-group';
import { MAX_STACK_OUTPUT_BYTES, runStackChecks } from '../stack';
import { type RunnerArgs } from '../types';

// Process groups, signal semantics and `ps` are POSIX. `detached` on Windows
// creates no signalling group at all, so every assertion below would be about
// a mechanism that does not exist there — skipped explicitly, the way
// kilo-host/__tests__/index.test.ts:263 does, rather than left to fail
// mysteriously on the one platform none of this applies to.
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX process groups' : false };

/**
 * One `node -e ""` cold start on this box, or null if the probe failed.
 *
 * Two constants below are sized off it, for the reason `FIXTURE_STARTUP_MS` is
 * measured rather than written down, and against a failure that constant cannot
 * prevent: see `BOUND_MS`.
 */
function nodeStartupMs(): number | null {
  const startedAt = Date.now();
  const probe = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  return probe.status === 0 ? Date.now() - startedAt : null;
}

const NODE_STARTUP_MS = nodeStartupMs();

/**
 * The bound the native rows announce — 1500 ms, unless this box cannot get a
 * fixture up inside it.
 *
 * A BOUND THAT FIRES BEFORE THE FIXTURE EXISTS GRADES NOTHING, and no fixture
 * deadline can rescue it. Every native row here spawns a leader that forks a
 * grandchild, and then waits for the grandchild to announce itself while the run
 * is in flight; the group kill at the bound reaches the whole chain, so a bound
 * that fires before the fork has happened means the grandchild NEVER starts and
 * `runningGrandchild` fails a guard about orphans on a machine that was merely
 * busy. Observed under 40 CPU + 12 IO workers on 10 cores: `the grandchild never
 * started, so nothing was orphanable` on the two rows this file is named for,
 * where two node startups plus a fork plus two writes did not fit inside 1500 ms.
 * Widening `FIXTURE_STARTUP_MS` cannot touch it — it is not the guard's patience
 * that ran out, it is the runner that killed the tree the guard was waiting for.
 *
 * Eight startups, because the chain is two of them plus a fork and two file
 * writes, which leaves 4x of headroom over the shape actually measured. AN IDLE
 * BOX IS UNAFFECTED, deliberately: `node -e ""` costs 40-60 ms here, 8x of that
 * is far under 1500, so the floor is what applies and every documented figure in
 * this file was taken at it. Only a box that has become slow enough to break the
 * premise pays anything, and it pays in proportion to how slow it got.
 *
 * Nothing downstream is weakened, because every timing assertion here is relative
 * to the bound the row announced: `assertHeldToBound` and `assertSettledBy`
 * derive the whole ceiling — grace plus a 15% overrun allowance — from this
 * value, so a bigger bound is held to a proportionally bigger ceiling and the
 * multiplier a regression has to breach is unchanged.
 */
const BOUND_MS = Math.max(1_500, 8 * (NODE_STARTUP_MS ?? 0));

/** How long the grandchild is given to disappear after the runner returns. */
const REAP_BUDGET_MS = 5_000;

/**
 * How many more heartbeats a leftover may write AFTER the runner has returned.
 *
 * This is the promptness claim, and it used to be a 300 ms wall-clock ceiling on
 * how long the tree stayed alive past `await run`. `REAP_BUDGET_MS` bounds
 * liveness and nothing else, which left kill PROMPTNESS invisible — measured, a
 * reap deferred by anything under five seconds passed every test in this file
 * unchanged, so "the tree is gone by the time the caller is told the run ended"
 * was only ever asserted as "eventually gone". The gap matters to the one caller
 * shape this lane exists for: a harness that starts the next run, against the
 * same port, the moment this one settles.
 *
 * A FIXED DEADLINE IS THE WRONG INSTRUMENT FOR IT, and that is not a taste
 * argument — 300 ms was 21x the worst idle reading and a machine running the
 * whole suite still crossed it, which turns a claim about the runner into a
 * report about the box. What the claim actually rests on is a synchronous fact
 * with no duration in it: `finish` calls `reapGroup()` BEFORE
 * `resolvePromise(result)`, so at the instant an awaiting caller resumes, the
 * SIGKILL has already been delivered to the group. A process that has been
 * SIGKILLed cannot write another byte, whatever the machine is doing.
 *
 * So promptness is counted in the LEFTOVER'S OWN WRITES rather than in
 * milliseconds: sample the heartbeat file synchronously as the runner returns,
 * and require that it has not grown by the time the tree is observed gone. That
 * is immune to load in both directions — a busy box slows the leftover down,
 * which can only reduce the count — and it still kills the regression the
 * ceiling was calibrated against, a reap moved onto the `FORCED_KILL_GRACE_MS`
 * timer: 500 ms of deferral at the fixture's 50 ms cadence is ten heartbeats
 * idle and at least one at any load a scheduler can produce.
 *
 * ONE is the allowance, not zero, and it is the in-flight write rather than
 * slack: SIGKILL terminates the target at its next kernel boundary, so an
 * `appendFileSync` already issued when the signal landed still completes, and it
 * can complete after the sample below is taken. Measured on this host across 24
 * runs of every shape in this file, idle and under 26-way load: growth 0 in all
 * of them, so the allowance has never been consumed. Ten beats against one is a
 * 10x margin on the mutant, and a leftover that keeps writing indefinitely is
 * caught by the liveness poll above regardless.
 */
const ALLOWED_IN_FLIGHT_BEATS = 1;

/**
 * What a bounded run may overrun its own bound by before the bound is a lie.
 *
 * EVERY timing assertion in this lane used to be one-sided — `elapsedMs >=
 * BOUND_MS` — and a lower bound can only ever prove the runner WAITED. It
 * cannot prove it stopped, which is the entire claim a bound makes. The
 * regression that shipped here was invisible for exactly that reason: with the
 * kill suppressed the runner did not fail these tests, it ran forever, and
 * `MAX_TIMEOUT_MS` quietly became no ceiling at all.
 *
 * PROPORTIONAL, capped, rather than a flat addend. A flat 2 s made the ceiling's
 * effective multiplier a function of the bound: at the smallest bound this lane
 * tests it admitted a 3.9x overrun and caught a 4x one by a hundred
 * milliseconds, so it proved "not unbounded" and said nothing about "badly
 * overrunning" — while at the production 300 s bound the same 2 s was 0.7%, far
 * tighter than intended. A fraction of the bound restores one meaning at every
 * size, and the cap keeps the large end exactly as strict as the flat form
 * already was there rather than loosening it to 150 s.
 *
 * What stays additive is the cost that genuinely does not scale with the bound:
 * the SIGKILL and `close` and `FORCED_KILL_GRACE_MS` when the kill reaches
 * nothing that can answer.
 *
 * The FRACTION is 0.15 rather than the 0.5 this started at, and the reason is
 * measurement. Half the bound left 750 ms of room at the 1500 ms bound below,
 * which made a 1.4x overrun free: 600 ms added to the bound timer changed no
 * verdict in this file. What that room was sized for is settlement latency, and
 * settlement latency is not large. Measured over six runs of each shape idle and
 * six more under 10-way CPU load, the worst overrun past the instant a run
 * IDEALLY settles was 11 ms (4–9 ms idle, 5–11 ms loaded), and an independent
 * 48-way run of the whole file agreed at 8 ms. 0.15 leaves 220 ms on the
 * tightest shape here — the escapee, whose settlement is fixed at
 * bound + grace by construction — which is 20x the worst reading, and it now
 * catches an overrun from 1.15x up.
 */
const MAX_OVERRUN_FRACTION = 0.15;
const MAX_OVERRUN_MS = 2_000;

function overrunAllowance(deadlineMs: number): number {
  return Math.min(MAX_OVERRUN_MS, Math.round(deadlineMs * MAX_OVERRUN_FRACTION));
}

/** The latest a run cut short at `deadlineMs` may still be settling. */
function settlementCeiling(deadlineMs: number): number {
  return deadlineMs + FORCED_KILL_GRACE_MS + overrunAllowance(deadlineMs);
}

function assertSettledBy(elapsedMs: number, deadlineMs: number, what: string): void {
  const ceiling = settlementCeiling(deadlineMs);
  assert.ok(
    elapsedMs < ceiling,
    `${what}: the deadline is announced to the caller and must be one — expected settlement `
    + `within ${ceiling} ms (${deadlineMs} + ${FORCED_KILL_GRACE_MS} forced-kill grace + `
    + `${overrunAllowance(deadlineMs)} allowed overrun), took ${elapsedMs} ms`,
  );
}

function assertHeldToBound(elapsedMs: number, boundMs: number, what: string): void {
  assert.ok(
    elapsedMs >= boundMs,
    `${what}: the runner must have waited out its ${boundMs} ms bound, waited ${elapsedMs} ms`,
  );
  assertSettledBy(elapsedMs, boundMs, what);
}

/**
 * How long a fixture is given to get its tree up before the test calls it a
 * fixture failure.
 *
 * 4 s was the wrong side of the observed spread. A 48-way run of this file took
 * 6.0 s in one test whose fixture is a `tsx` import of the runner plus two node
 * startups, and a startup that crosses this deadline does not fail an assertion
 * about orphans — it fails a guard, on a machine that was merely busy, naming
 * nothing. There is no cost to widening it: on the passing path the loop in
 * `runningGrandchild` exits as soon as the tree answers, so this is only ever
 * the time a genuine "nothing started" takes to be reported.
 *
 * 10 s WAS STILL THE WRONG SIDE OF IT, measured again on a box several lanes
 * were sharing: at load average 64 this file failed 6 of 18 rows and at 44 it
 * failed 1, every one of them at this guard rather than at an assertion, and
 * every one of them passing in isolation on the same box (2.2 s for the row
 * that had just taken 10.14 s). Widening it to 20 s moved which row failed and
 * not whether one did. The slow fixtures are the ones whose tree is `npm run
 * test` — a package manager, its shell, node, and a fork — which is four
 * startups deep and is the shape the stack path always has.
 *
 * SO MEASURE THE MACHINE, AND KEEP A FLOOR THE MEASUREMENT CANNOT UNDERCUT.
 * The probe below is the slow fixtures' own shape — `npm run` a script that
 * starts node and exits — taken on the same box in the same second, so a box
 * genuinely slower than any measured here widens its own deadline instead of
 * failing a guard. (`npm --version` was tried first and is the wrong probe: it
 * loads no manifest and spawns no shell.)
 *
 * THE PROBE IS NOT THE WHOLE COST, and the floor is there because of what it
 * missed: at load average 64 three consecutive probes cost 795-903 ms while
 * the fixture they stand for did not come up inside ten seconds. What the
 * probe cannot see is the rest of the chain — the runner imported through
 * `tsx` in this process, the fork below npm's script, the pid and heartbeat
 * writes — and, on a box several lanes are sharing, a few hundred `/bin/sleep`
 * members of the PREVIOUS row still dying. So the multiple protects a slow
 * box and the floor carries a busy one, which is the case actually observed.
 *
 * A RESIDUAL REMAINS AND IS NOT PAPERED OVER: at load ~60 one row in this file
 * still fails at a deadline roughly one run in three, and every constant tried
 * (10 s, 20 s, probe-derived) moved WHICH row rather than whether one failed.
 * The rows all pass in isolation on the same box, and the assertions they
 * guard — `assertHeldToBound`, `assertSettledBy` — are deliberately not
 * loosened to chase it: those decide the property, and a deadline that decides
 * nothing is the only one worth widening.
 *
 * A COUNT CANNOT REPLACE THIS ONE, which is what separates it from
 * `FORK_RACE_MIN_FORKS` below. There the deadline stood in for a RATE the
 * fixture had to reach, and a count measures that directly; here the loop
 * already waits for the exact event it needs — the pid file and a heartbeat —
 * and the deadline only decides how long a fixture that will NEVER answer is
 * given before it is called broken. Neither widening nor scaling it can weaken
 * an assertion, because it is not one: every row still fails, loudly, if the
 * tree does not come up.
 */
function npmStartupMs(): number | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-pgroup-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'startup-probe',
      private: true,
      scripts: { test: `${JSON.stringify(process.execPath)} -e ""` },
    }));
    const startedAt = Date.now();
    const probe = spawnSync('npm', ['run', 'test', '--silent'], { cwd: dir, encoding: 'utf8' });
    const costMs = Date.now() - startedAt;
    return probe.status === 0 ? costMs : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The `npm run` cold start this box pays right now, or null if it failed. */
const NPM_STARTUP_MS = npmStartupMs();

// Six, because a fixture tree is the probe's shape plus a tsx-loaded runner, one
// more fork and two file writes; 20 s, because six times a probe taken on a
// merely BUSY box still came out under the time the fixture took.
const FIXTURE_STARTUP_MS = NPM_STARTUP_MS === null
  ? 20_000
  : Math.min(Math.max(6 * NPM_STARTUP_MS, 20_000), 120_000);

/**
 * The bound the two STACK rows announce, which cannot be `BOUND_MS`.
 *
 * WIDENING `FIXTURE_STARTUP_MS` PROVABLY CANNOT FIX THOSE TWO ROWS, and that is
 * the correction this constant carries. The comment above records that every
 * constant tried moved WHICH row failed rather than whether one did, which is
 * true and is a different problem for these two: their fixture is not merely
 * slow to answer, it is racing the RUNNER'S OWN BOUND. `runningGrandchild` and
 * `runStackChecks` are awaited together, and the chain the grandchild sits at the
 * bottom of is `npm run` › shell › node › fork. If that chain has not reached the
 * fork when the bound fires, the group is killed and the grandchild NEVER STARTS
 * — so the guard's deadline is irrelevant, and at 20 s it simply waits 20 s for
 * a process the runner already made impossible. Observed under 20 CPU + 6 IO
 * workers on 10 cores: both stack rows failed at `the grandchild never started`
 * while every other row in the file passed, because `npm run` on that box did not
 * reach node inside 1500 ms.
 *
 * So the bound is sized from the machine the same way the guard is, off the same
 * probe: the bound has to outlast the STARTUP of the tree it is bounding, or the
 * row grades nothing. Three times the probe — the probe is npm + shell + node,
 * the fixture is that plus one more fork and two writes — plus the native bound
 * on top, which is the part that is actually about the runner. Idle that is
 * ~1.5 s + 3x~0.8 s ≈ 3.9 s; on the loaded box above it scales with the same
 * measurement that widens the guard.
 *
 * NOTHING IS WEAKENED BY IT. Every timing assertion in those two rows is
 * relative to the bound they were given (`assertHeldToBound`,
 * `assertSettledBy`, `elapsedMs < STACK_BOUND_MS`), so a larger bound is held to
 * a proportionally larger ceiling with the same 15% overrun allowance and the
 * same forced-kill grace; the group-kill and promptness claims do not involve it
 * at all. Verified by mutation: with the group kill reduced to a leader-only kill
 * both rows still fail, and with the reap deferred past the grace window row 61
 * still fails.
 */
const STACK_BOUND_MS = BOUND_MS + 3 * (NPM_STARTUP_MS ?? 1_000);

/**
 * A per-test ceiling. It is a backstop, not the bound assertion: measured with
 * a hung test holding a live child handle, node:test prints its `✖` at this
 * ceiling and then the process NEVER EXITS — no summary, no exit code, a
 * wedged CI job on top of a red test. So this ceiling cannot be relied on to
 * report anything; `assertHeldToBound` is what actually catches an unbounded
 * run, in time to fail cleanly.
 *
 * Five times the longest run observed under 48-way CPU load (6.0 s), rather than
 * ten times the longest IDLE one (1.8 s), which is what 20 s was. The idle
 * figure is the wrong population for a backstop: at 20 s a loaded box was three
 * slow tests away from a timeout that reports nothing about orphans, and the
 * fixture deadlines below have deliberately been widened toward it.
 *
 * It has to stay clear of `FIXTURE_STARTUP_MS`, and that is now what sizes it.
 * A fixture that never starts must be reported BY ITS OWN GUARD, which names
 * what went wrong, and not by this ceiling, which names nothing and then wedges
 * the process; so the ceiling is the guard's own deadline plus room for the
 * bound, the sweep and the teardown that follow it. Derived rather than
 * written down, because the guard is now measured from the machine and a
 * constant here would silently overtake it on exactly the loaded box the
 * measurement exists for.
 */
const TEST_TIMEOUT_MS = FIXTURE_STARTUP_MS + 30_000;

const posixTest = (
  name: string,
  options: { timeout?: number },
  fn: () => Promise<void> | void,
): void => { test(name, { ...POSIX_ONLY, ...options }, fn); };

function alive(pid: number): boolean {
  try {
    // Signal 0 is the POSIX "does this process exist and may I signal it"
    // probe: it delivers nothing. Same uid throughout, so a live process
    // answers true and a dead one throws ESRCH.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * How long the pid took to disappear, or null if it outlived the budget.
 *
 * The returned figure is DIAGNOSTIC — it goes into the failure message of the
 * liveness assertion and nothing decides on it. Promptness is decided by
 * `ALLOWED_IN_FLIGHT_BEATS` instead, which is why the 25 ms poll no longer has
 * to be fine enough to measure a ceiling; it stays there because a tighter poll
 * costs nothing on the passing path, where the loop exits as soon as the tree
 * answers.
 */
async function waitForDeath(pid: number, budgetMs: number): Promise<number | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < budgetMs) {
    if (!alive(pid)) return Date.now() - startedAt;
    await sleep(25);
  }
  return null;
}

interface Tree {
  dir: string;
  /** The script the CHILD runs: it forks the grandchild, then hangs past the bound. */
  childScript: string;
  /** The script the GRANDCHILD runs, for tests that need it to narrate. */
  grandchildScript: string;
  pidFile: string;
  beatFile: string;
}

/**
 * A two-level process tree under `dir`.
 *
 * The grandchild is spawned WITHOUT `detached`, which is the realistic shape
 * and the only one a group kill can reach: a child that deliberately leaves its
 * parent's process group is beyond any signal the runner can address, and
 * `npm`, `sh`, `go test` and `gradlew` all keep their children in the group.
 *
 * It writes its pid once and then appends a byte every 50 ms, so the test can
 * assert on two independent facts — the process is gone, and it stopped DOING
 * anything. A pid check alone would be satisfied by a pid that was never
 * running.
 */
/**
 * The three ways a surviving descendant can defeat a bound, as fixture knobs.
 *
 * The defaults are the shape described above, and the two overrides are the
 * shapes the lane's first round of tests could not see. `holdsPipe` is what
 * makes a hang possible at all: `close` waits for the child to exit AND for
 * every pipe it handed down to close, so a descendant on the inherited stdout
 * suppresses the ONLY event the runner used to resolve on. `escapes` puts that
 * descendant beyond every signal the runner can address, which is what forces
 * a second resolution path rather than a better kill. `leaderExits` is the
 * forgotten `&` — `node server.js & exit 0` in a `test` script — where the
 * command the runner spawned is already reaped when the bound fires.
 */
interface TreeShape {
  holdsPipe?: boolean;
  escapes?: boolean;
  leaderExits?: boolean;
}

/**
 * A two-level process tree under `dir`.
 *
 * By default the grandchild is spawned WITHOUT `detached`, which is the
 * realistic shape and the only one a group kill can reach: a child that
 * deliberately leaves its parent's process group is beyond any signal the
 * runner can address, and `npm`, `sh`, `go test` and `gradlew` all keep their
 * children in the group.
 *
 * It writes its pid once and then appends a byte every 50 ms, so the test can
 * assert on two independent facts — the process is gone, and it stopped DOING
 * anything. A pid check alone would be satisfied by a pid that was never
 * running.
 */
function processTree(dir: string, shape: TreeShape = {}): Tree {
  const pidFile = path.join(dir, 'grandchild.pid');
  const beatFile = path.join(dir, 'grandchild.beat');
  const grandchild = [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `setInterval(() => fs.appendFileSync(${JSON.stringify(beatFile)}, 'x'), 50);`,
    'setTimeout(() => {}, 600000);',
  ].join('\n');
  const grandchildFile = path.join(dir, 'grandchild.js');
  fs.writeFileSync(grandchildFile, `${grandchild}\n`);
  const childFile = path.join(dir, 'child.js');
  const stdio = shape.holdsPipe ? "'inherit'" : "['ignore', 'ignore', 'ignore']";
  fs.writeFileSync(childFile, [
    "const fs = require('fs');",
    "const { spawn } = require('child_process');",
    `const forked = spawn(process.execPath, [${JSON.stringify(grandchildFile)}], `
      + `{ stdio: ${stdio}, detached: ${String(Boolean(shape.escapes))} });`,
    // Without `unref` the leader cannot exit no matter what else it does: an
    // un-unref'd ChildProcess handle keeps its own event loop alive until the
    // grandchild ends, which is the opposite of both shapes here.
    ...(shape.escapes || shape.leaderExits ? ['forked.unref();'] : []),
    // A leader that exits waits for its leftover to have ANNOUNCED itself
    // first. Not politeness: the group is now reaped when the run settles, and
    // for a leftover holding no pipe that is within milliseconds of this exit —
    // measured, the grandchild was killed before it had written its pid file,
    // so what failed was the fixture guard rather than the assertion. Racing
    // the fixture against the behaviour under test proves nothing about either.
    ...(shape.leaderExits
      ? [
        // NOT unref\'d: this interval is the only thing keeping the leader
        // alive, and it is what makes the exit deterministic.
        'setInterval(() => {',
        `  try { if (fs.statSync(${JSON.stringify(beatFile)}).size > 0) process.exit(0); } catch { /* not up yet */ }`,
        '}, 20);',
      ]
      : ['setTimeout(() => {}, 600000);']),
    '',
  ].join('\n'));
  return { dir, childScript: childFile, grandchildScript: grandchildFile, pidFile, beatFile };
}

/**
 * The grandchild's pid once it has announced itself, plus the proof it was
 * doing work. Both are FIXTURE GUARDS: without them a runner that failed to
 * start anything at all would satisfy every assertion about the aftermath.
 */
async function runningGrandchild(tree: Tree): Promise<number> {
  const deadline = Date.now() + FIXTURE_STARTUP_MS;
  while (Date.now() < deadline) {
    try {
      const pid = Number(fs.readFileSync(tree.pidFile, 'utf8'));
      const beats = fs.statSync(tree.beatFile).size;
      if (pid > 0 && beats > 0) return pid;
    } catch {
      // not up yet
    }
    await sleep(50);
  }
  assert.fail('fixture guard: the grandchild never started, so nothing was orphanable');
}

async function withTree(fn: (tree: Tree) => Promise<void>, shape: TreeShape = {}): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-pgroup-'));
  const tree = processTree(dir, shape);
  try {
    await fn(tree);
  } finally {
    // Never leave the machine dirtier than we found it, whatever the verdict.
    try {
      const pid = Number(fs.readFileSync(tree.pidFile, 'utf8'));
      if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
    } catch {
      // nothing survived, or nothing ever started
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Who adopted the orphan, for the failure message only.
 *
 * Built INSIDE the failure branch. As an `assert` message ARGUMENT it was
 * evaluated eagerly on every call, so every invocation shelled out to `ps` —
 * and where that spawn is not permitted, `.stdout` is undefined and the test
 * died with `TypeError: Cannot read properties of undefined` before the real
 * assertion ran, on the passing path as well as the failing one. Measured: all
 * three tests in this file failed that way under this repo's sandboxed shell,
 * naming nothing about orphans. A test whose verdict is decided by an
 * unrelated environment restriction is a false red, which is the class this
 * whole file exists to eliminate.
 */
function adoptiveParent(pid: number): string {
  try {
    return spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout?.trim() || '?';
  } catch {
    return '?';
  }
}

function beatsWritten(tree: Tree): number {
  // One byte per beat, so the file size IS the count.
  try {
    return fs.statSync(tree.beatFile).size;
  } catch {
    return 0;
  }
}

/**
 * The whole aftermath assertion, shared by both paths: gone, gone PROMPTLY, and
 * gone rather than merely un-signallable.
 *
 * IT MUST BE CALLED IN THE SAME TURN THE RUNNER RETURNED IN, because the first
 * statement below samples the leftover's heartbeat and that sample is what the
 * promptness claim is measured from — see `ALLOWED_IN_FLIGHT_BEATS`. Everything
 * before the first `await` here runs synchronously in the caller's continuation,
 * so `const result = await run;` followed by any number of synchronous
 * assertions and then this call is exactly the right shape. An `await` in
 * between would let the leftover beat for a turn that has nothing to do with the
 * reap.
 *
 * `reapIssued` is how a caller says the reap did NOT happen before it called:
 * the two cross-process rows signal a child runner and then look at the tree, so
 * the kill is somewhere in another process's signal handler and no synchronous
 * fact is available to either of them. Those rows are about liveness only, and
 * they say so rather than measuring the courier.
 */
async function assertTreeIsGone(tree: Tree, pid: number, reapIssued = true): Promise<void> {
  const atReturn = beatsWritten(tree);
  const deadAfterMs = await waitForDeath(pid, REAP_BUDGET_MS);
  if (deadAfterMs === null) {
    assert.fail(`the grandchild (pid ${pid}) outlived the runner — it is an orphan at ppid ${adoptiveParent(pid)}`);
  }
  // Liveness alone is not the claim the runner makes. A caller that starts the
  // next run the moment this one settles — against the same port — is protected
  // by the kill having ALREADY HAPPENED when the promise resolved, and what
  // makes that visible from out here is that the leftover wrote NOTHING more
  // afterwards. A reap deferred onto a timer shows up as the beats it wrote
  // while waiting for it.
  const beatsAfterReturn = beatsWritten(tree) - atReturn;
  if (reapIssued) {
    assert.ok(
      beatsAfterReturn <= ALLOWED_IN_FLIGHT_BEATS,
      'the reap must be part of settling, not something that merely happens later: the tree wrote '
      + `${beatsAfterReturn} more heartbeats after the runner returned (at most ${ALLOWED_IN_FLIGHT_BEATS} `
      + `in-flight write is allowed), and it was still alive ${deadAfterMs} ms later`,
    );
  }
  const atDeath = beatsWritten(tree);
  await sleep(300);
  assert.equal(
    beatsWritten(tree),
    atDeath,
    'the grandchild is still writing, so the pid check above found a recycled or reaped id rather than a dead process',
  );
}

posixTest('a timed-out native command kills the whole process group, not just its leader', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withTree(async (tree) => {
    const startedAt = Date.now();
    const run = runBoundedProcess([process.execPath, tree.childScript], tree.dir, BOUND_MS);
    const pid = await runningGrandchild(tree);
    const result = await run;
    assertHeldToBound(Date.now() - startedAt, BOUND_MS, 'a timed-out command');
    assert.equal(result.kind, 'timeout', 'fixture guard: the child must have been cut short by the bound');
    await assertTreeIsGone(tree, pid);
  });
});

// The output bound kills for a different reason and used to do it through the
// same direct-child call, so it orphans exactly the same way.
//
// Its cut-short instant is NOT its `timeoutMs`: the bound below is deliberately
// 80x too long, so that a timeout cannot be what ends the run. It is the moment
// the fixture starts overflowing, and that is what the timing assertion is
// measured from — the same kill, the same `close`, the same grace timer and the
// same allowance as every other shape here. Without it this was the one bounded
// test in the lane carrying no timing assertion at all, and it stayed green
// under a mutation that made every other bounded test fail.
//
// It scales with the same node-startup probe as `BOUND_MS`, and for the same
// premise: the delay exists so the grandchild is fully up before the overflow
// kills the group, so on a box where a startup costs half a second it has to be
// longer than a box where it costs forty milliseconds.
const OVERFLOW_AT_MS = Math.max(800, 5 * (NODE_STARTUP_MS ?? 0));

/**
 * What 8 MB costs to push through a pipe on this box, measured.
 *
 * THE OVERFLOW INSTANT IS NOT THE INSTANT THE FIXTURE STARTS WRITING, and the
 * ceiling above was anchored as if it were. The runner cuts the run short when
 * ITS OWN capture crosses `MAX_NATIVE_PROCESS_OUTPUT`, which cannot happen until
 * 8 MB has actually transited the pipe and been read on this side — a cost the
 * old anchor accounted for nowhere, and one that IO contention stretches without
 * limit. Observed under 40 CPU + 12 IO workers on 10 cores: settlement in 1439 ms
 * against a 1420 ms ceiling, with the kill and the reap both perfect. That is a
 * latent defect in the assertion rather than slack that needs widening: on an
 * idle box the transfer is fast enough to hide inside the 15% overrun allowance,
 * and the row passed for that reason and not because the term was accounted for.
 *
 * The probe is the same transfer through the same kind of pipe, doubled, so it
 * reports on the machine at the moment the file loads. Twice, because the fixture
 * writes 9 MB in one call while the probe's own child is a fresh node startup —
 * neither is exactly the other, and the direction of the error should be the one
 * that does not fail a correct runner.
 */
function pipeDrainMs(bytes: number): number | null {
  const startedAt = Date.now();
  const probe = spawnSync(process.execPath, ['-e', `process.stdout.write('x'.repeat(${bytes}))`], {
    maxBuffer: bytes * 2,
  });
  return probe.status === 0 ? Date.now() - startedAt : null;
}

const OVERFLOW_TRANSFER_MS = 2 * (pipeDrainMs(MAX_NATIVE_PROCESS_OUTPUT) ?? 500);

posixTest('a native command killed for overflowing its output bound also kills its group', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withTree(async (tree) => {
    // Same tree, plus 9 MB against the 8 MB capture bound — delayed, because
    // overflowing immediately would kill the group before the grandchild had
    // finished starting, and the run would prove nothing about orphans.
    fs.appendFileSync(
      tree.childScript,
      `setTimeout(() => { process.stdout.write('x'.repeat(9 * 1024 * 1024)); }, ${OVERFLOW_AT_MS});\n`,
    );
    const startedAt = Date.now();
    const run = runBoundedProcess([process.execPath, tree.childScript], tree.dir, 120_000);
    const pid = await runningGrandchild(tree);
    const result = await run;
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.kind, 'output-limit', 'fixture guard: the capture bound must be what cut it short');
    assert.ok(
      elapsedMs >= OVERFLOW_AT_MS,
      `fixture guard: the run cannot have ended before the overflow began, ended in ${elapsedMs} ms`,
    );
    assertSettledBy(
      elapsedMs,
      OVERFLOW_AT_MS + OVERFLOW_TRANSFER_MS,
      'a run killed for overflowing its capture bound',
    );
    await assertTreeIsGone(tree, pid);
  });
});

// The stack path is the one that motivated the item: a test suite is always
// reached through a package manager, so EVERY process that matters there is a
// grandchild or deeper. This asserts the whole chain — npm, its shell, the
// script, and the process the script forked — is gone.
posixTest('a timed-out stack check kills the whole process group', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withTree(async (tree) => {
    fs.writeFileSync(path.join(tree.dir, 'package.json'), JSON.stringify({
      name: 'orphan-probe',
      private: true,
      scripts: { test: `node ${JSON.stringify(tree.childScript)}` },
    }));
    const args = {
      projectRoot: tree.dir,
      timeoutMs: STACK_BOUND_MS,
      timeoutMsExplicit: true,
    } as unknown as RunnerArgs;
    const startedAt = Date.now();
    const checks = runStackChecks(args, ['stack-test']);
    // Both are awaited unconditionally, because `runningGrandchild` can
    // `assert.fail` and the run above is ALREADY IN FLIGHT. Throwing straight
    // past it left the run's promise forever un-awaited, so a fixture-guard
    // failure was reported over the top of a still-running runner and a live
    // child.
    const [guard, [check]] = await Promise.all([
      runningGrandchild(tree).catch((error: unknown) => error),
      checks,
    ]);
    if (typeof guard !== 'number') throw guard;
    const pid = guard;
    assertHeldToBound(Date.now() - startedAt, STACK_BOUND_MS, 'a timed-out stack check');
    // Precondition: the check really was cut short by the bound. Asserted on
    // the marker rather than the status, because `not-applicable` is also what
    // an undeclared command produces.
    assert.match(String(check?.summary), /inconclusive:/i, 'fixture guard: the bound must be what ended this check');
    await assertTreeIsGone(tree, pid);
  });
});

// THE TWO HANG SHAPES.
//
// Everything above asserts on the AFTERMATH of a bound that fired. Neither of
// the next two can: in both, the event the runner resolves on never arrives at
// all, so what is under test is that the run ENDS — with a verdict, at
// approximately the time the runner told its caller it would. They are the
// cases the lane's first round of tests structurally could not see, because
// every timing assertion in it was a lower bound.

// Shape one: the forgotten `&`. `node server.js & exit 0` in a `test` script
// leaves the package manager the runner spawned already reaped when the bound
// fires, with the leftover server still holding the stdout it inherited. This
// is the shape that measured 20 s and counting on a 2 s bound, because the kill
// was guarded on the LEADER being alive — the one case the group kill exists
// for was the one case it was skipped in.
posixTest('a command that exits leaving a child on its output pipe is bounded, not left pending', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withTree(async (tree) => {
    const startedAt = Date.now();
    const run = runBoundedProcess([process.execPath, tree.childScript], tree.dir, BOUND_MS);
    const pid = await runningGrandchild(tree);
    const result = await run;
    assertHeldToBound(Date.now() - startedAt, BOUND_MS, 'a command whose leftovers held its output pipe');
    assert.equal(
      result.kind,
      'abandoned',
      'a leader that has already exited was not "still running at its bound" — the kind must not claim it was',
    );
    assert.equal(
      result.exitCode,
      0,
      'fixture guard: the leader really did exit cleanly, so this is a timeout wearing another name if it reports one',
    );
    await assertTreeIsGone(tree, pid);
  }, { holdsPipe: true, leaderExits: true });
});

// Shape two: the descendant leaves the process group AND holds the pipe. No
// signal this runner can address reaches it, so a better kill cannot fix this
// one — `close` has to stop being the only way a run can end. The assertion is
// deliberately NOT that the escapee dies (nothing here could make it) but that
// the bound still produces a verdict, which is what makes it a bound rather
// than a best effort.
posixTest('a bound still settles when the surviving child is beyond every signal', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withTree(async (tree) => {
    const startedAt = Date.now();
    const run = runBoundedProcess([process.execPath, tree.childScript], tree.dir, BOUND_MS);
    await runningGrandchild(tree);
    const result = await run;
    const elapsedMs = Date.now() - startedAt;
    assertHeldToBound(elapsedMs, BOUND_MS, 'a bound whose kill reached nothing that could answer');
    assert.ok(
      elapsedMs >= BOUND_MS + FORCED_KILL_GRACE_MS,
      'fixture guard: `close` cannot fire while the escapee holds the pipe, so this shape MUST have been '
      + `settled by the grace timer — it settled in ${elapsedMs} ms, too fast to have waited for one`,
    );
    assert.equal(result.kind, 'timeout', 'the leader was alive at the bound, so this one really is a timeout');
  }, { holdsPipe: true, escapes: true });
});

// WHAT A CUT-SHORT RUN WROTE ON ITS WAY OUT.
//
// Capture used to bail on `forced`, which threw away exactly the bytes a reader
// most wants: the native path quotes `result.process.stderr` in the summary a
// human reads when a run comes back inconclusive, and the heartbeat quotes the
// byte count at every pulse. Both went stale one chunk before the kill, for a
// window the runner already bounds at FORCED_KILL_GRACE_MS.
//
// Measured through the escapee shape, because it is the one where the window is
// wide and the writer is certain to survive it: the kill reaches nothing, so the
// descendant on the inherited stdout keeps narrating until the grace timer
// settles the run.
//
// THE DISCRIMINATOR IS THE DESCENDANT'S OWN PARENT, not a clock, and that is a
// correction rather than a refinement. It used to narrate `t=<ms since its own
// boot>` and require a line at or past the BOUND, on the reasoning that the
// grandchild starts strictly later than the run does. True, and it silently
// assumes the grandchild starts SOON after: the two clocks have different
// origins, so the assertion is really "the fixture booted within a few
// milliseconds of the run", which is a statement about the machine. Observed
// under load, exactly there: `the last line captured was t=260 of a 1500 ms
// bound` — a fixture that came up 1.7 s late, narrated correctly through the
// whole grace window, and failed anyway.
//
// A descendant that outlives its parent is REPARENTED — to pid 1 on this
// platform — so `process.ppid` changing is the same event as the group kill
// reaching the leader, observed from inside the writer, with no duration
// anywhere in it. A captured line carrying the new parent was therefore written
// after the kill; a line carrying the leader's own pid was written before it, so
// seeing both is proof that capture spanned the kill rather than stopping at it.
posixTest('a run that was cut short keeps the output written after its kill', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withTree(async (tree) => {
    fs.appendFileSync(
      tree.grandchildScript,
      ["setInterval(() => process.stdout.write(`ppid=${process.ppid}\\n`), 50);", ''].join('\n'),
    );
    const run = runBoundedProcess([process.execPath, tree.childScript], tree.dir, BOUND_MS);
    await runningGrandchild(tree);
    const result = await run;
    assert.equal(result.kind, 'timeout', 'fixture guard: the bound must be what ended this run');
    const parents = [...result.stdout.matchAll(/^ppid=(\d+)$/gm)].map((match) => Number(match[1]));
    assert.ok(
      parents.length > 0,
      `fixture guard: the descendant must have narrated at all, got ${JSON.stringify(result.stdout.slice(0, 200))}`,
    );
    // The pre-kill half, as a fixture guard: without a line naming the LIVE
    // leader there is no before-state, and "every line says pid 1" would be
    // satisfied by a fixture that only started narrating after the kill.
    assert.ok(
      parents[0]! > 1,
      `fixture guard: the first captured line must name the live leader, not ${parents[0]} — capture has to `
      + 'span the kill for this row to be about the tail at all',
    );
    assert.ok(
      parents.some((ppid) => ppid !== parents[0]),
      'the tail a killed run wrote during its grace window is what the inconclusive summary quotes, and it '
      + `must survive to the caller — every captured line still named the live leader (${JSON.stringify(parents)}), `
      + 'so nothing written after the group kill reached it',
    );
  }, { holdsPipe: true, escapes: true });
});

// The interrupt door on the same incident. `detached` is what makes the group
// kills addressable and, on its own, what stops a Ctrl-C from reaching the
// tree: the child no longer shares the runner's foreground group. Without a
// reaper this lane would close the timeout-orphan path and open an
// interrupt-orphan path of exactly the same shape, with a bigger tree behind
// it. Driven through a REAL child runner, because the thing under test is a
// `process.on` in a process that is being signalled.
posixTest('an interrupted runner takes its process group with it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const repoRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT || process.cwd();
  const module = path.join(repoRoot, 'src/runners/qa-evidence/native-process.ts');
  assert.ok(fs.existsSync(module), `fixture guard: the driver must import the real module, not ${module}`);
  await withTree(async (tree) => {
    const driver = path.join(tree.dir, 'driver.mjs');
    fs.writeFileSync(driver, [
      `import { runBoundedProcess } from ${JSON.stringify(module)};`,
      // A bound far longer than this test: the run must be interrupted, never
      // reach its own timeout, or the reaper would not be what killed the tree.
      `void runBoundedProcess([process.execPath, ${JSON.stringify(tree.childScript)}], `
        + `${JSON.stringify(tree.dir)}, 600000);`,
      '',
    ].join('\n'));
    const runner = spawn(process.execPath, ['--import', 'tsx', driver], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let runnerStderr = '';
    runner.stderr?.on('data', (chunk: Buffer) => { runnerStderr += chunk.toString(); });
    const exited = new Promise<void>((resolve) => { runner.once('close', () => resolve()); });
    try {
      const pid = await runningGrandchild(tree).catch((error: unknown) => {
        assert.fail(`fixture guard: the driver never started a tree. Its stderr was: ${runnerStderr.trim() || '(none)'}`
          + ` (${String(error)})`);
      });
      process.kill(runner.pid!, 'SIGINT');
      await exited;
      // The runner must still DIE from the signal it handled. A reaper that
      // swallowed SIGINT would be a worse bug than the orphan it prevents.
      assert.ok(runner.killed || runner.signalCode !== null || runner.exitCode !== 0,
        'an interrupted runner must not survive its own interrupt handler');
      await assertTreeIsGone(tree, pid);
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
    }
  });
});

// THE RACE ONE SIGNAL LOSES.
//
// `killProcessGroup` sweeps the group up to `REAP_SWEEPS` times rather than
// signalling it once, and the argument for signalling once was false: `kill(2)`
// on a group queues a signal per member of the list it walks, so a member
// executing `fork(2)` on another core mid-walk yields a child that inherits the
// pgid and was never on that list. One sweep leaves it running.
//
// This is the shape the runner exists to bound — a leader spawning workers
// continuously — and it is the only test here whose fixture forks in a loop, so
// nothing else in the file can see the difference. Every figure names its FORK
// RATE, because the rate is the whole detector: against a leader forking flat
// out, one sweep left survivors in 15 of 24 trials with a median surviving
// group of 584, and three gapped sweeps in 0 of 24 across 48 trials; against
// one forking every 2 ms, a single sweep leaks 3 of 24. An earlier version of
// this comment recorded "13 of 24 ... two in 0 of 24" against the 2 ms rate,
// which spliced a max-rate count onto a slow-rate leader. The peer's
// independent 30 ms-gap run agreed at 0 of 12.
//
// THE SHAPE HAD TO BE A SUCCESS, not a timeout, and finding that out cost a
// mutation run: with `REAP_SWEEPS` cut to 1 the timeout fixture still passed 12
// rounds. A cut-short run reaps TWICE for reasons that have nothing to do with
// this constant — once in `forceStop` at the bound, once in `finish` when the
// grace window closes — and the second call re-sweeps because `groupEmpty` only
// latches on an ESRCH. So the timeout path is redundant against a fork race
// whatever `REAP_SWEEPS` says, and the paths that are NOT are the ones that reap
// exactly once: a successful run that left something behind (below), the
// interrupt reaper, and the server teardown's SIGKILL. The fixture is therefore
// the leftover shape — `node forker.js >/dev/null 2>&1 & sleep …; exit 0`, the
// forgotten `&` around a worker pool — with the redirect that lets `close` fire
// so the run settles, and a leader that lingers long enough for the leftover to
// be forking hard when the single reap lands.
//
// FOUR rounds, and the count is a mutation-detection budget rather than
// superstition — but only one of the two mutants here is loud. Cutting
// `REAP_SWEEPS` to 1 leaks in 3 of 3 runs at this count, and fails in the first
// round every time. Cutting `REAP_SWEEP_GAP_MS` to 0 leaked in 2 of 5 runs at
// this count and in 0 of 3 at eight rounds, so raising the count bought nothing
// measurable and the extra rounds were given back: with a couple of hundred
// members dying at once the loop usually keeps sweeping anyway, because the
// group is still answering when the gapless probe asks, and the leak needs the
// members to die FAST enough for that probe to be fooled. That constant is
// defended by its mechanism and by two observed leaks, not by this count.
//
// It cannot fail in the other direction on a slow box — a survivor is a
// survivor, and the count below is polled rather than sampled.
const FORK_RACE_RUNS = 4;
const FORK_RACE_BOUND_MS = 10_000;
/**
 * How far the leftover must have RAMPED before the leader exits — counted in
 * forks, not in milliseconds.
 *
 * It was a 200 ms sleep, and that is a guess about what a machine will have
 * managed in 200 ms rather than a statement about the fixture. Under load the
 * guess fails: confirmed at load average 55.5, the run reached the assertion
 * below with fewer than ten logged forks and the test failed at its FIXTURE
 * GUARD — an amber light reported as a red one, which is the worst of both
 * because the next reader cannot tell it from a real leak.
 *
 * Waiting for the count instead makes the ramp the same SHAPE on every machine
 * — two hundred forks is what 200 ms bought on an unloaded box — and it takes
 * as long as it takes. The obvious alternative, widening the threshold, was
 * right to refuse: it weakens the detector everywhere to accommodate one
 * machine.
 *
 * IT CANNOT GO VACUOUS, which is the property that makes a wait admissible
 * here. If the count never arrives the leader never exits, the run reaches
 * `FORK_RACE_BOUND_MS`, and `result.kind` is `timeout` rather than `completed`
 * — so the guard below fails loudly instead of measuring a leftover that was
 * never forking. A silent pass would need the leader to exit with the count
 * unmet, and the only thing that lets it exit IS the count.
 */
const FORK_RACE_MIN_FORKS = 200;

/** Every live pid in `pgid`, whether or not the leader managed to log it. */
function groupMembers(pgid: number): number[] | null {
  const out = spawnSync('ps', ['-Ao', 'pid=,pgid='], { encoding: 'utf8' }).stdout;
  if (typeof out !== 'string') return null;
  return out.split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((pair) => pair.length === 2 && pair[1] === pgid && pair[0]! > 0)
    .map((pair) => pair[0]!);
}

posixTest('a bounded command that forks while it is being killed still loses every member', { timeout: TEST_TIMEOUT_MS }, async () => {
  for (let round = 0; round < FORK_RACE_RUNS; round += 1) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-forkrace-'));
    const pidLog = path.join(dir, 'forked.log');
    const pgidFile = path.join(dir, 'leader.pgid');
    const rampedFile = path.join(dir, 'ramped');
    const childFile = path.join(dir, 'child.js');
    // `/bin/sleep` is the cheapest possible group member, and 2 ms is fast
    // enough that a sweep is all but guaranteed to land inside a `fork`.
    fs.writeFileSync(childFile, [
      "const fs = require('fs');",
      "const { spawn, spawnSync } = require('child_process');",
      // The leftover is NOT the group leader here — the shell that started it is,
      // and that shell exits — so the group id has to be asked for rather than
      // read off a pid. One `ps` at startup, before any forking begins.
      "const pgid = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout;",
      `fs.writeFileSync(${JSON.stringify(pgidFile)}, String(pgid).trim());`,
      // TWO per tick at 1 ms, because the window a single sweep can miss is the
      // duration of the kernel's walk over the member list — tens of
      // microseconds — so the detector's power is the fork RATE against it.
      // Measured on the mutant with one fork per 2 ms: 1 kill in 2 runs. At this
      // rate: 3 in 3.
      // The RAMP SIGNAL, published by the process doing the forking rather than
      // inferred by the one waiting for it: the leader sleeps until this file
      // exists, so "the leftover is forking hard" is observed instead of
      // assumed. Logged forks are what it counts, so it is the same number the
      // assertion below reads.
      'let logged = 0;',
      'setInterval(() => {',
      '  for (let i = 0; i < 2; i += 1) {',
      "    const kid = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });",
      '    kid.unref();',
      '    if (!kid.pid) continue;',
      `    fs.appendFileSync(${JSON.stringify(pidLog)}, kid.pid + '\\n');`,
      '    logged += 1;',
      `    if (logged === ${FORK_RACE_MIN_FORKS}) fs.writeFileSync(${JSON.stringify(rampedFile)}, '');`,
      '  }',
      '}, 1);',
      'setTimeout(() => {}, 600000);',
      '',
    ].join('\n'));
    let forked: number[] = [];
    let pgid = 0;
    try {
      // The redirect is load-bearing: a leftover holding the inherited stdout
      // keeps `close` from firing, and this run has to SETTLE for the single
      // settle-time reap to be the thing under test.
      // `[ -f ]` is a shell builtin, so the wait itself forks nothing into the
      // group being measured; only the 10 ms `sleep` does, and it is gone
      // before the next iteration asks again.
      const script = `${JSON.stringify(process.execPath)} ${JSON.stringify(childFile)} >/dev/null 2>&1 &`
        + ` while [ ! -f ${JSON.stringify(rampedFile)} ]; do sleep 0.01; done; exit 0`;
      const result = await runBoundedProcess(['/bin/sh', '-c', script], dir, FORK_RACE_BOUND_MS);
      assert.equal(
        result.kind,
        'completed',
        'fixture guard: the leader must EXIT, so the reap under test is the single one at settle time',
      );
      pgid = Number(fs.readFileSync(pgidFile, 'utf8'));
      assert.ok(pgid > 1, 'fixture guard: the leftover must have reported the group it was forking into');
      forked = fs.readFileSync(pidLog, 'utf8').trim().split('\n').filter(Boolean).map(Number);
      assert.ok(
        forked.length >= FORK_RACE_MIN_FORKS,
        `fixture guard: the leader must have forked repeatedly, logged ${forked.length}`,
      );
      // Two independent counts. The log UNDERCOUNTS by construction — a child
      // killed between `spawn` returning and its `appendFileSync` is never named
      // in it, and the probe measured 16 real survivors against 7 logged ones —
      // so the group scan is the sharper of the two. It is also the one that can
      // be unavailable (`ps` is a spawn, and where that is not permitted this
      // has no stdout), so neither is allowed to be the only assertion.
      //
      // POLLED, not sampled, and this is the one assertion in the file that must
      // be: two hundred processes are being torn down at once and their parent is
      // dying with them, so for a few milliseconds most of them are zombies —
      // which `kill(pid, 0)` reports as ALIVE. Sampling here measured 131 of 131
      // "survivors" under a sweep that had in fact reached all of them.
      // Promptness is asserted where it can be, in `assertTreeIsGone`; what this
      // test is about is whether a member is left running for good.
      const deadline = Date.now() + REAP_BUDGET_MS;
      let stillAlive = forked.filter((pid) => alive(pid));
      let members = groupMembers(pgid)?.filter((pid) => pid !== pgid) ?? null;
      while ((stillAlive.length > 0 || (members?.length ?? 0) > 0) && Date.now() < deadline) {
        await sleep(50);
        stillAlive = forked.filter((pid) => alive(pid));
        members = groupMembers(pgid)?.filter((pid) => pid !== pgid) ?? null;
      }
      assert.deepEqual(stillAlive, [], 'members the leader logged survived the sweep');
      if (members !== null) {
        assert.deepEqual(
          members,
          [],
          'the group still has members the leader never got to log — one signal to a group that is '
          + 'forking does not reach the child of a fork that was already in flight',
        );
      }
    } finally {
      for (const pid of new Set([...forked, ...(pgid > 1 ? groupMembers(pgid) || [] : [])])) {
        if (pid > 1 && alive(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// THE SHAPE WITH NO BOUND IN IT AT ALL.
//
// Everything above is about a run that was CUT SHORT — the framing was "both
// hang shapes", and that framing is why nobody looked at what a PASSING run
// leaves behind. The group kill had exactly two callers, the failure path and
// the interrupt reaper, and the reaper deregisters the moment a run settles. So
// a command that exited 0 with a descendant still alive was never reaped at
// all, and no test here could see it, because every shape in the file was a
// hang: this leftover holds no inherited pipe, `close` fires at once, and the
// verdict is a prompt and correct `passed`.
//
// It is the survivor incident at plan-guard/plan-readiness/completion.ts:636
// through the one door a bound cannot watch. And `detached` had made it worse
// than the leader-only kill it replaced: measured, the leftover used to share
// the runner's own process group, where a harness's `kill -TERM -<pgid>` and a
// terminal Ctrl-C both reached it, and now it sits alone in a group the reaper
// has already dropped.
posixTest('a run that SUCCEEDS still takes its process group with it', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withTree(async (tree) => {
    const startedAt = Date.now();
    const run = runBoundedProcess([process.execPath, tree.childScript], tree.dir, BOUND_MS);
    const pid = await runningGrandchild(tree);
    const result = await run;
    const elapsedMs = Date.now() - startedAt;
    // The verdict is the ordinary one, and it must stay ordinary: this is a
    // command that did what it was asked. A reap that cost the run its exit
    // code, its output or its promptness would be a cure worse than the
    // disease.
    assert.equal(result.kind, 'completed', 'a command that exited on its own was not cut short');
    assert.equal(result.exitCode, 0, 'nor did it fail');
    assert.ok(
      elapsedMs < BOUND_MS,
      'fixture guard: the BOUND must not be what ended this run — the leftover holds no pipe, so '
      + `\`close\` fires at once. Settled in ${elapsedMs} ms of a ${BOUND_MS} ms bound`,
    );
    await assertTreeIsGone(tree, pid);
  }, { leaderExits: true });
});

// The same shape at the product level, which is where it does its damage: a
// `test` script whose forgotten `&` redirects its output
// (`node server.js >/dev/null 2>&1 & exit 0`) reports a green stack-test with
// the server still listening. Measured before the settle-time reap: `passed in
// 121 ms` with the leftover alive in its own process group. Nothing downstream
// can catch that — the check is genuinely `passed`, on genuine evidence, and
// the damage lands on the NEXT run.
posixTest('a stack check that passes does not leave a server behind', { timeout: TEST_TIMEOUT_MS }, async () => {
  await withTree(async (tree) => {
    fs.writeFileSync(path.join(tree.dir, 'package.json'), JSON.stringify({
      name: 'quiet-forgotten-ampersand',
      private: true,
      scripts: { test: `node ${JSON.stringify(tree.childScript)}` },
    }));
    const args = {
      projectRoot: tree.dir,
      timeoutMs: STACK_BOUND_MS,
      timeoutMsExplicit: true,
    } as unknown as RunnerArgs;
    const startedAt = Date.now();
    const checks = runStackChecks(args, ['stack-test']);
    const [guard, [check]] = await Promise.all([
      runningGrandchild(tree).catch((error: unknown) => error),
      checks,
    ]);
    if (typeof guard !== 'number') throw guard;
    const elapsedMs = Date.now() - startedAt;
    // Asserted, not incidental: the check MUST be green here. An
    // implementation that reaped the group by reporting the run inconclusive
    // would satisfy every other assertion in this test and would have broken
    // the runner.
    assert.equal(check?.status, 'passed', 'the command exited 0 and its verdict must still be a pass');
    assert.doesNotMatch(String(check?.summary), /inconclusive:/i, 'nothing about this run was unknown');
    assert.ok(
      elapsedMs < STACK_BOUND_MS,
      `fixture guard: the bound must not be what ended this run, settled in ${elapsedMs} ms of a `
      + `${STACK_BOUND_MS} ms bound`,
    );
    await assertTreeIsGone(tree, guard);
  }, { leaderExits: true });
});

// THE DETACH HALF.
//
// The design comment's central claim is that this module does not permanently
// change its host's signal disposition: the listeners go on when the first run
// starts and come off when the last one settles. Only the ATTACH half was
// covered, and a refactor that broke the other one would silently produce a
// process that stops answering Ctrl-C — the exact outcome the comment promises
// cannot happen.
//
// Two tests, because they fail in different circumstances. This one is the
// discriminator for the BOOKKEEPING: it is the only assertion here that a
// leaked listener cannot satisfy, since a leaked reaper that still re-raises
// dies from a signal exactly like a default disposition does.
posixTest('a settled run leaves the host\'s signal disposition exactly as it found it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const counts = (): string => ['SIGINT', 'SIGTERM', 'exit']
    .map((event) => `${event}=${process.listenerCount(event)}`).join(' ');
  const before = counts();
  // A command that ends on its own, and no tree: what is under test is this
  // process's own listener table. Sampled SYNCHRONOUSLY after the call, because
  // `reapOnInterrupt` runs inside the promise's executor — anything awaited
  // first would race the settlement it is trying to observe.
  const run = runBoundedProcess([process.execPath, '-e', 'setTimeout(() => {}, 300)'], os.tmpdir(), BOUND_MS);
  const live = counts();
  const result = await run;
  // Preconditions: the reapers really were installed while the child was live,
  // and the child really ran — an equality asserted over a listener that never
  // existed, or a spawn that never happened, would pass for the wrong reason.
  assert.equal(result.kind, 'completed', 'fixture guard: the probe must have run and exited');
  assert.notEqual(live, before, `fixture guard: a live run must install its reapers, saw ${live}`);
  assert.equal(counts(), before, `a run that has settled must own nothing on this process (was ${live} while live)`);
});

// And the promise itself, in the shape the promise is about: a real process,
// signalled from outside, after a run of its own has come and gone. What this
// catches and the count test does not is a listener that stays installed and
// SWALLOWS — a handled SIGINT no longer terminates by default, so the process
// would sail past its interrupt and keep working.
posixTest('a process that has finished a bounded run still dies from Ctrl-C', { timeout: TEST_TIMEOUT_MS }, async () => {
  const repoRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT || process.cwd();
  const module = path.join(repoRoot, 'src/runners/qa-evidence/native-process.ts');
  await withTree(async (tree) => {
    const ready = path.join(tree.dir, 'settled');
    const survived = path.join(tree.dir, 'survived');
    const driver = path.join(tree.dir, 'driver.mjs');
    fs.writeFileSync(driver, [
      "import * as fs from 'fs';",
      `import { runBoundedProcess } from ${JSON.stringify(module)};`,
      // A run that ENDS, unlike the one in the interrupt test above: the
      // disposition under test is the one left behind after it settles.
      `const result = await runBoundedProcess([process.execPath, '-e', ''], ${JSON.stringify(tree.dir)}, 30000);`,
      `fs.writeFileSync(${JSON.stringify(ready)}, result.kind);`,
      // Long enough to be interrupted, and loud if it is not.
      `setTimeout(() => { fs.writeFileSync(${JSON.stringify(survived)}, '1'); process.exit(9); }, 10000);`,
      '',
    ].join('\n'));
    const runner = spawn(process.execPath, ['--import', 'tsx', driver], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let runnerStderr = '';
    runner.stderr?.on('data', (chunk: Buffer) => { runnerStderr += chunk.toString(); });
    const exited = new Promise<void>((resolve) => { runner.once('close', () => resolve()); });
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await sleep(50);
      assert.equal(
        fs.existsSync(ready) ? fs.readFileSync(ready, 'utf8') : '',
        'completed',
        `fixture guard: the driver must have run a bounded command to completion first. Its stderr was: ${runnerStderr.trim() || '(none)'}`,
      );
      process.kill(runner.pid!, 'SIGINT');
      await exited;
      assert.equal(
        runner.signalCode,
        'SIGINT',
        'a process whose only involvement with this module was one finished run must still die BY SIGINT — '
        + `a listener left installed would swallow it. Exited ${String(runner.exitCode)}`,
      );
      assert.equal(fs.existsSync(survived), false, 'and must not have carried on working past its interrupt');
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
    }
  });
});

// A host that traps Ctrl-C itself — to ask "are you sure?", or on the ordinary
// press-twice-to-force-quit convention — must see ONE press once. The re-raise
// was unconditional, so its handler ran twice for one press, and the second
// press it was waiting for had effectively already happened. The reap must
// still take the tree with it: not re-raising is not the same as standing down.
posixTest('a host with its own interrupt handler sees one Ctrl-C once, and still loses its tree', { timeout: TEST_TIMEOUT_MS }, async () => {
  const repoRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT || process.cwd();
  const module = path.join(repoRoot, 'src/runners/qa-evidence/native-process.ts');
  await withTree(async (tree) => {
    const seen = path.join(tree.dir, 'host-sigint-count');
    const release = path.join(tree.dir, 'host-may-exit');
    const driver = path.join(tree.dir, 'driver.mjs');
    fs.writeFileSync(driver, [
      "import * as fs from 'fs';",
      `import { runBoundedProcess } from ${JSON.stringify(module)};`,
      'let count = 0;',
      // The host's own handler, installed BEFORE the run, and deliberately not
      // exiting: this is what "a handled SIGINT no longer terminates" looks
      // like from the host's side.
      `process.on('SIGINT', () => { count += 1; fs.writeFileSync(${JSON.stringify(seen)}, String(count)); });`,
      `void runBoundedProcess([process.execPath, ${JSON.stringify(tree.childScript)}], `
        + `${JSON.stringify(tree.dir)}, 600000);`,
      // Outlives the interrupt on purpose, so "the host survived" is observable
      // rather than inferred from a missing signal — and it leaves when the TEST
      // says so, not on a wall clock.
      //
      // It was `setTimeout(() => process.exit(7), 4000)`, which is a race the
      // test cannot win on a loaded box: measured at 48-way, this test took
      // 5983 ms, so a startup slower than 4 s had the driver exiting before the
      // test signalled it, and the run then died on an ENOENT reading
      // `host-sigint-count` — a red with nothing to do with interrupts. A file
      // the test writes when it is done asserting has no such deadline.
      `const release = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(7); }, 25);`,
      // A driver that is never released must still not outlive the suite. This
      // is a leak guard, not the exit path: 10x the interrupt handling it waits
      // for, and only reachable if the test itself died first.
      'setTimeout(() => { clearInterval(release); process.exit(8); }, 60000).unref();',
      '',
    ].join('\n'));
    const runner = spawn(process.execPath, ['--import', 'tsx', driver], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let runnerStderr = '';
    runner.stderr?.on('data', (chunk: Buffer) => { runnerStderr += chunk.toString(); });
    const exited = new Promise<void>((resolve) => { runner.once('close', () => resolve()); });
    try {
      const pid = await runningGrandchild(tree).catch((error: unknown) => {
        assert.fail(`fixture guard: the driver never started a tree. Its stderr was: ${runnerStderr.trim() || '(none)'}`
          + ` (${String(error)})`);
      });
      process.kill(runner.pid!, 'SIGINT');
      // LIVENESS ONLY here: the kill is issued inside the driver's own signal
      // handler, in another process, with nothing this side can synchronise on —
      // unlike the row above, which waits for the driver to CLOSE and therefore
      // reaches this call after the reap has provably run. Asserting promptness
      // from here would be timing the courier: signal delivery plus a `tsx`
      // process's handler, which is exactly the kind of wall clock a busy machine
      // decides instead of the runner.
      await assertTreeIsGone(tree, pid, false);
      // Read BEFORE the release, because it is the state of a host that is still
      // running after its interrupt, and asserted again after the exit so a
      // second delivery arriving late cannot pass unnoticed.
      const seenWhileRunning = fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8') : '';
      fs.writeFileSync(release, '1');
      await exited;
      assert.equal(
        seenWhileRunning,
        '1',
        'the host asked to handle its own interrupt and must be told about it exactly once',
      );
      assert.equal(
        fs.readFileSync(seen, 'utf8'),
        '1',
        'and must not have been told again on its way out',
      );
      assert.equal(
        runner.exitCode,
        7,
        'a host that chose to keep running after Ctrl-C must not be killed by the reaper it merely imported — '
        + `it exited ${String(runner.exitCode)} / ${String(runner.signalCode)}`,
      );
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
    }
  });
});

// The stack path stopped enforcing its own output bound when it moved onto
// `runBoundedProcess`, but it still QUOTES one: the overflow summary names
// MAX_STACK_OUTPUT_BYTES to a human deciding whether to re-run. A literal that
// drifts from the bound actually applied would send that human to the wrong
// answer, and nothing else would notice.
test('the output bound the stack summary quotes is the bound the runner enforces', () => {
  assert.equal(MAX_STACK_OUTPUT_BYTES, MAX_NATIVE_PROCESS_OUTPUT);
});

// ── the two states of the sweep loop no machine will produce ─────────────────
//
// The fork-race test above is the only thing that ever exercised this loop, and
// it can only ever show the loop's ORDINARY path: the group dies, a probe says
// so, and the loop stops. Two states matter and neither is reachable from a
// real fixture, which is exactly why both survived mutation.
//
// The GAP is the first. It is a few milliseconds inside a settling path and
// nothing observable differs afterwards except a race that appears in 1 of 24
// runs, so `REAP_SWEEP_GAP_MS = 0` survived 30 tests across three files. The CAP
// is the second: reaching it needs a group that is still answering after three
// SIGKILLs, and 48 max-rate trials never got past the second sweep, so a mutant
// that latched `true` there survived too.
//
// With the signaller injected both are ordinary assertions. What is under test
// is the loop's SEQUENCE — signal, wait, ask, signal — which is the mechanism
// the fork race needs and the thing a gap of 0 removes. Each row would fail if
// its property were deleted outright, not only mutated: no gap, no
// wait-before-ask; no cap, no `false`.
const NEVER_TREE_KILLED = (): never => {
  throw new Error('the POSIX path must never reach taskkill');
};

/** A signaller that records what it was asked to do, and when. */
function recordingSignaller(groupAnswersUntilCall = Infinity): {
  calls: { pid: number; signal: NodeJS.Signals | 0; atMs: number }[];
  signal: (pid: number, signal: NodeJS.Signals | 0) => void;
} {
  const calls: { pid: number; signal: NodeJS.Signals | 0; atMs: number }[] = [];
  return {
    calls,
    signal: (pid, signal) => {
      calls.push({ pid, signal, atMs: Number(process.hrtime.bigint()) / 1e6 });
      // ESRCH once the group is meant to have gone: `process.kill` throws, and
      // the loop reads that as "nothing of ours is left".
      if (calls.length > groupAnswersUntilCall) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
  };
}

const deadLeader = { kill: () => {}, exitCode: 0, signalCode: null } as unknown as Parameters<typeof killProcessGroup>[1];

test('a sweep waits for the in-flight forks to land before it asks whether the group is empty', () => {
  const recorder = recordingSignaller();
  killProcessGroup(4242, deadLeader, 'SIGKILL', 'linux', NEVER_TREE_KILLED, recorder.signal);
  const kills = recorder.calls.filter((call) => call.signal === 'SIGKILL');
  const probes = recorder.calls.filter((call) => call.signal === 0);
  assert.equal(kills.length, REAP_SWEEPS, 'a group that keeps answering must be swept exactly REAP_SWEEPS times');
  assert.equal(probes.length, REAP_SWEEPS - 1, 'each sweep but the last asks once whether the group has gone');
  assert.deepEqual([...new Set(recorder.calls.map((call) => call.pid))], [-4242],
    'every signal and every probe addresses the GROUP, never the leader');
  for (let index = 0; index + 1 < recorder.calls.length; index += 2) {
    const gapMs = recorder.calls[index + 1]!.atMs - recorder.calls[index]!.atMs;
    // A LITERAL floor, deliberately not derived from the constant: an assertion
    // written as `>= REAP_SWEEP_GAP_MS` is satisfied by a mutant that sets the
    // constant to 0, which is the exact mutant this row exists to kill. One
    // millisecond is far below anything measured (a gapless probe lands in
    // ~0.03 ms) and far below the value itself.
    assert.ok(
      gapMs >= 1,
      `a probe taken ${gapMs.toFixed(3)}ms after its signal is asking before the forks that were in flight have `
      + 'landed — that is the emptiness the loop was fooled by, and the wait is what makes the sweep a sweep',
    );
    assert.ok(
      gapMs >= REAP_SWEEP_GAP_MS - 1,
      `the loop must spend the gap it declares (${REAP_SWEEP_GAP_MS}ms), and spent ${gapMs.toFixed(3)}ms`,
    );
  }
});

// The cap's return value is a CLAIM about what the caller may do next, and the
// caller is `finish` in native-process.ts, which latches on it. `false` there
// means "not known empty", which is what keeps a later settling event allowed to
// sweep — and on the successful path there is no later event, so this value is
// also the honest record that the run ended without ever seeing the group go.
test('a group still answering at the cap leaves the sweep unlatched, and one that goes empty latches it', () => {
  const capped = recordingSignaller();
  assert.equal(
    killProcessGroup(4242, deadLeader, 'SIGKILL', 'linux', NEVER_TREE_KILLED, capped.signal),
    false,
    'the cap must not claim the group is gone: nothing observed it go',
  );
  // One SIGKILL, then a probe that answers ESRCH.
  const emptied = recordingSignaller(1);
  assert.equal(
    killProcessGroup(4242, deadLeader, 'SIGKILL', 'linux', NEVER_TREE_KILLED, emptied.signal),
    true,
    'a probe told ESRCH has observed the group empty, and a later kill at that id could only reach a stranger',
  );
  assert.equal(emptied.calls.length, 2, 'and the loop stops there rather than spending the rest of its sweeps');
});

// The polite signal is a REQUEST, and the convention is that repeating it means
// "stop asking" — a dev server given three SIGTERMs inside a microsecond
// force-quits instead of flushing, which is the one thing `stopOwnedServer`
// sends it for.
// Its single sweep IS its cap, so it answers `false` for the same reason the
// capped SIGKILL above does: one polite request tells you nothing about whether
// anyone left. `stopOwnedServer` does not read it — the SIGTERM phase is
// followed by `teardownComplete`, which asks the group and the port directly.
test('a polite signal is sent once, not swept', () => {
  const recorder = recordingSignaller();
  assert.equal(killProcessGroup(4242, deadLeader, 'SIGTERM', 'linux', NEVER_TREE_KILLED, recorder.signal), false);
  assert.deepEqual(recorder.calls.map((call) => call.signal), ['SIGTERM']);
});

// The band, not the number. What is measured is that 0 leaks (1 of 24 trials on
// the peer's driver, 2 of 5 runs of the fixture above) and that both 5 and 30
// hold (0 of 24 across 48 trials, and 0 of 12 independently). Five is the small
// end because every reap of every run pays it. This fails on the mutant that
// deletes the wait and on a value outside what anyone has measured — it is not
// a re-typing of the literal, which is what the row above pins.
test('the reap sweep gap stays inside the band that was measured', () => {
  assert.ok(REAP_SWEEP_GAP_MS > 0, 'a gapless probe asks before the in-flight forks have joined the group');
  assert.ok(REAP_SWEEP_GAP_MS <= 30, 'nothing above 30ms has been measured, and every reap of every run pays this');
  assert.ok(REAP_SWEEPS >= 2, 'one sweep is the latch the fork race defeats');
});
