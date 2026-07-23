import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

import {
  anyRunProducedImplementerOutput,
  anyRunReachedTerminalVerdict,
  claimCursorFollowupsBatch,
  claimThreadRole,
  claimCursorSpawnObservation,
  continuationAgentId,
  consumeCursorSpawnObservation,
  cursorParentObservationSnapshot,
  cursorSpawnObservationForChild,
  cursorTranscriptCandidateTimeMs,
  ensureCurrentRunId,
  ensureRunAgentClaim,
  ensureRunLedger,
  hasActiveRunClaims,
  hasRunAgentState,
  inferRoleFromTranscript,
  listCursorSpawnObservations,
  listCursorSubagentTranscriptCandidates,
  markCursorSpawnObservationFollowupEmitted,
  markCursorSpawnObservationRetryHandled,
  markRunAgentReplaced,
  pruneExpiredPendingClaims,
  readRunAgentRegistry,
  readRunAssignments,
  readRunAssignmentsResilient,
  refreshCursorRunAgentFromTranscriptCache,
  recordCursorSpawnObservation,
  recordRunAgent,
  releaseRunClaims,
  resolveRunAgentContext,
  roleForRunSessionId,
  runHasOrchestratedArtifacts,
  runIdNow,
  runReachedTerminalVerdict,
  runSettledForRotation,
  runVerificationState,
  settleTerminalRunLedger,
  suppressCursorFollowupsBatch,
  transcriptThreadId,
  transitionRunStatus,
  tryFallbackClaim,
  updateCursorSpawnObservation,
  validateCodexLiveRunAgent,
  type CursorSpawnObservation,
} from '../run-agent';
import { resetAuthoringRootCache } from '../../authoring-root';
import { currentHostModelTarget } from '../../current-model-tiers';
import { ensureRunModelPolicy } from '../../run-model-policy';
import { stackFingerprint } from '../materialization';
import { observeCodexChildModel } from '../codex-model-observation';

function writeDigest(dir: string, runId: string, name: string, verdict: string): void {
  const d = path.join(dir, '.traffic-one', 'digests', runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), `# ${name}\nverdict: ${verdict}\n`, 'utf8');
}

function writeMaintenanceMarker(dir: string, runId: string, outcome: string): void {
  const memoryDir = ['.traffic', '-one'].join('');
  const d = path.join(dir, memoryDir, 'runs', runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'maintenance.json'), JSON.stringify({ version: 1, outcome }), 'utf8');
}

