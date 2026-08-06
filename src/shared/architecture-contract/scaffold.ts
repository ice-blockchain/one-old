// src/shared/architecture-contract/scaffold.ts
// The per-profile scaffold tables: repository/environment/node tooling,
// frontend, native, and backend outputs with their owner roles.

import * as path from 'path';
import {
  type CapabilityProfileV1,
} from '../capabilities';

import {
  type CompiledArchitectureModuleV1,
  type CompiledArchitectureOutputV1,
} from './types';
import {
  normalizeRelative,
} from './core';
import {
  chosenRoot,
} from './naming';

/**
 * Does THIS RUN plan UI work, as opposed to merely running in a project that
 * has a UI? These are the kinds whose compiled outputs are markup; a plan
 * holding none of them writes no page, shell or component, so it needs no
 * browser evidence and no scope over the files that produce it.
 *
 * A web-surface PROFILE cannot answer this: it describes the project, and a
 * service-only plan in a web project is the common maintenance shape.
 */
export function plansWebUiWork(modules: readonly CompiledArchitectureModuleV1[]): boolean {
  return modules.some((module) => (
    module.kind === 'app-shell'
    || module.kind === 'page'
    || module.kind === 'component'
    || module.kind === 'feature'
  ));
}

export function webPackageRoot(profile: CapabilityProfileV1): string {
  const candidates = [
    ...profile.sourceRoots,
    ...profile.entrypoints,
    ...profile.layerRoots.pages,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeRelative(candidate);
    if (!normalized) continue;
    const workspace = /^((?:apps|packages)\/[^/]+|web|frontend|client)(?:\/|$)/.exec(normalized)?.[1];
    if (workspace) return workspace;
  }
  return '.';
}

export function workspaceScaffoldOutputs(webRoot: string): CompiledArchitectureOutputV1[] {
  if (!/^(?:apps|packages)\//.test(webRoot)) return [];
  return [
    'package.json',
    'pnpm-workspace.yaml',
    'turbo.json',
    'tsconfig.base.json',
  ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const }));
}

export const REPOSITORY_SCAFFOLD_OUTPUTS = [
  '.gitignore',
  'README.md',
  '.editorconfig',
  '.github/workflows/ci.yml',
] as const;

// The project's own quality toolchain, compiled per stack and seeded with
// canonical content at PLAN_READY (see scaffold-content.ts). These replace
// hand-rolled structural heuristics: prettier makes collapsed source impossible
// rather than detectable, and eslint owns module size and layer boundaries with a
// config the project owner can read and edit — which a hook heuristic never was.
// CI enforces them after the run ends, which no gate of ours can.
const NODE_TOOLING_OUTPUTS = [
  '.prettierrc',
  '.prettierignore',
  '.nvmrc',
  'eslint.config.js',
  // CSS through the community parser (13co: a 424-char single-line `@theme`
  // block was invisible to every lexical gate). Seeded with
  // stylelint-config-standard plus the Tailwind at-rule carve-outs.
  '.stylelintrc.json',
] as const;

const BACKEND_QUALITY_OUTPUT_BY_FRAMEWORK: Record<string, readonly string[]> = {
  python: ['ruff.toml'],
  go: ['.golangci.yml'],
  laravel: ['pint.json'],
  php: ['pint.json'],
  rust: ['rustfmt.toml'],
};

/**
 * Formatter/linter config for backends whose toolchain is not npm-based. Owned by
 * `senior-backend` so the role that writes the code also owns the bar it is held
 * to.
 */
export function backendQualityOutputs(
  profile: CapabilityProfileV1,
): CompiledArchitectureOutputV1[] {
  if (!profile.roles.includes('senior-backend')) return [];
  const outputs = BACKEND_QUALITY_OUTPUT_BY_FRAMEWORK[profile.backendFramework || ''] || [];
  const appRoot = profile.profileId === 'server-rendered' ? webPackageRoot(profile) : '.';
  return outputs.map((output) => ({
    path: appRoot === '.' ? output : `${appRoot}/${output}`,
    ownerRole: 'senior-backend',
    kind: 'scaffold' as const,
  }));
}

export function selectedImplementationOwner(profile: CapabilityProfileV1): string | null {
  const selectedUi = profile.surfaces.includes('web-ui') || profile.surfaces.includes('native-ui');
  if (selectedUi && profile.roles.includes('senior-frontend')) return 'senior-frontend';
  if (profile.roles.includes('senior-backend')) return 'senior-backend';
  return null;
}

