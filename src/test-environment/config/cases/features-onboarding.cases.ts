// features-onboarding.cases.ts
// Pure-Node deterministic matrix. Onboarding is PRE-COMPLETED (seeded via the
// real state writers) or driven through the real wizard state machine (scripted
// answers). No host CLI, no LLM spend — this is the deterministic backbone.
//
// Add a row = append a Case object.

import type { Case } from '../../core/types';

export const FEATURE_ONBOARDING_CASES: Case[] = [
  {
    id: 'onb-low-webonly-noopencode',
    category: 'feature-onboarding',
    layer: 'pure-node',
    fixture: 'empty',
    preSeed: {
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: false, framework: 'none' },
      performance: 'low', openCode: false, openCodeInstalled: false,
      codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: 'A small task tracker with users and an admin dashboard' },
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'model-resolution-matches' },
      { id: 'opencode-delegation' },
    ],
    notes: 'low → main-agent, no per-role model tiers; opencode off.',
  },
  {
    id: 'onb-balanced-webonly',
    category: 'feature-onboarding',
    layer: 'pure-node',
    fixture: 'empty',
    preSeed: {
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced', team: { mode: 'subagents', approved: true },
      openCode: false, codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: 'A task tracker SaaS with projects, teams, and an admin area' },
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'model-resolution-matches' },
    ],
  },
  {
    id: 'onb-high-mobile-rn-opencode',
    category: 'feature-onboarding',
    layer: 'pure-node',
    fixture: 'empty',
    preSeed: {
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: true, framework: 'react-native-expo' },
      performance: 'high', team: { mode: 'subagents', approved: true },
      openCode: true, openCodeInstalled: true, codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: 'A fitness tracker mobile app with social feed and an admin dashboard' },
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'model-resolution-matches' },
      { id: 'opencode-delegation' },
    ],
    notes: 'high + mobile (Expo) + opencode ON (enabled AND installed → delegation active).',
  },
  {
    id: 'onb-high-ionic-graphify',
    category: 'feature-onboarding',
    layer: 'pure-node',
    fixture: 'empty',
    preSeed: {
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: true, framework: 'ionic-capacitor' },
      performance: 'high', team: { mode: 'subagents', approved: true },
      openCode: false, codeGraphProvider: 'graphify',
      projectContext: { originalPrompt: 'A field-service app with offline support and an admin dashboard' },
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'model-resolution-matches' },
    ],
    notes: 'Ionic/Capacitor + graphify provider.',
  },
  {
    id: 'onb-balanced-modeloverride',
    category: 'feature-onboarding',
    layer: 'pure-node',
    fixture: 'empty',
    preSeed: {
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced',
      team: { mode: 'subagents', approved: true, overrides: { 'senior-architect': 'highest', 'senior-backend': 'cheapest' } },
      openCode: false, codeGraphProvider: 'gitnexus',
      projectContext: { originalPrompt: 'A CRM with contacts, deals, and an admin dashboard' },
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'model-resolution-matches' },
    ],
    notes: 'Manual model override: architect→highest, backend→cheapest must beat the balanced default.',
  },
  {
    id: 'onb-existing-balanced',
    category: 'feature-onboarding',
    layer: 'pure-node',
    fixture: 'existing-react-vite',
    preSeed: {
      mode: 'existing-codebase', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      performance: 'balanced', team: { mode: 'subagents', approved: true },
      openCode: false, codeGraphProvider: 'gitnexus',
    },
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'model-resolution-matches' },
    ],
    notes: 'Existing-codebase mode: local prefs complete (no new-project MVP prompts).',
  },
  {
    id: 'onb-flow-sim-backend-frontend',
    category: 'feature-onboarding',
    layer: 'pure-node',
    fixture: 'empty',
    preSeed: {
      // For a flow-sim case, preSeed declares only the EXPECTED final selection
      // the scripted answers should produce (stack/frontend/backend are derived
      // by finalize, so they are intentionally omitted from assertions).
      mode: 'new-project',
      mobile: { enabled: false, framework: 'none' },
      performance: 'balanced', team: { mode: 'subagents' },
      openCode: false, codeGraphProvider: 'gitnexus',
    },
    scriptedAnswers: [
      { step: 'open-code', value: false },
      { step: 'performance', value: 'balanced' },
      { step: 'team-confirmation', value: { action: 'approve' } },
      {
        step: 'project-context',
        value: {
          originalPrompt: 'Build a task tracker SaaS with user accounts, projects, and an admin dashboard',
          answers: { audience: 'small teams', v1Features: 'tasks, projects, auth, admin' },
        },
      },
      { step: 'mobile', value: 'web_only' },
      { step: 'code-graph', value: 'gitnexus' },
    ],
    assertions: [
      { id: 'state-matches-selection' },
      { id: 'onboarding-complete' },
      { id: 'model-resolution-matches' },
    ],
    notes: 'Drives the REAL wizard state machine (computeOnboarding/applyAnswer) to completion.',
  },
];
