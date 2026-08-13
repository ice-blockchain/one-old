// src/runners/qa-evidence/__tests__/exemption-provenance.test.ts
// WHICH `not-applicable` may be excused, and by what evidence.
//
// `validateQaReportV2` lets four stack ids pass without a verdict when the
// project declares no such command. It used to decide that by matching the
// check's SUMMARY — `not run:` plus `declares no|could not be executed` — and
// three producers in stack.ts write prose satisfying both, for two
// incompatible reasons:
//
//   stack.ts resolveStackCommand's fallthrough   no command declared. INTENDED.
//   stackCheckOutcome, kind 'unavailable'        declared; binary absent or not
//                                                executable.
//   stackCheckOutcome, exit 127                  declared; the shell could not
//                                                find the tool it names.
//
// The last two mean a test command WAS declared and zero tests ran. Both were
// excused, and neither is a cut-short run, so the inconclusive marker — the
// whole apparatus the previous rounds built — never saw them: nothing was
// killed, nothing timed out, no signal was involved. Measured before this
// change on the two shapes below, a Node api-only project whose `npm test`
// exits 127 and a Python one whose `pytest` cannot be run: `producerStatus:
// passed / validatorOk: true / onDiskStatus: passed`, with no test evidence of
// any kind. That is the everyday fresh-clone shape on the most common stack in
// this repository.
//
// The repair carries the FACT (`notApplicable`, a QA_NOT_APPLICABLE_REASONS
// member) instead of a sentence describing it, decided in the one place that
// knows. These tests are organised so that each row reports what the PRODUCER
// said, what the VALIDATOR said, and what a later unvalidated reader finds ON
// DISK — three answers that have differed from each other in this lane before,
// and a defect visible in only the third is invisible to the other two.
//
// Two instruments, deliberately of different kinds. The end-to-end rows below
// are killed by MUTATING a classification (flip a reason and the route settles
// green again). The two source-scanning rows near the bottom are killed by the
// ABSENCE of a classification — a producer arm added later with no reason at
// all, which is exactly how this defect arrived: an arm nobody classified,
// wearing prose that already meant something else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { compileArchitecture } from '../../../shared/architecture-contract';
import {
  QA_NOT_APPLICABLE_REASONS,
  qaReportV2Path,
  validateQaReportV2,
  type QaReportV2,
} from '../../../shared/qa-report-v2';
import { qaStackResolutionPath, readStackResolution } from '../../../shared/qa-report-v2';
import { compileVerificationContract } from '../../../shared/verification-contract';
import { parseArgs } from '../cli';
import {
  BROWSER_CHECK_IDS,
  NATIVE_ATTESTED_CHECK_IDS,
  computeBrowserCheckStatuses,
  nativeCheckStatuses,
} from '../report-publish';
import { loadStackRun, publishStackReport } from '../run-context';
import { runStackChecks, stackCheckOutcome, stackReportStatus } from '../stack';
import { type BoundedProcessResult } from '../native-process';

type Check = QaReportV2['checks'][number];

const RUN_ID = 'R';

/**
 * The three answers, from one run.
 *
 * `producerStatus` is the field the runner computed and published;
 * `validatorOk`/`validatorCode` is what `validateQaReportV2` said about it; and
 * `onDisk` is re-read from the file afterwards, because `persistGateRejection`
 * may have corrected it and because the durable artifact is what settlement,
 * the tester completion gate and a human actually read.
 */
interface Views {
  producerStatus: QaReportV2['status'];
  validatorOk: boolean;
  validatorCode?: string;
  onDiskStatus: QaReportV2['status'];
  onDiskGateIds: string[];
  check: (id: string) => Check;
}

function withProject(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-exemption-')));
  return fn(cwd).finally(() => fs.rmSync(cwd, { recursive: true, force: true }));
}

/** An api-only contract: `uiImpact: 'none'`, so the `stack` command owns the whole verdict. */
function apiOnlyContract(cwd: string, backend: string): void {
  fs.mkdirSync(path.join(cwd, 'internal/api'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'internal/api/handler.txt'), 'handler\n');
  const state = {
    mode: 'existing-codebase',
    stack: 'custom-backend',
    frontend: 'none',
    backend,
    mobile: { framework: 'none' },
  };
  const architecture = compileArchitecture(cwd, RUN_ID, state, {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'api', name: 'Api', kind: 'feature' }],
  });
  const contract = compileVerificationContract(cwd, RUN_ID, state, architecture, {
    changedPaths: ['internal/api/handler.txt'],
  });
  assert.equal(contract.uiImpact, 'none', 'fixture guard: an api-only contract');
  assert.equal(contract.browserRequired, false, 'fixture guard: the stack command owns this verdict');
  assert.ok(
    contract.requiredChecks.includes('stack-test'),
    'fixture guard: the contract must require the check under test',
  );
}

