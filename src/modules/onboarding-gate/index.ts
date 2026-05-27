// src/modules/onboarding-gate/index.ts
import type { Handler } from '../../core/types';
import { onboardingGate } from './handler';

export const handlers: Handler[] = [
  {
    id: 'onboarding-gate',
    event: 'PreToolUse',
    tools: ['shell', 'file-write', 'file-edit', 'file-read', 'spawn-agent'],
    priority: 10,
    run: (ctx) => onboardingGate(ctx),
  },
];
