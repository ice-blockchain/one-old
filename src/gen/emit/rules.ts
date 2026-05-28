// src/gen/emit/rules.ts
// Re-gathers the flat rules-templates/ tree (materialization reads it; the
// cursor-rules emitter derives .mdc slugs from its nested paths) from the
// content modules that declare `rules` subdirs in module.json. The rule docs
// now live in src/modules/<id>/rules/** (the source); gen re-emits
// rules-templates/<exact-nested-path> byte-identical.
//
// The emitter UNIONS every content module's rules/ subtree, so the grouping of
// rules across modules does not affect the output — a single `rules` module can
// later be re-split into cohesive feature modules with zero diff. Runs before
// emitCursorRules so the cursor .mdc mirror reads the freshly-emitted tree.

import * as fs from 'fs';
import * as path from 'path';

import { discoverDescriptors } from '../../core/registry';
import type { GenRun } from '../lib/run';

export interface RuleDoc { relPath: string; content: string; }

function collectFiles(dir: string, base: string, out: { rel: string; abs: string }[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(abs, base, out);
    else if (entry.isFile()) out.push({ rel: path.relative(base, abs), abs });
  }
}

export function generatedRuleTemplates(repoRoot: string): RuleDoc[] {
  const modulesDir = path.join(repoRoot, 'src', 'modules');
  const docs: RuleDoc[] = [];
  for (const { descriptor, dir } of discoverDescriptors(modulesDir)) {
    if (!descriptor.rules || descriptor.rules.length === 0) continue;
    for (const sub of descriptor.rules) {
      const base = path.join(dir, sub);
      const files: { rel: string; abs: string }[] = [];
      collectFiles(base, base, files);
      for (const f of files) {
        docs.push({ relPath: path.join('rules-templates', f.rel), content: fs.readFileSync(f.abs, 'utf8') });
      }
    }
  }
  docs.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return docs;
}

export function emitRules(run: GenRun): void {
  for (const doc of generatedRuleTemplates(run.root)) {
    run.file(doc.relPath, doc.content);
  }
}
