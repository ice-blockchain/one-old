import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { runCursorHook } from '../cursor-entry';

async function withEnv(opts: { authed: boolean }, fn: (cwd: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cursor-entry-'));
  const env = process.env;
  const saved = { ep: env.TRAFFIC_ONE_MCP_KEY_ENDPOINT, auth: env.TRAFFIC_ONE_AUTH_STATE_PATH, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH, choice: env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH, noSpawn: env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN };
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = path.join(dir, 'auth-choice.json');
  env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1'; // unit tests must never spawn a real wizard server
  if (opts.authed) {
    fs.writeFileSync(env.TRAFFIC_ONE_AUTH_STATE_PATH, JSON.stringify({
      version: 1, endpoint: 'http://127.0.0.1:8787/mcp', sessionToken: 'tok_x.sig',
      expiresAt: '2099-01-01T00:00:00Z', lastRemoteCheckedAt: '2099-01-01T00:00:00Z',
    }), 'utf8');
  }
  try {
    await fn(dir);
  } finally {
    for (const [k, v] of Object.entries({
      TRAFFIC_ONE_MCP_KEY_ENDPOINT: saved.ep, TRAFFIC_ONE_AUTH_STATE_PATH: saved.auth,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs, TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH: saved.choice,
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
    const stdin = JSON.stringify({ cwd, command: 'npm run build' });
    const r = await runCursorHook('before-shell-execution', stdin);
    const out = JSON.parse(r.stdout);
    assert.equal(out.permission, 'deny');
    assert.ok(out.user_message.includes('http://127.0.0.1'), 'deny carries the wizard URL');
    assert.ok(/setup/i.test(out.user_message));
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
