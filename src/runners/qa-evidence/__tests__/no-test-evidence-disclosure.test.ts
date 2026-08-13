// src/runners/qa-evidence/__tests__/no-test-evidence-disclosure.test.ts
// A run that settled WITHOUT TEST EVIDENCE has to say so, in all three places.
//
// The product decision is DISCLOSE, NOT REFUSE: a Node or plain-PHP project
// with a build script and no test script may still settle. What it may not do
// is settle quietly. Before this round the only route that existed was the
// quiet one — the verdict said `passed` and said nothing else, the advisory
// channel was populated only by Lighthouse thresholds, `publishStackReport`
// dropped advisories so completely that the field was not in its return type,
// and the tester completion gate reads nothing at all on the SUCCESS path. The
// absence reached the disk and stopped there.
//
// Three rows for three places, plus the two that keep the disclosure HONEST: it
// must not fire on a project that does run tests, and it must not be assertable
// by a report that says so without the checks to match.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { compileArchitecture } from '../../../shared/architecture-contract';
import { planReadinessViolations } from '../../../modules/plan-guard/plan-readiness';
import {
  QA_NOT_APPLICABLE_REASONS,
  notApplicableDisposition,
  qaReportV2Path,
  reportSettledWithoutTestEvidence,
  type QaReportV2,
} from '../../../shared/qa-report-v2';
import { formatSchemaIssues, newSchemaIssues, parseReport } from '../../../shared/qa-report-v2/schema';
import { compileVerificationContract } from '../../../shared/verification-contract';
import { parseArgs } from '../cli';
import { loadStackRun, publishStackReport } from '../run-context';
import { runStackChecks, stackReportStatus } from '../stack';

const RUN_ID = 'R';

const STATE = {
  mode: 'existing-codebase',
  stack: 'custom-backend',
  frontend: 'none',
  backend: 'node',
  mobile: { framework: 'none' },
  onboardingComplete: true,
};

function withProject(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-disclose-')));
  return fn(cwd).finally(() => fs.rmSync(cwd, { recursive: true, force: true }));
}

/**
 * The shape the exemption exists for: an api-only contract over a Node project
 * that declares a build and no test.
 *
 * `scripts.test` absent is the whole fixture. Every other stack resolves a test
 * command from a pinned language default — `go test ./...`, `cargo test`,
 * `pytest -q` — so this is the only family that can reach the exemption at all,
 * which is why `TEST_EVIDENCE_CHECK_IDS` is a list of one.
 */
function nodeProject(cwd: string, scripts: Record<string, string>): void {
  fs.mkdirSync(path.join(cwd, 'internal/api'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'internal/api/handler.txt'), 'handler\n');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'api', scripts }));
  const architecture = compileArchitecture(cwd, RUN_ID, STATE, {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'api', name: 'Api', kind: 'feature' }],
  });
  const contract = compileVerificationContract(cwd, RUN_ID, STATE, architecture, {
    changedPaths: ['internal/api/handler.txt'],
  });
  assert.equal(contract.browserRequired, false, 'fixture guard: the stack command owns this verdict');
  assert.ok(contract.requiredChecks.includes('stack-test'), 'fixture guard: stack-test must be required');
}

async function runStack(cwd: string): Promise<{
  report: QaReportV2;
  ok: boolean;
  advisories: string[];
  onDisk: QaReportV2;
}> {
  const args = parseArgs(['stack', '--project-root', cwd, '--run-id', RUN_ID], cwd)!;
  const loaded = loadStackRun(args);
  assert.ok(loaded.ok, 'fixture guard: the run must load');
  const checks = await runStackChecks(args, loaded.run.contract.requiredChecks);
  const published = publishStackReport(args, loaded.run, stackReportStatus(checks), checks);
  return {
    report: published.report,
    ok: Boolean(published.ok),
    advisories: published.advisories,
    onDisk: JSON.parse(fs.readFileSync(qaReportV2Path(cwd, RUN_ID), 'utf8')) as QaReportV2,
  };
}

