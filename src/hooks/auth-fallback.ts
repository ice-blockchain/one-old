import { fileURLToPath } from 'url';

import { asRecord, firstString } from '../adapters/coerce';
import { authRequiredMessage } from '../shared/auth';
import { isNonProjectRoot } from '../shared/authoring-root';
import { parseJson } from '../shared/fsjson';
import { isPathWithin, resolveProjectRoot } from '../shared/hook/paths';
import { pluginUseDeclined } from '../shared/state/plugin-use';

function workspaceRoots(value: unknown): string[] {
  const roots: string[] = [];
  const candidates = Array.isArray(value) ? value : [value];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const root of workspaceRoots(candidate)) {
        if (!roots.includes(root)) roots.push(root);
      }
      continue;
    }
    const item = asRecord(candidate);
    const raw = typeof candidate === 'string'
      ? candidate.trim()
      : firstString(item.path, item.uri, item.root);
    const root = normalizePath(raw);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

function normalizePath(value: string): string {
  if (!value.startsWith('file://')) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return '';
  }
}

export function fallbackCwd(stdin: string): string {
  const data = asRecord(parseJson<Record<string, unknown>>(stdin, {}));
  const input = asRecord(data.input ?? data.tool_info ?? data.toolInfo ?? data.toolArgs);
  const roots = workspaceRoots([
    input.workspaceRoot,
    data.projectRoot,
    data.root,
    data.workspace_roots
      ?? data.workspaceRoots
      ?? data.workspace_root
      ?? data.workspaceRoot
      ?? data.workspaceFolders,
  ]);
  const cwd = normalizePath(firstString(
    input.cwd,
    input.working_directory,
    input.workingDirectory,
    data.cwd,
  ));
  if (roots.length > 0) {
    const containing = cwd
      ? roots.filter((root) => isPathWithin(cwd, root)).sort((a, b) => b.length - a.length)[0]
      : '';
    return containing || roots[0] as string;
  }
  const start = cwd || process.cwd();
  return resolveProjectRoot(start);
}

export function hookFallbackStandsDown(
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cwd = fallbackCwd(stdin);
  return isNonProjectRoot(cwd) || pluginUseDeclined(cwd, env);
}

// Entry catch bodies must never throw: if stand-down itself throws, treat that
// as "does not stand down" and continue to the host's session-start / pre-tool
// fallbacks. An escaped exception here is exit 1, which is non-blocking on
// Claude/Codex/Windsurf — so a throw is an allow.
export function safeHookFallbackStandsDown(
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    return hookFallbackStandsDown(stdin, env);
  } catch {
    return false;
  }
}

// Hook crashes still fail closed for projects using Traffic One, but a durable
// pluginUse decline and non-project roots remain completely silent.
export function authFallbackMessage(
  stdin: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (safeHookFallbackStandsDown(stdin, env)) return '';
  try {
    return authRequiredMessage(env);
  } catch {
    return '';
  }
}
