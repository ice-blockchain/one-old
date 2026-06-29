// project-lifecycle.cases.ts — host-e2e (opt-in). Maintain a project that was
// "made with the plugin": pre-completed onboarding + a built skeleton, then a
// new-feature prompt and a text-edit prompt.

import type { Case } from '../../core/types';

const LIFECYCLE_SEED = {
  mode: 'existing-codebase' as const,
  stack: 'default', frontend: 'react-vite', backend: 'supabase',
  mobile: { enabled: false, framework: 'none' as const },
  performance: 'balanced' as const, team: { mode: 'subagents' as const, approved: true },
  openCode: false, codeGraphProvider: 'gitnexus' as const,
};

export const PROJECT_LIFECYCLE_CASES: Case[] = [
  {
    id: 'lc-new-feature',
    category: 'project-lifecycle',
    layer: 'host-e2e',
    fixture: 'existing-react-vite',
    preSeed: LIFECYCLE_SEED,
    prompt: 'Add a Settings page with a dark-mode toggle. Wire it into the app routing.',
    assertions: [
      { id: 'onboarding-complete' },
      { id: 'materialized-assets' },
      { id: 'feature-files-present', params: { anyOf: ['src/pages/Settings.tsx', 'src/Settings.tsx', 'src/components/Settings.tsx'] } },
    ],
  },
  {
    id: 'lc-text-edit',
    category: 'project-lifecycle',
    layer: 'host-e2e',
    fixture: 'existing-react-vite',
    preSeed: LIFECYCLE_SEED,
    prompt: "Change the homepage heading text to 'Welcome to Acme'. Only the copy — no other changes.",
    assertions: [
      { id: 'onboarding-complete' },
      { id: 'feature-files-present', params: { contains: [{ path: 'src/App.tsx', text: 'Welcome to Acme' }] } },
    ],
    notes: 'Small copy edit — exercises the maintenance/quick-fix path.',
  },
];
