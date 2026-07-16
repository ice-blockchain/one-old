import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { runKiloHook } from '../kilo-entry';

async function withEnv(opts: { authed: boolean }, fn: (cwd: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-entry-'));
  const env = process.env;
  const saved = {
    ep: env.TRAFFIC_ONE_MCP_KEY_ENDPOINT,
    state: env.TRAFFIC_ONE_STATE_PATH,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    noSpawn: env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN,
    authFlag: env.TRAFFIC_ONE_AUTH,
  };
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  env.TRAFFIC_ONE_AUTH = '1';
  if (opts.authed) {
    fs.writeFileSync(env.TRAFFIC_ONE_STATE_PATH, JSON.stringify({
      schemaVersion: 3,
      auth: { version: 1, authenticated: true, apiKey: 'sk-telemetry-123', updatedAt: '2099-01-01T00:00:00Z' },
      hosts: {},
    }), 'utf8');
  }
  try {
    await fn(dir);
  } finally {
    for (const [key, value] of Object.entries({
      TRAFFIC_ONE_MCP_KEY_ENDPOINT: saved.ep,
      TRAFFIC_ONE_STATE_PATH: saved.state,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_ONBOARDING_NO_SPAWN: saved.noSpawn,
      TRAFFIC_ONE_AUTH: saved.authFlag,
    })) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('unknown / missing subcommand -> kilo noop protocol', async () => {
  assert.equal((await runKiloHook(undefined, '{}')).stdout, '{"kind":"noop"}');
});

test('before-tool-use authed fresh project denies in Kilo wrapper protocol', async () => {
  await withEnv({ authed: true }, async (cwd) => {
    const stdin = JSON.stringify({
      event: 'tool.execute.before',
      cwd,
      workspaceRoot: cwd,
      tool_name: 'bash',
      tool_input: { command: 'npx create-next-app@latest .' },
      session_id: 'probe',
      call_id: 'call',
    });
    const result = await runKiloHook('before-tool-use', stdin);
    assert.equal(result.exitCode, 0);
    const out = JSON.parse(result.stdout) as { kind?: string; reason?: string };
    assert.equal(out.kind, 'deny');
    assert.match(out.reason || '', /setup wizard|Traffic One/i);
  });
});
