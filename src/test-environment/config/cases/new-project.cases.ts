// new-project.cases.ts — host-e2e (opt-in via --e2e). Onboarding is pre-completed
// (headless can't run the wizard), then a build prompt exercises the plugin.

import type { Case } from '../../core/types';

export const NEW_PROJECT_CASES: Case[] = [
  {
    id: 'np-backend-frontend',
    category: 'new-project',
    layer: 'host-e2e',
    fixture: 'empty',
    preSeed: {
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced', team: { mode: 'subagents', approved: true },
      openCode: false, codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: 'A task tracker with a list page, an add form, and Supabase persistence' },
    },
    prompt: 'Build a small task tracker: a list page showing tasks and a form to add a task, backed by Supabase. Keep it minimal but working.',
    assertions: [
      { id: 'onboarding-complete' },
      { id: 'materialized-assets' },
      { id: 'digests-terminal' },
      { id: 'run-manifest-roles' },
      { id: 'feature-files-present', params: { anyOf: ['src/App.tsx', 'src/app.tsx', 'src/main.tsx', 'index.html'] } },
    ],
  },
  {
    id: 'np-frontend-only',
    category: 'new-project',
    layer: 'host-e2e',
    fixture: 'empty',
    preSeed: {
      mode: 'new-project', stack: 'custom-frontend', frontend: 'react-vite', backend: 'none',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced', team: { mode: 'subagents', approved: true },
      openCode: false, codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: 'A static marketing landing page with hero and pricing sections' },
    },
    prompt: 'Build a static landing page with a hero section and a pricing section. Frontend only, no backend.',
    assertions: [
      { id: 'onboarding-complete' },
      { id: 'materialized-assets' },
      { id: 'feature-files-present', params: { anyOf: ['src/App.tsx', 'src/app.tsx', 'src/main.tsx', 'index.html'] } },
    ],
  },
  {
    id: 'np-nonrecommended-stack',
    category: 'new-project',
    layer: 'host-e2e',
    fixture: 'empty',
    preSeed: {
      // Non-recommended stack: Vue frontend + Node backend instead of the default
      // react-vite + supabase. Verifies the harness honours an explicit choice.
      mode: 'new-project', stack: 'custom-stack', frontend: 'vue', backend: 'node',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced', team: { mode: 'subagents', approved: true },
      openCode: false, codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: 'A Vue + Node notes app' },
    },
    prompt: 'Build a small notes app. Use the configured stack (Vue frontend, Node backend).',
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'materialized-assets' },
    ],
    notes: 'Confirms a non-default frontend/backend selection is persisted and respected.',
  },
];
