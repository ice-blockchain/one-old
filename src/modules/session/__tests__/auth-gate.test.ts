import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import type { Ctx, HookInput } from '../../../core/types';
import { writeSimpleAuth } from '../../../shared/auth';
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';
import { authPreToolGate } from '../auth-gate';

function ctx(cwd: string): Ctx {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'claude',
    cwd,
    raw: { tool_name: 'Write', tool_input: { file_path: 'src/app.ts' } },
    tool: { class: 'file-write', rawName: 'Write', filePath: 'src/app.ts' },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function withEnv(fn: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-auth-gate-'));
  const env = process.env;
  const saved = {
    auth: env.TRAFFIC_ONE_AUTH,
    state: env.TRAFFIC_ONE_STATE_PATH,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    askFirst: env.TRAFFIC_ONE_ASK_USE_PLUGIN,
    noSpawn: env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN,
  };
  env.TRAFFIC_ONE_AUTH = '1';
  env.TRAFFIC_ONE_STATE_PATH = path.join(cwd, 'one.json');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(cwd, 'preferences.json');
  env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
  env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  try {
    fn(cwd);
  } finally {
    for (const [key, value] of Object.entries({
      TRAFFIC_ONE_AUTH: saved.auth,
      TRAFFIC_ONE_STATE_PATH: saved.state,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_ASK_USE_PLUGIN: saved.askFirst,
      TRAFFIC_ONE_ONBOARDING_NO_SPAWN: saved.noSpawn,
    })) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('canonical one.json.auth clears the pre-tool auth gate', () => {
  withEnv((cwd) => {
    recordPluginUseChoice(cwd, true, 'test');
    writeSimpleAuth('sk-validated');
    assert.equal(authPreToolGate(ctx(cwd)).kind, 'noop');
  });
});

test('missing canonical auth stays gated after pluginUse opt-in', () => {
  withEnv((cwd) => {
    recordPluginUseChoice(cwd, true, 'test');
    assert.notEqual(authPreToolGate(ctx(cwd)).kind, 'noop');
  });
});

test('pluginUse decline stands down before auth or onboarding', () => {
  withEnv((cwd) => {
    recordPluginUseChoice(cwd, false, 'test');
    assert.equal(authPreToolGate(ctx(cwd)).kind, 'noop');
  });
});

test('TRAFFIC_ONE_AUTH=off explicitly disables enforcement', () => {
  withEnv((cwd) => {
    process.env.TRAFFIC_ONE_AUTH = 'off';
    assert.equal(authPreToolGate(ctx(cwd)).kind, 'noop');
  });
});
