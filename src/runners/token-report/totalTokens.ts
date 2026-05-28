// src/runners/token-report/totalTokens.ts
// Ported 1:1 from token-report/totalTokens.cjs.

import type { Stats } from './lib';

export function totalTokens(stats: Stats): number {
  return stats.inputTokens + stats.cacheCreationInputTokens + stats.cacheReadInputTokens + stats.outputTokens;
}
