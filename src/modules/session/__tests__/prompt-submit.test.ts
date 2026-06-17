import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { makeClaudeAdapter } from '../../../adapters/claude';
import { dispatch } from '../../../core/dispatch';
import { agentModelGate } from '../../agent-model/handler';
import { runUserPromptSubmit } from '../prompt-submit';
import type { Ctx, Handler, HookInput, HookResult, ToolClass } from '../../../core/types';
import { markOpenCodeGateDenied, markOpenCodeRoleAttempted } from '../../../shared/opencode-roles';
import { initializeToolchainState } from '../../../shared/state/toolchain';
import { writeGlobalCodeGraphProvider } from '../../../shared/state';
import { writeServerRecord } from '../../../shared/onboarding-server/registry';

function ctx(cwd: string, prompt: string): Ctx {
  const input: HookInput = { event: 'UserPromptSubmit', host: 'claude', cwd, prompt, raw: { prompt } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function ctxHost(cwd: string, prompt: string, host: HookInput['host']): Ctx {
  const input: HookInput = { event: 'UserPromptSubmit', host, cwd, prompt, raw: { prompt } };
  return { input, host, cwd, now: () => 'x' } as unknown as Ctx;
}

// A subagent thread prompt: parent_session_id present → hookSessionIdentity flags it.
function ctxSub(cwd: string, prompt: string): Ctx {
  const input: HookInput = { event: 'UserPromptSubmit', host: 'claude', cwd, prompt, raw: { prompt, session_id: 'child-thread', parent_session_id: 'parent-session' } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function spawnCtx(cwd: string, toolInput: Record<string, unknown>): Ctx {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'claude',
    cwd,
    raw: { tool_name: 'Task', tool_input: toolInput },
    tool: { class: 'spawn-agent' as ToolClass, rawName: 'Task' },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

// The wizard URL is surfaced (not a per-step popup); ensure() returns a placeholder
// URL under NO_SPAWN so no real server is started.
function assertSetupRequired(r: HookResult): void {
  assert.equal(r.kind, 'context');
  if (r.kind === 'context') {
    assert.equal(r.systemMessage, 'traffic-one [setup required]');
    assert.ok(r.context.includes('http://127.0.0.1'), 'context carries the wizard URL');
    assert.equal(r.promptRequest, undefined);
  }
}

// Fresh local auth → authGateForHook authenticated WITHOUT spawning the CLI.
function withAuthedProject(state: Record<string, unknown> | null, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-promptsub-'));
  const env = process.env;
  const prevAuth = env.TRAFFIC_ONE_AUTH_STATE_PATH;
  const prevEndpoint = env.TRAFFIC_ONE_MCP_KEY_ENDPOINT;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevNoSpawn = env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
  const prevToolchainRoot = env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  const prevCodexHome = env.CODEX_HOME;
  const prevCodexPluginRoot = env.CODEX_PLUGIN_ROOT;
  const prevTrafficOnePluginRoot = env.TRAFFIC_ONE_PLUGIN_ROOT;
  const prevCodexOriginator = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  const prevCodexThreadId = env.CODEX_THREAD_ID;
  const prevCursorPluginRoot = env.CURSOR_PLUGIN_ROOT;
  env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(dir, 'auth.json');
  env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(dir, 'managed-tools');
  env.CODEX_HOME = path.join(dir, 'codex-home');
  delete env.CODEX_PLUGIN_ROOT;
  delete env.TRAFFIC_ONE_PLUGIN_ROOT;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  delete env.CODEX_THREAD_ID;
  delete env.CURSOR_PLUGIN_ROOT;
  fs.writeFileSync(env.TRAFFIC_ONE_AUTH_STATE_PATH, JSON.stringify({
    version: 1,
    auth: {
      version: 1, endpoint: 'http://127.0.0.1:8787/mcp', sessionToken: 'tok_x.sig',
      expiresAt: '2099-01-01T00:00:00Z', lastRemoteCheckedAt: new Date().toISOString(),
    },
  }), 'utf8');
  if (state) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
  }
  try { fn(dir); } finally {
    if (prevAuth === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = prevAuth;
    if (prevEndpoint === undefined) delete env.TRAFFIC_ONE_MCP_KEY_ENDPOINT; else env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = prevEndpoint;
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevNoSpawn === undefined) delete env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN; else env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = prevNoSpawn;
    if (prevToolchainRoot === undefined) delete env.TRAFFIC_ONE_TOOLCHAIN_ROOT; else env.TRAFFIC_ONE_TOOLCHAIN_ROOT = prevToolchainRoot;
    if (prevCodexHome === undefined) delete env.CODEX_HOME; else env.CODEX_HOME = prevCodexHome;
    if (prevCodexPluginRoot === undefined) delete env.CODEX_PLUGIN_ROOT; else env.CODEX_PLUGIN_ROOT = prevCodexPluginRoot;
    if (prevTrafficOnePluginRoot === undefined) delete env.TRAFFIC_ONE_PLUGIN_ROOT; else env.TRAFFIC_ONE_PLUGIN_ROOT = prevTrafficOnePluginRoot;
    if (prevCodexOriginator === undefined) delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE; else env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = prevCodexOriginator;
    if (prevCodexThreadId === undefined) delete env.CODEX_THREAD_ID; else env.CODEX_THREAD_ID = prevCodexThreadId;
    if (prevCursorPluginRoot === undefined) delete env.CURSOR_PLUGIN_ROOT; else env.CURSOR_PLUGIN_ROOT = prevCursorPluginRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TOOLCHAIN = Object.fromEntries(Object.keys(initializeToolchainState({})).map((k) => [k, { installedVersion: '1', installedAt: 'now' }]));
function completeSharedState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
    projectContext: { source: 'prompted', originalPrompt: 'x', summary: 's', answers: { a: 1 }, collectedAt: '2026-01-01T00:00:00Z' },
    confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z',
    materializedStack: 'default|react-vite|supabase|none',
    ...extra,
  };
}

function existingSharedState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'existing-codebase',
    stack: 'minimal',
    frontend: 'none',
    backend: 'other',
    realtime: 'none',
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

function writeLocalPrefs(extra: Record<string, unknown> = {}): void {
  const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  assert.ok(prefsPath, 'test prefs path must be configured');
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify({
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
    performance: { level: 'high', source: 'prompted' },
    team: { mode: 'subagents', source: 'prompted', approved: true },
    toolchain: TOOLCHAIN,
    ...extra,
  }), 'utf8');
  // codeGraphProvider is machine-wide (one.json, the AUTH_STATE_PATH alias here).
  writeGlobalCodeGraphProvider('graphify');
}

function writeExistingNextCodebase(cwd: string): void {
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'child', dependencies: { next: '15.0.0', react: '19.0.0' } }), 'utf8');
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(path.join(cwd, 'src', `page-${i}.tsx`), `export const page${i} = ${i};\n`, 'utf8');
  }
}

