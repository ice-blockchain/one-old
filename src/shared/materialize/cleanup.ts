// src/shared/materialize/cleanup.ts
// Previous-manifest load + stale-asset cleanup + legacy migration helpers.
// Ported 1:1 from scripts/hook-runtime/materialize/_helpers.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { readText } from '../fsjson';
import { templatePath } from '../stacks';
import { removeGeneratedFile, removeGeneratedManifest, removeGeneratedSkillDir, removeGeneratedTree } from './generated';

type Rec = Record<string, unknown>;

export function loadPreviousManifest(cwd: string): Rec {
  const candidates = [
    path.join(cwd, '.traffic-one', 'manifest.json'),
    path.join(cwd, '.traffic-one', 'rules', 'manifest.json'),
  ];
  for (const manifestPath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed as Rec;
    } catch {
      // try the next candidate
    }
  }
  return {};
}

export function migrateLegacyMemoryFile(cwd: string, fileName: string): boolean {
  const legacyPath = path.join(cwd, '.traffic-one', 'rules', fileName);
  const targetPath = path.join(cwd, '.traffic-one', fileName);
  if (!fs.existsSync(legacyPath) || fs.lstatSync(legacyPath).isDirectory()) return false;
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(legacyPath, targetPath);
    return true;
  }
  if (readText(legacyPath) === readText(targetPath)) {
    fs.rmSync(legacyPath, { force: true });
    return true;
  }
  return false;
}

export function cleanupPrevious(cwd: string, previous: Rec, nextRulePaths: Set<string>, nextSkillNames: Set<string>): number {
  let removed = 0;
  const projectMemoryRoot = path.join(cwd, '.traffic-one');
  const legacyActiveRoot = path.join(cwd, '.traffic-one', 'rules', 'active');
  const skillsRoot = path.join(cwd, '.traffic-one', 'skills');

  const prevRules = Array.isArray(previous.rules) ? (previous.rules as string[]) : [];
  for (const relPath of prevRules) {
    if (removeGeneratedFile(path.join(legacyActiveRoot, relPath))) removed += 1;
    if (nextRulePaths.has(relPath)) continue;
    if (removeGeneratedFile(path.join(projectMemoryRoot, relPath))) removed += 1;
  }

  if (removeGeneratedTree(legacyActiveRoot)) removed += 1;
  if (removeGeneratedFile(path.join(cwd, '.traffic-one', 'rules', 'AGENTS.md'))) removed += 1;
  if (removeGeneratedManifest(path.join(cwd, '.traffic-one', 'rules', 'manifest.json'))) removed += 1;
  if (migrateLegacyMemoryFile(cwd, 'coding.md')) removed += 1;
  if (migrateLegacyMemoryFile(cwd, 'security.md')) removed += 1;

  const prevSkills = Array.isArray(previous.skills) ? (previous.skills as string[]) : [];
  for (const name of prevSkills) {
    if (nextSkillNames.has(name)) continue;
    if (removeGeneratedSkillDir(path.join(skillsRoot, name))) removed += 1;
  }
  return removed;
}

export function modeRulesForState(root: string, state: Rec): string[] {
  const mode = state && typeof state.mode === 'string' ? state.mode : '';
  if (!mode) return [];
  const relPath = `rules/modes/${mode}.md`;
  if (!fs.existsSync(path.join(root, templatePath(relPath)))) return [];
  return [relPath];
}
