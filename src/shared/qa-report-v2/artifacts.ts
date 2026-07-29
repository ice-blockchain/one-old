// src/shared/qa-report-v2-artifacts.ts
// Artifact containment, content hashing, and the acceptance attestation.
// Every hash is recomputed from disk; report booleans are never enough.

import * as fs from 'fs';
import * as path from 'path';
import { stableContractJson } from '../architecture-contract';
import { writeJson } from '../fsjson';
import {
  combineNativeSummaries,
  computeBuildOutputManifest,
  contentHash,
  decodeImageFile,
  parseAndroidJUnitXml,
  parseQaLighthouseEvidence,
  parseQaMachineEvidence,
  parseQaNativeEvidence,
  parseXcodeResultSummary,
  readJsonFile,
  readLighthouseArtifact,
  type QaLighthouseEvidenceV1,
  type QaMachineEvidenceV1,
  type QaMachineViewportEvidenceV1,
  type QaNativeEvidenceV1,
} from '../qa-evidence-runtime';
import { sha256 } from '../text';
import {
  currentVerificationSourceHash,
  readVerificationContract,
  type LighthouseThresholdsV1,
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
          viewport.tracePath,
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
  const observedBuildHash = report.build
    ? computeBuildOutputManifest(projectRoot, report.build.outputRoot)?.manifestHash || '<invalid>'
    : '<not-required>';
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
