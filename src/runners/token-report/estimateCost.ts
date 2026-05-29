// src/runners/token-report/estimateCost.ts
// Per-model USD estimate from accumulated stats. Ported 1:1 from
// token-report/estimateCost.cjs.

import type { Stats } from './lib';
import { priceFor } from './priceFor';

export function estimateCost(stats: Stats): number {
  let total = 0;
  for (const [model, m] of Object.entries(stats.byModel || {})) {
    const p = priceFor(model);
    total += (m.inputTokens / 1_000_000) * p.input;
    total += (m.cacheCreationInputTokens / 1_000_000) * p.cacheWrite;
    total += (m.cacheReadInputTokens / 1_000_000) * p.cacheRead;
    total += (m.outputTokens / 1_000_000) * p.output;
  }
  return total;
}
