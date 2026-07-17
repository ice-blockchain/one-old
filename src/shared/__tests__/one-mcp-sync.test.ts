import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { ONE_MCP_CONFIG_NAME_BY_HOST } from '../../config/one-mcp';
import { currentHostModelTarget } from '../current-model-tiers';
import {
  mapOneMcpTiers,
  oneMcpAppliedFingerprintForPlan,
  oneMcpPayloadFingerprint,
  type OneMcpFullConfigOutcome,
  type OneMcpModelConfigPayloadV2,
} from '../one-mcp';
import {
  readOneMcpConfigCacheEntry,
  readOneMcpCache,
  writeOneMcpConfigCacheEntry,
  type OneMcpConfigCacheEntry,
} from '../one-mcp-cache';
import {
  syncOneMcpHostForProject,
  type OneMcpSyncOptions,
  type OneMcpSyncResult,
} from '../one-mcp-sync';
import { currentLocalPreferenceTarget, nextLocalPreferenceStep } from '../onboarding/local-prefs';
import { mergeProjectHostPrefs, readProjectPrefs } from '../state';
import { recordPluginUseChoice } from '../state/plugin-use';

interface Fixture {
  dir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function fixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-sync-'));
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  return {
    dir,
    cwd,
    env: {
      HOME: dir,
      TRAFFIC_ONE_USER_PLAN: 'pro',
      TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'preferences.json'),
      TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json'),
      TRAFFIC_ONE_MCP_CACHE_PATH: path.join(dir, 'one-mcp.json'),
      TRAFFIC_ONE_MCP_PUBLIC_ENDPOINT: 'https://config.example.test/public-mcp',
      TRAFFIC_ONE_HOST: 'codex',
    } as NodeJS.ProcessEnv,
  };
}

function payload(tag: string, auto = `auto-${tag}`): OneMcpModelConfigPayloadV2 {
  return {
    payloadSchemaVersion: 2,
    tiers: {
      high: [`high-${tag}`, `high-fallback-${tag}`],
      balanced: [`balanced-${tag}`],
      low: [`low-${tag}`],
      auto: [auto],
    },
  };
}

function full(
  version: number,
  tag: string,
  updatedAt = `2026-07-${String(10 + version).padStart(2, '0')}T10:00:00.000Z`,
  auto?: string,
): OneMcpFullConfigOutcome {
  const value = payload(tag, auto);
  return {
    kind: 'full',
    config: {
      payload: value,
      version,
      createdAt: '2026-07-01T10:00:00.000Z',
      updatedAt,
    },
    payloadFingerprint: oneMcpPayloadFingerprint(value),
  };
}

function applied(
  outcome: OneMcpFullConfigOutcome,
  plan: 'free' | 'pro' = 'pro',
): string {
  return oneMcpAppliedFingerprintForPlan(outcome.config.payload, plan);
}

function entry(fx: Fixture, version: number, tag: string, auto?: string): OneMcpConfigCacheEntry {
  const outcome = full(version, tag, undefined, auto);
  return {
    endpoint: fx.env.TRAFFIC_ONE_MCP_PUBLIC_ENDPOINT!,
    configName: ONE_MCP_CONFIG_NAME_BY_HOST.codex,
    payloadSchemaVersion: 2,
    decoderVersion: 2,
    version,
    createdAt: outcome.config.createdAt,
    updatedAt: outcome.config.updatedAt,
    payload: outcome.config.payload,
    payloadFingerprint: outcome.payloadFingerprint,
  };
}

function sync(
  fx: Fixture,
  options: OneMcpSyncOptions = {},
): Promise<OneMcpSyncResult> {
  return syncOneMcpHostForProject(fx.cwd, 'codex', {
    featureEnabled: true,
    ...options,
    env: options.env ?? fx.env,
  });
}

function validChoice(
  fx: Fixture,
  target: { plan: string; appliedFingerprint: string; configVersion: number },
): void {
  mergeProjectHostPrefs(fx.cwd, 'codex', {
    performance: { level: 'balanced', source: 'prompted', target },
    team: { mode: 'subagents', source: 'prompted', approved: true },
  }, fx.env);
}

