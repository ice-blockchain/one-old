import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { runCursorHook } from '../cursor-entry';
import { writeServerRecord } from '../../shared/onboarding-server/registry';

// These tests exercise the setup-wizard flow itself, which under the shipped
// ask-first default (ASK_USE_PLUGIN_FIRST) only starts after the user's
// recorded yes. Pin the runtime override off so the wizard paths stay directly
// testable; the ask-first question has dedicated tests that set the flag to '1'.
process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

async function withEnv(opts: { authed: boolean }, fn: (cwd: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cursor-entry-'));
  const env = process.env;
  const saved = { ep: env.TRAFFIC_ONE_MCP_KEY_ENDPOINT, state: env.TRAFFIC_ONE_STATE_PATH, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH, noSpawn: env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN };
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1'; // unit tests must never spawn a real wizard server
  if (opts.authed) {
    fs.writeFileSync(env.TRAFFIC_ONE_STATE_PATH, JSON.stringify({
      schemaVersion: 3,
      auth: { version: 1, authenticated: true, apiKey: 'sk-telemetry-123', updatedAt: '2099-01-01T00:00:00Z' },
      hosts: {},
    }), 'utf8');
  }
  try {
    await fn(dir);
  } finally {
    for (const [k, v] of Object.entries({
      TRAFFIC_ONE_MCP_KEY_ENDPOINT: saved.ep, TRAFFIC_ONE_STATE_PATH: saved.state,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_ONBOARDING_NO_SPAWN: saved.noSpawn,
    })) { if (v === undefined) delete env[k]; else env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('unknown / missing subcommand → cursor noop "{}"', async () => {
  assert.equal((await runCursorHook(undefined, '{}')).stdout, '{}');
  // An unmapped subcommand falls back to a PreToolUse with no tool → noop merge.
  assert.equal((await runCursorHook('totally-unknown', '{}')).stdout, '{}');
});

test('beforeShellExecution UNAUTHED denies (auth gate, flat permission shape)', async () => {
  await withEnv({ authed: false }, async (cwd) => {
    const stdin = JSON.stringify({ cwd, command: 'npm run build' });
    const r = await runCursorHook('before-shell-execution', stdin);
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
    assert.ok(typeof out.user_message === 'string' && out.user_message.length > 0);
  });
});

test('beforeShellExecution AUTHED + benign command on an existing codebase → noop "{}"', async () => {
  await withEnv({ authed: true }, async (cwd) => {
    // existing-codebase mode has no new-project onboarding gate; a benign
    // command trips neither the architecture nor the library gate.
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');
    const stdin = JSON.stringify({ cwd, command: 'ls -la' });
    const r = await runCursorHook('before-shell-execution', stdin);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '{}');
  });
});

test('beforeShellExecution AUTHED on a fresh new-project dir → onboarding gate denies', async () => {
  await withEnv({ authed: true }, async (cwd) => {
    // Seed a live server record so the gate (NO_SPAWN) surfaces a real dashboard link.
    writeServerRecord(cwd, { pid: process.pid, port: 55555, token: 'tok', url: 'http://127.0.0.1:55555/?t=tok', startedAt: 'x' }, process.env, 'cursor');
    const stdin = JSON.stringify({ cwd, command: 'npm run build' });
    const r = await runCursorHook('before-shell-execution', stdin);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
    assert.ok(out.user_message.includes('/onboarding/agent'), 'deny carries the dashboard setup URL');
    assert.ok(/setup/i.test(out.user_message));
  });
});

test('beforeReadFile AUTHED denies a sibling workspace path', async () => {
  await withEnv({ authed: true }, async (cwd) => {
    const ws6b = path.join(cwd, '6b');
    const ws5b = path.join(cwd, '5b');
    const stateDir = path.join(ws6b, '.traffic-' + 'one');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(ws5b, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.one.json'), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');
    fs.writeFileSync(path.join(ws5b, 'package.json'), '{}\n', 'utf8');

    const stdin = JSON.stringify({
      cwd: ws6b,
      workspace_roots: [ws6b],
      file_path: path.join(ws5b, 'package.json'),
    });
    const r = await runCursorHook('before-read-file', stdin);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
    assert.ok(out.user_message.includes('workspace boundary blocked'));
  });
});

test('sessionStart returns valid JSON (never throws to the host)', async () => {
  await withEnv({ authed: true }, async (cwd) => {
    const stdin = JSON.stringify({ cwd });
    const r = await runCursorHook('session-start', stdin);
    assert.equal(r.exitCode, 0);
    // Must be parseable JSON (noop "{}" or a context object).
    assert.doesNotThrow(() => JSON.parse(r.stdout));
  });
});
