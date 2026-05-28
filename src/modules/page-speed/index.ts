// src/modules/page-speed/index.ts
import type { Handler } from '../../core/types';
import { postBuildPageSpeed } from './handler';

export const handlers: Handler[] = [
  {
    id: 'page-speed.build',
    event: 'PostToolUse',
    tools: ['shell'],
    priority: 40,
    run: (ctx) => postBuildPageSpeed(ctx),
  },
];
