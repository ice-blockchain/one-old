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

import * as path from 'path';

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

// True when the profile's i18n primitive is react-i18next (<Trans>/useTranslation).
// Other web profiles are scanned as MARKUP, where any literal text between tags
// is hardcoded copy and only expression children are accepted.
function usesReactI18n(ctx: ImplementContext): boolean {
  return ['vite-react', 'next-app', 'next-pages'].includes(ctx.architecture.profile.profileId);
}

// The shell is framework-shaped. Emitting a react-router `<Routes>` everywhere
// put a routerSignal inside Next's `app/layout.tsx`, which IS a declared
// entrypoint — STRUCT_ENTRYPOINT_COMPONENT, correctly: Next routes by file, so
// a router in the root layout is a real mistake, not a cosmetic one.
function appShell(ctx: ImplementContext, rel: string): string {
  const router = ctx.architecture.profile.router;
  if (router === 'next-app-router' || router === 'next-pages-router') return nextRootLayout();
  if (rel.endsWith('.vue')) return vueAppShell(router);
  return reactRouterShell(ctx, rel);
}

// A Next root layout only wraps children: no component tree, no router.
function nextRootLayout(): string {
  return [
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
  const outlet = router === 'nuxt-file-router' ? '<NuxtPage />' : '<router-view />';
  return [
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

function goPackage(rel: string): string {
  const dir = path.dirname(rel);
  return dir === '.' ? 'main' : path.basename(dir);
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

function goRecord(rel: string): string {
  const symbol = goSymbol(rel);
  return [
    `package ${goPackage(rel)}`,
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
    '',
  ].join('\n');
}

// Behaviour, not a grep over source text. Names derive from the file so sibling
// test files in one package cannot collide.
function goTest(rel: string): string {
  const symbol = goSymbol(rel);
  return [
    `package ${goPackage(rel)}`,
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

function goSource(rel: string): string | null {
  if (/_test\.go$/.test(path.basename(rel))) return goTest(rel);
  return goRecord(rel);
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

  const module = ctx.moduleAt(rel);

  // Language dispatch comes FIRST: a `service` module is TypeScript in a Vite
  // workspace and Go in a Go module, and the module kind alone cannot tell them
  // apart. Getting this order wrong emits TypeScript into a .go file, which the
  // real `go build ./...` in phase 3 catches — loudly, but late.
  if (rel.endsWith('.go')) return goSource(rel);
  if (rel === 'go.mod') {
    return `module example.com/api\n\ngo 1.22\n`;
  }
  // No external dependencies, so there is nothing to record; an empty go.sum
  // would be noise, not evidence.
  if (rel === 'go.sum') return null;

  if (module) {
    const name = componentName(rel);
    if (module.kind === 'app-shell') return appShell(ctx, rel);
    if (module.kind === 'page') {
      if (rel.endsWith('.vue')) return vuePage(ctx, rel, name);
      return usesReactI18n(ctx) ? pageSource(ctx, rel, name) : markupSafePage(ctx, rel, name);
    }
    if (module.kind === 'component') {
      return rel.endsWith('.vue') ? vueComponent(name) : componentSource(name);
    }
    if (module.kind === 'feature') return featureSource();
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
    if (rel.includes('/ui/')) return packageManifest('@app/ui');
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
  if (rel.endsWith('ui/src/index.ts')) {
    return [
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
