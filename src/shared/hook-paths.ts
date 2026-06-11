// src/shared/hook-paths.ts
// Project-root resolution from a hook tool's file path + new-project monorepo
// predicates. Ported 1:1 from scripts/hook-runtime/handlers/_helpers.cjs.

import * as os from 'os';
import * as path from 'path';

import { STATE_FILE } from '../config/paths';
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
    if (hasStateFile(current)) return current;
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
    if (isOnboardedProjectRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }
  return null;
}

// Resolve the effective Traffic One project root for a hook operating at `cwd` on
// an optional target `filePath`. Walks UP from the target file's dir (then from
// `cwd`) — deliberately NOT bounded by `cwd` — to the nearest ancestor that is a
// real onboarded root, so a monorepo sub-package (`apps/web`, `packages/*`)
// resolves to the workspace root that holds the onboarding/lifecycle state rather
// than tripping a bogus per-package wizard or hiding maintenance phase. Falls back
// to the legacy cwd-bounded nearest-any-state-file resolution (then `cwd`) when no
// onboarded ancestor exists — e.g. a fresh project whose root state has no `mode`
// yet — so gating of genuinely un-onboarded projects is unchanged.
export function resolveProjectRoot(cwd: string, filePath?: unknown): string {
  const normalized = String(filePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const fileAbs = normalized
    ? (path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized))
    : '';
  const fileStart = fileAbs ? path.dirname(fileAbs) : '';
  const onboarded = (fileStart && nearestOnboardedRoot(fileStart)) || nearestOnboardedRoot(cwd);
  if (onboarded) return onboarded;
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
