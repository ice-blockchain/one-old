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
  projectMaintenanceMarker,
  type FallbackSourceSnapshotV1,
  type PaidFallbackCompletionV1,
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

// Runtime-owned supersede transition for a SKIPPED delegation's pending
// fallback. A delegation that never ran (e.g. no git HEAD to sandbox — the
// existing-codebase no-repo case) still recorded `fallback-pending` with the
// bounded unit's hashes, and `fallbackContractMatches` then pinned every
// FUTURE work unit for that role to those hashes — so when the run escalated
// to the architect, the compiled contracts could never publish and PLAN_READY
// was denied forever (observed run 1785623723274). Nothing was delegated and
// nothing was touched, so a freshly compiled architecture legitimately
// supersedes the bounded scope. The sentinel is deliberately NON-terminal
// ('superseded' is not in MAINTENANCE_TERMINAL_OUTCOMES): a terminal outcome
// mid-run made per-prompt reconciliation read the re-planned run as a
// completed maintenance run — 'verified' → evidence-downgraded 'validating',
// origin/HEAD spawn-survival ref stripped — before any implementer spawned.
// With a non-terminal, non-pending sentinel every marker reader treats it as
// inert and the run proceeds as a normal compiled run. A delegation that RAN
// and failed keeps its pending fallback — the paid fallback proof chain
// against the captured pre-image still applies there.
export function supersedeSkippedDelegationFallback(
  projectRoot: string,
  runId: string,
  architectureHash: string,
): boolean {
  if (!runId.trim() || /[\\/]/.test(runId)) return false;
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
      if (!marker
        || marker.overallOutcome !== 'fallback-pending'
        || marker.fallbackAllowed !== true
        || marker.outcome !== 'skipped'
        || (Array.isArray(marker.touched) && marker.touched.length > 0)) {
        return false;
      }
      writeJson(markerPath, {
        ...marker,
        overallOutcome: 'superseded',
        outcome: 'superseded',
        fallbackAllowed: false,
        supersededByArchitectureHash: architectureHash,
        supersededAt: new Date().toISOString(),
      });
      // Re-derive the canonical settlement without the fallback pin: the
      // writer drops `fallback`/`reason`/hashes that the update omits, and
      // reconcile no longer re-pins once the marker is terminal 'skipped'.
      writeRunSettlement(projectRoot, runId, {
        status: 'active',
        incompleteChecks: ['verification-not-started'],
      });
      return true;
    });
  } catch {
    return false;
  }
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
      // Which pending debts does the ACTIVE envelope cover?
      // - EXACT: the envelope is one debt's pinned contract → that debt alone.
      // - UNION: the envelope's source files equal the union of every pending
      //   debt's pinned baseline paths (set equality — the same rule that
      //   admitted the envelope in `fallbackContractMatches`) → each covered
      //   debt is judged on ITS OWN baseline and its own delta. This is how a
      //   single paid child discharges a multi-unit batch; without it two
      //   debts for one role could never both be discharged, because no single
      //   envelope hash-matches more than one pin.
      const unitRecords = marker.units && typeof marker.units === 'object' && !Array.isArray(marker.units)
        ? marker.units as Record<string, Rec>
        : null;
      const pendingEntries: Array<[string, Rec]> = unitRecords
        ? Object.entries(unitRecords).filter(([, record]) => record.overallOutcome === 'fallback-pending')
        : [['(legacy)', marker]];
      const exactMode = marker.workUnitContractHash === bootstrap.workUnit.contractHash
        && marker.allowlistHash === allowlistHash;
      let coveredDebts: Array<[string, Rec]>;
      if (exactMode) {
        coveredDebts = pendingEntries.filter(([, record]) => (
          record.workUnitContractHash === bootstrap.workUnit.contractHash
          && record.allowlistHash === allowlistHash
        ));
        if (coveredDebts.length === 0) coveredDebts = [['(legacy)', marker]];
      } else {
        const envelopeSources = fallbackSourcePaths(bootstrap);
        // The union may span PAID debts too: after a partial discharge, the same
        // union envelope stays active while only the remaining debts are still
        // pending, and the second finalization pass must still recognize it.
        const settledEntries: Array<[string, Rec]> = unitRecords
          ? Object.entries(unitRecords).filter(([, record]) => (
            record.overallOutcome === 'fallback-pending' || record.overallOutcome === 'fallback-paid'
          ))
          : pendingEntries;
        const unionOf = (entries: Array<[string, Rec]>): string | null => {
          const union = new Set<string>();
          for (const [, record] of entries) {
            const parsed = parseFallbackSourceSnapshot(record.fallbackSourceBaseline);
            if (!parsed) return null;
            for (const entry of parsed.files) union.add(entry.path);
          }
          return union.size > 0 ? JSON.stringify([...union].sort()) : null;
        };
        const envelopeKey = envelopeSources ? JSON.stringify(envelopeSources) : null;
        if (!envelopeKey
          || (envelopeKey !== unionOf(pendingEntries) && envelopeKey !== unionOf(settledEntries))) {
          return { status: 'invalid', reason: 'maintenance fallback hashes do not match the active WorkUnit' };
        }
        coveredDebts = pendingEntries;
      }
      const settlementBefore = readRunSettlement(projectRoot, runId);
      // The settlement tracks the PROJECTED (oldest) debt's hashes, which under
      // a union envelope are not the envelope's own — require only that it
      // tracks a pending fallback pinned by one of the covered debts.
      if (settlementBefore && (
        settlementBefore.fallback?.state !== 'pending'
        || !coveredDebts.some(([, record]) => (
          settlementBefore.fallback?.workUnitContractHash === record.workUnitContractHash
          && settlementBefore.fallback?.allowlistHash === record.allowlistHash
        ))
      )) {
        return { status: 'invalid', reason: 'canonical settlement does not track this exact pending fallback' };
      }
      // Judge every covered debt on its own pre-image. A debt with no delta yet
      // simply stays pending (in union mode a partial delivery discharges what
      // it proved and nothing else); an unreadable pre-image is invalid.
      interface DischargeCandidate {
        key: string;
        record: Rec;
        changedPaths: string[];
        sourceBefore: FallbackSourceSnapshotV1;
        sourceAfter: FallbackSourceSnapshotV1;
        runBaselineHash: string;
      }
      const dischargeCandidates: DischargeCandidate[] = [];
      for (const [key, record] of coveredDebts) {
        const sourceBefore = parseFallbackSourceSnapshot(record.fallbackSourceBaseline);
        if (!sourceBefore) {
          return { status: 'invalid', reason: 'runtime source pre-image is missing or does not match the WorkUnit' };
        }
        const debtPaths = sourceBefore.files.map((entry) => entry.path);
        if (exactMode) {
          const envelopeSources = fallbackSourcePaths(bootstrap);
          if (!envelopeSources || JSON.stringify(debtPaths) !== JSON.stringify(envelopeSources)) {
            return { status: 'invalid', reason: 'runtime source pre-image is missing or does not match the WorkUnit' };
          }
        }
        const sourceAfter = captureFallbackSourceSnapshot(projectRoot, debtPaths);
        if (!sourceAfter) {
          return { status: 'invalid', reason: 'current WorkUnit source state cannot be scanned completely' };
        }
        const changed = changedSnapshotPaths(sourceBefore, sourceAfter);
        if (!changed || changed.length === 0) continue;
        const baselineDelta = runBaselineDelta(projectRoot, runId, sourceAfter);
        if (!baselineDelta) {
          return { status: 'invalid', reason: 'immutable run baseline cannot prove the current source delta' };
        }
        const confirmed = changed.filter((relative) => baselineDelta.changedPaths.includes(relative));
        if (confirmed.length === 0) continue;
        dischargeCandidates.push({
          key,
          record,
          changedPaths: confirmed,
          sourceBefore,
          sourceAfter,
          runBaselineHash: baselineDelta.baselineHash,
        });
      }
      if (dischargeCandidates.length === 0) {
        return { status: 'pending', reason: 'paid fallback has not produced an in-allowlist source delta' };
      }
      const changedPaths = [...new Set(dischargeCandidates.flatMap((candidate) => candidate.changedPaths))].sort();
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
      // The digest must postdate every debt it discharges — judged per debt, so
      // in union mode an older debt whose terminal failure predates the digest
      // discharges while a debt that failed AFTER the digest was written stays
      // pending rather than invalidating the whole finalization.
      const dischargeable = dischargeCandidates.filter((candidate) => {
        const finishedAt = markerTime(candidate.record.finishedAt);
        return finishedAt > 0 && digestMtime >= finishedAt;
      });
      if (dischargeable.length === 0) {
        return { status: 'invalid', reason: 'paid fallback digest predates the OpenCode terminal failure' };
      }

      const digestHash = fileHash(digestBytes);
      const completedAt = new Date().toISOString();
      const completions = dischargeable.map((candidate) => ({
        candidate,
        completion: createPaidFallbackCompletion({
          role,
          envelopeHash: bootstrap.envelopeHash,
          workUnitContractHash: String(candidate.record.workUnitContractHash || bootstrap.workUnit.contractHash),
          allowlistHash: String(candidate.record.allowlistHash || allowlistHash),
          digestPath,
          digestHash,
          sourceBaselineHash: candidate.sourceBefore.stateHash,
          sourceResultHash: candidate.sourceAfter.stateHash,
          runBaselineHash: candidate.runBaselineHash,
          changedPaths: candidate.changedPaths,
          completedAt,
        }),
      }));
      const completion = completions[0]!.completion;
      // Discharge THIS debt only. With the per-unit ledger, the marker's
      // top-level fields are a projection of the oldest pending debt — the one
      // this finalization just proved — so the unit record matching the active
      // envelope's hashes flips to fallback-paid and the marker re-projects.
      // A sibling debt still pending keeps the top level (and the settlement)
      // on `fallback-pending` with ITS hashes; wholesale-overwriting the marker
      // here was the same single-slot defect the delegation writer had.
      const dischargedFields = (unitCompletion: PaidFallbackCompletionV1): Rec => ({
        outcome: 'fallback-paid',
        overallOutcome: 'fallback-paid',
        fallbackAllowed: false,
        fallbackCompletion: unitCompletion,
        finishedAt: unitCompletion.completedAt,
      });
      const units = unitRecords ? { ...unitRecords } : null;
      let completedMarker: Rec;
      let nextPending: Rec | null = null;
      if (units) {
        for (const { candidate, completion: unitCompletion } of completions) {
          if (!units[candidate.key]) {
            return { status: 'invalid', reason: 'no pending per-unit debt matches the active WorkUnit' };
          }
          units[candidate.key] = { ...units[candidate.key]!, ...dischargedFields(unitCompletion) };
        }
        const projected = projectMaintenanceMarker(units)
          || units[completions[0]!.candidate.key]!;
        nextPending = projected.overallOutcome === 'fallback-pending' ? projected : null;
        completedMarker = {
          version: 1,
          kind: 'opencode-delegation',
          ...projected,
          units,
        };
      } else {
        completedMarker = { ...marker, ...dischargedFields(completion) };
      }
      writeJson(markerPath, completedMarker);
      const nextContract = nextPending ? String(nextPending.workUnitContractHash || '') : '';
      const nextAllowlist = nextPending ? String(nextPending.allowlistHash || '') : '';
      const settlement = writeRunSettlement(projectRoot, runId, nextPending && nextContract && nextAllowlist
        ? {
            status: 'active',
            reason: 'fallback-pending',
            workUnitContractHash: nextContract,
            allowlistHash: nextAllowlist,
            fallback: {
              state: 'pending',
              workUnitContractHash: nextContract,
              allowlistHash: nextAllowlist,
            },
            incompleteChecks: ['fallback-pending'],
          }
        : {
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
      // The readback proves the completion LANDED. When a sibling debt keeps the
      // top level pending, the completion lives in the discharged unit's record,
      // so it is validated there instead of at the top level.
      const rereadMarker = readJson<Rec | null>(markerPath, null);
      const rereadUnits = (rereadMarker?.units && typeof rereadMarker.units === 'object'
        ? rereadMarker.units
        : {}) as Record<string, Rec>;
      const completionLanded = units
        ? completions.every(({ candidate }) => paidFallbackCompletionFromMaintenance({
          ...rereadUnits[candidate.key],
          role: marker.role,
        }))
        : Boolean(paidFallbackCompletionFromMaintenance(rereadMarker));
      const settlementLanded = nextPending
        ? Boolean(settlement
          && settlement.status === 'active'
          && settlement.fallback?.state === 'pending'
          && settlement.fallback.workUnitContractHash === nextContract)
        : Boolean(settlement
          && settlement.status === 'code-delivered'
          && settlement.fallback?.state === 'completed'
          && settlement.workUnitContractHash === bootstrap.workUnit.contractHash
          && settlement.allowlistHash === allowlistHash);
      if (!settlementLanded || !completionLanded) {
        // Fail closed. Each JSON write is atomic and the outer project lock
        // excludes concurrent observers; restoring the pending marker makes a
        // crash/failure retryable instead of advertising partial completion.
        writeJson(markerPath, marker);
        return { status: 'invalid', reason: 'canonical paid-fallback settlement could not be published' };
      }
      return {
        status: 'completed',
        reason: nextPending
          ? 'paid fallback source delivery was finalized; a sibling unit\'s fallback remains pending'
          : 'paid fallback source delivery was finalized; verification remains pending',
        changedPaths,
      };
    });
  } catch {
    return { status: 'invalid', reason: 'paid fallback finalization transaction failed closed' };
  }
}
