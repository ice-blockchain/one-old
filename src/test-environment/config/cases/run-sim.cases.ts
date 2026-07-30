// run-sim.cases.ts
// Deterministic full-run simulations: onboarding is pre-completed, then scripted
// role writes drive the REAL post-onboarding chain (plan-write gate → PLAN_READY
// transaction → implement → QA → settlement). No host CLI, no LLM, no spend.
//
// A case declares SEMANTICS only. Compiled output paths are born inside the
// PLAN_READY transaction, so nothing here may name one — the driver reads them
// back from the published assignments instead.

import type { Case } from '../../core/types';

// The user briefs these shapes simulate. Kept verbatim: the whole point is that
// a real request walks the chain, not a synthetic one shaped to pass.
export const BRIEF_LEARNING =
  'create a modern learning platform with courses for web development. '
  + 'use latest tech, make it responsive. no admin area for now.';

export const BRIEF_API =
  'i want an api project with products listing, products info, news listing and info';

export const BRIEF_AGENCY =
  'create a modern agency presentation website. one landing page with projects '
  + 'listing, latest news, reviews.';

// The learning-platform architecture, reused by every full-stack web shape. The
// COMPILED paths differ per framework — that is the point — but the semantics
// the architect declares do not.
const LEARNING_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [
    { id: 'home-route', path: '/', moduleId: 'home' },
    { id: 'courses-route', path: '/courses', moduleId: 'courses' },
    { id: 'course-detail-route', path: '/courses/:slug', moduleId: 'course-detail' },
    { id: 'login-route', path: '/login', moduleId: 'login' },
  ],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' as const },
    { id: 'home', name: 'Home', kind: 'page' as const },
    { id: 'courses', name: 'Courses', kind: 'page' as const },
    { id: 'course-detail', name: 'Course Detail', kind: 'page' as const },
    { id: 'login', name: 'Login', kind: 'page' as const },
    { id: 'course-card', name: 'Course Card', kind: 'component' as const },
    { id: 'auth', name: 'Auth', kind: 'feature' as const },
    { id: 'courses-api', name: 'Courses API', kind: 'service' as const },
  ],
};

// The agency site: a single landing page. Deliberately one route — it guards the
// opposite failure from the learning platform, that a legitimately single-page
// app is not flagged by the structural rules that replaced the retired
// multi-page/inline-page heuristics.
const AGENCY_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [{ id: 'home-route', path: '/', moduleId: 'home' }],
  modules: [
    { id: 'app-shell', name: 'App', kind: 'app-shell' as const },
    { id: 'home', name: 'Home', kind: 'page' as const },
    { id: 'project-card', name: 'Project Card', kind: 'component' as const },
    { id: 'review-card', name: 'Review Card', kind: 'component' as const },
  ],
};

// api-only: no routes, no web surface.
const API_ARCHITECTURE = {
  schemaVersion: 1 as const,
  routes: [],
  modules: [
    { id: 'products-service', name: 'Products Service', kind: 'service' as const },
    { id: 'news-service', name: 'News Service', kind: 'service' as const },
    { id: 'store', name: 'Store', kind: 'store' as const },
  ],
};

const WEB_QA = {
  mode: 'browser' as const,
  expectChecks: {
    'stack-build': 'passed' as const,
    'playwright-local': 'passed' as const,
    'dom-assertions': 'passed' as const,
    actions: 'passed' as const,
    routing: 'passed' as const,
    hydration: 'passed' as const,
    'console-errors': 'passed' as const,
    'network-errors': 'passed' as const,
    'responsive-screenshots': 'passed' as const,
  },
};

const WEB_ASSERTIONS = [
  { id: 'state-matches-selection' },
  { id: 'onboarding-complete' },
  { id: 'run-sim-clean' },
  { id: 'run-sim-plan-ready-artifacts' },
  { id: 'run-sim-qa-evidence' },
  { id: 'run-sim-settlement' },
];