// PLACE ONE: THE DURABLE ARTIFACT, at the top level of it.
//
// Not buried in the checks array, because the two readers that matter — a later
// gate and a human — should not have to know which check id carries the news.
// And not written `false` when there is nothing to disclose: the artifact
// carries a claim only when there is one.
test('a run that excuses its test check discloses that at the top of the report', async () => {
  await withProject(async (cwd) => {
    nodeProject(cwd, { build: 'node -e ""' });
    const run = await runStack(cwd);

    assert.equal(run.ok, true, 'fixture guard: a build-only Node project still settles — the ruling is DISCLOSE');
    assert.equal(run.report.settledWithoutTestEvidence, true);
    assert.equal(run.onDisk.settledWithoutTestEvidence, true,
      'the disclosure has to survive to disk, which is the copy a later gate reads');
    assert.equal(run.onDisk.status, 'passed', 'and it is a disclosure, not a refusal');
  });
});

// PLACE TWO: THE ADVISORY, emitted at the moment the exemption is granted, and
// carried back rather than dropped. `publishStackReport` used not to have the
// field at all — the validator produced advisories and the stack path threw
// them away between two statements.
test('the exemption produces an advisory the stack path carries back', async () => {
  await withProject(async (cwd) => {
    nodeProject(cwd, { build: 'node -e ""' });
    const run = await runStack(cwd);

    assert.equal(run.advisories.length, 1, `expected one advisory, got: ${JSON.stringify(run.advisories)}`);
    const advisory = run.advisories[0]!;
    assert.match(advisory, /stack-test/, 'it must name what was not measured');
    assert.match(advisory, /declares no such command/, 'and why it was not measured');
    assert.match(advisory, /Nothing here says the code is covered/,
      'and it must not let a reader mistake an excused check for a passed one');
  });
});

// PLACE THREE: WHAT THE USER IS TOLD. The completion gate had no success path
// at all — it read `result.code` and `result.message`, both of which exist only
// on failure — so a disclosure that reached the artifact reached nobody.
//
// The route is a BLOCK rather than a notice, and that is a deliberate second
// choice: `planReadinessViolations` returns blocking violations and nothing
// else, and adding a non-blocking channel through it is a cross-cutting change
// to a module three other lanes are editing this week. Blocking is also the
// stronger reading of the ruling — the tester's own digest is what a human
// reads, so the disclosure belongs in it, written by the role that settled.
test('the tester cannot claim TESTS_GREEN on an excused test check without saying so', async () => {
  await withProject(async (cwd) => {
    nodeProject(cwd, { build: 'node -e ""' });
    assert.equal((await runStack(cwd)).ok, true, 'fixture guard: the run settles');

    const digest = (content: string): string[] => planReadinessViolations({
      filePath: `.traffic-one/digests/${RUN_ID}/tester.md`,
      content,
      projectRoot: cwd,
      state: STATE,
      writingFeatureSource: false,
      block: (name: string) => name,
    });

    const quiet = digest('verdict: TESTS_GREEN\n- All checks green.\n');
    assert.ok(
      quiet.includes('tester-no-test-evidence-disclosure'),
      `a silent TESTS_GREEN must be refused, got: ${quiet.join(' | ')}`,
    );

    const disclosed = digest(
      'verdict: TESTS_GREEN\n'
      + '- NO_TEST_EVIDENCE — stack-test was excused: this project declares no test command, so no tests ran.\n',
    );
    assert.ok(
      !disclosed.includes('tester-no-test-evidence-disclosure'),
      'and disclosing it must be enough to proceed — the ruling is DISCLOSE, not REFUSE',
    );
  });
});

// THE HONESTY OF THE SIGNAL. A disclosure that fires on every run means nothing
// by the second week, and this one is one check id wide: a project that runs
// its tests says nothing about missing evidence, and neither does a missing
// FORMATTER, which is on the same exemption allowlist and deliberately not on
// this one.
test('a project that runs its tests discloses nothing and advises nothing', async () => {
  await withProject(async (cwd) => {
    nodeProject(cwd, { build: 'node -e ""', test: 'node -e ""' });
    const run = await runStack(cwd);

    assert.equal(run.ok, true);
    assert.equal(run.report.settledWithoutTestEvidence, undefined, 'nothing to disclose is not `false`, it is absent');
    assert.ok(!('settledWithoutTestEvidence' in run.onDisk));
    assert.deepEqual(run.advisories, []);
    assert.equal(reportSettledWithoutTestEvidence(run.report.checks), false);
  });
});