/** Run the `stack` command exactly as `main` composes it, and collect all three views. */
async function runStack(cwd: string): Promise<Views> {
  const args = parseArgs(['stack', '--project-root', cwd, '--run-id', RUN_ID], cwd)!;
  const loaded = loadStackRun(args);
  assert.ok(loaded.ok, `fixture guard: the run must load — ${loaded.ok ? '' : loaded.reason}`);
  const checks = await runStackChecks(args, loaded.run.contract.requiredChecks);
  const published = publishStackReport(args, loaded.run, stackReportStatus(checks), checks);
  const onDisk = JSON.parse(fs.readFileSync(qaReportV2Path(cwd, RUN_ID), 'utf8')) as QaReportV2;
  const byId = new Map(onDisk.checks.map((check) => [check.id, check]));
  return {
    producerStatus: published.report.status,
    validatorOk: published.ok,
    ...(published.code ? { validatorCode: published.code } : {}),
    onDiskStatus: onDisk.status,
    onDiskGateIds: (onDisk.gates || []).map((gate) => gate.id),
    check: (id) => {
      const check = byId.get(id);
      assert.ok(check, `fixture guard: the report must carry a ${id} check`);
      return check;
    },
  };
}

/** The errno a bare spawn of `bin` yields on this PATH, or undefined if it started. */
function spawnErrno(bin: string): string | undefined {
  return (spawnSync(bin, ['--version']).error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * A PATH with no `pytest` on it, and the guard that says so.
 *
 * The ENOENT arm needs a `pytest` that genuinely is not installed, and this
 * machine may well have one — `test:env` requires it. Narrowing PATH to the
 * directories the fixture actually needs (this node, the npm beside it, and the
 * system defaults) is how that is made deterministic, and the guard is what
 * keeps the test from silently measuring the opposite arm on a host whose
 * `pytest` lives somewhere unusual.
 */
async function withoutPytest(fn: () => Promise<void>): Promise<void> {
  const npmDir = spawnSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(npmDir, 'fixture guard: npm must be resolvable, the build check runs through it');
  const previous = process.env.PATH;
  process.env.PATH = [path.dirname(process.execPath), path.dirname(npmDir), '/usr/bin', '/bin']
    .join(path.delimiter);
  try {
    assert.equal(
      spawnErrno('pytest'),
      'ENOENT',
      'fixture guard: this row measures a pytest that is ABSENT, and one is on PATH',
    );
    await fn();
  } finally {
    process.env.PATH = previous;
  }
}

/** A `pytest` on PATH that cannot be executed: present, and without its execute bit. */
async function withUnexecutablePytest(fn: () => Promise<void>): Promise<void> {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-noexec-'));
  fs.writeFileSync(path.join(bin, 'pytest'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(bin, 'pytest'), 0o644);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous || ''}`;
  try {
    assert.equal(
      spawnErrno('pytest'),
      'EACCES',
      'fixture guard: this row measures a pytest that is PRESENT and not executable',
    );
    await fn();
  } finally {
    process.env.PATH = previous;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// THE TWO MEASURED ROUTES.
// ---------------------------------------------------------------------------

// The commonest shape there is: a fresh clone, or an image whose devDependency
// never installed. `npm run test` propagates the shell's 127 verbatim, the
// project DID declare a test command, and nothing ran.
test('a declared test command whose binary is absent (exit 127) is refused the exemption', async () => {
  await withProject(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'api',
      scripts: { build: 'node -e ""', test: 't1-no-such-binary-8f21e' },
    }));
    apiOnlyContract(cwd, 'node');

    const views = await runStack(cwd);
    const test127 = views.check('stack-test');

    assert.equal(views.check('stack-build').status, 'passed',
      'fixture guard: the build must pass, so the verdict below is attributable to stack-test');
    assert.equal(test127.status, 'not-applicable', 'a 127 is an environment gap, not a red suite');
    assert.equal(test127.notApplicable, 'declared-not-runnable',
      'the project declared this command: it is not the absent-command exemption');
    assert.match(String(test127.summary), /not run:.*could not be executed/,
      'the prose the old predicate matched is unchanged — which is the point: it can no longer decide');

    assert.equal(views.producerStatus, 'failed',
      'the producer knows this too, and says so before the validator can: the file it publishes is '
      + 'readable in the window before the correction lands');
    assert.equal(views.validatorOk, false, 'this run measured no tests and must not validate');
    assert.equal(views.validatorCode, 'required-check-failed');
    assert.equal(views.onDiskStatus, 'failed', 'and the durable artifact must not keep claiming a pass');
    assert.deepEqual(views.onDiskGateIds, ['required-checks']);
  });
});

// The same fact one layer earlier: the runner's own spawn is refused before a
// shell is ever involved. Both arms of `kind: 'unavailable'` are driven — the
// binary absent, and the binary present without its execute bit — because they
// are separate errnos (ENOENT, EACCES) reaching one classification.
for (const [label, withPytest] of [
  ['absent', withoutPytest],
  ['present but not executable', withUnexecutablePytest],
] as const) {
  test(`a declared pytest that is ${label} is refused the exemption`, async () => {
    await withProject(async (cwd) => {
      // The polyglot shape: a Node build script beside a Python test suite, so
      // the build check does not depend on a python3 being installed and the
      // verdict is attributable to stack-test alone.
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
        name: 'api',
        scripts: { build: 'node -e ""' },
      }));
      fs.writeFileSync(path.join(cwd, 'pyproject.toml'), '[project]\nname = "api"\n');
      apiOnlyContract(cwd, 'python');

      await withPytest(async () => {
        const views = await runStack(cwd);
        const pytest = views.check('stack-test');

        assert.equal(views.check('stack-build').status, 'passed', 'fixture guard: the build must pass');
        assert.equal(pytest.status, 'not-applicable');
        assert.equal(pytest.notApplicable, 'declared-not-runnable',
          'a declared suite that could not be started is an environment gap, never an absent command');
        assert.equal(views.producerStatus, 'failed', 'and all three views must agree, not just the last two');
        assert.equal(views.validatorOk, false, 'zero tests ran, so the run must not validate');
        assert.equal(views.validatorCode, 'required-check-failed');
        assert.equal(views.onDiskStatus, 'failed');
        assert.deepEqual(views.onDiskGateIds, ['required-checks']);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// THE ARM THAT MUST STILL BE EXEMPT.
// ---------------------------------------------------------------------------

// Without this row every assertion above is satisfied by a validator that
// excuses nothing, which would make every project without a formatter, a
// linter or a test suite unfinishable — a strictly worse outcome than the
// defect, and the one the exemption was written for.
test('a project that declares no test command is still exempt, and still settles', async () => {
  await withProject(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'api',
      scripts: { build: 'node -e ""' },
    }));
    apiOnlyContract(cwd, 'node');

    const views = await runStack(cwd);
    for (const id of ['stack-test', 'stack-lint', 'stack-format']) {
      assert.equal(views.check(id).notApplicable, 'no-command-declared', `${id} resolved to no command`);
    }
    assert.equal(views.check('stack-build').status, 'passed');
    assert.equal(views.producerStatus, 'passed');
    assert.equal(views.validatorOk, true, 'an absent command is honestly reported, not a failure');
    assert.equal(views.onDiskStatus, 'passed', 'and nothing corrects an artifact that was right');
    assert.deepEqual(views.onDiskGateIds, []);
  });
});

// WHAT CONTAINS AN EMPTY DIRECTORY, measured because `stackReportStatus` used
// to justify its all-not-applicable arm on the grounds that such a report means
// "the project declares no build, test, lint or format command" — which it also
// means when the runner was pointed at a directory with no manifest at all. The
// decision survives; the mechanism that contains it is `stack-build` being off
// the exemption allowlist, and the correction being DURABLE.
test('a directory with no manifest at all produces an all-not-applicable report that cannot settle', async () => {
  await withProject(async (cwd) => {
    apiOnlyContract(cwd, 'node');

    const views = await runStack(cwd);
    for (const id of ['stack-build', 'stack-test', 'stack-lint', 'stack-format']) {
      assert.equal(views.check(id).status, 'not-applicable', `${id} resolves to nothing here`);
      assert.equal(views.check(id).notApplicable, 'no-command-declared');
    }
    assert.equal(views.producerStatus, 'passed',
      'the producer says passed, which is the honest report of "nothing to run" and not the last defence');
    assert.equal(views.validatorOk, false, 'stack-build is unexemptable, so this cannot settle');
    assert.equal(views.validatorCode, 'required-check-failed');
    assert.equal(views.onDiskStatus, 'failed',
      'and the correction is durable: an unvalidated later reader must not find the producer word');
  });
});

// ---------------------------------------------------------------------------
// THE VALIDATOR READS THE FACT, NOT THE SENTENCE.
// ---------------------------------------------------------------------------

// The direct statement of the repair, with the two inputs isolated: identical
// prose, opposite reasons, opposite verdicts. Before the field, both of these
// settled.
test('identical prose with opposite reasons reaches opposite verdicts', async () => {
  await withProject(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'api',
      scripts: { build: 'node -e ""' },
    }));
    apiOnlyContract(cwd, 'node');
    const args = parseArgs(['stack', '--project-root', cwd, '--run-id', RUN_ID], cwd)!;
    const loaded = loadStackRun(args);
    assert.ok(loaded.ok);
    const base = await runStackChecks(args, loaded.run.contract.requiredChecks);
    const summary = 'not run: `pytest -q` could not be executed (spawn pytest ENOENT)';

    const verdicts = QA_NOT_APPLICABLE_REASONS.map((reason) => {
      const checks = base.map((check) => (check.id === 'stack-test'
        ? { id: check.id, status: 'not-applicable' as const, notApplicable: reason, summary }
        : check));
      const published = publishStackReport(args, loaded.run, stackReportStatus(checks), checks);
      return [reason, published.ok] as const;
    });

    assert.deepEqual(verdicts, [
      ['no-command-declared', true],
      ['declared-not-runnable', false],
      ['cut-short', false],
      ['evidence-not-captured', false],
    ], 'one summary, four reasons, and only the absent-command one may be excused');
  });
});

// A report from a runner that predates the field — or a hand-authored one —
// carries no reason, and the exemption is refused. Fail-closed is the only
// safe direction for a claim whose evidence is missing.
test('a report carrying the old prose and no reason is refused the exemption', async () => {
  await withProject(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'api',
      scripts: { build: 'node -e ""' },
    }));
    apiOnlyContract(cwd, 'node');
    const args = parseArgs(['stack', '--project-root', cwd, '--run-id', RUN_ID], cwd)!;
    const loaded = loadStackRun(args);
    assert.ok(loaded.ok);
    const checks = (await runStackChecks(args, loaded.run.contract.requiredChecks))
      .map((check) => {
        if (check.id !== 'stack-test') return check;
        const legacy = { ...check };
        delete legacy.notApplicable;
        return legacy;
      });
    assert.equal(checks.find((check) => check.id === 'stack-test')?.notApplicable, undefined,
      'fixture guard: this row is about the ABSENCE of the field');

    const published = publishStackReport(args, loaded.run, stackReportStatus(checks), checks);
    assert.equal(published.ok, false, 'prose alone must no longer buy an exemption');
    assert.equal(published.code, 'required-check-failed');
  });
});

// The field the exemption keys on is SCHEMA-CHECKED, in both directions. A
// parser that dropped an unrecognized reason, or accepted one on a check that
// reached a verdict, would be silently rewriting the claim the validator is
// about to read — which is the same defect as reading it out of prose, one
// layer down. Refusing the report is the only answer that cannot be wrong
// quietly.
test('a report whose reason the schema does not recognize is refused', async () => {
  await withProject(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'api', scripts: { build: 'node -e ""' } }));
    apiOnlyContract(cwd, 'node');
    const args = parseArgs(['stack', '--project-root', cwd, '--run-id', RUN_ID], cwd)!;
    const loaded = loadStackRun(args);
    assert.ok(loaded.ok);
    const base = await runStackChecks(args, loaded.run.contract.requiredChecks);

    for (const [label, mutate] of [
      ['an unknown reason', (check: Check) => ({ ...check, notApplicable: 'no-such-reason' as never })],
      ['a reason on a passed check', (check: Check) => ({ ...check, status: 'passed' as const })],
    ] as const) {
      const checks = base.map((check) => (check.id === 'stack-test'
        ? mutate({ ...check, status: 'not-applicable', notApplicable: 'no-command-declared' })
        : check));
      const published = publishStackReport(args, loaded.run, 'passed', checks);
      assert.equal(published.ok, false, `${label} must not be accepted`);
      assert.equal(published.code, 'invalid-schema', `${label} is a schema violation, not a verdict`);
    }
  });
});

// ---------------------------------------------------------------------------
// THE FAIL-OPEN DIRECTION — THE ONLY ONE THAT COSTS ANYTHING.
// ---------------------------------------------------------------------------

// Every row above forges in the SAFE direction. `identical prose with opposite
// reasons` starts from a project that genuinely declares no test command and
// substitutes the three reasons that are NOT excusable, asserting each is
// refused; `a report whose reason the schema does not recognize` forges an
// unknown reason and a reason on a passed check. All fail closed. None of them
// drives the direction an attacker or a hurried agent would take: the EXCUSABLE
// reason forged onto a check whose command WAS declared and DID fail.
//
// That is the shape a peer drove by hand against this suite and got a green
// verdict from: take a real api-only project whose `npm test` exits 127, set
// `notApplicable` to `no-command-declared`, drop the persisted `gates`, set
// `status` to `passed`, and the validator accepted it. `report-v2.json` is
// attributed to the `senior-tester` role and no runtime-sidecar fence covers it,
// so the agent that writes the report owned the field that excused it — and on a
// nonvisual contract `validateMachineEvidence` never runs, so nothing else was
// checking anything either.
//
// What refuses it now is not a better reading of the report. It is
// `.traffic-one/runs/<id>/qa-stack-resolution-v1.json`, written by the runner at
// the moment it resolved each command and refused to every agent by
// `runtimeOwnedRunSidecar`. The report can say anything; the run's own record
// does not agree.
test('an excusable reason forged onto a command that WAS declared is refused', async () => {
  await withProject(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'api',
      scripts: { build: 'node -e ""', test: 't1-no-such-binary-8f21e' },
    }));
    apiOnlyContract(cwd, 'node');

    const honest = await runStack(cwd);
    assert.equal(honest.validatorOk, false, 'fixture guard: the honest run must not settle');
    assert.equal(honest.check('stack-test').notApplicable, 'declared-not-runnable',
      'fixture guard: this row forges over a command the project DID declare');
    assert.equal(
      readStackResolution(cwd, RUN_ID)?.resolved['stack-test'],
      'declared',
      'fixture guard: the runtime must have recorded that it found a command',
    );

    // The forgery, exactly as a tester with a Write tool would perform it: three
    // fields of one file, no other change anywhere.
    const reportPath = qaReportV2Path(cwd, RUN_ID);
    const forged = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as QaReportV2;
    forged.status = 'passed';
    delete forged.gates;
    for (const check of forged.checks) {
      if (check.id === 'stack-test') check.notApplicable = 'no-command-declared';
    }
    fs.writeFileSync(reportPath, JSON.stringify(forged));

    const args = parseArgs(['stack', '--project-root', cwd, '--run-id', RUN_ID], cwd)!;
    const loaded = loadStackRun(args);
    assert.ok(loaded.ok);
    const revalidated = validateQaReportV2(forged, cwd, RUN_ID, loaded.run.contract);
    assert.equal(revalidated.ok, false, 'a forged exemption must not settle a run that measured no tests');
    assert.equal(revalidated.ok ? '' : revalidated.code, 'required-check-failed');
    assert.match(revalidated.ok ? '' : revalidated.message, /runtime record/,
      'and the deny must name what actually refused it, not repeat the ordinary red');

    const after = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as QaReportV2;
    assert.equal(after.status, 'failed', 'the durable artifact must not keep the forged word');
  });
});

