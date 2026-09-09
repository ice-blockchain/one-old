// src/test-environment/core/run-sim/sources.ts
// Deterministic bodies for the files an implementer would author, keyed by the
// COMPILED path (never a hardcoded one — see assignments.ts for why).
//
// The content is shaped to satisfy the real completion gates for the right
// reasons, not to dodge them:
//   - pages import their planned components and the API client, so
//     STRUCT_ORPHAN_MODULE / STRUCT_API_CLIENT_UNUSED are satisfied by real
//     references rather than by suppression
//   - manifests declare the tools their scripts name (implementer-format-parity,
//     -typecheck-toolchain, -test-toolchain all read the manifest)
//   - tsconfigs set `noEmit: true` and never `composite` (frontend-emit-config)
//   - every body is multi-line and well under COLLAPSE_LINE_CHARS
//
// Crawl assets (robots.txt / sitemap.xml) are deliberately NOT authored here:
// crawlOriginProblem only judges files that exist, a project legitimately may
// have none, and a fabricated origin belongs in the negative-gate rows where it
// must produce a deny.

import * as fs from 'fs';
import * as path from 'path';

import { profileUsesReactI18n } from '../../../shared/architecture-contract';

import type { ImplementContext } from './assignments';

const PM = 'pnpm@10.12.1';

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function componentName(rel: string): string {
  return path.basename(rel).replace(/\.[^.]+$/, '');
}

// --- manifests -------------------------------------------------------------

// The workspace root. It owns the compiled `.prettierrc`, the TypeScript
// outputs, and the tester's runner configs, so every tool those name must be
// declared here — that is precisely what the three parity gates check.
// The i18n runtime each profile actually uses. projectDeclaresI18nRuntime looks
// for one of these in a manifest it can reach, and the root manifest is always
// reachable — so declaring it here covers every layout the compiler picks.
function i18nRuntimeDependencies(ctx: ImplementContext): Record<string, string> {
  const { profileId, framework } = ctx.architecture.profile;
  if (framework === 'nuxt') return { '@nuxtjs/i18n': '^9.1.0', 'vue-i18n': '^11.0.0' };
  if (framework === 'vue') return { 'vue-i18n': '^11.0.0' };
  if (['sveltekit', 'svelte'].includes(profileId)) return { 'svelte-i18n': '^4.0.1' };
  if (['vite-react', 'next-app', 'next-pages'].includes(profileId)) {
    return { i18next: '^24.0.0', 'react-i18next': '^15.2.0' };
  }
  // generic-web and anything else Traffic One does not model: i18next is the
  // framework-agnostic choice, and it is what the compiled runtime module imports.
  return { i18next: '^24.0.0' };
}

function rootPackageJson(ctx: ImplementContext): string {
  return json({
    name: 'learning-platform',
    version: '0.0.0',
    private: true,
    packageManager: PM,
    workspaces: ['apps/*', 'packages/*'],
    scripts: {
      build: 'tsc --noEmit && vite build',
      typecheck: 'tsc --noEmit',
      lint: 'eslint .',
      test: 'vitest run',
      // The tester owns playwright.config.ts but never this manifest, so it
      // cannot install its own runner — implementer-test-toolchain-gate makes
      // the manifest owner accountable for the script AND the dependency.
      'test:e2e': 'playwright test',
      format: 'prettier --write .',
      // Must reach every compiled output, or implementer-format-coverage-gate
      // fires: a formatter that skips owned source proves nothing.
      'format:check': 'prettier --check .',
    },
    devDependencies: {
      '@eslint/js': '^9.17.0',
      '@playwright/test': '^1.49.0',
      eslint: '^9.17.0',
      // Project-local, for the same reason as the Playwright runner: the
      // page-speed QA path shells out to the project's own lighthouse.
      lighthouse: '^12.2.1',
      prettier: '^3.4.2',
      typescript: '^5.7.2',
      vitest: '^2.1.8',
      // Reachable from every styled file: tailwindToolchainPresent walks from
      // the file's directory up to the project root. Profiles without an
      // apps/web package (generic-web, Nuxt) have no other reachable manifest.
      tailwindcss: '^4.0.0',
      ...i18nRuntimeDependencies(ctx),
    },
  });
}

function appPackageJson(): string {
  return json({
    name: '@app/web',
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: {
      build: 'tsc --noEmit && vite build',
      typecheck: 'tsc --noEmit',
      dev: 'vite',
      preview: 'vite preview --strictPort',
    },
    dependencies: {
      '@app/api-client': 'workspace:*',
      '@app/i18n': 'workspace:*',
      '@app/tailwind-config': 'workspace:*',
      '@app/ui': 'workspace:*',
      i18next: '^24.0.0',
      react: '^19.0.0',
      'react-dom': '^19.0.0',
      'react-i18next': '^15.2.0',
      'react-router-dom': '^7.1.0',
    },
    devDependencies: {
      // Reachability is what STRUCT_TAILWIND_NO_TOOLCHAIN checks:
      // tailwindToolchainPresent walks from the styled file's directory up to
      // the project root looking for the dependency or a tailwind config. The
      // app package is where these utilities are actually consumed.
      tailwindcss: '^4.0.0',
      typescript: '^5.7.2',
      vite: '^6.0.0',
    },
  });
}

function packageManifest(name: string, extra: Record<string, unknown> = {}): string {
  return json({
    name,
    version: '0.0.0',
    private: true,
    type: 'module',
    main: 'src/index.ts',
    ...extra,
  });
}

// --- tsconfig --------------------------------------------------------------
// `noEmit: true` and no `composite`: the stock Vite template emits compiled
// .js/.d.ts next to every source on first build, and the stale output shadows
// the module at import time (frontend-emit-config-gate).

function tsconfigBase(): string {
  return json({
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: true,
      noEmit: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      isolatedModules: true,
      verbatimModuleSyntax: true,
    },
  });
}

function tsconfigApp(): string {
  return json({
    extends: '../../tsconfig.base.json',
    compilerOptions: { noEmit: true },
    include: ['src'],
  });
}

// --- app source ------------------------------------------------------------

function mainEntry(appShell: string): string {
  const rel = `./${path.basename(appShell).replace(/\.tsx?$/, '')}`;
  return [
    // The shared Tailwind/theme stylesheet: the UI-system check requires the
    // application to consume the catalog's theme rather than style in isolation.
    "import '@app/tailwind-config/src/globals.css';",
    "import { StrictMode } from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import { BrowserRouter } from 'react-router-dom';",
    `import App from '${rel}';`,
    '',
    "const container = document.getElementById('root');",
    "if (!container) throw new Error('root container is missing');",
    '',
    'createRoot(container).render(',
    '  <StrictMode>',
    '    <BrowserRouter>',
    '      <App />',
    '    </BrowserRouter>',
    '  </StrictMode>,',
    ');',
    '',
  ].join('\n');
}

