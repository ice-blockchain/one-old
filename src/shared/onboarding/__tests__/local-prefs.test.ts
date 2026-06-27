import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextLocalPreferenceStep } from '../local-prefs';

test('nextLocalPreferenceStep walks only the per-user Traffic One preference steps', () => {
  const state: Record<string, unknown> = { mode: 'existing-codebase', stack: 'custom-frontend' };
  assert.equal(nextLocalPreferenceStep(state), 'open-code');
  assert.equal(nextLocalPreferenceStep(state, 'opencode'), 'performance');

  state.openCode = { enabled: false, source: 'prompted' };
  assert.equal(nextLocalPreferenceStep(state), 'performance');

  state.performance = { level: 'high', source: 'prompted' };
  state.team = { mode: 'subagents', source: 'prompted' };
  assert.equal(nextLocalPreferenceStep(state), 'team-confirmation');

  state.team = { mode: 'subagents', source: 'prompted', approved: true };
  assert.equal(nextLocalPreferenceStep(state), 'code-graph');

  state.codeGraphProvider = 'graphify';
  assert.equal(nextLocalPreferenceStep(state), null);
});

test('nextLocalPreferenceStep does not require new-project-only MVP or mobile answers', () => {
  assert.equal(nextLocalPreferenceStep({
    mode: 'existing-codebase',
    stack: 'minimal',
    openCode: { enabled: false, source: 'prompted' },
    performance: { level: 'low', source: 'prompted' },
    team: { mode: 'main-agent', source: 'prompted' },
    codeGraphProvider: 'gitnexus',
  }), null);
});

test('nextLocalPreferenceStep rejects team/performance mismatches', () => {
  assert.equal(nextLocalPreferenceStep({
    mode: 'existing-codebase',
    stack: 'default',
    openCode: { enabled: false, source: 'prompted' },
    performance: { level: 'high', source: 'prompted' },
    team: { mode: 'main-agent', source: 'prompted' },
    codeGraphProvider: 'graphify',
  }), 'performance');
});