// The other half of the same binding, and the half that decides whether it is a
// binding at all: DELETING the runtime record must not restore the exemption.
// An honest project with no test command settles; remove the file the fence
// protects and it stops settling, which is the fail-closed direction. Without
// this row the record could be absent-means-fine and every assertion above would
// still be green.
test('an honest exemption stops being granted when the runtime record is gone', async () => {
  await withProject(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'api',
      scripts: { build: 'node -e ""' },
    }));
    apiOnlyContract(cwd, 'node');

    const views = await runStack(cwd);
    assert.equal(views.validatorOk, true, 'fixture guard: this project settles honestly');

    fs.rmSync(qaStackResolutionPath(cwd, RUN_ID));
    const args = parseArgs(['stack', '--project-root', cwd, '--run-id', RUN_ID], cwd)!;
    const loaded = loadStackRun(args);
    assert.ok(loaded.ok);
    const revalidated = validateQaReportV2(
      JSON.parse(fs.readFileSync(qaReportV2Path(cwd, RUN_ID), 'utf8')),
      cwd,
      RUN_ID,
      loaded.run.contract,
    );
    assert.equal(revalidated.ok, false,
      'a claim whose only witness has been removed is a claim with no evidence');
    assert.equal(revalidated.ok ? '' : revalidated.code, 'required-check-failed');
  });
});

