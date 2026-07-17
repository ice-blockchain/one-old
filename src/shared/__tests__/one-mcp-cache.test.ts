import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ONE_MCP_CACHE_SCHEMA_VERSION,
  ONE_MCP_DECODER_VERSION,
  ONE_MCP_PAYLOAD_SCHEMA_VERSION,
} from '../../config/one-mcp';
import type { HostModelKey } from '../../config/model-tiers';
import { oneMcpPayloadFingerprint } from '../one-mcp';
import {
  ONE_MCP_CACHE_LOCK_TIMEOUT_MS,
  beginOneMcpConfigCacheRequest,
  clearOneMcpConfigCacheEntry,
  claimOneMcpWarningKey,
  completeOneMcpConfigCacheRequest,
  compareAndSwapOneMcpConfigCacheEntry,
  oneMcpCachePath,
  oneMcpConfigCacheIdentity,
  readOneMcpConfigCacheEntry,
  readOneMcpCache,
  writeOneMcpConfigCacheEntry,
  type OneMcpConfigCacheEntry,
} from '../one-mcp-cache';

function withCache(fn: (file: string, env: NodeJS.ProcessEnv, dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-cache-'));
  const file = path.join(dir, 'one-mcp.json');
  const env = { TRAFFIC_ONE_MCP_CACHE_PATH: file } as NodeJS.ProcessEnv;
  try {
    fn(file, env, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withCacheAsync(
  fn: (file: string, env: NodeJS.ProcessEnv, dir: string) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-cache-'));
  const file = path.join(dir, 'one-mcp.json');
  const env = { TRAFFIC_ONE_MCP_CACHE_PATH: file } as NodeJS.ProcessEnv;
  try {
    await fn(file, env, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cacheEntry(host: HostModelKey, version: number): OneMcpConfigCacheEntry {
  const payload = {
    payloadSchemaVersion: 2 as const,
    tiers: {
      high: [`${host}-high-v${version}`],
      balanced: [`${host}-balanced-v${version}`],
      low: [`${host}-low-v${version}`],
      auto: [`${host}-auto-v${version}`],
    },
  };
  return {
    endpoint: 'https://example.test/public-mcp',
    configName: `traffic_one_${host}_plugin_ai_model_configuration`,
    payloadSchemaVersion: ONE_MCP_PAYLOAD_SCHEMA_VERSION,
    decoderVersion: ONE_MCP_DECODER_VERSION,
    version,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: `2026-07-${String(16 + Math.min(version, 9)).padStart(2, '0')}T00:00:00.000Z`,
    payload,
    payloadFingerprint: oneMcpPayloadFingerprint(payload),
  };
}

test('One MCP cache writes securely and round-trips independently from one.json', () => {
  withCache((file, env) => {
    const entry = cacheEntry('codex', 1);
    assert.equal(oneMcpCachePath(env), file);
    writeOneMcpConfigCacheEntry('codex', entry, env);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readOneMcpConfigCacheEntry('codex', env), entry);
    assert.throws(
      () => writeOneMcpConfigCacheEntry('codex', { ...entry, version: 0 }, env),
      /invalid.*cache entry/i,
    );
    assert.throws(
      () => writeOneMcpConfigCacheEntry('codex', { ...entry, version: 2_147_483_648 }, env),
      /invalid.*cache entry/i,
    );
  });
});

test('One MCP cache stores canonical v2 plan overrides without derived fingerprints', () => {
  withCache((file, env) => {
    const base = cacheEntry('codex', 1);
    const payload = {
      ...base.payload,
      plans: {
        pro: {
          high: ['pro-high'], balanced: ['pro-balanced'], low: ['pro-low'], auto: ['pro-balanced'],
        },
      },
    };
    const entry: OneMcpConfigCacheEntry = {
      ...base,
      payload,
      payloadFingerprint: oneMcpPayloadFingerprint(payload),
    };
    writeOneMcpConfigCacheEntry('codex', entry, env);
    assert.deepEqual(readOneMcpConfigCacheEntry('codex', env)?.payload.plans?.pro, payload.plans.pro);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')).hosts.codex.config;
    assert.deepEqual(stored.payload.plans.pro, payload.plans.pro);
    assert.equal('payloadFingerprint' in stored, false);
    assert.equal('appliedFingerprint' in stored, false);
  });
});

test('request completion stores one host generation, canonical config, and bounded lastSync', () => {
  withCache((file, env) => {
    const request = beginOneMcpConfigCacheRequest('codex', env);
    const entry = cacheEntry('codex', 2);
    const completed = completeOneMcpConfigCacheRequest(
      'codex',
      request.identity,
      request.syncGeneration,
      { kind: 'replace', entry },
      {
        attemptedAt: '2026-07-17T10:00:00.000Z',
        outcome: 'full',
        source: 'one-mcp',
        requestedVersion: 0,
        observedVersion: 2,
      },
      env,
    );
    assert.equal(completed.written, true);
    assert.deepEqual(readOneMcpCache(env).hosts.codex?.lastSync, {
      attemptedAt: '2026-07-17T10:00:00.000Z',
      outcome: 'full',
      source: 'one-mcp',
      requestedVersion: 0,
      observedVersion: 2,
    });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.hosts.codex.syncGeneration, request.syncGeneration);
    assert.equal(raw.hosts.codex.config.version, 2);
    assert.equal(raw.hosts.codex.config.createdAt, entry.createdAt);
    assert.equal(raw.hosts.codex.config.updatedAt, entry.updatedAt);
    assert.equal('payloadFingerprint' in raw.hosts.codex.config, false);
    assert.equal('appliedFingerprint' in raw.hosts.codex.config, false);
    assert.equal('modelConfigs' in raw, false);
    assert.equal('requestTokens' in raw, false);
  });
});

test('warning keys are claimed once under the same cache lock', () => {
  withCache((_file, env) => {
    writeOneMcpConfigCacheEntry('codex', cacheEntry('codex', 1), env);
    assert.equal(claimOneMcpWarningKey('codex', 'codex|invalid-full-config|0|1', env), true);
    assert.equal(claimOneMcpWarningKey('codex', 'codex|invalid-full-config|0|1', env), false);
    assert.equal(claimOneMcpWarningKey('codex', 'codex|unsupported-payload-schema|1|1', env), true);
    assert.equal(
      readOneMcpCache(env).hosts.codex?.lastWarningKey,
      'codex|unsupported-payload-schema|1|1',
    );
    assert.throws(() => claimOneMcpWarningKey('codex', 'bad\nkey', env), /warning key/i);
  });
});

test('One MCP cache preserves unknown envelope fields and sibling host entries', () => {
  withCache((file, env) => {
    const codex = { ...cacheEntry('codex', 1), futureEntryField: { keep: true } };
    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: ONE_MCP_CACHE_SCHEMA_VERSION,
      futureEnvelopeField: { keep: true },
      hosts: {
        codex: { syncGeneration: 'abcdef0123456789', config: codex, futureHostState: { keep: true } },
        futureHost: { keep: true },
      },
    }, null, 2)}\n`, 'utf8');

    writeOneMcpConfigCacheEntry('cursor', cacheEntry('cursor', 2), env);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(raw.futureEnvelopeField, { keep: true });
    assert.deepEqual(raw.hosts.codex.config.futureEntryField, { keep: true });
    assert.deepEqual(raw.hosts.codex.futureHostState, { keep: true });
    assert.deepEqual(raw.hosts.futureHost, { keep: true });
    assert.equal(raw.hosts.cursor.config.version, 2);
    assert.equal('payloadFingerprint' in raw.hosts.cursor.config, false);
    assert.equal('appliedFingerprint' in raw.hosts.cursor.config, false);
  });
});

test('One MCP cache CAS discards late responses but permits an intentional server rollback', () => {
  withCache((_file, env) => {
    const v1 = writeOneMcpConfigCacheEntry('codex', cacheEntry('codex', 1), env);
    const requestIdentity = oneMcpConfigCacheIdentity(v1);
    const v3 = writeOneMcpConfigCacheEntry('codex', cacheEntry('codex', 3), env);

    const lateV2 = compareAndSwapOneMcpConfigCacheEntry(
      'codex', requestIdentity, cacheEntry('codex', 2), env,
    );
    assert.equal(lateV2.written, false);
    assert.equal(lateV2.current?.version, 3);

    const rollback = compareAndSwapOneMcpConfigCacheEntry(
      'codex', oneMcpConfigCacheIdentity(v3), cacheEntry('codex', 2), env,
    );
    assert.equal(rollback.written, true);
    assert.equal(readOneMcpConfigCacheEntry('codex', env)?.version, 2);
  });
});

test('One MCP cache recovers malformed current data but never overwrites a future schema', () => {
  withCache((file, env) => {
    fs.writeFileSync(file, '{malformed', 'utf8');
    writeOneMcpConfigCacheEntry('codex', cacheEntry('codex', 1), env);
    assert.equal(readOneMcpConfigCacheEntry('codex', env)?.version, 1);

    const future = `${JSON.stringify({ schemaVersion: 3, future: { keep: true } }, null, 2)}\n`;
    fs.writeFileSync(file, future, 'utf8');
    assert.throws(
      () => writeOneMcpConfigCacheEntry('codex', cacheEntry('codex', 2), env),
      /newer than this plugin/i,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), future);
  });
});

test('pre-release v1 cache is ignored and replaced without migration', () => {
  withCache((file, env) => {
    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: 1,
      hosts: {
        codex: {
          syncGeneration: 'abcdef0123456789',
          config: {
            endpoint: 'https://example.test/public-mcp',
            configName: 'traffic_one_codex_plugin_ai_model_configuration',
            decoderVersion: 1,
            version: 99,
            updatedAt: '2026-07-16T00:00:00.000Z',
            payload: {
              payloadSchemaVersion: 1,
              tiers: { high: ['old-h'], balanced: ['old-b'], low: ['old-l'], auto: ['old-a'] },
            },
          },
        },
      },
    }, null, 2)}\n`, 'utf8');

    assert.equal(readOneMcpConfigCacheEntry('codex', env), null);
    const request = beginOneMcpConfigCacheRequest('codex', env);
    assert.equal(request.entry, null);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.schemaVersion, 2);
    assert.equal(raw.hosts.codex.config, undefined);
  });
});

