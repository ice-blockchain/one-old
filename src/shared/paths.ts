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

const PROJECT_MARKERS = [
  path.join('.traffic-one', '.one.json'),
  '.traffic-one',
  'package.json',
  'go.mod',
  'pyproject.toml',
  'Cargo.toml',
  'deno.json',
  'deno.jsonc',
  'bun.lockb',
  'pnpm-lock.yaml',
  '.git',
];

function isInsideOrEqual(candidate: string, boundary: string): boolean {
  const rel = path.relative(boundary, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function existingDirectoryForHint(absPath: string): string {
  let current = absPath;
  try {
    if (!fs.existsSync(current) || !fs.lstatSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }
  return current;
}

function findUp(startDir: string, boundary?: string): string | null {
  let dir = startDir;
  for (;;) {
    if (boundary && !isInsideOrEqual(dir, boundary)) return null;
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

function safeRealpath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function hostBoundary(cwd: string): string {
  return safeRealpath(path.resolve(cwd));
}

function candidateRootFromHint(cwd: string, hint: string, boundary: string, baseDir = cwd): string | null {
  const raw = String(hint || '').trim();
  if (!raw || raw.startsWith('-') || raw.includes('://') || raw.includes('$')) return null;
  const cleaned = raw.replace(/^["'`]+|["'`,;]+$/g, '').replace(/\\ /g, ' ');
  if (!cleaned || cleaned.startsWith('-') || cleaned.includes('://') || cleaned.includes('$')) return null;
  const abs = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(baseDir, cleaned);
  const resolved = safeRealpath(existingDirectoryForHint(abs));
  if (!isInsideOrEqual(resolved, boundary)) return null;
  return findUp(resolved, boundary);
}

function promptPathHints(prompt: unknown, cwd: string): string[] {
  const text = typeof prompt === 'string' ? prompt : '';
  if (!text) return [];
  const hints: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) return;
    const abs = path.resolve(cwd, trimmed);
    try {
      if (fs.existsSync(abs) && fs.lstatSync(abs).isDirectory()) {
        seen.add(trimmed);
        hints.push(trimmed);
      }
    } catch {
      // ignore bad prompt hints
    }
  };

  const quoted = /\b(?:in|inside|under|within|for)\s+["'`]([^"'`]+)["'`]/gi;
  for (const match of text.matchAll(quoted)) add(match[1] || '');

  const bare = /\b(?:in|inside|under|within|for)\s+((?:\.{1,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*)(?=$|[\s,.;:!?])/gi;
  for (const match of text.matchAll(bare)) add(match[1] || '');
  return hints;
}

export function projectRoot(input: HookInput): string {
  const cwd = path.resolve(input.cwd || process.cwd());
  const boundary = hostBoundary(cwd);
  const workdirRoot = input.tool?.workdir
    ? candidateRootFromHint(cwd, input.tool.workdir, boundary)
    : null;
  if (workdirRoot) return workdirRoot;

  const fileBase = input.tool?.workdir && !path.isAbsolute(input.tool.workdir)
    ? path.resolve(cwd, input.tool.workdir)
    : input.tool?.workdir || cwd;
  const fileRoot = input.tool?.filePath
    ? candidateRootFromHint(cwd, input.tool.filePath, boundary, fileBase)
    : null;
  if (fileRoot) return fileRoot;

  for (const hint of promptPathHints(input.prompt, cwd)) {
    const promptRoot = candidateRootFromHint(cwd, hint, boundary);
    if (promptRoot) return promptRoot;
  }

  return findUp(boundary, boundary) ?? cwd;
}

export function stateFile(root: string): string {
  return path.join(root, '.traffic-one', '.one.json');
}

export const paths: Paths = { pluginRoot, projectRoot, stateFile };
