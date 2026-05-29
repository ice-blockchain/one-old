"use strict";
// src/shared/onboarding/prompts.ts
// New-project onboarding step ROUTER + popup request dispatch (pure logic). The
// directive PROSE (chat fallbacks shown when no popup tool is available) lives
// in the onboarding-gate module's skill and is supplied as `fallbackText`; this
// keeps routing logic prose-free. Ported 1:1 from nextOnboardingStep /
// nextOnboardingStepPromptAndRequest (_helpers.cjs).
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextOnboardingStep = nextOnboardingStep;
exports.performanceLevelOf = performanceLevelOf;
exports.onboardingPromptRequestForStep = onboardingPromptRequestForStep;
const obj_1 = require("../obj");
const prompt_request_1 = require("../prompt-request");
const state_1 = require("../state");
const predicates_1 = require("./predicates");
// The next unresolved onboarding step for a new project, in canonical order, or
// null when mode !== "new-project". 'state' means all prompts answered but the
// canonical state file still needs writing.
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
function performanceLevelOf(state) {
    const s = (0, obj_1.obj)(state);
    const perf = s && (0, obj_1.obj)(s.performance);
    return perf && typeof perf.level === 'string' ? perf.level : 'selected';
}
// Build the host popup request for a given onboarding step. Returns null for the
// terminal 'state' step (no popup — the model just writes the state file). The
// `fallbackText` (chat-fallback prose) is supplied by the caller from a skill.
function onboardingPromptRequestForStep(step, opts = {}) {
    const { level, fallbackText } = opts;
    switch (step) {
        case 'open-code': return (0, prompt_request_1.openCodePromptRequest)(fallbackText);
        case 'performance': return (0, prompt_request_1.performancePromptRequest)(fallbackText);
        case 'team-confirmation':
        case 'team': return (0, prompt_request_1.teamConfirmationPromptRequest)(level || 'selected', fallbackText);
        case 'project-context': return (0, prompt_request_1.projectContextPromptRequest)(fallbackText);
        case 'mobile': return (0, prompt_request_1.mobilePromptRequest)(fallbackText);
        case 'code-graph': return (0, prompt_request_1.codeGraphPromptRequest)(fallbackText);
        case 'state': return null;
    }
}
