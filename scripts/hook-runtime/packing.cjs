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
// `.traffic-one/<relPath>`. Subagents just need an index pointing
// to the materialized copies; they Read specific rules on demand instead of
// paying the 117KB rule-bundle cost up front.
function packRuleIndex(root, rules) {
  const lines = [
    '## Active rule index (read on demand)',
    '',
    'Full rule content is materialized at `.traffic-one/<path>`.',
    'Use the Read tool to load a specific rule when its guidance is needed.',
    '',
  ];
  const included = [];
  for (const rel of rules) {
    const filePath = path.join(root, rel);
    if (!fs.existsSync(filePath)) continue;
    lines.push(`- .traffic-one/${rel}`);
    included.push(rel);
  }
  return { body: lines.join('\n') + '\n', included, dropped: [] };
}

// For fix-cycle re-spawns (spawnIndex[role] > 1). The same role already ran
// in this orchestrator run, so it has produced a digest and the orchestrator
// has written a fix-cycle context file with EXACT findings to apply. Emit
// only the pointers — the model recalls its prior work and applies the
// targeted changes without re-exploring the codebase.
//
// Target size: ~300-500 bytes (vs ~2KB for the role-scoped index, ~117KB for
// the full bundle).
function packFixCycleHeader(cwd, role, runId, spawnIndex) {
  const fixCycleFile = `.traffic-one/fix-cycles/${runId}/${role}-fix-${spawnIndex - 1}.md`;
  const digestFile   = `.traffic-one/digests/${runId}/${roleDigestName(role)}.md`;
  const lines = [
    `═══ traffic-one — ${role} FIX-CYCLE #${spawnIndex - 1} (run ${runId}) ═══`,
    '',
    `[fix-cycle] You previously ran in this orchestrator run; apply only the targeted fixes below.`,
    '',
    `1. Read the fix-cycle context (exact reviewer findings with file:line):`,
    `   ${fixCycleFile}`,
    '',
    `2. Recall your prior work from your previous digest:`,
    `   ${digestFile}`,
    '',
    `3. Apply ONLY the listed fixes. Do not re-explore the codebase, do not re-read source files except those the fix-cycle context names. Active rules are already loaded; do not re-import them.`,
    '',
    `4. Re-emit your digest at ${digestFile} when done.`,
    '',
  ];
  return { body: lines.join('\n') + '\n', included: [], dropped: [] };
}

// Map a senior-* role to its digest filename (the orchestrator writes
// architect.md / frontend.md / backend.md / reviewer.md / tester.md / shipper.md
// per `rules/common/agent-handoff-digests.md`).
function roleDigestName(role) {
  if (!role || typeof role !== 'string') return 'agent';
  const m = /^senior-(.+)$/.exec(role);
  return m ? m[1] : role;
}

module.exports = { packBundle, packRuleIndex, packFixCycleHeader, roleDigestName };
