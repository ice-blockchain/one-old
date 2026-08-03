// src/test-environment/core/run-sim/qa.ts
// The real qa-evidence runner, invoked in-process. Shared by the main phase
// machine (index.ts) and the maintenance passes/legs (maintenance.ts) so both
// produce evidence through the identical production path.

import { main as qaMain } from '../../../runners/qa-evidence';
import { readQaReportV2 } from '../../../shared/qa-report-v2';
import type { VerificationContractV2 } from '../../../shared/verification-contract';

import { scenarioFor } from './build-output';

export interface QaRunOutcome {
  code: number;
  detail: string;
  checks: Record<string, { status: string; summary: string }>;
}

// Run the real qa-evidence `stack` command in-process and report what it did.
export async function runStackEvidence(cwd: string, runId: string): Promise<QaRunOutcome> {
  const code = await qaMain(
    ['stack', '--run-id', runId, '--project-root', cwd],
    cwd,
  );
  const report = readQaReportV2(cwd, runId);
  const checks: Record<string, { status: string; summary: string }> = {};
  let detail = '';
  if (report.ok) {
    // The SUMMARY is what separates "the project declares no such command"
    // (a legitimate not-applicable) from "the command exists but could not be
    // executed" (an environment gap that must never read as covered).
    for (const check of report.report.checks) {
      checks[check.id] = { status: check.status, summary: check.summary ?? '' };
    }
  } else {
    detail = `${report.code}: ${report.message}`;
  }
  return { code, detail, checks };
}

export async function runBrowserProbe(cwd: string, runId: string): Promise<number> {
  return qaMain(['browser', '--run-id', runId, '--project-root', cwd], cwd);
}

// The real `browser` command: it serves the build dir, launches Chromium, walks
// every changed route, and captures DOM/action/console/network/screenshot
// evidence. Nothing here is simulated except the build artifact itself.
export async function runBrowserEvidence(
  cwd: string,
  runId: string,
  buildDir: string,
  verification: VerificationContractV2,
): Promise<QaRunOutcome> {
  const code = await qaMain([
    'browser',
    '--run-id', runId,
    '--project-root', cwd,
    '--build-dir', buildDir,
    '--scenario-json', JSON.stringify(scenarioFor(verification)),
  ], cwd);
  const report = readQaReportV2(cwd, runId);
  const checks: Record<string, { status: string; summary: string }> = {};
  let detail = '';
  if (report.ok) {
    for (const check of report.report.checks) {
      checks[check.id] = { status: check.status, summary: check.summary ?? '' };
    }
  } else {
    detail = `${report.code}: ${report.message}`;
    for (const check of report.report?.checks ?? []) {
      checks[check.id] = { status: check.status, summary: check.summary ?? '' };
    }
  }
  return { code, detail, checks };
}
