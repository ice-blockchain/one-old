// src/shared/qa-report-v2/dimensions.ts
// Per-dimension QA statuses, DERIVED from the report's checks and the run
// contract — never written by the producer.
//
// Observed 10co: the tester wrote `TESTS_GREEN` on a `passed` report and the
// parent gate then failed the same run on Lighthouse. A single aggregate
// `status` cannot express "functionally green, page speed over an advisory
// budget", so the two consumers disagreed. Deriving the breakdown in the one
// reader both of them call makes contradictory statuses structurally
// impossible, and keeps an advisory miss from reading as a failure.

import type { LighthouseThresholdsV1, VerificationContractV2 } from '../verification-contract';
import type { QaDimensionStatus, QaDimensionsV1, QaReportV2 } from './schema';

// `lighthouse` is deliberately absent: it is not a check id, it is derived from
// the performance contract plus its evidence.
const ACCESSIBILITY_CHECKS = new Set(['axe-when-dom']);
const RESPONSIVE_CHECKS = new Set(['responsive-screenshots']);

function checkStatus(report: QaReportV2, ids: Set<string>, required: string[]): QaDimensionStatus {
  const scoped = required.filter((id) => ids.has(id));
  if (scoped.length === 0) return 'not-required';
  for (const id of scoped) {
    const check = report.checks.find((entry) => entry.id === id);
    // A required check the report never reports on is not a pass.
    if (!check || check.status === 'failed') return 'failed';
  }
  return 'passed';
}

function functionalStatus(report: QaReportV2, required: string[]): QaDimensionStatus {
  const scoped = required.filter((id) => !ACCESSIBILITY_CHECKS.has(id) && !RESPONSIVE_CHECKS.has(id));
  if (scoped.length === 0) return 'not-required';
  return checkStatus(report, new Set(scoped), scoped);
}

function lighthouseStatus(
  contract: VerificationContractV2,
  hasEvidence: boolean,
  thresholdFailures: string[],
): QaDimensionStatus {
  const { required, advisory } = contract.performance;
  if (!required && !advisory) return 'not-required';
  if (required) {
    return hasEvidence && thresholdFailures.length === 0 ? 'passed' : 'failed';
  }
  // Advisory: a miss — or a missing audit — is worth saying out loud, and is
  // never a reason to fail the run or to start a fix cycle.
  if (!hasEvidence || thresholdFailures.length > 0) return 'advisory-warning';
  return 'passed';
}

export function qaDimensions(
  report: QaReportV2 | undefined,
  contract: VerificationContractV2 | undefined,
  lighthouse: { hasEvidence: boolean; thresholdFailures: string[] } = { hasEvidence: false, thresholdFailures: [] },
): QaDimensionsV1 {
  if (!report || !contract) {
    return {
      functionalQaStatus: 'unknown',
      accessibilityStatus: 'unknown',
      responsiveStatus: 'unknown',
      lighthouseStatus: 'unknown',
      overallStatus: 'failed',
    };
  }
  const required = contract.requiredChecks || [];
  const functionalQaStatus = functionalStatus(report, required);
  const accessibilityStatus = checkStatus(report, ACCESSIBILITY_CHECKS, required);
  const responsiveStatus = checkStatus(report, RESPONSIVE_CHECKS, required);
  const lighthouse2 = lighthouseStatus(contract, lighthouse.hasEvidence, lighthouse.thresholdFailures);
  const blocking = [functionalQaStatus, accessibilityStatus, responsiveStatus, lighthouse2];
  return {
    functionalQaStatus,
    accessibilityStatus,
    responsiveStatus,
    lighthouseStatus: lighthouse2,
    // `advisory-warning` deliberately does not fail the run — that is the whole
    // point of the advisory class.
    overallStatus: blocking.includes('failed') ? 'failed' : 'passed',
  };
}

export function thresholdKeys(thresholds: LighthouseThresholdsV1 | undefined): string[] {
  return thresholds ? Object.keys(thresholds) : [];
}
