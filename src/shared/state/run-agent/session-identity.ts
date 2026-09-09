// src/shared/state/run-agent/session-identity.ts
// Hook-input session identity and subagent-thread detection.

import { obj, type Rec } from '../../obj';
import { parseJson } from '../../fsjson';
import { trustworthyAgeMs } from '../../clock-skew';

import {
  firstString,
  nestedValue,
  normalizeHostCallId,
  uniqueStrings,
} from './run-paths';
import {
  normalizeRoleIdentity,
  transcriptThreadId,
} from './role-evidence';

interface SessionIdentity {
  sessionId: string | null;
  parentSessionId: string | null;
  isSubagent: boolean;
  // The running thread id parsed from transcript_path — the reliable per-thread
  // key on Codex (where session_id is always the parent). Null when absent.
  threadId: string | null;
  // The raw transcript_path (the running thread's rollout) — read to infer the role
  // of a Codex subagent that has no claim yet.
  transcriptPath: string | null;
  // Claude agent-teams worker id (`agent_id`) — a STABLE per-worker key stamped on
  // every payload (unlike Codex, the transcript is the parent's). Null elsewhere.
  agentId: string | null;
  // The role the host declares via `agent_type` (agent-teams), canonicalized to a
  // Traffic One role; null when absent or not a role. Lets a team worker bind its
  // claim without transcript inference. See project_agent_teams_claim_deadlock.
  declaredRole: string | null;
  // Two role-bearing host identity fields named different valid roles. Generic
  // fields are filtered before this check; a real conflict must never fall
  // through to pending-claim correlation.
  declaredRoleConflict: boolean;
  // Best-effort model id from the hook payload. Cursor child writes can arrive
  // after multiple failed/retried Task spawns for the same role; matching by model
  // lets the binder consume the successful exact-slug pending claim instead of an
  // older family-alias claim that produced a visible "Couldn't start" card.
  model: string | null;
}

export function hookSessionIdentity(rawInput: unknown): SessionIdentity {
  const data = (rawInput && typeof rawInput === 'object'
    ? (rawInput as Rec)
    : parseJson<Rec>(typeof rawInput === 'string' ? rawInput : '', {}));
  const payload = obj(data.payload) || {};
  const topSource = obj(data.source);
  const payloadSource = obj(payload.source);
  const sourceCandidates = [topSource, payloadSource].filter((value): value is Rec => Boolean(value));
  const threadSpawnCandidates = [
    ...sourceCandidates.flatMap((source) => {
      const subagent = obj(source.subagent);
      return subagent ? [obj(subagent.thread_spawn), obj(subagent.threadSpawn)] : [];
    }),
    obj(nestedValue(data, ['subagent', 'thread_spawn'])),
    obj(nestedValue(data, ['subagent', 'threadSpawn'])),
    obj(nestedValue(payload, ['subagent', 'thread_spawn'])),
    obj(nestedValue(payload, ['subagent', 'threadSpawn'])),
  ].filter((value): value is Rec => Boolean(value));
  const threadSpawn = threadSpawnCandidates[0] || {};

  // Cursor usually sends session_id (== conversation_id), but some event shapes have
  // drifted across versions. Treat conversation_id as a fallback so child-session
  // writes can still bind their per-run role claim.
  const sessionId = firstString(
    data.session_id, data.sessionId, data.sessionID, data.id,
    payload.session_id, payload.sessionId, payload.id,
    data.conversation_id, data.conversationId, payload.conversation_id, payload.conversationId,
    nestedValue(data, ['session', 'id']), nestedValue(payload, ['session', 'id']),
    // Windsurf / Cascade: the host-supplied trajectory IS the session.
    // firstString skips the empty synthetic Devin-bridge value. Must not be
    // read as parentSessionId — that made isSubagent true on every genuine
    // Cascade payload and stood the onboarding/auth gates down (measured:
    // windsurf-entry genuine-trajectory pre_run_command returned exit 0).
    data.trajectory_id, data.trajectoryId,
    payload.trajectory_id, payload.trajectoryId,
  );
  const parentSessionId = firstString(
    data.parent_session_id, data.parentSessionId,
    payload.parent_session_id, payload.parentSessionId,
    threadSpawn.parent_thread_id, threadSpawn.parentThreadId,
    threadSpawn.parent_session_id, threadSpawn.parentSessionId,
  );
  const transcriptPath = firstString(data.transcript_path, data.transcriptPath, payload.transcript_path, payload.transcriptPath);
  const threadId = transcriptThreadId(transcriptPath);
  const threadSource = firstString(data.thread_source, data.threadSource, payload.thread_source, payload.threadSource);
  // Claude agent-teams stamps the worker's stable id + role directly on every
  // payload (agent_id / agent_type) and sends NO parent_session_id, no `subagent`
  // block, and the PARENT's session_id/transcript. Read them so a team worker is
  // recognized as a subagent and its claim binds by agent_id.
  // Cursor's subagent-start payload carries the spawned id as `subagent_id`
  // (= tool_<uuid>) and the role as `subagent_type` (Claude uses agent_id/agent_type;
  // Codex carries neither). Read Cursor's spellings too so a Cursor subagent is
  // recognized as a subagent and its reuse id + role are captured.
  const agentId = normalizeHostCallId(firstString(data.agent_id, data.agentId, payload.agent_id, payload.agentId, data.subagent_id, payload.subagent_id));
  const declaredRoles = uniqueStrings([
    data.agent_type, data.agentType, payload.agent_type, payload.agentType,
    data.subagent_type, data.subagentType, payload.subagent_type, payload.subagentType,
    data.agent_role, data.agentRole, payload.agent_role, payload.agentRole,
    data.agent_path, data.agentPath, payload.agent_path, payload.agentPath,
    threadSpawn.agent_type, threadSpawn.agentType,
    threadSpawn.subagent_type, threadSpawn.subagentType,
    threadSpawn.agent_role, threadSpawn.agentRole,
    ...threadSpawnCandidates.flatMap((spawn) => [
      spawn.agent_type, spawn.agentType,
      spawn.subagent_type, spawn.subagentType,
      spawn.agent_role, spawn.agentRole,
      spawn.agent_path, spawn.agentPath,
    ]),
  ].map(normalizeRoleIdentity).filter((role): role is string => Boolean(role)));
  const declaredRole = declaredRoles.length === 1 ? declaredRoles[0]! : null;
  const declaredRoleConflict = declaredRoles.length > 1;
  const model = firstString(
    data.model, payload.model,
    data.subagent_model, data.subagentModel,
    payload.subagent_model, payload.subagentModel,
    nestedValue(data, ['tool_input', 'model']), nestedValue(data, ['toolInput', 'model']),
    nestedValue(payload, ['tool_input', 'model']), nestedValue(payload, ['toolInput', 'model']),
  );
  const isSubagent = Boolean(
    threadSource === 'subagent'
    || parentSessionId
    || (agentId && (declaredRole || declaredRoleConflict))
    || sourceCandidates.some((source) => Boolean(obj(source.subagent)))
    || nestedValue(data, ['subagent'])
    || nestedValue(payload, ['subagent']),
  );

  return {
    sessionId,
    parentSessionId,
    isSubagent,
    threadId,
    transcriptPath,
    agentId,
    declaredRole,
    declaredRoleConflict,
    model,
  };
}

