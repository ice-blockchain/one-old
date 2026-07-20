import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  publicEndpoint,
} from '../../config/one-mcp';
import { hostModelSnapshot } from '../model-tiers';
import {
  bundledOneMcpPayload,
  oneMcpPayloadFingerprint,
  type OneMcpModelConfigPayload,
} from '../one-mcp';
import { writeOneMcpConfigCacheEntry } from '../one-mcp-cache';
import {
  currentAcceptableModels,
  currentHostModelTarget,
  currentHostModelSnapshot,
  currentModelForTier,
  currentModelsForTier,
  resolveTierFallback,
} from '../current-model-tiers';
import { writeRuntimeModelSnapshot } from './support/one-mcp-runtime';

test('runtime model resolution uses the authoritative One MCP sidecar preferred + fallbacks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-current-models-'));
  const env = {
    TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json'),
    TRAFFIC_ONE_MCP_CACHE_PATH: path.join(dir, 'one-mcp.json'),
  } as NodeJS.ProcessEnv;
  try {
    const snapshot = {
      ...hostModelSnapshot('codex', 'pro'),
      tiers: {
        highest: ['remote-high', 'remote-high-fallback'],
        balanced: ['remote-balanced', 'remote-balanced-fallback'],
        cheapest: ['remote-cheap'],
      },
    };
    writeRuntimeModelSnapshot('codex', snapshot, env);
    assert.equal(currentModelForTier('balanced', 'codex', 'pro', env), 'remote-balanced');
    assert.deepEqual(currentModelsForTier('balanced', 'codex', 'pro', env), [
      'remote-balanced',
      'remote-balanced-fallback',
    ]);
    assert.deepEqual(currentAcceptableModels('remote-balanced', 'codex', 'pro', env), [
      'remote-balanced',
      'remote-balanced-fallback',
    ]);
    assert.deepEqual(currentHostModelSnapshot('codex', 'pro', env), snapshot);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime derives the applied projection and fingerprint for the active plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-current-models-'));
  const env = { TRAFFIC_ONE_MCP_CACHE_PATH: path.join(dir, 'one-mcp.json') } as NodeJS.ProcessEnv;
  try {
    const payload: OneMcpModelConfigPayload = {
      tiers: {
        high: ['base-high'], balanced: ['base-balanced'], low: ['base-low'], auto: ['base-balanced'],
      },
      plans: {
        pro: {
          high: ['pro-high'], balanced: ['pro-balanced'], low: ['pro-low'], auto: ['pro-auto'],
        },
      },
    };
    writeOneMcpConfigCacheEntry('codex', {
      endpoint: publicEndpoint(env),
      configName: ONE_MCP_CONFIG_NAME_BY_HOST.codex,
      decoderVersion: ONE_MCP_DECODER_VERSION,
      version: 4,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
      payload,
      payloadFingerprint: oneMcpPayloadFingerprint(payload),
    }, env);

    const free = currentHostModelTarget('codex', 'free', env);
    const pro = currentHostModelTarget('codex', 'pro', env);
    assert.deepEqual(free.snapshot.tiers, {
      highest: ['base-high'], balanced: ['base-balanced'], cheapest: ['base-low'],
    });
    assert.deepEqual(pro.snapshot.tiers, {
      highest: ['pro-high'], balanced: ['pro-balanced'], cheapest: ['pro-low'],
    });
    assert.notEqual(free.appliedFingerprint, pro.appliedFingerprint);
    assert.equal(free.payloadFingerprint, oneMcpPayloadFingerprint(payload));
    assert.equal(pro.payloadFingerprint, oneMcpPayloadFingerprint(payload));
    assert.equal(pro.configVersion, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime ignores retired one.json host tiers and uses bundled data without a sidecar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-current-models-'));
  const env = {
    TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json'),
    TRAFFIC_ONE_MCP_CACHE_PATH: path.join(dir, 'one-mcp.json'),
  } as NodeJS.ProcessEnv;
  try {
    const bundled = hostModelSnapshot('cursor', 'pro');
    fs.writeFileSync(env.TRAFFIC_ONE_STATE_PATH!, `${JSON.stringify({
      schemaVersion: 3,
      codeGraphProvider: null,
      hosts: {
        cursor: {
          ...bundled,
          tiers: {
            ...bundled.tiers,
            balanced: ['retired-one-json-model'],
          },
        },
      },
    }, null, 2)}\n`, 'utf8');
    assert.deepEqual(
      currentHostModelSnapshot('cursor', 'pro', env),
      bundled,
    );
    assert.equal(currentHostModelTarget('cursor', 'pro', env).source, 'bundled');
    assert.equal(
      currentHostModelTarget('cursor', 'pro', env).payloadFingerprint,
      oneMcpPayloadFingerprint(bundledOneMcpPayload('cursor')),
    );
    assert.deepEqual(currentAcceptableModels('composer-2.5', 'cursor', 'pro', env), ['composer-2.5', 'gpt-5.4-mini', 'gpt-5.6-luna']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bundled target fingerprints the complete host payload while applied drift remains plan-specific', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-current-models-bundled-fingerprint-'));
  const env = { TRAFFIC_ONE_MCP_CACHE_PATH: path.join(dir, 'missing-one-mcp.json') } as NodeJS.ProcessEnv;
  try {
    const free = currentHostModelTarget('cursor', 'free', env);
    const pro = currentHostModelTarget('cursor', 'pro', env);
    const fullFingerprint = oneMcpPayloadFingerprint(bundledOneMcpPayload('cursor'));
    assert.equal(free.payloadFingerprint, fullFingerprint);
    assert.equal(pro.payloadFingerprint, fullFingerprint);
    assert.notEqual(free.appliedFingerprint, pro.appliedFingerprint);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fallback resolution is anchored to the role tier and returns an exact captured slug', () => {
  const captured = [
    'gpt-5.6-terra-medium',
    'gpt-5.6-sol-medium',
    'claude-sonnet-5-thinking-high',
    'composer-2.5-fast',
  ];
  const highest = resolveTierFallback({
    tier: 'highest',
    exhaustedModels: ['gpt-5.6-terra-medium', 'claude-fable-5-thinking-high'],
    capturedModels: captured,
  }, 'cursor', 'pro');
  assert.deepEqual(highest, {
    family: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol-medium',
  }, 'a failed balanced-family model cannot move a highest role into the balanced row');

  const balanced = resolveTierFallback({
    tier: 'balanced',
    exhaustedModels: ['gpt-5.6-terra-medium'],
    unavailableModels: ['claude-sonnet-5'],
    capturedModels: captured,
  }, 'cursor', 'pro');
  assert.deepEqual(balanced, { family: 'composer-2.5', model: 'composer-2.5-fast' });
});

test('fallback resolution skips uncaptured models and reports exhaustion without changing tiers', () => {
  assert.deepEqual(resolveTierFallback({
    tier: 'balanced',
    exhaustedModels: ['gpt-5.6-terra-medium'],
    capturedModels: ['composer-2.5-fast'],
  }, 'cursor', 'pro'), { family: 'composer-2.5', model: 'composer-2.5-fast' });

  assert.equal(resolveTierFallback({
    tier: 'balanced',
    exhaustedModels: ['gpt-5.6-terra-medium', 'composer-2.5-fast'],
    capturedModels: ['composer-2.5-fast'],
  }, 'cursor', 'pro'), null);
});

test('fallback resolution rejects a bare captured prefix and returns only a gate-compatible exact slug', () => {
  const exhaustedModels = [
    'gpt-5.6-terra-medium',
  ];

  assert.equal(resolveTierFallback({
    tier: 'balanced',
    exhaustedModels,
    capturedModels: ['claude-sonnet'],
  }, 'cursor', 'pro'), null, 'a shorter captured prefix is not a runnable variant of the tier family');

  assert.deepEqual(resolveTierFallback({
    tier: 'balanced',
    exhaustedModels,
    capturedModels: ['claude-sonnet', 'claude-sonnet-5-thinking-high'],
  }, 'cursor', 'pro'), {
    family: 'claude-sonnet-5',
    model: 'claude-sonnet-5-thinking-high',
  });
});
