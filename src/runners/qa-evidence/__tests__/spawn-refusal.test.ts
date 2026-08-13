// src/runners/qa-evidence/__tests__/spawn-refusal.test.ts
// A spawn the RUNNER's own resource limits refused is not an absent command.
//
// The defect, measured end to end before this file existed: `runBoundedProcess`
// mapped ENOENT to `unavailable` and the other four errnos node delivers
// asynchronously — EACCES, EAGAIN, EMFILE, ENFILE — to `completed`, the arm its
// own doc-comment describes as "ran to a verdict", with a null exit code and no
// signal. Both cut-short classifiers then answered "not cut short", because
// their `completed` arm keys on the signal; `stackCheckOutcome` fell into its
// "could not be executed" branch; `validateQaReportV2` accepts that exact prose
// as a justified exemption for `stack-test`; and `stackReportStatus` returned
// `passed` because nothing was `failed`. A run that measured nothing reported a
// pass, on the everyday failure mode of a process that spawns a group, a dev
// server and a Chrome under a CI `ulimit`.
//
// It was invisible to the enumeration test in inconclusive-evidence.test.ts and
// to a mutation campaign over the errno ternary, for the same reason: the hole
// was not a missing arm of the union but a state with no member to hold it. The
// repair is `start-failed`, a member both exhaustive switches must now decide.
// So the rows here are deliberately of three kinds — the mapping, the whole
// state space of the check builder, and one real spawn refused by a real fd
// limit, driven through the real validator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { compileArchitecture } from '../../../shared/architecture-contract';
import { CHECK_INCONCLUSIVE_PREFIX, qaReportV2Path } from '../../../shared/qa-report-v2';
import { type QaReportV2 } from '../../../shared/qa-report-v2/schema';
import { compileVerificationContract } from '../../../shared/verification-contract';
import {
  BOUNDED_PROCESS_KINDS,
  spawnRefusalKind,
  type BoundedProcessKind,
  type BoundedProcessResult,
} from '../native-process';
import { loadStackRun, publishStackReport } from '../run-context';
import { stackCheckOutcome, stackReportStatus } from '../stack';
import { type RunnerArgs } from '../types';

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX descriptor limits' : false };
const TEST_TIMEOUT_MS = 60_000;

// THE FIVE ERRNOS, and the line drawn through them.
//
// Node delivers exactly these five on the child rather than throwing them out of
// `spawn` (internal/child_process.js hands them to `process.nextTick`);
// everything else — the UV_EINVAL a `.cmd` earns among it — is thrown
// synchronously and caught elsewhere. Two of them mean THE TARGET is not
// runnable and three mean THIS PROCESS could not run it, and that is the whole
// distinction the report depends on: the first is exempt, the second must carry
// the inconclusive prefix.
test('a spawn refusal is classified by whose fault it is, not by whether an exit code arrived', () => {
  assert.equal(spawnRefusalKind('ENOENT'), 'unavailable', 'no such binary: there is nothing to run');
  assert.equal(spawnRefusalKind('EACCES'), 'unavailable', 'the target is not executable: still a property of the target');
  for (const code of ['EMFILE', 'ENFILE', 'EAGAIN']) {
    assert.equal(
      spawnRefusalKind(code),
      'start-failed',
      `${code} is the RUNNER out of descriptors or process slots — the command exists and would have answered`,
    );
  }
  // Fail-closed on anything not named. An errno nobody has classified is not
  // evidence that the command was absent, and `unavailable` is EXEMPT: the
  // cheap mistake here is the expensive one.
  assert.equal(spawnRefusalKind('EPERM'), 'start-failed');
  assert.equal(spawnRefusalKind(undefined), 'start-failed');
});

// EACCES IS THE BORDERLINE ONE, and it is ruled `unavailable` on the merits.
//
// A file without the execute bit is a fact about the declared target, exactly as
// ENOENT is: re-running the command changes nothing, no descriptor pressure is
// implied, and the operator's repair is to fix the file. The three exhaustion
// errnos are the opposite on every one of those. The sibling runner already
// treats a missing execute bit as an environment gap — `stackCheckOutcome`'s
// 127 arm, POSIX "command not found" as a package manager propagates it — so
// ruling EACCES `start-failed` would have made one fact wear two spellings
// depending on whether the shell or the runner met it first.
//
// It is the arm that would cost the most to be wrong about in the other
// direction, which is why it is pinned in prose here: `unavailable` is exempt,
// so if a future reader decides that a permission refusal deserves the
// inconclusive treatment, this is the test that has to be argued with rather
// than a ternary that can be edited without noticing.
test('the two refusals that are facts about the target stay exempt, and only those two', () => {
  const exempt = ['ENOENT', 'EACCES'].filter((code) => spawnRefusalKind(code) === 'unavailable');
  assert.deepEqual(exempt, ['ENOENT', 'EACCES']);
  assert.equal(
    ['EMFILE', 'ENFILE', 'EAGAIN', 'EPERM', 'ETXTBSY', undefined]
      .filter((code) => spawnRefusalKind(code) === 'unavailable').length,
    0,
    'nothing else may reach the exempt arm — that arm is what excuses a required check',
  );
});

