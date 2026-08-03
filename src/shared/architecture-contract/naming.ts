// src/shared/architecture-contract/naming.ts
// Name/derivation helpers: roots, casing, route segments, extensions, and
// per-profile module output paths.

import * as path from 'path';
import {
  type CapabilityProfileV1,
} from '../capabilities';

import {
  type ArchitectureModuleInputV1,
  type ArchitectureModuleKind,
  type ArchitectureRouteInputV1,
} from './types';
import {
  canonicalRoutePath,
  normalizeRelative,
  baselineContains,
} from './core';

export function chosenRoot(
  candidates: string[],
  fallback: string,
  baselinePaths: ReadonlySet<string>,
): string {
  for (const candidate of candidates) {
    const normalized = normalizeRelative(candidate);
    if (normalized && baselineContains(baselinePaths, normalized)) return normalized;
  }
  return normalizeRelative(candidates[0] || '') || fallback;
}

export function pascal(value: string): string {
  const result = value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
  return result || 'Module';
}

export function kebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'module';
}

export function snake(value: string): string {
  return kebab(value).replace(/-/g, '_');
}

function routeSegments(routePath: string): string[] {
  return routePath
    .split('/')
    .filter(Boolean)
    .map((segment) => segment
      .replace(/^\{(.+)\}$/, '[$1]')
      .replace(/^:(.+)$/, '[$1]'));
}

function extensionFor(profile: CapabilityProfileV1, kind: ArchitectureModuleKind): string {
  if (kind === 'test') return profile.framework === 'laravel' ? '.php' : '.test.ts';
  // `feature` is a UI SECTION, so it takes the framework-native extension for
  // the same reason page/component do: a Vue/Svelte/Astro section cannot live
  // in a `.ts` file. Angular is the exception below — its components ARE `.ts`
  // classes with the template beside or inside them.
  if (profile.profileId === 'nuxt') {
    return ['page', 'component', 'feature'].includes(kind) ? '.vue' : '.ts';
  }
  if (profile.profileId === 'vue') {
    return ['app-shell', 'page', 'component', 'feature'].includes(kind) ? '.vue' : '.ts';
  }
  if (profile.profileId === 'sveltekit' || profile.profileId === 'svelte') {
    return ['app-shell', 'page', 'component', 'feature'].includes(kind) ? '.svelte' : '.ts';
  }
  if (profile.profileId === 'astro') {
    return ['app-shell', 'page', 'component', 'feature'].includes(kind) ? '.astro' : '.ts';
  }
  if (profile.profileId === 'angular') return '.ts';
  if (profile.profileId === 'server-rendered') {
    if (profile.router === 'inertia-vue-router') return kind === 'page' || kind === 'component' ? '.vue' : '.ts';
    if (profile.router.startsWith('inertia-')) {
      return kind === 'page' || kind === 'component' || kind === 'feature' ? '.tsx' : '.ts';
    }
    return kind === 'page' || kind === 'component' ? '.blade.php' : '.php';
  }
  if (profile.profileId === 'swift-native') return '.swift';
  if (profile.profileId === 'kotlin-native') return '.kt';
  if (profile.profileId === 'flutter-native') return '.dart';
  if (profile.profileId === 'backend-only') {
    if (profile.backendFramework === 'go') return '.go';
    if (['python', 'django', 'fastapi'].includes(profile.backendFramework)) return '.py';
    if (['laravel', 'php'].includes(profile.backendFramework)) return '.php';
    if (profile.backendFramework === 'rust') return '.rs';
    if (profile.backendFramework === 'java') return '.java';
    if (profile.backendFramework === 'kotlin') return '.kt';
    if (profile.backendFramework === 'dotnet') return '.cs';
  }
  if (kind === 'service' || kind === 'store') return '.ts';
  return '.tsx';
}

// ── Extension freedom ───────────────────────────────────────────────────────
// The contract pins IDENTITY (base path + directory); the toolchain arbitrates
// FORM. `extensionFor` above still chooses the DEFAULT concrete filename that
// `moduleOutput` emits and every skeleton/simulator writes, but wherever the
// framework does not dictate the filename semantically the implementer may
// deliver any extension in the allowed set — tsc/build judges the choice, not
// a runtime table (observed 12co: a module pinned to a single extension forced
// a `createElement` rewrite in a file where JSX is illegal).
const FREE_EXTENSION_SETS: Record<string, readonly string[]> = {
  '.tsx': ['.tsx', '.ts'],
  '.vue': ['.vue', '.ts'],
  '.svelte': ['.svelte', '.ts'],
  '.astro': ['.astro', '.ts'],
};

