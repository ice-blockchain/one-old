// src/shared/qa-report-v2-evidence.ts
// Machine (Playwright), native, and Lighthouse evidence validation against
// the recomputed hashes and the report's own claims.

import * as fs from 'fs';
import * as path from 'path';
import {
  combineNativeSummaries,
  computeBuildOutputManifest,
  contentHash,
  parseAndroidJUnitXml,
  parseQaLighthouseEvidence,
  parseQaMachineEvidence,
  parseQaNativeEvidence,
  parseXcodeResultSummary,
  readJsonFile,
  readLighthouseArtifact,
  type QaLighthouseEvidenceV1,
  type QaMachineEvidenceV1,
  type QaMachineViewportEvidenceV1,
  type QaNativeEvidenceV1,
} from '../qa-evidence-runtime';
import { sha256 } from '../text';
import {
  type VerificationContractV2,
} from '../verification-contract';

import {
  type QaReportV2,
  type QaViewportV2,
} from './schema';
import {
  artifactContentHash,
  artifactValid,
  qaArtifactAbsolute,
} from './artifacts';
import {
  normalizedUrl,
} from './build';
import { readRegularFileOrThrow } from '../bounded-read';

export function viewportPassed(viewport: QaViewportV2): boolean {
  return viewport.status === 'passed'
    && viewport.domAssertionsPassed
    && viewport.actionsPassed
    && viewport.routingPassed
    && viewport.hydrationPassed
    && viewport.consoleErrors.length === 0
    && viewport.networkErrors.length === 0
    && (viewport.actionErrors ?? []).length === 0;
}

function machineViewportMatchesReport(
  machine: QaMachineViewportEvidenceV1,
  report: QaViewportV2,
): boolean {
  return machine.width === report.width
    && machine.status === report.status
    && machine.domAssertionsPassed === report.domAssertionsPassed
    && machine.actionsPassed === report.actionsPassed
    && machine.routingPassed === report.routingPassed
    && machine.hydrationPassed === report.hydrationPassed
    && machine.artifactAt === report.artifactAt
    && machine.screenshotPath === report.screenshotPath
    && JSON.stringify(machine.consoleErrors) === JSON.stringify(report.consoleErrors)
    && JSON.stringify(machine.networkErrors) === JSON.stringify(report.networkErrors)
    && JSON.stringify(machine.actionErrors ?? []) === JSON.stringify(report.actionErrors ?? []);
}

