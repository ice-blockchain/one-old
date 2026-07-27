// Resolve whether a tool call that starts inside Traffic One's own source/cache
// is still confined to that non-project space. A raw-cwd-only stand-down is
// unsafe: an absolute target or an explicit external workdir can point at a real
// end-user project. Conversely, a child running inside the plugin source must be
// allowed to inspect the source without first creating project run state.

import * as fs from 'fs';
import * as path from 'path';

import type { Ctx } from '../core/types';
import { parseApplyPatch, patchOperationPaths, patchTextFromToolInput } from './apply-patch';
import { isNonProjectRoot } from './authoring-root';
import { isPathWithin, resolveProjectRoot } from './hook-paths';
import { obj } from './obj';
import { commandFromToolInput, normalizedToolName, parsedToolInput } from './tool-classify';

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export interface ToolScopeTarget {
  path: string;
  directoryHint: boolean;
  source: 'workdir' | 'file-input' | 'patch' | 'command';
}

export interface ToolScopeResolution {
  rawCwd: string;
  base: string;
  targets: ToolScopeTarget[];
  externalTargets: ToolScopeTarget[];
  unresolvedWriteTargets: string[];
  projectRoot: string;
  standsDown: boolean;
}

const PATH_FIELDS = [
  'file_path',
  'filePath',
  'path',
  'target',
  'target_path',
  'targetPath',
  'directory',
  'dir',
  'root',
  'projectRoot',
  'project_root',
] as const;

const DIRECTORY_FIELDS = new Set([
  'directory',
  'dir',
  'root',
  'projectRoot',
  'project_root',
]);

const ARRAY_PATH_FIELDS = ['paths', 'files', 'allowedFiles', 'allowed_files'] as const;

