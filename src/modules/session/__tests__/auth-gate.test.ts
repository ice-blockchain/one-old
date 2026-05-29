import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  authChoiceRequiredDenyReason,
  authGateForHook,
  authPreToolGate,
  parseTrafficOneApiKey,
  parseUnauthenticatedAuthChoice,
} from '../auth-gate';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';

// A fresh local auth state → isAuthenticatedLocal true → authGateForHook returns
// authenticated WITHOUT spawning the CLI (remote not due). Mutates process.env
// because authGateForHook reads it directly; restored after.
function withFreshAuth<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-authgate-'));
  const env = process.env;
  const prevState = env.TRAFFIC_ONE_AUTH_STATE_PATH;
  const prevEndpoint = env.TRAFFIC_ONE_MCP_KEY_ENDPOINT;
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json');
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
  fs.writeFileSync(env.TRAFFIC_ONE_AUTH_STATE_PATH, JSON.stringify({
    version: 1, endpoint: 'http://127.0.0.1:8787/mcp', sessionToken: 'tok_x.sig',
    expiresAt: '2099-01-01T00:00:00Z', lastRemoteCheckedAt: new Date().toISOString(),
  }), 'utf8');
  try {
    return fn(dir);
  } finally {
    if (prevState === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = prevState;
    if (prevEndpoint === undefined) delete env.TRAFFIC_ONE_MCP_KEY_ENDPOINT; else env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = prevEndpoint;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ctxFor(cwd: string, command: string): Ctx {
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd, raw: {}, tool: { class: 'shell' as ToolClass, rawName: 'Bash', command } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

test('authGateForHook returns authenticated without spawning when state is fresh + remote not due', () => {
  withFreshAuth(() => {
    const gate = authGateForHook();
    assert.equal(gate.authenticated, true);
    assert.equal(gate.checkedRemote, false);
  });
});

test('authPreToolGate allows (noop) when authenticated', () => {
  withFreshAuth((dir) => {
    assert.equal(authPreToolGate(ctxFor(dir, 'ls')).kind, 'noop');
  });
});

test('authPreToolGate allows (noop) inside the plugin authoring root', () => {
  assert.equal(authPreToolGate(ctxFor(process.cwd(), 'ls')).kind, 'noop');
});

test('parse helpers + deny reason', () => {
  assert.equal(parseUnauthenticatedAuthChoice('1', { allowNumeric: true }), 'authenticate');
  assert.equal(parseUnauthenticatedAuthChoice('continue without traffic one'), 'continue-without-traffic-one');
  assert.equal(parseUnauthenticatedAuthChoice('build me an app'), null);
  assert.equal(parseTrafficOneApiKey('my key is abc12345'), 'abc12345');
  assert.equal(parseTrafficOneApiKey('hello world here'), null);
  assert.ok(authChoiceRequiredDenyReason().includes('Traffic One authentication choice required'));
});
