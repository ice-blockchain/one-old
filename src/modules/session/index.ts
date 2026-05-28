// src/modules/session/index.ts
// The session module's runtime handlers: the SessionStart auth gate + rule
// bundle / onboarding directive, the priority-0 auth PreToolUse gate (denies
// tool use until auth is resolved), and the UserPromptSubmit auth /
// onboarding-reminder / convergence handler.

import type { Handler } from '../../core/types';
import { authPreToolGate } from './auth-gate';
import { runSessionStart } from './session-start';
import { runUserPromptSubmit } from './prompt-submit';

export const handlers: Handler[] = [
  {
    id: 'session.session-start',
    event: 'SessionStart',
    priority: 0,
    run: (ctx) => runSessionStart(ctx),
  },
  {
    id: 'session.auth',
    event: 'PreToolUse',
    tools: ['shell', 'file-write', 'file-edit', 'file-read', 'spawn-agent', 'search'],
    priority: 0,
    run: (ctx) => authPreToolGate(ctx),
  },
  {
    id: 'session.prompt-submit',
    event: 'UserPromptSubmit',
    priority: 0,
    run: (ctx) => runUserPromptSubmit(ctx),
  },
];
