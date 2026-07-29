// src/shared/state/run-agent/index.ts
// Run-agent state barrel. The implementation lives in the sibling modules
// (layered run-paths/locks/ledger up to codex-liveness); this index
// re-exports the original public surface so both the state barrel and
// every direct './run-agent' specifier keep working.

export {
  assignmentForContext,
  readRunAssignments,
  readRunAssignmentsResilient,
  type AssignmentEntry,
  type RunManifest,
} from './assignments';
export {
  claimThreadRole,
  disownConflictedRoleAgent,
} from './claim-thread-role';
export {
  pruneExpiredPendingClaims,
  type RunAgentUnresolvedReason,
} from './claims-pending';
export {
  ensureRunAgentClaim,
  releaseAllRunClaims,
  releaseRunClaims,
} from './claims-store';
export {
  retireUnverifiedCodexRunAgent,
  type CodexLiveAgentValidation,
  validateCodexLiveRunAgent,
} from './codex-liveness';
export {
  explainUnresolvedRunAgent,
  hasActiveRunClaims,
  hasRunAgentState,
  resolveRunAgentContext,
  type RunAgentContext,
  type RunAgentUnresolvedDiagnosis,
} from './context-resolve';
export {
  claimCursorFollowupsBatch,
  consumeCursorSpawnObservation,
  markCursorSpawnObservationFollowupEmitted,
  markCursorSpawnObservationRetryHandled,
  suppressCursorFollowupsBatch,
} from './cursor-followups';
export {
  CURSOR_SPAWN_OBSERVATION_LIMIT,
  claimCursorSpawnObservation,
  cursorParentObservationSnapshot,
  cursorSpawnObservationForChild,
  listCursorSpawnObservations,
  recordCursorSpawnObservation,
  type CursorChildFollowupSuppressionRequest,
  type CursorFollowupClaimRequest,
  type CursorFollowupSuppressionReason,
  type CursorFollowupSuppressionRequest,
  type CursorParentFollowupSuppressionRequest,
  type CursorParentObservationSnapshot,
  type CursorSpawnObservation,
  type CursorSpawnObservationInput,
  type CursorSpawnObservationOutcome,
  type CursorSpawnObservationUpdate,
  updateCursorSpawnObservation,
} from './cursor-observations';
export {
  cursorTranscriptCandidateTimeMs,
  listCursorSubagentTranscriptCandidates,
  type CursorTranscriptCandidate,
} from './cursor-transcripts';
export {
  tryFallbackClaim,
} from './fallback-claims';
export {
  legacyRunAgentContext,
  reconcileRunIdentityDrift,
} from './identity-drift';
export {
  RUN_LEDGER_TRANSITION_HISTORY_LIMIT,
  RUN_STACK_DRIFT_HISTORY_LIMIT,
  ensureRunLedger,
  recordRunStackDrift,
  runIdentityFrozen,
  transitionRunStatus,
  type RunLedgerOutcome,
  type RunLedgerStatus,
  type RunLedgerTransitionOptions,
} from './ledger';
export {
  REPLACE_AGENT_MARKER,
  continuationAgentId,
  isCursorToolSubagentId,
  isResumeCapableAgentId,
  liveRunAgent,
  markRunAgentReplaced,
  markRunAgentReplacedIfMatches,
  readRunAgentRegistry,
  recordRunAgent,
  refreshCursorRunAgentFromTranscriptCache,
  roleForRunSessionId,
  subagentContinuationAvailable,
  type RunAgentEntry,
  type VerdictAgentConflict,
  verdictAgentConflict,
} from './registry';
export {
  inferRoleEvidenceFromTranscript,
  inferRoleFromTranscript,
  normalizeRoleIdentity,
  readCodexSessionMetaIdentity,
  transcriptThreadId,
  type CodexSessionMetaIdentity,
  type RoleEvidence,
  type RoleEvidenceAuthority,
  type RoleEvidenceResolution,
} from './role-evidence';
export {
  ensureCurrentRunId,
  normalizeHostCallId,
  runIdNow,
} from './run-paths';
export {
  anyRunProducedImplementerOutput,
  anyRunReachedTerminalVerdict,
  runHasOrchestratedArtifacts,
  runSettledForRotation,
  settleTerminalRunLedger,
} from './run-settle';
export {
  hookSessionIdentity,
  isSubagentThread,
  type SessionIdentity,
} from './session-identity';
export {
  runHasEnvironmentBlockedQaOutcome,
  runHasExplicitBlockedQaOutcome,
  runReachedTerminalVerdict,
  runVerificationState,
  type RunVerificationState,
} from './terminal-verdict';
