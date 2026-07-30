// 1.0.37 schema additions: actionErrors bucket + explicit Lighthouse skip
// record (8co findings). Both are optional and back-compatible; both must
// keep fake-green impossible.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseReport } from '../qa-report-v2/schema';
import { viewportPassed } from '../qa-report-v2/evidence';

const BASE_REPORT = {
  schemaVersion: 2,
  runId: '1785341588480',
  verificationContractHash: 'a'.repeat(64),
  generatedAt: '2026-07-30T00:00:00.000Z',
  producer: 'parent-runner',
  status: 'failed',
  sourceHash: 'b'.repeat(64),
  checks: [{ id: 'stack-build', status: 'failed', summary: 'x' }],
  routes: [],
};

function reportWith(overrides: Record<string, unknown>): unknown {
  return { ...BASE_REPORT, ...overrides };
}

function viewport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
  };
}

test('viewports parse with and without actionErrors; invalid shapes reject', () => {
  const withErrors = parseReport(reportWith({
    routes: [{ route: '/', viewports: [viewport({ actionErrors: ['locator.click: Timeout 30000ms exceeded.'] })] }],
  }));
  assert.ok(withErrors);
  assert.deepEqual(withErrors?.routes[0]?.viewports[0]?.actionErrors, ['locator.click: Timeout 30000ms exceeded.']);

  const without = parseReport(reportWith({
    routes: [{ route: '/', viewports: [viewport()] }],
  }));
  assert.ok(without);
  assert.equal(without?.routes[0]?.viewports[0]?.actionErrors, undefined);

  const invalid = parseReport(reportWith({
    routes: [{ route: '/', viewports: [viewport({ actionErrors: [42] })] }],
  }));
  assert.equal(invalid, null);
});

test('a viewport with actionErrors can never count as passed', () => {
  const parsed = parseReport(reportWith({
    routes: [{
      route: '/',
      viewports: [viewport({ actionErrors: ['locator.click: Timeout 30000ms exceeded.'] })],
    }],
  }));
  assert.ok(parsed);
  const target = parsed!.routes[0]!.viewports[0]!;
  assert.equal(viewportPassed(target), false);
});

test('lighthouse accepts evidencePath, the skip record, and rejects junk', () => {
  const withPath = parseReport(reportWith({ lighthouse: { evidencePath: 'lighthouse-evidence-v1.json' } }));
  assert.ok(withPath?.lighthouse?.evidencePath);

  const skipped = parseReport(reportWith({
    lighthouse: { status: 'skipped-scenario-failed', reason: 'browser scenario failed; Lighthouse was not attempted' },
  }));
  assert.ok(skipped);
  assert.equal(skipped?.lighthouse?.status, 'skipped-scenario-failed');
  assert.equal(skipped?.lighthouse?.evidencePath, undefined);

  assert.equal(parseReport(reportWith({ lighthouse: {} })), null);
  assert.equal(parseReport(reportWith({ lighthouse: { status: 'skipped-because-lazy' } })), null);
  assert.equal(parseReport(reportWith({ lighthouse: { reason: 'no status' } })), null);
  assert.equal(parseReport(reportWith({ lighthouse: { evidencePath: '/absolute/path.json' } })), null);
});
