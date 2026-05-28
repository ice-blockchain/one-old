"use strict";
// src/modules/session/index.ts
// The session module's runtime handlers: the SessionStart auth gate + rule
// bundle / onboarding directive, the priority-0 auth PreToolUse gate (denies
// tool use until auth is resolved), and the UserPromptSubmit auth /
// onboarding-reminder / convergence handler.
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlers = void 0;
const auth_gate_1 = require("./auth-gate");
const session_start_1 = require("./session-start");
const prompt_submit_1 = require("./prompt-submit");
exports.handlers = [
    {
        id: 'session.session-start',
        event: 'SessionStart',
        subcommands: ['session-start'],
        priority: 0,
        run: (ctx) => (0, session_start_1.runSessionStart)(ctx),
    },
    {
        // The priority-0 auth gate participates in every PreToolUse gate subcommand,
        // so the pipeline runs it first (matching the legacy per-gate auth check)
        // and short-circuits on an auth deny before the specific gate runs.
        id: 'session.auth',
        event: 'PreToolUse',
        tools: ['shell', 'file-write', 'file-edit', 'file-read', 'spawn-agent', 'search'],
        subcommands: ['check-onboarding-gate', 'check-agent-model', 'check-plan-write', 'check-library-allowlist'],
        priority: 0,
        run: (ctx) => (0, auth_gate_1.authPreToolGate)(ctx),
    },
    {
        id: 'session.prompt-submit',
        event: 'UserPromptSubmit',
        subcommands: ['user-prompt-submit'],
        priority: 0,
        run: (ctx) => (0, prompt_submit_1.runUserPromptSubmit)(ctx),
    },
];
