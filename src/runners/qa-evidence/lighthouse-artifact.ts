// src/runners/qa-evidence/lighthouse-artifact.ts
// Raw-artifact conversion shared by `lighthouse --artifact` and stack attach.
//
// Browser reports that carry `build.url` keep the owned-listener (L130) checks
// in lighthouse.ts. Stack reports have no served listener; this module writes
// evidence that still pins contract hash, source hash, and the artifact in the
// run QA directory. Score thresholds stay with validateQaReportV2.

import * as fs from 'fs';
import * as path from 'path';
import { writeJson } from '../../shared/fsjson';
import {
  createQaLighthouseEvidence,
  readLighthouseArtifact,
  type LighthouseArtifactSummaryV1,
} from '../../shared/qa-evidence-runtime';
import {
  expectedBuildFingerprint,
  PERFORMANCE_GATE_ID,
  type QaReportV2,
} from '../../shared/qa-report-v2';
import { type VerificationContractV2 } from '../../shared/verification-contract';

import {
  outputPath,
  qaDir,
  safeProjectRelative,
  strictRelative,
} from './run-context';
import { stackReportStatus } from './stack';
import { type RunnerArgs } from './types';

export function stackLighthouseBuildIdentity(
  runId: string,
  sourceHash: string,
): { buildHash: string; buildFingerprint: string } {
  // Schema requires 64-hex build fields. validateLighthouseEvidence does not
  // compare them when !browserRequired. Pin them to this run's source identity
  // so two conversions of the same artifact stay byte-stable.
  return {
    buildHash: sourceHash,
    buildFingerprint: expectedBuildFingerprint(runId, sourceHash, sourceHash),
  };
}

export type ResolvedLighthouseArtifact =
  | {
    ok: true;
    summary: LighthouseArtifactSummaryV1;
    safeArtifactRel: string;
    evidenceOut: { absolute: string; relative: string };
  }
  | { ok: false; code: number; message: string };

export function resolveLighthouseArtifact(args: RunnerArgs): ResolvedLighthouseArtifact {
  if (!args.artifact) {
    return { ok: false, code: 2, message: '--artifact is required for Lighthouse conversion.' };
  }
  const rel = safeProjectRelative(args.projectRoot, args.artifact);
  const out = outputPath(args, 'lighthouse-evidence-v1.json');
  if (!rel || !out) {
    return { ok: false, code: 2, message: 'Lighthouse artifact/output path is unsafe.' };
  }
  const artifactAbsolute = path.join(args.projectRoot, rel);
  const qaRoot = qaDir(args.projectRoot, args.runId);
  const artifactRel = path.relative(qaRoot, artifactAbsolute).replace(/\\/g, '/');
  const safeArtifactRel = strictRelative(artifactRel);
  let realArtifact = '';
  try {
    const realQa = fs.realpathSync(qaRoot);
    realArtifact = fs.realpathSync(artifactAbsolute);
    const boundary = path.relative(realQa, realArtifact);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) throw new Error('outside QA root');
  } catch {
    // handled by the common unsafe-artifact response below
  }
  if (!safeArtifactRel || !realArtifact) {
    return { ok: false, code: 2, message: 'raw Lighthouse JSON must be inside this run QA directory.' };
  }
  const summary = readLighthouseArtifact(realArtifact);
  if (!summary) {
    return {
      ok: false,
      code: 1,
      message: 'raw Lighthouse JSON is incomplete or lacks the four standard categories.',
    };
  }
  if (Date.parse(summary.generatedAt) > Date.now() + 1_000) {
    return { ok: false, code: 1, message: 'raw Lighthouse JSON has a future fetchTime.' };
  }
  return { ok: true, summary, safeArtifactRel, evidenceOut: out };
}

export function writeConvertedLighthouseEvidence(
  resolved: Extract<ResolvedLighthouseArtifact, { ok: true }>,
  identity: {
    runId: string;
    verificationContractHash: string;
    sourceHash: string;
    buildHash: string;
    buildFingerprint: string;
  },
): string | null {
  const { summary, safeArtifactRel, evidenceOut } = resolved;
  const evidence = createQaLighthouseEvidence({
    runId: identity.runId,
    verificationContractHash: identity.verificationContractHash,
    sourceHash: identity.sourceHash,
    buildHash: identity.buildHash,
    buildFingerprint: identity.buildFingerprint,
    generatedAt: summary.generatedAt,
    artifactPath: safeArtifactRel,
    artifactHash: summary.artifactHash,
    finalUrl: summary.finalUrl,
    performance: summary.performance,
    accessibility: summary.accessibility,
    bestPractices: summary.bestPractices,
    seo: summary.seo,
    lcpMs: summary.lcpMs,
    cls: summary.cls,
    ...(summary.inpMs === undefined ? {} : { inpMs: summary.inpMs }),
    ...(summary.fcpMs === undefined ? {} : { fcpMs: summary.fcpMs }),
    ...(summary.tbtMs === undefined ? {} : { tbtMs: summary.tbtMs }),
  });
  if (!writeJson(evidenceOut.absolute, evidence)) return null;
  return evidenceOut.relative;
}

export function attachStackLighthouseFromArtifact(
  args: RunnerArgs,
  loaded: { contract: VerificationContractV2; sourceHash: string },
):
  | { ok: true; lighthouse: NonNullable<QaReportV2['lighthouse']> }
  | { ok: false; code: number; message: string } {
  const resolved = resolveLighthouseArtifact(args);
  if (!resolved.ok) return resolved;
  const evidencePath = writeConvertedLighthouseEvidence(resolved, {
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    sourceHash: loaded.sourceHash,
    ...stackLighthouseBuildIdentity(args.runId, loaded.sourceHash),
  });
  if (!evidencePath) {
    return { ok: false, code: 1, message: 'could not persist converted Lighthouse evidence — the write was refused.' };
  }
  return { ok: true, lighthouse: { evidencePath } };
}

export function parentRunnerReportMismatch(
  report: QaReportV2 | undefined,
  loaded: { contract: VerificationContractV2; sourceHash: string },
  runId: string,
): boolean {
  return !report
    || report.producer !== 'parent-runner'
    || report.runId !== runId
    || report.verificationContractHash !== loaded.contract.contractHash
    || report.sourceHash !== loaded.sourceHash;
}

/**
 * A stack report that failed validation for a missing performance budget is
 * rewritten to `status: failed` with a `performance-budget` gate. Attaching
 * new Lighthouse evidence must drop that gate and restore the check-derived
 * status, or the persisted gate would settle the follow-up as failed forever.
 */
export function stackLighthouseReportUpdate(
  report: QaReportV2,
  evidencePath: string,
  summaryGeneratedAt: string,
): QaReportV2 {
  const gates = (report.gates || []).filter((gate) => gate.id !== PERFORMANCE_GATE_ID);
  const updated: QaReportV2 = {
    ...report,
    generatedAt: new Date(Math.max(Date.now(), Date.parse(summaryGeneratedAt))).toISOString(),
    lighthouse: { evidencePath },
    status: stackReportStatus(report.checks),
  };
  if (gates.length > 0) updated.gates = gates;
  else delete updated.gates;
  return updated;
}

export function stackLighthouseFollowUpHint(runId: string): string {
  const artifact = `.traffic-one/reports/qa/${runId}/lighthouse.raw.json`;
  return `place a lighthouse-runner --skip-build JSON at ${artifact} and run `
    + `\`qa-evidence lighthouse --run-id ${runId} --artifact ${artifact}\` (no --build-dir)`;
}
