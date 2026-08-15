// src/shared/packing.ts
// SessionStart context bundles — pointer-only (rules are materialized to
// .traffic-one/ and read on demand). Ported 1:1 from scripts/hook-runtime/packing.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { templatePath } from './stacks/template-path';

interface PackResult {
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

const DIGEST_WRITE_ROLE_RE =
  /(?:^|\/)\.traffic-one\/digests\/[^/]+\/(?:senior-)?(architect|frontend|backend|reviewer|tester|shipper)\.md$/;

/**
 * Inverse of `roleDigestName` for a digest write path. Cursor Task children
 * omit parent/subagent/transcript on Write, so the file they are writing is
 * the one unique role signal when reviewer and tester are both pending.
 */
export function roleFromDigestWritePath(filePath: unknown): string | null {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  const match = DIGEST_WRITE_ROLE_RE.exec(filePath.replace(/\\/g, '/'));
  return match?.[1] ? `senior-${match[1]}` : null;
}

export function packFixCycleHeader(_cwd: string, role: string, runId: string, spawnIndex: number): PackResult {
  // Canonical fix-cycle filename carries the FULL role (senior-frontend-fix-1.md).
  // Orchestrators reading the older `<role>` placeholder prose wrote the
  // digest-style short name (frontend-fix-1.md) — observed live on 12co, where
  // an existing findings file was silently skipped and the header degraded to
  // the no-context branch. Probe both spellings; canonical wins when both exist.
  const canonicalFile = `.traffic-one/fix-cycles/${runId}/${role}-fix-${spawnIndex - 1}.md`;
  const legacyFile = `.traffic-one/fix-cycles/${runId}/${roleDigestName(role)}-fix-${spawnIndex - 1}.md`;
  const onDisk = (rel: string): boolean => (_cwd ? fs.existsSync(path.join(_cwd, rel)) : false);
  const hasCanonical = onDisk(canonicalFile);
  const hasLegacy = !hasCanonical && legacyFile !== canonicalFile && onDisk(legacyFile);
  const fixCycleFile = hasLegacy ? legacyFile : canonicalFile;
  const digestFile = `.traffic-one/digests/${runId}/${roleDigestName(role)}.md`;
  const hasFixCycleFile = hasCanonical || hasLegacy;
  // Runtime-consolidated write-time quality findings (batched instead of
  // per-write denies); when present, they are part of the same single-turn fix.
  const qualityFile = `.traffic-one/fix-cycles/${runId}/${role}-quality-findings.md`;
  const hasQualityFile = _cwd ? fs.existsSync(path.join(_cwd, qualityFile)) : false;
  const lines = [
    `═══ traffic-one — ${role} FIX-CYCLE #${spawnIndex - 1} (run ${runId}) ═══`,
    '',
    '[fix-cycle] You previously ran in this orchestrator run; apply only the targeted fixes below.',
    '',
    hasFixCycleFile
      ? '1. Read the fix-cycle context (exact reviewer findings with file:line):'
      : '1. No fix-cycle context file exists on disk for this replacement. Use ONLY the spawn prompt/new message for exact findings; do not fabricate or read a missing fix-cycle path:',
    `   ${fixCycleFile}`,
    ...(hasQualityFile
      ? [
        '   Also apply ALL accumulated quality findings (batched write-time findings, one list) in the same turn:',
        `   ${qualityFile}`,
      ]
      : []),
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
