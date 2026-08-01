// src/shared/opencode-roles/index.ts
// OpenCode role/batch/attempt state. Barrel: implementation lives in the
// -plan-units/-batch-state/-markers siblings; this file re-exports exactly
// the original public surface.



export {
  OPENCODE_PLAN_MIN_UNITS,
  openCodeDelegateRoles,
  openCodeEnabled,
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
  shouldBlockImplementerForPlanBatch,
  touchPlanBatchHeartbeat,
  unitLivenessWindowMs,
} from './batch-state';

export {
  clearOpenCodeApplyInProgress,
  markOpenCodeApplyInProgress,
  markOpenCodeGateDenied,
  markOpenCodeGatewayOutage,
  markOpenCodePlanRoleCompleted,
  markOpenCodeRoleAttempted,
  openCodeApplyInProgress,
  openCodeGateDenied,
  openCodeGatewayOutageActive,
  openCodePlanRoleCompleted,
  openCodeRoleAttempted,
  pendingOpenCodePlanRoles,
  recordOpenCodeAttemptOutcome,
} from './markers';
