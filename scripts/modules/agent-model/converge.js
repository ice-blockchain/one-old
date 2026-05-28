"use strict";
// src/modules/agent-model/converge.ts
// Materialization-completeness check + on-demand convergence for the spawn gate.
// Ported from isCompletedTrafficOneMaterialization + materializeProjectIfNeeded
// (gates.cjs / _helpers.cjs), using the ported materialize subsystem.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isKnownStackName = void 0;
exports.isCompletedTrafficOneMaterialization = isCompletedTrafficOneMaterialization;
exports.materializeIfNeeded = materializeIfNeeded;
const config_1 = require("../../shared/config");
const materialize_1 = require("../../shared/materialize");
const state_1 = require("../../shared/state");
const text_1 = require("../../shared/text");
// Back-compat alias: the canonical predicate now lives in shared/config.
exports.isKnownStackName = config_1.isKnownStack;
function isCompletedTrafficOneMaterialization(cwd, state) {
    return Boolean(state
        && state.onboardingComplete === true
        && (0, exports.isKnownStackName)(state.stack)
        && (0, state_1.isMaterialized)(state)
        && (0, materialize_1.hasMaterializedProjectAssets)(cwd, state));
}
function materializeIfNeeded(cwd) {
    const state = (0, state_1.readEffectiveState)(cwd);
    if (!(0, exports.isKnownStackName)(state.stack) || state.onboardingComplete !== true)
        return;
    if ((0, state_1.isMaterialized)(state) && (0, materialize_1.hasMaterializedProjectAssets)(cwd, state))
        return;
    const result = (0, materialize_1.materializeProjectAssets)(cwd, state);
    if (!result.skipped) {
        state.materializedStack = (0, state_1.stackFingerprint)(state);
        state.materializedAt = (0, text_1.nowIsoNoMs)();
        state.materializedVersion = (0, state_1.stateVersion)();
        (0, state_1.writeState)(cwd, state);
    }
}
