// Structural analyzer kept separate from the collapse/minification detector.
// It is formatting-independent and dependency-free so the same implementation
// can run in every host hook.

import * as fs from 'fs';
import * as path from 'path';

import {
  canonicalRoutePath,
  type ArchitectureExceptionRequestV1,
  type CompiledArchitectureV1,
} from '../../shared/architecture-contract';
import type { CapabilityProfileV1 } from '../../shared/capabilities';
import { collapsedLineNumber, lexicalMask } from '../../shared/collapsed-source';
import { writeJson } from '../../shared/fsjson';
import { matchesPattern, matchesScope, type AssignedScope } from '../../shared/scope';

export const STRUCTURE_REPORT_SCHEMA_VERSION = 1 as const;
export const STRUCTURE_SCAN_DEFAULT_MAX_FILES = 10_000;

export type StructureFindingId =
  | 'STRUCT_ENTRYPOINT_COMPONENT'
  | 'STRUCT_APP_INLINE_PAGE'
  | 'STRUCT_MULTI_PAGE_MODULE'
  | 'STRUCT_ROUTE_MODULE_MISMATCH'
  | 'STRUCT_ROUTE_PATH_UNRESOLVED'
  | 'STRUCT_MISSING_PLANNED_MODULE'
  | 'STRUCT_LAYER_MISMATCH'
  | 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP'
  | 'STRUCT_SCAN_INCOMPLETE'
  | 'STRUCT_COMPONENT_LOC'
  | 'STRUCT_FUNCTION_COUNT'
  | 'STRUCT_COMPONENTS_PER_FILE'
  | 'STRUCT_MODULE_LOC'
  | 'STRUCT_COLLAPSED_LINE';

export interface StructureFinding {
  id: StructureFindingId;
  severity: 'error' | 'warning';
  file: string;
  line?: number;
  message: string;
}

export interface StructureReportV1 {
  schemaVersion: typeof STRUCTURE_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  contractHash: string;
  status: 'passed' | 'warnings' | 'failed';
  complete: boolean;
  filesScanned: number;
  findings: StructureFinding[];
}

export interface StructureScanOptions {
  maxFiles?: number;
  allowlist?: string[];
  assignmentScope?: AssignedScope;
  generatedAt?: string;
}

interface ComponentDeclaration {
  name: string;
  index: number;
  line: number;
  logicalLoc: number;
}

interface ImportBinding {
  local: string;
  imported: string;
  source: string;
}

interface RouteUsage {
  path: string;
  index: number;
  line: number;
  targetNames: string[];
  importSources: string[];
  inlineUi: boolean;
  laravelTargets?: Array<{
    kind: 'view' | 'inertia';
    name: string;
  }>;
  /**
   * Controller/callable routes are valid Laravel routing, but resolving their
   * return value without PHP execution is not safely provable. In that case
   * the compiled page's separate file-existence gate remains authoritative.
   */
  opaqueLaravelTarget?: boolean;
}

// A route whose `path` attribute/property EXISTS but is not a plain string
// literal (`path={courseRoute}`, `path={\`/x/${'{id}'}\`}`). The extractor
// cannot verify it against the compiled contract, so the route is invisible —
// and before this field existed, the resulting mismatch deny never said WHY
// (observed 1co: the agent improvised `'/'` escapes until the run died).
interface UnresolvedRoute {
  display: string;
  line: number;
}

interface SourceAnalysis {
  file: string;
  text: string;
  components: ComponentDeclaration[];
  functionCount: number;
  imports: ImportBinding[];
  routes: RouteUsage[];
  unresolvedRoutes: UnresolvedRoute[];
  routerSignal: boolean;
  inlineHostUi: { index: number; line: number } | null;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  analysis: SourceAnalysis;
}

const cache = new Map<string, CacheEntry>();
const STRUCTURAL_SOURCE_RE = /\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro|html|php|css|scss)$/i;
const ANALYZABLE_UI_RE = /\.(?:tsx?|jsx?|mjs|cjs|vue)$/i;
const SKIP_RE = /(^|\/)(?:\.git|\.traffic-one|node_modules|dist|build|coverage|out|\.turbo|\.next|\.vite|generated|__generated__|tests?|__tests__|fixtures?|stories)(?:\/|$)|\.(?:test|spec|stories?)\.[^.]+$/i;
// Findings an architect-declared exception may suppress. Every advisory numeric
// rule qualifies, plus the one BLOCKING numeric rule (STRUCT_MODULE_LOC) —
// without that a legitimately large module would have no escape hatch at all.
const EXCEPTIONABLE_IDS = new Set<StructureFindingId>([
  'STRUCT_COMPONENT_LOC',
  'STRUCT_FUNCTION_COUNT',
  'STRUCT_COMPONENTS_PER_FILE',
  'STRUCT_MODULE_LOC',
  // Advisory, not blocking: dynamic route paths (`path={ROUTES.x}`,
  // `routes.map(...)`) are legitimate patterns the contract simply cannot
  // verify. The blocking signal stays STRUCT_ROUTE_MODULE_MISMATCH, whose
  // message now carries this cause.
  'STRUCT_ROUTE_PATH_UNRESOLVED',
]);
const ADVISORY_FUNCTION_COUNT = 12;
// The one numeric threshold that BLOCKS. Per-component LOC and
// components-per-file stay advisory (rules/common/clean-code.md: numeric
// thresholds wait on a <1% false-positive fixture validation), but a module
// that packs an entire feature into one file is unambiguous: observed 6co,
// `pages/Catalog.tsx` shipped 515 logical lines / 7 components with all nine
// structural signals raised as non-blocking warnings, so `IMPLEMENTED` was
// accepted. Calibrated against that project: Catalog 515, next-largest module
// 307 — 400 separates the monolith from merely-large modules.
//
// It counts LOGICAL lines (the same collapse-resistant measure as
// STRUCT_COMPONENT_LOC), so minifying the module onto a handful of lines does
// not evade it — this is also the only size signal that runs on every scanned
// write rather than only at the frontend's `IMPLEMENTED` digest.
const BLOCKING_MODULE_LOC = 400;
// Generated declaration/type modules are legitimately enormous and nobody
// authored them: a Supabase `database.types.ts` is 198 logical lines from 85
// physical ones in 6co alone, and scales with the schema. Blocking those would
// be an unescapable deadlock on a file the implementer cannot shrink.
const GENERATED_MODULE_RE = /\.(?:d|types|generated)\.[cm]?[jt]sx?$/i;