function writePassingQaReport(
  dir: string,
  runId: string,
  options: { producer?: 'senior-tester' | 'parent-browser'; generatedAt?: string } = {},
): string {
  const qaDir = path.join(dir, '.traffic-one', 'reports', 'qa', runId);
  fs.mkdirSync(qaDir, { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  fs.writeFileSync(path.join(qaDir, 'mobile.png'), png);
  fs.writeFileSync(path.join(qaDir, 'desktop.png'), png);
  const viewport = (width: 390 | 768 | 1440, screenshotPath?: string) => ({
    width,
    status: 'passed',
    consoleErrorCount: 0,
    documentOverflow: false,
    elementOverflow: false,
    primaryAction: { status: 'reachable' },
    ...(screenshotPath ? { screenshotPath } : {}),
  });
  const reportFile = path.join(qaDir, 'report.json');
  fs.writeFileSync(reportFile, JSON.stringify({
    schemaVersion: 1,
    runId,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    producer: options.producer ?? 'senior-tester',
    status: 'passed',
    routes: [{
      route: '/',
      viewports: [viewport(390, 'mobile.png'), viewport(768), viewport(1440, 'desktop.png')],
    }],
  }));
  return reportFile;
}

test('QA-evidence gate is per-run: backend-only run is terminal; frontend run still needs QA but can rotate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-perrun-'));
  try {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    // Frontend project → QA is required project-wide (the old project-level gate).
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'),
      JSON.stringify({ mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase' }));
    // BACKEND-ONLY run: green verdicts + backend.md, but NO frontend.md and NO QA artifacts.
    // Must be terminal — gating it on project-level frontend config pinned currentRunId forever.
    writeDigest(dir, 'rb', 'backend.md', 'BUILD_COMPLETE');
    writeDigest(dir, 'rb', 'reviewer.md', 'APPROVED');
    writeDigest(dir, 'rb', 'tester.md', 'TESTS_GREEN');
    assert.equal(runReachedTerminalVerdict(dir, 'rb'), true, 'backend-only run does not require QA evidence');
    // FRONTEND run (frontend.md present), green, but no QA artifacts → still NOT terminal
    // (the QA enforcement for genuine frontend runs is preserved)...
    writeDigest(dir, 'rf', 'frontend.md', 'BUILD_COMPLETE');
    writeDigest(dir, 'rf', 'reviewer.md', 'APPROVED');
    writeDigest(dir, 'rf', 'tester.md', 'TESTS_GREEN');
    assert.equal(runReachedTerminalVerdict(dir, 'rf'), false, 'frontend run still requires QA evidence');
    // ...but it is "settled enough to rotate" at a prompt boundary, so currentRunId is never
    // pinned forever (the rotation-deadlock class). An in-flight run (no green verdicts) is not.
    assert.equal(runSettledForRotation(dir, 'rf'), true, 'finished frontend run rotates even without QA');
    writeDigest(dir, 'rx', 'frontend.md', 'BUILD_COMPLETE');
    writeDigest(dir, 'rx', 'reviewer.md', 'CHANGES_REQUESTED');
    assert.equal(runSettledForRotation(dir, 'rx'), false, 'a still-verifying run does not rotate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict QA-contract frontend runs reject screenshots and Lighthouse alone, then accept the canonical passing matrix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-strict-integration-'));
  try {
    const runId = 'strict-ui';
    ensureRunLedger(dir, runId, { status: 'active' });
    writeDigest(dir, runId, 'frontend.md', 'BUILD_COMPLETE');
    writeDigest(dir, runId, 'reviewer.md', 'APPROVED');
    writeDigest(dir, runId, 'tester.md', 'TESTS_GREEN');
    const qaDir = path.join(dir, '.traffic-one', 'reports', 'qa', runId);
    fs.mkdirSync(qaDir, { recursive: true });
    fs.writeFileSync(path.join(qaDir, 'screenshot.png'), 'image');
    assert.equal(runReachedTerminalVerdict(dir, runId), false, 'screenshot-only is not strict QA');
    const lighthouseDir = path.join(dir, '.traffic-one', 'reports', 'lighthouse');
    fs.mkdirSync(lighthouseDir, { recursive: true });
    fs.writeFileSync(path.join(lighthouseDir, 'report.json'), '{}');
    assert.equal(runReachedTerminalVerdict(dir, runId), false, 'Lighthouse is performance evidence only');
    assert.equal(runSettledForRotation(dir, runId), false, 'strict runs do not rotate on textual green tokens');

    writePassingQaReport(dir, runId);
    writeDigest(dir, runId, 'tester.md', 'APPROVED');
    assert.equal(runReachedTerminalVerdict(dir, runId), false, 'contract-v1 tester must emit TESTS_GREEN');
    writeDigest(dir, runId, 'reviewer.md', 'UNKNOWN\nnot APPROVED yet');
    writeDigest(dir, runId, 'tester.md', 'TESTS_GREEN');
    assert.equal(runReachedTerminalVerdict(dir, runId), false, 'reviewer prose cannot impersonate its verdict field');
    writeDigest(dir, runId, 'reviewer.md', 'APPROVED');
    writeDigest(dir, runId, 'tester.md', 'UNKNOWN\nTESTS_GREEN would require browser evidence');
    assert.equal(runReachedTerminalVerdict(dir, runId), false, 'tester prose cannot impersonate its verdict field');
    writeDigest(dir, runId, 'tester.md', 'TESTS_GREEN');
    assert.equal(runReachedTerminalVerdict(dir, runId), true);
    assert.equal(runSettledForRotation(dir, runId), true);
    const settled = settleTerminalRunLedger(dir, runId);
    assert.equal(settled?.status, 'completed');
    assert.equal(settled?.outcome, 'verified');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resuming a legacy run advances the strict QA freshness watermark', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-resume-watermark-'));
  try {
    const runId = 'legacy-resumed-ui';
    const oldCreatedAt = new Date(Date.now() - 120_000).toISOString();
    const preResumeReportAt = new Date(Date.now() - 60_000).toISOString();
    const runDir = path.join(dir, '.traffic-one', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 1,
      runId,
      status: 'active',
      createdAt: oldCreatedAt,
      statusUpdatedAt: oldCreatedAt,
    }));
    writeDigest(dir, runId, 'frontend.md', 'BUILD_COMPLETE');
    writeDigest(dir, runId, 'reviewer.md', 'APPROVED');
    writeDigest(dir, runId, 'tester.md', 'TESTS_GREEN');
    writePassingQaReport(dir, runId, { generatedAt: preResumeReportAt });

    const resumed = transitionRunStatus(dir, runId, { status: 'active' });
    assert.equal(resumed?.qaContractVersion, 1);
    assert.equal(typeof resumed?.qaContractActivatedAt, 'string');
    assert.ok(Date.parse(resumed!.qaContractActivatedAt as string) > Date.parse(preResumeReportAt));
    assert.equal(runReachedTerminalVerdict(dir, runId), false,
      'evidence from before strict-contract activation cannot settle a resumed run');

    writePassingQaReport(dir, runId, {
      generatedAt: new Date(Date.parse(resumed!.qaContractActivatedAt as string) + 1).toISOString(),
    });
    writeDigest(dir, runId, 'tester.md', 'TESTS_GREEN');
    assert.equal(runReachedTerminalVerdict(dir, runId), true,
      'fresh evidence produced for the resumed attempt is accepted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('whole-second QA timestamps use report mtime at a millisecond activation boundary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-second-boundary-'));
  try {
    const runId = 'whole-second-boundary-ui';
    const ledger = ensureRunLedger(dir, runId, { status: 'active' });
    const activatedAtMs = Math.floor(Date.now() / 1000) * 1000 + 500;
    const runFile = path.join(dir, '.traffic-one', 'runs', runId, 'run.json');
    fs.writeFileSync(runFile, JSON.stringify({
      ...ledger,
      createdAt: new Date(activatedAtMs).toISOString(),
      qaContractActivatedAt: new Date(activatedAtMs).toISOString(),
    }));
    writeDigest(dir, runId, 'frontend.md', 'BUILD_COMPLETE');
    writeDigest(dir, runId, 'reviewer.md', 'APPROVED');
    writeDigest(dir, runId, 'tester.md', 'TESTS_GREEN');
    const frontendFile = path.join(dir, '.traffic-one', 'digests', runId, 'frontend.md');
    const testerFile = path.join(dir, '.traffic-one', 'digests', runId, 'tester.md');
    fs.utimesSync(frontendFile, new Date(activatedAtMs), new Date(activatedAtMs));

    const generatedAt = new Date(Math.floor(activatedAtMs / 1000) * 1000)
      .toISOString()
      .replace('.000Z', 'Z');
    const reportFile = writePassingQaReport(dir, runId, { generatedAt });
    fs.utimesSync(reportFile, new Date(activatedAtMs - 1), new Date(activatedAtMs - 1));
    fs.utimesSync(testerFile, new Date(activatedAtMs + 20), new Date(activatedAtMs + 20));
    assert.equal(runReachedTerminalVerdict(dir, runId), false,
      'a whole-second value does not bypass freshness when the report file predates activation');

    fs.utimesSync(reportFile, new Date(activatedAtMs + 10), new Date(activatedAtMs + 10));
    assert.equal(runReachedTerminalVerdict(dir, runId), true,
      'the canonical file mtime proves same-second evidence was written after activation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a parent-browser replacement needs a later tester digest re-attestation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-parent-reattest-'));
  try {
    const runId = 'parent-browser-ui';
    const ledger = ensureRunLedger(dir, runId, { status: 'active' });
    assert.equal(typeof ledger?.qaContractActivatedAt, 'string');
    writeDigest(dir, runId, 'frontend.md', 'BUILD_COMPLETE');
    writeDigest(dir, runId, 'reviewer.md', 'APPROVED');
    writeDigest(dir, runId, 'tester.md', 'TESTS_GREEN');

    const activatedAtMs = Date.parse(ledger!.qaContractActivatedAt as string);
    const reportGeneratedAtMs = activatedAtMs + 10;
    const reportMtimeMs = activatedAtMs + 20;
    const reportFile = writePassingQaReport(dir, runId, {
      producer: 'parent-browser',
      generatedAt: new Date(reportGeneratedAtMs).toISOString(),
    });
    fs.utimesSync(reportFile, new Date(reportMtimeMs), new Date(reportMtimeMs));
    const testerFile = path.join(dir, '.traffic-one', 'digests', runId, 'tester.md');
    fs.utimesSync(testerFile, new Date(activatedAtMs + 15), new Date(activatedAtMs + 15));

    assert.equal(runReachedTerminalVerdict(dir, runId), false,
      'a green digest written before the parent report does not attest that report');

    writeDigest(dir, runId, 'tester.md', 'TESTS_GREEN');
    fs.utimesSync(testerFile, new Date(reportMtimeMs + 10), new Date(reportMtimeMs + 10));
    assert.equal(runReachedTerminalVerdict(dir, runId), true,
      'the continued tester can re-emit its green digest after validating the replacement');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict QA and tester attestation must be newer than the latest frontend digest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-fix-cycle-freshness-'));
  try {
    const runId = 'same-run-fix';
    const ledger = ensureRunLedger(dir, runId, { status: 'active' });
    const activatedAtMs = Date.parse(ledger!.qaContractActivatedAt as string);
    writeDigest(dir, runId, 'frontend.md', 'BUILD_COMPLETE');
    writeDigest(dir, runId, 'reviewer.md', 'APPROVED');
    const frontendFile = path.join(dir, '.traffic-one', 'digests', runId, 'frontend.md');
    const testerFile = path.join(dir, '.traffic-one', 'digests', runId, 'tester.md');
    fs.utimesSync(frontendFile, new Date(activatedAtMs + 5), new Date(activatedAtMs + 5));

    let reportFile = writePassingQaReport(dir, runId, {
      generatedAt: new Date(activatedAtMs + 20).toISOString(),
    });
    fs.utimesSync(reportFile, new Date(activatedAtMs + 20), new Date(activatedAtMs + 20));
    writeDigest(dir, runId, 'tester.md', 'TESTS_GREEN');
    fs.utimesSync(testerFile, new Date(activatedAtMs + 30), new Date(activatedAtMs + 30));
    assert.equal(runReachedTerminalVerdict(dir, runId), true);

    writeDigest(dir, runId, 'frontend.md', 'BUILD_COMPLETE\nfix cycle 2');
    fs.utimesSync(frontendFile, new Date(activatedAtMs + 40), new Date(activatedAtMs + 40));
    writeDigest(dir, runId, 'tester.md', 'TESTS_GREEN');
    fs.utimesSync(testerFile, new Date(activatedAtMs + 50), new Date(activatedAtMs + 50));
    assert.equal(runReachedTerminalVerdict(dir, runId), false,
      'a re-attested old matrix cannot verify implementation changed after QA');

    reportFile = writePassingQaReport(dir, runId, {
      generatedAt: new Date(activatedAtMs + 60).toISOString(),
    });
    fs.utimesSync(reportFile, new Date(activatedAtMs + 60), new Date(activatedAtMs + 60));
    writeDigest(dir, runId, 'tester.md', 'TESTS_GREEN');
    fs.utimesSync(testerFile, new Date(activatedAtMs + 70), new Date(activatedAtMs + 70));
    assert.equal(runReachedTerminalVerdict(dir, runId), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backend-only strict runs need no QA report; frontend prose N/A never bypasses evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-backend-only-'));
  try {
    ensureRunLedger(dir, 'backend-only', { status: 'active' });
    writeDigest(dir, 'backend-only', 'backend.md', 'BUILD_COMPLETE');
    writeDigest(dir, 'backend-only', 'reviewer.md', 'APPROVED');
    writeDigest(dir, 'backend-only', 'tester.md', 'TESTS_GREEN\nnotes: backend-only, no frontend digest');
    assert.equal(runReachedTerminalVerdict(dir, 'backend-only'), true);

    const blockedDir = path.join(dir, '.traffic-one', 'reports', 'qa', 'backend-only');
    fs.mkdirSync(blockedDir, { recursive: true });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(path.join(blockedDir, 'mobile.png'), png);
    fs.writeFileSync(path.join(blockedDir, 'desktop.png'), png);
    const blockedViewport = (width: 390 | 768 | 1440, screenshotPath?: string) => ({
      width,
      status: 'blocked:sandbox',
      consoleErrorCount: 0,
      documentOverflow: false,
      elementOverflow: false,
      primaryAction: { status: 'not-applicable', reason: 'Browser unavailable.' },
      ...(screenshotPath ? { screenshotPath } : {}),
    });
    fs.writeFileSync(path.join(blockedDir, 'report.json'), JSON.stringify({
      schemaVersion: 1,
      runId: 'backend-only',
      generatedAt: new Date().toISOString(),
      producer: 'senior-tester',
      status: 'blocked:sandbox',
      blocker: { code: 'sandbox', summary: 'Browser process denied.' },
      routes: [{
        route: '/',
        viewports: [
          blockedViewport(390, 'mobile.png'),
          blockedViewport(768),
          blockedViewport(1440, 'desktop.png'),
        ],
      }],
    }));
    assert.equal(runReachedTerminalVerdict(dir, 'backend-only'), false,
      'an explicit blocker overrides the backend-only exemption');

    writeDigest(dir, 'legacy-ui', 'frontend.md', 'BUILD_COMPLETE');
    writeDigest(dir, 'legacy-ui', 'reviewer.md', 'APPROVED');
    writeDigest(dir, 'legacy-ui', 'tester.md', 'TESTS_GREEN — visual QA not applicable because no browser surface');
    assert.equal(runReachedTerminalVerdict(dir, 'legacy-ui'), false, 'frontend digest removes the prose N/A escape');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy QA artifacts remain compatible unless the tester or report explicitly records a blocker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-legacy-'));
  try {
    const runId = 'legacy-artifacts';
    writeDigest(dir, runId, 'frontend.md', 'BUILD_COMPLETE');
    writeDigest(dir, runId, 'reviewer.md', 'APPROVED');
    writeDigest(dir, runId, 'tester.md', 'TESTS_GREEN');
    const qaDir = path.join(dir, '.traffic-one', 'reports', 'qa', runId);
    fs.mkdirSync(qaDir, { recursive: true });
    fs.writeFileSync(path.join(qaDir, 'legacy.png'), 'legacy');
    assert.equal(runReachedTerminalVerdict(dir, runId), true);

    fs.writeFileSync(path.join(qaDir, 'report.json'), JSON.stringify({
      status: 'blocked:sandbox',
      blocker: { code: 'sandbox', summary: 'Browser process denied.' },
    }));
    assert.equal(runReachedTerminalVerdict(dir, runId), false, 'explicit blockers override legacy artifact presence');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runVerificationState distinguishes interrupted implementation from every partial verifier outcome', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-verification-state-'));
  try {
    assert.equal(runVerificationState(dir, 'empty'), 'empty');
    writeDigest(dir, 'implementation', 'backend.md', 'BUILD_COMPLETE');
    assert.equal(runVerificationState(dir, 'implementation'), 'not-started');
    writeDigest(dir, 'partial', 'frontend.md', 'BUILD_COMPLETE');
    writeDigest(dir, 'partial', 'reviewer.md', 'APPROVED');
    assert.equal(runVerificationState(dir, 'partial'), 'nonterminal');
    writeDigest(dir, 'failing', 'backend.md', 'BUILD_COMPLETE');
    writeDigest(dir, 'failing', 'reviewer.md', 'APPROVED');
    writeDigest(dir, 'failing', 'tester.md', 'TESTS_FAILING');
    assert.equal(runVerificationState(dir, 'failing'), 'nonterminal');
    writeDigest(dir, 'verified', 'backend.md', 'BUILD_COMPLETE');
    writeDigest(dir, 'verified', 'reviewer.md', 'APPROVED');
    writeDigest(dir, 'verified', 'tester.md', 'TESTS_GREEN');
    assert.equal(runVerificationState(dir, 'verified'), 'terminal');

    assert.ok(transitionRunStatus(dir, 'blocked-ledger', { status: 'active' }));
    writeDigest(dir, 'blocked-ledger', 'backend.md', 'BUILD_COMPLETE');
    assert.ok(transitionRunStatus(dir, 'blocked-ledger', {
      status: 'blocked',
      outcome: 'review-cycle-cap',
    }));
    assert.equal(runVerificationState(dir, 'blocked-ledger'), 'nonterminal',
      'blocked ledger overrides implementer-only fallback');

    assert.ok(transitionRunStatus(dir, 'failed-ledger', { status: 'active' }));
    assert.ok(transitionRunStatus(dir, 'failed-ledger', { status: 'failed', outcome: 'agent-failed' }));
    assert.equal(runVerificationState(dir, 'failed-ledger'), 'nonterminal',
      'agent failure remains unresolved even without verifier digests');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runReachedTerminalVerdict requires terminal verdict tokens, not mere digest existence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-verdict-'));
  try {
    // No digests at all → not terminal.
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), false);
    // Reviewer mid-fix-cycle (CHANGES_REQUESTED), no tester → not terminal.
    writeDigest(dir, 'r1', 'reviewer.md', 'CHANGES_REQUESTED');
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), false);
    // Reviewer APPROVED but no tester digest → still not terminal (needs both).
    writeDigest(dir, 'r1', 'reviewer.md', 'APPROVED');
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), false);
    // Tester delegated-but-unverified token is non-terminal by design.
    writeDigest(dir, 'r1', 'tester.md', 'DELEGATED_OK');
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), false);
    // Tester TESTS_FAILING → not terminal.
    writeDigest(dir, 'r1', 'tester.md', 'TESTS_FAILING');
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), false);
    // Reviewer APPROVED + tester TESTS_GREEN → terminal.
    writeDigest(dir, 'r1', 'tester.md', 'TESTS_GREEN');
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), true);
    // Orchestrators deviate: a tester digest with `verdict: APPROVED` (observed: gpt-5.5)
    // is also a PASSING tester → terminal (was a false-negative before the broadening).
    writeDigest(dir, 'r1', 'tester.md', 'APPROVED');
    assert.equal(runReachedTerminalVerdict(dir, 'r1'), true);
    // A shipper digest (written only post-deploy) is terminal on its own.
    writeDigest(dir, 'r2', 'shipper.md', 'SHIPPED');
    assert.equal(runReachedTerminalVerdict(dir, 'r2'), true);
    writeDigest(dir, 'r3', 'shipper.md', 'FAILED');
    assert.equal(runReachedTerminalVerdict(dir, 'r3'), false, 'a failed shipper digest is not terminal success');
    // anyRunReachedTerminalVerdict scans every run dir.
    assert.equal(anyRunReachedTerminalVerdict(dir), true);
    assert.equal(anyRunReachedTerminalVerdict(path.join(dir, 'nope')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runReachedTerminalVerdict treats terminal maintenance markers as settled runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-maint-verdict-'));
  try {
    assert.equal(runReachedTerminalVerdict(dir, 'quick-1'), false);
    writeMaintenanceMarker(dir, 'quick-1', 'failed');
    assert.equal(runReachedTerminalVerdict(dir, 'quick-1'), true);
    writeMaintenanceMarker(dir, 'quick-2', 'running');
    assert.equal(runReachedTerminalVerdict(dir, 'quick-2'), false);
    ensureRunLedger(dir, 'strict-maintenance', { status: 'active' });
    writeMaintenanceMarker(dir, 'strict-maintenance', 'blocked');
    assert.equal(runReachedTerminalVerdict(dir, 'strict-maintenance'), true,
      'generic maintenance compatibility still reads the marker');
    assert.equal(runSettledForRotation(dir, 'strict-maintenance'), false,
      'v1 rotation cannot use a blocked maintenance marker as strict build verification');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('anyRunProducedImplementerOutput detects senior-* implementer digests (Cursor double-emit)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-impl-senior-'));
  try {
    assert.equal(anyRunProducedImplementerOutput(dir), false);
    // Cursor's write path can emit only the senior-prefixed digest. It must still count as
    // implementer output, or a finished build wedges in 'building' at the prompt boundary.
    writeDigest(dir, 'r1', 'senior-frontend.md', 'BUILD_COMPLETE');
    assert.equal(anyRunProducedImplementerOutput(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('anyRunProducedImplementerOutput sees frontend/backend digests, not architect-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-impl-'));
  try {
    // No digests dir at all → no implementer output.
    assert.equal(anyRunProducedImplementerOutput(dir), false);
    // Only an architect digest (the build merely planned) → not implementer output.
    writeDigest(dir, 'r1', 'architect.md', 'PLAN_READY');
    assert.equal(anyRunProducedImplementerOutput(dir), false);
    // A frontend digest (code was written) → implementer output, even with no verdict.
    writeDigest(dir, 'r1', 'frontend.md', 'done');
    assert.equal(anyRunProducedImplementerOutput(dir), true);
    // Scans every run dir; a backend-only digest in another run also counts.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 't1-impl2-'));
    try {
      writeDigest(dir2, 'r9', 'backend.md', 'done');
      assert.equal(anyRunProducedImplementerOutput(dir2), true);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readRunAssignments tolerates the `roles`-object schema (ownedPaths/readOnlyPaths)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-roles-'));
  try {
    const d = path.join(dir, '.traffic-one', 'runs', 'R');
    fs.mkdirSync(d, { recursive: true });
    // The exact deviation observed live (gpt-5.5 architect): a `roles` object, no `assignments` array.
    fs.writeFileSync(path.join(d, 'assignments.json'), JSON.stringify({
      runId: 'R', installOwner: 'senior-backend',
      roles: {
        'senior-frontend': { ownedPaths: ['apps/web/**', 'packages/ui/**'], readOnlyPaths: ['supabase/**'] },
        'senior-backend': { ownedPaths: ['supabase/**', 'packages/api-client/**'] },
      },
      nonOverlapAssertion: 'no overlap',
    }), 'utf8');
    const m = readRunAssignments(dir, 'R');
    assert.ok(m, 'roles schema must parse');
    assert.equal(m?.assignments.length, 2);
    const fe = m?.assignments.find((a) => a.role === 'senior-frontend');
    assert.deepEqual(fe?.scope.include, ['apps/web/**', 'packages/ui/**']);
    assert.deepEqual(fe?.scope.exclude, ['supabase/**']); // readOnlyPaths → exclude
    const be = m?.assignments.find((a) => a.role === 'senior-backend');
    assert.deepEqual(be?.scope.include, ['supabase/**', 'packages/api-client/**']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runHasOrchestratedArtifacts: schema-agnostic raw-existence of assignments OR a digest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-artifacts-'));
  try {
    assert.equal(runHasOrchestratedArtifacts(dir, 'R'), false); // nothing yet
    ensureRunLedger(dir, 'R', { status: 'planned', kind: 'maintenance-triage' });
    assert.equal(runHasOrchestratedArtifacts(dir, 'R'), false, 'run.json alone is not an orchestrated run');
    // A non-conforming assignments.json (would NOT parse) still counts — raw existence.
    const rd = path.join(dir, '.traffic-one', 'runs', 'R');
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'assignments.json'), '{"totally":"unparseable-for-scope"}', 'utf8');
    assert.equal(runHasOrchestratedArtifacts(dir, 'R'), true);
    // A digest alone also counts (no assignments file).
    writeDigest(dir, 'R2', 'architect.md', 'PLAN_READY');
    assert.equal(runHasOrchestratedArtifacts(dir, 'R2'), true);
    assert.equal(runHasOrchestratedArtifacts(dir, ''), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function withPrefs<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-runagent-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('runIdNow returns a unix epoch millisecond string', () => {
  assert.match(runIdNow(), /^\d{13}$/);
});

test('ensureCurrentRunId writes a minimal planned run ledger', () => {
  withPrefs((dir) => {
    const state = { mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' } };
    const runId = ensureCurrentRunId(dir, state);
    assert.match(runId, /^\d{13}$/);
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', runId, 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'planned');
    assert.equal(ledger.kind, 'spawn-gate');
    assert.equal(ledger.runId, runId);
    assert.equal(ledger.qaContractVersion, 1);
    assert.equal(ledger.statusUpdatedAt, ledger.createdAt);
    assert.deepEqual(ledger.transitionHistory.map((entry: Record<string, unknown>) => [entry.from, entry.to]), [[null, 'planned']]);
    assert.equal(runHasOrchestratedArtifacts(dir, runId), false);
  });
});

test('ensureCurrentRunId is read-only for existing legacy and blocked runs', () => {
  withPrefs((dir) => {
    const legacyState = { ...materializedState(), currentRunId: 'legacy-current' };
    assert.equal(ensureCurrentRunId(dir, legacyState), 'legacy-current');
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', 'legacy-current', 'run.json')), false);

    assert.ok(transitionRunStatus(dir, 'blocked-current', { status: 'active' }));
    assert.ok(transitionRunStatus(dir, 'blocked-current', {
      status: 'blocked',
      outcome: 'environment-blocked',
    }));
    assert.equal(ensureCurrentRunId(dir, { ...materializedState(), currentRunId: 'blocked-current' }), 'blocked-current');
    const blockedLedger = JSON.parse(fs.readFileSync(
      path.join(dir, '.traffic-one', 'runs', 'blocked-current', 'run.json'),
      'utf8',
    ));
    assert.equal(blockedLedger.status, 'blocked');
    assert.equal(blockedLedger.outcome, 'environment-blocked');
  });
});

test('run ledger transitions are validated, terminal writes are idempotent, and blocked resumes require authorization', () => {
  withPrefs((dir) => {
    const runId = 'run-transitions';
    assert.ok(transitionRunStatus(dir, runId, { status: 'active', kind: 'orchestration' }));
    assert.ok(transitionRunStatus(dir, runId, { status: 'blocked', outcome: 'test-cycle-cap' }));
    assert.equal(transitionRunStatus(dir, runId, { status: 'blocked', outcome: 'environment-blocked' }), null,
      'a terminal blocker outcome cannot be rewritten');
    assert.equal(transitionRunStatus(dir, runId, { status: 'active' }), null, 'blocked runs cannot silently resume');
    assert.ok(transitionRunStatus(dir, runId, {
      status: 'active',
      reason: 'user-authorized-extra-cycle',
    }));
    assert.equal(transitionRunStatus(dir, runId, { status: 'completed', outcome: 'verified' }), null,
      'the central transition helper cannot forge verified completion without evidence');
    writeDigest(dir, runId, 'backend.md', 'BUILD_COMPLETE');
    writeDigest(dir, runId, 'reviewer.md', 'APPROVED');
    writeDigest(dir, runId, 'tester.md', 'TESTS_GREEN');
    const completed = transitionRunStatus(dir, runId, { status: 'completed', outcome: 'verified' });
    assert.ok(completed);
    const replay = transitionRunStatus(dir, runId, { status: 'completed', outcome: 'verified' });
    assert.ok(replay);
    assert.equal(replay!.finishedAt, completed!.finishedAt);
    assert.equal((replay!.transitionHistory as unknown[]).length, (completed!.transitionHistory as unknown[]).length);
    assert.equal(transitionRunStatus(dir, runId, { status: 'completed', outcome: 'shipped' }), null,
      'the central transition helper cannot forge shipped completion without a positive shipper verdict');
    writeDigest(dir, runId, 'shipper.md', 'SHIPPED');
    const shipped = transitionRunStatus(dir, runId, { status: 'completed', outcome: 'shipped' });
    assert.ok(shipped, 'verified may advance to shipped without reopening the run');
    assert.equal(shipped!.finishedAt, completed!.finishedAt);
    assert.equal(transitionRunStatus(dir, runId, { status: 'completed', outcome: 'verified' }), null,
      'shipped cannot be downgraded to verified');
    assert.equal(transitionRunStatus(dir, runId, { status: 'failed', outcome: 'agent-failed' }), null,
      'completed is terminal');
    assert.deepEqual(
      (shipped!.transitionHistory as Array<Record<string, unknown>>).map((entry) => entry.to),
      ['active', 'blocked', 'active', 'completed', 'completed'],
    );
  });
});

test('resuming a legacy ledger upgrades it to the strict QA contract and preserves blocked history', () => {
  withPrefs((dir) => {
    const runId = 'legacy-resume';
    const runDir = path.join(dir, '.traffic-one', 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 1,
      runId,
      status: 'blocked',
      outcome: 'review-cycle-cap',
      createdAt: '2026-01-01T00:00:00.000Z',
      statusUpdatedAt: '2026-01-01T01:00:00.000Z',
      transitionHistory: [{ from: 'active', to: 'blocked', at: '2026-01-01T01:00:00.000Z' }],
    }));

    const resumed = transitionRunStatus(dir, runId, {
      status: 'active',
      reason: 'user-authorized-extra-cycle',
    });
    assert.ok(resumed);
    assert.equal(resumed!.qaContractVersion, 1);
    assert.equal(resumed!.finishedAt, undefined);
    assert.equal(resumed!.outcome, undefined);
    assert.deepEqual(
      (resumed!.transitionHistory as Array<Record<string, unknown>>).map((entry) => entry.to),
      ['blocked', 'active'],
    );
  });
});

test('run ledger transition history is capped without dropping the latest blocked resume pair', () => {
  withPrefs((dir) => {
    const runId = 'bounded-history';
    assert.ok(transitionRunStatus(dir, runId, { status: 'active' }));
    for (let index = 0; index < 20; index += 1) {
      assert.ok(transitionRunStatus(dir, runId, { status: 'blocked', outcome: 'test-cycle-cap' }));
      assert.ok(transitionRunStatus(dir, runId, {
        status: 'active',
        reason: 'user-authorized-extra-cycle',
      }));
    }
    const ledger = JSON.parse(fs.readFileSync(
      path.join(dir, '.traffic-one', 'runs', runId, 'run.json'),
      'utf8',
    )) as Record<string, unknown>;
    const history = ledger.transitionHistory as Array<Record<string, unknown>>;
    assert.equal(history.length, 32);
    assert.deepEqual(history.slice(-2).map((entry) => entry.to), ['blocked', 'active']);
    assert.equal(history.at(-1)?.reason, 'user-authorized-extra-cycle');
  });
});

test('hasActiveRunClaims ignores run.json planned ledgers without agent claims', () => {
  withPrefs((dir) => {
    const state = materializedState();
    const runId = ensureCurrentRunId(dir, state);
    assert.equal(hasActiveRunClaims(dir, state), false);
    assert.equal(hasRunAgentState(dir, state), false);
    assert.ok(fs.existsSync(path.join(dir, '.traffic-one', 'runs', runId, 'run.json')));
  });
});

test('hasRunAgentState counts real run-agent artifacts, not planned ledger directories', () => {
  withPrefs((dir) => {
    const state = materializedState();
    const runId = ensureCurrentRunId(dir, state);
    assert.equal(hasRunAgentState(dir, state), false);
    writeAssignments(dir, runId, 'senior-frontend');
    assert.equal(hasRunAgentState(dir, state), true);
  });
});

function writeAssignments(dir: string, runId: string, role: string): void {
  const d = path.join(dir, '.traffic-one', 'runs', runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'assignments.json'), JSON.stringify({
    version: 1, runId, assignments: [{ role, scope: { include: ['apps/web/**'] } }],
  }), 'utf8');
}

test('readRunAssignmentsResilient recovers from a run-id split (assignments under a stray id)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-runassign-'));
  try {
    // Architect wrote assignments under a stray ISO id; the gate's currentRunId differs.
    writeAssignments(dir, '2026-06-17T10-30-00Z', 'senior-frontend');
    const m = readRunAssignmentsResilient(dir, '1781692097241');
    assert.ok(m && m.assignments[0]?.role === 'senior-frontend', 'found assignments despite the split');
    // Nothing anywhere → null.
    assert.equal(readRunAssignmentsResilient(path.join(dir, 'nope'), '1781692097241'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readRunAssignmentsResilient prefers the exact runId over the fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-runassign2-'));
  try {
    writeAssignments(dir, '1781692097241', 'senior-backend');     // matches currentRunId
    writeAssignments(dir, '2026-06-17T10-30-00Z', 'senior-frontend'); // stray (newer name, but exact wins)
    const m = readRunAssignmentsResilient(dir, '1781692097241');
    assert.ok(m && m.assignments[0]?.role === 'senior-backend', 'exact runId match preferred');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readRunAssignments tolerates scope.include and object-shaped writeScope assignments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-assign-shapes-'));
  try {
    const d1 = path.join(dir, '.traffic-one', 'runs', 'roles-scope');
    fs.mkdirSync(d1, { recursive: true });
    fs.writeFileSync(path.join(d1, 'assignments.json'), JSON.stringify({
      roles: {
        'senior-frontend': { scope: { include: ['apps/web/**'], exclude: ['services/**'] } },
      },
    }), 'utf8');
    assert.deepEqual(readRunAssignments(dir, 'roles-scope')?.assignments[0]?.scope, {
      include: ['apps/web/**'],
      exclude: ['services/**'],
    });

    const d2 = path.join(dir, '.traffic-one', 'runs', 'object-shape');
    fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(path.join(d2, 'assignments.json'), JSON.stringify({
      assignments: {
        'senior-backend': { description: 'API', writeScope: ['services/api/**'] },
      },
    }), 'utf8');
    const m = readRunAssignments(dir, 'object-shape');
    assert.equal(m?.assignments[0]?.role, 'senior-backend');
    assert.equal(m?.assignments[0]?.summary, 'API');
    assert.deepEqual(m?.assignments[0]?.scope.include, ['services/api/**']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureRunAgentClaim writes a pending claim and stamps run state', () => {
  withPrefs((dir) => {
    const claim = ensureRunAgentClaim(dir, { stack: 'default' }, 'senior-frontend', {}, { toolName: 'Task' });
    assert.ok(claim);
    assert.equal(claim!.role, 'senior-frontend');
    assert.equal(claim!.status, 'pending');
    assert.equal(claim!.spawnIndex, 1);

    const runId = claim!.runId as string;
    const pending = path.join(dir, '.traffic-one', 'runs', runId, 'pending');
    assert.equal(fs.existsSync(pending), true);
    assert.equal(fs.readdirSync(pending).filter((f) => f.endsWith('.json')).length, 1);
    const ledger = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', runId, 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'active');
    assert.equal(ledger.kind, 'agent-claim');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(onDisk.currentRunId, runId);
    assert.deepEqual(onDisk.spawnIndex, { 'senior-frontend': 1 });
  });
});

test('ensureRunAgentClaim rejects unknown roles', () => {
  withPrefs((dir) => {
    assert.equal(ensureRunAgentClaim(dir, {}, 'bogus-role', {}, {}), null);
  });
});

test('blocked runs cannot create worker claims until the user-authorized resume transition', () => {
  withPrefs((dir) => {
    const runId = 'blocked-claim';
    const state = { ...materializedState(), currentRunId: runId };
    assert.ok(transitionRunStatus(dir, runId, { status: 'active' }));
    assert.ok(transitionRunStatus(dir, runId, { status: 'blocked', outcome: 'test-cycle-cap' }));
    assert.equal(ensureRunAgentClaim(dir, state, 'senior-tester', {}, { toolName: 'Task' }), null);
    const pending = path.join(dir, '.traffic-one', 'runs', runId, 'pending');
    assert.equal(fs.existsSync(pending), false);

    assert.ok(transitionRunStatus(dir, runId, {
      status: 'active',
      reason: 'user-authorized-extra-cycle',
    }));
    assert.ok(ensureRunAgentClaim(dir, state, 'senior-tester', {}, { toolName: 'Task' }));
    assert.equal(fs.readdirSync(pending).filter((name) => name.endsWith('.json')).length, 1);
  });
});

test('native Devin foreground child resolves the sole anonymous pending role', () => {
  withPrefs((dir) => {
    const state = materializedState();
    const claim = ensureRunAgentClaim(dir, state, 'senior-architect', {}, { toolName: 'run_subagent', agentType: 'subagent_general' });
    assert.ok(claim);
    const current = { ...state, currentRunId: claim!.runId };
    const raw = { hook_event_name: 'PreToolUse', tool_name: 'write', tool_input: { file_path: path.join(dir, 'package.json') } };
    assert.equal(resolveRunAgentContext(dir, current, raw, { claimPending: true }), null);
    const resolved = resolveRunAgentContext(dir, current, raw, { claimPending: true, allowSoleAnonymousPending: true });
    assert.equal(resolved?.role, 'senior-architect');
    assert.equal(resolved?.source, 'sole-foreground-pending');
  });
});

test('releaseRunClaims releases claimed files, deletes pending, and hasActiveRunClaims ignores released claims', () => {
  withPrefs((dir) => {
    const runId = 'run-release';
    const runDirPath = path.join(dir, '.traffic-one', 'runs', runId);
    fs.mkdirSync(path.join(runDirPath, 'pending'), { recursive: true });
    fs.writeFileSync(path.join(runDirPath, 'abc123.json'), JSON.stringify({
      version: 1, runId, claimId: 'senior-frontend-1-x', role: 'senior-frontend',
      status: 'claimed', createdAt: new Date().toISOString(), sessionId: 'abc123',
    }), 'utf8');
    fs.writeFileSync(path.join(runDirPath, 'pending', 'p1.json'), JSON.stringify({
      version: 1, runId, claimId: 'senior-backend-1-y', role: 'senior-backend',
      status: 'pending', createdAt: new Date().toISOString(),
    }), 'utf8');
    // Role-bearing sidecar without a claimId (maintenance.json shape) must stay untouched.
    fs.writeFileSync(path.join(runDirPath, 'maintenance.json'), JSON.stringify({
      version: 1, kind: 'opencode-delegation', role: 'senior-tester', outcome: 'failed',
    }), 'utf8');

    const state = { ...materializedState(), currentRunId: runId };
    assert.equal(hasActiveRunClaims(dir, state), true);
    assert.equal(releaseRunClaims(dir, runId, 'test-sweep'), 2);
    assert.equal(hasActiveRunClaims(dir, state), false);
    assert.equal(releaseRunClaims(dir, runId, 'again'), 0, 'idempotent on released claims');

    const claimed = JSON.parse(fs.readFileSync(path.join(runDirPath, 'abc123.json'), 'utf8'));
    assert.equal(claimed.status, 'released');
    assert.equal(claimed.releasedReason, 'test-sweep');
    assert.ok(claimed.releasedAt);
    assert.equal(fs.existsSync(path.join(runDirPath, 'pending', 'p1.json')), false);
    const sidecar = JSON.parse(fs.readFileSync(path.join(runDirPath, 'maintenance.json'), 'utf8'));
    assert.equal(sidecar.status, undefined, 'sidecar files are not mutated');

    // Released claims still count toward spawn indexing — indexes are never reused.
    const next = ensureRunAgentClaim(dir, state, 'senior-frontend', {}, { toolName: 'Task' });
    assert.ok(next);
    assert.equal(next!.spawnIndex, 2);
  });
});

test('releaseRunClaims deletes per-file fallback claims (8c: architect locks lingered post-settlement)', () => {
  withPrefs((dir) => {
    const runId = 'run-fallback-sweep';
    const ctx = fallbackTestContext(runId, 'senior-architect', 'arch-sess-0001');
    assert.equal(tryFallbackClaim(dir, ctx, 'package.json').blocked, false);
    assert.equal(tryFallbackClaim(dir, ctx, 'turbo.json').blocked, false);
    const claimsDir = path.join(dir, '.traffic-one', 'runs', runId, 'claims');
    assert.equal(fs.readdirSync(claimsDir).filter((n) => n.endsWith('.json')).length, 2);

    assert.equal(releaseRunClaims(dir, runId, 'settled'), 2);
    const left = fs.existsSync(claimsDir)
      ? fs.readdirSync(claimsDir).filter((n) => n.endsWith('.json')).length
      : 0;
    assert.equal(left, 0, 'fallback claim files are deleted by the terminal sweep');
    assert.equal(releaseRunClaims(dir, runId, 'again'), 0, 'idempotent once swept');
  });
});

test('roleForRunSessionId resolves the writer role from the run registry, then claims', () => {
  withPrefs((dir) => {
    const runId = 'run-role-resolve';
    recordRunAgent(dir, runId, 'senior-frontend', {
      agentId: 'fe-agent-uuid-1',
      resumeId: 'fe-agent-uuid-1',
      parentSessionId: 'parent-1',
    });
    assert.equal(roleForRunSessionId(dir, runId, 'fe-agent-uuid-1'), 'senior-frontend');
    // unknown session (the parent orchestrator) resolves to null
    assert.equal(roleForRunSessionId(dir, runId, 'parent-1'), null);
    assert.equal(roleForRunSessionId(dir, runId, null), null);

    // claims fallback: a bound agent claim resolves even without a registry row
    fs.writeFileSync(path.join(dir, '.traffic-one', 'runs', runId, 'be-sess-77.json'), JSON.stringify({
      version: 1, runId, claimId: 'senior-backend-1-z', role: 'senior-backend',
      status: 'claimed', createdAt: new Date().toISOString(), sessionId: 'be-sess-77',
    }), 'utf8');
    assert.equal(roleForRunSessionId(dir, runId, 'be-sess-77'), 'senior-backend');
  });
});

test('pruneExpiredPendingClaims removes stale pending claims and keeps fresh ones', () => {
  withPrefs((dir) => {
    const runId = 'run-prune';
    const pending = path.join(dir, '.traffic-one', 'runs', runId, 'pending');
    fs.mkdirSync(pending, { recursive: true });
    fs.writeFileSync(path.join(pending, 'old.json'), JSON.stringify({
      version: 1,
      runId,
      claimId: 'old',
      role: 'senior-backend',
      status: 'pending',
      createdAt: '1970-01-01T00:00:00Z',
    }), 'utf8');
    fs.writeFileSync(path.join(pending, 'fresh.json'), JSON.stringify({
      version: 1,
      runId,
      claimId: 'fresh',
      role: 'senior-frontend',
      status: 'pending',
      createdAt: new Date().toISOString(),
    }), 'utf8');
    assert.equal(pruneExpiredPendingClaims(dir, runId), 1);
    const remaining = fs.readdirSync(pending).filter((name) => name.endsWith('.json'));
    assert.equal(remaining.length, 1);
    assert.ok(!remaining.includes('old.json'));
  });
});

// A materialized state whose fingerprint matches materializedStack, so claims pass
// claimAllowsState (the run-context guard).
function materializedState(): Record<string, unknown> {
  const base = { mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' } };
  return { ...base, materializedStack: stackFingerprint(base) };
}

const FRONTEND_TRANSCRIPT = '/Users/x/.codex/sessions/2026/05/29/rollout-2026-05-29T14-48-49-019e7390-ca45-7e03-84d3-284bda1ba905.jsonl';
const FRONTEND_THREAD = '019e7390-ca45-7e03-84d3-284bda1ba905';

test('transcriptThreadId parses the running thread uuid from a rollout filename', () => {
  assert.equal(transcriptThreadId(FRONTEND_TRANSCRIPT), FRONTEND_THREAD);
  assert.equal(transcriptThreadId('rollout-2026-05-29T14-48-49-019e7390-ca45-7e03-84d3-284bda1ba905.jsonl'), FRONTEND_THREAD);
  assert.equal(transcriptThreadId('/tmp/not-a-rollout.txt'), null);
  assert.equal(transcriptThreadId(null), null);
});

test('claimThreadRole stakes a role claim keyed by thread id; a child write resolves it via transcript_path', () => {
  withPrefs((dir) => {
    const state = materializedState();
    const ctx = claimThreadRole(dir, state, FRONTEND_THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' });
    assert.ok(ctx);
    assert.equal(ctx!.role, 'senior-frontend');
    assert.equal(ctx!.sessionId, FRONTEND_THREAD);

    // Codex reports the PARENT session_id on the child's write, but its own
    // transcript_path → resolves by threadId, no pending-claiming.
    const resolved = resolveRunAgentContext(dir, state, {
      session_id: 'orchestrator-parent',
      transcript_path: FRONTEND_TRANSCRIPT,
    }, { claimPending: false });
    assert.equal(resolved?.role, 'senior-frontend');

    // Idempotent.
    assert.equal(claimThreadRole(dir, state, FRONTEND_THREAD, 'senior-frontend')?.sessionId, FRONTEND_THREAD);
  });
});

test('a released claim reactivates in place on resume — metadata intact, release markers cleared', () => {
  withPrefs((dir) => {
    const state = { ...materializedState(), currentRunId: '1784600000001' };
    const first = claimThreadRole(dir, state, FRONTEND_THREAD, 'senior-frontend', {
      parentSessionId: 'orchestrator',
      model: 'opus',
    });
    assert.ok(first);
    const runId = String(first!.runId);
    assert.equal(releaseRunClaims(dir, runId, 'interrupt-sweep'), 1);
    const claimFile = path.join(dir, '.traffic-one', 'runs', runId, `${FRONTEND_THREAD}.json`);
    const released = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    const oldCreatedAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(claimFile, JSON.stringify({ ...released, createdAt: oldCreatedAt }), 'utf8');

    // Resume: SubagentStart re-fires for the SAME thread with no model in the payload.
    const resumed = claimThreadRole(dir, state, FRONTEND_THREAD, 'senior-frontend', { parentSessionId: 'orchestrator' });
    assert.ok(resumed);
    const file = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    assert.equal(file.status, 'claimed', 'resumed thread is claimed again');
    assert.equal(file.model, 'opus', 'model survives the release/resume cycle');
    assert.notEqual(file.createdAt, oldCreatedAt, 'resume refreshes the claim freshness window');
    assert.equal(file.releasedAt, undefined, 'release markers are cleared on reactivation');
    assert.equal(file.releasedReason, undefined);
  });
});

test('a retired thread cannot resume over the live replacement for its role', () => {
  withPrefs((dir) => {
    const state = { ...materializedState(), currentRunId: '1784600000003' };
    assert.ok(claimThreadRole(dir, state, 'reviewer-thread-retired', 'senior-reviewer', {
      model: 'sonnet',
      recordAgent: false,
    }));
    const runId = String(state.currentRunId);
    recordRunAgent(dir, runId, 'senior-reviewer', {
      agentId: 'reviewer-thread-retired',
      model: 'sonnet',
    });
    markRunAgentReplaced(dir, runId, 'senior-reviewer');

    assert.ok(claimThreadRole(dir, state, 'reviewer-thread-replacement', 'senior-reviewer', {
      model: 'sonnet',
      recordAgent: false,
      refuseOccupiedRole: true,
    }), 'verified replacement binds after the old registry row is retired');

    assert.equal(claimThreadRole(dir, state, 'reviewer-thread-retired', 'senior-reviewer', {
      model: 'sonnet',
      recordAgent: false,
      refuseOccupiedRole: true,
    }), null, 'late resume of the retired thread is refused');

    const runDir = path.join(dir, '.traffic-one', 'runs', runId);
    const retired = JSON.parse(fs.readFileSync(path.join(runDir, 'reviewer-thread-retired.json'), 'utf8'));
    const replacement = JSON.parse(fs.readFileSync(path.join(runDir, 'reviewer-thread-replacement.json'), 'utf8'));
    assert.equal(retired.status, 'released');
    assert.equal(replacement.status, 'claimed', 'late old-thread activity does not release the replacement');
  });
});

test('a retired thread cannot reclaim after an interrupt releases it and its registered replacement', () => {
  withPrefs((dir) => {
    const state = { ...materializedState(), currentRunId: '1784600000004' };
    const runId = String(state.currentRunId);
    assert.ok(claimThreadRole(dir, state, 'reviewer-thread-old', 'senior-reviewer', {
      model: 'sonnet',
      recordAgent: false,
    }));
    recordRunAgent(dir, runId, 'senior-reviewer', {
      agentId: 'reviewer-thread-old',
      model: 'sonnet',
    });
    markRunAgentReplaced(dir, runId, 'senior-reviewer');

    assert.ok(claimThreadRole(dir, state, 'reviewer-thread-new', 'senior-reviewer', {
      model: 'sonnet',
      recordAgent: false,
      refuseOccupiedRole: true,
    }));
    recordRunAgent(dir, runId, 'senior-reviewer', {
      agentId: 'reviewer-thread-new',
      model: 'sonnet',
    });
    assert.equal(releaseRunClaims(dir, runId, 'interrupt-sweep'), 1,
      'the retired claim was already superseded; the interrupt releases its current replacement');
    const releasedRunDir = path.join(dir, '.traffic-one', 'runs', runId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(releasedRunDir, 'reviewer-thread-old.json'), 'utf8')).status, 'released');
    assert.equal(JSON.parse(fs.readFileSync(path.join(releasedRunDir, 'reviewer-thread-new.json'), 'utf8')).status, 'released');

    assert.equal(claimThreadRole(dir, state, 'reviewer-thread-old', 'senior-reviewer', {
      model: 'sonnet',
      recordAgent: false,
      refuseOccupiedRole: true,
    }), null, 'registry ownership prevents the old thread from reclaiming first');
    assert.ok(claimThreadRole(dir, state, 'reviewer-thread-new', 'senior-reviewer', {
      model: 'sonnet',
      recordAgent: false,
      refuseOccupiedRole: true,
    }), 'the registered replacement can reactivate its own released claim');

    const runDir = path.join(dir, '.traffic-one', 'runs', runId);
    const oldClaim = JSON.parse(fs.readFileSync(path.join(runDir, 'reviewer-thread-old.json'), 'utf8'));
    const newClaim = JSON.parse(fs.readFileSync(path.join(runDir, 'reviewer-thread-new.json'), 'utf8'));
    assert.equal(oldClaim.status, 'released');
    assert.equal(newClaim.status, 'claimed');
  });
});

test('a verified replacement supersedes only the explicitly retired same-role claim', () => {
  withPrefs((dir) => {
    const state = { ...materializedState(), currentRunId: '1784600000002' };
    const first = claimThreadRole(dir, state, 'reviewer-thread-dead', 'senior-reviewer', {
      model: 'sonnet',
      recordAgent: false,
    });
    assert.ok(first, 'first reviewer claim binds');
    const runId = String(first!.runId);
    recordRunAgent(dir, runId, 'senior-reviewer', {
      agentId: 'reviewer-thread-dead',
      model: 'sonnet',
    });

    // A live duplicate remains blocked even when its model/role are valid.
    assert.equal(claimThreadRole(dir, state, 'reviewer-thread-live', 'senior-reviewer', {
      model: 'sonnet',
      refuseOccupiedRole: true,
    }), null);

    // The normal replacement gate records that the first reviewer died before
    // starting a NEW thread. Its fresh claim must no longer block that verified
    // SubagentStart bind.
    markRunAgentReplaced(dir, runId, 'senior-reviewer');
    const second = claimThreadRole(dir, state, 'reviewer-thread-live', 'senior-reviewer', {
      model: 'sonnet',
      refuseOccupiedRole: true,
    });
    assert.ok(second, 'replacement reviewer claim binds');

    const dead = JSON.parse(fs.readFileSync(
      path.join(dir, '.traffic-one', 'runs', runId, 'reviewer-thread-dead.json'),
      'utf8',
    ));
    assert.equal(dead.status, 'released', 'dead sibling claim is superseded');
    assert.match(String(dead.releasedReason), /^superseded-by-/);
    const live = JSON.parse(fs.readFileSync(
      path.join(dir, '.traffic-one', 'runs', runId, 'reviewer-thread-live.json'),
      'utf8',
    ));
    assert.equal(live.status, 'claimed');
  });
});

test('a thread with no claim (the orchestrator) resolves to no role', () => {
  withPrefs((dir) => {
    const state = materializedState();
    claimThreadRole(dir, state, FRONTEND_THREAD, 'senior-frontend');
    const main = resolveRunAgentContext(dir, state, {
      session_id: 'orchestrator-parent',
      transcript_path: '/x/rollout-2026-05-29T14-00-00-019e7389-0000-7000-8000-000000000000.jsonl',
    }, { claimPending: false });
    assert.equal(main, null);
  });
});

test('claimThreadRole rejects unknown roles and empty thread ids', () => {
  withPrefs((dir) => {
    const state = materializedState();
    assert.equal(claimThreadRole(dir, state, FRONTEND_THREAD, 'bogus-role'), null);
    assert.equal(claimThreadRole(dir, state, '', 'senior-frontend'), null);
  });
});

// A real Codex spawn prompt names the ASSIGNED role AND cross-references others
// ("avoid backend-owned paths", "senior-backend owns the API") — the inference must
// pick the assigned one, anchored on "You are …", not bail on the multiple tokens.
const CODEX_COLLABORATION_V2_ARCHITECT_FIXTURE = path.join(
  process.cwd(),
  'src/shared/state/__tests__/fixtures/codex-collaboration-v2-architect.jsonl',
);

function codexCollaborationV2FixtureRecords(): Record<string, unknown>[] {
  return fs.readFileSync(CODEX_COLLABORATION_V2_ARCHITECT_FIXTURE, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function writeTranscriptRecords(dir: string, name: string, records: unknown[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return file;
}

const CODEX_V2_CHILD_THREAD = '019f69fe-e335-7de0-be43-1ee45e3535c4';
const CODEX_V2_PARENT_THREAD = '019f69fb-334a-7351-8e94-66c97c3fa908';
const CODEX_V2_MODEL = 'gpt-5.6-sol';

function freezeCodexPolicyAndObservation(
  dir: string,
  state: Record<string, unknown>,
  runId: string,
  role: string,
  childId: string = CODEX_V2_CHILD_THREAD,
  parentSessionId: string = CODEX_V2_PARENT_THREAD,
  model: string = CODEX_V2_MODEL,
): void {
  const env = { ...process.env, TRAFFIC_ONE_HOST: 'codex', TRAFFIC_ONE_USER_PLAN: 'pro' };
  const target = currentHostModelTarget('codex', 'pro', env);
  const policyState = {
    ...state,
    currentRunId: runId,
    performance: {
      level: 'high',
      source: 'prompted',
      target: {
        plan: 'pro',
        appliedFingerprint: target.appliedFingerprint,
        configVersion: target.configVersion,
      },
    },
    team: { mode: 'subagents', approved: true, source: 'prompted' },
  };
  assert.ok(ensureRunModelPolicy(dir, runId, 'codex', policyState, env));
  assert.equal(observeCodexChildModel(dir, runId, {
    childId,
    parentSessionId,
    actualModel: model,
    role,
    source: 'SubagentStart',
  })?.status, 'verified');
}

function writeCodexV2FixtureTranscript(dir: string): string {
  const file = path.join(dir, `rollout-2026-07-16T11-15-39-${CODEX_V2_CHILD_THREAD}.jsonl`);
  fs.writeFileSync(file, fs.readFileSync(CODEX_COLLABORATION_V2_ARCHITECT_FIXTURE, 'utf8'), 'utf8');
  return file;
}

function legacyRegistryEntry(
  agentId: string,
  parentSessionId: string = CODEX_V2_PARENT_THREAD,
  model: string = CODEX_V2_MODEL,
  recordedAt: string = new Date().toISOString(),
): Record<string, unknown> {
  return {
    agentId,
    resumeId: agentId,
    toolCallId: null,
    model,
    agentType: null,
    parentSessionId,
    recordedAt,
    tasks: 1,
    replaced: false,
  };
}

function writeLegacyCodexClaimAndRegistry(
  dir: string,
  state: Record<string, unknown>,
  runId: string,
  role: string,
  additionalAgents: Record<string, unknown> = {},
): { runDir: string; claimFile: string; registryFile: string } {
  freezeCodexPolicyAndObservation(dir, state, runId, role);
  const runDirectory = path.join(dir, '.traffic-one', 'runs', runId);
  const claimFile = path.join(runDirectory, `${CODEX_V2_CHILD_THREAD}.json`);
  const registryFile = path.join(runDirectory, 'agents.json');
  const now = new Date().toISOString();
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.writeFileSync(claimFile, JSON.stringify({
    version: 1,
    runId,
    claimId: `${role}-1-${CODEX_V2_CHILD_THREAD.slice(-8)}`,
    role,
    spawnIndex: 1,
    status: 'claimed',
    sessionId: CODEX_V2_CHILD_THREAD,
    parentSessionId: CODEX_V2_PARENT_THREAD,
    createdAt: now,
    claimedAt: now,
    stackFingerprint: stackFingerprint(state),
    model: CODEX_V2_MODEL,
  }), 'utf8');
  fs.writeFileSync(registryFile, JSON.stringify({
    version: 1,
    agents: {
      [role]: legacyRegistryEntry(CODEX_V2_CHILD_THREAD),
      ...additionalAgents,
    },
    history: [],
  }), 'utf8');
  return { runDir: runDirectory, claimFile, registryFile };
}

function fallbackTestContext(runId: string, role: string, sessionId: string): {
  source: string;
  runId: string;
  role: string;
  spawnIndex: number;
  sessionId: string;
  claimId: string;
} {
  return {
    source: 'test',
    runId,
    role,
    spawnIndex: 1,
    sessionId,
    claimId: `${role}-test-${sessionId.slice(-8)}`,
  };
}

type RebindCrashPhase = 'prepared' | 'claim-first' | 'registry-first' | 'committed' | 'after-cleanup';

function writeRebindCrashFixture(
  dir: string,
  runId: string,
  phase: RebindCrashPhase,
): {
  state: Record<string, unknown>;
  files: { runDir: string; claimFile: string; registryFile: string };
  journalFile: string;
  targetClaimId: string;
  otherThread: string;
} {
  const state = { ...materializedState(), currentRunId: runId };
  const files = writeLegacyCodexClaimAndRegistry(dir, state, runId, 'senior-frontend');
  const sourceClaim = JSON.parse(fs.readFileSync(files.claimFile, 'utf8')) as Record<string, unknown>;
  const sourceRegistry = JSON.parse(fs.readFileSync(files.registryFile, 'utf8')) as Record<string, unknown>;
  const pending = ensureRunAgentClaim(
    dir,
    state,
    'senior-architect',
    { session_id: CODEX_V2_PARENT_THREAD },
    { toolName: 'spawn_agent', model: CODEX_V2_MODEL, roleSource: 'spawn-task-name' },
  );
  assert.ok(pending);
  const now = new Date().toISOString();
  const targetClaim = {
    ...sourceClaim,
    claimId: pending!.claimId,
    role: 'senior-architect',
    spawnIndex: pending!.spawnIndex,
    roleSource: 'codex-session-meta-agent-path',
    transcriptPath: null,
    correctedAt: now,
    correctedFromRole: 'senior-frontend',
  };
  const sourceAgents = (sourceRegistry.agents || {}) as Record<string, unknown>;
  const targetEntry = {
    ...((sourceAgents['senior-frontend'] || {}) as Record<string, unknown>),
    agentId: CODEX_V2_CHILD_THREAD,
    roleSource: 'codex-session-meta-agent-path',
    transcriptPath: null,
  };
  const targetRegistry = {
    ...sourceRegistry,
    agents: { 'senior-architect': targetEntry },
  };
  const journalFile = path.join(
    files.runDir,
    'transactions',
    `rebind-${CODEX_V2_CHILD_THREAD}.json`,
  );
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  fs.writeFileSync(journalFile, JSON.stringify({
    version: 1,
    kind: 'authoritative-role-rebind',
    runId,
    threadId: CODEX_V2_CHILD_THREAD,
    oldRole: 'senior-frontend',
    targetRole: 'senior-architect',
    sourceClaimId: sourceClaim.claimId,
    sourceClaimWasPresent: true,
    targetClaimId: pending!.claimId,
    targetClaim,
    registryEntry: targetEntry,
    pendingClaimIds: [pending!.claimId, sourceClaim.claimId],
    createdAt: now,
  }), 'utf8');

  if (phase === 'claim-first' || phase === 'committed' || phase === 'after-cleanup') {
    fs.writeFileSync(files.claimFile, JSON.stringify(targetClaim), 'utf8');
  }
  if (phase === 'registry-first' || phase === 'committed' || phase === 'after-cleanup') {
    fs.writeFileSync(files.registryFile, JSON.stringify(targetRegistry), 'utf8');
  }

  const otherThread = '019f69ff-0000-7000-8000-000000000088';
  assert.equal(
    tryFallbackClaim(dir, fallbackTestContext(runId, 'senior-frontend', CODEX_V2_CHILD_THREAD), 'package.json').blocked,
    false,
  );
  assert.equal(
    tryFallbackClaim(dir, fallbackTestContext(runId, 'senior-backend', otherThread), 'services/api/src/other.ts').blocked,
    false,
  );
  if (phase === 'after-cleanup') {
    fs.rmSync(path.join(files.runDir, 'claims', 'package.json.json'), { force: true });
    const pendingDir = path.join(files.runDir, 'pending');
    for (const name of fs.readdirSync(pendingDir)) {
      const file = path.join(pendingDir, name);
      const claim = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (claim.claimId === pending!.claimId) fs.rmSync(file, { force: true });
    }
  }
  return {
    state,
    files,
    journalFile,
    targetClaimId: String(pending!.claimId),
    otherThread,
  };
}

function withIsolatedCodexSessions<T>(dir: string, fn: (sessionDir: string) => T): T {
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = path.join(dir, 'codex-home');
  process.env.CODEX_HOME = codexHome;
  const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '16');
  fs.mkdirSync(sessionDir, { recursive: true });
  try {
    return fn(sessionDir);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
}

function writeChildTranscript(dir: string, threadId: string, body: string): string {
  const file = path.join(dir, `rollout-2026-05-29T16-44-54-${threadId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: body }] },
  })}\n`, 'utf8');
  return file;
}

test('inferRoleFromTranscript trusts Codex collaboration-v2 session_meta over encrypted and non-user markers', () => {
  assert.equal(
    inferRoleFromTranscript(CODEX_COLLABORATION_V2_ARCHITECT_FIXTURE),
    'senior-architect',
    'line-0 agent_path is authoritative even when later opaque/tool/assistant/unknown records mention frontend',
  );
});

test('inferRoleFromTranscript ignores encrypted Codex task content', () => {
  withPrefs((dir) => {
    const records = codexCollaborationV2FixtureRecords();
    const encryptedOnly = writeTranscriptRecords(dir, 'codex-encrypted-only.jsonl', [records[1]]);
    assert.equal(inferRoleFromTranscript(encryptedOnly), null, 'encrypted_content is opaque, never role evidence');
  });
});

test('inferRoleFromTranscript ignores tool, assistant, and unknown marker records', () => {
  withPrefs((dir) => {
    const records = codexCollaborationV2FixtureRecords();
    const nonUserOnly = writeTranscriptRecords(dir, 'codex-non-user-only.jsonl', records.slice(2));
    assert.equal(
      inferRoleFromTranscript(nonUserOnly),
      null,
      'tool output, assistant text, and unknown records cannot authenticate a role',
    );
  });
});

test('inferRoleFromTranscript retains a marker anywhere in a recognized user record', () => {
  withPrefs((dir) => {
    const records = codexCollaborationV2FixtureRecords();
    const recognizedUser = {
      timestamp: '2026-07-16T08:20:00.500Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Resume the bounded review.\nContext before the marker.\n[t1-role: senior-reviewer]\nContinue read-only.',
        }],
      },
    };
    const file = writeTranscriptRecords(dir, 'codex-recognized-user-marker.jsonl', [
      records[1],
      records[2],
      recognizedUser,
      records[3],
      records[4],
    ]);
    assert.equal(
      inferRoleFromTranscript(file),
      'senior-reviewer',
      'recognized user markers remain valid regardless of record or text position',
    );
  });
});

test('inferRoleFromTranscript fails closed when valid structured Codex roles conflict', () => {
  withPrefs((dir) => {
    const records = codexCollaborationV2FixtureRecords();
    const conflictingMeta = JSON.parse(JSON.stringify(records[0])) as {
      payload: {
        source: { subagent: { thread_spawn: { agent_path: string } } };
      };
    };
    conflictingMeta.payload.source.subagent.thread_spawn.agent_path = '/root/senior_frontend';
    const file = writeTranscriptRecords(dir, 'codex-conflicting-session-meta.jsonl', [
      conflictingMeta,
      ...records.slice(1),
    ]);
    assert.equal(
      inferRoleFromTranscript(file),
      null,
      'two different valid line-0 roles are corruption, not a precedence choice',
    );
  });
});

test('current Codex roleless session_meta does not fall through to a later readable user marker', () => {
  withPrefs((dir) => {
    const childId = '019f69ff-0000-7000-8000-000000000011';
    const file = writeTranscriptRecords(dir, `rollout-roleless-${childId}.jsonl`, [
      {
        type: 'session_meta',
        payload: {
          id: childId,
          parent_thread_id: CODEX_V2_PARENT_THREAD,
          thread_source: 'subagent',
          agent_type: 'default',
          source: { subagent: { thread_spawn: { parent_thread_id: CODEX_V2_PARENT_THREAD } } },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Inherited context [t1-role: senior-frontend]' }],
        },
      },
    ]);
    assert.equal(inferRoleFromTranscript(file), null);
  });
});

test('authoritative Codex metadata repairs a poisoned claim and registry and releases only its holder locks', () => {
  withPrefs((dir) => {
    const runId = 'run-codex-authoritative-rebind';
    const state = { ...materializedState(), currentRunId: runId };
    const transcript = writeCodexV2FixtureTranscript(dir);
    const unrelatedBackend = '019f69ff-0000-7000-8000-000000000010';
    const files = writeLegacyCodexClaimAndRegistry(dir, state, runId, 'senior-frontend', {
      'senior-backend': legacyRegistryEntry(unrelatedBackend),
    });
    const originalCreatedAt = JSON.parse(fs.readFileSync(files.claimFile, 'utf8')).createdAt;
    const architectPending = ensureRunAgentClaim(
      dir,
      state,
      'senior-architect',
      { session_id: CODEX_V2_PARENT_THREAD },
      { toolName: 'spawn_agent', model: CODEX_V2_MODEL, roleSource: 'spawn-task-name' },
    );
    const unrelatedPending = ensureRunAgentClaim(
      dir,
      state,
      'senior-tester',
      { session_id: CODEX_V2_PARENT_THREAD },
      { toolName: 'spawn_agent', model: 'gpt-5.6-spark', roleSource: 'spawn-task-name' },
    );
    assert.ok(architectPending);
    assert.ok(unrelatedPending);
    const ownContext = fallbackTestContext(runId, 'senior-frontend', CODEX_V2_CHILD_THREAD);
    const otherThread = '019f69ff-0000-7000-8000-000000000001';
    const otherContext = fallbackTestContext(runId, 'senior-backend', otherThread);

    assert.equal(tryFallbackClaim(dir, ownContext, 'package.json').blocked, false);
    assert.equal(tryFallbackClaim(dir, ownContext, 'packages/contracts/src/index.ts').blocked, false);
    assert.equal(tryFallbackClaim(dir, otherContext, 'services/api/src/a.ts').blocked, false);
    const claimsDir = path.join(files.runDir, 'claims');
    fs.writeFileSync(path.join(claimsDir, 'same-holder-other-run.json'), JSON.stringify({
      version: 1,
      runId: 'another-run',
      path: 'apps/web/src/other-run.ts',
      holder: CODEX_V2_CHILD_THREAD,
      role: 'senior-frontend',
      createdAt: new Date().toISOString(),
    }), 'utf8');
    fs.writeFileSync(path.join(claimsDir, 'legacy-role-only.json'), JSON.stringify({
      version: 1,
      runId,
      path: 'packages/contracts/src/legacy.ts',
      role: 'senior-frontend',
      createdAt: new Date().toISOString(),
    }), 'utf8');
    fs.writeFileSync(path.join(claimsDir, 'malformed.json'), '{not-json', 'utf8');

    const resolved = resolveRunAgentContext(dir, state, {
      session_id: CODEX_V2_PARENT_THREAD,
      transcript_path: transcript,
      model: CODEX_V2_MODEL,
    }, { claimPending: true });
    assert.equal(resolved?.role, 'senior-architect');
    assert.equal(resolved?.source, 'authoritative-role-rebind');

    const correctedClaim = JSON.parse(fs.readFileSync(files.claimFile, 'utf8'));
    assert.equal(correctedClaim.role, 'senior-architect');
    assert.equal(correctedClaim.claimId, architectPending?.claimId, 'strict same-parent/model pending identity is reused');
    assert.equal(correctedClaim.spawnIndex, architectPending?.spawnIndex);
    assert.equal(correctedClaim.correctedFromRole, 'senior-frontend');
    assert.equal(correctedClaim.createdAt, originalCreatedAt, 'correction does not refresh the original claim age');
    assert.equal(typeof correctedClaim.correctedAt, 'string');
    assert.equal(correctedClaim.roleEvidenceVersion, undefined);
    assert.equal(correctedClaim.correctedFromSpawnIndex, undefined);
    assert.equal(correctedClaim.correctedFromClaimId, undefined);
    assert.match(correctedClaim.roleSource, /^codex-session-meta-/);
    const registry = readRunAgentRegistry(dir, runId);
    assert.equal(registry['senior-frontend'], undefined);
    assert.equal(registry['senior-architect']?.agentId, CODEX_V2_CHILD_THREAD);
    assert.equal(registry['senior-backend']?.agentId, unrelatedBackend, 'unrelated live agents are preserved');
    const registryRaw = JSON.parse(fs.readFileSync(files.registryFile, 'utf8'));
    assert.equal(registryRaw.history.at(-1)?.replacementReason, 'authoritative-role-rebind');
    const pendingAfter = fs.readdirSync(path.join(files.runDir, 'pending'))
      .map((name) => JSON.parse(fs.readFileSync(path.join(files.runDir, 'pending', name), 'utf8')));
    assert.equal(pendingAfter.some((claim) => claim.claimId === architectPending?.claimId), false);
    assert.equal(pendingAfter.some((claim) => claim.claimId === unrelatedPending?.claimId), true);

    const remainingFiles = fs.readdirSync(claimsDir).sort();
    const remainingClaims = remainingFiles.flatMap((name) => {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(claimsDir, name), 'utf8'));
        return value && typeof value === 'object' ? [value as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
    assert.equal(
      remainingClaims.some((claim) => claim.runId === runId && claim.holder === CODEX_V2_CHILD_THREAD),
      false,
      'every exact run+holder path lock is released',
    );
    assert.equal(remainingClaims.some((claim) => claim.holder === otherThread), true, 'unrelated holder remains');
    assert.equal(
      remainingClaims.some((claim) => claim.runId === 'another-run' && claim.holder === CODEX_V2_CHILD_THREAD),
      true,
      'same holder in another run remains',
    );
    assert.equal(remainingFiles.includes('malformed.json'), true, 'malformed lock remains untouched');
    assert.equal(remainingFiles.includes('legacy-role-only.json'), true, 'legacy role-only lock remains untouched');
  });
});

test('authoritative rebind journal rolls forward every crash phase before exact-claim reuse', () => {
  const phases: RebindCrashPhase[] = ['prepared', 'claim-first', 'registry-first', 'committed', 'after-cleanup'];
  for (const phase of phases) {
    withPrefs((dir) => {
      const fixture = writeRebindCrashFixture(dir, `run-rebind-crash-${phase}`, phase);
      if (phase === 'prepared') {
        const legacyClaim = JSON.parse(fs.readFileSync(fixture.files.claimFile, 'utf8')) as Record<string, unknown>;
        delete legacyClaim.sessionId;
        fs.writeFileSync(fixture.files.claimFile, JSON.stringify(legacyClaim), 'utf8');
      }
      const resolved = resolveRunAgentContext(dir, fixture.state, {
        agent_id: CODEX_V2_CHILD_THREAD,
        parent_session_id: CODEX_V2_PARENT_THREAD,
        subagent_type: 'senior-architect',
      }, { claimPending: false });
      assert.equal(resolved?.role, 'senior-architect', `${phase}: exact reuse waits for roll-forward cleanup`);
      assert.equal(resolved?.sessionId, CODEX_V2_CHILD_THREAD);
      assert.equal(fs.existsSync(fixture.journalFile), false, `${phase}: completed journal is removed`);

      const claim = JSON.parse(fs.readFileSync(fixture.files.claimFile, 'utf8')) as Record<string, unknown>;
      assert.equal(claim.role, 'senior-architect');
      assert.equal(claim.claimId, fixture.targetClaimId, `${phase}: target pending identity wins`);
      const registry = readRunAgentRegistry(dir, String(fixture.state.currentRunId));
      assert.equal(registry['senior-frontend'], undefined);
      assert.equal(registry['senior-architect']?.agentId, CODEX_V2_CHILD_THREAD);

      const remaining = fs.readdirSync(path.join(fixture.files.runDir, 'claims'))
        .map((name) => JSON.parse(fs.readFileSync(path.join(fixture.files.runDir, 'claims', name), 'utf8')));
      assert.equal(
        remaining.some((entry) => entry.runId === fixture.state.currentRunId && entry.holder === CODEX_V2_CHILD_THREAD),
        false,
        `${phase}: only the corrected child's exact-holder locks are cleared`,
      );
      assert.equal(remaining.some((entry) => entry.holder === fixture.otherThread), true, `${phase}: other holder remains`);
      const pendingDir = path.join(fixture.files.runDir, 'pending');
      const pendingAfter = fs.existsSync(pendingDir)
        ? fs.readdirSync(pendingDir).map((name) => JSON.parse(fs.readFileSync(path.join(pendingDir, name), 'utf8')))
        : [];
      assert.equal(pendingAfter.some((entry) => entry.claimId === fixture.targetClaimId), false);
    });
  }
});

test('same-role Codex metadata annotates the claim without releasing fallback locks', () => {
  withPrefs((dir) => {
    const runId = 'run-codex-same-role';
    const state = { ...materializedState(), currentRunId: runId };
    const transcript = writeCodexV2FixtureTranscript(dir);
    const files = writeLegacyCodexClaimAndRegistry(dir, state, runId, 'senior-architect');
    const context = fallbackTestContext(runId, 'senior-architect', CODEX_V2_CHILD_THREAD);
    assert.equal(tryFallbackClaim(dir, context, 'packages/contracts/src/index.ts').blocked, false);
    const claimsDir = path.join(files.runDir, 'claims');
    const before = fs.readdirSync(claimsDir).sort();

    const resolved = resolveRunAgentContext(dir, state, {
      session_id: CODEX_V2_PARENT_THREAD,
      transcript_path: transcript,
      model: CODEX_V2_MODEL,
    }, { claimPending: true });
    assert.equal(resolved?.role, 'senior-architect');
    assert.deepEqual(fs.readdirSync(claimsDir).sort(), before, 'no ownership change means no path-lock cleanup');
    const claim = JSON.parse(fs.readFileSync(files.claimFile, 'utf8'));
    assert.match(claim.roleSource, /^codex-session-meta-/);
  });
});

test('weaker task or prompt evidence cannot downgrade or rebind structured claim provenance', () => {
  withPrefs((dir) => {
    const runId = 'run-role-source-precedence';
    const state = { ...materializedState(), currentRunId: runId };
    const childId = '019f69ff-0000-7000-8000-000000000012';
    assert.ok(claimThreadRole(dir, state, childId, 'senior-architect', {
      parentSessionId: CODEX_V2_PARENT_THREAD,
      recordAgent: false,
      evidence: {
        role: 'senior-architect',
        source: 'codex-session-meta-agent-path',
        authority: 'authoritative',
      },
    }));

    assert.ok(claimThreadRole(dir, state, childId, 'senior-architect', {
      parentSessionId: CODEX_V2_PARENT_THREAD,
      recordAgent: false,
      evidence: { role: 'senior-architect', source: 'spawn-task-name', authority: 'authoritative' },
    }));
    assert.equal(claimThreadRole(dir, state, childId, 'senior-frontend', {
      parentSessionId: CODEX_V2_PARENT_THREAD,
      recordAgent: false,
      evidence: { role: 'senior-frontend', source: 'spawn-task-name', authority: 'authoritative' },
    }), null, 'task_name cannot correct a conflicting tier-1 claim');

    const claim = JSON.parse(fs.readFileSync(
      path.join(dir, '.traffic-one', 'runs', runId, `${childId}.json`),
      'utf8',
    ));
    assert.equal(claim.role, 'senior-architect');
    assert.equal(claim.roleSource, 'codex-session-meta-agent-path');

    recordRunAgent(dir, runId, 'senior-architect', {
      agentId: childId,
      parentSessionId: CODEX_V2_PARENT_THREAD,
      roleSource: 'codex-session-meta-agent-path',
    });
    recordRunAgent(dir, runId, 'senior-architect', {
      agentId: childId,
      parentSessionId: CODEX_V2_PARENT_THREAD,
      roleSource: 'spawn-task-name',
    });
    assert.equal(readRunAgentRegistry(dir, runId)['senior-architect']?.roleSource, 'codex-session-meta-agent-path');
  });
});

test('profile and agent-name host identity stay in the strongest persisted tier', () => {
  withPrefs((dir) => {
    const runId = 'run-host-source-precedence';
    const state = { ...materializedState(), currentRunId: runId };
    for (const [index, source] of ['host-profile', 'host-agent-name'].entries()) {
      const childId = `019f69ff-0000-7000-8000-00000000002${index}`;
      assert.ok(claimThreadRole(dir, state, childId, 'senior-architect', {
        recordAgent: false,
        evidence: { role: 'senior-architect', source, authority: 'authoritative' },
      }));

      assert.ok(claimThreadRole(dir, state, childId, 'senior-architect', {
        recordAgent: false,
        evidence: { role: 'senior-architect', source: 'spawn-task-name', authority: 'authoritative' },
      }));
      assert.equal(claimThreadRole(dir, state, childId, 'senior-frontend', {
        recordAgent: false,
        evidence: { role: 'senior-frontend', source: 'spawn-task-name', authority: 'authoritative' },
      }), null);

      const claim = JSON.parse(fs.readFileSync(
        path.join(dir, '.traffic-one', 'runs', runId, `${childId}.json`),
        'utf8',
      ));
      assert.equal(claim.role, 'senior-architect');
      assert.equal(claim.roleSource, source);

      recordRunAgent(dir, runId, 'senior-architect', { agentId: childId, roleSource: source });
      recordRunAgent(dir, runId, 'senior-architect', { agentId: childId, roleSource: 'spawn-task-name' });
      assert.equal(readRunAgentRegistry(dir, runId)['senior-architect']?.roleSource, source);
    }
  });
});

test('same-tier authoritative role conflicts fail closed while stronger evidence repairs weaker claims', () => {
  withPrefs((dir) => {
    const runId = 'run-role-source-conflict';
    const state = { ...materializedState(), currentRunId: runId };
    const hostChild = '019f69ff-0000-7000-8000-000000000030';
    assert.ok(claimThreadRole(dir, state, hostChild, 'senior-architect', {
      recordAgent: false,
      evidence: { role: 'senior-architect', source: 'host-agent-type', authority: 'authoritative' },
    }));
    assert.equal(claimThreadRole(dir, state, hostChild, 'senior-frontend', {
      recordAgent: false,
      evidence: { role: 'senior-frontend', source: 'codex-session-meta-agent-path', authority: 'authoritative' },
    }), null, 'equal-strength host/session evidence cannot rebind an existing claim');

    const taskChild = '019f69ff-0000-7000-8000-000000000031';
    assert.ok(claimThreadRole(dir, state, taskChild, 'senior-architect', {
      recordAgent: false,
      evidence: { role: 'senior-architect', source: 'spawn-task-name', authority: 'authoritative' },
    }));
    assert.equal(claimThreadRole(dir, state, taskChild, 'senior-frontend', {
      recordAgent: false,
      evidence: { role: 'senior-frontend', source: 'spawn-task-name', authority: 'authoritative' },
    }), null, 'equal-strength task names cannot rebind an existing claim');

    const legacyChild = '019f69ff-0000-7000-8000-000000000032';
    assert.ok(claimThreadRole(dir, state, legacyChild, 'senior-architect', {
      recordAgent: false,
      evidence: { role: 'senior-architect', source: 'spawn-role-marker', authority: 'explicit' },
    }));
    const repaired = claimThreadRole(dir, state, legacyChild, 'senior-frontend', {
      recordAgent: false,
      evidence: { role: 'senior-frontend', source: 'spawn-task-name', authority: 'authoritative' },
    });
    assert.equal(repaired?.role, 'senior-frontend', 'a stronger exact task name repairs weaker legacy evidence');

    const hostClaim = JSON.parse(fs.readFileSync(
      path.join(dir, '.traffic-one', 'runs', runId, `${hostChild}.json`),
      'utf8',
    ));
    const taskClaim = JSON.parse(fs.readFileSync(
      path.join(dir, '.traffic-one', 'runs', runId, `${taskChild}.json`),
      'utf8',
    ));
    assert.equal(hostClaim.role, 'senior-architect');
    assert.equal(hostClaim.roleSource, 'host-agent-type');
    assert.equal(taskClaim.role, 'senior-architect');
    assert.equal(taskClaim.roleSource, 'spawn-task-name');
  });
});

test('authoritative Codex rebind fails closed when the target role registry slot is occupied', () => {
  withPrefs((dir) => {
    const runId = 'run-codex-target-collision';
    const state = { ...materializedState(), currentRunId: runId };
    const transcript = writeCodexV2FixtureTranscript(dir);
    const existingArchitect = '019f69ff-0000-7000-8000-000000000002';
    const files = writeLegacyCodexClaimAndRegistry(dir, state, runId, 'senior-frontend', {
      'senior-architect': legacyRegistryEntry(existingArchitect),
    });
    const context = fallbackTestContext(runId, 'senior-frontend', CODEX_V2_CHILD_THREAD);
    assert.equal(tryFallbackClaim(dir, context, 'apps/web/src/collision.ts').blocked, false);
    const claimsDir = path.join(files.runDir, 'claims');
    const locksBefore = fs.readdirSync(claimsDir).sort();

    const resolved = resolveRunAgentContext(dir, state, {
      session_id: CODEX_V2_PARENT_THREAD,
      transcript_path: transcript,
      model: CODEX_V2_MODEL,
    }, { claimPending: true });
    assert.equal(resolved, null);
    assert.equal(JSON.parse(fs.readFileSync(files.claimFile, 'utf8')).role, 'senior-frontend');
    const registry = readRunAgentRegistry(dir, runId);
    assert.equal(registry['senior-frontend']?.agentId, CODEX_V2_CHILD_THREAD);
    assert.equal(registry['senior-architect']?.agentId, existingArchitect);
    assert.deepEqual(fs.readdirSync(claimsDir).sort(), locksBefore, 'failed correction cannot release ownership locks');
    const rawRegistry = JSON.parse(fs.readFileSync(files.registryFile, 'utf8'));
    assert.equal(rawRegistry.conflicts.at(-1)?.reason, 'authoritative-role-rebind-target-occupied');
  });
});

test('fallback writers fail open on a fresh claims-lock timeout without mutating ownership', () => {
  withPrefs((dir) => {
    const runId = 'run-fallback-lock-timeout';
    const runDirectory = path.join(dir, '.traffic-one', 'runs', runId);
    const lockDir = path.join(runDirectory, '.claims.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    const started = Date.now();
    const result = tryFallbackClaim(
      dir,
      fallbackTestContext(runId, 'senior-frontend', CODEX_V2_CHILD_THREAD),
      'apps/web/src/timeout.ts',
    );
    const elapsed = Date.now() - started;
    assert.deepEqual(result, { blocked: false }, 'writer stays fail-open when the serialization lock is unavailable');
    assert.ok(elapsed >= 1_800 && elapsed < 4_000, `expected a bounded ~2s wait, got ${elapsed}ms`);
    assert.equal(fs.existsSync(path.join(runDirectory, 'claims', 'apps_web_src_timeout.ts.json')), false);
    assert.equal(fs.existsSync(lockDir), true, 'a fresh lock owned by another process is never stolen');
  });
});

test('fallback claims serialize racing first writers so exactly one owns the path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-fallback-concurrent-'));
  const runId = 'run-fallback-concurrent';
  const runDirectory = path.join(dir, '.traffic-one', 'runs', runId);
  const lockDir = path.join(runDirectory, '.claims.lock');
  const source = [
    "const { tryFallbackClaim } = require('./src/shared/state/run-agent.ts');",
    "const [cwd, runId, holder] = process.argv.slice(1);",
    "const ctx = { source: 'child', runId, role: 'senior-frontend', spawnIndex: 1, sessionId: holder, claimId: holder };",
    "process.stdout.write(JSON.stringify(tryFallbackClaim(cwd, ctx, 'apps/web/src/race.ts')));",
  ].join('\n');
  try {
    resetAuthoringRootCache();
    fs.mkdirSync(lockDir, { recursive: true });
    const runChild = (holder: string): Promise<{ blocked: boolean; holder?: string }> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', source, dir, runId, holder], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let stdout = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) reject(new Error(`fallback claimant exited ${code}`));
        else resolve(JSON.parse(stdout) as { blocked: boolean; holder?: string });
      });
    });
    const racers = [runChild('thread-a'), runChild('thread-b')];
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(lockDir, { recursive: true, force: true });
    const results = await Promise.all(racers);
    assert.equal(results.filter((result) => result.blocked === false).length, 1);
    assert.equal(results.filter((result) => result.blocked === true).length, 1);
    const claim = JSON.parse(fs.readFileSync(
      path.join(runDirectory, 'claims', 'apps_web_src_race.ts.json'),
      'utf8',
    ));
    assert.ok(claim.holder === 'thread-a' || claim.holder === 'thread-b');
    assert.equal(results.find((result) => result.blocked)?.holder, claim.holder);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    resetAuthoringRootCache();
  }
});

test('authoritative correction denies and preserves locks when claims cleanup cannot acquire its lock', () => {
  withPrefs((dir) => {
    const runId = 'run-codex-claims-lock-timeout';
    const state = { ...materializedState(), currentRunId: runId };
    const transcript = writeCodexV2FixtureTranscript(dir);
    const files = writeLegacyCodexClaimAndRegistry(dir, state, runId, 'senior-frontend');
    const context = fallbackTestContext(runId, 'senior-frontend', CODEX_V2_CHILD_THREAD);
    assert.equal(tryFallbackClaim(dir, context, 'apps/web/src/held.ts').blocked, false);
    const claimsBefore = fs.readdirSync(path.join(files.runDir, 'claims')).sort();
    const claimsLock = path.join(files.runDir, '.claims.lock');
    fs.mkdirSync(claimsLock);

    const started = Date.now();
    const resolved = resolveRunAgentContext(dir, state, {
      session_id: CODEX_V2_PARENT_THREAD,
      transcript_path: transcript,
      model: CODEX_V2_MODEL,
    }, { claimPending: true });
    const elapsed = Date.now() - started;
    assert.equal(resolved, null);
    assert.ok(elapsed >= 1_800 && elapsed < 4_000, `expected a bounded ~2s wait, got ${elapsed}ms`);
    assert.equal(JSON.parse(fs.readFileSync(files.claimFile, 'utf8')).role, 'senior-frontend');
    assert.deepEqual(fs.readdirSync(path.join(files.runDir, 'claims')).sort(), claimsBefore);
    assert.equal(readRunAgentRegistry(dir, runId)['senior-frontend']?.agentId, CODEX_V2_CHILD_THREAD);
    assert.equal(readRunAgentRegistry(dir, runId)['senior-architect'], undefined);
  });
});

test('authoritative correction retains its journal and retries an unsafe exact-holder cleanup', (t) => {
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
    t.skip('directory-mode cleanup failure requires a non-root POSIX process');
    return;
  }
  withPrefs((dir) => {
    const runId = 'run-codex-cleanup-retry';
    const state = { ...materializedState(), currentRunId: runId };
    const transcript = writeCodexV2FixtureTranscript(dir);
    const files = writeLegacyCodexClaimAndRegistry(dir, state, runId, 'senior-frontend');
    const pending = ensureRunAgentClaim(
      dir,
      state,
      'senior-architect',
      { session_id: CODEX_V2_PARENT_THREAD },
      { toolName: 'spawn_agent', model: CODEX_V2_MODEL, roleSource: 'spawn-task-name' },
    );
    assert.ok(pending);
    const otherThread = '019f69ff-0000-7000-8000-000000000089';
    assert.equal(
      tryFallbackClaim(
        dir,
        fallbackTestContext(runId, 'senior-frontend', CODEX_V2_CHILD_THREAD),
        'packages/contracts/src/retry.ts',
      ).blocked,
      false,
    );
    assert.equal(
      tryFallbackClaim(
        dir,
        fallbackTestContext(runId, 'senior-backend', otherThread),
        'services/api/src/retry.ts',
      ).blocked,
      false,
    );
    const claimsDir = path.join(files.runDir, 'claims');
    const originalMode = fs.statSync(claimsDir).mode & 0o777;
    let first: ReturnType<typeof resolveRunAgentContext> = null;
    fs.chmodSync(claimsDir, 0o555);
    try {
      first = resolveRunAgentContext(dir, state, {
        session_id: CODEX_V2_PARENT_THREAD,
        transcript_path: transcript,
        model: CODEX_V2_MODEL,
      }, { claimPending: true });
    } finally {
      fs.chmodSync(claimsDir, originalMode);
    }
    assert.equal(first, null, 'unsafe cleanup never returns the corrected context');
    const journalFile = path.join(
      files.runDir,
      'transactions',
      `rebind-${CODEX_V2_CHILD_THREAD}.json`,
    );
    assert.equal(fs.existsSync(journalFile), true, 'the durable retry record remains');
    assert.equal(JSON.parse(fs.readFileSync(files.claimFile, 'utf8')).role, 'senior-architect');
    assert.equal(readRunAgentRegistry(dir, runId)['senior-architect']?.agentId, CODEX_V2_CHILD_THREAD);

    const retried = resolveRunAgentContext(dir, state, {
      agent_id: CODEX_V2_CHILD_THREAD,
      parent_session_id: CODEX_V2_PARENT_THREAD,
      subagent_type: 'senior-architect',
    }, { claimPending: false });
    assert.equal(retried?.role, 'senior-architect');
    assert.equal(fs.existsSync(journalFile), false);
    const remaining = fs.readdirSync(claimsDir)
      .map((name) => JSON.parse(fs.readFileSync(path.join(claimsDir, name), 'utf8')));
    assert.equal(remaining.some((entry) => entry.holder === CODEX_V2_CHILD_THREAD), false);
    assert.equal(remaining.some((entry) => entry.holder === otherThread), true, 'retry stays exact-holder only');
  });
});

test('authoritative correction denies before cleanup when the registry lock times out', () => {
  withPrefs((dir) => {
    const runId = 'run-codex-registry-lock-timeout';
    const state = { ...materializedState(), currentRunId: runId };
    const transcript = writeCodexV2FixtureTranscript(dir);
    const files = writeLegacyCodexClaimAndRegistry(dir, state, runId, 'senior-frontend');
    const context = fallbackTestContext(runId, 'senior-frontend', CODEX_V2_CHILD_THREAD);
    assert.equal(tryFallbackClaim(dir, context, 'apps/web/src/registry-held.ts').blocked, false);
    const claimsBefore = fs.readdirSync(path.join(files.runDir, 'claims')).sort();
    const registryLock = path.join(files.runDir, '.agents.lock');
    fs.mkdirSync(registryLock);

    const started = Date.now();
    const resolved = resolveRunAgentContext(dir, state, {
      session_id: CODEX_V2_PARENT_THREAD,
      transcript_path: transcript,
      model: CODEX_V2_MODEL,
    }, { claimPending: true });
    const elapsed = Date.now() - started;
    assert.equal(resolved, null);
    assert.ok(elapsed >= 1_800 && elapsed < 4_000, `expected a bounded ~2s wait, got ${elapsed}ms`);
    assert.deepEqual(fs.readdirSync(path.join(files.runDir, 'claims')).sort(), claimsBefore);
    assert.equal(JSON.parse(fs.readFileSync(files.claimFile, 'utf8')).role, 'senior-frontend');
  });
});

test('a roleless child cannot consume either of two same-parent same-model pending roles', () => {
  withPrefs((dir) => {
    const runId = 'run-codex-roleless-ambiguous';
    const state = { ...materializedState(), currentRunId: runId };
    const childId = '019f69ff-0000-7000-8000-000000000003';
    const rolelessTranscript = writeTranscriptRecords(
      dir,
      `rollout-2026-07-16T11-30-00-${childId}.jsonl`,
      [{
        type: 'session_meta',
        payload: {
          id: childId,
          session_id: CODEX_V2_PARENT_THREAD,
          parent_thread_id: CODEX_V2_PARENT_THREAD,
          thread_source: 'subagent',
          agent_path: null,
          source: { subagent: { thread_spawn: { parent_thread_id: CODEX_V2_PARENT_THREAD, agent_path: null } } },
        },
      }],
    );
    assert.ok(ensureRunAgentClaim(dir, state, 'senior-frontend', { session_id: CODEX_V2_PARENT_THREAD }, {
      toolName: 'spawn_agent', model: CODEX_V2_MODEL,
    }));
    assert.ok(ensureRunAgentClaim(dir, state, 'senior-backend', { session_id: CODEX_V2_PARENT_THREAD }, {
      toolName: 'spawn_agent', model: CODEX_V2_MODEL,
    }));
    const pendingDir = path.join(dir, '.traffic-one', 'runs', runId, 'pending');
    const before = fs.readdirSync(pendingDir).sort();

    const resolved = resolveRunAgentContext(dir, state, {
      session_id: CODEX_V2_PARENT_THREAD,
      parent_session_id: CODEX_V2_PARENT_THREAD,
      thread_source: 'subagent',
      transcript_path: rolelessTranscript,
      model: CODEX_V2_MODEL,
    }, { claimPending: true });
    assert.equal(resolved, null);
    assert.deepEqual(fs.readdirSync(pendingDir).sort(), before, 'ambiguous pending rows are not consumed');
    assert.equal(
      fs.existsSync(path.join(dir, '.traffic-one', 'runs', runId, `${childId}.json`)),
      false,
      'no claimed child row is invented from timestamp ordering',
    );
  });
});

test('a roleless Codex child never consumes even a uniquely correlated pending bucket', () => {
  withPrefs((dir) => {
    const runId = 'run-codex-roleless-unique';
    const state = { ...materializedState(), currentRunId: runId };
    const childId = '019f69ff-0000-7000-8000-000000000004';
    const rolelessTranscript = writeTranscriptRecords(
      dir,
      `rollout-2026-07-16T11-31-00-${childId}.jsonl`,
      [{
        type: 'session_meta',
        payload: {
          id: childId,
          parent_thread_id: CODEX_V2_PARENT_THREAD,
          thread_source: 'subagent',
          source: { subagent: { thread_spawn: { parent_thread_id: CODEX_V2_PARENT_THREAD } } },
        },
      }],
    );
    assert.ok(ensureRunAgentClaim(dir, state, 'senior-frontend', { session_id: CODEX_V2_PARENT_THREAD }, {
      toolName: 'spawn_agent', model: CODEX_V2_MODEL,
    }));
    assert.ok(ensureRunAgentClaim(dir, state, 'senior-backend', { session_id: CODEX_V2_PARENT_THREAD }, {
      toolName: 'spawn_agent', model: 'gpt-5.6-terra',
    }));

    const resolved = resolveRunAgentContext(dir, state, {
      session_id: CODEX_V2_PARENT_THREAD,
      parent_session_id: CODEX_V2_PARENT_THREAD,
      thread_source: 'subagent',
      transcript_path: rolelessTranscript,
      model: CODEX_V2_MODEL,
    }, { claimPending: true });
    assert.equal(resolved, null);
    const pending = fs.readdirSync(path.join(dir, '.traffic-one', 'runs', runId, 'pending'));
    assert.equal(pending.length, 2, 'roleless evidence cannot consume either pending row');
    assert.equal(
      fs.existsSync(path.join(dir, '.traffic-one', 'runs', runId, `${childId}.json`)),
      false,
      'a verified role/model observation is required before creating a reusable claim',
    );
  });
});

test('a roleless child with parent and model evidence never weakens an empty exact intersection', () => {
  withPrefs((dir) => {
    const runId = 'run-codex-roleless-no-weaken';
    const state = { ...materializedState(), currentRunId: runId };
    const childId = '019f69ff-0000-7000-8000-000000000013';
    const otherParent = '019f69fb-334a-7351-8e94-66c97c3fa999';
    const rolelessTranscript = writeTranscriptRecords(
      dir,
      `rollout-2026-07-16T11-32-00-${childId}.jsonl`,
      [{
        type: 'session_meta',
        payload: {
          id: childId,
          parent_thread_id: CODEX_V2_PARENT_THREAD,
          thread_source: 'subagent',
          source: { subagent: { thread_spawn: { parent_thread_id: CODEX_V2_PARENT_THREAD } } },
        },
      }],
    );
    assert.ok(ensureRunAgentClaim(dir, state, 'senior-frontend', { session_id: CODEX_V2_PARENT_THREAD }, {
      toolName: 'spawn_agent', model: 'model-for-parent-only',
    }));
    assert.ok(ensureRunAgentClaim(dir, state, 'senior-backend', { session_id: otherParent }, {
      toolName: 'spawn_agent', model: CODEX_V2_MODEL,
    }));
    const pendingDir = path.join(dir, '.traffic-one', 'runs', runId, 'pending');
    const before = fs.readdirSync(pendingDir).sort();

    const resolved = resolveRunAgentContext(dir, state, {
      session_id: CODEX_V2_PARENT_THREAD,
      transcript_path: rolelessTranscript,
      model: CODEX_V2_MODEL,
    }, { claimPending: true });
    assert.equal(resolved, null);
    assert.deepEqual(fs.readdirSync(pendingDir).sort(), before);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', runId, `${childId}.json`)), false);
  });
});

test('first-write self-heal rejects session_meta whose child or parent identity mismatches the hook', () => {
  withPrefs((dir) => {
    const runId = 'run-codex-meta-identity-mismatch';
    const state = { ...materializedState(), currentRunId: runId };
    const hookChild = '019f69ff-0000-7000-8000-000000000014';
    const metadataChild = '019f69ff-0000-7000-8000-000000000015';
    const transcript = writeTranscriptRecords(
      dir,
      `rollout-2026-07-16T11-33-00-${hookChild}.jsonl`,
      [{
        type: 'session_meta',
        payload: {
          id: metadataChild,
          parent_thread_id: CODEX_V2_PARENT_THREAD,
          thread_source: 'subagent',
          agent_path: '/root/senior_architect',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: CODEX_V2_PARENT_THREAD,
                agent_path: '/root/senior_architect',
              },
            },
          },
        },
      }],
    );
    assert.equal(resolveRunAgentContext(dir, state, {
      session_id: CODEX_V2_PARENT_THREAD,
      transcript_path: transcript,
    }), null);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', runId, `${hookChild}.json`)), false);
  });
});

