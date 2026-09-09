// src/shared/host/wrapper-jsonc.ts
// Bounded JSONC parsing + managed-config write shared by the kilo-host and
// opencode-host runners (previously byte-duplicated in each). Host-specific
// policy (the one-mcp disable shape, plugin-spec registration) stays in the
// runners; only the neutral machinery lives here.

import * as fs from 'fs';
import * as path from 'path';

import { ONE_MCP_SERVER_NAME } from '../../config/one-mcp';
import { readRegularFileOrThrow } from '../bounded-read';

export type JsonObject = Record<string, unknown>;
export type ConfigUpdate =
  | { ok: true; path: string; changed: boolean }
  | { ok: false; path: string; error: string };

/** Sibling written only when a splice cannot preserve the on-disk text. */
export const JSONC_CONFIG_BACKUP_SUFFIX = '.traffic-one-bak';

function stripJsonc(input: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] || '';
    const next = input[i + 1] || '';
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function removeTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] || '';
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (/\s/.test(input[j] || '')) j += 1;
      if (input[j] === '}' || input[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

export function parseJsoncText(input: string): JsonObject | null {
  const parsed = JSON.parse(removeTrailingCommas(stripJsonc(input))) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
}

export function parseJsoncObject(file: string): JsonObject | null {
  if (!fs.existsSync(file)) return {};
  return parseJsoncText(readRegularFileOrThrow(file));
}

export function jsonObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

export function managedPermissionKey(tool: string): string {
  return `${ONE_MCP_SERVER_NAME}_${tool}`;
}

/**
 * Write a managed host-config object.
 *
 * Prefers a textual splice that inserts missing keys and appends/removes
 * array elements in the on-disk JSONC, so user comments and unmanaged keys
 * keep their original text. After a splice, the file is re-parsed and must
 * deep-equal `config`; a mismatch falls through to the backup path.
 *
 * Caller research (every writeConfig site):
 * - OpenCode `ensureGlobalConfigPlugin`: add `$schema` / `plugin` / `mcp` /
 *   `permission` when missing, append one plugin spec. Splice-safe.
 * - OpenCode `removeGlobalConfigPlugin`: drop matching `plugin` entries.
 *   Splice-safe as array-element removal (object-key deletion is not).
 * - Kilo `ensureOneMcpDisabled`: add `$schema` / `mcp` / `permission` and
 *   nested managed keys when missing; never overwrite existing values.
 *   Splice-safe.
 *
 * Unsafe diffs (object-key deletion, replacing an object/array value,
 * mixed array rewrite, unlocatable span, or a splice that fails the
 * parse-equals check) copy the original bytes to
 * `<file>.traffic-one-bak` and rewrite with JSON.stringify. That path
 * destroys comments; the backup is the recovery.
 */
export function writeConfig(file: string, config: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rendered = `${JSON.stringify(config, null, 2)}\n`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, rendered, 'utf8');
    return;
  }
  const original = readRegularFileOrThrow(file);
  const spliced = trySpliceConfig(original, config);
  if (spliced !== null) {
    fs.writeFileSync(file, spliced, 'utf8');
    return;
  }
  fs.writeFileSync(`${file}${JSONC_CONFIG_BACKUP_SUFFIX}`, original, 'utf8');
  fs.writeFileSync(file, rendered, 'utf8');
}

type JsoncValue =
  | { type: 'object'; start: number; end: number; props: JsoncProp[] }
  | { type: 'array'; start: number; end: number; elements: JsoncElem[] }
  | { type: 'scalar'; start: number; end: number };

type JsoncProp = {
  key: string;
  value: JsoncValue;
  hasComma: boolean;
  commaEnd: number;
};

type JsoncElem = {
  value: JsoncValue;
  hasComma: boolean;
  commaEnd: number;
};

type Edit = { start: number; end: number; text: string };

const JSONC_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function skipTrivia(input: string, i: number): number {
  while (i < input.length) {
    const ch = input[i] || '';
    const next = input[i + 1] || '';
    if (isWs(ch)) {
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      if (i < input.length) i += 2;
      continue;
    }
    break;
  }
  return i;
}

function parseJsonString(input: string, i: number): { value: string; end: number } {
  if (input[i] !== '"') throw new Error('expected string');
  let escaped = false;
  for (let j = i + 1; j < input.length; j += 1) {
    const ch = input[j] || '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') return { value: JSON.parse(input.slice(i, j + 1)) as string, end: j + 1 };
  }
  throw new Error('unterminated string');
}

