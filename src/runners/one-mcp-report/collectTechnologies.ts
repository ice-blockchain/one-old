// src/runners/one-mcp-report/collectTechnologies.ts
// Technology list from declared state.technologies + dependency scan + file
// extensions. Ported 1:1 from one-mcp-report/collectTechnologies.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { addTechForDependency, dependencyNames } from './lib';

type Rec = Record<string, unknown>;

export function collectTechnologies(cwd: string, state: unknown, fileExtensions: Record<string, number>): string[] {
  const techs = new Set<string>();
  const s = state && typeof state === 'object' ? (state as Rec) : {};
  const stateTech = s.technologies && typeof s.technologies === 'object' ? (s.technologies as Rec) : {};
  for (const values of Object.values(stateTech)) {
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized) techs.add(normalized);
    }
  }

  for (const dep of dependencyNames(cwd)) addTechForDependency(techs, dep);
  if (fileExtensions.ts || fileExtensions.tsx) techs.add('typescript');
  if (fileExtensions.js || fileExtensions.jsx || fileExtensions.mjs || fileExtensions.cjs) techs.add('javascript');
  if (fileExtensions.go) techs.add('go');
  if (fileExtensions.rs) techs.add('rust');
  if (fileExtensions.py) techs.add('python');
  if (fileExtensions.kt || fileExtensions.kts) techs.add('kotlin');
  if (fileExtensions.swift) techs.add('swift');
  if (fileExtensions.dart) techs.add('dart');
  if (fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) techs.add('pnpm');
  return [...techs].filter(Boolean).sort().slice(0, 50);
}
