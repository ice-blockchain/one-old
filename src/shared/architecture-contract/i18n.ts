// Semantic i18n resolution: locale/namespace policy and deterministic
// framework-native catalog/runtime outputs. No filesystem reads live here.

import type { CapabilityProfileV1 } from '../capabilities';

import {
  type ArchitectureInputV1,
  type ArchitectureModuleInputV1,
  type ArchitectureRouteInputV1,
  type CompiledArchitectureOutputV1,
  type CompiledI18nCatalogV1,
  type CompiledI18nContractV1,
} from './types';
import {
  normalizeRelative,
} from './core';
import {
  webPackageRoot,
} from './scaffold';

const REACT_PROFILE_IDS = new Set([
  'vite-react',
  'next-app',
  'next-pages',
  'react-native',
]);

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function joined(root: string, suffix: string): string {
  return root === '.' || !root ? suffix : `${root.replace(/\/+$/, '')}/${suffix}`;
}

function firstRoot(profile: CapabilityProfileV1, fallback: string): string {
  return profile.sourceRoots
    .map((candidate) => normalizeRelative(candidate))
    .find((candidate): candidate is string => Boolean(candidate))
    || fallback;
}

function rootBefore(root: string, suffix: RegExp): string {
  return root.replace(suffix, '') || '.';
}

export function profileHasUi(profile: CapabilityProfileV1): boolean {
  if (profile.architectureTarget === 'web-ui') return profile.surfaces.includes('web-ui');
  if (profile.architectureTarget === 'native-ui') return profile.surfaces.includes('native-ui');
  return profile.surfaces.includes('web-ui') || profile.surfaces.includes('native-ui');
}

export function profileUsesReactI18n(profile: CapabilityProfileV1): boolean {
  return REACT_PROFILE_IDS.has(profile.profileId)
    || profile.router === 'inertia-react-router'
    || /\breact\b/i.test(profile.framework);
}

