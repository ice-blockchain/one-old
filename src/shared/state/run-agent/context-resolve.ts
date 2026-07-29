// src/shared/state/run-agent/context-resolve.ts
// RunAgentContext resolution and the unresolved-claim explainer.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import { parseJson, readJson, readText, writeJson } from '../../fsjson';
import {
  PENDING_AGENT_CLAIM_STALE_MS,
  RUNS_REL_DIR,
  SUBAGENT_STALE_MS,
  VALID_AGENT_ROLES,
} from '../../../config/state';
import { stateTimestamp } from '../io';
import {
  activeAgentRole,
  getSpawnIndex,
  isSubagentSession,
  stackFingerprint,
  UNKNOWN_STACK_FINGERPRINT,
} from '../materialization';
import {
  type CodexModelObservation,
  continuationModelOf,
  correctCodexChildObservationRole,
  readCodexModelObservation,
} from '../codex-model-observation';

import {
  assignmentsFile,
  runAgentFile,
  runDir,
  runLedgerFingerprint,
  stackFingerprintPatch,
  uniqueStrings,
} from './run-paths';
import {
  ensureRunLedger,
} from './ledger';
import {
  inferRoleEvidenceFromTranscript,
  readCodexSessionMetaIdentity,
  strongestRoleSource,
  type RoleEvidence,
  type RoleEvidenceResolution,
} from './role-evidence';
import {
  hookSessionIdentity,
  isFreshTimestamp,
} from './session-identity';
import {
  cursorSubagentTranscript,
} from './cursor-transcripts';
import {
  claimAllowsState,
  claimRejectReason,
  listPendingClaims,
  matchingPendingClaim,
  readClaimFile,
  removePendingClaim,
  removeSiblingPendingClaims,
  runIdsForLookup,
  uniquelyCorrelatedPendingClaim,
  type RunAgentUnresolvedReason,
} from './claims-pending';
import {
  listClaimedAgents,
  releaseSupersededRoleClaimsLocked,
  withRunAgentClaimsLock,
} from './claims-store';
import {
  agentRegistryFile,
} from './registry';
import {
  claimThreadRole,
} from './claim-thread-role';
import {
  authoritativeRebindThreadRole,
  replayAuthoritativeRebindJournal,
} from './rebind-journal';

export interface RunAgentContext {
  source: string;
  runId: unknown;
  role: unknown;
  spawnIndex: number;
  sessionId: string | null;
  claimId: string | null;
}

export function contextFromClaim(claim: Rec, source: string): RunAgentContext {
  return {
    source,
    runId: claim.runId,
    role: claim.role,
    spawnIndex: typeof claim.spawnIndex === 'number' && Number.isInteger(claim.spawnIndex) && claim.spawnIndex > 0
      ? claim.spawnIndex
      : 1,
    sessionId: (claim.sessionId as string) || null,
    claimId: (claim.claimId as string) || null,
  };
}

export function annotateClaimRoleSource(
  cwd: string,
  runId: string,
  key: string,
  expected: Rec,
  evidence: RoleEvidence,
): Rec | null {
  if (expected.roleSource === evidence.source) return expected;
  let result: Rec | null = null;
  const locked = withRunAgentClaimsLock(cwd, runId, () => {
    const file = runAgentFile(cwd, runId, key);
    const current = readClaimFile(file);
    if (!current || current.role !== expected.role || current.claimId !== expected.claimId) return;
    const source = strongestRoleSource(evidence.source, current.roleSource);
    const next = source === current.roleSource ? current : { ...current, roleSource: source };
    try {
      if (next !== current) writeJson(file, next);
      result = next;
    } catch {
      result = null;
    }
  });
  return locked ? result : null;
}

export interface RunAgentUnresolvedDiagnosis {
  reason: RunAgentUnresolvedReason;
  runId?: string;
  role?: string;
  claimFingerprint?: string;
  ledgerFingerprint?: string;
  liveFingerprint?: string;
}

