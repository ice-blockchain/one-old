"use strict";
// src/shared/onboarding/repair.ts
// Auto-repair of a new-project onboarding state that is complete-but-noncanonical
// (e.g. needs a normalize pass): if every required field is present and valid
// after normalization, rewrite the canonical state and materialize. Ported 1:1
// from canRepairNewProjectOnboardingState / repairNewProjectOnboardingState
// (_helpers.cjs).
Object.defineProperty(exports, "__esModule", { value: true });
exports.canRepairNewProjectOnboardingState = canRepairNewProjectOnboardingState;
exports.repairNewProjectOnboardingState = repairNewProjectOnboardingState;
const config_1 = require("../config");
const detection_1 = require("../detection");
const materialize_1 = require("../materialize");
const performance_1 = require("../performance");
const state_1 = require("../state");
const predicates_1 = require("./predicates");
function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
// True when `state` is an onboarding-complete new project that only needs a
// normalize pass to become canonical (so the gate can repair instead of deny).
function canRepairNewProjectOnboardingState(state) {
    const s = obj(state);
    if (!s)
        return false;
    if (s.onboardingComplete !== true)
        return false;
    if (s.confirmed === false)
        return false;
    const candidate = JSON.parse(JSON.stringify(s));
    (0, state_1.normalizeState)(candidate, candidate.mode || 'new-project');
    if (candidate.mode !== 'new-project')
        return false;
    if (typeof candidate.stack !== 'string' || !(0, config_1.isKnownStack)(candidate.stack))
        return false;
    if (typeof candidate.frontend !== 'string' || !state_1.FRONTEND_IDS.has(candidate.frontend))
        return false;
    if (typeof candidate.backend !== 'string' || !state_1.BACKEND_IDS.has(candidate.backend))
        return false;
    if (!(0, state_1.hasValidProjectContext)(candidate.projectContext))
        return false;
    if (candidate.mobile === undefined || candidate.mobile === null)
        return false;
    if (!(0, state_1.hasResolvedNewProjectMobileState)(candidate.mobile))
        return false;
    if (!(0, state_1.hasValidTeamState)(candidate.team))
        return false;
    if (!(0, state_1.hasValidPerformanceState)(candidate.performance))
        return false;
    const team = obj(candidate.team);
    const performance = obj(candidate.performance);
    if (!team || !performance)
        return false;
    const expectedTeamMode = (0, performance_1.teamModeForLevel)(String(performance.level));
    if (team.mode !== expectedTeamMode)
        return false;
    if (expectedTeamMode === 'subagents' && !(0, state_1.isTeamApproved)(candidate.team))
        return false;
    if (candidate.codeGraphProvider !== 'gitnexus' && candidate.codeGraphProvider !== 'graphify')
        return false;
    (0, state_1.normalizeState)(candidate, candidate.mode || 'new-project');
    return !(0, predicates_1.isNewProjectOnboardingIncomplete)(candidate);
}
// Repair + materialize, or null when the state cannot be auto-repaired (the gate
// then falls through to the onboarding prompt).
function repairNewProjectOnboardingState(cwd, state, trigger) {
    if (!canRepairNewProjectOnboardingState(state))
        return null;
    try {
        const repaired = JSON.parse(JSON.stringify(state));
        (0, state_1.normalizeState)(repaired, repaired.mode || (0, detection_1.detectMode)(cwd));
        (0, state_1.writeState)(cwd, repaired);
        return (0, materialize_1.materializeProjectFromState)(cwd, { trigger });
    }
    catch (error) {
        const detail = error && error.message ? error.message : String(error || 'unknown error');
        return {
            status: 'failed',
            systemMessage: 'traffic-one — project-local materialization failed',
            context: `traffic-one could not materialize .traffic-one/rules, .traffic-one/skills, and .traffic-one/manifest.json: ${detail}`,
            result: null,
        };
    }
}