function normalizeRel(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

/**
 * Mask comments and optionally strings while retaining byte offsets/newlines.
 * That lets the regex recognizers ignore fake JSX in data/comments without
 * losing stable locations or depending on source formatting.
 */

function braceDepths(masked: string): Uint16Array {
  const depths = new Uint16Array(masked.length + 1);
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    depths[i] = depth;
    const current = masked[i];
    if (current === '{') depth += 1;
    else if (current === '}' && depth > 0) depth -= 1;
  }
  depths[masked.length] = depth;
  return depths;
}

function componentCandidates(masked: string): Array<{ name: string; index: number }> {
  const candidates: Array<{ name: string; index: number }> = [];
  const patterns = [
    /(?:^|[;\n}])\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*\(/gm,
    /(?:^|[;\n}])\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=/gm,
    /(?:^|[;\n}])\s*(?:export\s+(?:default\s+)?)?class\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+(?:React\.)?(?:Pure)?Component\b/gm,
  ];
  const depths = braceDepths(masked);
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(masked))) {
      const name = match[1]!;
      const nameOffset = match[0].lastIndexOf(name);
      const index = match.index + Math.max(0, nameOffset);
      if (depths[index] === 0) candidates.push({ name, index });
    }
  }
  return candidates.sort((a, b) => a.index - b.index);
}

function topLevelFunctionCount(masked: string): number {
  const depths = braceDepths(masked);
  const indexes = new Set<number>();
  const patterns = [
    /(?:^|[;\n}])\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\b/gm,
    /(?:^|[;\n}])\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)/gm,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(masked))) {
      const tokenOffset = match[0].search(/\b(?:function|const|let|var)\b/);
      const index = match.index + Math.max(0, tokenOffset);
      if (depths[index] === 0) indexes.add(index);
    }
  }
  return indexes.size;
}

