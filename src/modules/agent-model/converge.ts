// src/modules/agent-model/converge.ts
// Materialization-completeness check + on-demand convergence for the spawn gate.
// Ported from isCompletedTrafficOneMaterialization + materializeProjectIfNeeded
// (gates.cjs / _helpers.cjs), using the ported materialize subsystem.

import { isKnownStack } from '../../shared/config';
import { hasMaterializedProjectAssets, materializeProjectAssets } from '../../shared/materialize';
import { isMaterialized, readEffectiveState, stackFingerprint, stateVersion, writeState } from '../../shared/state';
import { nowIsoNoMs } from '../../shared/text';

type Rec = Record<string, unknown>;

// Back-compat alias: the canonical predicate now lives in shared/config.
export const isKnownStackName = isKnownStack;

export function isCompletedTrafficOneMaterialization(cwd: string, state: Rec): boolean {
  return Boolean(
    state
    && state.onboardingComplete === true
    && isKnownStackName(state.stack)
    && isMaterialized(state)
    && hasMaterializedProjectAssets(cwd, state),
  );
}

export function materializeIfNeeded(cwd: string): void {
  const state = readEffectiveState(cwd);
  if (!isKnownStackName(state.stack) || state.onboardingComplete !== true) return;
  if (isMaterialized(state) && hasMaterializedProjectAssets(cwd, state)) return;
  const result = materializeProjectAssets(cwd, state);
  if (!result.skipped) {
    state.materializedStack = stackFingerprint(state);
    state.materializedAt = nowIsoNoMs();
    state.materializedVersion = stateVersion();
    writeState(cwd, state);
  }
}
