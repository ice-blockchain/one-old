// src/shared/detection/artifacts.ts
// Package/workspace/source-file detection primitives.

import * as fs from 'fs';
import * as path from 'path';
import { readJson } from '../fsjson';

type Rec = Record<string, unknown>;

export function loadPackageJson(cwd: string): Rec {
  return readJson<Rec>(path.join(cwd, 'package.json'), {});
}

export function dependenciesFromPackage(pkg: unknown): Rec {
  const p = pkg && typeof pkg === 'object' ? (pkg as Rec) : {};
  const deps = p.dependencies && typeof p.dependencies === 'object' ? (p.dependencies as Rec) : {};
  const dev = p.devDependencies && typeof p.devDependencies === 'object' ? (p.devDependencies as Rec) : {};
  return { ...deps, ...dev };
}

export function hasWorkspaces(pkg: unknown): boolean {
  const p = pkg && typeof pkg === 'object' ? (pkg as Rec) : {};
  return Boolean(p.workspaces) || Object.prototype.hasOwnProperty.call(p, 'pnpm');
}


export const SOURCE_EXTS = new Set([
  '.tsx', '.ts', '.jsx', '.js', '.vue', '.svelte',
  '.go', '.rs', '.py', '.java', '.kt', '.kts', '.cs', '.php', '.rb',
  '.swift', '.dart', '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp',
]);

export function countSourceFiles(cwd: string): number {
  let count = 0;
  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name))) count += 1;
    }
  }
  walk(cwd);
  return count;
}

export function detectMode(cwd: string): string {
  const deps = dependenciesFromPackage(loadPackageJson(cwd));
  const fileCount = countSourceFiles(cwd);
  if (fileCount <= 5) return 'new-project';
  if (deps['@supabase/supabase-js'] || deps['@supabase/ssr']) return 'existing-with-supabase';
  return 'existing-codebase';
}

// ── text classification ──────────────────────────────────────────────────────
export function includesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function detectFrontendFromText(text: string): string | null {
  // Every framework accepts the glued/dotted "js" spelling ("vuejs", "vue.js"):
  // \bvue\b alone never matches "vuejs" (no word boundary before a word char),
  // and a real run derived frontend `other` from "use laravel with vuejs" (8cl).
  if (/\b(next\.?js|nextjs)\b/.test(text)) return 'nextjs';
  if (/\bnuxt(?:\.?js)?\b/.test(text)) return 'nuxt';
  if (/\bvue(?:\.?js)?\b/.test(text)) return 'vue';
  if (/\bsvelte(?:\.?js)?\b|\bsveltekit\b/.test(text)) return 'svelte';
  if (/\bangular(?:\.?js)?\b/.test(text)) return 'angular';
  if (/\bastro\b/.test(text)) return 'astro';
  if (/\bsolid(?:\.?js)?\b/.test(text)) return 'solid';
  if (/\bremix(?:\.?js)?\b/.test(text)) return 'remix';
  if (/\breact(?:\.?js)?\b|\bvite(?:\.?js)?\b/.test(text)) return 'react-vite';
  return null;
}

function hasBackendLanguagePhrase(text: string, terms: readonly string[]): boolean {
  // Plural + microservice forms included: "microservices in go" is a natural
  // API-project phrasing that the singular noun set missed (observed while
  // fixing 13c — the prompt fell back to supabase/default).
  const backendNoun = '(?:backend|apis?|servers?|(?:micro)?services?)';
  return terms.some((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\ /g, '\\s+');
    return [
      new RegExp(`\\b${escaped}\\s+(?:as\\s+)?${backendNoun}\\b`),
      new RegExp(`\\b${backendNoun}\\s+(?:in|with|using|as)\\s+${escaped}\\b`),
      new RegExp(`\\b${backendNoun}\\s+(?:(?:is|was|should\\s+be|to\\s+be)\\s+)?(?:written|built|implemented)\\s+in\\s+${escaped}\\b`),
    ].some((pattern) => pattern.test(text));
  });
}

