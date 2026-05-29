// src/shared/packing.ts
// SessionStart context bundles — pointer-only (rules are materialized to
// .traffic-one/ and read on demand). Ported 1:1 from scripts/hook-runtime/packing.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { templatePath } from './stacks/template-path';

export interface PackResult {
  body: string;
  included: string[];
}

export function packBundle(
  root: string,
  mandatory: readonly string[],
  optional?: readonly string[],
): PackResult {
  const lines = [
    '## Active rules (read on demand)',
    '',
    'Materialized at `.traffic-one/rules/...` and `.traffic-one/core.md`.',
    'Read specific rules via the Read tool when their guidance applies.',
    '',
    '### Mandatory',
  ];
  const included: string[] = [];
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
  return { body: `${lines.join('\n')}\n`, included };
}

export function packRuleIndex(root: string, rules: readonly string[]): PackResult {
  const lines = [
    '## Active rule index (read on demand)',
    '',
    'Full rule content is materialized at `.traffic-one/<path>`.',
    'Use the Read tool to load a specific rule when its guidance is needed.',
    '',
  ];
  const included: string[] = [];
  for (const rel of rules) {
    if (!fs.existsSync(path.join(root, templatePath(rel)))) continue;
    lines.push(`- .traffic-one/${rel}`);
    included.push(rel);
  }
  return { body: `${lines.join('\n')}\n`, included };
}

export function roleDigestName(role: unknown): string {
  if (!role || typeof role !== 'string') return 'agent';
  const match = /^senior-(.+)$/.exec(role);
  return match && match[1] ? match[1] : role;
}

export function packFixCycleHeader(_cwd: string, role: string, runId: string, spawnIndex: number): PackResult {
  const fixCycleFile = `.traffic-one/fix-cycles/${runId}/${role}-fix-${spawnIndex - 1}.md`;
  const digestFile = `.traffic-one/digests/${runId}/${roleDigestName(role)}.md`;
  const lines = [
    `═══ traffic-one — ${role} FIX-CYCLE #${spawnIndex - 1} (run ${runId}) ═══`,
    '',
    '[fix-cycle] You previously ran in this orchestrator run; apply only the targeted fixes below.',
    '',
    '1. Read the fix-cycle context (exact reviewer findings with file:line):',
    `   ${fixCycleFile}`,
    '',
    '2. Recall your prior work from your previous digest:',
    `   ${digestFile}`,
    '',
    '3. Apply ONLY the listed fixes. Do not re-explore the codebase, do not re-read source files except those the fix-cycle context names. Active rules are already loaded; do not re-import them.',
    '',
    `4. Re-emit your digest at ${digestFile} when done.`,
    '',
  ];
  return { body: `${lines.join('\n')}\n`, included: [] };
}
