import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runWindsurfHook } from '../windsurf-entry';
import { writeServerRecord } from '../../shared/onboarding-server/registry';
import { recordPluginUseChoice } from '../../shared/state/plugin-use';

// Several cases below characterize the ask-first question itself (the pending
// pre_user_prompt, and the two pre_run_command denies it owns), so pin it on
// rather than inheriting it — the suite preload defaults it off so a bare
// mkdtemp fixture reads as a consented project.
process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';

async function withEnv(fn: (cwd: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-entry-'));
  const saved = {
    state: process.env.TRAFFIC_ONE_STATE_PATH,
    prefs: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    noSpawn: process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN,
    authEnabled: process.env.TRAFFIC_ONE_AUTH,
  };
  process.env.TRAFFIC_ONE_AUTH = 'on';
  process.env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  try {
    await fn(dir);
  } finally {
    for (const [key, value] of Object.entries({
      TRAFFIC_ONE_STATE_PATH: saved.state,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
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

test('windsurf entry: setup-required pre_user_prompt does not block native Devin prompt admission', async () => {
  await withEnv(async (cwd) => {
    process.env.TRAFFIC_ONE_AUTH = 'off';
    // The wizard URL is only surfaced AFTER the user's recorded yes (ask-first);
    // the live-server flow below is the post-consent state.
    recordPluginUseChoice(cwd, true, 'command');
    writeServerRecord(cwd, { pid: process.pid, port: 56858, token: 't', url: 'http://127.0.0.1:56858/?t=t', startedAt: 'x' }, process.env, 'windsurf');
    const stdin = JSON.stringify({
      agent_action_name: 'pre_user_prompt',
      tool_info: {
        user_prompt: 'create a modern learning platform with courses for web development',
        cwd,
      },
    });
    const out = await runWindsurfHook('pre_user_prompt', stdin);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /setup required/i);
    assert.match(out.stdout, /onboarding\/agent#p=56858&t=t/i);
    assert.match(out.stdout, /127\.0\.0\.1:56858\/local\?t=t/i);
    assert.equal(out.stderr, '');
  });
});

test('windsurf entry: ask-first pending pre_user_prompt asks the question and never leaks a wizard URL', async () => {
  await withEnv(async (cwd) => {
    process.env.TRAFFIC_ONE_AUTH = 'off';
    // Even a stray live server record must not resurface its URL pre-decision.
    writeServerRecord(cwd, { pid: process.pid, port: 56858, token: 't', url: 'http://127.0.0.1:56858/?t=t', startedAt: 'x' }, process.env, 'windsurf');
    const stdin = JSON.stringify({
      agent_action_name: 'pre_user_prompt',
      tool_info: {
        user_prompt: 'create a modern learning platform with courses for web development',
        cwd,
      },
    });
    const out = await runWindsurfHook('pre_user_prompt', stdin);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /Do you want to use the Traffic One plugin/);
    assert.doesNotMatch(out.stdout, /127\.0\.0\.1:56858/i);
    assert.doesNotMatch(out.stdout, /onboarding\/agent#p=56858&t=t/i);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'nothing written before the answer');
  });
});

test('windsurf entry: post hooks never block', async () => {
  await withEnv(async (cwd) => {
    const stdin = JSON.stringify({ agent_action_name: 'post_run_command', tool_info: { command_line: 'npm test', cwd } });
    const out = await runWindsurfHook('post_run_command', stdin);
    assert.equal(out.exitCode, 0);
  });
});

test('windsurf entry: synthetic empty-trajectory Devin bridge payload is ignored', async () => {
  await withEnv(async (cwd) => {
    const stdin = JSON.stringify({
      agent_action_name: 'pre_run_command',
      trajectory_id: '',
      timestamp: '2026-07-12T09:00:00Z',
      tool_info: { command_line: 'npm test', cwd },
    });
    const out = await runWindsurfHook('pre_run_command', stdin);
    assert.deepEqual(out, { stdout: '', stderr: '', exitCode: 0 });
  });
});

test('windsurf entry: genuine Cascade trajectory still runs Traffic One', async () => {
  await withEnv(async (cwd) => {
    const stdin = JSON.stringify({
      agent_action_name: 'pre_run_command',
      trajectory_id: 'cascade-trajectory-1',
      tool_info: { command_line: 'npm test', cwd },
    });
    const out = await runWindsurfHook('pre_run_command', stdin);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /Traffic One/i);
  });
});

test('windsurf entry: the wait command itself surfaces the setup banner on stdout (show_output)', async () => {
  await withEnv(async (cwd) => {
    process.env.TRAFFIC_ONE_AUTH = 'off';
    recordPluginUseChoice(cwd, true, 'command');
    writeServerRecord(cwd, { pid: process.pid, port: 56859, token: 't', url: 'http://127.0.0.1:56859/?t=t', startedAt: 'x' }, process.env, 'windsurf');
    const { onboardingWaitCommand } = await import('../../shared/onboarding-server/wait-command');
    const stdin = JSON.stringify({
      agent_action_name: 'pre_run_command',
      tool_info: { command_line: onboardingWaitCommand(cwd, 'windsurf'), cwd },
    });
    const out = await runWindsurfHook('pre_run_command', stdin);
    assert.equal(out.exitCode, 0, 'the waiter is never blocked');
    assert.match(out.stdout, /onboarding\/agent#p=56859&t=t/i,
      'Cascade renders hook stdout under show_output — the banner is the user-visible link surface');
  });
});
