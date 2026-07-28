// Runtime-owned architecture contracts. Agents provide only semantic routes,
// modules, and narrowly-scoped exception requests; roots and concrete output
// paths are compiled from the capability registry and the immutable run
// baseline.

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

import {
  capabilityProfileForProject,
  detectFrontendFramework,
  runtimeCapabilityStateFromProfile,
  type CapabilityProfileV1,
} from './capabilities';
import { readJson, writeJson } from './fsjson';
import { obj, type Rec } from './obj';
import { effectiveLegacyRunStatus } from './run-settlement';
import { matchesPattern } from './scope';
import { withProjectStateLock } from './state/project-state-lock';
import { sha256 } from './text';

export const ARCHITECTURE_INPUT_SCHEMA_VERSION = 1 as const;
export const COMPILED_ARCHITECTURE_SCHEMA_VERSION = 1 as const;
export const WORK_UNIT_CONTRACT_SCHEMA_VERSION = 1 as const;
export const ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const ARCHITECTURE_RUN_BASELINE_SCHEMA_VERSION = 1 as const;
export const ARCHITECTURE_SCAN_MAX_FILES = 10_000;

export type ArchitectureModuleKind =
  | 'app-shell'
  | 'page'
  | 'component'
  | 'feature'
  | 'service'
  | 'store'
  | 'test';

export interface ArchitectureRouteInputV1 {
  id: string;
  path: string;
  moduleId: string;
  redirect?: boolean;
}

export interface ArchitectureModuleInputV1 {
  id: string;
  name: string;
  kind: ArchitectureModuleKind;
}

export interface ArchitectureExceptionRequestV1 {
  ruleId: string;
  glob: string;
  reason: string;
}

export interface ArchitectureInputV1 {
  schemaVersion: typeof ARCHITECTURE_INPUT_SCHEMA_VERSION;
  routes: ArchitectureRouteInputV1[];
  modules: ArchitectureModuleInputV1[];
  exceptions?: ArchitectureExceptionRequestV1[];
}

export interface ArchitectureBaselineV1 {
  kind: 'git-head' | 'file-manifest';
  identity: string;
  capturedAt: string;
  filesHash?: string;
  fileCount?: number;
  files?: Array<{ path: string; hash: string }>;
  /** Immutable non-Git directory evidence, including empty framework roots. */
  directories?: string[];
}

export interface ArchitectureRunSnapshotV1 {
  schemaVersion: typeof ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION;
  runId: string;
  profile: CapabilityProfileV1;
  baselineIdentity: string;
  baselineHash: string;
  capturedAt: string;
  snapshotHash: string;
}

export interface ArchitectureRunBaselineV1 {
  schemaVersion: typeof ARCHITECTURE_RUN_BASELINE_SCHEMA_VERSION;
  runId: string;
  baseline: ArchitectureBaselineV1;
  baselineHash: string;
}

export interface CompiledArchitectureModuleV1 extends ArchitectureModuleInputV1 {
  ownerRole: string;
  output: string;
}

export interface CompiledArchitectureRouteV1 extends ArchitectureRouteInputV1 {
  moduleOutput: string;
}

export type CompiledOutputKindV1 =
  | 'module'
  | 'entrypoint'
  | 'scaffold'
  | 'test'
  | 'test-infra';

export interface CompiledArchitectureOutputV1 {
  path: string;
  ownerRole: string;
  kind: CompiledOutputKindV1;
}

export interface CompiledArchitectureV1 {
  schemaVersion: typeof COMPILED_ARCHITECTURE_SCHEMA_VERSION;
  runId: string;
  profile: CapabilityProfileV1;
  baseline: ArchitectureBaselineV1;
  sourceRoots: string[];
  entrypoints: string[];
  layers: CapabilityProfileV1['layerRoots'];
  routes: CompiledArchitectureRouteV1[];
  modules: CompiledArchitectureModuleV1[];
  /**
   * Runtime-derived scaffold/test outputs. Optional on read so v1.0.19
   * sidecars remain ignorable/parseable; every newly compiled contract emits
   * the field and covers it with contractHash.
   */
  scaffoldOutputs?: CompiledArchitectureOutputV1[];
  allowedOutputs: string[];
  exceptions: ArchitectureExceptionRequestV1[];
  inputHash: string;
  contractHash: string;
}

export interface ResolvedPolicyMaterialV1 {
  id: string;
  contentHash: string;
}

export interface WorkUnitContractV1 {
  schemaVersion: typeof WORK_UNIT_CONTRACT_SCHEMA_VERSION;
  runId: string;
  unitId: string;
  trafficOneRole: string;
  hostAgentType: string | null;
  rules: ResolvedPolicyMaterialV1[];
  skills: ResolvedPolicyMaterialV1[];
  outputs: string[];
  allowlist: string[];
  allowlistExclude: string[];
  architectureHash: string;
  verificationHash: string;
  contractHash: string;
}

export interface ArchitectureValidationResult {
  ok: boolean;
  errors: string[];
}

export interface RuntimeAssignmentEntryV1 {
  role: string;
  summary: string;
  scope: {
    include: string[];
    exclude: string[];
  };
}

export interface RuntimeAssignmentsV1 {
  version: 1;
  schemaVersion: 1;
  runId: string;
  createdBy: 'traffic-one-runtime';
  architectureHash: string;
  verificationHash: string;
  assignments: RuntimeAssignmentEntryV1[];
  assignmentsHash: string;
}

const MEMORY_DIR = '.traffic' + '-one';
const BLOCKED_EXCEPTION_RULES = new Set([
  'STRUCT_ENTRYPOINT_COMPONENT',
  'STRUCT_MULTI_PAGE_MODULE',
  'STRUCT_ROUTE_MODULE_MISMATCH',
  'STRUCT_ASSIGNMENT_ALLOWLIST_GAP',
  'STRUCT_SCAN_INCOMPLETE',
]);
const EXCEPTION_RULES = new Set([
  'STRUCT_COMPONENT_LOC',
  'STRUCT_FUNCTION_COUNT',
  'STRUCT_COMPONENTS_PER_FILE',
]);
const MODULE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
// `*` (bare) is the router-idiomatic catch-all every SPA needs for its 404.
// Requiring a leading slash made it undeclarable, and the structural gate then
// compared the contract path literally against the `path="*"` in code — so the
// only legal outcome was shipping without a not-found route at all (2cu shipped
// exactly that, leaving its compiled NotFoundPage module unreachable).
const ROUTE_PATH_RE = /^(?:\*|\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%{}[\]-]+\/?)*)$/;

/**
 * One canonical spelling for the catch-all so the compiled contract and the
 * route table in code always agree: `*`, `/*`, and `/**` are the same route.
 * Shared with the structural gate — keep the two in sync.
 */
export function canonicalRoutePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '*' || trimmed === '/*' || trimmed === '/**') return '*';
  if (trimmed === '/') return trimmed;
  return trimmed.replace(/\/+$/, '') || '/';
}
// Display-only field: the kebab-case `id` drives paths, so common title
// punctuation is safe here. Path/markup metacharacters stay excluded
// (observed 2cl: "Content schema, RLS, and seeds" cost the architect a
// deny cycle over the comma).
const SAFE_NAME_RE = /^[A-Za-z][A-Za-z0-9 ,.()&+':-]{0,79}$/;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sorted(child)]),
  );
}

export function stableContractJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function contractHash(value: unknown): string {
  return sha256(stableContractJson(value));
}