export function validateMachineEvidence(
  report: QaReportV2,
  contract: VerificationContractV2,
  sourceHash: string,
  projectRoot: string,
): { evidence: QaMachineEvidenceV1 | null; error: string | null } {
  if (!report.machineEvidencePath) {
    return { evidence: null, error: 'runtime Playwright evidence is required' };
  }
  const absolute = qaArtifactAbsolute(projectRoot, report.runId, report.machineEvidencePath);
  const evidence = absolute ? parseQaMachineEvidence(readJsonFile(absolute)) : null;
  if (!absolute || !evidence) {
    return { evidence: null, error: 'runtime Playwright evidence is missing, outside the run QA directory, or hash-invalid' };
  }
  const build = report.build;
  if (!build
    || evidence.runId !== report.runId
    || evidence.verificationContractHash !== contract.contractHash
    || evidence.sourceHash !== sourceHash
    || evidence.buildOutputRoot !== build.outputRoot
    || evidence.buildHash !== build.buildHash
    || evidence.buildFingerprint !== build.fingerprint
    || evidence.serverPid !== build.pid
    || evidence.serverPort !== build.port
    || evidence.serverStartedAt !== build.startedAt
    || normalizedUrl(evidence.serverUrl) !== normalizedUrl(build.url)) {
    return { evidence, error: 'runtime Playwright evidence run/source/contract/build identity mismatch' };
  }
  const manifest = computeBuildOutputManifest(projectRoot, build.outputRoot);
  const manifestHashes = new Set(manifest?.files.map((file) => file.sha256) || []);
  if (!manifest
    || manifest.manifestHash !== build.buildHash
    || !evidence.servedAssetHashes.some((hash) => manifestHashes.has(hash))) {
    return {
      evidence,
      error: 'runtime browser did not serve any response body from the recorded build output manifest',
    };
  }
  const startedAt = Date.parse(evidence.startedAt);
  const generatedAt = Date.parse(evidence.generatedAt);
  if (startedAt < Date.parse(build.startedAt)
    || generatedAt < startedAt
    || generatedAt > Date.parse(report.generatedAt)
    || !artifactValid(
      projectRoot,
      report.runId,
      report.machineEvidencePath,
      startedAt,
      Date.parse(report.generatedAt),
    )) {
    return { evidence, error: 'runtime Playwright evidence is stale or has invalid timestamps' };
  }
  if (evidence.status !== 'passed') {
    return {
      evidence,
      error: evidence.status === 'blocked-environment'
        ? evidence.blockerSummary || 'runtime Playwright environment is blocked'
        : 'runtime Playwright evidence records a failed scenario',
    };
  }

  const machineRoutes = new Map<string, Map<number, QaMachineViewportEvidenceV1>>();
  for (const route of evidence.routes) {
    if (machineRoutes.has(route.route)) {
      return { evidence, error: `runtime Playwright evidence duplicates route ${route.route}` };
    }
    const widths = new Map<number, QaMachineViewportEvidenceV1>();
    for (const viewport of route.viewports) {
      if (widths.has(viewport.width)) {
        return { evidence, error: `runtime Playwright evidence duplicates ${route.route} width ${viewport.width}` };
      }
      widths.set(viewport.width, viewport);
      if (!viewportPassed(viewport)) {
        return { evidence, error: `${route.route} width ${viewport.width} has failed Playwright evidence` };
      }
      // Since evidence v2 a PASSED viewport legitimately carries no trace (the
      // runner discards the green diagnostic at emit time); when one IS
      // recorded it must still verify byte-for-byte.
      if (viewport.tracePath !== undefined && (
        !artifactValid(
          projectRoot,
          report.runId,
          viewport.tracePath,
          Date.parse(viewport.artifactAt),
          Date.parse(report.generatedAt),
        )
        || artifactContentHash(projectRoot, report.runId, viewport.tracePath) !== viewport.traceHash
      )) {
        return { evidence, error: `${route.route} width ${viewport.width} has invalid Playwright trace evidence` };
      }
      if (viewport.screenshotPath && (
        !artifactValid(
          projectRoot,
          report.runId,
          viewport.screenshotPath,
          Date.parse(viewport.artifactAt),
          Date.parse(report.generatedAt),
          viewport.width,
        )
        || artifactContentHash(projectRoot, report.runId, viewport.screenshotPath) !== viewport.screenshotHash
      )) {
        return { evidence, error: `${route.route} width ${viewport.width} has invalid screenshot evidence` };
      }
    }
    machineRoutes.set(route.route, widths);
  }

  for (const route of report.routes) {
    const machine = machineRoutes.get(route.route);
    if (!machine) return { evidence, error: `report route ${route.route} is absent from runtime Playwright evidence` };
    for (const viewport of route.viewports) {
      const observed = machine.get(viewport.width);
      if (!observed || !machineViewportMatchesReport(observed, viewport)) {
        return {
          evidence,
          error: `report assertions for ${route.route} width ${viewport.width} are not machine-produced`,
        };
      }
    }
  }
  return { evidence, error: null };
}