// A Vue SPA declares its route table where the app is bootstrapped. That is
// wiring, not UI: the entrypoint rule forbids DECLARING components inline, and
// a `component:` reference to a compiled page module is exactly the binding
// STRUCT_ROUTE_MODULE_MISMATCH looks for.
function vueMainEntry(ctx: ImplementContext, rel: string): string {
  const dir = path.dirname(rel);
  const routes = ctx.architecture.routes.filter((route) => !route.redirect);
  const shell = ctx.architecture.modules.find((module) => module.kind === 'app-shell');
  const imports = routes.map((route) => (
    `import ${componentName(route.moduleOutput)} from '${`./${path.relative(dir, route.moduleOutput)}`}';`
  ));
  const table = routes.map((route) => (
    `  { path: '${route.path}', component: ${componentName(route.moduleOutput)} },`
  ));
  return [
    "import '@app/tailwind-config/src/globals.css';",
    "import { createApp } from 'vue';",
    "import { createRouter, createWebHistory } from 'vue-router';",
    "import { createI18n } from 'vue-i18n';",
    ...(shell ? [`import App from '${`./${path.relative(dir, shell.output)}`}';`] : []),
    ...imports,
    '',
    'const routes = [',
    ...table,
    '];',
    '',
    'const router = createRouter({ history: createWebHistory(), routes });',
    "const i18n = createI18n({ legacy: false, locale: 'en' });",
    '',
    ...(shell ? ["createApp(App).use(router).use(i18n).mount('#app');"] : []),
    '',
  ].join('\n');
}

// Which i18n primitive this profile uses. Asked of the PRODUCT rather than
// re-derived from a profileId list: a hand-kept list said `server-rendered` was
// not React, but Laravel+Inertia serves React pages and profileUsesReactI18n
// says so — the generator then emitted `{t(...)}` as rendered child text, which
// is STRUCT_I18N_REACT_TRANS. Any list I maintain here can drift from the one
// the gate consults; this cannot.
function usesReactI18n(ctx: ImplementContext): boolean {
  return profileUsesReactI18n(ctx.architecture.profile);
}

// The shell is framework-shaped. Emitting a react-router `<Routes>` everywhere
// put a routerSignal inside Next's `app/layout.tsx`, which IS a declared
// entrypoint — STRUCT_ENTRYPOINT_COMPONENT, correctly: Next routes by file, so
// a router in the root layout is a real mistake, not a cosmetic one.
function appShell(ctx: ImplementContext, rel: string): string {
  const router = ctx.architecture.profile.router;
  if (router === 'next-app-router' || router === 'next-pages-router') return nextRootLayout();
  if (router.startsWith('inertia')) return inertiaBootstrap();
  if (rel.endsWith('.vue')) return vueAppShell(router);
  return reactRouterShell(ctx, rel);
}

// Inertia's entrypoint mounts the page resolver and nothing else. It declares
// no component of its own — pages are resolved by name from the Pages
// directory — which is exactly what the entrypoint rule requires.
function inertiaBootstrap(): string {
  return [
    "import '@app/tailwind-config/src/globals.css';",
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
  ].join('\n');
}

// A Next root layout only wraps children: no component tree, no router.
function nextRootLayout(): string {
  return [
    "import '@app/tailwind-config/src/globals.css';",
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
  ].join('\n');
}

// Nuxt routes by file (<NuxtPage />); a plain Vue SPA mounts <router-view />.
function vueAppShell(router: string): string {
  const nuxt = router === 'nuxt-file-router';
  const outlet = nuxt ? '<NuxtPage />' : '<router-view />';
  return [
    // Nuxt has no separate bootstrap entry — app.vue IS the entrypoint, so the
    // shared theme stylesheet is imported here. A plain Vue SPA imports it from
    // main.ts instead.
    ...(nuxt
      ? [
        '<script setup lang="ts">',
        "import '@app/tailwind-config/src/globals.css';",
        '</script>',
        '',
      ]
      : []),
    '<template>',
    '  <main>',
    `    ${outlet}`,
    '  </main>',
    '</template>',
    '',
  ].join('\n');
}

function reactRouterShell(ctx: ImplementContext, rel: string): string {
  const dir = path.dirname(rel);
  const routes = ctx.architecture.routes.filter((route) => !route.redirect);
  const imports = routes.map((route) => {
    const target = `./${path.relative(dir, route.moduleOutput).replace(/\.tsx?$/, '')}`;
    return `import ${componentName(route.moduleOutput)} from '${target}';`;
  });
  // Planned FEATURE modules are wired in here. A feature that exists but is
  // imported nowhere is dead code, and STRUCT_ORPHAN_MODULE says so — correctly.
  // The shell is where cross-cutting features (auth, theming) legitimately
  // attach, so this is a real integration, not a reference added to placate.
  const features = ctx.architecture.modules.filter((module) => module.kind === 'feature');
  const featureImports = features.map((module) => {
    const target = `./${path.relative(dir, module.output).replace(/\.(tsx?|jsx?)$/, '')}`;
    return `import { signOut } from '${target}';`;
  });
  const featureUse = features.length > 0
    ? [
      '  const handleSignOut = () => {',
      '    void signOut();',
      '  };',
      '',
    ]
    : [];
  // Rendered child text goes through <Trans> with ns, key and a visible
  // source-language fallback; t() stays for string-valued props. That is the
  // contract the i18n gate enforces, and the catalogs below carry the keys.
  const nav = features.length > 0
    ? [
      '      <button type="button" onClick={handleSignOut}>',
      '        <Trans ns="common" i18nKey="signOut">Sign out</Trans>',
      '      </button>',
    ]
    : [];
  return [
    "import { Route, Routes } from 'react-router-dom';",
    ...(features.length > 0 ? ["import { Trans } from 'react-i18next';"] : []),
    ...imports,
    ...featureImports,
    '',
    'export default function App() {',
    ...featureUse,
    '  return (',
    '    <>',
    ...nav,
    '      <Routes>',
    ...routes.map((route) => (
      `        <Route path="${route.path}" element={<${componentName(route.moduleOutput)} />} />`
    )),
    '      </Routes>',
    '    </>',
    '  );',
    '}',
    '',
  ].join('\n');
}

