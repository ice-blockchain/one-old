// src/modules/plan-guard/react-structure/parse.ts
// Formatting-independent source parsing built on the shared lexical mask:
// component declarations, logical LOC, brace/JSX scanning primitives.

import * as path from 'path';
import { collapsedLineNumber, lexicalMask } from '../../../shared/collapsed-source';

import {
  type ComponentDeclaration,
} from './types';

export function normalizeRel(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
}

export function lineAt(text: string, index: number): number {
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

export function topLevelFunctionCount(masked: string): number {
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

export function firstInlineHostUi(text: string): { index: number; line: number } | null {
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

export function logicalLoc(segment: string): number {
  const withoutWhitespace = segment.trim();
  if (!withoutWhitespace) return 0;
  const physical = withoutWhitespace.split(/\r?\n/).filter((line) => line.trim()).length;
  const statements = (withoutWhitespace.match(/;/g) || []).length + 1;
  const jsxNodes = (withoutWhitespace.match(/<\/[A-Za-z][^>]*>/g) || []).length;
  return Math.max(physical, statements, jsxNodes);
}

export function declaredComponents(text: string): ComponentDeclaration[] {
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

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function findMatching(
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

export function enclosingCurly(syntax: string, index: number): number {
  const stack: number[] = [];
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (syntax[cursor] === '{') stack.push(cursor);
    else if (syntax[cursor] === '}') stack.pop();
  }
  return stack[stack.length - 1] ?? -1;
}

export interface PropertyValue {
  index: number;
  value: string;
}

export function objectProperties(
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

export function literalValue(value: string): string | null {
  let candidate = value.trim();
  if (candidate.startsWith('{') && candidate.endsWith('}')) {
    candidate = candidate.slice(1, -1).trim();
  }
  const match = /^(['"`])([^'"`]*)\1$/.exec(candidate);
  return match?.[2] || null;
}

