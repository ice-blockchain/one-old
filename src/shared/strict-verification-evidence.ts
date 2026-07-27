// Dependency-light terminal verification used by canonical settlement.
// Deliberately does not import state/run-agent (which itself projects into the
// settlement sidecar), avoiding a lifecycle import cycle.

import * as fs from 'fs';
import * as path from 'path';

import { readJson } from './fsjson';
import { readQaReportV1 } from './qa-report';
import { readQaReportV2 } from './qa-report-v2';
import { readVerificationContract } from './verification-contract';

export interface StrictVerificationEvidence {
  ok: boolean;
  incompleteChecks: string[];
  evidenceKind: 'v2' | 'v1' | 'legacy';
  verificationContractHash?: string;
  qaReportPath?: string;
}

const VERDICT_TOKENS = /\b(PLAN_READY|IMPLEMENTED|BLOCKED|APPROVED|CHANGES_REQUESTED|TESTS_GREEN|TESTS_FAILING|DELEGATED_OK|SHIPPED|FAILED)\b/g;

function safeRunId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
}

interface DigestEvidence {
  verdict: string | null;
  newestMtimeMs: number;
}

function exactVerdict(text: string): string | null {
  const verdicts: string[] = [];
  for (const match of text.matchAll(/^[ \t]*verdict[ \t]*:[ \t]*([A-Z][A-Z_-]*)\b([^\n]*)$/gim)) {
    const token = match[1]?.toUpperCase();
    if (!token) continue;
    const conflict = [...String(match[2] || '').toUpperCase().matchAll(VERDICT_TOKENS)]
      .some((candidate) => candidate[1] !== token);
    if (conflict) return null;
    verdicts.push(token);
  }
  return verdicts.length > 0 && verdicts.every((verdict) => verdict === verdicts[0])
    ? verdicts[0]!
    : null;
}

function digestEvidence(
  projectRoot: string,
  runId: string,
  role: 'reviewer' | 'tester',
): DigestEvidence {
  const root = path.join(projectRoot, '.traffic-one', 'digests', safeRunId(runId));
  const verdicts: string[] = [];
  let newestMtimeMs = 0;
  for (const name of [`${role}.md`, `senior-${role}.md`]) {
    const file = path.join(root, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size <= 0) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (!text.trim()) continue;
      const verdict = exactVerdict(text);
      if (!verdict) return { verdict: null, newestMtimeMs: Math.floor(stat.mtimeMs) };
      verdicts.push(verdict);
      newestMtimeMs = Math.max(newestMtimeMs, Math.floor(stat.mtimeMs));
    } catch {
      // The sibling canonical spelling may still exist.
    }
  }
  return {
    verdict: verdicts.length > 0 && verdicts.every((verdict) => verdict === verdicts[0])
      ? verdicts[0]!
      : null,
    newestMtimeMs,
  };
}

function digestHasContent(
  projectRoot: string,
  runId: string,
  role: 'frontend' | 'backend',
): { present: boolean; newestMtimeMs: number } {
  const root = path.join(projectRoot, '.traffic-one', 'digests', safeRunId(runId));
  let present = false;
  let newestMtimeMs = 0;
  for (const name of [`${role}.md`, `senior-${role}.md`]) {
    try {
      const stat = fs.statSync(path.join(root, name));
      if (!stat.isFile() || stat.size <= 0) continue;
      present = true;
      newestMtimeMs = Math.max(newestMtimeMs, Math.floor(stat.mtimeMs));
    } catch {
      // sibling spelling may exist
    }
  }
  return { present, newestMtimeMs };
}

function timestampMs(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function strictRunVerificationEvidence(
  projectRoot: string,
  runId: string,
): StrictVerificationEvidence {
  const incomplete = new Set<string>();
  const contract = readVerificationContract(projectRoot, runId);
  const ledger = readJson<Record<string, unknown> | null>(
    path.join(projectRoot, '.traffic-one', 'runs', safeRunId(runId), 'run.json'),
    null,
  );
  const evidenceKind: StrictVerificationEvidence['evidenceKind'] = contract || ledger?.qaContractVersion === 2
    ? 'v2'
    : ledger?.qaContractVersion === 1
      ? 'v1'
      : 'legacy';
  if (evidenceKind === 'v2' && !contract) incomplete.add('verification-contract-missing-or-invalid');

  const reviewer = digestEvidence(projectRoot, runId, 'reviewer');
  if (reviewer.verdict !== 'APPROVED') incomplete.add('reviewer-approval-missing');

  const tester = digestEvidence(projectRoot, runId, 'tester');
  const testerPassed = tester.verdict === 'TESTS_GREEN'
    || (evidenceKind === 'legacy' && tester.verdict === 'APPROVED');
  if (!testerPassed) incomplete.add('tester-verdict-missing');

  let qaReportPath: string | undefined;
  if (evidenceKind === 'v2') {
    const qa = contract ? readQaReportV2(projectRoot, runId) : null;
    if (!qa?.ok) {
      incomplete.add('qa-verification-incomplete');
    } else {
      qaReportPath = qa.reportPath;
      let reportMtimeMs = 0;
      try { reportMtimeMs = Math.floor(fs.statSync(qa.reportPath).mtimeMs); } catch { /* fail below */ }
      if (reportMtimeMs <= 0 || tester.newestMtimeMs < reportMtimeMs) {
        incomplete.add('tester-qa-attestation-stale');
      }
    }
  } else {
    const frontend = digestHasContent(projectRoot, runId, 'frontend');
    if (frontend.present && evidenceKind === 'v1') {
      const freshnessFloorMs = Math.max(
        timestampMs(ledger?.createdAt),
        timestampMs(ledger?.qaContractActivatedAt),
        frontend.newestMtimeMs,
      );
      const qa = readQaReportV1(projectRoot, runId, {
        ...(freshnessFloorMs > 0 ? { minimumGeneratedAtMs: freshnessFloorMs } : {}),
      });
      if (!qa.ok) {
        incomplete.add('qa-verification-incomplete');
      } else {
        qaReportPath = qa.reportPath;
        let reportMtimeMs = 0;
        try { reportMtimeMs = Math.floor(fs.statSync(qa.reportPath).mtimeMs); } catch { /* fail below */ }
        if (reportMtimeMs <= 0 || tester.newestMtimeMs < reportMtimeMs) {
          incomplete.add('tester-qa-attestation-stale');
        }
      }
    } else if (frontend.present) {
      const legacyReport = path.join(
        projectRoot,
        '.traffic-one',
        'reports',
        'qa',
        safeRunId(runId),
        'report.json',
      );
      try {
        if (!fs.statSync(legacyReport).isFile() || fs.statSync(legacyReport).size <= 0) {
          incomplete.add('qa-verification-incomplete');
        } else {
          qaReportPath = legacyReport;
        }
      } catch {
        incomplete.add('qa-verification-incomplete');
      }
    }
  }

  const incompleteChecks = [...incomplete].sort();
  return {
    ok: incompleteChecks.length === 0,
    incompleteChecks,
    evidenceKind,
    ...(contract ? { verificationContractHash: contract.contractHash } : {}),
    ...(qaReportPath ? { qaReportPath } : {}),
  };
}