function jsxBearing(segment: string): boolean {
  return /\b(?:React\.)?createElement\s*\(/.test(segment)
    || /<[A-Z][A-Za-z0-9_.]*(?:\s|\/?>)/.test(segment)
    || /<[a-z][A-Za-z0-9:-]*(?:\s|\/?>)/.test(segment);
}

function firstInlineHostUi(text: string): { index: number; line: number } | null {
  const syntax = lexicalMask(text, true);
  const commentsMasked = lexicalMask(text, false);
  const indexes: number[] = [];

  const hostJsx = /<(?!\/)(?:[a-z][A-Za-z0-9:-]*)(?:\s|\/?>)/g;
  let match: RegExpExecArray | null;
  while ((match = hostJsx.exec(syntax))) indexes.push(match.index);

  const createElement = /\b(?:React\.)?createElement\s*\(\s*(['"])[a-z][A-Za-z0-9:-]*\1/g;
  while ((match = createElement.exec(commentsMasked))) {
    const callEnd = match.index + match[0].indexOf('(');
    if (/\bcreateElement\s*$/.test(syntax.slice(match.index, callEnd))) {
      indexes.push(match.index);
    }
  }

  if (indexes.length === 0) return null;
  const index = Math.min(...indexes);
  return { index, line: lineAt(text, index) };
}

function logicalLoc(segment: string): number {
  const withoutWhitespace = segment.trim();
  if (!withoutWhitespace) return 0;
  const physical = withoutWhitespace.split(/\r?\n/).filter((line) => line.trim()).length;
  const statements = (withoutWhitespace.match(/;/g) || []).length + 1;
  const jsxNodes = (withoutWhitespace.match(/<\/[A-Za-z][^>]*>/g) || []).length;
  return Math.max(physical, statements, jsxNodes);
}

function declaredComponents(text: string): ComponentDeclaration[] {
  const masked = lexicalMask(text, true);
  const candidates = componentCandidates(masked);
  return candidates.flatMap((candidate, index) => {
    const end = candidates[index + 1]?.index ?? masked.length;
    const segment = masked.slice(candidate.index, end);
    if (!jsxBearing(segment)) return [];
    return [{
      ...candidate,
      line: lineAt(text, candidate.index),
      logicalLoc: logicalLoc(segment),
    }];
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function findMatching(
  syntax: string,
  start: number,
  open: string,
  close: string,
  limit = syntax.length,
): number {
  let depth = 0;
  for (let cursor = start; cursor < limit; cursor += 1) {
    if (syntax[cursor] === open) depth += 1;
    else if (syntax[cursor] === close) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function enclosingCurly(syntax: string, index: number): number {
  const stack: number[] = [];
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (syntax[cursor] === '{') stack.push(cursor);
    else if (syntax[cursor] === '}') stack.pop();
  }
  return stack[stack.length - 1] ?? -1;
}

interface PropertyValue {
  index: number;
  value: string;
}

function objectProperties(
  text: string,
  commentsMasked: string,
  syntax: string,
  open: number,
  close: number,
): Map<string, PropertyValue[]> {
  const properties = new Map<string, PropertyValue[]>();
  const depth = braceDepths(syntax);
  const objectDepth = depth[open]! + 1;
  const pattern = /\b(path|element|Component|component|lazy)\s*:/g;
  pattern.lastIndex = open + 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(commentsMasked)) && match.index < close) {
    if (depth[match.index] !== objectDepth || syntax.slice(match.index, match.index + match[1]!.length).trim() === '') {
      continue;
    }
    const colon = commentsMasked.indexOf(':', match.index + match[1]!.length);
    if (colon < 0 || colon >= close) continue;
    let end = close;
    let curly = 0;
    let square = 0;
    let paren = 0;
    for (let cursor = colon + 1; cursor < close; cursor += 1) {
      const current = syntax[cursor];
      if (current === '{') curly += 1;
      else if (current === '}') {
        if (curly === 0) {
          end = cursor;
          break;
        }
        curly -= 1;
      } else if (current === '[') square += 1;
      else if (current === ']' && square > 0) square -= 1;
      else if (current === '(') paren += 1;
      else if (current === ')' && paren > 0) paren -= 1;
      else if (current === ',' && curly === 0 && square === 0 && paren === 0) {
        end = cursor;
        break;
      }
    }
    const values = properties.get(match[1]!) || [];
    values.push({
      index: match.index,
      value: text.slice(colon + 1, end).trim(),
    });
    properties.set(match[1]!, values);
  }
  return properties;
}

function literalValue(value: string): string | null {
  let candidate = value.trim();
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    candidate = candidate.slice(1, -1).trim();
  }
  const match = /^(['"`])([^'"`]*)\1$/.exec(candidate);
  return match?.[2] || null;
}

function routeTarget(value: string): {
  targetNames: string[];
  importSources: string[];
  inlineUi: boolean;
} {
  const syntax = lexicalMask(value, true);
  const targetNames: string[] = [];
  const namedJsx = /<\s*(?!\/)([A-Z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\b/g;
  let namedMatch: RegExpExecArray | null;
  while ((namedMatch = namedJsx.exec(syntax))) targetNames.push(namedMatch[1]!);

  const createElement = /\b(?:React\.)?createElement\s*\(\s*([A-Za-z_$][A-Za-z0-9_$.]*)/g;
  let createMatch: RegExpExecArray | null;
  while ((createMatch = createElement.exec(syntax))) targetNames.push(createMatch[1]!);

  const simpleReference = /^\s*\{?\s*([A-Z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\}?\s*$/.exec(syntax);
  if (simpleReference) targetNames.push(simpleReference[1]!);

  const importSources: string[] = [];
  const commentsMasked = lexicalMask(value, false);
  const dynamicImport = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  let importMatch: RegExpExecArray | null;
  while ((importMatch = dynamicImport.exec(commentsMasked))) importSources.push(importMatch[2]!);

  return {
    targetNames: unique(targetNames),
    importSources: unique(importSources),
    inlineUi: /<\s*(?!\/)(?:[a-z][A-Za-z0-9:-]*)(?:\s|\/?>)/.test(syntax)
      || /<\s*>/.test(syntax)
      || /\b(?:React\.)?createElement\s*\(\s*['"][a-z][A-Za-z0-9:-]*['"]/.test(commentsMasked),
  };
}

function unresolvedDisplay(prefix: string, value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return `${prefix}${trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed}`;
}

function objectRouteUsages(text: string, unresolved?: UnresolvedRoute[]): RouteUsage[] {
  const commentsMasked = lexicalMask(text, false);
  const syntax = lexicalMask(text, true);
  const routes: RouteUsage[] = [];
  const seenObjects = new Set<number>();
  const pathProperty = /\bpath\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = pathProperty.exec(commentsMasked))) {
    if (syntax.slice(match.index, match.index + 4) !== 'path') continue;
    const open = enclosingCurly(syntax, match.index);
    if (open < 0 || seenObjects.has(open)) continue;
    const close = findMatching(syntax, open, '{', '}');
    if (close < 0 || match.index > close) continue;
    seenObjects.add(open);
    const properties = objectProperties(text, commentsMasked, syntax, open, close);
    const pathValue = properties.get('path')?.[0];
    const routePath = literalValue(pathValue?.value || '');
    if (routePath === null) {
      // Property present but not a plain string literal: record the cause so
      // the mismatch denies can state it instead of a generic "route missing".
      if (pathValue && unresolved) {
        unresolved.push({ display: unresolvedDisplay('path: ', pathValue.value), line: lineAt(text, open) });
      }
      continue;
    }
    const targets = [
      ...(properties.get('element') || []),
      ...(properties.get('Component') || []),
      ...(properties.get('component') || []),
      ...(properties.get('lazy') || []),
    ].map((property) => routeTarget(property.value));
    if (targets.length === 0) continue;
    routes.push({
      path: routePath,
      index: open,
      line: lineAt(text, open),
      targetNames: unique(targets.flatMap((target) => target.targetNames)),
      importSources: unique(targets.flatMap((target) => target.importSources)),
      inlineUi: targets.some((target) => target.inlineUi),
    });
  }
  return routes;
}

function jsxTagEnd(syntax: string, start: number): number {
  let curly = 0;
  for (let cursor = start; cursor < syntax.length; cursor += 1) {
    const current = syntax[cursor];
    if (current === '{') curly += 1;
    else if (current === '}' && curly > 0) curly -= 1;
    else if (current === '>' && curly === 0) return cursor;
  }
  return -1;
}

function jsxAttributeValue(
  text: string,
  commentsMasked: string,
  syntax: string,
  start: number,
  end: number,
  name: string,
): PropertyValue | null {
  const pattern = new RegExp(`\\b${name}\\s*=`, 'g');
  pattern.lastIndex = start;
  const match = pattern.exec(commentsMasked);
  if (!match || match.index >= end || syntax.slice(match.index, match.index + name.length).trim() === '') return null;
  let cursor = commentsMasked.indexOf('=', match.index + name.length) + 1;
  while (cursor < end && /\s/.test(text[cursor] || '')) cursor += 1;
  const quote = text[cursor];
  if (quote === '\'' || quote === '"' || quote === '`') {
    let valueEnd = cursor + 1;
    let escaped = false;
    while (valueEnd < end) {
      const current = text[valueEnd]!;
      if (!escaped && current === quote) break;
      escaped = !escaped && current === '\\';
      if (current !== '\\') escaped = false;
      valueEnd += 1;
    }
    return { index: match.index, value: text.slice(cursor, Math.min(end, valueEnd + 1)) };
  }
  if (text[cursor] === '{') {
    const valueEnd = findMatching(syntax, cursor, '{', '}', end + 1);
    if (valueEnd >= 0) return { index: match.index, value: text.slice(cursor, valueEnd + 1) };
  }
  let valueEnd = cursor;
  while (valueEnd < end && !/[\s>]/.test(text[valueEnd] || '')) valueEnd += 1;
  return { index: match.index, value: text.slice(cursor, valueEnd) };
}

function jsxRouteUsages(text: string, unresolved?: UnresolvedRoute[]): RouteUsage[] {
  const commentsMasked = lexicalMask(text, false);
  const syntax = lexicalMask(text, true);
  const routes: RouteUsage[] = [];
  const routeTag = /<Route\b/g;
  let match: RegExpExecArray | null;
  while ((match = routeTag.exec(commentsMasked))) {
    const tagStart = match.index;
    if (syntax.slice(tagStart, tagStart + 6) !== '<Route') continue;
    const end = jsxTagEnd(syntax, tagStart);
    if (end < 0) continue;
    const pathAttribute = jsxAttributeValue(text, commentsMasked, syntax, tagStart, end, 'path');
    const routePath = literalValue(pathAttribute?.value || '');
    if (routePath === null) {
      // Attribute present but not a plain string literal (`path={courseRoute}`).
      // A pathless <Route index> / layout route has NO attribute and stays
      // silent — only an existing-but-unverifiable path is recorded.
      if (pathAttribute && unresolved) {
        unresolved.push({ display: unresolvedDisplay('path=', pathAttribute.value), line: lineAt(text, tagStart) });
      }
      continue;
    }
    const targetValues = ['element', 'Component', 'component', 'lazy']
      .map((name) => jsxAttributeValue(text, commentsMasked, syntax, tagStart, end, name))
      .filter((value): value is PropertyValue => Boolean(value))
      .map((property) => routeTarget(property.value));
    if (targetValues.length === 0) continue;
    routes.push({
      path: routePath,
      index: tagStart,
      line: lineAt(text, tagStart),
      targetNames: unique(targetValues.flatMap((target) => target.targetNames)),
      importSources: unique(targetValues.flatMap((target) => target.importSources)),
      inlineUi: targetValues.some((target) => target.inlineUi),
    });
    routeTag.lastIndex = end + 1;
  }
  return routes;
}

function phpLineCommentsMasked(text: string): string {
  const commentsMasked = lexicalMask(text, false);
  return commentsMasked.replace(/(^|\n)([ \t]*)#[^\n]*/g, (line) => (
    line.replace(/[^\n]/g, ' ')
  ));
}

function topLevelCallArguments(
  text: string,
  syntax: string,
  open: number,
  close: number,
): string[] {
  const args: string[] = [];
  let start = open + 1;
  let paren = 0;
  let square = 0;
  let curly = 0;
  for (let cursor = open + 1; cursor < close; cursor += 1) {
    const current = syntax[cursor];
    if (current === '(') paren += 1;
    else if (current === ')' && paren > 0) paren -= 1;
    else if (current === '[') square += 1;
    else if (current === ']' && square > 0) square -= 1;
    else if (current === '{') curly += 1;
    else if (current === '}' && curly > 0) curly -= 1;
    else if (current === ',' && paren === 0 && square === 0 && curly === 0) {
      args.push(text.slice(start, cursor).trim());
      start = cursor + 1;
    }
  }
  args.push(text.slice(start, close).trim());
  return args;
}

function phpArgumentExpression(value: string): string {
  return value.trim().replace(/^[A-Za-z_][A-Za-z0-9_]*\s*:\s*/, '');
}

function phpStringLiteral(value: string): string | null {
  const candidate = phpArgumentExpression(value);
  const match = /^(['"])([\s\S]*)\1$/.exec(candidate);
  if (!match) return null;
  const quote = match[1]!;
  const body = match[2]!;
  // Interpolated/dynamic double-quoted strings cannot prove an exact route or
  // module target. Simple escaped quotes/slashes are safe to normalize.
  if (quote === '"' && /(?<!\\)\$/.test(body)) return null;
  return body
    .replace(new RegExp(`\\\\${quote}`, 'g'), quote)
    .replace(/\\\\\//g, '/')
    .replace(/\\\\\\\\/g, '\\');
}

function directLaravelTargets(value: string): {
  targets: NonNullable<RouteUsage['laravelTargets']>;
  rendererObserved: boolean;
} {
  const commentsMasked = phpLineCommentsMasked(value);
  const syntax = lexicalMask(commentsMasked, true);
  const targets: NonNullable<RouteUsage['laravelTargets']> = [];
  let rendererObserved = false;
  const renderers = [
    { kind: 'view' as const, pattern: /\bview\s*\(/g },
    { kind: 'inertia' as const, pattern: /\bInertia\s*::\s*render\s*\(/g },
    { kind: 'inertia' as const, pattern: /\binertia\s*\(/g },
  ];
  for (const renderer of renderers) {
    let match: RegExpExecArray | null;
    while ((match = renderer.pattern.exec(commentsMasked))) {
      const codeToken = renderer.kind === 'view'
        ? 'view'
        : renderer.pattern.source.includes('Inertia')
          ? 'Inertia'
          : 'inertia';
      const tokenOffset = match[0].indexOf(codeToken);
      if (!syntax.slice(match.index + tokenOffset, match.index + tokenOffset + codeToken.length).trim()) {
        continue;
      }
      rendererObserved = true;
      const open = commentsMasked.indexOf('(', match.index);
      const close = open >= 0 ? findMatching(syntax, open, '(', ')') : -1;
      if (open < 0 || close < 0) continue;
      const name = phpStringLiteral(
        topLevelCallArguments(commentsMasked, syntax, open, close)[0] || '',
      );
      if (name) targets.push({ kind: renderer.kind, name });
    }
  }
  return {
    targets: targets.filter((target, index, all) => (
      all.findIndex((candidate) => (
        candidate.kind === target.kind && candidate.name === target.name
      )) === index
    )),
    rendererObserved,
  };
}

function opaqueLaravelCallable(value: string): boolean {
  const candidate = value.trim();
  if (!candidate) return false;
  // Closures are inspectable: if they did not contain a literal view/Inertia
  // renderer, the route-to-module relationship is not demonstrated.
  if (/^(?:static\s+)?function\b|^fn\b/.test(candidate)) return false;
  // Class callables, controller arrays/strings, invokable classes, controller
  // group method strings, and runtime callable variables are all legitimate
  // Laravel routing forms. Their target remains deliberately indeterminate.
  return true;
}

function laravelRouteUsages(text: string): RouteUsage[] {
  const commentsMasked = phpLineCommentsMasked(text);
  const syntax = lexicalMask(commentsMasked, true);
  const routes: RouteUsage[] = [];
  const routeCall = /\bRoute\s*::\s*(view|inertia|get|post|put|patch|delete|options|any|match)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = routeCall.exec(commentsMasked))) {
    if (!syntax.slice(match.index, match.index + 5).trim()) continue;
    const method = match[1]!.toLowerCase();
    const open = commentsMasked.indexOf('(', match.index);
    const close = open >= 0 ? findMatching(syntax, open, '(', ')') : -1;
    if (open < 0 || close < 0) continue;
    const args = topLevelCallArguments(commentsMasked, syntax, open, close);
    const pathIndex = method === 'match' ? 1 : 0;
    const routePath = phpStringLiteral(args[pathIndex] || '');
    if (routePath === null) continue;
    const normalizedPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
    const targetValue = phpArgumentExpression(args[pathIndex + 1] || '');
    let laravelTargets: NonNullable<RouteUsage['laravelTargets']> = [];
    let rendererObserved = false;
    if (method === 'view' || method === 'inertia') {
      const name = phpStringLiteral(targetValue);
      rendererObserved = true;
      if (name) laravelTargets = [{
        kind: method === 'view' ? 'view' : 'inertia',
        name,
      }];
    } else {
      const direct = directLaravelTargets(targetValue);
      laravelTargets = direct.targets;
      rendererObserved = direct.rendererObserved;
    }
    routes.push({
      path: normalizedPath,
      index: match.index,
      line: lineAt(text, match.index),
      targetNames: [],
      importSources: [],
      inlineUi: false,
      laravelTargets,
      opaqueLaravelTarget: laravelTargets.length === 0
        && !rendererObserved
        && opaqueLaravelCallable(targetValue),
    });
    routeCall.lastIndex = close + 1;
  }
  return routes;
}

function importBindings(text: string): ImportBinding[] {
  const source = lexicalMask(text, false);
  const syntax = lexicalMask(text, true);
  const bindings: ImportBinding[] = [];
  const staticImport = /\bimport\s+(?!\s*\()([\s\S]*?)\s+from\s*(['"])([^'"\r\n]+)\2/g;
  let match: RegExpExecArray | null;
  while ((match = staticImport.exec(source))) {
    if (syntax.slice(match.index, match.index + 6) !== 'import' || match[1]!.length > 2_000) continue;
    const clause = match[1]!.trim().replace(/^type\s+/, '');
    const importSource = match[3]!;
    const defaultImport = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|$)/.exec(clause);
    if (defaultImport) {
      bindings.push({ local: defaultImport[1]!, imported: 'default', source: importSource });
    }
    const namespaceImport = /\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(clause);
    if (namespaceImport) {
      bindings.push({ local: namespaceImport[1]!, imported: '*', source: importSource });
    }
    const namedImports = /\{([\s\S]*?)\}/.exec(clause);
    for (const part of namedImports?.[1]?.split(',') || []) {
      const names = /^(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(part.trim());
      if (!names) continue;
      bindings.push({
        local: names[2] || names[1]!,
        imported: names[1]!,
        source: importSource,
      });
    }
  }

  const lazyBinding = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:React\.)?lazy\s*\([\s\S]{0,300}?\bimport\s*\(\s*(['"])([^'"]+)\2\s*\)/g;
  while ((match = lazyBinding.exec(source))) {
    if (syntax.slice(match.index, match.index + match[0].indexOf(match[1]!)).trim() === '') continue;
    bindings.push({ local: match[1]!, imported: 'default', source: match[3]! });
  }
  return bindings;
}

function analyzeText(file: string, text: string): SourceAnalysis {
  const source = lexicalMask(text, false);
  const isPhp = /\.php$/i.test(file);
  const unresolvedRoutes: UnresolvedRoute[] = [];
  return {
    file,
    text,
    components: ANALYZABLE_UI_RE.test(file) ? declaredComponents(text) : [],
    functionCount: topLevelFunctionCount(lexicalMask(text, true)),
    imports: importBindings(text),
    routes: isPhp
      ? laravelRouteUsages(text)
      : ANALYZABLE_UI_RE.test(file)
        ? [...objectRouteUsages(text, unresolvedRoutes), ...jsxRouteUsages(text, unresolvedRoutes)]
        : [],
    unresolvedRoutes,
    routerSignal: /(?:createBrowserRouter|createRoutesFromElements|<Route\b|<RouterProvider\b|useRoutes\s*\(|\bpath\s*:)/.test(source),
    inlineHostUi: ANALYZABLE_UI_RE.test(file) ? firstInlineHostUi(text) : null,
  };
}

function isEntrypoint(file: string, profile: CapabilityProfileV1): boolean {
  const normalized = normalizeRel(file);
  return profile.entrypoints.some((entry) => normalizeRel(entry) === normalized)
    || /(^|\/)(?:main|client)\.(?:tsx?|jsx?|mjs|cjs)$/.test(normalized);
}

function isBootstrapEntrypoint(file: string, profile: CapabilityProfileV1): boolean {
  const normalized = normalizeRel(file);
  if (/(^|\/)(?:main|client)\.(?:tsx?|jsx?|mjs|cjs)$/.test(normalized)) return true;
  return ['vite-react', 'generic-web'].includes(profile.profileId)
    && profile.entrypoints.some((entry) => normalizeRel(entry) === normalized);
}

function underAny(file: string, roots: string[]): boolean {
  const normalized = normalizeRel(file);
  return roots.some((root) => {
    const normalizedRoot = normalizeRel(root).replace(/\/+$/, '');
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
  });
}

function pageLike(name: string): boolean {
  return /(?:Page|Screen|View)$/.test(name)
    || /^(?:Home|Catalog|CourseDetail|Lesson|Learning|News|Dashboard|Profile|Settings)$/.test(name);
}

function exceptionCovers(
  finding: StructureFinding,
  exceptions: ArchitectureExceptionRequestV1[],
): boolean {
  if (!EXCEPTIONABLE_IDS.has(finding.id)) return false;
  return exceptions.some((exception) => (
    exception.ruleId === finding.id
    && matchesPattern(finding.file, exception.glob)
  ));
}

function localFindings(
  analysis: SourceAnalysis,
  profile: CapabilityProfileV1,
  exceptions: ArchitectureExceptionRequestV1[],
): StructureFinding[] {
  const findings: StructureFinding[] = [];
  const componentNames = new Set(analysis.components.map((component) => component.name));
  const localTargets = unique(analysis.routes.flatMap((route) => (
    route.targetNames
      .map((name) => name.split('.')[0]!)
      .filter((name) => componentNames.has(name))
  )));
  const localRouteUnits = unique(analysis.routes.flatMap((route) => {
    const named = route.targetNames
      .map((name) => name.split('.')[0]!)
      .filter((name) => componentNames.has(name))
      .map((name) => `component:${name}`);
    return route.inlineUi ? [...named, `inline:${route.index}`] : named;
  }));
  const inlineRoutes = analysis.routes.filter((route) => route.inlineUi);
  const pageComponents = analysis.components.filter((component) => (
    localTargets.includes(component.name) || pageLike(component.name)
  ));

  if (
    isEntrypoint(analysis.file, profile)
    && (analysis.components.length > 0 || inlineRoutes.length > 0 || analysis.inlineHostUi)
    && (
      isBootstrapEntrypoint(analysis.file, profile)
      || analysis.routerSignal
      || analysis.components.length > 1
    )
  ) {
    const first = analysis.components[0];
    const inline = inlineRoutes[0];
    const direct = analysis.inlineHostUi;
    findings.push({
      id: 'STRUCT_ENTRYPOINT_COMPONENT',
      severity: 'error',
      file: analysis.file,
      line: first?.line || inline?.line || direct?.line,
      message: first
        ? `Entrypoint declares UI component ${first.name}; entrypoints may only bootstrap providers and the application shell.`
        : inline
          ? `Entrypoint declares UI markup inline for route ${inline.path}; entrypoints may only bootstrap providers and the application shell.`
          : 'Entrypoint declares UI markup inline; entrypoints may only bootstrap providers and the application shell.',
    });
  }

  const appShell = /(^|\/)App\.(?:tsx?|jsx?)$/.test(analysis.file);
  if (appShell && localRouteUnits.length >= 1) {
    const first = analysis.components.find((component) => localTargets.includes(component.name));
    findings.push({
      id: 'STRUCT_APP_INLINE_PAGE',
      severity: 'error',
      file: analysis.file,
      line: first?.line || inlineRoutes[0]?.line,
      message: 'Application shell declares a route page inline; pages must live in their compiled page modules.',
    });
  }

  if (localRouteUnits.length >= 2) {
    findings.push({
      id: 'STRUCT_MULTI_PAGE_MODULE',
      severity: 'error',
      file: analysis.file,
      line: pageComponents[0]?.line || inlineRoutes[0]?.line,
      message: `Module contains multiple inline page/route targets (${localTargets.length > 0 ? localTargets.join(', ') : inlineRoutes.map((route) => route.path).join(', ')}).`,
    });
  }

  if (
    pageComponents.length > 0
    && !underAny(analysis.file, profile.layerRoots.pages)
    && !isEntrypoint(analysis.file, profile)
    && !appShell
  ) {
    findings.push({
      id: 'STRUCT_LAYER_MISMATCH',
      severity: 'error',
      file: analysis.file,
      line: pageComponents[0]?.line,
      message: 'Route page is outside the runtime-compiled page roots.',
    });
  }

  // Comments and string bodies are masked first: a module is "too long" by its
  // code, not its documentation, and counting comment lines would also break the
  // pretty-vs-minified parity the rest of this scanner guarantees (610 lines of
  // `// filler` must not outrank the same code on one line).
  const collapsedLine = collapsedLineNumber(analysis.file, analysis.text);
  if (collapsedLine !== null) {
    findings.push({
      id: 'STRUCT_COLLAPSED_LINE',
      severity: 'error',
      file: analysis.file,
      line: collapsedLine,
      message: `Line ${collapsedLine} packs an entire function/component onto one line. Collapsed source is a defect even when build and typecheck pass — write one statement per line and one JSX element per line.`,
    });
  }

  const moduleLoc = GENERATED_MODULE_RE.test(analysis.file)
    ? 0
    : logicalLoc(lexicalMask(analysis.text, true));
  if (moduleLoc > BLOCKING_MODULE_LOC) {
    findings.push({
      id: 'STRUCT_MODULE_LOC',
      severity: 'error',
      file: analysis.file,
      message: `Module is approximately ${moduleLoc} logical lines, over the ${BLOCKING_MODULE_LOC} limit. Split it along its own seams — routes, pages, features, and shared components each belong in their own module under the compiled layer roots.`,
    });
  }

  if (analysis.components.length > 1) {
    findings.push({
      id: 'STRUCT_COMPONENTS_PER_FILE',
      severity: 'warning',
      file: analysis.file,
      line: analysis.components[1]?.line,
      message: `Module declares ${analysis.components.length} UI components; the numeric one-component-per-file limit is advisory during rollout.`,
    });
  }
  for (const component of analysis.components) {
    if (component.logicalLoc <= 150) continue;
    findings.push({
      id: 'STRUCT_COMPONENT_LOC',
      severity: 'warning',
      file: analysis.file,
      line: component.line,
      message: `${component.name} is approximately ${component.logicalLoc} logical lines; the 150 LOC threshold is advisory during rollout.`,
    });
  }
  if (analysis.functionCount > ADVISORY_FUNCTION_COUNT) {
    findings.push({
      id: 'STRUCT_FUNCTION_COUNT',
      severity: 'warning',
      file: analysis.file,
      message: `Module declares ${analysis.functionCount} top-level functions; the ${ADVISORY_FUNCTION_COUNT}-function threshold is advisory during rollout.`,
    });
  }
  if (analysis.unresolvedRoutes.length > 0) {
    const first = analysis.unresolvedRoutes[0]!;
    findings.push({
      id: 'STRUCT_ROUTE_PATH_UNRESOLVED',
      severity: 'warning',
      file: analysis.file,
      line: first.line,
      message: `${analysis.unresolvedRoutes.length} route path value(s) (e.g. \`${first.display}\`) are not plain string literals, so contract verification cannot see them; prefer literal \`path\` strings.`,
    });
  }
  return findings.filter((finding) => !exceptionCovers(finding, exceptions));
}

export function invalidateStructureCache(filePath: string): void {
  cache.delete(path.resolve(filePath));
}

export function analyzeStructureText(
  file: string,
  text: string,
  profile: CapabilityProfileV1,
  exceptions: ArchitectureExceptionRequestV1[] = [],
): StructureFinding[] {
  return localFindings(analyzeText(normalizeRel(file), text), profile, exceptions);
}

export interface StructureTextContractOptions {
  allowlist?: string[];
  assignmentScope?: AssignedScope;
}

function profileUsesExplicitRouter(profile: CapabilityProfileV1): boolean {
  return [
    'vite-react',
    'generic-web',
    'vue',
    'angular',
  ].includes(profile.profileId)
    || (
      profile.profileId === 'server-rendered'
      && profile.framework === 'laravel'
    );
}

/**
 * Contract-aware hot path. It evaluates only the proposed contents of the
 * touched file, but still proves that every route observed in that file points
 * at the runtime-compiled module and that the work unit covers its planned
 * outputs. Missing routes/modules remain the responsibility of the complete
 * IMPLEMENTED/APPROVED scan.
 */
export function analyzeStructureTextAgainstContract(
  file: string,
  text: string,
  contract: CompiledArchitectureV1,
  options: StructureTextContractOptions = {},
): StructureFinding[] {
  const analysis = analyzeText(normalizeRel(file), text);
  const findings = localFindings(analysis, contract.profile, contract.exceptions);
  if (profileUsesExplicitRouter(contract.profile)) {
    const cause = unresolvedRouteNote([analysis]);
    for (const usage of analysis.routes) {
      const routePath = normalizedRoutePath(usage.path);
      const compiled = contract.routes.filter((route) => (
        !route.redirect && normalizedRoutePath(route.path) === routePath
      ));
      if (compiled.length > 0 && compiled.some((route) => (
        routeUsesModule(analysis, usage, route.moduleOutput)
      ))) continue;
      findings.push({
        id: 'STRUCT_ROUTE_MODULE_MISMATCH',
        severity: 'error',
        file: analysis.file,
        line: usage.line,
        message: (compiled.length === 0
          ? `Route ${usage.path} is not present in the runtime-compiled architecture contract.`
          : `Route ${usage.path} does not use its runtime-compiled module ${compiled.map((route) => route.moduleOutput).join(' or ')}.`) + cause,
      });
    }
  }
  if (options.allowlist !== undefined || options.assignmentScope) {
    for (const output of contract.allowedOutputs) {
      const covered = options.assignmentScope
        ? matchesScope(output, options.assignmentScope)
        : options.allowlist!.some((pattern) => matchesPattern(output, pattern));
      if (covered) continue;
      findings.push({
        id: 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP',
        severity: 'error',
        file: output,
        message: 'Planned output is not covered by the work-unit assignment allowlist.',
      });
    }
  }
  return findings.sort((a, b) => (
    a.id.localeCompare(b.id)
    || a.file.localeCompare(b.file)
    || (a.line || 0) - (b.line || 0)
  ));
}

function cachedAnalysis(projectRoot: string, file: string): SourceAnalysis {
  const absolute = path.join(projectRoot, file);
  const stat = fs.statSync(absolute);
  const existing = cache.get(absolute);
  if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) return existing.analysis;
  const analysis = analyzeText(file, fs.readFileSync(absolute, 'utf8'));
  cache.set(absolute, { mtimeMs: stat.mtimeMs, size: stat.size, analysis });
  return analysis;
}

function walkSourceFiles(
  projectRoot: string,
  roots: string[],
  maxFiles: number,
): { files: string[]; incomplete: string | null } {
  const files: string[] = [];
  const seenDirs = new Set<string>();
  const resolvedProjectRoot = path.resolve(projectRoot);
  let realProjectRoot: string;
  try { realProjectRoot = fs.realpathSync(resolvedProjectRoot); } catch {
    return { files, incomplete: 'cannot resolve project root' };
  }
  const requestedRoots = [...new Set(roots
    .map((root) => path.resolve(projectRoot, normalizeRel(root)))
  )];
  const outsideRoot = requestedRoots.find((root) => (
    root !== resolvedProjectRoot && !root.startsWith(`${resolvedProjectRoot}${path.sep}`)
  ));
  if (outsideRoot) {
    return {
      files,
      incomplete: `source root escapes project boundary: ${normalizeRel(path.relative(projectRoot, outsideRoot))}`,
    };
  }
  const stack: string[] = [];
  const unresolvedRoots: string[] = [];
  for (const root of requestedRoots) {
    const rootRel = normalizeRel(path.relative(resolvedProjectRoot, root));
    let rootCursor = resolvedProjectRoot;
    let symbolicRootSegment: string | null = null;
    for (const segment of rootRel.split('/').filter(Boolean)) {
      rootCursor = path.join(rootCursor, segment);
      try {
        if (fs.lstatSync(rootCursor).isSymbolicLink()) {
          symbolicRootSegment = normalizeRel(path.relative(projectRoot, rootCursor));
          break;
        }
      } catch {
        break;
      }
    }
    if (symbolicRootSegment) {
      return {
        files,
        incomplete: `source root contains symbolic link: ${symbolicRootSegment}`,
      };
    }
    let real: string;
    try {
      real = fs.realpathSync(root);
      if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
    } catch {
      // Capability profiles carry alternative roots (for example Next app and
      // src/app, or Nuxt app and the configured srcDir). An absent alternative
      // contains no files to scan. The scan is incomplete only when none of the
      // compiled roots can be resolved.
      unresolvedRoots.push(normalizeRel(path.relative(projectRoot, root)) || '.');
      continue;
    }
    if (real !== realProjectRoot && !real.startsWith(`${realProjectRoot}${path.sep}`)) {
      return {
        files,
        incomplete: `source root resolves outside project boundary: ${normalizeRel(path.relative(projectRoot, root)) || '.'}`,
      };
    }
    stack.push(root);
  }
  if (stack.length === 0 && requestedRoots.length > 0) {
    return {
      files,
      incomplete: `cannot resolve source root${unresolvedRoots.length === 1 ? '' : 's'} ${unresolvedRoots.join(', ')}`,
    };
  }
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let real: string;
    try { real = fs.realpathSync(dir); } catch {
      return { files, incomplete: `cannot resolve source directory ${normalizeRel(path.relative(projectRoot, dir))}` };
    }
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {
      return { files, incomplete: `cannot read source directory ${normalizeRel(path.relative(projectRoot, dir))}` };
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const rel = normalizeRel(path.relative(projectRoot, absolute));
      if (SKIP_RE.test(`/${rel}`)) continue;
      if (entry.isSymbolicLink()) {
        return { files, incomplete: `source scan encountered symbolic link: ${rel}` };
      }
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile() || !STRUCTURAL_SOURCE_RE.test(entry.name)) continue;
      if (files.length >= maxFiles) {
        return { files, incomplete: `source scan exceeds ${maxFiles} files` };
      }
      files.push(rel);
    }
  }
  files.sort();
  return { files, incomplete: null };
}

function withoutModuleExtension(value: string): string {
  return normalizeRel(value).replace(/\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro|html)$/, '');
}

// Shared with the architecture contract so a route declared as `*` (or `/*`)
// matches the `path="*"` every router uses in code. Comparing the two spellings
// literally made the catch-all unsatisfiable from both directions.
const normalizedRoutePath = canonicalRoutePath;

function sourceMatchesModule(
  importerFile: string,
  importSource: string,
  moduleOutput: string,
): boolean {
  const outputStem = withoutModuleExtension(moduleOutput);
  const sourceStem = withoutModuleExtension(importSource);
  if (importSource.startsWith('.')) {
    const resolved = normalizeRel(path.posix.normalize(path.posix.join(
      path.posix.dirname(normalizeRel(importerFile)),
      sourceStem,
    )));
    return resolved === outputStem;
  }
  const aliasTail = sourceStem.startsWith('@/') || sourceStem.startsWith('~/')
    ? sourceStem.slice(2)
    : sourceStem.startsWith('/')
      ? sourceStem.slice(1)
      : /^@[^/]+\//.test(sourceStem)
        ? sourceStem.replace(/^@[^/]+\//, '')
        : sourceStem;
  return aliasTail.includes('/')
    && (outputStem === aliasTail || outputStem.endsWith(`/${aliasTail}`));
}

function bindingMatchesModule(
  analysis: SourceAnalysis,
  targetName: string,
  binding: ImportBinding,
  moduleOutput: string,
): boolean {
  if (sourceMatchesModule(analysis.file, binding.source, moduleOutput)) return true;
  const outputStem = withoutModuleExtension(moduleOutput);
  const outputName = path.posix.basename(outputStem);
  const outputDir = path.posix.dirname(outputStem);
  const targetParts = targetName.split('.');
  if (binding.imported === '*' && targetParts[1] !== outputName) return false;
  if (binding.imported !== '*' && binding.imported !== outputName && binding.imported !== 'default') return false;
  if (!binding.source.startsWith('.')) return false;
  const resolvedSource = normalizeRel(path.posix.normalize(path.posix.join(
    path.posix.dirname(normalizeRel(analysis.file)),
    withoutModuleExtension(binding.source),
  )));
  return resolvedSource === outputDir;
}

function routeUsesModule(
  analysis: SourceAnalysis,
  route: RouteUsage,
  moduleOutput: string,
): boolean {
  const normalizedOutput = normalizeRel(moduleOutput);
  if (route.laravelTargets?.some((target) => {
    const normalizedName = target.name
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .replace(/\./g, '/');
    if (!normalizedName || normalizedName.includes('::')) return false;
    if (target.kind === 'view') {
      return normalizedOutput === `resources/views/${normalizedName}.blade.php`;
    }
    const outputStem = normalizedOutput.replace(/\.(?:tsx?|jsx?|vue)$/, '');
    const inertiaStem = /^resources\/js\/(?:Pages|pages)\/(.+)$/.exec(outputStem)?.[1] || '';
    return inertiaStem === normalizedName;
  })) {
    return true;
  }
  if (route.opaqueLaravelTarget) {
    // Controller execution is intentionally outside this static analyzer. The
    // caller already proved the compiled page file exists, so accepting this
    // indeterminate edge avoids rejecting valid controller routing while still
    // failing closed for absent routes and directly mismatched render targets.
    return true;
  }
  if (route.importSources.some((source) => sourceMatchesModule(analysis.file, source, moduleOutput))) {
    return true;
  }
  return route.targetNames.some((targetName) => {
    const local = targetName.split('.')[0]!;
    return analysis.imports
      .filter((binding) => binding.local === local)
      .some((binding) => bindingMatchesModule(analysis, targetName, binding, moduleOutput));
  });
}

// The actionable CAUSE for an unmatched contract route: when any analyzed file
// carries a non-literal `path`, the extractor could not see that route at all.
// Without this note the deny points at the page module with no line and no
// explanation (observed 1co: the agent kept "fixing" the slash instead of the
// literal until the run died).
function unresolvedRouteNote(analyses: readonly SourceAnalysis[]): string {
  const carriers = analyses.filter((analysis) => analysis.unresolvedRoutes.length > 0);
  if (carriers.length === 0) return '';
  const total = carriers.reduce((sum, analysis) => sum + analysis.unresolvedRoutes.length, 0);
  const sample = carriers[0]!;
  const first = sample.unresolvedRoutes[0]!;
  return ` NOTE: ${total} non-literal route path value(s) (e.g. \`${first.display}\` at ${sample.file}:${first.line}) cannot be verified — route \`path\` must be a plain string literal in the JSX attribute/object property.`;
}

function contractFindings(
  projectRoot: string,
  contract: CompiledArchitectureV1,
  analyses: SourceAnalysis[],
  allowlist: string[] | undefined,
  assignmentScope: AssignedScope | undefined,
): StructureFinding[] {
  const findings: StructureFinding[] = [];
  for (const module of contract.modules) {
    if (!fs.existsSync(path.join(projectRoot, module.output))) {
      findings.push({
        id: 'STRUCT_MISSING_PLANNED_MODULE',
        severity: 'error',
        file: module.output,
        message: `Compiled ${module.kind} module is missing.`,
      });
    }
  }

  if (profileUsesExplicitRouter(contract.profile)) {
    const cause = unresolvedRouteNote(analyses);
    for (const route of contract.routes.filter((item) => !item.redirect)) {
      if (!fs.existsSync(path.join(projectRoot, route.moduleOutput))) continue;
      const routePath = normalizedRoutePath(route.path);
      const matchingUsages = analyses.flatMap((analysis) => (
        analysis.routes
          .filter((usage) => normalizedRoutePath(usage.path) === routePath)
          .map((usage) => ({ analysis, usage }))
      ));
      if (!matchingUsages.some(({ analysis, usage }) => (
        routeUsesModule(analysis, usage, route.moduleOutput)
      ))) {
        findings.push({
          id: 'STRUCT_ROUTE_MODULE_MISMATCH',
          severity: 'error',
          file: route.moduleOutput,
          message: `Route ${route.path} does not demonstrably use its compiled module ${route.moduleOutput}.${cause}`,
        });
      }
    }
  }

  if (allowlist || assignmentScope) {
    for (const output of contract.allowedOutputs) {
      if (assignmentScope ? matchesScope(output, assignmentScope) : allowlist!.some((pattern) => matchesPattern(output, pattern))) continue;
      findings.push({
        id: 'STRUCT_ASSIGNMENT_ALLOWLIST_GAP',
        severity: 'error',
        file: output,
        message: 'Planned output is not covered by the work-unit assignment allowlist.',
      });
    }
  }
  return findings;
}

export function analyzeProjectStructure(
  projectRoot: string,
  contract: CompiledArchitectureV1,
  options: StructureScanOptions = {},
): StructureReportV1 {
  const maxFiles = Math.max(1, Math.floor(options.maxFiles || STRUCTURE_SCAN_DEFAULT_MAX_FILES));
  const laravelRouteRoots = contract.profile.profileId === 'server-rendered'
    && contract.profile.framework === 'laravel'
    ? ['routes']
    : [];
  const walked = walkSourceFiles(
    projectRoot,
    [...new Set([...contract.sourceRoots, ...laravelRouteRoots])],
    maxFiles,
  );
  const analyses: SourceAnalysis[] = [];
  let incomplete = walked.incomplete;
  for (const file of walked.files) {
    try {
      analyses.push(cachedAnalysis(projectRoot, file));
    } catch {
      incomplete = `cannot read source file ${file}`;
      break;
    }
  }
  const findings = analyses.flatMap((analysis) => (
    localFindings(analysis, contract.profile, contract.exceptions)
  ));
  findings.push(...contractFindings(projectRoot, contract, analyses, options.allowlist, options.assignmentScope));
  if (incomplete) {
    findings.push({
      id: 'STRUCT_SCAN_INCOMPLETE',
      severity: 'error',
      file: '<scan>',
      message: incomplete,
    });
  }
  findings.sort((a, b) => (
    a.id.localeCompare(b.id)
    || a.file.localeCompare(b.file)
    || (a.line || 0) - (b.line || 0)
  ));
  const failed = findings.some((finding) => finding.severity === 'error');
  return {
    schemaVersion: STRUCTURE_REPORT_SCHEMA_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    contractHash: contract.contractHash,
    status: failed ? 'failed' : findings.length ? 'warnings' : 'passed',
    complete: !incomplete,
    filesScanned: analyses.length,
    findings,
  };
}

export function writeStructureReport(
  projectRoot: string,
  runId: string,
  report: StructureReportV1,
): string {
  const reportPath = path.join(projectRoot, '.traffic-one', 'runs', runId, 'structure-report.json');
  writeJson(reportPath, report);
  return reportPath;
}
