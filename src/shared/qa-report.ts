// Strict, machine-verifiable functional QA evidence for Traffic One build runs.
// Lighthouse output is deliberately outside this contract: it is performance
// evidence, not proof that the required route/viewport matrix is functional.

import * as fs from 'fs';
import * as path from 'path';

export const QA_CONTRACT_VERSION = 1 as const;
export const QA_REQUIRED_WIDTHS = [390, 768, 1440] as const;

export type QaRequiredWidth = (typeof QA_REQUIRED_WIDTHS)[number];
export type QaReportProducer = 'senior-tester' | 'parent-browser';
export type QaBlockerCode = 'browser-unavailable' | 'sandbox' | 'usage-limit' | 'timeout';
export type QaReportStatus =
  | 'passed'
  | 'failed'
  | `blocked:${QaBlockerCode}`;
export type QaPrimaryActionStatus = 'reachable' | 'unreachable' | 'not-applicable';

export interface QaPrimaryActionResult {
  status: QaPrimaryActionStatus;
  /** Required when status is `not-applicable`; otherwise optional context. */
  reason?: string;
}

export interface QaViewportResult {
  width: QaRequiredWidth;
  status: QaReportStatus;
  consoleErrorCount: number;
  documentOverflow: boolean;
  elementOverflow: boolean;
  primaryAction: QaPrimaryActionResult;
  /** Relative to this run's QA directory, project-relative, or absolute. */
  screenshotPath?: string;
}

export interface QaRouteResult {
  route: string;
  viewports: QaViewportResult[];
}

export interface QaBlocker {
  code: QaBlockerCode;
  /** A short, single-line, user-safe explanation; never raw tool output. */
  summary: string;
}

export interface QaReportV1 {
  schemaVersion: typeof QA_CONTRACT_VERSION;
  runId: string;
  generatedAt: string;
  producer: QaReportProducer;
  status: QaReportStatus;
  routes: QaRouteResult[];
  blocker?: QaBlocker;
  /**
   * Identity of the build the sweep actually loaded OVER HTTP: the entry-asset
   * filename referenced by the served HTML (Vite `index-<hash>.js`) or the Next
   * `BUILD_ID`. Every other freshness check here is temporal, so a sweep run
   * against a leftover preview server on a shared port passes them all — observed
   * live (cursor-17c: port 4173 was still held by the PREVIOUS project's preview
   * and 21/21 checks passed against a different application). This is the only
   * field that answers "which app answered?".
   */
  verifiedBuild?: string;
}

export type QaReportFailureCode =
  | 'invalid-run-id'
  | 'report-missing'
  | 'report-unreadable'
  | 'invalid-json'
  | 'invalid-schema'
  | 'run-id-mismatch'
  | 'stale-report'
  | 'future-report'
  | 'missing-viewport'
  | 'invalid-screenshot'
  | 'report-failed'
  | 'report-blocked'
  | 'matrix-not-passed';

export interface QaReportAccepted {
  ok: true;
  code?: never;
  message?: never;
  report: QaReportV1;
  reportPath: string;
}

export interface QaReportRejected {
  ok: false;
  code: QaReportFailureCode;
  message: string;
  reportPath: string;
  /**
   * Present only after schema, run identity, freshness, viewport coverage, and
   * status consistency have passed. This prevents callers from treating raw
   * blocker text from an otherwise invalid report as a browser bridge signal.
   */
  report?: QaReportV1;
  status?: QaReportStatus;
  blockerCode?: QaBlockerCode;
  browserBridgeEligible?: true;
}

export type QaReportValidationResult = QaReportAccepted | QaReportRejected;

export interface QaReportValidationOptions {
  /** Override the clock for deterministic callers/tests. Defaults to Date.now(). */
  nowMs?: number;
  /** Reject evidence generated before this instant. Numeric run ids are used by default. */
  minimumGeneratedAtMs?: number;
  /**
   * Trusted filesystem write-time for the canonical report. readQaReportV1
   * supplies this itself; it disambiguates a whole-second generatedAt at a
   * millisecond contract boundary without weakening older-report rejection.
   */
  reportMtimeMs?: number;
  /** Optional additional freshness window measured back from nowMs. */
  maxAgeMs?: number;
  /** Future clock skew tolerated before a report is rejected. Defaults to five minutes. */
  maxFutureSkewMs?: number;
}

