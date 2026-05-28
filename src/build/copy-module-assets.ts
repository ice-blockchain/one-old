// src/build/copy-module-assets.ts
// Cutover build step: after `tsc` emits the compiled handlers into the runtime
// tree (scripts/modules/<id>/index.js), the module DESCRIPTORS + any non-.ts
// payload the runtime reads (module.json — read by the registry's readdir
// discovery) must be copied alongside, because tsc only emits compiled .ts and
// never copies data files. Verified necessary by the compiled-runtime smoke:
// without module.json in the compiled tree, discovery finds zero modules.
//
// Note: skill/rules/agent prose is read by skillBlock from the SHIPPED SOURCE
// (pluginRoot/src/modules/<id>/skill/SKILL.md), not from the compiled tree — so
// it is NOT copied here. This step copies only what the compiled runtime itself
// resolves relative to its own dir: the module.json descriptors.

import * as fs from 'fs';
import * as path from 'path';

export interface CopyResult { copied: string[]; }

// Copy every module's module.json from the source modules dir into the compiled
// modules dir, creating <out>/<id>/ as needed. Returns the relative paths copied
// (sorted, deterministic).
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
    const descriptor = path.join(srcModulesDir, entry.name, 'module.json');
    if (!fs.existsSync(descriptor)) continue;
    const destDir = path.join(outModulesDir, entry.name);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(descriptor, path.join(destDir, 'module.json'));
    copied.push(path.join(entry.name, 'module.json'));
  }
  copied.sort();
  return { copied };
}
