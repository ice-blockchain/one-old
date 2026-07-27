import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOST_MODELS } from '../../config/model-tiers';
import { currentHostModelTarget } from '../../shared/current-model-tiers';
import { defaultConfig } from '../config/test-config';
import type {
  CodexProofAppServer,
  CodexProofAppServerFactory,
} from './codex-trust-upgrade-proof';
import {
  preflightCodexE2eModels,
  seedCodexE2eModelCatalog,
} from './codex-e2e-models';
import { resolveCasePrompt } from './case-runner';
import type { Case } from './types';

function fakeFactory(
  models: readonly string[],
  calls: string[] = [],
): CodexProofAppServerFactory {
  return async (): Promise<CodexProofAppServer> => ({
    async request<T>(method: string): Promise<T> {
      calls.push(method);
      return {
        data: models.map((model) => ({ model })),
        nextCursor: null,
      } as T;
    },
    async close(): Promise<void> {
      calls.push('close');
    },
    stderrTail(): string {
      return '';
    },
  });
}

test('Codex E2E model preflight proves every configured session and tier slug', async (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-e2e-models-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const config = defaultConfig().hosts.codex;
  const calls: string[] = [];
  let receivedUnsupportedProfile = false;
  let observedCodexHome = '';
  const baseFactory = fakeFactory([
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark',
    'codex-auto-review',
  ], calls);

  const result = await preflightCodexE2eModels(config, {
    codexHome,
    appServerFactory: async (options) => {
      receivedUnsupportedProfile = 'profileName' in options;
      observedCodexHome = options.env.CODEX_HOME ?? '';
      return baseFactory(options);
    },
  });

  assert.equal(result.status, 'ready');
  assert.equal(receivedUnsupportedProfile, false);
  assert.equal(observedCodexHome, codexHome);
  assert.deepEqual(result.requiredModels, ['gpt-5.4', 'gpt-5.5', 'gpt-5.4-mini']);
  assert.deepEqual(calls, ['model/list', 'close']);
});

test('missing Codex child model is blocked-environment, never a production gate bypass', async (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-e2e-models-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const result = await preflightCodexE2eModels(defaultConfig().hosts.codex, {
    codexHome,
    appServerFactory: fakeFactory(['gpt-5.5', 'gpt-5.4']),
  });

  assert.equal(result.status, 'blocked-environment');
  assert.match(result.detail, /gpt-5\.4-mini/);
});

test('isolated Codex E2E sidecar changes only the case env; production keeps its normal registry', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-e2e-sidecar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = defaultConfig().hosts.codex;
  const isolatedEnv = {
    TRAFFIC_ONE_MCP_CACHE_PATH: path.join(dir, 'case', 'one-mcp.json'),
  } as NodeJS.ProcessEnv;

  seedCodexE2eModelCatalog(config, isolatedEnv);
  const isolated = currentHostModelTarget('codex', 'pro', isolatedEnv);
  assert.deepEqual(isolated.snapshot.tiers, {
    highest: ['gpt-5.5'],
    balanced: ['gpt-5.4'],
    cheapest: ['gpt-5.4-mini'],
  });
  assert.equal(isolated.source, 'one-mcp');

  const productionEnv = {
    TRAFFIC_ONE_MCP_CACHE_PATH: path.join(dir, 'production-missing.json'),
  } as NodeJS.ProcessEnv;
  const production = currentHostModelTarget('codex', 'pro', productionEnv);
  assert.deepEqual(production.snapshot.tiers, {
    highest: [...HOST_MODELS.codex.tiers.highest],
    balanced: [...HOST_MODELS.codex.tiers.balanced],
    cheapest: [...HOST_MODELS.codex.tiers.cheapest],
  });
  assert.equal(production.source, 'bundled');
});

test('Codex case prompt receives the isolated cheapest model before driver invocation', () => {
  const testCase: Case = {
    id: 'codex-model-token',
    category: 'project-lifecycle',
    layer: 'host-e2e',
    fixture: 'existing-react-vite',
    preSeed: { mode: 'existing-codebase' },
    prompt: 'Spawn quick_fix with model {TEST_MODEL_CHEAPEST}.',
    assertions: [],
  };
  const prompt = resolveCasePrompt(testCase, 'codex', defaultConfig());
  assert.equal(prompt, 'Spawn quick_fix with model gpt-5.4-mini.');
  assert.doesNotMatch(prompt, /\{TEST_MODEL_CHEAPEST\}/);
});