function normalizeRelative(value: string): string | null {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function baselinePathSet(
  projectRoot: string,
  baseline: ArchitectureBaselineV1,
): Set<string> {
  if (baseline.kind === 'file-manifest') {
    return new Set([
      ...(baseline.files || []).map((entry) => entry.path),
      ...(baseline.directories || []),
    ]);
  }
  if (!baseline.identity.startsWith('git:')) {
    throw new Error('immutable Git baseline identity is invalid');
  }
  let output: string;
  let prefix = '';
  try {
    prefix = execFileSync('git', ['-C', projectRoot, 'rev-parse', '--show-prefix'], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().replace(/\\/g, '/');
    output = execFileSync('git', [
      '-C', projectRoot, 'ls-tree', '-r', '--name-only', baseline.identity.slice(4),
      ...(prefix ? ['--', prefix] : []),
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error('immutable Git baseline tree cannot be read');
  }
  const files = output.split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/g, '/'))
    .filter((entry) => !prefix || entry.startsWith(prefix))
    .map((entry) => prefix ? entry.slice(prefix.length) : entry)
    .filter(Boolean);
  if (files.length > ARCHITECTURE_SCAN_MAX_FILES) {
    throw new Error(`baseline tree exceeds ${ARCHITECTURE_SCAN_MAX_FILES} files`);
  }
  return new Set(files);
}

function baselineContains(paths: ReadonlySet<string>, candidate: string): boolean {
  return paths.has(candidate)
    || [...paths].some((entry) => entry.startsWith(`${candidate.replace(/\/+$/, '')}/`));
}

function chosenRoot(
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

function pascal(value: string): string {
  const result = value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
  return result || 'Module';
}

function kebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'module';
}

function snake(value: string): string {
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
  if (profile.profileId === 'nuxt') return kind === 'page' || kind === 'component' ? '.vue' : '.ts';
  if (profile.profileId === 'vue') {
    return ['app-shell', 'page', 'component'].includes(kind) ? '.vue' : '.ts';
  }
  if (profile.profileId === 'sveltekit' || profile.profileId === 'svelte') {
    return ['app-shell', 'page', 'component'].includes(kind) ? '.svelte' : '.ts';
  }
  if (profile.profileId === 'astro') {
    return ['app-shell', 'page', 'component'].includes(kind) ? '.astro' : '.ts';
  }
  if (profile.profileId === 'angular') return '.ts';
  if (profile.profileId === 'server-rendered') {
    if (profile.router === 'inertia-vue-router') return kind === 'page' || kind === 'component' ? '.vue' : '.ts';
    if (profile.router.startsWith('inertia-')) return kind === 'page' || kind === 'component' ? '.tsx' : '.ts';
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
  if (kind === 'service' || kind === 'store' || kind === 'feature') return '.ts';
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

function moduleOutput(
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
    if (profile.profileId === 'angular') {
      const componentName = kebab(module.name);
      return `${componentsRoot}/${componentName}/${componentName}.component.ts`;
    }
    return `${componentsRoot}/${name}${ext}`;
  }
  if (module.kind === 'feature') return `${featuresRoot}/${kebab(module.name)}/index${ext}`;
  if (module.kind === 'test') return `tests/${kebab(module.name)}${ext}`;
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
      return `app/Services/${name}.php`;
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

function workspaceScaffoldOutputs(webRoot: string): CompiledArchitectureOutputV1[] {
  if (!/^(?:apps|packages)\//.test(webRoot)) return [];
  return [
    'package.json',
    'pnpm-workspace.yaml',
    'turbo.json',
    'tsconfig.base.json',
  ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const }));
}

const REPOSITORY_SCAFFOLD_OUTPUTS = [
  '.gitignore',
  'README.md',
  '.editorconfig',
  '.github/workflows/ci.yml',
] as const;

const NODE_TOOLING_OUTPUTS = [
  '.prettierrc',
  '.prettierignore',
  '.nvmrc',
] as const;

function selectedImplementationOwner(profile: CapabilityProfileV1): string | null {
  const selectedUi = profile.surfaces.includes('web-ui') || profile.surfaces.includes('native-ui');
  if (selectedUi && profile.roles.includes('senior-frontend')) return 'senior-frontend';
  if (profile.roles.includes('senior-backend')) return 'senior-backend';
  return null;
}

function selectedTargetHasWebUi(profile: CapabilityProfileV1): boolean {
  return profile.surfaces.includes('web-ui') && profile.architectureTarget !== 'native-ui';
}

function repositoryScaffoldOutputs(profile: CapabilityProfileV1): CompiledArchitectureOutputV1[] {
  const ownerRole = selectedImplementationOwner(profile);
  if (!ownerRole) return [];
  return REPOSITORY_SCAFFOLD_OUTPUTS.map((output) => ({
    path: output,
    ownerRole,
    kind: 'scaffold',
  }));
}

function environmentScaffoldOutputs(profile: CapabilityProfileV1): CompiledArchitectureOutputV1[] {
  const ownerRole = profile.roles.includes('senior-backend')
    ? 'senior-backend'
    : (
        selectedTargetHasWebUi(profile)
        && profile.backendFramework === 'external-api'
        && profile.roles.includes('senior-frontend')
          ? 'senior-frontend'
          : null
      );
  return ownerRole
    ? [{ path: '.env.example', ownerRole, kind: 'scaffold' }]
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

function nodeToolingScaffoldOutputs(
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

function appendUniqueScaffoldOutputs(
  outputs: CompiledArchitectureOutputV1[],
  additions: readonly CompiledArchitectureOutputV1[],
): void {
  for (const addition of additions) {
    if (!outputs.some((output) => output.path === addition.path)) outputs.push(addition);
  }
}

function resolveInitialScaffoldOwners(
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
] as const;

function frontendScaffoldOutputs(profile: CapabilityProfileV1): CompiledArchitectureOutputV1[] {
  if (!profile.surfaces.includes('web-ui') || profile.architectureTarget === 'native-ui') return [];
  const webRoot = webPackageRoot(profile);
  const at = (rel: string): string => webRoot === '.' ? rel : `${webRoot}/${rel}`;
  const common = workspaceScaffoldOutputs(webRoot);
  if (profile.profileId === 'vite-react') {
    return [
      ...common,
      ...[
        at('package.json'),
        at('index.html'),
        at('vite.config.ts'),
        at('tsconfig.json'),
        at('src/vite-env.d.ts'),
        ...PUBLIC_CRAWL_ASSETS.map(at),
        'packages/ui/package.json',
        'packages/ui/src/index.ts',
        'packages/i18n/package.json',
        'packages/i18n/src/index.ts',
        // The canonical source-locale catalog (rules/frontend/i18n.md layout).
        // Without it in scope, the classic bounded i18n delegation unit is
        // rejected at Step-0 and the paid frontend cannot author the catalog
        // file either (observed 3cl: 0/6 units delegable).
        'packages/i18n/src/locales/en/common.json',
        'packages/tailwind-config/package.json',
        'packages/tailwind-config/src/globals.css',
      ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const })),
    ];
  }
  if (profile.profileId === 'next-app' || profile.profileId === 'next-pages') {
    return [
      ...common,
      ...[
        at('package.json'),
        at('next.config.ts'),
        at('tsconfig.json'),
        ...PUBLIC_CRAWL_ASSETS.map(at),
      ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const })),
    ];
  }
  if (profile.profileId === 'nuxt') {
    return [
      ...common,
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
      ...[
        at('package.json'),
        at('svelte.config.js'),
        at('vite.config.ts'),
        at('tsconfig.json'),
      ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const })),
    ];
  }
  if (profile.profileId === 'astro') {
    return [
      ...common,
      ...[
        at('package.json'),
        at('astro.config.mjs'),
        at('tsconfig.json'),
      ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const })),
    ];
  }
  if (profile.profileId === 'angular') {
    return [
      ...common,
      ...[
        at('package.json'),
        at('angular.json'),
        at('tsconfig.json'),
      ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const })),
    ];
  }
  if (profile.profileId === 'server-rendered') {
    return [
      'package.json',
      'vite.config.ts',
      'resources/css/app.css',
    ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const }));
  }
  return [
    at('package.json'),
  ].map((output) => ({ path: output, ownerRole: 'senior-frontend', kind: 'scaffold' as const }));
}

