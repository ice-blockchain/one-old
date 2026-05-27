'use strict';

const fs = require('fs');
const path = require('path');
const { computeProjectFingerprint } = require('./computeProjectFingerprint.cjs');
const {
  DEFAULT_REPORT_DIR,
  nowIso,
  createReporter,
  scanExternalTools,
  scanProject,
  writeReports,
  stampState,
} = require('./_helpers.cjs');

function runSecurityCheck(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const reportDir = path.resolve(cwd, options.reportDir || DEFAULT_REPORT_DIR);
  const generatedAt = nowIso();
  const reporter = createReporter();
  const report = {
    generatedAt,
    status: 'passed',
    strict: Boolean(options.strict),
    cwd,
    fingerprint: computeProjectFingerprint(cwd),
    tools: {},
    externalReports: {},
    issues: reporter.issues,
  };
  report.addIssue = reporter.addIssue;

  fs.mkdirSync(reportDir, { recursive: true });
  scanExternalTools(cwd, reportDir, report);
  scanProject(cwd, report);

  const highCount = report.issues.filter((issue) => issue.severity === 'high').length;
  if (options.strict && highCount > 0) {
    report.status = 'failed';
  }
  delete report.addIssue;

  const paths = writeReports(cwd, reportDir, report);
  if (options.stamp && report.status === 'passed') {
    stampState(cwd, report, paths.relativeJsonPath);
  }

  return { report, paths, exitCode: report.status === 'passed' ? 0 : 1 };
}

module.exports = { runSecurityCheck };
