// features-auth.cases.ts — host-e2e (opt-in). Add authentication to an existing
// Supabase-backed project.

import type { Case } from '../../core/types';

export const FEATURE_AUTH_CASES: Case[] = [
  {
    id: 'feat-auth-email-password',
    category: 'feature-auth',
    layer: 'host-e2e',
    fixture: 'existing-react-vite',
    preSeed: {
      mode: 'existing-codebase', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced', team: { mode: 'subagents', approved: true },
      openCode: false, codeGraphProvider: 'gitnexus',
    },
    prompt: 'Add email/password authentication using Supabase: a login page, a sign-up page, and a protected route that redirects to login when signed out.',
    assertions: [
      { id: 'onboarding-complete' },
      { id: 'materialized-assets' },
      { id: 'feature-files-present', params: { anyOf: ['src/pages/Login.tsx', 'src/Login.tsx', 'src/auth/Login.tsx', 'src/components/Login.tsx'] } },
    ],
  },
];