// Profiles whose UI language is JSX/TSX: a `.ts` default (service/store/lib)
// may legitimately grow a provider component and need `.tsx`.
function reactFamilyProfile(profile: CapabilityProfileV1): boolean {
  if (['vite-react', 'next-app', 'next-pages', 'react-native', 'generic-web'].includes(profile.profileId)) {
    return true;
  }
  return profile.profileId === 'server-rendered'
    && profile.router.startsWith('inertia-')
    && profile.router !== 'inertia-vue-router';
}

// Pinning stays ONLY where the framework reads the filename itself: file-router
// page/layout files (Next, Nuxt, SvelteKit, Astro, Blade views), Angular
// `.component.ts`, entrypoint-derived app shells, test files, and the Supabase
// edge-function layout.
function moduleExtensionPinned(
  profile: CapabilityProfileV1,
  kind: ArchitectureModuleKind,
): boolean {
  if (kind === 'test' || kind === 'edge-function') return true;
  if (kind === 'app-shell') {
    return ['next-app', 'next-pages', 'nuxt', 'sveltekit', 'astro', 'angular', 'server-rendered']
      .includes(profile.profileId);
  }
  if (kind === 'page') {
    return ['next-app', 'next-pages', 'nuxt', 'sveltekit', 'astro', 'angular'].includes(profile.profileId)
      || (profile.profileId === 'server-rendered' && !profile.router.startsWith('inertia-'));
  }
  if (kind === 'component') return profile.profileId === 'angular';
  return false;
}

const COMPOUND_OUTPUT_EXTENSIONS = ['.blade.php', '.test.ts'] as const;

function outputExtension(output: string): string {
  for (const ext of COMPOUND_OUTPUT_EXTENSIONS) {
    if (output.endsWith(ext)) return ext;
  }
  return path.posix.extname(output);
}

export interface ResolvedModuleOutput {
  /** DEFAULT concrete path — what run-sim/skeletons emit and `module.output` keeps holding. */
  output: string;
  /** `output` minus its default extension. */
  outputBase: string;
  /** Extensions deliverable at `outputBase`; the first is the default. */
  allowedExtensions: string[];
}

export function resolveModuleOutput(
  projectRoot: string,
  profile: CapabilityProfileV1,
  module: ArchitectureModuleInputV1,
  route: ArchitectureRouteInputV1 | undefined,
  baselinePaths: ReadonlySet<string>,
  isNewProject = false,
): ResolvedModuleOutput {
  const output = moduleOutput(projectRoot, profile, module, route, baselinePaths, isNewProject);
  const ext = outputExtension(output);
  const outputBase = ext ? output.slice(0, -ext.length) : output;
  if (!ext) return { output, outputBase, allowedExtensions: [] };
  if (moduleExtensionPinned(profile, module.kind)) {
    return { output, outputBase, allowedExtensions: [ext] };
  }
  const free = ext === '.ts' && reactFamilyProfile(profile)
    ? ['.ts', '.tsx']
    : FREE_EXTENSION_SETS[ext];
  return { output, outputBase, allowedExtensions: [...(free || [ext])] };
}

/**
 * Every concrete path a compiled module may legally be delivered at, default
 * first. Pre-extension-freedom sidecars carry no `outputBase`/
 * `allowedExtensions` and keep their exact single-path behavior — the fields
 * are additive, so a mid-run plugin upgrade cannot invalidate persisted
 * assignments built from an older compiled contract.
 */
export function moduleOutputVariants(module: {
  output: string;
  outputBase?: string;
  allowedExtensions?: string[];
}): string[] {
  if (!module.outputBase
    || !Array.isArray(module.allowedExtensions)
    || module.allowedExtensions.length === 0) {
    return [module.output];
  }
  const variants = module.allowedExtensions.map((ext) => `${module.outputBase}${ext}`);
  return variants.includes(module.output) ? variants : [module.output, ...variants];
}