// A page renders real markup, consumes the planned API client, and references
// the planned components — the three things the integration findings look for.
function pageSource(ctx: ImplementContext, rel: string, name: string): string {
  const dir = path.dirname(rel);
  const components = ctx.architecture.modules.filter((module) => module.kind === 'component');
  const imports = components.map((module) => {
    const target = `./${path.relative(dir, module.output).replace(/\.tsx?$/, '')}`;
    return `import { ${componentName(module.output)} } from '${target}';`;
  });
  // Each route owns a namespace in the compiled i18n contract; a page uses its
  // own. Component props take t(), rendered text takes <Trans>.
  const namespace = pageNamespace(ctx, rel);
  const usage = components.map((module) => (
    `      <${componentName(module.output)} title={t('cardTitle')} />`
  ));
  const features = featureModulesFor(ctx, rel);
  const featureImports = features.map((module) => {
    const target = `./${path.relative(dir, module.output).replace(/\.(tsx?|jsx?)$/, '')}`;
    return `import { signOut } from '${target}';`;
  });
  const featureButton = features.length > 0
    ? [
      '      <button type="button" onClick={() => void signOut()}>',
      `        <Trans ns="${namespace}" i18nKey="signOut">Sign out</Trans>`,
      '      </button>',
    ]
    : [];
  return [
    "import { useEffect, useState } from 'react';",
    "import { Trans, useTranslation } from 'react-i18next';",
    "import { listCourses, type Course } from '@app/api-client';",
    ...imports,
    ...featureImports,
    '',
    `export default function ${name}() {`,
    `  const { t } = useTranslation('${namespace}');`,
    '  const [courses, setCourses] = useState<Course[]>([]);',
    '',
    '  useEffect(() => {',
    '    let active = true;',
    '    listCourses().then((next) => {',
    '      if (active) setCourses(next);',
    '    });',
    '    return () => {',
    '      active = false;',
    '    };',
    '  }, []);',
    '',
    '  return (',
    '    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">',
    '      <h1 className="text-3xl font-semibold">',
    `        <Trans ns="${namespace}" i18nKey="title">${name}</Trans>`,
    '      </h1>',
    '      <p className="text-slate-600">{courses.length}</p>',
    ...featureButton,
    ...usage,
    '    </main>',
    '  );',
    '}',
    '',
  ].join('\n');
}

// A Vue single-file component. Every piece of visible text is an expression
// (`{{ t(...) }}`), which is what the markup scanner requires: its rule is that
// literal text between tags is hardcoded copy, and an interpolation is not
// literal text.
function vuePage(ctx: ImplementContext, rel: string, name: string): string {
  const dir = path.dirname(rel);
  const components = ctx.architecture.modules.filter((module) => module.kind === 'component');
  const imports = components.map((module) => (
    `import ${componentName(module.output)} from '${`./${path.relative(dir, module.output)}`}';`
  ));
  const usage = components.map((module) => (
    `    <${componentName(module.output)} :title="t('cardTitle')" />`
  ));
  const features = featureModulesFor(ctx, rel);
  const featureImports = features.map((module) => (
    `import { signOut } from '${`./${path.relative(dir, module.output)}`.replace(/\.ts$/, '')}';`
  ));
  const featureUse = features.length > 0
    ? ['', 'function handleSignOut(): void {', '  void signOut();', '}']
    : [];
  const featureButton = features.length > 0
    ? ['    <button type="button" @click="handleSignOut">{{ t("signOut") }}</button>']
    : [];
  return [
    '<script setup lang="ts">',
    "import { useI18n } from 'vue-i18n';",
    ...imports,
    ...featureImports,
    '',
    'const { t } = useI18n();',
    ...featureUse,
    '</script>',
    '',
    '<template>',
    `  <section class="page-${name.toLowerCase()}">`,
    '    <h1>{{ t("title") }}</h1>',
    ...featureButton,
    ...usage,
    '  </section>',
    '</template>',
    '',
  ].join('\n');
}

function vueComponent(name: string): string {
  return [
    '<script setup lang="ts">',
    'defineProps<{ title: string }>();',
    '</script>',
    '',
    '<template>',
    `  <article class="card-${name.toLowerCase()}">`,
    '    <h2>{{ title }}</h2>',
    '  </article>',
    '</template>',
    '',
  ].join('\n');
}

// A React page for a profile whose i18n primitive is NOT react-i18next
// (generic-web). <Trans> means nothing there, and the markup scanner reads the
// file as template text — so every visible child is an expression instead.
function markupSafePage(ctx: ImplementContext, rel: string, name: string): string {
  const dir = path.dirname(rel);
  const components = ctx.architecture.modules.filter((module) => module.kind === 'component');
  const imports = components.map((module) => {
    const target = `./${path.relative(dir, module.output).replace(/\.tsx?$/, '')}`;
    return `import { ${componentName(module.output)} } from '${target}';`;
  });
  const usage = components.map((module) => (
    `      <${componentName(module.output)} title={t('cardTitle')} />`
  ));
  const features = featureModulesFor(ctx, rel);
  const featureImports = features.map((module) => {
    const target = `./${path.relative(dir, module.output).replace(/\.(tsx?|jsx?)$/, '')}`;
    return `import { signOut } from '${target}';`;
  });
  const featureButton = features.length > 0
    ? ["      <button type=\"button\" onClick={() => void signOut()}>{t('signOut')}</button>"]
    : [];
  return [
    "import { t } from '@app/i18n';",
    ...imports,
    ...featureImports,
    '',
    `export default function ${name}() {`,
    '  return (',
    '    <main>',
    "      <h1>{t('title')}</h1>",
    ...featureButton,
    ...usage,
    '    </main>',
    '  );',
    '}',
    '',
  ].join('\n');
}


// A planned FEATURE module imported nowhere is dead code — STRUCT_ORPHAN_MODULE,
// correctly. The react-router shell wires them, but a Next root layout and a
// Vue/Nuxt shell must not (they only bootstrap), so the first planned page
// hosts them instead. That is where a login/auth feature naturally attaches.
function featureModulesFor(ctx: ImplementContext, rel: string): typeof ctx.architecture.modules {
  const pages = ctx.architecture.modules.filter((module) => module.kind === 'page');
  const host = pages[0];
  if (!host || host.output !== rel) return [];
  return ctx.architecture.modules.filter((module) => module.kind === 'feature');
}

// The namespace the compiled contract assigns to this page's route.
function pageNamespace(ctx: ImplementContext, rel: string): string {
  const route = ctx.architecture.routes.find((entry) => entry.moduleOutput === rel);
  return route?.id || 'common';
}

// The runtime module the contract expects at this path. Its job is to expose
// `t` — projectDeclaresI18nRuntime wants the file present AND a known runtime
// dependency declared in a manifest.
function i18nRuntimeModule(rel: string): string {
  if (rel.endsWith('.json')) return json({ name: '@app/i18n', private: true });
  return [
    "import i18next from 'i18next';",
    '',
    'export function t(key: string): string {',
    '  return i18next.t(key);',
    '}',
    '',
    'export default i18next;',
    '',
  ].join('\n');
}

