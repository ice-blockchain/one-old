// PreToolUse deny for model-facing paths outside the active host workspace.
// Cursor supplies `workspace_roots`; when present, that boundary is the project
// sandbox for reads/searches/writes/spawn metadata. Project-root resolution uses
// the same boundary to avoid re-rooting, but it does not block the underlying
// tool call. This guard closes that gap.

import * as fs from 'fs';
import * as path from 'path';

import { asString } from '../../adapters/coerce';
import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { obj, type Rec } from '../../shared/obj';
import { normalizedToolName, parsedToolInput, patchTextFromToolInput, patchTouchedFiles } from '../../shared/tool-classify';

const DENY_PREFIX = 'traffic-one — workspace boundary blocked';

const PATH_FIELDS = [
  'file_path',
  'filePath',
  'path',
  'uri',
  'fsPath',
  'target',
  'target_path',
  'targetPath',
  'directory',
  'dir',
  'root',
  'projectRoot',
  'project_root',
] as const;

const WORKDIR_FIELDS = [
  'workdir',
  'working_dir',
  'workingDir',
  'working_directory',
  'cwd',
] as const;

const ARRAY_PATH_FIELDS = [
  'paths',
  'files',
  'allowedFiles',
  'allowed_files',
] as const;

function stripFileUri(value: string): string {
  return value.startsWith('file://') ? decodeURIComponent(value.slice('file://'.length)) : value;
}

function isInsideOrEqual(candidate: string, boundary: string): boolean {
  const rel = path.relative(path.resolve(boundary), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realpathClosest(absPath: string): string {
  const suffix: string[] = [];
  let current = path.resolve(absPath);
  for (;;) {
    try {
      if (fs.existsSync(current)) {
        return path.join(fs.realpathSync(current), ...suffix);
      }
    } catch {
      return path.resolve(absPath);
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(absPath);
    suffix.unshift(path.basename(current));
    current = parent;
  }
}

function addStringCandidate(out: string[], value: unknown): void {
  const text = asString(value).trim();
  if (!text || text.startsWith('-') || text.includes('$')) return;
  const stripped = stripFileUri(text.replace(/^["'`]+|["'`,;]+$/g, ''));
  if (!stripped || (stripped.includes('://') && !stripped.startsWith('file://'))) return;
  out.push(stripped);
}

function addCandidatesFromRecord(out: string[], rec: Rec | null, opts: { includeCwd: boolean; includeGlobPattern: boolean }): void {
  if (!rec) return;
  for (const field of PATH_FIELDS) addStringCandidate(out, rec[field]);
  for (const field of ARRAY_PATH_FIELDS) {
    const value = rec[field];
    if (Array.isArray(value)) {
      for (const item of value) addStringCandidate(out, item);
    }
  }
  for (const field of WORKDIR_FIELDS) {
    if (opts.includeCwd || field !== 'cwd') addStringCandidate(out, rec[field]);
  }
  if (opts.includeGlobPattern) addStringCandidate(out, rec.pattern);
}

function denyOutsideWorkspace(target: string, workspaceRoot: string): HookResult {
  return deny(`${DENY_PREFIX}: "${target}" is outside the active workspace "${workspaceRoot}". `
    + 'Open or switch to that workspace before reading, searching, writing, or delegating work there; sibling Traffic One projects are isolated.');
}

export function workspaceBoundaryGuard(ctx: Ctx): HookResult {
  const workspaceRoot = ctx.input.workspaceRoot ? realpathClosest(ctx.input.workspaceRoot) : '';
  if (!workspaceRoot) return noop();

  const raw = obj(ctx.input.raw) || {};
  const rawToolInput = obj(raw.tool_input) || obj(raw.toolInput) || obj(raw.input);
  const parsedInput = parsedToolInput(ctx.input.tool);
  const rawName = normalizedToolName(ctx.input.tool?.rawName || raw.tool_name || raw.toolName);
  const includeGlobPattern = /^Glob$/i.test(rawName);

  const candidates: string[] = [];
  addStringCandidate(candidates, ctx.input.tool?.filePath);
  addStringCandidate(candidates, ctx.input.tool?.workdir);
  addCandidatesFromRecord(candidates, raw, { includeCwd: false, includeGlobPattern });
  addCandidatesFromRecord(candidates, rawToolInput, { includeCwd: true, includeGlobPattern });
  addCandidatesFromRecord(candidates, parsedInput, { includeCwd: true, includeGlobPattern });
  candidates.push(...patchTouchedFiles(patchTextFromToolInput(rawToolInput || raw)));

  const base = ctx.input.tool?.workdir
    ? (path.isAbsolute(ctx.input.tool.workdir) ? ctx.input.tool.workdir : path.resolve(ctx.cwd, ctx.input.tool.workdir))
    : ctx.cwd;

  for (const candidate of candidates) {
    const abs = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(base, candidate);
    const real = realpathClosest(abs);
    if (!isInsideOrEqual(real, workspaceRoot)) {
      return denyOutsideWorkspace(real, workspaceRoot);
    }
  }

  return noop();
}
