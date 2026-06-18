// src/shared/detection/index.ts
// Project mode + stack detection from package.json / workspace files / prompt
// text. Read-only. Ported 1:1 from scripts/hook-runtime/detection/*.

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

export function workspaceYamlPresent(cwd: string): boolean {
  return fs.existsSync(path.join(cwd, 'pnpm-workspace.yaml')) || fs.existsSync(path.join(cwd, 'pnpm-workspace.yml'));
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
function includesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function detectFrontendFromText(text: string): string | null {
  if (/\b(next\.?js|nextjs)\b/.test(text)) return 'nextjs';
  if (/\bvue\b|\bnuxt\b/.test(text)) return 'vue';
  if (/\bsvelte\b|\bsveltekit\b/.test(text)) return 'svelte';
  if (/\bangular\b/.test(text)) return 'angular';
  if (/\bastro\b/.test(text)) return 'astro';
  if (/\bsolid\b/.test(text)) return 'solid';
  if (/\bremix\b/.test(text)) return 'remix';
  if (/\breact\b|\bvite\b/.test(text)) return 'react-vite';
  return null;
}

function detectBackendFromText(text: string): string | null {
  if (/\bsupabase\b/.test(text)) return 'supabase';
  if (/\bfirebase\b|\bfirestore\b/.test(text)) return 'firebase';
  if (/\bmongo(db)?\b/.test(text)) return 'mongo';
  if (/\bnest(js)?\b/.test(text)) return 'nestjs';
  if (/\bfastapi\b/.test(text)) return 'fastapi';
  if (/\bdjango\b/.test(text)) return 'django';
  if (/\bpython\b/.test(text)) return 'python';
  if (/\bgolang\b|\bgo backend\b|\bgo api\b/.test(text)) return 'go';
  if (/\brust\b/.test(text)) return 'rust';
  if (/\bspring\b|\bspring boot\b/.test(text)) return 'java';
  if (/\bkotlin\b|\bktor\b/.test(text)) return 'kotlin';
  if (/\blaravel\b/.test(text)) return 'laravel';
  if (/\bphp\b/.test(text)) return 'php';
  if (/\b\.net\b|\bdotnet\b|\bc#\b/.test(text)) return 'dotnet';
  if (/\bnode\b|\bexpress\b|\btypescript backend\b/.test(text)) return 'node';
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

function detectMobileFromText(text: string): MobileDetection {
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

export function detectStackFromCodebase(cwd: string): StackDetection {
  const out: StackDetection = { stack: null, backend: null, frontend: null, realtime: null, evidence: [] };

  const deps = dependenciesFromPackage(loadPackageJson(cwd));
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    out.stack = 'custom-backend';
    out.backend = 'go';
    out.frontend = 'none';
    out.evidence.push('go.mod detected → apply Go backend skills');
  }

  if (Object.keys(deps).length === 0) return out;

  const isNative = Boolean(deps.expo || deps['react-native']);
  const isReact = Boolean(deps.react);
  const frameworkDetections = [
    { frontend: 'nextjs', matches: Boolean(deps.next), evidence: 'next in deps → apply custom-frontend stack + Next.js provider-first recommendations' },
    { frontend: 'vue', matches: Boolean(deps.vue || deps.nuxt || deps['@vitejs/plugin-vue']), evidence: 'vue/nuxt in deps → apply custom-frontend stack + Vue-native patterns' },
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

  if (!out.backend && out.stack === 'custom-backend' && out.frontend === 'react-vite') {
    out.backend = 'none';
  }

  if (deps['socket.io-client'] || deps['socket.io'] || deps.ws) {
    out.realtime = 'light';
    out.evidence.push('websocket lib detected');
  }

  return out;
}

export interface PromptClassification {
  stack: string;
  frontend: string;
  backend: string;
  mobile: { enabled: boolean; framework: string; source: string };
  shouldAskMobile: boolean;
  evidence: {
    frontend: string | null;
    backend: string | null;
    mobileIntentDetected: boolean;
    backendNeed: boolean;
    wantsMinimal: boolean;
  };
}

export function classifyPromptForStack(prompt: unknown): PromptClassification {
  const text = String(prompt || '').toLowerCase();
  const frontend = detectFrontendFromText(text);
  const backend = detectBackendFromText(text);
  const mobile = detectMobileFromText(text);
  const wantsMinimal = includesAny(text, [
    /\blanding page\b/, /\bpresentation\b/, /\bbrochure\b/, /\bportfolio\b/,
    /\bone[- ]page\b/, /\bstatic\b/, /\bsimple website\b/,
  ]);
  const backendNeed = includesAny(text, [
    /\bauth\b/, /\blogin\b/, /\bsign ?up\b/, /\busers?\b/, /\bprofiles?\b/,
    /\bcrud\b/, /\bdatabase\b/, /\bdb\b/, /\bbackend\b/, /\bapi\b/,
    /\buploads?\b/, /\bfiles?\b/, /\brealtime\b/, /\breal[- ]time\b/,
    /\bdashboard\b/, /\badmin\b/, /\bpayments?\b/, /\bmarketplace\b/,
    /\bsaas\b/, /\bmvp\b/, /\bplatform\b/, /\bapp\b/,
  ]);
  const explicitCustomFrontend = Boolean(frontend && frontend !== 'react-vite');
  const explicitCustomBackend = Boolean(backend && backend !== 'supabase' && backend !== 'none');
  const noBackend = backend === 'none';

  let resolvedFrontend = frontend || 'react-vite';
  let resolvedBackend = backend || (backendNeed || mobile.enabled ? 'supabase' : 'none');
  let stack: string;

  if (wantsMinimal && !backendNeed && !frontend && !mobile.enabled) {
    stack = 'minimal';
    resolvedFrontend = 'none';
    resolvedBackend = 'none';
  } else if (mobile.enabled && !frontend) {
    stack = explicitCustomBackend ? 'custom-stack' : 'custom-frontend';
    resolvedFrontend = mobile.framework === 'ionic-capacitor' ? 'react-vite' : 'none';
    resolvedBackend = resolvedBackend === 'none' ? 'supabase' : resolvedBackend;
  } else if (explicitCustomFrontend && explicitCustomBackend) {
    stack = 'custom-stack';
  } else if (explicitCustomFrontend) {
    stack = 'custom-frontend';
    resolvedBackend = resolvedBackend === 'none' ? 'supabase' : resolvedBackend;
  } else if (explicitCustomBackend || noBackend) {
    stack = 'custom-backend';
  } else if (backendNeed) {
    stack = 'default';
  } else if (frontend === 'react-vite') {
    stack = resolvedBackend === 'none' ? 'custom-backend' : 'default';
  } else {
    stack = 'minimal';
    resolvedFrontend = 'none';
    resolvedBackend = 'none';
  }

  return {
    stack,
    frontend: resolvedFrontend,
    backend: resolvedBackend,
    mobile: { enabled: mobile.enabled, framework: mobile.framework, source: mobile.source },
    shouldAskMobile: stack !== 'minimal',
    evidence: {
      frontend: frontend || null,
      backend: backend || null,
      mobileIntentDetected: mobile.intentDetected,
      backendNeed,
      wantsMinimal,
    },
  };
}

// Deterministic coding-intent heuristic. Used only to suppress PREMATURE Traffic
// One activation: on a brand-new project with no active wizard, a clearly
// non-coding prompt (greeting, question, chit-chat) should not kick off setup.
// Biased toward `true` (false positives merely activate a beat early); the moment
// state exists, a wizard is running, or a tool is attempted, the normal path runs
// regardless — so an active project is never mis-skipped.
const CODING_INTENT_PATTERNS: RegExp[] = [
  /\b(build|create|make|add|implement|scaffold|generate|set ?up|develop|write|wire|integrate|configure|deploy|ship|fix|refactor|debug|optimi[sz]e|migrate|test|lint|typecheck|install|update|upgrade|rename|delete|remove|extract|split)\b/,
  /\b(app|application|web ?app|website|site|landing page|page|route|screen|view|component|feature|module|api|endpoint|backend|frontend|server|client|database|db|schema|table|migration|query|auth|login|signup|dashboard|form|button|modal|chart|service|function|hook|store|repo|repository|codebase|project|monorepo|package|library|dependency|bug|error|stack ?trace|test|ci|pipeline)\b/,
  /\b(react|vite|next\.?js|vue|svelte|angular|astro|solid|remix|supabase|postgres|mysql|mongo|firebase|tailwind|typescript|javascript|node|python|django|express|stripe|expo|capacitor|ionic|playwright|vitest|jest|docker|kubernetes|graphql|rest)\b/,
  /[`{}();]|=>|\bnpm\b|\bpnpm\b|\byarn\b|\bgit\b|\.(ts|tsx|js|jsx|py|go|rs|sql|json|md)\b/,
];

export function isLikelyCodingPrompt(prompt: unknown): boolean {
  const text = String(prompt || '').toLowerCase().trim();
  if (!text) return false;
  return CODING_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

// True when the prompt carries an explicit STACK signal — i.e. it reads as a real
// project description even without an imperative coding verb. Derived from
// classifyPromptForStack so there is ONE keyword source of truth (its backendNeed /
// frontend / backend / mobile / wantsMinimal evidence) rather than a parallel list
// that drifts out of sync with isLikelyCodingPrompt. The coding-intent gate uses
// this to AVOID dropping a verb-less first prompt like "a marketplace for
// freelancers": dropping it loses the genuine project description, and a later thin
// "ok build it" then becomes the seeded originalPrompt and derives `minimal`. A pure
// greeting/question ("hi there") has no stack signal, so the gate still suppresses it.
export function promptHasStackSignal(prompt: unknown): boolean {
  const text = String(prompt || '').toLowerCase().trim();
  if (!text) return false;
  const { evidence } = classifyPromptForStack(text);
  return Boolean(
    evidence.backendNeed
    || evidence.frontend
    || evidence.backend
    || evidence.mobileIntentDetected
    || evidence.wantsMinimal,
  );
}

// Broader edit-intent patterns for POST-BUILD MAINTENANCE: once the app exists, the
// bar for "this is an edit request" is lower than the onboarding coding-intent bar.
// Copy tweaks ("change the hero headline"), restyles ("shorten the title", "move the
// footer"), and other imperative edits use verbs/nouns the coding-intent heuristic
// omits, so they would otherwise skip post-build triage entirely.
const EDIT_INTENT_PATTERNS: RegExp[] = [
  /\b(chang\w+|tweak|adjust|reword|rewrit\w+|replac\w+|swap|shorten|lengthen|expand|moves?|moving|relocat\w+|hide|hidden|show|reveal|increas\w+|decreas\w+|bump|drop|switch|toggl\w+|reorder|re-?order|align|cent(er|re)\w*|resiz\w+|restyl\w+|re-?colou?r|recolou?r|tighten|loosen|capitali[sz]\w+|bold|italici[sz]\w+|underlin\w+|uppercase|lowercase|shrink|enlarge|nudge|polish|simplif\w+|trim|truncat\w+|tidy|cleanup|clean up)\b/,
  /\b(headlines?|hero|sub[- ]?headlines?|sub[- ]?titles?|taglines?|titles?|headings?|copy|wording|labels?|captions?|placeholders?|colou?rs?|fonts?|font[- ]?sizes?|spacing|paddings?|margins?|banners?|footers?|headers?|nav(bar|igation)?|menus?|tooltips?|paragraphs?|sentences?|texts?|wordings?|icons?|logos?|images?|spinners?|badges?|tabs?)\b/,
];

// True when a maintenance-phase prompt looks like an edit/work request (a superset
// of isLikelyCodingPrompt). Used to gate post-build triage so trivial copy/UI edits
// route through it; biased toward firing (a stray directive on a read prompt is
// cheap, a missed directive on an edit is the bug this guards against).
export function isLikelyEditRequest(prompt: unknown): boolean {
  const text = String(prompt || '').toLowerCase().trim();
  if (!text) return false;
  if (isLikelyCodingPrompt(text)) return true;
  return EDIT_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}
