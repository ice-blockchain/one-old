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

// For subagent SessionStart. The parent's session already inlined full rule
// content via packBundle() and materialize.cjs copied every active rule to
// `.traffic-one/rules/active/<relPath>`. Subagents just need an index pointing
// to the materialized copies; they Read specific rules on demand instead of
// paying the 117KB rule-bundle cost up front.
function packRuleIndex(root, rules) {
  const lines = [
    '## Active rule index (read on demand)',
    '',
    'Full rule content is materialized at `.traffic-one/rules/active/<path>`.',
    'Use the Read tool to load a specific rule when its guidance is needed.',
    '',
  ];
  const included = [];
  for (const rel of rules) {
    const filePath = path.join(root, rel);
    if (!fs.existsSync(filePath)) continue;
    lines.push(`- .traffic-one/rules/active/${rel}`);
    included.push(rel);
  }
  return { body: lines.join('\n') + '\n', included, dropped: [] };
}

module.exports = { packBundle, packRuleIndex };