test('future decoder and payload cache entries are unreadable but never overwritten', () => {
  withCache((file, env) => {
    const base = cacheEntry('codex', 1);
    const futureEntries = [
      { ...base, decoderVersion: 3 },
      { ...base, payload: { ...base.payload, payloadSchemaVersion: 3 } },
    ];
    for (const futureEntry of futureEntries) {
      const future = `${JSON.stringify({
        schemaVersion: ONE_MCP_CACHE_SCHEMA_VERSION,
        hosts: { codex: { syncGeneration: 'abcdef0123456789', config: futureEntry } },
      }, null, 2)}\n`;
      fs.writeFileSync(file, future, 'utf8');
      assert.equal(readOneMcpConfigCacheEntry('codex', env), null);
      assert.throws(
        () => writeOneMcpConfigCacheEntry('codex', cacheEntry('codex', 2), env),
        /entry.*newer than this plugin/i,
      );
      assert.throws(
        () => compareAndSwapOneMcpConfigCacheEntry('codex', null, cacheEntry('codex', 2), env),
        /entry.*newer than this plugin/i,
      );
      assert.equal(clearOneMcpConfigCacheEntry('codex', env), false);
      assert.equal(fs.readFileSync(file, 'utf8'), future);
    }
  });
});

test('One MCP cache lock timeout is bounded and never falls back to an unlocked write', () => {
  withCache((file, env) => {
    const lockDir = `${file}.lock`;
    const token = '1a1e123';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, `owner-${token}.json`), JSON.stringify({
      pid: process.pid,
      token,
      createdAt: Date.now(),
    }), 'utf8');
    const started = Date.now();
    assert.throws(() => writeOneMcpConfigCacheEntry('codex', cacheEntry('codex', 1), env), /lock timed out/i);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= ONE_MCP_CACHE_LOCK_TIMEOUT_MS - 50);
    assert.ok(elapsed < ONE_MCP_CACHE_LOCK_TIMEOUT_MS + 1_000);
    assert.equal(fs.existsSync(file), false);
  });
});

