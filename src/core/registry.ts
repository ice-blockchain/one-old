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

export function defaultModulesDir(pluginRoot: string): string {
  return path.join(pluginRoot, 'src', 'modules');
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

function loadHandlers(dir: string, descriptor: ModuleDescriptor): Handler[] {
  if (descriptor.kind !== 'runtime') return [];
  const entry = descriptor.entry ?? 'index';
  try {
    const mod = require(path.join(dir, entry)) as { handlers?: unknown };
    return Array.isArray(mod.handlers) ? (mod.handlers as Handler[]) : [];
  } catch {
    return [];
  }
}

export function loadModules(modulesDir: string): LoadedModule[] {
  return discoverDescriptors(modulesDir).map(({ descriptor, dir }) => ({
    descriptor,
    dir,
    handlers: loadHandlers(dir, descriptor),
  }));
}

export function collectHandlers(modules: readonly LoadedModule[]): Handler[] {
  return modules.flatMap((module) => [...module.handlers]);
}
