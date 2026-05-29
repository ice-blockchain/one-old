"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlers = void 0;
const handler_1 = require("./handler");
exports.handlers = [
    {
        id: 'agent-model.spawn',
        event: 'PreToolUse',
        tools: ['spawn-agent'],
        subcommands: ['check-agent-model'],
        priority: 40,
        run: (ctx) => (0, handler_1.agentModelGate)(ctx),
    },
];
