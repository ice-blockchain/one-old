// src/shared/authoring-root.ts
// Detects the plugin's OWN repo so the gate/materialiser never act on it.
// Ported from scripts/hook-runtime/materialize/{isPluginAuthoringRoot,_helpers}.cjs
// with the hook-runtime marker re-pointed to the surviving entry (scripts/
// hook-runtime.cjs) instead of the legacy handlers/handlers.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { pluginRoot } from './paths';

export function hasPluginAuthoringMarkers(root: string): boolean {
  try {
    const claudeManifest = path.join(root, '.claude-plugin', 'plugin.json');
    const codexManifest = path.join(root, '.codex-plugin', 'plugin.json');
    const hookRuntime = path.join(root, 'scripts', 'hook-runtime.cjs');
    const authScript = path.join(root, 'scripts', 'traffic-one-auth.cjs');
    if (!fs.existsSync(hookRuntime) || !fs.existsSync(authScript)) return false;
    const manifestPath = fs.existsSync(claudeManifest) ? claudeManifest : codexManifest;
    if (!fs.existsSync(manifestPath)) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return Boolean(manifest && manifest.name === 'traffic-one');
  } catch {
    return false;
  }
}

export function isPluginAuthoringRoot(cwd: string): boolean {
  const root = path.resolve(cwd);
  return root === path.resolve(pluginRoot()) || hasPluginAuthoringMarkers(root);
}
