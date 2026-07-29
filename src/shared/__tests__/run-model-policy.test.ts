import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { currentHostModelTarget } from '../current-model-tiers';
import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  ONE_MCP_MAX_MODELS_PER_TIER,
  DEFAULT_PUBLIC_ENDPOINT,
} from '../../config/one-mcp';
import { captureCursorModels } from '../materialize/cursor-models';
import { modelTierSnapshot, resolveModel } from '../model-tiers';
import { writeOneMcpConfigCacheEntry } from '../one-mcp/cache';
import { oneMcpPayloadFingerprint } from '../one-mcp';
import {
  ensureRunModelPolicy,
  readRunModelPolicy,
  resolveRunPolicyFallback,
  runModelPolicyPath,
} from '../run-model-policy';
import type { OneMcpModelConfigPayload } from '../one-mcp/types';
import {
  correctCodexChildObservationRole,
  observeCodexChildModel,
  readCodexModelObservation,
} from '../state/codex-model-observation';

function fixture<T>(body: (cwd: string, env: NodeJS.ProcessEnv) => T): T {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-run-policy-'));
  const env = {
    ...process.env,
    TRAFFIC_ONE_HOST: 'codex',
    TRAFFIC_ONE_USER_PLAN: 'pro',
    XDG_STATE_HOME: path.join(cwd, 'state'),
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'preferences.json'),
  };
  try {
    return body(cwd, env);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function stateFor(
  env: NodeJS.ProcessEnv,
  level: 'balanced' | 'high',
  overrides: Record<string, string> = {},
): Record<string, unknown> {
  const target = currentHostModelTarget('codex', 'pro', env);
  return {
    mode: 'new-project',
    performance: {
      level,
      source: 'prompted',
      target: {
        plan: 'pro',
        appliedFingerprint: target.appliedFingerprint,
        configVersion: target.configVersion,
      },
    },
    team: {
      mode: 'subagents',
      approved: true,
      source: 'prompted',
      ...(Object.keys(overrides).length ? { overrides } : {}),
    },
  };
}

function claudeStateFor(
  env: NodeJS.ProcessEnv,
  modelSelections: Record<string, string>,
  overrides: Record<string, string> = {},
): Record<string, unknown> {
  const target = currentHostModelTarget('claude', 'max', env);
  return {
    mode: 'new-project',
    performance: {
      level: 'high',
      source: 'prompted',
      target: {
        plan: 'max',
        appliedFingerprint: target.appliedFingerprint,
        configVersion: target.configVersion,
      },
    },
    team: {
      mode: 'subagents',
      approved: true,
      source: 'prompted',
      ...(Object.keys(overrides).length ? { overrides } : {}),
      modelSelections,
    },
  };
}

function publishCursorPayload(
  env: NodeJS.ProcessEnv,
  payload: OneMcpModelConfigPayload,
  version: number,
): void {
  writeOneMcpConfigCacheEntry('cursor', {
    endpoint: DEFAULT_PUBLIC_ENDPOINT,
    configName: ONE_MCP_CONFIG_NAME_BY_HOST.cursor,
    decoderVersion: ONE_MCP_DECODER_VERSION,
    version,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: `2026-07-${String(10 + version).padStart(2, '0')}T00:00:00.000Z`,
    payload,
    payloadFingerprint: oneMcpPayloadFingerprint(payload),
  }, env);
}

function cursorStateFor(
  env: NodeJS.ProcessEnv,
  plan: string,
  level: 'balanced' | 'high' = 'high',
): Record<string, unknown> {
  const target = currentHostModelTarget('cursor', plan, env);
  return {
    mode: 'new-project',
    performance: {
      level,
      source: 'prompted',
      target: { plan, appliedFingerprint: target.appliedFingerprint, configVersion: target.configVersion },
    },
    team: { mode: 'subagents', approved: true, source: 'prompted' },
  };
}

function rewritePolicyId(raw: Record<string, unknown>): void {
  const { policyId: _policyId, capturedAt: _capturedAt, ...canonical } = raw;
  raw.policyId = createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

test('Codex run policies encode the approved standard and override E2E profiles', () => {
  fixture((cwd, env) => {
    const balanced = ensureRunModelPolicy(cwd, 'balanced', 'codex', stateFor(env, 'balanced'), env);
    assert.ok(balanced);
    for (const role of [
      'senior-architect', 'senior-frontend', 'senior-backend',
      'senior-reviewer', 'senior-tester', 'senior-shipper',
    ]) {
      assert.equal(balanced!.roles[role]?.preferredModel, 'gpt-5.6-terra', role);
    }

    const overridden = ensureRunModelPolicy(
      cwd,
      'balanced-override',
      'codex',
      stateFor(env, 'balanced', { 'senior-architect': 'highest' }),
      env,
    );
    assert.equal(overridden?.roles['senior-architect']?.preferredModel, 'gpt-5.6-sol');
    for (const role of ['senior-frontend', 'senior-backend', 'senior-reviewer', 'senior-tester', 'senior-shipper']) {
      assert.equal(overridden?.roles[role]?.preferredModel, 'gpt-5.6-terra', role);
    }

    const high = ensureRunModelPolicy(cwd, 'high', 'codex', stateFor(env, 'high'), env);
    for (const role of ['senior-architect', 'senior-frontend', 'senior-backend', 'senior-reviewer']) {
      assert.equal(high?.roles[role]?.preferredModel, 'gpt-5.6-sol', role);
    }
    assert.equal(high?.roles['senior-tester']?.preferredModel, 'gpt-5.6-terra');
    assert.equal(high?.roles['senior-shipper']?.preferredModel, 'gpt-5.6-terra');
  });
});

test('run policy freezes a selected same-tier model first and preserves the remaining fallback order', () => {
  fixture((cwd, baseEnv) => {
    const env = { ...baseEnv, TRAFFIC_ONE_HOST: 'claude', TRAFFIC_ONE_USER_PLAN: 'max' };
    // Pick a NON-preferred member of the row so the hoist is actually exercised,
    // whichever model currently anchors the tier.
    const highestRow = modelTierSnapshot('claude', undefined).highest;
    const selected = highestRow[1] as string;
    const state = claudeStateFor(env, { 'senior-architect': selected });
    const policy = ensureRunModelPolicy(cwd, 'selected-model', 'claude', state, env);

    assert.ok(policy);
    assert.deepEqual(policy!.tiers.highest, highestRow);
    assert.deepEqual(policy!.roles['senior-architect'], {
      tier: 'highest',
      preferredModel: selected,
      acceptableModels: [selected, ...highestRow.filter((model) => model !== selected)],
    });
    assert.deepEqual(
      readRunModelPolicy(cwd, 'selected-model')?.roles['senior-architect'],
      policy!.roles['senior-architect'],
      'a selected-first permutation remains valid after decoding the immutable policy',
    );

    const changedState = claudeStateFor(env, { 'senior-architect': 'opus' });
    const stillFrozen = ensureRunModelPolicy(cwd, 'selected-model', 'claude', changedState, env);
    assert.equal(stillFrozen?.policyId, policy!.policyId);
    assert.equal(stillFrozen?.roles['senior-architect']?.preferredModel, selected);
  });
});

test('run policy freezes a cross-tier pair only when its tier override accompanies the exact model', () => {
  fixture((cwd, baseEnv) => {
    const env = { ...baseEnv, TRAFFIC_ONE_HOST: 'claude', TRAFFIC_ONE_USER_PLAN: 'max' };
    const state = claudeStateFor(
      env,
      { 'senior-architect': 'claude-sonnet-4-6' },
      { 'senior-architect': 'balanced' },
    );
    const policy = ensureRunModelPolicy(cwd, 'cross-tier-pair', 'claude', state, env);

    assert.deepEqual(policy?.roles['senior-architect'], {
      tier: 'balanced',
      preferredModel: 'claude-sonnet-4-6',
      acceptableModels: ['claude-sonnet-4-6', 'claude-sonnet-5', 'sonnet'],
    });
    assert.deepEqual(
      readRunModelPolicy(cwd, 'cross-tier-pair')?.roles['senior-architect'],
      policy?.roles['senior-architect'],
    );
  });
});

test('run policy fails closed when an explicit role model selection crosses tiers', () => {
  fixture((cwd, baseEnv) => {
    const env = { ...baseEnv, TRAFFIC_ONE_HOST: 'claude', TRAFFIC_ONE_USER_PLAN: 'max' };
    const state = claudeStateFor(env, { 'senior-architect': 'claude-sonnet-5' });

    assert.equal(ensureRunModelPolicy(cwd, 'cross-tier-selection', 'claude', state, env), null);
    assert.equal(readRunModelPolicy(cwd, 'cross-tier-selection'), null);
    assert.equal(
      fs.existsSync(runModelPolicyPath(cwd, 'cross-tier-selection')),
      false,
      'a rejected explicit selection must not publish a reusable policy path',
    );
  });
});

test('a pre-release Performance target without configVersion cannot mint a run policy', () => {
  fixture((cwd, env) => {
    const state = stateFor(env, 'balanced');
    delete ((state.performance as Record<string, unknown>).target as Record<string, unknown>).configVersion;
    assert.equal(ensureRunModelPolicy(cwd, 'legacy-target', 'codex', state, env), null);
    assert.equal(readRunModelPolicy(cwd, 'legacy-target'), null);
  });
});

test('a published run policy is immutable across later Performance changes and corruption', () => {
  fixture((cwd, env) => {
    const first = ensureRunModelPolicy(cwd, 'immutable', 'codex', stateFor(env, 'balanced'), env);
    assert.ok(first);
    const second = ensureRunModelPolicy(cwd, 'immutable', 'codex', stateFor(env, 'high'), env);
    assert.equal(second?.policyId, first?.policyId);
    assert.equal(second?.performanceLevel, 'balanced');
    assert.equal(second?.roles['senior-architect']?.preferredModel, 'gpt-5.6-terra');

    const file = runModelPolicyPath(cwd, 'immutable');
    const tampered = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    (tampered.roles as Record<string, { preferredModel: string }> )['senior-architect']!.preferredModel = 'gpt-5.6-sol';
    fs.writeFileSync(file, JSON.stringify(tampered), 'utf8');
    assert.equal(readRunModelPolicy(cwd, 'immutable'), null, 'hash/role-row tampering is rejected');
    assert.equal(
      ensureRunModelPolicy(cwd, 'immutable', 'codex', stateFor(env, 'high'), env),
      null,
      'an existing corrupt path cannot be rebased from mutable current state',
    );
    assert.equal(
      (JSON.parse(fs.readFileSync(file, 'utf8')).roles as Record<string, { preferredModel: string }> )['senior-architect']!.preferredModel,
      'gpt-5.6-sol',
      'fail-closed validation does not rewrite the published bytes',
    );
  });
});

test('run policy decoding rejects an over-cap tier even when its integrity hash is valid', () => {
  fixture((cwd, env) => {
    assert.ok(ensureRunModelPolicy(cwd, 'oversized-tier', 'codex', stateFor(env, 'high'), env));
    const file = runModelPolicyPath(cwd, 'oversized-tier');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const oversized = [
      'gpt-5.6-sol',
      ...Array.from({ length: ONE_MCP_MAX_MODELS_PER_TIER }, (_, i) => `sol-fallback-${i + 1}`),
    ];
    (raw.tiers as Record<string, unknown>).highest = oversized;
    for (const role of Object.values(raw.roles as Record<string, Record<string, unknown>>)) {
      if (role.tier === 'highest') role.acceptableModels = [...oversized];
    }
    rewritePolicyId(raw);
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');

    assert.equal(readRunModelPolicy(cwd, 'oversized-tier'), null);
  });
});

test('Cursor cannot freeze a partial picker capture or decode a policy without complete captured capability state', () => {
  fixture((cwd, baseEnv) => {
    const env = { ...baseEnv, TRAFFIC_ONE_HOST: 'cursor', TRAFFIC_ONE_USER_PLAN: 'pro' };
    const state = cursorStateFor(env, 'pro', 'balanced');

    assert.equal(captureCursorModels(cwd, [`${resolveModel('highest', 'cursor', 'pro')}-thinking-high`], 'pro', new Date().toISOString(), env), true);
    assert.equal(
      ensureRunModelPolicy(cwd, 'cursor-partial', 'cursor', state, env),
      null,
      'a capture that cannot run the active balanced roles and quick-fix must not become immutable policy',
    );
    assert.equal(fs.existsSync(runModelPolicyPath(cwd, 'cursor-partial')), false);

    const completeCapture = [
      `${resolveModel('highest', 'cursor', 'pro')}-thinking-high`,
      'gpt-5.6-terra-medium',
      'composer-2.5-fast',
    ];
    assert.equal(captureCursorModels(cwd, completeCapture, 'pro', new Date().toISOString(), env), true);
    const policy = ensureRunModelPolicy(cwd, 'cursor-complete', 'cursor', state, env);
    assert.ok(policy);
    assert.deepEqual(policy!.cursorAvailableModels, completeCapture);

    for (const mutation of ['empty', 'missing'] as const) {
      const runId = `cursor-tampered-${mutation}`;
      assert.ok(ensureRunModelPolicy(cwd, runId, 'cursor', state, env));
      const file = runModelPolicyPath(cwd, runId);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (mutation === 'empty') raw.cursorAvailableModels = [];
      else delete raw.cursorAvailableModels;
      rewritePolicyId(raw);
      fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
      assert.equal(
        readRunModelPolicy(cwd, runId),
        null,
        `a hash-valid Cursor policy with ${mutation} capture must fail closed`,
      );
    }
  });
});

test('Cursor run policy freezes remote tiers, plan, exact picker slugs, and retry candidates until the next run', () => {
  fixture((cwd, baseEnv) => {
    const env = { ...baseEnv, TRAFFIC_ONE_HOST: 'cursor', TRAFFIC_ONE_USER_PLAN: 'pro' };
    const firstPayload: OneMcpModelConfigPayload = {
      tiers: {
        high: ['base-high'], balanced: ['base-balanced'], low: ['base-low'], auto: ['base-balanced'],
      },
      plans: {
        pro: {
          high: ['pro-high', 'pro-high-alt'],
          balanced: ['pro-balanced', 'pro-balanced-alt'],
          low: ['pro-low'],
          auto: ['pro-balanced'],
        },
      },
    };
    publishCursorPayload(env, firstPayload, 1);
    assert.equal(captureCursorModels(cwd, [
      'pro-high-build', 'pro-high-alt-build', 'pro-balanced-build',
      'pro-balanced-alt-build', 'pro-low-build',
    ], 'pro', new Date().toISOString(), env), true);
    const first = ensureRunModelPolicy(cwd, 'cursor-run-1', 'cursor', cursorStateFor(env, 'pro'), env);
    assert.ok(first);
    assert.equal(first!.source, 'remote');
    assert.equal(first!.plan, 'pro');
    assert.equal(first!.roles['senior-architect']?.preferredModel, 'pro-high');

    const secondPayload: OneMcpModelConfigPayload = {
      tiers: {
        high: ['new-base-high'], balanced: ['new-base-balanced'], low: ['new-base-low'], auto: ['new-base-balanced'],
      },
      plans: {
        business: {
          high: ['business-high', 'business-high-alt'],
          balanced: ['business-balanced', 'business-balanced-alt'],
          low: ['business-low'],
          auto: ['business-balanced'],
        },
      },
    };
    publishCursorPayload(env, secondPayload, 2);
    env.TRAFFIC_ONE_USER_PLAN = 'business';
    assert.equal(captureCursorModels(cwd, [
      'business-high-build', 'business-high-alt-build', 'business-balanced-build',
      'business-balanced-alt-build', 'business-low-build',
    ], 'business', new Date().toISOString(), env), true);
    const secondState = cursorStateFor(env, 'business');

    const stillFirst = ensureRunModelPolicy(cwd, 'cursor-run-1', 'cursor', secondState, env);
    assert.equal(stillFirst?.policyId, first!.policyId);
    assert.equal(stillFirst?.plan, 'pro');
    assert.deepEqual(stillFirst?.cursorAvailableModels, [
      'pro-high-build', 'pro-high-alt-build', 'pro-balanced-build',
      'pro-balanced-alt-build', 'pro-low-build',
    ]);
    assert.deepEqual(resolveRunPolicyFallback(first!, {
      tier: 'highest',
      exhaustedModels: ['pro-high-build'],
      capturedModels: first!.cursorAvailableModels,
    }), { family: 'pro-high-alt', model: 'pro-high-alt-build' });

    const next = ensureRunModelPolicy(cwd, 'cursor-run-2', 'cursor', secondState, env);
    assert.ok(next);
    assert.equal(next!.plan, 'business');
    assert.equal(next!.configVersion, 2);
    assert.equal(next!.roles['senior-architect']?.preferredModel, 'business-high');
    assert.deepEqual(next!.cursorAvailableModels, [
      'business-high-build', 'business-high-alt-build', 'business-balanced-build',
      'business-balanced-alt-build', 'business-low-build',
    ]);
    assert.notEqual(next!.policyId, first!.policyId);
  });
});

test('concurrent parents publish one valid create-once policy', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-run-policy-race-'));
  const env = {
    ...process.env,
    TRAFFIC_ONE_HOST: 'codex',
    TRAFFIC_ONE_USER_PLAN: 'pro',
    XDG_STATE_HOME: path.join(cwd, 'state'),
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'preferences.json'),
    TRAFFIC_ONE_POLICY_STATE: path.join(cwd, 'state.json'),
  };
  try {
    fs.writeFileSync(env.TRAFFIC_ONE_POLICY_STATE, JSON.stringify(stateFor(env, 'balanced')), 'utf8');
    const policyModule = pathToFileURL(path.resolve('src/shared/run-model-policy.ts')).href;
    const script = [
      `import fs from 'node:fs';`,
      `import { ensureRunModelPolicy } from ${JSON.stringify(policyModule)};`,
      `const state = JSON.parse(fs.readFileSync(process.env.TRAFFIC_ONE_POLICY_STATE, 'utf8'));`,
      `const policy = ensureRunModelPolicy(${JSON.stringify(cwd)}, 'concurrent', 'codex', state, process.env);`,
      `process.stdout.write(policy?.policyId || '');`,
    ].join('\n');
    // Node <23 cannot resolve a tsx-transpiled .ts module's named exports from an
    // `--eval --input-type=module` entry (native type-strip only lands in Node 23).
    // A real .mts entry transpiles via `--import tsx` exactly like every test module.
    const scriptFile = path.join(cwd, 'run-policy-child.mts');
    fs.writeFileSync(scriptFile, script, 'utf8');
    const runParent = (): Promise<string> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--import', './src/build/test-preload.mjs',
        '--import', 'tsx',
        scriptFile,
      ], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`policy child exited ${code}: ${stderr}`));
      });
    });

    const ids = await Promise.all([runParent(), runParent()]);
    assert.match(ids[0]!, /^[a-f0-9]{64}$/);
    assert.equal(ids[1], ids[0]);
    assert.equal(readRunModelPolicy(cwd, 'concurrent')?.policyId, ids[0]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Codex observation order is monotonic and exact-model verified against the frozen policy', () => {
  fixture((cwd, env) => {
    assert.ok(ensureRunModelPolicy(cwd, 'observations', 'codex', stateFor(env, 'high'), env));
    const pending = observeCodexChildModel(cwd, 'observations', {
      childId: 'child-pending',
      parentSessionId: 'parent',
      actualModel: 'gpt-5.6-sol',
      source: 'SubagentStart',
    });
    assert.equal(pending?.status, 'pending-role');
    assert.equal(observeCodexChildModel(cwd, 'observations', {
      childId: 'child-pending',
      parentSessionId: 'parent',
      role: 'senior-frontend',
      actualModel: 'gpt-5.6-sol',
      source: 'PreToolUse',
    })?.status, 'verified');

    const variant = observeCodexChildModel(cwd, 'observations', {
      childId: 'child-variant',
      parentSessionId: 'parent',
      role: 'senior-frontend',
      actualModel: 'gpt-5.6-sol-medium',
      source: 'SubagentStart',
    });
    assert.equal(variant?.status, 'mismatch', 'Codex matching is exact, not family-prefix based');
    assert.equal(observeCodexChildModel(cwd, 'observations', {
      childId: 'child-variant',
      parentSessionId: 'parent',
      role: 'senior-frontend',
      actualModel: 'gpt-5.6-sol',
      source: 'PreToolUse',
    })?.status, 'conflict', 'a later different model cannot heal rejected evidence');

    assert.equal(observeCodexChildModel(cwd, 'observations', {
      childId: 'child-corrected-role',
      parentSessionId: 'parent',
      role: 'senior-frontend',
      actualModel: 'gpt-5.6-terra',
      source: 'SubagentStart',
    })?.status, 'mismatch');
    assert.equal(
      correctCodexChildObservationRole(cwd, 'observations', 'child-corrected-role', 'senior-tester')?.status,
      'verified',
      'an authoritative role correction revalidates the same observed model',
    );
    assert.equal(
      readCodexModelObservation(cwd, 'observations', ['child-corrected-role'])?.role,
      'senior-tester',
    );
  });
});

test('Codex model evidence cannot create an observation without a parent policy', () => {
  fixture((cwd) => {
    assert.equal(observeCodexChildModel(cwd, 'missing-policy', {
      childId: 'child',
      parentSessionId: 'parent',
      role: 'senior-architect',
      actualModel: 'gpt-5.6-sol',
      source: 'SubagentStart',
    }), null);
  });
});
