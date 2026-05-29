// src/runners/one-mcp-report/collectFileExtensions.ts
// Per-extension line counts across the (skip-filtered) tree, top 50. Ported 1:1
// from one-mcp-report/collectFileExtensions.cjs.

import { countLines, extensionFor, readText, walkFiles } from './lib';

const NUL = String.fromCharCode(0);

export function collectFileExtensions(cwd: string): Record<string, number> {
  const totals: Record<string, number> = {};
  walkFiles(cwd, (absPath, relPath) => {
    const ext = extensionFor(relPath);
    if (!ext) return;
    const text = readText(absPath);
    if (text === null || text.includes(NUL)) return; // skip binary files (NUL byte)
    totals[ext] = (totals[ext] || 0) + countLines(text);
  });
  return Object.fromEntries(
    Object.entries(totals).sort((left, right) => right[1] - left[1]).slice(0, 50),
  );
}
