import { test } from 'node:test';
import assert from 'node:assert/strict';

import { qaDimensions, type QaReportV2 } from '../qa-report-v2';
import type { VerificationContractV2 } from '../verification-contract';

// `qaDimensions` is a pure derivation over the report's checks and the run
// contract, so it is exercised directly. Observed 10co: the tester wrote
// TESTS_GREEN on a `passed` report and the parent gate then failed the same run
// on Lighthouse — one aggregate verdict could not express "functionally green,
// page speed over an advisory budget".

function report(checks: Array<[string, 'passed' | 'failed' | 'not-applicable']>): QaReportV2 {
  return { checks: checks.map(([id, status]) => ({ id, status })) } as unknown as QaReportV2;
}

function contract(
  requiredChecks: string[],
  performance: { required: boolean; advisory: boolean },
): VerificationContractV2 {
  return { requiredChecks, performance } as unknown as VerificationContractV2;
}

const FUNCTIONAL = ['stack-build', 'playwright-local', 'dom-assertions'];
const NO_PERF = { required: false, advisory: false };

test('qaDimensions splits the verdict by dimension and marks unrequired ones', () => {
  const dims = qaDimensions(
    report([['stack-build', 'passed'], ['playwright-local', 'passed'], ['dom-assertions', 'passed']]),
    contract(FUNCTIONAL, NO_PERF),
  );
  assert.equal(dims.functionalQaStatus, 'passed');
  assert.equal(dims.accessibilityStatus, 'not-required');
  assert.equal(dims.responsiveStatus, 'not-required');
  assert.equal(dims.lighthouseStatus, 'not-required');
  assert.equal(dims.overallStatus, 'passed');
});

test('qaDimensions attributes a failure to the dimension that owns the check', () => {
  const dims = qaDimensions(
    report([
      ['stack-build', 'passed'], ['playwright-local', 'passed'], ['dom-assertions', 'passed'],
      ['responsive-screenshots', 'failed'], ['axe-when-dom', 'passed'],
    ]),
    contract([...FUNCTIONAL, 'responsive-screenshots', 'axe-when-dom'], NO_PERF),
  );
  assert.equal(dims.functionalQaStatus, 'passed');
  assert.equal(dims.accessibilityStatus, 'passed');
  assert.equal(dims.responsiveStatus, 'failed');
  assert.equal(dims.overallStatus, 'failed');
});

test('a required check the report never mentions is not a pass', () => {
  const dims = qaDimensions(
    report([['stack-build', 'passed']]),
    contract(FUNCTIONAL, NO_PERF),
  );
  assert.equal(dims.functionalQaStatus, 'failed');
  assert.equal(dims.overallStatus, 'failed');
});

test('an advisory Lighthouse miss warns and never fails the run', () => {
  const green = report([['stack-build', 'passed'], ['playwright-local', 'passed'], ['dom-assertions', 'passed']]);
  const advisory = contract(FUNCTIONAL, { required: false, advisory: true });

  const missed = qaDimensions(green, advisory, { hasEvidence: true, thresholdFailures: ['fcpMs 1650 > 1500'] });
  assert.equal(missed.lighthouseStatus, 'advisory-warning');
  assert.equal(missed.functionalQaStatus, 'passed');
  assert.equal(missed.overallStatus, 'passed', 'an advisory miss must not end the run');

  const unmeasured = qaDimensions(green, advisory, { hasEvidence: false, thresholdFailures: [] });
  assert.equal(unmeasured.lighthouseStatus, 'advisory-warning', 'a missing advisory audit is still worth saying');
  assert.equal(unmeasured.overallStatus, 'passed');

  const clean = qaDimensions(green, advisory, { hasEvidence: true, thresholdFailures: [] });
  assert.equal(clean.lighthouseStatus, 'passed');
});

test('the same Lighthouse miss DOES fail the run once a budget is declared', () => {
  const green = report([['stack-build', 'passed'], ['playwright-local', 'passed'], ['dom-assertions', 'passed']]);
  const required = contract(FUNCTIONAL, { required: true, advisory: false });

  const missed = qaDimensions(green, required, { hasEvidence: true, thresholdFailures: ['fcpMs 1650 > 1500'] });
  assert.equal(missed.lighthouseStatus, 'failed');
  assert.equal(missed.overallStatus, 'failed');

  const missing = qaDimensions(green, required, { hasEvidence: false, thresholdFailures: [] });
  assert.equal(missing.lighthouseStatus, 'failed', 'a required audit that never ran is a failure');
});

test('an unreadable report or contract is unknown, never an implicit pass', () => {
  const dims = qaDimensions(undefined, undefined);
  assert.equal(dims.functionalQaStatus, 'unknown');
  assert.equal(dims.overallStatus, 'failed');
});
