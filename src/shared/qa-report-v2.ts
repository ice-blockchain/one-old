// QaReportV2 is a sidecar so runtime 1.0.19 can ignore it safely. The V2
// verifier is driven by VerificationContractV2 instead of a fixed browser matrix.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { stableContractJson } from './architecture-contract';
import { writeJson } from './fsjson';
import {
  combineNativeSummaries,
  computeBuildOutputManifest,
  contentHash,
  decodeImageFile,
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
} from './qa-evidence-runtime';
import { sha256 } from './text';
import {
  currentVerificationSourceHash,
  readVerificationContract,
  type LighthouseThresholdsV1,
  type VerificationContractV2,
} from './verification-contract';

export const QA_REPORT_V2_SCHEMA_VERSION = 2 as const;
export const QA_BUILD_IDENTITY_PROBE_PATH = '/.traffic-one/qa-build-identity.json';
export const QA_ACCEPTANCE_ATTESTATION_SCHEMA_VERSION = 1 as const;

export type QaV2Status = 'passed' | 'failed' | 'blocked-environment';

export interface QaV2Check {
  id: string;
  status: 'passed' | 'failed' | 'not-applicable';
  summary?: string;
}

export interface QaBuildIdentityV2 {
  runId: string;
  sourceHash: string;
  outputRoot: string;
  buildHash: string;
  pid: number;
  port: number;
  startedAt: string;
  url: string;
  fingerprint: string;
  servedFingerprint: string;
}

interface QaServedBuildIdentityV1 {
  schemaVersion: 1;
  runId: string;
  sourceHash: string;
  buildHash: string;
  pid: number;
  port: number;
  startedAt: string;
  url: string;
  fingerprint: string;
}

export interface QaViewportV2 {
  width: number;
  status: 'passed' | 'failed';
  domAssertionsPassed: boolean;
  actionsPassed: boolean;
  routingPassed: boolean;
  hydrationPassed: boolean;
  consoleErrors: string[];
  networkErrors: string[];
  artifactAt: string;
  screenshotPath?: string;
}

export interface QaRouteV2 {
  route: string;
  viewports: QaViewportV2[];
}

export interface NativeQaEvidenceV2 {
  evidencePath: string;
}

export interface LighthouseEvidenceV2 {
  evidencePath: string;
}

export interface QaReportV2 {
  schemaVersion: typeof QA_REPORT_V2_SCHEMA_VERSION;
  runId: string;
  verificationContractHash: string;
  generatedAt: string;
  producer: 'senior-tester' | 'parent-runner';
  status: QaV2Status;
  sourceHash: string;
  checks: QaV2Check[];
  routes: QaRouteV2[];
  machineEvidencePath?: string;
  build?: QaBuildIdentityV2;
  native?: NativeQaEvidenceV2;
  lighthouse?: LighthouseEvidenceV2;
  blockerSummary?: string;
}

export interface QaAcceptanceAttestationV1 {
  schemaVersion: typeof QA_ACCEPTANCE_ATTESTATION_SCHEMA_VERSION;
  runId: string;
  verificationContractHash: string;
  sourceHash: string;
  reportHash: string;
  evidenceHash: string;
  buildFingerprint: string;
  acceptedAt: string;
  attestationHash: string;
}

export type QaV2FailureCode =
  | 'contract-missing'
  | 'report-missing'
  | 'invalid-json'
  | 'invalid-schema'
  | 'contract-mismatch'
  | 'source-mismatch'
  | 'scan-incomplete'
  | 'required-check-failed'
  | 'blocked-environment'
  | 'build-identity-invalid'
  | 'machine-evidence-invalid'
  | 'route-matrix-incomplete'
  | 'functional-failure'
  | 'screenshot-invalid'
  | 'native-evidence-invalid'
  | 'lighthouse-threshold-failed';

export interface QaV2ValidationAccepted {
  ok: true;
  report: QaReportV2;
  contract: VerificationContractV2;
  reportPath: string;
  advisories: string[];
}

