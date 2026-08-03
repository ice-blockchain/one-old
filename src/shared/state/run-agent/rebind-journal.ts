// src/shared/state/run-agent/rebind-journal.ts
// The bounded authoritative rebind journal: read/complete/replay and
// authoritativeRebindThreadRole.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import {  readJson,  writeJson } from '../../fsjson';
import {
  SUBAGENT_STALE_MS,
  VALID_AGENT_ROLES,
} from '../../../config/state';
import { stateTimestamp } from '../io';
import {
  stackFingerprint,
} from '../materialization';

import {
  authoritativeRebindJournalFile,
  firstString,
  runAgentFile,
  stackFingerprintPatch,
  uniqueStrings,
} from './run-paths';
import {
  isCorrectionGradeEvidence,
  type RoleEvidence,
} from './role-evidence';
import {
  isFreshTimestamp,
} from './session-identity';
import {
  readClaimFile,
} from './claims-pending';
import {
  nextSpawnIndex,
  withRunAgentClaimsLock,
} from './claims-store';
import {
  agentRegistryFile,
  idsForRunAgent,
  withAgentRegistryLock,
} from './registry';
import {
  contextFromClaim,
  type RunAgentContext,
} from './context-resolve';
import {
  activeClaimForOtherThread,
  strictPendingForRoleRebind,
} from './claim-thread-role';
import {  withFallbackClaimsLock } from './fallback-claims';
import { boundedRebindRegistryEntry, boundedRebindTargetClaim, completeAuthoritativeRebindJournalUnlocked, readAuthoritativeRebindJournal } from './rebind-journal-io';

export const AUTHORITATIVE_REBIND_JOURNAL_MAX_BYTES = 32 * 1024;
export const AUTHORITATIVE_REBIND_PENDING_LIMIT = 8;

export interface AuthoritativeRebindJournal {
  version: 1;
  kind: 'authoritative-role-rebind';
  runId: string;
  threadId: string;
  oldRole: string;
  targetRole: string;
  sourceClaimId: string;
  sourceClaimWasPresent: boolean;
  targetClaimId: string;
  targetClaim: Rec;
  registryEntry: Rec;
  pendingClaimIds: string[];
  createdAt: string;
}

export type AuthoritativeRebindReplay =
  | { status: 'none' }
  | { status: 'complete'; claim: Rec }
  | { status: 'blocked' };






export function replayAuthoritativeRebindJournal(
  cwd: string,
  state: unknown,
  runId: string,
  threadId: string,
): AuthoritativeRebindReplay {
  const journalFile = authoritativeRebindJournalFile(cwd, runId, threadId);
  if (!fs.existsSync(journalFile)) return { status: 'none' };
  let result: AuthoritativeRebindReplay = { status: 'blocked' };
  const identityLocked = withRunAgentClaimsLock(cwd, runId, () => {
    const registryLocked = withAgentRegistryLock(cwd, runId, () => {
      const fallbackLocked = withFallbackClaimsLock(cwd, runId, () => {
        if (!fs.existsSync(journalFile)) {
          result = { status: 'none' };
          return;
        }
        const journal = readAuthoritativeRebindJournal(cwd, runId, threadId);
        result = journal
          ? completeAuthoritativeRebindJournalUnlocked(cwd, state, journal)
          : { status: 'blocked' };
      });
      if (!fallbackLocked) result = { status: 'blocked' };
    });
    if (!registryLocked) result = { status: 'blocked' };
  });
  return identityLocked ? result : { status: 'blocked' };
}

