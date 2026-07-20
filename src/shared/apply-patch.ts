// Canonical apply_patch input extraction, structural parsing, and in-memory
// reconstruction. Every hook adapter and write gate uses this module so path
// discovery and content validation cannot drift between hosts.

import * as fs from 'fs';
import * as path from 'path';

type Rec = Record<string, unknown>;

export type PatchOperationKind = 'add' | 'update' | 'delete' | 'move';

export interface PatchFileOperation {
  kind: PatchOperationKind;
  path: string;
  destinationPath?: string;
  addedContent: string;
  resultContent?: string;
}

export type ApplyPatchParseResult =
  | { ok: true; operations: PatchFileOperation[] }
  | { ok: false; error: string };

export interface ApplyPatchParseOptions {
  // When omitted, parsing is structural only. When supplied, Add/Update/Delete/
  // Move are validated against the current filesystem and resultContent is
  // reconstructed for every operation that leaves a file behind.
  baseDir?: string;
}

interface ParsedHunkLine {
  mode: 'context' | 'add' | 'delete';
  text: string;
}

interface ParsedHunk {
  anchor: string;
  oldStart: number | null;
  eof: boolean;
  lines: ParsedHunkLine[];
}

interface StructuralOperation {
  kind: PatchOperationKind;
  path: string;
  destinationPath?: string;
  addedContent: string;
  addContent?: string;
  hunks?: ParsedHunk[];
}

const PATCH_VALUE_KEYS = [
  'patch',
  'patchText',
  'patch_text',
  'diff',
  'input',
  'content',
  'command',
  'text',
] as const;

const PATCH_NESTED_KEYS = [
  'tool_input',
  'toolInput',
  'args',
  'arguments',
  'output',
  'tool',
] as const;

function isRecord(value: unknown): value is Rec {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeApplyPatch(text: string): boolean {
  return /^\s*\*\*\* Begin Patch(?:\r?\n|$)/.test(text)
    || /^\*\*\* (?:Add|Update|Delete) File:/m.test(text);
}

function collectPatchStrings(value: unknown, out: string[], seen: Set<unknown>, depth: number): void {
  if (depth > 5 || value == null) return;
  if (typeof value === 'string') {
    if (value.trim()) out.push(value);
    return;
  }
  if (!isRecord(value) || seen.has(value)) return;
  seen.add(value);

  for (const key of PATCH_VALUE_KEYS) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) out.push(candidate);
  }
  for (const key of PATCH_VALUE_KEYS) {
    const candidate = value[key];
    if (isRecord(candidate)) collectPatchStrings(candidate, out, seen, depth + 1);
  }
  for (const key of PATCH_NESTED_KEYS) {
    collectPatchStrings(value[key], out, seen, depth + 1);
  }
}

// Accept every attested host shape, including OpenCode/Kilo's
// output.args.patch and Codex freeform strings. A patch-looking candidate wins
// over an unrelated `content`/`command` sibling; otherwise return the first
// non-empty value so the parser can reject it fail-closed.
export function patchTextFromToolInput(...sources: readonly unknown[]): string {
  const candidates: string[] = [];
  const seen = new Set<unknown>();
  for (const source of sources) collectPatchStrings(source, candidates, seen, 0);
  return candidates.find(looksLikeApplyPatch) || candidates[0] || '';
}

function normalizePatchPath(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.includes('\0') || /[\r\n]/.test(value)) return null;
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function operationHeader(line: string): { kind: 'add' | 'update' | 'delete'; path: string } | null {
  const match = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
  if (!match || !match[1] || !match[2]) return null;
  const normalized = normalizePatchPath(match[2]);
  if (!normalized) return null;
  return { kind: match[1].toLowerCase() as 'add' | 'update' | 'delete', path: normalized };
}

function isOperationBoundary(line: string): boolean {
  return /^\*\*\* (?:Add|Update|Delete) File: /.test(line) || line === '*** End Patch';
}

