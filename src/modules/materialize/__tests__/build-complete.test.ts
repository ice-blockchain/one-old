import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { maybeFlipToMaintenance } from '../build-complete';
import { projectPhase, readState, transitionRunStatus } from '../../../shared/state';

const prefsFile = path.join(os.tmpdir(), `to-bc-prefs-${process.pid}.json`);
let prevPrefs: string | undefined;
before(() => {
  prevPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefsFile;
});
after(() => {
  if (prevPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
});

interface ProjectOpts {
  mode?: string;
  files?: number;
  currentRunId?: string;
  digest?: boolean;
  // Implementer output: a frontend/backend digest with NO reviewer/tester verdict.
  // Proof the orchestrator got past planning and code was written, but verification
  // never recorded a terminal verdict — the prompt-boundary flip accepts this.
  implementer?: boolean;
  verified?: boolean;
  claimFresh?: boolean;
  // Override the verdict tokens written into reviewer.md / tester.md. `verified`
  // is shorthand for a TERMINAL pair (reviewer APPROVED + tester TESTS_GREEN).
  reviewerVerdict?: string;
  testerVerdict?: string;
  shipper?: boolean;
  qa?: boolean;
}

function mkproject(opts: ProjectOpts): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'to-build-complete-'));
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  const state: Record<string, unknown> = {
    mode: opts.mode ?? 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true, confirmed: true,
  };
  if (opts.currentRunId) state.currentRunId = opts.currentRunId;
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state));
  const files = opts.files ?? 0;
  if (files > 0) {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src, { recursive: true });
    for (let i = 0; i < files; i += 1) fs.writeFileSync(path.join(src, `f${i}.ts`), 'export const x = 1;\n');
  }
  // `verified` ⇒ a terminal verdict pair unless a non-terminal verdict is set
  // explicitly. Existence alone is not settlement, so the digest CONTENT matters.
  const reviewerVerdict = opts.reviewerVerdict ?? (opts.verified ? 'APPROVED' : undefined);
  const testerVerdict = opts.testerVerdict ?? (opts.verified ? 'TESTS_GREEN' : undefined);
  if (opts.digest || opts.implementer || reviewerVerdict || testerVerdict || opts.shipper) {
    const dd = path.join(dir, '.traffic-one', 'digests', '123');
    fs.mkdirSync(dd, { recursive: true });
    // architect.md = Phase 1 (early); frontend/backend = Phase 2 (implementation);
    // reviewer/tester = Phase 3 (verification).
    if (opts.digest) fs.writeFileSync(path.join(dd, 'architect.md'), '# plan\nverdict: PLAN_READY\n');
    if (opts.implementer) {
      fs.writeFileSync(path.join(dd, 'frontend.md'), '# frontend\nTouched: src/App.tsx\n');
      fs.writeFileSync(path.join(dd, 'backend.md'), '# backend\nTouched: supabase/migrations\n');
    }
    if (reviewerVerdict) fs.writeFileSync(path.join(dd, 'reviewer.md'), `# reviewer\nverdict: ${reviewerVerdict}\n`);
    if (testerVerdict) fs.writeFileSync(path.join(dd, 'tester.md'), `# tester\nverdict: ${testerVerdict}\n`);
    if (opts.shipper) fs.writeFileSync(path.join(dd, 'shipper.md'), '# shipper\nverdict: SHIPPED\nurl: https://app.example\n');
    const shouldWriteQa = opts.qa ?? Boolean(testerVerdict && /\b(TESTS_GREEN|APPROVED)\b/.test(testerVerdict));
    if (shouldWriteQa) {
      const memoryDir = '.traffic' + '-one';
      const qaDir = path.join(dir, memoryDir, 'reports', 'qa', '123');
      fs.mkdirSync(qaDir, { recursive: true });
      fs.writeFileSync(path.join(qaDir, 'report.json'), JSON.stringify({ ok: true }));
    }
  }
  if (opts.claimFresh) {
    const rd = path.join(dir, '.traffic-one', 'runs', '123');
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'sess.json'), JSON.stringify({ role: 'senior-frontend', runId: '123', createdAt: new Date().toISOString() }));
  }
  return dir;
}