const RESULT = (over: Partial<BoundedProcessResult>): BoundedProcessResult => ({
  kind: 'completed', exitCode: 0, signal: null, stdout: '', stderr: '', ...over,
});

// THE WHOLE STATE SPACE, rather than the shapes a fixture happens to produce.
//
// The blocker did not live in the union — both switches over it were already
// exhaustive — but one layer below, in a branch of the check builder keyed on
// `exitCode`. No enumeration of `BOUNDED_PROCESS_KINDS` could reach it. So this
// walks every kind against every exit code and signal a spawn can produce, and
// asserts the one property that was violated: the excused prose is reachable
// only from `unavailable`.
test('only an absent command can produce the summary the validator excuses', () => {
  const excused = (summary: string): boolean => /\bnot run:/i.test(summary)
    && /\b(?:declares no|could not be executed)\b/i.test(summary)
    && !summary.startsWith(CHECK_INCONCLUSIVE_PREFIX);
  for (const kind of BOUNDED_PROCESS_KINDS) {
    for (const exitCode of [null, 0, 1, 127]) {
      for (const signal of [null, 'SIGKILL' as const]) {
        const check = stackCheckOutcome(
          'stack-test', 'go test ./...', 'go.mod',
          RESULT({ kind, exitCode, signal, stderr: 'spawn go EMFILE' }),
          1_000, 12,
        );
        if (!excused(String(check.summary))) continue;
        assert.ok(
          kind === 'unavailable' || (kind === 'completed' && exitCode === 127 && signal === null),
          `'${kind}' with exitCode ${String(exitCode)} and signal ${String(signal)} produced the summary that `
          + `EXCUSES a required check: ${String(check.summary)}`,
        );
      }
    }
  }
});

test('a run the runner could not start is inconclusive at every level of the report', () => {
  const check = stackCheckOutcome(
    'stack-test', 'go test ./...', 'go.mod',
    RESULT({ kind: 'start-failed', exitCode: null, stderr: 'spawn go EMFILE' }),
    300_000, 3,
  );
  const summary = String(check.summary);
  assert.equal(check.status, 'not-applicable', 'nothing ran, so there is no verdict in either direction');
  assert.ok(summary.startsWith(CHECK_INCONCLUSIVE_PREFIX), `the marker is what stops the exemption: ${summary}`);
  assert.match(summary, /EMFILE/, 'and the cause must be named — "we could not tell" with no cause is not actionable');
  assert.equal(
    stackReportStatus([
      { id: 'stack-build', status: 'passed', summary: '`npm run build` exited 0 (package.json)' },
      check,
    ]),
    'failed',
    'the DURABLE artifact must not say `passed` when a required check produced no verdict',
  );
});

/**
 * The exhaustion, for real, in a process of its own.
 *
 * A test that opened descriptors until EMFILE inside the runner would exhaust
 * the test runner too, so this is driven in a child under a real `ulimit -n`.
 * What comes back is the `check` object the product code built from a genuinely
 * refused spawn — not a hand-written one — and the parent then puts it through
 * the real validator. That join is what makes this end to end rather than two
 * arguments meeting in the middle.
 */
