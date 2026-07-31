import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { stableContractJson } from '../architecture-contract';
import { isMaintenanceTerminal } from '../maintenance/terminal';
import { qaReportV2Path } from '../qa-report-v2';
import {
  activateRunV2RollbackBarrier,
  activeRunClaimScan,
  effectiveLegacyRunStatus,
  projectRunLedgerForV2Rollback,
  readRunSettlement,
  reconcileRunSettlement,
  writeRunSettlement,
  type CanonicalRunStatus,
} from '../run-settlement';
import { sha256 } from '../text';
import { DEFAULT_LIGHTHOUSE_THRESHOLDS, currentVerificationSourceHash, verificationContractPath, type VerificationContractV2 } from '../verification-contract';
import { runtime1019AcceptsTransition } from './fixtures/runtime-1.0.19-run-ledger';

function withProject(run: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-settlement-'));
  try {
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', 'R'), { recursive: true });
    run(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function writeStrictVerificationEvidence(cwd: string, runId = 'R'): VerificationContractV2 {
  const now = new Date().toISOString();
  const withoutHash = {
    schemaVersion: 2 as const,
    runId,
    architectureHash: sha256('architecture'),
    baseline: {
      kind: 'file-manifest' as const,
      identity: 'manifest:strict-settlement',
      capturedAt: now,
      filesHash: sha256('files'),
      fileCount: 0,
      files: [],
    },
    uiImpact: 'none' as const,
    uiImpactSource: 'runtime' as const,
    changedPaths: [],
    changedRoutes: [],
    scanComplete: true,
    requiredChecks: ['stack-build', 'stack-test', 'stack-lint'],
    browserRequired: false,
    nativeAdapter: null,
    requiredScreenshotWidths: [],
    tabletRisk: false,
    buildIdentityRequired: false,
    performance: {
      required: false,
      advisory: false,
      reason: 'not-required' as const,
      thresholds: { ...DEFAULT_LIGHTHOUSE_THRESHOLDS },
      advisoryTolerancePercent: 3 as const,
    },
    generatedAt: now,
  };
  const contract: VerificationContractV2 = {
    ...withoutHash,
    contractHash: sha256(stableContractJson(withoutHash)),
  };
  fs.writeFileSync(verificationContractPath(cwd, runId), JSON.stringify(contract));
  const source = currentVerificationSourceHash(cwd, contract);
  const reportPath = qaReportV2Path(cwd, runId);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    schemaVersion: 2,
    runId,
    verificationContractHash: contract.contractHash,
    generatedAt: new Date().toISOString(),
    producer: 'senior-tester',
    status: 'passed',
    sourceHash: source.hash,
    checks: contract.requiredChecks.map((id) => ({ id, status: 'passed' })),
    routes: [],
  }));
  const digests = path.join(cwd, '.traffic-one', 'digests', runId);
  fs.mkdirSync(digests, { recursive: true });
  fs.writeFileSync(path.join(digests, 'reviewer.md'), '# Reviewer\nverdict: APPROVED\n');
  fs.writeFileSync(path.join(digests, 'tester.md'), '# Tester\nverdict: TESTS_GREEN\n');
  return contract;
}

test('maintenance terminality is shared and fallback-pending is always nonterminal', () => {
  assert.equal(isMaintenanceTerminal({ overallOutcome: 'fallback-pending', fallbackAllowed: true }), false);
  assert.equal(isMaintenanceTerminal({ overallOutcome: 'success' }), true);
  assert.equal(isMaintenanceTerminal({ outcome: 'fallback-paid' }), false);
  assert.equal(isMaintenanceTerminal({ outcome: 'unknown' }), false);
});

test('verified settlement fails closed while a claim or check remains active', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'worker.json'), JSON.stringify({
      role: 'senior-frontend',
      status: 'claimed',
    }));
    const settlement = writeRunSettlement(cwd, 'R', {
      status: 'verified',
      incompleteChecks: ['qa-incomplete'],
    });
    assert.equal(settlement?.status, 'validating');
    assert.ok(settlement?.incompleteChecks.includes('active-claims'));
    assert.ok(settlement?.incompleteChecks.includes('qa-incomplete'));
    assert.ok(settlement?.incompleteChecks.includes('reviewer-approval-missing'));
    const ledger = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'active');
    assert.equal(ledger.canonicalStatus, 'validating');
    assert.equal(effectiveLegacyRunStatus(ledger), 'active');
  });
});