// Keys for one catalog. Validation checks BOTH directions — a missing key and an
// extra one are each a finding — so the body is generated from the same facts
// the sources reference, never hand-listed. A catalog that covers several
// namespaces nests them; a single-namespace catalog is flat.
function catalogBody(
  catalog: { path: string; namespaces: string[] },
  ctx: ImplementContext,
): string {
  const keysFor = (namespace: string): Record<string, string> => {
    if (namespace === 'common') return { signOut: 'Sign out' };
    if (namespace === 'auth') return { signInFailed: 'Sign in failed' };
    const route = ctx.architecture.routes.find((entry) => entry.id === namespace);
    const page = route ? ctx.moduleAt(route.moduleOutput) : null;
    const keys: Record<string, string> = {
      title: page?.name || 'Page',
      cardTitle: page?.name || 'Card',
    };
    // Only the page that HOSTS the feature references signOut. Adding it to
    // every namespace would leave an unreferenced key, which validation reports.
    if (route && featureModulesFor(ctx, route.moduleOutput).length > 0) keys.signOut = 'Sign out';
    return keys;
  };
  const namespaces = catalog.namespaces || [];
  // Laravel keeps translations in `lang/<locale>/<ns>.php` as a returned array.
  if (catalog.path.endsWith('.php')) {
    const entries = namespaces.length === 1
      ? keysFor(namespaces[0]!)
      : Object.assign({}, ...namespaces.map((ns) => keysFor(ns))) as Record<string, string>;
    return [
      '<?php',
      '',
      'return [',
      ...Object.entries(entries).map(([key, value]) => `    '${key}' => '${value}',`),
      '];',
      '',
    ].join('\n');
  }
  if (namespaces.length === 1) return json(keysFor(namespaces[0]!));
  const nested: Record<string, Record<string, string>> = {};
  for (const namespace of namespaces) nested[namespace] = keysFor(namespace);
  return json(nested);
}

function componentSource(name: string): string {
  return [
    'interface Props {',
    '  title: string;',
    '}',
    '',
    `export function ${name}({ title }: Props) {`,
    '  return (',
    '    <section className="rounded-xl border border-slate-200 p-4">',
    '      <h2 className="text-lg font-medium">{title}</h2>',
    '    </section>',
    '  );',
    '}',
    '',
  ].join('\n');
}

// A Vue feature entry. `feature` compiles to the PROFILE-NATIVE extension, so on
// a Vue profile this file is an SFC, not a plain module — emitting TypeScript
// into a `.vue` path is the same class of defect as the `.ts` React entry this
// replaced. The helpers the hosting page imports live in the plain `<script>`
// block: `<script setup>` alone can only default-export, and an SFC may carry
// both blocks. Visible text is an interpolation, which the markup scanner
// requires (its `>text<` capture excludes braces).
function vueFeature(): string {
  return [
    '<script lang="ts">',
    "import { supabase } from '@app/api-client';",
    '',
    'export interface Session {',
    '  userId: string;',
    '}',
    '',
    'export async function signIn(email: string, password: string): Promise<Session | null> {',
    '  const result = await supabase.auth.signInWithPassword({ email, password });',
    '  return result.userId ? { userId: result.userId } : null;',
    '}',
    '',
    'export async function signOut(): Promise<void> {',
    '  await supabase.auth.signOut();',
    '}',
    '</script>',
    '',
    '<script setup lang="ts">',
    "import { useI18n } from 'vue-i18n';",
    '',
    'const { t } = useI18n();',
    '</script>',
    '',
    '<template>',
    '  <p class="feature-auth">{{ t("signInFailed") }}</p>',
    '</template>',
    '',
  ].join('\n');
}

function featureSource(): string {
  return [
    "import { supabase } from '@app/api-client';",
    "import { t } from '@app/i18n';",
    '',
    "export const SIGN_IN_FAILED = t('auth:signInFailed');",
    '',
    'export interface Session {',
    '  userId: string;',
    '}',
    '',
    'export async function signIn(email: string, password: string): Promise<Session | null> {',
    '  const result = await supabase.auth.signInWithPassword({ email, password });',
    '  return result.userId ? { userId: result.userId } : null;',
    '}',
    '',
    'export async function signOut(): Promise<void> {',
    '  await supabase.auth.signOut();',
    '}',
    '',
  ].join('\n');
}

// --- backend ---------------------------------------------------------------

function serviceSource(name: string): string {
  return [
    "import { supabase } from './supabase';",
    '',
    'export interface Course {',
    '  id: string;',
    '  slug: string;',
    '  title: string;',
    '}',
    '',
    `export class ${name} {`,
    '  async list(): Promise<Course[]> {',
    // Result typed at the binding, not with a call-position type argument.
    // This is how supabase-js v2 is actually written — and it sidesteps a
    // known i18n-scanner false positive where `.from<Course>(...)` in a plain
    // .ts file parses as JSX and reports STRUCT_HARDCODED_COPY. See the note
    // in run-sim.cases.ts.
    "    const rows: Course[] = await supabase.from('courses').select();",
    '    return rows;',
    '  }',
    '',
    '  async bySlug(slug: string): Promise<Course | null> {',
    "    const rows: Course[] = await supabase.from('courses').select();",
    '    return rows.find((row) => row.slug === slug) ?? null;',
    '  }',
    '}',
    '',
  ].join('\n');
}

function apiClientIndex(serviceRel: string): string {
  const name = componentName(serviceRel);
  return [
    `import { ${name}, type Course } from './${name}';`,
    '',
    `export { ${name} };`,
    "export { supabase } from './supabase';",
    'export type { Course };',
    '',
    `const client = new ${name}();`,
    '',
    'export function listCourses(): Promise<Course[]> {',
    '  return client.list();',
    '}',
    '',
    'export function courseBySlug(slug: string): Promise<Course | null> {',
    '  return client.bySlug(slug);',
    '}',
    '',
  ].join('\n');
}

function supabaseClient(): string {
  return [
    'const url = import.meta.env.VITE_SUPABASE_URL;',
    'const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;',
    '',
    'if (!url || !anonKey) {',
    "  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set');",
    '}',
    '',
    'export const supabase = createClient(url, anonKey);',
    '',
  ].join('\n');
}

// --- tests -----------------------------------------------------------------
// Behaviour, never a grep over source text: a test that asserts on source
// strings passes while the app is broken (the rule frontend/testing.md states).

function unitTest(rel: string): string {
  const name = componentName(rel).replace(/\.test$/, '');
  return [
    "import { describe, expect, it } from 'vitest';",
    '',
    `describe('${name}', () => {`,
    "  it('exposes the course listing contract', async () => {",
    "    const api = await import('@app/api-client');",
    "    expect(typeof api.listCourses).toBe('function');",
    '  });',
    '});',
    '',
  ].join('\n');
}

