// src/build/copy-module-assets.ts
// Cutover build step: after `tsc` emits the compiled handlers into the runtime
// tree (scripts/modules/<id>/index.js), the module DESCRIPTORS + any non-.ts
// payload the runtime reads (module.json — read by the registry's readdir
// discovery) must be copied alongside, because tsc only emits compiled .ts and
// never copies data files. Verified necessary by the compiled-runtime smoke:
// without module.json in the compiled tree, discovery finds zero modules.
//
// This step copies the module.json descriptors AND each module's skill/*.md
// prose into the compiled tree. The descriptors are needed by the registry's
// readdir discovery (tsc emits only compiled .ts, never data files). The skill
// prose is read at runtime by skillBlock; shipping it to scripts/modules/<id>/
// skill/ means the wording resolves even when src/ is not shipped. skillBlock
// prefers src/ (authoring source) and falls back to this compiled copy.

import * as fs from 'fs';
import * as path from 'path';

export interface CopyResult { copied: string[]; }

// Copy every module's module.json + skill/*.md from the source modules dir into
// the compiled modules dir, creating <out>/<id>/ as needed. Returns the relative
// paths copied (sorted, deterministic).
export function copyModuleDescriptors(srcModulesDir: string, outModulesDir: string): CopyResult {
  const copied: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcModulesDir, { withFileTypes: true });
  } catch {
    return { copied };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const moduleDir = path.join(srcModulesDir, entry.name);
    const destDir = path.join(outModulesDir, entry.name);

    const descriptor = path.join(moduleDir, 'module.json');
    if (fs.existsSync(descriptor)) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(descriptor, path.join(destDir, 'module.json'));
      copied.push(path.join(entry.name, 'module.json'));
    }

    // skill/*.md prose, so skillBlock can resolve it from the compiled tree.
    let skillEntries: fs.Dirent[] = [];
    try {
      skillEntries = fs.readdirSync(path.join(moduleDir, 'skill'), { withFileTypes: true });
    } catch {
      skillEntries = [];
    }
    for (const skillEntry of skillEntries) {
      if (!skillEntry.isFile() || !skillEntry.name.endsWith('.md')) continue;
      const destSkillDir = path.join(destDir, 'skill');
      fs.mkdirSync(destSkillDir, { recursive: true });
      fs.copyFileSync(
        path.join(moduleDir, 'skill', skillEntry.name),
        path.join(destSkillDir, skillEntry.name),
      );
      copied.push(path.join(entry.name, 'skill', skillEntry.name));
    }
  }
  copied.sort();
  return { copied };
}
