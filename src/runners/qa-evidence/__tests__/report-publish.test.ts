// Per-check truth + single-instance lock (1.0.37, 8co findings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { computeBrowserCheckStatuses, wholesaleCheckStatuses } from '../report-publish';
import { acquireQaRunLock, releaseQaRunLock } from '../lock';

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

test('wholesale mapping: blocked-environment yields not-applicable, failed keeps failed', () => {
  const blocked = wholesaleCheckStatuses(['a', 'b'], 'blocked-environment', 'no simulator');
  assert.ok(blocked.every((check) => check.status === 'not-applicable'));
  const failed = wholesaleCheckStatuses(['a'], 'failed', 'assertion failed');
  assert.equal(failed[0]?.status, 'failed');
  const passed = wholesaleCheckStatuses(['a'], 'passed');
  assert.equal(passed[0]?.status, 'passed');
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