// ---------------------------------------------------------------------------
// A REFUSAL WITH NO DURABLE TRACE.
// ---------------------------------------------------------------------------

// The third view, alone. `blocked-environment` on a contract that needs no
// browser is refused as `invalid-schema`, which had no `GATE_ID_FOR_FAILURE`
// entry — so the verdict existed only as a return value and the artifact kept
// its own word. Producer and validator both looked correct; only a later reader
// of the file saw a run claiming an environment blocker that the validator had
// already refused.
//
// Latent: no producer emits this shape, and `stackReportStatus` explains at
// length why the stack path must not. It is here because a refusal that leaves
// no trace is the same class of defect as `reject()` being pure, which is how a
// `passed` sidecar survived a failed performance gate (10co-e2e) — and because
// a latent route has no mutation to be killed by. The instrument for a route
// nobody takes is a test that takes it.
test('a refusal on a report that parsed is written back into the report', async () => {
  await withProject(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      name: 'api',
      scripts: { build: 'node -e ""', test: 'node -e ""' },
    }));
    apiOnlyContract(cwd, 'node');
    const args = parseArgs(['stack', '--project-root', cwd, '--run-id', RUN_ID], cwd)!;
    const loaded = loadStackRun(args);
    assert.ok(loaded.ok);
    const checks = await runStackChecks(args, loaded.run.contract.requiredChecks);

    const published = publishStackReport(args, loaded.run, 'blocked-environment', checks);
    assert.equal(published.ok, false, 'a nonvisual run has no environment to be blocked by');
    assert.equal(published.code, 'invalid-schema');

    const onDisk = JSON.parse(fs.readFileSync(qaReportV2Path(cwd, RUN_ID), 'utf8')) as QaReportV2;
    assert.equal(onDisk.status, 'failed', 'the artifact must not keep a word the validator refused');
    assert.deepEqual((onDisk.gates || []).map((gate) => [gate.id, gate.status, gate.code]), [
      ['report-schema', 'failed', 'invalid-schema'],
    ], 'and the correction must name which gate refused it, for the reader who never runs the validator');
  });
});