const PRODUCERS = new Set<QaReportProducer>(['senior-tester', 'parent-browser']);
const BLOCKER_CODES = new Set<QaBlockerCode>([
  'browser-unavailable',
  'sandbox',
  'usage-limit',
  'timeout',
]);
const REPORT_STATUSES = new Set<QaReportStatus>([
  'passed',
  'failed',
  'blocked:browser-unavailable',
  'blocked:sandbox',
  'blocked:usage-limit',
  'blocked:timeout',
]);
const PRIMARY_ACTION_STATUSES = new Set<QaPrimaryActionStatus>([
  'reachable',
  'unreachable',
  'not-applicable',
]);
const REQUIRED_SCREENSHOT_WIDTHS = new Set<QaRequiredWidth>([390, 1440]);
const ISO_UTC_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_SAFE_SUMMARY_LENGTH = 500;
const MAX_PRIMARY_ACTION_REASON_LENGTH = 300;
const MAX_ROUTE_LENGTH = 2048;
const MAX_VERIFIED_BUILD_LENGTH = 200;
const MAX_ROUTES = 100;
const DEFAULT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const OBVIOUS_CREDENTIAL_ASSIGNMENT_RE = /(?:^|[^A-Za-z0-9_-])(?:[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?(?:key|token)|auth[_-]?token|authorization|client[_-]?secret|password|passwd|secret|service[_-]?role[_-]?key|token)[A-Za-z0-9_-]*)\s*[:=]\s*(?:"[^"]+"|'[^']+'|[^\s,;}\]]+)/i;
const BEARER_CREDENTIAL_RE = /\bbearer\s+(?=[A-Za-z0-9._~+/=-]{8,}(?:$|[\s,;)}\]]))(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]+/i;
const KNOWN_TOKEN_PREFIX_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collects the first failing field path so invalid-schema rejections can name it. */
interface SchemaFailure {
  path: string;
}

function schemaFail(failure: SchemaFailure, path: string): null {
  if (!failure.path) failure.path = path;
  return null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isCleanBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isMachineSafeSummary(value: unknown): value is string {
  return isCleanBoundedText(value, MAX_SAFE_SUMMARY_LENGTH)
    && !OBVIOUS_CREDENTIAL_ASSIGNMENT_RE.test(value)
    && !BEARER_CREDENTIAL_RE.test(value)
    && !KNOWN_TOKEN_PREFIX_RE.test(value);
}

function isSafeRunId(runId: string): boolean {
  return runId.length > 0
    && runId.length <= 128
    && runId !== '.'
    && runId !== '..'
    && !runId.includes('/')
    && !runId.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(runId);
}

export function qaReportDirectory(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'reports', 'qa', runId);
}

export function qaReportPath(projectRoot: string, runId: string): string {
  return path.join(qaReportDirectory(projectRoot, runId), 'report.json');
}

function rejection(
  projectRoot: string,
  runId: string,
  code: QaReportFailureCode,
  message: string,
  report?: QaReportV1,
  bridgePrerequisitesPassed = false,
): QaReportRejected {
  const status = report?.status;
  const browserBridgeEligible = bridgePrerequisitesPassed
    && report?.producer === 'senior-tester'
    && status === 'blocked:browser-unavailable'
    && report.blocker?.code === 'browser-unavailable';
  return {
    ok: false,
    code,
    message,
    reportPath: qaReportPath(projectRoot, runId),
    ...(report ? { report, status } : {}),
    ...(report?.blocker ? { blockerCode: report.blocker.code } : {}),
    ...(browserBridgeEligible ? { browserBridgeEligible: true as const } : {}),
  };
}

/**
 * True only for a senior-tester browser blocker that passed schema, run-id,
 * timestamp, viewport-coverage, and status-consistency validation. The report
 * itself remains rejected functional evidence until the parent replaces it.
 */
export function isQaBrowserBridgeEligible(result: QaReportValidationResult): boolean {
  return !result.ok && result.browserBridgeEligible === true;
}

function parseCanonicalInstant(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_UTC_INSTANT_RE.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  // Milliseconds are optional: a second-precision instant is canonical when its
  // millisecond expansion round-trips, so calendar rollovers still reject.
  const canonical = new Date(parsed).toISOString();
  return canonical === value || canonical === value.replace(/Z$/, '.000Z') ? parsed : null;
}

