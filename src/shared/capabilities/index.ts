// Runtime-owned project capability registry. Stack labels remain compatible
// with existing .one.json files, while this profile is the single source for
// surfaces, structural conventions, role eligibility, skill buckets, and QA.

import * as fs from 'fs';
import * as path from 'path';

import { readJson } from '../fsjson';
import { obj, type Rec } from '../obj';

export const CAPABILITY_SCHEMA_VERSION = 1 as const;

export type ProjectSurface = 'web-ui' | 'native-ui' | 'api' | 'cli' | 'worker' | 'data';
export type StructuralProfileId =
  | 'vite-react'
  | 'next-app'
  | 'next-pages'
  | 'nuxt'
  | 'vue'
  | 'sveltekit'
  | 'svelte'
  | 'astro'
  | 'angular'
  | 'server-rendered'
  | 'generic-web'
  | 'unsupported-hybrid'
  | 'react-native'
  | 'swift-native'
  | 'kotlin-native'
  | 'flutter-native'
  | 'backend-only';
export type QaAdapterId = 'playwright' | 'maestro' | 'xcode-simulator' | 'android-emulator' | 'flutter-driver';
export type ArchitectureTargetSurface = 'web-ui' | 'native-ui';

export interface CapabilityBlockingIssueV1 {
  code: 'CAPABILITY_HYBRID_UI_TARGET_REQUIRED';
  message: string;
}

export interface CapabilityProfileV1 {
  schemaVersion: typeof CAPABILITY_SCHEMA_VERSION;
  profileId: StructuralProfileId;
  surfaces: ProjectSurface[];
  framework: string;
  backendFramework: string;
  router: string;
  sourceRoots: string[];
  entrypoints: string[];
  layerRoots: {
    pages: string[];
    components: string[];
    features: string[];
    lib: string[];
  };
  roles: string[];
  skillBuckets: string[];
  qaAdapters: QaAdapterId[];
  /** Runtime/user-owned selection for a project that exposes both UI domains. */
  architectureTarget?: ArchitectureTargetSurface;
  /** Detected frameworks are retained when the selected structural profile represents only one UI domain. */
  uiFrameworks?: {
    web: string;
    native: string;
  };
  /** Any entry is fail-closed at architecture compilation. */
  blockingIssues?: CapabilityBlockingIssueV1[];
}

const UNIVERSAL_ROLES = ['senior-architect', 'senior-reviewer', 'senior-tester', 'senior-shipper'];
const BACKEND_NONE = new Set(['', 'none', 'external-api']);
const FRONTEND_NONE = new Set(['', 'none']);
const MAX_WORKSPACE_ROOTS = 128;

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function stringField(rec: Rec | null, key: string, fallback = ''): string {
  const value = rec?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function exists(cwd: string, rel: string): boolean {
  try { return fs.existsSync(path.join(cwd, rel)); } catch { return false; }
}

function packageDependencies(cwd: string, root = '.'): Rec {
  const pkg = readJson<Rec>(path.join(cwd, root, 'package.json'), {});
  return {
    ...(obj(pkg.dependencies) || {}),
    ...(obj(pkg.devDependencies) || {}),
  };
}

function composerPackages(cwd: string): Rec {
  const composer = readJson<Rec>(path.join(cwd, 'composer.json'), {});
  return {
    ...(obj(composer.require) || {}),
    ...(obj(composer['require-dev']) || {}),
  };
}

export interface FrontendFrameworkDetectionV1 {
  frontend: string;
  hasWebUi: boolean;
  evidence: string[];
  webRoot?: string;
}

function laravelBladeUiPresent(cwd: string): boolean {
  const viewsRoot = path.join(cwd, 'resources', 'views');
  try {
    return fs.readdirSync(viewsRoot, { withFileTypes: true }).some((entry) => (
      entry.isDirectory()
      || (entry.isFile() && entry.name.endsWith('.blade.php') && entry.name !== 'welcome.blade.php')
    ));
  } catch {
    return false;
  }
}

function laravelJavascriptUiPresent(cwd: string): boolean {
  for (const entrypoint of [
    'resources/js/app.tsx',
    'resources/js/app.jsx',
    'resources/js/app.vue',
    'resources/js/App.tsx',
    'resources/js/App.jsx',
  ]) {
    if (exists(cwd, entrypoint)) return true;
  }
  for (const entrypoint of ['resources/js/app.js', 'resources/js/app.ts']) {
    let source = '';
    try { source = fs.readFileSync(path.join(cwd, entrypoint), 'utf8').slice(0, 256_000); } catch { continue; }
    // A stock Laravel Vite entrypoint imports only bootstrap.js. Treat it as
    // backend scaffolding; actual mount/router/Inertia code is UI evidence.
    const withoutImports = source
      .replace(/^\s*import\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .trim();
    if (withoutImports
      && /\b(?:createRoot|hydrateRoot|createApp|createInertiaApp|ReactDOM|Inertia|mount)\b/.test(withoutImports)) {
      return true;
    }
  }
  return false;
}

function frameworkFromDependencies(deps: Rec): string | null {
  if (deps.next) return 'nextjs';
  if (deps.nuxt) return 'nuxt';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps.astro) return 'astro';
  if (deps['@angular/core'] || deps['@angular/cli']) return 'angular';
  if (deps.vue || deps['@vitejs/plugin-vue']) return 'vue';
  if (deps.svelte) return 'svelte';
  if (deps['@remix-run/react']) return 'remix';
  if (deps['solid-js'] || deps['@solidjs/start']) return 'solid';
  if (deps.react) {
    // React is also a required peer of React Native. Do not manufacture a web
    // surface unless a browser runtime/build dependency is present.
    if ((deps.expo || deps['react-native']) && !deps['react-dom'] && !deps.vite) return null;
    return 'react-vite';
  }
  return null;
}

function frameworkArtifact(
  cwd: string,
  root: string,
): { frontend: string; marker: string } | null {
  const candidates: Array<{ frontend: string; markers: string[] }> = [
    {
      frontend: 'nextjs',
      markers: [
        'next.config.ts', 'next.config.js', 'next.config.mjs',
        'app/page.tsx', 'app/page.jsx', 'app/layout.tsx', 'app/layout.jsx',
        'src/app/page.tsx', 'src/app/page.jsx', 'src/app/layout.tsx', 'src/app/layout.jsx',
        'pages/_app.tsx', 'pages/_app.jsx', 'src/pages/_app.tsx', 'src/pages/_app.jsx',
      ],
    },
    {
      frontend: 'nuxt',
      markers: ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'app.vue'],
    },
    {
      frontend: 'sveltekit',
      markers: [
        'src/routes/+page.svelte', 'src/routes/+layout.svelte',
        'svelte.config.js', 'svelte.config.ts',
      ],
    },
    {
      frontend: 'astro',
      markers: [
        'astro.config.ts', 'astro.config.js', 'astro.config.mjs',
        'src/pages/index.astro',
      ],
    },
    {
      frontend: 'angular',
      markers: ['angular.json', 'src/app/app.component.ts'],
    },
    {
      frontend: 'vue',
      markers: ['src/App.vue', 'src/app.vue', 'src/main.vue'],
    },
    {
      frontend: 'svelte',
      markers: ['src/App.svelte', 'src/app.svelte'],
    },
    {
      frontend: 'react-vite',
      markers: ['src/main.tsx', 'src/main.jsx', 'src/App.tsx', 'src/App.jsx'],
    },
    {
      frontend: 'custom-web',
      markers: [
        'app/Home.tsx', 'app/Home.jsx',
        'pages/index.tsx', 'pages/index.jsx', 'pages/index.html',
        'src/index.html', 'index.html',
      ],
    },
  ];
  for (const candidate of candidates) {
    const marker = candidate.markers.find((rel) => exists(cwd, prefixed(root, rel)));
    if (marker) return { frontend: candidate.frontend, marker };
  }
  return null;
}