function nativeScaffoldOutputs(profile: CapabilityProfileV1): CompiledArchitectureOutputV1[] {
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

function backendScaffoldOutputs(profile: CapabilityProfileV1): CompiledArchitectureOutputV1[] {
  if (!profile.roles.includes('senior-backend')) return [];
  let outputs: string[] = [];
  if (profile.backendFramework === 'go') outputs = ['go.mod', 'go.sum'];
  else if (['python', 'django', 'fastapi'].includes(profile.backendFramework)) outputs = ['pyproject.toml'];
  else if (['laravel', 'php'].includes(profile.backendFramework)) outputs = ['composer.json', 'artisan'];
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
function workspaceManifestOutputs(
  scaffoldOutputs: readonly CompiledArchitectureOutputV1[],
  modules: readonly CompiledArchitectureModuleV1[],
): CompiledArchitectureOutputV1[] {
  const owners = new Map<string, string>();
  const claim = (outputPath: string, ownerRole: string): void => {
    const pkg = /^(packages\/[^/]+)\//.exec(outputPath)?.[1];
    if (!pkg || !ownerRole) return;
    if (!owners.has(pkg)) owners.set(pkg, ownerRole);
  };
  // Scaffold outputs first: a profile that already names the manifest keeps its
  // declared owner, and the entry below is then deduped away.
  for (const output of scaffoldOutputs) claim(output.path, output.ownerRole);
  for (const module of modules) claim(module.output, module.ownerRole);
  const existing = new Set(scaffoldOutputs.map((output) => output.path));
  return [...owners.entries()]
    .map(([pkg, ownerRole]) => ({ path: `${pkg}/package.json`, ownerRole, kind: 'scaffold' as const }))
    .filter((output) => !existing.has(output.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function routeRegistrationOutputs(
  profile: CapabilityProfileV1,
  routes: readonly ArchitectureRouteInputV1[],
): CompiledArchitectureOutputV1[] {
  if (
    routes.length === 0
    || profile.profileId !== 'server-rendered'
    || profile.framework !== 'laravel'
  ) return [];
  return [{
    path: 'routes/web.php',
    // This registration is the integration edge for frontend-owned page
    // modules. Keep one owner so parallel frontend/backend units never share a
    // writable route file.
    ownerRole: 'senior-frontend',
    kind: 'scaffold',
  }];
}

function testOutputForModule(
  profile: CapabilityProfileV1,
  module: CompiledArchitectureModuleV1,
): string {
  if (module.kind === 'test') return module.output;
  const basename = path.posix.basename(module.output).replace(/\.[^.]+$/, '');
  if (profile.backendFramework === 'go' && module.output.endsWith('.go')) {
    return module.output.replace(/\.go$/, '_test.go');
  }
  if (['python', 'django', 'fastapi'].includes(profile.backendFramework) && module.output.endsWith('.py')) {
    return `tests/test_${snake(basename)}.py`;
  }
  if (['laravel', 'php'].includes(profile.backendFramework) && module.output.endsWith('.php')) {
    return `tests/Feature/${pascal(basename)}Test.php`;
  }
  if (profile.profileId === 'swift-native') return `Tests/${pascal(basename)}Tests.swift`;
  if (profile.profileId === 'kotlin-native') return `app/src/test/${pascal(basename)}Test.kt`;
  if (profile.profileId === 'flutter-native') return `test/${snake(basename)}_test.dart`;
  return `tests/${kebab(basename)}.test.ts`;
}

function testerOutputs(
  profile: CapabilityProfileV1,
  modules: CompiledArchitectureModuleV1[],
): CompiledArchitectureOutputV1[] {
  const outputs: CompiledArchitectureOutputV1[] = modules
    .filter((module) => module.kind !== 'app-shell')
    .map((module) => ({
      path: testOutputForModule(profile, module),
      ownerRole: 'senior-tester',
      kind: 'test',
    }));
  if (selectedTargetHasWebUi(profile)) {
    outputs.push(
      // A unit-test runner config the tester OWNS. Without one it has no legal
      // place to configure a runner and improvises: observed 2cu, the tester
      // built a parallel harness (its own package.json + lockfile) under
      // `.traffic-one/reports/qa/<runId>/test-harness/` and installed 241 MB of
      // node_modules into the plugin's state directory, running the suite
      // against a config disconnected from the real workspace.
      { path: 'vitest.config.ts', ownerRole: 'senior-tester', kind: 'test-infra' },
      { path: 'playwright.config.ts', ownerRole: 'senior-tester', kind: 'test-infra' },
      { path: 'tests/e2e/smoke.spec.ts', ownerRole: 'senior-tester', kind: 'test' },
    );
  }
  if (profile.profileId === 'react-native') {
    outputs.push({ path: '.maestro/flows/smoke.yaml', ownerRole: 'senior-tester', kind: 'test-infra' });
  } else if (profile.profileId === 'swift-native') {
    outputs.push({ path: 'Tests/AppSmokeTests.swift', ownerRole: 'senior-tester', kind: 'test-infra' });
  } else if (profile.profileId === 'kotlin-native') {
    outputs.push({ path: 'app/src/androidTest/AppSmokeTest.kt', ownerRole: 'senior-tester', kind: 'test-infra' });
  } else if (profile.profileId === 'flutter-native') {
    outputs.push({ path: 'integration_test/app_test.dart', ownerRole: 'senior-tester', kind: 'test-infra' });
  } else if (['python', 'django', 'fastapi'].includes(profile.backendFramework)) {
    outputs.push({ path: 'tests/conftest.py', ownerRole: 'senior-tester', kind: 'test-infra' });
  } else if (['laravel', 'php'].includes(profile.backendFramework)) {
    outputs.push({ path: 'phpunit.xml', ownerRole: 'senior-tester', kind: 'test-infra' });
  }
  return outputs;
}

function validateExceptionRequest(request: ArchitectureExceptionRequestV1): string[] {
  const errors: string[] = [];
  const glob = normalizeRelative(request.glob);
  if (!EXCEPTION_RULES.has(request.ruleId) || BLOCKED_EXCEPTION_RULES.has(request.ruleId)) {
    errors.push(`exception ${request.ruleId || '<missing>'}: rule is not exception-eligible`);
  }
  if (!glob || glob === '**' || glob === '**/*' || !glob.includes('/')) {
    errors.push(`exception ${request.ruleId || '<missing>'}: glob must be narrow and project-relative`);
  } else {
    const uiPrimitive = glob.startsWith('packages/ui/')
      || glob.includes('/components/ui/')
      || /\/[A-Z][A-Za-z0-9]+(?:\*|\{[^}]+\})\.[A-Za-z]+$/.test(glob);
    if (!uiPrimitive) {
      errors.push(`exception ${request.ruleId}: only packages/ui, shadcn UI primitives, or a same-prefix compound family may be exempted`);
    }
  }
  if (String(request.reason || '').trim().length < 12) {
    errors.push(`exception ${request.ruleId || '<missing>'}: reason must be specific`);
  }
  return errors;
}

const ARCHITECTURE_INPUT_KEYS = new Set(['schemaVersion', 'routes', 'modules', 'exceptions']);
const ARCHITECTURE_MODULE_KEYS = new Set(['id', 'name', 'kind']);
const ARCHITECTURE_ROUTE_KEYS = new Set(['id', 'path', 'moduleId', 'redirect']);
const ARCHITECTURE_EXCEPTION_KEYS = new Set(['ruleId', 'glob', 'reason']);

function unsupportedArchitectureFields(
  value: Rec,
  allowed: ReadonlySet<string>,
  label: string,
): string[] {
  // Name the accepted keys in the error itself. The architect writes this file
  // from prose, so semantic-sounding extras get invented (observed 1cu-cursor:
  // `routes[].access` and `routes[].seo`); an error that only says which key is
  // wrong costs a whole re-read + retry cycle to find out which are right.
  const accepted = [...allowed].join(', ');
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort()
    .map((key) => `${label} has unsupported field ${key} (accepted: ${accepted})`);
}

export function validateArchitectureInput(input: unknown): ArchitectureValidationResult {
  const raw = obj(input);
  const errors: string[] = [];
  if (!raw || raw.schemaVersion !== ARCHITECTURE_INPUT_SCHEMA_VERSION) {
    return { ok: false, errors: ['schemaVersion must be 1'] };
  }
  errors.push(...unsupportedArchitectureFields(raw, ARCHITECTURE_INPUT_KEYS, 'input'));
  const routes = Array.isArray(raw.routes) ? raw.routes.map(obj) : [];
  const modules = Array.isArray(raw.modules) ? raw.modules.map(obj) : [];
  const exceptions = Array.isArray(raw.exceptions) ? raw.exceptions.map(obj) : [];
  if (!Array.isArray(raw.routes)) errors.push('routes must be an array');
  if (!Array.isArray(raw.modules) || modules.length === 0) errors.push('modules must be a non-empty array');
  if (raw.exceptions !== undefined && !Array.isArray(raw.exceptions)) {
    errors.push('exceptions must be an array when provided');
  }

  const moduleIds = new Set<string>();
  for (const [index, module] of modules.entries()) {
    if (module) {
      errors.push(...unsupportedArchitectureFields(
        module,
        ARCHITECTURE_MODULE_KEYS,
        `modules[${index}]`,
      ));
    }
    const id = typeof module?.id === 'string' ? module.id.trim() : '';
    const name = typeof module?.name === 'string' ? module.name.trim() : '';
    const kind = typeof module?.kind === 'string' ? module.kind : '';
    if (!MODULE_ID_RE.test(id)) errors.push(`modules[${index}].id is invalid (expected kebab-case: lowercase letter first, then lowercase letters/digits/hyphens, max 64 chars)`);
    if (moduleIds.has(id)) errors.push(`modules[${index}].id is duplicated`);
    moduleIds.add(id);
    if (!SAFE_NAME_RE.test(name)) errors.push(`modules[${index}].name is invalid (expected a letter first, then letters/digits/spaces and , . ( ) & + ' : - punctuation, max 80 chars — no slashes, quotes, or angle brackets)`);
    if (!['app-shell', 'page', 'component', 'feature', 'service', 'store', 'test'].includes(kind)) {
      errors.push(`modules[${index}].kind is invalid`);
    }
    if (
      'output' in (module || {})
      || 'root' in (module || {})
      || 'path' in (module || {})
      || 'ownerRole' in (module || {})
      || 'role' in (module || {})
    ) {
      errors.push(`modules[${index}] may not choose output paths, roots, or roles`);
    }
  }

  const routeIds = new Set<string>();
  for (const [index, route] of routes.entries()) {
    if (route) {
      errors.push(...unsupportedArchitectureFields(
        route,
        ARCHITECTURE_ROUTE_KEYS,
        `routes[${index}]`,
      ));
    }
    const id = typeof route?.id === 'string' ? route.id.trim() : '';
    const routePath = typeof route?.path === 'string' ? route.path.trim() : '';
    const moduleId = typeof route?.moduleId === 'string' ? route.moduleId.trim() : '';
    if (!MODULE_ID_RE.test(id)) errors.push(`routes[${index}].id is invalid (expected kebab-case: lowercase letter first, then lowercase letters/digits/hyphens, max 64 chars)`);
    if (routeIds.has(id)) errors.push(`routes[${index}].id is duplicated`);
    routeIds.add(id);
    if (!ROUTE_PATH_RE.test(routePath)) errors.push(`routes[${index}].path is invalid (expected a leading-slash path such as \`/\`, \`/courses\`, or \`/courses/:slug\`, or the catch-all \`*\`)`);
    if (route && 'redirect' in route && typeof route.redirect !== 'boolean') {
      errors.push(`routes[${index}].redirect must be a boolean when provided`);
    }
    if (route?.redirect !== true && !moduleIds.has(moduleId)) {
      errors.push(`routes[${index}].moduleId does not name a declared module`);
    }
    const target = modules.find((module) => module?.id === moduleId);
    if (route?.redirect !== true && target?.kind !== 'page') {
      errors.push(`routes[${index}] must target a page module`);
    }
  }

  for (const [index, exception] of exceptions.entries()) {
    if (!exception) {
      errors.push(`exceptions[${index}] must be an object`);
      continue;
    }
    errors.push(...unsupportedArchitectureFields(
      exception,
      ARCHITECTURE_EXCEPTION_KEYS,
      `exceptions[${index}]`,
    ));
    errors.push(...validateExceptionRequest({
      ruleId: typeof exception.ruleId === 'string' ? exception.ruleId : '',
      glob: typeof exception.glob === 'string' ? exception.glob : '',
      reason: typeof exception.reason === 'string' ? exception.reason : '',
    }));
  }
  return { ok: errors.length === 0, errors };
}

function findGitDir(projectRoot: string): string | null {
  let cursor = path.resolve(projectRoot);
  while (true) {
    const dotGit = path.join(cursor, '.git');
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) return dotGit;
      if (stat.isFile()) {
        const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (match?.[1]) return path.resolve(cursor, match[1]);
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function gitHead(projectRoot: string): string | null {
  const gitDir = findGitDir(projectRoot);
  if (!gitDir) return null;
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[a-f0-9]{40,64}$/i.test(head)) return head.toLowerCase();
    const ref = /^ref:\s+(.+)$/.exec(head)?.[1];
    if (!ref) return null;
    const direct = path.join(gitDir, ref);
    try {
      const value = fs.readFileSync(direct, 'utf8').trim();
      if (/^[a-f0-9]{40,64}$/i.test(value)) return value.toLowerCase();
    } catch {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      const line = packed.split(/\r?\n/).find((entry) => entry.endsWith(` ${ref}`));
      const value = line?.split(' ')[0] || '';
      if (/^[a-f0-9]{40,64}$/i.test(value)) return value.toLowerCase();
    }
  } catch {
    return null;
  }
  return null;
}

const BASELINE_SKIP_RE = /(^|\/)(?:\.git|\.traffic-one|node_modules|dist|build|coverage|out|\.next|\.turbo|generated|__generated__)(?:\/|$)/;

const CONTEXT_ALIAS_PATH = 'CLAUDE.md';
const CONTEXT_ALIAS_TARGET = 'AGENTS.md';

/**
 * Identity row for the canonical context alias. Both the immutable baseline and
 * the verification diff hash it this way, so replacing the alias with a regular
 * file (or another link) still shows up as a change in either scan.
 */
export function contextAliasHash(target: string): string {
  return sha256(`symbolic-link:${target}`);
}

/**
 * The ONE symlink materialization creates in a project root: `CLAUDE.md` →
 * `AGENTS.md`. Returns the link target when `relativePath` is exactly that
 * alias, else null.
 *
 * Exported because every scan that walks project files has to agree about it.
 * The immutable baseline accepted the alias while the verification scan failed
 * closed on it, so the plugin's own materialized artifact denied `PLAN_READY`
 * with `STRUCT_SCAN_INCOMPLETE` (observed 1cu-cursor; the parent had to replace
 * the symlink with a copy by hand to get the run moving).
 */
export function canonicalTrafficOneContextLink(
  projectRoot: string,
  fullPath: string,
  relativePath: string,
): string | null {
  // Materialization owns exactly this root alias. Keep every other symlink
  // fail-closed: source links, nested aliases, absolute targets, and escapes
  // must never disappear from an immutable non-Git baseline.
  if (relativePath !== CONTEXT_ALIAS_PATH) return null;
  let linkTarget: string;
  try {
    linkTarget = fs.readlinkSync(fullPath);
  } catch {
    return null;
  }
  if (linkTarget !== CONTEXT_ALIAS_TARGET) return null;
  const expectedTarget = path.join(path.resolve(projectRoot), CONTEXT_ALIAS_TARGET);
  const resolvedTarget = path.resolve(path.dirname(fullPath), linkTarget);
  if (resolvedTarget !== expectedTarget) return null;
  try {
    const targetStat = fs.lstatSync(resolvedTarget);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return linkTarget;
}

function fileManifestBaseline(projectRoot: string, roots: string[]): ArchitectureBaselineV1 {
  const rows: Array<[string, string]> = [];
  const directories: string[] = [];
  const stack = roots
    .map((root) => normalizeRelative(root))
    .filter((root): root is string => Boolean(root))
    .map((root) => path.join(projectRoot, root));
  let scanned = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      const rel = path.relative(projectRoot, dir).replace(/\\/g, '/') || '.';
      throw new Error(`baseline cannot read ${rel}`);
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
      if (BASELINE_SKIP_RE.test(`/${rel}`)) continue;
      if (entry.isSymbolicLink()) {
        const target = canonicalTrafficOneContextLink(projectRoot, full, rel);
        if (target) {
          scanned += 1;
          if (scanned > ARCHITECTURE_SCAN_MAX_FILES) {
            throw new Error(`baseline scan exceeds ${ARCHITECTURE_SCAN_MAX_FILES} files`);
          }
          // The target file is hashed independently. This row additionally
          // makes replacing the canonical alias with another filesystem shape
          // visible in the immutable baseline identity.
          rows.push([rel, contextAliasHash(target)]);
          continue;
        }
        throw new Error(`baseline cannot include symbolic link ${rel}`);
      }
      if (entry.isDirectory()) {
        directories.push(rel);
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      if (scanned > ARCHITECTURE_SCAN_MAX_FILES) {
        throw new Error(`baseline scan exceeds ${ARCHITECTURE_SCAN_MAX_FILES} files`);
      }
      let bytes: Buffer;
      try { bytes = fs.readFileSync(full); } catch {
        throw new Error(`baseline cannot read ${rel}`);
      }
      rows.push([rel, sha256(bytes.toString('base64'))]);
    }
  }
  rows.sort(([a], [b]) => a.localeCompare(b));
  directories.sort((a, b) => a.localeCompare(b));
  const filesHash = contractHash({ files: rows, directories });
  return {
    kind: 'file-manifest',
    identity: `files:${filesHash}`,
    capturedAt: new Date().toISOString(),
    filesHash,
    fileCount: rows.length,
    files: rows.map(([filePath, hash]) => ({ path: filePath, hash })),
    directories,
  };
}

export function captureArchitectureBaseline(
  projectRoot: string,
  _profile: CapabilityProfileV1,
  capturedAt = new Date().toISOString(),
): ArchitectureBaselineV1 {
  const head = gitHead(projectRoot);
  if (head) return { kind: 'git-head', identity: `git:${head}`, capturedAt };
  // A non-Git baseline covers the project, not only the currently detected
  // source roots. Otherwise an agent could create a new root before contract
  // compilation and have it silently treated as pre-existing debt.
  const baseline = fileManifestBaseline(projectRoot, ['.']);
  return { ...baseline, capturedAt };
}

export function architectureRunSnapshotPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'capability-v1.json');
}

export function architectureRunBaselinePath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'baseline-v1.json');
}