test('noop inside the plugin authoring root', () => {
  assert.equal(runUserPromptSubmit(ctx(process.cwd(), 'hello')).kind, 'noop');
});

test('authed + no state + a coding prompt → bootstraps new-project setup (mid-session auth)', () => {
  withAuthedProject(null, (cwd) => {
    const r = runUserPromptSubmit(ctx(cwd, 'build a todo app with auth'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      // Greenfield + authenticated → run the authed SessionStart body now →
      // the new-project setup directive + baseline rules.
      assert.ok(
        r.context.includes('Baseline rules') || r.context.toLowerCase().includes('setup'),
        'expected the new-project setup bootstrap',
      );
    }
  });
});

test('seeds the user request into new-project state so the wizard can derive the stack', () => {
  withAuthedProject(null, (cwd) => {
    runUserPromptSubmit(ctx(cwd, 'create a modern learning platform with courses and an admin area'));
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(state.mode, 'new-project');
    assert.ok(String(state.originalPrompt || '').includes('learning platform'), 'original prompt persisted for the wizard');
  });
});

test('coding-intent gate: authed + no state + a clearly non-coding prompt → noop (Traffic One stays inactive)', () => {
  withAuthedProject(null, (cwd) => {
    assert.equal(runUserPromptSubmit(ctx(cwd, 'hi there, how are you today?')).kind, 'noop');
    assert.equal(runUserPromptSubmit(ctx(cwd, 'what is the capital of France?')).kind, 'noop');
    // A signal-less prompt must NOT seed state — otherwise the next chit-chat turn
    // would find an initialized project and activate the wizard prematurely.
    assert.ok(!fs.existsSync(path.join(cwd, '.traffic-one', '.one.json')), 'no state seeded for non-coding chat');
  });
});

test('coding-intent gate: a verb-less project description is captured (not dropped) and wins over a later thin prompt', () => {
  // Regression: "a marketplace where freelancers and clients find each other" has no
  // coding verb, so the narrow isLikelyCodingPrompt dropped it — the first project
  // description was captured nowhere and a later "ok build it" became originalPrompt,
  // deriving `minimal`. promptHasStackSignal now admits it so the FIRST prompt wins.
  withAuthedProject(null, (cwd) => {
    const first = runUserPromptSubmit(ctx(cwd, 'a marketplace where freelancers and clients find each other'));
    assert.equal(first.kind, 'context', 'a real project description activates instead of being dropped');
    const seeded = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.ok(String(seeded.originalPrompt || '').includes('marketplace'), 'the first project prompt is seeded as originalPrompt');

    // A thin follow-up with a build verb must NOT overwrite the seeded project prompt.
    runUserPromptSubmit(ctx(cwd, 'ok build it'));
    const after = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.ok(String(after.originalPrompt || '').includes('marketplace'), 'the thin follow-up does not clobber the seeded project prompt');
  });
});

test('codex prompt mentioning an inner existing app bootstraps Traffic One in the child, not wrapper root', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-promptsub-child-')));
  const child = path.join(root, 'one-nextjs');
  const env = process.env;
  const prevAuth = env.TRAFFIC_ONE_AUTH_STATE_PATH;
  const prevEndpoint = env.TRAFFIC_ONE_MCP_KEY_ENDPOINT;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevNoSpawn = env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
  try {
    env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(root, 'auth.json');
    env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
    env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(root, 'prefs.json');
    env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
    fs.writeFileSync(env.TRAFFIC_ONE_AUTH_STATE_PATH, JSON.stringify({
      version: 1,
      auth: {
        version: 1, endpoint: 'http://127.0.0.1:8787/mcp', sessionToken: 'tok_x.sig',
        expiresAt: '2099-01-01T00:00:00Z', lastRemoteCheckedAt: new Date().toISOString(),
      },
    }), 'utf8');

    fs.mkdirSync(path.join(root, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(root, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase', stack: 'minimal', rootMarker: true }), 'utf8');
    writeExistingNextCodebase(child);

    const codex = makeClaudeAdapter('codex');
    const handlers: Handler[] = [{ id: 'prompt-submit', event: 'UserPromptSubmit', priority: 0, run: runUserPromptSubmit }];
    const out = await dispatch(codex, handlers, {
      stdin: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        cwd: root,
        prompt: 'please continue building the nextjs app in "one-nextjs"',
      }),
      argv: [],
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.systemMessage, 'traffic-one [custom-frontend] setup required');
    assert.ok(parsed.hookSpecificOutput.additionalContext.toLowerCase().includes('setup'));
    assert.ok(fs.existsSync(path.join(child, '.traffic-one', '.one.json')));
    const childState = JSON.parse(fs.readFileSync(path.join(child, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(childState.stack, 'custom-frontend');
    assert.equal(childState.frontend, 'nextjs');
    const rootState = JSON.parse(fs.readFileSync(path.join(root, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(rootState.rootMarker, true);
    assert.equal(rootState.stack, 'minimal');
  } finally {
    if (prevAuth === undefined) delete env.TRAFFIC_ONE_AUTH_STATE_PATH; else env.TRAFFIC_ONE_AUTH_STATE_PATH = prevAuth;
    if (prevEndpoint === undefined) delete env.TRAFFIC_ONE_MCP_KEY_ENDPOINT; else env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = prevEndpoint;
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevNoSpawn === undefined) delete env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN; else env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = prevNoSpawn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('authed + incomplete new project → setup required + wizard URL (no popup)', () => {
  withAuthedProject({ mode: 'new-project' }, (cwd) => {
    assertSetupRequired(runUserPromptSubmit(ctx(cwd, 'build a shop with checkout')));
  });
});

test('authed + incomplete new project but a SUBAGENT prompt → noop (subagents never onboard)', () => {
  withAuthedProject({ mode: 'new-project' }, (cwd) => {
    // The same prompt from the parent surfaces the wizard; from a subagent it must not.
    assertSetupRequired(runUserPromptSubmit(ctx(cwd, 'build a shop with checkout')));
    assert.equal(runUserPromptSubmit(ctxSub(cwd, 'build a shop with checkout')).kind, 'noop');
  });
});

test('authed + unapproved subagent line-up → setup required (wizard owns team confirmation)', () => {
  withAuthedProject(completeSharedState(), (cwd) => {
    writeLocalPrefs({ performance: { level: 'high', source: 'prompted' }, team: { mode: 'subagents', source: 'prompted', approved: false } });
    assertSetupRequired(runUserPromptSubmit(ctx(cwd, 'continue')));
  });
});

test('authed + complete shared new project but missing local prefs → setup required + URL', () => {
  withAuthedProject(completeSharedState(), (cwd) => {
    assertSetupRequired(runUserPromptSubmit(ctx(cwd, 'add a button')));
  });
});

test('authed + complete existing project but missing local prefs → setup required + URL', () => {
  withAuthedProject(existingSharedState(), (cwd) => {
    assertSetupRequired(runUserPromptSubmit(ctx(cwd, 'add a button')));
  });
});

test('cursor: incomplete onboarding puts the LIVE wizard URL in the USER-facing systemMessage (not just agent context)', () => {
  // On Cursor the recipe rides additional_context (agent-only) and the agent may skip
  // reposting the link — so the live URL must ALSO ride systemMessage → user_message.
  withAuthedProject({ mode: 'new-project' }, (cwd) => {
    // Seed a live server record so ensureOnboardingServer returns a REAL url under
    // NO_SPAWN (the ':0/' placeholder is intentionally NOT surfaced — formatWizardBanner).
    writeServerRecord(cwd, { pid: process.pid, port: 51234, token: 't', url: 'http://127.0.0.1:51234/?t=t', startedAt: 'x' });
    const r = runUserPromptSubmit(ctxHost(cwd, 'build a shop with checkout', 'cursor'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.systemMessage?.startsWith('traffic-one [setup required]'), 'banner preserved');
      assert.ok(r.systemMessage?.includes('http://127.0.0.1:51234'), 'systemMessage (user_message) carries the LIVE wizard URL on Cursor');
      assert.ok(r.context.includes('http://127.0.0.1'), 'agent context still carries the URL too');
    }
  });
});

test('non-cursor host keeps the plain setup banner (URL only in agent context)', () => {
  withAuthedProject({ mode: 'new-project' }, (cwd) => {
    const r = runUserPromptSubmit(ctxHost(cwd, 'build a shop with checkout', 'claude'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.equal(r.systemMessage, 'traffic-one [setup required]');
  });
});

function writeMaterialized(cwd: string, stackId: string): void {
  const t1 = path.join(cwd, '.traffic-one');
  fs.mkdirSync(path.join(t1, 'rules', 'common'), { recursive: true });
  fs.mkdirSync(path.join(t1, 'skills', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(t1, 'rules', 'common', 'auth-gate.md'), 'r', 'utf8');
  fs.writeFileSync(path.join(t1, 'skills', 'project-memory', 'SKILL.md'), 's', 'utf8');
  fs.writeFileSync(path.join(t1, 'manifest.json'), JSON.stringify({ generatedBy: 'traffic-one', stack: stackId, rules: ['rules/common/auth-gate.md'], skills: ['project-memory'] }), 'utf8');
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'x\n<!-- GENERATED BY traffic-one: project-local active rules -->\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'see agents', 'utf8');
}

test('authed + complete, materialized project, local prefs resolved → plain active-stack context', () => {
  withAuthedProject(completeSharedState(), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    const r = runUserPromptSubmit(ctx(cwd, 'add a button'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.equal(r.systemMessage, 'traffic-one [default]');
      assert.ok(r.context.includes('[ACTIVE STACK: default]'));
    }
  });
});

// ── Post-build maintenance triage ──

test('maintenance (existing-codebase) + trivial coding prompt → subagents triage, trivial hint', () => {
  withAuthedProject(existingSharedState({ materializedStack: 'minimal|none|other|none' }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'minimal');
    const r = runUserPromptSubmit(ctx(cwd, 'change the button color to blue'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('MAINTENANCE PHASE'), 'directive present');
      assert.ok(r.context.includes('Keyword hint: trivial'), 'trivial hint');
      assert.ok(r.context.includes('quick-fix'), 'subagents variant routes to quick-fix');
      // Prescriptive: force delegation + name the concrete cheapest model (host=claude → haiku).
      assert.ok(r.context.includes('Do NOT make the edit yourself'), 'directive forbids inline work in subagents mode');
      assert.ok(r.context.includes('model "haiku"'), 'names the concrete cheapest model');
    }
  });
});

test('maintenance triage: full rubric once per session, then a one-line reminder with fresh hint', () => {
  withAuthedProject(existingSharedState({ materializedStack: 'minimal|none|other|none' }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'minimal');
    const first = runUserPromptSubmit(ctx(cwd, 'change the button color to blue'));
    assert.equal(first.kind, 'context');
    if (first.kind === 'context') assert.ok(first.context.includes('MAINTENANCE PHASE — post-build triage'), 'first prompt gets the full rubric');
    const second = runUserPromptSubmit(ctx(cwd, 'now fix the headline copy'));
    assert.equal(second.kind, 'context');
    if (second.kind === 'context') {
      assert.ok(second.context.includes('triage reminder'), 'second prompt gets the one-liner');
      assert.ok(!second.context.includes('post-build triage] The main build is complete'), 'rubric body not repeated');
      assert.ok(second.context.includes('hint: trivial'), 'reminder still carries the per-prompt hint');
    }
  });
});

test('maintenance + OpenCode ACTIVE → triage routes to opencode_delegate FIRST (paid worker only as fallback)', () => {
  // The reported gap: quick-fix went straight to the paid model because the project's
  // opencode (enabled + present) was never stamped, so openCodeDelegationActive() was
  // false and the directive dropped its OpenCode clause. With opencode enabled AND
  // stamped, the directive must push the delegate tool first.
  withAuthedProject(existingSharedState({ materializedStack: 'minimal|none|other|none' }), (cwd) => {
    writeLocalPrefs({
      openCode: { enabled: true, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
      toolchain: { ...TOOLCHAIN, opencode: { installedVersion: '1.15.13', installedAt: 'now' } },
    });
    writeMaterialized(cwd, 'minimal');
    const r = runUserPromptSubmit(ctx(cwd, 'change the button color to blue'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('MAINTENANCE PHASE'), 'directive present');
      assert.ok(r.context.includes('opencode_delegate'), 'routes to the OpenCode delegate tool');
      assert.ok(r.context.includes('FIRST'), 'OpenCode is the FIRST attempt; the paid worker is the fallback');
    }
  });
});

test('maintenance + OpenCode ACTIVE on Codex → routes to opencode_delegate FIRST (host-agnostic) + self-registers the MCP server', () => {
  withAuthedProject(existingSharedState({ materializedStack: 'minimal|none|other|none' }), (cwd) => {
    const env = process.env;
    assert.ok(env.CODEX_HOME, 'test CODEX_HOME is sandboxed');
    const pluginRoot = path.join(env.CODEX_HOME, 'local-marketplaces', 'traffic-one-local', 'plugins', 'traffic-one');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'scripts', 'opencode-mcp.cjs'), '#!/usr/bin/env node\n', 'utf8');
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Codex Desktop';

    writeLocalPrefs({
      openCode: { enabled: true, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
      toolchain: { ...TOOLCHAIN, opencode: { installedVersion: '1.15.13', installedAt: 'now' } },
    });
    writeMaterialized(cwd, 'minimal');

    const r = runUserPromptSubmit(ctxHost(cwd, 'create new page called news and add some dummy data', 'codex'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      // Codex behaves like every other host now: delegate FIRST, no host-blocked clause.
      assert.ok(r.context.includes('opencode_delegate'), 'Codex routes to the OpenCode delegate tool');
      assert.ok(r.context.includes('FIRST'), 'OpenCode is the FIRST attempt; the paid worker is the fallback');
      assert.ok(!r.context.includes('Codex blocks'), 'no host-blocked clause');
      assert.ok(!r.context.includes('Do NOT call `opencode_delegate`'), 'Codex is not steered away from the tool');
    }
    // Still self-registers the MCP server in config.toml when session-start missed it.
    const cfg = fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.ok(cfg.includes('[mcp_servers.opencode-worker]'));
    assert.ok(cfg.includes('local-marketplaces/traffic-one-local/plugins/traffic-one/scripts/opencode-mcp.cjs'));
  });
});

test('maintenance triage mints a fresh run id so stale OpenCode role attempts do not bypass the next request', () => {
  withAuthedProject(existingSharedState({
    materializedStack: 'minimal|none|other|none',
    currentRunId: 'old-maintenance-run',
    spawnIndex: { 'senior-frontend': 1 },
  }), (cwd) => {
    writeLocalPrefs({
      openCode: { enabled: true, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
      toolchain: { ...TOOLCHAIN, opencode: { installedVersion: '1.15.13', installedAt: 'now' } },
    });
    writeMaterialized(cwd, 'minimal');
    markOpenCodeGateDenied(cwd, 'old-maintenance-run', 'senior-frontend');
    markOpenCodeRoleAttempted(cwd, 'old-maintenance-run', 'senior-frontend');

    const triage = runUserPromptSubmit(ctx(cwd, 'create new page called news and add some dummy data'));
    assert.equal(triage.kind, 'context');
    if (triage.kind === 'context') {
      assert.ok(triage.context.includes('MAINTENANCE PHASE'), 'triage directive present');
      assert.ok(triage.context.includes('role "senior-frontend"'), 'small single-role work is explicitly OpenCode-delegated first');
    }

    const one = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.notEqual(one.currentRunId, 'old-maintenance-run', 'new maintenance request gets a fresh run id');
    assert.deepEqual(one.spawnIndex || {}, {}, 'fresh maintenance run starts with a clean spawn index');

    const denied = agentModelGate(spawnCtx(cwd, { subagent_type: 'senior-frontend', model: 'opus' }));
    assert.equal(denied.kind, 'deny');
    if (denied.kind === 'deny') assert.ok(denied.reason.includes('OpenCode role gate'));
  });
});

test('maintenance + a copy/headline tweak (missed by the coding-intent heuristic) still triages', () => {
  // Regression: "Change the hero headline ..." has no coding verb/noun, so the
  // narrow isLikelyCodingPrompt suppressed the directive and the main agent edited
  // inline instead of routing to quick-fix. isLikelyEditRequest now fires it.
  withAuthedProject(existingSharedState({ materializedStack: 'minimal|none|other|none' }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'minimal');
    const r = runUserPromptSubmit(ctx(cwd, 'Change the hero headline to Master Software without Development'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('MAINTENANCE PHASE'), 'triage fires for a copy/headline tweak');
      assert.ok(r.context.includes('quick-fix'), 'routes to the quick-fix worker');
    }
  });
});

test('maintenance + complex coding prompt → complex hint, orchestrator route', () => {
  withAuthedProject(existingSharedState({ materializedStack: 'minimal|none|other|none' }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'minimal');
    const r = runUserPromptSubmit(ctx(cwd, 'add Stripe checkout and subscription billing'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('Keyword hint: complex'), 'complex hint');
      assert.ok(r.context.includes('senior-eng-orchestrator'), 'routes to the orchestrator');
    }
  });
});

test('building new project → NO triage directive', () => {
  withAuthedProject(completeSharedState(), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    const r = runUserPromptSubmit(ctx(cwd, 'change the button color'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.ok(!r.context.includes('MAINTENANCE PHASE'), 'no triage while still building');
  });
});

test('new project flipped to maintenance → triage directive appears', () => {
  withAuthedProject(completeSharedState({ lifecycle: { phase: 'maintenance', source: 'orchestrator', completedAt: '2026-02-01T00:00:00Z' } }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    const r = runUserPromptSubmit(ctx(cwd, 'add a new feature for exporting data'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.ok(r.context.includes('MAINTENANCE PHASE'), 'triage after the build flips');
  });
});

test('settled new-project build stuck in "building" flips to maintenance at the prompt boundary → triage appears', () => {
  // The Cursor regression: the build reached verification but the orchestrator's
  // Phase-5 stamp never landed and a spawned worker's claim never activated (stays
  // `pending`), so the project is pinned in `building` and the next edit request is
  // mis-gated. A NEW user prompt is the boundary: the prior turn ended, so the leftover
  // claim isn't in-flight — UserPromptSubmit flips to maintenance and triages the request.
  withAuthedProject(completeSharedState(), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    // Real build output (> the maintenance file floor).
    const srcDir = path.join(cwd, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(srcDir, `f${i}.ts`), 'export const x = 1;\n', 'utf8');
    // Build reached verification and TERMINALLY settled (reviewer APPROVED + tester
    // TESTS_GREEN). Existence alone is not settlement — a mid-fix-cycle digest must
    // not flip; this scenario is a genuinely-finished build whose Phase-5 stamp never landed.
    const dd = path.join(cwd, '.traffic-one', 'digests', 'build-run');
    fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, 'reviewer.md'), '# reviewer\nverdict: APPROVED\n', 'utf8');
    fs.writeFileSync(path.join(dd, 'tester.md'), '# tester\nverdict: TESTS_GREEN\n', 'utf8');
    // A leftover pending claim that never activated (would block the PostToolUse heuristic).
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'build-run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'sess.json'), JSON.stringify({ role: 'senior-frontend', runId: 'build-run', createdAt: new Date(Date.now() - 60_000).toISOString() }), 'utf8');

    const r = runUserPromptSubmit(ctx(cwd, 'add a new page (news)'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.ok(r.context.includes('MAINTENANCE PHASE'), 'flips + triages the request');
    // The flip is persisted so the worker write gate (run-team) re-reads maintenance.
    const persisted = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(persisted.lifecycle?.phase, 'maintenance');
    assert.equal(persisted.lifecycle?.source, 'prompt-boundary');
  });
});

test('subagent prompt does NOT flip the project lifecycle at the boundary', () => {
  // Only the main agent's prompt boundary represents the end of the build turn.
  withAuthedProject(completeSharedState(), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    const srcDir = path.join(cwd, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(srcDir, `f${i}.ts`), 'export const x = 1;\n', 'utf8');
    const dd = path.join(cwd, '.traffic-one', 'digests', 'build-run');
    fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, 'reviewer.md'), '# APPROVED\n', 'utf8');

    runUserPromptSubmit(ctxSub(cwd, 'add a new page (news)'));
    const persisted = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.ok(!persisted.lifecycle, 'subagent prompt left the lifecycle untouched (still building)');
  });
});

test('maintenance + non-coding prompt → NO triage directive', () => {
  withAuthedProject(existingSharedState({ materializedStack: 'minimal|none|other|none' }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'minimal');
    const r = runUserPromptSubmit(ctx(cwd, 'how are you today?'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.ok(!r.context.includes('MAINTENANCE PHASE'), 'no triage for non-coding chat');
  });
});

test('claims from a run finished before the lifecycle stamp do NOT suppress triage', () => {
  // Regression: after a build completes, its claims stay "fresh" for up to 30
  // minutes — the watermark (lifecycle.completedAt) must lift the suppression on
  // the user's immediate next prompt.
  const completedAt = new Date(Date.now() - 60_000).toISOString();
  const claimCreatedAt = new Date(Date.now() - 10 * 60_000).toISOString(); // fresh, but pre-watermark
  withAuthedProject(existingSharedState({
    materializedStack: 'minimal|none|other|none',
    lifecycle: { phase: 'maintenance', source: 'orchestrator', completedAt },
  }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'minimal');
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'run-done');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'sess.json'), JSON.stringify({ role: 'senior-frontend', runId: 'run-done', createdAt: claimCreatedAt }), 'utf8');
    const r = runUserPromptSubmit(ctx(cwd, 'change the button color'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.ok(r.context.includes('MAINTENANCE PHASE'), 'directive present right after the build');
  });
});

test('claims newer than the lifecycle stamp DO suppress triage (mid-run guard intact)', () => {
  const completedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const claimCreatedAt = new Date(Date.now() - 30_000).toISOString(); // a run started AFTER the stamp
  withAuthedProject(existingSharedState({
    materializedStack: 'minimal|none|other|none',
    lifecycle: { phase: 'maintenance', source: 'orchestrator', completedAt },
  }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'minimal');
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'run-live');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'sess.json'), JSON.stringify({ role: 'senior-frontend', runId: 'run-live', createdAt: claimCreatedAt }), 'utf8');
    const r = runUserPromptSubmit(ctx(cwd, 'change the button color'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.ok(!r.context.includes('MAINTENANCE PHASE'), 'no re-triage mid-run');
  });
});

test('maintenance + main-agent mode → main-agent triage variant', () => {
  withAuthedProject(existingSharedState({ materializedStack: 'minimal|none|other|none' }), (cwd) => {
    writeLocalPrefs({ performance: { level: 'low', source: 'prompted' }, team: { mode: 'main-agent', source: 'prompted' } });
    writeMaterialized(cwd, 'minimal');
    const r = runUserPromptSubmit(ctx(cwd, 'change the button color'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('MAINTENANCE PHASE'), 'directive present');
      assert.ok(r.context.includes('main-agent mode'), 'main-agent variant');
    }
  });
});
