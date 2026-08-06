// src/runners/security-check/run.ts
// Orchestrates the security check: build the report, run external scanners
// (gitleaks/trufflehog) + the in-process scanners, write the JSON+markdown
// reports, optionally stamp passing state. Ported 1:1 from
// scripts/security-check-runner/runSecurityCheck.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { computeProjectFingerprint } from './fingerprint';
import { DEFAULT_REPORT_DIR } from '../../config/security';
import {
  type ReportPaths,
  type Report,
  type ScanReport,
  type SecurityOptions,
  createReporter,
  nowIso,
  scanExternalTools,
  scanProject,
  stampState,
  writeReports,
} from './lib';

export interface SecurityCheckResult {
  report: Report;
  paths: ReportPaths;
  exitCode: number;
  /**
   * Only present when `--stamp` was asked for on a passing report: whether the
   * stamp the deploy-gate reads is actually in `.one.json`. `false` is a FAILED
   * run — the caller asked for a stamp and has none — so it decides the exit code
   * below rather than being reported alongside a `PASSED` headline.
   */
  stamped?: boolean;
}

export function runSecurityCheck(options: Partial<SecurityOptions> = {}): SecurityCheckResult {
  const cwd = path.resolve(options.cwd || process.cwd());
  const reportDir = path.resolve(cwd, options.reportDir || DEFAULT_REPORT_DIR);
  const generatedAt = nowIso();
  const reporter = createReporter();
  const report: ScanReport = {
    generatedAt,
    status: 'passed',
    strict: Boolean(options.strict),
    cwd,
    fingerprint: computeProjectFingerprint(cwd),
    tools: {},
    externalReports: {},
    issues: reporter.issues,
    addIssue: reporter.addIssue,
  };

  fs.mkdirSync(reportDir, { recursive: true });
  scanExternalTools(cwd, reportDir, report);
  scanProject(cwd, report);

  const highCount = report.issues.filter((issue) => issue.severity === 'high').length;
  if (options.strict && highCount > 0) {
    report.status = 'failed';
  }

  // Strip the runtime-only addIssue method before serialization.
  const serializable: Report = {
    generatedAt: report.generatedAt,
    status: report.status,
    strict: report.strict,
    cwd: report.cwd,
    fingerprint: report.fingerprint,
    tools: report.tools,
    externalReports: report.externalReports,
    issues: report.issues,
    ...(report.installPrompt ? { installPrompt: report.installPrompt } : {}),
  };

  const paths = writeReports(cwd, reportDir, serializable);
  const wantsStamp = Boolean(options.stamp) && serializable.status === 'passed';
  const stamped = wantsStamp ? stampState(cwd, serializable, paths.relativeJsonPath) : undefined;

  return {
    report: serializable,
    paths,
    exitCode: serializable.status === 'passed' && stamped !== false ? 0 : 1,
    ...(stamped === undefined ? {} : { stamped }),
  };
}