// Why the claims ON DISK do not bind for this hook payload. Read-only companion
// to resolveRunAgentContext: when that returns null the gates used to record a
// bare `role: null`, which is indistinguishable from "this really is the parent"
// — so a project could sit permanently unbindable with nothing anywhere saying
// why. Returns the most specific rejection found across the candidate keys.
export function explainUnresolvedRunAgent(
  cwd: string,
  state: unknown,
  rawInput: unknown,
): RunAgentUnresolvedDiagnosis {
  const identity = hookSessionIdentity(rawInput);
  const keys = [identity.agentId, identity.threadId, identity.sessionId]
    .filter((v): v is string => Boolean(v));
  // Most specific first: a fingerprint/run mismatch on a real claim explains far
  // more than "no claim file existed under this key".
  const ranked: RunAgentUnresolvedReason[] = [
    'fingerprint-mismatch', 'run-id-mismatch', 'not-materialized', 'claim-stale', 'no-claim',
  ];
  let best: RunAgentUnresolvedDiagnosis = { reason: 'no-claim' };
  let bestRank = ranked.length;
  for (const runId of runIdsForLookup(cwd, state)) {
    for (const key of keys) {
      const claim = readClaimFile(runAgentFile(cwd, runId, key));
      if (!claim) continue;
      const reason = claimRejectReason(cwd, state, claim);
      if (!reason) continue; // resolvable — some other stage rejected it
      const rank = ranked.indexOf(reason);
      if (rank < 0 || rank >= bestRank) continue;
      bestRank = rank;
      best = {
        reason,
        runId,
        role: typeof claim.role === 'string' ? claim.role : undefined,
        claimFingerprint: typeof claim.stackFingerprint === 'string' ? claim.stackFingerprint : undefined,
        ledgerFingerprint: runLedgerFingerprint(cwd, runId) || undefined,
        liveFingerprint: stackFingerprint(state),
      };
    }
  }
  return best;
}

