// existing-project.cases.ts — host-e2e (opt-in). A pre-existing codebase NOT
// made by the plugin: onboarding is pre-completed in existing-codebase mode,
// then a new-feature and a small text-edit prompt.

import type { Case } from '../../core/types';

const EXISTING_SEED = {
  mode: 'existing-codebase' as const,
  stack: 'default', frontend: 'react-vite', backend: 'supabase',
  mobile: { enabled: false, framework: 'none' as const },
  performance: 'balanced' as const, team: { mode: 'subagents' as const, approved: true },
  openCode: false, codeGraphProvider: 'gitnexus' as const,
};

export const EXISTING_PROJECT_CASES: Case[] = [
  {
    id: 'ep-new-feature',
    category: 'existing-project',
    layer: 'host-e2e',
    fixture: 'existing-react-vite',
    preSeed: EXISTING_SEED,
    prompt: 'Add a ContactForm component with name, email, and message fields, and render it on the home page.',
    assertions: [
      { id: 'onboarding-complete' },
      { id: 'materialized-assets' },
      { id: 'feature-files-present', params: { anyOf: ['src/components/ContactForm.tsx', 'src/ContactForm.tsx'] } },
    ],
  },
  {
    id: 'ep-text-edit',
    category: 'existing-project',
    layer: 'host-e2e',
    fixture: 'existing-react-vite',
    preSeed: EXISTING_SEED,
    prompt: "Rename the primary button label from 'Submit' to 'Send' wherever it appears.",
    assertions: [
      { id: 'onboarding-complete' },
      { id: 'feature-files-present', params: { contains: [{ path: 'src/App.tsx', text: 'Send' }] } },
    ],
  },
];