export function validateNativeEvidence(
  report: QaReportV2,
  contract: VerificationContractV2,
  sourceHash: string,
  projectRoot: string,
): { evidence: QaNativeEvidenceV1 | null; error: string | null } {
  if (!report.native) {
    return { evidence: null, error: 'Runtime-owned native evidence is required.' };
  }
  const absolute = qaArtifactAbsolute(projectRoot, report.runId, report.native.evidencePath);
  const evidence = absolute ? parseQaNativeEvidence(readJsonFile(absolute)) : null;
  if (!absolute || !evidence) {
    return {
      evidence: null,
      error: 'Native evidence sidecar is missing, outside the run QA directory, or hash-invalid.',
    };
  }
  if (evidence.runId !== report.runId
    || evidence.verificationContractHash !== contract.contractHash
    || evidence.sourceHash !== sourceHash
    || evidence.adapter !== contract.nativeAdapter) {
    return { evidence, error: 'Native run/source/contract/adapter identity mismatch.' };
  }
  const startedAt = Date.parse(evidence.startedAt);
  const generatedAt = Date.parse(evidence.generatedAt);
  if (startedAt < Math.max(
    Date.parse(contract.baseline.capturedAt),
    Date.parse(contract.generatedAt),
  )
    || generatedAt < startedAt
    || generatedAt > Date.parse(report.generatedAt)
    || !artifactValid(
      projectRoot,
      report.runId,
      report.native.evidencePath,
      startedAt,
      Date.parse(report.generatedAt),
    )) {
    return { evidence, error: 'Native evidence is stale or has invalid timestamps.' };
  }
  if (evidence.status !== 'passed'
    || !evidence.commandHash
    || !evidence.parser
    || !evidence.summary
    || !evidence.artifacts?.length) {
    return {
      evidence,
      error: evidence.blockerSummary
        || `Native adapter ${evidence.adapter} did not produce runtime-owned passing machine evidence.`,
    };
  }
  const artifactPaths = new Set<string>();
  for (const artifact of evidence.artifacts) {
    const artifactAt = Date.parse(artifact.artifactAt);
    const absoluteArtifact = qaArtifactAbsolute(
      projectRoot,
      report.runId,
      artifact.path,
    );
    if (artifactPaths.has(artifact.path)
      || !absoluteArtifact
      || artifactAt < startedAt
      || artifactAt > generatedAt
      || !artifactValid(
        projectRoot,
        report.runId,
        artifact.path,
        startedAt,
        Date.parse(report.generatedAt),
      )) {
      return { evidence, error: `Native machine artifact ${artifact.path} is missing, stale, duplicated, or unsafe.` };
    }
    artifactPaths.add(artifact.path);
    try {
      const stat = fs.statSync(absoluteArtifact);
      if (stat.size !== artifact.size || contentHash(absoluteArtifact) !== artifact.sha256) {
        return { evidence, error: `Native machine artifact ${artifact.path} hash/size mismatch.` };
      }
    } catch {
      return { evidence, error: `Native machine artifact ${artifact.path} cannot be inspected.` };
    }
  }

  let parsedSummary: typeof evidence.summary | null = null;
  if (evidence.parser === 'xcode-xcresult-summary-v1') {
    const summaries = evidence.artifacts.filter((artifact) => (
      /(?:^|\/)xcode-result-summary\.json$/.test(artifact.path)
    ));
    if (summaries.length !== 1
      || !evidence.artifacts.some((artifact) => artifact.path.includes('.xcresult/'))) {
      return { evidence, error: 'Xcode evidence requires one xcresulttool summary and a fresh xcresult bundle.' };
    }
    const absoluteSummary = qaArtifactAbsolute(
      projectRoot,
      report.runId,
      summaries[0]!.path,
    );
    parsedSummary = absoluteSummary
      ? parseXcodeResultSummary(readJsonFile(absoluteSummary))
      : null;
  } else if (evidence.parser === 'android-junit-xml-v1') {
    if (evidence.artifacts.some((artifact) => !/\.xml$/i.test(artifact.path))) {
      return { evidence, error: 'Android native evidence contains a non-JUnit artifact.' };
    }
    const summaries = evidence.artifacts.map((artifact) => {
      const absoluteArtifact = qaArtifactAbsolute(projectRoot, report.runId, artifact.path);
      if (!absoluteArtifact) return null;
      try {
        return parseAndroidJUnitXml(readRegularFileOrThrow(absoluteArtifact));
      } catch {
        return null;
      }
    });
    parsedSummary = summaries.some((summary) => !summary)
      ? null
      : combineNativeSummaries(summaries as NonNullable<(typeof summaries)[number]>[]);
  }
  if (!parsedSummary
    || parsedSummary.total !== evidence.summary.total
    || parsedSummary.passed !== evidence.summary.passed
    || parsedSummary.failed !== evidence.summary.failed
    || parsedSummary.skipped !== evidence.summary.skipped
    || parsedSummary.failed !== 0
    || parsedSummary.passed < 1) {
    return { evidence, error: 'Native evidence summary does not match supported machine-result artifacts.' };
  }
  return { evidence, error: null };
}

function lighthouseNumberMatches(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return Math.abs(left - right) < 0.001;
}

