// src/shared/qa-evidence-runtime-evidence.ts
// Machine (Playwright), native (Xcode/Android), and Lighthouse evidence:
// canonical creation with content hashes plus strict reparsing. The verifier
// recomputes every hash from disk; QaReportV2 booleans are never enough.
// Public surface re-exported by qa-evidence-runtime.ts.

import * as fs from 'fs';

import {
  isRecord,
  iso,
  safeRelativePath,
  safeText,
  sha256Bytes,
  SHA256_RE,
  stableJson,
} from './core';
import {
  QA_LIGHTHOUSE_EVIDENCE_SCHEMA_VERSION,
  QA_MACHINE_EVIDENCE_SCHEMA_VERSION,
  QA_NATIVE_EVIDENCE_SCHEMA_VERSION,
  type LighthouseArtifactSummaryV1,
  type QaLighthouseEvidenceV1,
  type QaMachineEvidenceV1,
  type QaMachineRouteEvidenceV1,
  type QaMachineViewportEvidenceV1,
  type QaNativeArtifactV1,
  type QaNativeEvidenceV1,
  type QaNativeMachineParserV1,
  type QaNativeTestSummaryV1,
  type Rec,
} from './types';

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)
    || !value.every((entry) => typeof entry === 'string' && entry.length <= 2_000)) return null;
  return [...value] as string[];
}

function parseMachineViewport(value: unknown): QaMachineViewportEvidenceV1 | null {
  if (!isRecord(value)
    || !Number.isInteger(value.width)
    || Number(value.width) < 240
    || Number(value.width) > 4_000
    || !['passed', 'failed'].includes(String(value.status))
    || typeof value.domAssertionsPassed !== 'boolean'
    || typeof value.actionsPassed !== 'boolean'
    || typeof value.routingPassed !== 'boolean'
    || typeof value.hydrationPassed !== 'boolean'
    || !iso(value.artifactAt)
    || !safeRelativePath(value.tracePath)
    || !SHA256_RE.test(String(value.traceHash))
    || (value.screenshotPath !== undefined && !safeRelativePath(value.screenshotPath))
    || (value.screenshotHash !== undefined && !SHA256_RE.test(String(value.screenshotHash)))
    || ((value.screenshotPath === undefined) !== (value.screenshotHash === undefined))) return null;
  const consoleErrors = stringArray(value.consoleErrors);
  const networkErrors = stringArray(value.networkErrors);
  if (!consoleErrors || !networkErrors) return null;
  const actionErrors = value.actionErrors === undefined ? undefined : stringArray(value.actionErrors);
  if (value.actionErrors !== undefined && !actionErrors) return null;
  return {
    width: Number(value.width),
    status: value.status as QaMachineViewportEvidenceV1['status'],
    domAssertionsPassed: value.domAssertionsPassed,
    actionsPassed: value.actionsPassed,
    routingPassed: value.routingPassed,
    hydrationPassed: value.hydrationPassed,
    consoleErrors,
    networkErrors,
    ...(actionErrors ? { actionErrors } : {}),
    artifactAt: value.artifactAt,
    tracePath: value.tracePath,
    traceHash: value.traceHash as string,
    ...(typeof value.screenshotPath === 'string'
      ? { screenshotPath: value.screenshotPath, screenshotHash: value.screenshotHash as string }
      : {}),
  };
}

function parseMachineRoute(value: unknown): QaMachineRouteEvidenceV1 | null {
  // `*` is the compiled catch-all identity, not a URL; the runner probes it via
  // a concrete `startPath` and files the evidence under the pattern.
  if (!isRecord(value)
    || !safeText(value.route, 2_048)
    || !(String(value.route) === '*' || String(value.route).startsWith('/'))
    || !Array.isArray(value.viewports)) return null;
  const viewports = value.viewports.map(parseMachineViewport);
  if (viewports.some((viewport) => !viewport)) return null;
  return { route: value.route, viewports: viewports as QaMachineViewportEvidenceV1[] };
}

function machineEvidenceHash(
  value: Omit<QaMachineEvidenceV1, 'evidenceHash'>,
): string {
  return sha256Bytes(stableJson(value));
}