function parseJsoncValue(input: string, from: number): JsoncValue {
  const i = skipTrivia(input, from);
  const ch = input[i] || '';
  if (ch === '{') return parseJsoncObjectValue(input, i);
  if (ch === '[') return parseJsoncArrayValue(input, i);
  if (ch === '"') {
    const str = parseJsonString(input, i);
    return { type: 'scalar', start: i, end: str.end };
  }
  if (input.startsWith('true', i)) return { type: 'scalar', start: i, end: i + 4 };
  if (input.startsWith('false', i)) return { type: 'scalar', start: i, end: i + 5 };
  if (input.startsWith('null', i)) return { type: 'scalar', start: i, end: i + 4 };
  if (ch === '-' || (ch >= '0' && ch <= '9')) {
    const m = input.slice(i).match(JSONC_NUMBER_RE);
    if (!m) throw new Error('expected number');
    return { type: 'scalar', start: i, end: i + m[0].length };
  }
  throw new Error(`unexpected token ${JSON.stringify(ch)}`);
}

function parseJsoncObjectValue(input: string, start: number): JsoncValue {
  const props: JsoncProp[] = [];
  let i = start + 1;
  while (true) {
    i = skipTrivia(input, i);
    if ((input[i] || '') === '}') return { type: 'object', start, end: i + 1, props };
    const key = parseJsonString(input, i);
    i = skipTrivia(input, key.end);
    if ((input[i] || '') !== ':') throw new Error('expected colon');
    const value = parseJsoncValue(input, i + 1);
    i = skipTrivia(input, value.end);
    const hasComma = (input[i] || '') === ',';
    const commaEnd = hasComma ? i + 1 : value.end;
    props.push({ key: key.value, value, hasComma, commaEnd });
    if (!hasComma) {
      i = skipTrivia(input, value.end);
      if ((input[i] || '') !== '}') throw new Error('expected }');
      return { type: 'object', start, end: i + 1, props };
    }
    i = commaEnd;
  }
}

function parseJsoncArrayValue(input: string, start: number): JsoncValue {
  const elements: JsoncElem[] = [];
  let i = start + 1;
  while (true) {
    i = skipTrivia(input, i);
    if ((input[i] || '') === ']') return { type: 'array', start, end: i + 1, elements };
    const value = parseJsoncValue(input, i);
    i = skipTrivia(input, value.end);
    const hasComma = (input[i] || '') === ',';
    const commaEnd = hasComma ? i + 1 : value.end;
    elements.push({ value, hasComma, commaEnd });
    if (!hasComma) {
      i = skipTrivia(input, value.end);
      if ((input[i] || '') !== ']') throw new Error('expected ]');
      return { type: 'array', start, end: i + 1, elements };
    }
    i = commaEnd;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => deepEqual(value, b[i]));
  }
  const ao = a as JsonObject;
  const bo = b as JsonObject;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(bo, key) && deepEqual(ao[key], bo[key]));
}

function objectStyle(input: string, object: Extract<JsoncValue, { type: 'object' }>): { indent: string; multiline: boolean } {
  if (object.props.length === 0) {
    const inner = input.slice(object.start + 1, object.end - 1);
    return { indent: inner.includes('\n') ? '  ' : '', multiline: inner.includes('\n') };
  }
  const keyAt = skipTrivia(input, object.start + 1);
  if ((input[keyAt] || '') === '"') {
    let j = keyAt;
    while (j > object.start && isWs(input[j - 1] || '') && input[j - 1] !== '\n') j -= 1;
    if (j > object.start && input[j - 1] === '\n') return { indent: input.slice(j, keyAt), multiline: true };
  }
  return { indent: '', multiline: input.slice(object.start, object.end).includes('\n') };
}

function lineCommentReaches(input: string, at: number): boolean {
  const lineStart = input.lastIndexOf('\n', at - 1) + 1;
  let inString = false;
  let escaped = false;
  for (let i = lineStart; i < at; i += 1) {
    const ch = input[i] || '';
    const next = input[i + 1] || '';
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '/' && next === '/') return true;
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < at && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      if (i < at) i += 1;
    }
  }
  return false;
}

