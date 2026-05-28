// src/modules/graphify/index.ts
import type { Handler } from '../../core/types';
import { preGraphifyHint } from './handler';
import { postBuildCodeGraphHint } from './post-build';

export { postBuildCodeGraphHint, __setCodeGraphBootstraps, __resetCodeGraphBootstraps } from './post-build';

export const handlers: Handler[] = [
  {
    id: 'graphify.hint',
    event: 'PreToolUse',
    tools: ['search'],
    subcommands: ['pre-graphify-hint'],
    priority: 50, // context-only, runs after the gates
    run: (ctx) => preGraphifyHint(ctx),
  },
  {
    id: 'graphify.post-build',
    event: 'PostToolUse',
    tools: ['shell'],
    subcommands: ['post-build-graphify'],
    priority: 50, // after page-speed (40); context-only
    run: (ctx) => postBuildCodeGraphHint(ctx),
  },
];
