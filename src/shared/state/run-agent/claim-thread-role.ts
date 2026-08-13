// src/shared/state/run-agent/claim-thread-role.ts
// claimThreadRole with its rebind preconditions and conflicted-role
// disown.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import { isNonProjectRoot } from '../../authoring-root';
import {  readJson,  writeJson } from '../../fsjson';
import {
  VALID_AGENT_ROLES,
} from '../../../config/state';
import { stateTimestamp } from '../io';
import {
  stackFingerprint,
} from '../materialization';
import { writeState } from '../normalize';

import {
  ensureCurrentRunId,
  firstString,
  runAgentFile,
  runDir,
  safePathSegment,
  stackFingerprintPatch,
} from './run-paths';
import {
  ensureRunLedger,
  runLedgerClaimAdmission,
} from './ledger';
import {
  isCorrectionGradeEvidence,
  strongestRoleSource,
  type RoleEvidence,
} from './role-evidence';
import {
  claimAllowsState,
  claimModel,
  claimRejectReason,
  listPendingClaims,
  matchingPendingClaim,
  readClaimFile,
  removePendingClaim,
  removeSiblingPendingClaims,
  runIdsForLookup,
  type PendingClaim,
} from './claims-pending';
import {
  ensureRunAgentClaim,
  listClaimedAgents,
  nextSpawnIndex,
  releaseSupersededRoleClaimsLocked,
  withRunAgentClaimsLock,
} from './claims-store';
import {
  agentRegistryFile,
  idsForRunAgent,
  recordRunAgent,
  subagentContinuationAvailable,
  withAgentRegistryLockResult,
} from './registry';
import {
  applied,
  mutationApplied,
  preconditionFailed,
  unavailable,
  type MutationResult,
} from './mutation-result';
import {
  contextFromClaim,
  type RunAgentContext,
} from './context-resolve';
import {
  authoritativeRebindThreadRole,
  replayAuthoritativeRebindJournal,
} from './rebind-journal';
import {
  runLedgerStatusRecord,
} from './terminal-verdict';

