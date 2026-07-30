// src/shared/hook/paths.ts
// Project-root resolution from a hook tool's file path + new-project monorepo
// predicates. Ported 1:1 from scripts/hook-runtime/handlers/_helpers.cjs.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { STATE_DIR, STATE_FILE } from '../../config/paths';
import { hasPluginAuthoringMarkers, isMachineConfigRoot } from '../authoring-root';
import { readJson } from '../fsjson';
import { dirOwnsProject, projectMembershipRoot } from '../project-membership';
import { isNativeState } from '../state';
import { hasStateFile } from '../tool-classify';

// Re-exported so the resolver stays the single import surface for root questions.
export { dirOwnsProject, projectMembershipRoot } from '../project-membership';

type Rec = Record<string, unknown>;

// Kilo's OpenCode-compatible hook bridge can drop the leading slash from an
// absolute macOS path. Restore it only when the resulting path is inside this
// hook's cwd, so an ordinary relative `Users/...` target is never reinterpreted.
function normalizeHookTargetPath(cwd: string, filePath: unknown): string {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || path.isAbsolute(normalized)) return normalized;
  const rootlessAbsolute = path.resolve(path.sep, normalized);
  return isPathWithin(rootlessAbsolute, path.resolve(cwd)) ? rootlessAbsolute : normalized;
}

export function stateRequiresNewProjectMonorepo(state: Rec): boolean {
  if (!state || state.mode !== 'new-project' || isNativeState(state)) return false;
  // The pnpm/Turborepo layout is a named profile contract, not a fallback for
  // every React-labelled or backend-backed project. Custom profiles keep the
  // roots compiled by the capability registry.
  return state.stack === 'default' || state.stack === 'react-realtime-monorepo';
}

// Walk up from the tool's target file to the nearest dir (within cwd) that has a
// .traffic-one state file — that's the project root for monorepo sub-apps.
export function findProjectRootForHookFile(cwd: string, filePath: unknown): string {
  const normalized = normalizeHookTargetPath(cwd, filePath);
  if (!normalized) return cwd;
  const absPath = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
  const cwdAbs = path.resolve(cwd);
  // Segment-aware containment (isPathWithin): a sibling dir sharing a name prefix
  // (/repo vs /repo2) must not be walked as if it were inside cwd.
  const within = (dir: string): boolean => isPathWithin(dir, cwdAbs);
  let current = path.dirname(absPath);
  while (within(current)) {
    // The plugin's own repo and machine-config space (incl. exact system-temp
    // roots) are never project roots, even with a stray state file.
    if (hasStateFile(current) && !hasPluginAuthoringMarkers(current) && !isMachineConfigRoot(current)) return current;
    if (current === cwdAbs) break;
    current = path.dirname(current);
  }
  return cwd;
}

// A dir is a REAL Traffic One project root only when its `.one.json` carries a
// committed `mode` (new-project / existing-*). A monorepo sub-package can accrue a
// SHALLOW stray state file — e.g. just `one-uid`, written by cwd-scoped
// materialization when a scaffolder cd'd into it — which is NOT a root and must not
// shadow the workspace that actually holds the onboarding/lifecycle state.
export function isOnboardedProjectRoot(dir: string): boolean {
  const s = readJson<Rec>(path.join(dir, STATE_FILE), {} as Rec);
  return Boolean(s && typeof s.mode === 'string' && (s.mode as string).trim());
}

// Bound the upward walk so a hook can never spend unbounded fs reads climbing to /.
const MAX_ROOT_WALK = 40;

// Ancestor-or-self containment (segment-aware: /repo is not within /repo2).
export function isPathWithin(dir: string, root: string): boolean {
  const d = path.resolve(dir);
  const r = path.resolve(root);
  return d === r || d.startsWith(r + path.sep);
}

// A hook can run with a cwd (or target file) that has DRIFTED inside the
// project's own state tree — e.g. an agent that `cd`'d into
// `.traffic-one/skills/<name>` to read a skill and stayed there. Resolution
// must never anchor inside `.traffic-one/**`: truncate at the first state-dir
// segment so the walk starts from the enclosing project instead.
export function stripStateDirSuffix(dir: string): string {
  if (!dir) return dir;
  const resolved = path.resolve(dir);
  const segments = resolved.split(path.sep);
  const idx = segments.indexOf(STATE_DIR);
  if (idx <= 0) return resolved;
  return segments.slice(0, idx).join(path.sep) || resolved;
}