export function resolveRunAgentContext(
  cwd: string,
  state: unknown,
  rawInput: unknown,
  options: { claimPending?: boolean; allowSoleAnonymousPending?: boolean; host?: string } = {},
): RunAgentContext | null {
  const identity = hookSessionIdentity(rawInput);
  if (identity.declaredRoleConflict) return null;
  const hookCodexMeta = identity.transcriptPath
    ? readCodexSessionMetaIdentity(identity.transcriptPath)
    : null;
  if (hookCodexMeta?.role.kind === 'conflict') return null;
  const transcriptIdentifiesChild = Boolean(
    identity.threadId && identity.sessionId && identity.threadId !== identity.sessionId,
  );
  const effectiveParentSessionId = identity.parentSessionId
    || hookCodexMeta?.parentThreadId
    || (transcriptIdentifiesChild ? identity.sessionId : null);
  const effectiveIsSubagent = identity.isSubagent || transcriptIdentifiesChild;
  // Before any exact-claim reuse, first-write self-heal, or pending correlation,
  // bind the line-zero metadata to the hook's actual child and parent. A copied
  // rollout must not grant its authoritative role to another thread.
  if (hookCodexMeta?.threadId && identity.threadId
    && hookCodexMeta.threadId.toLowerCase() !== identity.threadId.toLowerCase()) return null;
  if (hookCodexMeta?.parentThreadId && effectiveParentSessionId
    && hookCodexMeta.parentThreadId !== effectiveParentSessionId) return null;
  if (identity.declaredRole
    && hookCodexMeta?.role.kind === 'evidence'
    && hookCodexMeta.role.evidence.source !== 'spawn-task-name'
    && hookCodexMeta.role.evidence.role !== identity.declaredRole) return null;
  const shouldClaimPending = options.claimPending !== false;
  const runIds = runIdsForLookup(cwd, state);
  const requiresCodexObservation = options.host === 'codex' || Boolean(hookCodexMeta?.parentThreadId);
  const codexChildIds = uniqueStrings([
    identity.agentId,
    identity.threadId,
    hookCodexMeta?.threadId,
    ...(identity.isSubagent ? [identity.sessionId] : []),
  ].filter((value): value is string => Boolean(value)));
  const verifiedCodexObservation = (runId: string, role?: string | null): CodexModelObservation | null => {
    if (!requiresCodexObservation) return null;
    const observed = readCodexModelObservation(cwd, runId, codexChildIds);
    // A tolerated host continuation legitimately reports a model different from
    // the child-verified anchor. Without this the observation looks like an
    // identity mismatch: the context resolves to null, every write is denied, and
    // the role slot is not released either — a fresh deadlock. Only the ONE model
    // the observation store accepted as that continuation may differ.
    const continuationModel = continuationModelOf(observed);
    if (!observed
      || observed.status !== 'verified'
      || !observed.actualModel
      || (role && observed.role !== role)
      || (identity.model && observed.actualModel !== identity.model && continuationModel !== identity.model)
      || (hookCodexMeta?.threadId && observed.childId.toLowerCase() !== hookCodexMeta.threadId.toLowerCase())
      || (hookCodexMeta?.parentThreadId && observed.parentSessionId
        && observed.parentSessionId !== hookCodexMeta.parentThreadId)) return null;
    return observed;
  };

  // Exact claim match. agentId (Claude agent-teams) is the most specific key, then
  // threadId (from transcript_path, the reliable Codex key — a subagent's tool-call
  // hook reports the parent's session_id), then session_id (per-thread id on Claude).
  const exactKeys = [identity.agentId, identity.threadId, identity.sessionId].filter((v): v is string => Boolean(v));
  for (const runId of runIds) {
    for (const key of exactKeys) {
      // A crash may leave the claim already corrected while exact-holder or
      // pending cleanup is incomplete. Gate every exact reuse (including hosts
      // with no transcript) on durable transaction replay before returning it.
      const replay = replayAuthoritativeRebindJournal(cwd, state, runId, key);
      if (replay.status === 'blocked') return null;
      const claim = replay.status === 'complete'
        ? replay.claim
        : readClaimFile(runAgentFile(cwd, runId, key));
      if (claim && claimAllowsState(cwd, state, claim)) {
        let observed = requiresCodexObservation
          ? verifiedCodexObservation(runId, typeof claim.role === 'string' ? claim.role : null)
          : null;
        if (requiresCodexObservation && !observed) {
          const authoritativeRole = hookCodexMeta?.role.kind === 'evidence'
            ? hookCodexMeta.role.evidence.role
            : null;
          if (!authoritativeRole) return null;
          const existing = readCodexModelObservation(cwd, runId, codexChildIds);
          // A provisional SubagentStart role may have classified the immutable
          // model as a mismatch. Line-zero Codex session metadata is the one
          // correction-grade signal allowed to re-evaluate that same model.
          // Conflict remains terminal in correctCodexChildObservationRole.
          if (!existing || existing.status === 'conflict') return null;
          observed = correctCodexChildObservationRole(cwd, runId, existing.childId, authoritativeRole);
          if (!observed || observed.status !== 'verified' || observed.actualModel !== existing.actualModel) return null;
        }
        // Legacy Codex claims can carry the wrong role while remaining fresh. When
        // this exact hook supplies the child rollout, inspect ONLY line zero
        // (session_meta). Prompt/tool content is never consulted for correction.
        if (identity.transcriptPath && identity.threadId === key) {
          const meta = readCodexSessionMetaIdentity(identity.transcriptPath);
          if (meta && meta.role.kind === 'conflict') return null;
          if (meta && meta.role.kind === 'evidence') {
            if (meta.threadId && meta.threadId.toLowerCase() !== key.toLowerCase()) return null;
            if (meta.parentThreadId && identity.sessionId && meta.parentThreadId !== identity.sessionId) return null;
            if (claim.role !== meta.role.evidence.role) {
              return authoritativeRebindThreadRole(cwd, state, runId, key, claim, meta.role.evidence, {
                transcriptPath: identity.transcriptPath,
                parentSessionId: meta.parentThreadId || identity.sessionId,
                model: observed?.actualModel || identity.model,
              });
            }
            const annotated = annotateClaimRoleSource(cwd, runId, key, claim, meta.role.evidence);
            return annotated ? contextFromClaim(annotated, 'run-agent') : null;
          }
        }
        return contextFromClaim(claim, 'run-agent');
      }
    }
  }

  // Claude agent-teams self-heal: the worker stamps its role (agent_type) + stable
  // id (agent_id) on the payload but provides no per-thread transcript, so the
  // transcript-inference path below never sees it. Bind the claim keyed by agent_id
  // with the declared role — no inference needed. This is what unblocks team
  // workers' feature-source writes (see project_agent_teams_claim_deadlock).
  if (shouldClaimPending && identity.agentId && identity.declaredRole) {
    const runId = runIds[0] || '';
    const observed = requiresCodexObservation ? verifiedCodexObservation(runId, identity.declaredRole) : null;
    if (requiresCodexObservation && !observed) return null;
    const ctx = claimThreadRole(cwd, state, identity.agentId, identity.declaredRole, {
      parentSessionId: identity.sessionId,
      model: observed?.actualModel || identity.model,
      evidence: { role: identity.declaredRole, source: 'host-declared-role', authority: 'authoritative' },
    });
    if (ctx) return ctx;
  }

  // Hosts with a per-child session id can bind the same authoritative role
  // without a separate agent_id. Keep this behind an explicit subagent signal
  // so a parent spawn payload can never claim its own session.
  if (shouldClaimPending && !identity.agentId && identity.isSubagent && identity.declaredRole) {
    const declaredThreadId = identity.threadId || identity.sessionId;
    const declaredParentId = identity.threadId && identity.sessionId && identity.threadId !== identity.sessionId
      ? identity.sessionId
      : identity.parentSessionId;
    if (declaredThreadId) {
      const runId = runIds[0] || '';
      const observed = requiresCodexObservation ? verifiedCodexObservation(runId, identity.declaredRole) : null;
      if (requiresCodexObservation && !observed) return null;
      const ctx = claimThreadRole(cwd, state, declaredThreadId, identity.declaredRole, {
        parentSessionId: declaredParentId || effectiveParentSessionId,
        model: observed?.actualModel || identity.model,
        transcriptPath: identity.transcriptPath,
        evidence: { role: identity.declaredRole, source: 'host-declared-role', authority: 'authoritative' },
      });
      if (ctx) return ctx;
    }
  }

  // Codex/Cursor self-heal: a subagent thread with no claim yet can still bind from
  // its own transcript. Codex sends transcript_path directly; Cursor child writes
  // omit it, so we locate the child transcript by conversation/session id.
  const cursorTranscript = shouldClaimPending && !identity.transcriptPath && identity.sessionId
    ? cursorSubagentTranscript(cwd, rawInput, identity.sessionId)
    : null;
  const cursorTranscriptPath = cursorTranscript ? cursorTranscript.filePath : null;
  const inferenceTranscriptPath = identity.transcriptPath || cursorTranscriptPath;
  const inferredResolution = shouldClaimPending && inferenceTranscriptPath
    ? inferRoleEvidenceFromTranscript(inferenceTranscriptPath)
    : { kind: 'none' } as RoleEvidenceResolution;
  const inferredEvidence = inferredResolution.kind === 'evidence' ? inferredResolution.evidence : null;
  const inferredRole = inferredEvidence?.role || null;
  const inferredThreadId = identity.threadId && identity.sessionId && identity.threadId !== identity.sessionId
    ? identity.threadId
    : (cursorTranscriptPath && identity.sessionId ? identity.sessionId : null);
  if (shouldClaimPending && inferredThreadId && inferredRole) {
    const runId = runIds[0] || '';
    const observed = requiresCodexObservation ? verifiedCodexObservation(runId, inferredRole) : null;
    if (requiresCodexObservation && !observed) return null;
    const parentSessionId = effectiveParentSessionId || cursorTranscript?.parentSessionId || null;
    const ctx = claimThreadRole(cwd, state, inferredThreadId, inferredRole, {
      parentSessionId,
      model: observed?.actualModel || identity.model,
      transcriptPath: inferenceTranscriptPath,
      evidence: inferredEvidence || undefined,
    });
    if (ctx) return ctx;
  }

  if (shouldClaimPending && effectiveIsSubagent && inferredResolution.kind !== 'conflict') {
    if (requiresCodexObservation) return null;
    for (const runId of runIds) {
      // When the thread's transcript reveals its role, never claim a different
      // role's pending file: parallel fix-cycle workers spawn near-simultaneously
      // and FIFO matching hands the frontend worker the backend claim (observed
      // live — the misclaimed worker then fails every scope check and the run
      // deadlocks until the orchestrator improvises).
      const pending = listPendingClaims(cwd, runId)
        .filter(({ claim }) => claimAllowsState(cwd, state, claim));
      const matched = inferredRole
        ? matchingPendingClaim(cwd, state, runId, inferredRole, effectiveParentSessionId, identity.model)
        : uniquelyCorrelatedPendingClaim(pending, effectiveParentSessionId, identity.model);
      if (!matched) continue;

      // Key the claimed file by the PER-THREAD id when we have one. On Codex,
      // identity.sessionId is the parent's session for every worker thread — using
      // it as the key made all parallel workers collide on one claim file (each
      // overwrite re-pointed every worker's resolution at the last-claimed role).
      const sessionId = identity.threadId || identity.sessionId || (matched.claim.sessionId as string) || (matched.claim.claimId as string);
      let claimed: Rec | null = null;
      const claimedUnderLock = withRunAgentClaimsLock(cwd, runId, () => {
        const currentPending = readClaimFile(matched.filePath);
        if (!currentPending
          || currentPending.claimId !== matched.claim.claimId
          || currentPending.role !== matched.claim.role
          || !claimAllowsState(cwd, state, currentPending)) return;
        const existingThreadClaim = readClaimFile(runAgentFile(cwd, runId, sessionId));
        if (existingThreadClaim && claimAllowsState(cwd, state, existingThreadClaim)) return;
        const ledger = ensureRunLedger(cwd, runId, {
          status: 'active',
          kind: 'agent-claim',
          ...stackFingerprintPatch(cwd, runId, state),
        });
        if (ledger?.status !== 'active') return;
        claimed = {
          ...currentPending,
          status: 'claimed',
          sessionId,
          parentSessionId: effectiveParentSessionId || currentPending.parentSessionId || null,
          claimedAt: stateTimestamp(),
          roleSource: strongestRoleSource(inferredEvidence?.source, currentPending.roleSource) || 'pending-correlation',
          transcriptPath: inferenceTranscriptPath || null,
        };
        fs.mkdirSync(runDir(cwd, runId), { recursive: true });
        writeJson(runAgentFile(cwd, runId, sessionId), claimed);
        removePendingClaim(matched.filePath);
        removeSiblingPendingClaims(
          cwd, state, runId, String(claimed!.role || ''),
          claimed!.parentSessionId as string | null,
          claimed!.claimId as string | null,
        );
        releaseSupersededRoleClaimsLocked(
          cwd, runId, String(claimed!.role || ''), sessionId, String(claimed!.claimId || ''),
        );
      });
      if (claimedUnderLock && claimed) return contextFromClaim(claimed, 'run-agent');
    }
  }

  // Devin Local's native PreToolUse payload currently contains no session,
  // parent, transcript, or subagent marker. `run_subagent` is foreground-only:
  // while it is running the parent is suspended, so one fresh pending claim is
  // unambiguously the active child. Keep the pending file in place so every
  // subsequent child write resolves the same role; PostToolUse owns completion.
  // This fallback is opt-in because it would be unsafe on hosts with background
  // or parallel anonymous workers.
  if (shouldClaimPending && options.allowSoleAnonymousPending && exactKeys.length === 0) {
    const pending = runIds
      .flatMap((runId) => listPendingClaims(cwd, runId))
      .filter(({ claim }) => claimAllowsState(cwd, state, claim));
    if (pending.length === 1) return contextFromClaim(pending[0]!.claim, 'sole-foreground-pending');
  }

  return null;
}

