// src/modules/agent-model/index.ts
import type { Handler } from '../../core/types';
import { agentModelGate } from './handler';
import { recordSpawnedAgent } from './record-agent';
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
    // Persist the spawned agent id (role → agents.json) so the reuse gate can
    // route the role's NEXT task to the same agent via SendMessage.
    id: 'agent-model.record-spawn',
    event: 'PostToolUse',
    tools: ['spawn-agent'],
    subcommands: ['post-agent-spawned'],
    priority: 60,
    run: (ctx) => recordSpawnedAgent(ctx),
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
