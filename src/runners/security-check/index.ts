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
  const { report, paths, exitCode, stamped } = runSecurityCheck(options);
  const highCount = report.issues.filter((issue) => issue.severity === 'high').length;
  const warningCount = report.issues.length - highCount;
  process.stdout.write([
    // A refused stamp is NOT a passing run: the deploy-gate reads the stamp out
    // of `.one.json`, so `PASSED` here plus no stamp there is the contradiction
    // the shipper role cannot resolve. Say which one happened.
    `Traffic One security check: ${stamped === false ? 'FAILED (scan passed, stamp NOT written)' : report.status.toUpperCase()}`,
    `Report: ${paths.relativeMarkdownPath}`,
    `Fingerprint: ${report.fingerprint.fingerprint}`,
    `High findings: ${highCount}`,
    `Warnings: ${warningCount}`,
    ...(stamped === false
      ? ['Stamp: REFUSED — the write to .traffic-one/.one.json did not land, so the deploy gate will '
        + 'deny for a missing security stamp. Answer this project\'s "use Traffic One here?" question '
        + 'if it is still pending, and check that .traffic-one/.one.json is not a symbolic link.']
      : []),
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
