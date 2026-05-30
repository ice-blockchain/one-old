"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlers = void 0;
const handler_1 = require("./handler");
const subagent_bind_1 = require("./subagent-bind");
exports.handlers = [
    {
        id: 'agent-model.spawn',
        event: 'PreToolUse',
        tools: ['spawn-agent'],
        subcommands: ['check-agent-model'],
        priority: 40,
        run: (ctx) => (0, handler_1.agentModelGate)(ctx),
    },
    {
        // Codex SubagentStart: bind the pending role claim to the new subagent thread id.
        id: 'agent-model.subagent-start',
        event: 'SubagentStart',
        subcommands: ['subagent-start'],
        priority: 40,
        run: (ctx) => (0, subagent_bind_1.subagentStartBind)(ctx),
    },
];
