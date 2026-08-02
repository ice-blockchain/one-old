// src/shared/opencode-queue/index.ts
// Structured queue/status helpers for OpenCode delegation. The runner owns the
// actual model invocation; this module owns stable unit ids, queue policy, and
// per-run status files that let later gates and humans understand what happened.
//
// Barrel: implementation lives in the -types/-store/-policy siblings; this
// file re-exports exactly the original public surface.



export {
  type OpenCodeQueue,
  type OpenCodeQueueUnit,
  type OpenCodeUnitStatus,
  type OpenCodeUnitStatusEntry,
} from './types';

export {
  blockedByFailedDependencies,
  buildOpenCodeQueue,
  finalizeOpenCodeUnitsForBatch,
  hasRunningOpenCodeUnits,
  normalizeOpenCodeRole,
  opencodeAssignmentHash,
  parseAllowedFiles,
  persistBatchUnitsToStatus,
  readOpenCodeQueue,
  readOpenCodeUnitStatuses,
  reconcileAllRunningUnits,
  reconcileStaleRunningUnits,
  recordOpenCodeFallback,
  recordOpenCodeUnitStatus,
  statusFromDelegateAction,
  touchOpenCodeUnitRunning,
  writeOpenCodeQueue,
} from './store';

export {
  implicitProducerDependencies,
  openCodeQueuePolicyReport,
  openCodeQueuePolicyViolations,
  unsafeAllowedFilePatterns,
  type OpenCodeQueuePolicyOptions,
} from './policy';