function e2eSpec(): string {
  return [
    "import { expect, test } from '@playwright/test';",
    '',
    "test('home renders its heading', async ({ page }) => {",
    "  await page.goto('/');",
    "  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();",
    '});',
    '',
  ].join('\n');
}

// --- Go --------------------------------------------------------------------
// A real compilable module: `go build ./...` and `go test ./...` actually run
// in this tier, so these have to be correct Go, not Go-shaped text.

// The compiled backend-only Go layout puts EVERY module flat in one directory
// with no root-level entry, so that single package is the program and must be
// `main` — which is exactly what the live 15cl run produced ("Write surface is
// FLAT internal/*.go = one package main"). Emitting `package internal` instead
// made both Go cases green for a reason unrelated to the product: `go build
// ./...` discards the object for a NON-main package, so the runner's bare
// `go build ./...` never hit the output-name collision that made TESTS_GREEN
// unreachable in the real run. A root-level `.go` file means the repo brought
// its own entry (the existing-repo fixture) — leave that shape alone.
function goEntrypoint(ctx: ImplementContext): string | null {
  // An existing repo already declares its own package layout — the fixture ships
  // `main.go` at the root and `package internal` beside it, and Go names a package
  // per DIRECTORY, so renaming the compiled one would collide with source the run
  // never owned. The git-head baseline carries no file list, so read the disk.
  const owned = fs.existsSync(ctx.projectRoot)
    && fs.readdirSync(ctx.projectRoot).some((name) => name.endsWith('.go'));
  if (owned) return null;
  const sources = ctx.outputsFor('senior-backend')
    .filter((rel) => rel.endsWith('.go') && !/_test\.go$/.test(path.basename(rel)));
  if (!sources.length || sources.some((rel) => !rel.includes('/'))) return null;
  return [...sources].sort()[0] ?? null;
}

function goPackage(rel: string, entry: string | null): string {
  const dir = path.dirname(rel);
  if (dir === '.') return 'main';
  if (entry && path.dirname(entry) === dir) return 'main';
  return path.basename(dir);
}

