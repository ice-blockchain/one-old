// Canonical QaReportV2 validation. The heavy lifting lives in the
// -schema/-artifacts/-build/-evidence siblings; this file keeps the
// validateQaReportV2 orchestrator and re-exports the original public surface.

import * as fs from 'fs';
import {
  type QaLighthouseEvidenceV1,
  type QaMachineEvidenceV1,
} from '../qa-evidence-runtime';
import {
  currentVerificationSourceHash,
  readVerificationContract,
  type LighthouseThresholdsV1,
  type VerificationContractV2,
} from '../verification-contract';

import {
  isRecord,
  parseReport,
  qaReportV2Path,
  type QaReportV2,
  type QaV2FailureCode,
  type QaV2ValidationRejected,
  type QaV2ValidationResult,
} from './schema';
import { qaDimensions } from './dimensions';
import {
  acceptanceAttests,
  artifactValid,
  writeAcceptanceAttestation,
} from './artifacts';
import {
  validateBuild,
} from './build';
import {
  validateLighthouseEvidence,
  validateMachineEvidence,
  validateNativeEvidence,
  viewportPassed,
} from './evidence';

function metric(
  evidence: QaLighthouseEvidenceV1,
  key: keyof QaLighthouseEvidenceV1,
): number | undefined {
  const value = evidence[key];
  return typeof value === 'number' ? value : undefined;
}

function thresholdFailures(
  evidence: QaLighthouseEvidenceV1,
  thresholds: LighthouseThresholdsV1,
  tolerancePercent: number,
): string[] {
  const failures: string[] = [];
  const mins: Array<[keyof LighthouseThresholdsV1, keyof QaLighthouseEvidenceV1]> = [
    ['performanceMin', 'performance'],
    ['accessibilityMin', 'accessibility'],
    ['bestPracticesMin', 'bestPractices'],
    ['seoMin', 'seo'],
  ];
  for (const [thresholdKey, evidenceKey] of mins) {
    const threshold = thresholds[thresholdKey];
    if (threshold === undefined) continue;
    const observed = metric(evidence, evidenceKey);
    const floor = threshold * (1 - tolerancePercent / 100);
    if (observed === undefined || observed < floor) failures.push(`${String(evidenceKey)} ${observed ?? 'missing'} < ${floor}`);
  }
  const maxes: Array<[keyof LighthouseThresholdsV1, keyof QaLighthouseEvidenceV1]> = [
    ['lcpMaxMs', 'lcpMs'],
    ['clsMax', 'cls'],
    ['inpMaxMs', 'inpMs'],
    // Judgeable on the canonical path so a declared first-paint / blocking-time
    // budget is enforced HERE and not only inside the standalone runner.
    ['fcpMaxMs', 'fcpMs'],
    ['tbtMaxMs', 'tbtMs'],
  ];
  for (const [thresholdKey, evidenceKey] of maxes) {
    const threshold = thresholds[thresholdKey];
    if (threshold === undefined) continue;
    const observed = metric(evidence, evidenceKey);
    const ceiling = threshold * (1 + tolerancePercent / 100);
    if (observed === undefined || observed > ceiling) failures.push(`${String(evidenceKey)} ${observed ?? 'missing'} > ${ceiling}`);
  }
  return failures;
}

function reject(
  projectRoot: string,
  runId: string,
  code: QaV2FailureCode,
  message: string,
  report?: QaReportV2,
  contract?: VerificationContractV2,
  lighthouse?: { hasEvidence: boolean; thresholdFailures: string[] },
): QaV2ValidationRejected {
  return {
    ok: false,
    code,
    message,
    reportPath: qaReportV2Path(projectRoot, runId),
    ...(report ? { report } : {}),
    ...(contract ? { contract } : {}),
    // Carried on the failure path too: "which dimension failed" is exactly what
    // a rejected run needs to report, and it is what tells a fix cycle whether
    // it has anything blocking to fix at all.
    dimensions: qaDimensions(report, contract, lighthouse),
  };
}