test('bounded Codex legacy-registry validation verifies a matching line-zero transcript', () => {
  withPrefs((dir) => {
    withIsolatedCodexSessions(dir, (sessionDir) => {
      const boundedTranscript = path.join(
        sessionDir,
        `rollout-2026-07-16T11-15-39-${CODEX_V2_CHILD_THREAD}.jsonl`,
      );
      fs.writeFileSync(boundedTranscript, fs.readFileSync(CODEX_COLLABORATION_V2_ARCHITECT_FIXTURE, 'utf8'), 'utf8');

      const matchRun = 'run-codex-legacy-match';
      const matchState = { ...materializedState(), currentRunId: matchRun };
      freezeCodexPolicyAndObservation(dir, matchState, matchRun, 'senior-architect');
      recordRunAgent(dir, matchRun, 'senior-architect', {
        agentId: CODEX_V2_CHILD_THREAD,
        parentSessionId: null,
        model: CODEX_V2_MODEL,
      });
      const matchEntry = readRunAgentRegistry(dir, matchRun)['senior-architect'];
      assert.ok(matchEntry);
      const match = validateCodexLiveRunAgent(dir, matchState, {}, matchRun, 'senior-architect', matchEntry!);
      assert.equal(match.status, 'verified-match');
      assert.equal(readRunAgentRegistry(dir, matchRun)['senior-architect']?.transcriptPath, boundedTranscript);
      assert.equal(
        readRunAgentRegistry(dir, matchRun)['senior-architect']?.parentSessionId,
        CODEX_V2_PARENT_THREAD,
        'verified metadata backfills a missing legacy parent binding',
      );
    });
  });
});