function nearestOnboardedRoot(startDir: string, ceiling?: string): string | null {
  // The home dir is machine-wide config space (`~/.traffic-one`), never a project
  // root. Stop the walk there (and never above it): a stray mode-bearing
  // `~/.traffic-one/.one.json` — e.g. from running the plugin in `~` once — must
  // NOT be adopted as the root for a project that lacks its own state file.
  // Computed per-call (not module-scoped) so tests can pin $HOME.
  let home = '';
  try { home = path.resolve(os.homedir()); } catch { /* no home → unbounded but MAX-capped */ }
  const ceil = ceiling ? path.resolve(ceiling) : '';
  let current = path.resolve(startDir);
  for (let i = 0; i < MAX_ROOT_WALK; i += 1) {
    if (home && current === home) break; // reached the home dir — don't treat it (or above) as a root
    // Machine-config space (incl. exact system-temp roots like /private/tmp) is
    // never a project root and nothing above it is this project — stop, so a
    // stray .traffic-one minted into a temp root can never be adopted.
    if (isMachineConfigRoot(current)) break;
    // Never resolve above the host's authoritative workspace root (Cursor's
    // workspace_roots): a dir OUTSIDE the opened workspace is not this project, even
    // with a stray onboarded .one.json. Without this an out-of-tree tool path (or a
    // stray ancestor) re-roots Traffic One to the parent → a second onboarding wizard.
    if (ceil && !isPathWithin(current, ceil)) break;
    // A mode-bearing .one.json INSIDE the plugin authoring repo is a stray, never
    // a project — skip it and keep walking so an enclosing real workspace (if
    // any) still resolves. The repo can therefore never be adopted as a project.
    if (isOnboardedProjectRoot(current) && !hasPluginAuthoringMarkers(current)) {
      // An onboarded root that is ITSELF a workspace root is the monorepo root —
      // the NEAREST such root wins, even when a farther ancestor also declares
      // workspaces (a project nested inside an unrelated umbrella repo must not
      // resolve to the umbrella — the tests/claude/3 digests-at-parent incident).
      if (dirDeclaresWorkspace(current)) return current;
      // …and a mode-bearing .one.json BELOW a workspace root is a leak, not a
      // project root: a monorepo has ONE root (the workspace), so a stray
      // packages/*/.traffic-one (the packages/ui incident) must not shadow it.
      // Keep climbing to the workspace root instead of adopting the sub-package.
      //
      // The same reasoning by MEMBERSHIP, which is what catches non-npm trees: state
      // sitting in a dir that owns no project while a real project encloses it is a
      // leak too (observed: mercury/strategies and agora/handlers/strategies each
      // accrued a full new-project state inside a Go repo). Climbing past it both
      // fixes resolution AND makes isLeakedNestedRoot report it, so the SessionStart
      // retention sweep heals it — no migration needed. A dir that owns a marker is
      // always its own root, so a real repo can never become a cleanup candidate.
      if (nearestWorkspaceRoot(path.dirname(current), ceiling) === null
        && (dirOwnsProject(current)
          || projectMembershipRoot(path.dirname(current), ceiling) === null)) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }
  return null;
}

// A directory is a WORKSPACE ROOT when it declares workspaces — npm/yarn/bun
// `workspaces` in package.json, or a pnpm-workspace.yaml. Lenient by design: the
// cost of a false positive is resolving up one level; the cost of a miss is a
// stray .traffic-one minted into a sub-package (see resolveProjectRoot below).
function dirDeclaresWorkspace(dir: string): boolean {
  if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) || fs.existsSync(path.join(dir, 'pnpm-workspace.yml'))) {
    return true;
  }
  const pkg = readJson<Rec>(path.join(dir, 'package.json'), {} as Rec);
  const ws = pkg ? (pkg as Rec).workspaces : undefined;
  if (Array.isArray(ws)) return ws.length > 0;
  if (ws && typeof ws === 'object') return Array.isArray((ws as Rec).packages);
  return false;
}