function parseHunks(lines: string[], pathName: string): { ok: true; hunks: ParsedHunk[]; addedContent: string } | { ok: false; error: string } {
  const hunks: ParsedHunk[] = [];
  const added: string[] = [];
  let i = 0;

  while (i < lines.length) {
    let anchor = '';
    let oldStart: number | null = null;
    const marker = lines[i] || '';
    if (marker.startsWith('@@')) {
      const numeric = marker.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@(?:.*)?$/);
      if (numeric && numeric[1]) oldStart = Number(numeric[1]);
      else anchor = marker.replace(/^@@\s?/, '').trim();
      i += 1;
    } else if (hunks.length > 0) {
      return { ok: false, error: `missing @@ hunk marker in ${pathName}` };
    }

    const hunkLines: ParsedHunkLine[] = [];
    let eof = false;
    while (i < lines.length && !lines[i]?.startsWith('@@')) {
      const line = lines[i] as string;
      if (line === '*** End of File') {
        if (i !== lines.length - 1) return { ok: false, error: `*** End of File must terminate the hunk in ${pathName}` };
        eof = true;
        i += 1;
        break;
      }
      const prefix = line[0];
      if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
        return { ok: false, error: `invalid update line in ${pathName}; expected space, +, -, or @@` };
      }
      const text = line.slice(1);
      const mode = prefix === '+' ? 'add' : (prefix === '-' ? 'delete' : 'context');
      hunkLines.push({ mode, text });
      if (mode === 'add') added.push(text);
      i += 1;
    }
    if (hunkLines.length === 0) return { ok: false, error: `empty update hunk in ${pathName}` };
    hunks.push({ anchor, oldStart, eof, lines: hunkLines });
  }

  return { ok: true, hunks, addedContent: added.join('\n') };
}

function parseStructure(patchText: string): { ok: true; operations: StructuralOperation[] } | { ok: false; error: string } {
  const normalized = String(patchText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines[0] !== '*** Begin Patch') return { ok: false, error: 'missing *** Begin Patch header' };
  if (lines[lines.length - 1] !== '*** End Patch') return { ok: false, error: 'missing *** End Patch footer' };

  const operations: StructuralOperation[] = [];
  let i = 1;
  while (i < lines.length - 1) {
    const header = operationHeader(lines[i] as string);
    if (!header) return { ok: false, error: `invalid operation header at patch line ${i + 1}` };
    i += 1;
    const body: string[] = [];
    while (i < lines.length && !isOperationBoundary(lines[i] as string)) {
      body.push(lines[i] as string);
      i += 1;
    }

    if (header.kind === 'add') {
      const added: string[] = [];
      for (const line of body) {
        if (!line.startsWith('+')) return { ok: false, error: `invalid Add File line in ${header.path}; every line must start with +` };
        added.push(line.slice(1));
      }
      const text = added.length > 0 ? `${added.join('\n')}\n` : '';
      operations.push({ kind: 'add', path: header.path, addedContent: added.join('\n'), addContent: text });
      continue;
    }

    if (header.kind === 'delete') {
      if (body.length > 0) return { ok: false, error: `Delete File ${header.path} must not contain patch lines` };
      operations.push({ kind: 'delete', path: header.path, addedContent: '' });
      continue;
    }

    let destinationPath: string | undefined;
    if (body[0]?.startsWith('*** Move to: ')) {
      const normalizedDestination = normalizePatchPath(body[0].slice('*** Move to: '.length));
      if (!normalizedDestination) return { ok: false, error: `invalid Move destination for ${header.path}` };
      destinationPath = normalizedDestination;
      body.shift();
    }
    if (body.some((line) => line.startsWith('*** Move to: '))) {
      return { ok: false, error: `Move destination must immediately follow Update File ${header.path}` };
    }
    if (body.length === 0) {
      if (!destinationPath) return { ok: false, error: `Update File ${header.path} has no hunks` };
      operations.push({ kind: 'move', path: header.path, destinationPath, addedContent: '', hunks: [] });
      continue;
    }
    const hunks = parseHunks(body, header.path);
    if (!hunks.ok) return hunks;
    operations.push({
      kind: destinationPath ? 'move' : 'update',
      path: header.path,
      ...(destinationPath ? { destinationPath } : {}),
      addedContent: hunks.addedContent,
      hunks: hunks.hunks,
    });
  }
  if (operations.length === 0) return { ok: false, error: 'patch contains no file operations' };
  return { ok: true, operations };
}