test('dead-child reuse validation rebinds the poisoned row before continuation and frees the requested role', () => {
  withPrefs((dir) => {
    withIsolatedCodexSessions(dir, (sessionDir) => {
      const boundedTranscript = path.join(
        sessionDir,
        `rollout-2026-07-16T11-15-39-${CODEX_V2_CHILD_THREAD}.jsonl`,
      );
      fs.writeFileSync(boundedTranscript, fs.readFileSync(CODEX_COLLABORATION_V2_ARCHITECT_FIXTURE, 'utf8'), 'utf8');
      const runId = 'run-codex-dead-child-rebind';
      const state = { ...materializedState(), currentRunId: runId };
      const files = writeLegacyCodexClaimAndRegistry(dir, state, runId, 'senior-frontend');
      const ownContext = fallbackTestContext(runId, 'senior-frontend', CODEX_V2_CHILD_THREAD);
      assert.equal(tryFallbackClaim(dir, ownContext, 'packages/contracts/src/dead-child.ts').blocked, false);

      // A crashed hook may leave either lock directory behind. Both locks are
      // bounded and stale-reclaimable before the authoritative transaction.
      const staleAt = new Date(Date.now() - 30_000);
      const agentLock = path.join(files.runDir, '.agents.lock');
      const claimsLock = path.join(files.runDir, '.claims.lock');
      fs.mkdirSync(agentLock);
      fs.mkdirSync(claimsLock);
      fs.utimesSync(agentLock, staleAt, staleAt);
      fs.utimesSync(claimsLock, staleAt, staleAt);

      const poisoned = readRunAgentRegistry(dir, runId)['senior-frontend'];
      assert.ok(poisoned);
      const validation = validateCodexLiveRunAgent(
        dir, state, {}, runId, 'senior-frontend', poisoned!,
      );
      assert.equal(validation.status, 'rebound');
      const registry = readRunAgentRegistry(dir, runId);
      assert.equal(registry['senior-frontend'], undefined, 'the requested frontend slot is free for a fresh spawn');
      assert.equal(registry['senior-architect']?.agentId, CODEX_V2_CHILD_THREAD);
      const correctedClaim = JSON.parse(fs.readFileSync(files.claimFile, 'utf8'));
      assert.equal(correctedClaim.role, 'senior-architect');
      assert.match(correctedClaim.claimId, /^senior-architect-/);
      assert.equal(typeof correctedClaim.spawnIndex, 'number');
      assert.equal(
        fs.readdirSync(path.join(files.runDir, 'claims')).length,
        0,
        'the dead corrected child cannot leave a 30-minute path lock behind',
      );
      assert.equal(fs.existsSync(agentLock), false);
      assert.equal(fs.existsSync(claimsLock), false);
    });
  });
});

