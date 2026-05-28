"use strict";
// src/shared/onboarding/directives.ts
// Onboarding-flow directive PROSE assemblers (host-popup instruction, the
// agent-mode prompt, and the Codex current-thread onboarding fallback) injected
// by the session SessionStart + UserPromptSubmit handlers. Prose lives in the
// onboarding-gate skill; these assemblers fill the composition vars. Ported 1:1
// from onboarding-prompts.cjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.codexDefaultModeFallbackAgentModePrompt = void 0;
exports.agentModePrompt = agentModePrompt;
exports.hostPopupInstruction = hostPopupInstruction;
exports.codexDefaultModeFallbackDirective = codexDefaultModeFallbackDirective;
exports.onboardingReminderShort = onboardingReminderShort;
exports.openCodeOptInDirective = openCodeOptInDirective;
exports.openCodePopupBlock = openCodePopupBlock;
const fallbacks_1 = require("./fallbacks");
const AGENT_MODE_PROMPT_VERBATIM = [
    'Traffic One needs to know how you want to run agents for this build.',
    'How do you want to run agents for this build?',
    '',
    '1. High (Recommended) — Subagent team with max-power models',
    '2. Balanced — Subagent team with efficient mid-tier models',
    '3. Low — Main agent only with role roadmap checklist',
    '',
    'Reply with the option number or label.',
].join('\n');
function agentModePrompt(block) {
    return block('agent-mode-prompt', {}, AGENT_MODE_PROMPT_VERBATIM);
}
// Alias: the legacy mobile fallback reused the agent-mode prompt verbatim.
exports.codexDefaultModeFallbackAgentModePrompt = agentModePrompt;
function hostPopupInstruction(block) {
    return block('host-popup-instruction', {}, [
        'Ask via the host popup tool when available:',
        'Codex `request_user_input`, Claude Code `AskUserQuestion`, or the Cursor task-UI prompt.',
        'Only if no popup tool is exposed, ask in plain chat with the numbered options,',
        'tell the user to reply with the option number or label, and stop.',
        'Do NOT emit the plain-text fallback when a popup tool is working.',
    ].join(' '));
}
function codexDefaultModeFallbackDirective(block) {
    const agentMode = agentModePrompt(block);
    const verbatim = [
        'CURRENT-THREAD ONBOARDING FALLBACK (visible response, blocking):',
        'If `request_user_input` cannot be called, do not use tools and do not keep detecting/scaffolding.',
        'Before onboarding is resolved, mention only the project-detection/onboarding flow. Do not read, invoke, announce, or activate create-feature, create-page, frontend-design, tdd-workflow, or other implementation skills yet.',
        'Your next visible assistant message must be the plain-chat fallback prompt below, then you must stop for the user answer:',
        '',
        agentMode,
        '',
        "After the user answers, ask Team Confirmation for High/Balanced, then show \"Traffic One was successfully set up. Let's collect the project details next.\", collect a rich dynamic MVP project context, ask Mobile App, then ask Code Graph. Ask only the next unresolved question and stop each time.",
    ].join('\n');
    return block('codex-fallback', { AGENT_MODE_PROMPT: agentMode }, verbatim);
}
// Condensed reminder re-injected on UserPromptSubmit while a new project hasn't
// persisted a valid stack (SessionStart's full directive can scroll out). The
// full prose + required-state schema live in the skill; this fills the embedded
// Codex fallback. Concise verbatim fallback: this is injected context, not deny
// enforcement, so a degraded prose-less fallback never breaks any gate.
function onboardingReminderShort(block) {
    const codexFallback = codexDefaultModeFallbackDirective(block);
    const fallback = [
        '═══ traffic-one — onboarding still incomplete ═══',
        '',
        'mode=new-project: complete Traffic One onboarding in the current thread before implementation. Do not scaffold, install, edit source, or choose defaults while answers are pending.',
        '',
        codexFallback,
        '',
        'Write the full required schema to `.traffic-one/.one.json` (RELATIVE path) before feature work; the PostToolUse hook splits local fields out and auto-loads the rule bundle. See the onboarding-gate skill for the complete schema + field reference.',
    ].join('\n');
    return block('onboarding-reminder', { CODEX_FALLBACK: codexFallback }, fallback);
}
// One-time OpenCode delegation opt-in directive (surfaced for existing/auto-
// detected codebases via UserPromptSubmit). Composes the host-popup instruction
// + the OpenCode chat fallback.
function openCodeOptInDirective(block) {
    const hostPopup = hostPopupInstruction(block);
    const openCodeChat = (0, fallbacks_1.openCodeChatFallback)(block);
    const fallback = [
        'OPENCODE DELEGATION OPT-IN (one-time, non-blocking):',
        '  Traffic One can delegate bounded implementation tasks to OpenCode, a free',
        '  local AI coding agent, so it plans/supervises/verifies while OpenCode executes',
        '  — cutting paid token usage. Every delegated change stays in a reviewable',
        `  digest. To use it the user installs OpenCode (\`${fallbacks_1.OPEN_CODE_INSTALL}\`) and`,
        '  signs in; the delegation wiring ships in a later update.',
        `  ${hostPopup}`,
        '  Then record the answer in local Traffic One preferences:',
        '    "openCode": { "enabled": <true|false>, "source": "prompted", "decidedAt": "<ISO-8601 UTC>" }',
        '  "Enable" -> enabled: true; "Not now" -> enabled: false. Do NOT re-ask once it is',
        "  recorded, and do NOT let this block the user's current request.",
        '',
        openCodeChat,
    ].join('\n');
    return block('opencode-optin', { INSTALL: fallbacks_1.OPEN_CODE_INSTALL, HOST_POPUP: hostPopup, OPENCODE_CHAT: openCodeChat }, fallback);
}
// SessionStart "popup 0": the OpenCode delegation preflight (asked first, before
// the Performance popup). Full prose in the skill; concise verbatim fallback.
function openCodePopupBlock(block) {
    const hostPopup = hostPopupInstruction(block);
    const fallback = [
        'OPENCODE DELEGATION PREFLIGHT (asked first, before the Performance popup; blocking):',
        '  Offer the OpenCode token-economy opt-in via the host popup before the Performance popup.',
        `  ${hostPopup}`,
        `  Traffic One can later delegate bounded tasks to OpenCode (a free local agent; install \`${fallbacks_1.OPEN_CODE_INSTALL}\`); it plans/supervises/verifies while OpenCode executes. This only records the preference.`,
        '    header: "OpenCode"; question: "Save tokens by delegating coding tasks to OpenCode (a free local agent)?"',
        '    options: "Enable OpenCode delegation" / "Not now".',
        '  Persist "openCode": { "enabled": <true|false>, "source": "prompted", "decidedAt": "<ISO-8601 UTC>" }. Do NOT auto-answer; either choice resolves it, then continue to the Performance popup.',
    ].join('\n');
    return block('opencode-popup', { INSTALL: fallbacks_1.OPEN_CODE_INSTALL, HOST_POPUP: hostPopup }, fallback);
}
