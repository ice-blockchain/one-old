// src/runners/token-report/parseOriginalTokenCount.ts
// Ported 1:1 from token-report/parseOriginalTokenCount.cjs.

export function parseOriginalTokenCount(output: unknown): number {
  if (typeof output !== 'string') return 0;
  const match = /Original token count:\s*([0-9][0-9,]*)/.exec(output);
  if (!match) return 0;
  return Number((match[1] as string).replace(/,/g, '')) || 0;
}
