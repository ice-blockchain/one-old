"use strict";
// src/shared/onboarding/local-prefs.ts
// Per-user Traffic One preference gate for both existing projects and
// already-configured new projects. Shared state may be present in the repo, but
// each user still needs local choices for OpenCode, performance/team, and the
// code graph provider before mutating work proceeds.
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextLocalPreferenceStep = nextLocalPreferenceStep;
exports.hasMissingLocalPreferences = hasMissingLocalPreferences;
exports.localPreferencePromptAndRequest = localPreferencePromptAndRequest;
exports.localPreferenceContext = localPreferenceContext;
const performance_1 = require("../performance");
const state_1 = require("../state");
const fallbacks_1 = require("./fallbacks");
const prompts_1 = require("./prompts");
function obj(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function nextLocalPreferenceStep(state) {
    const s = obj(state);
    if (!s || !s.stack)
        return null;
    if (!(0, state_1.hasResolvedOpenCodeState)(s.openCode))
        return 'open-code';
    if (!(0, state_1.hasValidPerformanceState)(s.performance))
        return 'performance';
    const performance = obj(s.performance);
    const level = performance && typeof performance.level === 'string' ? performance.level : '';
    const expectedTeamMode = (0, performance_1.teamModeForLevel)(level);
    const team = obj(s.team);
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
function hasMissingLocalPreferences(state) {
    return nextLocalPreferenceStep(state) !== null;
}
function localPreferencePromptAndRequest(state, source, block) {
    const step = nextLocalPreferenceStep(state);
    if (!step)
        return null;
    const fallbackText = (() => {
        switch (step) {
            case 'open-code':
                return ['Next unresolved Traffic One local preference: OpenCode delegation opt-in.', '', (0, fallbacks_1.openCodeChatFallback)(block)].join('\n');
            case 'performance':
                return ['Next unresolved Traffic One local preference: Agent mode.', '', (0, fallbacks_1.performanceChatFallback)(block)].join('\n');
            case 'team-confirmation':
                return (0, fallbacks_1.teamConfirmationPromptContext)(state, source === 'gate' ? 'gate' : 'user-prompt', block);
            case 'code-graph':
                return ['Next unresolved Traffic One local preference: Code graph provider.', '', (0, fallbacks_1.codeGraphChatFallback)(block)].join('\n');
        }
    })();
    return {
        step,
        fallbackText,
        promptRequest: (0, prompts_1.onboardingPromptRequestForStep)(step, { level: (0, prompts_1.performanceLevelOf)(state), fallbackText }),
    };
}
function localPreferenceContext(state, stack, source, block) {
    const prompt = localPreferencePromptAndRequest(state, source, block);
    if (!prompt)
        return null;
    const intro = [
        `[ACTIVE STACK: ${stack}]`,
        '',
        'Traffic One local preferences are required for this user before implementation in this project.',
        'Read-only orientation is allowed, but feature writes, installs, and subagent work must wait until this preference is saved locally.',
        '',
        prompt.fallbackText,
    ].join('\n');
    return { context: intro, promptRequest: prompt.promptRequest };
}
