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
import { transitionRunStatus, writeGlobalCodeGraphProvider } from '../../../shared/state';
import { writeServerRecord } from '../../../shared/onboarding-server/registry';
import { markModelChoicePrompted, readModelChoice } from '../../agent-model/model-choice';
import { exhaustedModelsForRole, recordExhaustedModel } from '../../agent-model/exhausted-models';
import { hostScopedPerformancePrefs } from '../../../test-support/host-prefs';
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';
import { readJsonResult } from '../../../shared/fsjson';
import { writeMaterializedContent } from '../../../shared/materialize/__tests__/fixtures/materialized-content';

// These tests exercise the setup-wizard flow itself, which under the shipped
// ask-first default (ASK_USE_PLUGIN_FIRST) only starts after the user's
// recorded yes. Pin the runtime override off so the wizard paths stay directly
// testable; the ask-first question has dedicated tests that set the flag to '1'.
process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

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
    // Banner now carries the dashboard setup link on every host (opens in the browser).
    assert.ok(r.systemMessage?.startsWith('traffic-one [setup required]'));
    assert.ok(r.context.includes('/onboarding/agent'), 'context carries the dashboard setup URL');
    assert.equal(r.promptRequest, undefined);
  }
}

function assertOpenCodeSetupTextIsSanitized(text: string): void {
  assert.ok(text.includes('/onboarding/agent'), 'OpenCode setup text still carries the dashboard setup URL');
  assert.ok(text.includes('immediately run the wait command'), 'OpenCode setup text tells the agent not to pause after the link');
  assert.ok(text.includes('TRAFFIC_ONE_RESTART_OPENCODE_REQUIRED'), 'OpenCode setup text tells the agent to stop for restart');
  assert.ok(text.includes('type "continue" or "resume"'), 'OpenCode setup text tells the user how to resume after restart');
  assert.ok(!text.includes('Continue the original request after TRAFFIC_ONE_SETUP_COMPLETE'), 'OpenCode setup must not auto-continue');
  for (const unsafe of ['.claude/launch.json', 'preview_start', 'node_repl', 'const fs', 'do NOT', 'Do NOT']) {
    assert.ok(!text.includes(unsafe), `OpenCode setup text must not include ${unsafe}`);
  }
}