function exhaustedStackCheck(): QaReportV2['checks'][number] {
  const repoRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT || process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-emfile-'));
  try {
    const driver = path.join(dir, 'driver.mjs');
    fs.writeFileSync(driver, [
      "import * as fs from 'fs';",
      `import { runBoundedProcess } from ${JSON.stringify(path.join(repoRoot, 'src/runners/qa-evidence/native-process.ts'))};`,
      `import { reapOnInterrupt } from ${JSON.stringify(path.join(repoRoot, 'src/runners/qa-evidence/process-group.ts'))};`,
      `import { stackCheckOutcome } from ${JSON.stringify(path.join(repoRoot, 'src/runners/qa-evidence/stack.ts'))};`,
      // The interrupt reaper's listeners are installed FIRST and never removed.
      // Measured while writing this: with every descriptor taken, the
      // `process.on('SIGINT')` inside `reapOnInterrupt` aborts the process —
      // libuv allocates a signal watcher on the first listener for a signal and
      // has no descriptor to allocate it with, and a V8 abort is not catchable.
      // That is a real property of total exhaustion rather than an artefact of
      // this fixture, and it is not what is under test here: registering once up
      // front means the watcher already exists when the bounded run registers
      // its own, so the run reaches the spawn, which is the refusal being
      // measured.
      'reapOnInterrupt(() => {});',
      // Hold every descriptor the limit allows. `/dev/null` so nothing is
      // written and nothing has to be cleaned up if this process is killed.
      'const held = [];',
      'for (;;) {',
      "  try { held.push(fs.openSync('/dev/null', 'r')); } catch { break; }",
      '}',
      // A command that exists, is executable, and would answer instantly.
      "const run = await runBoundedProcess(['/bin/echo', '412 tests ran'], process.cwd(), 5000);",
      'for (const fd of held.splice(0)) { try { fs.closeSync(fd); } catch {} }',
      "const check = stackCheckOutcome('stack-test', 'go test ./...', 'go.mod', run, 5000, 3);",
      'process.stdout.write(JSON.stringify({ kind: run.kind, exitCode: run.exitCode, signal: run.signal, '
        + 'stdout: run.stdout, stderr: run.stderr, check }));',
      '',
    ].join('\n'));
    // 64 is low enough that the first spawn cannot get a descriptor and high
    // enough that node itself starts. `sh` applies it to itself and `exec`
    // replaces it, so the limit is the runner's own.
    const out = spawnSync('/bin/sh', [
      '-c',
      `ulimit -n 64; exec ${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(driver)}`,
    ], { cwd: repoRoot, encoding: 'utf8', timeout: 45_000 });
    assert.equal(out.status, 0, `fixture guard: the driver must run to completion. stderr: ${out.stderr}`);
    const measured = JSON.parse(out.stdout) as {
      kind: BoundedProcessKind;
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      check: QaReportV2['checks'][number];
    };
    // The table this round exists to move. Before: kind `completed`, exit code
    // null, empty stdout, `spawn /bin/echo EMFILE`, and BOTH classifiers
    // answering "not cut short".
    assert.equal(
      measured.kind,
      'start-failed',
      `a spawn refused for the runner's own exhaustion must not be an ending that ran to a verdict (got ${measured.kind})`,
    );
    assert.equal(measured.exitCode, null);
    assert.equal(measured.stdout, '', 'fixture guard: the command must not have run — it prints when it does');
    assert.match(measured.stderr, /EMFILE|ENFILE|EAGAIN/, `fixture guard: the refusal must be an exhaustion one: ${measured.stderr}`);
    return measured.check;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// AND THE SAME CHECK, THROUGH THE REAL VALIDATOR.
//
// This is the assertion the round is measured by. The check comes from a spawn a
// real descriptor limit really refused; the contract is compiled by the real
// compiler and really requires `stack-test`; the verdict is the real
// `validateQaReportV2`. Before the fix the same run produced `ok: true` — a
// green run that measured nothing.
test('a required check whose spawn the runner refused cannot settle the run green', { ...POSIX_ONLY, timeout: TEST_TIMEOUT_MS }, () => {
  const check = exhaustedStackCheck();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-emfile-project-'));
  try {
    fs.mkdirSync(path.join(cwd, 'apps/web/src/lib'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'web',
      dependencies: { react: '19.0.0', vite: '7.0.0' },
      scripts: { build: 'node -e ""', 'format:check': 'node -e ""' },
    }));
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module web\n\ngo 1.22\n');
    fs.writeFileSync(path.join(cwd, 'apps/web/src/lib/Mapper.ts'), 'export const map = (v: string): string => v;\n');
    const state = {
      mode: 'existing-codebase',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'none',
      mobile: { framework: 'none' },
    };
    const architecture = compileArchitecture(cwd, 'R', state, {
      schemaVersion: 1,
      routes: [],
      modules: [{ id: 'mapper', name: 'Mapper', kind: 'service' }],
    });
    const contract = compileVerificationContract(cwd, 'R', state, architecture, {
      changedPaths: ['apps/web/src/lib/Mapper.ts'],
    });
    assert.ok(contract.requiredChecks.includes('stack-test'), 'fixture guard: the contract must require the check under test');

    const checks: QaReportV2['checks'] = [
      { id: 'stack-build', status: 'passed', summary: '`npm run build` exited 0 (package.json scripts.build)' },
      { id: 'stack-format', status: 'passed', summary: '`npm run format:check` exited 0 (package.json scripts.format:check)' },
      check,
    ];
    // Published and validated by the product's own path, so nothing here can
    // pass or fail for a reason a hand-assembled report would have invented.
    const args = { command: 'stack', projectRoot: cwd, runId: 'R' } as unknown as RunnerArgs;
    const loaded = loadStackRun(args);
    assert.ok(loaded.ok, `fixture guard: the run must load. ${loaded.ok ? '' : loaded.reason}`);
    const published = publishStackReport(args, loaded.run, stackReportStatus(checks), checks);
    assert.equal(published.ok, false, 'a run that measured nothing must not validate');
    assert.equal(
      published.code,
      'required-check-failed',
      'and it must be rejected for the CHECK, not for its schema — a schema rejection does not persist and stops naming the check',
    );
    assert.match(
      String(published.message),
      /stack-test/,
      'the rejection must name the check whose spawn was refused',
    );
    const onDisk = JSON.parse(fs.readFileSync(qaReportV2Path(cwd, 'R'), 'utf8')) as { status: string };
    assert.equal(onDisk.status, 'failed', 'the durable artifact must not read `passed` for a run that measured nothing');
    // Attribution: the other two checks are ordinary and green, so nothing above
    // could be explained by a fixture that broke every command.
    assert.deepEqual(
      checks.filter((entry) => entry.status !== 'not-applicable').map((entry) => `${entry.id}=${entry.status}`),
      ['stack-build=passed', 'stack-format=passed'],
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