export function detectBackendFromText(text: string): string | null {
  if (/\bsupabase\b/.test(text)) return 'supabase';
  if (/\bfirebase\b|\bfirestore\b/.test(text)) return 'firebase';
  if (/\bmongo(db)?\b/.test(text)) return 'mongo';
  if (/\bnest(js)?\b/.test(text)) return 'nestjs';
  if (/\bfastapi\b/.test(text)) return 'fastapi';
  if (/\bdjango\b/.test(text)) return 'django';
  if (hasBackendLanguagePhrase(text, ['python']) || /\bpython backend\b/.test(text)) return 'python';
  if (/\bgolang\b/.test(text) || hasBackendLanguagePhrase(text, ['go'])) return 'go';
  if (hasBackendLanguagePhrase(text, ['rust'])) return 'rust';
  if (/\bspring\b|\bspring ?boot\b/.test(text) || hasBackendLanguagePhrase(text, ['java'])) return 'java';
  if (/\bktor\b/.test(text) || hasBackendLanguagePhrase(text, ['kotlin'])) return 'kotlin';
  if (/\blaravel\b/.test(text)) return 'laravel';
  if (hasBackendLanguagePhrase(text, ['php'])) return 'php';
  if (/\b\.net\b|\bdotnet\b|\bc#\b/.test(text) || hasBackendLanguagePhrase(text, ['dotnet', '.net', 'c#'])) return 'dotnet';
  if (/\bexpress(?:\.?js)?\b|\btypescript backend\b/.test(text) || hasBackendLanguagePhrase(text, ['node', 'node.js', 'nodejs', 'typescript'])) return 'node';
  if (/\bown api\b|\bexisting api\b|\bexternal api\b/.test(text)) return 'external-api';
  if (/\bno backend\b|\bfrontend[- ]only\b|\bstatic only\b/.test(text)) return 'none';
  return null;
}

interface MobileDetection {
  enabled: boolean;
  framework: string;
  source: string;
  intentDetected: boolean;
}

export function detectMobileFromText(text: string): MobileDetection {
  const hasMobileIntent = includesAny(text, [
    /\bmobile app\b/, /\bios\b/, /\bandroid\b/, /\bapp store\b/, /\bplay store\b/,
    /\bcapacitor\b/, /\bionic\b/, /\breact native\b/, /\bexpo\b/, /\brn\b/,
  ]);
  if (!hasMobileIntent) return { enabled: false, framework: 'none', source: 'none', intentDetected: false };
  if (/\breact native\b|\bexpo\b|\brn\b/.test(text)) {
    return { enabled: true, framework: 'react-native-expo', source: 'explicit', intentDetected: true };
  }
  return { enabled: true, framework: 'ionic-capacitor', source: 'explicit', intentDetected: true };
}

export interface StackDetection {
  stack: string | null;
  backend: string | null;
  frontend: string | null;
  realtime: string | null;
  evidence: string[];
  mobile?: { enabled: boolean; framework: string; source: string };
}

// Exported for the agent-classification path: the agent submits SURFACES
// (frontend/backend/mobile/realtime) and this single rule derives the stack id —
// the agent never picks a stack id directly, so both classification paths share
// one derivation.
export function classifyDetectedSurfaces(out: StackDetection): void {
  const hasWebUi = Boolean(out.frontend && out.frontend !== 'none');
  const hasNativeUi = Boolean(out.mobile?.enabled && out.mobile.framework !== 'none');
  const hasBackend = Boolean(out.backend && out.backend !== 'none');
  if (hasWebUi && out.frontend === 'react-vite' && out.backend === 'supabase' && !hasNativeUi) {
    out.stack = 'default';
  } else if ((hasWebUi || hasNativeUi) && hasBackend) {
    out.stack = 'custom-stack';
  } else if (hasWebUi || hasNativeUi) {
    out.stack = 'custom-frontend';
  } else if (hasBackend) {
    out.stack = 'custom-backend';
  }
}

export function detectStackFromCodebase(cwd: string): StackDetection {
  const out: StackDetection = { stack: null, backend: null, frontend: null, realtime: null, evidence: [] };

  const deps = dependenciesFromPackage(loadPackageJson(cwd));
  const composer = readJson<Rec>(path.join(cwd, 'composer.json'), {});
  const composerDeps = {
    ...(composer.require && typeof composer.require === 'object' ? composer.require as Rec : {}),
    ...(composer['require-dev'] && typeof composer['require-dev'] === 'object' ? composer['require-dev'] as Rec : {}),
  };
  if (detectGoBackendArtifacts(cwd)) {
    out.stack = 'custom-backend';
    out.backend = 'go';
    out.frontend = deps.react || deps.vite ? 'react-vite' : 'none';
    out.evidence.push('Go backend artifacts detected → apply Go backend skills');
  }

  if (fs.existsSync(path.join(cwd, 'pubspec.yaml'))) {
    out.stack = 'custom-frontend';
    out.frontend = 'none';
    out.mobile = { enabled: true, framework: 'flutter', source: 'explicit' };
    out.evidence.push('Flutter pubspec detected');
  } else if (
    fs.existsSync(path.join(cwd, 'Package.swift'))
    || (() => {
      try {
        return fs.readdirSync(cwd, { withFileTypes: true }).some((entry) => (
          entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcworkspace')
        ));
      } catch {
        return false;
      }
    })()
  ) {
    out.stack = 'custom-frontend';
    out.frontend = 'none';
    out.mobile = { enabled: true, framework: 'swift-native', source: 'explicit' };
    out.evidence.push('Swift/Xcode project detected');
  } else if (
    fs.existsSync(path.join(cwd, 'settings.gradle'))
    || fs.existsSync(path.join(cwd, 'settings.gradle.kts'))
    || fs.existsSync(path.join(cwd, 'app', 'build.gradle'))
    || fs.existsSync(path.join(cwd, 'app', 'build.gradle.kts'))
  ) {
    out.stack = 'custom-frontend';
    out.frontend = 'none';
    out.mobile = { enabled: true, framework: 'kotlin-android', source: 'explicit' };
    out.evidence.push('Android/Gradle project detected');
  }

  if (composerDeps['laravel/framework']) {
    out.stack = 'custom-backend';
    out.backend = 'laravel';
    const hasLaravelUi = fs.existsSync(path.join(cwd, 'resources', 'views'))
      || fs.existsSync(path.join(cwd, 'resources', 'js'))
      || Boolean(composerDeps['inertiajs/inertia-laravel']);
    out.frontend = hasLaravelUi ? 'other' : 'none';
    out.evidence.push(hasLaravelUi ? 'Laravel UI artifacts detected' : 'Laravel API-only project detected');
  }

  if (Object.keys(deps).length === 0) {
    classifyDetectedSurfaces(out);
    return out;
  }

  const isNative = Boolean(deps.expo || deps['react-native']);
  const isReact = Boolean(deps.react);
  const frameworkDetections = [
    { frontend: 'nextjs', matches: Boolean(deps.next), evidence: 'next in deps → apply custom-frontend stack + Next.js provider-first recommendations' },
    { frontend: 'nuxt', matches: Boolean(deps.nuxt), evidence: 'nuxt in deps → apply custom-frontend stack + Nuxt patterns' },
    { frontend: 'vue', matches: Boolean(deps.vue || deps['@vitejs/plugin-vue']), evidence: 'vue in deps → apply custom-frontend stack + Vue-native patterns' },
    { frontend: 'svelte', matches: Boolean(deps.svelte || deps['@sveltejs/kit']), evidence: 'svelte/sveltekit in deps → apply custom-frontend stack + Svelte-native patterns' },
    { frontend: 'angular', matches: Boolean(deps['@angular/core'] || deps['@angular/cli']), evidence: 'angular in deps → apply custom-frontend stack + Angular-native patterns' },
    { frontend: 'astro', matches: Boolean(deps.astro), evidence: 'astro in deps → apply custom-frontend stack + Astro-native patterns' },
    { frontend: 'solid', matches: Boolean(deps['solid-js'] || deps['@solidjs/start']), evidence: 'solid in deps → apply custom-frontend stack + Solid-native patterns' },
    { frontend: 'remix', matches: Boolean(deps['@remix-run/react'] || deps['@remix-run/node'] || deps['@remix-run/dev']), evidence: 'remix in deps → apply custom-frontend stack + Remix-native patterns' },
    { frontend: 'gatsby', matches: Boolean(deps.gatsby), evidence: 'gatsby in deps → apply custom-frontend stack + Gatsby-native patterns' },
    { frontend: 'qwik', matches: Boolean(deps['@builder.io/qwik'] || deps['@builder.io/qwik-city']), evidence: 'qwik in deps → apply custom-frontend stack + Qwik-native patterns' },
    { frontend: 'preact', matches: Boolean(deps.preact), evidence: 'preact in deps → apply custom-frontend stack + Preact-native patterns' },
    { frontend: 'lit', matches: Boolean(deps.lit || deps['lit-html'] || deps['lit-element']), evidence: 'lit in deps → apply custom-frontend stack + Lit-native patterns' },
    { frontend: 'ember', matches: Boolean(deps['ember-source'] || deps['ember-cli']), evidence: 'ember in deps → apply custom-frontend stack + Ember-native patterns' },
    { frontend: 'alpine', matches: Boolean(deps.alpinejs), evidence: 'alpinejs in deps → apply custom-frontend stack + Alpine-native patterns' },
    { frontend: 'stencil', matches: Boolean(deps['@stencil/core']), evidence: 'stencil in deps → apply custom-frontend stack + Stencil-native patterns' },
    { frontend: 'marko', matches: Boolean(deps.marko), evidence: 'marko in deps → apply custom-frontend stack + Marko-native patterns' },
  ];
  const detected = frameworkDetections.find((candidate) => candidate.matches);

  if (detected) {
    out.stack = 'custom-frontend';
    out.frontend = detected.frontend;
    out.evidence.push(detected.evidence);
  } else if (isNative) {
    out.stack = 'custom-frontend';
    out.frontend = 'none';
    out.mobile = { enabled: true, framework: 'react-native-expo', source: 'explicit' };
    out.evidence.push('react-native/expo in deps');
  } else if (isReact) {
    out.stack = deps['@supabase/supabase-js'] || deps['@supabase/ssr'] ? 'default' : 'custom-backend';
    out.frontend = 'react-vite';
    out.evidence.push('react in deps');
  }

  if (deps['@supabase/supabase-js'] || deps['@supabase/ssr']) {
    out.backend = 'supabase';
    out.evidence.push('supabase detected → recommend our fork once');
  } else if (deps.firebase || deps['firebase-admin']) {
    out.backend = 'firebase';
    out.evidence.push('firebase detected');
  }

  if (!out.backend && out.frontend === 'react-vite') {
    out.backend = 'none';
  }

  if (deps['socket.io-client'] || deps['socket.io'] || deps.ws) {
    out.realtime = 'light';
    out.evidence.push('websocket lib detected');
  }

  classifyDetectedSurfaces(out);
  return out;
}

export function detectGoBackendArtifacts(cwd: string): boolean {
  const candidates = [
    cwd,
    path.join(cwd, 'services', 'api'),
    path.join(cwd, 'apps', 'api'),
    path.join(cwd, 'backend'),
  ];
  return candidates.some((dir) => fs.existsSync(path.join(dir, 'go.mod')) || fs.existsSync(path.join(dir, 'go.work')));
}

