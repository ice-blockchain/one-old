'use strict';

// scripts/hook-runtime/packing.cjs
// Emits SessionStart context. The bundle DOES NOT inline rule content — it
// emits bullet-list pointers to the materialized copies under
// `.traffic-one/rules/...`. The model reads rules on demand via the Read
// tool. This applies to both parent and subagent SessionStart paths; only
// the framing/header text differs.
//
// Why not inline? `materializeProjectAssets()` already copies every active
// rule to the project's `.traffic-one/` folder. Inlining the same content
// into SessionStart additionalContext was a ~117KB duplicate that bloated
// every spawn (parent + each subagent). Cache reads, sure, but still
// massive cumulative cost.
//
// Security baseline (`@rules/common/security.md` in CLAUDE.md) stays
// inlined via CLAUDE.md @-import — that's a separate path and keeps the
// security checklist always-on for every API call.

const fs = require('fs');
const path = require('path');
const { templatePath } = require('./stacks.cjs');

// Parent SessionStart: rule pointer list with mandatory + optional sections.
// `budget` is accepted but unused (pointers are tiny — no need to truncate).
// `dropped` always returns [] for the same reason.
function packBundle(root, mandatory, optional, _budget) {
  const lines = [
    '## Active rules (read on demand)',
    '',
    'Materialized at `.traffic-one/rules/...` and `.traffic-one/core.md`.',
    'Read specific rules via the Read tool when their guidance applies.',
    '',
    '### Mandatory',
  ];
  const included = [];
  for (const rel of mandatory) {
    if (!fs.existsSync(path.join(root, templatePath(rel)))) continue;
    lines.push(`- .traffic-one/${rel}`);
    included.push(rel);
  }
  if (Array.isArray(optional) && optional.length > 0) {
    lines.push('');
    lines.push('### Optional (load when touching matching files)');
    for (const rel of optional) {
      if (!fs.existsSync(path.join(root, templatePath(rel)))) continue;
      lines.push(`- .traffic-one/${rel}`);
      included.push(rel);
    }
  }
  return { body: lines.join('\n') + '\n', included, dropped: [] };
}

// For subagent SessionStart. Same pointer-only output as packBundle but with
// a subagent-specific header. Kept as a separate function so the subagent
// path can evolve independently (e.g. role-scoped rule sets).
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
    if (!fs.existsSync(path.join(root, templatePath(rel)))) continue;
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
function packFixCycleHeader(_cwd, role, runId, spawnIndex) {
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
