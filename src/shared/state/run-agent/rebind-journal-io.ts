// src/shared/state/run-agent/rebind-journal-io.ts
// Bounded journal entry shaping and read/complete primitives.

import type { AuthoritativeRebindJournal, AuthoritativeRebindReplay } from './rebind-journal';
import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import {  readJson,  writeJson } from '../../fsjson';
import {
  VALID_AGENT_ROLES,
} from '../../../config/state';
import { stateTimestamp } from '../io';
import {
  stackFingerprint,
} from '../materialization';
import {
  authoritativeRebindJournalFile,
  firstString,
  pendingDir,
  runAgentFile,
  runDir,
  safePathSegment,
  uniqueStrings,
} from './run-paths';
import {
  readClaimFile,
} from './claims-pending';
import {
  agentRegistryFile,
  idsForRunAgent,
} from './registry';
import {
  activeClaimForOtherThread,
} from './claim-thread-role';
import { releaseFallbackClaimsForHolderUnlocked } from './fallback-claims';
import { AUTHORITATIVE_REBIND_JOURNAL_MAX_BYTES, AUTHORITATIVE_REBIND_PENDING_LIMIT } from './rebind-journal';

export function boundedRebindRegistryEntry(entry: Rec, threadId: string): Rec {
  return {
    agentId: threadId,
    resumeId: firstString(entry.resumeId),
    toolCallId: firstString(entry.toolCallId),
    model: firstString(entry.model),
    agentType: firstString(entry.agentType),
    parentSessionId: firstString(entry.parentSessionId),
    recordedAt: firstString(entry.recordedAt) || stateTimestamp(),
    tasks: typeof entry.tasks === 'number' && Number.isInteger(entry.tasks) && entry.tasks > 0
      ? Math.min(entry.tasks, 1_000_000)
      : 1,
    replaced: false,
    roleSource: firstString(entry.roleSource),
    transcriptPath: firstString(entry.transcriptPath),
  };
}
export function boundedRebindTargetClaim(claim: Rec, runId: string, threadId: string, targetRole: string): Rec {
  return {
    version: typeof claim.version === 'number' ? claim.version : 1,
    runId,
    claimId: firstString(claim.claimId),
    role: targetRole,
    spawnIndex: typeof claim.spawnIndex === 'number' && Number.isInteger(claim.spawnIndex) && claim.spawnIndex > 0
      ? claim.spawnIndex
      : 1,
    status: 'claimed',
    sessionId: threadId,
    parentSessionId: firstString(claim.parentSessionId),
    createdAt: firstString(claim.createdAt) || stateTimestamp(),
    claimedAt: firstString(claim.claimedAt) || stateTimestamp(),
    stackFingerprint: firstString(claim.stackFingerprint),
    toolName: firstString(claim.toolName),
    agentType: firstString(claim.agentType),
    model: firstString(claim.model),
    roleSource: firstString(claim.roleSource),
    transcriptPath: firstString(claim.transcriptPath),
    correctedAt: firstString(claim.correctedAt),
    correctedFromRole: firstString(claim.correctedFromRole),
  };
}
export function readAuthoritativeRebindJournal(
  cwd: string,
  runId: string,
  threadId: string,
): AuthoritativeRebindJournal | null {
  const file = authoritativeRebindJournalFile(cwd, runId, threadId);
  try {
    if (fs.statSync(file).size > AUTHORITATIVE_REBIND_JOURNAL_MAX_BYTES) return null;
  } catch {
    return null;
  }
  const raw = obj(readJson(file, null));
  const registryEntry = obj(raw?.registryEntry);
  const targetClaim = obj(raw?.targetClaim);
  const oldRole = firstString(raw?.oldRole);
  const targetRole = firstString(raw?.targetRole);
  const sourceClaimId = firstString(raw?.sourceClaimId);
  const targetClaimId = firstString(raw?.targetClaimId);
  const storedThreadId = firstString(raw?.threadId);
  const storedRunId = firstString(raw?.runId);
  const pendingRaw = Array.isArray(raw?.pendingClaimIds) ? raw.pendingClaimIds : [];
  if (!raw
    || raw.version !== 1
    || raw.kind !== 'authoritative-role-rebind'
    || storedRunId !== runId
    || storedThreadId !== threadId
    || !oldRole || !VALID_AGENT_ROLES.has(oldRole)
    || !targetRole || !VALID_AGENT_ROLES.has(targetRole) || targetRole === oldRole
    || !sourceClaimId || !targetClaimId
    || !targetClaim
    || firstString(targetClaim.runId) !== runId
    || firstString(targetClaim.sessionId) !== threadId
    || firstString(targetClaim.role) !== targetRole
    || firstString(targetClaim.claimId) !== targetClaimId
    || !registryEntry || firstString(registryEntry.agentId) !== threadId
    || pendingRaw.length > AUTHORITATIVE_REBIND_PENDING_LIMIT
    || pendingRaw.some((value) => typeof value !== 'string' || !value.trim())) return null;
  return {
    version: 1,
    kind: 'authoritative-role-rebind',
    runId,
    threadId,
    oldRole,
    targetRole,
    sourceClaimId,
    sourceClaimWasPresent: raw.sourceClaimWasPresent === true,
    targetClaimId,
    targetClaim: boundedRebindTargetClaim(targetClaim, runId, threadId, targetRole),
    registryEntry: boundedRebindRegistryEntry(registryEntry, threadId),
    pendingClaimIds: uniqueStrings(pendingRaw.map((value) => String(value).trim()))
      .slice(0, AUTHORITATIVE_REBIND_PENDING_LIMIT),
    createdAt: firstString(raw.createdAt) || stateTimestamp(),
  };
}
function removePendingClaimsByIdUnlocked(
  cwd: string,
  runId: string,
  claimIds: readonly string[],
): boolean {
  for (const claimId of new Set(claimIds.filter(Boolean))) {
    const file = path.join(pendingDir(cwd, runId), `${safePathSegment(claimId)}.json`);
    if (!fs.existsSync(file)) continue;
    const claim = readClaimFile(file);
    // The filename and payload form the pending-claim CAS. If either cannot be
    // verified, retain the journal instead of declaring cleanup complete.
    if (!claim || firstString(claim.claimId) !== claimId) return false;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      return false;
    }
  }
  return true;
}
export function completeAuthoritativeRebindJournalUnlocked(
  cwd: string,
  state: unknown,
  journal: AuthoritativeRebindJournal,
): AuthoritativeRebindReplay {
  const claimFile = runAgentFile(cwd, journal.runId, journal.threadId);
  const currentClaim = readClaimFile(claimFile);
  const currentClaimSessionId = firstString(currentClaim?.sessionId);
  const currentClaimThreadMatches = !currentClaimSessionId || currentClaimSessionId === journal.threadId;
  const targetClaimMatches = Boolean(
    currentClaim
    && firstString(currentClaim.runId) === journal.runId
    && currentClaimThreadMatches
    && firstString(currentClaim.role) === journal.targetRole
    && firstString(currentClaim.claimId) === journal.targetClaimId,
  );
  const sourceClaimMatches = Boolean(
    currentClaim
    && firstString(currentClaim.runId) === journal.runId
    && currentClaimThreadMatches
    && firstString(currentClaim.role) === journal.oldRole
    && firstString(currentClaim.claimId) === journal.sourceClaimId,
  );
  if (!targetClaimMatches && !sourceClaimMatches
    && (currentClaim || journal.sourceClaimWasPresent)) return { status: 'blocked' };

  const registryFile = agentRegistryFile(cwd, journal.runId);
  const registry = obj(readJson(registryFile, null)) || {};
  const agents = obj(registry.agents) || {};
  const targetEntry = obj(agents[journal.targetRole]);
  const targetMatches = Boolean(targetEntry && idsForRunAgent(targetEntry).includes(journal.threadId));
  if ((targetEntry && !targetMatches)
    || activeClaimForOtherThread(cwd, state, journal.runId, journal.targetRole, journal.threadId)) {
    return { status: 'blocked' };
  }

  const oldEntry = obj(agents[journal.oldRole]);
  const oldMatches = Boolean(oldEntry && idsForRunAgent(oldEntry).includes(journal.threadId));
  // A registry-only repair may legitimately start without a claim, but it must
  // still retain one exact registry identity as its source CAS until the target
  // claim is durable. Never invent both sides from an orphaned journal.
  if (!targetClaimMatches && !sourceClaimMatches && !oldMatches && !targetMatches) {
    return { status: 'blocked' };
  }

  if (!targetClaimMatches) {
    try {
      fs.mkdirSync(runDir(cwd, journal.runId), { recursive: true });
      writeJson(claimFile, journal.targetClaim);
    } catch {
      return { status: 'blocked' };
    }
  }

  let registryDirty = false;
  if (oldMatches) {
    delete agents[journal.oldRole];
    registryDirty = true;
  }
  if (!targetMatches) {
    agents[journal.targetRole] = journal.registryEntry;
    registryDirty = true;
  }
  if (registryDirty) {
    const history = Array.isArray(registry.history)
      ? registry.history.filter((item) => item && typeof item === 'object')
      : [];
    const alreadyRecorded = history.some((item) => {
      const record = obj(item);
      return record?.replacementReason === 'authoritative-role-rebind'
        && record.agentId === journal.threadId
        && record.oldRole === journal.oldRole
        && record.role === journal.targetRole;
    });
    if (!alreadyRecorded) {
      history.push({
        role: journal.targetRole,
        oldRole: journal.oldRole,
        agentId: journal.threadId,
        correctedAt: journal.createdAt,
        replacementReason: 'authoritative-role-rebind',
      });
    }
    try {
      writeJson(registryFile, {
        ...registry,
        version: 1,
        agents,
        history: history.slice(-100),
      });
    } catch {
      return { status: 'blocked' };
    }
  }

  const released = releaseFallbackClaimsForHolderUnlocked(cwd, journal.runId, journal.threadId);
  if (!released.ok) return { status: 'blocked' };
  if (!removePendingClaimsByIdUnlocked(cwd, journal.runId, journal.pendingClaimIds)) {
    return { status: 'blocked' };
  }
  try {
    fs.rmSync(authoritativeRebindJournalFile(cwd, journal.runId, journal.threadId), { force: true });
  } catch {
    return { status: 'blocked' };
  }
  const correctedClaim = readClaimFile(claimFile);
  return correctedClaim
    ? { status: 'complete', claim: correctedClaim }
    : { status: 'blocked' };
}