function splitFileLines(text: string): { lines: string[]; trailingNewline: boolean } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const trailingNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function matchesAt(lines: string[], needle: string[], index: number, mode: 'exact' | 'rstrip' | 'trim'): boolean {
  if (index < 0 || index + needle.length > lines.length) return false;
  const transform = mode === 'exact'
    ? (value: string): string => value
    : mode === 'rstrip'
      ? (value: string): string => value.replace(/\s+$/g, '')
      : (value: string): string => value.trim();
  return needle.every((line, offset) => transform(lines[index + offset] as string) === transform(line));
}

function findSequence(lines: string[], needle: string[], start: number, eof: boolean, preferred: number | null = null): number {
  for (const mode of ['exact', 'rstrip', 'trim'] as const) {
    if (preferred != null && preferred >= start && matchesAt(lines, needle, preferred, mode)
      && (!eof || preferred + needle.length === lines.length)) return preferred;
    for (let i = Math.max(0, start); i <= lines.length - needle.length; i += 1) {
      if (matchesAt(lines, needle, i, mode) && (!eof || i + needle.length === lines.length)) return i;
    }
  }
  return -1;
}

function findAnchor(lines: string[], anchor: string, start: number): number {
  for (const mode of ['exact', 'rstrip', 'trim'] as const) {
    for (let i = Math.max(0, start); i < lines.length; i += 1) {
      if (matchesAt(lines, [anchor], i, mode)) return i;
    }
  }
  return -1;
}

function applyHunks(source: string, hunks: ParsedHunk[], pathName: string): { ok: true; content: string } | { ok: false; error: string } {
  const file = splitFileLines(source);
  const lines = [...file.lines];
  let cursor = 0;

  for (const hunk of hunks) {
    let searchStart = cursor;
    if (hunk.anchor) {
      const anchorIndex = findAnchor(lines, hunk.anchor, cursor);
      if (anchorIndex < 0) return { ok: false, error: `update anchor not found in ${pathName}: ${hunk.anchor}` };
      searchStart = anchorIndex + 1;
    }
    const before = hunk.lines.filter((line) => line.mode !== 'add').map((line) => line.text);
    const after = hunk.lines.filter((line) => line.mode !== 'delete').map((line) => line.text);
    let index: number;
    if (before.length === 0) {
      if (!hunk.anchor && hunk.oldStart == null) {
        return { ok: false, error: `addition-only hunk in ${pathName} has no anchor or line number` };
      }
      index = hunk.oldStart == null ? searchStart : Math.max(searchStart, hunk.oldStart - 1);
      if (hunk.eof) index = lines.length;
      if (index > lines.length) return { ok: false, error: `update insertion is outside ${pathName}` };
    } else {
      const preferred = hunk.oldStart == null ? null : hunk.oldStart - 1;
      index = findSequence(lines, before, searchStart, hunk.eof, preferred);
      if (index < 0) return { ok: false, error: `update context not found in ${pathName}` };
    }
    lines.splice(index, before.length, ...after);
    cursor = index + after.length;
  }

  return { ok: true, content: lines.join('\n') + (file.trailingNewline ? '\n' : '') };
}

function absoluteTarget(baseDir: string, target: string): string {
  return path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseDir, target);
}

