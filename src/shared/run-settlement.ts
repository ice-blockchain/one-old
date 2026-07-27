// Canonical lifecycle settlement sidecar. Runtime 1.0.19 ignores this V2 file;
// current runtimes reconcile its legacy run/maintenance projections
// idempotently at SessionStart and UserPromptSubmit.

import * as fs from 'fs';
import * as path from 'path';

import { pluginVersion } from '../config/plugin-identity';
import { readJson, writeJson } from './fsjson';
import { isMaintenanceTerminal, maintenanceOutcome } from './maintenance-terminal';
import { paidFallbackCompletionFromMaintenance } from './maintenance-fallback-proof';
import { sha256 } from './text';
import { withProjectStateLock } from './state/project-state-lock';
import { strictRunVerificationEvidence } from './strict-verification-evidence';

export const RUN_SETTLEMENT_SCHEMA_VERSION = 2 as const;
export const RUN_SETTLEMENT_MIN_RUNTIME_VERSION = '1.0.20';

export type CanonicalRunStatus =
  | 'planned'
  | 'active'
  | 'code-delivered'
  | 'validating'
  | 'verified'
  | 'failed'
  | 'blocked';

export interface RunSettlementV2 {
  schemaVersion: typeof RUN_SETTLEMENT_SCHEMA_VERSION;
  runId: string;
  runtimeVersion: string;
  minimumRuntimeVersion: string;
  status: CanonicalRunStatus;
  reason?: string;
  workUnitContractHash?: string;
  allowlistHash?: string;
  fallback?: {
    state: 'pending' | 'completed' | 'not-allowed';
    workUnitContractHash: string;
    allowlistHash: string;
  };
  activeClaims: number;
  incompleteChecks: string[];
  revision: number;
  updatedAt: string;
  settlementHash: string;
}

export interface SettlementUpdate {
  status: CanonicalRunStatus;
  reason?: string;
  workUnitContractHash?: string;
  allowlistHash?: string;
  fallback?: RunSettlementV2['fallback'];
  incompleteChecks?: string[];
}

export interface RunV2RollbackBarrierProjection {
  version: number;
  runId: string;
  status: 'failed';
  outcome: 'agent-failed';
  qaContractVersion: 2;
  canonicalStatus: 'active' | 'code-delivered' | 'validating';
  runtimeV2RollbackGuard: {
    minimumRuntimeVersion: string;
    canonicalStatus: 'active' | 'code-delivered' | 'validating';
  };
  [key: string]: unknown;
}

type Rec = Record<string, unknown>;

function safeRunId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
}

function runDir(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'runs', safeRunId(runId));
}

