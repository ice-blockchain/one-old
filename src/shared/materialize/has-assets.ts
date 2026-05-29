// src/shared/materialize/has-assets.ts
// Materialization presence checks. Ported 1:1 from
// scripts/hook-runtime/materialize/{hasMaterializedProjectAssets,isLeanMaterialization}.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { isGenerated } from './generated';

type Rec = Record<string, unknown>;

export function hasMaterializedProjectAssets(cwd: string, state?: Rec): boolean {
  const manifestPath = path.join(cwd, '.traffic-one', 'manifest.json');
  let manifest: Rec;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return false;
    manifest = parsed as Rec;
  } catch {
    return false;
  }

  if (manifest.generatedBy !== 'traffic-one') return false;
  if (state && typeof manifest.stack === 'string' && state.stack && manifest.stack !== state.stack) return false;

  const rules = manifest.rules;
  const skills = manifest.skills;
  if (!Array.isArray(rules) || rules.length === 0) return false;
  if (!Array.isArray(skills) || skills.length === 0) return false;

  if (!fs.existsSync(path.join(cwd, 'AGENTS.md')) || !isGenerated(path.join(cwd, 'AGENTS.md'))) return false;
  if (!fs.existsSync(path.join(cwd, 'CLAUDE.md'))) return false;

  for (const relPath of rules as string[]) {
    if (!fs.existsSync(path.join(cwd, '.traffic-one', relPath))) return false;
  }
  for (const name of skills as string[]) {
    if (!fs.existsSync(path.join(cwd, '.traffic-one', 'skills', name, 'SKILL.md'))) return false;
  }
  return true;
}

export function isLeanMaterialization(_cwd: string, state?: Rec): boolean {
  if (state && (state.leanMode === false || state.contextMode === 'full' || state.tokenProfile === 'full')) {
    return false;
  }
  return true;
}
