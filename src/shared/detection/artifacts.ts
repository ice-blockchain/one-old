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

// Unbounded, measured on this checkout (macOS/APFS, warm cache, node 26.5,
// median of 5–7 runs) against a 150ms hook budget:
//
//   this repo, 1,541 source files / 521 dirs .............   9.2 ms
//   20,000 source files ..................................  19.3 ms
//   300,000 source files ................................. 290.4 ms
//   200,000 NON-source files, returning 0 ................ 164.0 ms
//   24,000 empty directories, returning 0 ................ 465.6 ms
//   5,000 files under node_modules .......................   0.1 ms (skipped)
//   a symlink cycle ......................................   0.1 ms
//
// Three things follow, and the first two rule out the obvious bound.
//
// The cost does not track the RESULT: the 200k-file tree and the 24k-directory
// tree are the two slowest shapes and both return 0, so a cap on the count
// never fires on the trees that are actually slow.
//
// It does not track entries alone either. Opening a directory measured 16–19µs
// against 0.4µs per entry — ~45x — so 24,000 empty directories cost 465ms while
// visiting only 24,000 entries. An entry budget on its own leaves that case
// unbounded, which is how the first cut of this bound was wrong. Both are
// charged.
//
// 2,048 directories measured at 51ms worst case across those trees — a third of
// the budget, and 4x this repo's 521. 25,000 entries adds ~10ms. The pairing is
// what bounds the walk; either alone does not. (2,048 is also what the claim
// scan settled on, for the same reason: it is where a directory walk stops
// being free.)
//
// Neither is a substitute for `stopAfter`, which is what keeps the common case
// cheap: `detectMode` over this repo went 9.2ms → 0.1ms by stopping at the
// sixth source file. The budgets only decide what a pathological tree costs.
export const SOURCE_SCAN_ENTRY_BUDGET = 25_000;
export const SOURCE_SCAN_DIRECTORY_BUDGET = 2_048;

export interface SourceScanOptions {
  entryBudget?: number;
  directoryBudget?: number;
  /**
   * Stop as soon as the count EXCEEDS this. Every caller compares the result
   * against a small threshold rather than using the total, and a scan that
   * stops at `threshold + 1` answers those questions identically for a fraction
   * of the walk. Not a bound: the answer is complete, just not the arithmetic.
   */
  stopAfter?: number;
}

export interface SourceFileScan {
  /** When `truncated`, this is a FLOOR on the real total, never the total. */
  count: number;
  truncated: boolean;
  entriesVisited: number;
  directoriesOpened: number;
}

/**
 * Bounded source-file walk. `countSourceFiles` below still hands back a bare
 * number because every caller today compares it against a small threshold — but
 * a budget can stop the walk early, and a partial count returned as if it were
 * a total is exactly the failure a bound introduces, so `truncated` says which
 * one this is and callers that care can ask.
 *
 * Symlinks are not followed, and were not before this bound either:
 * `Dirent.isDirectory()` reports the LINK's type, not its target's, so a cycle
 * costs one entry instead of hanging. Measured (0.1ms) and pinned by a test —
 * the hang this bound is often assumed to prevent was never reachable.
 */
export function scanSourceFiles(cwd: string, options: SourceScanOptions = {}): SourceFileScan {
  const entryBudget = options.entryBudget ?? SOURCE_SCAN_ENTRY_BUDGET;
  const directoryBudget = options.directoryBudget ?? SOURCE_SCAN_DIRECTORY_BUDGET;
  const stopAfter = options.stopAfter ?? Infinity;
  let count = 0;
  let entriesVisited = 0;
  let directoriesOpened = 0;
  let truncated = false;
  // Level by level, counting every file at the current depth before opening any
  // directory below it. Depth-first recursion made truncation arbitrary: which
  // files survived the budget depended on readdir order, so a project whose own
  // sources sit beside a vendored tree could truncate to 0 and tell
  // `webAppHoldsSource` there is nothing here to orphan. Breadth-first makes the
  // partial count a floor that fills from the top of the tree down, which is
  // where a project's own code is.
  const queue: string[] = [cwd];
  while (queue.length > 0 && !truncated) {
    if (directoriesOpened >= directoryBudget) {
      truncated = true;
      break;
    }
    const currentDir = queue.shift() as string;
    let entries: fs.Dirent[];
    directoriesOpened += 1;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const subdirectories: string[] = [];
    for (const entry of entries) {
      entriesVisited += 1;
      if (entriesVisited > entryBudget) {
        truncated = true;
        break;
      }
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        subdirectories.push(path.join(currentDir, entry.name));
        continue;
      }
      if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name))) {
        count += 1;
        // The answer is already decided; anything further is unpaid-for work.
        // NOT a truncation: `count` has passed the caller's threshold, which is
        // the whole of what it asked.
        if (count > stopAfter) return { count, truncated, entriesVisited, directoriesOpened };
      }
    }
    queue.push(...subdirectories);
  }
  return { count, truncated, entriesVisited, directoriesOpened };
}

