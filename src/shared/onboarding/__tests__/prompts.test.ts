import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextOnboardingStep, onboardingPromptRequestForStep, performanceLevelOf } from '../prompts';
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

test('onboardingPromptRequestForStep returns the right popup for each step', () => {
  assert.equal(onboardingPromptRequestForStep('open-code')?.id, 'traffic-one.onboarding.open-code');
  assert.equal(onboardingPromptRequestForStep('performance')?.id, 'traffic-one.onboarding.performance');
  assert.equal(onboardingPromptRequestForStep('mobile')?.kind, 'single_select');
  assert.equal(onboardingPromptRequestForStep('code-graph')?.options?.length, 2);
  assert.equal(onboardingPromptRequestForStep('project-context')?.kind, 'text');
  const team = onboardingPromptRequestForStep('team-confirmation', { level: 'high', fallbackText: 'FB' });
  assert.equal(team?.id, 'traffic-one.onboarding.team-confirmation');
  assert.ok(team?.question.includes('high'));
  assert.equal(team?.fallbackText, 'FB');
  // terminal step has no popup
  assert.equal(onboardingPromptRequestForStep('state'), null);
});

test('performanceLevelOf reads the level or defaults to "selected"', () => {
  assert.equal(performanceLevelOf(complete()), 'high');
  assert.equal(performanceLevelOf({ mode: 'new-project' }), 'selected');
});
