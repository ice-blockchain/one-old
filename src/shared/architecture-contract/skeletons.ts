// src/shared/architecture-contract/skeletons.ts
// Compliant module skeletons: models edit, they don't author.
//
// Most observed 13co denies (collapsed source, hardcoded copy, catalog parity)
// began with de-novo authoring of files whose SHAPE is compiled knowledge: the
// module kind, its export name (Pascal from the module name — naming.ts), its
// i18n namespace, and the catalog layout are all facts the compiler already
// holds. So the runtime materializes a minimal compliant skeleton for every
// compiled UI module at its DEFAULT output path (ensureScaffoldContent, same
// missing-or-blank rule as every other seed) and implementers EDIT compliant
// code instead of authoring from nothing.
//
// The shapes deliberately mirror the run-sim source generators
// (src/test-environment/core/run-sim/sources.ts), which are proven against the
// real gate pipeline end to end — this module is the shipped subset of those
// shapes, not a second invention. Profiles with no validated generator shape
// there (Svelte, Astro, Angular, every native profile) return null ON PURPOSE:
// the PLAN_READY satisfiability sweep runs these exact bodies through the
// blocking write gates, so an unproven skeleton that trips a gate would turn
// the sweep into a false deny of PLAN_READY itself — worse than the missed
// seeding. Add a profile here only together with its run-sim shape.
//
// Pure generation, no filesystem access: scaffold-content.ts owns the writes
// and the catalog-key seeding; plan-readiness/satisfiability.ts judges the
// same bodies in memory.

import * as path from 'path';

import {
  type CompiledArchitectureModuleV1,
  type CompiledArchitectureV1,
} from './types';
import {
  kebab,
  pascal,
} from './naming';
import {
  architectureModuleNamespace,
  profileUsesReactI18n,
} from './i18n';

/** Structurally compatible with i18n-enforcement's I18nReference. */
export interface ModuleSkeletonReferenceV1 {
  namespace: string;
  key: string;
  line: number;
  /** Declared source-language copy — what makes the catalog seed deterministic. */
  fallback: string;
}

export interface ModuleSkeletonV1 {
  content: string;
  /** Catalog keys the skeleton's copy references, for all-locale seeding. */
  references: ModuleSkeletonReferenceV1[];
}

const NATIVE_PROFILE_IDS = new Set([
  'react-native',
  'swift-native',
  'kotlin-native',
  'flutter-native',
]);

function componentNameOf(output: string): string {
  return path.posix.basename(output).replace(/\.[^.]+$/, '');
}

