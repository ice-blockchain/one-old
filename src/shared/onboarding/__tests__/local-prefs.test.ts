import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  DEFAULT_PUBLIC_ENDPOINT,
} from '../../../config/one-mcp';
import { oneMcpAppliedFingerprint, oneMcpPayloadFingerprint } from '../../one-mcp';
import { writeOneMcpConfigCacheEntry } from '../../one-mcp-cache';
import { hostModelSnapshot } from '../../model-tiers';
import {
  currentLocalPreferenceTarget,
  nextLocalPreferenceStep,
  type LocalPreferenceTarget,
} from '../local-prefs';

const CURRENT: LocalPreferenceTarget = {
  plan: 'pro',
  appliedFingerprint: 'a'.repeat(64),
  configVersion: 7,
};

const PERFORMANCE_TARGET = {
  plan: CURRENT.plan,
  appliedFingerprint: CURRENT.appliedFingerprint,
  configVersion: CURRENT.configVersion,
};

test('nextLocalPreferenceStep walks only the per-user Traffic One preference steps', () => {
  const state: Record<string, unknown> = { mode: 'existing-codebase', stack: 'custom-frontend' };
  assert.equal(nextLocalPreferenceStep(state, 'codex', CURRENT), 'open-code');
  assert.equal(nextLocalPreferenceStep(state, 'opencode', CURRENT), 'performance');
  assert.equal(nextLocalPreferenceStep(state, 'kilo', CURRENT), 'performance');

  state.openCode = { enabled: false, source: 'prompted' };
  assert.equal(nextLocalPreferenceStep(state, 'codex', CURRENT), 'performance');

  state.performance = { level: 'high', source: 'prompted', target: PERFORMANCE_TARGET };
  state.team = { mode: 'subagents', source: 'prompted' };
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
    performance: { level: 'low', source: 'prompted', target: PERFORMANCE_TARGET },
    team: { mode: 'main-agent', source: 'prompted' },
    codeGraphProvider: 'gitnexus',
  }, 'codex', CURRENT), null);
});

test('nextLocalPreferenceStep rejects team/performance mismatches', () => {
  assert.equal(nextLocalPreferenceStep({
    mode: 'existing-codebase',
    stack: 'default',
    openCode: { enabled: false, source: 'prompted' },
    performance: { level: 'high', source: 'prompted', target: PERFORMANCE_TARGET },
    team: { mode: 'main-agent', source: 'prompted' },
    codeGraphProvider: 'graphify',
  }, 'codex', CURRENT), 'performance');
});

test('nextLocalPreferenceStep reopens only Performance when plan or applied models changed', () => {
  const state = {
    mode: 'existing-codebase',
    stack: 'default',
    openCode: { enabled: false, source: 'prompted' },
    performance: {
      level: 'balanced',
      source: 'prompted',
      target: { plan: 'free', appliedFingerprint: CURRENT.appliedFingerprint, configVersion: 2 },
    },
    team: { mode: 'subagents', source: 'prompted', approved: true },
    codeGraphProvider: 'gitnexus',
  };

  assert.equal(nextLocalPreferenceStep(state, 'codex', CURRENT), 'performance');
  assert.deepEqual(state.team, { mode: 'subagents', source: 'prompted', approved: true });
  assert.deepEqual(state.performance.target, { plan: 'free', appliedFingerprint: CURRENT.appliedFingerprint, configVersion: 2 });
});

test('semantic Performance target accepts the same catalog and rejects model drift', () => {
  const state = {
    mode: 'existing-codebase',
    stack: 'default',
    openCode: { enabled: false, source: 'prompted' },
    performance: { level: 'low', source: 'prompted', target: PERFORMANCE_TARGET },
    team: { mode: 'main-agent', source: 'prompted' },
    codeGraphProvider: 'gitnexus',
  };

  assert.equal(nextLocalPreferenceStep(state, 'codex', CURRENT), null);

  assert.equal(nextLocalPreferenceStep(state, 'codex', {
    ...CURRENT,
    configVersion: CURRENT.configVersion + 1,
  }), null, 'metadata-only config version drift does not reopen Performance');

  assert.equal(nextLocalPreferenceStep(state, 'codex', {
    ...CURRENT,
    appliedFingerprint: 'b'.repeat(64),
  }), 'performance', 'an applied model change reopens Performance');
});

test('currentLocalPreferenceTarget uses bundled tiers for the detected plan without a sidecar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-local-pref-target-'));
  const env = {
    TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json'),
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'preferences.json'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    TRAFFIC_ONE_USER_PLAN: 'pro',
  } as NodeJS.ProcessEnv;
  try {
    const expected = hostModelSnapshot('cursor', 'pro');
    assert.deepEqual(currentLocalPreferenceTarget('cursor', env, dir), {
      plan: 'pro',
      appliedFingerprint: oneMcpAppliedFingerprint(expected.tiers),
      configVersion: 0,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('currentLocalPreferenceTarget uses a valid One MCP sidecar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-local-pref-cache-target-'));
  const env = {
    TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json'),
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'preferences.json'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    TRAFFIC_ONE_USER_PLAN: 'pro',
  } as NodeJS.ProcessEnv;
  try {
    const snapshot = hostModelSnapshot('codex', 'pro');
    const payload = {
      tiers: {
        high: snapshot.tiers.highest,
        balanced: snapshot.tiers.balanced,
        low: snapshot.tiers.cheapest,
        auto: snapshot.tiers.balanced,
      },
    };
    const appliedFingerprint = oneMcpAppliedFingerprint(snapshot.tiers);
    writeOneMcpConfigCacheEntry('codex', {
      endpoint: DEFAULT_PUBLIC_ENDPOINT,
      configName: ONE_MCP_CONFIG_NAME_BY_HOST.codex,
      decoderVersion: ONE_MCP_DECODER_VERSION,
      version: 8,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      payload,
      payloadFingerprint: oneMcpPayloadFingerprint(payload),
    }, env);
    const target = currentLocalPreferenceTarget('codex', env, dir);
    assert.equal(target.plan, 'pro');
    assert.equal(target.appliedFingerprint, appliedFingerprint);
    assert.equal(target.configVersion, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
