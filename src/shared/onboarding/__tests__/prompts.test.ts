import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextOnboardingStep } from '../prompts';
import { initializeToolchainState } from '../../state/toolchain';

const TOOLCHAIN = Object.fromEntries(
  Object.keys(initializeToolchainState({})).map((k) => [k, { installedVersion: '1', installedAt: 'now' }]),
);

// A complete new-project state; remove fields to walk the step order backwards.
function complete(): Record<string, unknown> {
  return {
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
    projectContext: { source: 'prompted', originalPrompt: 'x', summary: 's', answers: { a: 1 }, collectedAt: '2026-01-01T00:00:00Z' },
    openCode: { enabled: false, source: 'prompted' },
    codeGraphProvider: 'graphify',
    team: { mode: 'subagents', source: 'prompted', approved: true },
    performance: { level: 'high', source: 'prompted' },
    toolchain: TOOLCHAIN,
    confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z',
  };
}

test('nextOnboardingStep returns null when not a new project', () => {
  assert.equal(nextOnboardingStep({ mode: 'existing-codebase' }), null);
  assert.equal(nextOnboardingStep(null), null);
});

test('nextOnboardingStep walks the canonical order as fields resolve', () => {
  assert.equal(nextOnboardingStep({ mode: 'new-project' }), 'open-code');
  assert.equal(nextOnboardingStep({ mode: 'new-project' }, 'opencode'), 'performance');
  assert.equal(nextOnboardingStep({ mode: 'new-project' }, 'kilo'), 'performance');
  const s = complete();
  delete s.performance;
  delete s.team;
  assert.equal(nextOnboardingStep(s), 'performance');
  // unapproved subagent line-up → team-confirmation
  const tc = complete();
  (tc.team as Record<string, unknown>).approved = false;
  assert.equal(nextOnboardingStep(tc), 'team-confirmation');
  // missing project context
  const pc = complete();
  delete pc.projectContext;
  assert.equal(nextOnboardingStep(pc), 'project-context');
  // missing mobile resolution
  const mob = complete();
  mob.mobile = { enabled: false, framework: 'none', source: 'none' };
  assert.equal(nextOnboardingStep(mob), 'mobile');
  // missing code graph
  const cg = complete();
  delete cg.codeGraphProvider;
  assert.equal(nextOnboardingStep(cg), 'code-graph');
  // everything resolved → terminal 'state'
  assert.equal(nextOnboardingStep(complete()), 'state');
});
