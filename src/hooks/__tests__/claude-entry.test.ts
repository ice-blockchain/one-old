import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { runClaudeHook } from '../claude-entry';
import { handlersForSubcommand } from '../../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../../core/registry';

const REAL_HANDLERS = collectHandlers(loadModules(defaultModulesDir()));
function idsFor(sub: string): string[] {
  return handlersForSubcommand(REAL_HANDLERS, sub).map((h) => h.id).sort();
}

// ── Routing: each subcommand → exactly its legacy-equivalent handler set ──────
test('subcommand routing maps each hook entry point to the right handlers', () => {
  assert.deepEqual(idsFor('session-start'), ['session.session-start']);
  assert.deepEqual(idsFor('user-prompt-submit'), ['session.prompt-submit']);
  // The four PreToolUse gate subcommands each include the priority-0 auth gate
  // (so the pipeline checks auth first, matching the legacy per-gate auth check).
  assert.deepEqual(idsFor('check-onboarding-gate'), ['onboarding-gate', 'session.auth']);
  assert.deepEqual(idsFor('check-agent-model'), ['agent-model.spawn', 'session.auth']);
  assert.deepEqual(idsFor('check-architecture-write'), ['architecture-guard.write', 'session.auth']);
  assert.deepEqual(idsFor('check-library-allowlist'), ['architecture-guard.library', 'session.auth']);
  // Hints + post-build handlers route to exactly one handler (no cross-fire —
  // critical so the two PostToolUse entries don't double-emit context).
  assert.deepEqual(idsFor('pre-graphify-hint'), ['graphify.hint']);
  assert.deepEqual(idsFor('post-build-page-speed'), ['page-speed.build']);
  assert.deepEqual(idsFor('post-build-graphify'), ['graphify.post-build']);
  assert.deepEqual(idsFor('post-stack-setup'), ['materialize.post-stack-setup']);
});

test('an unknown subcommand routes to no handlers', () => {
  assert.deepEqual(idsFor('not-a-real-subcommand'), []);
});

// ── Integration: runClaudeHook end-to-end through the real pipeline ───────────
async function withEnv(opts: { authed: boolean }, fn: (cwd: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-claude-entry-'));
  const env = process.env;
  const saved = { ep: env.TRAFFIC_ONE_MCP_KEY_ENDPOINT, auth: env.TRAFFIC_ONE_AUTH_STATE_PATH, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH, choice: env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH };
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = path.join(dir, 'auth-choice.json');
  if (opts.authed) {
    fs.writeFileSync(env.TRAFFIC_ONE_AUTH_STATE_PATH, JSON.stringify({
      version: 1, endpoint: 'http://127.0.0.1:8787/mcp', sessionToken: 'tok_x.sig',
      expiresAt: '2099-01-01T00:00:00Z', lastRemoteCheckedAt: '2099-01-01T00:00:00Z',
    }), 'utf8');
  }
  try {
    await fn(dir);
  } finally {
    for (const [k, v] of Object.entries({
      TRAFFIC_ONE_MCP_KEY_ENDPOINT: saved.ep, TRAFFIC_ONE_AUTH_STATE_PATH: saved.auth,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs, TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH: saved.choice,
    })) { if (v === undefined) delete env[k]; else env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('unknown subcommand → empty stdout, exit 0', async () => {
  const r = await runClaudeHook('definitely-unknown', '{}');
  assert.equal(r.stdout, '');
  assert.equal(r.exitCode, 0);
});

test('check-architecture-write UNAUTHED denies via the priority-0 auth gate', async () => {
  await withEnv({ authed: false }, async (cwd) => {
    const stdin = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'x.ts'), content: 'export const x = 1;' }, cwd });
    const r = await runClaudeHook('check-architecture-write', stdin);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.length > 0, 'expected a deny payload');
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  });
});

test('pre-graphify-hint AUTHED with no graph artefact → silent (empty stdout)', async () => {
  await withEnv({ authed: true }, async (cwd) => {
    const stdin = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, cwd });
    const r = await runClaudeHook('pre-graphify-hint', stdin);
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '');
  });
});
