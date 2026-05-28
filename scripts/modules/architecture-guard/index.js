"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlers = void 0;
const architecture_write_1 = require("./architecture-write");
const deploy_gate_1 = require("./deploy-gate");
const handler_1 = require("./handler");
exports.handlers = [
    {
        id: 'architecture-guard.write',
        event: 'PreToolUse',
        tools: ['shell', 'file-write', 'file-edit'],
        subcommands: ['check-architecture-write'],
        priority: 20,
        run: (ctx) => (0, architecture_write_1.architectureWriteGate)(ctx),
    },
    {
        // Deploy gate shares the check-library-allowlist subcommand; priority 25 runs
        // it after auth (0) and before the install-allowlist (30), reproducing the
        // legacy "deploy gate runs first" ordering inside runCheckLibraryAllowlist.
        id: 'architecture-guard.deploy',
        event: 'PreToolUse',
        tools: ['shell'],
        subcommands: ['check-library-allowlist'],
        priority: 25,
        run: (ctx) => (0, deploy_gate_1.deployGate)(ctx),
    },
    {
        id: 'architecture-guard.library',
        event: 'PreToolUse',
        tools: ['shell'],
        subcommands: ['check-library-allowlist'],
        priority: 30,
        run: (ctx) => (0, handler_1.libraryAllowlistGate)(ctx),
    },
];