export function validateLighthouseEvidence(
  report: QaReportV2,
  contract: VerificationContractV2,
  sourceHash: string,
  projectRoot: string,
  machineEvidence?: QaMachineEvidenceV1 | null,
): { evidence: QaLighthouseEvidenceV1 | null; error: string | null } {
  const lighthousePath = report.lighthouse?.evidencePath;
  if (!lighthousePath) {
    return {
      evidence: null,
      error: report.lighthouse?.status === 'skipped-scenario-failed'
        ? `Lighthouse was skipped: ${report.lighthouse.reason || 'the browser scenario failed before the audit could run'}.`
        : 'Required Lighthouse evidence is missing.',
    };
  }
  const absolute = qaArtifactAbsolute(projectRoot, report.runId, lighthousePath);
  const evidence = absolute ? parseQaLighthouseEvidence(readJsonFile(absolute)) : null;
  const build = report.build;
  if (!absolute || !evidence) {
    return { evidence: null, error: 'Lighthouse evidence sidecar is missing, outside the run QA directory, or hash-invalid.' };
  }
  if (evidence.runId !== report.runId
    || evidence.verificationContractHash !== contract.contractHash
    || evidence.sourceHash !== sourceHash) {
    return { evidence, error: 'Lighthouse run/source/contract/build identity mismatch.' };
  }
  // Served-build coupling is a browser-listener fact. none/nonvisual still
  // measure performance (this function still runs when `performance.required`)
  // but the `stack` producer never starts a build-identity server, so comparing
  // evidence to `report.build` would make the budget unsettleable.
  if (contract.browserRequired && (
    !build
    || evidence.buildHash !== build.buildHash
    || evidence.buildFingerprint !== build.fingerprint
  )) {
    return { evidence, error: 'Lighthouse run/source/contract/build identity mismatch.' };
  }
  const generatedAt = Date.parse(evidence.generatedAt);
  const notBefore = contract.browserRequired && build
    ? Date.parse(build.startedAt)
    : Math.max(Date.parse(contract.baseline.capturedAt), Date.parse(contract.generatedAt));
  if (generatedAt < notBefore
    || generatedAt > Date.now() + 1_000
    || generatedAt > Date.parse(report.generatedAt)
    || !artifactValid(
      projectRoot,
      report.runId,
      lighthousePath,
      generatedAt,
      Date.parse(report.generatedAt),
    )) {
    return { evidence, error: 'Lighthouse evidence is stale or newer than the QA report.' };
  }
  if (machineEvidence && (
    generatedAt < Date.parse(machineEvidence.startedAt)
    || generatedAt > Date.parse(machineEvidence.generatedAt)
  )) {
    return {
      evidence,
      error: 'Lighthouse artifact was not captured during the runner-owned listener lifetime.',
    };
  }
  const artifact = qaArtifactAbsolute(projectRoot, report.runId, evidence.artifactPath);
  const summary = artifact ? readLighthouseArtifact(artifact) : null;
  if (!artifact
    || !summary
    || !artifactValid(
      projectRoot,
      report.runId,
      evidence.artifactPath,
      generatedAt,
      Date.parse(report.generatedAt),
    )
    || summary.artifactHash !== evidence.artifactHash
    || summary.generatedAt !== evidence.generatedAt
    || summary.finalUrl !== evidence.finalUrl
    || !lighthouseNumberMatches(summary.performance, evidence.performance)
    || !lighthouseNumberMatches(summary.accessibility, evidence.accessibility)
    || !lighthouseNumberMatches(summary.bestPractices, evidence.bestPractices)
    || !lighthouseNumberMatches(summary.seo, evidence.seo)
    || !lighthouseNumberMatches(summary.lcpMs, evidence.lcpMs)
    || !lighthouseNumberMatches(summary.cls, evidence.cls)
    || !lighthouseNumberMatches(summary.inpMs, evidence.inpMs)) {
    return { evidence, error: 'Lighthouse evidence does not match a complete raw Lighthouse artifact.' };
  }
  try {
    const finalUrl = new URL(summary.finalUrl);
    if (contract.browserRequired && build && finalUrl.origin !== new URL(build.url).origin) {
      return { evidence, error: 'Lighthouse artifact belongs to a different served build origin or port.' };
    }
  } catch {
    return { evidence, error: 'Lighthouse artifact final URL is invalid.' };
  }
  return { evidence, error: null };
}
