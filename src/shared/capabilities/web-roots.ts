// src/shared/capabilities/web-roots.ts
// Web-root resolution across workspace layouts.

import * as fs from 'fs';
import * as path from 'path';

import {
  composerPackages,
  exists,
  packageDependencies,
  prefixed,
  candidateWebRoots,
} from './fs-probe';
import {
  detectFrontendFramework,
} from './detect-frontend';

export function frontendArtifactsPresent(cwd: string): boolean {
  return detectFrontendFramework(cwd, {}).hasWebUi;
}




export function frameworkWebRoot(cwd: string, dependency: string, markers: string[]): string {
  const roots = candidateWebRoots(cwd);
  const withMarkers = roots.filter((root) => markers.some((marker) => exists(cwd, prefixed(root, marker))));
  const exact = withMarkers.find((root) => dependency && Boolean(packageDependencies(cwd, root)[dependency]));
  if (exact) return exact;
  if (withMarkers.length > 0) return withMarkers[0]!;
  return roots.find((root) => dependency && Boolean(packageDependencies(cwd, root)[dependency]))
    || roots.find((root) => root !== '.')
    || '.';
}

export function nuxtSourceRoot(cwd: string, webRoot: string): string {
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

export function laravelInertiaKind(cwd: string): 'react' | 'vue' | 'unknown' | null {
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

