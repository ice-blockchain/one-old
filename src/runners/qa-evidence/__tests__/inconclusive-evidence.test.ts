// src/runners/qa-evidence/__tests__/inconclusive-evidence.test.ts
// A step that was CUT SHORT produced no evidence, and no evidence is neither a
// pass nor a failure.
//
// The defect these tests were written against: `runStackChecks` collapsed four
// causes into one arm — "could not spawn", "killed at its timeout", "killed for
// overflowing its output buffer" and "killed by a signal from outside" all
// became `not-applicable / "could not be executed"`. That prose is exactly what
// `validateQaReportV2` accepts as a JUSTIFIED exemption for stack-test,
// stack-lint, stack-format and stack-performance, so a test suite that hung
// until the runner killed it settled the run GREEN with zero test evidence, and
// so did one an OOM killer took out mid-flight. Measured on node
// v26.5.0/darwin: spawnSync reported a timeout as `status: null, error.code
// ETIMEDOUT`, a maxBuffer overflow as `status: null, error.code ENOBUFS`, and
// an external kill as `status: null, signal: SIGKILL` with NO error at all —
// invisible to a classifier reading the errno.
//
// The discipline here is the one src/test-support/__tests__/latency-budget.ts
// established for wall-clock budgets: a third value that is neither green nor
// red, made LOUD rather than silent so it cannot become a mute-by-deployment.
// Its rule 1 — never manufacture a red where there was a green — is pinned by
// the two "still settles" tests below, which cover every input that was
// legitimately excused before this change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  compileArchitecture,
} from '../../../shared/architecture-contract';
import {
  qaReportV2Path,
  readQaReportV2,
  validateQaReportV2,
} from '../../../shared/qa-report-v2';
import { compileVerificationContract, readVerificationContract } from '../../../shared/verification-contract';
import { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, STEP_TIMEOUT_MS, parseArgs } from '../cli';
import { main } from '../index';
import { LIGHTHOUSE_MIN_TIMEOUT_MS } from '../lighthouse';
import { XCRESULTTOOL_MAX_TIMEOUT_MS, nativeBoundMs, nativeRunCutShort } from '../native';
import {
  BOUNDED_PROCESS_KINDS,
  FORCED_KILL_GRACE_MS,
  runBoundedProcess,
  type BoundedProcessKind,
  type BoundedProcessResult,
} from '../native-process';
import { cutShortCause, resolveStackCommand, runStackChecks, stackBoundMs } from '../stack';
import { type RunnerArgs } from '../types';

const STATE = {
  mode: 'existing-codebase',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'none',
  mobile: { framework: 'none' },
};

/** The contract half of the fixtures below, with the guards that keep them honest. */
function compileNonvisualContract(cwd: string): void {
  const architecture = compileArchitecture(cwd, 'R', STATE, {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'mapper', name: 'Mapper', kind: 'service' }],
  });
  fs.writeFileSync(
    path.join(cwd, 'apps/web/src/lib/Mapper.ts'),
    'export const map = (value: string): string => value;\n',
  );
  const contract = compileVerificationContract(cwd, 'R', STATE, architecture, {
    changedPaths: ['apps/web/src/lib/Mapper.ts'],
  });
  assert.equal(contract.uiImpact, 'nonvisual', 'fixture guard: a web project, non-visual change');
  assert.equal(contract.browserRequired, false, 'fixture guard: the stack command owns this verdict');
  assert.ok(
    contract.requiredChecks.includes('stack-test'),
    'fixture guard: the contract must actually require the check under test',
  );
}

/**
 * A nonvisual web contract — `browserRequired: false`, so the `stack` command
 * owns the whole verdict — with the caller's choice of `test` script.
 */
function nonvisualProject(cwd: string, testScript: string): void {
  fs.mkdirSync(path.join(cwd, 'apps/web/src/lib'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'web',
    dependencies: { react: '19.0.0', vite: '7.0.0' },
    scripts: { build: 'node -e ""', test: testScript, 'format:check': 'node -e ""' },
  }));
  compileNonvisualContract(cwd);
}

/**
 * The same contract, but `stack-test` resolves to `go test ./...` — answered by
 * a fake `go` the caller puts on PATH.
 *
 * The indirection is load-bearing for the signal tests. A `package.json` script
 * runs under `npm run`, so a script that kills ITSELF kills a grandchild and
 * npm reports an ordinary non-zero exit — a `failed`, which is not the arm
 * under test. Dropping the `test` script falls through to the pinned Go default
 * (`resolveStackCommand`'s go.mod branch), whose bare `go` is the process the
 * runner spawns directly, so the signal that kills it is the signal the runner
 * observes. `build` and `format:check` stay declared, so the only check that
 * can move the verdict below is `stack-test`.
 */
function nonvisualGoTestProject(cwd: string): void {
  fs.mkdirSync(path.join(cwd, 'apps/web/src/lib'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'web',
    dependencies: { react: '19.0.0', vite: '7.0.0' },
    scripts: { build: 'node -e ""', 'format:check': 'node -e ""' },
  }));
  fs.writeFileSync(path.join(cwd, 'go.mod'), 'module web\n\ngo 1.22\n');
  compileNonvisualContract(cwd);
  const resolved = resolveStackCommand(cwd, 'stack-test');
  assert.deepEqual(
    'unavailable' in resolved ? null : [resolved.command, ...resolved.args],
    ['go', 'test', './...'],
    'fixture guard: stack-test must resolve to a command the runner spawns DIRECTLY',
  );
}

/**
 * A fake executable on PATH, running the given body under this node.
 *
 * PREPENDED rather than substituted for the whole PATH: `stack-build` and
 * `stack-format` must keep resolving the real `npm` and passing, so a rejected
 * report below is attributable to `stack-test` and not to a runner that could
 * suddenly find nothing at all.
 */