export function readArchitectureRunSnapshot(
  projectRoot: string,
  runId: string,
): ArchitectureRunSnapshotV1 | null {
  const raw = readJson<ArchitectureRunSnapshotV1 | null>(
    architectureRunSnapshotPath(projectRoot, runId),
    null,
  );
  if (!raw
    || raw.schemaVersion !== ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION
    || raw.runId !== runId) return null;
  const { snapshotHash: observed, ...withoutHash } = raw;
  if (!observed || contractHash(withoutHash) !== observed) return null;
  return raw;
}

export function readArchitectureRunBaseline(
  projectRoot: string,
  runId: string,
): ArchitectureRunBaselineV1 | null {
  const raw = readJson<ArchitectureRunBaselineV1 | null>(
    architectureRunBaselinePath(projectRoot, runId),
    null,
  );
  if (!raw
    || raw.schemaVersion !== ARCHITECTURE_RUN_BASELINE_SCHEMA_VERSION
    || raw.runId !== runId) return null;
  const { baselineHash: observed, ...withoutHash } = raw;
  if (!observed || contractHash(withoutHash) !== observed) return null;
  return raw;
}

export function capabilityProfileForRun(
  projectRoot: string,
  state: unknown,
): CapabilityProfileV1 {
  const runId = String(obj(state)?.currentRunId || '').trim();
  return (runId ? readArchitectureRunSnapshot(projectRoot, runId)?.profile : null)
    || capabilityProfileForProject(projectRoot, state);
}

