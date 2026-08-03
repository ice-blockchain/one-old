// src/shared/project-membership.ts
// "Which project does this directory belong to?" — the ownership primitive shared by
// hook root resolution (shared/hook/paths) and the state-write veto
// (shared/state/normalize). Deliberately a LOW layer: it depends only on node
// builtins + authoring-root, so the state writer can consult it without the
// state → hook/paths → state cycle.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { hasPluginAuthoringMarkers, isMachineConfigRoot } from './authoring-root';

// A directory OWNS a project when it carries version control or a language manifest
// of its own — the top of a repo or module. Deliberately EXCLUDES `.traffic-one` /
// `.one.json` (unlike shared/paths.ts PROJECT_MARKERS, which is a STATE lookup):
// including them would make membership self-confirming, so a directory that once
// accrued stray state would own a project forever and never heal, and a stray
// `~/.traffic-one` would turn the home dir into a project.
export const VCS_MARKERS = ['.git', '.hg', '.svn'] as const;
export const MANIFEST_MARKERS = [
  'go.mod', 'go.work', 'package.json', 'composer.json', 'pyproject.toml',
  'Cargo.toml', 'Gemfile', 'pubspec.yaml', 'deno.json', 'deno.jsonc',
] as const;

// Bound the upward walk so a hook can never spend unbounded fs reads climbing to /.
const MAX_MEMBERSHIP_WALK = 40;

// Segment-aware containment (/repo is not within /repo2). Local so this module keeps
// no dependency on shared/hook/paths.
function withinCeiling(dir: string, ceiling: string): boolean {
  return dir === ceiling || dir.startsWith(ceiling + path.sep);
}

// existsSync, never isDirectory: `.git` is a FILE in a worktree or submodule.
function dirHasVcs(dir: string): boolean {
  const resolved = path.resolve(dir);
  return VCS_MARKERS.some((marker) => fs.existsSync(path.join(resolved, marker)));
}

function dirHasManifest(dir: string): boolean {
  const resolved = path.resolve(dir);
  return MANIFEST_MARKERS.some((marker) => fs.existsSync(path.join(resolved, marker)));
}

export function dirOwnsProject(dir: string): boolean {
  return dirHasVcs(dir) || dirHasManifest(dir);
}

// The project a directory BELONGS to: itself when it owns a project, otherwise the
// nearest ANCESTOR that is a repository. A dir owning a marker belongs to ITSELF, so a
// git submodule or nested module is never absorbed into its parent. Answers from the
// filesystem alone, so it works BEFORE anything is onboarded — exactly when root
// resolution used to guess wrong and mint a project for whatever subdirectory a tool
// happened to touch.
//
// Asymmetry by design: for the START dir a manifest is enough (a module root IS a
// project), but only VERSION CONTROL lets an ANCESTOR absorb a child. A manifest marks
// "this dir is a module"; it is not authority over everything beneath it, and a stray
// one high in the tree would otherwise hijack every marker-less dir below — observed
// live: a leftover `go.mod` in `~/Documents` and `~/Documents/projects` made an
// unrelated multi-repo workspace resolve to `~/Documents/projects`. `.git` is the
// intentional, unambiguous repository boundary.
//
// The break-guards mirror nearestWorkspaceRoot: they are what stops the walk at an
// UNRELATED ancestor (machine config space, the home dir, above the host's workspace
// root, the plugin's own repo).
export function projectMembershipRoot(startDir: string, ceiling?: string): string | null {
  let home = '';
  try { home = path.resolve(os.homedir()); } catch { /* no home → MAX-capped */ }
  const ceil = ceiling ? path.resolve(ceiling) : '';
  const start = path.resolve(startDir);
  let current = start;
  for (let i = 0; i < MAX_MEMBERSHIP_WALK; i += 1) {
    if (home && current === home) break;
    if (isMachineConfigRoot(current)) break;
    if (ceil && !withinCeiling(current, ceil)) break;
    const owns = current === start ? dirOwnsProject(current) : dirHasVcs(current);
    if (owns && !hasPluginAuthoringMarkers(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
