// src/modules/session/index.ts
// The session module's runtime handlers: the SessionStart auth gate + rule
// bundle / onboarding directive, the priority-0 auth PreToolUse gate (blocks
// tool use until the wizard validates an API key), and the UserPromptSubmit auth /
// onboarding-reminder / convergence handler.

import type { Handler } from '../../core/types';
import { authoringWriteGuard } from './authoring-guard';
import { authPreToolGate } from './auth-gate';
import { runSessionStart } from './session-start';
import { runUserPromptSubmit } from './prompt-submit';
import { workspaceBoundaryGuard } from './workspace-boundary-guard';

export const handlers: Handler[] = [
  {
    id: 'session.session-start',
    event: 'SessionStart',
    subcommands: ['session-start'],
    priority: 0,
    run: (ctx) => runSessionStart(ctx),
  },
  {
    // Deny model-steered writes into the plugin's own repo (.traffic-one/** or
    // generated AGENTS.md/CLAUDE.md content). Path-scoped — inert everywhere
    // else, including Cursor's full-pipeline fan-out. Piggybacks the existing
    // PreToolUse gate pipelines, so no hook wiring changes.
    id: 'session.authoring-guard',
    event: 'PreToolUse',
    tools: ['file-write', 'file-edit', 'shell'],
    subcommands: ['check-onboarding-gate', 'check-plan-write'],
    priority: 5,
    run: (ctx) => authoringWriteGuard(ctx),
  },
  {
    // The priority-0 auth gate participates in every PreToolUse gate subcommand,
    // so the pipeline runs it first and short-circuits on an auth deny before the
    // specific gate runs. While unauthenticated it delegates to the onboarding
    // gate to open the wizard's api-key page.
    id: 'session.auth',
    event: 'PreToolUse',
    tools: ['shell', 'file-write', 'file-edit', 'file-read', 'spawn-agent', 'search'],
    subcommands: ['check-onboarding-gate', 'check-model-choice-gate', 'check-agent-model', 'check-plan-write', 'check-library-allowlist'],
    priority: 0,
    run: (ctx) => authPreToolGate(ctx),
  },
  {
    // Cursor supplies workspace_roots as the authoritative project boundary.
    // Keep model-facing path tools inside that boundary so a run in tests/6b
    // cannot read/search/write a sibling tests/5b workspace through stale paths.
    id: 'session.workspace-boundary',
    event: 'PreToolUse',
    tools: ['shell', 'file-write', 'file-edit', 'file-read', 'spawn-agent', 'search'],
    subcommands: ['check-onboarding-gate', 'check-model-choice-gate', 'check-agent-model', 'check-plan-write', 'check-library-allowlist'],
    priority: 1,
    run: (ctx) => workspaceBoundaryGuard(ctx),
  },
  {
    id: 'session.prompt-submit',
    event: 'UserPromptSubmit',
    subcommands: ['user-prompt-submit'],
    priority: 0,
    run: (ctx) => runUserPromptSubmit(ctx),
  },
];
