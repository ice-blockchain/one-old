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
import { DEVIN_NATIVE_HOOKS, WINDSURF_HOOK_EVENTS } from '../../../config/windsurf-host';
import { devinUserHookCommand, windsurfUserHookCommand } from '../../../shared/windsurf-hook-command';

function legacyShellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function withHome(fn: (env: NodeJS.ProcessEnv) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-host-'));
  try {
    fn({
      HOME: path.join(dir, 'home'),
      TRAFFIC_ONE_PLUGIN_ROOT: path.join(dir, 'plugin'),
      // Windsurf is an uncertified host (HOST_CAPABILITIES.windsurf.tier):
      // installWrapper() refuses by default. These tests exercise install
      // MECHANICS, so they opt in exactly like a maintainer testing the
      // wrapper would — the refusal itself is covered separately below.
      TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST: '1',
    } as NodeJS.ProcessEnv);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('install refuses by default for this uncertified host, and proceeds with the opt-out', () => {
  withHome((env) => {
    const { TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST, ...withoutOptOut } = env;
    const refused = installWrapper(withoutOptOut as NodeJS.ProcessEnv, ['install', '--yes']);
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /Windsurf is not a certified host/);
    assert.match(refused.stdout, /TRAFFIC_ONE_ALLOW_UNCERTIFIED_HOST=1/);
    assert.equal(fs.existsSync(windsurfHooksPath(env)), false);

    const installed = installWrapper(env, ['install', '--yes']);
    assert.equal(installed.code, 0);
  });
});

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
    const oldPluginRoot = path.join(path.dirname(env.TRAFFIC_ONE_PLUGIN_ROOT!), 'old-plugin');
    const stamp = path.join(env.HOME!, '.traffic-one', 'windsurf-plugin-root');
    const nearCollision = 'node "/other/plugin/scripts/windsurf-hook-runtime.cjs" pre_run_command --host=windsurf';
    const legacyOwned = `TRAFFIC_ONE_PLUGIN_ROOT=${legacyShellQuote(oldPluginRoot)} TRAFFIC_ONE_HOST=windsurf node ${legacyShellQuote(path.join(oldPluginRoot, 'scripts', 'windsurf-hook-runtime.cjs'))} pre_run_command --host=windsurf`;
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, `${oldPluginRoot}\n`, 'utf8');
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { pre_run_command: [
      { command: 'python3 custom.py' },
      { command: nearCollision },
      { command: legacyOwned },
    ] } }, null, 2), 'utf8');
    assert.equal(installWrapper(env, ['install', '--yes']).code, 0);
    assert.equal(installWrapper(env, ['install', '--yes']).code, 0);
    const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as { hooks: Record<string, Array<{ command: string }>> };
    const entries = hooks.hooks.pre_run_command ?? [];
    assert.equal(entries.filter((entry) => entry.command === 'python3 custom.py').length, 1);
    assert.equal(entries.filter((entry) => entry.command === nearCollision).length, 1);
    assert.equal(entries.filter((entry) => entry.command === legacyOwned).length, 0);
    assert.equal(entries.filter((entry) => entry.command === windsurfUserHookCommand(env.TRAFFIC_ONE_PLUGIN_ROOT!, 'pre_run_command')).length, 1);
  });
});

test('uninstall removes only owned entries', () => {
  withHome((env) => {
    const hooksFile = windsurfHooksPath(env);
    assert.equal(installWrapper(env, ['install', '--yes']).code, 0);
    const cascadeNearCollision = 'node "/other/plugin/scripts/windsurf-hook-runtime.cjs" pre_run_command --host=windsurf';
    const devinNearCollision = 'node "/other/plugin/scripts/devin-hook-runtime.cjs" user-prompt-submit --host=windsurf';
    const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as { hooks: Record<string, Array<{ command: string }>> };
    hooks.hooks.pre_run_command?.unshift(
      { command: 'python3 custom.py' },
      { command: cascadeNearCollision },
    );
    fs.writeFileSync(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`, 'utf8');
    const devinFile = devinConfigPath(env);
    const devin = JSON.parse(fs.readFileSync(devinFile, 'utf8')) as { hooks: Record<string, unknown[]> };
    devin.hooks.UserPromptSubmit?.unshift({
      matcher: '',
      hooks: [
        { type: 'command', command: 'python3 custom.py' },
        { type: 'command', command: devinNearCollision },
      ],
    });
    fs.writeFileSync(devinFile, `${JSON.stringify(devin, null, 2)}\n`, 'utf8');

    assert.equal(installWrapper(env, ['install', '--yes']).code, 0);
    const afterReinstall = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as { hooks: Record<string, Array<{ command: string }>> };
    assert.equal(afterReinstall.hooks.pre_run_command?.some((entry) => entry.command === cascadeNearCollision), true);
    const devinAfterReinstall = JSON.parse(fs.readFileSync(devinFile, 'utf8')) as { hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    assert.equal(devinAfterReinstall.hooks.UserPromptSubmit?.some((group) => group.hooks?.some((entry) => entry.command === devinNearCollision)), true);

    assert.equal(uninstallWrapper(env, ['uninstall']).code, 2);
    assert.equal(uninstallWrapper(env, ['uninstall', '--yes']).code, 0);
    const after = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as { hooks: Record<string, Array<{ command: string }>> };
    assert.deepEqual(after.hooks.pre_run_command ?? [], [
      { command: 'python3 custom.py' },
      { command: cascadeNearCollision },
    ]);
    const devinAfter = JSON.parse(fs.readFileSync(devinFile, 'utf8')) as { hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    assert.equal(devinAfter.hooks.UserPromptSubmit?.some((group) => group.hooks?.some((entry) => entry.command === 'python3 custom.py')), true);
    assert.equal(devinAfter.hooks.UserPromptSubmit?.some((group) => group.hooks?.some((entry) => entry.command === devinNearCollision)), true);
    const managedDevinCommands = new Set(
      DEVIN_NATIVE_HOOKS.map((spec) => devinUserHookCommand(env.TRAFFIC_ONE_PLUGIN_ROOT!, spec.subcommand)),
    );
    assert.equal(
      Object.values(devinAfter.hooks).some((groups) => (
        groups.some((group) => group.hooks?.some((entry) => (
          typeof entry.command === 'string' && managedDevinCommands.has(entry.command)
        )))
      )),
      false,
    );
    assert.equal(doctorWrapper(env).code, 1);
  });
});