function arrayStyle(input: string, array: Extract<JsoncValue, { type: 'array' }>): { indent: string; multiline: boolean } {
  const inner = input.slice(array.start + 1, array.end - 1);
  const multiline = inner.includes('\n');
  if (array.elements.length === 0) return { indent: multiline ? '  ' : '', multiline };
  const first = array.elements[0];
  if (!first) return { indent: '', multiline };
  const start = first.value.start;
  let j = start;
  while (j > array.start && isWs(input[j - 1] || '') && input[j - 1] !== '\n') j -= 1;
  if (j > array.start && input[j - 1] === '\n') return { indent: input.slice(j, start), multiline: true };
  return { indent: '', multiline };
}

function formatInserted(value: unknown, indent: string, multiline: boolean): string {
  if (value === undefined) throw new Error('cannot insert undefined');
  if (!multiline) return JSON.stringify(value);
  const pretty = JSON.stringify(value, null, 2);
  const lines = pretty.split('\n');
  if (lines.length === 1) return pretty;
  return lines.map((line, idx) => (idx === 0 ? line : `${indent}${line}`)).join('\n');
}

function formatProps(pairs: Array<[string, unknown]>, indent: string, multiline: boolean): string {
  return pairs.map(([key, value], idx) => {
    const rendered = `${JSON.stringify(key)}${multiline ? ': ' : ':'}${formatInserted(value, indent, multiline)}`;
    const comma = idx < pairs.length - 1 ? ',' : '';
    return multiline ? `${indent}${rendered}${comma}` : `${rendered}${comma}`;
  }).join(multiline ? '\n' : '');
}

function formatElements(values: unknown[], indent: string, multiline: boolean): string {
  return values.map((value, idx) => {
    const rendered = formatInserted(value, indent, multiline);
    const comma = idx < values.length - 1 ? ',' : '';
    return multiline ? `${indent}${rendered}${comma}` : `${rendered}${comma}`;
  }).join(multiline ? '\n' : '');
}

function insertLead(input: string, at: number, trivia: string, multiline: boolean): string {
  if (trivia.endsWith('\n')) return '';
  if (lineCommentReaches(input, at) || multiline) return '\n';
  return '';
}

function insertProps(input: string, object: Extract<JsoncValue, { type: 'object' }>, pairs: Array<[string, unknown]>): Edit {
  const { indent, multiline } = objectStyle(input, object);
  const body = formatProps(pairs, indent, multiline);
  if (object.props.length === 0) {
    const at = object.end - 1;
    const trivia = input.slice(object.start + 1, at);
    const lead = insertLead(input, at, trivia, multiline);
    const tail = lead || (multiline && !trivia.endsWith('\n')) ? '\n' : '';
    return { start: at, end: at, text: `${lead}${body}${tail}` };
  }
  const last = object.props[object.props.length - 1];
  if (!last) throw new Error('missing last property');
  const at = last.hasComma ? last.commaEnd : last.value.end;
  const comma = last.hasComma ? '' : ',';
  const text = multiline || lineCommentReaches(input, at) ? `${comma}\n${body}` : `${comma}${body}`;
  return { start: at, end: at, text };
}

function appendElements(input: string, array: Extract<JsoncValue, { type: 'array' }>, values: unknown[]): Edit {
  const { indent, multiline } = arrayStyle(input, array);
  const body = formatElements(values, indent, multiline);
  if (array.elements.length === 0) {
    const at = array.end - 1;
    const trivia = input.slice(array.start + 1, at);
    const lead = insertLead(input, at, trivia, multiline);
    const tail = lead || (multiline && !trivia.endsWith('\n')) ? '\n' : '';
    return { start: at, end: at, text: `${lead}${body}${tail}` };
  }
  const last = array.elements[array.elements.length - 1];
  if (!last) throw new Error('missing last element');
  const at = last.hasComma ? last.commaEnd : last.value.end;
  const comma = last.hasComma ? '' : ',';
  const text = multiline || lineCommentReaches(input, at) ? `${comma}\n${body}` : `${comma}${body}`;
  return { start: at, end: at, text };
}

function elementRemoval(array: Extract<JsoncValue, { type: 'array' }>, index: number): Edit {
  const el = array.elements[index];
  if (!el) throw new Error('missing array element');
  if (el.hasComma) return { start: el.value.start, end: el.commaEnd, text: '' };
  if (index > 0) {
    const prev = array.elements[index - 1];
    if (!prev) throw new Error('missing previous array element');
    return { start: prev.value.end, end: el.value.end, text: '' };
  }
  return { start: el.value.start, end: el.value.end, text: '' };
}

