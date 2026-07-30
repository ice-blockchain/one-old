// src/shared/capabilities/profiles-web.ts
// The per-framework web profile table.

import {
  type CapabilityProfileV1,
} from './types';
import {
  exists,
} from './fs-probe';
import { frameworkWebRoot, laravelInertiaKind, nuxtSourceRoot } from './web-roots';
import { prefixed } from './fs-probe';

export function frontendProfile(
  frontend: string,
  cwd: string,
  preferredWebRoot?: string,
  configuredFrontend?: string | null,
): Pick<
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
    const inertia = laravelInertiaKind(cwd, configuredFrontend);
    const webRoot = preferredWebRoot || '.';
    const at = (rel: string): string => prefixed(webRoot, rel);
    const sourceRoots = inertia
      ? [at('resources/js'), at('resources/views')]
      : [at('resources/views'), at('resources/js')];
    const pages = inertia
      ? [at('resources/js/Pages'), at('resources/js/pages'), at('resources/views')]
      : [at('resources/views'), at('resources/js/Pages'), at('resources/js/pages')];
    const components = inertia
      ? [at('resources/js/Components'), at('resources/js/components'), at('resources/views/components')]
      : [at('resources/views/components'), at('resources/js/Components'), at('resources/js/components')];
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
      entrypoints: inertia === 'react'
        ? [at('resources/js/app.tsx'), at('resources/js/app.ts'), at('resources/js/app.js')]
        : [at('resources/js/app.ts'), at('resources/js/app.js')],
      layerRoots: {
        pages,
        components,
        features: [at('resources/js/Features'), at('resources/js/features')],
        lib: [at('resources/js/lib'), at('app/View')],
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