/**
 * Framework-aware frontend detector shared by capability derivation and
 * legacy-state migration. Configuration labels alone do not turn the stock
 * Laravel Vite/bootstrap scaffold into a browser UI.
 */
export function detectFrontendFramework(
  cwd: string,
  input: unknown,
): FrontendFrameworkDetectionV1 {
  const state = obj(input) || {};
  const configured = stringField(state, 'frontend', 'none');
  const dependencySets = candidateWebRoots(cwd).map((root) => ({
    root,
    deps: packageDependencies(cwd, root),
  }));
  const composer = composerPackages(cwd);
  const backend = stringField(state, 'backend', 'none');
  const isLaravel = backend === 'laravel' || Boolean(composer['laravel/framework']);
  const evidence: string[] = [];

  if (isLaravel) {
    const deps = packageDependencies(cwd);
    const inertia = Boolean(
      composer['inertiajs/inertia-laravel']
      || deps['@inertiajs/react']
      || deps['@inertiajs/vue3'],
    );
    if (inertia) evidence.push('laravel:inertia');
    if ([
      'resources/js/Pages',
      'resources/js/pages',
      'resources/js/Components',
      'resources/js/components',
    ].some((root) => exists(cwd, root))) evidence.push('laravel:ui-modules');
    if (laravelBladeUiPresent(cwd)) evidence.push('laravel:blade-views');
    if (laravelJavascriptUiPresent(cwd)) evidence.push('laravel:ui-entrypoint');
    if (configured === 'laravel-ui') evidence.push('state:laravel-ui');
    if (evidence.length > 0) {
      return { frontend: 'laravel-ui', hasWebUi: true, evidence, webRoot: '.' };
    }
    // `app/`, welcome.blade.php, resources/js/bootstrap.js/app.js and the
    // laravel-vite-plugin/vite dependency are ordinary Laravel scaffolding.
    return { frontend: 'none', hasWebUi: false, evidence: ['laravel:api-or-default-scaffold'] };
  }

  // Prefer specific application frameworks over generic React/Vite evidence
  // elsewhere in a workspace (for example a React package beside a Next app).
  for (const frontend of [
    'nextjs', 'nuxt', 'sveltekit', 'astro', 'angular', 'vue', 'svelte',
    'remix', 'solid', 'react-vite',
  ]) {
    const match = dependencySets.find(({ deps }) => frameworkFromDependencies(deps) === frontend);
    if (match) {
      return {
        frontend,
        hasWebUi: true,
        evidence: [`${match.root}/package.json:${frontend}`],
        // Root dependencies may be hoisted for a workspace app. Let the
        // framework profile choose a concrete marked child root in that case;
        // a package-local manifest remains authoritative for its own root.
        ...(match.root === '.' ? {} : { webRoot: match.root }),
      };
    }
  }

  const artifact = candidateWebRoots(cwd)
    .map((root) => ({ root, evidence: frameworkArtifact(cwd, root) }))
    .find((candidate) => Boolean(candidate.evidence));
  if (artifact?.evidence) {
    const frontend = configured !== 'none'
      && artifact.evidence.frontend === 'custom-web'
      ? configured
      : artifact.evidence.frontend;
    return {
      frontend,
      hasWebUi: true,
      evidence: [`path:${prefixed(artifact.root, artifact.evidence.marker)}`],
      webRoot: artifact.root,
    };
  }

  const vite = dependencySets.find(({ deps }) => Boolean(deps.vite));
  if (vite && state.stack !== 'custom-backend') {
    return {
      frontend: configured !== 'none' ? configured : 'custom-web',
      hasWebUi: true,
      evidence: [`${vite.root}/package.json:vite`],
      webRoot: vite.root,
    };
  }
  if (configured !== 'none' && state.stack !== 'custom-backend') {
    return { frontend: configured, hasWebUi: true, evidence: [`state:${configured}`], webRoot: '.' };
  }
  return { frontend: 'none', hasWebUi: false, evidence: [] };
}

