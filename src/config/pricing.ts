// src/config/pricing.ts
// Per-model token pricing (USD per million tokens) for the token-report runner.
// THE knob to update when model prices change. The cost math lives in
// runners/token-report/** (priceFor.ts looks a model up here).

export interface Pricing { input: number; cacheWrite: number; cacheRead: number; output: number }

export const PRICING: Record<string, Pricing> = {
  'claude-opus-4-7': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  'claude-opus-4-6': { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  'claude-sonnet-4-6': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-sonnet-4-5': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-haiku-4-5': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  // Fallback when model is unrecognized — assume sonnet-class pricing.
  _default: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
};
