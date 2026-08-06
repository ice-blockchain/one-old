// Per-check truth + single-instance lock (1.0.37, 8co findings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readRunSettlement, writeRunSettlement } from '../../../shared/run-settlement';
import { type QaReportV2 } from '../../../shared/qa-report-v2';
import {
  NATIVE_ATTESTED_CHECK_IDS,
  computeBrowserCheckStatuses,
  nativeCheckStatuses,
} from '../report-publish';
import { acquireQaRunLock, releaseQaRunLock } from '../lock';
import { publishQaReportV2 } from '../run-context';

const BEHAVIORAL_CHECKS = [
  'stack-build', 'playwright-local', 'dom-assertions', 'actions', 'routing',
  'hydration', 'console-errors', 'network-errors',
];

function viewport(overrides: Record<string, unknown> = {}): {
  width: number;
  status: 'passed' | 'failed';
  domAssertionsPassed: boolean;
  actionsPassed: boolean;
  routingPassed: boolean;
  hydrationPassed: boolean;
  consoleErrors: string[];
  networkErrors: string[];
  actionErrors?: string[];
  artifactAt: string;
  screenshotPath?: string;
} {
  return {
    width: 390,
    status: 'passed',
    domAssertionsPassed: true,
    actionsPassed: true,
    routingPassed: true,
    hydrationPassed: true,
    consoleErrors: [],
    networkErrors: [],
    artifactAt: '2026-07-30T00:00:00.000Z',
    ...overrides,
  } as never;
}

test('an action timeout fails actions/playwright checks but network-errors stays truthful', () => {
  const checks = computeBrowserCheckStatuses(BEHAVIORAL_CHECKS, {
    routes: [{
      route: '/',
      viewports: [viewport({
        status: 'failed',
        actionsPassed: false,
        actionErrors: ['locator.click: Timeout 30000ms exceeded.'],
      })],
    }],
    visual: false,
    playwrightOk: true,
    launchBlocker: null,
    servedOk: true,
  });
  const byId = new Map(checks.map((check) => [check.id, check]));
  assert.equal(byId.get('actions')?.status, 'failed');
  assert.equal(byId.get('network-errors')?.status, 'passed');
  assert.equal(byId.get('console-errors')?.status, 'passed');
  assert.equal(byId.get('routing')?.status, 'passed');
  assert.equal(byId.get('stack-build')?.status, 'passed');
  assert.equal(byId.get('playwright-local')?.status, 'passed');
});

test('a fully green scenario computes every required check as passed', () => {
  const checks = computeBrowserCheckStatuses([...BEHAVIORAL_CHECKS, 'responsive-screenshots'], {
    routes: [{ route: '/', viewports: [viewport({ screenshotPath: 'home-390.png' })] }],
    visual: true,
    playwrightOk: true,
    launchBlocker: null,
    servedOk: true,
  });
  assert.ok(checks.every((check) => check.status === 'passed'), JSON.stringify(checks));
});

test('missing Playwright marks only playwright-local failed; unrun checks are not-applicable', () => {
  const checks = computeBrowserCheckStatuses(BEHAVIORAL_CHECKS, {
    routes: [],
    visual: false,
    playwrightOk: false,
    launchBlocker: null,
    servedOk: false,
    blockerSummary: 'Project-local Playwright is unavailable.',
  });
  const byId = new Map(checks.map((check) => [check.id, check]));
  assert.equal(byId.get('playwright-local')?.status, 'failed');
  for (const id of ['stack-build', 'dom-assertions', 'actions', 'routing', 'hydration', 'console-errors', 'network-errors']) {
    assert.equal(byId.get(id)?.status, 'not-applicable', id);
    assert.match(String(byId.get(id)?.summary), /not run/, id);
  }
});

test('unknown check ids fail closed', () => {
  const checks = computeBrowserCheckStatuses(['made-up-check'], {
    routes: [{ route: '/', viewports: [viewport()] }],
    visual: false,
    playwrightOk: true,
    launchBlocker: null,
    servedOk: true,
  });
  assert.equal(checks[0]?.status, 'failed');
});

