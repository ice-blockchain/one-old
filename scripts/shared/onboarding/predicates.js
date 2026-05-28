"use strict";
// src/shared/onboarding/predicates.ts
// Pure new-project onboarding predicates (no prose, no IO). The onboarding gate
// + SessionStart flow read these to decide whether onboarding is resolved and
// whether Team Confirmation is still pending. Ported 1:1 from _helpers.cjs
// (isNewProjectOnboardingIncomplete:969, needsTeamConfirmation:1420).
Object.defineProperty(exports, "__esModule", { value: true });
exports.isNewProjectOnboardingIncomplete = isNewProjectOnboardingIncomplete;
exports.needsTeamConfirmation = needsTeamConfirmation;
const config_1 = require("../config");
const performance_1 = require("../performance");
const state_1 = require("../state");
function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
// True when mode==="new-project" and any required shared-state or local-pref
// onboarding field is still missing/invalid (blocks scaffolding/tool use).
function isNewProjectOnboardingIncomplete(state) {
    const s = obj(state);
    if (!s)
        return false;
    if (s.mode !== 'new-project')
        return false;
    const performance = obj(s.performance);
    const team = obj(s.team);
    const hasValidStack = typeof s.stack === 'string' && (0, config_1.isKnownStack)(s.stack);
    const hasOpenCode = (0, state_1.hasResolvedOpenCodeState)(s.openCode);
    const hasGraphProvider = s.codeGraphProvider === 'gitnexus' || s.codeGraphProvider === 'graphify';
    const hasFrontend = typeof s.frontend === 'string' && state_1.FRONTEND_IDS.has(s.frontend);
    const hasBackend = typeof s.backend === 'string' && state_1.BACKEND_IDS.has(s.backend);
    const hasTeam = (0, state_1.hasValidTeamState)(s.team);
    const hasPerformance = (0, state_1.hasValidPerformanceState)(s.performance);
    const hasProjectContext = (0, state_1.hasValidProjectContext)(s.projectContext);
    const expectedTeamMode = performance ? (0, performance_1.teamModeForLevel)(String(performance.level)) : null;
    const teamMatchesPerformance = hasTeam && hasPerformance && Boolean(team) && team.mode === expectedTeamMode;
    const hasRequiredTeamApproval = hasTeam && hasPerformance
        && (expectedTeamMode !== 'subagents' || (0, state_1.isTeamApproved)(s.team));
    return !hasValidStack
        || !hasOpenCode
        || !hasFrontend
        || !hasBackend
        || !hasProjectContext
        || !(0, state_1.hasResolvedNewProjectMobileState)(s.mobile)
        || !(0, state_1.hasTechnologyArrays)(s.technologies)
        || !hasGraphProvider
        || !hasTeam
        || !hasPerformance
        || !teamMatchesPerformance
        || !hasRequiredTeamApproval
        || !(0, state_1.hasInitializedToolchain)(s.toolchain)
        || s.confirmed !== true
        || s.onboardingComplete !== true
        || typeof s.confirmedAt !== 'string'
        || s.confirmedAt.trim() === '';
}
// True when a Balanced/High new project still needs the user to approve the
// subagent role/model line-up (team.mode="subagents" but team.approved !== true).
function needsTeamConfirmation(state) {
    const s = obj(state);
    if (!s)
        return false;
    if (s.mode !== 'new-project')
        return false;
    if (!(0, state_1.hasValidPerformanceState)(s.performance))
        return false;
    if (!(0, state_1.hasValidTeamState)(s.team))
        return false;
    const performance = obj(s.performance);
    const team = obj(s.team);
    if (!performance || !team)
        return false;
    if ((0, performance_1.teamModeForLevel)(String(performance.level)) !== 'subagents')
        return false;
    if (team.mode !== 'subagents')
        return false;
    return !(0, state_1.isTeamApproved)(s.team);
}