export function createQaMachineEvidence(
  value: Omit<QaMachineEvidenceV1, 'schemaVersion' | 'producer' | 'evidenceHash'>,
): QaMachineEvidenceV1 {
  const canonical = {
    schemaVersion: QA_MACHINE_EVIDENCE_SCHEMA_VERSION,
    producer: 'traffic-one-qa-runner' as const,
    ...value,
  };
  return { ...canonical, evidenceHash: machineEvidenceHash(canonical) };
}

export function parseQaMachineEvidence(value: unknown): QaMachineEvidenceV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== QA_MACHINE_EVIDENCE_SCHEMA_VERSION
    || value.producer !== 'traffic-one-qa-runner'
    || !safeText(value.runnerVersion, 128)
    || !safeText(value.playwrightVersion, 128)
    || !safeText(value.runId, 128)
    || !SHA256_RE.test(String(value.verificationContractHash))
    || !SHA256_RE.test(String(value.sourceHash))
    || !safeRelativePath(value.buildOutputRoot)
    || !SHA256_RE.test(String(value.buildHash))
    || !SHA256_RE.test(String(value.buildFingerprint))
    || !['runtime-static', 'runtime-command'].includes(String(value.serverMode))
    || !Number.isSafeInteger(value.serverPid)
    || Number(value.serverPid) <= 0
    || !Number.isSafeInteger(value.serverPort)
    || Number(value.serverPort) < 1
    || Number(value.serverPort) > 65_535
    || !iso(value.serverStartedAt)
    || !safeText(value.serverUrl, 2_048)
    || !Array.isArray(value.servedAssetHashes)
    || !value.servedAssetHashes.every((entry) => typeof entry === 'string' && SHA256_RE.test(entry))
    || !SHA256_RE.test(String(value.scenarioHash))
    || !iso(value.startedAt)
    || !iso(value.generatedAt)
    || !['passed', 'failed', 'blocked-environment'].includes(String(value.status))
    || (value.status === 'passed' && value.servedAssetHashes.length === 0)
    || !Array.isArray(value.routes)
    || (value.blockerSummary !== undefined && !safeText(value.blockerSummary, 500))
    || !SHA256_RE.test(String(value.evidenceHash))) return null;
  const routes = value.routes.map(parseMachineRoute);
  if (routes.some((route) => !route)) return null;
  const candidate: QaMachineEvidenceV1 = {
    schemaVersion: QA_MACHINE_EVIDENCE_SCHEMA_VERSION,
    producer: 'traffic-one-qa-runner',
    runnerVersion: value.runnerVersion,
    playwrightVersion: value.playwrightVersion,
    runId: value.runId,
    verificationContractHash: value.verificationContractHash as string,
    sourceHash: value.sourceHash as string,
    buildOutputRoot: value.buildOutputRoot,
    buildHash: value.buildHash as string,
    buildFingerprint: value.buildFingerprint as string,
    serverMode: value.serverMode as QaMachineEvidenceV1['serverMode'],
    serverPid: Number(value.serverPid),
    serverPort: Number(value.serverPort),
    serverStartedAt: value.serverStartedAt,
    serverUrl: value.serverUrl,
    servedAssetHashes: [...value.servedAssetHashes] as string[],
    scenarioHash: value.scenarioHash as string,
    startedAt: value.startedAt,
    generatedAt: value.generatedAt,
    status: value.status as QaMachineEvidenceV1['status'],
    routes: routes as QaMachineRouteEvidenceV1[],
    ...(typeof value.blockerSummary === 'string' ? { blockerSummary: value.blockerSummary } : {}),
    evidenceHash: value.evidenceHash as string,
  };
  const { evidenceHash, ...withoutHash } = candidate;
  return machineEvidenceHash(withoutHash) === evidenceHash ? candidate : null;
}