export function runSettlementPath(projectRoot: string, runId: string): string {
  return path.join(runDir(projectRoot, runId), 'settlement-v2.json');
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Rec)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function settlementHash(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

function semverTuple(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function runtimeVersionSatisfies(
  observed: string,
  minimum: string,
): boolean {
  const left = semverTuple(observed);
  const right = semverTuple(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
}

export function effectiveLegacyRunStatus(
  value: unknown,
  runtimeVersion = pluginVersion(),
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const rec = value as Rec;
  const guard = rec.runtimeV2RollbackGuard && typeof rec.runtimeV2RollbackGuard === 'object'
    ? rec.runtimeV2RollbackGuard as Rec
    : null;
  const minimum = typeof guard?.minimumRuntimeVersion === 'string'
    ? guard.minimumRuntimeVersion
    : '';
  const canonical = typeof guard?.canonicalStatus === 'string' ? guard.canonicalStatus : '';
  if (!minimum || !canonical || !runtimeVersionSatisfies(runtimeVersion, minimum)) {
    return typeof rec.status === 'string' ? rec.status : '';
  }
  if (canonical === 'planned') return 'planned';
  if (canonical === 'verified') return 'completed';
  if (canonical === 'failed') return 'failed';
  if (canonical === 'blocked') return 'blocked';
  return 'active';
}

export function effectiveLegacyRunOutcome(
  value: unknown,
  runtimeVersion = pluginVersion(),
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const rec = value as Rec;
  const effectiveStatus = effectiveLegacyRunStatus(rec, runtimeVersion);
  if (effectiveStatus === 'active' || effectiveStatus === 'planned') return '';
  const guard = rec.runtimeV2RollbackGuard && typeof rec.runtimeV2RollbackGuard === 'object'
    ? rec.runtimeV2RollbackGuard as Rec
    : null;
  const minimum = typeof guard?.minimumRuntimeVersion === 'string'
    ? guard.minimumRuntimeVersion
    : '';
  if (minimum
    && runtimeVersionSatisfies(runtimeVersion, minimum)
    && effectiveStatus === 'blocked') {
    return typeof guard?.canonicalOutcome === 'string'
      ? guard.canonicalOutcome
      : 'environment-blocked';
  }
  return typeof rec.outcome === 'string' ? rec.outcome : '';
}

export function projectRunLedgerForV2Rollback(
  value: unknown,
  canonicalStatus: CanonicalRunStatus,
  canonicalOutcome?: string,
  minimumRuntimeVersion = RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
): Rec {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Rec
    : {};
  const projection = legacyProjection(canonicalStatus, true);
  const guarded = !['verified', 'failed'].includes(canonicalStatus);
  const next: Rec = {
    ...source,
    ...projection,
    canonicalStatus,
    runtimeV2RollbackGuard: guarded
      ? {
          minimumRuntimeVersion,
          canonicalStatus,
          ...(canonicalStatus === 'blocked'
            ? { canonicalOutcome: canonicalOutcome || 'environment-blocked' }
            : {}),
        }
      : undefined,
  };
  if (!next.runtimeV2RollbackGuard) delete next.runtimeV2RollbackGuard;
  if (!projection.outcome) delete next.outcome;
  return next;
}

// Activate the V2 lifecycle before publishing the first V2-only sidecar.
//
// Runtime 1.0.19 reads the physical legacy projection and therefore sees an
// irreversible failed run. (`blocked` is insufficient: 1.0.19 permits an
// explicitly authorized blocked -> active transition.) Current runtimes
// understand the immutable rollback guard and recover its canonical in-flight
// status. Keeping this as a separate atomic write closes the crash window where
// verification-v2.json existed while run.json still looked resumable.
export function activateRunV2RollbackBarrier(
  projectRoot: string,
  runId: string,
  canonicalStatus: 'active' | 'code-delivered' | 'validating' = 'active',
): RunV2RollbackBarrierProjection | null {
  if (!runId.trim() || /[\\/]/.test(runId)) return null;
  if (!runtimeVersionSatisfies(pluginVersion(), RUN_SETTLEMENT_MIN_RUNTIME_VERSION)) return null;
  let written: RunV2RollbackBarrierProjection | null = null;
  try {
    withProjectStateLock(projectRoot, () => {
      const file = path.join(runDir(projectRoot, runId), 'run.json');
      const existing = readJson<Rec>(file, {});
      const effectiveStatus = effectiveLegacyRunStatus(existing);
      if (['completed', 'failed', 'blocked'].includes(effectiveStatus)) return;
      const now = new Date().toISOString();
      const createdAt = typeof existing.createdAt === 'string' && existing.createdAt
        ? existing.createdAt
        : now;
      const canonical: Rec = {
        ...existing,
        version: Math.max(typeof existing.version === 'number' ? existing.version : 1, 2),
        runId,
        kind: typeof existing.kind === 'string' && existing.kind
          ? existing.kind
          : 'orchestration',
        qaContractVersion: 2,
        qaContractActivatedAt: typeof existing.qaContractActivatedAt === 'string'
          && existing.qaContractActivatedAt
          ? existing.qaContractActivatedAt
          : now,
        createdAt,
        statusUpdatedAt: typeof existing.statusUpdatedAt === 'string'
          && existing.statusUpdatedAt
          ? existing.statusUpdatedAt
          : createdAt,
        transitionHistory: Array.isArray(existing.transitionHistory)
          ? existing.transitionHistory
          : [],
        updatedAt: now,
      };
      const next = projectRunLedgerForV2Rollback(
        canonical,
        canonicalStatus,
      ) as RunV2RollbackBarrierProjection;
      writeJson(file, next);
      written = next;
    });
  } catch {
    return null;
  }
  return written;
}

function parseSettlement(value: unknown, runId: string): RunSettlementV2 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<RunSettlementV2>;
  if (raw.schemaVersion !== 2
    || raw.runId !== runId
    || typeof raw.runtimeVersion !== 'string'
    || typeof raw.minimumRuntimeVersion !== 'string'
    || !['planned', 'active', 'code-delivered', 'validating', 'verified', 'failed', 'blocked'].includes(String(raw.status))
    || !Number.isInteger(raw.activeClaims)
    || Number(raw.activeClaims) < 0
    || !Array.isArray(raw.incompleteChecks)
    || !raw.incompleteChecks.every((item) => typeof item === 'string')
    || !Number.isInteger(raw.revision)
    || Number(raw.revision) < 1
    || typeof raw.updatedAt !== 'string'
    || typeof raw.settlementHash !== 'string') return null;
  const { settlementHash: observed, ...canonical } = raw;
  if (settlementHash(canonical) !== observed) return null;
  if (raw.status === 'verified' && (
    Number(raw.activeClaims) > 0
    || raw.incompleteChecks.length > 0
    || raw.fallback?.state === 'pending'
  )) return null;
  return raw as RunSettlementV2;
}

export function readRunSettlement(projectRoot: string, runId: string): RunSettlementV2 | null {
  return parseSettlement(readJson(runSettlementPath(projectRoot, runId), null), runId);
}

export interface ActiveRunClaimScan {
  count: number;
  complete: boolean;
  scanned: number;
}

export function activeRunClaimScan(projectRoot: string, runId: string): ActiveRunClaimScan {
  const dir = runDir(projectRoot, runId);
  let count = 0;
  let scanned = 0;
  let complete = true;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch {
      if (current !== dir || fs.existsSync(dir)) complete = false;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (scanned >= 2_048) {
        complete = false;
        return;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'bootstrap' || entry.name === 'transactions') continue;
        walk(absolute);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (['run.json', 'maintenance.json', 'settlement-v2.json', 'model-policy.json', 'assignments.json'].includes(entry.name)) continue;
      scanned += 1;
      const rec = readJson<Rec | null>(absolute, null);
      if (!rec) continue;
      const status = typeof rec.status === 'string' ? rec.status : '';
      if (status === 'pending' || status === 'claimed' || status === 'active' || status === 'running') count += 1;
    }
  };
  walk(dir);
  return { count, complete, scanned };
}

export function activeRunClaimCount(projectRoot: string, runId: string): number {
  const scan = activeRunClaimScan(projectRoot, runId);
  // Existing callers use a positive value as a terminal-settlement veto. A
  // truncated/unreadable scan therefore returns a conservative sentinel even
  // when no active record occurred in the inspected prefix.
  return scan.complete ? scan.count : Math.max(1, scan.count);
}

function legacyProjection(
  status: CanonicalRunStatus,
  rollbackProtected: boolean,
): { status: string; outcome?: string } {
  if (status === 'verified') return { status: 'completed', outcome: 'verified' };
  if (status === 'failed') return { status: 'failed', outcome: 'agent-failed' };
  if (rollbackProtected) {
    // Runtime 1.0.19 permits `blocked -> active` after a special resume reason.
    // `failed` is the only legacy terminal state that cannot be reopened.
    return { status: 'failed', outcome: 'agent-failed' };
  }
  if (status === 'blocked') return { status: 'blocked', outcome: 'environment-blocked' };
  if (status === 'planned') return { status: 'planned' };
  return { status: 'active' };
}

function writeLegacyProjection(projectRoot: string, settlement: RunSettlementV2): void {
  const file = path.join(runDir(projectRoot, settlement.runId), 'run.json');
  const existing = readJson<Rec>(file, {});
  const rollbackProtected = existing.qaContractVersion === 2
    || fs.existsSync(path.join(runDir(projectRoot, settlement.runId), 'verification-v2.json'));
  const effectiveExistingOutcome = effectiveLegacyRunOutcome(existing);
  const canonicalOutcome = settlement.status === 'verified' && effectiveExistingOutcome === 'shipped'
    ? 'shipped'
    : settlement.status === 'blocked'
      && ['review-cycle-cap', 'test-cycle-cap', 'environment-blocked'].includes(effectiveExistingOutcome)
      ? effectiveExistingOutcome
      : undefined;
  const projection = rollbackProtected
    ? projectRunLedgerForV2Rollback(
        existing,
        settlement.status,
        canonicalOutcome,
        settlement.minimumRuntimeVersion,
      )
    : {
        ...existing,
        ...legacyProjection(settlement.status, false),
        canonicalStatus: settlement.status,
      };
  if (settlement.status === 'verified' && canonicalOutcome === 'shipped') {
    projection.outcome = 'shipped';
  }
  const next: Rec = {
    ...projection,
    version: Math.max(typeof existing.version === 'number' ? existing.version : 1, 2),
    runId: settlement.runId,
    canonicalStatus: settlement.status,
    settlementHash: settlement.settlementHash,
    settlementUpdatedAt: settlement.updatedAt,
    updatedAt: settlement.updatedAt,
  };
  if (!next.runtimeV2RollbackGuard) delete next.runtimeV2RollbackGuard;
  if (!next.outcome) delete next.outcome;
  writeJson(file, next);

  const maintenanceFile = path.join(runDir(projectRoot, settlement.runId), 'maintenance.json');
  if (fs.existsSync(maintenanceFile)) {
    const maintenance = readJson<Rec>(maintenanceFile, {});
    writeJson(maintenanceFile, {
      ...maintenance,
      canonicalStatus: settlement.status,
      settlementHash: settlement.settlementHash,
    });
  }
}

export function writeRunSettlement(
  projectRoot: string,
  runId: string,
  update: SettlementUpdate,
): RunSettlementV2 | null {
  if (!runId.trim() || /[\\/]/.test(runId)) return null;
  if (!runtimeVersionSatisfies(pluginVersion(), RUN_SETTLEMENT_MIN_RUNTIME_VERSION)) return null;
  let written: RunSettlementV2 | null = null;
  try {
    withProjectStateLock(projectRoot, () => {
      const previous = readRunSettlement(projectRoot, runId);
      // Canonical terminal settlements are immutable for this run. A delayed
      // projection/reconciliation pass may have read an older active ledger,
      // but it must never reopen verified, failed, or blocked work.
      if (previous && ['verified', 'failed', 'blocked'].includes(previous.status)) {
        written = previous;
        writeLegacyProjection(projectRoot, previous);
        return;
      }
      const claimScan = activeRunClaimScan(projectRoot, runId);
      const activeClaims = claimScan.complete ? claimScan.count : Math.max(1, claimScan.count);
      const incompleteChecks = [...new Set([
        ...(update.incompleteChecks || []),
        ...(!claimScan.complete ? ['active-claim-scan-incomplete'] : []),
      ])].sort();
      let status = update.status;
      let reason = update.reason;
      let fallback = update.fallback;
      const maintenance = readJson<Rec | null>(
        path.join(runDir(projectRoot, runId), 'maintenance.json'),
        null,
      );
      if (status === 'verified') {
        const trackedFallback = previous?.fallback;
        if (trackedFallback || recordsPaidFallback(maintenance)) {
          const match = fallbackCompletionMatch(trackedFallback, maintenance);
          const requestedCompletionMatches = trackedFallback?.state !== 'pending'
            || (
              fallback?.state === 'completed'
              && fallback.workUnitContractHash === trackedFallback.workUnitContractHash
              && fallback.allowlistHash === trackedFallback.allowlistHash
            );
          if (match !== 'matched' || !requestedCompletionMatches) {
            status = 'validating';
            fallback = trackedFallback;
            reason = match === 'hash-mismatch'
              ? 'fallback-contract-mismatch'
              : match === 'marker-missing'
                ? 'fallback-marker-missing'
                : 'fallback-pending';
            incompleteChecks.push(match === 'hash-mismatch'
              ? 'fallback-hash-mismatch'
              : match === 'marker-missing'
                ? 'fallback-marker-missing'
                : 'fallback-pending');
          }
        }
      }
      if (status === 'verified') {
        const verification = strictRunVerificationEvidence(projectRoot, runId);
        // A canonical V2 settlement is never certified from legacy digest
        // conventions alone. Legacy ledgers remain readable for compatibility,
        // but adopting them into `verified` requires the runtime-owned
        // VerificationContractV2 and its matching QaReportV2 — including
        // backend/non-UI runs, whose build/test/lint checks live in that report.
        if (!verification.ok || verification.evidenceKind !== 'v2') {
          status = 'validating';
          reason = 'verification-evidence-incomplete';
          incompleteChecks.push(...verification.incompleteChecks);
          if (verification.evidenceKind !== 'v2') {
            incompleteChecks.push('verification-contract-missing-or-invalid');
            incompleteChecks.push('qa-verification-incomplete');
          }
        }
      }
      if (update.status === 'verified' && (
        activeClaims > 0
        || incompleteChecks.length > 0
        || fallback?.state === 'pending'
      )) {
        status = 'validating';
        if (activeClaims > 0) incompleteChecks.push('active-claims');
        if (fallback?.state === 'pending') incompleteChecks.push('fallback-pending');
      }
      const normalizedIncomplete = [...new Set(incompleteChecks)].sort();
      const unchanged = previous
        && previous.status === status
        && previous.runtimeVersion === pluginVersion()
        && previous.minimumRuntimeVersion === RUN_SETTLEMENT_MIN_RUNTIME_VERSION
        && previous.reason === reason
        && previous.workUnitContractHash === update.workUnitContractHash
        && previous.allowlistHash === update.allowlistHash
        && JSON.stringify(previous.fallback || null) === JSON.stringify(fallback || null)
        && previous.activeClaims === activeClaims
        && JSON.stringify(previous.incompleteChecks) === JSON.stringify(normalizedIncomplete);
      if (unchanged) {
        written = previous;
        writeLegacyProjection(projectRoot, previous);
        return;
      }
      const withoutHash = {
        schemaVersion: RUN_SETTLEMENT_SCHEMA_VERSION,
        runId,
        runtimeVersion: pluginVersion(),
        minimumRuntimeVersion: RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
        status,
        ...(reason ? { reason } : {}),
        ...(update.workUnitContractHash ? { workUnitContractHash: update.workUnitContractHash } : {}),
        ...(update.allowlistHash ? { allowlistHash: update.allowlistHash } : {}),
        ...(fallback ? { fallback } : {}),
        activeClaims,
        incompleteChecks: normalizedIncomplete,
        revision: (previous?.revision || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      written = { ...withoutHash, settlementHash: settlementHash(withoutHash) };
      writeJson(runSettlementPath(projectRoot, runId), written);
      writeLegacyProjection(projectRoot, written);
    });
  } catch {
    return null;
  }
  return written;
}

function digestExists(projectRoot: string, runId: string, names: string[]): boolean {
  return names.some((name) => {
    try {
      return fs.readFileSync(path.join(projectRoot, '.traffic-one', 'digests', safeRunId(runId), name), 'utf8').trim().length > 0;
    } catch {
      return false;
    }
  });
}

type FallbackCompletionMatch = 'matched' | 'pending' | 'marker-missing' | 'hash-mismatch';

function recordsPaidFallback(value: unknown): boolean {
  return Boolean(paidFallbackCompletionFromMaintenance(value));
}

function rawPaidFallback(value: Rec | null): boolean {
  return [value?.overallOutcome, value?.outcome]
    .some((candidate) => typeof candidate === 'string'
      && candidate.trim().toLowerCase() === 'fallback-paid');
}

function fallbackCompletionMatch(
  pending: RunSettlementV2['fallback'] | undefined,
  maintenance: Rec | null,
): FallbackCompletionMatch {
  const outcome = maintenanceOutcome(maintenance);
  if (outcome === 'failed' || outcome === 'blocked') return 'pending';
  const rawPaidMarker = rawPaidFallback(maintenance);
  const completion = paidFallbackCompletionFromMaintenance(maintenance);
  if (!rawPaidMarker && !isMaintenanceTerminal(maintenance)) return 'pending';
  if (!pending) return rawPaidMarker ? 'marker-missing' : 'matched';
  const workUnitContractHash = typeof maintenance?.workUnitContractHash === 'string'
    ? maintenance.workUnitContractHash
    : '';
  const allowlistHash = typeof maintenance?.allowlistHash === 'string'
    ? maintenance.allowlistHash
    : '';
  if (!pending.workUnitContractHash
    || !pending.allowlistHash
    || workUnitContractHash !== pending.workUnitContractHash
    || allowlistHash !== pending.allowlistHash) {
    return 'hash-mismatch';
  }
  if (!completion) return 'marker-missing';
  if (pending.state !== 'completed') return 'pending';
  if (completion.workUnitContractHash !== pending.workUnitContractHash
    || completion.allowlistHash !== pending.allowlistHash) {
    return 'hash-mismatch';
  }
  return 'matched';
}

// Idempotently derives the canonical lifecycle from legacy projections. It
// never manufactures verification from digest prose: only an already-settled
// run ledger or terminal maintenance result can project `verified`.
export function reconcileRunSettlement(projectRoot: string, runId: string): RunSettlementV2 | null {
  if (!runId.trim()) return null;
  try {
    return withProjectStateLock(projectRoot, () => {
      const current = readRunSettlement(projectRoot, runId);
      const ledger = readJson<Rec>(path.join(runDir(projectRoot, runId), 'run.json'), {});
      // Reconciliation is idempotent for runs that have activated the V2
      // lifecycle, but it must not silently upgrade a 1.0.19/V1 run merely
      // because a prompt boundary was crossed. Doing so would turn a resumable
      // legacy `blocked` ledger into an immutable canonical terminal settlement
      // and would also replace legacy digest/QA settlement semantics.
      const hasMaintenanceProjection = fs.existsSync(
        path.join(runDir(projectRoot, runId), 'maintenance.json'),
      );
      const legacyStatus = typeof ledger.status === 'string' ? ledger.status : '';
      const v2Activated = current
        || ledger.qaContractVersion === 2
        || fs.existsSync(path.join(runDir(projectRoot, runId), 'verification-v2.json'))
        // Maintenance runner output is a reconciliation input even when the
        // originating 1.0.19 run never wrote qaContractVersion. Likewise, a
        // legacy success/failure ledger may be adopted only through the strict
        // V2 verifier below. A bare legacy `blocked` run is deliberately
        // excluded: it remains resumable by the historical, explicitly
        // user-authorized transition instead of being frozen as a canonical
        // immutable terminal settlement at prompt start.
        || hasMaintenanceProjection
        || legacyStatus === 'completed'
        || legacyStatus === 'failed';
      if (!v2Activated) return null;
      const ledgerStatus = effectiveLegacyRunStatus(ledger);
      const ledgerOutcome = effectiveLegacyRunOutcome(ledger);
      const maintenance = readJson<Rec | null>(path.join(runDir(projectRoot, runId), 'maintenance.json'), null);
      let status: CanonicalRunStatus = current?.status || 'planned';
      let reason = current?.reason;
      let fallback = current?.fallback;
      const incomplete: string[] = [];

      const maintenanceValue = maintenanceOutcome(maintenance);
      if (maintenanceValue === 'fallback-pending') {
        status = 'active';
        reason = 'fallback-pending';
        fallback = {
          state: 'pending',
          workUnitContractHash: typeof maintenance?.workUnitContractHash === 'string'
            ? maintenance.workUnitContractHash
            : current?.workUnitContractHash || '',
          allowlistHash: typeof maintenance?.allowlistHash === 'string'
            ? maintenance.allowlistHash
            : current?.allowlistHash || '',
        };
        incomplete.push('fallback-pending');
      } else if (rawPaidFallback(maintenance) && !recordsPaidFallback(maintenance)) {
        const fallbackMatch = fallbackCompletionMatch(fallback, maintenance);
        status = 'active';
        reason = fallbackMatch === 'hash-mismatch'
          ? 'fallback-contract-mismatch'
          : fallbackMatch === 'pending'
            ? 'fallback-pending'
            : 'fallback-marker-missing';
        incomplete.push(fallbackMatch === 'hash-mismatch'
          ? 'fallback-hash-mismatch'
          : fallbackMatch === 'pending'
            ? 'fallback-pending'
            : 'fallback-marker-missing');
      } else if (isMaintenanceTerminal(maintenance)) {
        if (maintenanceValue === 'failed') {
          status = 'failed';
          if (fallback?.state === 'pending') fallback = { ...fallback, state: 'not-allowed' };
        } else if (maintenanceValue === 'blocked') {
          status = 'blocked';
          if (fallback?.state === 'pending') fallback = { ...fallback, state: 'not-allowed' };
        } else {
          const fallbackMatch = fallbackCompletionMatch(fallback, maintenance);
          if (fallbackMatch !== 'matched') {
            status = 'active';
            reason = fallbackMatch === 'hash-mismatch'
              ? 'fallback-contract-mismatch'
              : fallbackMatch === 'pending'
                ? 'fallback-pending'
                : 'fallback-marker-missing';
            incomplete.push(fallbackMatch === 'hash-mismatch'
              ? 'fallback-hash-mismatch'
              : fallbackMatch === 'pending'
                ? 'fallback-pending'
                : 'fallback-marker-missing');
          } else {
            if (fallback?.state === 'pending') {
              fallback = {
                ...fallback,
                state: 'completed',
              };
            }
            status = 'verified';
          }
        }
      } else if (ledgerStatus === 'completed' && (ledgerOutcome === 'verified' || ledgerOutcome === 'shipped')) {
        status = 'verified';
      } else if (ledgerStatus === 'failed') {
        status = 'failed';
      } else if (ledgerStatus === 'blocked') {
        status = 'blocked';
      } else if (strictRunVerificationEvidence(projectRoot, runId).ok) {
        status = 'verified';
      } else if (digestExists(projectRoot, runId, ['reviewer.md', 'senior-reviewer.md', 'tester.md', 'senior-tester.md'])) {
        status = 'validating';
        incomplete.push('verification-incomplete');
      } else if (digestExists(projectRoot, runId, ['frontend.md', 'senior-frontend.md', 'backend.md', 'senior-backend.md'])) {
        status = 'code-delivered';
        incomplete.push('verification-not-started');
      } else if (ledgerStatus === 'active') {
        status = 'active';
      }

      return writeRunSettlement(projectRoot, runId, {
        status,
        ...(reason ? { reason } : {}),
        ...(current?.workUnitContractHash ? { workUnitContractHash: current.workUnitContractHash } : {}),
        ...(current?.allowlistHash ? { allowlistHash: current.allowlistHash } : {}),
        ...(fallback ? { fallback } : {}),
        incompleteChecks: incomplete,
      });
    });
  } catch {
    return null;
  }
}
