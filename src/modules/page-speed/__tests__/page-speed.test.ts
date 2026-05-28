import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { postBuildPageSpeed } from '../handler';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';

function withProject(stateObj: Record<string, unknown>, authed: boolean, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-pagespeed-'));
  const env = process.env;
  const saved = { auth: env.TRAFFIC_ONE_AUTH_STATE_PATH, endpoint: env.TRAFFIC_ONE_MCP_KEY_ENDPOINT, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH };
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json');
  if (authed) {
    fs.writeFileSync(env.TRAFFIC_ONE_AUTH_STATE_PATH, JSON.stringify({
      version: 1, endpoint: 'http://127.0.0.1:8787/mcp', sessionToken: 'tok_x.sig',
      expiresAt: '2099-01-01T00:00:00Z', lastRemoteCheckedAt: '2099-01-01T00:00:00Z',
    }), 'utf8');
  }
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(stateObj), 'utf8');
  try {
    fn(dir);
  } finally {
    if (saved.auth === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = saved.auth;
    if (saved.endpoint === undefined) delete env.TRAFFIC_ONE_MCP_KEY_ENDPOINT; else env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = saved.endpoint;
    if (saved.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved.prefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ctxFor(cwd: string, command: string): Ctx {
  const input: HookInput = { event: 'PostToolUse', host: 'claude', cwd, raw: {}, tool: { class: 'shell' as ToolClass, rawName: 'Bash', command } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

test('page-speed fires after a web production build (authed)', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const r = postBuildPageSpeed(ctxFor(cwd, 'pnpm build'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('Lighthouse'));
      assert.equal(r.systemMessage, 'traffic-one page-speed gate pending after build');
    }
  });
});

test('page-speed is silent for non-build commands', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'pnpm install build-tools')).kind, 'noop');
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'ls')).kind, 'noop');
  });
});

test('page-speed is silent for React Native-only stacks', () => {
  withProject({ stack: 'custom-frontend', frontend: 'none', mobile: { framework: 'react-native-expo' } }, true, (cwd) => {
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'pnpm build')).kind, 'noop');
  });
});

test('page-speed is silent when unauthenticated', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, false, (cwd) => {
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'pnpm build')).kind, 'noop');
  });
});
