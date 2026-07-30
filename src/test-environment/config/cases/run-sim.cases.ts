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
      qa: { mode: 'browser' },
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'run-sim-plan-ready-artifacts' },
    ],
    notes: 'Shape 1: default stack, React/Vite + Supabase, with auth. The reference shape.',
  },
];
