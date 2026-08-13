// src/runners/token-report/parseJsonlFile.ts
// Parse a Claude session JSONL file into accumulated stats (assistant records
// only). Ported 1:1 from token-report/parseJsonlFile.cjs.


import { addToStats, type Stats } from './lib';
import { emptyStats } from './emptyStats';
import { readRegularFileOrThrow } from '../../shared/bounded-read';

export function parseJsonlFile(filePath: string): Stats {
  const stats = emptyStats();
  let text: string;
  try {
    text = readRegularFileOrThrow(filePath);
  } catch {
    return stats;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || (parsed as { type?: unknown }).type !== 'assistant') continue;
    addToStats(stats, parsed);
  }
  return stats;
}
