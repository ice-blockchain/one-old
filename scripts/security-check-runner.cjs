#!/usr/bin/env node
'use strict';

const os = require('os');
const { computeProjectFingerprint } = require('./security-check-runner/computeProjectFingerprint.cjs');
const { missingToolInstallPrompt } = require('./security-check-runner/missingToolInstallPrompt.cjs');
const { runSecurityCheck } = require('./security-check-runner/runSecurityCheck.cjs');
const { parseAuditJson } = require('./security-check-runner/parseAuditJson.cjs');
const { parseArgs, helpText } = require('./security-check-runner/_helpers.cjs');

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  const { report, paths, exitCode } = runSecurityCheck(options);
  const highCount = report.issues.filter((issue) => issue.severity === 'high').length;
  const warningCount = report.issues.length - highCount;
  process.stdout.write([
    `Traffic One security check: ${report.status.toUpperCase()}`,
    `Report: ${paths.relativeMarkdownPath}`,
    `Fingerprint: ${report.fingerprint.fingerprint}`,
    `High findings: ${highCount}`,
    `Warnings: ${warningCount}`,
  ].join('\n'));
  process.stdout.write(os.EOL);
  if (report.installPrompt) {
    process.stdout.write(os.EOL);
    process.stdout.write(report.installPrompt);
    process.stdout.write(os.EOL);
  }
  return exitCode;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  computeProjectFingerprint,
  missingToolInstallPrompt,
  runSecurityCheck,
  parseAuditJson,
};