function writeRun(dir: string, runId: string, opts: {
  implementer?: boolean;
  reviewer?: string;
  tester?: string;
  qa?: boolean;
  createdAt?: string;
}): void {
  const dd = path.join(dir, '.traffic-one', 'digests', runId);
  fs.mkdirSync(dd, { recursive: true });
  if (opts.implementer) fs.writeFileSync(path.join(dd, 'frontend.md'), '# frontend\nTouched: src/App.tsx\n');
  if (opts.reviewer) fs.writeFileSync(path.join(dd, 'reviewer.md'), `# reviewer\nverdict: ${opts.reviewer}\n`);
  if (opts.tester) fs.writeFileSync(path.join(dd, 'tester.md'), `# tester\nverdict: ${opts.tester}\n`);
  if (opts.qa) {
    const qaDir = path.join(dir, '.traffic-one', 'reports', 'qa', runId);
    fs.mkdirSync(qaDir, { recursive: true });
    fs.writeFileSync(path.join(qaDir, 'report.json'), JSON.stringify({ ok: true }));
  }
  if (opts.createdAt) {
    const rd = path.join(dir, '.traffic-one', 'runs', runId);
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'run.json'), JSON.stringify({ version: 1, runId, createdAt: opts.createdAt }));
  }
}

function writeStrictBlockedQaReport(
  dir: string,
  runId: string,
  blockerCode: 'browser-unavailable' | 'sandbox' | 'usage-limit' | 'timeout',
): void {
  const qaDir = path.join(dir, '.traffic-one', 'reports', 'qa', runId);
  fs.mkdirSync(qaDir, { recursive: true });
  const status = `blocked:${blockerCode}` as const;
  const viewport = (width: 390 | 768 | 1440) => ({
    width,
    status,
    consoleErrorCount: 0,
    documentOverflow: false,
    elementOverflow: false,
    primaryAction: { status: 'reachable' },
  });
  fs.writeFileSync(path.join(qaDir, 'report.json'), JSON.stringify({
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    producer: 'senior-tester',
    status,
    routes: [{ route: '/', viewports: [viewport(390), viewport(768), viewport(1440)] }],
    blocker: { code: blockerCode, summary: `QA is blocked by ${blockerCode}.` },
  }));
}

function writeStrictPassingQaReport(dir: string, runId: string, producer: 'senior-tester' | 'parent-browser'): string {
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
    generatedAt: new Date().toISOString(),
    producer,
    status: 'passed',
    routes: [{
      route: '/',
      viewports: [viewport(390, 'mobile.png'), viewport(768), viewport(1440, 'desktop.png')],
    }],
  }));
  return reportFile;
}

function run(dir: string): boolean {
  return maybeFlipToMaintenance(dir, readState(dir));
}

function runAtPromptBoundary(dir: string): boolean {
  return maybeFlipToMaintenance(dir, readState(dir), { atPromptBoundary: true });
}

test('no flip for an existing-codebase (heuristic is new-project only)', () => {
  const dir = mkproject({ mode: 'existing-codebase', files: 30, verified: true });
  assert.equal(run(dir), false);
});

test('no flip without any digest (orchestrator never ran)', () => {
  const dir = mkproject({ files: 30, digest: false });
  assert.equal(run(dir), false);
});

test('no flip with only an architect digest — build has not reached verification', () => {
  // Regression for the premature-flip bug: a long/blocked build whose implementer
  // claims aged out (no-active-claims passes) but that never reached review must
  // NOT flip. The architect digest lands in Phase 1; review is Phase 3.
  const dir = mkproject({ files: 30, digest: true, verified: false });
  assert.equal(run(dir), false);
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
});

test('no flip while a subagent claim is still active (never mid-orchestration)', () => {
  const dir = mkproject({ files: 30, verified: true, claimFresh: true });
  assert.equal(run(dir), false);
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
  assert.equal(fs.existsSync(path.join(dir, '.traffic-one', 'runs', '123', 'run.json')), false,
    'terminal ledger is not written before active-claim guards settle');
});

