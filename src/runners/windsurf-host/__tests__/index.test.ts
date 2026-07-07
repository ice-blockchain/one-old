import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  doctorWrapper,
  installWrapper,
  uninstallWrapper,
  windsurfGlobalRulesPath,
  windsurfHooksPath,
  windsurfMcpPath,
} from '../index';
import { DEFAULT_ENDPOINT } from '../../../config/auth';
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

test('install requires consent and writes owned hooks, MCP, and global rule block', () => {
  withHome((env) => {
    assert.equal(installWrapper(env, ['install']).code, 2);
    const installed = installWrapper(env, ['install', '--yes']);
    assert.equal(installed.code, 0);

    const hooks = JSON.parse(fs.readFileSync(windsurfHooksPath(env), 'utf8')) as { hooks: Record<string, Array<{ command: string }>> };
    for (const event of WINDSURF_HOOK_EVENTS) {
      assert.ok(hooks.hooks[event]?.some((entry) => entry.command.includes('windsurf-hook-runtime.cjs')), event);
    }

    const mcp = JSON.parse(fs.readFileSync(windsurfMcpPath(env), 'utf8')) as { mcpServers: Record<string, { serverUrl?: string }> };
    assert.equal(mcp.mcpServers['mcp-auth']?.serverUrl, DEFAULT_ENDPOINT);
    assert.match(fs.readFileSync(windsurfGlobalRulesPath(env), 'utf8'), /traffic-one:windsurf:start/);
    assert.equal(doctorWrapper(env).code, 0);
  });
});

test('install preserves existing hook entries and is idempotent', () => {
  withHome((env) => {
    const hooksFile = windsurfHooksPath(env);
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { pre_run_command: [{ command: 'python3 custom.py' }] } }, null, 2), 'utf8');
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
    const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as { hooks: Record<string, Array<{ command: string }>> };
    hooks.hooks.pre_run_command = hooks.hooks.pre_run_command ?? [];
    hooks.hooks.pre_run_command.unshift({ command: 'python3 custom.py' });
    fs.writeFileSync(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`, 'utf8');

    assert.equal(uninstallWrapper(env, ['uninstall']).code, 2);
    assert.equal(uninstallWrapper(env, ['uninstall', '--yes']).code, 0);
    const after = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as { hooks: Record<string, Array<{ command: string }>> };
    assert.deepEqual(after.hooks.pre_run_command ?? [], [{ command: 'python3 custom.py' }]);
    assert.equal(doctorWrapper(env).code, 1);
  });
});
