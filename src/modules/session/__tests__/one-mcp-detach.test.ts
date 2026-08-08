// src/modules/session/__tests__/one-mcp-detach.test.ts
// SessionStart must not BLOCK on the public-MCP worker once this machine has a
// model catalog to read.
//
// The defect, measured. `syncOneMcpForSession` is a `spawnSync` of a second
// full node process, and SessionStart waited on it with a blocking factor of
// 1.040-1.062 against a controlled-latency stub (a stub sleeping 500 ms moved
// SessionStart's p50 from 235.53 ms to 755.71 ms). The only ceiling on that
// wait is ONE_MCP_SESSION_SYNC_TIMEOUT_MS = 21_000 ms, so a slow endpoint could
// hold a session open for twenty-one seconds before the first prompt.
//
// What may NOT be lost. The wait is not decorative on a cold cache: with no
// usable cached config every model-tier read LATER IN THE SAME INVOCATION —
// agent-model's session-start handler, session/triage-directive.ts, and the
// gates under them, all via shared/current-model-tiers.ts — answers from the
// BUNDLED catalog. So the split is by cache state, and both halves are pinned
// here: cold still blocks, warm detaches.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { DEFAULT_PUBLIC_ENDPOINT, ONE_MCP_CONFIG_NAME_BY_HOST, ONE_MCP_DECODER_VERSION } from '../../../config/one-mcp';
import { oneMcpPayloadFingerprint, type OneMcpModelConfigPayload } from '../../../shared/one-mcp';
import { writeOneMcpConfigCacheEntry } from '../../../shared/one-mcp/cache';
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';
import {
  sessionOneMcpSyncMode,
  syncOneMcpDetached,
  syncOneMcpForSessionStart,
} from '../one-mcp-sync';
import { syncOneMcpAtSessionStart } from '../session-start';

interface Fixture {
  readonly dir: string;
  readonly runner: string;
  readonly env: NodeJS.ProcessEnv;
}

function fixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-detach-'));
  const runner = path.join(dir, 'one-mcp-sync.cjs');
  fs.writeFileSync(runner, '// fixture', 'utf8');
  const env = {
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'preferences.json'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    HOME: dir,
  } as NodeJS.ProcessEnv;
  recordPluginUseChoice(dir, true, 'test', env);
  return { dir, runner, env };
}

/** A cached config this host's readers would actually accept. */
function seedUsableCache(env: NodeJS.ProcessEnv, host: 'claude' = 'claude'): void {
  const payload: OneMcpModelConfigPayload = {
    tiers: { high: ['opus'], balanced: ['sonnet'], low: ['haiku'], auto: ['sonnet'] },
  };
  writeOneMcpConfigCacheEntry(host, {
    endpoint: DEFAULT_PUBLIC_ENDPOINT,
    configName: ONE_MCP_CONFIG_NAME_BY_HOST[host],
    decoderVersion: ONE_MCP_DECODER_VERSION,
    version: 7,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    payload,
    payloadFingerprint: oneMcpPayloadFingerprint(payload),
  }, env);
}

