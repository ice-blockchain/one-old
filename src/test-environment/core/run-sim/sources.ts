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
function rootPackageJson(): string {
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

// The shell composes the router and nothing else: route pages must be separate
// compiled modules, which is what the structural gate checks.
function appShell(ctx: ImplementContext, rel: string): string {
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
  return [
    "import { useEffect, useState } from 'react';",
    "import { Trans, useTranslation } from 'react-i18next';",
    "import { listCourses, type Course } from '@app/api-client';",
    ...imports,
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
    ...usage,
    '    </main>',
    '  );',
    '}',
    '',
  ].join('\n');
}

// The namespace the compiled contract assigns to this page's route.
function pageNamespace(ctx: ImplementContext, rel: string): string {
  const route = ctx.architecture.routes.find((entry) => entry.moduleOutput === rel);
  return route?.id || 'common';
}

// Every key referenced above, per namespace. Catalog validation checks BOTH
// directions — a missing key and an extra one are both findings — so these are
// generated from the same facts the sources use, never hand-listed.
export function catalogFor(rel: string, ctx: ImplementContext): string | null {
  const namespace = path.basename(rel).replace(/\.json$/, '');
  if (namespace === 'common') {
    return json({ signOut: 'Sign out' });
  }
  if (namespace === 'auth') {
    return json({ signInFailed: 'Sign in failed' });
  }
  const route = ctx.architecture.routes.find((entry) => entry.id === namespace);
  if (!route) return null;
  const page = ctx.moduleAt(route.moduleOutput);
  return json({
    title: page?.name || 'Page',
    cardTitle: page?.name || 'Card',
  });
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

function goStore(rel: string): string {
  return [
    `package ${goPackage(rel)}`,
    '',
    '// Store holds the in-memory catalogue the services read from.',
    'type Store struct {',
    '\tproducts []Product',
    '\tnews     []NewsItem',
    '}',
    '',
    '// NewStore builds a store seeded with the demo catalogue.',
    'func NewStore() *Store {',
    '\treturn &Store{',
    '\t\tproducts: []Product{',
    '\t\t\t{ID: "p-1", Slug: "desk-lamp", Title: "Desk Lamp"},',
    '\t\t\t{ID: "p-2", Slug: "notebook", Title: "Notebook"},',
    '\t\t},',
    '\t\tnews: []NewsItem{',
    '\t\t\t{ID: "n-1", Slug: "launch", Title: "We launched"},',
    '\t\t},',
    '\t}',
    '}',
    '',
    '// Products returns every product in the catalogue.',
    'func (s *Store) Products() []Product {',
    '\treturn s.products',
    '}',
    '',
    '// News returns every news item in the catalogue.',
    'func (s *Store) News() []NewsItem {',
    '\treturn s.news',
    '}',
    '',
  ].join('\n');
}

function goProducts(rel: string): string {
  return [
    `package ${goPackage(rel)}`,
    '',
    '// Product is one catalogue entry.',
    'type Product struct {',
    '\tID    string',
    '\tSlug  string',
    '\tTitle string',
    '}',
    '',
    '// ListProducts returns the full product listing.',
    'func ListProducts(s *Store) []Product {',
    '\treturn s.Products()',
    '}',
    '',
    '// ProductBySlug resolves a single product by its slug.',
    'func ProductBySlug(s *Store, slug string) (Product, bool) {',
    '\tfor _, product := range s.Products() {',
    '\t\tif product.Slug == slug {',
    '\t\t\treturn product, true',
    '\t\t}',
    '\t}',
    '\treturn Product{}, false',
    '}',
    '',
  ].join('\n');
}

function goNews(rel: string): string {
  return [
    `package ${goPackage(rel)}`,
    '',
    '// NewsItem is one published article.',
    'type NewsItem struct {',
    '\tID    string',
    '\tSlug  string',
    '\tTitle string',
    '}',
    '',
    '// ListNews returns the full news listing.',
    'func ListNews(s *Store) []NewsItem {',
    '\treturn s.News()',
    '}',
    '',
    '// NewsBySlug resolves a single news item by its slug.',
    'func NewsBySlug(s *Store, slug string) (NewsItem, bool) {',
    '\tfor _, item := range s.News() {',
    '\t\tif item.Slug == slug {',
    '\t\t\treturn item, true',
    '\t\t}',
    '\t}',
    '\treturn NewsItem{}, false',
    '}',
    '',
  ].join('\n');
}

// Behaviour, not a grep over source text. Test function names are derived from
// the file so three sibling test files cannot collide.
function goTest(rel: string): string {
  const suffix = path.basename(rel)
    .replace(/_test\.go$/, '')
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return [
    `package ${goPackage(rel)}`,
    '',
    'import "testing"',
    '',
    `func Test${suffix}SeedsCatalogue(t *testing.T) {`,
    '\tstore := NewStore()',
    '\tif len(store.Products()) == 0 {',
    '\t\tt.Fatal("expected the store to seed products")',
    '\t}',
    '\tif len(store.News()) == 0 {',
    '\t\tt.Fatal("expected the store to seed news")',
    '\t}',
    '}',
    '',
  ].join('\n');
}

function goSource(rel: string, kind: string | null): string | null {
  const base = path.basename(rel);
  if (/_test\.go$/.test(base)) return goTest(rel);
  if (kind === 'store' || /store\.go$/.test(base)) return goStore(rel);
  if (/products?_/.test(base)) return goProducts(rel);
  if (/news_/.test(base)) return goNews(rel);
  return null;
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
  if (rel.endsWith('.go')) return goSource(rel, module?.kind ?? null);
  if (rel === 'go.mod') {
    return `module example.com/api\n\ngo 1.22\n`;
  }
  // No external dependencies, so there is nothing to record; an empty go.sum
  // would be noise, not evidence.
  if (rel === 'go.sum') return null;

  if (module) {
    const name = componentName(rel);
    if (module.kind === 'app-shell') return appShell(ctx, rel);
    if (module.kind === 'page') return pageSource(ctx, rel, name);
    if (module.kind === 'component') return componentSource(name);
    if (module.kind === 'feature') return featureSource();
    if (module.kind === 'service') return serviceSource(name);
  }

  const base = path.basename(rel);
  if (rel === 'package.json') return rootPackageJson();
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
  if (/locales\/[a-z-]+\/[a-z-]+\.json$/i.test(rel)) return catalogFor(rel, ctx);
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