function nativeEvidenceHash(
  value: Omit<QaNativeEvidenceV1, 'evidenceHash'>,
): string {
  return sha256Bytes(stableJson(value));
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseNativeSummary(value: unknown): QaNativeTestSummaryV1 | null {
  if (!isRecord(value)
    || !nonNegativeInteger(value.total)
    || !nonNegativeInteger(value.passed)
    || !nonNegativeInteger(value.failed)
    || !nonNegativeInteger(value.skipped)
    || Number(value.total) < 1
    || Number(value.passed) + Number(value.failed) + Number(value.skipped) !== Number(value.total)) {
    return null;
  }
  return {
    total: Number(value.total),
    passed: Number(value.passed),
    failed: Number(value.failed),
    skipped: Number(value.skipped),
  };
}

function parseNativeArtifact(value: unknown): QaNativeArtifactV1 | null {
  if (!isRecord(value)
    || !safeRelativePath(value.path)
    || !nonNegativeInteger(value.size)
    || Number(value.size) < 1
    || !SHA256_RE.test(String(value.sha256))
    || !iso(value.artifactAt)
    || Object.keys(value).some((key) => !['path', 'size', 'sha256', 'artifactAt'].includes(key))) {
    return null;
  }
  return {
    path: value.path,
    size: Number(value.size),
    sha256: value.sha256 as string,
    artifactAt: value.artifactAt,
  };
}

/**
 * Parse the stable JSON shape emitted by:
 *   xcrun xcresulttool get test-results summary --path <bundle> --format json
 */
export function parseXcodeResultSummary(value: unknown): QaNativeTestSummaryV1 | null {
  if (!isRecord(value)
    || !nonNegativeInteger(value.totalTestCount)
    || !nonNegativeInteger(value.passedTests)
    || !nonNegativeInteger(value.failedTests)
    || !nonNegativeInteger(value.skippedTests)
    || (value.expectedFailures !== undefined && !nonNegativeInteger(value.expectedFailures))
    || typeof value.result !== 'string') return null;
  const total = Number(value.totalTestCount);
  const passed = Number(value.passedTests) + Number(value.expectedFailures || 0);
  const failed = Number(value.failedTests);
  const skipped = Number(value.skippedTests);
  if (total < 1
    || passed + failed + skipped !== total
    || !['Passed', 'Failed', 'Skipped', 'Expected Failure'].includes(value.result)
    || (['Passed', 'Expected Failure'].includes(value.result) && failed !== 0)
    || (value.result === 'Failed' && failed === 0)) return null;
  return { total, passed, failed, skipped };
}

function xmlInteger(attributes: string, name: string, fallback?: number): number | null {
  const match = new RegExp(`(?:^|\\s)${name}=(?:"([0-9]+)"|'([0-9]+)')`, 'i').exec(attributes);
  if (!match) return fallback === undefined ? null : fallback;
  const value = Number(match[1] || match[2]);
  return nonNegativeInteger(value) ? value : null;
}

/**
 * Parse the bounded JUnit XML files emitted by Android Gradle Plugin connected
 * tests. DTD/entity input and prose-only XML are rejected.
 */
export function parseAndroidJUnitXml(value: string): QaNativeTestSummaryV1 | null {
  if (typeof value !== 'string'
    || value.length < 20
    || value.length > 64 * 1024 * 1024
    || /<!DOCTYPE|<!ENTITY/i.test(value)
    || !/<testcase\b/i.test(value)) return null;
  const suites = [...value.matchAll(/<testsuite\b([^>]*)>/gi)];
  if (suites.length < 1 || suites.length > 100_000) return null;
  let total = 0;
  let failed = 0;
  let skipped = 0;
  for (const suite of suites) {
    const attributes = suite[1] || '';
    const tests = xmlInteger(attributes, 'tests');
    const failures = xmlInteger(attributes, 'failures', 0);
    const errors = xmlInteger(attributes, 'errors', 0);
    const omitted = xmlInteger(attributes, 'skipped', 0);
    const disabled = xmlInteger(attributes, 'disabled', 0);
    if (tests === null
      || failures === null
      || errors === null
      || omitted === null
      || disabled === null
      || failures + errors + omitted + disabled > tests) return null;
    total += tests;
    failed += failures + errors;
    skipped += omitted + disabled;
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(failed) || !Number.isSafeInteger(skipped)) return null;
  }
  if (total < 1) return null;
  return { total, passed: total - failed - skipped, failed, skipped };
}