function sharedUiExtension(profile: CapabilityProfileV1): string {
  if (profile.uiSystem?.adapter === 'shadcn-vue') return '.vue';
  if (profile.uiSystem?.adapter === 'shadcn-svelte') return '.svelte';
  if (profile.profileId === 'nuxt' || profile.profileId === 'vue' || profile.router === 'inertia-vue-router') return '.vue';
  if (profile.profileId === 'sveltekit' || profile.profileId === 'svelte') return '.svelte';
  if (profile.profileId === 'astro') return '.astro';
  if (profile.profileId === 'angular') return '.ts';
  if (profile.profileId === 'server-rendered' && !profile.router.startsWith('inertia-')) return '.blade.php';
  return '.tsx';
}

function backendSourceRoot(
  profile: CapabilityProfileV1,
  baselinePaths: ReadonlySet<string>,
): string {
  if (profile.backendFramework === 'go') {
    return chosenRoot(['internal', 'cmd', 'pkg', ...profile.sourceRoots], 'internal', baselinePaths);
  }
  if (['laravel', 'php'].includes(profile.backendFramework)) {
    return chosenRoot(['app', ...profile.sourceRoots], 'app', baselinePaths);
  }
  if (['python', 'django', 'fastapi'].includes(profile.backendFramework)) {
    return chosenRoot(['src', 'app', ...profile.sourceRoots], 'src', baselinePaths);
  }
  return chosenRoot(profile.sourceRoots, 'src', baselinePaths);
}

// Which wiring-convention family a backend-only profile belongs to. Single
// dispatch point shared by the module-home rules here and the wiring grants in
// scaffold.ts, so compiled homes and tree grants can never drift apart — the
// invariant that keeps a feature home's directory grant (index.ts turns a
// feature's dirname into a tree include) inside a tree the wiring already
// grants, instead of silently widening the closed allowlist.
//
// EVIDENCE-FIRST: on an existing repo a family resolves only when the baseline
// proves its layout. Declared-but-unproven stacks (a Laravel app nested under
// apps/api/, a src/<Project>/ .NET solution, a cargo workspace with a virtual
// manifest, a python package that is neither src/ nor app/) get NO wiring and
// keep their bounded per-module stems: writes then hard-deny into a recoverable
// BLOCKED replan rather than opening a phantom root tree the toolchain never
// reads. A missing grant is recoverable; an over-grant is not.
//
// null = no framework conventions compiled: node/ts keeps the features-root
// stems (`dir/index.ts` IS the Node convention), go stays out until
// assignments can carve colocated `*_test.go` tester files out of a
// source-tree grant, supabase models its wiring with deterministic names in
// backendScaffoldOutputs, and external-api has no server tree at all.
export type BackendWiringFamily = 'laravel' | 'jvm' | 'dotnet' | 'rust' | 'django' | 'python';

export function backendWiringFamily(
  profile: CapabilityProfileV1,
  baselinePaths: ReadonlySet<string>,
  isNewProject: boolean,
): BackendWiringFamily | null {
  if (profile.profileId !== 'backend-only') return null;
  const framework = profile.backendFramework;
  const evidenced = (...markers: string[]): boolean => (
    isNewProject || markers.some((marker) => baselineContains(baselinePaths, marker))
  );
  // A generic `php` declaration becomes Laravel only on repo evidence: a
  // Symfony/Slim repo must keep its bounded per-module stems instead of
  // inheriting stack-false Laravel grants.
  if (framework === 'laravel'
    || (framework === 'php'
      && (baselinePaths.has('artisan') || baselinePaths.has('bootstrap/app.php')))) {
    return evidenced('artisan', 'app', 'bootstrap/app.php') ? 'laravel' : null;
  }
  if (framework === 'java' || framework === 'kotlin') {
    return evidenced('src/main/java', 'src/main/kotlin') ? 'jvm' : null;
  }
  // The flat single-project layout is the only shape these root-relative
  // grants fit; a src/<Project>/ solution must stay unwired. `appsettings.json`
  // is NOT evidence of it — solutions routinely keep one at the repo root for
  // docker/compose while the project lives under src/ — but any genuinely flat
  // project has a root Program.cs beside it.
  if (framework === 'dotnet') return evidenced('Program.cs', 'Controllers') ? 'dotnet' : null;
  // cargo requires a crate src/; a workspace virtual manifest has none.
  if (framework === 'rust') return evidenced('src') ? 'rust' : null;
  if (['python', 'django', 'fastapi'].includes(framework)) {
    // Django is a repo shape, not a declared string: filesystem detection only
    // ever reports `python`, so the manage.py marker is the authority on an
    // existing repo and the declaration only decides new ones.
    if (isNewProject) return framework === 'django' ? 'django' : 'python';
    // manage.py alone is not enough: the django grants are all relative to a
    // top-level project package, so a src-layout Django repo (manage.py at the
    // root, everything else under src/) would resolve the family and compile an
    // EMPTY wiring layer. It is better served as a plain package root.
    if (baselinePaths.has('manage.py') && djangoLayout(baselinePaths).settingsPkg) return 'django';
    return pythonPackageRoot(baselinePaths, isNewProject) ? 'python' : null;
  }
  return null;
}