export interface QaV2ValidationRejected {
  ok: false;
  code: QaV2FailureCode;
  message: string;
  reportPath: string;
  report?: QaReportV2;
  contract?: VerificationContractV2;
}

export type QaV2ValidationResult = QaV2ValidationAccepted | QaV2ValidationRejected;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]{1,500}$/;
const BUILD_START_TOLERANCE_MS = 1_000;
const HTTP_PROBE_TIMEOUT_MS = 1_000;
const HTTP_PROBE_MAX_BYTES = 16 * 1024;
const HTTP_PROBE_SOURCE = String.raw`
const target = new URL(process.argv[1]);
const client = require(target.protocol === 'https:' ? 'https' : 'http');
let settled = false;
function fail() {
  if (settled) return;
  settled = true;
  process.exitCode = 2;
}
const request = client.get(target, {
  agent: false,
  headers: { accept: 'application/json', connection: 'close' },
  rejectUnauthorized: false,
}, (response) => {
  if (response.statusCode !== 200) {
    response.resume();
    fail();
    return;
  }
  const chunks = [];
  let bytes = 0;
  response.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > ${HTTP_PROBE_MAX_BYTES}) {
      request.destroy();
      fail();
      return;
    }
    chunks.push(chunk);
  });
  response.on('end', () => {
    if (settled) return;
    settled = true;
    process.stdout.write(Buffer.concat(chunks).toString('utf8'));
  });
  response.on('error', fail);
});
request.setTimeout(${HTTP_PROBE_TIMEOUT_MS}, () => request.destroy());
request.on('error', fail);
`;

export function qaReportV2Path(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'reports', 'qa', runId, 'report-v2.json');
}

export function qaAcceptanceAttestationPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'runs', runId, 'qa-acceptance-v1.json');
}

export function expectedBuildFingerprint(runId: string, sourceHash: string, buildHash: string): string {
  return sha256(`${runId}\0${sourceHash}\0${buildHash}`);
}

function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeString(value: unknown, max = 500): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && SAFE_TEXT_RE.test(value);
}

function safeRelativePath(value: unknown, max = 4_096): value is string {
  return safeString(value, max)
    && !path.isAbsolute(value)
    && !value.includes('\\')
    && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value)
    && !/[*?[\]{};]/.test(value)
    && !value.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length <= 2_000)) return null;
  return [...value] as string[];
}

function parseCheck(value: unknown): QaV2Check | null {
  if (!isRecord(value) || !safeString(value.id, 160)) return null;
  if (!['passed', 'failed', 'not-applicable'].includes(String(value.status))) return null;
  if (value.summary !== undefined && !safeString(value.summary)) return null;
  return {
    id: value.id,
    status: value.status as QaV2Check['status'],
    ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
  };
}

function parseViewport(value: unknown): QaViewportV2 | null {
  if (!isRecord(value)
    || !Number.isInteger(value.width)
    || Number(value.width) < 240
    || Number(value.width) > 4_000
    || !['passed', 'failed'].includes(String(value.status))
    || typeof value.domAssertionsPassed !== 'boolean'
    || typeof value.actionsPassed !== 'boolean'
    || typeof value.routingPassed !== 'boolean'
    || typeof value.hydrationPassed !== 'boolean'
    || isoMs(value.artifactAt) === null) return null;
  const consoleErrors = stringArray(value.consoleErrors);
  const networkErrors = stringArray(value.networkErrors);
  if (!consoleErrors || !networkErrors) return null;
  if (value.screenshotPath !== undefined && !safeRelativePath(value.screenshotPath)) return null;
  return {
    width: Number(value.width),
    status: value.status as QaViewportV2['status'],
    domAssertionsPassed: value.domAssertionsPassed,
    actionsPassed: value.actionsPassed,
    routingPassed: value.routingPassed,
    hydrationPassed: value.hydrationPassed,
    consoleErrors,
    networkErrors,
    artifactAt: value.artifactAt as string,
    ...(typeof value.screenshotPath === 'string' ? { screenshotPath: value.screenshotPath } : {}),
  };
}

