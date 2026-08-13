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

// Settling an OLDER run (the codex-child deny remedy: settle it and mint a new
// one) must never let the same-invocation sweep reclaim the ledger it just
// wrote: currentRunId alone does not protect an arbitrary --run-id
// (adversarial review), so the settled id is protected explicitly.
test('the settlement sweep protects the run being settled even when it is not current', () => {
  silenced(fs.mkdtempSync(path.join(os.tmpdir(), 't1-run-status-protect-')), (root) => {
    fs.mkdirSync(path.join(root, '.traffic-one'), { recursive: true });
    // current is run-9; the settled run-1 is OLDEST and outside keepRuns:1.
    fs.writeFileSync(path.join(root, '.traffic-one', '.one.json'), JSON.stringify({ currentRunId: 'run-9' }), 'utf8');
    fs.writeFileSync(
      path.join(root, '.traffic-one', 'retention.json'),
      JSON.stringify({ keepRuns: 1, backupKeep: 1, orphanTtlDays: 3650 }),
      'utf8',
    );
    for (const id of ['run-1', 'run-5', 'run-6', 'run-9']) {
      fs.mkdirSync(path.join(root, '.traffic-one', 'digests', id), { recursive: true });
    }
    assert.equal(main(['--run-id', 'run-1', '--status', 'active'], root), 0);
    assert.equal(main(['--run-id', 'run-1', '--status', 'blocked', '--outcome', 'review-cycle-cap'], root), 0);
    assert.equal(fs.existsSync(path.join(root, '.traffic-one', 'runs', 'run-1')), true, 'the settled run keeps its ledger');
    assert.equal(fs.existsSync(path.join(root, '.traffic-one', 'digests', 'run-1')), true, 'the settled run keeps its digests');
    assert.equal(fs.existsSync(path.join(root, '.traffic-one', 'digests', 'run-9')), true, 'current stays protected');
    assert.equal(fs.existsSync(path.join(root, '.traffic-one', 'digests', 'run-5')), false, 'a genuinely superseded run is still reclaimed');
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

// The sweep is IRREVERSIBLE and used to answer `void`, so a settlement whose
// cleanup reclaimed nothing it planned printed `{"ok":true,…}` and said no more.
// The commonest half is a REFUSAL rather than a crash (the crash is the row
// below, and it is reachable too): `removePath` answers false when
// the state-write fence declines a path, and a project whose use-plugin consent
// is unanswered has every path declined — `.traffic-one` then grows without
// bound while every settlement reports success.
//
// The fence here is the READ-BEFORE-WRITE variant. The sweep schedules
// `.codegraph-build-lock` only after `existsSync` and a `statSync` mtime resolve
// at it, so a DANGLING link is never scheduled and `removePath` is never
// reached; the real file is moved aside and the original name links to it, with
// a guard below that the read still resolves. The unfenced digest dir is the
// WRITABLE BASELINE: it must really be reclaimed in the same call.
test('a settlement whose cleanup was REFUSED still exits 0, and says so', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-run-status-refused-'));
  try {
    fs.mkdirSync(path.join(root, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(root, '.traffic-one', '.one.json'), JSON.stringify({ currentRunId: 'run-2' }), 'utf8');
    fs.writeFileSync(
      path.join(root, '.traffic-one', 'retention.json'),
      JSON.stringify({ keepRuns: 1, backupKeep: 1, orphanTtlDays: 3 }),
      'utf8',
    );
    // keepRuns:1 plus the reserved current/settled id means run-2 and run-1
    // survive and run-0 is the one genuinely superseded candidate.
    for (const id of ['run-0', 'run-1', 'run-2']) {
      fs.mkdirSync(path.join(root, '.traffic-one', 'digests', id), { recursive: true });
    }
    const lock = path.join(root, '.traffic-one', '.codegraph-build-lock');
    const behind = `${lock}.real`;
    const stale = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
    fs.writeFileSync(behind, 'held\n', 'utf8');
    fs.utimesSync(behind, stale, stale);
    fs.symlinkSync(behind, lock);
    assert.equal(fs.existsSync(lock), true, 'fixture: the link RESOLVES — a dangling one is never scheduled');

    assert.equal(capturedStderr(() => {
      assert.equal(main(['--run-id', 'run-2', '--status', 'active'], root), 0);
    }), '', 'a non-terminal transition sweeps nothing and reports nothing');

    let code = -1;
    const stderr = capturedStderr(() => {
      code = main(['--run-id', 'run-2', '--status', 'blocked', '--outcome', 'review-cycle-cap'], root);
    });
    assert.equal(code, 0, 'the SETTLEMENT stands — cleanup must never fail it');
    assert.equal(
      fs.existsSync(path.join(root, '.traffic-one', 'digests', 'run-0')),
      false,
      'WRITABLE BASELINE: the unfenced candidate really was reclaimed',
    );
    assert.equal(fs.lstatSync(lock).isSymbolicLink(), true, 'the fenced candidate survived, as the fence intends');
    assert.match(
      stderr,
      /run-status: run run-2 settled blocked and the settlement stands, but post-settlement cleanup reclaimed only \d+ of \d+ candidate path\(s\) — 1 refused by the state-write fence\. Re-run it with `traffic-one-cleanup\.cjs --apply`\./,
      'the CLI names the run, the shortfall, and the command that retries it',
    );
    // "the rest were refused" USED TO BE THIS LINE, and it was the same
    // falsehood the report carried: everything short of `removed` was called a
    // refusal, including a removal that THREW. The two are now counted apart, so
    // this line may only say `refused` about paths the fence actually declined —
    // and the row below drives the other half against a real errno.
    assert.ok(!stderr.includes('filesystem error'), 'and nothing here threw, so no error is claimed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The other half of the same line, and the reason it had to be split. A
// recursive `rmSync` that THROWS is not a fence refusal, but `refused` was
// `planned - removed`, so this CLI told the user verbatim about "unanswered
// use-plugin consent, a planted symlink, or a path escaping the state dir" for
// an ENOTEMPTY — three remedies, none of which would have changed anything, on a
// run where part of the tree had already been destroyed.
//
// The fixture is a LEAKED NESTED ROOT holding only recognised runtime artefacts,
// which is the one plan shape that hands `rmSync` a tree to walk, with a `0o111`
// child it cannot list. Mirrors shared/__tests__/retention.test.ts, driven here
// through the CLI that words the report.
test('a settlement whose cleanup THREW is not reported as a refusal', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-run-status-threw-')));
  const memoryDir = '.traffic' + '-one';
  const blocked = path.join(root, 'apps', 'web', memoryDir, 'debug');
  try {
    fs.mkdirSync(path.join(root, memoryDir), { recursive: true });
    fs.writeFileSync(path.join(root, memoryDir, '.one.json'), JSON.stringify({ currentRunId: 'run-2' }), 'utf8');
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n", 'utf8');
    const nested = path.join(root, 'apps', 'web', memoryDir);
    fs.mkdirSync(blocked, { recursive: true });
    // Non-empty: an EMPTY directory is removed by the parent's write bit alone
    // and never reads the mode under test.
    fs.writeFileSync(path.join(blocked, 'trace.jsonl'), '{}', 'utf8');
    fs.mkdirSync(path.join(nested, 'runs', '9001'), { recursive: true });
    fs.writeFileSync(path.join(nested, '.one.json'), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');

    fs.chmodSync(blocked, 0o111);
    let code = -1;
    const stderr = (() => {
      try {
        return capturedStderr(() => {
          code = main(['--run-id', 'run-2', '--status', 'blocked', '--outcome', 'review-cycle-cap'], root);
        });
      } finally {
        fs.chmodSync(blocked, 0o755);
      }
    })();
    if (!fs.existsSync(nested)) {
      t.skip('running with a uid that ignores 0o111 — rmSync could read the child directory anyway');
      return;
    }

    assert.equal(code, 0, 'the SETTLEMENT stands — cleanup must never fail it');
    assert.match(
      stderr,
      /cleanup reclaimed only 0 of 1 candidate path\(s\) — 1 failed with a filesystem error\./,
      'the CLI names the cause that actually occurred',
    );
    assert.ok(!stderr.includes('refused by the state-write fence'),
      'and never the one that did not: no fence declined anything here');
    assert.ok(stderr.includes('could not remove'), 'with the sweep\'s own errno line beside it');
  } finally {
    try { fs.chmodSync(blocked, 0o755); } catch { /* already restored, or never created */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A sweep can refuse NOTHING, reclaim NOTHING, and still be the reason a state
// dir grows without bound: an illegible `.one.json` suspends the run-history caps
// until a human repairs it. `planned`, `removed` and `refused` all read 0, so the
// shortfall line above cannot fire, and TerminalSweepReport used to drop the
// notices field at the type level — neither of this function's callers could
// surface the condition even if it had wanted to.
test('a settlement whose sweep is SUSPENDED prints the remedy, though nothing was refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-run-status-suspended-'));
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let out = '';
  let err = '';
  try {
    fs.mkdirSync(path.join(root, '.traffic-one'), { recursive: true });
    // Parses as nothing: the policy reader answers `corrupt` and suspends.
    fs.writeFileSync(path.join(root, '.traffic-one', '.one.json'), '{ "currentRunId": ', 'utf8');
    fs.mkdirSync(path.join(root, '.traffic-one', 'digests', 'run-0'), { recursive: true });

    process.stdout.write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => { err += String(chunk); return true; }) as typeof process.stderr.write;
    const code = main(['--run-id', 'run-2', '--status', 'blocked', '--outcome', 'review-cycle-cap'], root);
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;

    assert.equal(code, 0, 'the settlement stands, as it must');
    assert.match(out, /SUSPENDED/, 'the CLI prints the sweep advisory on stdout');
    assert.match(out, /\.one\.json/, 'naming the file only the user can repair');
    assert.equal(fs.existsSync(path.join(root, '.traffic-one', 'digests', 'run-0')), true,
      'and the suspension is real: the superseded digest dir was NOT reclaimed');
    assert.equal(err.includes('cleanup'), false,
      'nothing was refused, so the shortfall line correctly stays silent — this condition needs its own channel');
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    fs.rmSync(root, { recursive: true, force: true });
  }
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