export function selectedTargetHasWebUi(profile: CapabilityProfileV1): boolean {
  return profile.surfaces.includes('web-ui') && profile.architectureTarget !== 'native-ui';
}

export function repositoryScaffoldOutputs(profile: CapabilityProfileV1): CompiledArchitectureOutputV1[] {
  const ownerRole = selectedImplementationOwner(profile);
  if (!ownerRole) return [];
  return REPOSITORY_SCAFFOLD_OUTPUTS.map((output) => ({
    path: output,
    ownerRole,
    kind: 'scaffold',
  }));
}

export function environmentScaffoldOutputs(profile: CapabilityProfileV1): CompiledArchitectureOutputV1[] {
  const ownerRole = profile.roles.includes('senior-backend')
    ? 'senior-backend'
    : (
        selectedTargetHasWebUi(profile)
        && profile.backendFramework === 'external-api'
        && profile.roles.includes('senior-frontend')
          ? 'senior-frontend'
          : null
      );
  const appRoot = profile.profileId === 'server-rendered' ? webPackageRoot(profile) : '.';
  return ownerRole
    ? [{ path: appRoot === '.' ? '.env.example' : `${appRoot}/.env.example`, ownerRole, kind: 'scaffold' }]
    : [];
}

function selectedNodePackageManifest(
  profile: CapabilityProfileV1,
  outputs: readonly CompiledArchitectureOutputV1[],
  immutablePaths: ReadonlySet<string>,
): CompiledArchitectureOutputV1 | null {
  const manifests = outputs.filter((output) => (
    output.path === 'package.json' || output.path.endsWith('/package.json')
  ));
  if (manifests.length === 0) return null;
  const rootManifest = manifests.find((output) => output.path === 'package.json');

  let selectedManifest: CompiledArchitectureOutputV1 | undefined = rootManifest;
  if (!selectedManifest && selectedTargetHasWebUi(profile)) {
    const webRoot = webPackageRoot(profile);
    const webManifest = webRoot === '.' ? 'package.json' : `${webRoot}/package.json`;
    selectedManifest = manifests.find((output) => output.path === webManifest);
  }

  selectedManifest ||= manifests
    .slice()
    .sort((a, b) => {
      const depth = a.path.split('/').length - b.path.split('/').length;
      return depth || a.path.localeCompare(b.path);
    })[0];
  if (!selectedManifest) return null;

  // A detected root manifest is the repository tooling authority even when the
  // selected application package lives below it. Keep the same deterministic
  // owner as the selected Node manifest so config, scripts, and dependency
  // changes cannot split across roles.
  if (immutablePaths.has('package.json') && selectedManifest.path !== 'package.json') {
    return {
      path: 'package.json',
      ownerRole: selectedManifest.ownerRole,
      kind: 'scaffold',
    };
  }
  return selectedManifest;
}

export function nodeToolingScaffoldOutputs(
  profile: CapabilityProfileV1,
  outputs: readonly CompiledArchitectureOutputV1[],
  immutablePaths: ReadonlySet<string>,
): CompiledArchitectureOutputV1[] {
  const manifest = selectedNodePackageManifest(profile, outputs, immutablePaths);
  if (!manifest) return [];
  const packageRoot = path.posix.dirname(manifest.path);
  return [
    ...(!outputs.some((output) => output.path === manifest.path) ? [manifest] : []),
    ...NODE_TOOLING_OUTPUTS.map((output) => ({
      path: packageRoot === '.' ? output : `${packageRoot}/${output}`,
      ownerRole: manifest.ownerRole,
      kind: 'scaffold' as const,
    })),
  ];
}

export function appendUniqueScaffoldOutputs(
  outputs: CompiledArchitectureOutputV1[],
  additions: readonly CompiledArchitectureOutputV1[],
): void {
  for (const addition of additions) {
    if (!outputs.some((output) => output.path === addition.path)) outputs.push(addition);
  }
}

