// src/shared/opencode-roles/index.ts
// OpenCode role/batch/attempt state. Barrel: implementation lives in the
// -plan-units/-batch-state/-markers siblings; this file re-exports exactly
// the original public surface.



export {
  OPENCODE_PLAN_MIN_UNITS,
  openCodeDelegateRoles,
  openCodeEnabled,
  openCodeParallelImplementers,
  parsePlanDelegationBlock,
  parsePlanDelegationUnits,
  planDelegationQueueRoles,
  planDelegationQueueRolesForRun,
  planDelegationUnitCount,
  roleHasQueuedUnits,
  shouldRunRoleOnOpenCode,
  type OpenCodePlanBatchOutcome,
  type OpenCodePlanBatchState,
  type PlanDelegationUnit,
} from './plan-units';

export {
  batchLooksLive,
  deriveBatchOutcomeFromUnits,
  hasFreshArchitectQueueForRun,
  markOpenCodePlanBatchComplete,
  markOpenCodePlanBatchRunning,
  markOpenCodePlanBatchTerminal,
  openCodePlanBatchComplete,
  readOpenCodePlanBatchState,
  reservedOpenCodeFiles,
  shouldBlockImplementerForPlanBatch,
  touchPlanBatchHeartbeat,
  unitLivenessWindowMs,
  type OpenCodeReservation,
} from './batch-state';

export {
  clearOpenCodeApplyInProgress,
  markOpenCodeApplyInProgress,
  markOpenCodeGateDenied,
  markOpenCodeGatewayOutage,
  markOpenCodePlanRoleCompleted,
  markOpenCodeRoleAttempted,
  markVerifyGateDenied,
  openCodeApplyInProgress,
  openCodeGateDenied,
  openCodeGatewayOutageActive,
  openCodePlanRoleCompleted,
  openCodeRoleAttempted,
  pendingOpenCodePlanRoles,
  recordOpenCodeAttemptOutcome,
  verifyGateDenied,
} from './markers';