test('no flip when the codebase has not produced real output yet', () => {
  const dir = mkproject({ files: 4, verified: true });
  assert.equal(run(dir), false);
});

test('no flip for frontend TESTS_GREEN without QA artifacts', () => {
  // A genuine frontend run (implementer wrote frontend.md) that is green but produced NO QA
  // artifacts must stay non-terminal — the per-run QA gate still applies because the run
  // touched the frontend. (A backend-only run with no frontend.md is exempt; covered below.)
  const dir = mkproject({ files: 30, digest: true, implementer: true, verified: true, qa: false });
  assert.equal(run(dir), false);
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
});

test('no flip for stale shared Lighthouse output from an earlier run', () => {
  const dir = mkproject({ files: 30, digest: true, implementer: true, verified: true, qa: false });
  const memoryDir = '.traffic' + '-one';
  const runDir = path.join(dir, memoryDir, 'runs', '123');
  const lighthouseDir = path.join(dir, memoryDir, 'reports', 'lighthouse');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(lighthouseDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
    version: 1,
    runId: '123',
    createdAt: '2099-01-01T00:00:00Z',
  }));
  fs.writeFileSync(path.join(lighthouseDir, 'report.html'), '<html></html>');
  assert.equal(run(dir), false);
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
});

test('flips to maintenance when the build reached verification and every guard holds; idempotent', () => {
  const dir = mkproject({ files: 30, digest: true, verified: true });
  // A stale build-time claim (past the freshness window, so it does not block the
  // flip) must be swept by the canonical terminal settlement before maintenance is
  // projected.
  const claimFile = path.join(dir, '.traffic-one', 'runs', '123', 'sess-old.json');
  fs.mkdirSync(path.dirname(claimFile), { recursive: true });
  fs.writeFileSync(claimFile, JSON.stringify({
    version: 1, runId: '123', claimId: 'senior-frontend-1-b', role: 'senior-frontend',
    status: 'claimed', sessionId: 'sess-old',
    createdAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
  }));
  assert.equal(run(dir), true);
  const state = readState(dir);
  assert.equal(projectPhase(state, 'new-project'), 'maintenance');
  assert.equal((state.lifecycle as Record<string, unknown>).source, 'heuristic');
  const released = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
  assert.equal(released.status, 'released');
  assert.equal(released.releasedReason, 'terminal-verified-evidence');
  // second call: already maintenance → no-op
  assert.equal(run(dir), false);
});

test('atPromptBoundary flips PAST a stale pending claim — a new prompt means the build turn ended', () => {
  // The exact Cursor stuck-in-building case: build reached verification, but a
  // never-activated pending claim lingers so the PostToolUse heuristic (no-active-
  // claims guard) refuses to flip. At the prompt boundary the claim is a leftover, so
  // the flip proceeds and the maintenance gates fail open for the next request.
  const dir = mkproject({ files: 30, verified: true, claimFresh: true });
  assert.equal(run(dir), false, 'mid-turn heuristic still blocked by the active claim');
  assert.equal(runAtPromptBoundary(dir), true, 'prompt boundary flips past it');
  const state = readState(dir);
  assert.equal(projectPhase(state, 'new-project'), 'maintenance');
  assert.equal((state.lifecycle as Record<string, unknown>).source, 'prompt-boundary');
});

test('atPromptBoundary still requires the build to have produced implementer output', () => {
  // The boundary relaxes the claims guard AND the terminal-verdict requirement, but
  // not to nothing: a build that only PLANNED (an architect digest, no frontend/
  // backend digest) must NOT flip, even on a new prompt — no code was written yet.
  const dir = mkproject({ files: 30, digest: true, verified: false });
  assert.equal(runAtPromptBoundary(dir), false);
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
});