// Go modules are SELF-CONTAINED and named from their compiled filename. An
// earlier version keyed on filename patterns (`products_`, `news_`), so a
// service the architect happened to call `courses-api` was never authored at
// all — the module simply went missing and only the reviewer's full scan caught
// it. Deriving everything from the path means any planned service compiles.
function goSymbol(rel: string): string {
  return path.basename(rel)
    .replace(/\.go$/, '')
    .replace(/_test$/, '')
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function goRecord(rel: string, entry: string | null): string {
  const symbol = goSymbol(rel);
  // `package main` without `func main` does not compile, so the designated
  // entry carries it. One per package, deterministically the first by path.
  const main = rel === entry
    ? ['', '// main starts the service. The compiled flat layout has no other home for it.', 'func main() {', `\t_ = List${symbol}()`, '}']
    : [];
  return [
    `package ${goPackage(rel, entry)}`,
    '',
    `// ${symbol}Item is one record served by this module.`,
    `type ${symbol}Item struct {`,
    '\tID    string',
    '\tSlug  string',
    '\tTitle string',
    '}',
    '',
    `// List${symbol} returns every record.`,
    `func List${symbol}() []${symbol}Item {`,
    `\treturn []${symbol}Item{`,
    '\t\t{ID: "1", Slug: "first", Title: "First"},',
    '\t\t{ID: "2", Slug: "second", Title: "Second"},',
    '\t}',
    '}',
    '',
    `// ${symbol}BySlug resolves a single record by its slug.`,
    `func ${symbol}BySlug(slug string) (${symbol}Item, bool) {`,
    `\tfor _, item := range List${symbol}() {`,
    '\t\tif item.Slug == slug {',
    '\t\t\treturn item, true',
    '\t\t}',
    '\t}',
    `\treturn ${symbol}Item{}, false`,
    '}',
    ...main,
    '',
  ].join('\n');
}

// Behaviour, not a grep over source text. Names derive from the file so sibling
// test files in one package cannot collide.
function goTest(rel: string, entry: string | null): string {
  const symbol = goSymbol(rel);
  return [
    `package ${goPackage(rel, entry)}`,
    '',
    'import "testing"',
    '',
    `func Test${symbol}ListsRecords(t *testing.T) {`,
    `\tif len(List${symbol}()) == 0 {`,
    `\t\tt.Fatal("expected ${symbol} to list records")`,
    '\t}',
    `\tif _, ok := ${symbol}BySlug("first"); !ok {`,
    '\t\tt.Fatal("expected a record with slug \\"first\\"")',
    '\t}',
    '}',
    '',
  ].join('\n');
}

// --- Python ----------------------------------------------------------------
// `python -m compileall` and `pytest` really run in this tier, so these have to
// be valid Python that passes ruff, not Python-shaped text.

function pySymbol(rel: string): string {
  return path.basename(rel)
    .replace(/\.py$/, '')
    .replace(/^test_/, '')
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function pyModule(rel: string): string {
  const symbol = pySymbol(rel);
  const snake = path.basename(rel).replace(/\.py$/, '');
  return [
    `"""${symbol} records served by this module."""`,
    '',
    'from dataclasses import dataclass',
    '',
    '',
    '@dataclass(frozen=True)',
    `class ${symbol}Item:`,
    `    """One ${snake} record."""`,
    '',
    '    id: str',
    '    slug: str',
    '    title: str',
    '',
    '',
    `def list_${snake}() -> list[${symbol}Item]:`,
    '    """Return every record."""',
    '    return [',
    `        ${symbol}Item(id="1", slug="first", title="First"),`,
    `        ${symbol}Item(id="2", slug="second", title="Second"),`,
    '    ]',
    '',
    '',
    `def ${snake}_by_slug(slug: str) -> ${symbol}Item | None:`,
    '    """Resolve a single record by its slug."""',
    `    for item in list_${snake}():`,
    '        if item.slug == slug:',
    '            return item',
    '    return None',
    '',
  ].join('\n');
}

function pyTest(rel: string): string {
  const snake = path.basename(rel).replace(/\.py$/, '').replace(/^test_/, '');
  return [
    `"""Behavioural coverage for ${snake}."""`,
    '',
    // Members sorted: the compiled ruff.toml selects "I", so an unsorted
    // import block is a real lint failure.
    `from ${snake} import ${[`list_${snake}`, `${snake}_by_slug`].sort().join(', ')}`,
    '',
    '',
    `def test_${snake}_lists_records() -> None:`,
    `    assert list_${snake}()`,
    '',
    '',
    `def test_${snake}_resolves_by_slug() -> None:`,
    `    assert ${snake}_by_slug("first") is not None`,
    `    assert ${snake}_by_slug("missing") is None`,
    '',
  ].join('\n');
}

function pySource(rel: string): string | null {
  const base = path.basename(rel);
  if (base === 'conftest.py') {
    return [
      '"""Make the project modules importable from the test suite."""',
      '',
      'import sys',
      'from pathlib import Path',
      '',
      'sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))',
      '',
    ].join('\n');
  }
  if (/^test_/.test(base)) return pyTest(rel);
  return pyModule(rel);
}

function goSource(rel: string, ctx: ImplementContext): string | null {
  const entry = goEntrypoint(ctx);
  if (/_test\.go$/.test(path.basename(rel))) return goTest(rel, entry);
  return goRecord(rel, entry);
}

// --- Rust ------------------------------------------------------------------
// `cargo test`, `cargo clippy` and `cargo fmt --check` really run in this
// tier, so these have to be a crate rustc accepts, not Rust-shaped text.
// Modules stay out of `src/lib.rs` (that file is the crate root Cargo reads
// by name) and use `&'static str` so clippy stays quiet on owned literals.

function rustIdent(rel: string): string {
  return path.basename(rel).replace(/\.rs$/, '').replace(/-/g, '_');
}

function rustModules(ctx: ImplementContext): string[] {
  return ctx.outputsFor('senior-backend')
    .filter((rel) => rel.endsWith('.rs'))
    .filter((rel) => {
      const base = path.basename(rel);
      return base !== 'lib.rs' && base !== 'main.rs' && !base.endsWith('_test.rs');
    })
    .sort();
}

function rustCargoToml(): string {
  return [
    '[package]',
    'name = "api"',
    'version = "0.0.0"',
    'edition = "2021"',
    '',
  ].join('\n');
}

function rustfmtToml(): string {
  // Byte-match architecture-contract/scaffold-content.ts RUSTFMT_BODY so a
  // PLAN_READY seed and a run-sim write are the same file.
  return [
    '# generated by traffic-one — Rust formatting. Edit freely; CI runs it.',
    'max_width = 100',
    'chain_width = 100',
    'edition = "2021"',
    '',
  ].join('\n');
}

function rustLib(ctx: ImplementContext): string {
  const mods = rustModules(ctx).map((rel) => `pub mod ${rustIdent(rel)};`);
  return [...mods, ''].join('\n');
}

function rustMain(ctx: ImplementContext): string {
  const first = rustModules(ctx)[0];
  const ident = first ? rustIdent(first) : null;
  const body = ident
    ? `    println!("{}", api::${ident}::list_${ident}().len());`
    : '    println!("ok");';
  return ['fn main() {', body, '}', ''].join('\n');
}

function rustModule(rel: string): string {
  const ident = rustIdent(rel);
  const pascal = ident
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return [
    `pub struct ${pascal}Item {`,
    "    pub id: &'static str,",
    "    pub slug: &'static str,",
    "    pub title: &'static str,",
    '}',
    '',
    `pub fn list_${ident}() -> Vec<${pascal}Item> {`,
    '    vec![',
    `        ${pascal}Item {`,
    '            id: "1",',
    '            slug: "first",',
    '            title: "First",',
    '        },',
    `        ${pascal}Item {`,
    '            id: "2",',
    '            slug: "second",',
    '            title: "Second",',
    '        },',
    '    ]',
    '}',
    '',
    `pub fn ${ident}_by_slug(slug: &str) -> Option<${pascal}Item> {`,
    // rustfmt.toml pins chain_width = 100 so this one-liner is stable for
    // both short (`list_store`) and long (`list_news_service`) idents.
    `    list_${ident}().into_iter().find(|item| item.slug == slug)`,
    '}',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    use super::*;',
    '',
    '    #[test]',
    '    fn lists_records() {',
    `        assert!(!list_${ident}().is_empty());`,
    '    }',
    '',
    '    #[test]',
    '    fn resolves_by_slug() {',
    `        assert!(${ident}_by_slug("first").is_some());`,
    '    }',
    '}',
    '',
  ].join('\n');
}

function rustSource(rel: string, ctx: ImplementContext): string | null {
  const base = path.basename(rel);
  if (base === 'lib.rs') return rustLib(ctx);
  if (base === 'main.rs') return rustMain(ctx);
  return rustModule(rel);
}

// --- Laravel ---------------------------------------------------------------

// Laravel binds routes to modules in `routes/web.php`, and that binding is what
// STRUCT_ROUTE_MODULE_MISMATCH reads — Blade via `view('name')`, Inertia via
// `Inertia::render('Name')`. Laravel's own path syntax is `{slug}`, not `:slug`.
function laravelRoutes(ctx: ImplementContext): string {
  const inertia = ctx.architecture.profile.router.startsWith('inertia');
  const lines = ctx.architecture.routes
    .filter((route) => !route.redirect)
    .map((route) => {
      const laravelPath = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const output = route.moduleOutput;
      if (inertia) {
        const name = /^resources\/js\/(?:Pages|pages)\/(.+)$/.exec(
          output.replace(/\.(tsx?|jsx?|vue)$/, ''),
        )?.[1] || path.basename(output).replace(/\.[^.]+$/, '');
        return `Route::get('${laravelPath}', fn () => Inertia::render('${name}'));`;
      }
      const view = output
        .replace(/^resources\/views\//, '')
        .replace(/\.blade\.php$/, '')
        .replace(/\//g, '.');
      return `Route::get('${laravelPath}', fn () => view('${view}'));`;
    });
  return [
    '<?php',
    '',
    'use Illuminate\\Support\\Facades\\Route;',
    ...(inertia ? ['use Inertia\\Inertia;'] : []),
    '',
    ...lines,
    '',
  ].join('\n');
}

// A Blade view: every visible string goes through `__()`, which the markup
// scanner accepts because `{{ }}` is an expression, not literal text.
function bladeView(ctx: ImplementContext, rel: string, kind: string): string {
  const namespace = 'common';
  if (kind === 'component') {
    return [
      '<article class="card">',
      '    <h2>{{ $title }}</h2>',
      '</article>',
      '',
    ].join('\n');
  }
  const components = ctx.architecture.modules.filter((module) => module.kind === 'component');
  const includes = components.map((module) => {
    const name = module.output
      .replace(/^resources\/views\//, '')
      .replace(/\.blade\.php$/, '')
      .replace(/\//g, '.');
    return `    @include('${name}', ['title' => __('${namespace}.cardTitle')])`;
  });
  return [
    '<main class="page">',
    `    <h1>{{ __('${namespace}.title') }}</h1>`,
    ...includes,
    '</main>',
    '',
  ].join('\n');
}

// The web outputs the compiler hands a run whose UI it does not touch: the
// profile entrypoints senior-frontend owns, and the unconditional test
// infrastructure senior-tester owns for any web-surface profile.
const WEB_SHAPE_OUTPUT_RE = /(?:^|\/)main\.[tj]sx?$|^vitest\.config\.ts$|^playwright\.config\.ts$|^tests\/e2e\/smoke\.spec\.ts$/;

/**
 * True when `rel` is a web-shape output the repo ALREADY has and this run plans
 * no UI (no routes, no app-shell) — in which case the tier must leave it alone.
 *
 * `goEntrypoint` has always applied this rule to a repo's own `main.go`: a shape
 * the project brought is not ours to rewrite. It matters more than tidiness for
 * the `nonvisual` impact. Those two output groups are attached to a web profile
 * unconditionally, so a run that changes no UI still had them rewritten — a Vue
 * bootstrap over a vanilla `web/src/main.js`, mounting nothing because the route
 * table is empty, plus a first-ever Playwright config. That put changed `.ts`
 * and `.js` files in the baseline diff, and the `nonvisual` contract published
 * at PLAN_READY came back `behavioral` (browser-required, and unsettleable on a
 * machine with no Chromium) on the next refresh. The impact of a change must
 * come from the change, not from the tier's own boilerplate.
 */
function repoOwnedNoUiOutput(rel: string, ctx: ImplementContext): boolean {
  if (!WEB_SHAPE_OUTPUT_RE.test(rel)) return false;
  const plansUi = ctx.architecture.routes.some((route) => !route.redirect)
    || ctx.architecture.modules.some((module) => module.kind === 'app-shell');
  if (plansUi) return false;
  return fs.existsSync(path.join(ctx.projectRoot, rel));
}

// --- the resolver ----------------------------------------------------------

/**
 * Body for one compiled output, or null when this tier deliberately does not
 * author it (binary assets, crawl files). Ordered most-specific first: a module
 * output always wins over a filename pattern.
 */
export function sourceFor(rel: string, ctx: ImplementContext): string | null {
  // Never author binaries; nothing requires them and a text stub would be a lie.
  if (/\.(png|ico|jpg|jpeg|webp|woff2?)$/i.test(rel)) return null;
  // Crawl assets: see the header comment.
  if (/(?:^|\/)(robots\.txt|sitemap\.xml)$/i.test(rel)) return null;
  // A file the REPO already brought, on a run that plans no UI at all: nothing
  // here is ours to rewrite. See repoOwnedNoUiOutput.
  if (repoOwnedNoUiOutput(rel, ctx)) return null;

  const module = ctx.moduleAt(rel);

  // Language dispatch comes FIRST: a `service` module is TypeScript in a Vite
  // workspace and Go in a Go module, and the module kind alone cannot tell them
  // apart. Getting this order wrong emits TypeScript into a .go file, which the
  // real `go build ./...` in phase 3 catches — loudly, but late.
  // Anchored on the suffix: the compiler nests a Laravel app under a web root
  // (apps/web/routes/web.php), so an exact root match authored nothing at all.
  if (rel.endsWith('routes/web.php')) return laravelRoutes(ctx);
  if (rel.endsWith('.go')) return goSource(rel, ctx);
  if (rel.endsWith('.py')) return pySource(rel);
  if (rel.endsWith('.rs')) return rustSource(rel, ctx);
  if (rel === 'Cargo.toml') return rustCargoToml();
  if (rel === 'rustfmt.toml') return rustfmtToml();
  // A directory output, not a file. sqlx/diesel own the layout; this tier does
  // not invent a migration the crate does not compile against.
  if (rel === 'migrations') return null;
  if (rel === 'pyproject.toml') {
    // Presence of this file is what resolveStackCommand keys on for the Python
    // byte-compile build AND for pytest; without it neither check resolves and
    // the run cannot settle.
    return [
      '[project]',
      'name = "api"',
      'version = "0.0.0"',
      'requires-python = ">=3.11"',
      '',
      '[tool.pytest.ini_options]',
      'testpaths = ["tests"]',
      '',
    ].join('\n');
  }
  if (rel === 'go.mod') {
    return `module example.com/api\n\ngo 1.22\n`;
  }
  // No external dependencies, so there is nothing to record; an empty go.sum
  // would be noise, not evidence.
  if (rel === 'go.sum') return null;

  if (module) {
    const name = componentName(rel);
    if (module.kind === 'app-shell') {
      if (rel.endsWith('.blade.php')) return bladeView(ctx, rel, 'component');
      return appShell(ctx, rel);
    }
    if (module.kind === 'page') {
      if (rel.endsWith('.blade.php')) return bladeView(ctx, rel, 'page');
      if (rel.endsWith('.vue')) return vuePage(ctx, rel, name);
      return usesReactI18n(ctx) ? pageSource(ctx, rel, name) : markupSafePage(ctx, rel, name);
    }
    if (module.kind === 'component') {
      if (rel.endsWith('.blade.php')) return bladeView(ctx, rel, 'component');
      return rel.endsWith('.vue') ? vueComponent(name) : componentSource(name);
    }
    if (module.kind === 'feature') {
      // Dispatched by compiled extension exactly like page/component above.
      // `.svelte`/`.astro` have no branch because those profiles have no
      // run-sim shape at all — their page/component generators do not exist
      // either, so a feature-only generator would be untested dead weight.
      // Add all three together when a Svelte/Astro shape lands.
      return rel.endsWith('.vue') ? vueFeature() : featureSource();
    }
    if (module.kind === 'service') return serviceSource(name);
  }

  const base = path.basename(rel);
  if (rel === 'package.json') return rootPackageJson(ctx);
  if (base === 'package.json') {
    if (rel.startsWith('apps/')) return appPackageJson();
    if (rel.includes('tailwind-config')) {
      // The dependency that makes the Tailwind utilities in globals.css real —
      // without it STRUCT_TAILWIND_NO_TOOLCHAIN fires, and correctly so.
      return packageManifest('@app/tailwind-config', {
        dependencies: { tailwindcss: '^4.0.0' },
      });
    }
    if (rel.includes('api-client')) return packageManifest('@app/api-client');
    if (rel.includes('i18n')) {
      // projectDeclaresI18nRuntime looks for one of the known runtimes in a
      // manifest AND for every runtimeOutput on disk. Without the dependency,
      // STRUCT_I18N_RUNTIME blocks IMPLEMENTED — correctly: catalogs with no
      // runtime to read them are inert.
      return packageManifest('@app/i18n', {
        dependencies: { i18next: '^24.0.0', 'react-i18next': '^15.2.0' },
      });
    }
    if (rel.includes('/ui/')) {
      // STRUCT_UI_SYSTEM_MISSING requires the shared UI package to be named
      // `@app/ui` and to declare exports — application code may not deep-import
      // its internals, so the package surface has to be explicit.
      return json({
        name: '@app/ui',
        version: '0.0.0',
        private: true,
        type: 'module',
        main: 'src/index.ts',
        exports: {
          '.': './src/index.ts',
          './styles': './src/styles.css',
        },
        dependencies: { clsx: '^2.1.1', 'tailwind-merge': '^2.6.0' },
      });
    }
    return packageManifest(`@app/${path.basename(path.dirname(rel))}`);
  }
  if (rel === 'tsconfig.base.json') return tsconfigBase();
  if (base === 'tsconfig.json') return tsconfigApp();
  if (rel === 'pnpm-workspace.yaml') return 'packages:\n  - "apps/*"\n  - "packages/*"\n';
  if (rel === 'turbo.json') return json({ $schema: 'https://turbo.build/schema.json', tasks: { build: { dependsOn: ['^build'] } } });
  if (base === 'vite.config.ts') {
    return [
      "import { defineConfig } from 'vite';",
      "import react from '@vitejs/plugin-react';",
      '',
      'export default defineConfig({',
      '  plugins: [react()],',
      '  build: { outDir: "dist" },',
      '});',
      '',
    ].join('\n');
  }
  if (base === 'vitest.config.ts') {
    return [
      "import { defineConfig } from 'vitest/config';",
      '',
      'export default defineConfig({',
      "  test: { environment: 'jsdom', globals: true },",
      '});',
      '',
    ].join('\n');
  }
  if (base === 'playwright.config.ts') {
    return [
      "import { defineConfig } from '@playwright/test';",
      '',
      'export default defineConfig({',
      "  testDir: './tests/e2e',",
      "  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4321' },",
      '});',
      '',
    ].join('\n');
  }
  if (base === 'index.html') {
    return [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
      // Empty on purpose: the shell HTML has no localization primitive, and the
      // compiled contract declares no literal brands, so any prose here is
      // hardcoded user-facing copy. The app sets document.title from the
      // catalog once it boots — the standard i18n pattern for an SPA shell.
      '    <title></title>',
      '  </head>',
      '  <body>',
      '    <div id="root"></div>',
      '    <script type="module" src="/src/main.tsx"></script>',
      '  </body>',
      '</html>',
      '',
    ].join('\n');
  }
  if (base === 'main.ts' || base === 'main.js') {
    // Vue's entrypoint: bootstraps the app, the router and the i18n plugin.
    return vueMainEntry(ctx, rel);
  }
  if (base === 'main.tsx' || base === 'main.jsx') {
    const shell = ctx.architecture.modules.find((m) => m.kind === 'app-shell');
    return mainEntry(shell?.output ?? 'apps/web/src/App.tsx');
  }
  if (base === 'vite-env.d.ts') return '/// <reference types="vite/client" />\n';
  if (base === 'supabase.ts') return supabaseClient();
  if (base === 'database.types.ts') {
    return [
      'export interface Database {',
      '  courses: {',
      '    id: string;',
      '    slug: string;',
      '    title: string;',
      '  };',
      '}',
      '',
    ].join('\n');
  }
  if (rel.endsWith('api-client/src/index.ts')) {
    const service = ctx.architecture.modules.find((m) => m.kind === 'service');
    return apiClientIndex(service?.output ?? 'CoursesAPI.ts');
  }
  if (rel.endsWith('i18n/src/index.ts')) {
    return [
      "import common from './locales/en/common.json';",
      '',
      'const dictionary: Record<string, string> = common;',
      '',
      'export function t(key: string): string {',
      '  return dictionary[key] ?? key;',
      '}',
      '',
    ].join('\n');
  }
  // i18n runtime + catalogs come from the COMPILED contract, not a path guess:
  // every profile puts them somewhere different (packages/i18n/src/index.ts,
  // i18n/index.ts, src/locales/en.json), and the contract already says where.
  const i18n = ctx.architecture.i18n;
  if (i18n) {
    if ((i18n.runtimeOutputs || []).includes(rel)) return i18nRuntimeModule(rel);
    const catalog = (i18n.catalogs || []).find((entry) => entry.path === rel);
    if (catalog) return catalogBody(catalog, ctx);
  }
  if (rel.endsWith('packages/ui/components.json')) {
    // The shadcn adapter config the UI-system check looks for.
    return json({
      $schema: 'https://ui.shadcn.com/schema.json',
      style: 'default',
      rsc: false,
      tsx: true,
      tailwind: {
        config: '',
        css: '../tailwind-config/src/globals.css',
        baseColor: 'slate',
        cssVariables: true,
      },
      // A shared `ui` alias is required: it is what points component code at
      // the catalog package instead of a per-app copy.
      aliases: { ui: '@app/ui', components: '@app/ui/components', utils: '@app/ui/lib/utils' },
    });
  }
  if (rel.endsWith('packages/ui/src/lib/utils.ts')) {
    // The canonical shadcn `cn` helper; every generated component composes its
    // classes through it rather than concatenating strings by hand.
    return [
      "import { clsx, type ClassValue } from 'clsx';",
      "import { twMerge } from 'tailwind-merge';",
      '',
      'export function cn(...inputs: ClassValue[]): string {',
      '  return twMerge(clsx(inputs));',
      '}',
      '',
    ].join('\n');
  }
  if (rel.endsWith('ui/src/index.ts')) {
    return [
      "export { cn } from './lib/utils';",
      '',
      'export interface ButtonProps {',
      '  label: string;',
      '}',
      '',
      'export function buttonClass(): string {',
      "  return 'rounded-lg px-4 py-2 font-medium';",
      '}',
      '',
    ].join('\n');
  }
  if (base === 'globals.css') {
    return '@import "tailwindcss";\n\n:root {\n  color-scheme: light dark;\n}\n';
  }
  if (rel.endsWith('.sql')) {
    return [
      'create table if not exists courses (',
      '  id uuid primary key default gen_random_uuid(),',
      '  slug text not null unique,',
      '  title text not null',
      ');',
      '',
    ].join('\n');
  }
  if (base === 'config.toml') {
    return '[api]\nenabled = true\nport = 54321\n';
  }
  if (rel.includes('/e2e/') && rel.endsWith('.spec.ts')) return e2eSpec();
  if (/\.test\.ts$/.test(rel)) return unitTest(rel);
  if (base === 'manifest.webmanifest') {
    return json({ name: 'Learning Platform', short_name: 'Learn', start_url: '/', display: 'standalone' });
  }
  if (base === '.editorconfig') return 'root = true\n\n[*]\nindent_style = space\nindent_size = 2\n';
  if (base === '.nvmrc') return '22\n';
  if (base === 'README.md') return '# Learning Platform\n\nCourses for web development.\n';
  if (rel.endsWith('ci.yml')) {
    return [
      'name: ci',
      'on: [push, pull_request]',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - run: pnpm install --frozen-lockfile',
      '      - run: pnpm typecheck && pnpm test',
      '',
    ].join('\n');
  }
  return null;
}
