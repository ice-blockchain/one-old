// src/runners/qa-evidence/run-context.ts
// Path safety, run/contract loading, and report publication+validation.

import * as fs from 'fs';
import * as path from 'path';
import { writeJson } from '../../shared/fsjson';
import {
  computeBuildOutputManifest,
  type BuildOutputManifestV1,
} from '../../shared/qa-evidence-runtime';
import {
  expectedBuildFingerprint,
  qaReportV2Path,
  validateQaReportV2,
  type QaReportV2,
} from '../../shared/qa-report-v2';
import { reconcileRunSettlement } from '../../shared/run-settlement';
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
import {
  computeBrowserCheckStatuses,
  type CheckEvidenceInput,
} from './report-publish';
import { runStackChecks } from './stack';

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

// Persist the canonical QA report AND re-derive the run's canonical settlement
// from it. `reconcileRunSettlement` used to be reachable only from the two
// session/prompt boundaries (session-start, prompt-submit), so the PLAN_READY
// seed (`active` + `verification-not-started`) survived verbatim for the whole
// run — observed still at revision 5 roughly fifty minutes after
// verification-v2.json, report-v2.json and both reviewer/tester digests were on
// disk. The settlement is DERIVED state, so it has to be re-derived where the
// evidence actually lands, not only where a human happens to type. Publishing a
// report can never manufacture `verified` here: strict evidence additionally
// requires a reviewer/tester attestation NEWER than this report.
// Returns whether report-v2.json is actually ON DISK. The write is fenced
// (fsjson.ts: an unanswered consent question, a planted symlink at the sidecar,
// a path escaping the state dir) and the refusal used to be dropped, so the
// runner validated its own IN-MEMORY report — validateQaReportV2 never reads the
// file — printed `ok: true` and exited 0, while every gate downstream calls
// readQaReportV2 and gets `report-missing`. The run was then blocked by a
// missing artifact the one process that knew it had not been written had already
// certified.
//
// The settlement re-derivation is skipped on a refusal for the same reason it
// exists: it re-derives from the evidence that just landed, and none did.
export function publishQaReportV2(
  projectRoot: string,
  runId: string,
  report: QaReportV2,
): boolean {
  if (!writeJson(qaReportV2Path(projectRoot, runId), report)) return false;
  reconcileRunSettlement(projectRoot, runId);
  return true;
}

/**
 * The rejection every publisher below reports when the sidecar could not be
 * written. `report-missing` is the code the READERS already produce for the same
 * on-disk state (see readQaReportV2), so a gate and the runner name one fact the
 * same way instead of two.
 */
function notPublished(projectRoot: string, runId: string): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: 'report-missing',
    message: `the runtime could not persist ${qaReportV2Path(projectRoot, runId)}: the write was refused. `
      + 'No QA evidence is on disk, so this run has produced none. Answer this project\'s '
      + '"use Traffic One here?" question if it is still pending, and check that '
      + `.traffic-one/reports/qa/${runId}/ contains no symbolic links.`,
  };
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

export interface LoadedRun {
  contract: VerificationContractV2;
  sourceHash: string;
  manifest: BuildOutputManifestV1;
  fingerprint: string;
}

export interface LoadedNativeRun {
  contract: VerificationContractV2;
  sourceHash: string;
}

// Every load failure names WHICH precondition failed. The previous shape
// collapsed four distinct causes into one `null`, and the caller printed a
// message listing all four — so an agent holding the precise answer
// (`currentVerificationSourceHash` already computes it) learned nothing. Two
// roles each burned minutes on that, and neither ever identified the cause.
export type LoadResult<T> = { ok: true; run: T } | { ok: false; reason: string };

