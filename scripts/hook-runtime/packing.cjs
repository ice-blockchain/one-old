'use strict';

// scripts/hook-runtime/packing.cjs
// Concatenates rule files into the SessionStart bundle. Mandatory files
// always load (even past the budget — drop after = drop important rules).
// Optional files fill remaining headroom in declaration order; the rest get
// listed in `dropped` for the path-scoped attach mechanism to pick up later.

const fs   = require('fs');
const path = require('path');

function packBundle(root, mandatory, optional, budget) {
  const bodyParts = [];
  const included  = [];
  const dropped   = [];
  let total = 0;

  for (const rel of mandatory) {
    const filePath = path.join(root, rel);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    const header  = `# ── ${rel} ──\n`;
    bodyParts.push(header + content);
    included.push(rel);
    total += header.length + content.length + 2;
  }

  for (const rel of optional) {
    const filePath = path.join(root, rel);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    const header  = `# ── ${rel} ──\n`;
    const additionSize = header.length + content.length + 2;
    if (total + additionSize > budget) {
      dropped.push(rel);
      continue;
    }
    bodyParts.push(header + content);
    included.push(rel);
    total += additionSize;
  }

  return {
    body: bodyParts.join('\n\n'),
    included,
    dropped,
  };
}

module.exports = { packBundle };
