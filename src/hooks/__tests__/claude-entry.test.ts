import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { runClaudeHook } from '../claude-entry';
import { handlersForSubcommand } from '../../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../../core/registry';
import { writeOneSection } from '../../shared/one-settings';

const REAL_HANDLERS = collectHandlers(loadModules(defaultModulesDir()));
function idsFor(sub: string): string[] {
  return handlersForSubcommand(REAL_HANDLERS, sub).map((h) => h.id).sort();
}

// ── Routing: each subcommand → exactly its handler set ────────────────────────
test('subcommand routing maps each hook entry point to the right handlers', () => {
  assert.deepEqual(idsFor('session-start'), ['agent-model.cursor-failure-session-reconcile', 'session.session-start']);
  // agent-model.opencode-subagent-bind rides user-prompt-submit to bind a spawned
  // OpenCode role subagent's claim from its first prompt's [t1-role:] marker
  // (OpenCode has no SubagentStart); inert on other hosts.
  // agent-model.model-choice-reply is the post-reconcile sweep: the reconcile
  // (priority 35) may arm the pending model choice on the same prompt AFTER
  // session.prompt-submit (priority 0) evaluated the reply, so the sweep
  // (priority 45) re-runs the recorder so the first reply is never dropped.
  assert.deepEqual(idsFor('user-prompt-submit'), [
    'agent-model.cursor-failure-prompt-reconcile',
    'agent-model.model-choice-reply',
    'agent-model.opencode-subagent-bind',
    'session.prompt-submit',
  ]);
  // The PreToolUse gate subcommands each include the priority-0 auth gate so the
  // pipeline checks auth first.
  // The authoring write-guard (priority 5) piggybacks the two write-gate
  // pipelines so model-steered .traffic-one writes into the plugin repo deny.
  assert.deepEqual(idsFor('check-onboarding-gate'), ['onboarding-gate', 'session.auth', 'session.authoring-guard', 'session.workspace-boundary']);
  assert.deepEqual(idsFor('check-agent-model'), ['agent-model.spawn', 'session.auth', 'session.workspace-boundary']);
  assert.deepEqual(idsFor('check-plan-write'), ['plan-guard.write', 'session.auth', 'session.authoring-guard', 'session.workspace-boundary']);
  // check-library-allowlist runs the scaffold gate (22, windsurf-only) + supabase
  // local-stack gate (24, all hosts) + deploy gate (25) + install allowlist (30)
  // after auth (0) — the scaffold/supabase/deploy gates run before the install
  // allowlist, matching the legacy "deploy gate runs first" ordering.
  assert.deepEqual(idsFor('check-library-allowlist'), ['plan-guard.deploy', 'plan-guard.library', 'plan-guard.scaffold', 'plan-guard.supabase-local', 'session.auth', 'session.workspace-boundary']);
  assert.deepEqual(idsFor('check-one-mcp-tool'), ['one-mcp-tool-gate.agent-call']);
  assert.deepEqual(idsFor('check-codex-child-model'), ['agent-model.codex-child-observed-model']);
  // Hints + post-build handlers route to exactly one handler (no cross-fire —
  // critical so the two PostToolUse entries don't double-emit context).
  assert.deepEqual(idsFor('pre-graphify-hint'), ['graphify.hint']);
  assert.deepEqual(idsFor('post-build-page-speed'), ['page-speed.build']);
  assert.deepEqual(idsFor('post-build-graphify'), ['graphify.post-build']);
  assert.deepEqual(idsFor('post-stack-setup'), ['materialize.post-stack-setup']);
  // Codex SubagentStart binds the pending role claim to the new subagent thread id.
  assert.deepEqual(idsFor('subagent-start'), ['agent-model.subagent-start']);
  assert.deepEqual(idsFor('cursor-subagent-stop'), ['agent-model.cursor-subagent-stop']);
  assert.deepEqual(idsFor('cursor-stop'), ['agent-model.cursor-stop']);
});

test('an unknown subcommand routes to no handlers', () => {
  assert.deepEqual(idsFor('not-a-real-subcommand'), []);
});

// ── Integration: runClaudeHook end-to-end through the real pipeline ───────────
async function withEnv(opts: { authed: boolean }, fn: (cwd: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-claude-entry-'));
  const env = process.env;
  const saved = { ep: env.TRAFFIC_ONE_MCP_KEY_ENDPOINT, state: env.TRAFFIC_ONE_STATE_PATH, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH, noSpawn: env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN, authFlag: env.TRAFFIC_ONE_AUTH };
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1'; // unit tests must never spawn a real wizard server
  env.TRAFFIC_ONE_AUTH = '1'; // pin auth enforcement on regardless of the committed AUTH_ENABLED default
  if (opts.authed) {
    // The sole wizard-validated auth record lives under one.json.auth.
    writeOneSection('auth', {
      version: 1, authenticated: true, apiKey: 'sk-telemetry-123', updatedAt: '2099-01-01T00:00:00Z',
    }, env);
  }
  try {
    await fn(dir);
  } finally {
    for (const [k, v] of Object.entries({
      TRAFFIC_ONE_MCP_KEY_ENDPOINT: saved.ep, TRAFFIC_ONE_STATE_PATH: saved.state,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_ONBOARDING_NO_SPAWN: saved.noSpawn, TRAFFIC_ONE_AUTH: saved.authFlag,
    })) { if (v === undefined) delete env[k]; else env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('unknown subcommand → empty stdout, exit 0', async () => {
  const r = await runClaudeHook('definitely-unknown', '{}');
  assert.equal(r.stdout, '');
  assert.equal(r.exitCode, 0);
});

test('check-plan-write UNAUTHED denies via the priority-0 auth gate', async () => {
  await withEnv({ authed: false }, async (cwd) => {
    const stdin = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'x.ts'), content: 'export const x = 1;' }, cwd });
    const r = await runClaudeHook('check-plan-write', stdin);
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

test('session-start UNAUTHED points at the wizard (api-key page), no host prompt', async () => {
  await withEnv({ authed: false }, async (cwd) => {
    const r = await runClaudeHook('session-start', JSON.stringify({ hook_event_name: 'SessionStart', cwd }));
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout);
    // Missing canonical auth surfaces the wizard (which shows the api-key page because
    // computeOnboarding returns it while unauthenticated) — no host prompt request.
    assert.match(String(out.systemMessage), /authentication required/);
    assert.equal(out.promptRequest, undefined);
    assert.equal(out.hookSpecificOutput?.hookEventName, 'SessionStart');
  });
});

test('session-start AUTHED plumbs through to valid JSON, exit 0 (never throws to host)', async () => {
  // The entry routes session-start through the pipeline and always returns valid
  // output; canonical-auth gate behavior is covered by the session module tests.
  await withEnv({ authed: true }, async (cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');
    const r = await runClaudeHook('session-start', JSON.stringify({ hook_event_name: 'SessionStart', cwd }));
    assert.equal(r.exitCode, 0);
    if (r.stdout) assert.doesNotThrow(() => JSON.parse(r.stdout));
  });
});