// The stack-command checks a browser or native contract also carries have no
// command channel in their own producer: `computeBrowserCheckStatuses` is
// entirely evidence-derived, and a native adapter result attests only what it
// actually ran (report-publish's NATIVE_ATTESTED_CHECK_IDS). Run the project's
// own declared scripts here and substitute the REAL results. A project that
// declares none reports `not-applicable` with its reason, which
// `validateQaReportV2` accepts for these ids — so substitution can never
// deadlock a contract, only stop it reading as covered.
//
// `stack-format` was the first of these: verifying the formatter by
// CONFIGURATION alone let two runs ship with format:check red from the first
// implementer turn to the last. `stack-build` is deliberately NOT substituted —
// the browser path already answers it from the served build-output manifest,
// which is stronger evidence than re-running the build.
export const SUBSTITUTED_STACK_CHECK_IDS = ['stack-format', 'stack-performance'] as const;

export function withExecutedStackChecks(
  args: RunnerArgs,
  checks: QaReportV2['checks'],
): QaReportV2['checks'] {
  const wanted = SUBSTITUTED_STACK_CHECK_IDS.filter((id) => checks.some((check) => check.id === id));
  if (wanted.length === 0) return checks;
  const executed = new Map(runStackChecks(args, wanted).map((check) => [check.id, check]));
  return checks.map((check) => executed.get(check.id) || check);
}

export function loadRun(args: RunnerArgs): LoadResult<LoadedRun> {
  if (!SAFE_ID_RE.test(args.runId)) {
    return { ok: false, reason: `run id is not a safe identifier: ${args.runId}` };
  }
  if (!args.buildDir) return { ok: false, reason: 'no --build-dir was provided' };
  const contract = readVerificationContract(args.projectRoot, args.runId);
  if (!contract) {
    return {
      ok: false,
      reason: `VerificationContractV2 for run ${args.runId} is missing, malformed, `
        + 'or fails its own hash self-check',
    };
  }
  const source = currentVerificationSourceHash(args.projectRoot, contract);
  if (!source.complete || !source.hash) {
    return { ok: false, reason: source.reason || 'source identity scan is incomplete' };
  }
  const manifest = computeBuildOutputManifest(args.projectRoot, args.buildDir);
  if (!manifest) {
    return {
      ok: false,
      reason: `build output manifest could not be computed from ${args.buildDir} `
        + '(missing, empty, or over the manifest size limits)',
    };
  }
  return {
    ok: true,
    run: {
      contract,
      sourceHash: source.hash,
      manifest,
      fingerprint: expectedBuildFingerprint(args.runId, source.hash, manifest.manifestHash),
    },
  };
}

export interface LoadedStackRun {
  contract: VerificationContractV2;
  sourceHash: string;
}

/**
 * Load for the `stack` command: contract plus source identity, and NO build
 * manifest. An api-only project (Go, Python, Rust, a Laravel API) has no JS
 * build output, so requiring `--build-dir` here made the only path that could
 * ever satisfy its `stack-*` checks unreachable.
 */
export function loadStackRun(args: RunnerArgs): LoadResult<LoadedStackRun> {
  if (!SAFE_ID_RE.test(args.runId)) {
    return { ok: false, reason: `run id is not a safe identifier: ${args.runId}` };
  }
  const contract = readVerificationContract(args.projectRoot, args.runId);
  if (!contract) {
    return {
      ok: false,
      reason: `VerificationContractV2 for run ${args.runId} is missing, malformed, `
        + 'or fails its own hash self-check',
    };
  }
  if (contract.browserRequired || contract.uiImpact === 'native-ui') {
    return {
      ok: false,
      reason: `active contract requires ${contract.uiImpact === 'native-ui' ? 'native' : 'browser'} `
        + 'evidence, so stack checks alone cannot satisfy it',
    };
  }
  const source = currentVerificationSourceHash(args.projectRoot, contract);
  if (!source.complete || !source.hash) {
    return { ok: false, reason: source.reason || 'source identity scan is incomplete' };
  }
  return { ok: true, run: { contract, sourceHash: source.hash } };
}

