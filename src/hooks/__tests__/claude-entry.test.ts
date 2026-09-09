import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { runClaudeHook } from '../claude-entry';
import { guardedMain } from '../entry-guard';
import { nestedPreToolDeny, wrapperPreToolDeny } from '../fail-closed';
import { handlersForSubcommand } from '../../core/dispatch';
import { collectHandlers, defaultModulesDir, loadModules } from '../../core/registry';
import { doctorScriptPath } from '../../shared/doctor-command';
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
  // cursor-stop routes BOTH the onboarding backstop (priority 10, first followup
  // wins) and the agent-model failure reconcile (40).
  assert.deepEqual(idsFor('cursor-stop'), ['agent-model.cursor-stop', 'onboarding-gate.stop']);
  // The Claude/Codex turn-end backstop: re-delivers the setup link when a turn
  // would end with onboarding pending and a live wizard engaged.
  assert.deepEqual(idsFor('onboarding-stop'), ['onboarding-gate.stop']);
});

test('an unknown subcommand routes to no handlers', () => {
  assert.deepEqual(idsFor('not-a-real-subcommand'), []);
});

// ── Integration: runClaudeHook end-to-end through the real pipeline ───────────
async function withEnv(opts: { authed: boolean }, fn: (cwd: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-claude-entry-'));
  const env = process.env;
  const saved = { state: env.TRAFFIC_ONE_STATE_PATH, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH, noSpawn: env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN, authFlag: env.TRAFFIC_ONE_AUTH };
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
      TRAFFIC_ONE_STATE_PATH: saved.state,
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

test('new-project MCP write shape is denied; shapeless MCP stays other and does not invent a deny', async () => {
  await withEnv({ authed: true }, async (cwd) => {
    const write = await runClaudeHook('check-onboarding-gate', JSON.stringify({
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'mcp__filesystem__write_file',
      tool_input: { path: path.join(cwd, 'src', 'app.ts'), content: 'export const x = 1;' },
    }));
    assert.equal(write.exitCode, 0);
    assert.ok(write.stdout.length > 0, 'write-shaped MCP must hit a write gate');
    const denied = JSON.parse(write.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');

    const other = await runClaudeHook('check-onboarding-gate', JSON.stringify({
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'mcp__search__query',
      tool_input: { query: 'todos' },
    }));
    assert.equal(other.exitCode, 0);
    if (other.stdout) {
      const parsed = JSON.parse(other.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string };
      };
      assert.notEqual(parsed.hookSpecificOutput?.permissionDecision, 'deny');
    }
  });
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

test('runClaudeHook still denies when hookFallbackStandsDown would throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-claude-stand-down-'));
  try {
    const stdin = JSON.stringify({
      hook_event_name: 'PreToolUse',
      cwd: dir,
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'x.ts'), content: 'x' },
    });
    const hostile = new Proxy({} as NodeJS.ProcessEnv, {
      get() { throw new Error('hostile env'); },
      set() { throw new Error('hostile env'); },
    });
    const result = await runClaudeHook('check-plan-write', stdin, hostile);
    assert.equal(result.exitCode, 0);
    const out = JSON.parse(result.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// ── main() guard: anything that still escapes a runner becomes deny / noop ────
const boom = async (): Promise<{ stdout: string; exitCode: number }> => {
  throw new Error('unguarded runner rejection');
};

test('guardedMain emits the nested pre-tool deny when the runner rejects a gate subcommand', async () => {
  const out = await guardedMain({
    subcommand: 'check-plan-write',
    stdin: '{}',
    isPreTool: true,
    surface: 'nested',
    deny: { stdout: nestedPreToolDeny('Claude'), exitCode: 0 },
    noop: { stdout: '', exitCode: 0 },
    run: boom,
  });
  assert.equal(out.exitCode, 0);
  const parsed = JSON.parse(out.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(parsed.hookSpecificOutput?.permissionDecision, 'deny');
});

test('guardedMain noops (exit 0) when the runner rejects a non-gate subcommand', async () => {
  const out = await guardedMain({
    subcommand: 'session-start',
    stdin: '{}',
    isPreTool: false,
    surface: 'nested',
    deny: { stdout: nestedPreToolDeny('Claude'), exitCode: 0 },
    noop: { stdout: '', exitCode: 0 },
    run: boom,
  });
  assert.equal(out.stdout, '');
  assert.equal(out.exitCode, 0);
});

test('guardedMain honors a recognized recovery command instead of denying', async () => {
  const script = doctorScriptPath();
  const stdin = JSON.stringify({
    cwd: '/tmp',
    tool_name: 'Bash',
    tool_input: { command: `node ${script} --bundle` },
  });
  const out = await guardedMain({
    subcommand: 'check-plan-write',
    stdin,
    isPreTool: true,
    surface: 'nested',
    deny: { stdout: nestedPreToolDeny('Claude'), exitCode: 0 },
    noop: { stdout: '', exitCode: 0 },
    run: boom,
  });
  assert.equal(out.stdout, '');
  assert.equal(out.exitCode, 0);
});

test('guardedMain uses Windsurf deny channel (stderr + exit 2) for a pre-tool escape', async () => {
  const out = await guardedMain({
    subcommand: 'pre_run_command',
    stdin: '{}',
    isPreTool: true,
    surface: 'windsurf',
    deny: { stdout: '', stderr: 'windsurf-deny', exitCode: 2 },
    noop: { stdout: '', stderr: '', exitCode: 0 },
    run: async () => {
      throw new Error('windsurf runner rejection');
    },
  });
  assert.equal(out.stdout, '');
  assert.equal(out.stderr, 'windsurf-deny');
  assert.equal(out.exitCode, 2);
});

test('guardedMain uses the wrapper deny shape for an OpenCode/Kilo pre-tool escape', async () => {
  const out = await guardedMain({
    subcommand: 'before-tool-use',
    stdin: '{}',
    isPreTool: true,
    surface: 'wrapper',
    deny: { stdout: wrapperPreToolDeny('OpenCode'), exitCode: 0 },
    noop: { stdout: JSON.stringify({ kind: 'noop' }), exitCode: 0 },
    run: boom,
  });
  assert.equal(out.exitCode, 0);
  assert.equal(JSON.parse(out.stdout).kind, 'deny');
});

test('guardedMain returns the runner result unchanged on success', async () => {
  const out = await guardedMain({
    subcommand: 'check-plan-write',
    stdin: '{}',
    isPreTool: true,
    surface: 'nested',
    deny: { stdout: nestedPreToolDeny('Claude'), exitCode: 0 },
    noop: { stdout: '', exitCode: 0 },
    run: async () => ({ stdout: 'ok', exitCode: 0 }),
  });
  assert.equal(out.stdout, 'ok');
  assert.equal(out.exitCode, 0);
});
