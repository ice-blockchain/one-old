import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { maybeFlipToMaintenance } from '../build-complete';
import { projectPhase, readState } from '../../../shared/state';

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
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
    mode: opts.mode ?? 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true, confirmed: true,
  }));
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
    if (opts.shipper) fs.writeFileSync(path.join(dd, 'shipper.md'), '# shipper\nurl: https://app.example\n');
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
  assert.equal(run(dir), true);
  const state = readState(dir);
  assert.equal(projectPhase(state, 'new-project'), 'maintenance');
  assert.equal((state.lifecycle as Record<string, unknown>).source, 'heuristic');
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

test('flips on a terminal shipper digest alone (shipper runs only post-deploy)', () => {
  const dir = mkproject({ files: 30, shipper: true });
  assert.equal(run(dir), true);
  assert.equal(projectPhase(readState(dir), 'new-project'), 'maintenance');
});
