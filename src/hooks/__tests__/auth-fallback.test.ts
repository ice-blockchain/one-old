import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { authFallbackMessage, fallbackCwd, hookFallbackStandsDown, safeHookFallbackStandsDown } from '../auth-fallback';
import { recordPluginUseChoice } from '../../shared/state/plugin-use';

test('fallbackCwd understands host cwd and Cursor workspace roots', () => {
  assert.equal(fallbackCwd(JSON.stringify({ cwd: '/repo/direct' })), '/repo/direct');
  assert.equal(fallbackCwd(JSON.stringify({ workspace_roots: ['/repo/cursor'] })), '/repo/cursor');
  assert.equal(
    fallbackCwd(JSON.stringify({ cwd: '/repo/cursor/packages/app', workspace_roots: ['/repo/cursor'] })),
    '/repo/cursor',
  );
  assert.equal(
    fallbackCwd(JSON.stringify({ workspace_roots: [{ uri: 'file:///repo/from-uri' }] })),
    '/repo/from-uri',
  );
});

test('auth crash fallback stays silent for pluginUse decline before reading auth', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-auth-fallback-'));
  const cwd = path.join(dir, 'project');
  const nested = path.join(cwd, 'packages', 'app');
  const env = {
    HOME: path.join(dir, 'home'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    TRAFFIC_ONE_STATE_PATH: path.join(dir, 'one.json'),
    TRAFFIC_ONE_AUTH: '1',
  } as NodeJS.ProcessEnv;
  fs.mkdirSync(nested, { recursive: true });
  try {
    recordPluginUseChoice(cwd, false, 'test', env);
    assert.equal(hookFallbackStandsDown(JSON.stringify({ cwd }), env), true);
    assert.equal(authFallbackMessage(JSON.stringify({ cwd }), env), '');
    const nestedPayload = JSON.stringify({ cwd: nested, workspace_roots: [cwd] });
    assert.equal(fallbackCwd(nestedPayload), cwd);
    assert.equal(hookFallbackStandsDown(nestedPayload, env), true);
    assert.equal(authFallbackMessage(nestedPayload, env), '');

    recordPluginUseChoice(cwd, true, 'test', env);
    assert.equal(hookFallbackStandsDown(JSON.stringify({ cwd }), env), false);
    assert.match(authFallbackMessage(JSON.stringify({ cwd }), env), /authentication is required/i);
    assert.equal(hookFallbackStandsDown(nestedPayload, env), false);
    assert.match(authFallbackMessage(nestedPayload, env), /authentication is required/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safeHookFallbackStandsDown never throws on empty, garbage, or huge stdin', () => {
  const env = process.env;
  for (const stdin of ['', '{', '[]', 'null', 'not-json', 'x'.repeat(1_000_000)]) {
    assert.equal(typeof safeHookFallbackStandsDown(stdin, env), 'boolean', stdin.slice(0, 16) || '(empty)');
  }
});

test('safeHookFallbackStandsDown returns false when hookFallbackStandsDown throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-stand-down-throw-'));
  try {
    const stdin = JSON.stringify({ cwd: dir });
    const hostile = new Proxy({} as NodeJS.ProcessEnv, {
      get() { throw new Error('hostile env'); },
    });
    assert.throws(() => hookFallbackStandsDown(stdin, hostile));
    assert.equal(safeHookFallbackStandsDown(stdin, hostile), false);
    assert.equal(authFallbackMessage(stdin, hostile), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
