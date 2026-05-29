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

export function generatedSkillDocs(repoRoot: string): SkillDoc[] {
  const modulesDir = path.join(repoRoot, 'src', 'modules');
  const docs: SkillDoc[] = [];
  for (const { dir } of discoverDescriptors(modulesDir)) {
    for (const tree of SKILL_TREES) {
      const base = path.join(dir, tree);
      if (!fs.existsSync(base)) continue;
      for (const f of collectFiles(base)) {
        docs.push({ relPath: path.join(tree, f.rel), content: fs.readFileSync(f.abs, 'utf8') });
      }
    }
  }
  docs.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return docs;
}

export function emitSkills(run: GenRun): void {
  for (const doc of generatedSkillDocs(run.root)) {
    run.file(doc.relPath, doc.content);
  }
}
