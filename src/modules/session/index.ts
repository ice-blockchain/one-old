// src/modules/session/index.ts
// The session module's runtime handlers: the priority-0 auth PreToolUse gate
// (denies tool use until auth is resolved) and the UserPromptSubmit auth /
// onboarding-reminder / convergence handler. The SessionStart handler is added next.

import type { Handler } from '../../core/types';
import { authPreToolGate } from './auth-gate';
import { runUserPromptSubmit } from './prompt-submit';

export const handlers: Handler[] = [
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