function namespaceId(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

export function architectureI18nNamespaces(
  modules: readonly ArchitectureModuleInputV1[],
  routes: readonly ArchitectureRouteInputV1[],
): string[] {
  const routeByModule = new Map(
    routes
      .filter((route) => route.redirect !== true)
      .map((route) => [route.moduleId, route] as const),
  );
  const namespaces = ['common'];
  for (const module of modules) {
    if (module.kind === 'page') {
      const routeId = routeByModule.get(module.id)?.id || module.id;
      namespaces.push(namespaceId(routeId, 'common'));
    } else if (module.kind === 'feature') {
      namespaces.push(namespaceId(module.id, 'common'));
    }
  }
  return unique(namespaces).sort((a, b) => (
    a === 'common' ? -1 : b === 'common' ? 1 : a.localeCompare(b)
  ));
}

function reactCatalogRoot(
  profile: CapabilityProfileV1,
  selectedEntrypoints: readonly string[],
): string {
  if (profile.profileId === 'vite-react') return 'packages/i18n/src/locales';
  if (profile.profileId === 'next-app' || profile.profileId === 'next-pages') {
    const entrypoint = selectedEntrypoints[0] || profile.entrypoints[0] || '';
    const sourceRoot = entrypoint.replace(/(?:^|\/)(?:app\/layout|pages\/_app)\.tsx$/, '');
    return joined(sourceRoot || '.', 'i18n/locales');
  }
  if (profile.profileId === 'react-native') {
    const sourceRoot = profile.sourceRoots
      .map((candidate) => normalizeRelative(candidate))
      .find((candidate): candidate is string => Boolean(
        candidate && (candidate === 'src' || candidate.endsWith('/src')),
      ))
      || 'src';
    return joined(sourceRoot, 'i18n/locales');
  }
  if (profile.router === 'inertia-react-router') return 'resources/js/i18n/locales';
  return joined(firstRoot(profile, 'src'), 'i18n/locales');
}

function reactRuntimeOutputs(profile: CapabilityProfileV1, catalogRoot: string): string[] {
  if (profile.profileId === 'vite-react') {
    return ['packages/i18n/package.json', 'packages/i18n/src/index.ts'];
  }
  return [`${catalogRoot.replace(/\/locales$/, '')}/index.ts`];
}

function jsonPerNamespace(
  root: string,
  locales: readonly string[],
  namespaces: readonly string[],
): CompiledI18nCatalogV1[] {
  return locales.flatMap((locale) => namespaces.map((namespace) => ({
    path: `${root}/${locale}/${namespace}.json`,
    format: 'json' as const,
    locales: [locale],
    namespaces: [namespace],
  })));
}

function jsonPerLocale(
  root: string,
  locales: readonly string[],
  namespaces: readonly string[],
): CompiledI18nCatalogV1[] {
  return locales.map((locale) => ({
    path: `${root}/${locale}.json`,
    format: 'json' as const,
    locales: [locale],
    namespaces: [...namespaces],
  }));
}

function frameworkCatalogs(
  profile: CapabilityProfileV1,
  locales: readonly string[],
  namespaces: readonly string[],
  selectedEntrypoints: readonly string[],
): Pick<CompiledI18nContractV1, 'reactCatalogLayout' | 'catalogs' | 'runtimeOutputs'> {
  if (profileUsesReactI18n(profile)) {
    const root = reactCatalogRoot(profile, selectedEntrypoints);
    return {
      reactCatalogLayout: true,
      catalogs: jsonPerNamespace(root, locales, namespaces),
      runtimeOutputs: reactRuntimeOutputs(profile, root),
    };
  }

  const sourceRoot = firstRoot(profile, 'src');
  if (profile.profileId === 'nuxt') {
    const root = joined(webPackageRoot(profile), 'i18n/locales');
    return { reactCatalogLayout: false, catalogs: jsonPerLocale(root, locales, namespaces), runtimeOutputs: [] };
  }
  if (profile.profileId === 'vue') {
    return {
      reactCatalogLayout: false,
      catalogs: jsonPerLocale(`${sourceRoot}/locales`, locales, namespaces),
      runtimeOutputs: [`${sourceRoot}/i18n.ts`],
    };
  }
  if (profile.profileId === 'svelte' || profile.profileId === 'sveltekit') {
    return {
      reactCatalogLayout: false,
      catalogs: jsonPerLocale(`${sourceRoot}/lib/i18n`, locales, namespaces),
      runtimeOutputs: [`${sourceRoot}/lib/i18n/index.ts`],
    };
  }
  if (profile.profileId === 'astro') {
    return {
      reactCatalogLayout: false,
      catalogs: jsonPerLocale(`${sourceRoot}/i18n`, locales, namespaces),
      runtimeOutputs: [`${sourceRoot}/i18n/index.ts`],
    };
  }
  if (profile.profileId === 'angular') {
    const root = rootBefore(sourceRoot, /\/src\/app$|^src\/app$/);
    return {
      reactCatalogLayout: false,
      catalogs: locales.map((locale) => ({
        path: joined(root, `src/locale/messages.${locale}.xlf`),
        format: 'xlf',
        locales: [locale],
        namespaces: [...namespaces],
      })),
      runtimeOutputs: [],
    };
  }
  if (profile.profileId === 'server-rendered' && profile.framework === 'laravel') {
    return {
      reactCatalogLayout: false,
      catalogs: locales.flatMap((locale) => namespaces.map((namespace) => ({
        path: `lang/${locale}/${namespace}.php`,
        format: 'php' as const,
        locales: [locale],
        namespaces: [namespace],
      }))),
      runtimeOutputs: [],
    };
  }
  if (profile.profileId === 'swift-native') {
    const nativeRoot = rootBefore(sourceRoot, /\/(?:Sources|App)$|^(?:Sources|App)$/);
    return {
      reactCatalogLayout: false,
      catalogs: [{
        path: joined(nativeRoot, 'Localizable.xcstrings'),
        format: 'xcstrings',
        locales: [...locales],
        namespaces: [...namespaces],
      }],
      runtimeOutputs: [],
    };
  }
  if (profile.profileId === 'kotlin-native') {
    const appRoot = rootBefore(sourceRoot, /\/src\/main$/);
    const catalogs = locales.map((locale, index) => ({
      path: `${appRoot}/src/main/res/${index === 0 ? 'values' : `values-${locale.toLowerCase()}`}/strings.xml`,
      format: 'android-xml' as const,
      locales: [locale],
      namespaces: [...namespaces],
    }));
    return { reactCatalogLayout: false, catalogs, runtimeOutputs: [] };
  }
  if (profile.profileId === 'flutter-native') {
    return {
      reactCatalogLayout: false,
      catalogs: locales.map((locale) => ({
        path: `${sourceRoot}/l10n/app_${locale.replace(/-/g, '_')}.arb`,
        format: 'arb' as const,
        locales: [locale],
        namespaces: [...namespaces],
      })),
      runtimeOutputs: ['l10n.yaml'],
    };
  }
  return {
    reactCatalogLayout: false,
    catalogs: jsonPerLocale(`${sourceRoot}/locales`, locales, namespaces),
    runtimeOutputs: [`${sourceRoot}/i18n.ts`],
  };
}

export function resolveArchitectureI18n(
  profile: CapabilityProfileV1,
  input: ArchitectureInputV1,
  enabledByDefault: boolean,
  selectedEntrypoints: readonly string[] = [],
): CompiledI18nContractV1 | undefined {
  if (!profileHasUi(profile) || (!enabledByDefault && !input.i18n)) return undefined;
  const sourceLocale = input.i18n?.sourceLocale.trim() || 'en';
  const locales = unique((input.i18n?.locales || [sourceLocale]).map((locale) => locale.trim()));
  const literalBrands = unique((input.i18n?.literalBrands || []).map((brand) => brand.trim()));
  const namespaces = architectureI18nNamespaces(input.modules, input.routes);
  const framework = frameworkCatalogs(profile, locales, namespaces, selectedEntrypoints);
  return {
    sourceLocale,
    locales,
    literalBrands,
    namespaces,
    ...framework,
  };
}

export function i18nScaffoldOutputs(
  i18n: CompiledI18nContractV1 | undefined,
): CompiledArchitectureOutputV1[] {
  if (!i18n) return [];
  return unique([
    ...i18n.runtimeOutputs,
    ...i18n.catalogs.map((catalog) => catalog.path),
  ]).map((output) => ({
    path: output,
    ownerRole: 'senior-frontend',
    kind: 'scaffold' as const,
  }));
}