// The python package root, evidenced only: never the `src` fallback
// backendSourceRoot would invent, because a phantom root becomes a whole-tree
// grant through the feature-dirname rule.
export function pythonPackageRoot(
  baselinePaths: ReadonlySet<string>,
  isNewProject: boolean,
): string | null {
  if (isNewProject) return 'app';
  return ['src', 'app'].find((root) => baselineContains(baselinePaths, root)) || null;
}

// Maven/Gradle source tree. Detection reports `java` for Gradle Kotlin repos
// (there is no filesystem probe for Kotlin), so the tree — and with it the
// extension — follows the baseline, not the framework id.
export function jvmSourceTree(
  profile: CapabilityProfileV1,
  baselinePaths: ReadonlySet<string>,
): { root: string; ext: string } {
  const preferred = profile.backendFramework === 'kotlin' ? 'src/main/kotlin' : 'src/main/java';
  const candidates = preferred === 'src/main/kotlin'
    ? ['src/main/kotlin', 'src/main/java']
    : ['src/main/java', 'src/main/kotlin'];
  const root = chosenRoot(candidates, preferred, baselinePaths);
  return { root, ext: root.endsWith('/kotlin') ? '.kt' : '.java' };
}

// The repo's base package directory under a JVM source tree, as the deepest
// directory every existing source file shares. Compiling into the UNNAMED
// package instead would be unbuildable in practice: JLS 7.5 makes a named
// package unable to import an unnamed-package type at all, so a class dropped
// at the tree root can never be wired into an existing `com.acme.api`
// codebase, and Spring's component scan skips the default package outright.
export function jvmBasePackageDir(root: string, baselinePaths: ReadonlySet<string>): string {
  const prefix = `${root}/`;
  const sourceDirs = [...baselinePaths]
    .filter((entry) => entry.startsWith(prefix) && /\.(java|kt)$/.test(entry))
    .map((entry) => path.posix.dirname(entry.slice(prefix.length)))
    .filter((dir) => dir !== '.');
  if (sourceDirs.length === 0) return 'app';
  const common = sourceDirs.reduce((shared, candidate) => {
    const a = shared.split('/');
    const b = candidate.split('/');
    const out: string[] = [];
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) break;
      out.push(a[i]!);
    }
    return out.join('/');
  });
  return common || 'app';
}

