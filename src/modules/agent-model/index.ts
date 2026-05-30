// src/modules/agent-model/index.ts
import type { Handler } from '../../core/types';
import { agentModelGate } from './handler';
import { subagentStartBind } from './subagent-bind';

export const handlers: Handler[] = [
  {
    id: 'agent-model.spawn',
    event: 'PreToolUse',
    tools: ['spawn-agent'],
    subcommands: ['check-agent-model'],
    priority: 40,
    run: (ctx) => agentModelGate(ctx),
  },
  {
    // Codex SubagentStart: bind the pending role claim to the new subagent thread id.
    id: 'agent-model.subagent-start',
    event: 'SubagentStart',
    subcommands: ['subagent-start'],
    priority: 40,
    run: (ctx) => subagentStartBind(ctx),
  },
];