export function capabilityStateForRun(projectRoot: string, state: unknown): Rec {
  return runtimeCapabilityStateFromProfile(capabilityProfileForRun(projectRoot, state), state);
}

/**
 * Mint-once runtime snapshot. Call this when the run id is established, before
 * any architect/implementer write. Replanning reuses it and cannot steer roots
 * by adding framework markers or editing package manifests mid-run.
 */
export function ensureArchitectureRunSnapshot(
  projectRoot: string,
  runId: string,
  state: unknown,
): ArchitectureRunSnapshotV1 {
  if (!runId || /[\\/]/.test(runId)) throw new Error('runId is invalid');
  const existing = readArchitectureRunSnapshot(projectRoot, runId);
  if (existing) {
    const baseline = readArchitectureRunBaseline(projectRoot, runId);
    if (!baseline || baseline.baselineHash !== existing.baselineHash) {
      throw new Error('immutable run baseline is missing or corrupt');
    }
    return existing;
  }
  if (fs.existsSync(architectureRunSnapshotPath(projectRoot, runId))) {
    throw new Error('immutable runtime capability snapshot is corrupt');
  }
  const capturedAt = new Date().toISOString();
  // A pre-existing compiled sidecar is not an authority: it may be stale,
  // agent-authored, or from a rolled-back runtime. Mint the immutable profile
  // and baseline only from current runtime detection at run start.
  const profile = capabilityProfileForProject(projectRoot, state);
  const baseline = captureArchitectureBaseline(projectRoot, profile, capturedAt);
  const baselineCanonical = {
    schemaVersion: ARCHITECTURE_RUN_BASELINE_SCHEMA_VERSION,
    runId,
    baseline,
  };
  const baselineSidecar: ArchitectureRunBaselineV1 = {
    ...baselineCanonical,
    baselineHash: contractHash(baselineCanonical),
  };
  const canonical = {
    schemaVersion: ARCHITECTURE_RUN_SNAPSHOT_SCHEMA_VERSION,
    runId,
    profile,
    baselineIdentity: baseline.identity,
    baselineHash: baselineSidecar.baselineHash,
    capturedAt,
  };
  const candidate: ArchitectureRunSnapshotV1 = {
    ...canonical,
    snapshotHash: contractHash(canonical),
  };

  return withProjectStateLock(projectRoot, () => {
    const raced = readArchitectureRunSnapshot(projectRoot, runId);
    if (raced) {
      const racedBaseline = readArchitectureRunBaseline(projectRoot, runId);
      if (!racedBaseline || racedBaseline.baselineHash !== raced.baselineHash) {
        throw new Error('immutable run baseline is missing or corrupt');
      }
      return raced;
    }
    if (fs.existsSync(architectureRunSnapshotPath(projectRoot, runId))) {
      throw new Error('immutable runtime capability snapshot is corrupt');
    }
    if (fs.existsSync(architectureRunBaselinePath(projectRoot, runId))) {
      throw new Error('incomplete runtime snapshot: baseline exists without capability marker');
    }
    // Publish the potentially large manifest first and the small capability
    // marker last. Hot hooks read only capability-v1.json.
    writeJson(architectureRunBaselinePath(projectRoot, runId), baselineSidecar);
    writeJson(architectureRunSnapshotPath(projectRoot, runId), candidate);
    const persisted = readArchitectureRunSnapshot(projectRoot, runId);
    const persistedBaseline = readArchitectureRunBaseline(projectRoot, runId);
    if (!persisted
      || !persistedBaseline
      || persisted.baselineHash !== persistedBaseline.baselineHash) {
      throw new Error('runtime capability snapshot could not be persisted atomically');
    }
    return persisted;
  });
}

