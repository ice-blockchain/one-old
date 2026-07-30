// src/shared/qa-report-v2-schema.ts
// QaReportV2 schema: versions, every V2 interface, bounds, and the strict
// field parsers. Runtime validation lives in the siblings; the public surface
// is re-exported by qa-report-v2.ts.

import * as path from 'path';
import { sha256 } from '../text';
import {
  type VerificationContractV2,
} from '../verification-contract';

const QA_REPORT_V2_SCHEMA_VERSION = 2 as const;
export const QA_BUILD_IDENTITY_PROBE_PATH = '/.traffic-one/qa-build-identity.json';
export const QA_ACCEPTANCE_ATTESTATION_SCHEMA_VERSION = 1 as const;

type QaV2Status = 'passed' | 'failed' | 'blocked-environment';

interface QaV2Check {
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

export interface QaServedBuildIdentityV1 {
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
  // Playwright step/navigation failures (timeouts, unreachable locators).
  // Optional and absent on pre-1.0.37 reports; absent means []. Kept separate
  // from consoleErrors so a click timeout is not misread as a page error.
  actionErrors?: string[];
  artifactAt: string;
  screenshotPath?: string;
}

interface QaRouteV2 {
  route: string;
  viewports: QaViewportV2[];
}

interface NativeQaEvidenceV2 {
  evidencePath: string;
}

// Either a real evidence sidecar, or an explicit skip record: when the
// browser scenario fails, Lighthouse is not attempted — the report must SAY
// so instead of silently omitting the section (observed 8co: a
// performance-required run ended with no performance evidence and no trace of
// why). A skip record never satisfies `performance.required`.
interface LighthouseEvidenceV2 {
  evidencePath?: string;
  status?: 'skipped-scenario-failed';
  reason?: string;
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

export type QaDimensionStatus = 'passed' | 'failed' | 'advisory-warning' | 'not-required' | 'unknown';

/**
 * The QA verdict, split by what actually failed. Derived — never producer-
 * written — so the tester and the final gate cannot report contradictory
 * statuses for the same run.
 */
export interface QaDimensionsV1 {
  functionalQaStatus: QaDimensionStatus;
  accessibilityStatus: QaDimensionStatus;
  responsiveStatus: QaDimensionStatus;
  lighthouseStatus: QaDimensionStatus;
  overallStatus: 'passed' | 'failed';
}

interface QaV2ValidationAccepted {
  ok: true;
  report: QaReportV2;
  contract: VerificationContractV2;
  reportPath: string;
  advisories: string[];
  dimensions: QaDimensionsV1;
}

export interface QaV2ValidationRejected {
  ok: false;
  code: QaV2FailureCode;
  message: string;
  reportPath: string;
  report?: QaReportV2;
  contract?: VerificationContractV2;
  dimensions: QaDimensionsV1;
}

export type QaV2ValidationResult = QaV2ValidationAccepted | QaV2ValidationRejected;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]{1,500}$/;
export const BUILD_START_TOLERANCE_MS = 1_000;

export function qaReportV2Path(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'reports', 'qa', runId, 'report-v2.json');
}

export function qaAcceptanceAttestationPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'runs', runId, 'qa-acceptance-v1.json');
}

export function expectedBuildFingerprint(runId: string, sourceHash: string, buildHash: string): string {
  return sha256(`${runId}\0${sourceHash}\0${buildHash}`);
}

export function isoMs(value: unknown): number | null {
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

export function safeRelativePath(value: unknown, max = 4_096): value is string {
  return safeString(value, max)
    && !path.isAbsolute(value)
    && !value.includes('\\')
    && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value)
    && !/[*?[\]{};]/.test(value)
    && !value.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
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
  const actionErrors = value.actionErrors === undefined ? undefined : stringArray(value.actionErrors);
  if (value.actionErrors !== undefined && !actionErrors) return null;
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
    ...(actionErrors ? { actionErrors } : {}),
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

export function parseServedBuild(value: unknown): QaServedBuildIdentityV1 | null {
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
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !['evidencePath', 'status', 'reason'].includes(key))) return null;
  const hasPath = value.evidencePath !== undefined;
  const hasStatus = value.status !== undefined;
  if (!hasPath && !hasStatus) return null;
  if (hasPath && !safeRelativePath(value.evidencePath)) return null;
  if (hasStatus && value.status !== 'skipped-scenario-failed') return null;
  if (value.reason !== undefined && (!hasStatus || !safeString(value.reason))) return null;
  return {
    ...(hasPath ? { evidencePath: value.evidencePath as string } : {}),
    ...(hasStatus ? { status: 'skipped-scenario-failed' as const } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  };
}

export function parseReport(value: unknown): QaReportV2 | null {
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