// The other arm of the same code, which must keep NOT writing: a sidecar that
// does not parse has no identity to match, so there is nothing to correct and
// nothing to be trusted about the bytes on disk. `persistGateRejection` is
// handed no report and no-ops — the distinction is the report argument at the
// two `reject()` sites, not the code.
test('a refusal on a report that did not parse writes nothing', async () => {
  await withProject(async (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'api', scripts: { build: 'node -e ""' } }));
    apiOnlyContract(cwd, 'node');
    const args = parseArgs(['stack', '--project-root', cwd, '--run-id', RUN_ID], cwd)!;
    const loaded = loadStackRun(args);
    assert.ok(loaded.ok);
    const reportPath = qaReportV2Path(cwd, RUN_ID);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, '{"schemaVersion":2,"nonsense":true}');

    const validated = validateQaReportV2(
      JSON.parse(fs.readFileSync(reportPath, 'utf8')),
      cwd,
      RUN_ID,
      loaded.run.contract,
    );
    assert.equal(validated.ok, false);
    assert.equal(validated.ok ? '' : validated.code, 'invalid-schema');
    assert.equal(
      fs.readFileSync(reportPath, 'utf8'),
      '{"schemaVersion":2,"nonsense":true}',
      'a file this validator could not read is not a file it may rewrite',
    );
  });
});

