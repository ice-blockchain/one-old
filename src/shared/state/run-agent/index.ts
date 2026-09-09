// src/shared/state/run-agent/index.ts
// Run-agent state barrel. The implementation lives in the sibling modules
// (layered run-paths/locks/ledger up to codex-liveness); this index
// re-exports the original public surface so both the state barrel and
// every direct './run-agent' specifier keep working.

export {
  AGENT_ACTIVITY_EXPLORATION_CAP_DEFAULT,
  AGENT_ACTIVITY_REGRESSION_THRESHOLD,
  AGENT_ACTIVITY_WARN_THRESHOLD,
  EXPLORATION_CAPPED_ROLES,
  agentActivityCapDenied,
  bumpRunAgentActivity,
  explorationCapForRole,
  listRunAgentActivity,
  markAgentActivityCapDenied,
  readRunAgentActivity,
  type RunAgentActivity,
} from './activity';
export {
  assignmentForContext,
  readRunAssignments,
  readRunAssignmentsResilient,
  type RunManifest,
} from './assignments';
export {
  activeClaimForOtherThread,
  claimThreadRole,
  disownConflictedRoleAgent,
  disownConflictedRoleAgentResult,
} from './claim-thread-role';
export {
  pruneExpiredPendingClaims,
  type RunAgentUnresolvedReason,
} from './claims-pending';
export {
  ensureRunAgentClaim,
  ensureRunAgentClaimResult,
  releaseAllRunClaims,
  releaseRunClaims,
  releaseRunClaimsResult,
  runRoleHasBoundClaim,
} from './claims-store';
export {
  isApplied,
  retryWhileUnavailable,
  type MutationOutcome,
  type MutationResult,
} from './mutation-result';
export {
  retireUnverifiedCodexRunAgent,
  retireUnverifiedCodexRunAgentResult,
  type CodexLiveAgentValidation,
  validateCodexLiveRunAgent,
} from './codex-liveness';
export {
  findHostSessionFile,
  kiloDataDir,
  openCodeDataDir,
  validateHostLiveRunAgent,
  validateKiloLiveRunAgent,
  validateOpenCodeLiveRunAgent,
  validateWindsurfLiveRunAgent,
  windsurfTrajectoryId,
  type HostLiveAgentValidation,
} from './host-liveness';
export {
  explainUnresolvedRunAgent,
  hasActiveRunClaims,
  hasRunAgentState,
  resolveRunAgentContext,
  type RunAgentContext,
} from './context-resolve';
export {
  claimCursorFollowupsBatch,
  consumeCursorSpawnObservation,
  markCursorSpawnObservationFollowupEmitted,
  markCursorSpawnObservationRetryHandled,
  suppressCursorFollowupsBatch,
} from './cursor-followups';
export {
  claimCursorSpawnObservation,
  cursorParentObservationSnapshot,
  cursorSpawnObservationForChild,
  listCursorSpawnObservations,
  recordCursorSpawnObservation,
  type CursorFollowupClaimRequest,
  type CursorFollowupSuppressionReason,
  type CursorFollowupSuppressionRequest,
  type CursorSpawnObservation,
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
  ensureRunLedger,
  ensureRunLedgerResult,
  recordRunStackDrift,
  recordRunStackDriftResult,
  runIdentityFrozen,
  runLedgerAdmitsClaims,
  runLedgerClaimAdmission,
  transitionRunStatus,
  transitionRunStatusResult,
  type RunLedgerClaimAdmission,
  type RunLedgerOutcome,
  type RunLedgerStatus,
} from './ledger';
export {
  REPLACE_AGENT_MARKER,
  continuationAgentId,
  isCursorToolSubagentId,
  isResumeCapableAgentId,
  liveRunAgent,
  markRunAgentReplaced,
  markRunAgentReplacedIfMatches,
  markRunAgentReplacedIfMatchesResult,
  markRunAgentReplacedResult,
  readRunAgentRegistry,
  recordRunAgent,
  recordRunAgentResult,
  refreshCursorRunAgentFromTranscriptCache,
  roleForRunSessionId,
  subagentContinuationAvailable,
  type RunAgentEntry,
  verdictAgentConflict,
} from './registry';
export {
  inferRoleEvidenceFromTranscript,
  inferRoleFromTranscript,
  normalizeRoleIdentity,
  readCodexSessionMetaIdentity,
  transcriptThreadId,
  type RoleEvidence,
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
  describeTerminalSettleBlockers,
  runHasOrchestratedArtifacts,
  runIsEmptyFailedHusk,
  runSettledForRotation,
  settleTerminalRunLedger,
} from './run-settle';
export {
  ageAttestsLiveness,
  attestsLiveness,
  hookSessionIdentity,
  isSubagentThread,
} from './session-identity';
export {
  runHasEnvironmentBlockedQaOutcome,
  runHasExplicitBlockedQaOutcome,
  runLedgerStatusRecord,
  runReachedTerminalVerdict,
  runVerificationState,
} from './terminal-verdict';
