"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlers = void 0;
const plan_write_1 = require("./plan-write");
const deploy_gate_1 = require("./deploy-gate");
const handler_1 = require("./handler");
exports.handlers = [
    {
        id: 'plan-guard.write',
        event: 'PreToolUse',
        tools: ['shell', 'file-write', 'file-edit'],
        subcommands: ['check-plan-write'],
        priority: 20,
        run: (ctx) => (0, plan_write_1.planWriteGate)(ctx),
    },
    {
        // Deploy gate shares the check-library-allowlist subcommand; priority 25 runs
        // it after auth (0) and before the install-allowlist (30), reproducing the
        // legacy "deploy gate runs first" ordering inside runCheckLibraryAllowlist.
        id: 'plan-guard.deploy',
        event: 'PreToolUse',
        tools: ['shell'],
        subcommands: ['check-library-allowlist'],
        priority: 25,
        run: (ctx) => (0, deploy_gate_1.deployGate)(ctx),
    },
    {
        id: 'plan-guard.library',
        event: 'PreToolUse',
        tools: ['shell'],
        subcommands: ['check-library-allowlist'],
        priority: 30,
        run: (ctx) => (0, handler_1.libraryAllowlistGate)(ctx),
    },
];
