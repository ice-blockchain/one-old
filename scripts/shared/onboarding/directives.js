"use strict";
// src/shared/onboarding/directives.ts
// Onboarding-flow directive PROSE assemblers (host-popup instruction, the
// agent-mode prompt, the Codex current-thread onboarding fallback, and the
// condensed UserPromptSubmit reminder) injected by the session SessionStart +
// UserPromptSubmit handlers. The wording lives in the onboarding-gate SKILL.md;
// these assemblers only fill the composition vars. Ported from
// onboarding-prompts.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentModePrompt = agentModePrompt;
exports.hostPopupInstruction = hostPopupInstruction;
exports.codexDefaultModeFallbackDirective = codexDefaultModeFallbackDirective;
exports.onboardingReminderShort = onboardingReminderShort;
exports.openCodePopupBlock = openCodePopupBlock;
const fallbacks_1 = require("./fallbacks");
function agentModePrompt(block) {
    return block('agent-mode-prompt', {});
}
function hostPopupInstruction(block) {
    return block('host-popup-instruction', {});
}
function codexDefaultModeFallbackDirective(block) {
    const agentMode = agentModePrompt(block);
    const openCode = (0, fallbacks_1.openCodeChatFallback)(block);
    return block('codex-fallback', { OPEN_CODE_PROMPT: openCode, AGENT_MODE_PROMPT: agentMode });
}
// Condensed reminder re-injected on UserPromptSubmit while a new project hasn't
// persisted a valid stack (SessionStart's full directive can scroll out). The
// full prose + required-state schema live in the skill; this fills the embedded
// Codex fallback.
function onboardingReminderShort(block) {
    const codexFallback = codexDefaultModeFallbackDirective(block);
    return block('onboarding-reminder', { CODEX_FALLBACK: codexFallback });
}
// SessionStart "popup 0": the OpenCode delegation preflight (asked first, before
// the Performance popup). Composes the host-popup instruction.
function openCodePopupBlock(block) {
    const hostPopup = hostPopupInstruction(block);
    return block('opencode-popup', { INSTALL: fallbacks_1.OPEN_CODE_INSTALL, HOST_POPUP: hostPopup });
}
