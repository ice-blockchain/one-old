import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { hostModelSnapshot } from '../../model-tiers';
import { writeOneHostSettings } from '../../one-settings';
import { currentLocalPreferenceTarget, nextLocalPreferenceStep } from '../local-prefs';

const CURRENT = { plan: 'pro', modelsUpdatedAt: '2026-07-12' };

test('nextLocalPreferenceStep walks only the per-user Traffic One preference steps', () => {
  const state: Record<string, unknown> = { mode: 'existing-codebase', stack: 'custom-frontend' };
  assert.equal(nextLocalPreferenceStep(state, 'codex', CURRENT), 'open-code');
  assert.equal(nextLocalPreferenceStep(state, 'opencode', CURRENT), 'performance');
  assert.equal(nextLocalPreferenceStep(state, 'kilo', CURRENT), 'performance');

  state.openCode = { enabled: false, source: 'prompted' };
  assert.equal(nextLocalPreferenceStep(state, 'codex', CURRENT), 'performance');

  state.performance = { level: 'high', source: 'prompted' };
  state.team = { mode: 'subagents', source: 'prompted' };
  state.configuredFor = CURRENT;
  assert.equal(nextLocalPreferenceStep(state, 'codex', CURRENT), 'team-confirmation');

  state.team = { mode: 'subagents', source: 'prompted', approved: true };
  assert.equal(nextLocalPreferenceStep(state, 'codex', CURRENT), 'code-graph');

  state.codeGraphProvider = 'graphify';
  assert.equal(nextLocalPreferenceStep(state, 'codex', CURRENT), null);
});

test('nextLocalPreferenceStep does not require new-project-only MVP or mobile answers', () => {
  assert.equal(nextLocalPreferenceStep({
    mode: 'existing-codebase',
    stack: 'minimal',
    openCode: { enabled: false, source: 'prompted' },
    performance: { level: 'low', source: 'prompted' },
    team: { mode: 'main-agent', source: 'prompted' },
    configuredFor: CURRENT,
    codeGraphProvider: 'gitnexus',
  }, 'codex', CURRENT), null);
});

test('nextLocalPreferenceStep rejects team/performance mismatches', () => {
  assert.equal(nextLocalPreferenceStep({
    mode: 'existing-codebase',
    stack: 'default',
    openCode: { enabled: false, source: 'prompted' },
    performance: { level: 'high', source: 'prompted' },
    team: { mode: 'main-agent', source: 'prompted' },
    configuredFor: CURRENT,
    codeGraphProvider: 'graphify',
  }, 'codex', CURRENT), 'performance');
});

test('nextLocalPreferenceStep reopens only Performance when the plan or catalog date changed', () => {
  const state = {
    mode: 'existing-codebase',
    stack: 'default',
    openCode: { enabled: false, source: 'prompted' },
    performance: { level: 'balanced', source: 'prompted' },
    team: { mode: 'subagents', source: 'prompted', approved: true },
    configuredFor: { plan: 'free', modelsUpdatedAt: '2026-07-10' },
    codeGraphProvider: 'gitnexus',
  };

  assert.equal(nextLocalPreferenceStep(state, 'codex', CURRENT), 'performance');
  assert.deepEqual(state.team, { mode: 'subagents', source: 'prompted', approved: true });
  assert.deepEqual(state.configuredFor, { plan: 'free', modelsUpdatedAt: '2026-07-10' });
});

test('currentLocalPreferenceTarget ignores a stored catalog from a different detected plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-local-pref-target-'));
  const env = {
    TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json'),
    TRAFFIC_ONE_USER_PLAN: 'pro',
  } as NodeJS.ProcessEnv;
  try {
    writeOneHostSettings('cursor', {
      ...hostModelSnapshot('cursor', 'free'),
      updatedAt: '2026-07-14',
    }, env);

    assert.deepEqual(currentLocalPreferenceTarget('cursor', env), {
      plan: 'pro',
      modelsUpdatedAt: hostModelSnapshot('cursor', 'pro').updatedAt,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