function alignArrays(oldArr: unknown[], newArr: unknown[]): { remove: number[]; append: unknown[] } | null {
  const remove: number[] = [];
  let j = 0;
  for (let i = 0; i < oldArr.length; i += 1) {
    if (j < newArr.length && deepEqual(oldArr[i], newArr[j])) j += 1;
    else remove.push(i);
  }
  const append = newArr.slice(j);
  const rebuilt = oldArr.filter((_, i) => !remove.includes(i)).concat(append);
  if (!deepEqual(rebuilt, newArr)) return null;
  if (remove.length > 0 && append.length > 0) return null;
  return { remove, append };
}

function diffValue(oldVal: unknown, newVal: unknown, span: JsoncValue, input: string): Edit[] | null {
  if (deepEqual(oldVal, newVal)) return [];
  const oldObj = jsonObject(oldVal);
  const newObj = jsonObject(newVal);
  if (oldObj && newObj) {
    if (span.type !== 'object') return null;
    return diffObject(oldObj, newObj, span, input);
  }
  if (Array.isArray(oldVal) && Array.isArray(newVal)) {
    if (span.type !== 'array') return null;
    return diffArray(oldVal, newVal, span, input);
  }
  if (span.type === 'scalar' && !oldObj && !newObj && !Array.isArray(oldVal) && !Array.isArray(newVal) && newVal !== undefined) {
    return [{ start: span.start, end: span.end, text: JSON.stringify(newVal) }];
  }
  return null;
}

function diffObject(oldObj: JsonObject, newObj: JsonObject, span: Extract<JsoncValue, { type: 'object' }>, input: string): Edit[] | null {
  const keys = span.props.map((prop) => prop.key);
  if (new Set(keys).size !== keys.length) return null;
  const edits: Edit[] = [];
  for (const key of Object.keys(oldObj)) {
    if (!Object.prototype.hasOwnProperty.call(newObj, key)) return null;
    const prop = span.props.find((entry) => entry.key === key);
    if (!prop) return null;
    const child = diffValue(oldObj[key], newObj[key], prop.value, input);
    if (!child) return null;
    edits.push(...child);
  }
  const adds: Array<[string, unknown]> = [];
  for (const key of Object.keys(newObj)) {
    if (!Object.prototype.hasOwnProperty.call(oldObj, key)) {
      if (newObj[key] === undefined) return null;
      adds.push([key, newObj[key]]);
    }
  }
  if (adds.length > 0) edits.push(insertProps(input, span, adds));
  return edits;
}

function diffArray(oldArr: unknown[], newArr: unknown[], span: Extract<JsoncValue, { type: 'array' }>, input: string): Edit[] | null {
  if (span.elements.length !== oldArr.length) return null;
  const aligned = alignArrays(oldArr, newArr);
  if (!aligned) return null;
  const edits: Edit[] = [];
  for (const index of aligned.remove) edits.push(elementRemoval(span, index));
  if (aligned.append.length > 0) edits.push(appendElements(input, span, aligned.append));
  return edits;
}

function applyEdits(input: string, edits: Edit[]): string | null {
  const sorted = [...edits].sort((a, b) => (b.start - a.start) || (b.end - a.end));
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const later = sorted[i];
    const earlier = sorted[i + 1];
    if (!later || !earlier) return null;
    if (later.start < earlier.end) return null;
  }
  let out = input;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end > out.length || edit.start > edit.end) return null;
    out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
  }
  return out;
}

function trySpliceConfig(original: string, config: JsonObject): string | null {
  let old: JsonObject | null;
  try {
    old = parseJsoncText(original);
  } catch {
    return null;
  }
  if (!old) return null;
  if (deepEqual(old, config)) return original;
  let root: JsoncValue;
  try {
    root = parseJsoncValue(original, 0);
  } catch {
    return null;
  }
  if (root.type !== 'object') return null;
  let edits: Edit[] | null;
  try {
    edits = diffValue(old, config, root, original);
  } catch {
    return null;
  }
  if (!edits || edits.length === 0) return null;
  const next = applyEdits(original, edits);
  if (next === null) return null;
  try {
    const parsed = parseJsoncText(next);
    if (!parsed || !deepEqual(parsed, config)) return null;
  } catch {
    return null;
  }
  return next;
}
