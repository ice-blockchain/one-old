// src/runners/security-check/report.ts
// Report IO: write the JSON + Markdown reports and stamp a passing run into state.
import * as fs from 'fs';
import * as path from 'path';

import { type Rec, type Report } from './constants';
import { relativePath, timestampSlug } from './helpers';
import { legacyStatePath, statePath } from '../../shared/state';
import { pluginVersion } from '../../config/plugin-identity';
import { writeJson } from '../../shared/fsjson';
import {
  preserveCurrentRunId,
  preserveOneMcpReportId,
  withProjectStateLock,
} from '../../shared/state/project-state-lock';

export interface ReportPaths { jsonPath: string; markdownPath: string; relativeJsonPath: string; relativeMarkdownPath: string; }

export function writeReports(cwd: string, reportDir: string, report: Report): ReportPaths {
  fs.mkdirSync(reportDir, { recursive: true });
  const slug = timestampSlug(report.generatedAt);
  const jsonPath = path.join(reportDir, `security-check-${slug}.json`);
  const markdownPath = path.join(reportDir, `security-check-${slug}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, renderMarkdownReport(report), 'utf8');
  return {
    jsonPath,
    markdownPath,
    relativeJsonPath: relativePath(cwd, jsonPath),
    relativeMarkdownPath: relativePath(cwd, markdownPath),
  };
}

export function renderMarkdownReport(report: Report): string {
  const blockers = report.issues.filter((issue) => issue.severity === 'high');
  const warnings = report.issues.filter((issue) => issue.severity !== 'high');
  const lines = [
    '# Traffic One Pre-Deployment Security Check',
    '',
    `Status: ${report.status.toUpperCase()}`,
    `Generated: ${report.generatedAt}`,
    `Fingerprint: ${report.fingerprint.fingerprint}`,
    '',
    `High findings: ${blockers.length}`,
    `Warnings: ${warnings.length}`,
    '',
  ];
  for (const issue of report.issues) {
    const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}` : 'project';
    lines.push(`- [${issue.severity}] ${issue.category} — ${location} — ${issue.message}`);
    if (issue.remediation) {
      lines.push(`  Fix: ${issue.remediation}`);
    }
  }
  if (report.issues.length === 0) {
    lines.push('No findings.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

// Returns whether the stamp is actually ON DISK. `.one.json` is written through
// the fenced chokepoint, and the refusal used to be dropped here: the runner then
// printed `PASSED` and exited 0 while nothing was stamped, and the deploy-gate —
// which reads lastSecurityCheckStatus/Fingerprint straight back out of
// `.one.json` — denied the deploy for a missing stamp. Two components, one fact,
// opposite answers, and the shipper role had no way to tell which was lying.
// The gate's own direction is fail-closed and stays untouched; what was broken is
// that the producer certified a stamp it never landed.
export function stampState(cwd: string, report: Report, relativeReportPath: string): boolean {
  return withProjectStateLock(cwd, () => {
    const nextStatePath = statePath(cwd);
    const oldStatePath = legacyStatePath(cwd);
    let state: Rec = {};
    try {
      const readableStatePath = fs.existsSync(nextStatePath) ? nextStatePath : oldStatePath;
      const parsed = JSON.parse(fs.readFileSync(readableStatePath, 'utf8')) as unknown;
      state = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Rec : {};
    } catch {
      state = {};
    }
    const current = { ...state };
    state.lastSecurityCheckAt = report.generatedAt;
    state.lastSecurityCheckStatus = 'passed';
    state.lastSecurityCheckFingerprint = report.fingerprint.fingerprint;
    state.lastSecurityCheckReport = relativeReportPath;
    delete state.pluginVersion;
    const version = pluginVersion();
    if (version) state.version = version;
    return writeJson(nextStatePath, preserveCurrentRunId(current, preserveOneMcpReportId(current, state)));
  });
}
