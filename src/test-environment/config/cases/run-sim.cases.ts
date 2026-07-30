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