// AND IT CANNOT BE ASSERTED WITHOUT THE CHECKS TO MATCH, in either direction.
// The field is a SUMMARY of the check array, derived by the producer and the
// validator from one function, so a report whose summary disagrees with what it
// summarises is not a report this schema accepts — otherwise the disclosure
// would be another author-writable claim, which is the defect this round spent
// its blocker on.
test('the disclosure field must agree with the checks it summarises', () => {
  const base = {
    schemaVersion: 2,
    runId: RUN_ID,
    verificationContractHash: 'a'.repeat(64),
    generatedAt: '2026-08-11T00:00:00.000Z',
    producer: 'parent-runner',
    sourceHash: 'b'.repeat(64),
    routes: [],
  };
  const excused = {
    id: 'stack-test',
    status: 'not-applicable',
    notApplicable: 'no-command-declared',
    summary: 'not run: no test script',
  };
  const passed = { id: 'stack-test', status: 'passed', summary: 'passed in 1 ms' };

  const parse = (value: unknown): { report: QaReportV2 | null; issues: string } => {
    const collector = newSchemaIssues();
    const report = parseReport(value, collector);
    return { report, issues: formatSchemaIssues(collector) };
  };

  const claimedWithoutBasis = parse({
    ...base, status: 'passed', checks: [passed], settledWithoutTestEvidence: true,
  });
  assert.equal(claimedWithoutBasis.report, null);
  assert.match(claimedWithoutBasis.issues, /settledWithoutTestEvidence: must agree with the checks/);

  const hiddenWhenTrue = parse({
    ...base, status: 'passed', checks: [excused], settledWithoutTestEvidence: false,
  });
  assert.equal(hiddenWhenTrue.report, null, 'the direction that matters: a run may not deny its own absence');
  assert.match(hiddenWhenTrue.issues, /settledWithoutTestEvidence: must agree with the checks/);

  const consistent = parse({
    ...base, status: 'passed', checks: [excused], settledWithoutTestEvidence: true,
  });
  assert.ok(consistent.report, `a consistent report must parse: ${consistent.issues}`);
  assert.equal(consistent.report?.settledWithoutTestEvidence, true, 'and the field must survive the parse');
});

// ---------------------------------------------------------------------------
// THE FIFTH REASON.
// ---------------------------------------------------------------------------

// `QA_NOT_APPLICABLE_REASONS` is a closed tuple with a runtime membership check
// and an enumeration test, so a fifth member reds SOMETHING. What it did not do
// was red at the two places that decide, and those two failed in opposite
// directions: the exemption predicate compared against the literal
// `'no-command-declared'` (a fifth reason is refused the exemption — fail
// closed, correct), while the producer's cut-short rule compared against the
// literal `'cut-short'` (a fifth reason denoting signal death would slip it —
// fail OPEN, and that is the direction that costs). Two literals a hundred
// lines apart cannot fail the same way.
//
// `notApplicableDisposition` is a switch with a `never` default, so the
// compiler now refuses a fifth member that has not been classified. A compile
// error is not observable from a test, so what is asserted here is the
// consequence: every reason has a disposition, and the two rules read THAT
// rather than a string of their own.
test('every not-applicable reason is classified, and the classification is what the rules read', () => {
  for (const reason of QA_NOT_APPLICABLE_REASONS) {
    assert.ok(
      ['excusable', 'no-verdict', 'not-excusable'].includes(notApplicableDisposition(reason)),
      `${reason} has no disposition`,
    );
  }
  // Absence is not excusable and not signal death: a report from a runner older
  // than the field, or a hand-authored one, says nothing and gets nothing.
  assert.equal(notApplicableDisposition(undefined), 'not-excusable');

  const check = (notApplicable: string | undefined): QaReportV2['checks'] => [{
    id: 'stack-test',
    status: 'not-applicable' as const,
    ...(notApplicable ? { notApplicable: notApplicable as 'cut-short' } : {}),
    summary: 'x',
  }];
  assert.equal(stackReportStatus(check('no-command-declared')), 'passed', 'excusable is the only one that settles');
  assert.equal(stackReportStatus(check('cut-short')), 'failed');
  assert.equal(stackReportStatus(check('declared-not-runnable')), 'failed');
  assert.equal(stackReportStatus(check('evidence-not-captured')), 'failed');
  assert.equal(stackReportStatus(check(undefined)), 'failed',
    'a verdictless check that names no reason is not a pass — the fail-closed answer, from one place');
});