test('claim scan truncation is explicit and cannot hide a late active claim', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    writeStrictVerificationEvidence(cwd);
    for (let index = 0; index < 2_048; index += 1) {
      fs.writeFileSync(path.join(runDir, `${String(index).padStart(4, '0')}-done.json`), JSON.stringify({
        role: 'senior-backend',
        status: 'released',
      }));
    }
    fs.writeFileSync(path.join(runDir, 'zzzz-active.json'), JSON.stringify({
      role: 'senior-backend',
      status: 'active',
    }));

    const scan = activeRunClaimScan(cwd, 'R');
    assert.equal(scan.complete, false);
    assert.equal(scan.scanned, 2_048);
    const settlement = writeRunSettlement(cwd, 'R', { status: 'verified' });
    assert.equal(settlement?.status, 'validating');
    assert.ok(settlement?.incompleteChecks.includes('active-claim-scan-incomplete'));
    assert.ok(settlement?.incompleteChecks.includes('active-claims'));
  });
});

test('V2 rollback guard lets the current runtime continue but irreversibly fails runtime 1.0.19', () => {
  withProject((cwd) => {
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'runs', 'R', 'run.json'), JSON.stringify({
      version: 2,
      runId: 'R',
      status: 'active',
      qaContractVersion: 2,
    }));
    const settlement = writeRunSettlement(cwd, 'R', {
      status: 'active',
      incompleteChecks: ['verification-not-started'],
    });
    assert.ok(settlement);
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    const ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'failed');
    assert.equal(ledger.outcome, 'agent-failed');
    assert.equal(effectiveLegacyRunStatus(ledger, '1.0.20'), 'active');
    assert.equal(effectiveLegacyRunStatus(ledger, '1.0.19'), 'failed');
    // A legacy runtime can ignore the V2 sidecar as ordinary unknown JSON
    // without crashing, while run.json remains a fail-closed projection.
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(runDir, 'settlement-v2.json'), 'utf8')));
  });
});

test('V2 activation barrier is fail-closed before any V2-only sidecar exists', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 1,
      runId: 'R',
      status: 'active',
      kind: 'orchestration',
      createdAt: '2026-07-27T00:00:00.000Z',
    }));

    const barrier = activateRunV2RollbackBarrier(cwd, 'R');
    assert.ok(barrier);
    assert.equal(fs.existsSync(path.join(runDir, 'verification-v2.json')), false);
    assert.equal(fs.existsSync(path.join(runDir, 'settlement-v2.json')), false);

    // This is the exact state left by a crash after activation and before the
    // first V2 sidecar publication.
    const ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'failed');
    assert.equal(ledger.outcome, 'agent-failed');
    assert.equal(ledger.qaContractVersion, 2);
    assert.deepEqual(ledger.runtimeV2RollbackGuard, {
      minimumRuntimeVersion: '1.0.20',
      canonicalStatus: 'active',
    });
    assert.equal(effectiveLegacyRunStatus(ledger, '1.0.19'), 'failed');
    assert.equal(effectiveLegacyRunStatus(ledger, '1.0.20'), 'active');

    // Exercise the frozen transition semantics copied from the actual 1.0.19
    // release. Its special blocked-resume reason cannot reopen `failed`.
    fs.writeFileSync(path.join(runDir, 'verification-v2.json'), '{"schemaVersion":2}');
    fs.writeFileSync(path.join(runDir, 'settlement-v2.json'), '{"schemaVersion":2}');
    const runtime1019Ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(runtime1019AcceptsTransition({
      ...runtime1019Ledger,
      status: 'blocked',
      outcome: 'environment-blocked',
    }, {
      status: 'active',
      reason: 'user-authorized-extra-cycle',
    }), true, 'the old blocked projection was resumable in actual 1.0.19 semantics');
    assert.equal(runtime1019AcceptsTransition(runtime1019Ledger, {
      status: 'active',
      reason: 'user-authorized-extra-cycle',
    }), false);
    assert.doesNotThrow(() => runtime1019AcceptsTransition(runtime1019Ledger, {
      status: 'failed',
      outcome: 'agent-failed',
    }), '1.0.19 ignores the sibling V2 sidecars and reads only run.json');
  });
});

