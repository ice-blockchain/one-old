// src/gen/emit/skills.ts
// Re-gathers BOTH skill trees gen emits: skills/ (the host-read bootstrap dir —
// all three host manifests point here; the session-start surgery fills it with
// the per-stack set) and skills-catalog/ (the pristine source pool the surgery +
// materializer copy from; no host manifest reads it directly). Each content
// module ships them as separate subtrees:
//   src/modules/<id>/skills/**          → skills/**
//   src/modules/<id>/skills-catalog/**  → skills-catalog/**
// gen re-emits both byte-identical. Unions across content modules, so the
// grouping (one skills module today) can be re-split into feature modules later
// with zero output diff.

import * as fs from 'fs';
import * as path from 'path';

import { discoverDescriptors } from '../../core/registry';
import { collectFiles } from '../lib/content-walk';
import type { GenRun } from '../lib/run';

const SKILL_TREES = ['skills', 'skills-catalog'] as const;

export interface SkillDoc { relPath: string; content: string; }

// Upstream-provenance frontmatter keys. The block is maintainer bookkeeping
// (kept in src); shipped, it rides into every materialized project and is
// re-read on every skill invocation by all three hosts — dead context bytes.
const PROVENANCE_KEYS = new Set(['source', 'source_path', 'source_commit', 'adapted_for', 'merged_source_paths']);

export function stripProvenanceMetadata(content: string): string {
  const lines = content.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return content;
  let fenceEnd = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '---') { fenceEnd = i; break; }
  }
  if (fenceEnd === -1) return content;
  for (let i = 1; i < fenceEnd; i += 1) {
    if (!/^metadata:\s*$/.test(lines[i] ?? '')) continue;
    let stop = i + 1;
    while (stop < fenceEnd) {
      const line = lines[stop] ?? '';
      if (/^\s+-\s/.test(line)) { stop += 1; continue; } // list item under a provenance key
      const key = /^\s+([A-Za-z_][\w-]*):/.exec(line);
      if (!key) break;
      if (!PROVENANCE_KEYS.has(key[1] ?? '')) return content; // carries real data — keep
      stop += 1;
    }
    if (stop === i + 1) return content; // empty mapping — leave as-is
    return [...lines.slice(0, i), ...lines.slice(stop)].join('\n');
  }
  return content;
}

export function generatedSkillDocs(repoRoot: string): SkillDoc[] {
  const modulesDir = path.join(repoRoot, 'src', 'modules');
  const docs: SkillDoc[] = [];
  for (const { dir } of discoverDescriptors(modulesDir)) {
    for (const tree of SKILL_TREES) {
      const base = path.join(dir, tree);
      if (!fs.existsSync(base)) continue;
      for (const f of collectFiles(base)) {
        const raw = fs.readFileSync(f.abs, 'utf8');
        const content = path.basename(f.rel) === 'SKILL.md' ? stripProvenanceMetadata(raw) : raw;
        docs.push({ relPath: path.join(tree, f.rel), content });
      }
    }
  }
  docs.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return docs;
}

export function emitSkills(run: GenRun): void {
  for (const doc of generatedSkillDocs(run.sourceRoot)) {
    run.file(doc.relPath, doc.content);
  }
}