// The Django project layout, read from the baseline: the settings package
// (flat `settings.py` or the split `settings/` package cookiecutter-django
// uses) and the app directories makemigrations writes into.
export function djangoLayout(baselinePaths: ReadonlySet<string>): {
  settingsPkg: string | null;
  splitSettings: boolean;
  appDirs: string[];
} {
  const entries = [...baselinePaths];
  // Reserved dirs are filtered here for the same reason they are filtered out
  // of appDirs below: pytest-django's conventional `tests/settings.py` would
  // otherwise win the scan (baselines arrive sorted, so `tests` beats a
  // project package named `web`/`webapp`/`zproject`) and hand senior-backend
  // five files inside the tester's home while the real settings package went
  // ungranted.
  const settingsPkg = entries
    .map((entry) => /^([^/]+)\/settings(?:\.py|\/(?:__init__|base)\.py)$/.exec(entry)?.[1])
    .find((candidate): candidate is string => (
      Boolean(candidate) && !DJANGO_RESERVED_APP_DIRS.includes(candidate!)
    )) || null;
  const splitSettings = Boolean(settingsPkg)
    && baselineContains(baselinePaths, `${settingsPkg}/settings`);
  const appDirs = [...new Set(entries
    .map((entry) => /^([^/]+)\/(?:apps|models)\.py$/.exec(entry)?.[1])
    .filter((candidate): candidate is string => Boolean(candidate)))]
    .filter((dir) => dir !== settingsPkg && !DJANGO_RESERVED_APP_DIRS.includes(dir))
    .sort();
  return { settingsPkg, splitSettings, appDirs };
}

// A Django feature compiles to a repo-root app package, so its name becomes a
// directory grant. These directories belong to another role (the tester's
// compiled tests/ home) — claiming one would hand two roles concurrent write
// access to the same files, the collision the closed-allowlist design exists
// to prevent.
const DJANGO_RESERVED_APP_DIRS = ['tests', 'test'];

// django-admin's own tutorial names the project package after the project;
// `config` is the dominant convention in real repos (and cookiecutter-django's
// default), so a new project compiles a settings home the architect can wire.
export const DJANGO_NEW_PROJECT_PKG = 'config';