function parseRoute(value: unknown): QaRouteV2 | null {
  // Evidence is keyed by the CONTRACT route, so `*` (the router-idiomatic
  // catch-all) is a legal identity here even though it is never a URL — the
  // runner probes it through a concrete `startPath`.
  if (!isRecord(value)
    || !safeString(value.route, 2_048)
    || !(value.route === '*' || value.route.startsWith('/'))
    || !Array.isArray(value.viewports)) return null;
  const viewports = value.viewports.map(parseViewport);
  if (viewports.some((viewport) => !viewport)) return null;
  return { route: value.route, viewports: viewports as QaViewportV2[] };
}

function parseBuild(value: unknown): QaBuildIdentityV2 | null {
  if (!isRecord(value)
    || !safeString(value.runId, 128)
    || !/^[a-f0-9]{64}$/.test(String(value.sourceHash))
    || !safeRelativePath(value.outputRoot)
    || !/^[a-f0-9]{64}$/.test(String(value.buildHash))
    || !Number.isSafeInteger(value.pid)
    || Number(value.pid) <= 0
    || !Number.isSafeInteger(value.port)
    || Number(value.port) < 1
    || Number(value.port) > 65_535
    || isoMs(value.startedAt) === null
    || !safeString(value.url, 2_048)
    || !/^[a-f0-9]{64}$/.test(String(value.fingerprint))
    || !/^[a-f0-9]{64}$/.test(String(value.servedFingerprint))) return null;
  return value as unknown as QaBuildIdentityV2;
}

function parseServedBuild(value: unknown): QaServedBuildIdentityV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !safeString(value.runId, 128)
    || !/^[a-f0-9]{64}$/.test(String(value.sourceHash))
    || !safeString(value.buildHash, 256)
    || !Number.isSafeInteger(value.pid)
    || Number(value.pid) <= 0
    || !Number.isSafeInteger(value.port)
    || Number(value.port) < 1
    || Number(value.port) > 65_535
    || isoMs(value.startedAt) === null
    || !safeString(value.url, 2_048)
    || !/^[a-f0-9]{64}$/.test(String(value.fingerprint))) return null;
  return value as unknown as QaServedBuildIdentityV1;
}

function parseNative(value: unknown): NativeQaEvidenceV2 | null {
  if (!isRecord(value)
    || Object.keys(value).length !== 1
    || !safeRelativePath(value.evidencePath)) return null;
  return { evidencePath: value.evidencePath };
}

function parseLighthouse(value: unknown): LighthouseEvidenceV2 | null {
  if (!isRecord(value)
    || Object.keys(value).length !== 1
    || !safeRelativePath(value.evidencePath)) return null;
  return { evidencePath: value.evidencePath };
}

function parseReport(value: unknown): QaReportV2 | null {
  if (!isRecord(value)
    || value.schemaVersion !== QA_REPORT_V2_SCHEMA_VERSION
    || !safeString(value.runId, 128)
    || !/^[a-f0-9]{64}$/.test(String(value.verificationContractHash))
    || isoMs(value.generatedAt) === null
    || !['senior-tester', 'parent-runner'].includes(String(value.producer))
    || !['passed', 'failed', 'blocked-environment'].includes(String(value.status))
    || !/^[a-f0-9]{64}$/.test(String(value.sourceHash))
    || !Array.isArray(value.checks)
    || !Array.isArray(value.routes)
    || (value.machineEvidencePath !== undefined && !safeRelativePath(value.machineEvidencePath))
    || (value.blockerSummary !== undefined && !safeString(value.blockerSummary))) return null;
  const checks = value.checks.map(parseCheck);
  const routes = value.routes.map(parseRoute);
  if (checks.some((check) => !check) || routes.some((route) => !route)) return null;
  const build = value.build === undefined ? undefined : parseBuild(value.build);
  const native = value.native === undefined ? undefined : parseNative(value.native);
  const lighthouse = value.lighthouse === undefined ? undefined : parseLighthouse(value.lighthouse);
  if ((value.build !== undefined && !build) || (value.native !== undefined && !native) || (value.lighthouse !== undefined && !lighthouse)) return null;
  return {
    schemaVersion: 2,
    runId: value.runId,
    verificationContractHash: value.verificationContractHash as string,
    generatedAt: value.generatedAt as string,
    producer: value.producer as QaReportV2['producer'],
    status: value.status as QaV2Status,
    sourceHash: value.sourceHash as string,
    checks: checks as QaV2Check[],
    routes: routes as QaRouteV2[],
    ...(typeof value.machineEvidencePath === 'string'
      ? { machineEvidencePath: value.machineEvidencePath }
      : {}),
    ...(build ? { build } : {}),
    ...(native ? { native } : {}),
    ...(lighthouse ? { lighthouse } : {}),
    ...(typeof value.blockerSummary === 'string' ? { blockerSummary: value.blockerSummary } : {}),
  };
}