test('Codex reuse validation converges claim-first and registry-first interrupted rebind states', () => {
  withPrefs((dir) => {
    withIsolatedCodexSessions(dir, (sessionDir) => {
      const boundedTranscript = path.join(
        sessionDir,
        `rollout-2026-07-16T11-15-39-${CODEX_V2_CHILD_THREAD}.jsonl`,
      );
      fs.writeFileSync(boundedTranscript, fs.readFileSync(CODEX_COLLABORATION_V2_ARCHITECT_FIXTURE, 'utf8'), 'utf8');

      const claimFirstRun = 'run-codex-split-claim-first';
      const claimFirstState = { ...materializedState(), currentRunId: claimFirstRun };
      const claimFirst = writeLegacyCodexClaimAndRegistry(dir, claimFirstState, claimFirstRun, 'senior-frontend');
      const targetClaim = JSON.parse(fs.readFileSync(claimFirst.claimFile, 'utf8'));
      targetClaim.role = 'senior-architect';
      targetClaim.claimId = `senior-architect-1-${CODEX_V2_CHILD_THREAD.slice(-8)}`;
      targetClaim.roleSource = 'codex-session-meta-agent-path';
      targetClaim.correctedAt = new Date().toISOString();
      targetClaim.correctedFromRole = 'senior-frontend';
      fs.writeFileSync(claimFirst.claimFile, JSON.stringify(targetClaim), 'utf8');
      const oldRow = readRunAgentRegistry(dir, claimFirstRun)['senior-frontend'];
      assert.ok(oldRow);
      assert.equal(
        validateCodexLiveRunAgent(dir, claimFirstState, {}, claimFirstRun, 'senior-frontend', oldRow!).status,
        'rebound',
      );
      assert.equal(readRunAgentRegistry(dir, claimFirstRun)['senior-frontend'], undefined);
      assert.equal(readRunAgentRegistry(dir, claimFirstRun)['senior-architect']?.agentId, CODEX_V2_CHILD_THREAD);

      const registryFirstRun = 'run-codex-split-registry-first';
      const registryFirstState = { ...materializedState(), currentRunId: registryFirstRun };
      const registryFirst = writeLegacyCodexClaimAndRegistry(dir, registryFirstState, registryFirstRun, 'senior-frontend');
      const registry = JSON.parse(fs.readFileSync(registryFirst.registryFile, 'utf8'));
      registry.agents['senior-architect'] = registry.agents['senior-frontend'];
      delete registry.agents['senior-frontend'];
      fs.writeFileSync(registryFirst.registryFile, JSON.stringify(registry), 'utf8');
      const targetRow = readRunAgentRegistry(dir, registryFirstRun)['senior-architect'];
      assert.ok(targetRow);
      const validation = validateCodexLiveRunAgent(
        dir, registryFirstState, {}, registryFirstRun, 'senior-architect', targetRow!,
      );
      assert.equal(validation.status, 'verified-match');
      assert.equal(JSON.parse(fs.readFileSync(registryFirst.claimFile, 'utf8')).role, 'senior-architect');
      assert.equal(readRunAgentRegistry(dir, registryFirstRun)['senior-architect']?.agentId, CODEX_V2_CHILD_THREAD);
    });
  });
});

