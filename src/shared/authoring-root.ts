// src/shared/authoring-root.ts
// Detects the plugin's OWN repo (or its generated tree) so the gate/materialiser
// never act on it. Two independent signals, so detection survives layout changes:
//   1. the SOURCE repo — identified by the TypeScript generator/build entries plus
//      package.json name (independent of where the build emits), and
//   2. a GENERATED plugin tree — hook-runtime + auth shim + a plugin manifest named
//      traffic-one, which since the dist/ refactor lives under dist/ (older layouts
//      kept it at the repo root).

import * as fs from 'fs';
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

export function isPluginAuthoringRoot(cwd: string): boolean {
  const root = path.resolve(cwd);
  return root === path.resolve(pluginRoot()) || hasPluginAuthoringMarkers(root);
}
