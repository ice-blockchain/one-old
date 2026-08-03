// src/modules/plan-guard/react-structure/laravel.ts
// Laravel route extraction: php masking, Route:: calls, view/inertia
// targets, and opaque controller callables.

import * as path from 'path';
import {  lexicalMask } from '../../../shared/collapsed-source';

import {
  type RouteUsage,
} from './types';
import {
  findMatching,
  lineAt,
} from './parse';

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

export function laravelRouteUsages(text: string): RouteUsage[] {
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

