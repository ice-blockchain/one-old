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
import { removePath } from '../fsjson';
import { writeTextIfChanged } from '../fs-text';

const WINDSURF_LEGACY_SKILLS_REL = path.join('.windsurf', 'skills');

interface WindsurfAssetsResult {
  rules: number;
  skills: number;
  written: number;
  removed: number;
  workspaceHooks?: number;
  skipped?: string;
}

// `rmdir` and not the fsjson chokepoint, unlike the two file deletes below: it
// is the one mutation here whose REFUSAL is the safety. `rmdir` fails on a
// non-empty directory, so the emptiness check and the call together cannot
// delete a directory that gained a file in between; `removePath` deletes
// recursively and would turn that race into data loss.
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

// The file's own text when it is one of ours, null otherwise — read once, because
// the sweep below needs both the marker and the source class out of it.
function generatedText(filePath: string): string | null {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text.includes(GENERATED_MARKER) ? text : null;
  } catch {
    return null;
  }
}

// Which of the two independently-resolved classes a mirrored file came from, read
// from the provenance line renderWindsurfRuleDocs stamps into it
// (`<!-- GENERATED FROM: agents/<role>.md -->`) rather than from the `00-agent-`
// filename slug — the marker is the writer's own record, the slug is a convention
// a future rename would silently break.
function isRoleDocMirror(text: string): boolean {
  return text.includes('<!-- GENERATED FROM: agents/');
}

/**
 * `roleDocsResolved` is the per-class half of this writer's destruction guard.
 *
 * The keep-list is assembled from TWO independently resolved sources —
 * `<root>/rules/**` (enumerated by the caller, so its completeness is the
 * caller's to guarantee) and `<root>/agents/**` (enumerated by reading the
 * directory, so a tree that is missing or mid-write yields fewer entries and
 * nothing local can tell that from a release that retired a role). One flat
 * sweep over both classes therefore let an absent `agents/` dir delete every
 * mirrored role contract while the run reported success: `docs` was still
 * non-empty from the rule half, so the empty-content refusal below never fired,
 * and `.devin/rules` is the only copy Cascade reads.
 *
 * The scope of a sweep is limited to the class whose keep-list the run actually
 * produced. A retired role is still swept on any run that resolved the agents
 * tree; a run that resolved NONE of it leaves those mirrors alone and converges
 * the rule half as usual, which is strictly better than either deleting them or
 * refusing the whole run.
 */
function cleanupGeneratedRuleFiles(root: string, keep: ReadonlySet<string>, roleDocsResolved: boolean): number {
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
      const text = generatedText(abs);
      if (text === null) continue;
      if (!roleDocsResolved && isRoleDocMirror(text)) continue;
      // Routed through the chokepoint for the reason render-agents.ts gives at
      // its own root-file delete: the fence is addressed by `.traffic-one/**`
      // and this path is outside it, so nothing is refused today, but a fence
      // that ever grows to cover project files covers this too instead of this
      // being the site that has to remember to opt in. Counting the return
      // rather than assuming the delete is the other half — `rmSync` with
      // `force` reports nothing, so a refusal would still be counted as removed.
      if (removePath(abs)) removed += 1;
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

// `missing` is what the caller asked to mirror and this root could not supply —
// the rule half's completeness signal. Silently skipping those (the old
// behaviour) shortens the keep-list by exactly the rules whose mirrors are then
// swept, which is the partial-deletion shape rather than the empty one.
function activeRuleDocs(root: string, rules: readonly string[]): {
  docs: WindsurfRuleDocument[];
  missing: string[];
} {
  const docs: WindsurfRuleDocument[] = [];
  const missing: string[] = [];
  for (const relPath of rules) {
    const source = path.join(root, templatePath(relPath));
    if (!fs.existsSync(source)) {
      missing.push(relPath);
      continue;
    }
    docs.push(...renderWindsurfRuleDocs(relPath, fs.readFileSync(source, 'utf8')));
  }
  return { docs, missing };
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
  const mirrored = activeRuleDocs(root, rules);
  const roleDocs = roleRuleDocs(root);
  const docs = [...mirrored.docs, ...roleDocs];
  // This writer's OWN destruction guard, deliberately not inherited from
  // materializeProjectAssets' refusals by call-graph accident. `docs` is the
  // keep-list for cleanupGeneratedRuleFiles below, so an empty `docs` means
  // "keep nothing" — every generated file under .devin/rules gets swept, and
  // the mirror is the only copy Cascade reads. `docs` resolves empty exactly
  // when the plugin root cannot supply content (`<root>/rules/**` and
  // `<root>/agents/**` both missing — an unverified, partial or source-checkout
  // root), which is precisely when there is nothing to write back. A healthy
  // installed root always yields at least the role docs. Refuse and keep the
  // mirror; the next run against a resolvable root re-converges it.
  if (docs.length === 0) {
    return { rules: 0, skills: 0, written: 0, removed: 0, skipped: 'windsurf-content-empty' };
  }
  // The TORN root, for the half this writer is authoritative about: the caller
  // named the rules to mirror and this root could not supply all of them, so the
  // keep-list is short by exactly the mirrors the sweep would then delete. Same
  // reasoning as materialize.ts tornRootRefusal — a partially copied tree must
  // not be allowed to narrow a keep-list — and the same answer: keep the mirror,
  // report why, converge on the next run against a whole root.
  //
  // Not reachable from materializeProjectAssets today, which filters `rules` by
  // existence in the same root before calling (and now refuses the torn root
  // outright). It is reachable through the export, which is the reason this
  // writer carries its own guards at all rather than inheriting them by
  // call-graph accident.
  if (mirrored.missing.length > 0) {
    return { rules: 0, skills: 0, written: 0, removed: 0, skipped: 'windsurf-content-incomplete' };
  }
  const keepRules = new Set(docs.map((doc) => doc.relPath.split(path.sep).join('/')));
  const roleDocsResolved = roleDocs.length > 0;
  let written = 0;
  let removed = cleanupGeneratedRuleFiles(cwd, keepRules, roleDocsResolved) + cleanupGeneratedSkillDirs(cwd);

  for (const doc of docs) {
    if (writeTextIfChanged(path.join(cwd, doc.relPath), doc.content)) written += 1;
  }

  removed += cleanupGeneratedRuleFiles(cwd, keepRules, roleDocsResolved) + cleanupGeneratedSkillDirs(cwd);
  const workspaceHooksPath = path.join(cwd, WINDSURF_WORKSPACE_HOOKS_REL);
  let workspaceHooks = 0;
  try {
    const existing = fs.existsSync(workspaceHooksPath) ? fs.readFileSync(workspaceHooksPath, 'utf8') : '';
    // Current Windsurf uses native Devin lifecycle hooks from config.json.
    // Remove only our generated Cascade workspace file; never touch a manual one.
    if (existing && isGeneratedWindsurfWorkspaceHooks(existing) && removePath(workspaceHooksPath)) {
      removed += 1;
    }
  } catch {
    // best-effort; user-level install remains the primary path
  }
  return { rules: docs.length, skills: 0, written, removed, workspaceHooks };
}