export function frontendArtifactsPresent(cwd: string): boolean {
  return detectFrontendFramework(cwd, {}).hasWebUi;
}

function prefixed(root: string, rel: string): string {
  return root === '.' ? rel : `${root}/${rel}`;
}

function workspaceChildren(cwd: string, container: 'apps' | 'packages'): string[] {
  try {
    return fs.readdirSync(path.join(cwd, container), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${container}/${entry.name}`)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function candidateWebRoots(cwd: string): string[] {
  const conventional = ['apps/web', 'web', 'frontend', 'client']
    .filter((root) => exists(cwd, root));
  const workspace = [
    ...workspaceChildren(cwd, 'apps'),
    ...workspaceChildren(cwd, 'packages'),
  ].slice(0, MAX_WORKSPACE_ROOTS);
  return unique([...conventional, ...workspace, '.']);
}

function frameworkWebRoot(cwd: string, dependency: string, markers: string[]): string {
  const roots = candidateWebRoots(cwd);
  const withMarkers = roots.filter((root) => markers.some((marker) => exists(cwd, prefixed(root, marker))));
  const exact = withMarkers.find((root) => dependency && Boolean(packageDependencies(cwd, root)[dependency]));
  if (exact) return exact;
  if (withMarkers.length > 0) return withMarkers[0]!;
  return roots.find((root) => dependency && Boolean(packageDependencies(cwd, root)[dependency]))
    || roots.find((root) => root !== '.')
    || '.';
}

function nuxtSourceRoot(cwd: string, webRoot: string): string {
  for (const name of ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs']) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(cwd, prefixed(webRoot, name)), 'utf8').slice(0, 256_000);
    } catch {
      continue;
    }
    const match = /\bsrcDir\s*:\s*['"]([^'"]+)['"]/.exec(text);
    const configured = match?.[1]?.replace(/^\.?\//, '').replace(/\/+$/, '');
    if (configured && !configured.includes('..')) return prefixed(webRoot, configured);
  }
  return webRoot;
}

function laravelInertiaKind(cwd: string): 'react' | 'vue' | 'unknown' | null {
  const composer = composerPackages(cwd);
  const deps = packageDependencies(cwd);
  const hasPages = [
    'resources/js/Pages',
    'resources/js/pages',
  ].some((root) => exists(cwd, root));
  if (!composer['inertiajs/inertia-laravel'] && !deps['@inertiajs/react'] && !deps['@inertiajs/vue3'] && !hasPages) {
    return null;
  }
  if (deps['@inertiajs/react'] || deps.react) return 'react';
  if (deps['@inertiajs/vue3'] || deps.vue) return 'vue';
  return 'unknown';
}

function detectedBackend(cwd: string, state: Rec): string {
  const configured = stringField(state, 'backend', 'none');
  if (!['', 'none', 'other'].includes(configured)) return configured;
  const composer = composerPackages(cwd);
  if (composer['laravel/framework']) return 'laravel';
  if (exists(cwd, 'go.mod')) return 'go';
  if (exists(cwd, 'Cargo.toml')) return 'rust';
  if (exists(cwd, 'pyproject.toml') || exists(cwd, 'requirements.txt') || exists(cwd, 'setup.py')) return 'python';
  if (
    safeNames(cwd).some((name) => name.endsWith('.py') && !name.startsWith('.'))
    && (stringField(state, 'stack') === 'custom-backend' || !frontendArtifactsPresent(cwd))
  ) return 'python';
  if (exists(cwd, 'pom.xml') || exists(cwd, 'build.gradle') || exists(cwd, 'build.gradle.kts')) return 'java';
  return configured;
}

export function defaultStateForStack(stack: string): Rec {
  if (stack === 'default') {
    return {
      stack,
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'none' },
    };
  }
  if (stack === 'custom-backend') {
    return {
      stack,
      frontend: 'none',
      backend: 'other',
      mobile: { enabled: false, framework: 'none', source: 'none' },
    };
  }
  return {
    stack,
    frontend: 'none',
    backend: stack === 'minimal' ? 'none' : 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'none' },
  };
}

interface NativeFrameworkDetectionV1 {
  framework: string;
  root: string;
}

function detectedNativeFramework(cwd: string, state: Rec): NativeFrameworkDetectionV1 {
  const mobile = obj(state.mobile);
  const configured = stringField(mobile, 'framework', 'none');
  const roots = candidateWebRoots(cwd);
  const dependencySets = roots.map((root) => ({ root, deps: packageDependencies(cwd, root) }));
  const reactNative = dependencySets.find(({ deps }) => Boolean(deps.expo || deps['react-native']));
  const flutter = roots.find((root) => exists(cwd, prefixed(root, 'pubspec.yaml')));
  const swift = roots.find((root) => (
    exists(cwd, prefixed(root, 'Package.swift'))
    || exists(cwd, prefixed(root, 'project.pbxproj'))
    || safeNames(path.join(cwd, root)).some((name) => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace'))
  ));
  const kotlin = roots.find((root) => (
    exists(cwd, prefixed(root, 'settings.gradle'))
    || exists(cwd, prefixed(root, 'settings.gradle.kts'))
    || exists(cwd, prefixed(root, 'app/build.gradle'))
    || exists(cwd, prefixed(root, 'app/build.gradle.kts'))
  ));
  if (configured !== 'none') {
    if (configured === 'react-native-expo' && reactNative) return { framework: configured, root: reactNative.root };
    if (configured === 'flutter' && flutter) return { framework: configured, root: flutter };
    if (configured === 'swift-native' && swift) return { framework: configured, root: swift };
    if (configured === 'kotlin-android' && kotlin) return { framework: configured, root: kotlin };
    const conventional = roots.find((root) => /(?:^|\/)(?:mobile|native|ios|android)$/.test(root));
    return { framework: configured, root: conventional || '.' };
  }
  if (reactNative) return { framework: 'react-native-expo', root: reactNative.root };
  if (flutter) return { framework: 'flutter', root: flutter };
  if (swift) return { framework: 'swift-native', root: swift };
  if (kotlin) return { framework: 'kotlin-android', root: kotlin };
  return { framework: 'none', root: '.' };
}

function safeNames(cwd: string): string[] {
  try { return fs.readdirSync(cwd); } catch { return []; }
}

function fileContains(cwd: string, rel: string, pattern: RegExp): boolean {
  try {
    return pattern.test(fs.readFileSync(path.join(cwd, rel), 'utf8').slice(0, 512_000));
  } catch {
    return false;
  }
}

function pythonApiEvidencePresent(cwd: string, backend: string): boolean {
  if (backend === 'fastapi' || backend === 'django') return true;
  if ([
    'api',
    'routes',
    'endpoints',
    'manage.py',
  ].some((marker) => exists(cwd, marker))) return true;
  const frameworkPattern = /\b(?:fastapi|flask|django|starlette|litestar|aiohttp|sanic|uvicorn)\b/i;
  if ([
    'pyproject.toml',
    'requirements.txt',
    'requirements-dev.txt',
    'Pipfile',
  ].some((rel) => fileContains(cwd, rel, frameworkPattern))) return true;
  const serverPattern = /\b(?:FastAPI|Flask|APIRouter)\s*\(|\bfrom\s+(?:django|aiohttp|sanic)\b|@(?:app|router)\.(?:get|post|put|patch|delete|route)\b/;
  return safeNames(cwd)
    .filter((name) => name.endsWith('.py'))
    .some((name) => fileContains(cwd, name, serverPattern));
}

function backendExposesApi(cwd: string, backend: string): boolean {
  if (BACKEND_NONE.has(backend)) return false;
  // `python` names a language/runtime, not a transport. A script, CLI, worker,
  // ETL job, or library must not acquire an API surface without server/router
  // evidence. Explicit web frameworks remain APIs.
  if (backend === 'python') return pythonApiEvidencePresent(cwd, backend);
  return true;
}

function pythonCliEvidencePresent(cwd: string): boolean {
  if (exists(cwd, 'cmd') || exists(cwd, 'bin')) return true;
  if (fileContains(cwd, 'pyproject.toml', /^\s*\[(?:project\.scripts|tool\.poetry\.scripts)\]\s*$/m)) {
    return true;
  }
  return safeNames(cwd).some((name) => (
    name.endsWith('.py')
    && !['manage.py', 'wsgi.py', 'asgi.py'].includes(name)
  ));
}

function postgresEvidencePresent(cwd: string, state: Rec, backend: string): boolean {
  if (['supabase', 'our-fork', 'postgres', 'postgresql'].includes(backend)) return true;
  const provider = [
    state.database,
    state.databaseProvider,
    state.database_provider,
    state.db,
    state.dbProvider,
  ].find((value) => typeof value === 'string' && value.trim()) as string | undefined;
  if (provider && /\b(?:postgres|postgresql|supabase)\b/i.test(provider)) return true;

  const jsDeps = candidateWebRoots(cwd).flatMap((root) => Object.keys(packageDependencies(cwd, root)));
  if (jsDeps.some((name) => [
    'pg',
    'postgres',
    'postgres.js',
    '@supabase/supabase-js',
    '@supabase/ssr',
  ].includes(name))) return true;

  const packageEvidence = [
    ['go.mod', /\b(?:github\.com\/lib\/pq|github\.com\/jackc\/pgx)\b/i],
    ['pyproject.toml', /\b(?:psycopg|psycopg2|asyncpg|postgresql)\b/i],
    ['requirements.txt', /\b(?:psycopg|psycopg2|asyncpg)\b/i],
    ['composer.json', /\b(?:ext-pgsql|ext-pdo_pgsql)\b/i],
    ['Cargo.toml', /\b(?:tokio-postgres|postgres)\b/i],
    ['docker-compose.yml', /\b(?:image:\s*postgres|postgresql:)\b/i],
    ['docker-compose.yaml', /\b(?:image:\s*postgres|postgresql:)\b/i],
    ['compose.yml', /\b(?:image:\s*postgres|postgresql:)\b/i],
    ['compose.yaml', /\b(?:image:\s*postgres|postgresql:)\b/i],
    ['.env.example', /\bpostgres(?:ql)?:\/\//i],
  ] as const;
  return packageEvidence.some(([rel, pattern]) => fileContains(cwd, rel, pattern));
}

function backendSkillBucket(backend: string): string | null {
  if (backend === 'supabase' || backend === 'our-fork') return 'supabase';
  if (backend === 'nestjs') return 'node';
  if (backend === 'fastapi') return 'python';
  if (backend === 'laravel') return 'php';
  if (backend === 'csharp') return 'dotnet';
  if (backend === 'other') return null;
  return backend;
}

function frontendProfile(frontend: string, cwd: string, preferredWebRoot?: string): Pick<
  CapabilityProfileV1,
  'profileId' | 'framework' | 'router' | 'sourceRoots' | 'entrypoints' | 'layerRoots' | 'qaAdapters'
> {
  if (frontend === 'nextjs') {
    const webRoot = preferredWebRoot
      || frameworkWebRoot(cwd, 'next', ['app', 'src/app', 'pages', 'src/pages']);
    const appRoot = prefixed(webRoot, 'app');
    const srcAppRoot = prefixed(webRoot, 'src/app');
    const pagesRoot = prefixed(webRoot, 'pages');
    const srcPagesRoot = prefixed(webRoot, 'src/pages');
    const appRouter = exists(cwd, appRoot) || exists(cwd, srcAppRoot)
      || (!exists(cwd, pagesRoot) && !exists(cwd, srcPagesRoot));
    return {
      profileId: appRouter ? 'next-app' : 'next-pages',
      framework: 'nextjs',
      router: appRouter ? 'next-app-router' : 'next-pages-router',
      sourceRoots: appRouter ? [appRoot, srcAppRoot] : [pagesRoot, srcPagesRoot],
      entrypoints: appRouter
        ? [`${appRoot}/layout.tsx`, `${srcAppRoot}/layout.tsx`]
        : [`${pagesRoot}/_app.tsx`, `${srcPagesRoot}/_app.tsx`],
      layerRoots: {
        pages: appRouter ? [appRoot, srcAppRoot] : [pagesRoot, srcPagesRoot],
        components: [prefixed(webRoot, 'components'), prefixed(webRoot, 'src/components')],
        features: [prefixed(webRoot, 'features'), prefixed(webRoot, 'src/features')],
        lib: [prefixed(webRoot, 'lib'), prefixed(webRoot, 'src/lib')],
      },
      qaAdapters: ['playwright'],
    };
  }
  if (frontend === 'nuxt') {
    const webRoot = preferredWebRoot
      || frameworkWebRoot(cwd, 'nuxt', ['nuxt.config.ts', 'nuxt.config.js', 'app.vue', 'app']);
    const sourceRoot = nuxtSourceRoot(cwd, webRoot);
    return {
      profileId: 'nuxt',
      framework: 'nuxt',
      router: 'nuxt-file-router',
      sourceRoots: [prefixed(sourceRoot, 'app'), sourceRoot],
      entrypoints: [prefixed(sourceRoot, 'app/app.vue'), prefixed(sourceRoot, 'app.vue')],
      layerRoots: {
        pages: [prefixed(sourceRoot, 'app/pages'), prefixed(sourceRoot, 'pages')],
        components: [prefixed(sourceRoot, 'app/components'), prefixed(sourceRoot, 'components')],
        features: [prefixed(sourceRoot, 'app/features'), prefixed(sourceRoot, 'features')],
        lib: [prefixed(sourceRoot, 'app/composables'), prefixed(sourceRoot, 'composables'), prefixed(sourceRoot, 'utils')],
      },
      qaAdapters: ['playwright'],
    };
  }
  if (frontend === 'vue') {
    const webRoot = preferredWebRoot
      || frameworkWebRoot(cwd, 'vue', ['src/App.vue', 'src/main.ts', 'src']);
    const sourceRoot = prefixed(webRoot, 'src');
    return {
      profileId: 'vue',
      framework: 'vue',
      router: 'vue-router',
      sourceRoots: [sourceRoot],
      entrypoints: [`${sourceRoot}/main.ts`, `${sourceRoot}/main.js`],
      layerRoots: {
        pages: [`${sourceRoot}/pages`, `${sourceRoot}/views`],
        components: [`${sourceRoot}/components`],
        features: [`${sourceRoot}/features`],
        lib: [`${sourceRoot}/lib`, `${sourceRoot}/composables`],
      },
      qaAdapters: ['playwright'],
    };
  }
  if (frontend === 'sveltekit') {
    const webRoot = preferredWebRoot
      || frameworkWebRoot(cwd, '@sveltejs/kit', ['src/routes', 'svelte.config.js', 'svelte.config.ts']);
    const sourceRoot = prefixed(webRoot, 'src');
    return {
      profileId: 'sveltekit',
      framework: 'sveltekit',
      router: 'sveltekit-file-router',
      sourceRoots: [sourceRoot],
      entrypoints: [`${sourceRoot}/routes/+layout.svelte`],
      layerRoots: {
        pages: [`${sourceRoot}/routes`],
        components: [`${sourceRoot}/lib/components`],
        features: [`${sourceRoot}/lib/features`],
        lib: [`${sourceRoot}/lib`],
      },
      qaAdapters: ['playwright'],
    };
  }
  if (frontend === 'svelte') {
    const webRoot = preferredWebRoot
      || frameworkWebRoot(cwd, 'svelte', ['src/App.svelte', 'src/main.ts', 'src']);
    const sourceRoot = prefixed(webRoot, 'src');
    return {
      profileId: 'svelte',
      framework: 'svelte',
      router: 'svelte-router',
      sourceRoots: [sourceRoot],
      entrypoints: [`${sourceRoot}/main.ts`, `${sourceRoot}/main.js`],
      layerRoots: {
        pages: [`${sourceRoot}/pages`, `${sourceRoot}/routes`],
        components: [`${sourceRoot}/components`, `${sourceRoot}/lib/components`],
        features: [`${sourceRoot}/features`, `${sourceRoot}/lib/features`],
        lib: [`${sourceRoot}/lib`],
      },
      qaAdapters: ['playwright'],
    };
  }
  if (frontend === 'astro') {
    const webRoot = preferredWebRoot
      || frameworkWebRoot(cwd, 'astro', ['astro.config.ts', 'astro.config.mjs', 'src/pages']);
    const sourceRoot = prefixed(webRoot, 'src');
    return {
      profileId: 'astro',
      framework: 'astro',
      router: 'astro-file-router',
      sourceRoots: [sourceRoot],
      entrypoints: [`${sourceRoot}/layouts/Layout.astro`],
      layerRoots: {
        pages: [`${sourceRoot}/pages`],
        components: [`${sourceRoot}/components`],
        features: [`${sourceRoot}/features`],
        lib: [`${sourceRoot}/lib`],
      },
      qaAdapters: ['playwright'],
    };
  }
  if (frontend === 'angular') {
    const webRoot = preferredWebRoot
      || frameworkWebRoot(cwd, '@angular/core', ['angular.json', 'src/app', 'src/main.ts']);
    const sourceRoot = prefixed(webRoot, 'src/app');
    return {
      profileId: 'angular',
      framework: 'angular',
      router: 'angular-router',
      sourceRoots: [sourceRoot],
      entrypoints: [prefixed(webRoot, 'src/main.ts')],
      layerRoots: {
        pages: [`${sourceRoot}/pages`],
        components: [`${sourceRoot}/components`, `${sourceRoot}/shared/components`],
        features: [`${sourceRoot}/features`],
        lib: [`${sourceRoot}/core`, `${sourceRoot}/shared`],
      },
      qaAdapters: ['playwright'],
    };
  }
  if (frontend === 'laravel-ui') {
    const inertia = laravelInertiaKind(cwd);
    const sourceRoots = inertia ? ['resources/js', 'resources/views'] : ['resources/views', 'resources/js'];
    const pages = inertia
      ? ['resources/js/Pages', 'resources/js/pages', 'resources/views']
      : ['resources/views', 'resources/js/Pages', 'resources/js/pages'];
    const components = inertia
      ? ['resources/js/Components', 'resources/js/components', 'resources/views/components']
      : ['resources/views/components', 'resources/js/Components', 'resources/js/components'];
    return {
      profileId: 'server-rendered',
      framework: 'laravel',
      router: inertia === 'react'
        ? 'inertia-react-router'
        : inertia === 'vue'
          ? 'inertia-vue-router'
          : inertia
            ? 'inertia-router'
            : 'laravel-router',
      sourceRoots,
      entrypoints: ['resources/js/app.ts', 'resources/js/app.tsx', 'resources/js/app.js'],
      layerRoots: {
        pages,
        components,
        features: ['resources/js/Features', 'resources/js/features'],
        lib: ['resources/js/lib', 'app/View'],
      },
      qaAdapters: ['playwright'],
    };
  }
  if (frontend === 'react-vite') {
    const webRoot = preferredWebRoot || frameworkWebRoot(cwd, 'vite', [
      'src/main.tsx',
      'src/main.jsx',
      'vite.config.ts',
      'vite.config.js',
      'src',
    ]);
    const sourceRoot = prefixed(webRoot, 'src');
    return {
      profileId: 'vite-react',
      framework: 'react-vite',
      router: 'react-router',
      sourceRoots: [sourceRoot],
      entrypoints: [`${sourceRoot}/main.tsx`, `${sourceRoot}/main.jsx`],
      layerRoots: {
        pages: [`${sourceRoot}/pages`],
        components: [`${sourceRoot}/components`, 'packages/ui/src'],
        features: [`${sourceRoot}/features`],
        lib: [`${sourceRoot}/lib`, 'packages'],
      },
      qaAdapters: ['playwright'],
    };
  }
  const webRoot = preferredWebRoot || frameworkWebRoot(cwd, '', ['src', 'app', 'pages']);
  return {
    profileId: 'generic-web',
    framework: frontend,
    router: 'framework-router',
    sourceRoots: [prefixed(webRoot, 'src'), prefixed(webRoot, 'app'), prefixed(webRoot, 'pages')],
    entrypoints: [prefixed(webRoot, 'src/main.ts'), prefixed(webRoot, 'src/main.js'), prefixed(webRoot, 'app')],
    layerRoots: {
      pages: [prefixed(webRoot, 'src/pages'), prefixed(webRoot, 'pages'), prefixed(webRoot, 'app')],
      components: [prefixed(webRoot, 'src/components'), prefixed(webRoot, 'components')],
      features: [prefixed(webRoot, 'src/features'), prefixed(webRoot, 'features')],
      lib: [prefixed(webRoot, 'src/lib'), prefixed(webRoot, 'lib')],
    },
    qaAdapters: ['playwright'],
  };
}

function nativeProfile(framework: string, nativeRoot = '.'): Pick<
  CapabilityProfileV1,
  'profileId' | 'framework' | 'router' | 'sourceRoots' | 'entrypoints' | 'layerRoots' | 'qaAdapters'
> {
  if (framework === 'react-native-expo') {
    const appRoot = prefixed(nativeRoot, 'app');
    const sourceRoot = prefixed(nativeRoot, 'src');
    return {
      profileId: 'react-native',
      framework,
      router: 'expo-router',
      sourceRoots: [appRoot, sourceRoot],
      entrypoints: [`${appRoot}/_layout.tsx`],
      layerRoots: {
        pages: [appRoot, `${sourceRoot}/screens`],
        components: [`${sourceRoot}/components`, 'packages/ui-native/src'],
        features: [`${sourceRoot}/features`],
        lib: [`${sourceRoot}/lib`, `${sourceRoot}/services`],
      },
      qaAdapters: ['maestro'],
    };
  }
  if (framework === 'swift-native') {
    return {
      profileId: 'swift-native',
      framework,
      router: 'swiftui-navigation',
      sourceRoots: [prefixed(nativeRoot, 'Sources'), prefixed(nativeRoot, 'App')],
      entrypoints: [prefixed(nativeRoot, 'App.swift')],
      layerRoots: {
        pages: [prefixed(nativeRoot, 'Features'), prefixed(nativeRoot, 'Views')],
        components: [prefixed(nativeRoot, 'Components')],
        features: [prefixed(nativeRoot, 'Features')],
        lib: [prefixed(nativeRoot, 'Core'), prefixed(nativeRoot, 'Services')],
      },
      qaAdapters: ['xcode-simulator'],
    };
  }
  if (framework === 'kotlin-android') {
    const appRoot = prefixed(nativeRoot, 'app');
    return {
      profileId: 'kotlin-native',
      framework,
      router: 'android-navigation',
      sourceRoots: [`${appRoot}/src/main`],
      entrypoints: [`${appRoot}/src/main/AndroidManifest.xml`],
      layerRoots: {
        pages: [`${appRoot}/src/main/java`, `${appRoot}/src/main/kotlin`],
        components: [`${appRoot}/src/main/java`, `${appRoot}/src/main/kotlin`],
        features: [prefixed(nativeRoot, 'features'), `${appRoot}/src/main`],
        lib: [prefixed(nativeRoot, 'core')],
      },
      qaAdapters: ['android-emulator'],
    };
  }
  const libRoot = prefixed(nativeRoot, 'lib');
  return {
    profileId: 'flutter-native',
    framework: 'flutter',
    router: 'flutter-router',
    sourceRoots: [libRoot],
    entrypoints: [`${libRoot}/main.dart`],
    layerRoots: {
      pages: [`${libRoot}/screens`, `${libRoot}/pages`],
      components: [`${libRoot}/widgets`],
      features: [`${libRoot}/features`],
      lib: [`${libRoot}/core`],
    },
    qaAdapters: ['flutter-driver'],
  };
}

type StructuralProfileV1 = ReturnType<typeof frontendProfile> | ReturnType<typeof nativeProfile>;

function frontendSkillBucket(frontend: string): string {
  if (frontend === 'react-vite' || frontend === 'nextjs' || frontend === 'nuxt') return frontend;
  return 'custom-web';
}

function architectureTarget(state: Rec): ArchitectureTargetSurface | null {
  const raw = stringField(
    state,
    'architectureTarget',
    stringField(state, 'architectureTargetSurface', ''),
  );
  return raw === 'web-ui' || raw === 'native-ui' ? raw : null;
}

function unsupportedHybridProfile(
  web: StructuralProfileV1,
  native: StructuralProfileV1,
): StructuralProfileV1 {
  return {
    profileId: 'unsupported-hybrid',
    framework: 'hybrid',
    router: 'unresolved',
    sourceRoots: unique([...web.sourceRoots, ...native.sourceRoots]),
    entrypoints: unique([...web.entrypoints, ...native.entrypoints]),
    layerRoots: {
      pages: unique([...web.layerRoots.pages, ...native.layerRoots.pages]),
      components: unique([...web.layerRoots.components, ...native.layerRoots.components]),
      features: unique([...web.layerRoots.features, ...native.layerRoots.features]),
      lib: unique([...web.layerRoots.lib, ...native.layerRoots.lib]),
    },
    qaAdapters: unique([...web.qaAdapters, ...native.qaAdapters]),
  };
}

export function capabilityProfileForProject(cwd: string, input: unknown): CapabilityProfileV1 {
  const state = obj(input) || {};
  const frontendDetection = detectFrontendFramework(cwd, state);
  const frontend = frontendDetection.frontend;
  const nativeDetection = detectedNativeFramework(cwd, state);
  const nativeFramework = nativeDetection.framework;
  const backend = detectedBackend(cwd, state);
  const surfaces: ProjectSurface[] = [];
  const skillBuckets: string[] = [];
  const hasWeb = !FRONTEND_NONE.has(frontend);
  const hasNative = nativeFramework !== 'none' && nativeFramework !== 'ionic-capacitor';
  const selectedTarget = architectureTarget(state);
  let profileExtras: Pick<
    CapabilityProfileV1,
    'architectureTarget' | 'uiFrameworks' | 'blockingIssues'
  > = {};

  const plannedViteMonorepo = frontend === 'react-vite'
    && state.mode === 'new-project'
    && (
      state.stack === 'default'
      || state.stack === 'react-realtime-monorepo'
      || (state.frontend === 'react-vite' && !BACKEND_NONE.has(backend))
    );
  const webStructural = hasWeb
    ? frontendProfile(
        frontend,
        cwd,
        plannedViteMonorepo ? 'apps/web' : frontendDetection.webRoot,
      )
    : null;
  const nativeStructural = hasNative
    ? nativeProfile(nativeFramework, nativeDetection.root)
    : null;

  let structural: StructuralProfileV1;
  if (webStructural && nativeStructural) {
    surfaces.push('web-ui', 'native-ui');
    skillBuckets.push(
      'web-ui',
      frontendSkillBucket(frontend),
      'native-ui',
      nativeFramework,
    );
    profileExtras = {
      uiFrameworks: { web: frontend, native: nativeFramework },
      ...(selectedTarget ? { architectureTarget: selectedTarget } : {}),
      ...(!selectedTarget
        ? {
            blockingIssues: [{
              code: 'CAPABILITY_HYBRID_UI_TARGET_REQUIRED' as const,
              message: 'Both web-ui and native-ui were detected; set runtime/user-owned architectureTarget to web-ui or native-ui before architecture compilation.',
            }],
          }
        : {}),
    };
    structural = selectedTarget === 'web-ui'
      ? webStructural
      : selectedTarget === 'native-ui'
        ? nativeStructural
        : unsupportedHybridProfile(webStructural, nativeStructural);
  } else if (nativeStructural) {
    structural = nativeStructural;
    surfaces.push('native-ui');
    skillBuckets.push('native-ui', nativeFramework);
  } else if (webStructural) {
    structural = webStructural;
    surfaces.push('web-ui');
    skillBuckets.push('web-ui', frontendSkillBucket(frontend));
    if (nativeFramework === 'ionic-capacitor') skillBuckets.push('ionic-capacitor');
  } else {
    structural = {
      profileId: 'backend-only',
      framework: backend,
      router: 'none',
      sourceRoots: ['src', 'app', 'cmd', 'internal'],
      entrypoints: [],
      layerRoots: { pages: [], components: [], features: ['src', 'app', 'internal'], lib: ['lib', 'pkg'] },
      qaAdapters: [],
    };
  }

  if (backendExposesApi(cwd, backend)) {
    surfaces.push('api');
  }
  if (
    exists(cwd, 'cmd')
    || exists(cwd, 'bin')
    || (backend === 'python' && !surfaces.includes('api') && pythonCliEvidencePresent(cwd))
  ) {
    surfaces.push('cli');
  }
  if (exists(cwd, 'workers') || exists(cwd, 'jobs') || exists(cwd, 'app/Jobs')) surfaces.push('worker');
  if (exists(cwd, 'migrations') || exists(cwd, 'database/migrations') || exists(cwd, 'supabase/migrations')) surfaces.push('data');
  if (!BACKEND_NONE.has(backend)) {
    skillBuckets.push('backend-common');
    if (surfaces.includes('api')) skillBuckets.push('api');
    const languageBucket = backendSkillBucket(backend);
    if (languageBucket) skillBuckets.push(languageBucket);
  }
  if (surfaces.includes('data') || postgresEvidencePresent(cwd, state, backend)) {
    skillBuckets.push('postgres');
  }

  const roles = [
    ...UNIVERSAL_ROLES,
    ...(surfaces.includes('web-ui') || surfaces.includes('native-ui') ? ['senior-frontend'] : []),
    ...(!BACKEND_NONE.has(backend)
      || surfaces.some((surface) => ['api', 'cli', 'worker', 'data'].includes(surface))
      ? ['senior-backend']
      : []),
  ];

  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    ...structural,
    backendFramework: backend,
    surfaces: unique(surfaces),
    roles: unique(roles),
    skillBuckets: unique(skillBuckets),
    ...profileExtras,
  };
}

export function profileHasWebUi(profile: CapabilityProfileV1): boolean {
  return profile.surfaces.includes('web-ui');
}

export function profileHasNativeUi(profile: CapabilityProfileV1): boolean {
  return profile.surfaces.includes('native-ui');
}

export function eligibleRolesForProject(cwd: string, input: unknown): Set<string> {
  return new Set(capabilityProfileForProject(cwd, input).roles);
}

export function eligibleRolesForProfile(profile: CapabilityProfileV1): Set<string> {
  return new Set(profile.roles);
}

/** Pure state-only projection used by materialization before project files exist. */
export function skillBucketsForState(input: unknown): string[] {
  const state = obj(input) || {};
  const frontend = stringField(state, 'frontend', 'none');
  const backend = stringField(state, 'backend', 'none');
  const mobile = stringField(obj(state.mobile), 'framework', 'none');
  const buckets: string[] = [];
  if (!FRONTEND_NONE.has(frontend)) {
    buckets.push('web-ui');
    if (frontend === 'react-vite') buckets.push('react-vite');
    else if (frontend === 'nextjs') buckets.push('nextjs');
    else if (frontend === 'nuxt') buckets.push('nuxt');
    else buckets.push('custom-web');
  }
  if (mobile !== 'none' && mobile !== 'ionic-capacitor') {
    buckets.push('native-ui', mobile);
  } else if (mobile === 'ionic-capacitor') {
    buckets.push('web-ui', 'react-vite', 'ionic-capacitor');
  }
  if (!BACKEND_NONE.has(backend)) {
    buckets.push('backend-common');
    const explicitSurfaces = Array.isArray(state.capabilitySurfaces)
      ? state.capabilitySurfaces
      : Array.isArray(state.surfaces)
        ? state.surfaces
        : [];
    if (
      explicitSurfaces.includes('api')
      || (explicitSurfaces.length === 0 && !['python', 'other'].includes(backend))
    ) buckets.push('api');
    if (backend === 'supabase' || backend === 'our-fork') buckets.push('supabase', 'postgres');
    else if (backend === 'postgres' || backend === 'postgresql') buckets.push('postgres');
    else if (backend === 'nestjs') buckets.push('node');
    else if (backend === 'fastapi') buckets.push('python');
    else if (backend === 'laravel') buckets.push('php');
    else if (backend === 'csharp') buckets.push('dotnet');
    else if (backend !== 'other') buckets.push(backend);
  }
  const surfaces = Array.isArray(state.capabilitySurfaces)
    ? state.capabilitySurfaces
    : Array.isArray(state.surfaces)
      ? state.surfaces
      : [];
  const profileBuckets = Array.isArray(state.capabilitySkillBuckets)
    ? state.capabilitySkillBuckets
    : [];
  if (surfaces.includes('data') || profileBuckets.includes('postgres')) buckets.push('postgres');
  const provider = [
    state.database,
    state.databaseProvider,
    state.database_provider,
    state.db,
    state.dbProvider,
  ].find((value) => typeof value === 'string' && value.trim());
  if (typeof provider === 'string' && /\b(?:postgres|postgresql|supabase)\b/i.test(provider)) {
    buckets.push('postgres');
  }
  return unique(buckets);
}

/** Runtime-derived state view for rule/skill materialization; never persisted. */
export function runtimeCapabilityState(cwd: string, input: unknown): Rec {
  const state = obj(input) || {};
  const profile = capabilityProfileForProject(cwd, state);
  return runtimeCapabilityStateFromProfile(profile, state);
}

export function runtimeCapabilityStateFromProfile(
  profile: CapabilityProfileV1,
  input: unknown,
): Rec {
  const state = obj(input) || {};
  const frontend = profile.surfaces.includes('web-ui')
    ? profile.uiFrameworks?.web
      || (profile.framework === 'laravel' ? 'laravel-ui' : profile.framework)
    : 'none';
  const mobile = obj(state.mobile) || {};
  const nativeFramework = profile.uiFrameworks?.native
    || (profile.surfaces.includes('native-ui') ? profile.framework : stringField(mobile, 'framework', 'none'));
  return {
    ...state,
    frontend,
    backend: profile.backendFramework,
    mobile: {
      ...mobile,
      enabled: profile.surfaces.includes('native-ui') || mobile.framework === 'ionic-capacitor',
      framework: nativeFramework,
    },
    // Ephemeral runtime projection consumed by rule/skill materialization.
    // Persisted state never owns or edits these values.
    capabilityProfileId: profile.profileId,
    capabilitySurfaces: [...profile.surfaces],
    capabilitySkillBuckets: [...profile.skillBuckets],
    ...(profile.architectureTarget ? { capabilityArchitectureTarget: profile.architectureTarget } : {}),
    ...(profile.blockingIssues ? { capabilityBlockingIssues: [...profile.blockingIssues] } : {}),
  };
}
