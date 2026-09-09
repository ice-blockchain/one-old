import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { runCopilotHook } from '../copilot-entry';
import { writeOneSection } from '../../shared/one-settings';

async function withEnv(opts: { authed: boolean }, fn: (cwd: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-copilot-entry-'));
  const env = process.env;
  const saved = {
    state: env.TRAFFIC_ONE_STATE_PATH,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    noSpawn: env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN,
    authFlag: env.TRAFFIC_ONE_AUTH,
    wire: env.TRAFFIC_ONE_COPILOT_WIRE,
    term: env.TERM_PROGRAM,
    vscodePid: env.VSCODE_PID,
  };
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  env.TRAFFIC_ONE_AUTH = '1';
  delete env.TRAFFIC_ONE_COPILOT_WIRE;
  delete env.TERM_PROGRAM;
  delete env.VSCODE_PID;
  if (opts.authed) {
    writeOneSection('auth', {
      version: 1, authenticated: true, apiKey: 'sk-telemetry-123', updatedAt: '2099-01-01T00:00:00Z',
    }, env);
  }
  try {
    await fn(dir);
  } finally {
    for (const [key, value] of Object.entries({
      TRAFFIC_ONE_STATE_PATH: saved.state,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_ONBOARDING_NO_SPAWN: saved.noSpawn,
      TRAFFIC_ONE_AUTH: saved.authFlag,
      TRAFFIC_ONE_COPILOT_WIRE: saved.wire,
      TERM_PROGRAM: saved.term,
      VSCODE_PID: saved.vscodePid,
    })) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (!Object.prototype.hasOwnProperty.call(extra, 'TRAFFIC_ONE_COPILOT_WIRE')) delete env.TRAFFIC_ONE_COPILOT_WIRE;
  if (!Object.prototype.hasOwnProperty.call(extra, 'TERM_PROGRAM')) delete env.TERM_PROGRAM;
  if (!Object.prototype.hasOwnProperty.call(extra, 'VSCODE_PID')) delete env.VSCODE_PID;
  return env;
}

test('missing subcommand → cli noop unless payload names an event', async () => {
  assert.equal((await runCopilotHook(undefined, '{}', cleanEnv())).stdout, '');
  const named = JSON.parse(
    (await runCopilotHook(undefined, JSON.stringify({ hook_event_name: 'PreToolUse' }), cleanEnv())).stdout,
  );
  assert.equal(named.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(named.permissionDecision, undefined);
  assert.equal(
    (await runCopilotHook(undefined, '{}', cleanEnv({ TRAFFIC_ONE_COPILOT_WIRE: 'vscode' }))).stdout,
    '{}',
  );
});

test('argv-less hook_event_name PreToolUse denies in the VS Code nested shape', async () => {
  await withEnv({ authed: false }, async (cwd) => {
    const stdin = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'bash',
      tool_args: '{"command":"rm -rf /"}',
      cwd,
    });
    const result = await runCopilotHook(undefined, stdin);
    const out = JSON.parse(result.stdout);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(out.permissionDecision, undefined);
  });
});

test('TERM_PROGRAM=vscode + argv before-tool-use uses the CLI deny shape', async () => {
  const out = await runCopilotHook('before-tool-use', '{', cleanEnv({ TERM_PROGRAM: 'vscode' }));
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.permissionDecision, 'deny');
  assert.equal(parsed.hookSpecificOutput, undefined);
});

test('TRAFFIC_ONE_COPILOT_WIRE=vscode wins over argv before-tool-use', async () => {
  const out = await runCopilotHook('before-tool-use', '{', cleanEnv({ TRAFFIC_ONE_COPILOT_WIRE: 'vscode' }));
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(parsed.permissionDecision, undefined);
});

test('runCopilotHook batch [write, bash rm] denies in one CLI shape', async () => {
  await withEnv({ authed: false }, async (cwd) => {
    const stdin = JSON.stringify({
      cwd,
      workspace_roots: [cwd],
      tool_calls: [
        { name: 'write', args: { path: path.join(cwd, 'a.ts'), content: 'x' } },
        { name: 'bash', args: { command: 'rm -rf /tmp/x' } },
      ],
    });
    const result = await runCopilotHook('before-tool-use', stdin, {
      ...process.env, TRAFFIC_ONE_COPILOT_WIRE: 'cli',
    });
    const out = JSON.parse(result.stdout);
    assert.equal(out.permissionDecision, 'deny');
    assert.equal(out.hookSpecificOutput, undefined);
  });
});