test('atPromptBoundary flips on implementer output even WITHOUT a terminal verdict', () => {
  // The exact pshihological-raport case: the team built a real app (architect +
  // frontend + backend digests) but the reviewer/tester never wrote their digests,
  // so there is no terminal verdict and the project was pinned in "building" forever
  // — every maintenance follow-up bypassed triage. At a new prompt boundary the build
  // turn has ended, so implementer output is enough to settle into maintenance.
  const dir = mkproject({ files: 30, digest: true, implementer: true, verified: false });
  assert.equal(run(dir), false, 'mid-turn still demands a terminal verdict');
  assert.equal(runAtPromptBoundary(dir), true, 'prompt boundary accepts implementer output');
  const state = readState(dir);
  assert.equal(projectPhase(state, 'new-project'), 'maintenance');
  assert.equal((state.lifecycle as Record<string, unknown>).source, 'prompt-boundary');
});

test('currentRunId wins over an older terminal run: unresolved verification stays building', () => {
  const dir = mkproject({ files: 30, currentRunId: 'CURRENT' });
  writeRun(dir, 'OLD', { implementer: true, reviewer: 'APPROVED', tester: 'TESTS_GREEN', qa: true });
  writeRun(dir, 'CURRENT', { implementer: true, reviewer: 'CHANGES_REQUESTED' });

  assert.equal(run(dir), false);
  assert.equal(runAtPromptBoundary(dir), false, 'old green evidence must not settle the unresolved current run');
  const state = readState(dir) as Record<string, unknown>;
  assert.equal(projectPhase(state, 'new-project'), 'building');
  assert.equal(state.currentRunId, 'CURRENT', 'the unresolved run id is preserved');
});

test('a terminal strict-contract current backend-only run settles maintenance and its ledger', () => {
  const dir = mkproject({ files: 30, currentRunId: 'CURRENT' });
  const dd = path.join(dir, '.traffic-one', 'digests', 'CURRENT');
  fs.mkdirSync(dd, { recursive: true });
  fs.writeFileSync(path.join(dd, 'backend.md'), '# backend\nTouched: src/api.ts\n');
  fs.writeFileSync(path.join(dd, 'reviewer.md'), '# reviewer\nverdict: APPROVED\n');
  fs.writeFileSync(path.join(dd, 'tester.md'), '# tester\nverdict: TESTS_GREEN\n');
  const rd = path.join(dir, '.traffic-one', 'runs', 'CURRENT');
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, 'run.json'), JSON.stringify({
    version: 1,
    runId: 'CURRENT',
    status: 'active',
    qaContractVersion: 1,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  }));

  assert.equal(run(dir), true);
  assert.equal(projectPhase(readState(dir), 'new-project'), 'maintenance');
  const ledger = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
  assert.equal(ledger.status, 'completed');
  assert.equal(ledger.outcome, 'verified');
});

test('a partial verifier digest makes the current run nonterminal at the prompt boundary', () => {
  const dir = mkproject({ files: 30, currentRunId: 'CURRENT' });
  writeRun(dir, 'CURRENT', { implementer: true, reviewer: 'APPROVED' });

  assert.equal(runAtPromptBoundary(dir), false, 'reviewer-only verification is not the implementer fallback');
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
});

test('explicit blocked QA settles the run ledger as environment-blocked without flipping lifecycle', () => {
  const dir = mkproject({ files: 30, currentRunId: 'BLOCKED' });
  writeRun(dir, 'BLOCKED', { implementer: true, reviewer: 'APPROVED', tester: 'TESTS_FAILING' });
  const qaDir = path.join(dir, '.traffic-one', 'reports', 'qa', 'BLOCKED');
  fs.mkdirSync(qaDir, { recursive: true });
  fs.writeFileSync(path.join(qaDir, 'report.json'), JSON.stringify({ status: 'blocked:sandbox' }));

  assert.equal(runAtPromptBoundary(dir), false);
  const state = readState(dir) as Record<string, unknown>;
  assert.equal(projectPhase(state, 'new-project'), 'building');
  assert.equal(state.currentRunId, 'BLOCKED');
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', 'runs', 'BLOCKED', 'run.json'), 'utf8'));
  assert.equal(ledger.status, 'blocked');
  assert.equal(ledger.outcome, 'environment-blocked');
  assert.equal(ledger.qaContractVersion, 1);
  assert.equal(typeof ledger.finishedAt, 'string');
});