test('the sync mode is decided by whether a usable cached config exists', () => {
  const fx = fixture();
  try {
    assert.equal(
      sessionOneMcpSyncMode('claude', fx.env), 'blocking',
      'with no usable cached config every tier read in this invocation would answer from the bundled '
      + 'catalog, so the wait is buying something and must not be skipped',
    );
    seedUsableCache(fx.env);
    assert.equal(
      sessionOneMcpSyncMode('claude', fx.env), 'detached',
      'with a usable cached config the sync is a REFRESH and nothing in this invocation needs to wait for it',
    );
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('SessionStart detaches the worker once a usable cached config exists', () => {
  const fx = fixture();
  seedUsableCache(fx.env);
  const detachedCalls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  let blockingCalls = 0;
  const spawnDetached = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    detachedCalls.push({ command, args, options });
    return { unref: () => {} };
  }) as never;
  const spawnBlocking = (() => {
    blockingCalls += 1;
    return { status: 0, stdout: '{}', stderr: '' };
  }) as never;

  try {
    const started = syncOneMcpForSessionStart(fx.dir, 'claude', fx.env, {
      spawnDetached, spawnBlocking, runnerPath: fx.runner, featureEnabled: true,
    });

    assert.equal(started.kind, 'detached', `SessionStart blocked on the worker: ${JSON.stringify(started)}`);
    assert.equal(blockingCalls, 0, 'the blocking spawnSync path must not run when a usable cache exists');
    assert.equal(detachedCalls.length, 1);
    // Same argv the blocking form used — detaching may not change WHAT runs.
    assert.equal(detachedCalls[0]?.command, process.execPath);
    assert.deepEqual(detachedCalls[0]?.args, [fx.runner, 'claude', fx.dir]);
    // The three options that make it fire-and-forget. Without `detached` the
    // child stays in this process group; without `stdio: 'ignore'` the parent
    // holds pipes open and can still be kept alive by a chatty child.
    assert.equal(detachedCalls[0]?.options.detached, true, 'the child must leave this process group');
    assert.equal(detachedCalls[0]?.options.stdio, 'ignore', 'inherited pipes would re-couple parent and child');
    assert.equal(
      detachedCalls[0]?.options.timeout, undefined,
      'a parent-side timeout on a child nobody waits for is a claim the parent cannot keep',
    );
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('SessionStart still WAITS for the very first sync on a machine with no catalog', () => {
  const fx = fixture();
  let blockingCalls = 0;
  let detachedCalls = 0;
  const spawnDetached = (() => { detachedCalls += 1; return { unref: () => {} }; }) as never;
  const spawnBlocking = (() => {
    blockingCalls += 1;
    return { status: 0, stdout: '{}', stderr: '' };
  }) as never;

  try {
    const started = syncOneMcpForSessionStart(fx.dir, 'claude', fx.env, {
      spawnDetached, spawnBlocking, runnerPath: fx.runner, featureEnabled: true,
    });
    assert.equal(started.kind, 'completed');
    assert.equal(blockingCalls, 1, 'a cold cache must still be filled before this invocation reads tiers');
    assert.equal(detachedCalls, 0);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

// The three assertions above inject their spawns, so they prove
// syncOneMcpForSessionStart. They cannot prove that SessionStart CALLS it: with
// the default argument put back to the blocking form, all three stay green.
// This one takes no injection at all and separates the two by wall clock,
// against a real runner that sleeps.
test('syncOneMcpAtSessionStart does not wait for the worker it started', () => {
  const fx = fixture();
  seedUsableCache(fx.env);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-detach-root-'));
  const marker = path.join(root, 'worker-ran');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'one-mcp-sync.cjs'), [
    "'use strict';",
    'const fs = require("fs");',
    `fs.writeFileSync(${JSON.stringify(marker)}, "ran");`,
    // Long enough that a parent which waits cannot be mistaken for one that did
    // not, and short enough to be gone well before this file finishes.
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);',
    '',
  ].join('\n'), 'utf8');

  const pluginRoot0 = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  try {
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = root;
    const started = Date.now();
    syncOneMcpAtSessionStart(fx.dir, 'claude', { session_id: 'detach-wallclock' }, fx.env, undefined, true);
    const elapsed = Date.now() - started;
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = pluginRoot0;

    assert.ok(
      elapsed < 1_000,
      `SessionStart waited ${elapsed} ms on a worker that sleeps 1500 ms — it is still on the critical path`,
    );
    // Detached is not "skipped": the refresh must still have been started, or
    // the cache would never advance again.
    let ran = false;
    for (let i = 0; i < 60 && !ran; i += 1) {
      ran = fs.existsSync(marker);
      if (!ran) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.equal(ran, true, 'the worker was never started — detaching must not become skipping');
  } finally {
    if (pluginRoot0 === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT;
    else process.env.TRAFFIC_ONE_PLUGIN_ROOT = pluginRoot0;
    fs.rmSync(fx.dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the detached start reports WHY it did nothing instead of answering null', () => {
  const fx = fixture();
  const spawnDetached = (() => ({ unref: () => {} })) as never;
  try {
    assert.deepEqual(
      syncOneMcpDetached(fx.dir, 'claude', fx.env, spawnDetached, fx.runner, false),
      { kind: 'skipped', reason: 'feature-disabled' },
    );

    const undecided = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-detach-undecided-'));
    try {
      assert.deepEqual(
        syncOneMcpDetached(undecided, 'claude', {
          TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(undecided, 'preferences.json'),
        } as NodeJS.ProcessEnv, spawnDetached, fx.runner, true),
        { kind: 'skipped', reason: 'plugin-use-not-enabled' },
      );
    } finally {
      fs.rmSync(undecided, { recursive: true, force: true });
    }

    // The outcome the old `null` hid most damagingly: a DAMAGED INSTALL is not
    // a project that opted out, and before this it was the same value.
    assert.deepEqual(
      syncOneMcpDetached(fx.dir, 'claude', fx.env, spawnDetached, path.join(fx.dir, 'absent.cjs'), true),
      { kind: 'unavailable', reason: 'runner-missing' },
    );

    const throwing = (() => { throw new Error('EAGAIN'); }) as never;
    assert.deepEqual(
      syncOneMcpDetached(fx.dir, 'claude', fx.env, throwing, fx.runner, true),
      { kind: 'unavailable', reason: 'spawn-refused' },
    );
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});