export function validateQaReportV2(
  value: unknown,
  projectRoot: string,
  runId: string,
  contract: VerificationContractV2,
): QaV2ValidationResult {
  const report = parseReport(value);
  if (!report) return reject(projectRoot, runId, 'invalid-schema', 'QA sidecar does not match QaReportV2.', undefined, contract);
  if (report.runId !== runId || report.verificationContractHash !== contract.contractHash) {
    return reject(projectRoot, runId, 'contract-mismatch', 'QA report does not belong to the active verification contract.', report, contract);
  }
  const source = currentVerificationSourceHash(projectRoot, contract);
  if (!source.complete) return reject(projectRoot, runId, 'scan-incomplete', source.reason || 'source identity scan incomplete', report, contract);
  if (report.sourceHash !== source.hash) {
    return reject(projectRoot, runId, 'source-mismatch', 'QA report source hash is stale or belongs to another build.', report, contract);
  }
  if (report.status === 'blocked-environment') {
    if (!contract.browserRequired && contract.uiImpact !== 'native-ui') {
      return reject(projectRoot, runId, 'invalid-schema', 'Environment blocker is invalid for none/nonvisual verification.', report, contract);
    }
    return reject(projectRoot, runId, 'blocked-environment', report.blockerSummary || 'Required runtime environment is unavailable.', report, contract);
  }
  const checks = new Map(report.checks.map((check) => [check.id, check]));
  for (const required of contract.requiredChecks) {
    const check = checks.get(required);
    const justifiedNoDom = required === 'axe-when-dom'
      && check?.status === 'not-applicable'
      && typeof check.summary === 'string'
      && (
        /\bno\s+DOM\b/i.test(check.summary)
        || /\bwithout(?:\s+any|\s+a)?\s+DOM\b/i.test(check.summary)
        || /\bdoes(?:\s+not|n't)\s+(?:render|touch|create|use|produce|affect)\b.{0,60}\bDOM\b/i.test(check.summary)
        || /\bDOM\b.{0,60}\b(?:is\s+)?(?:absent|not\s+present|unaffected)\b/i.test(check.summary)
      );
    // A quality command the project does not declare is honestly reported, not
    // silently passed. `stack-build` is deliberately excluded: a backend that
    // does not build is broken, and every supported backend has a build form.
    // Test and lint coverage is still guarded independently by the tester's own
    // completion gate, so this cannot become the only thing standing between an
    // untested service and settlement.
    const justifiedNoStackCommand = (required === 'stack-test' || required === 'stack-lint' || required === 'stack-performance')
      && check?.status === 'not-applicable'
      && typeof check.summary === 'string'
      && /\bnot run:/i.test(check.summary)
      && /\b(?:declares no|could not be executed)\b/i.test(check.summary);
    if (check?.status !== 'passed' && !justifiedNoDom && !justifiedNoStackCommand) {
      return reject(projectRoot, runId, 'required-check-failed', `Required check ${required} did not pass.`, report, contract);
    }
  }
  if (report.checks.some((check) => check.status === 'failed') || report.status === 'failed') {
    return reject(projectRoot, runId, 'functional-failure', 'QA report contains a failed check.', report, contract);
  }

  const requiresBuildIdentity = contract.buildIdentityRequired
    || contract.performance.required
    || Boolean(report.lighthouse?.evidencePath);
  let machineEvidence: QaMachineEvidenceV1 | null = null;
  if (contract.browserRequired) {
    const machine = validateMachineEvidence(report, contract, source.hash, projectRoot);
    if (machine.error || !machine.evidence) {
      return reject(
        projectRoot,
        runId,
        'machine-evidence-invalid',
        machine.error || 'runtime Playwright evidence is missing',
        report,
        contract,
      );
    }
    machineEvidence = machine.evidence;
  }
  const previouslyAttested = requiresBuildIdentity
    && acceptanceAttests(projectRoot, runId, report, contract, source.hash);
  if (requiresBuildIdentity && !previouslyAttested) {
    const buildFailure = validateBuild(
      report,
      contract,
      source.hash,
      projectRoot,
      machineEvidence,
    );
    if (buildFailure) return reject(projectRoot, runId, 'build-identity-invalid', buildFailure, report, contract);
  }

  if (contract.browserRequired) {
    const byRoute = new Map(report.routes.map((route) => [route.route, route]));
    for (const requiredRoute of contract.changedRoutes) {
      const route = byRoute.get(requiredRoute);
      if (!route || route.viewports.length === 0) {
        return reject(projectRoot, runId, 'route-matrix-incomplete', `Missing browser evidence for ${requiredRoute}.`, report, contract);
      }
      const widths = new Set(route.viewports.map((viewport) => viewport.width));
      for (const width of contract.requiredScreenshotWidths) {
        if (!widths.has(width)) {
          return reject(projectRoot, runId, 'route-matrix-incomplete', `${requiredRoute} is missing width ${width}.`, report, contract);
        }
      }
      for (const viewport of route.viewports) {
        if (!viewportPassed(viewport)) {
          return reject(projectRoot, runId, 'functional-failure', `${requiredRoute} width ${viewport.width} failed runtime assertions.`, report, contract);
        }
        const artifactAt = Date.parse(viewport.artifactAt);
        const minimumAt = report.build ? Date.parse(report.build.startedAt) : Date.parse(contract.baseline.capturedAt);
        if (artifactAt < minimumAt || artifactAt > Date.parse(report.generatedAt)) {
          return reject(projectRoot, runId, 'build-identity-invalid', `${requiredRoute} width ${viewport.width} artifact timestamp is stale.`, report, contract);
        }
        if (viewport.screenshotPath && !artifactValid(
          projectRoot,
          runId,
          viewport.screenshotPath,
          artifactAt,
          Date.parse(report.generatedAt),
          viewport.width,
        )) {
          return reject(projectRoot, runId, 'screenshot-invalid', `${requiredRoute} width ${viewport.width} screenshot is invalid or stale.`, report, contract);
        }
        if (
          contract.requiredScreenshotWidths.includes(viewport.width)
          && !viewport.screenshotPath
        ) {
          return reject(projectRoot, runId, 'screenshot-invalid', `${requiredRoute} width ${viewport.width} requires a fresh screenshot.`, report, contract);
        }
      }
    }
  }

  if (contract.uiImpact === 'native-ui') {
    const native = validateNativeEvidence(report, contract, source.hash, projectRoot);
    if (native.error || !native.evidence) {
      return reject(
        projectRoot,
        runId,
        'native-evidence-invalid',
        native.error || 'Native simulator/emulator evidence is missing.',
        report,
        contract,
      );
    }
  }

  const advisories: string[] = [];
  let lighthouseEvidence: QaLighthouseEvidenceV1 | null = null;
  if (contract.performance.required) {
    const lighthouse = validateLighthouseEvidence(
      report,
      contract,
      source.hash,
      projectRoot,
      machineEvidence,
    );
    if (lighthouse.error || !lighthouse.evidence) {
      return reject(
        projectRoot,
        runId,
        'lighthouse-threshold-failed',
        lighthouse.error || 'Required Lighthouse evidence is missing.',
        report,
        contract,
      );
    }
    lighthouseEvidence = lighthouse.evidence;
    // Judge the contract's EFFECTIVE budget, not just what the plan declared.
    // `explicitThresholds || {}` meant a required performance contract with no
    // declared numbers enforced nothing here, while the standalone runner
    // applied its own defaults — the two paths reached opposite verdicts on the
    // same audit (observed 10co).
    const exactFailures = thresholdFailures(lighthouseEvidence, contract.performance.thresholds || {}, 0);
    if (exactFailures.length > 0) {
      return reject(
        projectRoot,
        runId,
        'lighthouse-threshold-failed',
        exactFailures.join('; '),
        report,
        contract,
        { hasEvidence: true, thresholdFailures: exactFailures },
      );
    }
  } else if (report.lighthouse?.evidencePath) {
    const lighthouse = validateLighthouseEvidence(
      report,
      contract,
      source.hash,
      projectRoot,
      machineEvidence,
    );
    if (lighthouse.error || !lighthouse.evidence) {
      return reject(
        projectRoot,
        runId,
        'lighthouse-threshold-failed',
        lighthouse.error || 'Optional Lighthouse evidence is invalid.',
        report,
        contract,
      );
    }
    lighthouseEvidence = lighthouse.evidence;
  }
  if (lighthouseEvidence && contract.performance.advisoryThresholds) {
    advisories.push(...thresholdFailures(
      lighthouseEvidence,
      contract.performance.advisoryThresholds,
      contract.performance.advisoryTolerancePercent,
    ));
  }
  // An ADVISORY performance contract is measured against the same effective
  // budget as a required one, but a miss is a warning: it is reported, it never
  // rejects the run, and it must never start a fix cycle.
  const advisoryThresholdFailures = lighthouseEvidence && contract.performance.advisory
    ? thresholdFailures(
      lighthouseEvidence,
      contract.performance.thresholds || {},
      contract.performance.advisoryTolerancePercent,
    )
    : [];
  advisories.push(...advisoryThresholdFailures.map((failure) => `advisory page-speed: ${failure}`));
  const lighthouseSummary = {
    hasEvidence: Boolean(lighthouseEvidence),
    thresholdFailures: advisoryThresholdFailures,
  };
  if (requiresBuildIdentity
    && !previouslyAttested
    && !writeAcceptanceAttestation(projectRoot, runId, report, contract, source.hash)) {
    return reject(
      projectRoot,
      runId,
      'build-identity-invalid',
      'Live build identity passed, but its durable QA acceptance attestation could not be persisted.',
      report,
      contract,
      lighthouseSummary,
    );
  }
  return {
    ok: true,
    report,
    contract,
    reportPath: qaReportV2Path(projectRoot, runId),
    advisories,
    dimensions: qaDimensions(report, contract, lighthouseSummary),
  };
}

export function readQaReportV2(projectRoot: string, runId: string): QaV2ValidationResult {
  const contract = readVerificationContract(projectRoot, runId);
  if (!contract) return reject(projectRoot, runId, 'contract-missing', 'VerificationContractV2 is missing or invalid.');
  const reportPath = qaReportV2Path(projectRoot, runId);
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (error) {
    const code = isRecord(error) && error.code === 'ENOENT' ? 'report-missing' : 'invalid-json';
    return reject(projectRoot, runId, code, code === 'report-missing' ? 'QaReportV2 sidecar is missing.' : 'QaReportV2 is not valid JSON.', undefined, contract);
  }
  return validateQaReportV2(value, projectRoot, runId, contract);
}


export {
  QA_ACCEPTANCE_ATTESTATION_SCHEMA_VERSION,
  QA_BUILD_IDENTITY_PROBE_PATH,
  expectedBuildFingerprint,
  qaAcceptanceAttestationPath,
  qaReportV2Path,
  type QaAcceptanceAttestationV1,
  type QaBuildIdentityV2,
  type QaDimensionStatus,
  type QaDimensionsV1,
  type QaReportV2,
  type QaV2FailureCode,
  type QaV2ValidationRejected,
  type QaV2ValidationResult,
  type QaViewportV2,
} from './schema';
export { qaDimensions } from './dimensions';
export { qaReportV2ContentHash } from './artifacts';