function inside(candidate: string, boundary: string): boolean {
  const rel = path.relative(boundary, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function qaArtifactAbsolute(
  projectRoot: string,
  runId: string,
  rel: string,
): string | null {
  if (!safeRelativePath(rel)) return null;
  const qaDir = path.resolve(projectRoot, '.traffic-one', 'reports', 'qa', runId);
  const absolute = path.resolve(qaDir, rel);
  if (!inside(absolute, qaDir)) return null;
  try {
    const realProject = fs.realpathSync(projectRoot);
    const realQa = fs.realpathSync(qaDir);
    if (!inside(realQa, realProject) || fs.lstatSync(absolute).isSymbolicLink()) return null;
    const real = fs.realpathSync(absolute);
    return inside(real, realQa) ? real : null;
  } catch {
    return null;
  }
}

function artifactValid(
  projectRoot: string,
  runId: string,
  rel: string,
  minimumMtimeMs: number,
  maximumMtimeMs: number,
  expectedImageWidth?: number,
): boolean {
  const absolute = qaArtifactAbsolute(projectRoot, runId, rel);
  if (!absolute) return false;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile()
      || stat.size <= 0
      || stat.mtimeMs + 1_000 < minimumMtimeMs
      || stat.mtimeMs - 1_000 > maximumMtimeMs) return false;
    if (/\.(?:png|jpe?g|webp)$/i.test(absolute)) {
      const decoded = decodeImageFile(absolute);
      // Canonical Playwright screenshots are PNG. PNG validation inflates the
      // complete pixel stream and checks every chunk CRC, so a header-only or
      // truncated image cannot satisfy visual evidence.
      if (!decoded || (expectedImageWidth !== undefined && (
        decoded.format !== 'png' || decoded.width !== expectedImageWidth
      ))) {
        return false;
      }
    } else if (expectedImageWidth !== undefined) {
      return false;
    }
    if (/\.zip$/i.test(absolute)) {
      const header = Buffer.alloc(4);
      const fd = fs.openSync(absolute, 'r');
      let read = 0;
      try { read = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
      if (read < 4 || header[0] !== 0x50 || header[1] !== 0x4b) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function artifactContentHash(
  projectRoot: string,
  runId: string,
  rel: string,
): string {
  const absolute = qaArtifactAbsolute(projectRoot, runId, rel);
  if (!absolute) return '<invalid>';
  try {
    if (!fs.statSync(absolute).isFile()) return '<invalid>';
    return contentHash(absolute) || '<missing>';
  } catch {
    return '<missing>';
  }
}

function qaEvidenceContentHash(
  projectRoot: string,
  runId: string,
  report: QaReportV2,
): string {
  const machinePath = report.machineEvidencePath
    ? qaArtifactAbsolute(projectRoot, runId, report.machineEvidencePath)
    : null;
  const machine = machinePath
    ? parseQaMachineEvidence(readJsonFile(machinePath))
    : null;
  const lighthousePath = report.lighthouse?.evidencePath
    ? qaArtifactAbsolute(projectRoot, runId, report.lighthouse.evidencePath)
    : null;
  const lighthouse = lighthousePath
    ? parseQaLighthouseEvidence(readJsonFile(lighthousePath))
    : null;
  const nativePath = report.native?.evidencePath
    ? qaArtifactAbsolute(projectRoot, runId, report.native.evidencePath)
    : null;
  const native = nativePath
    ? parseQaNativeEvidence(readJsonFile(nativePath))
    : null;
  const artifactPaths = [
    ...(report.machineEvidencePath ? [report.machineEvidencePath] : []),
    ...(machine
      ? machine.routes.flatMap((route) => route.viewports.flatMap((viewport) => [
          viewport.tracePath,
          ...(viewport.screenshotPath ? [viewport.screenshotPath] : []),
        ]))
      : []),
    ...report.routes.flatMap((route) => (
      route.viewports.flatMap((viewport) => viewport.screenshotPath ? [viewport.screenshotPath] : [])
    )),
    ...(report.native?.evidencePath ? [report.native.evidencePath] : []),
    ...(native?.artifacts?.map((artifact) => artifact.path) || []),
    ...(report.lighthouse?.evidencePath ? [report.lighthouse.evidencePath] : []),
    ...(lighthouse?.artifactPath ? [lighthouse.artifactPath] : []),
  ];
  const artifacts = [...new Set(artifactPaths)]
    .sort()
    .map((artifactPath) => [
      artifactPath,
      artifactContentHash(projectRoot, runId, artifactPath),
    ]);
  const observedBuildHash = report.build
    ? computeBuildOutputManifest(projectRoot, report.build.outputRoot)?.manifestHash || '<invalid>'
    : '<not-required>';
  return sha256(stableContractJson({
    report: qaReportV2ContentHash(report),
    artifacts,
    observedBuildHash,
  }));
}

function attestationHash(value: Omit<QaAcceptanceAttestationV1, 'attestationHash'>): string {
  return sha256(stableContractJson(value));
}

function readAcceptanceAttestation(
  projectRoot: string,
  runId: string,
): QaAcceptanceAttestationV1 | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(qaAcceptanceAttestationPath(projectRoot, runId), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value)
    || value.schemaVersion !== QA_ACCEPTANCE_ATTESTATION_SCHEMA_VERSION
    || value.runId !== runId
    || !/^[a-f0-9]{64}$/.test(String(value.verificationContractHash))
    || !/^[a-f0-9]{64}$/.test(String(value.sourceHash))
    || !/^[a-f0-9]{64}$/.test(String(value.reportHash))
    || !/^[a-f0-9]{64}$/.test(String(value.evidenceHash))
    || !/^[a-f0-9]{64}$/.test(String(value.buildFingerprint))
    || isoMs(value.acceptedAt) === null
    || !/^[a-f0-9]{64}$/.test(String(value.attestationHash))) return null;
  const candidate = value as unknown as QaAcceptanceAttestationV1;
  const { attestationHash: observed, ...withoutHash } = candidate;
  return attestationHash(withoutHash) === observed ? candidate : null;
}

function acceptanceAttests(
  projectRoot: string,
  runId: string,
  report: QaReportV2,
  contract: VerificationContractV2,
  sourceHash: string,
): boolean {
  const accepted = readAcceptanceAttestation(projectRoot, runId);
  return Boolean(accepted
    && report.build
    && accepted.verificationContractHash === contract.contractHash
    && accepted.sourceHash === sourceHash
    && accepted.reportHash === qaReportV2ContentHash(report)
    && accepted.evidenceHash === qaEvidenceContentHash(projectRoot, runId, report)
    && accepted.buildFingerprint === report.build.fingerprint);
}

function writeAcceptanceAttestation(
  projectRoot: string,
  runId: string,
  report: QaReportV2,
  contract: VerificationContractV2,
  sourceHash: string,
): boolean {
  if (!report.build) return false;
  const withoutHash = {
    schemaVersion: QA_ACCEPTANCE_ATTESTATION_SCHEMA_VERSION,
    runId,
    verificationContractHash: contract.contractHash,
    sourceHash,
    reportHash: qaReportV2ContentHash(report),
    evidenceHash: qaEvidenceContentHash(projectRoot, runId, report),
    buildFingerprint: report.build.fingerprint,
    acceptedAt: new Date().toISOString(),
  };
  try {
    writeJson(qaAcceptanceAttestationPath(projectRoot, runId), {
      ...withoutHash,
      attestationHash: attestationHash(withoutHash),
    });
    return acceptanceAttests(projectRoot, runId, report, contract, sourceHash);
  } catch {
    return false;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
}

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function probeServedBuild(buildUrl: URL): QaServedBuildIdentityV1 | null {
  const probeUrl = new URL(QA_BUILD_IDENTITY_PROBE_PATH, buildUrl);
  const result = spawnSync(process.execPath, ['-e', HTTP_PROBE_SOURCE, probeUrl.href], {
    encoding: 'utf8',
    timeout: HTTP_PROBE_TIMEOUT_MS + 500,
    maxBuffer: HTTP_PROBE_MAX_BYTES + 1_024,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (result.status !== 0 || result.error || !result.stdout) return null;
  try {
    return parseServedBuild(JSON.parse(result.stdout));
  } catch {
    return null;
  }
}

function validateBuild(
  report: QaReportV2,
  contract: VerificationContractV2,
  sourceHash: string,
  projectRoot: string,
  machineEvidence?: QaMachineEvidenceV1 | null,
): string | null {
  const build = report.build;
  if (!build) return 'build identity is required';
  if (build.runId !== report.runId || build.sourceHash !== sourceHash) return 'build identity run/source hash mismatch';
  const manifest = computeBuildOutputManifest(projectRoot, build.outputRoot);
  if (!manifest) return 'build output manifest is missing, unsafe, empty, or incomplete';
  if (manifest.manifestHash !== build.buildHash) {
    return 'build hash does not match the runtime-computed output manifest';
  }
  const expected = expectedBuildFingerprint(report.runId, sourceHash, build.buildHash);
  if (build.fingerprint !== expected || build.servedFingerprint !== expected) return 'served build fingerprint mismatch';
  let url: URL;
  try { url = new URL(build.url); } catch { return 'build URL is invalid'; }
  if (!['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
    || url.username
    || url.password
    || url.hash
    || Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== build.port) {
    return 'build URL is not the recorded local server/port';
  }
  const startedAt = Date.parse(build.startedAt);
  const baselineAt = Math.max(
    Date.parse(contract.baseline.capturedAt),
    Date.parse(contract.generatedAt),
  );
  const reportAt = Date.parse(report.generatedAt);
  if (startedAt < baselineAt || startedAt > reportAt) return 'server start time is stale or after the report';
  // The bundled runner owns the listener, serves/spawns it after computing the
  // build manifest, records Playwright traces, and proves at least one response
  // body belongs to that manifest. It normally tears the listener down before
  // the tester writes report-v2, so its hash-valid evidence is the durable
  // server/port attestation. Non-browser Lighthouse-only flows retain the live
  // probe below.
  if (machineEvidence) return null;
  if (!processExists(build.pid)) return 'recorded build PID does not exist';

  const served = probeServedBuild(url);
  if (!served) return `build URL did not serve ${QA_BUILD_IDENTITY_PROBE_PATH}`;
  if (served.runId !== report.runId
    || served.sourceHash !== sourceHash
    || served.buildHash !== build.buildHash) {
    return 'served build run/source/build hash mismatch';
  }
  if (served.pid !== build.pid) return 'served build PID does not match the recorded process';
  if (served.port !== build.port
    || normalizedUrl(served.url) !== normalizedUrl(build.url)) {
    return 'served build URL/port mismatch';
  }
  if (Math.abs(Date.parse(served.startedAt) - startedAt) > BUILD_START_TOLERANCE_MS) {
    return 'served build start time does not match the recorded process';
  }
  if (served.fingerprint !== expected || build.servedFingerprint !== served.fingerprint) {
    return 'served build fingerprint mismatch';
  }
  return null;
}

function viewportPassed(viewport: QaViewportV2): boolean {
  return viewport.status === 'passed'
    && viewport.domAssertionsPassed
    && viewport.actionsPassed
    && viewport.routingPassed
    && viewport.hydrationPassed
    && viewport.consoleErrors.length === 0
    && viewport.networkErrors.length === 0;
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
    && JSON.stringify(machine.networkErrors) === JSON.stringify(report.networkErrors);
}

function validateMachineEvidence(
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
      if (!viewportPassed(viewport)
        || !artifactValid(
          projectRoot,
          report.runId,
          viewport.tracePath,
          Date.parse(viewport.artifactAt),
          Date.parse(report.generatedAt),
        )
        || artifactContentHash(projectRoot, report.runId, viewport.tracePath) !== viewport.traceHash) {
        return { evidence, error: `${route.route} width ${viewport.width} has failed or invalid Playwright trace evidence` };
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

function validateNativeEvidence(
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
        return parseAndroidJUnitXml(fs.readFileSync(absoluteArtifact, 'utf8'));
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

function validateLighthouseEvidence(
  report: QaReportV2,
  contract: VerificationContractV2,
  sourceHash: string,
  projectRoot: string,
  machineEvidence?: QaMachineEvidenceV1 | null,
): { evidence: QaLighthouseEvidenceV1 | null; error: string | null } {
  if (!report.lighthouse) return { evidence: null, error: 'Required Lighthouse evidence is missing.' };
  const absolute = qaArtifactAbsolute(projectRoot, report.runId, report.lighthouse.evidencePath);
  const evidence = absolute ? parseQaLighthouseEvidence(readJsonFile(absolute)) : null;
  const build = report.build;
  if (!absolute || !evidence) {
    return { evidence: null, error: 'Lighthouse evidence sidecar is missing, outside the run QA directory, or hash-invalid.' };
  }
  if (!build
    || evidence.runId !== report.runId
    || evidence.verificationContractHash !== contract.contractHash
    || evidence.sourceHash !== sourceHash
    || evidence.buildHash !== build.buildHash
    || evidence.buildFingerprint !== build.fingerprint) {
    return { evidence, error: 'Lighthouse run/source/contract/build identity mismatch.' };
  }
  const generatedAt = Date.parse(evidence.generatedAt);
  if (generatedAt < Date.parse(build.startedAt)
    || generatedAt > Date.now() + 1_000
    || generatedAt > Date.parse(report.generatedAt)
    || !artifactValid(
      projectRoot,
      report.runId,
      report.lighthouse.evidencePath,
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
    if (finalUrl.origin !== new URL(build.url).origin) {
      return { evidence, error: 'Lighthouse artifact belongs to a different served build origin or port.' };
    }
  } catch {
    return { evidence, error: 'Lighthouse artifact final URL is invalid.' };
  }
  return { evidence, error: null };
}

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
): QaV2ValidationRejected {
  return { ok: false, code, message, reportPath: qaReportV2Path(projectRoot, runId), ...(report ? { report } : {}), ...(contract ? { contract } : {}) };
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
    if (check?.status !== 'passed' && !justifiedNoDom) {
      return reject(projectRoot, runId, 'required-check-failed', `Required check ${required} did not pass.`, report, contract);
    }
  }
  if (report.checks.some((check) => check.status === 'failed') || report.status === 'failed') {
    return reject(projectRoot, runId, 'functional-failure', 'QA report contains a failed check.', report, contract);
  }

  const requiresBuildIdentity = contract.buildIdentityRequired
    || contract.performance.required
    || Boolean(report.lighthouse);
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
    const exactFailures = thresholdFailures(lighthouseEvidence, contract.performance.explicitThresholds || {}, 0);
    if (exactFailures.length > 0) {
      return reject(projectRoot, runId, 'lighthouse-threshold-failed', exactFailures.join('; '), report, contract);
    }
  } else if (report.lighthouse) {
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
    );
  }
  return { ok: true, report, contract, reportPath: qaReportV2Path(projectRoot, runId), advisories };
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

export function qaReportV2ContentHash(report: QaReportV2): string {
  return sha256(stableContractJson(report));
}
