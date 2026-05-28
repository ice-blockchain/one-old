// src/modules/architecture-guard/index.ts
import type { Handler } from '../../core/types';
import { architectureWriteGate } from './architecture-write';
import { libraryAllowlistGate } from './handler';

export const handlers: Handler[] = [
  {
    id: 'architecture-guard.write',
    event: 'PreToolUse',
    tools: ['shell', 'file-write', 'file-edit'],
    subcommands: ['check-architecture-write'],
    priority: 20,
    run: (ctx) => architectureWriteGate(ctx),
  },
  {
    id: 'architecture-guard.library',
    event: 'PreToolUse',
    tools: ['shell'],
    subcommands: ['check-library-allowlist'],
    priority: 30,
    run: (ctx) => libraryAllowlistGate(ctx),
  },
];