// Fresh canonical auth lets runtime gates continue without opening the wizard.
function withAuthedProject(state: Record<string, unknown> | null, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-promptsub-'));
  const env = process.env;
  const prevAuth = env.TRAFFIC_ONE_STATE_PATH;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevNoSpawn = env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
  const prevToolchainRoot = env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  const prevCodexHome = env.CODEX_HOME;
  const prevCodexPluginRoot = env.CODEX_PLUGIN_ROOT;
  const prevTrafficOnePluginRoot = env.TRAFFIC_ONE_PLUGIN_ROOT;
  const prevCodexOriginator = env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  const prevCodexThreadId = env.CODEX_THREAD_ID;
  const prevCursorPluginRoot = env.CURSOR_PLUGIN_ROOT;
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(dir, 'managed-tools');
  env.CODEX_HOME = path.join(dir, 'codex-home');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  delete env.CODEX_PLUGIN_ROOT;
  delete env.TRAFFIC_ONE_PLUGIN_ROOT;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  delete env.CODEX_THREAD_ID;
  delete env.CURSOR_PLUGIN_ROOT;
  fs.writeFileSync(env.TRAFFIC_ONE_STATE_PATH, JSON.stringify({
    schemaVersion: 3,
    auth: {
      version: 1, authenticated: true, apiKey: 'sk-telemetry-123', updatedAt: '2099-01-01T00:00:00Z',
    },
    hosts: {},
  }), 'utf8');
  if (state) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
    // Seed a live server record ONLY for already-initialized projects (mid-onboarding),
    // so ensureOnboardingServer (NO_SPAWN) hands back a real dashboard deep link instead
    // of the inert placeholder. Not for null state — a bare/pristine dir must stay inert
    // so non-coding chit-chat still resolves to noop. Tests needing a specific port
    // re-seed their own record (it overwrites this).
    for (const host of ['claude', 'codex', 'cursor', 'opencode', 'kilo', 'windsurf'] as const) {
      writeServerRecord(
        dir,
        { pid: process.pid, port: 51900, token: 't', url: 'http://127.0.0.1:51900/?t=t', startedAt: 'x' },
        process.env,
        host,
      );
    }
  }
  try { fn(dir); } finally {
    if (prevAuth === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = prevAuth;
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevNoSpawn === undefined) delete env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN; else env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = prevNoSpawn;
    if (prevToolchainRoot === undefined) delete env.TRAFFIC_ONE_TOOLCHAIN_ROOT; else env.TRAFFIC_ONE_TOOLCHAIN_ROOT = prevToolchainRoot;
    if (prevCodexHome === undefined) delete env.CODEX_HOME; else env.CODEX_HOME = prevCodexHome;
    if (prevCodexPluginRoot === undefined) delete env.CODEX_PLUGIN_ROOT; else env.CODEX_PLUGIN_ROOT = prevCodexPluginRoot;
    if (prevTrafficOnePluginRoot === undefined) delete env.TRAFFIC_ONE_PLUGIN_ROOT; else env.TRAFFIC_ONE_PLUGIN_ROOT = prevTrafficOnePluginRoot;
    if (prevCodexOriginator === undefined) delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE; else env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = prevCodexOriginator;
    if (prevCodexThreadId === undefined) delete env.CODEX_THREAD_ID; else env.CODEX_THREAD_ID = prevCodexThreadId;
    if (prevCursorPluginRoot === undefined) delete env.CURSOR_PLUGIN_ROOT; else env.CURSOR_PLUGIN_ROOT = prevCursorPluginRoot;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
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
  const {
    performance = { level: 'high', source: 'prompted' },
    team = { mode: 'subagents', source: 'prompted', approved: true },
    ...rest
  } = extra;
  fs.writeFileSync(prefsPath, JSON.stringify({
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
    ...hostScopedPerformancePrefs(
      performance as Record<string, unknown>,
      team as Record<string, unknown>,
      'pro',
    ),
    toolchain: TOOLCHAIN,
    ...rest,
  }), 'utf8');
  // codeGraphProvider is machine-wide in the canonical one.json envelope.
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

test('declined project: silent on normal prompts; an explicit Traffic One mention offers the reconsider command', () => {
  withAuthedProject(null, (cwd) => {
    recordPluginUseChoice(cwd, false, 'command');
    // Normal prompts: fully silent — no recipes, no banners, no wizard.
    assert.equal(runUserPromptSubmit(ctx(cwd, 'build a todo app with auth')).kind, 'noop');
    assert.equal(runUserPromptSubmit(ctx(cwd, 'fix the login bug')).kind, 'noop');
    // The one re-entry signal: the user explicitly names Traffic One.
    const r = runUserPromptSubmit(ctx(cwd, 'actually, I want to use Traffic One for this project'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.match(r.context, /DISABLED by the user's own earlier choice/);
      assert.ok(r.context.includes('--reconsider'), 'offers the reconsider command');
    }
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'still no project files');
  });
});

// The chat message is the last moment our code runs at all — no host fires a
// plugin uninstall hook — so the check sits ahead of every gate below it.
test('an uninstall request is answered from anywhere, including outside a project', () => {
  for (const cwd of [process.cwd(), os.tmpdir()]) {
    const r = runUserPromptSubmit(ctx(cwd, 'uninstall traffic one'));
    assert.equal(r.kind, 'context', `expected the directive from ${cwd}`);
    if (r.kind === 'context') {
      assert.match(r.context, /ONE explicit confirmation/);
      assert.ok(r.context.includes('traffic-one-uninstall.cjs'), 'carries the cleanup command');
      assert.equal(r.systemMessage, 'traffic-one [uninstall requested]');
    }
  }
});

test('an uninstall request on a DECLINED project uninstalls — it does not offer to re-enable', () => {
  withAuthedProject(null, (cwd) => {
    recordPluginUseChoice(cwd, false, 'command');
    const r = runUserPromptSubmit(ctx(cwd, 'please uninstall the traffic one plugin'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.match(r.context, /UNINSTALL Traffic One/);
      assert.ok(!r.context.includes('--reconsider'), 'the reconsider branch must not claim this prompt');
    }
  });
});

test('talk ABOUT uninstalling is not an uninstall request', () => {
  withAuthedProject(null, (cwd) => {
    for (const prompt of ['how do I uninstall traffic one?', "don't uninstall traffic one"]) {
      const r = runUserPromptSubmit(ctx(cwd, prompt));
      const text = r.kind === 'context' ? r.context : '';
      assert.ok(!text.includes('traffic-one-uninstall.cjs'), `must not arm the cleanup: ${prompt}`);
    }
  });
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

test('ask-first: the first coding prompt gets ONLY the question — nothing written, request rides the yes command', () => {
  withAuthedProject(null, (cwd) => {
    const prevAsk = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
    try {
      const prompt = 'create a modern learning platform with courses for web development';
      const r = runUserPromptSubmit(ctx(cwd, prompt));
      assert.equal(r.kind, 'context');
      if (r.kind === 'context') {
        assert.match(r.context, /Do you want to use the Traffic One plugin/);
        assert.ok(r.context.includes(`--seed-prompt=${prompt}`), 'the yes command carries the request so it is seeded AFTER the recorded yes');
        assert.ok(!r.context.includes('http://127.0.0.1'), 'no wizard URL before the user says yes');
      }
      // The exact regression this guards: .one.json, per-user preferences.json,
      // and the wizard server record were all created BEFORE the user answered.
      assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'no project .traffic-one before the answer');
      assert.equal(fs.existsSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string), false, 'no per-user prefs before the answer');
      // Repeat prompts keep asking (still no writes) instead of seeding state.
      const again = runUserPromptSubmit(ctx(cwd, prompt));
      assert.equal(again.kind, 'context');
      assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'still nothing after a repeat prompt');
    } finally {
      if (prevAsk === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
      else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = prevAsk;
    }
  });
});

test('a control/stop command is NEVER seeded as originalPrompt (initialized-but-unseeded project)', () => {
  // Field bug: state existed without an originalPrompt (the first build prompt wasn't captured —
  // e.g. reset mid-session), then the user typed "stop all", which became originalPrompt and
  // mis-drove the wizard/triage. originalPrompt is the project DESCRIPTION → a control command
  // must never seed it.
  withAuthedProject({ mode: 'new-project' }, (cwd) => {
    runUserPromptSubmit(ctx(cwd, 'stop all'));
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.notEqual(String(state.originalPrompt || ''), 'stop all', 'a control command is not seeded as the project description');
    // A real build prompt afterward IS captured.
    runUserPromptSubmit(ctx(cwd, 'create a modern learning platform with courses and an admin area'));
    const after = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.ok(String(after.originalPrompt || '').includes('learning platform'), 'the real build prompt is seeded');
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
  // deriving a bare frontend shell with none of the real project's surfaces.
  // promptHasStackSignal now admits it so the FIRST prompt wins.
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

test('codex prompt mentioning an inner app stays anchored at the ancestor Traffic One root', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-promptsub-child-')));
  const child = path.join(root, 'one-nextjs');
  const env = process.env;
  const prevAuth = env.TRAFFIC_ONE_STATE_PATH;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevNoSpawn = env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
  try {
    env.TRAFFIC_ONE_STATE_PATH = path.join(root, 'one.json');
    env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(root, 'prefs.json');
    env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
    fs.writeFileSync(env.TRAFFIC_ONE_STATE_PATH, JSON.stringify({
      schemaVersion: 3,
      auth: {
        version: 1, authenticated: true, apiKey: 'sk-telemetry-123', updatedAt: '2099-01-01T00:00:00Z',
      },
      hosts: {},
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
    assert.equal(parsed.systemMessage, 'traffic-one [setup required]');
    assert.ok(parsed.hookSpecificOutput.additionalContext.toLowerCase().includes('setup'));
    const trafficDir = '.traffic' + '-one';
    assert.equal(fs.existsSync(path.join(child, trafficDir, '.one.json')), false);
    const rootStateAfter = JSON.parse(fs.readFileSync(path.join(root, trafficDir, '.one.json'), 'utf8'));
    assert.equal(rootStateAfter.rootMarker, true);
    assert.equal(rootStateAfter.stack, 'minimal');
  } finally {
    if (prevAuth === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = prevAuth;
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

test('incomplete-project waiter carries the normalized prompt session id', () => {
  withAuthedProject({ mode: 'new-project' }, (cwd) => {
    const prompt = 'build a shop with checkout';
    const input: HookInput = {
      event: 'UserPromptSubmit',
      host: 'claude',
      cwd,
      prompt,
      raw: { prompt, session_id: 'prompt:session' },
    };
    const r = runUserPromptSubmit({ input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx);
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.ok(r.context.includes("'--sync-session=prompt_session'"));
  });
});

test('opencode: incomplete onboarding prompt uses sanitized setup text', () => {
  withAuthedProject({ mode: 'new-project' }, (cwd) => {
    const r = runUserPromptSubmit(ctxHost(cwd, 'build a shop with checkout', 'opencode'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      // The banner now carries the dashboard link on opencode too (a plain URL in the
      // user-facing systemMessage is safe; the prompt-injection concern is the agent
      // context, which stays sanitized below).
      assert.ok(r.systemMessage?.startsWith('traffic-one [setup required]'));
      assertOpenCodeSetupTextIsSanitized(r.context);
    }
  });
});

test('windsurf: incomplete onboarding prompt uses the compact host-only setup directive', () => {
  withAuthedProject({ mode: 'new-project' }, (cwd) => {
    const url = 'http://127.0.0.1:51235/?t=windsurf';
    const dashboardUrl = 'https://traffic.io/onboarding/agent#p=51235&t=windsurf';
    writeServerRecord(cwd, { pid: process.pid, port: 51235, token: 'windsurf', url, startedAt: 'x' }, process.env, 'windsurf');
    const r = runUserPromptSubmit(ctxHost(cwd, 'build a shop with checkout', 'windsurf'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.systemMessage?.includes(dashboardUrl), 'Windsurf banner carries the dashboard setup URL');
      assert.ok(r.context.includes(`[Open Traffic One setup](${dashboardUrl})`));
      assert.ok(r.context.includes('TRAFFIC_ONE_SETUP_COMPLETE'));
      for (const foreign of ['Claude Code', 'Cursor:', 'Codex Desktop', '.claude/launch.json', 'preview_start', 'node_repl', 'const fs']) {
        assert.ok(!r.context.includes(foreign), `Windsurf setup must not include ${foreign}`);
      }
    }
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
    writeServerRecord(cwd, { pid: process.pid, port: 51234, token: 't', url: 'http://127.0.0.1:51234/?t=t', startedAt: 'x' }, process.env, 'cursor');
    const r = runUserPromptSubmit(ctxHost(cwd, 'build a shop with checkout', 'cursor'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.systemMessage?.startsWith('traffic-one [setup required]'), 'banner preserved');
      assert.ok(r.systemMessage?.includes('https://traffic.io/onboarding/agent#p=51234&t=t'), 'systemMessage (user_message) carries the dashboard setup URL on Cursor');
      assert.ok(r.context.includes('/onboarding/agent'), 'agent context still carries the URL too');
    }
  });
});

test('every host now surfaces the dashboard setup URL in the banner (onboarding opens in the browser)', () => {
  withAuthedProject({ mode: 'new-project' }, (cwd) => {
    // seeded record → port 51900 (withAuthedProject default)
    const r = runUserPromptSubmit(ctxHost(cwd, 'build a shop with checkout', 'claude'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.systemMessage?.startsWith('traffic-one [setup required]'));
      assert.ok(r.systemMessage?.includes('https://traffic.io/onboarding/agent#p=51900&t=t'), 'claude banner now carries the dashboard link too');
    }
  });
});

test('cursor: PRISTINE first coding prompt (no .one.json) puts the URL + "post link FIRST" recipe in the AGENT channel', () => {
  // The 5b failure: a truly pristine new-project dir takes the uninitialized early
  // return into runSessionStartAuthed → Flow 3, which previously emitted the URL-less
  // `setup-pending` block in additional_context — so on Cursor the agent saw no link
  // and no instruction to post one (user_message is not rendered on user-prompt-submit).
  // Flow 3 must now carry the live URL AND the explicit "Open the Traffic One setup
  // wizard: <url>" FIRST, before the wait command instruction in the agent-facing channel.
  withAuthedProject(null, (cwd) => {
    // Seed a live server record so ensureOnboardingServer returns a REAL url under
    // NO_SPAWN (the ':0/' placeholder is intentionally not surfaced).
    writeServerRecord(cwd, { pid: process.pid, port: 56858, token: 't', url: 'http://127.0.0.1:56858/?t=t', startedAt: 'x' }, process.env, 'cursor');
    const r = runUserPromptSubmit(ctxHost(cwd, 'create a modern learning platform', 'cursor'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('https://traffic.io/onboarding/agent#p=56858&t=t'), 'agent context carries the dashboard setup URL on the pristine first prompt');
      assert.ok(/Open Traffic One setup:/i.test(r.context), 'agent context instructs Cursor to post the clickable link line');
      assert.ok(/FIRST/.test(r.context) && /wait command/i.test(r.context), 'instruction says post FIRST, before the wait command');
    }
  });
});

test('non-cursor PRISTINE first coding prompt now also carries the dashboard setup URL (onboarding opens in the browser)', () => {
  // The onboarding UI moved to the traffic.io dashboard and opens in an external
  // browser on every host, so Flow 3 surfaces the dashboard link for claude too (no
  // more preview-pane-only special-casing).
  withAuthedProject(null, (cwd) => {
    writeServerRecord(cwd, { pid: process.pid, port: 56858, token: 't', url: 'http://127.0.0.1:56858/?t=t', startedAt: 'x' }, process.env, 'claude');
    const r = runUserPromptSubmit(ctxHost(cwd, 'create a modern learning platform', 'claude'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('https://traffic.io/onboarding/agent#p=56858&t=t'), 'claude agent context now carries the dashboard setup URL');
      assert.ok(r.context.includes('onboarding-wait.cjs'), 'agent context carries the blocking waiter on the pristine first prompt');
    }
  });
});

// The manifest carries the project's WHOLE declared rule/skill set, not a
// one-rule stand-in: a short manifest is the shape of a project truncated by a
// partially copied plugin root, and convergence re-materializes that instead of
// short-circuiting (shared/materialize/has-assets.ts
// materializedContentIsIncomplete). With the suite-wide plugin root being this
// source checkout, a re-converge here would surface as a materialization refusal
// in place of the prompt output these tests assert on.
function writeMaterialized(cwd: string, stackId: string): void {
  writeMaterializedContent(cwd, { stack: stackId });
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

test('an explicit UI library choice is persisted and never copied from a subagent prompt', () => {
  withAuthedProject(completeSharedState(), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    runUserPromptSubmit(ctx(cwd, 'Use MUI for this frontend instead of shadcn'));
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).uiLibrary, 'mui');

    runUserPromptSubmit(ctxSub(cwd, 'Use Chakra UI for my assigned component'));
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).uiLibrary, 'mui');
  });
});

// The prompt is the ONLY source of `uiLibrary` — the wizard has no step for it —
// so a refused write loses an explicit user instruction outright unless they
// happen to name the library again later. Worse, the in-memory state used to be
// advanced past the refused write, so the rest of the hook behaved on a value no
// later hook can read back.
//
// MOVE-ASIDE rather than a dangling link: writeState re-reads `.one.json` and this
// handler reads it several times before the write, so a dangling link makes the
// handler bail on its own precondition and the case passes vacuously — which the
// writable baseline above cannot catch, being a different directory.
test('a UI library choice the fence refused is not recorded silently', () => {
  withAuthedProject(completeSharedState(), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const aside = `${statePath}.aside`;
    const before = fs.readFileSync(statePath, 'utf8');
    fs.renameSync(statePath, aside);
    fs.symlinkSync(aside, statePath);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before,
      'fixture guard: reads still resolve through the link, so the handler reaches its write');

    const result = runUserPromptSubmit(ctx(cwd, 'Use MUI for this frontend instead of shadcn'));
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).uiLibrary, undefined,
      'fixture guard: the write really was refused');
    assert.equal(result.kind, 'context', 'the handler still answers — a refused preference never fails a prompt');
    if (result.kind === 'context') {
      assert.match(result.context, /UI library you named/,
        'the user is told their explicit instruction was not recorded');
      assert.match(result.context, /\.one\.json/, 'and which path refused it');
    }
  });
});

// The kind of failure the fence test above cannot reach: not a refused write, an
// ILLEGIBLE BASE. This path used to REPLACE a torn `.one.json` with a couple of
// prompt-derived fields plus a version and answer true, sending everything the
// wizard had recorded to `.one.json.corrupt` where nothing reads it. TWO writers
// did it, which is what this test is about:
//
//   - the UI-library write, `writeState(cwd, { ...readState(cwd), uiLibrary })`,
//     now `patchState`, which re-reads inside the state lock and refuses;
//   - `seedOriginalPrompt` (shared/onboarding/seed-prompt.ts), the same
//     whole-object spelling onto the same `{}`, now refusing at the read.
//
// It used to assert the file WAS replaced, because on ONE prompt the two are
// indistinguishable: a torn base necessarily makes computeOnboarding incomplete,
// that branch calls the seed, and the seed derives the same `uiLibrary` from the
// same words — so "Use MUI for this frontend" produced a file carrying both
// fields whichever writer was at fault. That masking is why the sibling
// conversion could not be proven, and SPLITTING THE PROMPT is what separates
// them: `switch to mui` names a library but is not a project description, so
// only the UI-library site can write; `build a marketplace for freelancers` is a
// project description that names no library, so only the seed can. Each case
// below therefore fails in ONE writer's name.
//
// Every case asserts its writable, legible baseline first, on the same handler
// and the same prompt: an untouched file afterwards is then the READ's decision
// and not a handler that never reached the writer.
test('a torn `.one.json` is left exactly as it was on this path — neither writer merges onto a base it could not read', () => {
  const statePathOf = (cwd: string): string => path.join(cwd, '.traffic-one', '.one.json');
  const SEED_ONLY = 'build a marketplace for freelancers';
  const UI_ONLY = 'switch to mui';
  const torn = '{"mode":"new-project","stack":"default","onboardingComplete":tr';

  withAuthedProject({ mode: 'new-project' }, (cwd) => {
    assert.equal(readJsonResult(statePathOf(cwd)).kind, 'ok', 'baseline guard: the base is legible');
    assert.equal(runUserPromptSubmit(ctx(cwd, SEED_ONLY)).kind, 'context');
    const after = JSON.parse(fs.readFileSync(statePathOf(cwd), 'utf8'));
    assert.equal(after.originalPrompt, SEED_ONLY, 'baseline: the seed reaches its write and a legible base takes it');
    assert.equal(after.uiLibrary, undefined, 'baseline: and this prompt names no library, so nothing else wrote');
    assert.equal(after.mode, 'new-project', 'baseline: onto the base, not over it');
  });

  withAuthedProject({ mode: 'new-project' }, (cwd) => {
    assert.equal(runUserPromptSubmit(ctx(cwd, UI_ONLY)).kind, 'context');
    const after = JSON.parse(fs.readFileSync(statePathOf(cwd), 'utf8'));
    assert.equal(after.uiLibrary, 'mui', 'baseline: the UI-library write reaches its site and a legible base takes it');
    assert.equal(after.originalPrompt, undefined,
      'baseline: and this prompt is not a project description, so the seed declined it and nothing else wrote');
    assert.equal(after.mode, 'new-project', 'baseline: onto the base, not over it');
  });

  const tornStaysTorn = (prompt: string, writer: string): void => {
    withAuthedProject({ mode: 'new-project' }, (cwd) => {
      fs.writeFileSync(statePathOf(cwd), torn, 'utf8');
      assert.equal(readJsonResult(statePathOf(cwd)).kind, 'corrupt', 'fixture guard: the base is unparseable');

      const result = runUserPromptSubmit(ctx(cwd, prompt));
      assert.equal(result.kind, 'context', 'the handler still answers — an illegible base never fails a prompt');

      assert.equal(fs.readFileSync(statePathOf(cwd), 'utf8'), torn,
        `${writer} merged onto a base it could not read: the file is no longer the bytes that were there`);
      // The sidecar is the second half of the same fact. `writeState` moves an
      // unparseable file aside BEFORE replacing it, so one appearing here means
      // the write ran — and the user's real state is now somewhere nothing reads.
      assert.equal(fs.existsSync(`${statePathOf(cwd)}.corrupt`), false,
        `${writer} quarantined it: only a writer that MEANS to replace the file does that, which on this path is `
        + 'the wizard\'s finalize and not this one');
    });
  };

  tornStaysTorn(SEED_ONLY, 'seedOriginalPrompt');
  tornStaysTorn(UI_ONLY, 'the UI-library write');
});

test('records a pending Cursor model-choice reply before normal prompt handling', () => {
  withAuthedProject(completeSharedState({ currentRunId: 'run-choice' }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    markModelChoicePrompted(cwd, 'run-choice');

    const r = runUserPromptSubmit(ctxHost(cwd, 'fallback', 'cursor'));
    assert.equal(r.kind, 'context');
    assert.equal(readModelChoice(cwd, 'run-choice'), 'use-fallback');
    if (r.kind === 'context') assert.equal(r.systemMessage, 'traffic-one: model choice recorded');
  });
});

test('an "enable" model-choice reply clears the run\'s exhausted-model ledger (restored model gets retried)', () => {
  withAuthedProject(completeSharedState({ currentRunId: 'run-enable' }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    markModelChoicePrompted(cwd, 'run-enable');
    recordExhaustedModel(cwd, 'run-enable', 'senior-backend', 'gpt-5.6-terra-medium');
    assert.deepEqual(exhaustedModelsForRole(cwd, 'run-enable', 'senior-backend'), ['gpt-5.6-terra-medium']);

    const r = runUserPromptSubmit(ctxHost(cwd, 'enable', 'cursor'));
    assert.equal(r.kind, 'context');
    assert.equal(readModelChoice(cwd, 'run-enable'), 'enable-retry');
    assert.deepEqual(
      exhaustedModelsForRole(cwd, 'run-enable', 'senior-backend'),
      [],
      'the enable reply un-condemns the models the user just restored',
    );
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
      // Prescriptive: force delegation + name the concrete cheapest model (host=claude → pinned Haiku id).
      assert.ok(r.context.includes('Do NOT make the edit yourself'), 'directive forbids inline work in subagents mode');
      assert.ok(r.context.includes('model "claude-haiku-4-5"'), 'names the concrete cheapest model');
    }
  });
});

test('Codex trivial maintenance publishes the complete quick_fix spawn contract', () => {
  withAuthedProject(existingSharedState({ materializedStack: 'minimal|none|other|none' }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'minimal');
    const r = runUserPromptSubmit(ctxHost(cwd, 'change the button copy to Continue', 'codex'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('task_name: "quick_fix"'), 'structured quick-fix identity is explicit');
      assert.ok(r.context.includes('fork_turns: "none"'), 'fresh spawn never inherits full history');
      assert.ok(r.context.includes('model: "gpt-5.6-terra"'), 'spawn uses the exact runtime policy model');
      assert.ok(r.context.includes('never retry with a generic task name'), 'unavailable models do not authorize a generic fallback');
    }
  });
});

test('maintenance runtime-control prompts stay with the parent and do not mint a worker run', () => {
  for (const prompt of [
    'start the dev server',
    'stop the preview server',
    'restart the local server',
    'check if port 5173 is in use',
    'show me the local server logs',
  ]) {
    withAuthedProject(existingSharedState({
      materializedStack: 'minimal|none|other|none',
      currentRunId: 'existing-run',
      spawnIndex: { 'quick-fix': 1 },
    }), (cwd) => {
      writeLocalPrefs({
        openCode: { enabled: true, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
        toolchain: { ...TOOLCHAIN, opencode: { installedVersion: '1.15.13', installedAt: 'now' } },
      });
      writeMaterialized(cwd, 'minimal');
      const r = runUserPromptSubmit(ctx(cwd, prompt));
      assert.equal(r.kind, 'context');
      if (r.kind === 'context') {
        assert.ok(!r.context.includes('MAINTENANCE PHASE'), 'no worker-routing rubric');
        assert.ok(!r.context.includes('opencode_delegate'), 'no OpenCode routing for parent runtime work');
      }
      const persisted = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
      assert.equal(persisted.currentRunId, 'existing-run', 'runtime control preserves currentRunId');
      assert.deepEqual(persisted.spawnIndex, { 'quick-fix': 1 }, 'runtime control preserves role state');
    });
  }
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
      assert.ok(triage.context.includes('for each chosen role'), 'small work is explicitly OpenCode-delegated first for every owning role');
      assert.ok(triage.context.includes('"senior-frontend" and/or "senior-backend"'), 'the direct-role route can cover a bounded page plus data seam');
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

test('a nonterminal current run emits continuation routing and preserves its role state', () => {
  withAuthedProject(completeSharedState({
    currentRunId: 'verify-run',
    spawnIndex: { 'senior-reviewer': 1, 'senior-tester': 1 },
  }), (cwd) => {
    writeLocalPrefs({
      openCode: { enabled: true, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
      toolchain: { ...TOOLCHAIN, opencode: { installedVersion: '1.15.13', installedAt: 'now' } },
    });
    writeMaterialized(cwd, 'default');
    const dd = path.join(cwd, '.traffic-one', 'digests', 'verify-run');
    fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, 'frontend.md'), '# frontend\nTouched: src/App.tsx\n', 'utf8');
    fs.writeFileSync(path.join(dd, 'reviewer.md'), '# reviewer\nverdict: APPROVED\n', 'utf8');
    fs.writeFileSync(path.join(dd, 'tester.md'), '# tester\nverdict: TESTS_FAILING\n', 'utf8');
    const rd = path.join(cwd, '.traffic-one', 'runs', 'verify-run');
    fs.mkdirSync(rd, { recursive: true });
    fs.writeFileSync(path.join(rd, 'tester-session.json'), JSON.stringify({
      version: 1,
      runId: 'verify-run',
      role: 'senior-tester',
      status: 'claimed',
      sessionId: 'tester-session',
      createdAt: new Date().toISOString(),
    }), 'utf8');

    const r = runUserPromptSubmit(ctx(cwd, 'continue and finish the export feature'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.match(r.context, /UNRESOLVED TRAFFIC ONE RUN/);
      assert.ok(r.context.includes('verify-run'), 'directive names the run to continue');
      assert.ok(r.context.includes('existing role-agent continuations'), 'same agents are resumed');
      assert.ok(!r.context.includes('opencode_delegate'), 'unresolved work does not start an OpenCode quick-fix');
      assert.match(r.systemMessage || '', /unresolved run/);
      assert.ok(!(r.systemMessage || '').includes('maintenance'), 'unresolved work is not mislabeled maintenance');
    }
    const persisted = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(persisted.currentRunId, 'verify-run');
    assert.deepEqual(persisted.spawnIndex, { 'senior-reviewer': 1, 'senior-tester': 1 });
    assert.ok(!persisted.lifecycle, 'nonterminal verification remains building');
    assert.equal(fs.existsSync(path.join(rd, 'tester-session.json')), true, 'existing role claim remains intact');
    const ledger = JSON.parse(fs.readFileSync(path.join(rd, 'run.json'), 'utf8'));
    assert.equal(ledger.status, 'active');
    assert.equal(ledger.qaContractVersion, 1, 'resuming a legacy unresolved run activates strict QA');
  });
});

test('runtime control during an unresolved run remains parent-only and leaves the run untouched', () => {
  withAuthedProject(completeSharedState({
    currentRunId: 'verify-run',
    spawnIndex: { 'senior-tester': 1 },
  }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    const dd = path.join(cwd, '.traffic-one', 'digests', 'verify-run');
    fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, 'frontend.md'), '# frontend\nTouched: src/App.tsx\n', 'utf8');
    fs.writeFileSync(path.join(dd, 'tester.md'), '# tester\nverdict: TESTS_FAILING\n', 'utf8');

    const r = runUserPromptSubmit(ctx(cwd, 'restart the dev server'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(!r.context.includes('UNRESOLVED TRAFFIC ONE RUN'), 'runtime operation gets no worker continuation directive');
      assert.ok(!r.context.includes('MAINTENANCE PHASE'), 'runtime operation gets no maintenance worker directive');
    }
    const persisted = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(persisted.currentRunId, 'verify-run');
    assert.deepEqual(persisted.spawnIndex, { 'senior-tester': 1 });
    assert.ok(!persisted.lifecycle, 'unresolved run remains building');
  });
});

test('an explicit one-word resume upgrades a legacy unresolved run to strict QA', () => {
  withAuthedProject(completeSharedState({ currentRunId: 'legacy-resume' }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    const dd = path.join(cwd, '.traffic-one', 'digests', 'legacy-resume');
    fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, 'frontend.md'), '# frontend\nTouched: src/App.tsx\n', 'utf8');
    fs.writeFileSync(path.join(dd, 'reviewer.md'), '# reviewer\nverdict: CHANGES_REQUESTED\n', 'utf8');

    const result = runUserPromptSubmit(ctx(cwd, 'continue'));
    assert.equal(result.kind, 'context');
    if (result.kind === 'context') assert.match(result.context, /UNRESOLVED TRAFFIC ONE RUN/);
    const replay = runUserPromptSubmit(ctx(cwd, 'continue'));
    assert.equal(replay.kind, 'context', 'replaying the prompt remains on the unresolved run');
    const ledger = JSON.parse(fs.readFileSync(
      path.join(cwd, '.traffic-one', 'runs', 'legacy-resume', 'run.json'),
      'utf8',
    ));
    assert.equal(ledger.status, 'active');
    assert.equal(ledger.qaContractVersion, 1);
  });
});

test('an explicit continue authorizes exactly one blocked-run resume transition', () => {
  withAuthedProject(completeSharedState({ currentRunId: 'blocked-resume' }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    assert.ok(transitionRunStatus(cwd, 'blocked-resume', { status: 'active', kind: 'orchestration' }));
    assert.ok(transitionRunStatus(cwd, 'blocked-resume', {
      status: 'blocked',
      outcome: 'test-cycle-cap',
    }));

    const result = runUserPromptSubmit(ctx(cwd, 'continue'));
    assert.equal(result.kind, 'context');
    if (result.kind === 'context') assert.match(result.context, /UNRESOLVED TRAFFIC ONE RUN/);

    const ledger = JSON.parse(fs.readFileSync(
      path.join(cwd, '.traffic-one', 'runs', 'blocked-resume', 'run.json'),
      'utf8',
    ));
    assert.equal(ledger.status, 'active');
    assert.equal(ledger.outcome, undefined);
    assert.equal(ledger.qaContractVersion, 1);
    assert.deepEqual(
      ledger.transitionHistory.map((entry: Record<string, unknown>) => [entry.to, entry.reason]),
      [
        ['active', undefined],
        ['blocked', undefined],
        ['active', 'user-authorized-extra-cycle'],
      ],
      'the blocked transition is preserved and repeated prompts do not duplicate the authorized resume',
    );
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
    const memoryDir = '.traffic' + '-one';
    const qaDir = path.join(cwd, memoryDir, 'reports', 'qa', 'build-run');
    fs.mkdirSync(qaDir, { recursive: true });
    fs.writeFileSync(path.join(qaDir, 'report.json'), JSON.stringify({ ok: true }), 'utf8');
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

test('a runtime command may settle a terminal build but does not replace its run or route a worker', () => {
  withAuthedProject(completeSharedState({ currentRunId: 'build-run' }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    const srcDir = path.join(cwd, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(srcDir, `f${i}.ts`), 'export const x = 1;\n', 'utf8');
    const dd = path.join(cwd, '.traffic-one', 'digests', 'build-run');
    fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, 'reviewer.md'), '# reviewer\nverdict: APPROVED\n', 'utf8');
    fs.writeFileSync(path.join(dd, 'tester.md'), '# tester\nverdict: TESTS_GREEN\n', 'utf8');

    const r = runUserPromptSubmit(ctx(cwd, 'restart the dev server'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.ok(!r.context.includes('MAINTENANCE PHASE'), 'parent runtime work bypasses triage');
    const persisted = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(persisted.lifecycle?.phase, 'maintenance', 'the genuinely terminal prior build still settles');
    assert.equal(persisted.currentRunId, 'build-run', 'no new maintenance run is created');
  });
});

test('settling a ledger-less legacy run preserves legacy QA long enough to rotate the next maintenance request', () => {
  withAuthedProject(completeSharedState({
    currentRunId: 'legacy-build-run',
    spawnIndex: { 'senior-frontend': 1 },
  }), (cwd) => {
    writeLocalPrefs();
    writeMaterialized(cwd, 'default');
    const srcDir = path.join(cwd, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(srcDir, `f${i}.ts`), 'export const x = 1;\n', 'utf8');
    const dd = path.join(cwd, '.traffic-one', 'digests', 'legacy-build-run');
    fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, 'frontend.md'), '# frontend\nTouched: src/App.tsx\n', 'utf8');
    fs.writeFileSync(path.join(dd, 'reviewer.md'), '# reviewer\nverdict: APPROVED\n', 'utf8');
    fs.writeFileSync(path.join(dd, 'tester.md'), '# tester\nverdict: TESTS_GREEN\n', 'utf8');
    const qaDir = path.join(cwd, '.traffic-one', 'reports', 'qa', 'legacy-build-run');
    fs.mkdirSync(qaDir, { recursive: true });
    fs.writeFileSync(path.join(qaDir, 'report.json'), JSON.stringify({ ok: true }), 'utf8');

    const r = runUserPromptSubmit(ctx(cwd, 'add a new page for release notes'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.match(r.context, /MAINTENANCE PHASE/);
    const persisted = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(persisted.lifecycle?.phase, 'maintenance');
    assert.notEqual(persisted.currentRunId, 'legacy-build-run', 'fresh maintenance work rotates beyond the compatible legacy run');
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
