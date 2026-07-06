// src/modules/agent-model/index.ts
import type { Handler } from '../../core/types';
import { agentModelGate } from './handler';
import { modelGateAfterShell, modelGateShell } from './model-gate';
import { opencodeSubagentBind } from './opencode-subagent-bind';
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
    // Cursor pre-spawn model-gate command: on beforeShellExecution of `model-gate.cjs`, pop a
    // user APPROVE/REJECT prompt (permission:"ask") when a picked model isn't offered. No-op
    // otherwise (lets the command run). Priority 41 = after the spawn gate's slot; shell-only.
    id: 'agent-model.model-gate',
    event: 'PreToolUse',
    tools: ['shell'],
    subcommands: ['check-model-gate'],
    priority: 41,
    run: (ctx) => modelGateShell(ctx),
  },
  {
    // Persist the spawned agent id (role → agents.json) so the reuse gate can
    // route the role's NEXT task to the same agent via the host continuation tool.
    id: 'agent-model.record-spawn',
    event: 'PostToolUse',
    tools: ['spawn-agent'],
    subcommands: ['post-agent-spawned'],
    priority: 60,
    run: (ctx) => recordSpawnedAgent(ctx),
  },
  {
    // Cursor afterShellExecution: if model-gate.cjs STOPs with exit 2, surface the same
    // fallback/enable choice as a user-visible message instead of leaving it in shell stdout.
    id: 'agent-model.model-gate-after-shell',
    event: 'PostToolUse',
    tools: ['shell'],
    subcommands: ['after-shell-execution'],
    priority: 41,
    run: (ctx) => modelGateAfterShell(ctx),
  },
  {
    // Codex SubagentStart: bind the pending role claim to the new subagent thread id.
    id: 'agent-model.subagent-start',
    event: 'SubagentStart',
    subcommands: ['subagent-start'],
    priority: 40,
    run: (ctx) => subagentStartBind(ctx),
  },
  {
    // OpenCode-only: no SubagentStart hook exists, so bind the role claim from the
    // subagent's first prompt ([t1-role:] marker) on user-prompt-submit. Inert on
    // other hosts and outside subagents mode (guards in the handler).
    id: 'agent-model.opencode-subagent-bind',
    event: 'UserPromptSubmit',
    subcommands: ['user-prompt-submit'],
    priority: 30,
    run: (ctx) => opencodeSubagentBind(ctx),
  },
];