export function combineNativeSummaries(
  values: readonly QaNativeTestSummaryV1[],
): QaNativeTestSummaryV1 | null {
  if (values.length < 1) return null;
  const summary = values.reduce<QaNativeTestSummaryV1>((out, value) => ({
    total: out.total + value.total,
    passed: out.passed + value.passed,
    failed: out.failed + value.failed,
    skipped: out.skipped + value.skipped,
  }), { total: 0, passed: 0, failed: 0, skipped: 0 });
  return parseNativeSummary(summary);
}

export function createQaNativeEvidence(
  value: Omit<QaNativeEvidenceV1, 'schemaVersion' | 'producer' | 'evidenceHash'>,
): QaNativeEvidenceV1 {
  const canonical = {
    schemaVersion: QA_NATIVE_EVIDENCE_SCHEMA_VERSION,
    producer: 'traffic-one-qa-runner' as const,
    ...value,
  };
  return { ...canonical, evidenceHash: nativeEvidenceHash(canonical) };
}

export function parseQaNativeEvidence(value: unknown): QaNativeEvidenceV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== QA_NATIVE_EVIDENCE_SCHEMA_VERSION
    || value.producer !== 'traffic-one-qa-runner'
    || !safeText(value.runnerVersion, 128)
    || !safeText(value.runId, 128)
    || !SHA256_RE.test(String(value.verificationContractHash))
    || !SHA256_RE.test(String(value.sourceHash))
    || !safeText(value.adapter, 128)
    || !iso(value.startedAt)
    || !iso(value.generatedAt)
    || !['passed', 'failed', 'blocked-environment'].includes(String(value.status))
    || (value.commandHash !== undefined && !SHA256_RE.test(String(value.commandHash)))
    || (value.parser !== undefined && ![
      'xcode-xcresult-summary-v1',
      'android-junit-xml-v1',
    ].includes(String(value.parser)))
    || (value.blockerSummary !== undefined && !safeText(value.blockerSummary, 500))
    || !SHA256_RE.test(String(value.evidenceHash))) return null;
  const summary = value.summary === undefined ? undefined : parseNativeSummary(value.summary);
  const artifacts = value.artifacts === undefined
    ? undefined
    : Array.isArray(value.artifacts) && value.artifacts.length <= 25_000
      ? value.artifacts.map(parseNativeArtifact)
      : null;
  if ((value.summary !== undefined && !summary)
    || (value.artifacts !== undefined && (!artifacts || artifacts.some((artifact) => !artifact)))
    || (value.status === 'passed' && (
      !value.commandHash
      || !value.parser
      || !summary
      || !artifacts
      || artifacts.length < 1
      || summary.failed !== 0
      || summary.passed < 1
      || value.blockerSummary !== undefined
    ))
    || (value.status === 'blocked-environment' && !safeText(value.blockerSummary, 500))
    || (value.parser === 'xcode-xcresult-summary-v1' && value.adapter !== 'xcode-simulator')
    || (value.parser === 'android-junit-xml-v1' && value.adapter !== 'android-emulator')) return null;
  const candidate: QaNativeEvidenceV1 = {
    schemaVersion: QA_NATIVE_EVIDENCE_SCHEMA_VERSION,
    producer: 'traffic-one-qa-runner',
    runnerVersion: value.runnerVersion,
    runId: value.runId,
    verificationContractHash: value.verificationContractHash as string,
    sourceHash: value.sourceHash as string,
    adapter: value.adapter,
    startedAt: value.startedAt,
    generatedAt: value.generatedAt,
    status: value.status as QaNativeEvidenceV1['status'],
    ...(typeof value.commandHash === 'string' ? { commandHash: value.commandHash } : {}),
    ...(typeof value.parser === 'string'
      ? { parser: value.parser as QaNativeMachineParserV1 }
      : {}),
    ...(summary ? { summary } : {}),
    ...(artifacts ? { artifacts: artifacts as QaNativeArtifactV1[] } : {}),
    ...(typeof value.blockerSummary === 'string' ? { blockerSummary: value.blockerSummary } : {}),
    evidenceHash: value.evidenceHash as string,
  };
  const { evidenceHash, ...withoutHash } = candidate;
  return nativeEvidenceHash(withoutHash) === evidenceHash ? candidate : null;
}

function numericScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value * 100
    : null;
}

function auditNumeric(audits: Rec, names: string[]): number | null {
  for (const name of names) {
    const audit = isRecord(audits[name]) ? audits[name] as Rec : null;
    const value = audit?.numericValue;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

export function readLighthouseArtifact(filePath: string): LighthouseArtifactSummaryV1 | null {
  let buffer: Buffer;
  let parsed: unknown;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 100 || stat.size > 128 * 1024 * 1024) return null;
    buffer = fs.readFileSync(filePath);
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)
    || !safeText(parsed.lighthouseVersion, 64)
    || !iso(parsed.fetchTime)
    || !safeText(parsed.finalDisplayedUrl || parsed.finalUrl, 2_048)
    || !isRecord(parsed.categories)
    || !isRecord(parsed.audits)) return null;
  const category = (name: string): number | null => {
    const value = isRecord((parsed.categories as Rec)[name])
      ? ((parsed.categories as Rec)[name] as Rec).score
      : null;
    return numericScore(value);
  };
  const performance = category('performance');
  const accessibility = category('accessibility');
  const bestPractices = category('best-practices');
  const seo = category('seo');
  const lcpMs = auditNumeric(parsed.audits, ['largest-contentful-paint']);
  const cls = auditNumeric(parsed.audits, ['cumulative-layout-shift']);
  const inpMs = auditNumeric(parsed.audits, [
    'interaction-to-next-paint',
    'experimental-interaction-to-next-paint',
  ]);
  if (performance === null
    || accessibility === null
    || bestPractices === null
    || seo === null
    || lcpMs === null
    || cls === null) return null;
  return {
    generatedAt: parsed.fetchTime,
    finalUrl: String(parsed.finalDisplayedUrl || parsed.finalUrl),
    performance,
    accessibility,
    bestPractices,
    seo,
    lcpMs,
    cls,
    ...(inpMs === null ? {} : { inpMs }),
    artifactHash: sha256Bytes(buffer),
  };
}

function lighthouseEvidenceHash(
  value: Omit<QaLighthouseEvidenceV1, 'evidenceHash'>,
): string {
  return sha256Bytes(stableJson(value));
}

export function createQaLighthouseEvidence(
  value: Omit<QaLighthouseEvidenceV1, 'schemaVersion' | 'producer' | 'evidenceHash'>,
): QaLighthouseEvidenceV1 {
  const canonical = {
    schemaVersion: QA_LIGHTHOUSE_EVIDENCE_SCHEMA_VERSION,
    producer: 'traffic-one-qa-runner' as const,
    ...value,
  };
  return { ...canonical, evidenceHash: lighthouseEvidenceHash(canonical) };
}

export function parseQaLighthouseEvidence(value: unknown): QaLighthouseEvidenceV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== QA_LIGHTHOUSE_EVIDENCE_SCHEMA_VERSION
    || value.producer !== 'traffic-one-qa-runner'
    || !safeText(value.runId, 128)
    || !SHA256_RE.test(String(value.verificationContractHash))
    || !SHA256_RE.test(String(value.sourceHash))
    || !SHA256_RE.test(String(value.buildHash))
    || !SHA256_RE.test(String(value.buildFingerprint))
    || !iso(value.generatedAt)
    || !safeRelativePath(value.artifactPath)
    || !SHA256_RE.test(String(value.artifactHash))
    || !safeText(value.finalUrl, 2_048)
    || !['performance', 'accessibility', 'bestPractices', 'seo', 'lcpMs', 'cls']
      .every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && Number(value[key]) >= 0)
    || ['performance', 'accessibility', 'bestPractices', 'seo']
      .some((key) => Number(value[key]) > 100)
    || (value.inpMs !== undefined
      && (typeof value.inpMs !== 'number' || !Number.isFinite(value.inpMs) || value.inpMs < 0))
    || !SHA256_RE.test(String(value.evidenceHash))) return null;
  const candidate = value as unknown as QaLighthouseEvidenceV1;
  const { evidenceHash, ...withoutHash } = candidate;
  return lighthouseEvidenceHash(withoutHash) === evidenceHash ? candidate : null;
}