// A thread's claim file is REBUILT in place when the same thread re-claims
// (interrupt/resume, a fix cycle, a role rebind), so the record it replaces is
// destroyed. `previousClaimId` on the new claim is a pointer to a file that no
// longer exists, which made cycle-1 claim history unrecoverable — model,
// roleSource, parent and timing of the superseded claim were simply gone
// (observed live). Snapshot the outgoing record into a sidecar of its own
// first. Sidecars live in a SUBDIRECTORY: `listClaimedAgentEntries` reads only
// files directly in the run dir, so archived claims never re-enter resolution
// or the spawn-index count. Best-effort — an archive failure must never block
// the bind.
function archiveSupersededClaim(cwd: string, runId: string, claim: Rec, supersededBy: string): void {
  const claimId = firstString(claim.claimId);
  if (!claimId) return; // role-bearing sidecars (maintenance.json) are not claims
  try {
    const dir = path.join(runDir(cwd, runId), 'superseded');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safePathSegment(claimId)}.${Date.now()}.json`);
    writeJson(file, {
      ...claim,
      supersededAt: stateTimestamp(),
      supersededBy: supersededBy || null,
    });
  } catch {
    // best-effort history; the live claim below is still written
  }
}

export function claimThreadRole(
  cwd: string,
  state: unknown,
  threadId: string,
  role: string,
  options: {
    parentSessionId?: string | null;
    recordAgent?: boolean;
    model?: string | null;
    transcriptPath?: string | null;
    evidence?: RoleEvidence;
    /** Verified child binds must never replace another live thread for this role. */
    refuseOccupiedRole?: boolean;
    /**
     * DECIDE WITHOUT STAKING. Every read, every precondition and every refusal
     * below is unchanged, and the returned context is built from the same record
     * the bind would have written — but nothing is persisted: no claim file, no
     * archive of the record it would have replaced, no pending-claim removal, no
     * `releaseSupersededRoleClaimsLocked`, no reuse-registry row, and the run
     * ledger is READ (`runLedgerClaimAdmission`) instead of activated.
     *
     * WHO NEEDS IT: plan-guard attributes a Cursor worker's write by scope alone
     * (plan-runteam.ts attributeForeignWriteBySpawnScope) and that attribution is
     * the one path in the gate that MINTS authority. It runs before the gate has
     * decided, so a write the gate went on to refuse still made its author the
     * incumbent for the role — and an incumbent claim denies the next legitimate
     * respawn for as long as it stays live, bounded at SUBAGENT_STALE_MS. That
     * price was argued for a successful write; it must not be paid for a refused
     * one.
     *
     * THE BOUND, stated rather than implied: this suppresses the ROLE CLAIM and
     * every displacement it causes. It does NOT make the call write-free — an
     * absent `currentRunId` is still minted by `ensureCurrentRunId` (a run-id
     * stamp is not authority over a role, and the surrounding gate has already
     * read the run through it), and an authorized rebind already recorded in the
     * journal is still replayed. Neither can make a thread the incumbent for a
     * role it did not already hold.
     */
    mint?: boolean;
  } = {},
): RunAgentContext | null {
  if (!VALID_AGENT_ROLES.has(role)) return null;
  if (typeof threadId !== 'string' || !threadId.trim()) return null;
  if (isNonProjectRoot(cwd)) return null; // never claim runs in the plugin's own repo
  const id = threadId.trim();
  const mint = options.mint !== false;
  const source: Rec = obj(state) ? { ...(state as Rec) } : {};
  // Same serialized-mint fallback as ensureRunAgentClaim (13c-codex sibling mints).
  const runId = typeof source.currentRunId === 'string' && source.currentRunId
    ? source.currentRunId
    : ensureCurrentRunId(cwd, state);
  if (!source.currentRunId) source.currentRunId = runId;
  const parentSessionId = firstString(options.parentSessionId);
  const model = firstString(options.model);
  const transcriptPath = firstString(options.transcriptPath);
  const evidence = options.evidence && options.evidence.role === role ? options.evidence : null;
  let claim: Rec | null = null;
  let rebindExpected: Rec | null = null;
  let created = false;
  const replay = replayAuthoritativeRebindJournal(cwd, state, runId, id);
  if (replay.status === 'blocked') return null;
  const locked = withRunAgentClaimsLock(cwd, runId, () => {
    const existing = readClaimFile(runAgentFile(cwd, runId, id));
    // A SUPERSEDED thread must not re-enter through the fresh-bind path below.
    // Its claim is released and another agent demonstrably owns the role, so
    // claimAllowsState now says no — and the released-claim refusal inside the
    // branch below is only reached for claims it says yes to. Falling through
    // would mint this thread a new claim and then have
    // releaseSupersededRoleClaimsLocked release the replacement that owns the
    // role, handing it straight back to the agent the parent just retired.
    if (existing && claimRejectReason(cwd, state, existing) === 'claim-superseded') return;
    if (existing && claimAllowsState(cwd, state, existing)) {
      if (existing.role !== role) {
        if (isCorrectionGradeEvidence(evidence, existing.roleSource)) rebindExpected = existing;
        return;
      }
      // A released-but-fresh claim for THIS thread means the agent resumed after
      // an interrupt sweep: reactivate it in place (metadata intact) instead of
      // handing back a claim whose status contradicts the live agent. Only while
      // the run ledger is still active — never fight terminal settlement.
      const reclaiming = existing.status === 'released'
        && runLedgerStatusRecord(cwd, runId).status === 'active'
        // An explicitly retired claim must not come back while the parent is
        // replacing it, and an older thread must never displace a replacement
        // that already owns the live role slot.
        && !roleRegistryDisownsClaim(cwd, runId, role, existing)
        && !activeClaimForOtherThread(cwd, source, runId, role, id);
      // Released claims remain useful for read-only identity resolution, but a
      // SubagentStart bind may return one only after it was safely reactivated.
      // Otherwise the retired thread would keep receiving write authority even
      // though another thread owns this role.
      if (existing.status === 'released' && !reclaiming) return;
      const nextSource = strongestRoleSource(evidence?.source, existing.roleSource);
      const reactivatedAt = reclaiming ? stateTimestamp() : '';
      const next: Rec = {
        ...existing,
        ...(nextSource ? { roleSource: nextSource } : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(reclaiming ? {
          status: 'claimed',
          createdAt: reactivatedAt,
          claimedAt: reactivatedAt,
        } : {}),
      };
      if (reclaiming) {
        delete next.releasedAt;
        delete next.releasedReason;
      }
      if (mint && (reclaiming || nextSource !== existing.roleSource || (transcriptPath && transcriptPath !== existing.transcriptPath))) {
        try { writeJson(runAgentFile(cwd, runId, id), next); } catch { return; }
      }
      if (mint) {
        removeSiblingPendingClaims(
          cwd, source, runId, role,
          parentSessionId || firstString(existing.parentSessionId),
          firstString(existing.claimId),
        );
      }
      claim = next;
      return;
    }

    if (options.refuseOccupiedRole
      && activeClaimForOtherThread(cwd, source, runId, role, id)) return;

    // READ, not activate, when nothing is being staked. `runLedgerClaimAdmission`
    // asks the same state machine the write below would have asked
    // (`runLedgerTransitionAllowed(status, 'active')`), and its `unknown` arm —
    // a torn or unreadable ledger — refuses here exactly as the failed
    // transition would have.
    if (mint) {
      const ledger = ensureRunLedger(cwd, runId, {
        status: 'active',
        kind: 'agent-claim',
        ...stackFingerprintPatch(cwd, runId, source),
      });
      if (ledger?.status !== 'active') return;
    } else if (runLedgerClaimAdmission(cwd, runId) !== 'admits') return;

    const pending = matchingPendingClaim(cwd, source, runId, role, parentSessionId, model);
    // Re-claim of THIS same thread after its earlier claim was released or aged
    // stale (interrupt/resume): the resume hook payload often carries no model,
    // so without the prior record the rebuilt claim forgets what the agent runs
    // on (observed live: model "opus" → null across a sleep interrupt).
    const prior = existing && existing.role === role ? existing : null;
    const spawnIndex = pending && typeof pending.claim.spawnIndex === 'number'
      ? pending.claim.spawnIndex
      : nextSpawnIndex(cwd, source, runId, role);
    const now = stateTimestamp();
    const nextClaimId = pending && typeof pending.claim.claimId === 'string'
      ? pending.claim.claimId
      : `${role}-${spawnIndex}-${id.slice(-8)}`;
    claim = {
      ...(pending ? pending.claim : {}),
      version: pending && typeof pending.claim.version === 'number' ? pending.claim.version : 1,
      runId: pending && typeof pending.claim.runId === 'string' ? pending.claim.runId : runId,
      claimId: nextClaimId,
      role,
      spawnIndex,
      status: 'claimed',
      sessionId: id,
      parentSessionId: parentSessionId
        || (pending && typeof pending.claim.parentSessionId === 'string' ? pending.claim.parentSessionId : null)
        || (prior && typeof prior.parentSessionId === 'string' ? prior.parentSessionId : null),
      // createdAt stays fresh — claimAllowsState gates resolution on it; the
      // prior lineage is preserved in previousClaimId below instead.
      createdAt: pending && typeof pending.claim.createdAt === 'string' ? pending.claim.createdAt : now,
      claimedAt: now,
      ...(pending && typeof pending.claim.stackFingerprint === 'string'
        ? { stackFingerprint: pending.claim.stackFingerprint }
        : stackFingerprintPatch(cwd, runId, source)),
      model: model
        || (pending && typeof pending.claim.model === 'string' ? pending.claim.model : null)
        || (prior && typeof prior.model === 'string' ? prior.model : null),
      roleSource: strongestRoleSource(evidence?.source, pending?.claim.roleSource ?? prior?.roleSource) || 'explicit-bind',
      transcriptPath: transcriptPath
        || (pending && typeof pending.claim.transcriptPath === 'string' ? pending.claim.transcriptPath : null)
        || (prior && typeof prior.transcriptPath === 'string' ? prior.transcriptPath : null),
      // Lineage only when there IS lineage. On a same-thread re-claim with no
      // pending row, `claimId` above is rebuilt deterministically from
      // `${role}-${spawnIndex}-${id.slice(-8)}` and lands on the prior value, so
      // an unguarded copy made the field point at itself — carrying nothing in
      // exactly the case it exists for (observed 10co).
      ...(prior && typeof prior.claimId === 'string' && prior.claimId !== nextClaimId
        ? { previousClaimId: prior.claimId }
        : {}),
    };
    if (!mint) return; // decided, and `claim` carries the decision — see `mint`
    fs.mkdirSync(runDir(cwd, runId), { recursive: true });
    // The write below destroys whatever record this thread's claim file held —
    // preserve it before it is gone (see archiveSupersededClaim).
    if (existing) archiveSupersededClaim(cwd, runId, existing, nextClaimId);
    writeJson(runAgentFile(cwd, runId, id), claim);
    if (pending) removePendingClaim(pending.filePath);
    removeSiblingPendingClaims(cwd, source, runId, role, claim!.parentSessionId as string | null, claim!.claimId as string | null);
    releaseSupersededRoleClaimsLocked(cwd, runId, role, id, String(claim!.claimId || ''));
    created = true;
  });
  if (!locked) return null;
  const expectedForRebind = rebindExpected as Rec | null;
  // A rebind REWRITES another role's claim, so it is a mint by any reading and
  // is refused (null, the closed direction) rather than performed when nothing
  // is being staked. Unreachable from the one `mint: false` caller — it passes
  // no `evidence`, and `rebindExpected` is only set for correction-grade
  // evidence — so this is the guard on a door, not a branch with traffic.
  if (expectedForRebind && mint && isCorrectionGradeEvidence(evidence, expectedForRebind.roleSource)) {
    return authoritativeRebindThreadRole(cwd, state, runId, id, expectedForRebind, evidence, {
      parentSessionId,
      model,
      transcriptPath,
    });
  }
  const boundClaim = claim as Rec | null;
  if (!boundClaim) return null;
  // Mirror the bind into the role-keyed reuse registry (agents.json), so the spawn
  // dedup gate sees a LIVE agent for the role and routes the next same-role task to
  // the host's continuation primitive — one agent per role instead of a fresh rule-reloading
  // spawn. Only the host's spawn-result recorder ran before, which never fires for
  // hosts that bind here (Codex SubagentStart; Claude agent-teams, whose workers
  // carry agent_id/agent_type but no separately-recorded spawn result). Gated on
  // continuation (the registry is dead weight without it) and best-effort.
  if (created && options.recordAgent !== false && subagentContinuationAvailable()) {
    recordRunAgent(cwd, runId, role, {
      agentId: id,
      parentSessionId,
      model: boundClaim.model as string | null,
      roleSource: boundClaim.roleSource as string | null,
      transcriptPath: boundClaim.transcriptPath as string | null,
      // A bind is the CHILD acting: this thread claimed the role for itself, so
      // it was alive just now. That is the one thing allowed to advance the
      // registry row's liveness clock — without it a child that re-binds after
      // its claim aged out would get a fresh 30-minute claim window over a row
      // that stays presumed-dead, and the reuse gate would offer its role to a
      // replacement while it still held write authority.
      childObserved: true,
    });
  }
  // Deliberately NOT writeState() here. Parallel subagents self-heal their claims
  // near-simultaneously on their first writes, and writeState does a non-atomic
  // read-modify-rewrite of the shared .one.json — concurrent calls would clobber it.
  // The per-thread claim file written above is the source of truth, and
  // runIdsForLookup() scans the runs/ dir on disk, so resolution needs no
  // currentRunId/spawnIndex stamp (the orchestrator already stamps currentRunId
  // during onboarding; nextSpawnIndex counts claim files on disk).
  return contextFromClaim(boundClaim, 'subagent-start');
}

export function strictPendingForRoleRebind(
  cwd: string,
  state: unknown,
  runId: string,
  role: string,
  parentSessionId: string | null,
  model: string | null,
): { match: PendingClaim | null; ambiguous: boolean } {
  if (!parentSessionId || !model) return { match: null, ambiguous: false };
  const matches = listPendingClaims(cwd, runId)
    .filter(({ claim }) => claimAllowsState(cwd, state, claim))
    .filter(({ claim }) => claim.role === role)
    .filter(({ claim }) => claim.parentSessionId === parentSessionId)
    .filter(({ claim }) => claimModel(claim) === model);
  return matches.length === 1
    ? { match: matches[0]!, ambiguous: false }
    : { match: null, ambiguous: matches.length > 1 };
}

export function activeClaimForOtherThread(
  cwd: string,
  state: unknown,
  runId: string,
  role: string,
  threadId: string,
): Rec | null {
  return listClaimedAgents(cwd, runId).find((claim) => (
    claimAllowsState(cwd, state, claim)
    && claim.status !== 'released'
    && claim.role === role
    && firstString(claim.sessionId) !== threadId
    // The parent-side replacement gate marks an exhausted/dead role in the
    // reuse registry before it starts the replacement child. That durable,
    // id-correlated marker is the authority to retire the old claim; freshness
    // alone cannot distinguish a just-crashed child from a live sibling. Keep
    // refusing an unmarked duplicate, but do not let the old claim deadlock the
    // verified replacement's SubagentStart bind.
    && !roleRegistryDisownsClaim(cwd, runId, role, claim)
  )) || null;
}

// The role registry is the durable ownership lineage when an interrupt sweep
// releases every claim file. A matching `replaced` entry retires that claim;
// once the replacement is recorded, its live entry also disowns every older
// same-role claim. Conversely, a replaced entry for the OLD agent must not
// reject the not-yet-recorded replacement whose id differs.
function roleRegistryDisownsClaim(
  cwd: string,
  runId: string,
  role: string,
  claim: Rec,
): boolean {
  const registry = obj(readJson(agentRegistryFile(cwd, runId), null));
  const entry = obj(obj(registry?.agents)?.[role]);
  if (!entry) return false;
  const sessionId = firstString(claim.sessionId);
  if (!sessionId) return false;
  const registryOwnsClaim = idsForRunAgent(entry).includes(sessionId);
  return registryOwnsClaim ? entry.replaced === true : entry.replaced !== true;
}

// A child whose observed model terminally conflicts with the immutable run
// policy can never act again — every tool call is denied. On hosts whose spawn
// results bind via SubagentStart (Codex), nothing ever set the registry's
// `replaced` marker for such a child, so the role slot stayed occupied and the
// parent's FRESH policy-compliant replacement was refused as a duplicate
// (observed 8c-codex: reviewer stranded after a followup model drift, all
// respawn paths dead-ended). Durably disown the dead child here — the existing
// machinery (activeClaimForOtherThread → roleRegistryDisownsClaim) then lets
// exactly the next verified same-role child claim the slot, and the recorder
// preserves this lineage in registry history. Only the entry actually owned by
// one of the given thread ids is marked; a live replacement is never touched.
export function disownConflictedRoleAgentResult(
  cwd: string,
  runId: string,
  role: string,
  threadIds: readonly string[],
  reason: string,
): MutationResult<void> {
  if (!VALID_AGENT_ROLES.has(role) || !runId) return preconditionFailed('invalid-role-or-run');
  const ids = threadIds.map((id) => String(id || '').trim()).filter(Boolean);
  if (ids.length === 0) return preconditionFailed('no-thread-ids');
  // Fix #1 of the eleven. The lock result was discarded, so a contended registry
  // lock reported the same `false` as "that thread does not own this role" — and
  // this function's `false` is what keeps a stranded role slot occupied, the exact
  // dead-end (8c-codex) it was written to clear.
  const outcome = withAgentRegistryLockResult<void>(cwd, runId, () => {
    const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
    const agents = obj(registry.agents) || {};
    const entry = obj(agents[role]);
    if (!entry) return preconditionFailed('no-registry-row');
    const entryIds = idsForRunAgent(entry);
    if (!ids.some((id) => entryIds.includes(id))) return preconditionFailed('thread-does-not-own-role');
    // Already disowned: the slot IS clear, which is what the caller asked for.
    if (entry.replaced === true) return applied(undefined);
    agents[role] = {
      ...entry,
      replaced: true,
      replacedAt: stateTimestamp(),
      replacementReason: reason,
    };
    try {
      fs.mkdirSync(runDir(cwd, runId), { recursive: true });
      if (!writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents })) {
        return unavailable('registry-write-refused');
      }
      return applied(undefined);
    } catch {
      // best-effort: the deny still blocks the dead child; the parent can retry
      return unavailable('registry-write-failed');
    }
  });
  return outcome;
}

// The boolean face every product caller uses. It cannot express `unavailable`,
// which is exactly why the Result above is the exported one: the three-valued
// answer is asserted against a held lock in
// __tests__/mutation-result-lock-contract.test.ts, so a later refactor cannot
// collapse a contended lock back into this `false` unnoticed.
export function disownConflictedRoleAgent(
  cwd: string,
  runId: string,
  role: string,
  threadIds: readonly string[],
  reason: string,
): boolean {
  return mutationApplied(disownConflictedRoleAgentResult(cwd, runId, role, threadIds, reason));
}