test('an old empty One MCP cache lock left by an interrupted release is recovered', () => {
  withCache((file, env) => {
    const lockDir = `${file}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    const abandonedAt = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, abandonedAt, abandonedAt);

    writeOneMcpConfigCacheEntry('codex', cacheEntry('codex', 1), env);

    assert.equal(readOneMcpConfigCacheEntry('codex', env)?.version, 1);
    assert.equal(fs.existsSync(lockDir), false);
    assert.deepEqual(
      fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.released')),
      [],
    );
  });
});

test('concurrent One MCP cache writers preserve different host entries', async () => {
  await withCacheAsync(async (file) => {
    const modulePath = path.resolve(__dirname, '..', 'one-mcp-cache.ts');
    const childSource = [
      `const { writeOneMcpConfigCacheEntry } = require(${JSON.stringify(modulePath)});`,
      'const host = process.argv[1];',
      'const file = process.argv[2];',
      'const version = Number(process.argv[3]);',
      `const { oneMcpPayloadFingerprint } = require(${JSON.stringify(path.resolve(__dirname, '..', 'one-mcp', 'index.ts'))});`,
      'const payload = { payloadSchemaVersion: 2, tiers: { high: [`${host}-high`], balanced: [`${host}-balanced`], low: [`${host}-low`], auto: [`${host}-auto`] } };',
      'const entry = { endpoint: "https://example.test/public-mcp", configName: `traffic_one_${host}_plugin_ai_model_configuration`, payloadSchemaVersion: 2, decoderVersion: 2, version, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z", payload, payloadFingerprint: oneMcpPayloadFingerprint(payload) };',
      'for (let i = 0; i < 20; i += 1) writeOneMcpConfigCacheEntry(host, entry, { TRAFFIC_ONE_MCP_CACHE_PATH: file });',
    ].join(' ');
    const run = (host: HostModelKey, version: number) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', childSource, host, file, String(version)], {
        cwd: path.resolve(__dirname, '../../..'),
        env: { ...process.env },
        stdio: 'pipe',
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
    });

    await Promise.all([run('codex', 1), run('cursor', 2)]);
    const env = { TRAFFIC_ONE_MCP_CACHE_PATH: file } as NodeJS.ProcessEnv;
    assert.equal(readOneMcpConfigCacheEntry('codex', env)?.version, 1);
    assert.equal(readOneMcpConfigCacheEntry('cursor', env)?.version, 2);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp')), []);
  });
});