function parsePrimaryAction(value: unknown, at: string, failure: SchemaFailure): QaPrimaryActionResult | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['status', 'reason'])) return schemaFail(failure, at);
  if (typeof value.status !== 'string' || !PRIMARY_ACTION_STATUSES.has(value.status as QaPrimaryActionStatus)) {
    return schemaFail(failure, `${at}.status`);
  }
  if (value.reason !== undefined && !isCleanBoundedText(value.reason, MAX_PRIMARY_ACTION_REASON_LENGTH)) {
    return schemaFail(failure, `${at}.reason`);
  }
  if (value.status === 'not-applicable' && !isCleanBoundedText(value.reason, MAX_PRIMARY_ACTION_REASON_LENGTH)) {
    return schemaFail(failure, `${at}.reason`);
  }
  return {
    status: value.status as QaPrimaryActionStatus,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  };
}

function parseViewport(value: unknown, at: string, failure: SchemaFailure): QaViewportResult | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'width',
    'status',
    'consoleErrorCount',
    'documentOverflow',
    'elementOverflow',
    'primaryAction',
    'screenshotPath',
  ])) return schemaFail(failure, at);

  if (!QA_REQUIRED_WIDTHS.includes(value.width as QaRequiredWidth)) return schemaFail(failure, `${at}.width`);
  if (typeof value.status !== 'string' || !REPORT_STATUSES.has(value.status as QaReportStatus)) return schemaFail(failure, `${at}.status`);
  if (!Number.isSafeInteger(value.consoleErrorCount) || Number(value.consoleErrorCount) < 0) return schemaFail(failure, `${at}.consoleErrorCount`);
  if (typeof value.documentOverflow !== 'boolean' || typeof value.elementOverflow !== 'boolean') return schemaFail(failure, `${at}.documentOverflow/elementOverflow`);
  const primaryAction = parsePrimaryAction(value.primaryAction, `${at}.primaryAction`, failure);
  if (!primaryAction) return null;
  if (value.screenshotPath !== undefined && !isCleanBoundedText(value.screenshotPath, 4096)) return schemaFail(failure, `${at}.screenshotPath`);

  return {
    width: value.width as QaRequiredWidth,
    status: value.status as QaReportStatus,
    consoleErrorCount: Number(value.consoleErrorCount),
    documentOverflow: value.documentOverflow,
    elementOverflow: value.elementOverflow,
    primaryAction,
    ...(typeof value.screenshotPath === 'string' ? { screenshotPath: value.screenshotPath } : {}),
  };
}

function parseRoute(value: unknown, at: string, failure: SchemaFailure): QaRouteResult | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['route', 'viewports'])) return schemaFail(failure, at);
  if (!isCleanBoundedText(value.route, MAX_ROUTE_LENGTH) || !value.route.startsWith('/')) return schemaFail(failure, `${at}.route`);
  if (!Array.isArray(value.viewports) || value.viewports.length === 0) return schemaFail(failure, `${at}.viewports`);
  const viewports: QaViewportResult[] = [];
  for (const [index, rawViewport] of value.viewports.entries()) {
    const viewport = parseViewport(rawViewport, `${at}.viewports[${index}]`, failure);
    if (!viewport) return null;
    viewports.push(viewport);
  }
  return { route: value.route, viewports };
}

function parseBlocker(value: unknown, failure: SchemaFailure): QaBlocker | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['code', 'summary'])) return schemaFail(failure, 'blocker');
  if (typeof value.code !== 'string' || !BLOCKER_CODES.has(value.code as QaBlockerCode)) return schemaFail(failure, 'blocker.code');
  if (!isMachineSafeSummary(value.summary)) return schemaFail(failure, 'blocker.summary');
  return { code: value.code as QaBlockerCode, summary: value.summary };
}

