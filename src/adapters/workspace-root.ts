// src/adapters/workspace-root.ts
// The workspace-root selector, shared by every host whose payload carries the
// project root(s) as data rather than as the hook process's cwd.
//
// It lived TWICE — adapters/cursor.ts and adapters/copilot.ts — behind a
// `T1SHARED:workspace-root` marker that adapters/__tests__/workspace-root-parity.test.ts
// held byte-identical. That test's own header called the duplication
// "provisional, not principled" and named the exit: extract the block, drop the
// textual half, keep the behavioural half. This is that extraction.
//
// What deliberately did NOT move here: `isInsideOrEqual` in shared/paths.ts.
// It looks like a fifth copy and is not the same function — it calls
// `path.relative(boundary, candidate)` on the RAW arguments where this one
// resolves both first, so the two disagree for any relative input. Folding it in
// would be a behaviour change to the repo's most incident-dense file wearing a
// deduplication's clothes. shared/authoring-root.ts `isInsideOrEqualRoot` is a
// third shape again (string prefix, no path.relative). Three functions that
// answer similar questions differently are not three copies of one function.

import * as path from 'path';

import { firstString } from './coerce';

export function stripFileUri(p: string): string {
  return p.startsWith('file://') ? decodeURIComponent(p.slice('file://'.length)) : p;
}

// Cursor sends the project root(s) as `workspace_roots` (an array of path strings
// — or {path|uri|fsPath} objects on some versions), NOT a `cwd` field. A plugin
// hook's process.cwd() is event-dependent: currently the plugin directory for
// most events, but the workspace for Stop/SubagentStop. It therefore cannot be
// the project identity contract. Accept string or object elements, strip file://.
export function workspaceRootList(data: Record<string, unknown>): string[] {
  const roots = data.workspace_roots ?? data.workspaceRoots ?? data.workspace_root ?? data.workspaceFolders;
  const list = Array.isArray(roots) ? roots : (roots != null ? [roots] : []);
  const out: string[] = [];
  for (const r of list) {
    if (typeof r === 'string' && r) { out.push(stripFileUri(r)); continue; }
    if (r && typeof r === 'object') {
      const rec = r as Record<string, unknown>;
      const p = firstString(rec.path, rec.uri, rec.fsPath);
      if (p) out.push(stripFileUri(p));
    }
  }
  return out;
}

export function isInsideOrEqual(candidate: string, boundary: string): boolean {
  const rel = path.relative(path.resolve(boundary), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// A window can hold SEVERAL folders, so `workspace_roots` is a list. Taking its
// FIRST element made the ceiling name a different project whenever the hook was
// working in any folder but the first: every bounded walk in resolveProjectRoot
// breaks immediately and it returns the ceiling itself, the cwd fold below
// replaces the real cwd with that foreign root, and workspaceBoundaryGuard then
// denies every read/search/write in the folder actually being worked in. Pick the
// root that CONTAINS the cwd instead.
//
// OUTERMOST containing root, not the innermost. The ceiling is an upper BOUND,
// not a selection — resolveProjectRoot already picks the nearest onboarded (or
// workspace) root at or below it. When a user opens both a monorepo and one of
// its own packages, an innermost ceiling pins resolution to the sub-package and
// mints a stray .traffic-one there: the packages/ui incident, reintroduced
// through the ceiling. (Contrast hooks/auth-fallback.ts, which picks the LONGEST
// match from the same list — correct there because that value is used as a
// starting cwd, where nearest wins.)
//
// Matched against the cwd, never the tool's target file: a ceiling derived from
// the target would by construction contain that target, which is precisely the
// question workspaceBoundaryGuard exists to ask.
//
// Nothing contains the cwd — Cursor's internal terminals metadata dir, a relative
// cwd, or no cwd at all — falls back to the first element, unchanged.
export function activeWorkspaceRoot(data: Record<string, unknown>): string | undefined {
  const roots = workspaceRootList(data);
  if (roots.length === 0) return undefined;
  const cwd = stripFileUri(firstString(data.cwd));
  if (cwd && path.isAbsolute(cwd)) {
    let outermost = '';
    for (const root of roots) {
      if (!path.isAbsolute(root) || !isInsideOrEqual(cwd, root)) continue;
      if (!outermost || root.length < outermost.length) outermost = root;
    }
    if (outermost) return outermost;
  }
  return roots[0];
}

// An explicit `cwd` is honoured only while it stays inside the selected root; a
// cwd outside it (or a relative one that resolves outside) folds back to the
// root, so a hook working in a foreign directory cannot carry the project
// identity out of the workspace.
export function workspaceScopedCwd(data: Record<string, unknown>, wsRoot: string | undefined): string {
  const explicit = firstString(data.cwd);
  if (!explicit) return wsRoot || process.cwd();
  if (!wsRoot || !path.isAbsolute(wsRoot)) return explicit;
  const resolved = path.isAbsolute(explicit) ? explicit : path.resolve(wsRoot, explicit);
  return isInsideOrEqual(resolved, wsRoot) ? explicit : wsRoot;
}
