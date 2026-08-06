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

// `copied` is a FILE count (one entry per module.json + one per skill/*.md),
// deliberately kept for callers that want the raw file list. `moduleIds` is
// the actual module-id set — the thing "how many modules did we build"
// questions (compiled-smoke's assertion, the PASS-line wording) must use
// instead, since a module shipping N skill files was previously
// double/triple-counted as N modules by mistake.
export interface CopyResult { readonly copied: string[]; readonly moduleIds: ReadonlySet<string>; }

export interface ModuleSkillDoc {
  readonly moduleId: string;
  // relative to the modules dir, e.g. "onboarding-gate/skill/SKILL.md"
  readonly relPath: string;
  readonly absPath: string;
}

// Every module's skill/*.md gate-prose file (the T1BLOCK deny wording), keyed
// off the same on-disk convention copyModuleDescriptors copies from. The
// single source of truth for "what counts as gate prose" so tooling that
// needs to mirror it elsewhere (golden-update.ts, golden-snapshot.test.ts)
// can never silently diverge from what actually ships.
export function listModuleSkillDocs(srcModulesDir: string): ModuleSkillDoc[] {
  const docs: ModuleSkillDoc[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcModulesDir, { withFileTypes: true });
  } catch {
    return docs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(srcModulesDir, entry.name, 'skill');
    let skillEntries: fs.Dirent[];
    try {
      skillEntries = fs.readdirSync(skillDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const skillEntry of skillEntries) {
      if (!skillEntry.isFile() || !skillEntry.name.endsWith('.md')) continue;
      docs.push({
        moduleId: entry.name,
        relPath: path.join(entry.name, 'skill', skillEntry.name),
        absPath: path.join(skillDir, skillEntry.name),
      });
    }
  }
  docs.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return docs;
}

// Every module dir directly under `modulesDir` that ships a module.json
// descriptor — the same "is this a real module" predicate discoverDescriptors
// (src/core/registry.ts) uses. Works against either src/modules or a built
// modules/ tree, so it is the shared yardstick for "does the built tree
// contain the same module set as source" (compiled-smoke.ts).
export function listModuleIdsWithDescriptor(modulesDir: string): ReadonlySet<string> {
  const ids = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(modulesDir, { withFileTypes: true });
  } catch {
    return ids;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(modulesDir, entry.name, 'module.json'))) ids.add(entry.name);
  }
  return ids;
}

// Copy every module's module.json + skill/*.md from the source modules dir into
// the compiled modules dir, creating <out>/<id>/ as needed. Returns the relative
// paths copied (sorted, deterministic) and the distinct module-id set.
export function copyModuleDescriptors(srcModulesDir: string, outModulesDir: string): CopyResult {
  const copied: string[] = [];
  const moduleIds = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(srcModulesDir, { withFileTypes: true });
  } catch {
    return { copied, moduleIds };
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
      moduleIds.add(entry.name);
    }
  }

  // skill/*.md prose, so skillBlock can resolve it from the compiled tree.
  for (const doc of listModuleSkillDocs(srcModulesDir)) {
    const destSkillDir = path.join(outModulesDir, doc.moduleId, 'skill');
    fs.mkdirSync(destSkillDir, { recursive: true });
    fs.copyFileSync(doc.absPath, path.join(destSkillDir, path.basename(doc.relPath)));
    copied.push(doc.relPath);
  }

  copied.sort();
  return { copied, moduleIds };
}
