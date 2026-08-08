// src/runners/qa-evidence/__tests__/inconclusive-evidence.test.ts
// A step that was CUT SHORT produced no evidence, and no evidence is neither a
// pass nor a failure.
//
// The defect these tests were written against: `runStackChecks` collapsed three
// causes into one arm — "could not spawn", "killed at its timeout" and "killed
// for overflowing its output buffer" all became
// `not-applicable / "could not be executed"`. That prose is exactly what
// `validateQaReportV2` accepts as a JUSTIFIED exemption for stack-test,
// stack-lint, stack-format and stack-performance, so a test suite that hung
// until the runner killed it settled the run GREEN with zero test evidence.
// Measured on node v26.5.0/darwin: spawnSync reports a timeout as
// `status: null, error.code ETIMEDOUT` and a maxBuffer overflow as
// `status: null, error.code ENOBUFS` — both land in that arm.
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
} from '../../../shared/qa-report-v2';
import { compileVerificationContract } from '../../../shared/verification-contract';
import { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, STEP_TIMEOUT_MS, parseArgs } from '../cli';
import { main } from '../index';
import { LIGHTHOUSE_MIN_TIMEOUT_MS } from '../lighthouse';
import { XCRESULTTOOL_MAX_TIMEOUT_MS } from '../native';
import { runBoundedProcess, type BoundedProcessResult } from '../native-process';
import { resolveStackCommand, runStackChecks, stackBoundMs } from '../stack';
import { type RunnerArgs } from '../types';

const STATE = {
  mode: 'existing-codebase',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'none',
  mobile: { framework: 'none' },
};

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
    // Second precondition: the command actually RAN and was held to the bound.
    // Without this the test would still pass if the runner had skipped it.
    assert.ok(
      elapsedMs >= 1_500,
      `fixture guard: the runner must have waited out the 1500 ms bound, waited ${elapsedMs} ms`,
    );

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

// The other cut-short cause. `maxBuffer` overflow kills the child too, and the
// process it kills may have been about to exit 0 — measured: a child that wrote
// 9 MB and would have exited 0 comes back `status: null, ENOBUFS`.
test('a test command killed for overflowing its output buffer is rejectable, not a pass', async () => {
  await withProject(async (cwd) => {
    // 9 MB against the runner's 8 MB maxBuffer, then a clean exit 0. Under the
    // old arm this exact command certified the run green.
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

// The second honest exemption: the project DECLARED the script but its binary is
// absent. The command never started, so nothing was cut short — that is an
// environment gap, and it stays excused. The line this fix draws is exactly
// "started and was killed" versus "never started".
test('a declared command whose binary is absent still settles green', async () => {
  await withProject(async (cwd) => {
    nonvisualProject(cwd, 't1-no-such-binary-9d3f1a');
    assert.equal(await runStack(cwd), 0, 'a missing binary was always a justified exemption');
    const validated = readQaReportV2(cwd, 'R');
    assert.equal(validated.ok, true, validated.ok ? '' : `${validated.code}: ${validated.message}`);
    const check = validated.ok
      ? validated.report.checks.find((entry) => entry.id === 'stack-test')
      : undefined;
    assert.equal(check?.status, 'not-applicable');
    assert.match(String(check?.summary), /could not be executed/i);
    assert.doesNotMatch(String(check?.summary), /inconclusive:/i, 'a command that never started was not cut short');
  });
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
    const [check] = runStackChecks({ projectRoot: cwd } as unknown as RunnerArgs, ['stack-test']);
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
      // Precondition: the adapter really ran and was really held to the bound.
      assert.ok(elapsedMs >= 1_200, `fixture guard: expected a >=1200 ms wait, waited ${elapsedMs} ms`);

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
      assert.doesNotMatch(message, /environment unavailable/i);
    });
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
// run directory. The native path is the only one that can pulse WHILE it works:
// `runBoundedProcess` is promise-based, so the event loop is free. The stack
// path runs spawnSync and cannot, which is why it announces its deadline up
// front instead — asserted by the deadline test below.
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
  // A directly-constructed RunnerArgs carries no bound, and spawnSync reads a
  // missing timeout as UNBOUNDED. That is the one outcome this must never
  // produce: an unbounded stack check is the hang the whole item is about.
  assert.equal(stackBoundMs({} as RunnerArgs), MAX_TIMEOUT_MS);
  assert.equal(stackBoundMs({ timeoutMs: 0 } as RunnerArgs), MAX_TIMEOUT_MS);
  assert.equal(stackBoundMs({ timeoutMs: 5_000 } as RunnerArgs), MAX_TIMEOUT_MS, 'a bound with no explicit flag is not trusted');
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
