// src/shared/hook-paths.ts
// Project-root resolution from a hook tool's file path + new-project monorepo
// predicates. Ported 1:1 from scripts/hook-runtime/handlers/_helpers.cjs.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { STATE_FILE } from '../config/paths';
import { hasPluginAuthoringMarkers } from './authoring-root';
import { readJson } from './fsjson';
import { isNativeState } from './state';
import { hasStateFile } from './tool-classify';

type Rec = Record<string, unknown>;

export function stateRequiresNewProjectMonorepo(state: Rec): boolean {
  if (!state || state.mode !== 'new-project' || isNativeState(state)) return false;
  if (state.stack === 'default' || state.stack === 'react-realtime-monorepo') return true;
  return state.frontend === 'react-vite' && state.backend !== 'none';
}

// Walk up from the tool's target file to the nearest dir (within cwd) that has a
// .traffic-one state file — that's the project root for monorepo sub-apps.
export function findProjectRootForHookFile(cwd: string, filePath: unknown): string {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) return cwd;
  const absPath = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
  const cwdAbs = path.resolve(cwd);
  // Segment-aware containment: a sibling dir sharing a name prefix (/repo vs
  // /repo2) must not be walked as if it were inside cwd.
  const within = (dir: string): boolean => dir === cwdAbs || dir.startsWith(cwdAbs + path.sep);
  let current = path.dirname(absPath);
  while (within(current)) {
    // The plugin's own repo is never a project root, even with a stray state file.
    if (hasStateFile(current) && !hasPluginAuthoringMarkers(current)) return current;
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

function nearestOnboardedRoot(startDir: string): string | null {
  // The home dir is machine-wide config space (`~/.traffic-one`), never a project
  // root. Stop the walk there (and never above it): a stray mode-bearing
  // `~/.traffic-one/.one.json` — e.g. from running the plugin in `~` once — must
  // NOT be adopted as the root for a project that lacks its own state file.
  // Computed per-call (not module-scoped) so tests can pin $HOME.
  let home = '';
  try { home = path.resolve(os.homedir()); } catch { /* no home → unbounded but MAX-capped */ }
  let current = path.resolve(startDir);
  for (let i = 0; i < MAX_ROOT_WALK; i += 1) {
    if (home && current === home) break; // reached the home dir — don't treat it (or above) as a root
    // A mode-bearing .one.json INSIDE the plugin authoring repo is a stray, never
    // a project — skip it and keep walking so an enclosing real workspace (if
    // any) still resolves. The repo can therefore never be adopted as a project.
    if (isOnboardedProjectRoot(current) && !hasPluginAuthoringMarkers(current)) {
      // …and a mode-bearing .one.json BELOW a workspace root is a leak, not a
      // project root: a monorepo has ONE root (the workspace), so a stray
      // packages/*/.traffic-one (the packages/ui incident) must not shadow it.
      // Keep climbing to the workspace root instead of adopting the sub-package.
      if (nearestWorkspaceRoot(path.dirname(current)) === null) return current;
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
function nearestWorkspaceRoot(startDir: string): string | null {
  let home = '';
  try { home = path.resolve(os.homedir()); } catch { /* no home → MAX_ROOT_WALK-capped */ }
  let current = path.resolve(startDir);
  for (let i = 0; i < MAX_ROOT_WALK; i += 1) {
    if (home && current === home) break;
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
// `cwd`) — deliberately NOT bounded by `cwd` — to the nearest ancestor that is a
// real onboarded root, so a monorepo sub-package (`apps/web`, `packages/*`)
// resolves to the workspace root that holds the onboarding/lifecycle state rather
// than tripping a bogus per-package wizard or hiding maintenance phase. When no
// onboarded ancestor exists yet — e.g. mid-onboarding, before the workspace root
// has committed `mode` — anchor at the enclosing WORKSPACE root if one exists, so
// every writer (gate, server, once-markers, convergence) targets the workspace
// instead of minting a stray shallow .traffic-one into the sub-package. Falls back
// to the legacy cwd-bounded nearest-any-state-file resolution (then `cwd`) for a
// standalone project with no workspace ancestor, so its gating is unchanged.
export function resolveProjectRoot(cwd: string, filePath?: unknown): string {
  const normalized = String(filePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const fileAbs = normalized
    ? (path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized))
    : '';
  const fileStart = fileAbs ? path.dirname(fileAbs) : '';
  const onboarded = (fileStart && nearestOnboardedRoot(fileStart)) || nearestOnboardedRoot(cwd);
  if (onboarded) return onboarded;
  const workspace = (fileStart && nearestWorkspaceRoot(fileStart)) || nearestWorkspaceRoot(cwd);
  if (workspace) return workspace;
  return findProjectRootForHookFile(cwd, filePath);
}

export function projectRelativeHookPath(cwd: string, projectRoot: string, filePath: unknown): string {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
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
