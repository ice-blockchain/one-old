// src/runners/qa-evidence/run-context.ts
// Path safety, run/contract loading, and report publication+validation.

import * as fs from 'fs';
import * as path from 'path';
import { writeJson } from '../../shared/fsjson';
import {
  combineNativeSummaries,
  computeBuildOutputManifest,
  contentHash,
  createQaLighthouseEvidence,
  createQaMachineEvidence,
  createQaNativeEvidence,
  parseAndroidJUnitXml,
  parseXcodeResultSummary,
  readLighthouseArtifact,
  type BuildOutputManifestV1,
  type QaMachineRouteEvidenceV1,
  type QaMachineViewportEvidenceV1,
  type QaNativeArtifactV1,
  type QaNativeTestSummaryV1,
} from '../../shared/qa-evidence-runtime';
import {
  expectedBuildFingerprint,
  QA_BUILD_IDENTITY_PROBE_PATH,
  qaReportV2Path,
  readQaReportV2,
  validateQaReportV2,
  type QaReportV2,
} from '../../shared/qa-report-v2';
import {
  currentVerificationSourceHash,
  readVerificationContract,
  type VerificationContractV2,
} from '../../shared/verification-contract';

import {
  SAFE_ID_RE,
  type OwnedServer,
  type RunnerArgs,
} from './types';

export function strictRelative(value: string): string | null {
  if (!value
    || path.isAbsolute(value)
    || /^[A-Za-z]:[\\/]/.test(value)
    || /[*?[\]{};\u0000-\u001f\u007f]/.test(value)) return null;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/')
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    return null;
  }
  return normalized;
}

export function ensureProjectDirectory(projectRoot: string, relative: string): string | null {
  const normalized = strictRelative(relative);
  if (!normalized) return null;
  let realProject: string;
  try { realProject = fs.realpathSync(projectRoot); } catch { return null; }
  let current = path.resolve(projectRoot);
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    try {
      if (fs.existsSync(current)) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
      } else {
        fs.mkdirSync(current);
      }
    } catch {
      return null;
    }
  }
  try {
    const real = fs.realpathSync(current);
    const boundary = path.relative(realProject, real);
    return !boundary.startsWith('..') && !path.isAbsolute(boundary) ? real : null;
  } catch {
    return null;
  }
}

export function safeProjectRelative(projectRoot: string, value: string): string | null {
  const normalized = strictRelative(value);
  if (!normalized) return null;
  const absolute = path.resolve(projectRoot, normalized);
  const rel = path.relative(projectRoot, absolute);
  return !rel.startsWith('..') && !path.isAbsolute(rel) ? normalized : null;
}

export function qaDir(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'reports', 'qa', runId);
}

export function outputPath(
  args: RunnerArgs,
  defaultName: string,
): { absolute: string; relative: string } | null {
  const base = qaDir(args.projectRoot, args.runId);
  const requested = args.out || defaultName;
  const relative = strictRelative(requested);
  if (!relative) return null;
  const absolute = path.resolve(base, relative);
  const parent = path.dirname(absolute);
  const parentRel = path.relative(args.projectRoot, parent).replace(/\\/g, '/');
  try {
    const realParent = ensureProjectDirectory(args.projectRoot, parentRel);
    const realBase = fs.realpathSync(base);
    if (!realParent) return null;
    const boundary = path.relative(realBase, realParent);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) return null;
    if (fs.existsSync(absolute)) {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return null;
      const realTarget = fs.realpathSync(absolute);
      const targetBoundary = path.relative(realBase, realTarget);
      if (targetBoundary.startsWith('..') || path.isAbsolute(targetBoundary)) return null;
    }
  } catch {
    return null;
  }
  return { absolute, relative };
}

export function loadRun(
  args: RunnerArgs,
): {
  contract: VerificationContractV2;
  sourceHash: string;
  manifest: BuildOutputManifestV1;
  fingerprint: string;
} | null {
  if (!SAFE_ID_RE.test(args.runId) || !args.buildDir) return null;
  const contract = readVerificationContract(args.projectRoot, args.runId);
  if (!contract) return null;
  const source = currentVerificationSourceHash(args.projectRoot, contract);
  const manifest = computeBuildOutputManifest(args.projectRoot, args.buildDir);
  if (!source.complete || !source.hash || !manifest) return null;
  return {
    contract,
    sourceHash: source.hash,
    manifest,
    fingerprint: expectedBuildFingerprint(args.runId, source.hash, manifest.manifestHash),
  };
}

export function loadNativeRun(
  args: RunnerArgs,
): {
  contract: VerificationContractV2;
  sourceHash: string;
} | null {
  if (!SAFE_ID_RE.test(args.runId)) return null;
  const contract = readVerificationContract(args.projectRoot, args.runId);
  if (!contract || contract.uiImpact !== 'native-ui' || !contract.nativeAdapter) return null;
  const source = currentVerificationSourceHash(args.projectRoot, contract);
  if (!source.complete || !source.hash) return null;
  return { contract, sourceHash: source.hash };
}

function reportLighthousePath(args: RunnerArgs): string | null {
  if (!args.lighthouseEvidence) return null;
  return strictRelative(args.lighthouseEvidence);
}

export function publishAndValidateReport(
  args: RunnerArgs,
  loaded: NonNullable<ReturnType<typeof loadRun>>,
  owned: OwnedServer,
  machineEvidencePath: string,
  status: QaReportV2['status'],
  routes: QaReportV2['routes'],
  blockerSummary?: string,
  lighthouseEvidencePath?: string,
): { report: QaReportV2; ok: boolean; code?: string; message?: string } {
  const lighthousePath = lighthouseEvidencePath || reportLighthousePath(args);
  const report: QaReportV2 = {
    schemaVersion: 2,
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    generatedAt: new Date().toISOString(),
    producer: 'parent-runner',
    status,
    sourceHash: loaded.sourceHash,
    checks: loaded.contract.requiredChecks.map((id) => ({
      id,
      status: status === 'passed' ? 'passed' : 'failed',
      summary: status === 'passed'
        ? 'Executed by traffic-one-qa-runner.'
        : blockerSummary || 'Runtime QA evidence did not pass.',
    })),
    routes,
    machineEvidencePath,
    build: {
      runId: args.runId,
      sourceHash: loaded.sourceHash,
      outputRoot: loaded.manifest.outputRoot,
      buildHash: loaded.manifest.manifestHash,
      pid: process.pid,
      port: owned.port,
      startedAt: owned.startedAt,
      url: owned.url,
      fingerprint: loaded.fingerprint,
      servedFingerprint: loaded.fingerprint,
    },
    ...(lighthousePath ? { lighthouse: { evidencePath: lighthousePath } } : {}),
    ...(blockerSummary ? { blockerSummary } : {}),
  };
  writeJson(qaReportV2Path(args.projectRoot, args.runId), report);
  const validation = validateQaReportV2(report, args.projectRoot, args.runId, loaded.contract);
  return validation.ok
    ? { report, ok: true }
    : { report, ok: false, code: validation.code, message: validation.message };
}
