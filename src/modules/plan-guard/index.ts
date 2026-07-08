// src/modules/plan-guard/index.ts
import type { Handler } from '../../core/types';
import { planWriteGate } from './plan-write';
import { deployGate } from './deploy-gate';
import { libraryAllowlistGate } from './handler';
import { scaffoldGate } from './scaffold-gate';

export const handlers: Handler[] = [
  {
    id: 'plan-guard.write',
    event: 'PreToolUse',
    tools: ['shell', 'file-write', 'file-edit'],
    subcommands: ['check-plan-write'],
    priority: 20,
    run: (ctx) => planWriteGate(ctx),
  },
  {
    // Windsurf/Devin-only scaffolder gate: block off-stack / pre-plan app
    // scaffolders (create-next-app …) so the build stays on the React/Vite stack
    // and cannot start before the architect writes plan.md. Priority 22 runs it
    // after plan-write (20) and before the deploy (25) / library (30) gates.
    id: 'plan-guard.scaffold',
    event: 'PreToolUse',
    tools: ['shell'],
    subcommands: ['check-library-allowlist'],
    priority: 22,
    run: (ctx) => scaffoldGate(ctx),
  },
  {
    // Deploy gate shares the check-library-allowlist subcommand; priority 25 runs
    // it after auth (0) and before the install-allowlist (30), reproducing the
    // legacy "deploy gate runs first" ordering inside runCheckLibraryAllowlist.
    id: 'plan-guard.deploy',
    event: 'PreToolUse',
    tools: ['shell'],
    subcommands: ['check-library-allowlist'],
    priority: 25,
    run: (ctx) => deployGate(ctx),
  },
  {
    id: 'plan-guard.library',
    event: 'PreToolUse',
    tools: ['shell'],
    subcommands: ['check-library-allowlist'],
    priority: 30,
    run: (ctx) => libraryAllowlistGate(ctx),
  },
];