export function resolveInitialScaffoldOwners(
  profile: CapabilityProfileV1,
  outputs: readonly CompiledArchitectureOutputV1[],
): CompiledArchitectureOutputV1[] {
  const resolved = new Map<string, CompiledArchitectureOutputV1>();
  for (const output of outputs) {
    const existing = resolved.get(output.path);
    if (!existing) {
      resolved.set(output.path, output);
      continue;
    }
    if (existing.ownerRole === output.ownerRole) continue;

    // React Native and a root Node API can legitimately share package.json.
    // The selected implementation owner is the single integration owner and
    // must merge both surfaces' dependency/script requirements. Every other
    // cross-role collision remains a compiler error instead of being silently
    // discarded by path de-duplication.
    const integrationOwner = selectedImplementationOwner(profile);
    const implementationOwners = new Set([existing.ownerRole, output.ownerRole]);
    if (
      output.path === 'package.json'
      && integrationOwner
      && implementationOwners.has(integrationOwner)
      && [...implementationOwners].every((owner) => (
        owner === 'senior-frontend' || owner === 'senior-backend'
      ))
    ) {
      resolved.set(output.path, { ...existing, ownerRole: integrationOwner });
      continue;
    }
    throw new Error(
      `compiled scaffold output ${output.path} has conflicting owners `
      + `${existing.ownerRole} and ${output.ownerRole}`,
    );
  }
  return [...resolved.values()];
}

// Public crawl/share assets `rules/common/seo.md` REQUIRES for every public
// web surface. Nothing compiled them, so every web build blocked at the same
// wall: the frontend digested BLOCKED and forced an architect replan just to
// widen the allowlist (observed 4cu — two of its four replans were exactly
// robots/sitemap/manifest/icons/OG). Deterministic names, no globs, same as
// every other scaffold output.
//
// `llms.txt` is here for exactly the same reason, one campaign later: the
// reviewer's documentation baseline REQUIRES a served `/llms.txt` for every web
// surface, `auto-documentation-generator` names `public/llms.txt` as its home,
// and nothing compiled it. Observed 12co — reviewer finding 5 ordered the
// frontend to create `apps/web/public/llms.txt`, the write was hard-denied with
// STRUCT_ASSIGNMENT_ALLOWLIST_GAP (an `apps/*/public/**` path is a build
// artifact, so the run-team gate judges it), whose only remedy is a replan the
// fix cycle cannot perform — so the reviewer could never reach `APPROVED`.
const PUBLIC_CRAWL_ASSETS = [
  'public/robots.txt',
  'public/sitemap.xml',
  'public/manifest.webmanifest',
  'public/favicon.ico',
  'public/favicon.svg',
  'public/apple-touch-icon.png',
  'public/icons/icon-192.png',
  'public/icons/icon-512.png',
  'public/og-image.png',
  'public/llms.txt',
] as const;

