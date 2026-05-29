"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlers = void 0;
const handler_1 = require("./handler");
exports.handlers = [
    {
        id: 'onboarding-gate',
        event: 'PreToolUse',
        tools: ['shell', 'file-write', 'file-edit', 'file-read', 'spawn-agent'],
        subcommands: ['check-onboarding-gate'],
        priority: 10,
        run: (ctx) => (0, handler_1.onboardingGate)(ctx),
    },
];
