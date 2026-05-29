// src/modules/materialize/post-helpers.ts
// Path/detection helpers for the PostToolUse dispatcher: resolve the project
// root a tool write targets (from file/command hints or a state-file path), and
// classify project-memory writes. Pure (fs reads only). Ported 1:1 from
// post.cjs + _helpers.cjs. The materialize-from-write convergence + the handler
// assembly land next.

import * as fs from 'fs';
import * as path from 'path';

import { hasStateFile } from '../../shared/tool-classify';

type Rec = Record<string, unknown>;

// PostToolUse dispatch route patterns.
export const FUNCTION_PATH_RE = /\/supabase\/functions\/([^/]+)\/(index|deno)\.(ts|tsx|mts|js)$/;
export const DIGEST_PATH_RE = /(?:^|\/)\.traffic-one\/digests\/[^/]+\/(architect|frontend|backend|reviewer|tester|shipper)\.md$/;
export const DIGEST_HARD_BYTES = 3 * 1024; // warn over 3 KB; target is ≤2 KB

export const PROJECT_ROOT_HINT_FIELDS = ['file_path', 'path', 'cwd', 'workdir'];
export const PROJECT_COMMAND_HINT_FIELDS = ['command', 'cmd', 'shell_command'];
export const PROJECT_PATH_TOKEN_RE = /(?:^|[\s"'`=])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.@-]+\/)+(?:[A-Za-z0-9_.@-]+)?)(?=$|[\s"'`,;|&])/g;

// Walk up from a path hint to the nearest dir that carries a .traffic-one state
// file. Returns null for flags, URLs, var-expansions, or no enclosing project.
export function projectRootForPathHint(cwd: string, hintPath: unknown): string | null {
  const raw = String(hintPath || '').trim();
  if (!raw || raw.startsWith('-') || raw.includes('://')) return null;

  const cleaned = raw.replace(/^["'`]+|["'`,;]+$/g, '').replace(/\\ /g, ' ');
  if (!cleaned || cleaned.startsWith('-') || cleaned.includes('$')) return null;

  const absPath = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);

  let current = absPath;
  if (!fs.existsSync(current) || !fs.lstatSync(current).isDirectory()) {
    current = path.dirname(current);
  }
  for (;;) {
    if (hasStateFile(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// All distinct project roots referenced by a tool input's path/command hints.
export function projectRootsFromToolInputHints(cwd: string, toolInput: unknown): string[] {
  const ti = toolInput && typeof toolInput === 'object' ? (toolInput as Rec) : {};
  const roots = new Set<string>();
  const addHint = (hint: unknown): void => {
    const root = projectRootForPathHint(cwd, hint);
    if (root) roots.add(root);
  };
  for (const field of PROJECT_ROOT_HINT_FIELDS) {
    if (typeof ti[field] === 'string') addHint(ti[field]);
  }
  for (const field of PROJECT_COMMAND_HINT_FIELDS) {
    const command = typeof ti[field] === 'string' ? (ti[field] as string) : '';
    if (!command) continue;
    for (const match of command.matchAll(PROJECT_PATH_TOKEN_RE)) addHint(match[1]);
  }
  return [...roots];
}

// The project root that owns a `.traffic-one/.one.json` (or its parent dir).
export function projectRootFromStateFilePath(filePath: string): string {
  const absolute = path.resolve(filePath);
  const parent = path.dirname(absolute);
  if (path.basename(absolute) === '.one.json' && path.basename(parent) === '.traffic-one') {
    return path.dirname(parent);
  }
  return parent;
}

// True for writes into .traffic-one/ project memory (NOT digests/reports/backups/
// rules/skills/manifest — those are generated, not user memory).
export function isProjectMemoryWritePath(relativePath: unknown): boolean {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.startsWith('.traffic-one/')) return false;
  if (normalized.startsWith('.traffic-one/digests/')) return false;
  if (normalized.startsWith('.traffic-one/reports/')) return false;
  if (normalized.startsWith('.traffic-one/backups/')) return false;
  if (normalized.startsWith('.traffic-one/rules/')) return false;
  if (normalized.startsWith('.traffic-one/skills/')) return false;
  return normalized !== '.traffic-one/manifest.json';
}