// posix on purpose: contract paths are normalized posix and the emitted import
// specifier must stay forward-slashed on every host.
function relativeModuleImport(fromOutput: string, toOutput: string): string {
  const rel = path.posix.relative(path.posix.dirname(fromOutput), toOutput);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

// Visible source-language fallback copy derived from the module name. Markup
// metacharacters are stripped so a name can never escape JSX/template text
// position, and the result is guaranteed longer than one character — a shorter
// string is not a valid <Trans> fallback and would deny the skeleton in the
// satisfiability sweep.
function skeletonCopy(module: CompiledArchitectureModuleV1): string {
  const cleaned = module.name
    .replace(/[<>{}"`\\&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 1 ? cleaned : `${pascal(module.name)} module`;
}

// The namespace derivation mirrors architectureI18nNamespaces exactly: that
// helper builds its route-by-module map with `new Map(...)`, which keeps the
// LAST route for a module, so the last one is authoritative here too.
function routeFor(
  compiled: CompiledArchitectureV1,
  module: CompiledArchitectureModuleV1,
): { id: string } | undefined {
  const routes = compiled.routes.filter((route) => (
    route.redirect !== true && route.moduleId === module.id
  ));
  return routes[routes.length - 1];
}

// The shared Tailwind/theme stylesheet import — only when the compiled contract
// actually scaffolds the package (shadcn family). The UI-system completion
// check requires the application to consume the catalog's theme; a profile
// without the package must not import a specifier nothing resolves.
function sharedThemeImport(compiled: CompiledArchitectureV1): string[] {
  const hasThemePackage = (compiled.scaffoldOutputs || [])
    .some((output) => output.path === 'packages/tailwind-config/src/globals.css');
  return hasThemePackage ? ["import '@app/tailwind-config/src/globals.css';"] : [];
}

// --- react ------------------------------------------------------------------

// The explicit-router shell wires every compiled route to its compiled page
// module — the binding STRUCT_ROUTE_MODULE_MISMATCH looks for, expressed with
// the relative imports the analyzer resolves.
function reactRouterShellSkeleton(
  compiled: CompiledArchitectureV1,
  module: CompiledArchitectureModuleV1,
): ModuleSkeletonV1 {
  const routes = compiled.routes.filter((route) => (
    route.redirect !== true && Boolean(route.moduleOutput)
  ));
  const imports: string[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.moduleOutput)) continue;
    seen.add(route.moduleOutput);
    const target = relativeModuleImport(module.output, route.moduleOutput)
      .replace(/\.tsx?$/, '');
    imports.push(`import ${componentNameOf(route.moduleOutput)} from '${target}';`);
  }
  return {
    content: [
      ...sharedThemeImport(compiled),
      "import { Route, Routes } from 'react-router-dom';",
      ...imports,
      '',
      'export default function App() {',
      '  return (',
      '    <Routes>',
      ...routes.map((route) => (
        `      <Route path="${route.path}" element={<${componentNameOf(route.moduleOutput)} />} />`
      )),
      '    </Routes>',
      '  );',
      '}',
      '',
    ].join('\n'),
    references: [],
  };
}

// A Next root layout only wraps children: no component tree, no router.
function nextRootLayoutSkeleton(compiled: CompiledArchitectureV1): ModuleSkeletonV1 {
  return {
    content: [
      ...sharedThemeImport(compiled),
      "import type { ReactNode } from 'react';",
      '',
      'export default function RootLayout({ children }: { children: ReactNode }) {',
      '  return (',
      '    <html lang="en">',
      '      <body>{children}</body>',
      '    </html>',
      '  );',
      '}',
      '',
    ].join('\n'),
    references: [],
  };
}

// Inertia's entrypoint mounts the page resolver and nothing else — pages are
// resolved by name from the Pages directory, which is exactly what the
// entrypoint rule requires.
function inertiaBootstrapSkeleton(compiled: CompiledArchitectureV1): ModuleSkeletonV1 {
  return {
    content: [
      ...sharedThemeImport(compiled),
      "import { createInertiaApp } from '@inertiajs/react';",
      "import { createElement } from 'react';",
      "import { createRoot } from 'react-dom/client';",
      '',
      'void createInertiaApp({',
      '  resolve: (name: string) => import(`./Pages/${name}.tsx`),',
      '  setup({ el, App, props }) {',
      '    createRoot(el).render(createElement(App, props));',
      '  },',
      '});',
      '',
    ].join('\n'),
    references: [],
  };
}

// Rendered child copy goes through <Trans> with ns, key, and a visible
// source-language fallback — the contract the i18n gate enforces, and the
// declared copy the catalog seed writes into every locale.
function reactPageSkeleton(
  compiled: CompiledArchitectureV1,
  module: CompiledArchitectureModuleV1,
): ModuleSkeletonV1 {
  const name = pascal(module.name);
  if (!profileUsesReactI18n(compiled.profile)) {
    // No react-i18next primitive on this profile: emit no copy at all rather
    // than a hardcoded string the markup scanner would deny.
    return {
      content: [
        `export default function ${name}() {`,
        `  return <main className="page-${kebab(module.name)}" />;`,
        '}',
        '',
      ].join('\n'),
      references: [],
    };
  }
  const namespace = architectureModuleNamespace(module, routeFor(compiled, module));
  const fallback = skeletonCopy(module);
  return {
    content: [
      "import { Trans } from 'react-i18next';",
      '',
      `export default function ${name}() {`,
      '  return (',
      '    <main>',
      '      <h1>',
      `        <Trans ns="${namespace}" i18nKey="title">${fallback}</Trans>`,
      '      </h1>',
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n'),
    references: [{ namespace, key: 'title', line: 7, fallback }],
  };
}

function reactComponentSkeleton(module: CompiledArchitectureModuleV1): ModuleSkeletonV1 {
  const name = pascal(module.name);
  return {
    content: [
      'interface Props {',
      '  title: string;',
      '}',
      '',
      `export function ${name}({ title }: Props) {`,
      '  return (',
      '    <section>',
      '      <h2>{title}</h2>',
      '    </section>',
      '  );',
      '}',
      '',
    ].join('\n'),
    references: [],
  };
}

// The leading comment is contract guidance, not decoration: the feature's
// assignment scope covers the whole folder, so sibling files verify — without
// saying so, implementers under `max-lines` pressure collapse the feature back
// into this one file (observed 14cl: a role deleted its sibling split to pass
// the old exact-output verification authority).
const FEATURE_BARREL_COMMENT =
  '// This index is the feature barrel — split components/hooks/types into sibling files in this folder as it grows.';

function reactFeatureSkeleton(
  compiled: CompiledArchitectureV1,
  module: CompiledArchitectureModuleV1,
): ModuleSkeletonV1 {
  const name = pascal(module.name);
  if (!profileUsesReactI18n(compiled.profile)) {
    return {
      content: [
        FEATURE_BARREL_COMMENT,
        `export function ${name}() {`,
        `  return <section className="feature-${kebab(module.name)}" />;`,
        '}',
        '',
      ].join('\n'),
      references: [],
    };
  }
  const namespace = architectureModuleNamespace(module, undefined);
  const fallback = skeletonCopy(module);
  return {
    content: [
      FEATURE_BARREL_COMMENT,
      "import { Trans } from 'react-i18next';",
      '',
      `export function ${name}() {`,
      '  return (',
      '    <section>',
      '      <p>',
      `        <Trans ns="${namespace}" i18nKey="title">${fallback}</Trans>`,
      '      </p>',
      '    </section>',
      '  );',
      '}',
      '',
    ].join('\n'),
    references: [{ namespace, key: 'title', line: 8, fallback }],
  };
}

// --- vue --------------------------------------------------------------------

// Nuxt routes by file (<NuxtPage />); a plain Vue SPA mounts <router-view />.
function vueShellSkeleton(compiled: CompiledArchitectureV1): ModuleSkeletonV1 {
  const nuxt = compiled.profile.profileId === 'nuxt';
  const theme = sharedThemeImport(compiled);
  return {
    content: [
      ...(theme.length > 0
        ? ['<script setup lang="ts">', ...theme, '</script>', '']
        : []),
      '<template>',
      '  <main>',
      `    ${nuxt ? '<NuxtPage />' : '<router-view />'}`,
      '  </main>',
      '</template>',
      '',
    ].join('\n'),
    references: [],
  };
}

// Every piece of visible text is an interpolation, which the markup scanner
// requires: literal text between tags is hardcoded copy, an expression is not.
function vuePageSkeleton(
  compiled: CompiledArchitectureV1,
  module: CompiledArchitectureModuleV1,
): ModuleSkeletonV1 {
  const namespace = architectureModuleNamespace(module, routeFor(compiled, module));
  return {
    content: [
      '<script setup lang="ts">',
      "import { useI18n } from 'vue-i18n';",
      '',
      'const { t } = useI18n();',
      '</script>',
      '',
      '<template>',
      `  <section class="page-${kebab(module.name)}">`,
      '    <h1>{{ t("title") }}</h1>',
      '  </section>',
      '</template>',
      '',
    ].join('\n'),
    references: [{ namespace, key: 'title', line: 9, fallback: skeletonCopy(module) }],
  };
}

function vueComponentSkeleton(module: CompiledArchitectureModuleV1): ModuleSkeletonV1 {
  return {
    content: [
      '<script setup lang="ts">',
      'defineProps<{ title: string }>();',
      '</script>',
      '',
      '<template>',
      `  <article class="card-${kebab(module.name)}">`,
      '    <h2>{{ title }}</h2>',
      '  </article>',
      '</template>',
      '',
    ].join('\n'),
    references: [],
  };
}

function vueFeatureSkeleton(module: CompiledArchitectureModuleV1): ModuleSkeletonV1 {
  const namespace = architectureModuleNamespace(module, undefined);
  return {
    content: [
      '<script setup lang="ts">',
      // Same barrel guidance as the react feature skeleton, in Vue vocabulary.
      '// This index is the feature barrel — split components/composables/types into sibling files in this folder as it grows.',
      "import { useI18n } from 'vue-i18n';",
      '',
      'const { t } = useI18n();',
      '</script>',
      '',
      '<template>',
      `  <section class="feature-${kebab(module.name)}">`,
      '    <p>{{ t("title") }}</p>',
      '  </section>',
      '</template>',
      '',
    ].join('\n'),
    references: [{ namespace, key: 'title', line: 10, fallback: skeletonCopy(module) }],
  };
}

// --- blade ------------------------------------------------------------------
// Laravel translation keys are `<file>.<key>`, so the namespace prefix targets
// the compiled `lang/<locale>/<namespace>.php` catalog. PHP catalogs are not
// deterministically seedable (i18n-seed.ts touches JSON only), so blade
// skeletons declare no seed references; the markup scanner collects none from
// `__()` either, so the key is a TODO for the owning role, never a parity trap.

function bladePageSkeleton(
  compiled: CompiledArchitectureV1,
  module: CompiledArchitectureModuleV1,
): ModuleSkeletonV1 {
  const namespace = architectureModuleNamespace(module, routeFor(compiled, module));
  return {
    content: [
      `<main class="page-${kebab(module.name)}">`,
      `    <h1>{{ __('${namespace}.title') }}</h1>`,
      '</main>',
      '',
    ].join('\n'),
    references: [],
  };
}

function bladeComponentSkeleton(module: CompiledArchitectureModuleV1): ModuleSkeletonV1 {
  return {
    content: [
      `<article class="card-${kebab(module.name)}">`,
      '    <h2>{{ $title }}</h2>',
      '</article>',
      '',
    ].join('\n'),
    references: [],
  };
}

function bladeLayoutSkeleton(): ModuleSkeletonV1 {
  return {
    content: [
      '<main class="app-shell">',
      "    @yield('content')",
      '</main>',
      '',
    ].join('\n'),
    references: [],
  };
}

// --- services/stores --------------------------------------------------------

// A typed empty export under the compiled Pascal name: consumers planned
// against the module keep resolving, and the implementer replaces the body
// instead of inventing a file (and a name) from nothing.
function typedEmptyExportSkeleton(module: CompiledArchitectureModuleV1): ModuleSkeletonV1 {
  const name = pascal(module.name);
  return {
    content: [
      `// ${name} — ${module.kind} skeleton generated by traffic-one. Replace the`,
      '// typed empty export with the real implementation; keep the named export',
      '// so planned consumers keep resolving.',
      `export interface ${name}Contract {}`,
      '',
      `export const ${name}: ${name}Contract = {};`,
      '',
    ].join('\n'),
    references: [],
  };
}

// --- dispatch ---------------------------------------------------------------

function appShellSkeleton(
  compiled: CompiledArchitectureV1,
  module: CompiledArchitectureModuleV1,
): ModuleSkeletonV1 | null {
  const { profile } = compiled;
  if (profile.profileId === 'next-app' || profile.profileId === 'next-pages') {
    return module.output.endsWith('.tsx') ? nextRootLayoutSkeleton(compiled) : null;
  }
  if (module.output.endsWith('.vue')) return vueShellSkeleton(compiled);
  if (profile.profileId === 'server-rendered') {
    // Same react-vs-vue inertia split naming.ts applies to extensions.
    if (profile.router.startsWith('inertia-') && profile.router !== 'inertia-vue-router') {
      return /\.tsx?$/.test(module.output) ? inertiaBootstrapSkeleton(compiled) : null;
    }
    return module.output.endsWith('.blade.php') ? bladeLayoutSkeleton() : null;
  }
  return module.output.endsWith('.tsx')
    ? reactRouterShellSkeleton(compiled, module)
    : null;
}

/**
 * The compliant skeleton for one compiled module, or null where no validated
 * generator shape exists (see the header — null means the empty-module
 * behavior everywhere, never a deny).
 */
export function moduleSkeleton(
  compiled: CompiledArchitectureV1,
  module: CompiledArchitectureModuleV1,
): ModuleSkeletonV1 | null {
  if (NATIVE_PROFILE_IDS.has(compiled.profile.profileId)) return null;
  const output = module.output;
  if (module.kind === 'service' || module.kind === 'store') {
    return output.endsWith('.ts') && !output.endsWith('.d.ts') && !output.endsWith('.test.ts')
      ? typedEmptyExportSkeleton(module)
      : null;
  }
  if (module.kind === 'app-shell') return appShellSkeleton(compiled, module);
  if (module.kind === 'page') {
    if (output.endsWith('.tsx')) return reactPageSkeleton(compiled, module);
    if (output.endsWith('.vue')) return vuePageSkeleton(compiled, module);
    if (output.endsWith('.blade.php')) return bladePageSkeleton(compiled, module);
    return null;
  }
  if (module.kind === 'component') {
    if (output.endsWith('.tsx')) return reactComponentSkeleton(module);
    if (output.endsWith('.vue')) return vueComponentSkeleton(module);
    if (output.endsWith('.blade.php')) return bladeComponentSkeleton(module);
    return null;
  }
  if (module.kind === 'feature') {
    if (output.endsWith('.tsx')) return reactFeatureSkeleton(compiled, module);
    if (output.endsWith('.vue')) return vueFeatureSkeleton(module);
    return null;
  }
  // edge-function is Deno (never part of this project surface), test is
  // tester-owned; both stay unauthored.
  return null;
}

/** Content-only accessor for the satisfiability sweep. */
export function moduleSkeletonContent(
  compiled: CompiledArchitectureV1,
  module: CompiledArchitectureModuleV1,
): string | null {
  return moduleSkeleton(compiled, module)?.content ?? null;
}
