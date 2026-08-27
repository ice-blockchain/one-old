import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { applyUseChoice, declineOutput } from '../wizard-output';
import { onboardingDeclineCommand } from '../../../shared/onboarding-server/wait-command';
import { defaultProjectPrefsPath } from '../../../shared/state/local-prefs';
import {
  readPluginUseChoice,
  recordPluginUseChoice,
  resetPluginUseCache,
} from '../../../shared/state/plugin-use';

test('child decline still vetoes and embeds the exact parent --decline command', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-layer-c-decline-')));
  const parent = path.join(root, 'mercury');
  const child = path.join(parent, 'strategies');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(parent, '.git'), { recursive: true });

  const saved = {
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    TRAFFIC_ONE_PROJECT_PREFS_PATH: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    TRAFFIC_ONE_ASK_USE_PLUGIN: process.env.TRAFFIC_ONE_ASK_USE_PLUGIN,
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, 'home'),
    XDG_STATE_HOME: path.join(root, 'xdg'),
    TRAFFIC_ONE_ASK_USE_PLUGIN: '1',
  };
  delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.HOME = env.HOME;
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
  resetPluginUseCache();

  const originalStderr = process.stderr.write;
  process.stderr.write = ((() => true) as unknown) as typeof process.stderr.write;
  try {
    assert.equal(recordPluginUseChoice(parent, true, 'command', env), true);
    const parentPrefs = defaultProjectPrefsPath(parent, env);
    const childPrefs = defaultProjectPrefsPath(child, env);
    const parentBefore = fs.readFileSync(parentPrefs, 'utf8');
    assert.equal(fs.existsSync(childPrefs), false, 'fixture guard: no child bucket');

    const out = declineOutput(child, 'cursor');
    assert.match(out, /^TRAFFIC_ONE_DISABLED\n/);
    const parentDecline = onboardingDeclineCommand(parent, 'cursor', env);
    assert.ok(out.includes(parentDecline), 'unrecorded body embeds the exact parent --decline command');
    assert.equal(onboardingDeclineCommand(child, 'cursor', env), parentDecline);
    assert.equal(fs.existsSync(childPrefs), false, 'child bucket still absent');
    assert.equal(fs.readFileSync(parentPrefs, 'utf8'), parentBefore, 'parent bucket unchanged');
    assert.equal(readPluginUseChoice(parent, env)?.enabled, true, 'parent yes is unchanged');

    const used = applyUseChoice(child, ['--use', child], env);
    assert.equal(used, false);
    assert.equal(fs.existsSync(childPrefs), false, 'child --use still vetoes CREATE');
    assert.equal(fs.readFileSync(parentPrefs, 'utf8'), parentBefore, 'parent yes is not overwritten');
    assert.equal(readPluginUseChoice(parent, env)?.enabled, true);
  } finally {
    process.stderr.write = originalStderr;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetPluginUseCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
