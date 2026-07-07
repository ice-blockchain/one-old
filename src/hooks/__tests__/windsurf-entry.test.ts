import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runWindsurfHook } from '../windsurf-entry';
import { writeServerRecord } from '../../shared/onboarding-server/registry';

async function withEnv(fn: (cwd: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-entry-'));
  const saved = {
    auth: process.env.TRAFFIC_ONE_AUTH_STATE_PATH,
    prefs: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    choice: process.env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH,
    noSpawn: process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN,
    authEnabled: process.env.TRAFFIC_ONE_AUTH,
  };
  process.env.TRAFFIC_ONE_AUTH = 'on';
  process.env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json');
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = path.join(dir, 'choice.json');
  process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  try {
    await fn(dir);
  } finally {
    for (const [key, value] of Object.entries({
      TRAFFIC_ONE_AUTH_STATE_PATH: saved.auth,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH: saved.choice,
      TRAFFIC_ONE_ONBOARDING_NO_SPAWN: saved.noSpawn,
      TRAFFIC_ONE_AUTH: saved.authEnabled,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('windsurf entry: unauthenticated pre_run_command blocks with exit 2 stderr', async () => {
  await withEnv(async (cwd) => {
    const stdin = JSON.stringify({ agent_action_name: 'pre_run_command', tool_info: { command_line: 'npm test', cwd } });
    const out = await runWindsurfHook('pre_run_command', stdin);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /Traffic One/i);
    assert.equal(out.stdout, '');
  });
});

test('windsurf entry: setup-required pre_user_prompt stays non-blocking so Cascade can respond', async () => {
  await withEnv(async (cwd) => {
    process.env.TRAFFIC_ONE_AUTH = 'off';
    writeServerRecord(cwd, { pid: process.pid, port: 56858, token: 't', url: 'http://127.0.0.1:56858/?t=t', startedAt: 'x' });
    const stdin = JSON.stringify({
      agent_action_name: 'pre_user_prompt',
      cwd,
      user_prompt: 'create a modern learning platform with courses for web development',
    });
    const out = await runWindsurfHook('pre_user_prompt', stdin);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stderr, '');
    assert.match(out.stdout, /setup required/i);
    assert.match(out.stdout, /127\.0\.0\.1:56858/i);
  });
});

test('windsurf entry: post hooks never block', async () => {
  await withEnv(async (cwd) => {
    const stdin = JSON.stringify({ agent_action_name: 'post_run_command', tool_info: { command_line: 'npm test', cwd } });
    const out = await runWindsurfHook('post_run_command', stdin);
    assert.equal(out.exitCode, 0);
  });
});
