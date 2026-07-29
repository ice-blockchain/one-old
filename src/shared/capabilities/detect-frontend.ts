// src/shared/capabilities/detect-frontend.ts
// Frontend framework detection from dependencies and artifacts.

import * as fs from 'fs';
import * as path from 'path';
import { obj, type Rec } from '../obj';

import {
  composerPackages,
  exists,
  packageDependencies,
  stringField,
  prefixed,
  candidateWebRoots,
} from './fs-probe';

interface FrontendFrameworkDetectionV1 {
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

