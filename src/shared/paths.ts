// src/shared/paths.ts
// The ONE path layer. pluginRoot resolves the repo/install root (env override →
// __dirname), and the same relative depth holds whether running from src/shared
// (tsx dev) or scripts/shared (compiled). projectRoot is hint-aware: it prefers
// the directory of a tool's target file (PostToolUse materialisation derives the
// project from the edited path, not cwd).

import * as fs from 'fs';
import * as path from 'path';

import type { HookInput, Paths } from '../core/types';

const PLUGIN_ROOT_ENV = [
  'TRAFFIC_ONE_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
  'CURSOR_PLUGIN_ROOT',
] as const;

export function pluginRoot(): string {
  for (const key of PLUGIN_ROOT_ENV) {
    const value = process.env[key];
    if (value) return value;
  }
  // src/shared/paths.ts → ../../ = repo root; scripts/shared/paths.js → ../../ = repo root.
  return path.resolve(__dirname, '..', '..');
}

export function isManagedPluginCachePath(root: string): boolean {
  return [
    `${path.sep}.claude${path.sep}plugins${path.sep}cache${path.sep}`,
    `${path.sep}.codex${path.sep}plugins${path.sep}cache${path.sep}`,
  ].some((marker) => root.includes(marker));
}

export function isInPluginCache(): boolean {
  return isManagedPluginCachePath(pluginRoot());
}

const PROJECT_MARKERS = ['.git', 'package.json', '.traffic-one', path.join('.traffic-one', '.one.json')];

function findUp(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    for (const marker of PROJECT_MARKERS) {
      try {
        if (fs.existsSync(path.join(dir, marker))) return dir;
      } catch {
        // ignore and keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function projectRoot(input: HookInput): string {
  const hint = input.tool?.filePath
    ? path.dirname(path.resolve(input.cwd, input.tool.filePath))
    : input.cwd;
  return findUp(hint) ?? findUp(input.cwd) ?? input.cwd;
}

export function stateFile(root: string): string {
  return path.join(root, '.traffic-one', '.one.json');
}

export const paths: Paths = { pluginRoot, projectRoot, stateFile };
