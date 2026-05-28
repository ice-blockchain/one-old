// src/runners/token-report/cacheHitRate.ts
// Ported 1:1 from token-report/cacheHitRate.cjs.

import type { Stats } from './lib';

export function cacheHitRate(stats: Stats): number {
  const cacheReads = stats.cacheReadInputTokens;
  const totalInput = stats.inputTokens + stats.cacheCreationInputTokens + stats.cacheReadInputTokens;
  if (totalInput === 0) return 0;
  return (cacheReads / totalInput) * 100;
}
