// src/runners/token-report/priceFor.ts
// Longest-prefix model → pricing lookup. Ported 1:1 from token-report/priceFor.cjs.

import { PRICING, type Pricing } from '../../config/pricing';

export function priceFor(model: unknown): Pricing {
  if (!model || typeof model !== 'string') return PRICING._default as Pricing;
  const matches = Object.keys(PRICING).filter((k) => k !== '_default' && model.startsWith(k));
  if (matches.length === 0) return PRICING._default as Pricing;
  matches.sort((a, b) => b.length - a.length);
  return PRICING[matches[0] as string] as Pricing;
}
