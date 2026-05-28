"use strict";
// src/modules/session/prompt-submit.ts
// UserPromptSubmit handler: drives the auth gate / auth-choice flow on every
// prompt, records/clears the team-mode-change approval, surfaces onboarding
// reminders + the one-time OpenCode opt-in, and converges project-local
// materialization. Ported 1:1 from runUserPromptSubmit (prompt-submit.cjs).
// Auth-choice parsing reads the extracted prompt text (cleaner than the legacy
// raw-string pass; the host adapter already extracts the prompt).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runUserPromptSubmit = runUserPromptSubmit;
const result_1 = require("../../core/result");
const authoring_root_1 = require("../../shared/authoring-root");
const detection_1 = require("../../shared/detection");
const materialize_1 = require("../../shared/materialize");
const directives_1 = require("../../shared/onboarding/directives");
const fallbacks_1 = require("../../shared/onboarding/fallbacks");
const predicates_1 = require("../../shared/onboarding/predicates");
const prompts_1 = require("../../shared/onboarding/prompts");
const team_mode_approval_1 = require("../../shared/onboarding/team-mode-approval");
const config_1 = require("../../shared/config");
const paths_1 = require("../../shared/paths");
const prompt_request_1 = require("../../shared/prompt-request");
const prompt_input_1 = require("../../shared/prompt-input");
const skill_block_1 = require("../../shared/skill-block");
const state_1 = require("../../shared/state");
const auth_gate_1 = require("./auth-gate");
const auth_choice_1 = require("./auth-choice");
const fs = __importStar(require("fs"));
const skillBlock = (0, skill_block_1.makeSkillBlock)(paths_1.pluginRoot);
const block = (name, vars, fallback) => skillBlock('onboarding-gate', name, vars, fallback);
const TEAM_MODE_SWITCH_AUTHORIZED_FALLBACK = 'The latest user prompt explicitly requested switching away from subagents to Low/main-agent mode. The next local Traffic One preference write may change `performance.level` to "low" and `team.mode` to "main-agent"; this authorization is single-use and expires in 10 minutes.';
function runUserPromptSubmit(ctx) {
    const cwd = ctx.cwd;
    if ((0, authoring_root_1.isPluginAuthoringRoot)(cwd))
        return (0, result_1.noop)();
    const raw = ctx.input.raw;
    const promptText = ctx.input.prompt || (0, prompt_input_1.promptTextFromSubmit)(raw);
    // ── Auth gate / auth-choice flow ──
    const authGate = (0, auth_gate_1.authGateForHook)();
    if (!authGate.authenticated) {
        const choiceStatus = (0, auth_choice_1.authChoiceStatus)(cwd);
        const authChoice = (0, auth_gate_1.parseUnauthenticatedAuthChoice)(promptText, { allowNumeric: choiceStatus === 'pending-choice' });
        if (authChoice)
            return (0, auth_gate_1.authChoiceHookResult)(authChoice, cwd);
        if ((0, auth_choice_1.authChoiceAllowsContinue)(cwd))
            return (0, result_1.noop)();
        const promptApiKey = (0, auth_gate_1.parseTrafficOneApiKey)(promptText);
        if (promptApiKey)
            return (0, auth_gate_1.authLoginFromPromptHookResult)(promptApiKey);
        if ((0, auth_gate_1.isSessionExpiryReauth)(authGate))
            return (0, auth_gate_1.sessionExpiredReauthPromptResult)();
        if (choiceStatus === 'authenticate')
            return (0, auth_gate_1.authApiKeyPromptHookResult)();
        const writeResult = (0, auth_choice_1.tryWriteAuthChoice)('pending-choice', cwd);
        return (0, auth_gate_1.authRequiredHookResult)('UserPromptSubmit', { authChoiceWrite: writeResult });
    }
    if (!fs.existsSync((0, state_1.statePath)(cwd)) && !fs.existsSync((0, state_1.legacyStatePath)(cwd))) {
        return (0, result_1.context)('', { systemMessage: 'traffic-one active' });
    }
    const state = (0, state_1.readEffectiveState)(cwd);
    if (!state || typeof state !== 'object')
        return (0, result_1.context)('', { systemMessage: 'traffic-one active' });
    const stack = state.stack || state.mode || 'unknown';
    const normalizedState = JSON.parse(JSON.stringify(state));
    (0, state_1.normalizeState)(normalizedState, normalizedState.mode || (0, detection_1.detectMode)(cwd));
    // ── Team-mode-change approval recorded from the prompt ──
    const teamModeApproval = (0, team_mode_approval_1.updateTeamModeChangeApprovalFromPrompt)(cwd, normalizedState, promptText);
    if (teamModeApproval.recorded) {
        const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${block('team-mode-switch-authorized', {}, TEAM_MODE_SWITCH_AUTHORIZED_FALLBACK)}`;
        return (0, result_1.context)(additionalContext, { systemMessage: 'traffic-one [team mode switch authorized]' });
    }
    // ── Team Confirmation still pending ──
    if ((0, predicates_1.needsTeamConfirmation)(normalizedState)) {
        const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${(0, fallbacks_1.teamConfirmationPromptContext)(normalizedState, 'user-prompt', block)}`;
        const promptRequest = (0, prompts_1.onboardingPromptRequestForStep)('team-confirmation', {
            level: (0, prompts_1.performanceLevelOf)(normalizedState), fallbackText: additionalContext,
        });
        return (0, result_1.context)(additionalContext, { systemMessage: 'traffic-one [team confirmation required]', promptRequest });
    }
    const validStack = Boolean(state.stack && (0, config_1.isKnownStack)(state.stack));
    const isIncomplete = !validStack
        || state.onboardingComplete !== true
        || (state.mode === 'new-project' && (0, predicates_1.isNewProjectOnboardingIncomplete)(normalizedState));
    // ── Re-inject the short onboarding reminder while a new project is incomplete ──
    if (isIncomplete && state.mode === 'new-project') {
        const reminder = (0, directives_1.onboardingReminderShort)(block);
        const classification = promptText ? (0, detection_1.classifyPromptForStack)(promptText) : null;
        const promptRequest = (0, fallbacks_1.nextOnboardingPromptRequest)(normalizedState, 'user-prompt', block);
        const classificationContext = classification
            ? block('first-prompt-classification', {
                STACK: classification.stack,
                FRONTEND: classification.frontend,
                BACKEND: classification.backend,
                MOBILE: classification.mobile.enabled ? classification.mobile.framework : 'none',
                CODEX_FALLBACK: (0, directives_1.codexDefaultModeFallbackDirective)(block),
                HOST_POPUP: (0, directives_1.hostPopupInstruction)(block),
                NEXT_STEP: (0, fallbacks_1.nextOnboardingStepPrompt)(normalizedState, 'user-prompt', block),
            }, firstPromptClassificationFallback(classification))
            : (0, fallbacks_1.nextOnboardingStepPrompt)(normalizedState, 'user-prompt', block);
        const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${classificationContext ? `${classificationContext}\n\n` : ''}${reminder}`;
        return (0, result_1.context)(additionalContext, { systemMessage: 'traffic-one [onboarding incomplete]', ...(promptRequest ? { promptRequest } : {}) });
    }
    // ── Generic convergence ──
    const materialized = (0, materialize_1.materializeProjectIfNeeded)(cwd, { trigger: 'generic user-prompt convergence' });
    if (materialized) {
        return (0, result_1.context)(materialized.context, { systemMessage: materialized.systemMessage });
    }
    // ── One-time OpenCode opt-in (existing/auto-detected codebases) ──
    if (!(0, state_1.hasResolvedOpenCodeState)(normalizedState.openCode)) {
        const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${(0, directives_1.openCodeOptInDirective)(block)}`;
        return (0, result_1.context)(additionalContext, { systemMessage: `traffic-one [${stack}] opencode opt-in`, promptRequest: (0, prompt_request_1.openCodePromptRequest)(additionalContext) });
    }
    return (0, result_1.context)(`[ACTIVE STACK: ${stack}]`, { systemMessage: `traffic-one [${stack}]` });
}
function firstPromptClassificationFallback(c) {
    return [
        '[FIRST PROMPT STACK CLASSIFICATION]',
        `stack=${c.stack}`,
        `frontend=${c.frontend}`,
        `backend=${c.backend}`,
        `mobile=${c.mobile.enabled ? c.mobile.framework : 'none'}`,
        'mode=new-project: complete Traffic One onboarding in the current thread before implementation. If no popup/input tool is available, ask fallback chat questions and stop for typed answers.',
        (0, directives_1.codexDefaultModeFallbackDirective)(block),
        `Onboarding choices must be prompt popups. ${(0, directives_1.hostPopupInstruction)(block)} Do not print numbered option lists in chat when a popup tool is available; never choose a default or continue implementation while an answer is pending.`,
        'Required order: Agent mode (High/Balanced/Low), Team role/model confirmation for High/Balanced, success message, rich MVP-context questionnaire, Mobile App, then Code Graph provider.',
        'Ask only the next unresolved onboarding step below:',
    ].join('\n');
}