/** Publish a stack-only v2 report: no server, no build identity, no routes. */
export function publishStackReport(
  args: RunnerArgs,
  loaded: LoadedStackRun,
  status: QaReportV2['status'],
  checks: QaReportV2['checks'],
): { report: QaReportV2; ok: boolean; code?: string; message?: string } {
  const report: QaReportV2 = {
    schemaVersion: 2,
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    generatedAt: new Date().toISOString(),
    producer: 'parent-runner',
    status,
    sourceHash: loaded.sourceHash,
    checks,
    routes: [],
  };
  if (!publishQaReportV2(args.projectRoot, args.runId, report)) {
    return { report, ...notPublished(args.projectRoot, args.runId) };
  }
  const validation = validateQaReportV2(report, args.projectRoot, args.runId, loaded.contract);
  return validation.ok
    ? { report, ok: true }
    : { report, ok: false, code: validation.code, message: validation.message };
}

export function loadNativeRun(args: RunnerArgs): LoadResult<LoadedNativeRun> {
  if (!SAFE_ID_RE.test(args.runId)) {
    return { ok: false, reason: `run id is not a safe identifier: ${args.runId}` };
  }
  const contract = readVerificationContract(args.projectRoot, args.runId);
  if (!contract) {
    return {
      ok: false,
      reason: `VerificationContractV2 for run ${args.runId} is missing, malformed, `
        + 'or fails its own hash self-check',
    };
  }
  if (contract.uiImpact !== 'native-ui' || !contract.nativeAdapter) {
    return {
      ok: false,
      reason: `active contract does not require native evidence (uiImpact=${contract.uiImpact}, `
        + `nativeAdapter=${contract.nativeAdapter ?? 'null'})`,
    };
  }
  const source = currentVerificationSourceHash(args.projectRoot, contract);
  if (!source.complete || !source.hash) {
    return { ok: false, reason: source.reason || 'source identity scan is incomplete' };
  }
  return { ok: true, run: { contract, sourceHash: source.hash } };
}

function reportLighthousePath(args: RunnerArgs): string | null {
  if (!args.lighthouseEvidence) return null;
  return strictRelative(args.lighthouseEvidence);
}

export function publishAndValidateReport(
  args: RunnerArgs,
  loaded: LoadedRun,
  owned: OwnedServer,
  machineEvidencePath: string,
  status: QaReportV2['status'],
  routes: QaReportV2['routes'],
  blockerSummary: string | undefined,
  lighthouse: QaReportV2['lighthouse'] | string | undefined,
  // Required: the wholesale fallback that used to stand in for a missing
  // `checkInput` stamped every id from the overall status, which is the same
  // zero-evidence pass the native path carried. Both browser call sites always
  // had the evidence — nothing was using it.
  checkInput: CheckEvidenceInput,
): { report: QaReportV2; ok: boolean; code?: string; message?: string } {
  // Back-compat: a bare string is the evidence path (pre-1.0.37 call shape).
  const lighthouseField: QaReportV2['lighthouse'] | undefined = typeof lighthouse === 'string'
    ? { evidencePath: lighthouse }
    : lighthouse && (lighthouse.evidencePath || lighthouse.status)
      ? lighthouse
      : reportLighthousePath(args)
        ? { evidencePath: reportLighthousePath(args)! }
        : undefined;
  const report: QaReportV2 = {
    schemaVersion: 2,
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    generatedAt: new Date().toISOString(),
    producer: 'parent-runner',
    status,
    sourceHash: loaded.sourceHash,
    checks: withExecutedStackChecks(
      args,
      computeBrowserCheckStatuses(loaded.contract.requiredChecks, checkInput),
    ),
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
    ...(lighthouseField ? { lighthouse: lighthouseField } : {}),
    ...(blockerSummary ? { blockerSummary } : {}),
  };
  if (!publishQaReportV2(args.projectRoot, args.runId, report)) {
    return { report, ...notPublished(args.projectRoot, args.runId) };
  }
  const validation = validateQaReportV2(report, args.projectRoot, args.runId, loaded.contract);
  return validation.ok
    ? { report, ok: true }
    : { report, ok: false, code: validation.code, message: validation.message };
}