// This case used to pass ids `'a'` and `'b'`, which is exactly the defect it was
// characterizing: the mapping was WHOLESALE, so any id at all took the adapter's
// overall verdict and a native run reported `stack-format: passed` having never
// run a formatter. The pass-through behaviour below is unchanged for the ids the
// adapter result genuinely attests; an id outside that set now fails closed and
// must be produced by something that actually ran it.
test('native mapping passes through only what the adapter result attests', () => {
  const blocked = nativeCheckStatuses(NATIVE_ATTESTED_CHECK_IDS, 'blocked-environment', 'no simulator');
  assert.ok(blocked.every((check) => check.status === 'not-applicable'), JSON.stringify(blocked));
  const failed = nativeCheckStatuses(['native-unit-tests'], 'failed', 'assertion failed');
  assert.equal(failed[0]?.status, 'failed');
  const passed = nativeCheckStatuses(NATIVE_ATTESTED_CHECK_IDS, 'passed');
  assert.ok(passed.every((check) => check.status === 'passed'), JSON.stringify(passed));

  const unattested = nativeCheckStatuses(['stack-format', 'made-up-check'], 'passed');
  assert.ok(
    unattested.every((check) => check.status === 'failed'),
    'a green simulator run is not evidence that anything else ran',
  );
});

test('QA run lock is exclusive, reports the holder, and reclaims dead pids', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-lock-'));
  try {
    const first = acquireQaRunLock(projectRoot, '1785341588480');
    assert.ok(first.ok);
    const second = acquireQaRunLock(projectRoot, '1785341588480');
    assert.ok(!second.ok);
    if (!second.ok) {
      assert.equal(second.holder?.pid, process.pid);
    }
    if (first.ok) releaseQaRunLock(first.lockPath);
    const third = acquireQaRunLock(projectRoot, '1785341588480');
    assert.ok(third.ok);
    if (third.ok) {
      // Fake a dead holder: rewrite the payload with an impossible pid.
      fs.writeFileSync(third.lockPath, JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }));
      const reclaimed = acquireQaRunLock(projectRoot, '1785341588480');
      assert.ok(reclaimed.ok, 'dead-pid lock must be reclaimed');
      if (reclaimed.ok) releaseQaRunLock(reclaimed.lockPath);
    }
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('different run ids do not contend', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-lock2-'));
  try {
    const a = acquireQaRunLock(projectRoot, '1000000000001');
    const b = acquireQaRunLock(projectRoot, '1000000000002');
    assert.ok(a.ok && b.ok);
    if (a.ok) releaseQaRunLock(a.lockPath);
    if (b.ok) releaseQaRunLock(b.lockPath);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// The PLAN_READY seed (`active` + `verification-not-started`) used to outlive
// the evidence: `reconcileRunSettlement` was reachable only from session-start
// and prompt-submit, so the seed was still verbatim at revision 5 roughly fifty
// minutes after the QA report and both digests were on disk. Publishing the
// report re-derives the settlement where the evidence actually lands.
test('publishing the QA report supersedes the PLAN_READY settlement seed', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-settle-'));
  try {
    const runDir = path.join(projectRoot, '.traffic-one', 'runs', 'R');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 2,
      runId: 'R',
      status: 'active',
      kind: 'orchestration',
      qaContractVersion: 2,
    }));
    const seed = writeRunSettlement(projectRoot, 'R', {
      status: 'active',
      incompleteChecks: ['verification-not-started'],
    });
    assert.equal(seed?.status, 'active');
    assert.deepEqual(seed?.incompleteChecks, ['verification-not-started']);

    const digests = path.join(projectRoot, '.traffic-one', 'digests', 'R');
    fs.mkdirSync(digests, { recursive: true });
    fs.writeFileSync(path.join(digests, 'reviewer.md'), '# reviewer\nverdict: CHANGES_REQUESTED\n');
    fs.writeFileSync(path.join(digests, 'tester.md'), '# tester\nverdict: TESTS_FAILING\n');

    const report: QaReportV2 = {
      schemaVersion: 2,
      runId: 'R',
      verificationContractHash: 'a'.repeat(64),
      generatedAt: new Date().toISOString(),
      producer: 'parent-runner',
      status: 'failed',
      sourceHash: 'b'.repeat(64),
      checks: [{ id: 'stack-build', status: 'failed' }],
      routes: [],
    };
    publishQaReportV2(projectRoot, 'R', report);

    const settled = readRunSettlement(projectRoot, 'R');
    assert.equal(settled?.status, 'validating', 'the seed must not survive published evidence');
    assert.deepEqual(settled?.incompleteChecks, ['verification-incomplete']);
    assert.equal(settled!.revision, seed!.revision + 1);
    // A published report can never manufacture a green: strict evidence still
    // needs a contract plus a NEWER reviewer/tester attestation.
    assert.notEqual(settled?.status, 'verified');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
