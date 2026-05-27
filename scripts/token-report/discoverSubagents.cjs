'use strict';

const fs = require('fs');
const path = require('path');

function discoverSubagents(sessionDir) {
  const subagentsDir = path.join(sessionDir, 'subagents');
  if (!fs.existsSync(subagentsDir)) return [];
  let entries;
  try {
    entries = fs.readdirSync(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const id = e.name.replace(/\.jsonl$/, '');
    const metaPath = path.join(subagentsDir, `${id}.meta.json`);
    let meta = {};
    if (fs.existsSync(metaPath)) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { meta = {}; }
    }
    out.push({
      id,
      jsonl: path.join(subagentsDir, e.name),
      agentType: typeof meta.agentType === 'string' ? meta.agentType : 'unknown',
      description: typeof meta.description === 'string' ? meta.description : '',
    });
  }
  return out;
}

module.exports = { discoverSubagents };