export function frontendScaffoldOutputs(profile: CapabilityProfileV1): CompiledArchitectureOutputV1[] {
  if (!profile.surfaces.includes('web-ui') || profile.architectureTarget === 'native-ui') return [];
  const webRoot = webPackageRoot(profile);
  const at = (rel: string): string => webRoot === '.' ? rel : `${webRoot}/${rel}`;
  const common = workspaceScaffoldOutputs(webRoot);
  const sharedUi = sharedUiScaffoldOutputs(profile);
  if (profile.profileId === 'vite-react') {
    return [
      ...common,
      ...sharedUi,
      ...[
        at('package.json'),
        at('index.html'),
        at('vite.config.ts'),
        at('tsconfig.json'),
        at('src/vite-env.d.ts'),
        ...PUBLIC_CRAWL_ASSETS.map(at),
        'packages/i18n/package.json',
        'packages/i18n/src/index.ts',
      ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const })),
    ];
  }
  if (profile.profileId === 'next-app' || profile.profileId === 'next-pages') {
    // Styling and i18n need compiled homes here just like vite-react's
    // packages/{tailwind-config,i18n} — without them the always-loaded
    // ui-quality/typography/i18n rules demand tokens and translation keys the
    // frontend has nowhere to write (observed 5cl-claude: 240 lines of global
    // CSS inlined into a `<style>` tag in app/layout.tsx, zero i18n, every
    // string hardcoded). `globals.css` sits in the compiled app/pages root;
    // i18n runtime/catalog outputs are compiled from semantic ArchitectureInputV1;
    // `next-env.d.ts` is (re)generated by every
    // `next build`, so it must be an authorized output or the first build
    // invalidates the frozen verification diff.
    const styleRoot = profile.profileId === 'next-app'
      ? chosenRoot(profile.layerRoots.pages, at('app'), new Set<string>())
      : at('styles');
    return [
      ...common,
      ...sharedUi,
      ...[
        at('package.json'),
        at('next.config.ts'),
        at('tsconfig.json'),
        at('postcss.config.mjs'),
        at('next-env.d.ts'),
        `${styleRoot}/globals.css`,
        ...PUBLIC_CRAWL_ASSETS.map(at),
      ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const })),
    ];
  }
  if (profile.profileId === 'nuxt') {
    return [
      ...common,
      ...sharedUi,
      ...[
        at('package.json'),
        at('nuxt.config.ts'),
        at('tsconfig.json'),
        ...PUBLIC_CRAWL_ASSETS.map(at),
      ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const })),
      ];
  }
  if (profile.profileId === 'vue' || profile.profileId === 'svelte') {
    return [
      ...common,
      ...sharedUi,
      ...[
        at('package.json'),
        at('vite.config.ts'),
        at('tsconfig.json'),
        ...PUBLIC_CRAWL_ASSETS.map(at),
      ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const })),
    ];
  }
  if (profile.profileId === 'sveltekit') {
    return [
      ...common,
      ...sharedUi,
      ...[
        at('package.json'),
        at('svelte.config.js'),
        at('vite.config.ts'),
        at('tsconfig.json'),
      ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const })),
    ];
  }
  if (profile.profileId === 'astro') {
    // Astro serves `public/` verbatim, so the crawl/share assets the reviewer
    // baseline requires compile here exactly like vite-react/next. Without
    // them these profiles had NO owner for robots.txt/sitemap.xml and every
    // reviewer demand for them was an unsatisfiable order (the 12co class the
    // satisfiability sweep now denies at PLAN_READY).
    return [
      ...common,
      ...sharedUi,
      ...[
        at('package.json'),
        at('astro.config.mjs'),
        at('tsconfig.json'),
        ...PUBLIC_CRAWL_ASSETS.map(at),
      ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const })),
    ];
  }
  if (profile.profileId === 'angular') {
    // Angular's default builder copies `public/` since v18 (`angular.json`
    // assets glob), so the same crawl assets compile here; see the astro note.
    return [
      ...common,
      ...sharedUi,
      ...[
        at('package.json'),
        at('angular.json'),
        at('tsconfig.json'),
        ...PUBLIC_CRAWL_ASSETS.map(at),
      ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const })),
    ];
  }
  if (profile.profileId === 'server-rendered') {
    return [
      ...common,
      ...sharedUi,
      ...[
        at('package.json'),
        at('vite.config.ts'),
        at('resources/css/app.css'),
      ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const })),
    ];
  }
  return [
    ...sharedUi,
    { path: at('package.json'), ownerRole: 'senior-frontend', kind: 'scaffold' as const },
  ];
}

export function sharedUiScaffoldOutputs(profile: CapabilityProfileV1): CompiledArchitectureOutputV1[] {
  const sharedRoot = profile.uiSystem?.sharedRoot;
  if (!sharedRoot) return [];
  const common = [
    `${sharedRoot}/package.json`,
    `${sharedRoot}/tsconfig.json`,
    `${sharedRoot}/src/index.ts`,
  ];
  const shadcn = profile.uiSystem?.family === 'shadcn'
    ? [
        `${sharedRoot}/components.json`,
        `${sharedRoot}/src/lib/utils.ts`,
        'packages/tailwind-config/package.json',
        'packages/tailwind-config/src/globals.css',
      ]
    : [];
  return [...common, ...shadcn].map((output) => ({
    path: output,
    ownerRole: 'senior-frontend',
    kind: 'scaffold' as const,
  }));
}

export function uiPrimitiveScaffoldOutputs(
  profile: CapabilityProfileV1,
  primitiveNames: readonly string[],
): CompiledArchitectureOutputV1[] {
  if (profile.uiSystem?.family !== 'shadcn' || !profile.uiSystem.sharedRoot) return [];
  const root = `${profile.uiSystem.sharedRoot}/src/components/ui`;
  const names = [...new Set(primitiveNames.map((name) => name.trim()).filter(Boolean))].sort();
  return names.map((name) => ({
    path: profile.uiSystem?.adapter === 'shadcn'
      ? `${root}/${name}.tsx`
      : `${root}/${name}/**`,
    ownerRole: 'senior-frontend',
    kind: 'scaffold',
  }));
}

