// src/shared/materialize/windsurf-assets.ts
// Project-local Devin Desktop / Windsurf Cascade assets. Rules are mirrored into
// `.devin/rules` (preferred by current docs). Skills stay under the canonical
// `.traffic-one/skills` tree written by the shared materializer.

import * as fs from 'fs';
import * as path from 'path';

import { pluginRoot } from '../paths';
import { templatePath } from '../stacks';
import { renderWindsurfRuleDocs, WINDSURF_RULES_REL, type WindsurfRuleDocument } from '../windsurf-rules';
import {
  isGeneratedWindsurfWorkspaceHooks,
  WINDSURF_WORKSPACE_HOOKS_REL,
} from '../windsurf-hook-command';
import { GENERATED_MARKER, removeGeneratedSkillDir } from './generated';
import { writeTextIfChanged } from '../fs-text';

const WINDSURF_LEGACY_SKILLS_REL = path.join('.windsurf', 'skills');

interface WindsurfAssetsResult {
  rules: number;
  skills: number;
  written: number;
  removed: number;
  workspaceHooks?: number;
}

function removeEmptyDirs(baseAbs: string): void {
  if (!fs.existsSync(baseAbs)) return;
  for (const entry of fs.readdirSync(baseAbs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(baseAbs, entry.name);
    removeEmptyDirs(abs);
    try {
      if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
    } catch {
      // best-effort cleanup
    }
  }
  try {
    if (fs.existsSync(baseAbs) && fs.readdirSync(baseAbs).length === 0) fs.rmdirSync(baseAbs);
  } catch {
    // best-effort cleanup
  }
}

function generatedText(filePath: string): boolean {
  try {
    return fs.readFileSync(filePath, 'utf8').includes(GENERATED_MARKER);
  } catch {
    return false;
  }
}

function cleanupGeneratedRuleFiles(root: string, keep: ReadonlySet<string>): number {
  const dir = path.join(root, WINDSURF_RULES_REL);
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (keep.has(rel)) continue;
      if (!generatedText(abs)) continue;
      fs.rmSync(abs, { force: true });
      removed += 1;
    }
  };
  walk(dir);
  removeEmptyDirs(dir);
  return removed;
}

function cleanupGeneratedSkillDirs(root: string): number {
  const dir = path.join(root, WINDSURF_LEGACY_SKILLS_REL);
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (removeGeneratedSkillDir(path.join(dir, entry.name))) removed += 1;
  }
  removeEmptyDirs(dir);
  removeEmptyDirs(path.join(root, '.windsurf'));
  return removed;
}

function activeRuleDocs(root: string, rules: readonly string[]) {
  const docs: WindsurfRuleDocument[] = [];
  for (const relPath of rules) {
    const source = path.join(root, templatePath(relPath));
    if (!fs.existsSync(source)) continue;
    docs.push(...renderWindsurfRuleDocs(relPath, fs.readFileSync(source, 'utf8')));
  }
  return docs;
}

function roleRuleDocs(root: string) {
  const agentsRoot = path.join(root, 'agents');
  if (!fs.existsSync(agentsRoot)) return [];
  const docs: WindsurfRuleDocument[] = [];
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.endsWith('.agent.md')) continue;
    const relPath = `agents/${entry.name}`;
    docs.push(...renderWindsurfRuleDocs(relPath, fs.readFileSync(path.join(agentsRoot, entry.name), 'utf8')));
  }
  return docs;
}

export function writeWindsurfHostAssets(cwd: string, rules: readonly string[]): WindsurfAssetsResult {
  const root = pluginRoot();
  const docs = [...activeRuleDocs(root, rules), ...roleRuleDocs(root)];
  const keepRules = new Set(docs.map((doc) => doc.relPath.split(path.sep).join('/')));
  let written = 0;
  let removed = cleanupGeneratedRuleFiles(cwd, keepRules) + cleanupGeneratedSkillDirs(cwd);

  for (const doc of docs) {
    if (writeTextIfChanged(path.join(cwd, doc.relPath), doc.content)) written += 1;
  }

  removed += cleanupGeneratedRuleFiles(cwd, keepRules) + cleanupGeneratedSkillDirs(cwd);
  const workspaceHooksPath = path.join(cwd, WINDSURF_WORKSPACE_HOOKS_REL);
  let workspaceHooks = 0;
  try {
    const existing = fs.existsSync(workspaceHooksPath) ? fs.readFileSync(workspaceHooksPath, 'utf8') : '';
    // Current Windsurf uses native Devin lifecycle hooks from config.json.
    // Remove only our generated Cascade workspace file; never touch a manual one.
    if (existing && isGeneratedWindsurfWorkspaceHooks(existing)) {
      fs.rmSync(workspaceHooksPath, { force: true });
      removed += 1;
    }
  } catch {
    // best-effort; user-level install remains the primary path
  }
  return { rules: docs.length, skills: 0, written, removed, workspaceHooks };
}
