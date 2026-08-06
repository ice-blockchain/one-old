// src/shared/state/run-agent/identity-drift.ts
// Run-identity drift repair and the legacy run-agent context.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import { isNonProjectRoot } from '../../authoring-root';
import { STATE_FILE } from '../../../config/paths';
import {  readJson,  writeJson } from '../../fsjson';
import {
  activeAgentRole,
  getSpawnIndex,
  isSubagentSession,
  stackFingerprint,
  UNKNOWN_STACK_FINGERPRINT,
} from '../materialization';
import { writeState } from '../normalize';
import {
  activeRunClaimCount,
  effectiveLegacyRunStatus,
} from '../../run-settlement';

import {
  assignmentsFile,
  invalidateRunLedgerFingerprint,
  runDir,
  runLedgerFile,
  runLedgerFingerprint,
  runsRoot,
} from './run-paths';
import {
  transitionRunStatus,
  withRunLedgerLockResult,
} from './ledger';
import {
  applied,
  mutationApplied,
  preconditionFailed,
  unavailable,
  type MutationResult,
} from './mutation-result';
import {
  listClaimedAgents,
  releaseRunClaims,
} from './claims-store';
import {
  type RunAgentContext,
} from './context-resolve';

// ── Run-identity drift repair ────────────────────────────────────────────────
// Un-wedge a project whose run identity already drifted away from its claims,
// with no user action. Idempotent; safe to call on every SessionStart.
//
// Two shapes are repaired:
//   1. A run ledger with NO frozen fingerprint (legacy, or minted from a
//      degraded read). Backfilled from the run's own claims — never from live
//      state, which is the moving value this whole change exists to stop
//      trusting.
//   2. Two non-terminal runs both holding live claims (a sibling run was minted
//      beside a working team). The one with real orchestration evidence wins;
//      `currentRunId` re-points to it and the loser is released and settled.
function runEvidenceScore(cwd: string, runId: string): number {
  let score = 0;
  try {
    if (fs.existsSync(assignmentsFile(cwd, runId))) score += 4;
    if (fs.existsSync(path.join(runDir(cwd, runId), 'architecture-v1.json'))) score += 4;
    if (fs.existsSync(path.join(runDir(cwd, runId), 'bootstrap'))) score += 2;
    if (fs.existsSync(path.join(runDir(cwd, runId), 'verification-v2.json'))) score += 1;
  } catch {
    return score;
  }
  return score;
}

// ADVISORY (mutation-result.ts's split rule), and named as such by the plan. The
// claim check already tolerates a ledger with no fingerprint — that is the whole
// reason this backfill is a repair rather than a requirement — so a lost one
// costs nothing beyond the repair not happening this pass. Fix #6 of the eleven:
// the lock result was discarded, so a contended ledger lock and an
// already-stamped ledger both returned `false`.
export function backfillRunLedgerFingerprintResult(cwd: string, runId: string): MutationResult<void> {
  if (runLedgerFingerprint(cwd, runId)) return preconditionFailed('already-stamped');
  const claims = listClaimedAgents(cwd, runId)
    .filter((claim) => typeof claim.stackFingerprint === 'string' && claim.stackFingerprint);
  const inherited = claims.length
    ? String(claims[claims.length - 1]!.stackFingerprint)
    : '';
  if (!inherited || inherited === UNKNOWN_STACK_FINGERPRINT) return preconditionFailed('nothing-to-inherit');
  return withRunLedgerLockResult<void>(cwd, runId, () => {
    const ledger = obj(readJson(runLedgerFile(cwd, runId), null));
    if (!ledger) return preconditionFailed('no-ledger');
    if (typeof ledger.stackFingerprint === 'string') return preconditionFailed('already-stamped');
    try {
      // `wrote = true` was unconditional, so a refused ledger reported a
      // fingerprint the next read does not find.
      const wrote = writeJson(runLedgerFile(cwd, runId), { ...ledger, stackFingerprint: inherited });
      invalidateRunLedgerFingerprint(cwd, runId);
      return wrote ? applied(undefined) : unavailable('ledger-write-refused');
    } catch {
      // Best effort — the claim check tolerates a ledger with no fingerprint.
      return unavailable('ledger-write-failed');
    }
  });
}

function backfillRunLedgerFingerprint(cwd: string, runId: string): boolean {
  return mutationApplied(backfillRunLedgerFingerprintResult(cwd, runId));
}

export function reconcileRunIdentityDrift(cwd: string, state: unknown): boolean {
  if (isNonProjectRoot(cwd)) return false;
  const s = obj(state);
  if (!s) return false;
  let changed = false;
  const live: { runId: string; score: number; val: number }[] = [];
  try {
    if (!fs.existsSync(runsRoot(cwd))) return false;
    for (const name of fs.readdirSync(runsRoot(cwd))) {
      if (!/^\d{13}$/.test(name)) continue;
      const ledger = obj(readJson(runLedgerFile(cwd, name), null));
      if (!ledger) continue;
      const status = effectiveLegacyRunStatus(ledger);
      if (status && status !== 'planned' && status !== 'active') continue;
      if (backfillRunLedgerFingerprint(cwd, name)) changed = true;
      if (activeRunClaimCount(cwd, name) > 0) {
        live.push({ runId: name, score: runEvidenceScore(cwd, name), val: Number(name) });
      }
    }
  } catch {
    return changed;
  }
  if (live.length < 2) return changed;
  // Most orchestration evidence wins; newest breaks a tie.
  live.sort((a, b) => (b.score - a.score) || (b.val - a.val));
  const survivor = live[0]!;
  const current = typeof s.currentRunId === 'string' ? s.currentRunId.trim() : '';
  if (current !== survivor.runId) {
    try {
      // The re-point is the PRECONDITION for the loop below, not its neighbour:
      // releasing and failing the losers is only correct because `currentRunId`
      // now names the survivor. A refused write left the losers settled while
      // `.one.json` still pointed at one of them — so the next hook read a run
      // whose claims this pass had just released and whose ledger it had just
      // transitioned to `failed`, which is strictly worse than not repairing at
      // all. Same exit the catch beside it already takes.
      if (!writeState(cwd, { ...readJson<Rec>(path.join(cwd, STATE_FILE), {}), currentRunId: survivor.runId })) {
        return changed;
      }
      (state as Rec).currentRunId = survivor.runId;
      changed = true;
    } catch {
      return changed;
    }
  }
  for (const loser of live.slice(1)) {
    // Release BEFORE settling: a terminal transition fails closed while claims
    // are still active.
    releaseRunClaims(cwd, loser.runId, 'superseded-by-run-identity-repair');
    transitionRunStatus(cwd, loser.runId, {
      status: 'failed',
      outcome: 'agent-failed',
      reason: `superseded by run-identity repair (survivor ${survivor.runId})`,
    });
    changed = true;
  }
  return changed;
}

export function legacyRunAgentContext(state: unknown): RunAgentContext | null {
  if (!isSubagentSession(state)) return null;
  const role = activeAgentRole(state);
  if (!role) return null;
  const s = obj(state) || {};
  return {
    source: 'legacy-state',
    runId: s.currentRunId,
    role,
    spawnIndex: getSpawnIndex(state, role) || 1,
    sessionId: null,
    claimId: null,
  };
}

