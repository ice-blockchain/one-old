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
const isKnownStackName = isKnownStack;

export function isCompletedTrafficOneMaterialization(cwd: string, state: Rec): boolean {
  return Boolean(
    state
    && state.onboardingComplete === true
    && isKnownStackName(state.stack)
    && isMaterialized(state)
    && hasMaterializedProjectAssets(cwd, state),
  );
}

/**
 * Converge the project's `.traffic-one/**` assets, reporting whether the
 * materialization STAMP is now on disk.
 *
 * `false` has exactly one cause: the stamp write was REFUSED — an unanswered
 * consent question, or a planted symlink at `.traffic-one/.one.json`. Measured,
 * and not the same list as "everything that can stop the write": fsjson.ts's
 * `act` answers `false` only for the consent/path guard and ELOOP, and RETHROWS
 * every other errno, so an EACCES arrives here as an exception rather than as
 * `false`. Either way the assets exist and nothing on disk says so; only the
 * first arm is expressible as a return value. `true` covers a completed stamp
 * AND every path that had no stamp to write — an unknown stack, incomplete
 * onboarding, an already-materialized project, a skipped sweep.
 *
 * WHAT THE ANSWER IS FOR, since it deliberately does not decide the verdict.
 * The consumer (gate-enforcement.ts#modelEnforcementGates) reads back
 * `isCompletedTrafficOneMaterialization` against the state it re-reads from disk,
 * and that read-back stays authoritative — it is strictly stronger, because it
 * also catches a stamp that landed over incomplete assets, and an already-stamped
 * project whose assets were just restored under a refused re-stamp (there the
 * project IS complete and `false` here would misreport it). So this boolean names
 * the CAUSE, not the outcome: it is the only thing that can distinguish "did not
 * converge" from "converged and could not record it", and the second is
 * permanent — refusals through this layer are durable, so every later spawn
 * re-runs the whole sweep (~36 ms, ~90 rewritten files per call; 72.5, 34.8,
 * 37.3, 36.1, 36.0 ms over five consecutive calls on a default/react-vite
 * project) and denies again, forever, with nothing naming the refused path.
 *
 * Measured on a project whose `.one.json` was fenced move-aside: the assets land
 * (3 -> 93 files), no `materialized*` key reaches disk, the read-back answers
 * `false`, and the consumer denies `agent-materialization-missing` rather than
 * `agent-materialization-deny`. Both are denies and they are distinguishable, so
 * the run already failed closed on the correct one — this is a diagnosis fix, not
 * a fail-open fix.
 *
 * NOT the permanent-deny-loop consumer: that one is
 * shared/materialize/converge.ts's, whose caller reads any non-null outcome as
 * `repaired-materialization`, and it already reports the refusal
 * (stateWriteRefusedOutcome).
 */
export function materializeIfNeeded(cwd: string): boolean {
  const state = readEffectiveState(cwd);
  if (!isKnownStackName(state.stack) || state.onboardingComplete !== true) return true;
  if (isMaterialized(state) && hasMaterializedProjectAssets(cwd, state)) return true;
  const result = materializeProjectAssets(cwd, state);
  if (result.skipped) return true;
  state.materializedStack = stackFingerprint(state);
  state.materializedAt = nowIsoNoMs();
  state.materializedVersion = stateVersion();
  return writeState(cwd, state);
}