// Nearest ancestor-or-self (within the bounded walk, never above $HOME) that is a
// workspace root. Used as the project-root anchor when no ONBOARDED root exists
// yet — e.g. mid-onboarding, before the workspace root has committed `mode`.
function nearestWorkspaceRoot(startDir: string, ceiling?: string): string | null {
  let home = '';
  try { home = path.resolve(os.homedir()); } catch { /* no home → MAX_ROOT_WALK-capped */ }
  const ceil = ceiling ? path.resolve(ceiling) : '';
  let current = path.resolve(startDir);
  for (let i = 0; i < MAX_ROOT_WALK; i += 1) {
    if (home && current === home) break;
    if (isMachineConfigRoot(current)) break; // temp/config roots never anchor a workspace
    if (ceil && !isPathWithin(current, ceil)) break; // never anchor above the host workspace root
    if (dirDeclaresWorkspace(current) && !hasPluginAuthoringMarkers(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// True when `cwd` is a monorepo sub-package with NO Traffic One state of its own
// that sits inside a workspace root — so it must never be materialized as its own
// project. The write-side backstop for the resolveProjectRoot anchor below
// (detectMode labels any sparse dir 'new-project', so an un-guarded converge would
// mint a stray shallow .traffic-one/.one.json into packages/* during a build).
export function isUnclaimedWorkspaceSubPackage(cwd: string): boolean {
  const dir = path.resolve(cwd);
  if (hasStateFile(dir)) return false;                      // owns state → a real root, leave it
  return nearestWorkspaceRoot(path.dirname(dir)) !== null;  // an ANCESTOR is a workspace root
}

// Resolve the effective Traffic One project root for a hook operating at `cwd` on
// an optional target `filePath`. Walks UP from the target file's dir (then from
// `cwd`) — deliberately NOT bounded by `cwd` (but capped by `opts.ceiling` when the
// host supplies an authoritative workspace root; see below) — to the nearest
// ancestor that is a real onboarded root, so a monorepo sub-package (`apps/web`,
// `packages/*`)
// resolves to the workspace root that holds the onboarding/lifecycle state rather
// than tripping a bogus per-package wizard or hiding maintenance phase. When no
// onboarded ancestor exists yet — e.g. mid-onboarding, before the workspace root
// has committed `mode` — anchor at the enclosing WORKSPACE root if one exists, so
// every writer (gate, server, once-markers, convergence) targets the workspace
// instead of minting a stray shallow .traffic-one into the sub-package. Falls back
// to the legacy cwd-bounded nearest-any-state-file resolution (then `cwd`) for a
// standalone project with no workspace ancestor, so its gating is unchanged.
//
// `opts.ceiling` is the host's AUTHORITATIVE workspace root (Cursor's
// workspace_roots): resolution never climbs above it. This is what keeps a hook
// that touches a path ABOVE the opened workspace — or a stray onboarded ancestor —
// from re-rooting Traffic One to the parent (the Cursor double-onboarding incident).
// Hosts that declare no workspace boundary (Claude/Codex) leave it unset, so the
// monorepo sub-package climb is unchanged.
export function resolveProjectRoot(cwd: string, filePath?: unknown, opts: { ceiling?: string } = {}): string {
  const ceiling = opts.ceiling ? path.resolve(opts.ceiling) : '';
  // Relative targets still resolve against the REAL cwd; only the walk anchors
  // are lifted out of a drifted `.traffic-one/**` cwd (see stripStateDirSuffix).
  const cwdStart = stripStateDirSuffix(cwd);
  const normalized = normalizeHookTargetPath(cwd, filePath);
  const fileAbs = normalized
    ? (path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized))
    : '';
  let fileStart = fileAbs ? stripStateDirSuffix(path.dirname(fileAbs)) : '';
  // A target file OUTSIDE the authoritative workspace root is out-of-tree — never
  // let it re-root resolution to an ancestor. Drop the file hint and resolve from
  // cwd within the workspace.
  if (ceiling && fileStart && !isPathWithin(fileStart, ceiling)) fileStart = '';
  const onboarded = (fileStart && nearestOnboardedRoot(fileStart, ceiling)) || nearestOnboardedRoot(cwdStart, ceiling);
  if (onboarded) return onboarded;
  const workspace = (fileStart && nearestWorkspaceRoot(fileStart, ceiling)) || nearestWorkspaceRoot(cwdStart, ceiling);
  if (workspace) return workspace;
  // Cursor can run a subagent shell with cwd under its internal metadata tree
  // (for example ~/.cursor/.../terminals), outside workspace_roots. The ceiling
  // bounded walks above correctly refuse to climb from that cwd, but falling back
  // to cwd would make Traffic One think this out-of-tree dir is a fresh project.
  if (ceiling && !isPathWithin(path.resolve(cwdStart), ceiling)) {
    if (isOnboardedProjectRoot(ceiling)) return ceiling;
    const workspaceAtCeiling = nearestWorkspaceRoot(ceiling, ceiling);
    if (workspaceAtCeiling) return workspaceAtCeiling;
    return ceiling;
  }
  // Nothing is onboarded and no workspace is declared — so ask which project this
  // directory BELONGS to. Without this the fallback below returns `cwd` verbatim,
  // which is how a Go PACKAGE became its own project (observed: mercury/strategies
  // and agora/handlers/strategies each got a full new-project wizard, because
  // detectMode counts files in the resolved root and a small package reads as
  // `new-project`). Deliberately AFTER the workspace anchor: a monorepo sub-package
  // owns a package.json of its own, so running this first would make it a root and
  // defeat the packages/* leak rule.
  const member = (fileStart && projectMembershipRoot(fileStart, ceiling))
    || projectMembershipRoot(cwdStart, ceiling);
  if (member) return member;
  return findProjectRootForHookFile(cwdStart, fileAbs || filePath);
}

export function projectRelativeHookPath(cwd: string, projectRoot: string, filePath: unknown): string {
  const normalized = normalizeHookTargetPath(cwd, filePath);
  if (!normalized) return '';
  const absPath = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
  const relative = path.relative(projectRoot, absPath).replace(/\\/g, '/');
  if (relative && !relative.startsWith('..') && relative !== '.') return relative;
  return normalized;
}

export function packageJsonDeclaresWorkspace(content: string): boolean {
  if (!content || !content.trim()) return true;
  try {
    const pkg = JSON.parse(content);
    const workspaces = pkg && pkg.workspaces;
    const hasWorkspaces = Array.isArray(workspaces) || Boolean(workspaces && Array.isArray(workspaces.packages));
    const hasPnpmPackageManager = typeof pkg.packageManager === 'string' && /^pnpm@\d/.test(pkg.packageManager);
    return pkg.private === true && hasWorkspaces && hasPnpmPackageManager;
  } catch {
    return true;
  }
}
