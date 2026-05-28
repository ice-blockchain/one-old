// src/runners/token-report/emptyStats.ts
// Ported 1:1 from token-report/emptyStats.cjs.

import type { Stats } from './lib';

export function emptyStats(): Stats {
  return {
    messages: 0,
    toolUses: 0,
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    firstAt: null,
    lastAt: null,
    byTool: {},
    byModel: {},
    largestMessage: null,
    modelContextWindow: null,
  };
}
