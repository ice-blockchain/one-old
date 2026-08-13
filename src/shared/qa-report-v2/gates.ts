// src/shared/qa-report-v2/gates.ts
// Non-browser QA gates: which rejection each one owns, and the durable
// persistence of a rejected verdict into the report artifact itself.
//
// Observed 10co-e2e: `report-v2.json` was persisted `"status":"passed"` with
// nine checks — none of them performance — while the run's verification
// contract declared `performance { required: true, performanceMin: 90,
// lcpMaxMs: 2500 }` and the evidence sitting beside it recorded performance 74
// / LCP 4527ms. Two independent causes:
//
//   1. `reject()` is a PURE function. It computes the verdict and writes
//      nothing, so the runner's optimistic `passed` publication stayed on disk
//      as the only durable record of the run.
//   2. `requiredChecks` is a flat list of BROWSER check ids, so a gate that is
//      not a browser check had no slot in the schema to be reported in.
//
// `QaGateV2` is that slot; `persistGateRejection` closes the write hole. The
// correction is deliberately narrow: it only ever rewrites the sidecar that
// holds the exact report just judged, it only ever moves a verdict from
// optimistic to failed, and it is idempotent — a second identical rejection
// writes nothing.


import { writeJson } from '../fsjson';
import {
  parseReport,
  qaReportV2Path,
  type QaGateV2,
  type QaReportV2,
  type QaV2FailureCode,
  type QaV2ValidationRejected,
} from './schema';
import { readRegularFileOrThrow } from '../bounded-read';

/** The page-speed budget: the gate with no browser check id at all. */
export const PERFORMANCE_GATE_ID = 'performance-budget';

// Only rejections that survive the identity checks (same run, same contract,
// same source) may be written back — a `contract-mismatch` report belongs to
// another build and must never be edited here.
//
// WHICH CODES BELONG HERE IS A RULE, not a list of the ones anybody happened to
// think of: a refusal must persist exactly when the artifact would otherwise be
// left CLAIMING SOMETHING THE VALIDATOR JUST REFUSED. Everything absent below
// is absent for one of two reasons, and both were checked rather than assumed:
//
//   nothing durable to correct — `contract-missing`, `report-missing`,
//     `invalid-json`, and the parse-failure arm of `invalid-schema` all reach
//     `reject()` with no parsed report, so `persistGateRejection` has no
//     identity to match and correctly no-ops.
//   the artifact does not contradict the verdict — `contract-mismatch`,
//     `source-mismatch` and `scan-incomplete` are refusals to VOUCH for a
//     report whose identity is unverified, and editing one is precisely what
//     the identity guard below forbids; `blocked-environment` is a report
//     already saying `blocked-environment` on disk, which no reader mistakes
//     for a pass.
//
// `invalid-schema` is here because ONE of its two arms breaks that rule.
// `report.status === 'blocked-environment'` on a none/nonvisual contract is
// refused with this code while the report has already parsed and matched
// identity, so before this entry existed nothing was written and the sidecar
// kept its own word. Latent — no producer emits that shape today, and
// stackReportStatus explains at length why the stack path must not — but a
// refusal whose only trace is a return value is a class of defect this lane has
// already paid for once (`reject()` being pure is how a `passed` sidecar
// survived a failed performance gate, 10co-e2e), and the cost of closing it is
// one row.
export const GATE_ID_FOR_FAILURE: Partial<Record<QaV2FailureCode, string>> = {
  'invalid-schema': 'report-schema',
  'lighthouse-threshold-failed': PERFORMANCE_GATE_ID,
  'build-identity-invalid': 'build-identity',
  'machine-evidence-invalid': 'machine-evidence',
  'native-evidence-invalid': 'native-evidence',
  'route-matrix-incomplete': 'route-matrix',
  'screenshot-invalid': 'screenshot-freshness',
  'required-check-failed': 'required-checks',
  'functional-failure': 'functional-checks',
};

// Gate summaries live in the report, so they obey the schema's safe-string rule
// (1..500 chars, no control characters). Filtered by char code — no control
// character may appear in this source file either.
export function boundedGateSummary(value: string): string {
  let stripped = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    stripped += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return stripped.replace(/\s+/g, ' ').trim().slice(0, 500)
    || 'Runtime QA evidence did not pass.';
}

export function failedGate(report: QaReportV2 | undefined): QaGateV2 | null {
  return (report?.gates || []).find((gate) => gate.status === 'failed') || null;
}

/**
 * Write the rejected verdict back into the report sidecar.
 *
 * No-op unless the file on disk IS the report that was just judged (same run,
 * contract, source and generation timestamp) — a validation of an in-memory
 * candidate never edits somebody else's artifact.
 */
export function persistGateRejection(
  projectRoot: string,
  runId: string,
  result: QaV2ValidationRejected,
): void {
  const report = result.report;
  const gateId = GATE_ID_FOR_FAILURE[result.code];
  if (!report || !gateId) return;
  const gate: QaGateV2 = {
    id: gateId,
    status: 'failed',
    code: result.code,
    summary: boundedGateSummary(result.message),
  };
  const reportPath = qaReportV2Path(projectRoot, runId);
  let onDisk: QaReportV2 | null = null;
  try {
    onDisk = parseReport(JSON.parse(readRegularFileOrThrow(reportPath)));
  } catch {
    return; // nothing durable to correct
  }
  if (!onDisk
    || onDisk.runId !== report.runId
    || onDisk.verificationContractHash !== report.verificationContractHash
    || onDisk.sourceHash !== report.sourceHash
    || onDisk.generatedAt !== report.generatedAt) return;
  const already = (onDisk.gates || []).some((entry) => (
    entry.id === gate.id
    && entry.status === 'failed'
    && entry.code === gate.code
    && entry.summary === gate.summary
  ));
  if (already && onDisk.status === 'failed') return;
  const corrected: QaReportV2 = {
    ...onDisk,
    status: 'failed',
    gates: [...(onDisk.gates || []).filter((entry) => entry.id !== gate.id), gate],
  };
  try {
    writeJson(reportPath, corrected);
  } catch {
    // Best effort: a read-only or racing artifact directory must never turn a
    // rejection into a crash. The verdict itself is already `ok: false`.
  }
}
