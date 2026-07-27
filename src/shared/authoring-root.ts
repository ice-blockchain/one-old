// src/shared/authoring-root.ts
// Detects the plugin's OWN repo (or its generated tree) so the gate/materialiser
// never act on it. Two independent signals, so detection survives layout changes:
//   1. the SOURCE repo — identified by the TypeScript generator/build entries plus
//      package.json name (independent of where the build emits), and
//   2. a GENERATED plugin tree — hook-runtime + a plugin manifest named
//      traffic-one, which since the dist/ refactor lives under dist/ (older layouts
//      kept it at the repo root).
// Detection walks UP (bounded, stopping at $HOME) so a session cwd or write
// target anywhere INSIDE the repo also stands down — a hook invoked from
// one/src, or from a parent workspace targeting a file in the repo, must never
// treat the plugin's own codebase as an end-user project.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { pluginRoot } from './paths';
import { globalTrafficOneDir } from './state/traffic-one-paths';

function manifestNameIsTrafficOne(manifestPath: string): boolean {
  try {
    if (!fs.existsSync(manifestPath)) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Boolean(manifest && manifest.name === 'traffic-one');
  } catch {
    return false;
  }
}

// A generated/installed plugin tree rooted at `base`: hook-runtime + a
// plugin manifest named traffic-one. Covers both the legacy root layout (base =
// repo root) and the current dist/ layout (base = <repo>/dist).
function hasGeneratedPluginTree(base: string): boolean {
  const hookRuntime = path.join(base, 'scripts', 'hook-runtime.cjs');
  if (!fs.existsSync(hookRuntime)) return false;
  const claudeManifest = path.join(base, '.claude-plugin', 'plugin.json');
  const codexManifest = path.join(base, '.codex-plugin', 'plugin.json');
  return manifestNameIsTrafficOne(fs.existsSync(claudeManifest) ? claudeManifest : codexManifest);
}