export function authoritativeRebindThreadRole(
  cwd: string,
  state: unknown,
  runId: string,
  threadId: string,
  expectedClaim: Rec,
  evidence: RoleEvidence,
  options: {
    parentSessionId?: string | null;
    model?: string | null;
    transcriptPath?: string | null;
    expectedRegistryRole?: string | null;
    expectedRegistryIds?: string[];
  } = {},
): RunAgentContext | null {
  if (!VALID_AGENT_ROLES.has(evidence.role)) return null;
  const targetRole = evidence.role;
  const claimRole = firstString(expectedClaim.role);
  const expectedRegistryRole = firstString(options.expectedRegistryRole);
  // A crash can occur after the claim was corrected but before the registry row
  // was re-keyed. Finishing that exact, stamped transaction is convergence, not
  // a second same-tier correction: the claim already carries this role/source
  // and records the registry role it was corrected from.
  const convergesInterruptedCorrection = Boolean(
    evidence.authority === 'authoritative'
    && claimRole === targetRole
    && expectedRegistryRole
    && firstString(expectedClaim.correctedFromRole) === expectedRegistryRole
    && firstString(expectedClaim.roleSource) === evidence.source,
  );
  if (!convergesInterruptedCorrection
    && !isCorrectionGradeEvidence(evidence, expectedClaim.roleSource)) return null;
  const oldRole = claimRole && claimRole !== targetRole
    ? claimRole
    : (expectedRegistryRole && expectedRegistryRole !== targetRole ? expectedRegistryRole : null);
  if (!oldRole) return null;
  const id = threadId.trim();
  const parentSessionId = firstString(options.parentSessionId, expectedClaim.parentSessionId);
  const model = firstString(options.model, expectedClaim.model);
  const transcriptPath = firstString(options.transcriptPath, expectedClaim.transcriptPath);
  let corrected: Rec | null = null;

  // Canonical mutation order: identity claim -> role registry -> fallback path
  // claims. Every other claim mutation uses the first lock only, so no caller can
  // overwrite a corrected claim from a stale pre-rebind snapshot.
  const identityLocked = withRunAgentClaimsLock(cwd, runId, () => {
    const registryLocked = withAgentRegistryLock(cwd, runId, () => {
      const claimsLocked = withFallbackClaimsLock(cwd, runId, () => {
      const claimFile = runAgentFile(cwd, runId, id);
      const current = readClaimFile(claimFile);
      const base = current || expectedClaim;
      if (current && expectedClaim.claimId && current.claimId !== expectedClaim.claimId) return;
      if (current && current.role !== oldRole && current.role !== targetRole) return;

      const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
      const agents = obj(registry.agents) || {};
      const history = Array.isArray(registry.history)
        ? registry.history.filter((item) => item && typeof item === 'object')
        : [];
      const conflicts = Array.isArray(registry.conflicts)
        ? registry.conflicts.filter((item) => item && typeof item === 'object')
        : [];
      if (options.expectedRegistryRole) {
        const inspected = obj(agents[options.expectedRegistryRole]);
        const expectedIds = new Set(options.expectedRegistryIds || [id]);
        if (!inspected || !idsForRunAgent(inspected).some((candidate) => expectedIds.has(candidate))) return;
      }
      const oldEntry = obj(agents[oldRole]);
      const oldEntryMatches = Boolean(oldEntry && idsForRunAgent(oldEntry).includes(id));
      // Registry-only legacy repair must CAS the exact inspected row. A child-hook
      // correction may legitimately have a claim but no registry row yet; however,
      // a newer row under the old role is never overwritten or re-keyed.
      if (!current && !oldEntryMatches) return;
      const targetEntry = obj(agents[targetRole]);
      const targetIds = idsForRunAgent(targetEntry);
      const targetParentMatches = !targetEntry
        || !parentSessionId
        || !firstString(targetEntry.parentSessionId)
        || firstString(targetEntry.parentSessionId) === parentSessionId;
      const targetIsLive = Boolean(
        targetEntry
        && targetEntry.replaced !== true
        && targetParentMatches
        && isFreshTimestamp(targetEntry.recordedAt, SUBAGENT_STALE_MS),
      );
      const occupiedTarget = targetIsLive && !targetIds.includes(id);
      const otherClaim = activeClaimForOtherThread(cwd, state, runId, targetRole, id);
      const pending = strictPendingForRoleRebind(cwd, state, runId, targetRole, parentSessionId, model);
      if (occupiedTarget || otherClaim || pending.ambiguous) {
        conflicts.push({
          role: targetRole,
          conflictingRole: oldRole,
          rejectedAgentId: id,
          conflictingAgentId: occupiedTarget ? firstString(targetEntry?.agentId) : firstString(otherClaim?.sessionId),
          recordedAt: stateTimestamp(),
          reason: pending.ambiguous
            ? 'authoritative-role-rebind-ambiguous-pending'
            : 'authoritative-role-rebind-target-occupied',
        });
        try {
          writeJson(agentRegistryFile(cwd, runId), {
            ...registry,
            version: 1,
            agents,
            history: history.slice(-100),
            conflicts: conflicts.slice(-50),
          });
        } catch {
          // best-effort conflict diagnostic
        }
        return;
      }

      const claimAlreadyCorrected = current?.role === targetRole;
      const matchingPending = claimAlreadyCorrected ? null : pending.match;
      const spawnIndex = claimAlreadyCorrected && typeof current.spawnIndex === 'number'
        ? current.spawnIndex
        : (matchingPending && typeof matchingPending.claim.spawnIndex === 'number'
          ? matchingPending.claim.spawnIndex
          : nextSpawnIndex(cwd, state, runId, targetRole));
      const claimId = claimAlreadyCorrected && typeof current.claimId === 'string'
        ? current.claimId
        : (matchingPending && typeof matchingPending.claim.claimId === 'string'
          ? matchingPending.claim.claimId
          : `${targetRole}-${spawnIndex}-${id.slice(-8)}`);
      const now = stateTimestamp();
      const nextClaim: Rec = {
        ...base,
        version: typeof base.version === 'number' ? base.version : 1,
        runId,
        claimId,
        role: targetRole,
        spawnIndex,
        status: 'claimed',
        sessionId: id,
        parentSessionId,
        createdAt: typeof base.createdAt === 'string' ? base.createdAt : now,
        claimedAt: typeof base.claimedAt === 'string' ? base.claimedAt : now,
        ...(typeof base.stackFingerprint === 'string'
          ? { stackFingerprint: base.stackFingerprint }
          : stackFingerprintPatch(cwd, runId, state)),
        model,
        roleSource: evidence.source,
        transcriptPath,
        correctedAt: firstString(base.correctedAt, now),
        correctedFromRole: firstString(base.correctedFromRole, oldRole),
      };

      const sourceEntry = oldEntryMatches ? oldEntry : null;
      const preserved = sourceEntry || (targetEntry && targetIds.includes(id) ? targetEntry : null) || {};
      const nextEntry: Rec = {
        ...preserved,
        agentId: id,
        resumeId: firstString(preserved.resumeId),
        toolCallId: firstString(preserved.toolCallId),
        model: firstString(preserved.model, model),
        agentType: firstString(preserved.agentType),
        parentSessionId: firstString(parentSessionId, preserved.parentSessionId),
        recordedAt: firstString(preserved.recordedAt, base.createdAt, now) || now,
        tasks: typeof preserved.tasks === 'number' && preserved.tasks > 0 ? preserved.tasks : 1,
        replaced: false,
        roleSource: evidence.source,
        transcriptPath,
      };
      const sourceClaimId = firstString(expectedClaim.claimId, base.claimId);
      if (!sourceClaimId) return;
      const journal: AuthoritativeRebindJournal = {
        version: 1,
        kind: 'authoritative-role-rebind',
        runId,
        threadId: id,
        oldRole,
        targetRole,
        sourceClaimId,
        sourceClaimWasPresent: Boolean(current),
        targetClaimId: claimId,
        targetClaim: boundedRebindTargetClaim(nextClaim, runId, id, targetRole),
        registryEntry: boundedRebindRegistryEntry(nextEntry, id),
        pendingClaimIds: uniqueStrings([
          firstString(matchingPending?.claim.claimId),
          firstString(base.claimId),
        ].filter((value): value is string => Boolean(value)))
          .slice(0, AUTHORITATIVE_REBIND_PENDING_LIMIT),
        createdAt: now,
      };
      // `writeJson` emits pretty JSON. Refuse the correction before its first
      // mutation when the durable transaction would exceed replay's hard cap;
      // never write a journal that the next process must reject as malformed.
      if (Buffer.byteLength(`${JSON.stringify(journal, null, 2)}\n`, 'utf8')
        > AUTHORITATIVE_REBIND_JOURNAL_MAX_BYTES) return;
      try {
        writeJson(authoritativeRebindJournalFile(cwd, runId, id), journal);
      } catch {
        return;
      }
      const completed = completeAuthoritativeRebindJournalUnlocked(cwd, state, journal);
      if (completed.status === 'complete') corrected = completed.claim;
      });
      if (!claimsLocked) corrected = null;
    });
    if (!registryLocked) corrected = null;
  });
  if (!identityLocked || !corrected) return null;
  return contextFromClaim(corrected, 'authoritative-role-rebind');
}