async function withFakeBinary(name: string, body: string, fn: () => Promise<void>): Promise<void> {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 't1-fake-bin-'));
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(file, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath || ''}`;
  try {
    await fn();
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

/**
 * A bound is a promise about when the runner STOPS, and only an upper bound
 * tests that half.
 *
 * Every timing assertion in this file was `elapsedMs >= bound`, which proves
 * the runner waited and can never prove it stopped — so when the timeout kill
 * was suppressed by a guard, these tests did not fail, they RAN FOREVER, and a
 * five-minute production ceiling silently became no ceiling at all. Measured
 * against that regression on the product shape: 20 s and counting on a 2 s
 * bound, with the heartbeat printing "10s of a 2s bound".
 *
 * The ceiling has three parts, and only one of them scales with the bound.
 *
 * `FORCED_KILL_GRACE_MS` is fixed by the runner, for the case where the kill
 * reaches nothing that can answer it. The RUNNER OVERHEAD is fixed by the
 * command: these invocations go through `main`, so the ceiling has to cover the
 * other required checks and the report write, measured at ~400 ms for a stack
 * run (two more `npm run` legs) and ~30 ms for a native one — an order of
 * magnitude apart, which is why it is an argument rather than one constant
 * sized for the larger. And the OVERRUN allowance is proportional, because
 * "badly overrunning" is a statement about a multiple of the bound rather than
 * about milliseconds: a flat 3 s admitted a 3.9x overrun at the smallest bound
 * here and caught a 4x one by a hundred milliseconds, while at the production
 * 300 s bound the same 3 s was 1%. Half the bound, capped so the large end
 * stays exactly as strict as the flat form already was there.
 */
const MAX_OVERRUN_FRACTION = 0.5;
const MAX_OVERRUN_MS = 2_000;
const STACK_RUN_OVERHEAD_MS = 1_200;
const NATIVE_RUN_OVERHEAD_MS = 300;

/** Signal 0 delivers nothing and answers "does this process still exist". */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertHeldToBound(elapsedMs: number, boundMs: number, what: string, overheadMs: number): void {
  assert.ok(
    elapsedMs >= boundMs,
    `fixture guard: ${what} must have waited out its ${boundMs} ms bound, waited ${elapsedMs} ms`,
  );
  const overrunMs = Math.min(MAX_OVERRUN_MS, Math.round(boundMs * MAX_OVERRUN_FRACTION));
  const ceiling = boundMs + FORCED_KILL_GRACE_MS + overheadMs + overrunMs;
  assert.ok(
    elapsedMs < ceiling,
    `${what} must also STOP at its bound — the runner announces one to its caller and `
    + `cli.ts promises "a command killed at this bound reports INCONCLUSIVE". Expected settlement within `
    + `${ceiling} ms (${boundMs} bound + ${FORCED_KILL_GRACE_MS} forced-kill grace + `
    + `${overheadMs} for the rest of the run + ${overrunMs} allowed overrun), took ${elapsedMs} ms`,
  );
}

async function withProject(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-inconclusive-'));
  try {
    await fn(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Capture this process's stderr around `fn` while still FORWARDING every byte.
 *
 * The forwarding is not politeness. node:test's reporter writes its own stream
 * through these same descriptors and flushes asynchronously, so a helper that
 * replaces `write` with `() => true` silently eats the reporter's records for
 * whatever it happens to be flushing — measured here: eight of this file's
 * fifteen tests disappeared from the run summary, which reported `tests 7 /
 * pass 7 / fail 0` and exit 0. A test count that a test file can quietly shrink
 * is exactly the "mistyped path passes clean" trap one layer in.
 */
async function captureStderr(fn: (soFar: () => string) => Promise<void>): Promise<string> {
  let captured = '';
  const errWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    return (errWrite as (...args: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    await fn(() => captured);
  } finally {
    process.stderr.write = errWrite;
  }
  return captured;
}

async function runStack(cwd: string, extra: readonly string[] = []): Promise<number> {
  return main(['stack', '--project-root', cwd, '--run-id', 'R', ...extra], cwd);
}

function onDiskReport(cwd: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(qaReportV2Path(cwd, 'R'), 'utf8')) as Record<string, unknown>;
}

// The headline false pass. A hung test suite is the single most expensive shape
// this runner can mis-certify: `stack-test` is the ONLY thing standing between
// untested source and a settled run on a nonvisual contract.
test('a test command killed at its timeout is rejectable, not a pass', async () => {
  await withProject(async (cwd) => {
    // Hangs until the runner kills it. `setTimeout` keeps the event loop alive
    // without burning CPU, so the wall clock below measures the BOUND, not the
    // machine.
    nonvisualProject(cwd, 'node -e "setTimeout(()=>{},600000)"');

    // Precondition, asserted before the verdict: the command RESOLVES, so the
    // outcome below cannot be the ordinary "project declares no test command"
    // exemption wearing a different hat. A verdict assertion with no precondition
    // assertion passes for the wrong reason.
    const resolved = resolveStackCommand(cwd, 'stack-test');
    assert.ok(!('unavailable' in resolved), 'fixture guard: the test command must resolve');

    const startedAt = Date.now();
    const code = await runStack(cwd, ['--timeout-ms', '1500']);
    const elapsedMs = Date.now() - startedAt;
    // Second precondition, and the bound's own contract. The lower half is what
    // stops this passing for a runner that skipped the command; the upper half
    // is what stops it passing for a runner that never stopped running it.
    assertHeldToBound(elapsedMs, 1_500, 'a hung test command', STACK_RUN_OVERHEAD_MS);

    const validated = readQaReportV2(cwd, 'R');
    assert.equal(validated.ok, false, 'a run with no test evidence must never validate');
    assert.equal(
      validated.ok === false ? validated.code : '',
      'required-check-failed',
      'the cut-short check must be REJECTABLE — this is the whole item',
    );
    assert.equal(code, 1, 'the runner must not exit 0 on a report no gate will accept');

    const check = (validated.ok ? [] : validated.report?.checks || [])
      .find((entry) => entry.id === 'stack-test');
    assert.equal(check?.status, 'not-applicable', 'a killed command never RAN, so it never failed either');
    assert.match(
      String(check?.summary),
      /inconclusive:/i,
      'the summary must say the step produced no verdict, not that it "could not be executed"',
    );
    assert.match(String(check?.summary), /1500/, 'the summary must name the bound that cut it short');

    // The consumer channel, read back from disk: `persistGateRejection` writes
    // the rejection into the artifact itself, so the file every downstream gate
    // opens no longer says `passed`. Checked by re-reading the file rather than
    // trusting the returned object — the whole class of defect on this surface
    // is a producer certifying an artifact it never read back.
    const disk = onDiskReport(cwd);
    assert.equal(disk.status, 'failed', 'the durable artifact must not read `passed`');
    assert.ok(
      (disk.gates as Array<Record<string, unknown>> | undefined)
        ?.some((gate) => gate.id === 'required-checks' && gate.status === 'failed'),
      'the rejection must be durable in the artifact, not only in this process',
    );
  });
});

// The other cut-short cause. The capture bound kills the child too, and the
// process it kills may have been about to exit 0 — measured: a child that wrote
// 9 MB and would have exited 0 comes back `kind: 'output-limit'`, with the exit
// code it was heading for never delivered.
//
// The MECHANISM here is not the one this file was written against. spawnSync
// enforced this with `maxBuffer` and reported `status: null, ENOBUFS`; the path
// is async now and the bound is `MAX_NATIVE_PROCESS_OUTPUT`, counted in
// `runBoundedProcess`'s own capture and enforced with a group kill. There is no
// `maxBuffer` and no `ENOBUFS` on this path any more. The DEFECT is identical
// either way, which is the point of the test: an overflow is not a verdict.
test('a test command killed for overflowing its output buffer is rejectable, not a pass', async () => {
  await withProject(async (cwd) => {
    // 9 MB against the runner's 8 MB capture bound, then a clean exit 0. Under
    // the old arm this exact command certified the run green.
    nonvisualProject(cwd, 'node -e "process.stdout.write(\'x\'.repeat(9*1024*1024))"');
    const resolved = resolveStackCommand(cwd, 'stack-test');
    assert.ok(!('unavailable' in resolved), 'fixture guard: the test command must resolve');

    const code = await runStack(cwd);
    const validated = readQaReportV2(cwd, 'R');
    assert.equal(validated.ok, false, 'an overflowed run produced no verdict either');
    assert.equal(validated.ok === false ? validated.code : '', 'required-check-failed');
    assert.equal(code, 1);

    const check = (validated.ok ? [] : validated.report?.checks || [])
      .find((entry) => entry.id === 'stack-test');
    assert.equal(check?.status, 'not-applicable');
    assert.match(String(check?.summary), /inconclusive:/i);
    assert.match(
      String(check?.summary),
      /output/i,
      'the summary must name the bound that cut it short, not blame the environment',
    );
    assert.equal(onDiskReport(cwd).status, 'failed');
  });
});

// The cut-short cause with an EXIT CODE, which is what makes it the most
// dangerous one on this path: every other cut-short arrives with `exitCode:
// null`, so a classifier that missed it would at worst reach the "could not be
// executed" exemption. This one exits 0, so a missing arm does not launder the
// run — it certifies it, straight through `if (run.exitCode === 0) passed`.
//
// The shape is the forgotten `&`: `node server.js & exit 0`, the ordinary
// mistake in an integration `test` script. The suite "passes" and leaves a
// server up, and that server holds the stdout it inherited from npm, so the
// `close` the runner resolves on never arrives. Both halves matter and are
// asserted below. The verdict must be INCONCLUSIVE — which is PARITY with the
// spawnSync path this replaced, where the same project reported `ETIMEDOUT` at
// its bound, not a new red invented here — and the leftover must be gone,
// because a survivor on a port is the mechanism behind the incident at
// plan-guard/plan-readiness/completion.ts:636, where one run's server answered
// every check of the next.
test('a test command that exits leaving a server behind is rejectable, not a pass', async () => {
  await withProject(async (cwd) => {
    // Outside the project tree on purpose: a stray `.js` at the project root is
    // a source file the verification contract does not cover, and the run would
    // be rejected `scan-incomplete` before it ever reached the arm under test.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 't1-leftover-'));
    const pidFile = path.join(outside, 'server.pid');
    const server = path.join(outside, 'leftover-server.js');
    fs.writeFileSync(server, [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'setTimeout(() => {}, 600000);',
      '',
    ].join('\n'));
    nonvisualProject(cwd, `node ${JSON.stringify(server)} & exit 0`);
    try {
      const startedAt = Date.now();
      const code = await runStack(cwd, ['--timeout-ms', '1500']);
      assertHeldToBound(Date.now() - startedAt, 1_500, 'a test command that leaked a server', STACK_RUN_OVERHEAD_MS);

      const validated = readQaReportV2(cwd, 'R');
      assert.equal(validated.ok, false, 'a suite whose output was truncated by its own leftovers proved nothing');
      assert.equal(validated.ok === false ? validated.code : '', 'required-check-failed');
      assert.equal(code, 1, 'the runner must not exit 0 on a report no gate will accept');

      const check = (validated.ok ? [] : validated.report?.checks || [])
        .find((entry) => entry.id === 'stack-test');
      assert.equal(check?.status, 'not-applicable');
      assert.match(String(check?.summary), /inconclusive:/i);
      assert.match(
        String(check?.summary),
        /exited 0/,
        'the summary must not claim the command was still running — it exited, and said so',
      );

      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(pid > 0, 'fixture guard: the leftover server must actually have started');
      assert.equal(
        processAlive(pid),
        false,
        `the leftover server (pid ${pid}) survived the run and will answer the NEXT run's checks`,
      );
    } finally {
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// The third cut-short cause, and the one that survived the first two fixes: the
// child is killed by something that is NOT this runner's own bound.
//
// A killed child reports `status: null` with NO error object — measured, on
// this file's own spawnSync options: `{ status: null, signal: 'SIGKILL', error:
// undefined }`. A classifier reading only the errno therefore saw nothing at
// all and fell into the "never started" arm, whose prose is the justified
// exemption. A suite that ran 412 tests and was then killed reported
// `status: passed`, runner exit 0, validator `ok: true`.
//
// Every signal below is something a real CI produces: SIGKILL from an OOM
// killer or a cgroup, SIGTERM from a job cancellation, SIGSEGV or SIGBUS from a
// native extension, SIGABRT from an assertion or a failed allocation. They are
// enumerated rather than sampled because the fix keys on the PRESENCE of a
// signal, and a fix that keyed on a list of names would pass a one-signal test
// while leaving the rest laundered.
for (const signal of ['SIGKILL', 'SIGTERM', 'SIGSEGV', 'SIGBUS', 'SIGABRT'] as const) {
  test(`a test command killed by ${signal} is rejectable, not a pass`, async () => {
    await withProject(async (cwd) => {
      nonvisualGoTestProject(cwd);
      await withFakeBinary('go', `process.kill(process.pid, '${signal}');`, async () => {
        const code = await runStack(cwd);

        const validated = readQaReportV2(cwd, 'R');
        assert.equal(validated.ok, false, 'a killed suite produced no test evidence, so nothing may validate');
        assert.equal(
          validated.ok === false ? validated.code : '',
          'required-check-failed',
          'the killed check must be REJECTABLE',
        );
        assert.equal(code, 1, 'the runner must not exit 0 on a report no gate will accept');

        const checks = validated.ok ? [] : validated.report?.checks || [];
        const check = checks.find((entry) => entry.id === 'stack-test');
        assert.equal(check?.status, 'not-applicable', 'a killed command never RAN, so it never failed either');
        assert.match(String(check?.summary), /inconclusive:/i);
        assert.match(
          String(check?.summary),
          new RegExp(`killed by ${signal}\\b`),
          'the summary must name the signal — "we could not tell" with no cause is not actionable',
        );

        // Attribution: the rejection is about the killed check specifically.
        // Without this the assertions above would hold just as well if the fake
        // PATH had broken every other command too.
        assert.deepEqual(
          checks.filter((entry) => entry.status !== 'not-applicable').map((entry) => `${entry.id}=${entry.status}`),
          ['stack-build=passed', 'stack-format=passed'],
          'only stack-test may be unresolved; the rest of the report must be ordinary and green',
        );
        assert.equal(onDiskReport(cwd).status, 'failed', 'the durable artifact must not read `passed`');
      });
    });
  });
}

// THE UNION ITSELF, rather than the four shapes the tests above happen to build.
//
// `BoundedProcessResult['kind']` has five members and exactly two consumers that
// matter, and the arm a member falls through to when nobody wrote one for it is
// the one that reads a zero exit code as a PASS. Both consumers were `if`-chains
// ending in `return null`, and nothing anywhere checked them for
// exhaustiveness: measured, a sixth member added to the union produced ZERO
// errors from `tsc --noEmit` — verified non-vacuous by planting a deliberate
// type error in the same file, which `tsc` did report. So a seventh kind added
// next year got no compile error and no test failure.
//
// Both are switches over the same exported list now, which makes a missing arm
// a compile error. This is the other half, and it is not redundant with it: a
// compile-time guard is defeated by a cast or an `any` at the boundary, and a
// runtime guard is defeated by nobody running the test. They fail in different
// circumstances.
test('every way a bounded run can end is classified by both consumers', () => {
  // The four that are cut short by KIND alone. `completed` and `unavailable`
  // are the two that must stay classifiable-as-fine, and they are opposite
  // facts: one ran to a verdict, the other never started.
  //
  // `start-failed` is the fourth and it is the one that had to be ADDED to the
  // union to be askable at all: an EMFILE refusal used to arrive as `completed`
  // with a null exit code, which both consumers read as "not cut short" because
  // their `completed` arm keys on the SIGNAL. The hole was one layer below this
  // loop — inside a branch keyed on `exitCode` — so this test could not have
  // seen it, and the repair is that the state now has a name here.
  const cutShortKinds = new Set(['timeout', 'output-limit', 'abandoned', 'start-failed']);
  const shape = (kind: BoundedProcessKind): BoundedProcessResult => ({
    kind,
    // Exit 0 deliberately: this is the value that becomes a false green if a
    // kind reaches the pass arm, so every member is probed carrying it.
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
  });
  for (const kind of BOUNDED_PROCESS_KINDS) {
    assert.equal(
      cutShortCause(shape(kind), 1_000) !== null,
      cutShortKinds.has(kind),
      `stack: '${kind}' is classified on the wrong side of the cut-short line`,
    );
    assert.equal(
      nativeRunCutShort(shape(kind)) !== null,
      cutShortKinds.has(kind),
      `native: '${kind}' is classified on the wrong side of the cut-short line`,
    );
  }

  // The fifth cut-short shape, and the only one that turns on a FIELD rather
  // than the kind: an external kill arrives as `completed` with a signal.
  const killed: BoundedProcessResult = { ...shape('completed'), exitCode: null, signal: 'SIGKILL' };
  assert.match(String(cutShortCause(killed, 1_000)), /SIGKILL/);
  assert.match(String(nativeRunCutShort(killed)), /SIGKILL/);

  // And the runtime half of the compile-time guard: a kind that reached these
  // functions despite the switch — through a cast, a JSON round-trip, an older
  // sidecar — must land on CUT SHORT, which is rejectable. The fail-closed
  // direction is the whole point; `null` here is the false green.
  const future = { ...shape('completed'), kind: 'reaped-by-cgroup' as BoundedProcessKind };
  assert.notEqual(cutShortCause(future, 1_000), null, 'an unrecognized ending must never read as a verdict');
  assert.notEqual(nativeRunCutShort(future), null, 'an unrecognized ending must never read as a verdict');
});

// latency-budget's rule 1, transplanted: the new classifier must not manufacture
// a red where there was a green. Every input the old arm legitimately excused
// still settles. This is the guard against the fix over-reaching into the two
// exemptions that were always honest.
test('a project that declares no test command still settles green', async () => {
  await withProject(async (cwd) => {
    fs.mkdirSync(path.join(cwd, 'apps/web/src/lib'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'web',
      dependencies: { react: '19.0.0', vite: '7.0.0' },
      scripts: { build: 'node -e ""' },
    }));
    const architecture = compileArchitecture(cwd, 'R', STATE, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapper', name: 'Mapper', kind: 'service' }],
    });
    fs.writeFileSync(
      path.join(cwd, 'apps/web/src/lib/Mapper.ts'),
      'export const map = (value: string): string => value;\n',
    );
    compileVerificationContract(cwd, 'R', STATE, architecture, {
      changedPaths: ['apps/web/src/lib/Mapper.ts'],
    });

    assert.equal(await runStack(cwd), 0, 'an undeclared command was always a justified exemption');
    const validated = readQaReportV2(cwd, 'R');
    assert.equal(validated.ok, true, validated.ok ? '' : `${validated.code}: ${validated.message}`);
    const check = validated.ok
      ? validated.report.checks.find((entry) => entry.id === 'stack-test')
      : undefined;
    assert.equal(check?.status, 'not-applicable');
    assert.doesNotMatch(String(check?.summary), /inconclusive:/i, 'an absent command is not inconclusive');
  });
});

// THIS ROW USED TO ASSERT THE OPPOSITE, and it was wrong — it read "a declared
// command whose binary is absent still settles green", and called that the
// second honest exemption on the grounds that the command never started, so
// nothing was cut short.
//
// The premise is true and the conclusion does not follow. Nothing was cut
// short, and nothing was measured either: the project declared a test command
// and zero tests ran. "Never started" is the right line for the INCONCLUSIVE
// marker, whose job is to name a signal death, and it is the wrong line for
// the EXEMPTION, whose job is to excuse a check the project never asked for.
// Sorting an environment gap by the first line put it on the excused side of
// the second, and the everyday fresh clone — a devDependency that never
// installed — settled verified with no test evidence.
//
// The check-level report is unchanged (still `not-applicable`, still not
// inconclusive, still the same prose); what changed is that it now carries the
// reason that separates it from a project with no test command at all, and the
// validator reads that reason instead of the prose. See
// __tests__/exemption-provenance.test.ts for all three views of this run and
// for the arm that is still exempt.
test('a declared command whose binary is absent cannot settle', async () => {
  await withProject(async (cwd) => {
    nonvisualProject(cwd, 't1-no-such-binary-9d3f1a');
    assert.equal(await runStack(cwd), 1, 'a declared suite that never ran is not a justified exemption');
    const validated = readQaReportV2(cwd, 'R');
    assert.equal(validated.ok, false, 'zero tests ran, and the validator must say so');
    assert.equal(validated.ok ? '' : validated.code, 'required-check-failed');
    const check = validated.report?.checks.find((entry) => entry.id === 'stack-test');
    assert.equal(check?.status, 'not-applicable', 'nobody observed a failure, so this is still not a red check');
    assert.equal(check?.notApplicable, 'declared-not-runnable', 'and the reason is what refuses it the exemption');
    assert.match(String(check?.summary), /could not be executed/i);
    assert.doesNotMatch(String(check?.summary), /inconclusive:/i, 'a command that never started was not cut short');
  });
});

// The discrimination the exemption now rests on, pinned at the primitive rather
// than inferred from the verdict above. `signal` is the ONLY thing separating a
// command that never started from one that was killed — both report
// `exitCode: null` and neither carries an error the classifier can read — so if
// a failed spawn ever started reporting one, every honest environment gap would
// become an inconclusive and the fix would have inverted itself.
test('a command that never started carries no signal, which is what keeps its exemption honest', async () => {
  const result = await runBoundedProcess(['t1-no-such-binary-9d3f1a'], process.cwd(), 30_000);
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null, 'a spawn that never happened cannot have been signalled');
});

// A green run must stay green, end to end, with the real gate reading the real
// artifact. Anchors the whole file: if this goes red the fix has broken the
// ordinary path rather than the dishonest one.
test('a test command that passes still settles green', async () => {
  await withProject(async (cwd) => {
    nonvisualProject(cwd, 'node -e ""');
    assert.equal(await runStack(cwd), 0);
    const validated = readQaReportV2(cwd, 'R');
    assert.equal(validated.ok, true, validated.ok ? '' : `${validated.code}: ${validated.message}`);
    assert.deepEqual(
      validated.ok ? validated.report.checks.map((check) => `${check.id}=${check.status}`) : [],
      ['stack-build=passed', 'stack-format=passed', 'stack-test=passed'],
    );
  });
});

// A red run must stay red AND keep its own diagnosis: a failing suite is a
// FAILURE, not an inconclusive. Collapsing the two would be the mirror defect —
// laundering a real red into "we could not tell".
test('a failing test command is still a failure, not an inconclusive', async () => {
  await withProject(async (cwd) => {
    nonvisualProject(cwd, 'node -e "process.exit(1)"');
    assert.equal(await runStack(cwd), 1);
    const [check] = await runStackChecks({ projectRoot: cwd } as unknown as RunnerArgs, ['stack-test']);
    assert.equal(check?.status, 'failed', 'an observed non-zero exit is evidence of failure');
    assert.doesNotMatch(String(check?.summary), /inconclusive:/i);
  });
});

// The validator half, pinned INDEPENDENTLY of the producer.
//
// Found by mutation: reverting `validateQaReportV2`'s inconclusive exclusion
// left every test above green, because the summary this runner now writes
// carries none of the prose the exemption matches on. That made the guard
// redundant against TODAY's producer and untested against any other — and the
// exemption is prose-matched, which is precisely why it must not depend on one
// producer continuing to phrase things a particular way. The report below is
// the shape the OLD arm wrote for a timeout: the exemption prose verbatim, with
// the marker added. The validator must refuse it on the marker alone.
test('the validator refuses an inconclusive check even when it wears the exemption prose', async () => {
  await withProject(async (cwd) => {
    fs.mkdirSync(path.join(cwd, 'apps/web/src/lib'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'web',
      dependencies: { react: '19.0.0', vite: '7.0.0' },
      scripts: { build: 'node -e ""' },
    }));
    const architecture = compileArchitecture(cwd, 'R', STATE, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapper', name: 'Mapper', kind: 'service' }],
    });
    fs.writeFileSync(
      path.join(cwd, 'apps/web/src/lib/Mapper.ts'),
      'export const map = (value: string): string => value;\n',
    );
    compileVerificationContract(cwd, 'R', STATE, architecture, {
      changedPaths: ['apps/web/src/lib/Mapper.ts'],
    });
    assert.equal(await runStack(cwd), 0, 'fixture guard: this report must start out ACCEPTED');
    assert.equal(readQaReportV2(cwd, 'R').ok, true, 'fixture guard: the exemption is live on this report');

    // Same status, same ids, same everything — only the summary changes, to the
    // exemption prose PLUS the marker.
    const report = onDiskReport(cwd);
    const checks = report.checks as Array<Record<string, unknown>>;
    const target = checks.find((check) => check.id === 'stack-test');
    assert.ok(target, 'fixture guard: stack-test must be present to be rewritten');
    assert.equal(target!.status, 'not-applicable');
    target!.summary = 'not run: `npm run test --silent` could not be executed '
      + '(inconclusive: it was still running at its 30000 ms bound and was killed)';
    fs.writeFileSync(qaReportV2Path(cwd, 'R'), JSON.stringify(report));

    const validated = readQaReportV2(cwd, 'R');
    assert.equal(validated.ok, false, 'the marker alone must defeat the exemption');
    assert.equal(validated.ok === false ? validated.code : '', 'required-check-failed');
  });
});

