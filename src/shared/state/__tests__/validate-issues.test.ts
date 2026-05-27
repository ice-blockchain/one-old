import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasTechnologyArrays, trafficOneStateValidationIssues } from '../validate';
import { initializeToolchainState } from '../toolchain';

function readyNewProjectState(): Record<string, unknown> {
  return {
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
    projectContext: {
      source: 'prompted', originalPrompt: 'build x', summary: 'an app',
      answers: { goal: 'x' }, collectedAt: '2026-01-01T00:00:00Z',
    },
    team: { mode: 'subagents', source: 'prompted', approved: true },
    performance: { level: 'high', source: 'prompted' },
    codeGraphProvider: 'graphify',
    toolchain: Object.fromEntries(
      Object.entries(initializeToolchainState({})).map(([k]) => [k, { installedVersion: '1', installedAt: 'now' }]),
    ),
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-01-01T00:00:00Z',
  };
}

test('hasTechnologyArrays requires frontend/backend/mobile arrays', () => {
  assert.equal(hasTechnologyArrays({ frontend: [], backend: [], mobile: [] }), true);
  assert.equal(hasTechnologyArrays({ frontend: [], backend: [] }), false);
  assert.equal(hasTechnologyArrays(null), false);
});

test('trafficOneStateValidationIssues: a fully-resolved new-project state is ready (no issues)', () => {
  assert.deepEqual(trafficOneStateValidationIssues(readyNewProjectState()), []);
});

test('trafficOneStateValidationIssues: non-object input fails fast', () => {
  assert.deepEqual(trafficOneStateValidationIssues(null), ['`.traffic-one/.one.json` must contain a JSON object.']);
});

test('trafficOneStateValidationIssues: flags each missing/invalid field', () => {
  const issues = trafficOneStateValidationIssues({ mode: 'new-project' });
  const joined = issues.join('\n');
  assert.ok(issues.length > 5);
  assert.ok(joined.includes('`stack` is missing.'));
  assert.ok(joined.includes('`frontend` is missing.'));
  assert.ok(joined.includes('`backend` is missing.'));
  assert.ok(joined.includes('`codeGraphProvider` is missing.'));
  assert.ok(joined.includes('`confirmed` must be true.'));
  assert.ok(joined.includes('`onboardingComplete` must be true.'));
});

test('trafficOneStateValidationIssues: balanced/high subagents need team.approved', () => {
  const state = readyNewProjectState();
  (state.team as Record<string, unknown>).approved = false;
  const issues = trafficOneStateValidationIssues(state);
  assert.ok(issues.some((i) => i.includes('`team.approved` must be true')));
});

test('trafficOneStateValidationIssues: team.mode must match performance level', () => {
  const state = readyNewProjectState();
  (state.team as Record<string, unknown>).mode = 'main-agent'; // high requires subagents
  const issues = trafficOneStateValidationIssues(state);
  assert.ok(issues.some((i) => i.includes('requires "subagents"')));
});

test('trafficOneStateValidationIssues: new-project mobile.source=none is rejected', () => {
  const state = readyNewProjectState();
  (state.mobile as Record<string, unknown>).source = 'none';
  const issues = trafficOneStateValidationIssues(state);
  assert.ok(issues.some((i) => i.includes('`mobile.source` must be `prompted` or `explicit`')));
});
