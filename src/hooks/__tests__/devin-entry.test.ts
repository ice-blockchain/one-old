import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runDevinHook } from '../devin-entry';
import { writeServerRecord } from '../../shared/onboarding-server/registry';
import { onboardingWaitCommand } from '../../shared/onboarding-server/wait-command';

// These tests exercise the setup-wizard flow itself, which under the shipped
// ask-first default (ASK_USE_PLUGIN_FIRST) only starts after the user's
// recorded yes. Pin the runtime override off so the wizard paths stay directly
// testable; the ask-first question has dedicated tests that set the flag to '1'.
process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

async function withSetupProject(fn: (cwd: string) => Promise<void>): Promise<void> {
  // home ≠ project: a real Devin workspace is never $HOME, and cwd === $HOME is
  // machine-config space the gate now refuses outright (isNonProjectRoot).
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-devin-entry-')));
  const home = path.join(base, 'home');
  const dir = path.join(base, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const oldCwd = process.cwd();
  const saved = {
    auth: process.env.TRAFFIC_ONE_AUTH,
    noSpawn: process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN,
    home: process.env.HOME,
  };
  process.env.HOME = home;
  process.env.TRAFFIC_ONE_AUTH = 'off';
  process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  try {
    writeServerRecord(dir, { pid: process.pid, port: 56859, token: 'native', url: 'http://127.0.0.1:56859/?t=native', startedAt: 'x' }, process.env, 'windsurf');
    await fn(dir);
  } finally {
    process.chdir(oldCwd);
    if (saved.auth === undefined) delete process.env.TRAFFIC_ONE_AUTH;
    else process.env.TRAFFIC_ONE_AUTH = saved.auth;
    if (saved.noSpawn === undefined) delete process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
    else process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = saved.noSpawn;
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test('Devin UserPromptSubmit injects a visible setup URL before planning', async () => {
  await withSetupProject(async (cwd) => {
    const out = await runDevinHook('user-prompt-submit', JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      cwd,
      prompt: 'create a Next.js learning platform',
    }));
    assert.equal(out.exitCode, 0);
    const wire = JSON.parse(out.stdout) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
    assert.equal(wire.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
    assert.match(wire.hookSpecificOutput?.additionalContext ?? '', /https:\/\/traffic\.io\/onboarding\/agent#p=56859&t=native/);
    assert.match(wire.hookSpecificOutput?.additionalContext ?? '', /http:\/\/127\.0\.0\.1:56859\/local\?t=native/);
    assert.match(wire.hookSpecificOutput?.additionalContext ?? '', /\[Open Traffic One setup\]\(https:\/\/traffic\.io\/onboarding\/agent#p=56859&t=native\)/);
    assert.match(wire.hookSpecificOutput?.additionalContext ?? '', /onboarding-wait\.cjs/);
  });
});

test('Devin PreToolUse blocks scaffolding immediately and allows the ordinary wait command', async () => {
  await withSetupProject(async (cwd) => {
    const scaffold = await runDevinHook('check-onboarding-gate', JSON.stringify({
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'exec',
      tool_input: { command: 'npx create-next-app@latest learning-platform' },
    }));
    const blocked = JSON.parse(scaffold.stdout) as { decision?: string; reason?: string };
    assert.equal(blocked.decision, 'block');
    assert.match(blocked.reason ?? '', /https:\/\/traffic\.io\/onboarding\/agent#p=56859&t=native/);
    assert.match(blocked.reason ?? '', /http:\/\/127\.0\.0\.1:56859\/local\?t=native/);

    const wait = await runDevinHook('check-onboarding-gate', JSON.stringify({
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'exec',
      tool_input: { command: onboardingWaitCommand(cwd, 'windsurf') },
    }));
    assert.equal(wait.stdout, '');
    assert.equal(wait.exitCode, 0);
  });
});

test('Devin Stop gives an incomplete setup one wait-command retry without looping', async () => {
  await withSetupProject(async (cwd) => {
    const first = await runDevinHook('onboarding-stop', JSON.stringify({
      hook_event_name: 'Stop', cwd, stop_hook_active: false, session_id: 'devin:stop',
    }));
    const blocked = JSON.parse(first.stdout) as { decision?: string; reason?: string };
    assert.equal(blocked.decision, 'block');
    assert.match(blocked.reason ?? '', /onboarding-wait\.cjs/);
    assert.match(blocked.reason ?? '', /--sync-session=devin_stop/);
    assert.match(blocked.reason ?? '', /http:\/\/127\.0\.0\.1:56859\/local\?t=native/);

    const retry = await runDevinHook('onboarding-stop', JSON.stringify({
      hook_event_name: 'Stop', cwd, stop_hook_active: true,
    }));
    assert.equal(retry.stdout, '');
  });
});