// Create a claimed role context keyed by an explicit thread id. Used by the Codex
// SubagentStart hook: Codex fires no PreToolUse for spawns (so the agent-model gate
// never stakes a pending claim) and reports the parent's session_id on the child's
// later tool calls — the child is identifiable only by its transcript thread id
// (== the SubagentStart `agent_id`). We persist a claim under that id with the role
// inferred from the child's spawn prompt, so the child's write hook resolves its role
// by exact threadId match. Idempotent: an existing valid claim is returned as-is.

export function hasRunAgentState(cwd: string, state: unknown): boolean {
  const s = obj(state);
  const runId = s && typeof s.currentRunId === 'string' ? s.currentRunId : null;
  if (!runId) return false;
  if (listPendingClaims(cwd, runId).length > 0) return true;
  if (listClaimedAgents(cwd, runId).length > 0) return true;
  if (fs.existsSync(assignmentsFile(cwd, runId))) return true;
  const registry = obj(readJson(agentRegistryFile(cwd, runId), null));
  const agents = registry ? obj(registry.agents) : null;
  return Boolean(agents && Object.keys(agents).length > 0);
}

// True when any subagent is currently in flight across all runs: a fresh pending
// claim (within PENDING_AGENT_CLAIM_STALE_MS) or a fresh claimed agent (within
// SUBAGENT_STALE_MS). Used by the build-completion heuristic to never flip a
// project to maintenance phase while an orchestration run is still active.
// `options.since` is the lifecycle completion watermark: claims created at or
// before it belong to a FINISHED run and do not count — without it, a completed
// build's claims would look "active" for up to 30 minutes and suppress the
// post-build triage directive at exactly the moment the user starts iterating.
export function hasActiveRunClaims(cwd: string, state: unknown, options: { since?: string | null } = {}): boolean {
  const sinceTs = typeof options.since === 'string' && options.since.trim() ? Date.parse(options.since) : NaN;
  const afterWatermark = (claim: Rec): boolean => {
    if (!Number.isFinite(sinceTs)) return true;
    const created = typeof claim.createdAt === 'string' ? Date.parse(claim.createdAt) : NaN;
    return !Number.isFinite(created) || created > sinceTs;
  };
  for (const runId of runIdsForLookup(cwd, state)) {
    if (listPendingClaims(cwd, runId).some(({ claim }) => afterWatermark(claim))) return true;
    if (listClaimedAgents(cwd, runId).some((claim) => (
      claim.status !== 'released'
      && isFreshTimestamp(claim.createdAt, SUBAGENT_STALE_MS)
      && afterWatermark(claim)
    ))) return true;
  }
  return false;
}

