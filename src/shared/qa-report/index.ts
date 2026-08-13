// Strict, machine-verifiable functional QA evidence for Traffic One build runs.
// Lighthouse output is deliberately outside this contract: it is performance
// evidence, not proof that the required route/viewport matrix is functional.

import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_FUTURE_SKEW_MS,
  QA_REQUIRED_WIDTHS,
  qaReportDirectory,
  qaReportPath,
  REQUIRED_SCREENSHOT_WIDTHS,
  isRecord,
  isSafeRunId,
  parseReport,
  rejection,
  type SchemaFailure,
  type QaReportV1,
  type QaViewportResult,
  type QaReportValidationOptions,
  type QaReportValidationResult,
  type QaRequiredWidth,
} from './schema';
import { openRegularFd, readRegularFileOrThrow } from '../bounded-read';

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
    const fd = openRegularFd(realCandidate);
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
    text = readRegularFileOrThrow(reportPath);
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

export { QA_REQUIRED_WIDTHS, qaReportDirectory, qaReportPath };
export {
  isQaBrowserBridgeEligible,
  type QaReportStatus,
  type QaReportV1,
  type QaReportValidationOptions,
  type QaReportValidationResult,
  type QaRequiredWidth,
  type QaViewportResult,
} from './schema';
