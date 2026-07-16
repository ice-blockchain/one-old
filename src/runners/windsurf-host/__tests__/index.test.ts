import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  doctorWrapper,
  devinConfigPath,
  installWrapper,
  uninstallWrapper,
  windsurfGlobalRulesPath,
  windsurfHooksPath,
} from '../index';
import { WINDSURF_HOOK_EVENTS } from '../../../config/windsurf-host';

function withHome(fn: (env: NodeJS.ProcessEnv) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-host-'));
  try {
    fn({
      HOME: path.join(dir, 'home'),
      TRAFFIC_ONE_PLUGIN_ROOT: path.join(dir, 'plugin'),
    } as NodeJS.ProcessEnv);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('install requires consent and writes Cascade + native hooks and global rule block', () => {
  withHome((env) => {
    assert.equal(installWrapper(env, ['install']).code, 2);
    const installed = installWrapper(env, ['install', '--yes']);
    assert.equal(installed.code, 0);

    const cascade = JSON.parse(fs.readFileSync(windsurfHooksPath(env), 'utf8')) as { hooks: Record<string, Array<{ command: string }>> };
    for (const event of WINDSURF_HOOK_EVENTS) {
      assert.ok(cascade.hooks[event]?.some((entry) => entry.command.includes('windsurf-hook-runtime.cjs')), event);
    }

    const stamp = fs.readFileSync(path.join(env.HOME!, '.traffic-one', 'windsurf-plugin-root'), 'utf8').trim();
    assert.equal(stamp, env.TRAFFIC_ONE_PLUGIN_ROOT);

    assert.match(fs.readFileSync(windsurfGlobalRulesPath(env), 'utf8'), /traffic-one:windsurf:start/);
    const devin = JSON.parse(fs.readFileSync(devinConfigPath(env), 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    assert.ok(devin.hooks.UserPromptSubmit?.some((group) => group.hooks.some((entry) => /devin-hook-runtime\.cjs.* user-prompt-submit /.test(entry.command))));
    assert.ok(devin.hooks.PreToolUse?.some((group) => group.hooks.some((entry) => /devin-hook-runtime\.cjs.* check-onboarding-gate /.test(entry.command))));
    assert.equal(doctorWrapper(env).code, 0);
  });
});

test('install preserves custom Cascade entries, refreshes owned entries, and is idempotent', () => {
  withHome((env) => {
    const hooksFile = windsurfHooksPath(env);
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { pre_run_command: [
      { command: 'python3 custom.py' },
      { command: 'node /plugin/scripts/windsurf-hook-runtime.cjs pre_run_command' },
    ] } }, null, 2), 'utf8');
    assert.equal(installWrapper(env, ['install', '--yes']).code, 0);
    assert.equal(installWrapper(env, ['install', '--yes']).code, 0);
    const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as { hooks: Record<string, Array<{ command: string }>> };
    const entries = hooks.hooks.pre_run_command ?? [];
    assert.equal(entries.filter((entry) => entry.command === 'python3 custom.py').length, 1);
    assert.equal(entries.filter((entry) => entry.command.includes('windsurf-hook-runtime.cjs')).length, 1);
  });
});

test('uninstall removes only owned entries', () => {
  withHome((env) => {
    const hooksFile = windsurfHooksPath(env);
    assert.equal(installWrapper(env, ['install', '--yes']).code, 0);
    const hooks = { hooks: { pre_run_command: [
      { command: 'python3 custom.py' },
      { command: 'node /plugin/scripts/windsurf-hook-runtime.cjs pre_run_command' },
    ] } };
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`, 'utf8');
    const devinFile = devinConfigPath(env);
    const devin = JSON.parse(fs.readFileSync(devinFile, 'utf8')) as { hooks: Record<string, unknown[]> };
    devin.hooks.UserPromptSubmit?.unshift({ matcher: '', hooks: [{ type: 'command', command: 'python3 custom.py' }] });
    fs.writeFileSync(devinFile, `${JSON.stringify(devin, null, 2)}\n`, 'utf8');

    assert.equal(uninstallWrapper(env, ['uninstall']).code, 2);
    assert.equal(uninstallWrapper(env, ['uninstall', '--yes']).code, 0);
    const after = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as { hooks: Record<string, Array<{ command: string }>> };
    assert.deepEqual(after.hooks.pre_run_command ?? [], [{ command: 'python3 custom.py' }]);
    const devinAfter = JSON.parse(fs.readFileSync(devinFile, 'utf8')) as { hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    assert.equal(devinAfter.hooks.UserPromptSubmit?.some((group) => group.hooks?.some((entry) => entry.command === 'python3 custom.py')), true);
    assert.equal(JSON.stringify(devinAfter).includes('devin-hook-runtime.cjs'), false);
    assert.equal(doctorWrapper(env).code, 1);
  });
});
