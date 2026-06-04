"use strict";
// src/shared/onboarding/local-prefs.ts
// Per-user Traffic One preference STEP router for both existing projects and
// already-configured new projects. Shared state may be present in the repo, but
// each user still needs local choices for OpenCode, performance/team, and the
// code graph provider before mutating work proceeds. The wizard server consumes
// nextLocalPreferenceStep; the prose/popup assemblers were removed when onboarding
// moved into the local wizard (shared/onboarding-server).
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextLocalPreferenceStep = nextLocalPreferenceStep;
const obj_1 = require("../obj");
const performance_1 = require("../performance");
const state_1 = require("../state");
function nextLocalPreferenceStep(state) {
    const s = (0, obj_1.obj)(state);
    if (!s || !s.stack)
        return null;
    if (!(0, state_1.hasResolvedOpenCodeState)(s.openCode))
        return 'open-code';
    if (!(0, state_1.hasValidPerformanceState)(s.performance))
        return 'performance';
    const performance = (0, obj_1.obj)(s.performance);
    const level = performance && typeof performance.level === 'string' ? performance.level : '';
    const expectedTeamMode = (0, performance_1.teamModeForLevel)(level);
    const team = (0, obj_1.obj)(s.team);
    if (!(0, state_1.hasValidTeamState)(s.team)) {
        return expectedTeamMode === 'subagents' ? 'team-confirmation' : 'performance';
    }
    if (team && team.mode !== expectedTeamMode)
        return 'performance';
    if (expectedTeamMode === 'subagents' && !(0, state_1.isTeamApproved)(s.team))
        return 'team-confirmation';
    if (s.codeGraphProvider !== 'gitnexus' && s.codeGraphProvider !== 'graphify')
        return 'code-graph';
    return null;
}
