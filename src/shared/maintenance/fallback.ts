// Production finalizer for a paid maintenance fallback.
//
// The OpenCode runner publishes the exact parent-owned WorkUnit and captures
// the source pre-image before a fallback is allowed. Hosts with no reliable
// post-write hook invoke this finalizer at SessionStart/UserPromptSubmit. The
// shared project lock is re-entrant, so maintenance.json and the canonical
// settlement projection are serialized as one runtime transaction; a process
// crash between atomic file renames is repaired idempotently on the next pass.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  readArchitectureRunBaseline,
  type ArchitectureBaselineV1,
} from '../architecture-contract';
import { readJson, writeJson } from '../fsjson';
import {
  captureFallbackSourceSnapshot,
  createPaidFallbackCompletion,
  paidFallbackCompletionFromMaintenance,
  parseFallbackSourceSnapshot,
  type FallbackSourceFileV1,
  type FallbackSourceSnapshotV1,
} from './fallback-proof';
import { roleDigestName } from '../packing';
import {
  quickFixDigestPath,
  readActiveRunBootstrap,
  type RunBootstrapEnvelopeV2,
} from '../run-bootstrap-policy';
import {
  readRunSettlement,
  writeRunSettlement,
} from '../run-settlement';
import { matchesPattern } from '../scope';
import { withProjectStateLock } from '../state/project-state-lock';
import { sha256 } from '../text';

type Rec = Record<string, unknown>;

export type PaidFallbackFinalizationStatus =
  | 'not-applicable'
  | 'pending'
  | 'invalid'
  | 'completed'
  | 'already-completed';

interface PaidFallbackFinalizationResult {
  status: PaidFallbackFinalizationStatus;
  reason: string;
  changedPaths?: string[];
}

function safeRunId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
}

function canonicalRole(value: unknown): string {
  const role = typeof value === 'string' ? value.trim() : '';
  if (role.startsWith('senior-') || role === 'quick-fix') return role;
  if (role === 'frontend') return 'senior-frontend';
  if (role === 'backend') return 'senior-backend';
  if (role === 'tester') return 'senior-tester';
  if (role === 'docs') return 'senior-architect';
  return role;
}

export function workUnitAllowlistHash(envelope: RunBootstrapEnvelopeV2): string {
  return sha256(JSON.stringify({
    include: envelope.workUnit.allowlist,
    exclude: envelope.workUnit.allowlistExclude,
  }));
}

function exactSourcePath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
  if (!normalized
    || normalized.startsWith('/')
    || normalized === '.'
    || normalized.split('/').includes('..')
    || normalized.includes('\0')
    || /[*?[\]{}]/.test(normalized)
    || normalized === '.traffic-one'
    || normalized.startsWith('.traffic-one/')) return null;
  return normalized;
}

export function fallbackSourcePaths(
  envelope: RunBootstrapEnvelopeV2,
): string[] | null {
  const source: string[] = [];
  for (const output of envelope.workUnit.outputs) {
    if (output === quickFixDigestPath(envelope.runId)
      || output.startsWith('.traffic-one/')) continue;
    const normalized = exactSourcePath(output);
    if (!normalized
      || !envelope.workUnit.allowlist.some((pattern) => matchesPattern(normalized, pattern))
      || envelope.workUnit.allowlistExclude.some((pattern) => matchesPattern(normalized, pattern))) {
      return null;
    }
    source.push(normalized);
  }
  const unique = [...new Set(source)].sort();
  return unique.length > 0 ? unique : null;
}

export function captureMaintenanceFallbackBaseline(
  projectRoot: string,
  envelope: RunBootstrapEnvelopeV2,
): FallbackSourceSnapshotV1 | null {
  const paths = fallbackSourcePaths(envelope);
  return paths ? captureFallbackSourceSnapshot(projectRoot, paths) : null;
}

function digestPathForRole(runId: string, role: string): string {
  return role === 'quick-fix'
    ? quickFixDigestPath(runId)
    : `.traffic-one/digests/${safeRunId(runId)}/${roleDigestName(role)}.md`;
}

