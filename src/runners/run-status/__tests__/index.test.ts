import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  activateRunV2RollbackBarrier,
  activeRunClaimScan,
  readRunSettlement,
  writeRunSettlement,
} from '../../../shared/run-settlement';
import { validateQaReportV2, qaReportV2Path, type QaReportV2 } from '../../../shared/qa-report-v2';
import {
  lighthouseFor,
  reportFor,
  setup,
  startBuildServer,
  stopBuildServer,
  withProject,
  BUILD_OUTPUT_ROOT,
} from '../../../shared/__tests__/qa-v2-fixture';
import { main, parseRunStatusArgs } from '../index';

function silenced(root: string, run: (root: string) => void): void {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    run(root);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Run `fn` with stdout discarded and stderr CAPTURED, restoring both. */
function capturedStderr(fn: () => void): string {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let captured = '';
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    captured += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return captured;
}

// Reconstruct the 14cl artifact shape (run 1785511629914) in a temp project:
//  - a VISUAL v2 contract with REAL accepted evidence (report, machine
//    evidence, screenshots, Lighthouse, acceptance attestation),
//  - reviewer APPROVED + tester TESTS_GREEN digests written after the report,
//  - the rollback-barrier MASK: run.json projected failed/agent-failed over
//    canonicalStatus 'validating',
//  - a post-acceptance probe rebuild of the build output dir (the reviewer's
//    `pnpm build`) and the poisoned report-v2.json that a re-validation
//    against that drifted tree durably persisted (status failed +
//    machine-evidence gate, file mtime NEWER than the tester digest),
//  - live top-level role claims plus archived snapshots under superseded/.
// Returns the paths the assertions need.
async function build14clShape(cwd: string, options: { testerVerdict?: string } = {}): Promise<{
  reportPath: string;
  report: QaReportV2;
  claimFiles: string[];
  supersededFiles: string[];
}> {
  const contract = setup(cwd, {
    schemaVersion: 1,
    routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
    modules: [{ id: 'home', name: 'Home', kind: 'page' }],
  }, { changedPaths: ['apps/web/src/pages/Home.tsx'] }, {
    'apps/web/src/pages/Home.tsx': 'export const Home=()=> <main/>;\n',
  });

  // Ledger active, then the V2 rollback barrier with canonical 'validating' —
  // run.json now physically reads failed/agent-failed (the mask).
  assert.equal(main(['--run-id', 'R', '--status', 'active'], cwd), 0);
  assert.ok(activateRunV2RollbackBarrier(cwd, 'R', 'validating'));
  assert.ok(writeRunSettlement(cwd, 'R', {
    status: 'validating',
    incompleteChecks: ['verification-incomplete'],
  }));

  // Real accepted QA evidence, produced against the live build tree.
  const running = await startBuildServer(cwd, contract);
  let report: QaReportV2;
  try {
    const lighthouse = lighthouseFor(cwd, contract, running.build);
    report = reportFor(cwd, contract, [390, 1440], {
      screenshots: true,
      lighthouse,
      build: running.build,
    });
    fs.writeFileSync(qaReportV2Path(cwd, 'R'), JSON.stringify(report));
    assert.equal(
      validateQaReportV2(report, cwd, 'R', contract).ok,
      true,
      'the fixture evidence must pass live validation and write the acceptance attestation',
    );
  } finally {
    await stopBuildServer(running);
  }

  // Verifier digests, attested AFTER the report was generated (like 14cl:
  // tester TESTS_GREEN 43s after report.generatedAt).
  const digests = path.join(cwd, '.traffic-one', 'digests', 'R');
  fs.mkdirSync(digests, { recursive: true });
  fs.writeFileSync(path.join(digests, 'reviewer.md'), '# reviewer\nverdict: APPROVED\n');
  fs.writeFileSync(
    path.join(digests, 'tester.md'),
    `# tester\nverdict: ${options.testerVerdict ?? 'TESTS_GREEN'}\n`,
  );
  const testerAttestedAt = new Date(Date.parse(report.generatedAt) + 2_000);
  fs.utimesSync(path.join(digests, 'tester.md'), testerAttestedAt, testerAttestedAt);

  // The reviewer's post-QA probe rebuild: the output tree drifts.
  fs.writeFileSync(path.join(cwd, BUILD_OUTPUT_ROOT, 'index.html'), '<main>reviewer probe build</main>\n');

  // The poisoned sidecar exactly as persistGateRejection wrote it on 14cl,
  // with a file mtime well after the tester digest.
  const reportPath = qaReportV2Path(cwd, 'R');
  fs.writeFileSync(reportPath, JSON.stringify({
    ...report,
    status: 'failed',
    gates: [{
      id: 'machine-evidence',
      status: 'failed',
      code: 'machine-evidence-invalid',
      summary: 'runtime browser did not serve any response body from the recorded build output manifest',
    }],
  }));
  const poisonedAt = new Date(Date.parse(report.generatedAt) + 10_000);
  fs.utimesSync(reportPath, poisonedAt, poisonedAt);

  // Live role claims plus archived snapshots — 14cl held 4 live claims and 15
  // superseded/ archives, all counted as "active" by the pre-fix scan.
  const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
  const claimFiles = [
    path.join(runDir, 'thread-frontend.json'),
    path.join(runDir, 'thread-tester.json'),
  ];
  fs.writeFileSync(claimFiles[0]!, JSON.stringify({
    role: 'senior-frontend', claimId: 'claim-frontend-2', status: 'claimed',
  }));
  fs.writeFileSync(claimFiles[1]!, JSON.stringify({
    role: 'senior-tester', claimId: 'claim-tester-2', status: 'claimed',
  }));
  fs.mkdirSync(path.join(runDir, 'superseded'), { recursive: true });
  const supersededFiles = [
    path.join(runDir, 'superseded', 'claim-frontend-1.1.json'),
    path.join(runDir, 'superseded', 'claim-tester-1.1.json'),
  ];
  for (const file of supersededFiles) {
    fs.writeFileSync(file, JSON.stringify({
      role: 'senior-frontend', claimId: 'claim-old', status: 'claimed', supersededBy: 'claim-new',
    }));
  }
  return { reportPath, report, claimFiles, supersededFiles };
}

// The green mirror of 'a capped red run settles terminal with zero active
// claims': the EXACT 14cl artifact shape must settle completed/verified.
// Pre-fix, this shape returned null three independent ways — the poisoned
// report failed runHasQaEvidence, the report rewrite made the tester
// attestation read stale, and the superseded/ archives kept activeClaims
// positive forever.
test('the 14cl shape — green verdicts, accepted-then-poisoned QA report, masked ledger, archived claims — settles verified', async () => {
  await withProject(async (cwd) => {
    const { claimFiles, supersededFiles } = await build14clShape(cwd);

    // The mask is on and archives are not liveness.
    const masked = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'run.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(masked.status, 'failed');
    assert.equal(masked.outcome, 'agent-failed');
    assert.equal(masked.canonicalStatus, 'validating');
    assert.equal(activeRunClaimScan(cwd, 'R').count, 2, 'superseded/ snapshots are history, not active claims');

    const stderr = capturedStderr(() => {
      assert.equal(main(['--run-id', 'R', '--status', 'completed', '--outcome', 'verified'], cwd), 0);
    });
    assert.equal(stderr, '', 'the green settle must not print a rejection');

    const settlement = readRunSettlement(cwd, 'R');
    assert.equal(settlement?.status, 'verified');
    assert.equal(settlement?.activeClaims, 0);
    assert.deepEqual(settlement?.incompleteChecks, []);
    assert.equal(activeRunClaimScan(cwd, 'R').count, 0, 'the green path must release its claims');
    for (const file of claimFiles) {
      const claim = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      assert.equal(claim.status, 'released');
      assert.equal(claim.releasedReason, 'terminal-verified-evidence');
    }
    for (const file of supersededFiles) {
      const snapshot = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      assert.equal(snapshot.status, 'claimed', 'archived history is immutable');
    }
    const ledger = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'run.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(ledger.status, 'completed');
    assert.equal(ledger.outcome, 'verified');
    assert.equal(ledger.canonicalStatus, 'verified');
    assert.equal(ledger.runtimeV2RollbackGuard, undefined);
  });
});

test('the same shape with tester TESTS_FAILING keeps every claim and names the tester predicate', async () => {
  await withProject(async (cwd) => {
    const { claimFiles } = await build14clShape(cwd, { testerVerdict: 'TESTS_FAILING' });

    const stderr = capturedStderr(() => {
      assert.equal(main(['--run-id', 'R', '--status', 'completed', '--outcome', 'verified'], cwd), 1);
    });
    assert.match(stderr, /tester digest is not TESTS_GREEN/);
    assert.match(stderr, /TESTS_FAILING/);
    assert.match(stderr, /compatibility projection/);

    assert.equal(activeRunClaimScan(cwd, 'R').count, 2, 'a red run keeps its claims');
    for (const file of claimFiles) {
      const claim = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      assert.equal(claim.status, 'claimed');
    }
    assert.equal(readRunSettlement(cwd, 'R')?.status, 'validating');
  });
});

test('green digests with deleted machine evidence fail closed naming the evidence check', async () => {
  await withProject(async (cwd) => {
    const { claimFiles } = await build14clShape(cwd);
    fs.rmSync(path.join(cwd, '.traffic-one', 'reports', 'qa', 'R', 'machine-evidence-v1.json'));

    const stderr = capturedStderr(() => {
      assert.equal(main(['--run-id', 'R', '--status', 'completed', '--outcome', 'verified'], cwd), 1);
    });
    assert.match(stderr, /QA evidence did not validate — machine-evidence-invalid/);
    // With the evidence file gone the recovery cannot vouch, so the rejection
    // surfaces the persisted machine-evidence gate's own summary.
    assert.match(stderr, /Playwright evidence|build output manifest/);

    assert.equal(activeRunClaimScan(cwd, 'R').count, 2, 'failed evidence keeps the claims');
    for (const file of claimFiles) {
      const claim = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      assert.equal(claim.status, 'claimed');
    }
    assert.notEqual(readRunSettlement(cwd, 'R')?.status, 'verified');
  });
});

test('parseRunStatusArgs accepts only bounded ledger vocabulary', () => {
  assert.deepEqual(parseRunStatusArgs([
    '--run-id', 'run-1', '--status', 'blocked', '--outcome', 'test-cycle-cap',
  ]), { runId: 'run-1', status: 'blocked', outcome: 'test-cycle-cap' });
  assert.equal(parseRunStatusArgs(['--run-id', 'run-1', '--status', 'done']), null);
  assert.equal(parseRunStatusArgs([
    '--run-id', 'run-1', '--status', 'active', '--reason', 'automatic-retry',
  ]), null);
});

test('run-status CLI persists validated transitions and rejects an unauthorized blocked resume', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-run-status-'));
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal(main(['--run-id', 'run-1', '--status', 'active'], root), 0);
    assert.equal(main([
      '--run-id', 'run-1', '--status', 'blocked', '--outcome', 'review-cycle-cap',
    ], root), 0);
    assert.equal(main(['--run-id', 'run-1', '--status', 'active'], root), 1);
    assert.equal(main([
      '--run-id', 'run-1', '--status', 'active', '--reason', 'user-authorized-extra-cycle',
    ], root), 0);
    const ledger = JSON.parse(fs.readFileSync(
      path.join(root, '.traffic-one', 'runs', 'run-1', 'run.json'),
      'utf8',
    )) as Record<string, unknown>;
    assert.equal(ledger.status, 'active');
    assert.equal(ledger.qaContractVersion, 1);
    assert.deepEqual(
      (ledger.transitionHistory as Array<Record<string, unknown>>).map((entry) => entry.to),
      ['active', 'blocked', 'active'],
    );
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A run that ends RED (reviewer CHANGES_REQUESTED + tester TESTS_FAILING, capped)
// used to keep every claim it staked: `releaseRunClaims` was reachable only from
// the verified/shipped branches of `settleTerminalRunLedger`, so the canonical
// settlement recorded a terminal status while `activeClaims` stayed positive and
// no later writer could tell a live agent from a finished one.
test('a capped red run settles terminal with zero active claims and a recorded reason', () => {
  silenced(fs.mkdtempSync(path.join(os.tmpdir(), 't1-run-status-red-')), (root) => {
    assert.equal(main(['--run-id', 'run-red', '--status', 'active'], root), 0);
    // Mirrors PLAN_READY: barrier activation followed by the seed settlement.
    assert.ok(activateRunV2RollbackBarrier(root, 'run-red'));
    assert.ok(writeRunSettlement(root, 'run-red', {
      status: 'active',
      incompleteChecks: ['verification-not-started'],
    }));

    const runDir = path.join(root, '.traffic-one', 'runs', 'run-red');
    fs.writeFileSync(path.join(runDir, 'thread-frontend.json'), JSON.stringify({
      role: 'senior-frontend',
      claimId: 'claim-frontend',
      status: 'claimed',
    }));
    fs.writeFileSync(path.join(runDir, 'thread-reviewer.json'), JSON.stringify({
      role: 'senior-reviewer',
      claimId: 'claim-reviewer',
      status: 'active',
    }));
    fs.mkdirSync(path.join(runDir, 'pending'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'pending', 'tester.json'), JSON.stringify({
      role: 'senior-tester',
      createdAt: new Date().toISOString(),
    }));
    const digests = path.join(root, '.traffic-one', 'digests', 'run-red');
    fs.mkdirSync(digests, { recursive: true });
    fs.writeFileSync(path.join(digests, 'reviewer.md'), '# reviewer\nverdict: CHANGES_REQUESTED\n');
    fs.writeFileSync(path.join(digests, 'tester.md'), '# tester\nverdict: TESTS_FAILING\n');
    assert.equal(activeRunClaimScan(root, 'run-red').count, 2);

    assert.equal(main([
      '--run-id', 'run-red', '--status', 'blocked', '--outcome', 'review-cycle-cap',
    ], root), 0);

    assert.equal(activeRunClaimScan(root, 'run-red').count, 0, 'the red path must release its claims');
    assert.equal(fs.existsSync(path.join(runDir, 'pending', 'tester.json')), false);
    const settlement = readRunSettlement(root, 'run-red');
    assert.equal(settlement?.status, 'blocked');
    assert.equal(settlement?.reason, 'review-cycle-cap');
    assert.equal(settlement?.activeClaims, 0);

    const ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(ledger.canonicalStatus, 'blocked');
    const history = ledger.transitionHistory as Array<Record<string, unknown>>;
    assert.equal(history[history.length - 1]!.to, 'blocked');
    assert.equal(history[history.length - 1]!.outcome, 'review-cycle-cap');
    assert.equal(ledger.statusUpdatedAt, history[history.length - 1]!.at);
  });
});

// The retention sweep fires the moment a run reaches a TERMINAL ledger state —
// not on planned/active — so superseded artefacts stop waiting for the next
// SessionStart (12co: 113 files / 9.5 MB of reports outlived their run by hours).
test('a terminal transition triggers the retention sweep; a non-terminal one does not', () => {
  silenced(fs.mkdtempSync(path.join(os.tmpdir(), 't1-run-status-sweep-')), (root) => {
    fs.mkdirSync(path.join(root, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(root, '.traffic-one', '.one.json'), JSON.stringify({ currentRunId: 'run-2' }), 'utf8');
    fs.writeFileSync(
      path.join(root, '.traffic-one', 'retention.json'),
      JSON.stringify({ keepRuns: 1, backupKeep: 1, orphanTtlDays: 3650 }),
      'utf8',
    );
    for (const id of ['run-0', 'run-1', 'run-2']) {
      fs.mkdirSync(path.join(root, '.traffic-one', 'digests', id), { recursive: true });
    }

    // Non-terminal: no sweep — the superseded digest dirs survive.
    assert.equal(main(['--run-id', 'run-2', '--status', 'active'], root), 0);
    assert.equal(fs.existsSync(path.join(root, '.traffic-one', 'digests', 'run-0')), true);

    // Terminal: the sweep runs for real; the current run stays untouched.
    assert.equal(main(['--run-id', 'run-2', '--status', 'blocked', '--outcome', 'review-cycle-cap'], root), 0);
    assert.equal(fs.existsSync(path.join(root, '.traffic-one', 'digests', 'run-0')), false, 'superseded run reclaimed at settlement');
    assert.equal(fs.existsSync(path.join(root, '.traffic-one', 'digests', 'run-2')), true, 'current run protected');
    assert.equal(fs.existsSync(path.join(root, '.traffic-one', 'runs', 'run-2')), true, 'the settling run keeps its ledger');
  });
});

test('run-status CLI rejects completed outcomes until verification or shipper evidence exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-run-status-evidence-'));
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal(main(['--run-id', 'run-2', '--status', 'active'], root), 0);
    assert.equal(main([
      '--run-id', 'run-2', '--status', 'completed', '--outcome', 'verified',
    ], root), 1, 'text-free completion is rejected');

    const digests = path.join(root, '.traffic-one', 'digests', 'run-2');
    fs.mkdirSync(digests, { recursive: true });
    fs.writeFileSync(path.join(digests, 'backend.md'), '# backend\nBUILD_COMPLETE\n');
    fs.writeFileSync(path.join(digests, 'reviewer.md'), '# reviewer\nverdict: APPROVED\n');
    fs.writeFileSync(path.join(digests, 'tester.md'), '# tester\nverdict: TESTS_GREEN\n');
    assert.equal(main([
      '--run-id', 'run-2', '--status', 'completed', '--outcome', 'verified',
    ], root), 0);
    assert.equal(main([
      '--run-id', 'run-2', '--status', 'completed', '--outcome', 'shipped',
    ], root), 1, 'verified is not synonymous with shipped');
    fs.writeFileSync(path.join(digests, 'shipper.md'), '# shipper\nverdict: SHIPPED\n');
    assert.equal(main([
      '--run-id', 'run-2', '--status', 'completed', '--outcome', 'shipped',
    ], root), 0);

    const ledger = JSON.parse(fs.readFileSync(
      path.join(root, '.traffic-one', 'runs', 'run-2', 'run.json'),
      'utf8',
    )) as Record<string, unknown>;
    assert.equal(ledger.status, 'completed');
    assert.equal(ledger.outcome, 'shipped');
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