// ---------------------------------------------------------------------------
// EVERY ROUTE INTO THE PREDICATE, ENUMERATED.
// ---------------------------------------------------------------------------

function boundedResult(over: Partial<BoundedProcessResult>): BoundedProcessResult {
  return { kind: 'completed', exitCode: 0, signal: null, stdout: '', stderr: '', ...over };
}

// `stackCheckOutcome` is driven over its whole state space rather than over the
// shapes a fixture happens to produce — the same instrument
// __tests__/inconclusive-evidence.test.ts uses, asking the other question:
// not "is this cut short" but "may this be excused".
test('no arm of stackCheckOutcome can claim the exemption', () => {
  const exitCodes: (number | null)[] = [null, 0, 1, 127, 137];
  const signals: (NodeJS.Signals | null)[] = [null, 'SIGKILL', 'SIGSEGV'];
  let notApplicableSeen = 0;
  for (const kind of ['completed', 'unavailable', 'start-failed', 'timeout', 'output-limit', 'abandoned'] as const) {
    for (const exitCode of exitCodes) {
      for (const signal of signals) {
        const outcome = stackCheckOutcome(
          'stack-test',
          'pytest -q',
          'pytest configuration',
          boundedResult({ kind, exitCode, signal }),
          1_000,
          10,
        );
        if (outcome.status !== 'not-applicable') continue;
        notApplicableSeen += 1;
        assert.ok(outcome.notApplicable, `kind=${kind} exit=${exitCode} signal=${signal} carries no reason`);
        assert.notEqual(
          outcome.notApplicable,
          'no-command-declared',
          `kind=${kind} exit=${exitCode} signal=${signal} claimed the exemption: this function only ever `
          + 'reports on a command that WAS declared',
        );
      }
    }
  }
  assert.ok(notApplicableSeen > 0, 'fixture guard: the sweep must have reached the arm under test');
});