// The same guard from the other end, with the REAL summary a killed runner
// writes rather than a hand-built one.
//
// The exemption is prose-matched on two independent clauses, and the marker is
// a third condition on top. This asserts a killed check fails ALL THREE, so
// re-opening the false pass takes three regressions rather than one careless
// rewording of the producer — which matters because the producer is the only
// thing that has ever written this prose, and nothing stops a future arm from
// phrasing a kill as "could not be executed" again.
test('a killed runner\'s own summary matches no clause of the justified exemption', async () => {
  await withProject(async (killed) => {
    nonvisualGoTestProject(killed);
    let summary = '';
    await withFakeBinary('go', "process.kill(process.pid, 'SIGKILL');", async () => {
      const [check] = await runStackChecks({ projectRoot: killed } as unknown as RunnerArgs, ['stack-test']);
      assert.equal(check?.status, 'not-applicable', 'fixture guard: this is the arm the exemption reads');
      summary = String(check?.summary);
    });

    // The two halves of `justifiedNoStackCommand` in shared/qa-report-v2, quoted
    // verbatim. Restated here on purpose: importing the predicate would make
    // this test agree with whatever the validator does, which is the one thing
    // an independent pin must not do.
    assert.doesNotMatch(summary, /\bnot run:/i, 'the killed summary must not open with the exemption phrase');
    assert.doesNotMatch(
      summary,
      /\b(?:declares no|could not be executed)\b/i,
      'nor claim the command was absent or unrunnable — it ran',
    );

    // And end to end: transplanted onto a report the validator accepts TODAY,
    // it is refused. Without this the assertions above would only prove the
    // prose differs, not that the difference decides anything.
    await withProject(async (accepted) => {
      fs.mkdirSync(path.join(accepted, 'apps/web/src/lib'), { recursive: true });
      fs.writeFileSync(path.join(accepted, 'package.json'), JSON.stringify({
        name: 'web',
        dependencies: { react: '19.0.0', vite: '7.0.0' },
        scripts: { build: 'node -e ""' },
      }));
      compileNonvisualContract(accepted);
      assert.equal(await runStack(accepted), 0, 'fixture guard: this report must start out ACCEPTED');

      const report = onDiskReport(accepted);
      const target = (report.checks as Array<Record<string, unknown>>)
        .find((check) => check.id === 'stack-test');
      assert.equal(target?.status, 'not-applicable', 'fixture guard: same status, so only the summary changes');
      target!.summary = summary;
      fs.writeFileSync(qaReportV2Path(accepted, 'R'), JSON.stringify(report));

      const validated = readQaReportV2(accepted, 'R');
      assert.equal(validated.ok, false, 'the exemption must not cover a summary a killed runner wrote');
      assert.equal(validated.ok === false ? validated.code : '', 'required-check-failed');
    });
  });
});