export function architectureInputPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'architecture-input-v1.json');
}

export function compiledArchitecturePath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'architecture-v1.json');
}

export function compileArchitecture(
  projectRoot: string,
  runId: string,
  state: unknown,
  input: ArchitectureInputV1,
  baseline?: ArchitectureBaselineV1,
  frozenProfile?: CapabilityProfileV1,
): CompiledArchitectureV1 {
  const validation = validateArchitectureInput(input);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  if (!runId || /[\\/]/.test(runId)) throw new Error('runId is invalid');
  const profile = frozenProfile || capabilityProfileForProject(projectRoot, state);
  if (profile.profileId === 'unsupported-hybrid' || (profile.blockingIssues?.length || 0) > 0) {
    const issue = profile.blockingIssues?.[0];
    throw new Error(
      `[${issue?.code || 'CAPABILITY_HYBRID_UI_TARGET_REQUIRED'}] ${
        issue?.message
        || 'Architecture compilation is blocked until web-ui or native-ui is selected by runtime/user-owned state.'
      }`,
    );
  }
  const hasUi = profile.surfaces.includes('web-ui') || profile.surfaces.includes('native-ui');
  const uiOnlyModules = input.modules.filter((module) => (
    module.kind === 'app-shell' || module.kind === 'page' || module.kind === 'component'
  ));
  if (!hasUi && (input.routes.length > 0 || uiOnlyModules.length > 0)) {
    throw new Error(
      `capability profile ${profile.profileId} has no UI surface; routes/app-shell/page/component modules are unavailable`,
    );
  }
  const compiledSourceRoots = [...new Set([
    ...profile.sourceRoots,
    ...profile.layerRoots.pages,
    ...profile.layerRoots.components,
    ...profile.layerRoots.features,
    ...profile.layerRoots.lib,
  ].map((root) => normalizeRelative(root)).filter((root): root is string => Boolean(root)))];
  const compiledBaseline = baseline
    || captureArchitectureBaseline(projectRoot, { ...profile, sourceRoots: compiledSourceRoots });
  const immutablePaths = baselinePathSet(projectRoot, compiledBaseline);
  const routesByModule = new Map(input.routes.map((route) => [route.moduleId, route]));
  const modules = input.modules.map((module) => ({
    ...module,
    ownerRole: module.kind === 'test'
      ? 'senior-tester'
      : (
          ['app-shell', 'page', 'component', 'feature'].includes(module.kind)
          && hasUi
        )
          ? 'senior-frontend'
          : profile.roles.includes('senior-backend')
            ? 'senior-backend'
            : 'senior-frontend',
    output: moduleOutput(projectRoot, profile, module, routesByModule.get(module.id), immutablePaths),
  }));
  const outputById = new Map(modules.map((module) => [module.id, module.output]));
  const routes = input.routes.map((route) => ({
    ...route,
    moduleOutput: route.redirect ? '' : (outputById.get(route.moduleId) || ''),
  }));
  const entrypointCandidates = profile.entrypoints
    .map(normalizeRelative)
    .filter((entry): entry is string => Boolean(entry));
  const existingEntrypoints = entrypointCandidates.filter((entry) => immutablePaths.has(entry));
  const parentBackedEntrypoints = entrypointCandidates.filter((entry) => {
    const parent = path.posix.dirname(entry);
    return parent !== '.' && baselineContains(immutablePaths, parent);
  });
  const selectedEntrypoints = existingEntrypoints.length > 0
    ? existingEntrypoints
    : parentBackedEntrypoints.length > 0
      ? [parentBackedEntrypoints[0]!]
      : entrypointCandidates.slice(0, 1);
  const isNewProject = obj(state)?.mode === 'new-project';
  const scaffoldOutputs = resolveInitialScaffoldOwners(profile, [
    ...(isNewProject ? frontendScaffoldOutputs(profile) : []),
    ...(isNewProject ? nativeScaffoldOutputs(profile) : []),
    ...(isNewProject ? backendScaffoldOutputs(profile) : []),
    ...routeRegistrationOutputs(profile, input.routes),
    ...testerOutputs(profile, modules),
  ]);
  if (isNewProject) {
    appendUniqueScaffoldOutputs(scaffoldOutputs, repositoryScaffoldOutputs(profile));
    appendUniqueScaffoldOutputs(scaffoldOutputs, environmentScaffoldOutputs(profile));
    scaffoldOutputs.push(...workspaceManifestOutputs(scaffoldOutputs, modules));
    appendUniqueScaffoldOutputs(
      scaffoldOutputs,
      nodeToolingScaffoldOutputs(profile, scaffoldOutputs, immutablePaths),
    );
    const duplicateScaffold = scaffoldOutputs.find((output, index) => (
      scaffoldOutputs.findIndex((candidate) => candidate.path === output.path) !== index
    ));
    if (duplicateScaffold) {
      throw new Error(`compiled scaffold output ${duplicateScaffold.path} has multiple owners`);
    }
    const repositoryOwner = selectedImplementationOwner(profile);
    if (repositoryOwner) {
      for (const required of REPOSITORY_SCAFFOLD_OUTPUTS) {
        const output = scaffoldOutputs.find((candidate) => candidate.path === required);
        if (!output || output.ownerRole !== repositoryOwner) {
          throw new Error(`repository scaffold ${required} is missing its deterministic owner`);
        }
      }
    }
  }
  const inputHash = contractHash(input);
  const allowedOutputs = [...new Set([
    ...selectedEntrypoints,
    ...modules.map((module) => module.output),
    ...scaffoldOutputs.map((output) => output.path),
  ])].sort();
  const runtimeOwnedOutput = allowedOutputs.find((output) => (
    output === 'AGENTS.md'
    || output === 'CLAUDE.md'
    || output === '.traffic-one'
    || output.startsWith('.traffic-one/')
  ));
  if (runtimeOwnedOutput) {
    throw new Error(`compiled output ${runtimeOwnedOutput} is runtime/materializer-owned`);
  }
  const withoutHash = {
    schemaVersion: COMPILED_ARCHITECTURE_SCHEMA_VERSION,
    runId,
    profile,
    baseline: compiledBaseline,
    sourceRoots: compiledSourceRoots,
    entrypoints: selectedEntrypoints,
    layers: profile.layerRoots,
    routes,
    modules,
    scaffoldOutputs,
    allowedOutputs,
    exceptions: input.exceptions || [],
    inputHash,
  };
  return {
    ...withoutHash,
    contractHash: contractHash(withoutHash),
  };
}

