// src/shared/materialize/windsurf-assets.ts
// Project-local Devin Desktop / Windsurf Cascade assets. Rules are mirrored into
// `.devin/rules` (preferred by current docs). Skills stay under the canonical
// `.traffic-one/skills` tree written by the shared materializer.

import * as fs from 'fs';
import * as path from 'path';

import { TEAM_ROLES } from '../../config/onboarding';
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

// A real file at `candidate`, reached THROUGH any symlinks, and never a
// directory. Mirrors paths.ts isFileSafe; never throws, for a nonexistent path,
// a broken link, a link loop or an unreadable parent — all of which mean "not a
// role doc this root can supply" here.
function isFileFollowingLinks(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
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
 * caller's to guarantee) and `<root>/agents/**` (read from the directory, so a
 * tree that is missing or mid-write yields fewer entries). One flat sweep over
 * both classes therefore let an absent `agents/` dir delete every mirrored role
 * contract while the run reported success: `docs` was still non-empty from the
 * rule half, so the empty-content refusal below never fired, and `.devin/rules`
 * is the only copy Cascade reads.
 *
 * The scope of a sweep is limited to the class whose keep-list the run actually
 * produced IN FULL. `roleDocsResolved` is false both when the agents tree gave
 * back nothing and when it gave back a strict subset of the declared roster
 * (DECLARED_ROLE_DOC_IDS) — a partial copy narrows the keep-list by exactly the
 * mirrors the sweep would then delete, which is the same partial-deletion shape
 * as the empty one and was measured deleting 8 of 14 mirrors. Either way the
 * mirrors are left alone and the rule half converges as usual, which is strictly
 * better than deleting them or refusing the whole run. A genuinely retired role
 * is still swept, because retiring one shrinks the roster in the same build.
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

/**
 * The role docs a COMPLETE install ships as `<root>/agents/<id>.md` — one per
 * content module that declares an agent in its module.json, which is exactly the
 * team roster plus the always-available quick-fix role.
 *
 * Declared here rather than counted from the directory, for the reason
 * materialize.ts tornRootRefusal gives at length: a candidate set read from the
 * tree it is meant to audit cannot detect a shortfall in that tree. It is
 * upgrade-proof by the same lockstep — `agents/**` is emitted and TEAM_ROLES is
 * compiled by one `npm run gen` from one commit, so a release that retires a
 * role deletes its module (and with it the emitted doc) and its roster entry
 * together, both sides shrink, and nothing reads as missing.
 * windsurf-assets.test.ts pins the two against each other.
 */
export const DECLARED_ROLE_DOC_IDS: readonly string[] = [...TEAM_ROLES.map((member) => member.role), 'quick-fix'];

/**
 * `missing` is the agents half of the same completeness signal activeRuleDocs
 * produces for the rules half, and it exists because a PARTIALLY copied
 * `agents/` is the one tear the doc comment below did not cover.
 *
 * Measured on an installed root torn to 3 of 7 role docs, Windsurf host, against
 * a project already mirrored from a whole root: the run was not refused,
 * `removed` was 8, and eight role-contract mirrors under `.devin/rules` — the
 * only copy Cascade reads — were deleted. An absent `agents/` was already
 * handled (docs empty ⇒ the class is not swept); a SHORT one was not, because
 * "some entries came back" is indistinguishable from "this release ships these"
 * when the directory is its own authority.
 *
 * Extra docs are still mirrored: this reports what the roster declared and the
 * root could not supply, and says nothing about entries it did not declare.
 */
function roleRuleDocs(root: string): { docs: WindsurfRuleDocument[]; missing: string[] } {
  const agentsRoot = path.join(root, 'agents');
  const docs: WindsurfRuleDocument[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    // A root with no agents/ at all resolves nothing and is reported as such by
    // the empty `docs`, not as a shortfall — see writeWindsurfHostAssets.
    return { docs, missing: [] };
  }
  const present = new Set<string>();
  for (const entry of entries) {
    if (!entry.name.endsWith('.md') || entry.name.endsWith('.agent.md')) continue;
    const abs = path.join(agentsRoot, entry.name);
    // statSync and NOT `entry.isFile()`: readdirSync's Dirent reflects lstat, so
    // a SYMLINKED role doc answers false there and the whole tree reads as empty.
    // paths.ts classifyPluginRootLayout already stats through links for exactly
    // this reason ("an installed tree may symlink its runtime"), and measured on
    // a root whose agents/ entries are links this filter resolved 0 of 7 — which,
    // now that the shortfall is a signal, would report a healthy install as
    // permanently torn and stop the role sweep forever.
    if (!isFileFollowingLinks(abs)) continue;
    const relPath = `agents/${entry.name}`;
    present.add(entry.name.slice(0, -'.md'.length));
    docs.push(...renderWindsurfRuleDocs(relPath, fs.readFileSync(abs, 'utf8')));
  }
  return { docs, missing: DECLARED_ROLE_DOC_IDS.filter((id) => !present.has(id)).sort() };
}

export function writeWindsurfHostAssets(cwd: string, rules: readonly string[]): WindsurfAssetsResult {
  const root = pluginRoot();
  const mirrored = activeRuleDocs(root, rules);
  const roleDocs = roleRuleDocs(root);
  const docs = [...mirrored.docs, ...roleDocs.docs];
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
  // A TORN `agents/` is treated exactly like an unresolved one, and the choice
  // is the same one this writer already made for the empty case: narrowing the
  // keep-list is the destructive act, so a keep-list this root could not fill
  // does not get to authorize a sweep. Writing is unaffected — the docs that DID
  // resolve are still mirrored — and the next run against a whole root sweeps
  // any genuinely retired role then, because a retirement shrinks the declared
  // roster too and leaves nothing missing.
  const roleDocsResolved = roleDocs.docs.length > 0 && roleDocs.missing.length === 0;
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
