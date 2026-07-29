// src/shared/run-settlement/index.ts
// Run settlement v2. Barrel: implementation lives in the -types/-projection/
// -io/-reconcile siblings; this file re-exports exactly the original public
// surface.



export {
  RUN_SETTLEMENT_MIN_RUNTIME_VERSION,
  RUN_SETTLEMENT_SCHEMA_VERSION,
  runSettlementPath,
  runtimeVersionSatisfies,
  type CanonicalRunStatus,
  type RunSettlementV2,
  type RunV2RollbackBarrierProjection,
  type SettlementUpdate,
} from './types';

export {
  activateRunV2RollbackBarrier,
  effectiveLegacyRunOutcome,
  effectiveLegacyRunStatus,
  projectRunLedgerForV2Rollback,
} from './projection';

export {
  activeRunClaimCount,
  activeRunClaimScan,
  readRunSettlement,
  writeRunSettlement,
} from './io';

export {
  reconcileRunSettlement,
} from './reconcile';