export function compileArchitectureForRun(
  projectRoot: string,
  runId: string,
  state: unknown,
  options: { persist?: boolean } = {},
): CompiledArchitectureV1 {
  const input = readJson<ArchitectureInputV1 | null>(architectureInputPath(projectRoot, runId), null);
  if (!input) throw new Error(`missing ${path.relative(projectRoot, architectureInputPath(projectRoot, runId))}`);
  const snapshot = ensureArchitectureRunSnapshot(projectRoot, runId, state);
  const frozenBaseline = readArchitectureRunBaseline(projectRoot, runId);
  if (!frozenBaseline || frozenBaseline.baselineHash !== snapshot.baselineHash) {
    throw new Error('immutable run baseline is missing or corrupt');
  }
  const inputHash = contractHash(input);
  // Baseline is mint-once for a run. Replanning recompiles topology against the
  // same snapshot rather than silently grandfathering code written mid-run.
  const compiled = compileArchitecture(
    projectRoot,
    runId,
    state,
    input,
    frozenBaseline.baseline,
    snapshot.profile,
  );
  if (compiled.inputHash !== inputHash) throw new Error('architecture input hash mismatch');
  // persist:false lets the completion gate validate the FULL candidate set
  // before anything touches disk. A compiled sidecar persisted next to a
  // DENIED digest flips every on-disk contract check while the role bootstraps
  // still describe the pre-compile world (observed 2cl: the live architect
  // lost all tool access mid-flight and had to be respawned).
  if (options.persist !== false) writeJson(compiledArchitecturePath(projectRoot, runId), compiled);
  return compiled;
}

export function persistCompiledArchitecture(
  projectRoot: string,
  compiled: CompiledArchitectureV1,
): void {
  writeJson(compiledArchitecturePath(projectRoot, compiled.runId), compiled);
}

export function readCompiledArchitecture(
  projectRoot: string,
  runId: string,
): CompiledArchitectureV1 | null {
  const raw = readJson<CompiledArchitectureV1 | null>(compiledArchitecturePath(projectRoot, runId), null);
  if (!raw || raw.schemaVersion !== COMPILED_ARCHITECTURE_SCHEMA_VERSION || raw.runId !== runId) return null;
  const { contractHash: observed, ...withoutHash } = raw;
  if (!observed || contractHash(withoutHash) !== observed) return null;
  return raw;
}

export function runtimeAssignmentsPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'assignments.json');
}

function assignmentOutputs(
  architecture: CompiledArchitectureV1,
  role: string,
): string[] {
  const outputs = [
    ...architecture.modules
      .filter((module) => module.ownerRole === role)
      .map((module) => module.output),
    ...(role === 'senior-frontend' ? architecture.entrypoints : []),
    ...(architecture.scaffoldOutputs || [])
      .filter((output) => output.ownerRole === role)
      .map((output) => output.path),
  ];
  return [...new Set(outputs)].sort();
}

function runtimeAssignmentForRole(
  architecture: CompiledArchitectureV1,
  role: string,
): RuntimeAssignmentEntryV1 | null {
  // Runtime assignments are a closed set. Broad source/test roots would let a
  // child create outputs absent from the compiled plan and silently bypass
  // re-planning. Every writable path therefore comes from a compiled module,
  // entrypoint, scaffold, test, or test-infrastructure output.
  const include = assignmentOutputs(architecture, role);
  if (include.length === 0) return null;
  return {
    role,
    summary: role === 'senior-tester'
      ? 'Runtime-owned test and test-infrastructure outputs'
      : 'Runtime-owned compiled architecture and scaffold outputs',
    scope: {
      include,
      exclude: [],
    },
  };
}

export function buildRuntimeAssignments(
  architecture: CompiledArchitectureV1,
  verificationHash: string,
): RuntimeAssignmentsV1 {
  if (!verificationHash.trim()) throw new Error('verificationHash is required');
  const roleOrder = ['senior-frontend', 'senior-backend', 'senior-tester'];
  const assignments = roleOrder
    .filter((role) => architecture.profile.roles.includes(role))
    .map((role) => runtimeAssignmentForRole(architecture, role))
    .filter((entry): entry is RuntimeAssignmentEntryV1 => Boolean(entry));
  const canonical = {
    version: 1 as const,
    schemaVersion: 1 as const,
    runId: architecture.runId,
    createdBy: 'traffic-one-runtime' as const,
    architectureHash: architecture.contractHash,
    verificationHash,
    assignments,
  };
  return { ...canonical, assignmentsHash: contractHash(canonical) };
}

export function readRuntimeAssignments(
  projectRoot: string,
  runId: string,
): RuntimeAssignmentsV1 | null {
  const raw = readJson<RuntimeAssignmentsV1 | null>(runtimeAssignmentsPath(projectRoot, runId), null);
  if (!raw
    || raw.version !== 1
    || raw.schemaVersion !== 1
    || raw.runId !== runId
    || raw.createdBy !== 'traffic-one-runtime'
    || !Array.isArray(raw.assignments)
    || typeof raw.assignmentsHash !== 'string') return null;
  const { assignmentsHash: observed, ...canonical } = raw;
  if (contractHash(canonical) !== observed) return null;
  const architecture = readCompiledArchitecture(projectRoot, runId);
  if (!architecture
    || architecture.contractHash !== raw.architectureHash
    || !raw.verificationHash) return null;
  const verification = readJson<Record<string, unknown> | null>(
    path.join(projectRoot, MEMORY_DIR, 'runs', runId, 'verification-v2.json'),
    null,
  );
  if (!verification
    || verification.schemaVersion !== 2
    || verification.runId !== runId
    || verification.architectureHash !== architecture.contractHash
    || typeof verification.contractHash !== 'string') return null;
  const { contractHash: observedVerificationHash, ...verificationCanonical } = verification;
  if (contractHash(verificationCanonical) !== observedVerificationHash
    || raw.verificationHash !== observedVerificationHash) return null;
  const expected = buildRuntimeAssignments(architecture, observedVerificationHash);
  if (stableContractJson(raw) !== stableContractJson(expected)) return null;
  for (const assignment of raw.assignments) {
    if (!assignment
      || !architecture.profile.roles.includes(assignment.role)
      || !assignment.scope
      || !Array.isArray(assignment.scope.include)
      || assignment.scope.include.length === 0
      || !assignment.scope.include.every((entry) => typeof entry === 'string' && Boolean(normalizeRelative(entry)))
      || !Array.isArray(assignment.scope.exclude)
      || !assignment.scope.exclude.every((entry) => typeof entry === 'string' && Boolean(normalizeRelative(entry)))) {
      return null;
    }
  }
  return raw;
}

export function publishRuntimeAssignments(
  projectRoot: string,
  architecture: CompiledArchitectureV1,
  verificationHash: string,
): RuntimeAssignmentsV1 {
  const candidate = buildRuntimeAssignments(architecture, verificationHash);
  return withProjectStateLock(projectRoot, () => {
    writeJson(runtimeAssignmentsPath(projectRoot, architecture.runId), candidate);
    const persisted = readRuntimeAssignments(projectRoot, architecture.runId);
    if (!persisted || persisted.assignmentsHash !== candidate.assignmentsHash) {
      throw new Error('runtime assignments could not be persisted atomically');
    }
    return persisted;
  });
}