test('dead-child authoritative rebind CAS cannot alter a newer requested-role row', () => {
  withPrefs((dir) => {
    withIsolatedCodexSessions(dir, (sessionDir) => {
      const boundedTranscript = path.join(
        sessionDir,
        `rollout-2026-07-16T11-15-39-${CODEX_V2_CHILD_THREAD}.jsonl`,
      );
      fs.writeFileSync(boundedTranscript, fs.readFileSync(CODEX_COLLABORATION_V2_ARCHITECT_FIXTURE, 'utf8'), 'utf8');
      const runId = 'run-codex-dead-child-cas';
      const state = { ...materializedState(), currentRunId: runId };
      const files = writeLegacyCodexClaimAndRegistry(dir, state, runId, 'senior-frontend');
      const inspected = readRunAgentRegistry(dir, runId)['senior-frontend'];
      assert.ok(inspected);
      const newerThread = '019f69ff-0000-7000-8000-000000000099';
      recordRunAgent(dir, runId, 'senior-frontend', {
        agentId: newerThread,
        parentSessionId: CODEX_V2_PARENT_THREAD,
        model: CODEX_V2_MODEL,
        roleSource: 'spawn-task-name',
      });

      const validation = validateCodexLiveRunAgent(
        dir, state, {}, runId, 'senior-frontend', inspected!,
      );
      assert.equal(validation.status, 'conflict');
      assert.equal(readRunAgentRegistry(dir, runId)['senior-frontend']?.agentId, newerThread);
      assert.equal(readRunAgentRegistry(dir, runId)['senior-architect'], undefined);
      assert.equal(JSON.parse(fs.readFileSync(files.claimFile, 'utf8')).role, 'senior-frontend');
    });
  });
});

test('bounded Codex legacy-registry validation classifies conflicting structured roles as conflict', () => {
  withPrefs((dir) => {
    withIsolatedCodexSessions(dir, (sessionDir) => {
      const conflictRun = 'run-codex-legacy-conflict';
      const conflictId = '019f69fe-e335-7de0-be43-1ee45e3535d5';
      const conflictMeta = JSON.parse(JSON.stringify(codexCollaborationV2FixtureRecords()[0])) as {
        payload: {
          id: string;
          agent_path: string;
          source: { subagent: { thread_spawn: { agent_path: string } } };
        };
      };
      conflictMeta.payload.id = conflictId;
      conflictMeta.payload.agent_path = '/root/senior_frontend';
      conflictMeta.payload.source.subagent.thread_spawn.agent_path = '/root/senior_architect';
      writeTranscriptRecords(
        sessionDir,
        `rollout-2026-07-16T11-15-40-${conflictId}.jsonl`,
        [conflictMeta],
      );
      const conflictState = { ...materializedState(), currentRunId: conflictRun };
      freezeCodexPolicyAndObservation(
        dir,
        conflictState,
        conflictRun,
        'senior-frontend',
        conflictId,
      );
      recordRunAgent(dir, conflictRun, 'senior-frontend', {
        agentId: conflictId,
        parentSessionId: CODEX_V2_PARENT_THREAD,
        model: CODEX_V2_MODEL,
      });
      const conflictEntry = readRunAgentRegistry(dir, conflictRun)['senior-frontend'];
      assert.ok(conflictEntry);
      const conflict = validateCodexLiveRunAgent(dir, conflictState, {}, conflictRun, 'senior-frontend', conflictEntry!);
      assert.equal(conflict.status, 'conflict');
      if (conflict.status === 'conflict') assert.equal(conflict.reason, 'codex-session-meta-role-conflict');
    });
  });
});

test('bounded Codex legacy-registry validation keeps a fresh missing transcript unverified', () => {
  withPrefs((dir) => {
    withIsolatedCodexSessions(dir, () => {
      const unverifiedRun = 'run-codex-legacy-unverified';
      const missingId = '019f69fe-e335-7de0-be43-1ee45e3535e6';
      const unverifiedState = { ...materializedState(), currentRunId: unverifiedRun };
      freezeCodexPolicyAndObservation(
        dir,
        unverifiedState,
        unverifiedRun,
        'senior-backend',
        missingId,
      );
      recordRunAgent(dir, unverifiedRun, 'senior-backend', {
        agentId: missingId,
        parentSessionId: CODEX_V2_PARENT_THREAD,
        model: CODEX_V2_MODEL,
        roleSource: 'spawn-task-name',
      });
      const unverifiedEntry = readRunAgentRegistry(dir, unverifiedRun)['senior-backend'];
      assert.ok(unverifiedEntry);
      const unverified = validateCodexLiveRunAgent(
        dir, unverifiedState, {}, unverifiedRun, 'senior-backend', unverifiedEntry!,
      );
      assert.equal(unverified.status, 'unverified');
      if (unverified.status === 'unverified') {
        assert.equal(unverified.reason, 'codex-session-meta-missing-or-mismatched');
      }
    });
  });
});

test('bounded Codex legacy-registry validation retires a stale missing transcript', () => {
  withPrefs((dir) => {
    withIsolatedCodexSessions(dir, () => {
      const staleRun = 'run-codex-legacy-stale';
      const staleRunDir = path.join(dir, '.traffic-one', 'runs', staleRun);
      const staleId = '019f69fe-e335-7de0-be43-1ee45e3535f7';
      const staleModel = 'gpt-5.6-terra';
      fs.mkdirSync(staleRunDir, { recursive: true });
      freezeCodexPolicyAndObservation(
        dir,
        { ...materializedState(), currentRunId: staleRun },
        staleRun,
        'senior-tester',
        staleId,
        CODEX_V2_PARENT_THREAD,
        staleModel,
      );
      fs.writeFileSync(path.join(staleRunDir, 'agents.json'), JSON.stringify({
        version: 1,
        agents: {
          'senior-tester': legacyRegistryEntry(
            staleId,
            CODEX_V2_PARENT_THREAD,
            staleModel,
            new Date(Date.now() - 31 * 60 * 1000).toISOString(),
          ),
        },
        history: [],
      }), 'utf8');
      const staleEntry = readRunAgentRegistry(dir, staleRun)['senior-tester'];
      assert.ok(staleEntry);
      const stale = validateCodexLiveRunAgent(
        dir,
        { ...materializedState(), currentRunId: staleRun },
        {},
        staleRun,
        'senior-tester',
        staleEntry!,
      );
      assert.equal(stale.status, 'stale-retired');
      assert.equal(readRunAgentRegistry(dir, staleRun)['senior-tester']?.replaced, true);
    });
  });
});

test('inferRoleFromTranscript reads the assigned role despite cross-referenced roles', () => {
  withPrefs((dir) => {
    const fe = writeChildTranscript(dir, FRONTEND_THREAD,
      'You are Traffic One `senior-frontend` for run `R` in /x. You are not alone; avoid backend-owned paths. senior-backend owns the API.');
    assert.equal(inferRoleFromTranscript(fe), 'senior-frontend');

    const be = writeChildTranscript(dir, '019e7402-3e75-7ef0-bc01-115940d1a574',
      'You are Traffic One `senior-backend` for run `R`. Coordinate with senior-frontend on contracts.');
    assert.equal(inferRoleFromTranscript(be), 'senior-backend');

    // No assignment (orchestrator transcript) → null.
    const main = writeChildTranscript(dir, '019e7389-0000-7000-8000-000000000000', 'Build the portfolio app. Spawn the team.');
    assert.equal(inferRoleFromTranscript(main), null);
    assert.equal(inferRoleFromTranscript('/no/such/file.jsonl'), null);
  });
});

test('resolveRunAgentContext self-heals: a subagent write with no claim infers role from its transcript and stakes it', () => {
  withPrefs((dir) => {
    const state = materializedState();
    const transcript = writeChildTranscript(dir, FRONTEND_THREAD,
      'You are Traffic One `senior-frontend` for run `R`. Avoid backend-owned paths; senior-backend owns the API.');

    // Child write: Codex reports the PARENT session_id, threadId from transcript differs → self-heal.
    const ctx = resolveRunAgentContext(dir, state, {
      session_id: 'orchestrator-parent',
      transcript_path: transcript,
    }, { claimPending: true });
    assert.ok(ctx, 'expected the subagent write to self-heal a role claim');
    assert.equal(ctx!.role, 'senior-frontend');
    assert.equal(ctx!.sessionId, FRONTEND_THREAD);

    // The claim is now persisted → a second resolution hits the fast exact-match path.
    const again = resolveRunAgentContext(dir, state, { session_id: 'orchestrator-parent', transcript_path: transcript }, { claimPending: false });
    assert.equal(again?.role, 'senior-frontend');

    // The orchestrator itself (threadId === sessionId, no claim) never self-heals a role.
    const orch = '019e7389-8edd-7e50-b566-2e9a0d52b9d9';
    const orchTranscript = writeChildTranscript(dir, orch, 'Build the portfolio app and spawn the team.');
    const main = resolveRunAgentContext(dir, state, { session_id: orch, transcript_path: orchTranscript }, { claimPending: true });
    assert.equal(main, null);
  });
});

// The dominant real-world spawn phrasing (observed live on Codex) has no "You are":
// "Traffic One senior-frontend fix-cycle role for project … Run id: …". Without
// matching it, every worker failed transcript inference and fell to FIFO pending
// matching, which misclaims roles under parallel spawns.
test('inferRoleFromTranscript reads the "Traffic One senior-X …" prompt shape', () => {
  withPrefs((dir) => {
    const fix = writeChildTranscript(dir, FRONTEND_THREAD,
      'Traffic One senior-frontend fix-cycle role for project /x. Run id: 1781253608942.\n\nRead the reviewer digest first. senior-backend owns the API surfaces.');
    assert.equal(inferRoleFromTranscript(fix), 'senior-frontend');

    const retry = writeChildTranscript(dir, '019e7402-3e75-7ef0-bc01-115940d1a574',
      'Traffic One senior-tester paid fallback for /x. Run id: 1781253608942. Add tests only.');
    assert.equal(inferRoleFromTranscript(retry), 'senior-tester');
  });
});

test('pending-claim matching is role-aware and keys the claim by thread id', () => {
  withPrefs((dir) => {
    const state = materializedState();
    const runId = (state as Record<string, unknown>).currentRunId as string;
    // Parent staked two pending claims (fix-cycle frontend + backend).
    ensureRunAgentClaim(dir, state, 'senior-backend', { session_id: 'orchestrator-parent' }, { toolName: 'spawn_agent' });
    ensureRunAgentClaim(dir, state, 'senior-frontend', { session_id: 'orchestrator-parent' }, { toolName: 'spawn_agent' });

    // The frontend thread's transcript names ONLY its own assignment — it must
    // claim the senior-frontend pending file even though backend's is older
    // (FIFO order), and the claimed file must be keyed by the THREAD id, not the
    // parent session id Codex repeats for every worker.
    const transcript = writeChildTranscript(dir, FRONTEND_THREAD,
      'Traffic One senior-frontend fix-cycle role for project /x. Run id: ' + runId + '.');
    const ctx = resolveRunAgentContext(dir, state, {
      session_id: 'orchestrator-parent',
      transcript_path: transcript,
    }, { claimPending: true });
    assert.ok(ctx);
    assert.equal(ctx!.role, 'senior-frontend');
    assert.equal(ctx!.sessionId, FRONTEND_THREAD);
  });
});

test('inferRoleFromTranscript honors the [t1-role:] marker contract', () => {
  withPrefs((dir) => {
    const file = writeChildTranscript(dir, FRONTEND_THREAD,
      '[t1-role: senior-reviewer]\nRead-only review for run R. senior-frontend and senior-backend own the implementation.');
    assert.equal(inferRoleFromTranscript(file), 'senior-reviewer');
  });
});

test('inferRoleFromTranscript parses the CURSOR {role, message} transcript shape', () => {
  withPrefs((dir) => {
    // Cursor's subagent transcript is {role, message} per line — NOT the Codex
    // payload/content shape. This is the run-team-not-subagent block: parsing only
    // the Codex shape returned null for every Cursor subagent. (tests/4b live bug.)
    const f1 = path.join(dir, 'rollout-cursor-be.jsonl');
    fs.writeFileSync(f1, [
      JSON.stringify({ role: 'user', message: '[t1-role: senior-backend]\nRun R. Implement the API layer.', type: 'message', status: 'ok' }),
      JSON.stringify({ role: 'assistant', message: 'Working on it.' }),
    ].join('\n') + '\n', 'utf8');
    assert.equal(inferRoleFromTranscript(f1), 'senior-backend');

    // Cursor message-as-object shape ({content:string}) also resolves.
    const f2 = path.join(dir, 'rollout-cursor-fe.jsonl');
    fs.writeFileSync(f2, JSON.stringify({
      role: 'user', message: { content: 'You are Traffic One `senior-frontend` for run R. senior-backend owns the API.' },
    }) + '\n', 'utf8');
    assert.equal(inferRoleFromTranscript(f2), 'senior-frontend');

    // Unknown line shapes are not authenticated user input. A raw marker scan here
    // lets tool output or transcript drift impersonate a role.
    const f3 = path.join(dir, 'rollout-cursor-odd.jsonl');
    fs.writeFileSync(f3, JSON.stringify({ kind: 'thread_item', data: { text: 'spawn [t1-role: senior-tester] user' } }) + '\n', 'utf8');
    assert.equal(inferRoleFromTranscript(f3), null);
  });
});

function cursorProjectKey(projectRoot: string): string {
  return path.resolve(projectRoot).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').replace(/[/:\s]+/g, '-');
}

