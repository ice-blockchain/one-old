// src/shared/run-settlement-reconcile.ts
// Paid-fallback completion reconciliation for settled runs.

import * as fs from 'fs';
import * as path from 'path';
import { readJsonResult } from '../fsjson';
import { removeOriginHeadRef } from '../git-init';
import { isMaintenanceTerminal, maintenanceOutcome } from '../maintenance/terminal';
import { withProjectStateLock } from '../state/project-state-lock';
import { strictRunVerificationEvidence } from '../strict-verification-evidence';

import {
  runDir,
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
      // ── The two files this whole derivation is made of ────────────────────
      // Everything below is a projection of `run.json` and `maintenance.json`
      // onto a canonical status. `readJson(file, fallback)` answered an ABSENT
      // file and an ILLEGIBLE one (unparseable, EMPTY — the signature of an
      // O_TRUNC open whose write never landed — or unreadable) with the same
      // value, so "I could not read it" arrived here as a confident fact about
      // the run. Both inversions are measured, and both are the same shape the
      // sibling `activateRunV2RollbackBarrier` was fixed for:
      //
      //   run.json — the terminal arms below (`ledgerStatus === 'failed'` /
      //   `'blocked'` / a completed+verified ledger) are decided from these
      //   bytes, and `effectiveLegacyRunStatus({})` is '' — not terminal. A
      //   FAILED run whose ledger was torn reconciled as `code-delivered`, and
      //   `writeLegacyProjection` then HEALED run.json into an in-flight
      //   projection carrying `canonicalStatus: 'code-delivered'`. The finished
      //   run came back alive, and the only record that said otherwise was
      //   overwritten in the same pass.
      //
      //   maintenance.json — the `fallback-pending` arm is decided from these
      //   bytes, and `maintenanceOutcome(null)` is ''. A run owing a paid
      //   fallback whose marker was torn reconciled as `verified`: the debt was
      //   not merely untracked, it was LAUNDERED, because the settlement is what
      //   the finalizer later checks the debt against.
      //
      // REFUSING, both files, both kinds. Reconciliation derives; a derivation
      // whose inputs cannot be read has nothing honest to publish — the same
      // answer `patchState` gives a base it cannot see. It needs no new channel
      // (`| null` is already the answer for a non-activated run and for the
      // `catch`), and it is the one option that writes NOTHING, so the bytes
      // recording the run's real history stay on disk for a repair to read.
      //
      // It deadlocks nothing: all three production callers — UserPromptSubmit,
      // SessionStart and the QA-evidence run context — discard this return, so
      // `null` is already the ordinary outcome, and every OTHER settlement
      // writer (the ledger state machine, the OpenCode maintenance recorder,
      // the paid-fallback finalizer) still reaches `writeRunSettlement` on its
      // own. What stops is only this pass's guess.
      const ledgerRead = readJsonResult<Rec>(path.join(runDir(projectRoot, runId), 'run.json'));
      if (ledgerRead.kind === 'corrupt' || ledgerRead.kind === 'unreadable') return null;
      const maintenanceRead = readJsonResult<Rec>(path.join(runDir(projectRoot, runId), 'maintenance.json'));
      if (maintenanceRead.kind === 'corrupt' || maintenanceRead.kind === 'unreadable') return null;
      const ledger = ledgerRead.kind === 'ok' ? ledgerRead.value : {};
      // Reconciliation is idempotent for runs that have activated the V2
      // lifecycle, but it must not silently upgrade a 1.0.19/V1 run merely
      // because a prompt boundary was crossed. Doing so would turn a resumable
      // legacy `blocked` ledger into an immutable canonical terminal settlement
      // and would also replace legacy digest/QA settlement semantics.
      //
      // `kind === 'ok'` rather than the `existsSync` this used to be: the two
      // agree on every input that still reaches here, because an existing but
      // illegible sidecar already returned above.
      const hasMaintenanceProjection = maintenanceRead.kind === 'ok';
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
      const maintenance = maintenanceRead.kind === 'ok' ? maintenanceRead.value : null;
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

      // A run that has stopped moving no longer needs the spawn-survival ref
      // `ensureRunBootstrap` created, so the user's repo is left as it was found.
      // Ownership is proven by the absence of a real `origin` remote — once one
      // exists the ref is git's and `removeOriginHeadRef` returns untouched.
      if (status === 'verified' || status === 'failed' || status === 'blocked') {
        removeOriginHeadRef(projectRoot);
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
