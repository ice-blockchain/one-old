// src/test-environment/reporting/aggregate-report.ts
// Renders results.md + results.json from all case runs.

import * as fs from 'fs';
import * as path from 'path';

import type { AssertionStatus, CaseRunResult, RootTestConfig } from '../core/types';

const STATUS_ICON: Record<AssertionStatus, string> = {
  PASS: '✅', FAIL: '❌', SKIP: '⏭️', INCONCLUSIVE: '❓',
};

export interface ReportSummary {
  total: number;
  pass: number;
  fail: number;
  skip: number;
  inconclusive: number;
  reportPath: string;
}

export function writeReport(results: CaseRunResult[], config: RootTestConfig, startedAt: string, runDir: string): ReportSummary {
  let pass = 0; let fail = 0; let skip = 0; let inconclusive = 0; let total = 0;
  for (const r of results) {
    for (const a of r.assertions) {
      total++;
      if (a.status === 'PASS') pass++;
      else if (a.status === 'FAIL') fail++;
      else if (a.status === 'SKIP') skip++;
      else inconclusive++;
    }
  }

  const lines: string[] = [];
  lines.push('# Traffic One — Test Environment Report');
  lines.push('');
  lines.push(`- Started: ${startedAt}`);
  lines.push(`- Finished: ${new Date().toISOString()}`);
  lines.push(`- Hosts: ${config.enabledHosts.join(', ')} · Host-E2E: ${config.includeHostE2E ? 'on' : 'off (pure-node only)'}`);
  lines.push(`- Cases run: ${results.length}`);
  lines.push(`- Assertions: ${total} — ${STATUS_ICON.PASS} ${pass} · ${STATUS_ICON.FAIL} ${fail} · ${STATUS_ICON.SKIP} ${skip} · ${STATUS_ICON.INCONCLUSIVE} ${inconclusive}`);
  lines.push('');

  lines.push('## Matrix');
  lines.push('');
  lines.push('| Case | Category | Target | Host run | Assertions (P/F/S/I) |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of results) {
    const p = r.assertions.filter((a) => a.status === 'PASS').length;
    const f = r.assertions.filter((a) => a.status === 'FAIL').length;
    const s = r.assertions.filter((a) => a.status === 'SKIP').length;
    const i = r.assertions.filter((a) => a.status === 'INCONCLUSIVE').length;
    const host = r.host === 'pure-node' ? '—' : `${r.hostResult.status}`;
    lines.push(`| ${r.caseId} | ${r.category} | ${r.host} | ${host} | ${p}/${f}/${s}/${i} |`);
  }
  lines.push('');

  lines.push('## Details');
  lines.push('');
  for (const r of results) {
    lines.push(`### ${r.caseId} — ${r.host}`);
    if (r.host !== 'pure-node') {
      lines.push(`Host run: **${r.hostResult.status}** (exit ${r.hostResult.exitCode}, ${r.hostResult.durationMs}ms)${r.hostResult.skippedReason ? ` — ${r.hostResult.skippedReason}` : ''}`);
      if (r.hostResult.command) lines.push('`' + r.hostResult.command + '`');
    }
    for (const a of r.assertions) {
      lines.push(`- ${STATUS_ICON[a.status]} **${a.id}** — ${a.title}`);
      const detail = a.detail.split('\n').map((d) => `  > ${d}`).join('\n');
      if (detail.trim()) lines.push(detail);
    }
    lines.push('');
  }

  fs.mkdirSync(runDir, { recursive: true });
  const reportPath = path.join(runDir, 'results.md');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify({ startedAt, summary: { total, pass, fail, skip, inconclusive }, results }, null, 2), 'utf8');

  return { total, pass, fail, skip, inconclusive, reportPath };
}
