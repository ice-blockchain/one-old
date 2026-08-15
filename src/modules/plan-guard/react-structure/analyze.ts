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

// Blade references its partials with DIRECTIVES, not ES imports, so a template
// that includes a planned component produced no binding at all — moduleReferenced
// could never be true and STRUCT_ORPHAN_MODULE fired on every Blade component in
// a Laravel project. A directive is the only way to reference a Blade partial,
// so the analyzer has to read one.
//
// Dotted view names resolve the way Laravel resolves them: `components.Card`
// becomes `resources/views/components/Card.blade.php`, which is exactly the
// compiled module output, so the existing path comparison then matches.
function bladeBindings(text: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  const viewPath = (name: string): string => (
    `resources/views/${name.trim().replace(/^\/+|\/+$/g, '').replace(/\./g, '/')}.blade.php`
  );

  // @include('a.b'), @includeIf/@includeWhen/@includeFirst, @extends, @component
  const directive = /@(?:include(?:If|When|First|Unless)?|extends|component)\s*\(\s*(['"])([^'"]+)\1/g;
  for (let match = directive.exec(text); match; match = directive.exec(text)) {
    const name = match[2]!;
    if (!name || name.includes('::')) continue;
    bindings.push({ local: '', imported: 'default', source: viewPath(name) });
  }

  // <x-foo.bar /> — Laravel's component tag. It resolves under components/, and
  // the dot is a directory separator exactly as in a dotted view name.
  const tag = /<x-([A-Za-z0-9._-]+)/g;
  for (let match = tag.exec(text); match; match = tag.exec(text)) {
    bindings.push({ local: '', imported: 'default', source: viewPath(`components.${match[1]!}`) });
  }
  return bindings;
}

function importBindings(text: string, file = ''): ImportBinding[] {
  const source = lexicalMask(text, false);
  const syntax = lexicalMask(text, true);
  const bindings: ImportBinding[] = [];
  if (/\.blade\.php$/i.test(file)) bindings.push(...bladeBindings(text));
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

  // Bare `import('…')` (route-object `lazy: () => import('./feature')`,
  // inline `lazy(() => import('./x'))` without a const binding). The orphan
  // check only reads import bindings; without these, a lazy-loaded feature
  // barrel looked unreferenced and IMPLEMENTED was offered `--unblock`.
  const dynamicImport = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((match = dynamicImport.exec(source))) {
    if (syntax.slice(match.index, match.index + 6) !== 'import') continue;
    bindings.push({ local: '', imported: 'default', source: match[2]! });
  }

  // Re-exports count as references: a barrel's `export { X } from './x'` /
  // `export * from './x'` keeps the target module reachable. Without these
  // bindings the orphan-module check would flag every barrel-routed module.
  const reExport = /\bexport\s+(?:\*(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?|\{[\s\S]*?\})\s*from\s*(['"])([^'"\r\n]+)\1/g;
  while ((match = reExport.exec(source))) {
    if (syntax.slice(match.index, match.index + 6) !== 'export') continue;
    bindings.push({ local: '*', imported: '*', source: match[2]! });
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
    imports: importBindings(text, file),
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

