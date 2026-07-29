// src/modules/plan-guard/react-structure/analyze.ts
// Import bindings + the per-file analyzeText entry over parse/routes/laravel.

import {  lexicalMask } from '../../../shared/collapsed-source';

import {
  type ImportBinding,
  type SourceAnalysis,
  type UnresolvedRoute,
  ANALYZABLE_UI_RE,
} from './types';
import {
  declaredComponents,
  firstInlineHostUi,
  topLevelFunctionCount,
} from './parse';
import {
  jsxRouteUsages,
  objectRouteUsages,
} from './routes';
import {
  laravelRouteUsages,
} from './laravel';

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

export function analyzeText(file: string, text: string): SourceAnalysis {
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

