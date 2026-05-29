// src/runners/security-check/index.ts
// CLI entry + public surface for the Traffic One pre-deployment security check
// (compiles to scripts/security-check-runner.cjs). Ported 1:1 from
// scripts/security-check-runner.cjs.

import * as os from 'os';

import { helpText, parseArgs } from './lib';
import { runSecurityCheck } from './run';

export { computeProjectFingerprint } from './fingerprint';
export { runSecurityCheck } from './run';
export type { SecurityCheckResult } from './run';
export { missingToolInstallPrompt, parseAuditJson, parseArgs, helpText } from './lib';
export type { Report, Issue, Fingerprint, ScanReport, SecurityOptions } from './lib';

export function main(): number {
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