test('V2 activation barrier never reopens a terminal legacy run', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 1,
      runId: 'R',
      status: 'failed',
      outcome: 'agent-failed',
    }));
    assert.equal(activateRunV2RollbackBarrier(cwd, 'R'), null);
    const ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'failed');
    assert.equal(ledger.qaContractVersion, undefined);
  });
});

test('reconciliation is idempotent and never manufactures success from fallback-pending', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
      version: 1,
      role: 'quick-fix',
      outcome: 'failed',
      overallOutcome: 'fallback-pending',
      fallbackAllowed: true,
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
    }));
    const first = reconcileRunSettlement(cwd, 'R');
    const second = reconcileRunSettlement(cwd, 'R');
    assert.equal(first?.status, 'active');
    assert.equal(first?.reason, 'fallback-pending');
    assert.equal(second?.revision, first?.revision);
    assert.equal(readRunSettlement(cwd, 'R')?.fallback?.state, 'pending');
  });
});

test('a bare fallback-paid marker cannot manufacture runtime fallback completion', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    writeRunSettlement(cwd, 'R', {
      status: 'active',
      reason: 'fallback-pending',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'pending',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
      incompleteChecks: ['fallback-pending'],
    });
    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
      version: 1,
      role: 'quick-fix',
      outcome: 'fallback-paid',
      overallOutcome: 'success',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
    }));
    const missingQa = reconcileRunSettlement(cwd, 'R');
    assert.equal(missingQa?.status, 'active');
    assert.equal(missingQa?.reason, 'fallback-marker-missing');
    assert.equal(missingQa?.fallback?.state, 'pending');
    assert.deepEqual(missingQa?.incompleteChecks, ['fallback-marker-missing']);

    writeStrictVerificationEvidence(cwd);
    const reconciled = reconcileRunSettlement(cwd, 'R');
    assert.equal(reconciled?.status, 'active');
    assert.equal(reconciled?.fallback?.state, 'pending');
  });
});

test('matching fallback hashes without a fallback-paid marker stay nonterminal and reconciliation is idempotent', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    writeRunSettlement(cwd, 'R', {
      status: 'active',
      reason: 'fallback-pending',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'pending',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
      incompleteChecks: ['fallback-pending'],
    });
    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
      version: 1,
      role: 'quick-fix',
      outcome: 'success',
      overallOutcome: 'success',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
    }));
    const first = reconcileRunSettlement(cwd, 'R');
    const second = reconcileRunSettlement(cwd, 'R');
    assert.equal(first?.status, 'active');
    assert.equal(first?.reason, 'fallback-marker-missing');
    assert.equal(first?.fallback?.state, 'pending');
    assert.deepEqual(first?.incompleteChecks, ['fallback-marker-missing']);
    assert.equal(second?.revision, first?.revision);
  });
});

test('maintenance success, completed, and skipped never promote verified without strict evidence', () => {
  for (const outcome of ['success', 'completed', 'skipped']) {
    withProject((cwd) => {
      const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
      fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
        version: 1,
        role: 'quick-fix',
        outcome,
        overallOutcome: outcome,
      }));
      const missing = reconcileRunSettlement(cwd, 'R');
      assert.equal(missing?.status, 'validating', outcome);
      assert.equal(missing?.reason, 'verification-evidence-incomplete', outcome);
      writeStrictVerificationEvidence(cwd);
      assert.equal(reconcileRunSettlement(cwd, 'R')?.status, 'verified', outcome);
    });
  }
});

test('maintenance failed and blocked outcomes remain terminal without success evidence', () => {
  for (const outcome of ['failed', 'blocked']) {
    withProject((cwd) => {
      const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
      fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
        version: 1,
        role: 'quick-fix',
        outcome,
        overallOutcome: outcome,
      }));
      assert.equal(reconcileRunSettlement(cwd, 'R')?.status, outcome);
    });
  }
});

