// src/shared/authoring-root.ts
// Detects the plugin's OWN repo (or its generated tree) so the gate/materialiser
// never act on it. Two independent signals, so detection survives layout changes:
//   1. the SOURCE repo — identified by the TypeScript generator/build entries plus
//      package.json name (independent of where the build emits), and
//   2. a GENERATED plugin tree — hook-runtime + auth shim + a plugin manifest named
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

function manifestNameIsTrafficOne(manifestPath: string): boolean {
  try {
    if (!fs.existsSync(manifestPath)) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Boolean(manifest && manifest.name === 'traffic-one');
  } catch {
    return false;
  }
}

// A generated/installed plugin tree rooted at `base`: hook-runtime + auth shim + a
// plugin manifest named traffic-one. Covers both the legacy root layout (base =
// repo root) and the current dist/ layout (base = <repo>/dist).
function hasGeneratedPluginTree(base: string): boolean {
  const hookRuntime = path.join(base, 'scripts', 'hook-runtime.cjs');
  const authScript = path.join(base, 'scripts', 'traffic-one-auth.cjs');
  if (!fs.existsSync(hookRuntime) || !fs.existsSync(authScript)) return false;
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