// The plugin SOURCE repo: its TypeScript generator/build entries + package.json
// name. Layout-independent — it does NOT depend on where the build emits, so it
// keeps recognizing the repo after the generated output moved to dist/.
function hasPluginSourceTree(root: string): boolean {
  try {
    const pkgPath = path.join(root, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const hasSourceEntry = fs.existsSync(path.join(root, 'src', 'gen', 'index.ts'))
      || fs.existsSync(path.join(root, 'src', 'build', 'build-runtime.ts'));
    if (!hasSourceEntry) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return Boolean(pkg && pkg.name === 'traffic-one');
  } catch {
    return false;
  }
}

export function hasPluginAuthoringMarkers(root: string): boolean {
  return hasPluginSourceTree(root)
    || hasGeneratedPluginTree(root)
    || hasGeneratedPluginTree(path.join(root, 'dist'));
}

// Mirrors MAX_ROOT_WALK in hook-paths.ts: a hook never spends unbounded fs
// reads climbing toward /.
const MAX_AUTHORING_WALK = 40;

// Hooks are one process per event, but Cursor's fan-out runs many handlers per
// process and each guard probes ~3 paths per level — memoize per start dir.
const authoringRootMemo = new Map<string, string | null>();

// Test helper: forget memoized lookups (tmp fixtures reuse paths).
export function resetAuthoringRootCache(): void {
  authoringRootMemo.clear();
}

// Nearest ancestor (or `start` itself; file or dir path) that is the plugin
// authoring repo / a generated plugin tree. Stops at $HOME (exclusive) and the
// filesystem root. Returns null when `start` is not inside any authoring root.
export function findAuthoringRootContaining(start: string): string | null {
  const resolved = path.resolve(start);
  const cached = authoringRootMemo.get(resolved);
  if (cached !== undefined) return cached;

  let home = '';
  try { home = path.resolve(os.homedir()); } catch { /* no home → MAX-capped walk */ }
  const installedRoot = path.resolve(pluginRoot());

  let current = resolved;
  let found: string | null = null;
  for (let i = 0; i < MAX_AUTHORING_WALK; i += 1) {
    if (home && current === home) break; // $HOME is machine config space, never the repo
    if (current === installedRoot || hasPluginAuthoringMarkers(current)) {
      found = current;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }
  authoringRootMemo.set(resolved, found);
  return found;
}

// `p` is the plugin authoring repo, inside it, or inside a generated plugin tree.
export function isInsidePluginAuthoringRoot(p: string): boolean {
  return findAuthoringRootContaining(p) !== null;
}

export function isPluginAuthoringRoot(cwd: string): boolean {
  return isInsidePluginAuthoringRoot(cwd);
}

// Machine-config space is never an end-user project: $HOME itself, the
// filesystem root, and the machine-wide state dir (~/.traffic-one or
// $XDG_STATE_HOME/traffic-one) including anything inside it. Without this, a
// session whose cwd is $HOME (an editor opened with no folder) onboards home as
// an "existing codebase" and materializes the project tree INTO the machine
// dir — <$HOME>/.traffic-one IS ~/.traffic-one — interleaving project
// artifacts (.one.json, manifest.json, rules/, skills/) with machine state.
// Symlink-resolved compare (best-effort): macOS spells the same dir /var/… and
// /private/var/…, and a symlinked $HOME must not dodge the guard on spelling.
function realResolve(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// Host and tooling STATE directories under $HOME. These hold the editor's own
// data — sessions, plans, plugin caches, per-user config — and are never an
// end-user project. Without this, merely NAMING one of these paths in a
// read-only tool call adopts it as an un-onboarded project and the gate demands
// onboarding for the host's own state. Observed live: Claude Code could not
// write its plan file (it lives in ~/.claude/plans), and a worker reading a
// Codex rollout under ~/.codex/sessions was handed the setup question as tool
// output. Adding a host is one line here; XDG overrides are honoured too.
const HOME_STATE_DIRNAMES = [
  '.claude',
  '.codex',
  '.cursor',
  '.opencode',
  '.kilo',
  '.kilocode',
  '.windsurf',
  '.devin',
  '.config',
  '.local',
  'Library',
] as const;

function homeStateRoots(home: string): string[] {
  const roots = HOME_STATE_DIRNAMES.map((name) => path.join(home, name));
  for (const key of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME'] as const) {
    const value = process.env[key];
    if (value) roots.push(value);
  }
  return roots;
}

function isInsideOrEqualRoot(resolved: string, root: string): boolean {
  const real = realResolve(root);
  return resolved === real || resolved.startsWith(real + path.sep);
}

export function isMachineConfigRoot(p: string): boolean {
  const resolved = realResolve(p);
  if (resolved === path.parse(resolved).root) return true; // filesystem root
  let home = '';
  try { home = realResolve(os.homedir()); } catch { /* no home */ }
  if (home && resolved === home) return true;
  const envHome = process.env.HOME ? realResolve(process.env.HOME) : '';
  if (envHome && resolved === envHome) return true;
  for (const base of [home, envHome]) {
    if (!base) continue;
    for (const root of homeStateRoots(base)) {
      if (isInsideOrEqualRoot(resolved, root)) return true;
    }
  }
  // System temp ROOTS are shared scratch space, never a project root themselves:
  // a stray `.traffic-one` minted into a /tmp-family dir (a scratch write with a
  // temp cwd) must not make every later temp-path hook adopt e.g. /private/tmp
  // as an onboarded project (the stale-bootstrap incident: reads of harness
  // task-output files re-served the use-plugin question from that root).
  // EXACT roots only — a real (or test) project in a temp SUBDIRECTORY stays
  // fully eligible.
  for (const tmp of [safeTmpDir(), '/tmp', '/private/tmp', '/var/tmp']) {
    if (tmp && resolved === realResolve(tmp)) return true;
  }
  const globalDir = realResolve(globalTrafficOneDir());
  return resolved === globalDir || resolved.startsWith(globalDir + path.sep);
}

function safeTmpDir(): string {
  try { return os.tmpdir(); } catch { return ''; }
}

// The single stand-down predicate for "never treat this dir as an end-user
// project": machine-config space, the plugin's own repo, or a generated plugin
// tree. Every gate/materializer/state writer that adopts a project root guards
// on this — not on isPluginAuthoringRoot alone.
export function isNonProjectRoot(cwd: string): boolean {
  return isMachineConfigRoot(cwd) || isInsidePluginAuthoringRoot(cwd);
}
