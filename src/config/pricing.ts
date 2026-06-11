// src/config/pricing.ts
// Per-model token pricing (USD per million tokens) for the token-report runner.
// THE knob to update when model prices change. The cost math lives in
// runners/token-report/** (priceFor.ts looks a model up here).

export interface Pricing { input: number; cacheWrite: number; cacheRead: number; output: number }

// Rates per docs (platform.claude.com pricing, June 2026): Opus 4.6+ is $5/$25,
// Fable 5 is $10/$50; cache write = 1.25x input (5-min TTL), cache read = 0.1x.
// priceFor() does longest-prefix matching, so the family rows ('claude-opus-')
// price future point releases until an exact row is added.
export const PRICING: Record<string, Pricing> = {
  'claude-fable-5': { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  'claude-fable-': { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  'claude-opus-4-8': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'claude-opus-4-7': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'claude-opus-4-6': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'claude-opus-': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'claude-sonnet-4-6': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-sonnet-4-5': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-sonnet-': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-haiku-4-5': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  'claude-haiku-': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
  // Fallback when model is unrecognized — assume sonnet-class pricing.
  _default: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
};
