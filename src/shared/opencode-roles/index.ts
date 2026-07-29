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
  deriveBatchOutcomeFromUnits,
  hasFreshArchitectQueueForRun,
  markOpenCodePlanBatchComplete,
  markOpenCodePlanBatchRunning,
  markOpenCodePlanBatchTerminal,
  openCodePlanBatchComplete,
  readOpenCodePlanBatchState,
  shouldBlockImplementerForPlanBatch,
} from './batch-state';

export {
  markOpenCodeGateDenied,
  markOpenCodeGatewayOutage,
  markOpenCodePlanRoleCompleted,
  markOpenCodeRoleAttempted,
  openCodeGateDenied,
  openCodeGatewayOutageActive,
  openCodePlanRoleCompleted,
  openCodeRoleAttempted,
  pendingOpenCodePlanRoles,
  recordOpenCodeAttemptOutcome,
} from './markers';
