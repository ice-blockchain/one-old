// src/modules/agent-model/index.ts
import type { Handler } from '../../core/types';
import { agentModelGate } from './handler';

export const handlers: Handler[] = [
  {
    id: 'agent-model.spawn',
    event: 'PreToolUse',
    tools: ['spawn-agent'],
    subcommands: ['check-agent-model'],
    priority: 40,
    run: (ctx) => agentModelGate(ctx),
  },
];