export function validateArchitectureAllowlist(
  contract: CompiledArchitectureV1,
  include: string[],
): string[] {
  return contract.allowedOutputs.filter((output) => !include.some((pattern) => matchesPattern(output, pattern)));
}

export function createWorkUnitContract(input: Omit<WorkUnitContractV1, 'schemaVersion' | 'contractHash'>): WorkUnitContractV1 {
  if (!input.trafficOneRole.trim()) throw new Error('trafficOneRole must be non-null');
  if (!input.runId.trim() || !input.unitId.trim()) throw new Error('runId and unitId are required');
  const canonical = {
    schemaVersion: WORK_UNIT_CONTRACT_SCHEMA_VERSION,
    ...input,
    rules: [...input.rules].sort((a, b) => a.id.localeCompare(b.id)),
    skills: [...input.skills].sort((a, b) => a.id.localeCompare(b.id)),
    outputs: [...new Set(input.outputs)].sort(),
    allowlist: [...new Set(input.allowlist)].sort(),
    allowlistExclude: [...new Set(input.allowlistExclude)].sort(),
  };
  const missing = canonical.outputs.filter((output) => (
    !canonical.allowlist.some((pattern) => matchesPattern(output, pattern))
    || canonical.allowlistExclude.some((pattern) => matchesPattern(output, pattern))
  ));
  if (missing.length) throw new Error(`allowlist does not cover: ${missing.join(', ')}`);
  return { ...canonical, contractHash: contractHash(canonical) };
}

export function validateWorkUnitContract(value: unknown): value is WorkUnitContractV1 {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<WorkUnitContractV1>;
  if (raw.schemaVersion !== WORK_UNIT_CONTRACT_SCHEMA_VERSION
    || typeof raw.runId !== 'string'
    || typeof raw.unitId !== 'string'
    || typeof raw.trafficOneRole !== 'string'
    || (raw.hostAgentType !== null && typeof raw.hostAgentType !== 'string')
    || !Array.isArray(raw.rules)
    || !Array.isArray(raw.skills)
    || !Array.isArray(raw.outputs)
    || !Array.isArray(raw.allowlist)
    || !Array.isArray(raw.allowlistExclude)
    || typeof raw.architectureHash !== 'string'
    || typeof raw.verificationHash !== 'string'
    || typeof raw.contractHash !== 'string'
    || !raw.rules.every((entry) => (
      entry && typeof entry.id === 'string' && typeof entry.contentHash === 'string'
    ))
    || !raw.skills.every((entry) => (
      entry && typeof entry.id === 'string' && typeof entry.contentHash === 'string'
    ))
    || !raw.outputs.every((entry) => typeof entry === 'string')
    || !raw.allowlist.every((entry) => typeof entry === 'string')
    || !raw.allowlistExclude.every((entry) => typeof entry === 'string')) return false;
  try {
    const rebuilt = createWorkUnitContract({
      runId: raw.runId,
      unitId: raw.unitId,
      trafficOneRole: raw.trafficOneRole,
      hostAgentType: raw.hostAgentType,
      rules: raw.rules,
      skills: raw.skills,
      outputs: raw.outputs,
      allowlist: raw.allowlist,
      allowlistExclude: raw.allowlistExclude,
      architectureHash: raw.architectureHash,
      verificationHash: raw.verificationHash,
    });
    return stableContractJson(rebuilt) === stableContractJson(raw);
  } catch {
    return false;
  }
}

export function architectureInputFromUnknown(value: unknown): ArchitectureInputV1 | null {
  const validation = validateArchitectureInput(value);
  if (!validation.ok) return null;
  return value as ArchitectureInputV1;
}

export function legacyCustomBackendMigration(
  projectRoot: string,
  state: unknown,
): { state: Rec; changed: boolean; ambiguous: boolean; message?: string } {
  const current = obj(state) || {};
  if (current.stack !== 'custom-backend' || current.frontend !== 'react-vite') {
    return { state: current, changed: false, ambiguous: false };
  }

  const currentRunId = typeof current.currentRunId === 'string'
    ? current.currentRunId.trim()
    : typeof current.currentRunId === 'number' && Number.isFinite(current.currentRunId)
      ? String(Math.trunc(current.currentRunId))
      : '';
  if (currentRunId) {
    const runRoot = path.join(projectRoot, MEMORY_DIR, 'runs', currentRunId);
    const settlementFile = path.join(runRoot, 'settlement-v2.json');
    const ledgerFile = path.join(runRoot, 'run.json');
    let lifecycleStatus = '';
    let lifecycleValid = false;
    if (fs.existsSync(settlementFile)) {
      const raw = readJson<Rec | null>(settlementFile, null);
      if (raw
        && raw.schemaVersion === 2
        && raw.runId === currentRunId
        && typeof raw.status === 'string'
        && typeof raw.runtimeVersion === 'string'
        && typeof raw.minimumRuntimeVersion === 'string'
        && Number.isInteger(raw.activeClaims)
        && Number(raw.activeClaims) >= 0
        && Array.isArray(raw.incompleteChecks)
        && raw.incompleteChecks.every((item) => typeof item === 'string')
        && Number.isInteger(raw.revision)
        && Number(raw.revision) >= 1
        && typeof raw.updatedAt === 'string'
        && typeof raw.settlementHash === 'string') {
        const { settlementHash: observed, ...canonical } = raw;
        if (contractHash(canonical) === observed) {
          lifecycleStatus = raw.status;
          lifecycleValid = [
            'planned', 'active', 'code-delivered', 'validating',
            'verified', 'failed', 'blocked',
          ].includes(lifecycleStatus);
          const fallback = obj(raw.fallback);
          if (fallback && !['pending', 'completed', 'not-allowed'].includes(String(fallback.state))) {
            lifecycleValid = false;
          }
          if (lifecycleStatus === 'verified' && (
            Number(raw.activeClaims) > 0
            || raw.incompleteChecks.length > 0
            || fallback?.state === 'pending'
          )) lifecycleValid = false;
        }
      }
    } else if (fs.existsSync(ledgerFile)) {
      const raw = readJson<Rec | null>(ledgerFile, null);
      const rawRunId = typeof raw?.runId === 'string'
        ? raw.runId
        : typeof raw?.runId === 'number' && Number.isFinite(raw.runId)
          ? String(Math.trunc(raw.runId))
          : '';
      if (raw
        && rawRunId === currentRunId
        && typeof raw.status === 'string'
        && ['planned', 'active', 'completed', 'failed', 'blocked'].includes(raw.status)) {
        lifecycleStatus = effectiveLegacyRunStatus(raw);
        lifecycleValid = [
          'planned', 'active', 'completed', 'failed', 'blocked',
        ].includes(lifecycleStatus);
      }
    }
    if (!lifecycleValid) {
      return {
        state: current,
        changed: false,
        ambiguous: true,
        message: 'current run lifecycle evidence is missing or corrupt; migration is fail-closed',
      };
    }
    if (!['verified', 'completed', 'failed', 'blocked'].includes(lifecycleStatus)) {
      return {
        state: current,
        changed: false,
        ambiguous: true,
        message: `current run is ${lifecycleStatus}; migration is forbidden mid-run`,
      };
    }
  }

  const frontend = detectFrontendFramework(projectRoot, current);
  if (frontend.hasWebUi) {
    return {
      state: current,
      changed: false,
      ambiguous: true,
      message: `frontend evidence exists (${frontend.evidence.join(', ') || frontend.frontend}); doctor confirmation is required`,
    };
  }
  return { state: { ...current, frontend: 'none' }, changed: true, ambiguous: false };
}