test('strict QA blocker settlement keeps the browser bridge eligible and blocks other environments', () => {
  const blockerTable = [
    ['browser-unavailable', 'active'],
    ['sandbox', 'blocked'],
    ['usage-limit', 'blocked'],
    ['timeout', 'blocked'],
  ] as const;

  for (const [blockerCode, expectedStatus] of blockerTable) {
    const runId = `BLOCKER-${blockerCode}`;
    const dir = mkproject({ files: 30, currentRunId: runId });
    try {
      writeRun(dir, runId, { implementer: true, reviewer: 'APPROVED', tester: 'TESTS_FAILING' });
      const runDir = path.join(dir, '.traffic-one', 'runs', runId);
      const activatedAt = new Date(Date.now() - 10_000).toISOString();
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
        version: 1,
        runId,
        status: 'active',
        qaContractVersion: 1,
        qaContractActivatedAt: activatedAt,
        createdAt: activatedAt,
      }));
      writeStrictBlockedQaReport(dir, runId, blockerCode);

      assert.equal(runAtPromptBoundary(dir), false, `${blockerCode} never flips lifecycle`);
      const ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
      assert.equal(ledger.status, expectedStatus, blockerCode);
      if (blockerCode === 'browser-unavailable') {
        assert.equal(ledger.outcome, undefined, 'parent browser bridge keeps the same active run');
        assert.equal(ledger.finishedAt, undefined);
      } else {
        assert.equal(ledger.outcome, 'environment-blocked', blockerCode);
        assert.equal(typeof ledger.finishedAt, 'string', blockerCode);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a parent-browser replacement settles only after the tester re-attests it', () => {
  const runId = 'PARENT-BROWSER';
  const dir = mkproject({ files: 30, currentRunId: runId });
  try {
    writeRun(dir, runId, { implementer: true, reviewer: 'APPROVED', tester: 'TESTS_GREEN' });
    const runDir = path.join(dir, '.traffic-one', 'runs', runId);
    const activatedAt = new Date(Date.now() - 10_000).toISOString();
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 1,
      runId,
      status: 'active',
      qaContractVersion: 1,
      qaContractActivatedAt: activatedAt,
      createdAt: activatedAt,
    }));
    const testerFile = path.join(dir, '.traffic-one', 'digests', runId, 'tester.md');
    const reportFile = writeStrictPassingQaReport(dir, runId, 'parent-browser');
    const reportMtimeMs = fs.statSync(reportFile).mtimeMs;
    fs.utimesSync(testerFile, new Date(reportMtimeMs - 1_000), new Date(reportMtimeMs - 1_000));
    assert.equal(runAtPromptBoundary(dir), false, 'pre-report TESTS_GREEN cannot attest parent evidence');

    fs.writeFileSync(testerFile, '# tester\nverdict: TESTS_GREEN\n');
    fs.utimesSync(testerFile, new Date(reportMtimeMs + 1_000), new Date(reportMtimeMs + 1_000));
    assert.equal(runAtPromptBoundary(dir), true);
    const ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'completed');
    assert.equal(ledger.outcome, 'verified');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict blocked settlement rejects malformed or stale reports before accepting a safe structured blocker', () => {
  const dir = mkproject({ files: 30, currentRunId: 'STRICT-BLOCKED' });
  writeRun(dir, 'STRICT-BLOCKED', {
    implementer: true,
    reviewer: 'APPROVED',
    tester: 'TESTS_FAILING blocked:sandbox',
  });
  const createdAt = new Date(Date.now() - 10_000).toISOString();
  const rd = path.join(dir, '.traffic-one', 'runs', 'STRICT-BLOCKED');
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, 'run.json'), JSON.stringify({
    version: 1,
    runId: 'STRICT-BLOCKED',
    status: 'active',
    qaContractVersion: 1,
    createdAt,
  }));
  const qaDir = path.join(dir, '.traffic-one', 'reports', 'qa', 'STRICT-BLOCKED');
  fs.mkdirSync(qaDir, { recursive: true });
  fs.writeFileSync(path.join(qaDir, 'report.json'), JSON.stringify({ status: 'blocked:sandbox' }));

  assert.equal(runAtPromptBoundary(dir), false);
  let ledger = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
  assert.equal(ledger.status, 'active', 'malformed strict blocker is not persisted');

  const viewport = (width: number) => ({
    width,
    status: 'blocked:sandbox',
    consoleErrorCount: 0,
    documentOverflow: false,
    elementOverflow: false,
    primaryAction: { status: 'reachable' },
  });
  const report = {
    schemaVersion: 1,
    runId: 'STRICT-BLOCKED',
    generatedAt: new Date(Date.parse(createdAt) - 1).toISOString(),
    producer: 'senior-tester',
    status: 'blocked:sandbox',
    routes: [{ route: '/', viewports: [viewport(390), viewport(768), viewport(1440)] }],
    blocker: { code: 'sandbox', summary: 'Browser process execution was denied by policy.' },
  };
  fs.writeFileSync(path.join(qaDir, 'report.json'), JSON.stringify(report));
  assert.equal(runAtPromptBoundary(dir), false);
  ledger = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
  assert.equal(ledger.status, 'active', 'stale strict blocker is not persisted');

  report.generatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(qaDir, 'report.json'), JSON.stringify(report));
  assert.equal(runAtPromptBoundary(dir), false);
  ledger = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
  assert.equal(ledger.status, 'blocked');
  assert.equal(ledger.outcome, 'environment-blocked');
});