function parseReport(value: unknown, failure: SchemaFailure): QaReportV1 | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'schemaVersion',
    'runId',
    'generatedAt',
    'producer',
    'status',
    'routes',
    'blocker',
    'verifiedBuild',
  ])) return schemaFail(failure, '(top-level keys)');
  if (value.schemaVersion !== QA_CONTRACT_VERSION) return schemaFail(failure, 'schemaVersion');
  if (typeof value.runId !== 'string' || !isSafeRunId(value.runId)) return schemaFail(failure, 'runId');
  if (parseCanonicalInstant(value.generatedAt) === null) return schemaFail(failure, 'generatedAt');
  if (typeof value.producer !== 'string' || !PRODUCERS.has(value.producer as QaReportProducer)) return schemaFail(failure, 'producer');
  if (value.verifiedBuild !== undefined && !isCleanBoundedText(value.verifiedBuild, MAX_VERIFIED_BUILD_LENGTH)) return schemaFail(failure, 'verifiedBuild');
  if (typeof value.status !== 'string' || !REPORT_STATUSES.has(value.status as QaReportStatus)) return schemaFail(failure, 'status');
  if (!Array.isArray(value.routes) || value.routes.length === 0 || value.routes.length > MAX_ROUTES) return schemaFail(failure, 'routes');

  const routes: QaRouteResult[] = [];
  for (const [index, rawRoute] of value.routes.entries()) {
    const route = parseRoute(rawRoute, `routes[${index}]`, failure);
    if (!route) return null;
    routes.push(route);
  }

  const blocker = value.blocker === undefined ? undefined : parseBlocker(value.blocker, failure);
  if (value.blocker !== undefined && !blocker) return null;
  const status = value.status as QaReportStatus;
  if (status.startsWith('blocked:')) {
    const expectedCode = status.slice('blocked:'.length) as QaBlockerCode;
    if (!blocker || blocker.code !== expectedCode) return schemaFail(failure, 'blocker (must match blocked:* status)');
  } else if (blocker !== undefined) {
    return schemaFail(failure, 'blocker (only allowed with blocked:* status)');
  }

  return {
    schemaVersion: QA_CONTRACT_VERSION,
    runId: value.runId,
    generatedAt: value.generatedAt as string,
    producer: value.producer as QaReportProducer,
    status,
    routes,
    ...(blocker ? { blocker } : {}),
    ...(typeof value.verifiedBuild === 'string' ? { verifiedBuild: value.verifiedBuild } : {}),
  };
}

function isInside(candidate: string, boundary: string): boolean {
  const relative = path.relative(boundary, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function screenshotAbsolutePath(projectRoot: string, qaDirectory: string, screenshotPath: string): string {
  if (path.isAbsolute(screenshotPath)) return path.resolve(screenshotPath);
  const normalized = screenshotPath.replace(/\\/g, '/');
  if (normalized === '.traffic-one' || normalized.startsWith('.traffic-one/')) {
    return path.resolve(projectRoot, normalized);
  }
  return path.resolve(qaDirectory, screenshotPath);
}

function screenshotExistsInsideQaDirectory(
  projectRoot: string,
  qaDirectory: string,
  screenshotPath: string,
): boolean {
  const candidate = screenshotAbsolutePath(projectRoot, qaDirectory, screenshotPath);
  if (!isInside(candidate, qaDirectory)) return false;
  const extension = path.extname(candidate).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) return false;
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    const realQaDirectory = fs.realpathSync(qaDirectory);
    const realCandidate = fs.realpathSync(candidate);
    if (!isInside(realCandidate, realQaDirectory)) return false;
    const header = Buffer.alloc(12);
    const fd = fs.openSync(realCandidate, 'r');
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const png = bytesRead >= 8
      && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    const webp = bytesRead >= 12
      && header.subarray(0, 4).toString('ascii') === 'RIFF'
      && header.subarray(8, 12).toString('ascii') === 'WEBP';
    return (extension === '.png' && png)
      || ((extension === '.jpg' || extension === '.jpeg') && jpeg)
      || (extension === '.webp' && webp);
  } catch {
    return false;
  }
}

