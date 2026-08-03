// src/modules/onboarding-gate/index.ts
import type { Handler } from '../../core/types';
import { onboardingGate } from './handler';
import { onboardingStopGate } from './stop';

export const handlers: Handler[] = [
  {
    id: 'onboarding-gate',
    event: 'PreToolUse',
    tools: ['shell', 'file-write', 'file-edit', 'file-read', 'spawn-agent'],
    subcommands: ['check-onboarding-gate'],
    priority: 10,
    run: (ctx) => onboardingGate(ctx),
  },
  {
    // Turn-end backstop: re-deliver the setup link when a turn would end with
    // onboarding pending and a live wizard engaged (see stop.ts). Not
    // tool-scoped — Stop carries no tool.
    id: 'onboarding-gate.stop',
    event: 'Stop',
    subcommands: ['onboarding-stop', 'cursor-stop'],
    priority: 10,
    run: (ctx) => onboardingStopGate(ctx),
  },
];
