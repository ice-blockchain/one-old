// src/modules/architecture-guard/index.ts
import type { Handler } from '../../core/types';
import { architectureWriteGate } from './architecture-write';
import { deployGate } from './deploy-gate';
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
    // Deploy gate shares the check-library-allowlist subcommand; priority 25 runs
    // it after auth (0) and before the install-allowlist (30), reproducing the
    // legacy "deploy gate runs first" ordering inside runCheckLibraryAllowlist.
    id: 'architecture-guard.deploy',
    event: 'PreToolUse',
    tools: ['shell'],
    subcommands: ['check-library-allowlist'],
    priority: 25,
    run: (ctx) => deployGate(ctx),
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