test('a blocked run cannot settle terminal evidence until the user-authorized resume transition', () => {
  const dir = mkproject({ files: 30, currentRunId: 'BLOCKED' });
  const dd = path.join(dir, '.traffic-one', 'digests', 'BLOCKED');
  fs.mkdirSync(dd, { recursive: true });
  fs.writeFileSync(path.join(dd, 'backend.md'), '# backend\nTouched: src/api.ts\n');
  fs.writeFileSync(path.join(dd, 'reviewer.md'), '# reviewer\nverdict: APPROVED\n');
  fs.writeFileSync(path.join(dd, 'tester.md'), '# tester\nverdict: TESTS_GREEN\n');
  const rd = path.join(dir, '.traffic-one', 'runs', 'BLOCKED');
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, 'run.json'), JSON.stringify({
    version: 1,
    runId: 'BLOCKED',
    status: 'blocked',
    outcome: 'environment-blocked',
    qaContractVersion: 1,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 30_000).toISOString(),
  }));

  assert.equal(runAtPromptBoundary(dir), false, 'terminal artifacts cannot bypass blocked→active authorization');
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
  assert.ok(transitionRunStatus(dir, 'BLOCKED', {
    status: 'active',
    reason: 'user-authorized-extra-cycle',
  }));
  assert.equal(runAtPromptBoundary(dir), true);
  const ledger = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
  assert.equal(ledger.status, 'completed');
  assert.equal(ledger.outcome, 'verified');
});

test('an implementer-only current run retains the interrupted-build prompt-boundary fallback', () => {
  const dir = mkproject({ files: 30, currentRunId: 'CURRENT' });
  writeRun(dir, 'OLD', { implementer: true, reviewer: 'APPROVED', tester: 'TESTS_GREEN', qa: true });
  writeRun(dir, 'CURRENT', { implementer: true });

  assert.equal(run(dir), false, 'mid-turn remains strict');
  assert.equal(runAtPromptBoundary(dir), true, 'verification never started, so the compatibility fallback applies');
});

