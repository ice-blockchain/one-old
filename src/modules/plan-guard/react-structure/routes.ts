// src/modules/plan-guard/react-structure/routes.ts
// Route extraction from object router tables and JSX <Route> elements.

import * as path from 'path';
import {  lexicalMask } from '../../../shared/collapsed-source';

import {
  type RouteUsage,
  type UnresolvedRoute,
} from './types';
import {
  enclosingCurly,
  findMatching,
  lineAt,
  literalValue,
  objectProperties,
  unique,
  type PropertyValue,
} from './parse';

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

export function objectRouteUsages(text: string, unresolved?: UnresolvedRoute[]): RouteUsage[] {
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

export function jsxRouteUsages(text: string, unresolved?: UnresolvedRoute[]): RouteUsage[] {
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
