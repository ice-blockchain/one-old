// src/shared/qa-report-v2-artifacts.ts
// Artifact containment, content hashing, and the acceptance attestation.
// Every hash is recomputed from disk; report booleans are never enough.

import * as fs from 'fs';
import * as path from 'path';
import { stableContractJson } from '../architecture-contract';
import { writeJson } from '../fsjson';
import {
  computeBuildOutputManifest,
  contentHash,
  decodeImageFile,
  parseQaLighthouseEvidence,
  parseQaMachineEvidence,
  parseQaNativeEvidence,
  readJsonFile,
} from '../qa-evidence-runtime';
import { sha256 } from '../text';
import {
  type VerificationContractV2,
} from '../verification-contract';

import {
  QA_ACCEPTANCE_ATTESTATION_SCHEMA_VERSION,
  isRecord,
  isoMs,
  qaAcceptanceAttestationPath,
  safeRelativePath,
  type QaAcceptanceAttestationV1,
  type QaReportV2,
} from './schema';

function inside(candidate: string, boundary: string): boolean {
  const rel = path.relative(boundary, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function qaArtifactAbsolute(
  projectRoot: string,
  runId: string,
  rel: string,
): string | null {
  if (!safeRelativePath(rel)) return null;
  const qaDir = path.resolve(projectRoot, '.traffic-one', 'reports', 'qa', runId);
  const absolute = path.resolve(qaDir, rel);
  if (!inside(absolute, qaDir)) return null;
  try {
    const realProject = fs.realpathSync(projectRoot);
    const realQa = fs.realpathSync(qaDir);
    if (!inside(realQa, realProject) || fs.lstatSync(absolute).isSymbolicLink()) return null;
    const real = fs.realpathSync(absolute);
    return inside(real, realQa) ? real : null;
  } catch {
    return null;
  }
}

export function artifactValid(
  projectRoot: string,
  runId: string,
  rel: string,
  minimumMtimeMs: number,
  maximumMtimeMs: number,
  expectedImageWidth?: number,
): boolean {
  const absolute = qaArtifactAbsolute(projectRoot, runId, rel);
  if (!absolute) return false;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile()
      || stat.size <= 0
      || stat.mtimeMs + 1_000 < minimumMtimeMs
      || stat.mtimeMs - 1_000 > maximumMtimeMs) return false;
    if (/\.(?:png|jpe?g|webp)$/i.test(absolute)) {
      const decoded = decodeImageFile(absolute);
      // Canonical Playwright screenshots are PNG. PNG validation inflates the
      // complete pixel stream and checks every chunk CRC, so a header-only or
      // truncated image cannot satisfy visual evidence.
      if (!decoded || (expectedImageWidth !== undefined && (
        decoded.format !== 'png' || decoded.width !== expectedImageWidth
      ))) {
        return false;
      }
    } else if (expectedImageWidth !== undefined) {
      return false;
    }
    if (/\.zip$/i.test(absolute)) {
      const header = Buffer.alloc(4);
      const fd = fs.openSync(absolute, 'r');
      let read = 0;
      try { read = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
      if (read < 4 || header[0] !== 0x50 || header[1] !== 0x4b) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function artifactContentHash(
  projectRoot: string,
  runId: string,
  rel: string,
): string {
  const absolute = qaArtifactAbsolute(projectRoot, runId, rel);
  if (!absolute) return '<invalid>';
  try {
    if (!fs.statSync(absolute).isFile()) return '<invalid>';
    return contentHash(absolute) || '<missing>';
  } catch {
    return '<missing>';
  }
}

function qaEvidenceContentHash(
  projectRoot: string,
  runId: string,
  report: QaReportV2,
  observedBuildHashOverride?: string,
): string {
  const machinePath = report.machineEvidencePath
    ? qaArtifactAbsolute(projectRoot, runId, report.machineEvidencePath)
    : null;
  const machine = machinePath
    ? parseQaMachineEvidence(readJsonFile(machinePath))
    : null;
  const lighthousePath = report.lighthouse?.evidencePath
    ? qaArtifactAbsolute(projectRoot, runId, report.lighthouse.evidencePath)
    : null;
  const lighthouse = lighthousePath
    ? parseQaLighthouseEvidence(readJsonFile(lighthousePath))
    : null;
  const nativePath = report.native?.evidencePath
    ? qaArtifactAbsolute(projectRoot, runId, report.native.evidencePath)
    : null;
  const native = nativePath
    ? parseQaNativeEvidence(readJsonFile(nativePath))
    : null;
  const artifactPaths = [
    ...(report.machineEvidencePath ? [report.machineEvidencePath] : []),
    ...(machine
      ? machine.routes.flatMap((route) => route.viewports.flatMap((viewport) => [
          ...(viewport.tracePath ? [viewport.tracePath] : []),
          ...(viewport.screenshotPath ? [viewport.screenshotPath] : []),
        ]))
      : []),
    ...report.routes.flatMap((route) => (
      route.viewports.flatMap((viewport) => viewport.screenshotPath ? [viewport.screenshotPath] : [])
    )),
    ...(report.native?.evidencePath ? [report.native.evidencePath] : []),
    ...(native?.artifacts?.map((artifact) => artifact.path) || []),
    ...(report.lighthouse?.evidencePath ? [report.lighthouse.evidencePath] : []),
    ...(lighthouse?.artifactPath ? [lighthouse.artifactPath] : []),
  ];
  const artifacts = [...new Set(artifactPaths)]
    .sort()
    .map((artifactPath) => [
      artifactPath,
      artifactContentHash(projectRoot, runId, artifactPath),
    ]);
  const observedBuildHash = observedBuildHashOverride
    ?? (report.build
      ? computeBuildOutputManifest(projectRoot, report.build.outputRoot)?.manifestHash || '<invalid>'
      : '<not-required>');
  return sha256(stableContractJson({
    report: qaReportV2ContentHash(report),
    artifacts,
    observedBuildHash,
  }));
}

function attestationHash(value: Omit<QaAcceptanceAttestationV1, 'attestationHash'>): string {
  return sha256(stableContractJson(value));
}

function readAcceptanceAttestation(
  projectRoot: string,
  runId: string,
): QaAcceptanceAttestationV1 | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(qaAcceptanceAttestationPath(projectRoot, runId), 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value)
    || value.schemaVersion !== QA_ACCEPTANCE_ATTESTATION_SCHEMA_VERSION
    || value.runId !== runId
    || !/^[a-f0-9]{64}$/.test(String(value.verificationContractHash))
    || !/^[a-f0-9]{64}$/.test(String(value.sourceHash))
    || !/^[a-f0-9]{64}$/.test(String(value.reportHash))
    || !/^[a-f0-9]{64}$/.test(String(value.evidenceHash))
    || !/^[a-f0-9]{64}$/.test(String(value.buildFingerprint))
    || isoMs(value.acceptedAt) === null
    || !/^[a-f0-9]{64}$/.test(String(value.attestationHash))) return null;
  const candidate = value as unknown as QaAcceptanceAttestationV1;
  const { attestationHash: observed, ...withoutHash } = candidate;
  return attestationHash(withoutHash) === observed ? candidate : null;
}

export function acceptanceAttests(
  projectRoot: string,
  runId: string,
  report: QaReportV2,
  contract: VerificationContractV2,
  sourceHash: string,
): boolean {
  const accepted = readAcceptanceAttestation(projectRoot, runId);
  return Boolean(accepted
    && report.build
    && accepted.verificationContractHash === contract.contractHash
    && accepted.sourceHash === sourceHash
    && accepted.reportHash === qaReportV2ContentHash(report)
    && accepted.evidenceHash === qaEvidenceContentHash(projectRoot, runId, report)
    && accepted.buildFingerprint === report.build.fingerprint);
}

/**
 * Recover the ACCEPTED report from the durable acceptance attestation, judging
 * evidence by content hashes alone — never by file mtimes, live server state,
 * or the current build output tree.
 *
 * The attestation is written exactly once, by this validator, at the end of a
 * FULLY PASSING live validation (machine evidence, route matrix, screenshots,
 * build identity — all against the then-live tree). From that moment the
 * accepted verdict is a fact about hash-pinned inputs: the report
 * (`reportHash`), every evidence artifact byte (`evidenceHash`), the contract
 * (`verificationContractHash`), the source tree (`sourceHash`, which the
 * caller has already re-verified LIVE), and the build identity
 * (`buildFingerprint`).
 *
 * Two later events must not be able to revoke it (observed live, 14cl run
 * 1785511629914 — a fully green run that could never settle):
 *
 *   1. The build output dir was rebuilt after acceptance (the reviewer's probe
 *      `pnpm build`). The live-manifest recheck inside machine-evidence
 *      validation then failed, although not one byte of the accepted evidence,
 *      report, or source had changed.
 *   2. That very rejection was persisted into report-v2.json by
 *      `persistGateRejection`, durably flipping the accepted `passed` report
 *      to `failed` + a machine-evidence gate — poisoning every later read.
 *
 * So this function accepts two report forms: the report byte-identical to what
 * was accepted, and the accepted report reconstructed by undoing exactly the
 * `persistGateRejection` transform (status back to `passed`, `gates` dropped).
 * And it accepts two `observedBuildHash` forms: the current live manifest
 * (nothing drifted), or the RECORDED `build.buildHash` — which is provably the
 * value embedded at acceptance time, because the acceptance-time live checks
 * required `manifestHash === build.buildHash`.
 *
 * Fail-closed properties, deliberately kept: no attestation → full live
 * validation; any changed byte in the report, machine evidence, a trace, or a
 * screenshot → hash mismatch → full live validation; source drift → the
 * caller's live sourceHash check rejects before this is consulted; a report
 * whose gate rejection predates acceptance can never match, because acceptance
 * is only ever written after a full pass.
 */
export function acceptanceRestoresReport(
  projectRoot: string,
  runId: string,
  report: QaReportV2,
  contract: VerificationContractV2,
  sourceHash: string,
): QaReportV2 | null {
  const accepted = readAcceptanceAttestation(projectRoot, runId);
  if (!accepted
    || !report.build
    || accepted.verificationContractHash !== contract.contractHash
    || accepted.sourceHash !== sourceHash
    || accepted.buildFingerprint !== report.build.fingerprint) return null;
  const candidates: QaReportV2[] = [report];
  if (report.status === 'failed' || (report.gates || []).length > 0) {
    const normalized = { ...report, status: 'passed' as const };
    delete normalized.gates;
    candidates.push(normalized);
  }
  for (const candidate of candidates) {
    if (accepted.reportHash !== qaReportV2ContentHash(candidate)) continue;
    if (accepted.evidenceHash === qaEvidenceContentHash(projectRoot, runId, candidate)
      || accepted.evidenceHash === qaEvidenceContentHash(
        projectRoot,
        runId,
        candidate,
        candidate.build?.buildHash,
      )) {
      return candidate;
    }
  }
  return null;
}

export function writeAcceptanceAttestation(
  projectRoot: string,
  runId: string,
  report: QaReportV2,
  contract: VerificationContractV2,
  sourceHash: string,
): boolean {
  if (!report.build) return false;
  const withoutHash = {
    schemaVersion: QA_ACCEPTANCE_ATTESTATION_SCHEMA_VERSION,
    runId,
    verificationContractHash: contract.contractHash,
    sourceHash,
    reportHash: qaReportV2ContentHash(report),
    evidenceHash: qaEvidenceContentHash(projectRoot, runId, report),
    buildFingerprint: report.build.fingerprint,
    acceptedAt: new Date().toISOString(),
  };
  try {
    writeJson(qaAcceptanceAttestationPath(projectRoot, runId), {
      ...withoutHash,
      attestationHash: attestationHash(withoutHash),
    });
    return acceptanceAttests(projectRoot, runId, report, contract, sourceHash);
  } catch {
    return false;
  }
}

export function qaReportV2ContentHash(report: QaReportV2): string {
  return sha256(stableContractJson(report));
}