export function countSourceFiles(cwd: string): number {
  return scanSourceFiles(cwd).count;
}

export function detectMode(cwd: string): string {
  const deps = dependenciesFromPackage(loadPackageJson(cwd));
  // Only the ≤5 comparison is used, so the walk stops at the sixth source file.
  const fileCount = scanSourceFiles(cwd, { stopAfter: 5 }).count;
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
  /**
   * Frameworks the manifests name that this probe cannot choose between. A
   * non-empty list forces `stack` to null: "two of these and I cannot tell" is
   * not a stack, and every downstream gate reads a stack id as settled fact.
   */
  ambiguous?: string[];
}

// Exported for the agent-classification path: the agent submits SURFACES
// (frontend/backend/mobile/realtime) and this single rule derives the stack id —
// the agent never picks a stack id directly, so both classification paths share
// one derivation.
export function classifyDetectedSurfaces(out: StackDetection): void {
  // An unresolved disagreement is not a stack. Deriving one anyway would pick a
  // winner by array order and hand it downstream as a settled id — and a stack
  // id is indistinguishable from one the user chose, so nothing later reopens
  // it. Null routes the project to the agent-classification step that already
  // exists for "the tables saw nothing", which is the same honest answer.
  if (out.ambiguous && out.ambiguous.length > 0) {
    out.stack = null;
    return;
  }
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

// Which frameworks a match RULES OUT as competitors, because depending on them
// is how the outer framework works rather than a sign of a second app. Only
// relationships that hold by construction belong here: a Nuxt app always pulls
// vue, an Astro app pulls whichever UI library its integrations render, a
// Remix/Gatsby app pulls react. Two frameworks that merely often appear
// together are NOT subsumption — they are the disagreement this table exists to
// leave visible.
const FRONTEND_SUBSUMES: Record<string, readonly string[]> = {
  nextjs: ['react-vite'],
  nuxt: ['vue'],
  remix: ['react-vite'],
  gatsby: ['react-vite'],
  astro: ['vue', 'svelte', 'solid', 'preact', 'lit', 'react-vite'],
};

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
  // `.find()` used to answer this, which meant the array's own order silently
  // decided every multi-framework repo. Measured before the subsumption table
  // below existed: `astro` + `@astrojs/vue` + `vue` detected `vue`, and
  // `astro` + `@astrojs/svelte` + `svelte` detected `svelte`, while
  // `astro` + `react` and `astro` + `solid-js` correctly detected `astro` — the
  // difference was nothing but each candidate's index. Embedding another
  // framework's components is Astro's headline feature, so those are ordinary
  // Astro projects that were being classified as the framework they embed.
  //
  // A meta-framework's own dependency on the UI library it renders is evidence
  // FOR it, not a competitor. Anything left over after subsumption is a real
  // disagreement.
  const matched = frameworkDetections.filter((candidate) => candidate.matches);
  const subsumed = new Set(matched.flatMap((candidate) => FRONTEND_SUBSUMES[candidate.frontend] || []));
  const contenders = matched.filter((candidate) => !subsumed.has(candidate.frontend));
  const detected = contenders.length === 1 ? contenders[0] : undefined;

  if (contenders.length > 1) {
    out.ambiguous = contenders.map((candidate) => candidate.frontend);
    out.frontend = null;
    out.evidence.push(
      `competing frontend frameworks in the manifests (${out.ambiguous.join(', ')}) → no stack derived; ask instead of guessing`,
    );
  } else if (detected) {
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

