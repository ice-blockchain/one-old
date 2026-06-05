import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { runClaudeHook } from '../claude-entry';
import { runCursorHook } from '../cursor-entry';

// Golden parity: the SAME canonical scenario must yield the SAME canonical
// decision (deny / silent) across hosts, serialized into each host's wire shape
// — Claude/Codex nested hookSpecificOutput.permissionDecision vs Cursor flat
// permission. Claude routes the scenario through its specific gate subcommand;
// Cursor runs the coarse before-shell-execution pipeline; both must agree.

async function withScenario(
  opts: { authed: boolean; state?: Record<string, unknown> },
  fn: (cwd: string) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-parity-'));
  const env = process.env;
  const saved = { ep: env.TRAFFIC_ONE_MCP_KEY_ENDPOINT, auth: env.TRAFFIC_ONE_AUTH_STATE_PATH, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH, choice: env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH, noSpawn: env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN, authFlag: env.TRAFFIC_ONE_AUTH };
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = path.join(dir, 'auth-choice.json');
  env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1'; // parity test must never spawn a real wizard server
  env.TRAFFIC_ONE_AUTH = '1'; // pin auth enforcement on regardless of the committed AUTH_ENABLED default
  if (opts.authed) {
    fs.writeFileSync(env.TRAFFIC_ONE_AUTH_STATE_PATH, JSON.stringify({
      version: 1, endpoint: 'http://127.0.0.1:8787/mcp', sessionToken: 'tok_x.sig',
      expiresAt: '2099-01-01T00:00:00Z', lastRemoteCheckedAt: '2099-01-01T00:00:00Z',
    }), 'utf8');
  }
  if (opts.state) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(opts.state), 'utf8');
  }
  try {
    await fn(dir);
  } finally {
    for (const [k, v] of Object.entries({
      TRAFFIC_ONE_MCP_KEY_ENDPOINT: saved.ep, TRAFFIC_ONE_AUTH_STATE_PATH: saved.auth,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs, TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH: saved.choice,
      TRAFFIC_ONE_ONBOARDING_NO_SPAWN: saved.noSpawn, TRAFFIC_ONE_AUTH: saved.authFlag,
    })) { if (v === undefined) delete env[k]; else env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function claudeDecision(stdout: string): 'deny' | 'silent' | 'context' {
  if (!stdout) return 'silent';
  const out = JSON.parse(stdout);
  if (out.hookSpecificOutput?.permissionDecision === 'deny') return 'deny';
  return 'context';
}
function cursorDecision(stdout: string): 'deny' | 'silent' | 'context' {
  const out = JSON.parse(stdout || '{}');
  if (out.permission === 'deny') return 'deny';
  if (Object.keys(out).length === 0) return 'silent';
  return 'context';
}

test('parity: UNAUTHED shell → DENY on both Claude and Cursor', async () => {
  await withScenario({ authed: false }, async (cwd) => {
    const shellStdin = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm install left-pad' }, cwd });
    const claude = await runClaudeHook('check-library-allowlist', shellStdin);
    const cursor = await runCursorHook('before-shell-execution', JSON.stringify({ cwd, command: 'npm install left-pad' }));
    assert.equal(claudeDecision(claude.stdout), 'deny');
    assert.equal(cursorDecision(cursor.stdout), 'deny');
    // Same canonical decision, different wire shapes:
    assert.equal(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(JSON.parse(cursor.stdout).permission, 'deny');
  });
});

test('parity: AUTHED new-project + onboarding incomplete → DENY on both', async () => {
  await withScenario({ authed: true, state: { mode: 'new-project' } }, async (cwd) => {
    // Claude routes the onboarding gate via check-onboarding-gate; Cursor runs
    // the coarse before-shell-execution pipeline (which includes onboarding).
    const claude = await runClaudeHook('check-onboarding-gate', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'mkdir src' }, cwd }));
    const cursor = await runCursorHook('before-shell-execution', JSON.stringify({ cwd, command: 'mkdir src' }));
    assert.equal(claudeDecision(claude.stdout), 'deny');
    assert.equal(cursorDecision(cursor.stdout), 'deny');
  });
});

test('parity: AUTHED existing-codebase + benign shell → silent on both', async () => {
  await withScenario({ authed: true, state: { mode: 'existing-codebase' } }, async (cwd) => {
    const claude = await runClaudeHook('check-library-allowlist', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd }));
    const cursor = await runCursorHook('before-shell-execution', JSON.stringify({ cwd, command: 'ls -la' }));
    assert.equal(claudeDecision(claude.stdout), 'silent');
    assert.equal(cursorDecision(cursor.stdout), 'silent');
  });
});