const VERDICT_TOKENS = /\b(PLAN_READY|IMPLEMENTED|BLOCKED|APPROVED|CHANGES_REQUESTED|TESTS_GREEN|TESTS_FAILING|DELEGATED_OK|SHIPPED|FAILED)\b/g;

function exactDigestVerdict(text: string): string | null {
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

function changedSnapshotPaths(
  before: FallbackSourceSnapshotV1,
  after: FallbackSourceSnapshotV1,
): string[] | null {
  if (before.files.length !== after.files.length) return null;
  const changed: string[] = [];
  for (let index = 0; index < before.files.length; index += 1) {
    const left = before.files[index]!;
    const right = after.files[index]!;
    if (left.path !== right.path) return null;
    if (left.state !== right.state || left.size !== right.size || left.hash !== right.hash) {
      changed.push(left.path);
    }
  }
  return changed;
}

function manifestBaselineStates(
  baseline: ArchitectureBaselineV1,
  paths: readonly string[],
): Map<string, string | null> | null {
  if (baseline.kind !== 'file-manifest' || !Array.isArray(baseline.files)) return null;
  const entries = new Map(baseline.files.map((entry) => [entry.path, entry.hash]));
  return new Map(paths.map((relative) => [relative, entries.get(relative) || null]));
}

function gitBaselineStates(
  projectRoot: string,
  baseline: ArchitectureBaselineV1,
  paths: readonly string[],
): Map<string, string | null> | null {
  if (baseline.kind !== 'git-head' || !/^git:[a-f0-9]{40,64}$/i.test(baseline.identity)) return null;
  const commit = baseline.identity.slice(4);
  let prefix = '';
  try {
    execFileSync('git', ['-C', projectRoot, 'cat-file', '-e', `${commit}^{commit}`], {
      timeout: 3_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    prefix = execFileSync('git', ['-C', projectRoot, 'rev-parse', '--show-prefix'], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().replace(/\\/g, '/');
  } catch {
    return null;
  }
  const states = new Map<string, string | null>();
  for (const relative of paths) {
    const object = `${commit}:${prefix}${relative}`;
    try {
      execFileSync('git', ['-C', projectRoot, 'cat-file', '-e', object], {
        timeout: 3_000,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      states.set(relative, null);
      continue;
    }
    try {
      const bytes = execFileSync('git', ['-C', projectRoot, 'show', object], {
        timeout: 3_000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      states.set(relative, sha256(bytes.toString('base64')));
    } catch {
      return null;
    }
  }
  return states;
}

function runBaselineDelta(
  projectRoot: string,
  runId: string,
  current: FallbackSourceSnapshotV1,
): { baselineHash: string; changedPaths: string[] } | null {
  const sidecar = readArchitectureRunBaseline(projectRoot, runId);
  if (!sidecar) return null;
  const paths = current.files.map((entry) => entry.path);
  const baseline = sidecar.baseline.kind === 'file-manifest'
    ? manifestBaselineStates(sidecar.baseline, paths)
    : gitBaselineStates(projectRoot, sidecar.baseline, paths);
  if (!baseline || baseline.size !== paths.length) return null;
  const changedPaths = current.files
    .filter((entry) => {
      const expected = baseline.get(entry.path) ?? null;
      return entry.state === 'missing' ? expected !== null : entry.hash !== expected;
    })
    .map((entry) => entry.path);
  return { baselineHash: sidecar.baselineHash, changedPaths };
}

function markerTime(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fileHash(bytes: Buffer): string {
  return sha256(bytes.toString('base64'));
}

function alreadyCompleted(
  projectRoot: string,
  runId: string,
  marker: Rec,
): PaidFallbackFinalizationResult {
  const completion = paidFallbackCompletionFromMaintenance(marker);
  const settlement = readRunSettlement(projectRoot, runId);
  if (!completion
    || !settlement
    || settlement.fallback?.state !== 'completed'
    || settlement.fallback.workUnitContractHash !== completion.workUnitContractHash
    || settlement.fallback.allowlistHash !== completion.allowlistHash
    || settlement.workUnitContractHash !== completion.workUnitContractHash
    || settlement.allowlistHash !== completion.allowlistHash) {
    return { status: 'invalid', reason: 'fallback-paid marker is not backed by the canonical completed settlement' };
  }
  return {
    status: 'already-completed',
    reason: 'paid fallback was already finalized by the runtime',
    changedPaths: completion.changedPaths,
  };
}

export function finalizePaidMaintenanceFallback(
  projectRoot: string,
  runId: string,
): PaidFallbackFinalizationResult {
  if (!runId.trim() || /[\\/]/.test(runId)) {
    return { status: 'invalid', reason: 'run id is invalid' };
  }
  try {
    return withProjectStateLock(projectRoot, () => {
      const markerPath = path.join(
        projectRoot,
        '.traffic-one',
        'runs',
        safeRunId(runId),
        'maintenance.json',
      );
      const marker = readJson<Rec | null>(markerPath, null);
      if (!marker) return { status: 'not-applicable', reason: 'maintenance marker is absent' };
      if ([marker.overallOutcome, marker.outcome].some((value) => (
        typeof value === 'string' && value.trim().toLowerCase() === 'fallback-paid'
      ))) {
        return alreadyCompleted(projectRoot, runId, marker);
      }
      if (marker.overallOutcome !== 'fallback-pending' || marker.fallbackAllowed !== true) {
        return { status: 'not-applicable', reason: 'maintenance fallback is not pending' };
      }
      const role = canonicalRole(marker.role);
      if (!role || role !== marker.role) {
        return { status: 'invalid', reason: 'maintenance fallback role is missing or noncanonical' };
      }
      const bootstrap = readActiveRunBootstrap(projectRoot, runId, role);
      if (!bootstrap || bootstrap.trafficOneRole !== role) {
        return { status: 'invalid', reason: 'active role bootstrap is missing or invalid' };
      }
      const allowlistHash = workUnitAllowlistHash(bootstrap);
      if (marker.workUnitContractHash !== bootstrap.workUnit.contractHash
        || marker.allowlistHash !== allowlistHash) {
        return { status: 'invalid', reason: 'maintenance fallback hashes do not match the active WorkUnit' };
      }
      const settlementBefore = readRunSettlement(projectRoot, runId);
      if (settlementBefore && (
        settlementBefore.fallback?.state !== 'pending'
        || settlementBefore.fallback.workUnitContractHash !== bootstrap.workUnit.contractHash
        || settlementBefore.fallback.allowlistHash !== allowlistHash
        || settlementBefore.workUnitContractHash !== bootstrap.workUnit.contractHash
        || settlementBefore.allowlistHash !== allowlistHash
      )) {
        return { status: 'invalid', reason: 'canonical settlement does not track this exact pending fallback' };
      }
      const sourcePaths = fallbackSourcePaths(bootstrap);
      const sourceBefore = parseFallbackSourceSnapshot(marker.fallbackSourceBaseline);
      if (!sourcePaths
        || !sourceBefore
        || JSON.stringify(sourceBefore.files.map((entry) => entry.path)) !== JSON.stringify(sourcePaths)) {
        return { status: 'invalid', reason: 'runtime source pre-image is missing or does not match the WorkUnit' };
      }
      const sourceAfter = captureFallbackSourceSnapshot(projectRoot, sourcePaths);
      if (!sourceAfter) {
        return { status: 'invalid', reason: 'current WorkUnit source state cannot be scanned completely' };
      }
      const fallbackChanged = changedSnapshotPaths(sourceBefore, sourceAfter);
      if (!fallbackChanged || fallbackChanged.length === 0) {
        return { status: 'pending', reason: 'paid fallback has not produced an in-allowlist source delta' };
      }
      const baselineDelta = runBaselineDelta(projectRoot, runId, sourceAfter);
      if (!baselineDelta) {
        return { status: 'invalid', reason: 'immutable run baseline cannot prove the current source delta' };
      }
      const changedPaths = fallbackChanged.filter((relative) => baselineDelta.changedPaths.includes(relative));
      if (changedPaths.length === 0) {
        return { status: 'pending', reason: 'paid fallback delta does not leave a source change against the immutable run baseline' };
      }
      const digestPath = digestPathForRole(runId, role);
      if (!bootstrap.workUnit.outputs.includes(digestPath)
        || !bootstrap.workUnit.allowlist.some((pattern) => matchesPattern(digestPath, pattern))
        || bootstrap.workUnit.allowlistExclude.some((pattern) => matchesPattern(digestPath, pattern))) {
        return { status: 'invalid', reason: 'terminal fallback digest is outside the active WorkUnit' };
      }
      let digestBytes: Buffer;
      let digestMtime = 0;
      try {
        const absoluteDigest = path.join(projectRoot, digestPath);
        const stat = fs.statSync(absoluteDigest);
        if (!stat.isFile() || stat.size <= 0 || stat.size > 1024 * 1024) throw new Error('invalid digest');
        digestBytes = fs.readFileSync(absoluteDigest);
        digestMtime = Math.floor(stat.mtimeMs);
      } catch {
        return { status: 'pending', reason: 'paid fallback terminal digest is absent' };
      }
      if (exactDigestVerdict(digestBytes.toString('utf8')) !== 'IMPLEMENTED') {
        return { status: 'pending', reason: 'paid fallback digest has no unambiguous IMPLEMENTED verdict' };
      }
      const delegationFinishedAt = markerTime(marker.finishedAt);
      if (delegationFinishedAt <= 0 || digestMtime < delegationFinishedAt) {
        return { status: 'invalid', reason: 'paid fallback digest predates the OpenCode terminal failure' };
      }

      const completion = createPaidFallbackCompletion({
        role,
        envelopeHash: bootstrap.envelopeHash,
        workUnitContractHash: bootstrap.workUnit.contractHash,
        allowlistHash,
        digestPath,
        digestHash: fileHash(digestBytes),
        sourceBaselineHash: sourceBefore.stateHash,
        sourceResultHash: sourceAfter.stateHash,
        runBaselineHash: baselineDelta.baselineHash,
        changedPaths,
        completedAt: new Date().toISOString(),
      });
      const completedMarker: Rec = {
        ...marker,
        outcome: 'fallback-paid',
        overallOutcome: 'fallback-paid',
        fallbackAllowed: false,
        fallbackCompletion: completion,
        finishedAt: completion.completedAt,
      };
      writeJson(markerPath, completedMarker);
      const settlement = writeRunSettlement(projectRoot, runId, {
        status: 'code-delivered',
        workUnitContractHash: bootstrap.workUnit.contractHash,
        allowlistHash,
        fallback: {
          state: 'completed',
          workUnitContractHash: bootstrap.workUnit.contractHash,
          allowlistHash,
        },
        incompleteChecks: ['verification-not-started'],
      });
      if (!settlement
        || settlement.status !== 'code-delivered'
        || settlement.fallback?.state !== 'completed'
        || settlement.workUnitContractHash !== bootstrap.workUnit.contractHash
        || settlement.allowlistHash !== allowlistHash
        || !paidFallbackCompletionFromMaintenance(readJson(markerPath, null))) {
        // Fail closed. Each JSON write is atomic and the outer project lock
        // excludes concurrent observers; restoring the pending marker makes a
        // crash/failure retryable instead of advertising partial completion.
        writeJson(markerPath, marker);
        return { status: 'invalid', reason: 'canonical paid-fallback settlement could not be published' };
      }
      return {
        status: 'completed',
        reason: 'paid fallback source delivery was finalized; verification remains pending',
        changedPaths,
      };
    });
  } catch {
    return { status: 'invalid', reason: 'paid fallback finalization transaction failed closed' };
  }
}
