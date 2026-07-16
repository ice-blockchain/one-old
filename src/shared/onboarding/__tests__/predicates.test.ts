import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNewProjectOnboardingIncomplete, needsTeamConfirmation } from '../predicates';
import { initializeToolchainState } from '../../state/toolchain';

function completeState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
    projectContext: {
      source: 'prompted', originalPrompt: 'x', summary: 'app', answers: { a: 1 }, collectedAt: '2026-01-01T00:00:00Z',
    },
    openCode: { enabled: false, source: 'prompted' },
    codeGraphProvider: 'graphify',
    team: { mode: 'subagents', source: 'prompted', approved: true },
    performance: { level: 'high', source: 'prompted' },
    toolchain: Object.fromEntries(
      Object.keys(initializeToolchainState({})).map((k) => [k, { installedVersion: '1', installedAt: 'now' }]),
    ),
    confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

test('isNewProjectOnboardingIncomplete: a fully-resolved new project is complete (false)', () => {
  assert.equal(isNewProjectOnboardingIncomplete(completeState()), false);
  assert.equal(isNewProjectOnboardingIncomplete(completeState({ openCode: undefined }), 'opencode'), false);
  assert.equal(isNewProjectOnboardingIncomplete(completeState({ openCode: undefined }), 'kilo'), false);
});

test('isNewProjectOnboardingIncomplete: only applies to new-project mode', () => {
  assert.equal(isNewProjectOnboardingIncomplete({ mode: 'existing-codebase' }), false);
  assert.equal(isNewProjectOnboardingIncomplete(null), false);
});

test('isNewProjectOnboardingIncomplete: flags each kind of missing field', () => {
  assert.equal(isNewProjectOnboardingIncomplete(completeState({ stack: 'nonsense' })), true);
  assert.equal(isNewProjectOnboardingIncomplete(completeState({ codeGraphProvider: undefined })), true);
  assert.equal(isNewProjectOnboardingIncomplete(completeState({ confirmed: false })), true);
  assert.equal(isNewProjectOnboardingIncomplete(completeState({ onboardingComplete: false })), true);
  assert.equal(isNewProjectOnboardingIncomplete(completeState({ mobile: { enabled: false, framework: 'none', source: 'none' } })), true);
  // performance/team mismatch: high requires subagents
  assert.equal(isNewProjectOnboardingIncomplete(completeState({ team: { mode: 'main-agent', source: 'prompted' } })), true);
  // balanced/high without approval
  assert.equal(isNewProjectOnboardingIncomplete(completeState({ team: { mode: 'subagents', source: 'prompted', approved: false } })), true);
});

test('needsTeamConfirmation: true only for unapproved subagent line-ups on a new project', () => {
  assert.equal(needsTeamConfirmation(completeState({ team: { mode: 'subagents', source: 'prompted', approved: false } })), true);
  assert.equal(needsTeamConfirmation(completeState()), false); // approved
  // low/main-agent never needs confirmation
  assert.equal(needsTeamConfirmation(completeState({ performance: { level: 'low', source: 'prompted' }, team: { mode: 'main-agent', source: 'prompted' } })), false);
  assert.equal(needsTeamConfirmation({ mode: 'existing-codebase' }), false);
  assert.equal(needsTeamConfirmation(null), false);
});