// The other two producers of a `not-applicable` check in this runner. Neither
// can be excused today — their ids are not on the allowlist, or are refused it
// outright — and both say so in the report rather than relying on that.
test('the browser and native producers classify every not-applicable check they emit', () => {
  const browser = computeBrowserCheckStatuses([...BROWSER_CHECK_IDS], {
    routes: [],
    visual: true,
    playwrightOk: false,
    launchBlocker: null,
    servedOk: false,
  });
  const native = nativeCheckStatuses([...NATIVE_ATTESTED_CHECK_IDS], 'blocked-environment', 'no simulator');
  let seen = 0;
  for (const check of [...browser, ...native]) {
    if (check.status !== 'not-applicable') continue;
    seen += 1;
    assert.equal(check.notApplicable, 'evidence-not-captured', `${check.id} must say why it has no verdict`);
  }
  assert.ok(seen >= 2, `fixture guard: both producers must have emitted a not-applicable check, saw ${seen}`);
});

// ---------------------------------------------------------------------------
// THE ABSENCE INSTRUMENTS.
// ---------------------------------------------------------------------------

const RUNNER_DIR = path.join(__dirname, '..');

function runnerSources(): { file: string; lines: string[] }[] {
  return fs.readdirSync(RUNNER_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      file: name,
      lines: fs.readFileSync(path.join(RUNNER_DIR, name), 'utf8').split('\n'),
    }));
}

// The mutation instrument cannot see an arm that does not exist yet, and an arm
// nobody classified is exactly how this defect arrived. Every `not-applicable`
// a producer in this runner constructs must name its reason in the same object
// literal, so a new one fails HERE rather than inheriting whatever the
// exemption predicate makes of a missing field.
test('every not-applicable a producer constructs names its reason', () => {
  const offenders: string[] = [];
  let checked = 0;
  for (const { file, lines } of runnerSources()) {
    lines.forEach((line, index) => {
      if (!/status:\s*'not-applicable'/.test(line)) return;
      checked += 1;
      // The literal is written status-then-reason at every site; five lines
      // covers the one that has a comment between them.
      const window = lines.slice(index, index + 5).join('\n');
      if (!/notApplicable:/.test(window)) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.ok(checked >= 7, `fixture guard: the scan must have found the known producers, found ${checked}`);
  assert.deepEqual(offenders, [], 'a not-applicable check with no reason cannot be classified by the validator');
});

// And the exemption itself has exactly ONE producer. A second site claiming
// `no-command-declared` would be a second answer to "was anything declared",
// which is the shape of the defect rather than a new instance of it.
test('only the resolution fallthrough may claim the exemption', () => {
  const sites = runnerSources().flatMap(({ file, lines }) => lines
    .map((line, index) => ({ line, at: `${file}:${index + 1}` }))
    .filter(({ line }) => /notApplicable:\s*'no-command-declared'/.test(line))
    .map(({ at }) => at));
  assert.equal(sites.length, 1, `the exemption must have exactly one producer, found ${sites.join(', ')}`);
  assert.match(sites[0]!, /^stack\.ts:/);
});