export const RUN_SIM_CASES: Case[] = [
  {
    id: 'sim-new-react-vite-supabase',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_LEARNING },
    },
    runSim: {
      brief: BRIEF_LEARNING,
      architecture: {
        schemaVersion: 1,
        routes: [
          { id: 'home-route', path: '/', moduleId: 'home' },
          { id: 'courses-route', path: '/courses', moduleId: 'courses' },
          { id: 'course-detail-route', path: '/courses/:slug', moduleId: 'course-detail' },
          { id: 'lesson-route', path: '/courses/:slug/lessons/:lessonId', moduleId: 'lesson' },
          { id: 'login-route', path: '/login', moduleId: 'login' },
        ],
        modules: [
          { id: 'app-shell', name: 'App', kind: 'app-shell' },
          { id: 'home', name: 'Home', kind: 'page' },
          { id: 'courses', name: 'Courses', kind: 'page' },
          { id: 'course-detail', name: 'Course Detail', kind: 'page' },
          { id: 'lesson', name: 'Lesson', kind: 'page' },
          { id: 'login', name: 'Login', kind: 'page' },
          { id: 'course-card', name: 'Course Card', kind: 'component' },
          { id: 'lesson-list', name: 'Lesson List', kind: 'component' },
          { id: 'auth', name: 'Auth', kind: 'feature' },
          { id: 'courses-api', name: 'Courses API', kind: 'service' },
        ],
      },
      // Greenfield web shapes compile to uiImpact 'visual' (every planned page
      // is absent from the baseline), so the contract requires real browser
      // evidence. The assertion cross-checks this declaration against the
      // PUBLISHED contract.browserRequired — a shape can never quietly slide
      // onto the cheap `stack` path.
      qa: {
        mode: 'browser',
        expectChecks: {
          'stack-build': 'passed',
          'playwright-local': 'passed',
          'dom-assertions': 'passed',
          actions: 'passed',
          routing: 'passed',
          hydration: 'passed',
          'console-errors': 'passed',
          'network-errors': 'passed',
          'responsive-screenshots': 'passed',
        },
      },
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'run-sim-clean' },
      { id: 'run-sim-plan-ready-artifacts' },
      { id: 'run-sim-qa-evidence' },
      { id: 'run-sim-settlement' },
    ],
    notes: 'Shape 1: default stack, React/Vite + Supabase, with auth. The reference shape.',
  },
  {
    id: 'sim-new-nextjs-supabase',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'custom-frontend',
      frontend: 'nextjs',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_LEARNING },
    },
    runSim: { brief: BRIEF_LEARNING, architecture: LEARNING_ARCHITECTURE, qa: WEB_QA },
    assertions: WEB_ASSERTIONS,
    notes: 'Shape 4: Next.js + Supabase, with auth. App-router layout and its own scaffold table.',
  },
  {
    id: 'sim-new-nuxt-nobackend',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      // NOT 'custom-backend': detect-frontend suppresses the configured-frontend
      // fallback for that id (it means "React frontend, bring your own backend"),
      // which compiles a backend-only profile and rejects the routes.
      stack: 'custom-frontend',
      frontend: 'nuxt',
      backend: 'none',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_AGENCY },
    },
    runSim: { brief: BRIEF_AGENCY, architecture: AGENCY_ARCHITECTURE, qa: WEB_QA },
    assertions: WEB_ASSERTIONS,
    notes: 'Shape 3: Nuxt, no backend. Also the single-page guard, and the profile whose build output (.output/public) builtAppIdentities had to learn.',
  },
  {
    id: 'sim-new-vue-go-api',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'custom-stack',
      frontend: 'vue',
      backend: 'go',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_LEARNING },
    },
    runSim: { brief: BRIEF_LEARNING, architecture: LEARNING_ARCHITECTURE, qa: WEB_QA },
    assertions: WEB_ASSERTIONS,
    notes: 'Shape 5: Vue SPA with a Go API backend — two languages in one run.',
  },
  {
    id: 'sim-new-unsupported-framework',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'custom-frontend',
      // Qwik is not in FRONTEND_IDS and state validation REJECTS unknown values,
      // which would make materialization incomplete. `other` is the escape hatch
      // onboarding offers, and it compiles to the generic-web profile. The brief
      // names the framework the user actually asked for.
      frontend: 'other',
      backend: 'none',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: `${BRIEF_AGENCY} use qwik.` },
    },
    runSim: { brief: `${BRIEF_AGENCY} use qwik.`, architecture: AGENCY_ARCHITECTURE, qa: WEB_QA },
    assertions: WEB_ASSERTIONS,
    notes: 'Shape 6: a framework Traffic One does not model. Characterises the CURRENT contract — degrade to generic-web and still settle — so any future change to that behaviour is deliberate.',
  },
  {
    id: 'sim-new-python-api',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'python',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_API },
    },
    runSim: {
      brief: BRIEF_API,
      architecture: API_ARCHITECTURE,
      qa: {
        mode: 'stack',
        // All three run for real: byte-compile, pytest, ruff. validateQaReportV2
        // refuses a justified `not-applicable` for stack-build ("a backend that
        // does not build is broken"), and byte-compiling IS Python's build — it
        // is what turns source into the artifact the interpreter runs, and it
        // fails on a syntax error anywhere in the tree. Pinned so a shape can
        // never quietly settle on checks that did not execute.
        expectChecks: {
          'stack-build': 'passed',
          'stack-test': 'passed',
          'stack-lint': 'passed',
        },
      },
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'run-sim-clean' },
      { id: 'run-sim-plan-ready-artifacts' },
      { id: 'run-sim-qa-evidence' },
      { id: 'run-sim-settlement' },
    ],
    notes: 'Shape 8: Python API only. Requires pytest + ruff on PATH; stack-build is legitimately not-applicable.',
  },
  {
    id: 'sim-new-go-api',
    category: 'run-sim',
    layer: 'run-sim',
    fixture: 'empty-git',
    preSeed: {
      mode: 'new-project',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true },
      openCode: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: BRIEF_API },
    },
    runSim: {
      brief: BRIEF_API,
      architecture: {
        schemaVersion: 1,
        // No web surface: an API-only project has no routes to compile.
        routes: [],
        modules: [
          { id: 'products-service', name: 'Products Service', kind: 'service' },
          { id: 'news-service', name: 'News Service', kind: 'service' },
          { id: 'store', name: 'Store', kind: 'store' },
        ],
      },
      // No web-ui surface → uiImpact 'none' → requiredChecks are the stack
      // trio, which the `stack` runner produces for real. This is the shape
      // that was UNFINISHABLE before the v1 batch added that runner: the
      // checks had no producer, so validateQaReportV2 rejected every report
      // and settlement could never close.
      qa: {
        mode: 'stack',
        // Pinned, because stackReportStatus returns `passed` whenever nothing
        // FAILED — an all-`not-applicable` report would otherwise read as a
        // pass. Go has a canonical form for all three.
        expectChecks: {
          'stack-build': 'passed',
          'stack-test': 'passed',
          'stack-lint': 'passed',
        },
      },
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'run-sim-clean' },
      { id: 'run-sim-plan-ready-artifacts' },
      { id: 'run-sim-qa-evidence' },
      { id: 'run-sim-settlement' },
    ],
    notes: 'Shape 7: Go API only. Requires `go` on PATH; the qa-evidence assertion reports INCONCLUSIVE rather than passing if the toolchain is missing.',
  },
];
