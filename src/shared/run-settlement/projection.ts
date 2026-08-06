// src/shared/run-settlement-projection.ts
// Legacy run.json projection + the v2 rollback barrier: how a v2 settlement
// is mirrored into the legacy fields old runtimes still read.

import * as fs from 'fs';
import * as path from 'path';
import { pluginVersion } from '../../config/plugin-identity';
import { readJson, writeJson } from '../fsjson';
import { withProjectStateLock } from '../state/project-state-lock';

import {
  RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
  runDir,
  runtimeVersionSatisfies,
  settlementHash,
  type CanonicalRunStatus,
  type Rec,
  type RunSettlementV2,
  type RunV2RollbackBarrierProjection,
} from './types';

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
      // Same `| null` channel the `catch` uses, for the other way this fails:
      // the fence refuses the write (fsjson.ts) and returns `false`. That was
      // dropped, so a barrier that never landed reported itself activated — and
      // plan-readiness went on to publish verification-v2.json behind a run.json
      // an older runtime still reads as resumable, which is exactly the crash
      // window this separate atomic write exists to close.
      if (!writeJson(file, next)) return;
      written = next;
    });
  } catch {
    return null;
  }
  return written;
}


/**
 * The legacy `status`/`outcome` pair written into `run.json` for runtimes older
 * than the v2 settlement. `canonicalStatus` is the truth; these two are a
 * compatibility projection of it.
 *
 * READ THIS BEFORE DIAGNOSING A RUN. Under the rollback barrier this reports
 * `failed`/`agent-failed` over a run that is alive and progressing — which looks
 * exactly like a dead run to anyone reading the file. It has now cost two
 * separate investigations a full diagnosis cycle, and in 16co it sat next to
 * `canonicalStatus: "active"` on a run that went on to finish `verified`.
 *
 * Do NOT "fix" this by renaming the keys to `legacyStatus`/`legacyOutcome`: the
 * barrier works precisely because an OLD runtime reads `status` and refuses to
 * reopen the run. Renaming makes it read a missing field and proceed, which is
 * the failure the barrier exists to prevent. Every current reader already goes
 * through `effectiveLegacyRunStatus`.
 */
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

const BLOCKED_OUTCOMES = ['review-cycle-cap', 'test-cycle-cap', 'environment-blocked'];

const TERMINAL_LEGACY_STATUS: Partial<Record<CanonicalRunStatus, string>> = {
  verified: 'completed',
  failed: 'failed',
  blocked: 'blocked',
};
const PROJECTED_TRANSITION_HISTORY_LIMIT = 32;

// `writeLegacyProjection` is the only writer of run.json that does NOT go
// through the run-ledger state machine, and `reconcileRunSettlement` can derive
// a terminal canonical status the ledger never transitioned to (a terminal
// maintenance result, or strict V2 verification evidence). When that happened,
// run.json ended up carrying a terminal `canonicalStatus` while
// `transitionHistory` still stopped at `planned -> active` and `statusUpdatedAt`
// stayed frozen at that moment — only `updatedAt` moved on. The lifecycle record
// has to be single-sourced: whichever writer moves the run to a terminal state
// records the transition, exactly as `writeRunLedgerTransition` does.
function recordProjectedTerminalTransition(
  existing: Rec,
  next: Rec,
  settlement: RunSettlementV2,
): void {
  const terminal = TERMINAL_LEGACY_STATUS[settlement.status];
  if (!terminal) return;
  const previous = effectiveLegacyRunStatus(existing);
  if (previous === terminal) return;
  const at = settlement.updatedAt;
  // Read the outcome back off the finished projection so the entry records the
  // CANONICAL outcome, not the `agent-failed` mask the rollback barrier writes
  // into the raw `status`/`outcome` pair.
  const outcome = effectiveLegacyRunOutcome(next);
  const history = (Array.isArray(existing.transitionHistory) ? existing.transitionHistory : [])
    .filter((entry): entry is Rec => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
  history.push({
    from: previous || null,
    to: terminal,
    at,
    ...(outcome ? { outcome } : {}),
    reason: 'settlement-projection',
  });
  next.transitionHistory = history.slice(-PROJECTED_TRANSITION_HISTORY_LIMIT);
  next.statusUpdatedAt = at;
  next.finishedAt = typeof existing.finishedAt === 'string' && existing.finishedAt
    ? existing.finishedAt
    : at;
}

/**
 * Mirror a settlement into the legacy `run.json` fields, and into the same two
 * fields on `maintenance.json` when that sidecar exists.
 *
 * `void` is deliberate, and it is only honest because of where this sits: the
 * canonical record is `settlement-v2.json`, and `writeRunSettlement` (io.ts) now
 * establishes that it is on disk BEFORE calling this. So a refused mirror leaves
 * legacy readers on the previous consistent projection rather than an invented
 * one, and nothing above has to revise a claim it already made. Returning a
 * boolean here would only add one more droppable value — its three call sites
 * have nothing they could do with it.
 *
 * What did have to change is the ORDER. Two writes to two paths carried the same
 * `canonicalStatus`/`settlementHash`, and both refusals were dropped, so the
 * sidecar could advance while `run.json` — the file every legacy reader consults
 * through `effectiveLegacyRunStatus` — stayed behind, each one citing a different
 * settlement. `run.json` is the primary, so its refusal now stops the pass.
 */
export function writeLegacyProjection(projectRoot: string, settlement: RunSettlementV2): void {
  const file = path.join(runDir(projectRoot, settlement.runId), 'run.json');
  const existing = readJson<Rec>(file, {});
  const rollbackProtected = existing.qaContractVersion === 2
    || fs.existsSync(path.join(runDir(projectRoot, settlement.runId), 'verification-v2.json'));
  const effectiveExistingOutcome = effectiveLegacyRunOutcome(existing);
  // `settlement-v2.json` is the canonical, hash-protected record; `run.json` is
  // only its projection. So the settlement's own `reason` outranks anything
  // derived from the projection. Without this, projecting a blocked settlement
  // while `run.json` is transiently non-blocked makes
  // `effectiveLegacyRunOutcome` short-circuit to '' (it returns '' for
  // active/planned), `canonicalOutcome` becomes undefined, and
  // `projectRunLedgerForV2Rollback` defaults it to `environment-blocked` —
  // silently rewriting a `review-cycle-cap` run as an environment failure
  // (observed 10co).
  const settlementBlockedOutcome = settlement.status === 'blocked'
    && BLOCKED_OUTCOMES.includes(String(settlement.reason || ''))
    ? settlement.reason
    : undefined;
  const canonicalOutcome = settlement.status === 'verified' && effectiveExistingOutcome === 'shipped'
    ? 'shipped'
    : settlementBlockedOutcome
      ?? (settlement.status === 'blocked'
        && BLOCKED_OUTCOMES.includes(effectiveExistingOutcome)
        ? effectiveExistingOutcome
        : undefined);
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
        // An unprotected projection publishes its status raw, so a leftover
        // guard from an earlier barrier activation would make
        // `effectiveLegacyRunStatus` keep reporting the STALE canonical status
        // and contradict the `canonicalStatus` written right here.
        runtimeV2RollbackGuard: undefined,
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
  recordProjectedTerminalTransition(existing, next, settlement);
  if (!writeJson(file, next)) return;

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

