// src/core/registry.ts
// Module discovery: readdir the modules dir, read each module.json descriptor,
// and (for runtime modules) load the handlers the module exports. This is what
// makes "add a folder → it's wired in" work, with NO central HANDLERS map to
// edit. Unbundled output is what lets us readdir at runtime (a bundle couldn't).

import * as fs from 'fs';
import * as path from 'path';

import { readJson } from '../shared/fsjson';
import type { Handler, ModuleDescriptor } from './types';

export interface LoadedModule {
  readonly descriptor: ModuleDescriptor;
  readonly dir: string;
  readonly handlers: readonly Handler[];
}

export function defaultModulesDir(): string {
  // registry.{ts→js} lives in core/; the modules sit next to core under BOTH
  // src/ (tsx dev/test) and the compiled scripts/ tree. Resolving via __dirname
  // (not pluginRoot/src) keeps discovery layout-agnostic — critical so the
  // compiled runtime loads scripts/modules/*/index.js and never reaches back
  // into src/ (which holds un-runnable .ts). A test may pass an override dir.
  return path.join(__dirname, '..', 'modules');
}

export function discoverDescriptors(
  modulesDir: string,
): { descriptor: ModuleDescriptor; dir: string }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(modulesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: { descriptor: ModuleDescriptor; dir: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(modulesDir, entry.name);
    const descriptor = readJson<ModuleDescriptor | null>(path.join(dir, 'module.json'), null);
    if (descriptor && typeof descriptor.id === 'string') {
      found.push({ descriptor, dir });
    }
  }
  found.sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id));
  return found;
}

function loadHandlers(dir: string, descriptor: ModuleDescriptor, strict: boolean): Handler[] {
  if (descriptor.kind !== 'runtime') return [];
  const entry = descriptor.entry ?? 'index';
  try {
    const mod = require(path.join(dir, entry)) as { handlers?: unknown };
    if (Array.isArray(mod.handlers) && (!strict || mod.handlers.length > 0)) return mod.handlers as Handler[];
    if (strict) throw new Error(`traffic-one runtime module ${descriptor.id} exported no handlers array`);
    return [];
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

export function loadModules(modulesDir: string, options: { strict?: boolean } = {}): LoadedModule[] {
  const strict = options.strict === true;
  const discovered = discoverDescriptors(modulesDir);
  if (strict && discovered.length === 0) {
    throw new Error(`traffic-one runtime module directory is missing or empty: ${modulesDir}`);
  }
  if (strict) {
    const validDirs = new Set(discovered.map(({ dir }) => path.resolve(dir)));
    const invalid = fs.readdirSync(modulesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !validDirs.has(path.resolve(modulesDir, entry.name)))
      .map((entry) => entry.name);
    if (invalid.length > 0) {
      throw new Error(`traffic-one runtime module descriptor is missing or invalid: ${invalid.join(', ')}`);
    }
  }
  return discovered.map(({ descriptor, dir }) => ({
    descriptor,
    dir,
    handlers: loadHandlers(dir, descriptor, strict),
  }));
}

export function collectHandlers(modules: readonly LoadedModule[]): Handler[] {
  return modules.flatMap((module) => [...module.handlers]);
}
