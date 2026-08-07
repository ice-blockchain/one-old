// src/shared/state/run-agent/rebind-journal-io.ts
// Bounded journal entry shaping and read/complete primitives.

import type { AuthoritativeRebindJournal, AuthoritativeRebindReplay } from './rebind-journal';
import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import {  readJson, readJsonResult,  writeJson } from '../../fsjson';
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
  const wanted = new Set(claimIds.filter(Boolean));
  if (wanted.size === 0) return true;
  // Matched on the claim id INSIDE each file, by scanning the directory.
  //
  // This used to address `pending/<claimId>.json` directly and called the
  // filename half of "the pending-claim CAS" — but a name every writer derives
  // from its own fresh random id is contended by nobody, so it was not a CAS at
  // all. claims-store.ts's pendingClaimFile keys the slot by ROLE, which is
  // contended by construction and gives the exclusive create something real to
  // fail on. A content scan is the lookup that follows from that, and it is
  // filename-agnostic: it still finds the `<claimId>.json` files an older build
  // left behind.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pendingDir(cwd, runId), { withFileTypes: true });
  } catch {
    // No pending directory at all means nothing of this journal's is left there.
    return true;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(pendingDir(cwd, runId), entry.name);
    const claim = readClaimFile(file);
    const id = firstString(claim?.claimId);
    // A pending file whose claim id cannot be read might BE one of these, and the
    // direct lookup was fail-closed about exactly that ("if either cannot be
    // verified, retain the journal"). Keep the journal rather than declare a
    // cleanup that may have missed a claim.
    if (!id) return false;
    if (!wanted.has(id)) continue;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      return false;
    }
  }
  // A wanted id with no file left is already cleaned up — the same tolerance the
  // direct lookup had in its `existsSync` continue.
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
  // SETTLED (it was filed as conditional because the write below depends on a
  // claim match sourced in another module): reachable, and destructive when it
  // is reached. `|| {}` on an unreadable registry left `agents` empty, so
  // `targetMatches` and `oldMatches` are both false — and the guard on those two
  // is satisfied by a CLAIM match alone, which a rebind whose claim write already
  // landed (or replay of its journal) supplies. The transaction then reads its
  // own CAS as "the target role is FREE" from a file that may say the opposite,
  // and republishes the whole registry from `{}`, deleting every other role's
  // row for real this time.
  //
  // Refuse both kinds. A compare-and-swap is defined against a base, exactly as
  // a patch is (normalize.ts's patchState), and refusing writes nothing.
  // `blocked` is what a malformed journal already produces here and all three
  // consumers refuse conservatively on it, so this costs a retry and never a
  // wrong role. It is not a wedge either: `recordRunAgentUnlocked` quarantines
  // and heals a corrupt registry on the next PostToolUse observation, after
  // which this retries against a base it can see.
  const read = readJsonResult<Rec>(registryFile);
  if (read.kind === 'corrupt' || read.kind === 'unreadable') return { status: 'blocked' };
  const registry = (read.kind === 'ok' ? obj(read.value) : null) || {};
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

  // Both writes below reuse the `catch`'s own channel for the OTHER way they
  // fail: shared/fsjson.ts answers `false` for a refusal (an unanswered consent
  // question, a planted symlink, a path escaping the state dir) instead of
  // throwing, and that answer was dropped.
  //
  // Not merely untidy, and not merely a divergence between the two paths. The
  // claim file is keyed by THREAD, so the rebind rewrites the one file from
  // oldRole to targetRole — and when the write was refused, the source claim was
  // still sitting there, so the read-back at the end of this function found a
  // claim, and this returned `{ status: 'complete', claim }` carrying the
  // UN-REBOUND role. `authoritativeRebindThreadRole` then built a context from it
  // labelled `authoritative-role-rebind`, and context-resolve.ts consumed
  // `replay.claim` directly. The journal has already been deleted by then, so
  // replay cannot recover it. `blocked` is the answer a malformed journal
  // produces, and all three consumers refuse conservatively on it
  // (codex-liveness.ts → `conflict`, rendered as the retryable
  // `agent-reuse-await-codex-meta` deny; claim-thread-role.ts and
  // context-resolve.ts → null), so it costs a retry and never a wrong role.
  if (!targetClaimMatches) {
    try {
      fs.mkdirSync(runDir(cwd, journal.runId), { recursive: true });
      if (!writeJson(claimFile, journal.targetClaim)) return { status: 'blocked' };
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
      if (!writeJson(registryFile, {
        ...registry,
        version: 1,
        agents,
        history: history.slice(-100),
      })) return { status: 'blocked' };
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
