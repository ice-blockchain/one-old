"use strict";
// src/shared/onboarding/prompts.ts
// New-project onboarding step ROUTER (pure logic). The wizard server consumes
// nextOnboardingStep to decide which question to show next. The per-step popup
// builders + chat-fallback prose were removed when onboarding moved into the
// local wizard (shared/onboarding-server).
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextOnboardingStep = nextOnboardingStep;
const obj_1 = require("../obj");
const state_1 = require("../state");
const predicates_1 = require("./predicates");
// The next unresolved onboarding step for a new project, in canonical order, or
// null when mode !== "new-project". 'state' means all prompts answered but the
// canonical state file still needs writing (the wizard's finalize step).
function nextOnboardingStep(state) {
    const s = (0, obj_1.obj)(state);
    if (!s || s.mode !== 'new-project')
        return null;
    if (!(0, state_1.hasResolvedOpenCodeState)(s.openCode))
        return 'open-code';
    if (!(0, state_1.hasValidPerformanceState)(s.performance))
        return 'performance';
    if ((0, predicates_1.needsTeamConfirmation)(s))
        return 'team-confirmation';
    if (!(0, state_1.hasValidTeamState)(s.team))
        return 'team';
    if (!(0, state_1.hasValidProjectContext)(s.projectContext))
        return 'project-context';
    if (!(0, state_1.hasResolvedNewProjectMobileState)(s.mobile))
        return 'mobile';
    if (s.codeGraphProvider !== 'gitnexus' && s.codeGraphProvider !== 'graphify')
        return 'code-graph';
    return 'state';
}
