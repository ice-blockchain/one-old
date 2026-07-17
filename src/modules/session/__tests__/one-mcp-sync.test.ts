import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { ONE_MCP_CACHE_SCHEMA_VERSION, ONE_MCP_CONFIG_NAME_BY_HOST } from '../../../config/one-mcp';
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';
import { syncOneMcpAtSessionStart } from '../session-start';
import { oneMcpSessionWarning, syncOneMcpForSession } from '../one-mcp-sync';

test('SessionStart MCP sync invokes only the active host runner with a bounded wait', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-session-'));
  const runner = path.join(dir, 'one-mcp-sync.cjs');
  const env = { TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'preferences.json') } as NodeJS.ProcessEnv;
  fs.writeFileSync(runner, '// fixture', 'utf8');
  recordPluginUseChoice(dir, true, 'test', env);
  const observed: Array<{ command: string; args: readonly string[]; timeout: number | undefined }> = [];
  const spawn = ((command: string, args: readonly string[], options: { timeout?: number }) => {
    observed.push({ command, args, timeout: options.timeout });
    return { status: 0, stdout: '{}', stderr: '' };
  }) as never;
  try {
    syncOneMcpForSession(dir, 'cursor', env, spawn, runner, true);
    assert.equal(observed[0]?.command, process.execPath);
    assert.deepEqual(observed[0]?.args, [runner, 'cursor', dir]);
    assert.ok((observed[0]?.timeout ?? 0) >= 5_000 && (observed[0]?.timeout ?? 0) < 6_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionStart MCP sync requires exact opt-in and honors the offline switch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-session-'));
  const runner = path.join(dir, 'one-mcp-sync.cjs');
  const prefs = path.join(dir, 'preferences.json');
  fs.writeFileSync(runner, '// fixture', 'utf8');
  let called = false;
  const spawn = (() => {
    called = true;
    return { status: 0, stdout: '', stderr: '' };
  }) as never;
  try {
    const missing = syncOneMcpForSession(dir, 'codex', { TRAFFIC_ONE_PROJECT_PREFS_PATH: prefs }, spawn, runner, true);
    assert.equal(missing, null);
    recordPluginUseChoice(dir, true, 'test', { TRAFFIC_ONE_PROJECT_PREFS_PATH: prefs });
    const disabled = syncOneMcpForSession(dir, 'codex', {
      TRAFFIC_ONE_PROJECT_PREFS_PATH: prefs,
      TRAFFIC_ONE_DISABLE_ONE_MCP_SYNC: '1',
    }, spawn, runner, true);
    assert.equal(disabled, null);
    assert.equal(called, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionStart MCP sync runs once per identified parent session and again for a new session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-session-stamp-'));
  const env = { TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'preferences.json') } as NodeJS.ProcessEnv;
  const calls: Array<{ host: unknown; session: string }> = [];
  const sync = ((_cwd: string, host: unknown, syncEnv: NodeJS.ProcessEnv) => {
    calls.push({ host, session: String(syncEnv.TRAFFIC_ONE_TEST_SESSION || '') });
  }) as never;
  try {
    // Missing consent: neither network bridge nor the project-local once marker.
    syncOneMcpAtSessionStart(dir, 'opencode', { session_id: 'parent-1' }, env, sync, true);
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one')), false);

    recordPluginUseChoice(dir, true, 'test', env);
    syncOneMcpAtSessionStart(dir, 'opencode', { session_id: 'parent-1' }, env, sync, true);
    syncOneMcpAtSessionStart(dir, 'opencode', { session_id: 'parent-1' }, env, sync, true);
    syncOneMcpAtSessionStart(dir, 'opencode', { session_id: 'parent-2' }, env, sync, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.host), ['opencode', 'opencode']);

    // No reliable identity: do not stamp a guessed session; duplicate calls are
    // intentionally harmless under the cache lock + CAS protocol.
    syncOneMcpAtSessionStart(dir, 'kilo', {}, env, sync, true);
    syncOneMcpAtSessionStart(dir, 'kilo', {}, env, sync, true);
    assert.equal(calls.length, 4);
    const markerDir = path.join(dir, '.traffic-one', 'runs', '.once');
    assert.equal(fs.readdirSync(markerDir).filter((name) => name.startsWith('one-mcp-sync-')).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionStart MCP sync identity is scoped by canonical host', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-host-stamp-')));
  const env = { TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'preferences.json') } as NodeJS.ProcessEnv;
  const hosts: unknown[] = [];
  try {
    recordPluginUseChoice(dir, true, 'test', env);
    syncOneMcpAtSessionStart(dir, 'cursor', { session_id: 'parent-shared' }, env, (_cwd, host) => { hosts.push(host); }, true);
    syncOneMcpAtSessionStart(dir, 'codex', { session_id: 'parent-shared' }, env, (_cwd, host) => { hosts.push(host); }, true);
    syncOneMcpAtSessionStart(dir, 'cursor', { session_id: 'parent-shared' }, env, (_cwd, host) => { hosts.push(host); }, true);
    assert.deepEqual(hosts, ['cursor', 'codex'], 'same session syncs once for each active host');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionStart MCP sync switch is checked before the session marker is written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-session-off-'));
  const env = {
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'preferences.json'),
    TRAFFIC_ONE_DISABLE_ONE_MCP_SYNC: '1',
  } as NodeJS.ProcessEnv;
  let calls = 0;
  try {
    recordPluginUseChoice(dir, true, 'test', env);
    syncOneMcpAtSessionStart(dir, 'kilo', { session_id: 'parent-off' }, env, () => { calls += 1; }, true);
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(path.join(dir, '.traffic-one')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parent SessionStart warns once per bounded invalid/config-missing diagnostic and names the fallback source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-session-warning-'));
  const cachePath = path.join(dir, 'one-mcp.json');
  const env = {
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(dir, 'preferences.json'),
    TRAFFIC_ONE_MCP_CACHE_PATH: cachePath,
  } as NodeJS.ProcessEnv;
  try {
    recordPluginUseChoice(dir, true, 'test', env);
    fs.writeFileSync(cachePath, `${JSON.stringify({
      schemaVersion: ONE_MCP_CACHE_SCHEMA_VERSION,
      hosts: {
        codex: {
          lastSync: {
            attemptedAt: '2026-07-17T10:00:00.000Z',
            outcome: 'invalid-response',
            source: 'one-mcp',
            requestedVersion: 4,
            observedVersion: 5,
            reason: 'invalid-full-config',
            remoteError: 'untrusted remote text must never surface',
          },
        },
        cursor: {
          lastSync: {
            attemptedAt: '2026-07-17T10:00:00.000Z',
            outcome: 'config-not-found',
            source: 'bundled',
            requestedVersion: 2,
            observedVersion: 0,
          },
        },
      },
    }, null, 2)}\n`, 'utf8');

    const first = syncOneMcpAtSessionStart(
      dir,
      'codex',
      { session_id: 'warning-parent-1' },
      env,
      () => undefined,
      true,
    );
    assert.match(first || '', new RegExp(ONE_MCP_CONFIG_NAME_BY_HOST.codex));
    assert.match(first || '', /invalid-full-config/);
    assert.match(first || '', /last valid cached One MCP model catalog/);
    assert.doesNotMatch(first || '', /untrusted remote text/);
    assert.equal(oneMcpSessionWarning('codex', env), null, 'same diagnostic is already claimed');

    const missing = oneMcpSessionWarning('cursor', env);
    assert.match(missing || '', /published configuration is missing/);
    assert.match(missing || '', /bundled model catalog/);

    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
      hosts: { codex: { lastSync: { observedVersion: number } } };
    };
    raw.hosts.codex.lastSync.observedVersion = 6;
    fs.writeFileSync(cachePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const changedVersion = oneMcpSessionWarning('codex', env);
    assert.match(changedVersion || '', /observed version 6/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parent SessionStart keeps temporary One MCP transport failures silent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-one-mcp-session-warning-'));
  const cachePath = path.join(dir, 'one-mcp.json');
  const env = { TRAFFIC_ONE_MCP_CACHE_PATH: cachePath } as NodeJS.ProcessEnv;
  try {
    fs.writeFileSync(cachePath, `${JSON.stringify({
      schemaVersion: ONE_MCP_CACHE_SCHEMA_VERSION,
      hosts: {
        kilo: {
          lastSync: {
            attemptedAt: '2026-07-17T10:00:00.000Z',
            outcome: 'unavailable',
            source: 'bundled',
            requestedVersion: 0,
            observedVersion: 0,
            reason: 'transport-failed',
          },
        },
      },
    }, null, 2)}\n`, 'utf8');
    assert.equal(oneMcpSessionWarning('kilo', env), null);
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { hosts: { kilo: Record<string, unknown> } };
    assert.equal(Object.prototype.hasOwnProperty.call(raw.hosts.kilo, 'lastWarningKey'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
