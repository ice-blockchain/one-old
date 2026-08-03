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
): ResolvedModuleOutput {
  const output = moduleOutput(projectRoot, profile, module, route, baselinePaths);
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
    const workspaceRoot = profile.sourceRoots
      .map((candidate) => /^(apps\/[^/]+)\//.exec(candidate)?.[1])
      .find((candidate): candidate is string => Boolean(candidate));
    const appRoot = workspaceRoot ? `${workspaceRoot}/app` : 'app';
    return chosenRoot([appRoot, ...profile.sourceRoots], appRoot, baselinePaths);
  }
  if (['python', 'django', 'fastapi'].includes(profile.backendFramework)) {
    return chosenRoot(['src', 'app', ...profile.sourceRoots], 'src', baselinePaths);
  }
  return chosenRoot(profile.sourceRoots, 'src', baselinePaths);
}

export function moduleOutput(
  projectRoot: string,
  profile: CapabilityProfileV1,
  module: ArchitectureModuleInputV1,
  route: ArchitectureRouteInputV1 | undefined,
  baselinePaths: ReadonlySet<string>,
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
  if (module.kind === 'feature') return `${featuresRoot}/${kebab(module.name)}/index${ext}`;
  if (module.kind === 'test') return `tests/${kebab(module.name)}${ext}`;
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
      return `${sourceRoot}/${snake(module.name)}${ext}`;
    }
    if (['laravel', 'php'].includes(profile.backendFramework)) {
      return `${sourceRoot}/Services/${name}${ext}`;
    }
  }
  return `${libRoot}/${name}${ext}`;
}

// Exported for the emit-config completion gate: it must target ONLY the web
// app package's own tsconfig/scripts (never packages/* or the workspace base,
// where `composite`/`tsc -b` are legitimate).
