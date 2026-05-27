'use strict';

const fs = require('fs');
const { emptyStats } = require('./emptyStats.cjs');
const { addToStats } = require('./_helpers.cjs');

function parseJsonlFile(filePath) {
  const stats = emptyStats();
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return stats;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || parsed.type !== 'assistant') continue;
    addToStats(stats, parsed);
  }
  return stats;
}

module.exports = { parseJsonlFile };
