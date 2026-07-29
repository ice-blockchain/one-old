// src/shared/run-settlement-reconcile.ts
// Paid-fallback completion reconciliation for settled runs.

import * as fs from 'fs';
import * as path from 'path';
import { readJson, writeJson } from '../fsjson';
import { isMaintenanceTerminal, maintenanceOutcome } from '../maintenance/terminal';
import { paidFallbackCompletionFromMaintenance } from '../maintenance/fallback-proof';
import { withProjectStateLock } from '../state/project-state-lock';
import { strictRunVerificationEvidence } from '../strict-verification-evidence';

import {
  runDir,
  safeRunId,
  type CanonicalRunStatus,
  type Rec,
  type RunSettlementV2,
} from './types';
import {
  effectiveLegacyRunOutcome,
  effectiveLegacyRunStatus,
} from './projection';
import {
  readRunSettlement,
  writeRunSettlement,
  digestExists,
  recordsPaidFallback,
  rawPaidFallback,
  fallbackCompletionMatch,
} from './io';






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