test('terminal settlements are monotonic against stale direct writes and reconciliation projections', () => {
  for (const terminal of ['verified', 'failed', 'blocked'] as const) {
    withProject((cwd) => {
      if (terminal === 'verified') writeStrictVerificationEvidence(cwd);
      const initial = writeRunSettlement(cwd, 'R', { status: terminal });
      assert.equal(initial?.status, terminal);
      assert.ok(initial);
      const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
      fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
        version: 2,
        runId: 'R',
        status: 'active',
      }));
      fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
        version: 1,
        role: 'quick-fix',
        outcome: 'failed',
        overallOutcome: 'fallback-pending',
        fallbackAllowed: true,
        workUnitContractHash: 'stale-contract',
        allowlistHash: 'stale-allowlist',
      }));

      const directReplay = writeRunSettlement(cwd, 'R', {
        status: 'active',
        reason: 'stale-projection',
        incompleteChecks: ['fallback-pending'],
      });
      const reconciled = reconcileRunSettlement(cwd, 'R');
      assert.equal(directReplay?.status, terminal);
      assert.equal(reconciled?.status, terminal);
      assert.equal(reconciled?.revision, initial?.revision);
      assert.equal(reconciled?.settlementHash, initial?.settlementHash);
    });
  }
});

test('a paid fallback with a mismatched work-unit contract hash stays nonterminal and reconciliation is idempotent', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    writeRunSettlement(cwd, 'R', {
      status: 'active',
      reason: 'fallback-pending',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'pending',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
      incompleteChecks: ['fallback-pending'],
    });
    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
      version: 1,
      role: 'quick-fix',
      outcome: 'fallback-paid',
      overallOutcome: 'success',
      workUnitContractHash: 'different-contract',
      allowlistHash: 'allowlist',
    }));
    const first = reconcileRunSettlement(cwd, 'R');
    const second = reconcileRunSettlement(cwd, 'R');
    assert.equal(first?.status, 'active');
    assert.equal(first?.reason, 'fallback-contract-mismatch');
    assert.equal(first?.fallback?.state, 'pending');
    assert.deepEqual(first?.incompleteChecks, ['fallback-hash-mismatch']);
    assert.equal(second?.revision, first?.revision);
    const attemptedBypass = writeRunSettlement(cwd, 'R', {
      status: 'verified',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'completed',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
    });
    const replayedBypass = writeRunSettlement(cwd, 'R', {
      status: 'verified',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'completed',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
    });
    assert.equal(attemptedBypass?.status, 'validating');
    assert.equal(attemptedBypass?.fallback?.state, 'pending');
    assert.ok(attemptedBypass?.incompleteChecks.includes('fallback-hash-mismatch'));
    assert.equal(replayedBypass?.revision, attemptedBypass?.revision);
  });
});

test('a paid fallback with a mismatched allowlist hash stays nonterminal and reconciliation is idempotent', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    writeRunSettlement(cwd, 'R', {
      status: 'active',
      reason: 'fallback-pending',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'pending',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
      incompleteChecks: ['fallback-pending'],
    });
    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
      version: 1,
      role: 'quick-fix',
      outcome: 'fallback-paid',
      overallOutcome: 'success',
      workUnitContractHash: 'contract',
      allowlistHash: 'different-allowlist',
    }));
    const first = reconcileRunSettlement(cwd, 'R');
    const second = reconcileRunSettlement(cwd, 'R');
    assert.equal(first?.status, 'active');
    assert.equal(first?.reason, 'fallback-contract-mismatch');
    assert.equal(first?.fallback?.state, 'pending');
    assert.deepEqual(first?.incompleteChecks, ['fallback-hash-mismatch']);
    assert.equal(second?.revision, first?.revision);
    const attemptedBypass = writeRunSettlement(cwd, 'R', {
      status: 'verified',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'completed',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
    });
    const replayedBypass = writeRunSettlement(cwd, 'R', {
      status: 'verified',
      workUnitContractHash: 'contract',
      allowlistHash: 'allowlist',
      fallback: {
        state: 'completed',
        workUnitContractHash: 'contract',
        allowlistHash: 'allowlist',
      },
    });
    assert.equal(attemptedBypass?.status, 'validating');
    assert.equal(attemptedBypass?.fallback?.state, 'pending');
    assert.ok(attemptedBypass?.incompleteChecks.includes('fallback-hash-mismatch'));
    assert.equal(replayedBypass?.revision, attemptedBypass?.revision);
  });
});