function preferenceStep(fx: Fixture): ReturnType<typeof nextLocalPreferenceStep> {
  const prefs = readProjectPrefs(fx.cwd, fx.env);
  const hosts = prefs.hosts as Record<string, Record<string, unknown>> | undefined;
  const hostPrefs = hosts?.codex ?? {};
  return nextLocalPreferenceStep({
    stack: 'minimal',
    openCode: { enabled: false, source: 'prompted' },
    ...hostPrefs,
    codeGraphProvider: 'graphify',
  }, 'codex', currentLocalPreferenceTarget('codex', fx.env, fx.cwd));
}

test('sync is strict opt-in and sends the exact active-host config name only after consent', async () => {
  const fx = fixture();
  try {
    let calls = 0;
    const disabled = await sync(fx, {
      env: fx.env,
      getConfig: async () => { calls += 1; return full(1, 'never'); },
    });
    assert.equal(disabled.outcome, 'disabled');
    assert.equal(calls, 0);

    recordPluginUseChoice(fx.cwd, true, 'command', fx.env);
    const seen: Array<{ endpoint: string; name: string; version: number }> = [];
    const result = await sync(fx, {
      env: fx.env,
      now: () => '2026-07-17T10:00:00Z',
      getConfig: async (endpoint, name, version) => {
        seen.push({ endpoint, name, version });
        return full(2, 'v2');
      },
    });
    assert.deepEqual(seen, [{
      endpoint: 'https://config.example.test/public-mcp',
      name: 'traffic_one_codex_plugin_ai_model_configuration',
      version: 0,
    }]);
    assert.equal(result.outcome, 'full');
    assert.equal(result.source, 'one-mcp');
    assert.equal(result.configVersion, 2);
    assert.equal(readOneMcpConfigCacheEntry('codex', fx.env)?.version, 2);
    assert.deepEqual(readOneMcpCache(fx.env).hosts.codex?.lastSync, {
      attemptedAt: '2026-07-17T10:00:00.000Z',
      outcome: 'full',
      source: 'one-mcp',
      requestedVersion: 0,
      observedVersion: 2,
    });
    assert.equal(fs.existsSync(fx.env.TRAFFIC_ONE_STATE_PATH!), false, 'sync never writes one.json');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('an unusable up-to-date sentinel retries once from version zero', async () => {
  const fx = fixture();
  try {
    recordPluginUseChoice(fx.cwd, true, 'command', fx.env);
    const versions: number[] = [];
    const result = await sync(fx, {
      env: fx.env,
      getConfig: async (_endpoint, _name, version) => {
        versions.push(version);
        return versions.length === 1 ? { kind: 'up-to-date', version } : full(3, 'retry');
      },
    });
    assert.deepEqual(versions, [0, 0]);
    assert.equal(result.outcome, 'full');
    assert.equal(readOneMcpConfigCacheEntry('codex', fx.env)?.version, 3);
    assert.equal(readOneMcpCache(fx.env).hosts.codex?.lastSync?.outcome, 'full');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('mapped-model drift is routed by performance.target after sync without mutating preferences', async () => {
  const fx = fixture();
  try {
    recordPluginUseChoice(fx.cwd, true, 'command', fx.env);
    const first = full(1, 'one', '2026-07-16T10:00:00.000Z');
    writeOneMcpConfigCacheEntry('codex', entry(fx, 1, 'one'), fx.env);
    validChoice(fx, { plan: 'pro', appliedFingerprint: applied(first), configVersion: 1 });
    assert.equal(preferenceStep(fx), null);
    const preferencesBefore = fs.readFileSync(fx.env.TRAFFIC_ONE_PROJECT_PREFS_PATH!, 'utf8');

    const changed = full(2, 'two', '2026-07-17T10:00:00.000Z');
    const result = await sync(fx, {
      env: fx.env,
      now: () => '2026-07-17T10:00:00Z',
      getConfig: async () => changed,
    });
    assert.equal(result.outcome, 'full');
    assert.equal(preferenceStep(fx), 'performance');
    assert.equal(
      fs.readFileSync(fx.env.TRAFFIC_ONE_PROJECT_PREFS_PATH!, 'utf8'),
      preferencesBefore,
      'sync owns only the machine cache; the wizard owns the Performance acknowledgement',
    );
    assert.equal(readOneMcpCache(fx.env).hosts.codex?.lastSync?.observedVersion, 2);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('auto-only and metadata-only changes keep the semantic Performance target valid', async () => {
  const fx = fixture();
  try {
    recordPluginUseChoice(fx.cwd, true, 'command', fx.env);
    const v1 = full(1, 'same', '2026-07-15T10:00:00.000Z', 'auto-old');
    writeOneMcpConfigCacheEntry('codex', entry(fx, 1, 'same', 'auto-old'), fx.env);
    validChoice(fx, { plan: 'pro', appliedFingerprint: applied(v1), configVersion: 1 });
    const v2 = full(2, 'same', '2026-07-17T10:00:00.000Z', 'auto-new');
    const result = await sync(fx, {
      env: fx.env,
      getConfig: async () => v2,
    });
    assert.equal(applied(v1), applied(v2));
    assert.notEqual(v1.payloadFingerprint, v2.payloadFingerprint);
    assert.equal(result.outcome, 'full');
    assert.equal(preferenceStep(fx), null);
    const prefs = readProjectPrefs(fx.cwd, fx.env);
    const target = (((prefs.hosts as Record<string, Record<string, unknown>>).codex?.performance) as {
      target: { plan: string; appliedFingerprint: string; configVersion: number };
    } | undefined)?.target;
    assert.deepEqual(target, {
      plan: 'pro',
      appliedFingerprint: applied(v2),
      configVersion: 2,
    }, 'metadata-only version advances without reopening Performance');
    assert.equal(readOneMcpCache(fx.env).hosts.codex?.lastSync?.observedVersion, 2);

    const v3 = full(3, 'same', '2026-07-18T10:00:00.000Z', 'auto-new');
    assert.equal(v3.payloadFingerprint, v2.payloadFingerprint, 'v3 is metadata-only');
    await sync(fx, { env: fx.env, getConfig: async () => v3 });
    assert.equal(preferenceStep(fx), null);
    const advanced = readProjectPrefs(fx.cwd, fx.env) as {
      hosts?: { codex?: { performance?: { target?: { configVersion?: number } } } };
    };
    assert.equal(advanced.hosts?.codex?.performance?.target?.configVersion, 3);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('config_not_found clears remote cache and applies bundled defaults', async () => {
  const fx = fixture();
  try {
    recordPluginUseChoice(fx.cwd, true, 'command', fx.env);
    writeOneMcpConfigCacheEntry('codex', entry(fx, 4, 'remote'), fx.env);
    validChoice(fx, currentLocalPreferenceTarget('codex', fx.env, fx.cwd));
    assert.equal(preferenceStep(fx), null);
    const result = await sync(fx, {
      env: fx.env,
      now: () => '2026-07-17T10:00:00Z',
      getConfig: async () => ({ kind: 'config-not-found' }),
    });
    assert.equal(result.outcome, 'config-not-found');
    assert.equal(result.source, 'bundled');
    assert.equal(readOneMcpConfigCacheEntry('codex', fx.env), null);
    assert.equal(preferenceStep(fx), 'performance');
    assert.deepEqual(readOneMcpCache(fx.env).hosts.codex?.lastSync, {
      attemptedAt: '2026-07-17T10:00:00.000Z',
      outcome: 'config-not-found',
      source: 'bundled',
      requestedVersion: 4,
      observedVersion: 0,
    });
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('a late duplicate response cannot overwrite a newer cache identity', async () => {
  const fx = fixture();
  try {
    recordPluginUseChoice(fx.cwd, true, 'command', fx.env);
    writeOneMcpConfigCacheEntry('codex', entry(fx, 1, 'v1'), fx.env);
    const lateV2 = full(2, 'v2');
    const newest = entry(fx, 3, 'v3');
    const result = await sync(fx, {
      env: fx.env,
      getConfig: async () => {
        writeOneMcpConfigCacheEntry('codex', newest, fx.env);
        return lateV2;
      },
    });
    assert.equal(result.changed, false);
    assert.equal(result.configVersion, 3);
    assert.equal(readOneMcpConfigCacheEntry('codex', fx.env)?.version, 3);
    assert.deepEqual(currentHostModelTarget('codex', 'pro', fx.env).snapshot.tiers, mapOneMcpTiers(newest.payload.tiers));
    assert.equal(readOneMcpCache(fx.env).hosts.codex?.lastSync, null, 'stale completion cannot publish diagnostics either');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('a first-session stale full response cannot resurrect a config after a newer not-found result', async () => {
  const fx = fixture();
  try {
    recordPluginUseChoice(fx.cwd, true, 'command', fx.env);
    let releaseOlder: ((value: OneMcpFullConfigOutcome) => void) | null = null;
    let olderStarted!: () => void;
    const started = new Promise<void>((resolve) => { olderStarted = resolve; });
    const olderResponse = new Promise<OneMcpFullConfigOutcome>((resolve) => { releaseOlder = resolve; });

    const older = sync(fx, {
      env: fx.env,
      getConfig: async () => {
        olderStarted();
        return olderResponse;
      },
    });
    await started;

    const newer = await sync(fx, {
      env: fx.env,
      getConfig: async () => ({ kind: 'config-not-found' }),
    });
    assert.equal(newer.outcome, 'config-not-found');
    releaseOlder!(full(1, 'stale-first-session'));
    const stale = await older;

    assert.equal(stale.changed, false);
    assert.equal(stale.source, 'bundled');
    assert.equal(readOneMcpConfigCacheEntry('codex', fx.env), null);
    assert.equal(readOneMcpCache(fx.env).hosts.codex?.lastSync?.outcome, 'config-not-found');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('temporary failure preserves the last valid cache and does not downgrade', async () => {
  const fx = fixture();
  try {
    recordPluginUseChoice(fx.cwd, true, 'command', fx.env);
    const cached = entry(fx, 5, 'offline');
    writeOneMcpConfigCacheEntry('codex', cached, fx.env);
    const result = await sync(fx, {
      env: fx.env,
      getConfig: async () => ({ kind: 'temporary-error' }),
    });
    assert.equal(result.outcome, 'temporary-error');
    assert.equal(result.source, 'one-mcp');
    assert.equal(result.configVersion, 5);
    assert.equal(readOneMcpConfigCacheEntry('codex', fx.env)?.version, 5);
    assert.deepEqual(readOneMcpCache(fx.env).hosts.codex?.lastSync && {
      outcome: readOneMcpCache(fx.env).hosts.codex?.lastSync?.outcome,
      source: readOneMcpCache(fx.env).hosts.codex?.lastSync?.source,
      requestedVersion: readOneMcpCache(fx.env).hosts.codex?.lastSync?.requestedVersion,
      observedVersion: readOneMcpCache(fx.env).hosts.codex?.lastSync?.observedVersion,
    }, {
      outcome: 'temporary-error',
      source: 'one-mcp',
      requestedVersion: 5,
      observedVersion: 5,
    });
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('invalid remote payload diagnostics retain a valid observed row version', async () => {
  const fx = fixture();
  try {
    recordPluginUseChoice(fx.cwd, true, 'command', fx.env);
    writeOneMcpConfigCacheEntry('codex', entry(fx, 5, 'cached'), fx.env);
    const result = await sync(fx, {
      env: fx.env,
      getConfig: async () => ({
        kind: 'invalid-response',
        reason: 'unsupported-payload-schema',
        observedVersion: 7,
      }),
    });
    assert.equal(result.source, 'one-mcp');
    assert.equal(result.configVersion, 5);
    assert.deepEqual(readOneMcpCache(fx.env).hosts.codex?.lastSync && {
      requestedVersion: readOneMcpCache(fx.env).hosts.codex?.lastSync?.requestedVersion,
      observedVersion: readOneMcpCache(fx.env).hosts.codex?.lastSync?.observedVersion,
      reason: readOneMcpCache(fx.env).hosts.codex?.lastSync?.reason,
    }, {
      requestedVersion: 5,
      observedVersion: 7,
      reason: 'unsupported-payload-schema',
    });
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('sync never mutates one.json, whose machine settings are a separate concern', async () => {
  const fx = fixture();
  try {
    recordPluginUseChoice(fx.cwd, true, 'command', fx.env);
    const machineSettings = `${JSON.stringify({
      auth: { apiKey: 'sk-local' },
      codeGraphProvider: 'graphify',
    }, null, 2)}\n`;
    fs.writeFileSync(fx.env.TRAFFIC_ONE_STATE_PATH!, machineSettings, 'utf8');

    const result = await sync(fx, {
      env: fx.env,
      getConfig: async () => ({ kind: 'temporary-error' }),
    });

    assert.equal(result.source, 'bundled');
    assert.equal(fs.readFileSync(fx.env.TRAFFIC_ONE_STATE_PATH!, 'utf8'), machineSettings);
    assert.equal(readOneMcpCache(fx.env).hosts.codex?.lastSync?.source, 'bundled');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('up-to-date records lastSync while keeping cache and preferences unchanged', async () => {
  const fx = fixture();
  try {
    recordPluginUseChoice(fx.cwd, true, 'command', fx.env);
    const cached = entry(fx, 5, 'repair');
    writeOneMcpConfigCacheEntry('codex', cached, fx.env);
    validChoice(fx, currentLocalPreferenceTarget('codex', fx.env, fx.cwd));
    const preferencesBefore = fs.readFileSync(fx.env.TRAFFIC_ONE_PROJECT_PREFS_PATH!, 'utf8');

    const result = await sync(fx, {
      env: fx.env,
      now: () => '2026-07-17T12:00:00Z',
      getConfig: async (_endpoint, _name, version) => ({ kind: 'up-to-date', version }),
    });

    assert.equal(result.outcome, 'up-to-date');
    assert.equal(result.source, 'one-mcp');
    assert.equal(readOneMcpConfigCacheEntry('codex', fx.env)?.version, cached.version);
    assert.deepEqual(readOneMcpConfigCacheEntry('codex', fx.env)?.payload, cached.payload);
    assert.equal(fs.readFileSync(fx.env.TRAFFIC_ONE_PROJECT_PREFS_PATH!, 'utf8'), preferencesBefore);
    assert.deepEqual(readOneMcpCache(fx.env).hosts.codex?.lastSync, {
      attemptedAt: '2026-07-17T12:00:00.000Z',
      outcome: 'up-to-date',
      source: 'one-mcp',
      requestedVersion: 5,
      observedVersion: 5,
    });
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('plan drift is routed by performance.target and is never reconciled by sync', async () => {
  const fx = fixture();
  try {
    recordPluginUseChoice(fx.cwd, true, 'command', fx.env);
    writeOneMcpConfigCacheEntry('codex', entry(fx, 7, 'same-catalog'), fx.env);
    validChoice(fx, currentLocalPreferenceTarget('codex', fx.env, fx.cwd));
    assert.equal(preferenceStep(fx), null);
    const preferencesBefore = fs.readFileSync(fx.env.TRAFFIC_ONE_PROJECT_PREFS_PATH!, 'utf8');
    fx.env.TRAFFIC_ONE_USER_PLAN = 'free';
    const result = await sync(fx, {
      env: fx.env,
      getConfig: async (_endpoint, _name, version) => ({ kind: 'up-to-date', version }),
      now: () => '2026-07-17T11:00:00Z',
    });
    assert.equal(result.plan, 'free');
    assert.equal(preferenceStep(fx), 'performance');
    assert.equal(fs.readFileSync(fx.env.TRAFFIC_ONE_PROJECT_PREFS_PATH!, 'utf8'), preferencesBefore);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('sync leaves all project preferences and host siblings byte-for-byte untouched', async () => {
  const fx = fixture();
  try {
    recordPluginUseChoice(fx.cwd, true, 'command', fx.env);
    const cursorTarget = currentLocalPreferenceTarget('cursor', fx.env, fx.cwd);
    mergeProjectHostPrefs(fx.cwd, 'cursor', {
      performance: { level: 'low', source: 'prompted', target: cursorTarget },
      team: { mode: 'main-agent', source: 'prompted' },
    }, fx.env);
    const next = full(1, 'codex', '2026-07-17T10:00:00.000Z');
    validChoice(fx, currentLocalPreferenceTarget('codex', fx.env, fx.cwd));
    const preferencesBefore = fs.readFileSync(fx.env.TRAFFIC_ONE_PROJECT_PREFS_PATH!, 'utf8');
    await sync(fx, {
      env: fx.env,
      getConfig: async () => next,
    });
    assert.equal(fs.readFileSync(fx.env.TRAFFIC_ONE_PROJECT_PREFS_PATH!, 'utf8'), preferencesBefore);
    const prefs = readProjectPrefs(fx.cwd, fx.env);
    assert.deepEqual((prefs.hosts as Record<string, unknown>).cursor, {
      performance: { level: 'low', source: 'prompted', target: cursorTarget },
      team: { mode: 'main-agent', source: 'prompted' },
    });
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});