// True when the hook is firing inside a SUBAGENT thread (not the parent/main
// agent). On Claude a subagent has its own session_id plus a parent_session_id; on
// Codex every thread reports the parent's session_id, so the reliable per-thread
// discriminator is a transcript threadId that differs from the reported session_id.
// Used to keep parent-only flows (onboarding wizard) from ever running in a worker.
export function isSubagentThread(rawInput: unknown): boolean {
  const id = hookSessionIdentity(rawInput);
  return id.isSubagent || Boolean(id.threadId && id.sessionId && id.threadId !== id.sessionId);
}

export function timestampAgeMs(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return Infinity;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? Date.now() - ts : Infinity;
}
export function isFreshTimestamp(value: unknown, maxAgeMs: number): boolean {
  return timestampAgeMs(value) <= maxAgeMs;
}

/**
 * The same window question asked the other way round: does this age ATTEST that
 * its subject was alive recently, rather than merely fail to prove it was not?
 *
 * `isFreshTimestamp` above answers the first question and must keep answering
 * it, because most of its callers read freshness as a REASON TO BLOCK — a
 * fallback lock that still shuts a rival out (fallback-claims.ts), a successor
 * whose live claim supersedes a ghost (claims-pending.ts), a target row whose
 * occupancy refuses a rebind (rebind-journal.ts). There, an unusable stamp must
 * keep the block: dropping it hands a second writer into files the first one
 * still holds. Liveness sites want the opposite default, and the two cannot be
 * one predicate.
 *
 * Two ages are unusable, and both currently read as ALIVE:
 *   - Infinity, from an absent or unparseable stamp. `age <= maxAgeMs` is false,
 *     so this predicate already fails closed and callers must stop hand-rolling
 *     the inverse.
 *   - a NEGATIVE age, from a stamp in the future, which passes `<= maxAgeMs` and
 *     so reads as maximally fresh forever. Clamping it to zero would change
 *     nothing (zero age is maximally fresh); a future stamp has to be
 *     CLASSIFIED as an untrustworthy clock, which is what the skew bound does.
 */
export function ageAttestsLiveness(ageMs: number, maxAgeMs: number): boolean {
  const age = trustworthyAgeMs(ageMs);
  return age !== null && age <= maxAgeMs;
}

export function attestsLiveness(value: unknown, maxAgeMs: number): boolean {
  return ageAttestsLiveness(timestampAgeMs(value), maxAgeMs);
}

// Why a claim did not bind. Recorded verbatim in the run's debug capture so an
// unresolved child is diagnosable: the old boolean returned a bare `false` that
// every consumer read as "no claim exists", which is how a project could sit