export function nativeScaffoldOutputs(profile: CapabilityProfileV1): CompiledArchitectureOutputV1[] {
  if (!profile.surfaces.includes('native-ui') || profile.architectureTarget === 'web-ui') return [];
  if (profile.profileId === 'react-native') {
    return ['package.json', 'app.json'].map((output) => ({
      path: output,
      ownerRole: 'senior-frontend',
      kind: 'scaffold' as const,
    }));
  }
  if (profile.profileId === 'swift-native') {
    return [{ path: 'Package.swift', ownerRole: 'senior-frontend', kind: 'scaffold' }];
  }
  if (profile.profileId === 'kotlin-native') {
    return [
      'settings.gradle.kts',
      'app/build.gradle.kts',
    ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const }));
  }
  return [{ path: 'pubspec.yaml', ownerRole: 'senior-frontend', kind: 'scaffold' }];
}

export function backendScaffoldOutputs(profile: CapabilityProfileV1): CompiledArchitectureOutputV1[] {
  if (!profile.roles.includes('senior-backend')) return [];
  let outputs: string[] = [];
  if (profile.backendFramework === 'go') outputs = ['go.mod', 'go.sum'];
  else if (['python', 'django', 'fastapi'].includes(profile.backendFramework)) outputs = ['pyproject.toml'];
  else if (['laravel', 'php'].includes(profile.backendFramework)) {
    const appRoot = profile.profileId === 'server-rendered' ? webPackageRoot(profile) : '.';
    outputs = ['composer.json', 'artisan'].map((output) => (
      appRoot === '.' ? output : `${appRoot}/${output}`
    ));
  }
  else if (profile.backendFramework === 'rust') outputs = ['Cargo.toml'];
  else if (profile.backendFramework === 'java') outputs = ['pom.xml'];
  else if (profile.backendFramework === 'kotlin') outputs = ['build.gradle.kts'];
  else if (profile.backendFramework === 'dotnet') outputs = ['Directory.Build.props'];
  else if (['supabase', 'our-fork'].includes(profile.backendFramework)) {
    // The database IS the backend on this stack. Compiling only `config.toml`
    // left schema, RLS, and seed data owned by nobody, so every supabase build
    // shipped without a data layer: 1cu and 2cu backends both reported "the
    // immutable allowlist excludes Supabase migrations", and 1cl died in
    // planning because the architect could not queue a seed unit at all.
    // Deterministic names keep assignments a closed set (no globs) while
    // matching the CLI's lexicographic apply order.
    outputs = [
      'supabase/config.toml',
      'supabase/migrations/0001_init.sql',
      'supabase/seed.sql',
      // The generated Database type snapshot (`gen:types` target) and the
      // committed schema snapshot are required AFTER the migration lands, and
      // neither was in any allowlist — the 4cu backend digested BLOCKED and
      // forced an architect replan just to own them.
      'packages/api-client/src/database.types.ts',
      // The client boundary itself. `new-project-setup.md` already describes
      // `packages/api-client` as the home of the Supabase browser client, but
      // no role was ever given a path to write it: observed 6co, the backend
      // compiled three typed services and the FRONTEND constructed its own
      // `createClient<Database>` inside `apps/web/src/features/auth-boundary`,
      // then passed closures back into backend-owned services. One factory,
      // owned by the role that owns the schema and the generated types.
      'packages/api-client/src/supabase.ts',
      'packages/api-client/src/index.ts',
    ];
  } else if (!selectedTargetHasWebUi(profile)) {
    outputs = ['package.json'];
  }
  return outputs.map((output) => ({
    path: output,
    ownerRole: 'senior-backend',
    kind: 'scaffold' as const,
  }));
}

/**
 * Every workspace package a compiled output lands in needs its own manifest, or
 * the package is unresolvable: `pnpm-workspace.yaml` globs `packages/*`, and a
 * package directory without `package.json` is not a workspace member at all.
 *
 * Observed 1cu-cursor: supabase service modules compile to
 * `packages/api-client/src/*.ts` and NO role was ever given
 * `packages/api-client/package.json` — the frontend's manifests are hardcoded
 * per profile, the backend's are not. Owned by whoever owns the package's
 * sources, so parallel roles never share a writable manifest.
 */