function inferredRunStartMs(runId: string): number | undefined {
  if (!/^\d{12,16}$/.test(runId)) return undefined;
  const parsed = Number(runId);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function viewportPassingChecks(viewport: QaViewportResult): boolean {
  return viewport.consoleErrorCount === 0
    && !viewport.documentOverflow
    && !viewport.elementOverflow
    && viewport.primaryAction.status !== 'unreachable';
}

function reportStatusesAreConsistent(report: QaReportV1): boolean {
  let matchingNonPassSeen = false;
  for (const route of report.routes) {
    for (const viewport of route.viewports) {
      if (viewport.status === 'passed' && !viewportPassingChecks(viewport)) return false;
      if (report.status === 'passed') {
        if (viewport.status !== 'passed') return false;
        continue;
      }
      if (report.status === 'failed') {
        if (viewport.status !== 'passed' && viewport.status !== 'failed') return false;
        if (viewport.status === 'failed') matchingNonPassSeen = true;
        continue;
      }
      if (viewport.status !== 'passed' && viewport.status !== report.status) return false;
      // A blocked report may describe an unavailable verification surface, but
      // it cannot hide a known console/overflow/action failure behind that
      // blocker. Such a matrix is a real failed result, not a bridge candidate.
      if (!viewportPassingChecks(viewport)) return false;
      if (viewport.status === report.status) matchingNonPassSeen = true;
    }
  }
  return report.status === 'passed' || matchingNonPassSeen;
}

/**
 * Validate a parsed QA report as terminal functional evidence. A well-formed
 * failed or blocked report is still returned in the rejection so orchestration
 * can distinguish a browser bridge candidate from other blockers without ever
 * treating it as passing evidence.
 */
export function validateQaReportV1(
  value: unknown,
  projectRoot: string,
  expectedRunId: string,
  options: QaReportValidationOptions = {},
): QaReportValidationResult {
  if (!isSafeRunId(expectedRunId)) {
    return rejection(projectRoot, expectedRunId, 'invalid-run-id', 'The expected QA run id is not a safe path segment.');
  }
  const failure: SchemaFailure = { path: '' };
  const report = parseReport(value, failure);
  if (!report) {
    const detail = failure.path ? ` (first invalid field: ${failure.path})` : '';
    return rejection(projectRoot, expectedRunId, 'invalid-schema', `QA report does not match QaReportV1${detail}.`);
  }
  if (report.runId !== expectedRunId) {
    return rejection(projectRoot, expectedRunId, 'run-id-mismatch', 'QA report runId does not match the current run.');
  }

  const generatedAtMs = Date.parse(report.generatedAt);
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const minimumGeneratedAtMs = Number.isFinite(options.minimumGeneratedAtMs)
    ? Number(options.minimumGeneratedAtMs)
    : inferredRunStartMs(expectedRunId);
  const reportMtimeMs = Number.isFinite(options.reportMtimeMs) ? Number(options.reportMtimeMs) : undefined;
  const wholeSecondAtFreshnessBoundary = minimumGeneratedAtMs !== undefined
    && generatedAtMs < minimumGeneratedAtMs
    && !/\.\d{3}Z$/.test(report.generatedAt)
    && Math.floor(generatedAtMs / 1000) === Math.floor(minimumGeneratedAtMs / 1000)
    && reportMtimeMs !== undefined
    && reportMtimeMs >= minimumGeneratedAtMs;
  if (minimumGeneratedAtMs !== undefined
    && generatedAtMs < minimumGeneratedAtMs
    && !wholeSecondAtFreshnessBoundary) {
    return rejection(projectRoot, expectedRunId, 'stale-report', 'QA report predates the current run.');
  }
  if (Number.isFinite(options.maxAgeMs) && Number(options.maxAgeMs) >= 0
    && generatedAtMs < nowMs - Number(options.maxAgeMs)) {
    return rejection(projectRoot, expectedRunId, 'stale-report', 'QA report is older than the permitted freshness window.');
  }
  const maxFutureSkewMs = Number.isFinite(options.maxFutureSkewMs) && Number(options.maxFutureSkewMs) >= 0
    ? Number(options.maxFutureSkewMs)
    : DEFAULT_FUTURE_SKEW_MS;
  if (generatedAtMs > nowMs + maxFutureSkewMs) {
    return rejection(projectRoot, expectedRunId, 'future-report', 'QA report timestamp is implausibly far in the future.');
  }

  const qaDirectory = qaReportDirectory(projectRoot, expectedRunId);
  const seenRoutes = new Set<string>();
  for (const route of report.routes) {
    if (seenRoutes.has(route.route)) {
      return rejection(projectRoot, expectedRunId, 'invalid-schema', `QA route ${route.route} is duplicated.`);
    }
    seenRoutes.add(route.route);
    const seenWidths = new Set<QaRequiredWidth>();
    for (const viewport of route.viewports) {
      if (seenWidths.has(viewport.width)) {
        return rejection(
          projectRoot,
          expectedRunId,
          'missing-viewport',
          `QA route ${route.route} contains duplicate width ${viewport.width}.`,
        );
      }
      seenWidths.add(viewport.width);
    }
    for (const width of QA_REQUIRED_WIDTHS) {
      if (!seenWidths.has(width)) {
        return rejection(
          projectRoot,
          expectedRunId,
          'missing-viewport',
          `QA route ${route.route} is missing required width ${width}.`,
        );
      }
    }
  }

  if (!reportStatusesAreConsistent(report)) {
    return rejection(
      projectRoot,
      expectedRunId,
      'matrix-not-passed',
      'QA report top-level and viewport statuses or passing metrics are inconsistent.',
    );
  }

  // Validate every supplied path before recognizing an absent-screenshot
  // browser blocker. A traversal, dangling path, or escaped symlink is not an
  // eligible bridge signal and must not expose parsed blocker metadata.
  for (const route of report.routes) {
    for (const viewport of route.viewports) {
      if (viewport.screenshotPath
        && !screenshotExistsInsideQaDirectory(projectRoot, qaDirectory, viewport.screenshotPath)) {
        return rejection(
          projectRoot,
          expectedRunId,
          'invalid-screenshot',
          `QA route ${route.route} width ${viewport.width} screenshot is missing or outside the run QA directory.`,
        );
      }
    }
  }

  for (const route of report.routes) {
    for (const viewport of route.viewports) {
      const screenshotRequired = REQUIRED_SCREENSHOT_WIDTHS.has(viewport.width);
      if (screenshotRequired && !viewport.screenshotPath) {
        return rejection(
          projectRoot,
          expectedRunId,
          'invalid-screenshot',
          `QA route ${route.route} width ${viewport.width} is missing its required screenshot.`,
          report,
          true,
        );
      }
    }
  }

  if (report.status === 'failed') {
    return rejection(projectRoot, expectedRunId, 'report-failed', 'QA report records a failed overall result.', report);
  }
  if (report.status.startsWith('blocked:')) {
    return rejection(
      projectRoot,
      expectedRunId,
      'report-blocked',
      'QA report records a blocked overall result.',
      report,
      true,
    );
  }

  for (const route of report.routes) {
    for (const viewport of route.viewports) {
      const matrixPassed = viewport.status === 'passed' && viewportPassingChecks(viewport);
      if (!matrixPassed) {
        return rejection(
          projectRoot,
          expectedRunId,
          'matrix-not-passed',
          `QA route ${route.route} width ${viewport.width} did not pass every functional check.`,
          report,
        );
      }
    }
  }

  return { ok: true, report, reportPath: qaReportPath(projectRoot, expectedRunId) };
}

/** Read and validate the canonical report for a run. Missing/malformed input fails closed. */
export function readQaReportV1(
  projectRoot: string,
  expectedRunId: string,
  options: QaReportValidationOptions = {},
): QaReportValidationResult {
  if (!isSafeRunId(expectedRunId)) {
    return rejection(projectRoot, expectedRunId, 'invalid-run-id', 'The expected QA run id is not a safe path segment.');
  }
  const reportPath = qaReportPath(projectRoot, expectedRunId);
  let text: string;
  let reportMtimeMs: number | undefined;
  try {
    text = fs.readFileSync(reportPath, 'utf8');
    const mtime = fs.statSync(reportPath).mtimeMs;
    if (Number.isFinite(mtime)) reportMtimeMs = mtime;
  } catch (error) {
    const code = isRecord(error) && error.code === 'ENOENT' ? 'report-missing' : 'report-unreadable';
    return rejection(
      projectRoot,
      expectedRunId,
      code,
      code === 'report-missing' ? 'Canonical QA report is missing.' : 'Canonical QA report could not be read.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return rejection(projectRoot, expectedRunId, 'invalid-json', 'Canonical QA report is not valid JSON.');
  }
  return validateQaReportV1(value, projectRoot, expectedRunId, {
    ...options,
    ...(reportMtimeMs !== undefined ? { reportMtimeMs } : {}),
  });
}