// ---------------------------------------------------------------------------
// The native adapter: the same distinction, one runner over.
// ---------------------------------------------------------------------------

function setupNativeProject(cwd: string): void {
  fs.writeFileSync(path.join(cwd, 'Package.swift'), '// swift-tools-version:6.2\n');
  const state = {
    mode: 'new-project',
    stack: 'custom-frontend',
    frontend: 'none',
    backend: 'none',
    mobile: { framework: 'swift-native' },
  };
  const architecture = compileArchitecture(cwd, 'R', state, {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'home-screen', name: 'Home Screen', kind: 'page' }],
  });
  fs.mkdirSync(path.join(cwd, 'Features'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'Features/HomeView.swift'), 'struct HomeView {}\n');
  const contract = compileVerificationContract(cwd, 'R', state, architecture, {
    changedPaths: ['Features/HomeView.swift'],
  });
  assert.equal(contract.nativeAdapter, 'xcode-simulator', 'fixture guard: the xcode adapter must be selected');
}

/** A fake `xcodebuild` on PATH, running the given body under this node. */
async function withFakeXcodebuild(body: string, fn: () => Promise<void>): Promise<void> {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 't1-native-cutshort-'));
  const xcodebuild = path.join(bin, 'xcodebuild');
  fs.writeFileSync(xcodebuild, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(xcodebuild, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    await fn();
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

const XCODE_ARGV = [
  'xcodebuild', 'test', '-scheme', 'NativeApp',
  '-destination', 'platform=iOS Simulator,name=iPhone 16',
];

async function runNative(cwd: string, extra: readonly string[] = []): Promise<number> {
  return main([
    'native', '--run-id', 'R', '--native-command-json', JSON.stringify(XCODE_ARGV), ...extra,
  ], cwd);
}

// An adapter run that overflowed its captured-output bound was reported
// `failed` — "Native adapter xcode-simulator failed or produced no valid machine
// result" — for a build that was killed by the RUNNER and might have been about
// to pass. That is an invented red: nobody observed a failure. It is now the
// same rejectable inconclusive as everything else that was cut short.
test('a native adapter killed for overflowing its output bound is inconclusive, not failed', async () => {
  await withProject(async (cwd) => {
    setupNativeProject(cwd);
    await withFakeXcodebuild(
      // 9 MB against the runner's 8 MB bound, then a clean exit 0.
      "process.stdout.write('x'.repeat(9*1024*1024));",
      async () => {
        const code = await runNative(cwd);
        const result = readQaReportV2(cwd, 'R');
        assert.equal(result.ok, false, 'a cut-short adapter run is never a pass');
        assert.equal(
          result.ok === false ? result.code : '',
          'blocked-environment',
          'an overflow is "we could not tell", not "your app is broken"',
        );
        assert.equal(code, 2, 'blocked-environment exits 2, the same as every other unanswerable run');
        assert.match(
          result.ok === false ? result.message : '',
          /inconclusive:/i,
          'the blocker must say no verdict was observed',
        );
        assert.doesNotMatch(
          result.ok === false ? result.message : '',
          /environment unavailable/i,
          'the simulator was present; blaming the environment is a diagnosis the runner never made',
        );
      },
    );
  });
});

// The same shape one layer over: an adapter that finishes while a simulator, a
// Metro server or a Gradle daemon it started keeps the inherited stdout open.
// `xcodebuild` owning a simulator is the everyday form of it, and it is the
// only cut-short cause on this path that arrives WITH an exit code.
//
// It cannot be a false green — `passed` requires `kind === 'completed'` — so
// what a missing arm produces here is the OTHER defect this file exists to
// close, and the one the overflow case above was carved out of: "Native adapter
// xcode-simulator failed or produced no valid machine result", an invented red
// for a run whose only observed fact was an exit code the runner could not
// trust. Verified by mutation: with the `abandoned` arm removed from
// `nativeRunCutShort`, this test is the only thing in the suite that notices.
test('a native adapter that exits leaving a process on its output pipe is inconclusive, not failed', async () => {
  await withProject(async (cwd) => {
    setupNativeProject(cwd);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 't1-native-leftover-'));
    const pidFile = path.join(outside, 'leftover.pid');
    const leftover = path.join(outside, 'leftover.js');
    fs.writeFileSync(leftover, [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'setTimeout(() => {}, 600000);',
      '',
    ].join('\n'));
    try {
      await withFakeXcodebuild(
        // Forks something that inherits stdout, then exits 0 — `unref` because
        // an un-unref'd handle would keep the adapter itself alive and make
        // this an ordinary timeout instead.
        "const { spawn } = require('child_process');\n"
        + `spawn(process.execPath, [${JSON.stringify(leftover)}], { stdio: 'inherit' }).unref();`,
        async () => {
          const startedAt = Date.now();
          const code = await runNative(cwd, ['--timeout-ms', '1200']);
          assertHeldToBound(Date.now() - startedAt, 1_200, 'a native adapter that leaked a process', NATIVE_RUN_OVERHEAD_MS);

          assert.equal(code, 2, 'blocked-environment exits 2, the same as every other unanswerable run');
          const result = readQaReportV2(cwd, 'R');
          assert.equal(result.ok, false);
          assert.equal(
            result.ok === false ? result.code : '',
            'blocked-environment',
            'no machine result was produced, and an exit code the runner cannot trust is not a verdict',
          );
          const message = result.ok === false ? result.message : '';
          assert.match(message, /inconclusive:/i);
          assert.match(message, /exited 0/, 'the message must not claim the adapter was still running');
          assert.doesNotMatch(
            message,
            /failed or produced no valid machine result/i,
            'the invented red is the defect; an adapter nobody watched fail must not be reported as failing',
          );

          const pid = Number(fs.readFileSync(pidFile, 'utf8'));
          assert.ok(pid > 0, 'fixture guard: the leftover must actually have started');
          assert.equal(processAlive(pid), false, `the leftover (pid ${pid}) survived the adapter's bound`);
        },
      );
    } finally {
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// A timeout already produced `blocked-environment`, so the VERDICT was right —
// but it arrived through `nativeEnvironmentMissing`, so it said "Native
// environment unavailable for xcode-simulator". A present simulator running a
// slow suite and an absent simulator are different problems with different
// fixes, and the message named the wrong one.
test('a native adapter killed at its bound says so, instead of blaming a missing simulator', async () => {
  await withProject(async (cwd) => {
    setupNativeProject(cwd);
    await withFakeXcodebuild('setTimeout(()=>{}, 600000);', async () => {
      const startedAt = Date.now();
      const code = await runNative(cwd, ['--timeout-ms', '1200']);
      const elapsedMs = Date.now() - startedAt;
      // The adapter really ran, really was held to the bound, and really was
      // released by it.
      assertHeldToBound(elapsedMs, 1_200, 'a hung native adapter', NATIVE_RUN_OVERHEAD_MS);

      assert.equal(code, 2);
      const result = readQaReportV2(cwd, 'R');
      assert.equal(result.ok, false);
      assert.equal(
        result.ok === false ? result.code : '',
        'blocked-environment',
        'unchanged: a timeout was already rejectable, and must stay rejectable',
      );
      const message = result.ok === false ? result.message : '';
      assert.match(message, /inconclusive:/i);
      assert.match(message, /1200 ms bound/, 'the message must name the bound that cut it short');
      assert.match(message, /adapter was still running/, 'and this one really was the adapter');
      assert.doesNotMatch(message, /environment unavailable/i);
    });
  });
});

// WHICH of the two bounded commands was still running.
//
// The xcode path runs two: the adapter, then `xcresulttool` over the result
// bundle. It returned the PARSER's result as the run's `process` whenever the
// parser was what failed, and everything downstream reads that object as the
// adapter — so a hung `xcresulttool` was reported as "the xcode-simulator
// adapter was still running at its bound and was killed" about an adapter that
// had exited cleanly seconds earlier. A hung parser and a hung simulator are
// different problems with different fixes, and the reader was sent to the wrong
// one with no way to tell from the report.
test('a hung result-bundle parser is named as the parser, not as the adapter', async () => {
  await withProject(async (cwd) => {
    setupNativeProject(cwd);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 't1-native-parser-'));
    // The adapter SUCCEEDS here — it produces the bundle and exits 0 — which is
    // what makes the attribution observable: everything cut short after this
    // point belongs to the parser.
    fs.writeFileSync(path.join(bin, 'xcodebuild'), [
      `#!${process.execPath}`,
      "const fs = require('fs');",
      "const at = process.argv.indexOf('-resultBundlePath');",
      'fs.mkdirSync(process.argv[at + 1], { recursive: true });',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(bin, 'xcrun'), `#!${process.execPath}\nsetTimeout(() => {}, 600000);\n`);
    fs.chmodSync(path.join(bin, 'xcodebuild'), 0o755);
    fs.chmodSync(path.join(bin, 'xcrun'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      const code = await runNative(cwd, ['--timeout-ms', '1200']);
      assert.equal(code, 2, 'a run nobody could read is blocked, not failed');
      const result = readQaReportV2(cwd, 'R');
      assert.equal(result.ok === false ? result.code : '', 'blocked-environment');
      const message = result.ok === false ? result.message : '';
      assert.match(message, /inconclusive:/i);
      assert.match(
        message,
        /result-bundle parser was still running/,
        'the parser is what was killed, and the message must say so',
      );
      assert.doesNotMatch(
        message,
        /adapter was still running/,
        'the adapter exited cleanly before the parser ever started; claiming otherwise sends the reader to the wrong process',
      );
    } finally {
      process.env.PATH = previousPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
});

// The third cut-short cause on this path, and the one the stack fix named
// before this one adopted it. An `xcodebuild test` an OOM killer takes out
// reports `exitCode: null` with no error and no forced kind, so it fell through
// to `failed`: "Native adapter xcode-simulator failed or produced no valid
// machine result: exit null" — a red for a run in which nobody observed a
// failure. Rejectable either way, which is exactly why it survived; the defect
// was never the verdict class, it was the report saying something untrue.
//
// SIGSEGV as well as SIGKILL because they arrive from opposite directions — one
// is the machine killing the adapter, one is the adapter's own test host
// crashing — and a fix keying on a list of names rather than on the presence of
// a signal would cover only the first.
for (const signal of ['SIGKILL', 'SIGSEGV'] as const) {
  test(`a native adapter killed by ${signal} is inconclusive, not failed`, async () => {
    await withProject(async (cwd) => {
      setupNativeProject(cwd);
      await withFakeXcodebuild(`process.kill(process.pid, '${signal}');`, async () => {
        const code = await runNative(cwd);
        const result = readQaReportV2(cwd, 'R');
        assert.equal(result.ok, false, 'a killed adapter produced no evidence, so nothing may validate');
        assert.equal(
          result.ok === false ? result.code : '',
          'blocked-environment',
          'a killed adapter is "we could not tell", not "your app is broken"',
        );
        assert.equal(code, 2, 'blocked-environment exits 2, the same as every other unanswerable run');
        const message = result.ok === false ? result.message : '';
        assert.match(message, /inconclusive:/i);
        assert.match(
          message,
          new RegExp(`killed by ${signal}\\b`),
          'the message must name the signal — "we could not tell" with no cause is not actionable',
        );
        assert.doesNotMatch(
          message,
          /failed or produced no valid machine result/i,
          'the invented red is the whole defect and must not survive anywhere in the message',
        );
        // `kind` is 'completed' for a signal death, so the tail of this message
        // used to append the word "completed" to a sentence explaining that the
        // adapter had been killed before it could report.
        assert.doesNotMatch(message, /observed: completed/, 'the tail must not contradict the clause above it');
      });
    });
  });
}

// The arm the classification above must NOT swallow, and the reason it tests a
// forced kind and a signal rather than "no exit code": an adapter that ran and
// exited non-zero produced a real, observed verdict. Calling that inconclusive
// would launder every genuine native test failure into "we could not tell",
// which is the mirror defect and a far more expensive one.
test('an adapter that fails with an exit code is still a failure, not an inconclusive', async () => {
  await withProject(async (cwd) => {
    setupNativeProject(cwd);
    await withFakeXcodebuild(
      "process.stderr.write('** TEST FAILED **');\nprocess.exit(65);",
      async () => {
        const code = await runNative(cwd);
        assert.equal(code, 1, 'a failed run exits 1; a blocked one would exit 2');
        assert.equal(readQaReportV2(cwd, 'R').ok, false, 'a failing adapter is still not a settleable run');

        // Asserted on the durable artifact rather than the validator code,
        // because the validator rejects a `failed` native report on the first
        // unsatisfied required check and never reaches a verdict that would
        // tell these two arms apart. The status and the blocker do.
        const disk = onDiskReport(cwd);
        assert.equal(disk.status, 'failed', 'an observed non-zero exit is evidence of failure and must stay one');
        const blocker = String(disk.blockerSummary || '');
        assert.match(blocker, /failed or produced no valid machine result/i);
        assert.doesNotMatch(blocker, /inconclusive:/i, 'a verdict WAS observed, so nothing here is unknown');
        assert.doesNotMatch(blocker, /environment unavailable/i);
      },
    );
  });
});

// The other direction, so the classification above cannot swallow the case it
// was carved out of: an adapter that reports a genuinely absent simulator is
// still `blocked-environment` AND still says the environment is unavailable.
test('a genuinely missing simulator still reports the environment, not an inconclusive', async () => {
  await withProject(async (cwd) => {
    setupNativeProject(cwd);
    await withFakeXcodebuild(
      "process.stderr.write('Unable to find a destination matching the provided destination specifier');\nprocess.exit(70);",
      async () => {
        assert.equal(await runNative(cwd), 2);
        const result = readQaReportV2(cwd, 'R');
        assert.equal(result.ok, false);
        assert.equal(result.ok === false ? result.code : '', 'blocked-environment');
        assert.match(result.ok === false ? result.message : '', /environment unavailable/i);
        assert.doesNotMatch(
          result.ok === false ? result.message : '',
          /inconclusive:/i,
          'an absent simulator IS a diagnosis; it must not be laundered into "we could not tell"',
        );
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Heartbeat. A long step that emits nothing is indistinguishable from a hung
// one — observed 8co, where a silent runner was relaunched four times over one
// run directory. Anything bounded by `runBoundedProcess` can pulse WHILE it
// works, because it is promise-based and leaves the event loop free; the stack
// path acquired that when it moved off spawnSync, and both paths still announce
// their deadline up front, which is the only signal that arrives BEFORE the
// silence — asserted by the deadline test below.
// ---------------------------------------------------------------------------

test('a running native adapter reports that it is still alive', async () => {
  let result: BoundedProcessResult | null = null;
  const captured = await captureStderr(async () => {
    result = await runBoundedProcess(
      [process.execPath, '-e', 'setTimeout(()=>{}, 600)'],
      process.cwd(),
      30_000,
      { label: 'native probe', intervalMs: 100 },
    );
  });
  // Precondition: the child ran to completion on its own. A heartbeat count
  // asserted over a child that never started would pass for the wrong reason.
  assert.equal(result!.kind, 'completed', 'fixture guard: the probe must have run and exited');
  const beats = captured.split('\n').filter((line) => line.includes('native probe: still running'));
  assert.ok(beats.length >= 2, `a ~600 ms run at a 100 ms cadence must pulse repeatedly, saw ${beats.length}`);
  assert.match(beats[0]!, /\d+s of a 30s bound/, 'a heartbeat that carries no numbers cannot be audited');
});

// A heartbeat that outlives its work is worse than none: it reports liveness
// for a process that has exited. Measured as a DELTA rather than an absolute
// count, because a child that pulsed legitimately while it ran (`node -e ''`
// still costs ~40 ms of startup, which is two 20 ms intervals) would otherwise
// look like a leak.
test('a native adapter that finishes stops pulsing', async () => {
  const beats = (text: string): number => (
    text.split('\n').filter((line) => line.includes('native quick: still running')).length
  );
  let atCompletion = -1;
  let result: BoundedProcessResult | null = null;
  const captured = await captureStderr(async (soFar) => {
    result = await runBoundedProcess(
      [process.execPath, '-e', 'setTimeout(()=>{}, 150)'],
      process.cwd(),
      30_000,
      { label: 'native quick', intervalMs: 20 },
    );
    atCompletion = beats(soFar());
    // Long enough for ~25 further intervals if the timer outlived the child.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  });
  assert.equal(result!.kind, 'completed', 'fixture guard: the probe must have run and exited');
  assert.ok(atCompletion >= 2, `fixture guard: it must have pulsed while alive, saw ${atCompletion}`);
  assert.equal(beats(captured), atCompletion, 'a heartbeat must never outlive the work it reports on');
});

// The stack path's half of the same wire, which it acquired when it moved off
// spawnSync. Asserted with the cadence parameterised, because the default is
// ten seconds and a test that waited for it would cost more than every other
// test in this file combined — the same reason `runBoundedProcess` takes an
// `intervalMs` at all. What is being pinned is the WIRING: that a stack check
// hands `runBoundedProcess` a heartbeat, and that its label names the check, so
// an observer watching a three-command run can tell WHICH command is silent.
test('a running stack check reports that it is still alive', async () => {
  await withProject(async (cwd) => {
    nonvisualProject(cwd, 'node -e "setTimeout(()=>{}, 600)"');
    let checks: Awaited<ReturnType<typeof runStackChecks>> = [];
    const captured = await captureStderr(async () => {
      checks = await runStackChecks(
        { projectRoot: cwd } as unknown as RunnerArgs,
        ['stack-test'],
        100,
      );
    });
    // Precondition: the command ran to completion on its own. Heartbeats
    // counted over a check that was killed, or never started, would pass for
    // the wrong reason.
    assert.equal(checks[0]?.status, 'passed', 'fixture guard: the probe command must have run and exited 0');
    const beats = captured.split('\n').filter((line) => line.includes('stack stack-test: still running'));
    assert.ok(beats.length >= 2, `a ~600 ms command at a 100 ms cadence must pulse repeatedly, saw ${beats.length}`);
    assert.match(beats[0]!, /\d+s of a \d+s bound/, 'a heartbeat that carries no numbers cannot be audited');
  });
});

// A heartbeat that outlives its work reports liveness for a process that has
// exited — worse than none, and the failure the sequential loop makes easy to
// hit: three checks in a row, each leaving its timer behind, and the third
// command is reported as three concurrent ones.
test('a finished stack check stops pulsing before the next one starts', async () => {
  await withProject(async (cwd) => {
    nonvisualProject(cwd, 'node -e "setTimeout(()=>{}, 400)"');
    const captured = await captureStderr(async () => {
      const checks = await runStackChecks(
        { projectRoot: cwd } as unknown as RunnerArgs,
        ['stack-test', 'stack-build'],
        50,
      );
      assert.deepEqual(
        checks.map((check) => check.status),
        ['passed', 'passed'],
        'fixture guard: both checks must have run',
      );
      // Long enough for ~8 further intervals if a timer outlived its check.
      await new Promise((resolve) => { setTimeout(resolve, 400); });
    });
    const lines = captured.split('\n');
    const lastTestBeat = lines.findLastIndex((line) => line.includes('stack stack-test: still running'));
    const testFinished = lines.findIndex((line) => line.includes('stack stack-test: passed'));
    assert.ok(lastTestBeat >= 0 && testFinished >= 0, 'fixture guard: the check must have pulsed and then finished');
    assert.ok(
      lastTestBeat < testFinished,
      'a check that has reported its verdict must never pulse again — it is not running',
    );
  });
});

test('a stack command announces its bound and deadline before it goes silent', async () => {
  await withProject(async (cwd) => {
    nonvisualProject(cwd, 'node -e ""');
    const captured = await captureStderr(async () => {
      assert.equal(await runStack(cwd, ['--timeout-ms', '45000']), 0);
    });
    const announcement = captured.split('\n').find((line) => line.includes('stack stack-test:'));
    assert.ok(announcement, 'the stack runner must name the command it is about to block on');
    assert.match(announcement!, /bound 45000 ms/, 'the caller must be told how long the silence may last');
    assert.match(
      announcement!,
      /\d{4}-\d{2}-\d{2}T[\d:.]+Z/,
      'and when it must end — a deadline is what distinguishes a working runner from a dead one',
    );
  });
});

// ---------------------------------------------------------------------------
// --timeout-ms: a clamp, and a default sized to the command it bounds.
// ---------------------------------------------------------------------------

function parsed(argv: readonly string[]): RunnerArgs {
  const args = parseArgs(argv, '/tmp/project');
  assert.ok(args, `parseArgs must accept ${argv.join(' ')}`);
  return args!;
}

// The flag admitted a value only when it was already in range and SILENTLY
// substituted the default otherwise — so `--timeout-ms 600000`, a caller asking
// for ten minutes, got thirty seconds. Asking for more time must never yield
// less time than asking for nothing.
test('--timeout-ms clamps into range instead of silently resetting to the default', () => {
  assert.equal(parsed(['stack', '--timeout-ms', '600000']).timeoutMs, 300_000, 'over the ceiling clamps DOWN to the ceiling');
  assert.equal(parsed(['stack', '--timeout-ms', '500']).timeoutMs, 1_000, 'under the floor clamps UP to the floor');
  assert.equal(parsed(['stack', '--timeout-ms', '45000']).timeoutMs, 45_000, 'an in-range value is honoured verbatim');
  assert.equal(parsed(['stack', '--timeout-ms', '45000.9']).timeoutMs, 45_000, 'a fractional value is floored');
});

// A value that is not a number carries no request to clamp. It falls back to the
// command's default, exactly as an absent flag does.
test('a non-numeric --timeout-ms falls back to the command default', () => {
  assert.equal(parsed(['stack', '--timeout-ms', 'abc']).timeoutMs, parsed(['stack']).timeoutMs);
  assert.equal(parsed(['browser', '--timeout-ms', '']).timeoutMs, parsed(['browser']).timeoutMs);
});

// The plan item's "default 300s" applies to the bounds that wrap a WHOLE
// command — a test suite, an xcodebuild run. It deliberately does not apply to
// the per-action browser waits, which is the same knob feeding
// `page.goto(..., { timeout })`: raising those to 300 s would multiply the wall
// clock of reporting one hung route by ten and buy nothing.
test('the whole-command bounds default to the ceiling, the per-action bounds do not', () => {
  assert.equal(parsed(['stack']).timeoutMs, 300_000);
  assert.equal(parsed(['native']).timeoutMs, 300_000);
  assert.equal(parsed(['browser']).timeoutMs, 30_000);
  assert.equal(parsed(['lighthouse']).timeoutMs, 30_000);
  assert.equal(parsed(['manifest']).timeoutMs, 30_000);
  // Pinned so the default and the ceiling cannot drift apart: the whole-command
  // default IS the most this flag will admit, which is what makes it a bound a
  // caller can never usefully raise.
  assert.equal(
    parsed(['stack']).timeoutMs,
    parsed(['stack', '--timeout-ms', '999999999']).timeoutMs,
    'the whole-command default must equal the clamp ceiling',
  );
});

// The clamp is only worth anything if it is TOTAL: every one of these inputs is
// something a caller, a script or a mangled env var can actually produce, and
// none of them may escape the range or hand a timer a value it cannot honour.
// `setTimeout(NaN)` fires immediately and `spawnSync({ timeout: -1 })` throws —
// either would turn the bound into a fresh source of false verdicts.
test('the --timeout-ms clamp is total: no input escapes the range', () => {
  const hostile = [
    '0', '-1', '-600000', '1', '999', '1000', '300000', '300001', '1e9', '1e-9',
    'NaN', 'Infinity', '-Infinity', 'abc', '', ' ', '30_000', '0x7530', '1,000',
    '30000ms', 'null', 'undefined', '  45000  ', '+45000', '9007199254740993',
  ];
  for (const raw of hostile) {
    for (const command of ['stack', 'native', 'browser', 'lighthouse', 'manifest']) {
      const { timeoutMs } = parsed([command, '--timeout-ms', raw]);
      assert.ok(
        Number.isSafeInteger(timeoutMs),
        `${command} --timeout-ms ${JSON.stringify(raw)} produced ${timeoutMs}, which no timer can honour`,
      );
      assert.ok(
        timeoutMs >= MIN_TIMEOUT_MS && timeoutMs <= MAX_TIMEOUT_MS,
        `${command} --timeout-ms ${JSON.stringify(raw)} escaped the clamp with ${timeoutMs}`,
      );
    }
  }
});

// A stack check is a whole external command wherever it runs, including as a
// leg of `browser` — whose default is the per-step thirty seconds sized for a
// Playwright navigation. While being killed was laundered into a justified
// exemption that under-sizing was invisible; now that it is loud, inheriting it
// would MANUFACTURE inconclusives on slow-but-healthy builds. So an inherited
// default widens and an explicit request does not.
test('a stack check does not inherit the per-step default from a browser run', () => {
  assert.equal(stackBoundMs(parsed(['browser'])), MAX_TIMEOUT_MS, 'inherited per-step default widens');
  assert.equal(parsed(['browser']).timeoutMs, STEP_TIMEOUT_MS, 'the browser navigation bound itself is untouched');
  assert.equal(stackBoundMs(parsed(['stack'])), MAX_TIMEOUT_MS);
  // An explicit request is authoritative in BOTH directions — including a
  // deliberately short one, which is how a caller bounds a known-hanging suite.
  assert.equal(stackBoundMs(parsed(['browser', '--timeout-ms', '5000'])), 5_000);
  assert.equal(stackBoundMs(parsed(['stack', '--timeout-ms', '5000'])), 5_000);
  // A directly-constructed RunnerArgs carries no bound. Both things that could
  // then happen are outcomes this must never produce: spawnSync read a missing
  // timeout as UNBOUNDED — the hang the whole item is about — and the
  // `setTimeout` that enforces the bound today fires IMMEDIATELY on a NaN,
  // which manufactures an inconclusive on a healthy command.
  assert.equal(stackBoundMs({} as RunnerArgs), MAX_TIMEOUT_MS);
  assert.equal(stackBoundMs({ timeoutMs: 0 } as RunnerArgs), MAX_TIMEOUT_MS);
  assert.equal(stackBoundMs({ timeoutMs: 5_000 } as RunnerArgs), MAX_TIMEOUT_MS, 'a bound with no explicit flag is not trusted');
});

// The native path took its bound RAW, from the same directly-constructed
// RunnerArgs the clamp above exists for — and this is the caller shape
// `stackBoundMs`'s own docstring was written about. `setTimeout(fn, NaN)` fires
// immediately, so an `xcodebuild` given no bound would have been killed before
// it started and reported the manufactured INCONCLUSIVE that docstring names.
test('a native run clamps a bound it was never given, instead of firing its timer at once', () => {
  assert.equal(nativeBoundMs(parsed(['native'])), MAX_TIMEOUT_MS);
  assert.equal(nativeBoundMs(parsed(['native', '--timeout-ms', '5000'])), 5_000, 'a real invocation is honoured verbatim');
  assert.equal(nativeBoundMs({} as RunnerArgs), MAX_TIMEOUT_MS);
  assert.equal(nativeBoundMs({ timeoutMs: 0 } as RunnerArgs), MAX_TIMEOUT_MS);
  assert.equal(nativeBoundMs({ timeoutMs: Number.NaN } as RunnerArgs), MAX_TIMEOUT_MS);
  assert.equal(nativeBoundMs({ timeoutMs: -1 } as RunnerArgs), MAX_TIMEOUT_MS);
  assert.equal(nativeBoundMs({ timeoutMs: Number.POSITIVE_INFINITY } as RunnerArgs), MAX_TIMEOUT_MS);
  // Deliberately NOT stackBoundMs's rule: a native run is never a leg of
  // another command, so there is no inherited per-step default to distrust and
  // a number the caller supplied is the only bound that exists.
  assert.equal(nativeBoundMs({ timeoutMs: 5_000 } as RunnerArgs), 5_000);
});

// An audit of every duration this runner honours (20 sites) found each one
// either derived from this flag or a constant far below it, and exactly two
// that narrow it further. A NARROWING step is safe by construction — but only
// while it narrows. Raising either constant past the ceiling would let a step
// outlive the bound its own --help promises, silently, from a file nowhere near
// the flag. These two lines are the drift guard.
test('no step can outlive the --timeout-ms ceiling it narrows', () => {
  assert.ok(
    LIGHTHOUSE_MIN_TIMEOUT_MS <= MAX_TIMEOUT_MS,
    `the Lighthouse floor (${LIGHTHOUSE_MIN_TIMEOUT_MS}) must stay under the ceiling (${MAX_TIMEOUT_MS})`,
  );
  assert.ok(
    XCRESULTTOOL_MAX_TIMEOUT_MS <= MAX_TIMEOUT_MS,
    `the xcresulttool cap (${XCRESULTTOOL_MAX_TIMEOUT_MS}) must stay under the ceiling (${MAX_TIMEOUT_MS})`,
  );
  // Both narrow a request that arrives at the ceiling, so neither can widen one.
  assert.equal(Math.max(MAX_TIMEOUT_MS, LIGHTHOUSE_MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  assert.equal(Math.min(MAX_TIMEOUT_MS, XCRESULTTOOL_MAX_TIMEOUT_MS), XCRESULTTOOL_MAX_TIMEOUT_MS);
});

// The other door into the same laundering, and the one every test above walked
// past: the validator's cut-short rejection lived INSIDE its requiredChecks
// loop, so the guarantee held only for ids that happened to be on that list.
// `requiredChecks('nonvisual')` omits `stack-lint` exactly as
// `requiredChecks('behavioral')` omits `stack-test`, the blanket rule fires only
// on `failed`, and a cut-short check is `not-applicable` with `inconclusive:`
// prose — so an id off the list carried a killed command into a settling report.
//
// Constructed rather than produced, because no producer can currently reach it:
// measured across all five impact classes, `runStackChecks`,
// `computeBrowserCheckStatuses` and `nativeCheckStatuses` each emit exactly the
// ids they are handed, which are `contract.requiredChecks`. That is precisely
// why it needs a test — the property was resting on an invariant held in three
// other files and asserted in none of them, and the first producer to report a
// check it was not asked for would have laundered a signal death with nothing
// failing anywhere. Both halves are asserted: the clean report still settles
// (rule 1 — never manufacture a red where there was a green), and the same
// report plus one cut-short check does not.
test('a cut-short check the contract never required is rejectable too, not a settling not-applicable', async () => {
  await withProject(async (cwd) => {
    nonvisualProject(cwd, 'node -e ""');
    assert.equal(await runStack(cwd), 0, 'fixture guard: every required check passes, so the run must settle');

    const contract = readVerificationContract(cwd, 'R');
    assert.ok(contract, 'fixture guard: the contract must be readable back');
    assert.equal(
      contract.requiredChecks.includes('stack-lint'),
      false,
      'fixture guard: the id under test must be one the contract does NOT require',
    );

    const report = onDiskReport(cwd);
    assert.equal(
      validateQaReportV2(report, cwd, 'R', contract).ok,
      true,
      'fixture guard: the unmutated report is the green this must not manufacture a red out of',
    );

    const laundered = {
      ...report,
      checks: [
        ...(report.checks as unknown[]),
        {
          id: 'stack-lint',
          status: 'not-applicable',
          summary: 'inconclusive: `npm run lint` produced no verdict because it overflowed the 8388608 byte '
            + 'capture bound and was killed after 4211 ms (package.json scripts.lint). No evidence exists in '
            + 'either direction; re-run it, or raise --timeout-ms if the command legitimately needs longer.',
        },
      ],
    };
    const verdict = validateQaReportV2(laundered, cwd, 'R', contract);
    assert.equal(verdict.ok, false, 'a killed command proves nothing whether or not its id is on a list');
    assert.equal(
      verdict.ok === false ? verdict.code : '',
      'required-check-failed',
      'one condition — a check with no verdict — must not report two codes depending on the id',
    );
  });
});