export function moduleOutput(
  projectRoot: string,
  profile: CapabilityProfileV1,
  module: ArchitectureModuleInputV1,
  route: ArchitectureRouteInputV1 | undefined,
  baselinePaths: ReadonlySet<string>,
  isNewProject = false,
): string {
  const sourceRoot = profile.profileId === 'backend-only'
    ? backendSourceRoot(profile, baselinePaths)
    : chosenRoot(profile.sourceRoots, 'src', baselinePaths);
  const pagesRoot = chosenRoot(profile.layerRoots.pages, `${sourceRoot}/pages`, baselinePaths);
  const componentsRoot = chosenRoot(profile.layerRoots.components, `${sourceRoot}/components`, baselinePaths);
  const featuresRoot = chosenRoot(profile.layerRoots.features, `${sourceRoot}/features`, baselinePaths);
  const libRoot = chosenRoot(profile.layerRoots.lib, `${sourceRoot}/lib`, baselinePaths);
  const name = pascal(module.name);
  const ext = extensionFor(profile, module.kind);

  if (module.kind === 'app-shell') {
    if (profile.profileId === 'next-app') return `${sourceRoot}/layout.tsx`;
    if (profile.profileId === 'next-pages') {
      return chosenRoot(profile.entrypoints, profile.entrypoints[0] || `${sourceRoot}/_app.tsx`, baselinePaths);
    }
    if (profile.profileId === 'nuxt') {
      return chosenRoot(profile.entrypoints, profile.entrypoints[0] || 'app.vue', baselinePaths);
    }
    if (profile.profileId === 'sveltekit') return `${pagesRoot}/+layout.svelte`;
    if (profile.profileId === 'astro') return `${sourceRoot}/layouts/Layout.astro`;
    if (profile.profileId === 'angular') return `${sourceRoot}/app.component.ts`;
    if (profile.profileId === 'server-rendered') {
      if (profile.router.startsWith('inertia-')) {
        return chosenRoot(profile.entrypoints, profile.entrypoints[0] || 'resources/js/app.ts', baselinePaths);
      }
      return `${sourceRoot}/layouts/app.blade.php`;
    }
    return `${sourceRoot}/App${ext}`;
  }
  if (module.kind === 'page') {
    // The catch-all has no path segments to derive a file-router location from
    // (`pages/*/page.tsx` is not a legal filename), so it falls back to the
    // module name exactly like a page with no route at all.
    const catchAll = route ? canonicalRoutePath(route.path) === '*' : false;
    const segments = route && !catchAll ? routeSegments(route.path) : [kebab(module.name)];
    if (profile.profileId === 'next-app') {
      return `${pagesRoot}/${segments.join('/')}${segments.length ? '/' : ''}page.tsx`
        .replace(/\/+/g, '/');
    }
    if (profile.profileId === 'next-pages') {
      return `${pagesRoot}/${segments.length ? segments.join('/') : 'index'}.tsx`;
    }
    if (profile.profileId === 'nuxt') {
      return `${pagesRoot}/${segments.length ? segments.join('/') : 'index'}.vue`;
    }
    if (profile.profileId === 'sveltekit') {
      return `${pagesRoot}/${segments.length ? `${segments.join('/')}/` : ''}+page.svelte`;
    }
    if (profile.profileId === 'astro') {
      return `${pagesRoot}/${segments.length ? segments.join('/') : 'index'}.astro`;
    }
    if (profile.profileId === 'angular') {
      const pageName = kebab(module.name);
      return `${pagesRoot}/${pageName}/${pageName}.component.ts`;
    }
    if (profile.profileId === 'server-rendered' && pagesRoot.includes('/views')) {
      return `${pagesRoot}/${segments.length ? segments.join('/') : 'home'}.blade.php`;
    }
    return `${pagesRoot}/${name}${ext}`;
  }
  if (module.kind === 'component') {
    if (module.placement === 'shared-ui') {
      const sharedRoot = profile.uiSystem?.sharedRoot;
      if (!sharedRoot) {
        throw new Error(`component module ${module.id} requests shared-ui but profile ${profile.profileId} has no shared UI root`);
      }
      return `${sharedRoot}/src/components/${name}${sharedUiExtension(profile)}`;
    }
    if (profile.profileId === 'angular') {
      const componentName = kebab(module.name);
      return `${componentsRoot}/${componentName}/${componentName}.component.ts`;
    }
    return `${componentsRoot}/${name}${ext}`;
  }
  if (module.kind === 'feature') {
    // Backend frameworks are not JS: `src/<id>/index.<ext>` stems are junk
    // their toolchains never read (observed test-laravel: five feature modules
    // compiled to `src/*` while the real homes — app/Http/**, config/,
    // routes/ — had no owner; a Java `index.java` cannot even hold a public
    // class, and kebab directories are illegal Rust/Python module names).
    // Each family gets its neutral conventional default INSIDE a tree the
    // wiring already grants, so the feature-dirname rule cannot widen the
    // allowlist past the wiring layer.
    const family = backendWiringFamily(profile, baselinePaths, isNewProject);
    // `app/` is the granted tree, and an artisan-evidenced repo always has it.
    if (family === 'laravel') return `app/${name}${ext}`;
    if (family === 'rust') return `${sourceRoot}/${snake(module.name)}${ext}`;
    if (family === 'python') {
      const pkgRoot = pythonPackageRoot(baselinePaths, isNewProject);
      if (pkgRoot) return `${pkgRoot}/${snake(module.name)}${ext}`;
    }
    // A Django feature IS an app: a new snake_case package at the repo root
    // (startapp's shape). The feature-dirname assignment rule then grants the
    // app's whole tree (models.py, views.py, migrations/) with no wildcard —
    // which is why the name may not claim another owner's directory.
    if (family === 'django') {
      const appDir = snake(module.name);
      const layout = djangoLayout(baselinePaths);
      const projectPkg = layout.settingsPkg || (isNewProject ? DJANGO_NEW_PROJECT_PKG : null);
      // A Django app package is the ONE feature home that is a repo-root
      // directory named after the module, so its name alone decides what the
      // dirname rule grants. It may claim a NEW directory or an existing app,
      // never another owner's tree: `media/`, `docs/`, `static/`, `src/` are
      // real directories full of content no compiled output names.
      const claimsForeignDir = baselineContains(baselinePaths, appDir)
        && !layout.appDirs.includes(appDir);
      if (DJANGO_RESERVED_APP_DIRS.includes(appDir) || appDir === projectPkg || claimsForeignDir) {
        throw new Error(`django feature module ${module.id} would claim the reserved directory ${appDir}/; rename the module`);
      }
      return `${appDir}/__init__.py`;
    }
    if (family === 'jvm') {
      const tree = jvmSourceTree(profile, baselinePaths);
      return `${tree.root}/${jvmBasePackageDir(tree.root, baselinePaths)}/${name}${tree.ext}`;
    }
    // Vertical-slice folder inside the granted `Features/` tree. Deliberately
    // NOT `src/<Pascal>/`: on a solution-layout repo that dirname grant would
    // swallow the project's own `.csproj`, the manifest the existing-mode pin
    // keeps off the re-plan surface.
    if (family === 'dotnet') return `Features/${name}${ext}`;
    return `${featuresRoot}/${kebab(module.name)}/index${ext}`;
  }
  if (module.kind === 'test') {
    const family = backendWiringFamily(profile, baselinePaths, isNewProject);
    if (family === 'python' || family === 'django') return `tests/test_${snake(module.name)}.py`;
    if (family === 'rust') return `tests/${snake(module.name)}.rs`;
    if (family === 'jvm') {
      const tree = jvmSourceTree(profile, baselinePaths);
      const testRoot = tree.root.replace('/main/', '/test/');
      return `${testRoot}/${jvmBasePackageDir(tree.root, baselinePaths)}/${pascal(module.name)}Test${tree.ext}`;
    }
    return `tests/${kebab(module.name)}${ext}`;
  }
  // Edge functions have ONE legal layout: the Supabase CLI deploys
  // `supabase/functions/<name>/index.ts` by directory name. The file is Deno,
  // not the app's TypeScript project, so it deliberately lands outside every
  // source root — nothing here may pull it into the app tsconfig/lint/format
  // surface, and app code reaches it through `functions.invoke`, never import.
  if (module.kind === 'edge-function') return `supabase/functions/${kebab(module.name)}/index.ts`;
  if (
    profile.profileId !== 'backend-only'
    && (module.kind === 'service' || module.kind === 'store')
    && profile.roles.includes('senior-backend')
  ) {
    if (['supabase', 'our-fork'].includes(profile.backendFramework)) {
      return `packages/api-client/src/${name}.ts`;
    }
    if (profile.backendFramework === 'go') return `internal/${snake(module.name)}.go`;
    if (['python', 'django', 'fastapi'].includes(profile.backendFramework)) {
      return `services/api/${snake(module.name)}.py`;
    }
    if (['laravel', 'php'].includes(profile.backendFramework)) {
      const workspaceRoot = profile.sourceRoots
        .map((candidate) => /^(apps\/[^/]+)\//.exec(candidate)?.[1])
        .find((candidate): candidate is string => Boolean(candidate));
      return `${workspaceRoot ? `${workspaceRoot}/` : ''}app/Services/${name}.php`;
    }
    return `services/api/src/${name}.ts`;
  }
  if (profile.profileId === 'backend-only') {
    if (profile.backendFramework === 'go') return `${sourceRoot}/${snake(module.name)}${ext}`;
    if (['python', 'django', 'fastapi'].includes(profile.backendFramework)) {
      // Services must share the package root the feature homes and the wiring
      // grant agree on, or a run scaffolds `app/` while compiling its services
      // into a `src/` that no grant covers and nothing imports. Only the
      // unevidenced case keeps backendSourceRoot's bounded fallback.
      const pkgRoot = pythonPackageRoot(baselinePaths, isNewProject);
      return `${pkgRoot || sourceRoot}/${snake(module.name)}${ext}`;
    }
    if (['laravel', 'php'].includes(profile.backendFramework)) {
      return `${sourceRoot}/Services/${name}${ext}`;
    }
    // Same junk-stem argument as the feature homes: `lib/<Pascal>.rs` sits
    // outside the cargo build graph and `lib/<Pascal>.java` outside every
    // Maven/Gradle tree.
    const family = backendWiringFamily(profile, baselinePaths, isNewProject);
    if (family === 'rust') return `${sourceRoot}/${snake(module.name)}${ext}`;
    if (family === 'jvm') {
      const tree = jvmSourceTree(profile, baselinePaths);
      return `${tree.root}/${jvmBasePackageDir(tree.root, baselinePaths)}/${name}${tree.ext}`;
    }
    if (family === 'dotnet') return `Services/${name}${ext}`;
  }
  return `${libRoot}/${name}${ext}`;
}

// Exported for the emit-config completion gate: it must target ONLY the web
// app package's own tsconfig/scripts (never packages/* or the workspace base,
// where `composite`/`tsc -b` are legitimate).