function readCurrent(
  absPath: string,
  virtual: Map<string, string | null>,
): { ok: true; content: string } | { ok: false; error: string } {
  if (virtual.has(absPath)) {
    const content = virtual.get(absPath);
    return content == null
      ? { ok: false, error: `file does not exist: ${absPath}` }
      : { ok: true, content };
  }
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    if (content.includes('\0')) return { ok: false, error: `cannot reconstruct binary file: ${absPath}` };
    return { ok: true, content };
  } catch {
    return { ok: false, error: `file does not exist or is unreadable: ${absPath}` };
  }
}

function targetExists(absPath: string, virtual: Map<string, string | null>): boolean {
  if (virtual.has(absPath)) return virtual.get(absPath) != null;
  try { return fs.existsSync(absPath); } catch { return true; }
}

export function parseApplyPatch(patchText: string, options: ApplyPatchParseOptions = {}): ApplyPatchParseResult {
  const parsed = parseStructure(patchText);
  if (!parsed.ok) return parsed;

  if (!options.baseDir) {
    return {
      ok: true,
      operations: parsed.operations.map((operation) => ({
        kind: operation.kind,
        path: operation.path,
        ...(operation.destinationPath ? { destinationPath: operation.destinationPath } : {}),
        addedContent: operation.addedContent,
        ...(operation.kind === 'add' ? { resultContent: operation.addContent || '' } : {}),
      })),
    };
  }

  const baseDir = path.resolve(options.baseDir);
  const virtual = new Map<string, string | null>();
  const operations: PatchFileOperation[] = [];
  for (const operation of parsed.operations) {
    const sourceAbs = absoluteTarget(baseDir, operation.path);
    if (operation.kind === 'add') {
      if (targetExists(sourceAbs, virtual)) return { ok: false, error: `Add File target already exists: ${operation.path}` };
      const resultContent = operation.addContent || '';
      virtual.set(sourceAbs, resultContent);
      operations.push({ kind: 'add', path: operation.path, addedContent: operation.addedContent, resultContent });
      continue;
    }

    if (operation.kind === 'delete') {
      // Delete is path-only. Existence matters for atomic validation, but file
      // bytes do not: an unreadable or binary target remains safely deletable.
      if (!targetExists(sourceAbs, virtual)) {
        return { ok: false, error: `delete ${operation.path}: file does not exist` };
      }
      virtual.set(sourceAbs, null);
      operations.push({ kind: 'delete', path: operation.path, addedContent: '' });
      continue;
    }

    const current = readCurrent(sourceAbs, virtual);
    if (!current.ok) return { ok: false, error: `${operation.kind} ${operation.path}: ${current.error}` };

    const rebuilt = applyHunks(current.content, operation.hunks || [], operation.path);
    if (!rebuilt.ok) return rebuilt;
    if (operation.kind === 'move') {
      const destinationPath = operation.destinationPath as string;
      const destinationAbs = absoluteTarget(baseDir, destinationPath);
      if (destinationAbs !== sourceAbs && targetExists(destinationAbs, virtual)) {
        return { ok: false, error: `Move destination already exists: ${destinationPath}` };
      }
      virtual.set(sourceAbs, null);
      virtual.set(destinationAbs, rebuilt.content);
      operations.push({
        kind: 'move',
        path: operation.path,
        destinationPath,
        addedContent: operation.addedContent,
        resultContent: rebuilt.content,
      });
      continue;
    }
    virtual.set(sourceAbs, rebuilt.content);
    operations.push({
      kind: 'update',
      path: operation.path,
      addedContent: operation.addedContent,
      resultContent: rebuilt.content,
    });
  }
  return { ok: true, operations };
}

export function patchOperationPaths(operations: readonly PatchFileOperation[]): string[] {
  const paths: string[] = [];
  for (const operation of operations) {
    if (!paths.includes(operation.path)) paths.push(operation.path);
    if (operation.destinationPath && !paths.includes(operation.destinationPath)) paths.push(operation.destinationPath);
  }
  return paths;
}