// Command text is intentionally not parsed as a complete shell language. We
// only need immutable path evidence before a tool runs. This recognizer finds
// absolute POSIX/Windows paths in plain, quoted, option-assignment, redirect,
// and nested `sh -lc "..."` forms without evaluating expansions.
const COMMAND_ABSOLUTE_PATH_RE = /(?:^|[\s"'`=(:,\[])(\/(?!\/)[^\s"'`;|&<>,)\]}]+|[A-Za-z]:[\\/][^\s"'`;|&<>,)\]}]+)/g;
const COMMAND_RELATIVE_PATH_RE = /(?:^|[\s"'`=(:,\[])(\.{1,2}[\\/][^\s"'`;|&<>,)\]}]+)/g;
const COMMAND_PWD_PATH_RE = /(?:^|[\s"'`=(:,\[])(\$(?:\{PWD\}|PWD(?=[\\/]|$))[^\s"'`;|&<>,)\]}]*)/g;
const DIRECTORY_COMMAND_RE = /(?:^|[\s;&|"'(])(?:cd|pushd|git\s+-C|npm\s+--prefix|pnpm\s+(?:--dir|-C)|yarn\s+--cwd|bun\s+--cwd)\s+(?:--\s+)?["']?([^\s"';&|]+)/g;
const COPY_MOVE_RE = /(?:^|[\s;&|"'(])(?:cp|mv|install|ln|rsync)\s+(?:-[^\s]+\s+)*(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+("[^"]*"|'[^']*'|[^\s;&|]+)/g;
const DIRECT_WRITE_RE = /(?:^|[\s;&|"'(])(touch|mkdir|tee|rm|rmdir|unlink|truncate)\s+(?:-[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|><]+))/g;
const WRITE_REDIRECT_RE = /(?:^|[\s])(?:\d*)>>?\s*(?!&)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
const SHELL_WRITE_SIGNAL_RE = /(?:^|[\s;&|"'(])(?:touch|mkdir|tee|rm|rmdir|unlink|truncate|cp|mv|install|ln|rsync)\b|(?:^|[\s])(?:\d*)>>?\s*(?!&)/;
const TRUSTED_PWD_RE = /(^|[^\\])\$(?:\{PWD\}|PWD(?=[\\/]|$))/g;

function normalizeCommandCandidate(value: string): string {
  return value
    .replace(/\\ /g, ' ')
    .replace(/^["'`>]+|["'`,;]+$/g, '')
    .replace(/[.:]+$/g, '');
}

function isIgnoredSystemCommandPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, '/');
  return normalized === '/dev/null'
    || normalized.startsWith('/dev/')
    || normalized.startsWith('/proc/')
    || normalized.startsWith('/sys/')
    || /^(?:\/usr)?\/(?:s?bin|libexec)\/[^/]+$/.test(normalized)
    || /^\/opt\/homebrew\/(?:bin|sbin)\/[^/]+$/.test(normalized);
}

function isDiscardRedirect(candidate: string): boolean {
  return candidate.replace(/\\/g, '/') === '/dev/null';
}

function expandTrustedPwd(candidate: string, base: string): string {
  return candidate.replace(TRUSTED_PWD_RE, (_match, prefix: string) => `${prefix}${base}`);
}

function commandCandidate(value: string, base: string): { value: string; unresolved: boolean } {
  const normalized = normalizeCommandCandidate(value);
  if (!normalized) return { value: '', unresolved: false };
  const expanded = expandTrustedPwd(normalized, base);
  return {
    value: expanded,
    unresolved: expanded.includes('$') || expanded.includes('`'),
  };
}

interface CommandTargetScan {
  targets: ToolScopeTarget[];
  unresolvedWriteTargets: string[];
}

function commandTargets(command: string, base: string): CommandTargetScan {
  if (!command) return { targets: [], unresolvedWriteTargets: [] };
  const unresolvedWriteTargets: string[] = [];
  const writeSignaled = SHELL_WRITE_SIGNAL_RE.test(command);
  const directoryPaths = new Set<string>();
  const directoryTargets: ToolScopeTarget[] = [];
  let directoryMatch: RegExpExecArray | null;
  DIRECTORY_COMMAND_RE.lastIndex = 0;
  while ((directoryMatch = DIRECTORY_COMMAND_RE.exec(command))) {
    const parsed = commandCandidate(directoryMatch[1] || '', base);
    const candidate = parsed.value;
    if (parsed.unresolved) {
      if (writeSignaled) unresolvedWriteTargets.push(normalizeCommandCandidate(directoryMatch[1] || ''));
      continue;
    }
    if (!candidate || candidate.startsWith('-') || candidate.includes('://')) continue;
    const normalized = path.isAbsolute(candidate) ? path.resolve(candidate) : candidate;
    directoryPaths.add(normalized);
    directoryTargets.push({
      path: normalized,
      directoryHint: true,
      source: 'command',
    });
  }

  // Keep explicit directory transitions even when they are relative. They are
  // resolved against the raw tool base later, which makes
  // `cd ../external-project && ...` visible before stand-down is decided.
  const targets: ToolScopeTarget[] = [...directoryTargets];
  let match: RegExpExecArray | null;
  // `$PWD` / `${PWD}` is the one shell variable whose value is already
  // authenticated by this invocation's cwd/workdir. Resolve it without reading
  // process.env (which can be stale/spoofed), then feed the literal path through
  // the same project-boundary logic as every other command operand.
  COMMAND_PWD_PATH_RE.lastIndex = 0;
  while ((match = COMMAND_PWD_PATH_RE.exec(command))) {
    const parsed = commandCandidate(match[1] || '', base);
    if (!parsed.value || parsed.unresolved || parsed.value.includes('://')) continue;
    const candidate = path.isAbsolute(parsed.value) ? path.resolve(parsed.value) : parsed.value;
    if (isIgnoredSystemCommandPath(candidate)) continue;
    targets.push({
      path: candidate,
      directoryHint: directoryPaths.has(candidate),
      source: 'command',
    });
  }
  COMMAND_ABSOLUTE_PATH_RE.lastIndex = 0;
  while ((match = COMMAND_ABSOLUTE_PATH_RE.exec(command))) {
    const parsed = commandCandidate(match[1] || '', base);
    const candidate = parsed.value;
    if (!candidate || parsed.unresolved || candidate.includes('://')) continue;
    const absolute = path.resolve(candidate);
    if (isIgnoredSystemCommandPath(absolute)) continue;
    targets.push({
      path: absolute,
      directoryHint: directoryPaths.has(absolute),
      source: 'command',
    });
  }
  // Any literal ./ or ../ operand is relevant scope evidence regardless of the
  // executable name. This closes authoring-root escapes through less common
  // writers (rm/sed/install/custom scripts) without attempting shell expansion.
  COMMAND_RELATIVE_PATH_RE.lastIndex = 0;
  while ((match = COMMAND_RELATIVE_PATH_RE.exec(command))) {
    const parsed = commandCandidate(match[1] || '', base);
    const candidate = parsed.value;
    if (!candidate || parsed.unresolved || candidate.includes('://')) continue;
    targets.push({
      path: candidate,
      directoryHint: directoryPaths.has(candidate),
      source: 'command',
    });
  }
  // `cp`/`mv` are the important two-path exception: the first operand can be a
  // generated/read-only asset outside the project while the final operand is
  // the actual write target. Capture that final operand even when it is
  // relative, and append it after generic absolute-path evidence so project
  // resolution prefers the destination.
  let copyMoveMatch: RegExpExecArray | null;
  COPY_MOVE_RE.lastIndex = 0;
  while ((copyMoveMatch = COPY_MOVE_RE.exec(command))) {
    const rawDestination = normalizeCommandCandidate(copyMoveMatch[1] || '');
    const parsed = commandCandidate(rawDestination, base);
    const destination = parsed.value;
    if (parsed.unresolved) {
      if (rawDestination) unresolvedWriteTargets.push(rawDestination);
    } else if (destination && !destination.startsWith('-') && !destination.includes('://')) {
      targets.push({ path: destination, directoryHint: false, source: 'command' });
    }
  }
  // Direct shell writers and redirects are the other important relative-path
  // escape. `$PWD` is resolved from the authenticated tool base; every other
  // expansion in a recognized write target remains unverifiable and is
  // returned to the caller for a fail-closed decision.
  let directWriteMatch: RegExpExecArray | null;
  DIRECT_WRITE_RE.lastIndex = 0;
  while ((directWriteMatch = DIRECT_WRITE_RE.exec(command))) {
    const commandName = directWriteMatch[1] || '';
    const rawCandidate = normalizeCommandCandidate(
      directWriteMatch[2] || directWriteMatch[3] || directWriteMatch[4] || '',
    );
    const parsed = commandCandidate(rawCandidate, base);
    const candidate = parsed.value;
    if (parsed.unresolved) {
      if (rawCandidate) unresolvedWriteTargets.push(rawCandidate);
    } else if (candidate && !candidate.startsWith('-') && !candidate.includes('://')) {
      targets.push({
        path: candidate,
        directoryHint: commandName === 'mkdir',
        source: 'command',
      });
    }
  }
  let redirectMatch: RegExpExecArray | null;
  WRITE_REDIRECT_RE.lastIndex = 0;
  while ((redirectMatch = WRITE_REDIRECT_RE.exec(command))) {
    const rawCandidate = normalizeCommandCandidate(
      redirectMatch[1] || redirectMatch[2] || redirectMatch[3] || '',
    );
    const parsed = commandCandidate(rawCandidate, base);
    const candidate = parsed.value;
    if (parsed.unresolved) {
      if (rawCandidate) unresolvedWriteTargets.push(rawCandidate);
    } else if (
      candidate
      && !candidate.startsWith('&')
      && !candidate.includes('://')
      && !isDiscardRedirect(candidate)
    ) {
      targets.push({ path: candidate, directoryHint: false, source: 'command' });
    }
  }
  return {
    targets,
    unresolvedWriteTargets: [...new Set(unresolvedWriteTargets)],
  };
}

function addTarget(
  out: ToolScopeTarget[],
  value: unknown,
  source: ToolScopeTarget['source'],
  directoryHint = false,
): void {
  const target = stringValue(value);
  if (!target || target.startsWith('-') || target.includes('$') || target.includes('://')) return;
  out.push({ path: target, directoryHint, source });
}

function explicitToolTargets(
  ctx: Ctx,
): { base: string; targets: ToolScopeTarget[]; unresolvedWriteTargets: string[] } {
  const raw = obj(ctx.input.raw) || {};
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || obj(raw.input)
    || parsedToolInput(ctx.input.tool) || {};
  const workdir = ctx.input.tool?.workdir
    || stringValue(toolInput.workdir ?? toolInput.working_dir ?? toolInput.workingDir ?? toolInput.cwd);
  const base = workdir
    ? (path.isAbsolute(workdir) ? path.resolve(workdir) : path.resolve(ctx.cwd, workdir))
    : path.resolve(ctx.cwd);
  const targets: ToolScopeTarget[] = [];

  if (workdir) addTarget(targets, workdir, 'workdir', true);
  addTarget(targets, ctx.input.tool?.filePath, 'file-input');
  for (const field of PATH_FIELDS) {
    addTarget(targets, toolInput[field], 'file-input', DIRECTORY_FIELDS.has(field));
  }
  for (const field of ARRAY_PATH_FIELDS) {
    const value = toolInput[field];
    if (!Array.isArray(value)) continue;
    for (const item of value) addTarget(targets, item, 'file-input');
  }

  const rawName = normalizedToolName(ctx.input.tool?.rawName || raw.tool_name || raw.toolName);
  if (/^apply_patch$/i.test(rawName)) {
    const patchText = patchTextFromToolInput(
      ctx.input.tool?.patchText,
      raw.tool_input,
      raw.toolInput,
      raw.input,
      raw,
      toolInput,
    );
    const parsed = parseApplyPatch(patchText);
    if (parsed.ok) {
      for (const target of patchOperationPaths(parsed.operations)) addTarget(targets, target, 'patch');
    }
  }

  const command = ctx.input.tool?.command || commandFromToolInput(toolInput);
  const commandScan = commandTargets(command, base);
  targets.push(...commandScan.targets);
  return { base, targets, unresolvedWriteTargets: commandScan.unresolvedWriteTargets };
}

function absoluteTarget(base: string, target: ToolScopeTarget): ToolScopeTarget {
  return {
    ...target,
    path: path.isAbsolute(target.path) ? path.resolve(target.path) : path.resolve(base, target.path),
  };
}

function targetIsNonProject(target: ToolScopeTarget): boolean {
  if (target.directoryHint) return isNonProjectRoot(target.path);
  try {
    if (fs.statSync(target.path).isDirectory()) return isNonProjectRoot(target.path);
  } catch {
    // A not-yet-created file is classified from its owning directory.
  }
  return isNonProjectRoot(path.dirname(target.path));
}

function targetStart(target: ToolScopeTarget): string {
  if (target.directoryHint) return target.path;
  try {
    return fs.statSync(target.path).isDirectory() ? target.path : path.dirname(target.path);
  } catch {
    return path.dirname(target.path);
  }
}

/**
 * Resolve a pre-tool call against both its raw cwd and every explicit path
 * carried by the host. When a hook runs inside the plugin source but points at
 * a real project, the external target becomes the resolution anchor; an
 * unrelated host workspace ceiling is deliberately not applied across that
 * boundary.
 */
export function resolveToolScope(ctx: Ctx): ToolScopeResolution {
  const rawCwd = path.resolve(ctx.cwd);
  const { base, targets: relativeTargets, unresolvedWriteTargets } = explicitToolTargets(ctx);
  const targets = relativeTargets.map((target) => absoluteTarget(base, target));
  const externalTargets = targets.filter((target) => !targetIsNonProject(target));
  const standsDown = isNonProjectRoot(rawCwd)
    && isNonProjectRoot(base)
    && externalTargets.length === 0
    && unresolvedWriteTargets.length === 0;

  const preferred = [...externalTargets].reverse().find((target) => target.source !== 'command')
    || [...externalTargets].reverse()[0];
  if (!preferred) {
    const filePath = ctx.input.tool?.filePath;
    return {
      rawCwd,
      base,
      targets,
      externalTargets,
      unresolvedWriteTargets,
      projectRoot: resolveProjectRoot(rawCwd, filePath, { ceiling: ctx.input.workspaceRoot }),
      standsDown,
    };
  }

  const start = targetStart(preferred);
  // A normal relative target inside the tool's cwd/workdir must not turn its
  // parent directory (for example `<project>/src`) into a synthetic project
  // root before onboarding state exists. Re-anchor only when the target truly
  // crosses out of the tool base (notably plugin-source cwd -> user project).
  const resolutionCwd = isPathWithin(start, base) ? base : start;
  const workspaceRoot = ctx.input.workspaceRoot && isPathWithin(start, ctx.input.workspaceRoot)
    ? ctx.input.workspaceRoot
    : undefined;
  return {
    rawCwd,
    base,
    targets,
    externalTargets,
    unresolvedWriteTargets,
    projectRoot: resolveProjectRoot(resolutionCwd, preferred.path, { ceiling: workspaceRoot }),
    standsDown,
  };
}

/**
 * True only when the raw cwd is a non-project root and every explicit target or
 * workdir remains in non-project space. Any target in a real project disables
 * stand-down so normal auth/model/plan enforcement evaluates that target.
 */
export function toolScopeStandsDown(ctx: Ctx): boolean {
  return resolveToolScope(ctx).standsDown;
}

export function resolveToolProjectRoot(ctx: Ctx): string {
  return resolveToolScope(ctx).projectRoot;
}

export function toolScopeTargets(ctx: Ctx): ToolScopeTarget[] {
  return resolveToolScope(ctx).targets;
}