test('a terminal legacy ledger cannot bypass strict reviewer, tester, QA, and VerificationContract evidence', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 1,
      runId: 'R',
      status: 'completed',
      outcome: 'verified',
    }));
    const digests = path.join(cwd, '.traffic-one', 'digests', 'R');
    fs.mkdirSync(digests, { recursive: true });
    fs.writeFileSync(path.join(digests, 'reviewer.md'), '# Reviewer\nverdict: APPROVED\n');
    fs.writeFileSync(path.join(digests, 'tester.md'), '# Tester\nverdict: TESTS_GREEN\n');
    const missing = reconcileRunSettlement(cwd, 'R');
    assert.equal(missing?.status, 'validating');
    assert.ok(missing?.incompleteChecks.includes('verification-contract-missing-or-invalid'));
    assert.ok(missing?.incompleteChecks.includes('qa-verification-incomplete'));
    writeStrictVerificationEvidence(cwd);
    assert.equal(reconcileRunSettlement(cwd, 'R')?.status, 'verified');
  });
});

// `writeLegacyProjection` is the one writer of run.json that bypasses the
// run-ledger state machine, and reconciliation can derive a TERMINAL canonical
// status the ledger never transitioned to. Observed 12co: run.json carried a
// terminal projection while `transitionHistory` still ended at `planned ->
// active` and `statusUpdatedAt` was frozen at that moment — only `updatedAt`
// moved on, an hour later. The lifecycle record must be single-sourced.
test('a projected terminal settlement records its transition and advances statusUpdatedAt', () => {
  withProject((cwd) => {
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'R');
    const planned = '2026-07-30T00:00:00.000Z';
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 2,
      runId: 'R',
      status: 'active',
      kind: 'orchestration',
      qaContractVersion: 2,
      createdAt: planned,
      statusUpdatedAt: planned,
      transitionHistory: [{ from: 'planned', to: 'active', at: planned }],
    }));
    assert.ok(writeRunSettlement(cwd, 'R', {
      status: 'active',
      incompleteChecks: ['verification-not-started'],
    }));
    const seeded = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(seeded.statusUpdatedAt, planned, 'a non-terminal projection is not a transition');
    assert.equal((seeded.transitionHistory as unknown[]).length, 1);

    fs.writeFileSync(path.join(runDir, 'maintenance.json'), JSON.stringify({
      version: 1,
      role: 'quick-fix',
      overallOutcome: 'failed',
    }));
    const settlement = reconcileRunSettlement(cwd, 'R');
    assert.equal(settlement?.status, 'failed');

    const ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(ledger.canonicalStatus, 'failed');
    assert.equal(ledger.statusUpdatedAt, settlement!.updatedAt);
    assert.equal(ledger.finishedAt, settlement!.updatedAt);
    const history = ledger.transitionHistory as Array<Record<string, unknown>>;
    assert.equal(history.length, 2);
    assert.deepEqual(history[1], {
      from: 'active',
      to: 'failed',
      at: settlement!.updatedAt,
      outcome: 'agent-failed',
      reason: 'settlement-projection',
    });

    // Idempotent: a replayed projection of the same terminal settlement must not
    // append a second entry or re-stamp the transition timestamp.
    assert.ok(reconcileRunSettlement(cwd, 'R'));
    const replayed = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal((replayed.transitionHistory as unknown[]).length, 2);
    assert.equal(replayed.statusUpdatedAt, settlement!.updatedAt);
  });
});

// The legacy `status` and `canonicalStatus` may look different on disk — that is
// the rollback barrier, not a contradiction — but reading the projection back
// through `effectiveLegacyRunStatus` must always return the legacy equivalent of
// the canonical status a current runtime is entitled to see.
test('every legacy projection round-trips to its own canonicalStatus', () => {
  const cases: Array<[CanonicalRunStatus, string]> = [
    ['planned', 'planned'],
    ['active', 'active'],
    ['code-delivered', 'active'],
    ['validating', 'active'],
    ['verified', 'completed'],
    ['failed', 'failed'],
    ['blocked', 'blocked'],
  ];
  for (const [canonical, legacy] of cases) {
    const projected = projectRunLedgerForV2Rollback({ runId: 'R' }, canonical);
    assert.equal(projected.canonicalStatus, canonical);
    assert.equal(effectiveLegacyRunStatus(projected), legacy, canonical);
    // Runtime 1.0.19 never reads the guard: everything unfinished must look
    // irreversibly failed to it, and nothing may look completed unless it is.
    const legacyView = effectiveLegacyRunStatus(projected, '1.0.19');
    assert.equal(legacyView === 'completed', canonical === 'verified', canonical);
  }
});
