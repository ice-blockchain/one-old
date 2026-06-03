"use strict";
// src/modules/session/prompt-submit.ts
// UserPromptSubmit handler: drives the auth gate / auth-choice flow on every
// prompt, records/clears the team-mode-change approval, and — once a project is a
// Traffic One project but onboarding is incomplete — points the user at the local
// setup wizard (the wizard owns the questions now; this only surfaces its URL and
// converges materialization). A deterministic coding-intent heuristic suppresses
// premature activation on a brand-new project when the prompt is clearly not a
// coding/implementation request. Auth flow ported 1:1 from runUserPromptSubmit.
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
const ensure_1 = require("../../shared/onboarding-server/ensure");
const flow_1 = require("../../shared/onboarding-server/flow");
const registry_1 = require("../../shared/onboarding-server/registry");
const project_context_1 = require("../../shared/onboarding/project-context");
const team_mode_approval_1 = require("../../shared/onboarding/team-mode-approval");
const paths_1 = require("../../shared/paths");
const prompt_input_1 = require("../../shared/prompt-input");
const skill_block_1 = require("../../shared/skill-block");
const state_1 = require("../../shared/state");
const auth_gate_1 = require("./auth-gate");
const auth_choice_1 = require("./auth-choice");
const session_start_1 = require("./session-start");
const fs = __importStar(require("fs"));
const skillBlock = (0, skill_block_1.makeSkillBlock)(paths_1.pluginRoot);
const block = (name, vars = {}) => skillBlock('onboarding-gate', name, vars);
const sessionBlock = (name, vars = {}) => skillBlock('session', name, vars);
// Persist the user's first request into the new-project state so the wizard can
// tailor its questions AND derive the right stack (without it, an empty prompt
// derives to `minimal`). Idempotent: only on a new project, and never overwrites
// an existing prompt — the FIRST coding prompt is the project description.
function seedOriginalPrompt(cwd, prompt) {
    const text = (prompt || '').trim();
    if (!text)
        return;
    const state = (0, state_1.readState)(cwd);
    if (state.mode !== 'new-project')
        return;
    if ((0, project_context_1.projectContextOriginalPrompt)(state))
        return;
    try {
        (0, state_1.writeState)(cwd, { ...state, originalPrompt: text });
    }
    catch {
        // best-effort; the wizard still runs, just without prompt-tailored defaults
    }
}
// Prepend a note (e.g. the login-success line) to a context result, leaving
// non-context results untouched.
function prependContext(prefix, result) {
    if (!prefix || result.kind !== 'context')
        return result;
    return (0, result_1.context)(`${prefix}${result.context}`, {
        ...(result.systemMessage ? { systemMessage: result.systemMessage } : {}),
        ...(result.promptRequest ? { promptRequest: result.promptRequest } : {}),
    });
}
function runUserPromptSubmit(ctx) {
    const cwd = ctx.cwd;
    if ((0, authoring_root_1.isPluginAuthoringRoot)(cwd))
        return (0, result_1.noop)();
    const raw = ctx.input.raw;
    const promptText = ctx.input.prompt || (0, prompt_input_1.promptTextFromSubmit)(raw);
    // ── Auth gate / auth-choice flow ──
    const authGate = (0, auth_gate_1.authGateForHook)();
    let loginSucceeded = false;
    if (!authGate.authenticated) {
        const choiceStatus = (0, auth_choice_1.authChoiceStatus)(cwd);
        const authChoice = (0, auth_gate_1.parseUnauthenticatedAuthChoice)(promptText, { allowNumeric: choiceStatus === 'pending-choice' });
        if (authChoice)
            return (0, auth_gate_1.authChoiceHookResult)(authChoice, cwd);
        if ((0, auth_choice_1.authChoiceAllowsContinue)(cwd))
            return (0, result_1.noop)();
        const promptApiKey = (0, auth_gate_1.parseTrafficOneApiKey)(promptText);
        if (promptApiKey) {
            const login = (0, auth_gate_1.runInternalAuthLogin)(promptApiKey);
            if (!login.ok) {
                return (0, result_1.context)(sessionBlock('login-failed', { REASON: login.reason || 'unknown failure' }), { systemMessage: 'traffic-one authentication failed' });
            }
            // Authenticated this turn → fall through and run the authed SessionStart
            // body now, so setup starts in the SAME response.
            loginSucceeded = true;
        }
        else if ((0, auth_gate_1.isSessionExpiryReauth)(authGate)) {
            return (0, auth_gate_1.sessionExpiredReauthPromptResult)();
        }
        else if (choiceStatus === 'authenticate') {
            return (0, auth_gate_1.authApiKeyPromptHookResult)();
        }
        else {
            const writeResult = (0, auth_choice_1.tryWriteAuthChoice)('pending-choice', cwd);
            return (0, auth_gate_1.authRequiredHookResult)('UserPromptSubmit', { authChoiceWrite: writeResult });
        }
    }
    const uninitialized = !fs.existsSync((0, state_1.statePath)(cwd)) && !fs.existsSync((0, state_1.legacyStatePath)(cwd));
    // ── Coding-intent gate ──
    // On a brand-new project with no active wizard, a clearly non-coding prompt
    // must not activate Traffic One. The instant state exists, a wizard server is
    // running, the user just authenticated, or the prompt looks like build/
    // implementation work, the normal path runs — an active project is never
    // mis-skipped (and the PreToolUse gate still fires if a tool is attempted).
    if (uninitialized && !loginSucceeded && !(0, registry_1.serverRecordExists)(cwd) && !(0, detection_1.isLikelyCodingPrompt)(promptText)) {
        return (0, result_1.noop)();
    }
    // A fresh login, or any authenticated interaction on a not-yet-initialized
    // project (auth completed mid-session, so SessionStart returned the gate and
    // never ran the authed body), runs that authed SessionStart body now — this is
    // where new-project setup / existing-codebase auto-detect actually starts.
    if (loginSucceeded || uninitialized) {
        const bootstrapped = (0, session_start_1.runSessionStartAuthed)(ctx);
        seedOriginalPrompt(cwd, promptText);
        return loginSucceeded ? prependContext(`${sessionBlock('login-success')}\n\n`, bootstrapped) : bootstrapped;
    }
    const state = (0, state_1.readEffectiveState)(cwd);
    if (!state || typeof state !== 'object')
        return (0, session_start_1.runSessionStartAuthed)(ctx);
    const stack = state.stack || state.mode || 'unknown';
    const normalizedState = JSON.parse(JSON.stringify(state));
    (0, state_1.normalizeState)(normalizedState, normalizedState.mode || (0, detection_1.detectMode)(cwd));
    // ── Team-mode-change approval recorded from the prompt ──
    const teamModeApproval = (0, team_mode_approval_1.updateTeamModeChangeApprovalFromPrompt)(cwd, normalizedState, promptText);
    if (teamModeApproval.recorded) {
        const additionalContext = `[ACTIVE STACK: ${stack}]\n\n${block('team-mode-switch-authorized')}`;
        return (0, result_1.context)(additionalContext, { systemMessage: 'traffic-one [team mode switch authorized]' });
    }
    // ── Onboarding incomplete → surface the local setup wizard URL ──
    // The wizard owns the questions + state writes; the agent only points the user
    // at it and waits. Covers new-project onboarding AND an already-configured
    // project missing this user's local preferences.
    if (!(0, flow_1.computeOnboarding)(cwd).done) {
        seedOriginalPrompt(cwd, promptText);
        const server = (0, ensure_1.ensureOnboardingServer)(cwd);
        return (0, result_1.context)(`[ACTIVE STACK: ${stack}]\n\n${block('server-deny-reason', { URL: server.url })}`, {
            systemMessage: 'traffic-one [setup required]',
        });
    }
    // ── Generic convergence ──
    const materialized = (0, materialize_1.materializeProjectIfNeeded)(cwd, { trigger: 'generic user-prompt convergence' });
    if (materialized) {
        return (0, result_1.context)(materialized.context, { systemMessage: materialized.systemMessage });
    }
    return (0, result_1.context)(`[ACTIVE STACK: ${stack}]`, { systemMessage: `traffic-one [${stack}]` });
}
