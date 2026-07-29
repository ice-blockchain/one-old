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
      writeJson(file, next);
      written = next;
    });
  } catch {
    return null;
  }
  return written;
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

export function writeLegacyProjection(projectRoot: string, settlement: RunSettlementV2): void {
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

