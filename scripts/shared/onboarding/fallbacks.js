"use strict";
// src/shared/onboarding/fallbacks.ts
// Assembles the new-project onboarding chat-fallback PROSE (shown when no host
// popup tool is available) by reading the onboarding-gate skill blocks and
// filling their {{VARS}}, then wires the step router → prose + popup request.
// The wording lives ONLY in the onboarding-gate SKILL.md (the single source);
// these helpers just compute the dynamic vars and select the block. A
// block-coverage test guarantees every referenced block exists, so the optional
// `fallback` arg is left empty here.
Object.defineProperty(exports, "__esModule", { value: true });
exports.OPEN_CODE_INSTALL = void 0;
exports.openCodeChatFallback = openCodeChatFallback;
exports.performanceChatFallback = performanceChatFallback;
exports.mobileChatFallback = mobileChatFallback;
exports.codeGraphChatFallback = codeGraphChatFallback;
exports.projectContextChatFallback = projectContextChatFallback;
exports.teamConfirmationChatFallback = teamConfirmationChatFallback;
exports.teamConfirmationPromptContext = teamConfirmationPromptContext;
exports.nextOnboardingStepPromptAndRequest = nextOnboardingStepPromptAndRequest;
exports.nextOnboardingStepPrompt = nextOnboardingStepPrompt;
exports.nextOnboardingPromptRequest = nextOnboardingPromptRequest;
exports.onboardingGateFallbackReason = onboardingGateFallbackReason;
exports.teamConfirmationGateFallbackReason = teamConfirmationGateFallbackReason;
exports.repairedMaterializationDenyReason = repairedMaterializationDenyReason;
const obj_1 = require("../obj");
const project_context_1 = require("./project-context");
const prompts_1 = require("./prompts");
const team_lines_1 = require("./team-lines");
// OpenCode install approval wording (no user-run shell command).
exports.OPEN_CODE_INSTALL = 'Traffic One hook-owned install/upgrade of the OpenCode CLI';
function openCodeChatFallback(block) {
    return block('open-code', { INSTALL: exports.OPEN_CODE_INSTALL });
}
function performanceChatFallback(block) {
    return block('performance', {});
}
function mobileChatFallback(block) {
    return block('mobile', {});
}
function codeGraphChatFallback(block) {
    return block('code-graph', {});
}
function projectContextChatFallback(state, block) {
    const originalPrompt = (0, project_context_1.projectContextOriginalPrompt)(state);
    const promptIntro = originalPrompt ? `Original request I should tailor this to: "${originalPrompt}"\n\n` : '';
    const answerKeys = project_context_1.PROJECT_CONTEXT_ANSWER_KEYS.join(', ');
    const domainQuestions = (0, project_context_1.projectContextDomainQuestionLines)(originalPrompt).map((line) => `- ${line}`).join('\n');
    return block('project-context', { PROMPT_INTRO: promptIntro, ANSWER_KEYS: answerKeys, DOMAIN_QUESTIONS: domainQuestions });
}
function teamConfirmationChatFallback(level, overrides, block) {
    const teamLines = (0, team_lines_1.renderTeamLines)(level, overrides).join('\n');
    return block('team-confirmation-chat', { LEVEL_UPPER: String(level).toUpperCase(), TEAM_LINES: teamLines });
}
function teamConfirmationPromptContext(state, source, block) {
    const s = (0, obj_1.obj)(state);
    const perf = s && (0, obj_1.obj)(s.performance);
    const level = perf && typeof perf.level === 'string' ? perf.level : '';
    const team = s && (0, obj_1.obj)(s.team);
    const overrides = team && (0, obj_1.obj)(team.overrides) ? team.overrides : null;
    const teamChat = teamConfirmationChatFallback(level, overrides, block);
    const sourceNote = source === 'user-prompt'
        ? block('team-confirmation-source-user-prompt', {})
        : block('team-confirmation-source-gate', {});
    return block('team-confirmation-context', { LEVEL: level, SOURCE_NOTE: sourceNote, TEAM_CHAT: teamChat });
}
// Build the {fallbackText, promptRequest} for the next unresolved onboarding
// step. Mirrors nextOnboardingStepPromptAndRequest (_helpers.cjs).
function nextOnboardingStepPromptAndRequest(state, source, block) {
    const step = (0, prompts_1.nextOnboardingStep)(state);
    const level = (0, prompts_1.performanceLevelOf)(state);
    const stepFallback = (s) => {
        switch (s) {
            case 'open-code': return ['Next unresolved Traffic One onboarding step: OpenCode delegation opt-in.', '', openCodeChatFallback(block)].join('\n');
            case 'performance': return ['Next unresolved Traffic One onboarding step: Agent mode.', '', performanceChatFallback(block)].join('\n');
            case 'team-confirmation':
            case 'team': return teamConfirmationPromptContext(state, source, block);
            case 'project-context': return projectContextChatFallback(state, block);
            case 'mobile': return mobileChatFallback(block);
            case 'code-graph': return codeGraphChatFallback(block);
            case 'state': return [
                'Traffic One onboarding state is still incomplete or noncanonical.',
                'Complete `.traffic-one/.one.json` plus local Traffic One preferences before continuing.',
            ].join('\n');
        }
    };
    if (!step) {
        return {
            fallbackText: [
                'Traffic One onboarding state is still incomplete or noncanonical.',
                'Complete `.traffic-one/.one.json` plus local Traffic One preferences before continuing.',
            ].join('\n'),
            promptRequest: null,
        };
    }
    return {
        fallbackText: stepFallback(step),
        promptRequest: (0, prompts_1.onboardingPromptRequestForStep)(step, { level, fallbackText: stepFallback(step) }),
    };
}
function nextOnboardingStepPrompt(state, source, block) {
    return nextOnboardingStepPromptAndRequest(state, source, block).fallbackText;
}
function nextOnboardingPromptRequest(state, source, block) {
    return nextOnboardingStepPromptAndRequest(state, source, block).promptRequest;
}
// ── Gate deny reasons (compose the prose blocks above) ───────────────────────
function onboardingGateFallbackReason(state, block) {
    const nextStepPrompt = nextOnboardingStepPrompt(state, 'gate', block);
    return block('gate-fallback-reason', { NEXT_STEP_PROMPT: nextStepPrompt });
}
function teamConfirmationGateFallbackReason(state, block) {
    const context = teamConfirmationPromptContext(state, 'gate', block);
    return block('team-confirmation-gate-reason', { CONTEXT: context });
}
function repairedMaterializationDenyReason(block) {
    return block('repaired-materialization', {});
}
