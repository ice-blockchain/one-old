// src/modules/architecture-guard/index.ts
import type { Handler } from '../../core/types';
import { architectureWriteGate } from './architecture-write';
import { libraryAllowlistGate } from './handler';

export const handlers: Handler[] = [
  {
    id: 'architecture-guard.write',
    event: 'PreToolUse',
    tools: ['shell', 'file-write', 'file-edit'],
    priority: 20,
    run: (ctx) => architectureWriteGate(ctx),
  },
  {
    id: 'architecture-guard.library',
    event: 'PreToolUse',
    tools: ['shell'],
    priority: 30,
    run: (ctx) => libraryAllowlistGate(ctx),
  },
];