test('without currentRunId, only the newest legacy run is evaluated', () => {
  const dir = mkproject({ files: 30 });
  writeRun(dir, 'OLD', {
    implementer: true,
    reviewer: 'APPROVED',
    tester: 'TESTS_GREEN',
    qa: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  writeRun(dir, 'NEW', {
    implementer: true,
    reviewer: 'CHANGES_REQUESTED',
    createdAt: '2099-01-01T00:00:00.000Z',
  });

  assert.equal(runAtPromptBoundary(dir), false, 'an old terminal run cannot hide the newest unresolved legacy run');
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
});

test('without currentRunId, touching or finishing an old terminal run cannot outrank a newer unresolved run', () => {
  const dir = mkproject({ files: 30 });
  const oldRunId = '1767225600000';
  const newRunId = '1767225660000';
  writeRun(dir, oldRunId, {
    implementer: true,
    reviewer: 'APPROVED',
    tester: 'TESTS_GREEN',
    qa: true,
    createdAt: new Date(Number(oldRunId)).toISOString(),
  });
  writeRun(dir, newRunId, {
    implementer: true,
    reviewer: 'CHANGES_REQUESTED',
    createdAt: new Date(Number(newRunId)).toISOString(),
  });

  const oldLedgerPath = path.join(dir, '.traffic-one', 'runs', oldRunId, 'run.json');
  const oldLedger = JSON.parse(fs.readFileSync(oldLedgerPath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(oldLedgerPath, JSON.stringify({
    ...oldLedger,
    status: 'completed',
    outcome: 'verified',
    statusUpdatedAt: '2099-01-01T00:00:00.000Z',
    finishedAt: '2099-01-01T00:00:00.000Z',
  }));
  const touchedAt = new Date('2099-01-02T00:00:00.000Z');
  const oldDigestDir = path.join(dir, '.traffic-one', 'digests', oldRunId);
  for (const name of fs.readdirSync(oldDigestDir)) {
    fs.utimesSync(path.join(oldDigestDir, name), touchedAt, touchedAt);
  }
  fs.utimesSync(oldDigestDir, touchedAt, touchedAt);

  assert.equal(runAtPromptBoundary(dir), false, 'creation order wins over mutable terminal timestamps');
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
});

test('atPromptBoundary still requires real source output and new-project mode', () => {
  const tooSmall = mkproject({ files: 4, verified: true });
  assert.equal(runAtPromptBoundary(tooSmall), false);
  const existing = mkproject({ mode: 'existing-codebase', files: 30, verified: true });
  assert.equal(runAtPromptBoundary(existing), false);
});

test('no flip while the reviewer verdict is CHANGES_REQUESTED (digest exists but is non-terminal)', () => {
  // The exact 16:26:19Z forensic case: reviewer.md exists but says CHANGES_REQUESTED
  // and no tester digest yet. Existence-only would flip mid-fix-cycle; the terminal-
  // verdict gate keeps it building. This also closes the prompt-boundary bypass.
  const dir = mkproject({ files: 30, reviewerVerdict: 'CHANGES_REQUESTED' });
  assert.equal(run(dir), false);
  assert.equal(runAtPromptBoundary(dir), false);
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
});

test('no flip with reviewer APPROVED but no tester digest (terminal requires both)', () => {
  const dir = mkproject({ files: 30, reviewerVerdict: 'APPROVED' });
  assert.equal(run(dir), false);
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
});

test('no flip with tester TESTS_FAILING even when reviewer is APPROVED', () => {
  const dir = mkproject({ files: 30, reviewerVerdict: 'APPROVED', testerVerdict: 'TESTS_FAILING' });
  assert.equal(run(dir), false);
});

test('a shipper digest alone cannot fabricate verified settlement', () => {
  const dir = mkproject({ files: 30, shipper: true });
  assert.equal(run(dir), false);
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
});

test('a failed shipper digest is unresolved and never advertises terminal settlement', () => {
  const dir = mkproject({ files: 30, currentRunId: 'FAILED-SHIP' });
  const dd = path.join(dir, '.traffic-one', 'digests', 'FAILED-SHIP');
  fs.mkdirSync(dd, { recursive: true });
  fs.writeFileSync(path.join(dd, 'shipper.md'), '# shipper\nverdict: FAILED\n');
  assert.equal(runAtPromptBoundary(dir), false);
  assert.equal(projectPhase(readState(dir), 'new-project'), 'building');
});