function writeCursorSubagentTranscript(cursorProjectsRoot: string, projectRoot: string, parentId: string, childId: string, body: string): string {
  const file = path.join(cursorProjectsRoot, cursorProjectKey(projectRoot), 'agent-transcripts', parentId, 'subagents', `${childId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    role: 'user',
    message: { content: [{ type: 'text', text: body }] },
  }) + '\n', 'utf8');
  return file;
}

test('Cursor transcript listing returns only child JSONL files and prefers birthtime over mtime', () => {
  withPrefs((dir) => {
    const previous = process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
    const cursorRoot = path.join(dir, 'cursor-projects');
    process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = cursorRoot;
    try {
      const parentId = '9c5e9932-478d-4f21-b31e-c7f64f46156b';
      const firstId = '62c7127d-eb00-4294-b552-3c5f24207fcf';
      const secondId = '4a2ece8c-ea15-458b-92b4-45d33849804f';
      const first = writeCursorSubagentTranscript(cursorRoot, dir, parentId, firstId, '[t1-role: senior-architect]');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      const second = writeCursorSubagentTranscript(cursorRoot, dir, parentId, secondId, '[t1-role: senior-backend]');

      // Deliberately make mtime point in the opposite direction from creation.
      // Cursor appends to long-running transcripts, so this is the incident shape
      // where mtime is not a reliable start-time correlation anchor.
      const now = Date.now();
      fs.utimesSync(first, new Date(now), new Date(now + 120_000));
      fs.utimesSync(second, new Date(now), new Date(now - 120_000));
      const parentTranscript = path.join(cursorRoot, cursorProjectKey(dir), 'agent-transcripts', parentId, `${parentId}.jsonl`);
      fs.writeFileSync(parentTranscript, `${JSON.stringify({ type: 'turn_ended', status: 'error', error: 'User aborted request' })}\n`, 'utf8');

      const candidates = listCursorSubagentTranscriptCandidates(dir, { workspace_roots: [dir] }, parentId);
      assert.equal(candidates.length, 2);
      assert.deepEqual(new Set(candidates.map((item) => item.childTranscriptId)), new Set([firstId, secondId]));
      assert.ok(candidates.every((item) => item.filePath.includes(`${path.sep}subagents${path.sep}`)));
      assert.ok(candidates.every((item) => Number.isFinite(item.birthtimeMs) && Number.isFinite(item.mtimeMs)));
      assert.ok(!candidates.some((item) => item.filePath === parentTranscript), 'the parent transcript is never scanned');
      assert.equal(cursorTranscriptCandidateTimeMs({
        filePath: '/x', parentSessionId: parentId, childTranscriptId: firstId, birthtimeMs: 100, mtimeMs: 900,
      }), 100, 'birthtime wins even when mtime is newer');
      assert.equal(cursorTranscriptCandidateTimeMs({
        filePath: '/x', parentSessionId: parentId, childTranscriptId: firstId, birthtimeMs: 0, mtimeMs: 900,
      }), 900, 'mtime remains the fallback when birthtime is unavailable');

      const preferredTimes = candidates.map(cursorTranscriptCandidateTimeMs);
      assert.ok(preferredTimes[0]! >= preferredTimes[1]!, 'the exported list is ordered by the preferred timestamp');
      const otherParent = listCursorSubagentTranscriptCandidates(dir, { workspace_roots: [dir] }, 'different-parent');
      assert.deepEqual(otherParent, []);
    } finally {
      if (previous === undefined) delete process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
      else process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = previous;
    }
  });
});

function recordFinalizedCursorFailure(
  cwd: string,
  runId: string,
  input: {
    parentSessionId: string;
    role: string;
    toolCallId: string;
    childTranscriptId: string;
    startedAtMs: number;
    directive: string;
    prescribedModel?: string | null;
  },
): void {
  assert.ok(recordCursorSpawnObservation(cwd, runId, {
    parentSessionId: input.parentSessionId,
    toolCallId: input.toolCallId,
    role: input.role,
    requestedModel: 'gpt-5.6-terra-medium',
    tier: 'balanced',
    expectedModel: 'gpt-5.6-terra',
    startedAtMs: input.startedAtMs,
  }));
  assert.ok(claimCursorSpawnObservation(
    cwd,
    runId,
    input.toolCallId,
    input.childTranscriptId,
    input.startedAtMs + 1,
  ));
  assert.ok(updateCursorSpawnObservation(cwd, runId, input.childTranscriptId, {
    outcome: 'api-limit',
    error: 'API usage limit reached',
    directive: input.directive,
    prescribedModel: input.prescribedModel === undefined
      ? 'claude-sonnet-5-thinking-high'
      : input.prescribedModel,
  }, input.startedAtMs + 2));
  assert.ok(consumeCursorSpawnObservation(cwd, runId, input.childTranscriptId, input.startedAtMs + 3));
}

function cursorFollowupClaim(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
  latest: CursorSpawnObservation = observation,
  expectedParentFingerprint?: string,
) {
  assert.ok(observation.childTranscriptId);
  assert.ok(observation.directive);
  const fingerprint = expectedParentFingerprint
    || cursorParentObservationSnapshot(cwd, runId, observation.parentSessionId)?.fingerprint;
  assert.ok(fingerprint);
  return {
    parentSessionId: observation.parentSessionId,
    expectedParentFingerprint: fingerprint!,
    role: observation.role,
    childTranscriptId: observation.childTranscriptId!,
    toolCallId: observation.toolCallId,
    expectedLatestToolCallId: latest.toolCallId,
    expectedLatestStartedAtMs: latest.startedAtMs,
    directive: observation.directive!,
    prescribedModel: observation.prescribedModel,
  };
}

test('Cursor spawn observations enforce one-to-one transcript claims and monotonic action markers', () => {
  withPrefs((dir) => {
    const runId = 'run-cursor-observations';
    const first = recordCursorSpawnObservation(dir, runId, {
      parentSessionId: 'parent-1',
      toolCallId: 'tool_architect',
      role: 'senior-architect',
      requestedModel: 'gpt-5.6-terra-medium',
      tier: 'highest',
      expectedModel: 'claude-fable-5',
      startedAtMs: 1_000,
    });
    assert.ok(first);
    assert.equal(first!.childTranscriptId, null);
    assert.equal(first!.outcome, null);
    assert.equal(first!.followupEmitted, false);
    assert.equal(first!.followupSuppressed, false);
    assert.equal(first!.followupSuppressedAtMs, null);
    assert.equal(first!.followupSuppressionReason, null);
    assert.equal(first!.retryHandled, false);

    // Spawn anchors are immutable/idempotent by tool-call id.
    const duplicate = recordCursorSpawnObservation(dir, runId, {
      parentSessionId: 'different-parent',
      toolCallId: 'tool_architect',
      role: 'senior-backend',
      requestedModel: 'composer-2.5-fast',
      tier: 'cheapest',
      expectedModel: 'composer-2.5',
      startedAtMs: 9_000,
    });
    assert.equal(duplicate?.role, 'senior-architect');
    assert.equal(duplicate?.startedAtMs, 1_000);

    recordCursorSpawnObservation(dir, runId, {
      parentSessionId: 'parent-1',
      toolCallId: 'tool_backend',
      role: 'senior-backend',
      requestedModel: 'gpt-5.6-terra-medium',
      tier: 'balanced',
      expectedModel: 'gpt-5.6-terra',
      startedAtMs: 2_000,
    });
    const childId = '62c7127d-eb00-4294-b552-3c5f24207fcf';
    assert.equal(claimCursorSpawnObservation(dir, runId, 'tool_architect', childId, 3_000)?.childTranscriptId, childId);
    assert.equal(claimCursorSpawnObservation(dir, runId, 'tool_architect', childId, 3_100)?.claimedAtMs, 3_000, 'same claim is idempotent');
    assert.equal(claimCursorSpawnObservation(dir, runId, 'tool_backend', childId), null, 'one transcript cannot claim two spawns');
    assert.equal(claimCursorSpawnObservation(dir, runId, 'tool_architect', 'another-child'), null, 'one spawn cannot claim two transcripts');

    const updated = updateCursorSpawnObservation(dir, runId, childId, {
      outcome: 'api-limit',
      error: 'API usage limit reached. Switched to composer-2.5.',
      directive: 'retry same role on the prescribed model',
      prescribedModel: 'gpt-5.6-sol-medium',
    }, 4_000);
    assert.equal(updated?.outcome, 'api-limit');
    assert.equal(updated?.prescribedModel, 'gpt-5.6-sol-medium');
    assert.match(updated?.error || '', /Switched to composer/);
    assert.equal(cursorSpawnObservationForChild(dir, runId, childId)?.directive, 'retry same role on the prescribed model');

    assert.equal(markCursorSpawnObservationFollowupEmitted(dir, runId, childId, 5_000)?.followupEmitted, true);
    assert.equal(markCursorSpawnObservationFollowupEmitted(dir, runId, childId, 5_100), null, 'only one hook owns follow-up emission');
    assert.equal(markCursorSpawnObservationRetryHandled(dir, runId, childId, 6_000)?.retryHandled, true);
    assert.equal(markCursorSpawnObservationRetryHandled(dir, runId, childId, 6_100), null, 'only one hook owns retry settlement');
    assert.equal(consumeCursorSpawnObservation(dir, runId, childId, 7_000)?.consumedAtMs, 7_000);
    assert.equal(consumeCursorSpawnObservation(dir, runId, childId, 8_000)?.consumedAtMs, 7_000, 'consumption is idempotent');
  });
});

test('Cursor followup suppression is monotonic, scoped, and bounded by the abort observation time', () => {
  withPrefs((dir) => {
    const runId = 'run-cursor-suppression';
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId: 'parent-a', role: 'senior-architect', toolCallId: 'tool_a_arch',
      childTranscriptId: 'child-a-arch', startedAtMs: 1_000, directive: 'retry architect',
    });
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId: 'parent-a', role: 'senior-backend', toolCallId: 'tool_a_back',
      childTranscriptId: 'child-a-back', startedAtMs: 2_000, directive: 'retry backend',
    });
    assert.ok(recordCursorSpawnObservation(dir, runId, {
      parentSessionId: 'parent-a', role: 'senior-tester', toolCallId: 'tool_a_unterminated',
      requestedModel: 'gpt-5.6-terra-medium', tier: 'balanced', expectedModel: 'gpt-5.6-terra',
      startedAtMs: 2_800,
    }));
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId: 'parent-a', role: 'senior-reviewer', toolCallId: 'tool_a_future',
      childTranscriptId: 'child-a-future', startedAtMs: 4_000, directive: 'retry future reviewer',
    });
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId: 'parent-b', role: 'senior-backend', toolCallId: 'tool_b_back',
      childTranscriptId: 'child-b-back', startedAtMs: 2_500, directive: 'retry other parent',
    });

    const first = suppressCursorFollowupsBatch(dir, runId, {
      scope: 'parent',
      parentSessionId: 'parent-a',
      observedAtMs: 3_000,
      reason: 'stop-user-abort',
    });
    assert.deepEqual(first.map((item) => item.toolCallId).sort(),
      ['tool_a_arch', 'tool_a_back', 'tool_a_unterminated']);

    let observations = listCursorSpawnObservations(dir, runId);
    for (const toolCallId of ['tool_a_arch', 'tool_a_back', 'tool_a_unterminated']) {
      const observation = observations.find((item) => item.toolCallId === toolCallId)!;
      assert.equal(observation.followupSuppressed, true);
      assert.equal(observation.followupSuppressedAtMs, 3_000);
      assert.equal(observation.followupSuppressionReason, 'stop-user-abort');
      if (observation.childTranscriptId) {
        assert.equal(markCursorSpawnObservationFollowupEmitted(
          dir,
          runId,
          observation.childTranscriptId,
        ), null, 'the legacy single-row CAS cannot reopen a suppressed continuation');
      }
    }
    assert.equal(observations.find((item) => item.toolCallId === 'tool_a_future')?.followupSuppressed, false,
      'a parent abort never suppresses a start created after its observedAt watermark');
    assert.equal(observations.find((item) => item.toolCallId === 'tool_b_back')?.followupSuppressed, false,
      'parent abort suppression never crosses parent sessions');

    const later = suppressCursorFollowupsBatch(dir, runId, {
      scope: 'parent',
      parentSessionId: 'parent-a',
      observedAtMs: 5_000,
      reason: 'parent-transcript-user-abort',
    });
    assert.deepEqual(later.map((item) => item.toolCallId), ['tool_a_future'],
      'a later signal changes only newly-covered rows, never the first reason on old rows');
    observations = listCursorSpawnObservations(dir, runId);
    assert.equal(observations.find((item) => item.toolCallId === 'tool_a_arch')?.followupSuppressionReason, 'stop-user-abort');
    assert.equal(observations.find((item) => item.toolCallId === 'tool_a_future')?.followupSuppressionReason,
      'parent-transcript-user-abort');

    const childOnly = suppressCursorFollowupsBatch(dir, runId, {
      scope: 'child',
      parentSessionId: 'parent-b',
      toolCallId: 'tool_b_back',
      observedAtMs: 6_000,
      reason: 'subagent-stop-user-abort',
    });
    assert.deepEqual(childOnly.map((item) => item.toolCallId), ['tool_b_back']);
    assert.equal(suppressCursorFollowupsBatch(dir, runId, {
      scope: 'child',
      parentSessionId: 'wrong-parent',
      toolCallId: 'tool_b_back',
      observedAtMs: 7_000,
      reason: 'subagent-stop-user-abort',
    }).length, 0, 'child suppression validates the optional parent identity');
    const raw = JSON.parse(fs.readFileSync(
      path.join(dir, '.traffic-one', 'runs', runId, 'cursor-spawns.json'),
      'utf8',
    ));
    assert.equal(raw.version, 1, 'additive suppression state does not bump the observation store version');
  });
});

test('Cursor followup claims are all-or-nothing and validate the stable finalized head fingerprint', () => {
  withPrefs((dir) => {
    const runId = 'run-cursor-followup-batch';
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId: 'parent-batch', role: 'senior-architect', toolCallId: 'tool_arch',
      childTranscriptId: 'child-arch', startedAtMs: 1_000, directive: 'retry architect',
    });
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId: 'parent-batch', role: 'senior-backend', toolCallId: 'tool_back',
      childTranscriptId: 'child-back', startedAtMs: 2_000, directive: 'retry backend',
    });
    const initial = listCursorSpawnObservations(dir, runId);
    const architect = initial.find((item) => item.toolCallId === 'tool_arch')!;
    const backend = initial.find((item) => item.toolCallId === 'tool_back')!;
    const claimed = claimCursorFollowupsBatch(
      dir,
      runId,
      [cursorFollowupClaim(dir, runId, architect), cursorFollowupClaim(dir, runId, backend)],
      8_000,
    );
    assert.deepEqual(claimed.map((item) => item.role).sort(), ['senior-architect', 'senior-backend']);
    assert.ok(claimed.every((item) => item.followupEmitted && item.updatedAtMs === 8_000));
    assert.deepEqual(claimCursorFollowupsBatch(
      dir,
      runId,
      [cursorFollowupClaim(dir, runId, architect), cursorFollowupClaim(dir, runId, backend)],
      9_000,
    ), [], 'a duplicate Stop/subagentStop batch loses every row');
  });

  withPrefs((dir) => {
    const runId = 'run-cursor-followup-stale-batch';
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId: 'parent-stale', role: 'senior-architect', toolCallId: 'tool_arch_old',
      childTranscriptId: 'child-arch-old', startedAtMs: 1_000, directive: 'retry architect',
    });
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId: 'parent-stale', role: 'senior-backend', toolCallId: 'tool_back_old',
      childTranscriptId: 'child-back-old', startedAtMs: 2_000, directive: 'retry backend',
    });
    const selected = listCursorSpawnObservations(dir, runId);
    const architect = selected.find((item) => item.toolCallId === 'tool_arch_old')!;
    const backend = selected.find((item) => item.toolCallId === 'tool_back_old')!;

    assert.ok(recordCursorSpawnObservation(dir, runId, {
      parentSessionId: 'parent-stale',
      toolCallId: 'tool_back_new_start',
      role: 'senior-backend',
      requestedModel: 'claude-sonnet-5-thinking-high',
      tier: 'balanced',
      expectedModel: 'gpt-5.6-terra',
      startedAtMs: 3_000,
    }));
    assert.deepEqual(claimCursorFollowupsBatch(
      dir,
      runId,
      [cursorFollowupClaim(dir, runId, architect), cursorFollowupClaim(dir, runId, backend)],
      8_000,
    ), [], 'a newer start invalidates the complete selection snapshot');
    assert.ok(listCursorSpawnObservations(dir, runId)
      .filter((item) => item.toolCallId === 'tool_arch_old' || item.toolCallId === 'tool_back_old')
      .every((item) => !item.followupEmitted), 'a stale second row cannot partially claim the first row');

    const latestBackend = listCursorSpawnObservations(dir, runId)
      .find((item) => item.toolCallId === 'tool_back_new_start')!;
    assert.equal(claimCursorFollowupsBatch(dir, runId, [
      cursorFollowupClaim(dir, runId, architect),
      cursorFollowupClaim(dir, runId, backend, latestBackend),
    ], 9_000).length, 2, 'an expired/newer blocker may be fingerprinted without becoming the finalized target');
  });

  withPrefs((dir) => {
    const runId = 'run-cursor-followup-finalized-head';
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId: 'parent-head', role: 'senior-architect', toolCallId: 'tool_arch_first',
      childTranscriptId: 'child-arch-first', startedAtMs: 1_000, directive: 'retry first failure',
    });
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId: 'parent-head', role: 'senior-architect', toolCallId: 'tool_arch_latest',
      childTranscriptId: 'child-arch-latest', startedAtMs: 2_000, directive: 'retry latest failure',
    });
    const observations = listCursorSpawnObservations(dir, runId);
    const first = observations.find((item) => item.toolCallId === 'tool_arch_first')!;
    const latest = observations.find((item) => item.toolCallId === 'tool_arch_latest')!;
    assert.deepEqual(claimCursorFollowupsBatch(
      dir,
      runId,
      [cursorFollowupClaim(dir, runId, first, latest)],
      8_000,
    ), [], 'an older finalized failure can never resurface beneath a newer finalized head');
    assert.equal(claimCursorFollowupsBatch(
      dir,
      runId,
      [cursorFollowupClaim(dir, runId, latest)],
      9_000,
    ).length, 1);
  });
});

test('Cursor parent fingerprint rejects new-role and newly-finalized sibling races without partial claims', () => {
  withPrefs((dir) => {
    const runId = 'run-cursor-parent-new-role';
    const parentSessionId = 'parent-new-role';
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId, role: 'senior-architect', toolCallId: 'tool_new_role_arch',
      childTranscriptId: 'child-new-role-arch', startedAtMs: 1_000, directive: 'retry architect',
    });
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId, role: 'senior-backend', toolCallId: 'tool_new_role_back',
      childTranscriptId: 'child-new-role-back', startedAtMs: 2_000, directive: 'retry backend',
    });
    const snapshot = cursorParentObservationSnapshot(dir, runId, parentSessionId)!;
    const requests = snapshot.observations.map((observation) => (
      cursorFollowupClaim(dir, runId, observation, observation, snapshot.fingerprint)
    ));

    assert.ok(recordCursorSpawnObservation(dir, runId, {
      parentSessionId,
      role: 'senior-tester',
      toolCallId: 'tool_new_role_tester',
      requestedModel: 'gpt-5.5-medium',
      tier: 'balanced',
      expectedModel: 'gpt-5.6-terra',
      startedAtMs: 3_000,
    }));
    assert.deepEqual(claimCursorFollowupsBatch(dir, runId, requests, 8_000), []);
    assert.ok(listCursorSpawnObservations(dir, runId)
      .filter((observation) => requests.some((request) => request.toolCallId === observation.toolCallId))
      .every((observation) => !observation.followupEmitted));
  });

  withPrefs((dir) => {
    const runId = 'run-cursor-parent-finalize';
    const parentSessionId = 'parent-finalize';
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId, role: 'senior-architect', toolCallId: 'tool_finalize_arch',
      childTranscriptId: 'child-finalize-arch', startedAtMs: 1_000, directive: 'retry architect',
    });
    assert.ok(recordCursorSpawnObservation(dir, runId, {
      parentSessionId,
      role: 'senior-backend',
      toolCallId: 'tool_finalize_back',
      requestedModel: 'gpt-5.6-terra-medium',
      tier: 'balanced',
      expectedModel: 'gpt-5.6-terra',
      startedAtMs: 2_000,
    }));
    const snapshot = cursorParentObservationSnapshot(dir, runId, parentSessionId)!;
    const architect = snapshot.observations.find((observation) => observation.role === 'senior-architect')!;
    const request = cursorFollowupClaim(dir, runId, architect, architect, snapshot.fingerprint);

    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId, role: 'senior-backend', toolCallId: 'tool_finalize_back',
      childTranscriptId: 'child-finalize-back', startedAtMs: 2_000, directive: 'retry backend',
    });
    assert.deepEqual(claimCursorFollowupsBatch(dir, runId, [request], 8_000), []);
    assert.equal(listCursorSpawnObservations(dir, runId)
      .find((observation) => observation.toolCallId === architect.toolCallId)?.followupEmitted, false);
  });
});

test('Cursor parent fingerprint rejects sibling suppression and retry settlement races', () => {
  withPrefs((dir) => {
    const runId = 'run-cursor-parent-suppression';
    const parentSessionId = 'parent-suppression';
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId, role: 'senior-architect', toolCallId: 'tool_suppress_arch',
      childTranscriptId: 'child-suppress-arch', startedAtMs: 1_000, directive: 'retry architect',
    });
    assert.ok(recordCursorSpawnObservation(dir, runId, {
      parentSessionId,
      role: 'senior-backend',
      toolCallId: 'tool_suppress_back',
      requestedModel: 'gpt-5.6-terra-medium',
      tier: 'balanced',
      expectedModel: 'gpt-5.6-terra',
      startedAtMs: 2_000,
    }));
    const snapshot = cursorParentObservationSnapshot(dir, runId, parentSessionId)!;
    const architect = snapshot.observations.find((observation) => observation.role === 'senior-architect')!;
    const request = cursorFollowupClaim(dir, runId, architect, architect, snapshot.fingerprint);

    assert.equal(suppressCursorFollowupsBatch(dir, runId, {
      scope: 'child',
      parentSessionId,
      toolCallId: 'tool_suppress_back',
      observedAtMs: 3_000,
      reason: 'subagent-stop-user-abort',
    }).length, 1);
    assert.deepEqual(claimCursorFollowupsBatch(dir, runId, [request], 8_000), []);
    assert.equal(listCursorSpawnObservations(dir, runId)
      .find((observation) => observation.toolCallId === architect.toolCallId)?.followupEmitted, false);
  });

  withPrefs((dir) => {
    const runId = 'run-cursor-parent-retry-handled';
    const parentSessionId = 'parent-retry-handled';
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId, role: 'senior-architect', toolCallId: 'tool_handled_arch',
      childTranscriptId: 'child-handled-arch', startedAtMs: 1_000, directive: 'retry architect',
    });
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId, role: 'senior-backend', toolCallId: 'tool_handled_back',
      childTranscriptId: 'child-handled-back', startedAtMs: 2_000, directive: 'retry backend',
    });
    const snapshot = cursorParentObservationSnapshot(dir, runId, parentSessionId)!;
    const architect = snapshot.observations.find((observation) => observation.role === 'senior-architect')!;
    const request = cursorFollowupClaim(dir, runId, architect, architect, snapshot.fingerprint);

    assert.ok(markCursorSpawnObservationRetryHandled(dir, runId, 'child-handled-back', 3_000));
    assert.deepEqual(claimCursorFollowupsBatch(dir, runId, [request], 8_000), []);
    assert.equal(listCursorSpawnObservations(dir, runId)
      .find((observation) => observation.toolCallId === architect.toolCallId)?.followupEmitted, false);
  });
});

test('the single-row followup CAS refuses a retry that already started', () => {
  withPrefs((dir) => {
    const runId = 'run-cursor-followup-handled';
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId: 'parent-handled', role: 'senior-architect', toolCallId: 'tool_handled',
      childTranscriptId: 'child-handled', startedAtMs: 1_000, directive: 'retry architect',
    });
    assert.ok(markCursorSpawnObservationRetryHandled(dir, runId, 'child-handled', 4_000));
    assert.equal(markCursorSpawnObservationFollowupEmitted(dir, runId, 'child-handled', 5_000), null);
    const observation = listCursorSpawnObservations(dir, runId)[0]!;
    assert.equal(observation.retryHandled, true);
    assert.equal(observation.followupEmitted, false);
  });
});

test('Cursor spawn observation storage is bounded and reads pre-versioned state', () => {
  withPrefs((dir) => {
    const legacyRun = 'run-cursor-legacy';
    const legacyFile = path.join(dir, '.traffic-one', 'runs', legacyRun, 'cursor-spawns.json');
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, `${JSON.stringify({
      spawns: [{
        parent_session_id: 'parent-legacy',
        tool_call_id: 'tool_legacy',
        role: 'senior-reviewer',
        model: 'claude-sonnet-5',
        tier: 'balanced',
        expected: 'gpt-5.6-terra',
        startedAt: '2026-07-15T09:00:00.000Z',
        child_transcript_id: 'legacy-child',
        outcome: 'generic',
      }],
    }, null, 2)}\n`, 'utf8');
    const legacy = listCursorSpawnObservations(dir, legacyRun);
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0]?.requestedModel, 'claude-sonnet-5');
    assert.equal(legacy[0]?.expectedModel, 'gpt-5.6-terra');
    assert.equal(legacy[0]?.childTranscriptId, 'legacy-child');
    assert.equal(legacy[0]?.followupEmitted, false);
    assert.equal(legacy[0]?.followupSuppressed, false);
    assert.equal(legacy[0]?.followupSuppressedAtMs, null);
    assert.equal(legacy[0]?.followupSuppressionReason, null);

    const runId = 'run-cursor-bounded';
    for (let index = 0; index < 132; index += 1) {
      const recorded = recordCursorSpawnObservation(dir, runId, {
        parentSessionId: 'parent-bounded',
        toolCallId: `tool_${index}`,
        role: 'senior-tester',
        requestedModel: 'composer-2.5-fast',
        tier: 'cheapest',
        expectedModel: 'composer-2.5',
        startedAtMs: index + 1,
      });
      assert.ok(recorded);
    }
    const bounded = listCursorSpawnObservations(dir, runId);
    assert.equal(bounded.length, 128);
    assert.equal(bounded[0]?.toolCallId, 'tool_4');
    assert.equal(bounded.at(-1)?.toolCallId, 'tool_131');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', runId, 'cursor-spawns.json'), 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.observations.length, 128);
  });
});

test('Cursor spawn observations preserve concurrent subagentStart records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cursor-spawn-concurrent-'));
  const source = [
    "const { recordCursorSpawnObservation } = require('./src/shared/state/run-agent.ts');",
    "const [cwd, role, toolCallId, startedAtMs] = process.argv.slice(1);",
    "recordCursorSpawnObservation(cwd, 'run-concurrent', { parentSessionId: 'parent-1', toolCallId, role, requestedModel: 'gpt-5.6-terra-medium', tier: 'balanced', expectedModel: 'gpt-5.6-terra', startedAtMs: Number(startedAtMs) });",
  ].join('\n');
  try {
    const lockDir = path.join(dir, '.traffic-one', 'runs', 'run-concurrent', '.cursor-spawns.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    let exited = 0;
    const children = ['senior-architect', 'senior-backend'].map((role, index) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--import', 'tsx', '-e', source, dir, role, `tool_${index}`, String(index + 1),
      ], { cwd: process.cwd(), stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code) => {
        exited += 1;
        if (code === 0) resolve();
        else reject(new Error(`Cursor spawn recorder child exited ${code}`));
      });
    }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(exited, 0, 'both hook processes wait for the observation lock');
    fs.rmSync(lockDir, { recursive: true, force: true });
    await Promise.all(children);
    assert.deepEqual(
      listCursorSpawnObservations(dir, 'run-concurrent').map((item) => item.role).sort(),
      ['senior-architect', 'senior-backend'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent Cursor lifecycle processes cannot split one parent followup batch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cursor-followup-concurrent-'));
  const runId = 'run-followup-concurrent';
  const source = [
    "const { claimCursorFollowupsBatch } = require('./src/shared/state/run-agent.ts');",
    'const [cwd, runId, encoded] = process.argv.slice(1);',
    "const requests = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));",
    'const claimed = claimCursorFollowupsBatch(cwd, runId, requests, 10000);',
    'process.stdout.write(JSON.stringify(claimed.map((item) => item.role).sort()));',
  ].join('\n');
  try {
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId: 'parent-concurrent', role: 'senior-architect', toolCallId: 'tool_concurrent_arch',
      childTranscriptId: 'child-concurrent-arch', startedAtMs: 1_000, directive: 'retry architect',
    });
    recordFinalizedCursorFailure(dir, runId, {
      parentSessionId: 'parent-concurrent', role: 'senior-backend', toolCallId: 'tool_concurrent-back',
      childTranscriptId: 'child-concurrent-back', startedAtMs: 2_000, directive: 'retry backend',
    });
    const observations = listCursorSpawnObservations(dir, runId);
    const requests = observations.map((observation) => cursorFollowupClaim(dir, runId, observation));
    const encoded = Buffer.from(JSON.stringify(requests), 'utf8').toString('base64url');
    const lockDir = path.join(dir, '.traffic-one', 'runs', runId, '.cursor-spawns.lock');
    fs.mkdirSync(lockDir, { recursive: true });

    let exited = 0;
    const children = [0, 1].map(() => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--import', 'tsx', '-e', source, dir, runId, encoded,
      ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => {
        exited += 1;
        if (code === 0) resolve(stdout);
        else reject(new Error(`Cursor followup claimant child exited ${code}`));
      });
    }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(exited, 0, 'both lifecycle hooks wait on the shared observation lock');
    fs.rmSync(lockDir, { recursive: true, force: true });

    const outputs = (await Promise.all(children)).map((output) => JSON.parse(output) as string[]);
    assert.deepEqual(outputs.map((roles) => roles.length).sort((a, b) => a - b), [0, 2]);
    assert.deepEqual(outputs.find((roles) => roles.length === 2), ['senior-architect', 'senior-backend']);
    assert.ok(listCursorSpawnObservations(dir, runId).every((observation) => observation.followupEmitted));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Cursor spawn observation mutators and transcript scanner stand down in the plugin authoring root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cursor-authoring-'));
  const previous = process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
  try {
    fs.mkdirSync(path.join(dir, 'src', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'gen', 'index.ts'), 'export {};\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
    resetAuthoringRootCache();
    process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = path.join(dir, 'cursor-projects');

    assert.equal(recordCursorSpawnObservation(dir, 'run-authoring', {
      parentSessionId: 'parent', toolCallId: 'tool_1', role: 'senior-frontend',
      requestedModel: 'composer-2.5-fast', tier: 'cheapest', expectedModel: 'composer-2.5', startedAtMs: 1,
    }), null);
    assert.deepEqual(listCursorSpawnObservations(dir, 'run-authoring'), []);
    assert.equal(claimCursorSpawnObservation(dir, 'run-authoring', 'tool_1', 'child-1'), null);
    assert.equal(updateCursorSpawnObservation(dir, 'run-authoring', 'child-1', { outcome: 'generic' }), null);
    assert.equal(consumeCursorSpawnObservation(dir, 'run-authoring', 'child-1'), null);
    assert.deepEqual(claimCursorFollowupsBatch(dir, 'run-authoring', [{
      parentSessionId: 'parent', role: 'senior-frontend', childTranscriptId: 'child-1',
      toolCallId: 'tool_1', expectedLatestToolCallId: 'tool_1', expectedLatestStartedAtMs: 1,
      expectedParentFingerprint: '0'.repeat(64),
      directive: 'retry', prescribedModel: 'composer-2.5-fast',
    }]), []);
    assert.deepEqual(suppressCursorFollowupsBatch(dir, 'run-authoring', {
      scope: 'parent', parentSessionId: 'parent', observedAtMs: 2, reason: 'stop-user-abort',
    }), []);
    assert.deepEqual(listCursorSubagentTranscriptCandidates(dir, { workspace_roots: [dir] }, 'parent'), []);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one')), false);
  } finally {
    if (previous === undefined) delete process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
    else process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = previous;
    resetAuthoringRootCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRunAgentContext binds Cursor child writes from the local subagent transcript cache', () => {
  withPrefs((dir) => {
    const prevCursorProjects = process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
    const prevCursorPluginRoot = process.env.CURSOR_PLUGIN_ROOT;
    const cursorRoot = path.join(dir, 'cursor-projects');
    process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = cursorRoot;
    process.env.CURSOR_PLUGIN_ROOT = path.join(dir, 'cursor-plugin');
    try {
      const parentId = '8a93bb38-0503-4c9a-ab15-fec68978ad1b';
      const childId = '8602964e-64f8-4b29-94d6-6836622a27b0';
      const state = { ...materializedState(), currentRunId: 'run-cursor-child' };
      ensureRunAgentClaim(dir, state, 'senior-frontend', { session_id: parentId }, { toolName: 'Task' });
      recordRunAgent(dir, 'run-cursor-child', 'senior-frontend', {
        agentId: 'tool_b1b73265-1c92-4340-a170-d148f8f0dde',
        toolCallId: 'tool_b1b73265-1c92-4340-a170-d148f8f0dde',
        parentSessionId: parentId,
      });
      writeCursorSubagentTranscript(cursorRoot, dir, parentId, childId,
        'You are senior-frontend for DevLearn. Read .traffic-one/runs/run-cursor-child/assignments.json and write only your scope.');

      const ctx = resolveRunAgentContext(dir, state, {
        conversation_id: childId,
        session_id: childId,
        workspace_roots: [dir],
        transcript_path: null,
        hook_event_name: 'preToolUse',
        tool_name: 'Write',
      }, { claimPending: true });

      assert.ok(ctx, 'Cursor child write should resolve instead of being treated as main agent');
      assert.equal(ctx!.role, 'senior-frontend');
      assert.equal(ctx!.sessionId, childId);
      assert.equal(ctx!.spawnIndex, 1, 'the child consumes the existing pending spawn claim');
      const pending = path.join(dir, '.traffic-one', 'runs', 'run-cursor-child', 'pending');
      assert.deepEqual(fs.readdirSync(pending).filter((name) => name.endsWith('.json')), []);

      const entry = readRunAgentRegistry(dir, 'run-cursor-child')['senior-frontend'];
      assert.ok(entry, 'child bind should mirror the resumable Cursor conversation id into agents.json');
      assert.equal(entry!.agentId, childId);
      assert.equal(entry!.resumeId, childId);
      assert.equal(entry!.toolCallId, 'tool_b1b73265-1c92-4340-a170-d148f8f0dde');
      assert.equal(continuationAgentId(entry!, 'cursor'), childId);

      const again = resolveRunAgentContext(dir, state, { session_id: childId }, { claimPending: false });
      assert.equal(again?.role, 'senior-frontend');
    } finally {
      if (prevCursorProjects === undefined) delete process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
      else process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = prevCursorProjects;
      if (prevCursorPluginRoot === undefined) delete process.env.CURSOR_PLUGIN_ROOT;
      else process.env.CURSOR_PLUGIN_ROOT = prevCursorPluginRoot;
    }
  });
});

test('Cursor child bind prefers the matching exact-model pending claim and clears stale siblings', () => {
  withPrefs((dir) => {
    const prevCursorProjects = process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
    const prevCursorPluginRoot = process.env.CURSOR_PLUGIN_ROOT;
    const cursorRoot = path.join(dir, 'cursor-projects');
    process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = cursorRoot;
    process.env.CURSOR_PLUGIN_ROOT = path.join(dir, 'cursor-plugin');
    try {
      const parentId = 'ab2a10f9-9117-4e8d-83c2-b15bebe7b08d';
      const childId = '91535f31-5c62-4e8b-acce-5ccff7439d22';
      const state = { ...materializedState(), currentRunId: 'run-cursor-model' };
      const stale = ensureRunAgentClaim(dir, state, 'senior-architect', { session_id: parentId }, {
        toolName: 'Task',
        model: 'claude-opus-4-8',
      });
      const exact = ensureRunAgentClaim(dir, state, 'senior-architect', { session_id: parentId }, {
        toolName: 'Task',
        model: 'claude-opus-4-8-thinking-medium',
      });
      recordRunAgent(dir, 'run-cursor-model', 'senior-architect', {
        agentId: 'tool_f02c546e-efaa-43d0-a6b5-065439bc41a',
        toolCallId: 'tool_f02c546e-efaa-43d0-a6b5-065439bc41a',
        parentSessionId: parentId,
      });
      writeCursorSubagentTranscript(cursorRoot, dir, parentId, childId,
        '[t1-role: senior-architect]\nArchitect learning platform plan.');

      const ctx = resolveRunAgentContext(dir, state, {
        conversation_id: childId,
        session_id: childId,
        workspace_roots: [dir],
        model: 'claude-opus-4-8-thinking-medium',
        transcript_path: null,
        hook_event_name: 'preToolUse',
        tool_name: 'Write',
      }, { claimPending: true });

      assert.ok(ctx);
      assert.equal(ctx!.role, 'senior-architect');
      assert.equal(ctx!.spawnIndex, 2, 'the successful exact-model retry claim wins over the older family claim');
      assert.notEqual(stale?.claimId, exact?.claimId);
      assert.equal(ctx!.claimId, exact?.claimId);

      const claimed = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', 'run-cursor-model', `${childId}.json`), 'utf8'));
      assert.equal(claimed.model, 'claude-opus-4-8-thinking-medium');
      assert.equal(claimed.claimId, exact?.claimId);

      const pending = path.join(dir, '.traffic-one', 'runs', 'run-cursor-model', 'pending');
      assert.deepEqual(fs.readdirSync(pending).filter((name) => name.endsWith('.json')), []);

      const entry = readRunAgentRegistry(dir, 'run-cursor-model')['senior-architect'];
      assert.equal(entry?.agentId, childId);
      assert.equal(entry?.resumeId, childId);
      assert.equal(entry?.toolCallId, 'tool_f02c546e-efaa-43d0-a6b5-065439bc41a');
      assert.equal(entry?.model, 'claude-opus-4-8-thinking-medium');
    } finally {
      if (prevCursorProjects === undefined) delete process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
      else process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = prevCursorProjects;
      if (prevCursorPluginRoot === undefined) delete process.env.CURSOR_PLUGIN_ROOT;
      else process.env.CURSOR_PLUGIN_ROOT = prevCursorPluginRoot;
    }
  });
});

test('refreshCursorRunAgentFromTranscriptCache upgrades read-only Cursor agents before they write', () => {
  withPrefs((dir) => {
    const prevCursorProjects = process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
    const prevCursorPluginRoot = process.env.CURSOR_PLUGIN_ROOT;
    const cursorRoot = path.join(dir, 'cursor-projects');
    process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = cursorRoot;
    process.env.CURSOR_PLUGIN_ROOT = path.join(dir, 'cursor-plugin');
    try {
      const parentId = '8a93bb38-0503-4c9a-ab15-fec68978ad1b';
      const childId = 'e391ca30-0b3d-4bba-896d-431c4b49f405';
      const state = { ...materializedState(), currentRunId: 'run-cursor-reviewer' };
      ensureRunAgentClaim(dir, state, 'senior-reviewer', { session_id: parentId }, { toolName: 'Task' });
      recordRunAgent(dir, 'run-cursor-reviewer', 'senior-reviewer', {
        agentId: 'tool_2401d263-9b87-44db-8e0d-2df7dd7842dd',
        toolCallId: 'tool_2401d263-9b87-44db-8e0d-2df7dd7842dd',
        parentSessionId: parentId,
      });
      writeCursorSubagentTranscript(cursorRoot, dir, parentId, childId,
        '[t1-role: senior-reviewer]\nReview the implementation and write only a digest.');

      const upgraded = refreshCursorRunAgentFromTranscriptCache(dir, state, {
        session_id: parentId,
        workspace_roots: [dir],
      }, 'run-cursor-reviewer', 'senior-reviewer', parentId);

      assert.ok(upgraded, 'expected the real Cursor child id to be discovered');
      assert.equal(upgraded!.agentId, childId);
      assert.equal(upgraded!.resumeId, childId);
      assert.equal(upgraded!.toolCallId, 'tool_2401d263-9b87-44db-8e0d-2df7dd7842dd');
      assert.equal(continuationAgentId(upgraded!, 'cursor'), childId);
      const pending = path.join(dir, '.traffic-one', 'runs', 'run-cursor-reviewer', 'pending');
      assert.deepEqual(fs.readdirSync(pending).filter((name) => name.endsWith('.json')), []);
    } finally {
      if (prevCursorProjects === undefined) delete process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
      else process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = prevCursorProjects;
      if (prevCursorPluginRoot === undefined) delete process.env.CURSOR_PLUGIN_ROOT;
      else process.env.CURSOR_PLUGIN_ROOT = prevCursorPluginRoot;
    }
  });
});

test('refreshCursorRunAgentFromTranscriptCache never binds an old role transcript to a newer tool start', () => {
  withPrefs((dir) => {
    const prevCursorProjects = process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
    const prevCursorPluginRoot = process.env.CURSOR_PLUGIN_ROOT;
    const cursorRoot = path.join(dir, 'cursor-projects');
    process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = cursorRoot;
    process.env.CURSOR_PLUGIN_ROOT = path.join(dir, 'cursor-plugin');
    try {
      const runId = 'run-cursor-stale-transcript';
      const parentId = '4b872ad4-f47c-4ae7-8061-2fc720265e93';
      const oldToolId = 'tool_5a61f21d-aeed-40a7-bf5e-8b5a527a196f';
      const oldChildId = 'd76eae91-6e60-4c38-8315-6483360d0fe7';
      const legacyChildId = '56936be6-c586-4aef-8f47-a6b38ce165a1';
      const newToolId = 'tool_c5fa21a6-bc99-4554-97bf-158a52e3fa11';
      const state = { ...materializedState(), currentRunId: runId };

      recordFinalizedCursorFailure(dir, runId, {
        parentSessionId: parentId,
        role: 'senior-reviewer',
        toolCallId: oldToolId,
        childTranscriptId: oldChildId,
        startedAtMs: 1_000,
        directive: 'generic recovery for old reviewer',
      });
      writeCursorSubagentTranscript(cursorRoot, dir, parentId, oldChildId,
        '[t1-role: senior-reviewer]\nOld consumed reviewer transcript.');
      writeCursorSubagentTranscript(cursorRoot, dir, parentId, legacyChildId,
        '[t1-role: senior-reviewer]\nOld unclaimed legacy reviewer transcript.');

      const newStartedAtMs = Date.now() + 10_000;
      assert.ok(recordCursorSpawnObservation(dir, runId, {
        parentSessionId: parentId,
        role: 'senior-reviewer',
        toolCallId: newToolId,
        requestedModel: 'gpt-5.6-terra-medium',
        tier: 'balanced',
        expectedModel: 'gpt-5.6-terra',
        startedAtMs: newStartedAtMs,
      }));
      recordRunAgent(dir, runId, 'senior-reviewer', {
        agentId: newToolId,
        toolCallId: newToolId,
        parentSessionId: parentId,
      });

      assert.equal(refreshCursorRunAgentFromTranscriptCache(dir, state, {
        session_id: parentId,
        workspace_roots: [dir],
      }, runId, 'senior-reviewer', parentId), null);
      const current = readRunAgentRegistry(dir, runId)['senior-reviewer'];
      assert.equal(current?.agentId, newToolId);
      assert.equal(current?.toolCallId, newToolId);
      assert.equal(current?.resumeId, null);
      assert.equal(continuationAgentId(current!, 'cursor'), '');
    } finally {
      if (prevCursorProjects === undefined) delete process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
      else process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = prevCursorProjects;
      if (prevCursorPluginRoot === undefined) delete process.env.CURSOR_PLUGIN_ROOT;
      else process.env.CURSOR_PLUGIN_ROOT = prevCursorPluginRoot;
    }
  });
});

test('recordRunAgent: Cursor tool_* id is stored separately from Task resume UUID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-resume-id-'));
  try {
    recordRunAgent(dir, 'run-1', 'senior-frontend', {
      agentId: 'tool_b1b73265-1c92-4340-a170-d148f8f0dde',
      toolCallId: 'tool_b1b73265-1c92-4340-a170-d148f8f0dde',
      model: 'composer-2.5-fast',
      agentType: 'senior-frontend',
      parentSessionId: 'parent-1',
    });
    let entry = readRunAgentRegistry(dir, 'run-1')['senior-frontend'];
    assert.ok(entry);
    assert.equal(entry!.toolCallId, 'tool_b1b73265-1c92-4340-a170-d148f8f0dde');
    assert.equal(entry!.resumeId, null);
    assert.equal(continuationAgentId(entry!, 'cursor'), '');

    recordRunAgent(dir, 'run-1', 'senior-frontend', {
      agentId: 'bff46cd7-3681-4cf0-adcf-263bf55cc301',
      resumeId: 'bff46cd7-3681-4cf0-adcf-263bf55cc301',
      parentSessionId: 'parent-1',
    });
    entry = readRunAgentRegistry(dir, 'run-1')['senior-frontend'];
    assert.equal(entry!.resumeId, 'bff46cd7-3681-4cf0-adcf-263bf55cc301');
    assert.equal(entry!.agentId, 'bff46cd7-3681-4cf0-adcf-263bf55cc301');
    assert.equal(entry!.toolCallId, 'tool_b1b73265-1c92-4340-a170-d148f8f0dde');
    assert.equal(entry!.model, 'composer-2.5-fast');
    assert.equal(entry!.agentType, 'senior-frontend');
    assert.equal(entry!.parentSessionId, 'parent-1');
    assert.equal(entry!.tasks, 2);
    assert.equal(continuationAgentId(entry!, 'cursor'), 'bff46cd7-3681-4cf0-adcf-263bf55cc301');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recordRunAgent preserves replacement history while keeping the live role slot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-agent-history-'));
  try {
    recordRunAgent(dir, 'run-1', 'senior-frontend', {
      agentId: 'agent-old',
      parentSessionId: 'parent-1',
      model: 'old-model',
    });
    markRunAgentReplaced(dir, 'run-1', 'senior-frontend');
    recordRunAgent(dir, 'run-1', 'senior-frontend', {
      agentId: 'agent-new',
      parentSessionId: 'parent-1',
      model: 'new-model',
    });

    const live = readRunAgentRegistry(dir, 'run-1')['senior-frontend'];
    assert.equal(live?.agentId, 'agent-new');
    assert.equal(live?.replaced, false);
    assert.equal(live?.tasks, 1);

    const raw = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', 'run-1', 'agents.json'), 'utf8'));
    assert.equal(raw.history.length, 1);
    assert.equal(raw.history[0].role, 'senior-frontend');
    assert.equal(raw.history[0].oldAgentId, 'agent-old');
    assert.equal(raw.history[0].newAgentId, 'agent-new');
    assert.equal(raw.history[0].replacementReason, 'explicit-replace-agent-marker');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recordRunAgent preserves every role across concurrent hook processes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-agent-concurrent-'));
  const roles = ['senior-frontend', 'senior-backend'];
  const source = [
    "const { recordRunAgent } = require('./src/shared/state/run-agent.ts');",
    "const [cwd, role, agentId] = process.argv.slice(1);",
    "recordRunAgent(cwd, 'run-concurrent', role, { agentId, parentSessionId: 'parent-1' });",
  ].join('\n');
  try {
    const lockDir = path.join(dir, '.traffic-one', 'runs', 'run-concurrent', '.agents.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    let exited = 0;
    const children = roles.map((role, index) => {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '-e', source, dir, role, `agent-${index}`], {
          cwd: process.cwd(),
          stdio: 'ignore',
        });
        child.once('error', reject);
        child.once('exit', (code) => {
          exited += 1;
          if (code === 0) resolve();
          else reject(new Error(`recorder child exited ${code}`));
        });
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(exited, 0, 'both hook processes must wait for the bounded registry lock');
    fs.rmSync(lockDir, { recursive: true, force: true });
    await Promise.all(children);
    const registry = readRunAgentRegistry(dir, 'run-concurrent');
    assert.deepEqual(Object.keys(registry).sort(), [...roles].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
