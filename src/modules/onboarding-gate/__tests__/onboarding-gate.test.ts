import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { onboardingGate } from '../handler';
import { recordMainOnboardingSession } from '../../../shared/onboarding-server/onboarding-session';
import { writeServerRecord } from '../../../shared/onboarding-server/registry';
import { onboardingBootstrapCommand, onboardingDeclineCommand, onboardingUseBootstrapCommand, onboardingUseCommand, onboardingWaitCommand } from '../../../shared/onboarding-server/wait-command';
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';
import type { Ctx, HookInput, HostId, ToolClass } from '../../../core/types';
import { initializeToolchainState } from '../../../shared/state/toolchain';
import { writeGlobalCodeGraphProvider } from '../../../shared/state';
import { hostScopedPerformancePrefs } from '../../../test-support/host-prefs';
import { writeSimpleAuth } from '../../../shared/auth';

// These tests exercise the setup-wizard flow itself, which under the shipped
// ask-first default (ASK_USE_PLUGIN_FIRST) only starts after the user's
// recorded yes. Pin the runtime override off so the wizard paths stay directly
// testable; the ask-first question's own test sets the flag to '1' explicitly.
process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

// The dashboard deep link the gate surfaces for the seeded server record (port+token
// in the fragment; default dashboard base since no TRAFFIC_ONE_DASHBOARD_URL is set).
const DASH_URL = 'https://traffic.io/onboarding/agent#p=55222&t=tok';

function ctx(cwd: string, rawName: string, cls: ToolClass, toolInput: Record<string, unknown>): Ctx {
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd, raw: { tool_name: rawName, tool_input: toolInput }, tool: { class: cls, rawName } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function ctxHost(host: HostId, cwd: string, rawName: string, cls: ToolClass, toolInput: Record<string, unknown>): Ctx {
  const raw = { tool_name: rawName, tool_input: toolInput, session_id: `${host}-main` };
  const input: HookInput = { event: 'PreToolUse', host, cwd, raw, tool: { class: cls, rawName } };
  return { input, host, cwd, now: () => 'x' } as unknown as Ctx;
}

function ctxOpenCode(cwd: string, rawName: string, cls: ToolClass, toolInput: Record<string, unknown>): Ctx {
  const input: HookInput = { event: 'PreToolUse', host: 'opencode', cwd, raw: { tool_name: rawName, tool_input: toolInput }, tool: { class: cls, rawName } };
  return { input, host: 'opencode', cwd, now: () => 'x' } as unknown as Ctx;
}

function ctxWindsurf(cwd: string, rawName: string, cls: ToolClass, toolInput: Record<string, unknown>): Ctx {
  const input: HookInput = { event: 'PreToolUse', host: 'windsurf', cwd, raw: { tool_name: rawName, tool_input: toolInput }, tool: { class: cls, rawName } };
  return { input, host: 'windsurf', cwd, now: () => 'x' } as unknown as Ctx;
}

// A subagent thread: its own session_id plus a parent_session_id (the Claude shape;
// hookSessionIdentity flags isSubagent from parent_session_id alone).
function ctxSub(cwd: string, rawName: string, cls: ToolClass, toolInput: Record<string, unknown>): Ctx {
  const raw = { tool_name: rawName, tool_input: toolInput, session_id: 'child-thread', parent_session_id: 'parent-session' };
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd, raw, tool: { class: cls, rawName } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

// A Cursor thread: host=cursor + its conversation session_id; a MAIN thread carries a
// transcript_path, a subagent's own events do NOT (verified from captured Cursor payloads).
function ctxCursor(
  cwd: string,
  rawName: string,
  cls: ToolClass,
  toolInput: Record<string, unknown>,
  sessionId: string,
  transcriptPath?: string,
  workspaceRoot = cwd,
): Ctx {
  const raw: Record<string, unknown> = { tool_name: rawName, tool_input: toolInput, session_id: sessionId, workspace_roots: [workspaceRoot] };
  if (transcriptPath) raw.transcript_path = transcriptPath;
  const input: HookInput = { event: 'PreToolUse', host: 'cursor', cwd, raw, tool: { class: cls, rawName }, workspaceRoot };
  return { input, host: 'cursor', cwd, now: () => 'x' } as unknown as Ctx;
}

function withProject(state: Record<string, unknown> | null, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbgate-'));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = env.TRAFFIC_ONE_STATE_PATH;
  const prevNoSpawn = env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  const prevAuth = env.TRAFFIC_ONE_AUTH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  // Canonical auth and codeGraphProvider are machine-wide (one.json) — isolate it.
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  // Never spawn a real wizard server from a unit test; ensure() hands back a
  // deterministic placeholder URL instead.
  env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  env.TRAFFIC_ONE_AUTH = '1';
  writeSimpleAuth('sk-test');
  if (state) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
  }
  // Seed a live server record so the gate's ensureOnboardingServer() (NO_SPAWN) hands
  // back a real dashboard URL for the deny prose instead of the inert placeholder.
  // pid=process.pid is guaranteed alive → the reuse path computes dashboardUrl.
  for (const host of ['claude', 'codex', 'cursor', 'opencode', 'windsurf'] as const) {
    writeServerRecord(
      dir,
      { pid: process.pid, port: 55222, token: 'tok', url: 'http://127.0.0.1:55222/?t=tok', startedAt: 'x' },
      process.env,
      host,
    );
  }
  try { fn(dir); } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    if (prevState === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = prevState;
    if (prevNoSpawn === undefined) delete env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN; else env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = prevNoSpawn;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    if (prevAuth === undefined) delete env.TRAFFIC_ONE_AUTH; else env.TRAFFIC_ONE_AUTH = prevAuth;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withBlockedCanonicalRuntime(fn: (cwd: string) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbgate-blocked-')));
  const cwd = path.join(base, 'project');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  // A regular file where ~/.traffic-one must be a directory deterministically
  // reproduces a canonical user-state bootstrap failure without chmod/root quirks.
  fs.writeFileSync(path.join(home, '.traffic-one'), 'blocked', 'utf8');
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'new-project' }), 'utf8');

  const env = process.env;
  const saved = {
    home: env.HOME,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: env.TRAFFIC_ONE_STATE_PATH,
    noSpawn: env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN,
    plan: env.TRAFFIC_ONE_USER_PLAN,
  };
  env.HOME = home;
  delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  delete env.TRAFFIC_ONE_STATE_PATH;
  delete env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    fn(cwd);
  } finally {
    if (saved.home === undefined) delete env.HOME; else env.HOME = saved.home;
    if (saved.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved.prefs;
    if (saved.state === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = saved.state;
    if (saved.noSpawn === undefined) delete env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN; else env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = saved.noSpawn;
    if (saved.plan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = saved.plan;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const TOOLCHAIN = Object.fromEntries(Object.keys(initializeToolchainState({})).map((k) => [k, { installedVersion: '1', installedAt: 'now' }]));

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
  // codeGraphProvider is machine-wide (one.json), not a per-project pref.
  writeGlobalCodeGraphProvider('graphify');
}

function existingState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'existing-codebase',
    stack: 'minimal',
    frontend: 'none',
    backend: 'other',
    realtime: 'none',
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-01-01T00:00:00Z',
    materializedStack: 'minimal|none|other|none',
    ...extra,
  };
}

function materializeFixture(cwd: string, stack = 'minimal'): void {
  const t1 = path.join(cwd, '.traffic-one');
  fs.mkdirSync(path.join(t1, 'rules', 'common'), { recursive: true });
  fs.mkdirSync(path.join(t1, 'skills', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(t1, 'rules', 'common', 'auth-gate.md'), 'r', 'utf8');
  fs.writeFileSync(path.join(t1, 'skills', 'project-memory', 'SKILL.md'), 's', 'utf8');
  fs.writeFileSync(path.join(t1, 'manifest.json'), JSON.stringify({ generatedBy: 'traffic-one', stack, rules: ['rules/common/auth-gate.md'], skills: ['project-memory'] }), 'utf8');
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'x\n<!-- GENERATED BY traffic-one: project-local active rules -->\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'see agents', 'utf8');
}

test('ask-first: mutating work is denied with the host-chat question — no wizard, no URL', () => {
  withProject(null, (cwd) => {
    const prevAsk = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
    try {
      const denied = onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'x' }));
      assert.equal(denied.kind, 'deny');
      if (denied.kind === 'deny') {
        assert.match(denied.reason, /Do you want to use the Traffic One plugin/);
        assert.ok(denied.reason.includes("'--use' '--bootstrap-only'"), 'yes path leads with the link-first bootstrap command');
        assert.ok(denied.reason.includes('IN THE BACKGROUND'), 'yes path tells the agent to background the waiter');
        assert.ok(denied.reason.includes('--decline'), 'no path names the --decline command');
        assert.ok(!denied.reason.includes('http://127.0.0.1'), 'NO setup URL before the user says yes');
      }
      // The answer commands themselves flow through the gate while pending.
      const useBootstrapCmd = onboardingUseBootstrapCommand(cwd, 'claude');
      assert.equal(onboardingGate(ctx(cwd, 'Bash', 'shell', { command: useBootstrapCmd })).kind, 'noop');
      const useCmd = onboardingUseCommand(cwd, 'claude');
      assert.equal(onboardingGate(ctx(cwd, 'Bash', 'shell', { command: useCmd })).kind, 'noop');
      const declineCmd = onboardingDeclineCommand(cwd, 'claude');
      assert.equal(onboardingGate(ctx(cwd, 'Bash', 'shell', { command: declineCmd })).kind, 'noop');
    } finally {
      if (prevAsk === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
      else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = prevAsk;
    }
  });
});

test('declined project: the gate stands down entirely and creates nothing', () => {
  withProject(null, (cwd) => {
    recordPluginUseChoice(cwd, false, 'command');
    assert.equal(onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'x' })).kind, 'noop');
    assert.equal(onboardingGate(ctx(cwd, 'Bash', 'shell', { command: 'npx create-next-app@latest app' })).kind, 'noop');
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'no project files for a declined project');
  });
});

test('noop inside the plugin authoring root', () => {
  assert.equal(onboardingGate(ctx(process.cwd(), 'Write', 'file-write', { file_path: 'x.ts', content: 'x' })).kind, 'noop');
});

test('noop when the session cwd is $HOME or the machine state dir — home is never onboarded as a project', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbgate-home-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.traffic-one'), { recursive: true });
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(onboardingGate(ctx(home, 'Write', 'file-write', { file_path: 'x.ts', content: 'x' })).kind, 'noop');
    assert.equal(onboardingGate(ctx(path.join(home, '.traffic-one'), 'Write', 'file-write', { file_path: 'x.ts', content: 'x' })).kind, 'noop');
    // No wizard, no state: nothing may appear under the machine dir.
    assert.equal(fs.existsSync(path.join(home, '.traffic-one', '.one.json')), false);
  } finally {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('every host fails closed terminally when the canonical user-state root is malformed', () => {
  withBlockedCanonicalRuntime((cwd) => {
    const hosts: HostId[] = ['claude', 'codex', 'cursor', 'opencode', 'copilot', 'windsurf', 'kilo'];
    for (const host of hosts) {
      const input = ctxHost(host, cwd, host === 'codex' ? 'exec_command' : 'Write', 'file-write', {
        file_path: 'src/app.ts',
        content: 'export const x = 1;',
      });
      // Repeated failures must remain actionable; a failed launch must not consume
      // the one-time live-URL marker and silently release later calls.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = onboardingGate(input);
        assert.equal(result.kind, 'deny', `${host} attempt ${attempt + 1} must fail closed`);
        if (result.kind !== 'deny') continue;
        assert.ok(!result.reason.includes(onboardingBootstrapCommand(cwd, host)), `${host}: malformed storage must not prescribe bootstrap`);
        assert.ok(!result.reason.includes(onboardingWaitCommand(cwd, host)), `${host}: malformed storage must not enter the waiter loop`);
        assert.match(result.reason, /plugin\/runtime failure/, `${host}: terminal diagnosis`);
        assert.match(result.reason, /doctor|reinstall\/update/, `${host}: recovery route`);
        assert.doesNotMatch(result.reason, /\.traffic-one\/preferences\.json|\.traffic-one\/machine\.json/, `${host}: no project-local fallback`);
        assert.doesNotMatch(result.reason, /127\.0\.0\.1:0/, `${host}: no placeholder URL`);
      }
    }
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'preferences.json')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'machine.json')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'onboarding')), false);
  });
});

test('new project with no Traffic One state: a mutating feature write is denied with the wizard URL', () => {
  withProject(null, (cwd) => {
    const r = onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes(DASH_URL), 'deny reason carries the dashboard setup URL');
      assert.ok(/setup/i.test(r.reason));
      assert.equal(r.promptRequest, undefined); // no per-step popup any more — the wizard owns the questions
    }
  });
});

test('OpenCode setup deny stops after onboarding and asks the user to restart before resuming', () => {
  withProject(null, (cwd) => {
    const r = onboardingGate(ctxOpenCode(cwd, 'write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes(DASH_URL), 'deny reason carries the dashboard setup URL');
      assert.ok(r.reason.includes('immediately run this wait command'), 'agent must run wait without another user prompt');
      assert.ok(r.reason.includes('TRAFFIC_ONE_RESTART_OPENCODE_REQUIRED'), 'restart sentinel is named');
      assert.ok(r.reason.includes('type "continue" or "resume"'), 'resume instruction is user-visible');
      assert.ok(!r.reason.includes('continue the user\'s original request'), 'must not instruct same-process auto-continuation');
      assert.ok(!r.reason.includes('Ctrl+C'), 'no terminal interrupt workaround');
    }
  });
});

test('Windsurf setup deny is compact and never includes another host recipe', () => {
  withProject(null, (cwd) => {
    const url = 'http://127.0.0.1:51444/?t=windsurf';
    const dashboardUrl = 'https://traffic.io/onboarding/agent#p=51444&t=windsurf';
    writeServerRecord(cwd, { pid: process.pid, port: 51444, token: 'windsurf', url, startedAt: 'x' }, process.env, 'windsurf');
    const r = onboardingGate(ctxWindsurf(cwd, 'write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes(dashboardUrl));
      assert.ok(r.reason.includes(`[Open Traffic One setup](${dashboardUrl})`));
      assert.ok(r.reason.includes('TRAFFIC_ONE_SETUP_COMPLETE'));
      for (const foreign of ['Claude Code', 'Cursor:', 'Codex Desktop', '.claude/launch.json', 'preview_start', 'node_repl']) {
        assert.ok(!r.reason.includes(foreign), `Windsurf setup must not include ${foreign}`);
      }
    }
  });
});

test('Windsurf setup allows read-only orientation and gates the first mutation', () => {
  withProject(null, (cwd) => {
    const url = 'http://127.0.0.1:51445/?t=windsurf-read';
    const dashboardUrl = 'https://traffic.io/onboarding/agent#p=51445&t=windsurf-read';
    writeServerRecord(cwd, { pid: process.pid, port: 51445, token: 'windsurf-read', url, startedAt: 'x' }, process.env, 'windsurf');
    assert.equal(
      onboardingGate(ctxWindsurf(cwd, 'Bash', 'shell', { command: 'ls -la' })).kind,
      'noop',
      'Windsurf must not render harmless orientation as a failed command',
    );
    const write = onboardingGate(ctxWindsurf(cwd, 'write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(write.kind, 'deny');
    if (write.kind === 'deny') assert.ok(write.reason.includes(dashboardUrl));
  });
});

test('existing project with Traffic One state but no local prefs: mutating tools are denied with the wizard URL', () => {
  withProject(existingState(), (cwd) => {
    materializeFixture(cwd);
    const r = onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes(DASH_URL), 'deny reason carries the dashboard setup URL');
      assert.equal(r.promptRequest, undefined);
    }
  });
});

test('existing project with missing local prefs: first gated call denies with the recipe, then orientation is allowed', () => {
  withProject(existingState(), (cwd) => {
    // First gated tool of the session — even read-only orientation — denies ONCE
    // with the full wizard recipe (the only PreToolUse channel Codex surfaces).
    const first = onboardingGate(ctx(cwd, 'Bash', 'shell', { command: 'ls -la' }));
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') assert.ok(first.reason.includes(DASH_URL), 'first deny carries the dashboard setup URL');
    // Recipe delivered this session → subsequent read-only orientation flows.
    assert.equal(onboardingGate(ctx(cwd, 'Bash', 'shell', { command: 'ls -la' })).kind, 'noop');
  });
});

test('Codex first read-only tool receives the live URL recipe, then orientation is released', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    const url = 'http://127.0.0.1:55331/?t=codex-live';
    const dashboardUrl = 'https://traffic.io/onboarding/agent#p=55331&t=codex-live';
    writeServerRecord(cwd, { pid: process.pid, port: 55331, token: 'codex-live', url, startedAt: 'x' }, process.env, 'codex');
    const input = ctxHost('codex', cwd, 'exec_command', 'shell', { command: 'pwd' });
    const first = onboardingGate(input);
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') {
      assert.ok(first.reason.includes(dashboardUrl));
      assert.ok(!first.reason.includes('node_repl'));
      assert.ok(first.reason.includes("'--host=codex'"));
    }
    assert.equal(onboardingGate(input).kind, 'noop');
  });
});

test('existing project with complete local prefs: mutating tools proceed normally when materialized', () => {
  withProject(existingState(), (cwd) => {
    writeLocalPrefs();
    materializeFixture(cwd);
    assert.equal(onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' })).kind, 'noop');
  });
});

test('incomplete new project: first gated call denies with the recipe, then orientation (ls) is allowed and mutating writes get the repeat', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    const first = onboardingGate(ctx(cwd, 'Bash', 'shell', { command: 'ls -la' }));
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') assert.ok(first.reason.includes(DASH_URL), 'first deny carries the dashboard setup URL');
    // Recipe delivered → subsequent read-only orientation flows.
    assert.equal(onboardingGate(ctx(cwd, 'Bash', 'shell', { command: 'ls -la' })).kind, 'noop');
    // A mutating write still denies after the one-time recipe (short repeat block, still URL-bearing).
    const write = onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(write.kind, 'deny');
    if (write.kind === 'deny') assert.ok(write.reason.includes(DASH_URL));
  });
});

test('a subagent thread is NEVER sent to the onboarding wizard (parent owns onboarding)', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    // A parent write on this incomplete project denies with the wizard…
    assert.equal(onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' })).kind, 'deny');
    // …but the same write from a SUBAGENT thread is allowed through — a worker can't
    // drive the wizard, so reaching the gate means a stray nested root was resolved.
    assert.equal(onboardingGate(ctxSub(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' })).kind, 'noop');
  });
});

test('writing the canonical state file itself is always allowed', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    const tool = { file_path: '.traffic-one/.one.json', content: JSON.stringify({ mode: 'new-project', stack: 'default' }) };
    assert.equal(onboardingGate(ctx(cwd, 'Write', 'file-write', tool)).kind, 'noop');
  });
});

test('writing the canonical state file is allowed through camelCase host aliases', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    const tool = { filePath: '.traffic-one/.one.json', content: JSON.stringify({ mode: 'new-project', stack: 'default' }) };
    assert.equal(onboardingGate(ctx(cwd, 'Write', 'file-write', tool)).kind, 'noop');
  });
});

test('hand-writing the team modeChangeApproval marker is denied (team-mode guard)', () => {
  withProject({ mode: 'new-project', team: { mode: 'subagents', source: 'prompted' } }, (cwd) => {
    const tool = { file_path: '.traffic-one/.one.json', content: JSON.stringify({ mode: 'new-project', team: { mode: 'subagents', source: 'prompted', modeChangeApproval: { from: 'subagents', to: 'main-agent' } } }) };
    const r = onboardingGate(ctx(cwd, 'Write', 'file-write', tool));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.ok(r.reason.includes('team mode guard'));
  });
});

const completeNewProject = (): Record<string, unknown> => ({
  mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
  mobile: { enabled: false, framework: 'none', source: 'prompted' },
  technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
  projectContext: { source: 'prompted', originalPrompt: 'x', summary: 's', answers: { a: 1 }, collectedAt: '2026-01-01T00:00:00Z' },
  confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z',
  materializedStack: 'default|react-vite|supabase|none',
});

test('a fully materialized, complete new project lets tool use through (run-id announce once, then noop)', () => {
  withProject(completeNewProject(), (cwd) => {
    writeLocalPrefs();
    materializeFixture(cwd, 'default');
    // First post-onboarding call announces the pre-minted build run-id (one-time) — it
    // still ALLOWS the write (context, not deny), and stamps currentRunId so the
    // orchestrator reads it instead of fabricating one with `date`.
    const first = onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'apps/web/src/x.ts', content: 'export const x = 1;' }));
    assert.equal(first.kind, 'context');
    if (first.kind === 'context') assert.match(first.context, /build run-id: \d+/);
    // The announce fired once → subsequent calls fall through to noop.
    assert.equal(onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'apps/web/src/y.ts', content: 'export const y = 1;' })).kind, 'noop');
  });
});

test('monorepo: a write from an onboarded workspace sub-package is NOT blocked (resolves up to the root)', () => {
  withProject(completeNewProject(), (cwd) => {
    writeLocalPrefs();
    materializeFixture(cwd, 'default');
    // The bug trigger: a sub-package accrued a stray SHALLOW state file (just
    // one-uid, no mode) from cwd-scoped materialization while a scaffolder was
    // cd'd into it.
    const appWeb = path.join(cwd, 'apps', 'web');
    fs.mkdirSync(path.join(appWeb, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(appWeb, '.traffic-one', '.one.json'), JSON.stringify({ 'one-uid': 'stray' }), 'utf8');
    // The hook now runs with cwd = the sub-package, targeting a file inside it.
    // Before the fix this resolved apps/web as its own un-onboarded project and
    // denied with a bogus wizard URL; now it resolves up to the onboarded root.
    const r = onboardingGate(ctx(appWeb, 'Write', 'file-write', { file_path: 'src/LandingPage.tsx', content: 'export const x = 1;' }));
    // Resolves up to the onboarded root → allowed (never the bogus per-package wizard
    // deny). The first such call may carry the one-time run-id announce context; the
    // invariant under test is that it is NOT denied.
    assert.notEqual(r.kind, 'deny');
  });
});

test('Cursor: a subagent shell cwd outside workspace_roots is NOT sent to the onboarding wizard', () => {
  withProject(completeNewProject(), (cwd) => {
    writeLocalPrefs();
    materializeFixture(cwd, 'default');
    recordMainOnboardingSession(cwd, 'orchestrator-conv');
    const terminalCwd = path.join(path.dirname(cwd), '.cursor', 'projects', 'Users-u-Projects-app', 'terminals');
    fs.mkdirSync(terminalCwd, { recursive: true });

    const r = onboardingGate(ctxCursor(
      terminalCwd,
      'before-shell-execution',
      'shell',
      { command: 'head -n 12 *.txt' },
      'backend-subagent-conv',
      undefined,
      cwd,
    ));

    assert.notEqual(r.kind, 'deny', 'out-of-workspace Cursor terminal cwd must not trigger a setup wizard');
  });
});

test('Cursor: once the orchestrator is recorded (via subagentStart), a subagent session is NOT sent to the wizard', () => {
  withProject(null, (cwd) => {
    // The subagentStart handler records the orchestrator's session as MAIN (its session_id ==
    // parent_conversation_id, fired in the parent context before the subagent runs).
    recordMainOnboardingSession(cwd, 'orchestrator-conv');
    // The orchestrator's own gate event still gets the wizard.
    const main = onboardingGate(ctxCursor(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'x' }, 'orchestrator-conv'));
    assert.equal(main.kind, 'deny', 'the orchestrator (main) thread gets the wizard');
    // The architect subagent's own event (a DIFFERENT conversation id — regardless of transcript)
    // → suppressed (noop), so it is never trapped on the "wait for setup" command.
    const sub = onboardingGate(ctxCursor(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'x' }, 'architect-subagent-conv', '/x/transcript.jsonl'));
    assert.equal(sub.kind, 'noop', 'a subagent thread is not sent to the wizard (even with a transcript_path)');
  });
});

test('Cursor: before any orchestrator is recorded, the main thread still gets the wizard (no false suppression)', () => {
  withProject(null, (cwd) => {
    const r = onboardingGate(ctxCursor(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'x' }, 'main-conv', '/x/transcript.jsonl'));
    assert.equal(r.kind, 'deny', 'no recorded main yet → nobody is suppressed → wizard shows');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes(DASH_URL), 'completion recipe uses the dashboard setup link');
      assert.ok(!r.reason.includes('`browser_tabs`'), 'external dashboard setup does not control editor tabs');
    }
  });
});

test('Cursor: first onboarding wait command is denied once with a clickable wizard link, then allowed', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    const url = 'http://127.0.0.1:55222/?t=tok';
    writeServerRecord(cwd, { pid: process.pid, port: 55222, token: 'tok', url, startedAt: 'x' }, process.env, 'cursor');
    const command = onboardingWaitCommand(cwd, 'cursor');

    const first = onboardingGate(ctxCursor(cwd, 'before-shell-execution', 'shell', { command }, 'main-conv', '/x/transcript.jsonl'));
    assert.equal(first.kind, 'deny', 'first wait is stopped to surface the link');
    if (first.kind === 'deny') {
      assert.ok(first.reason.includes(`Open Traffic One setup: ${DASH_URL}`), 'deny carries a direct clickable dashboard URL line');
      assert.ok(first.reason.includes(command), 'deny tells the agent to re-run the wait command');
      assert.ok(!first.reason.includes('`browser_tabs`'), 'dashboard setup does not require editor-tab cleanup');
    }

    const second = onboardingGate(ctxCursor(cwd, 'before-shell-execution', 'shell', { command }, 'main-conv', '/x/transcript.jsonl'));
    assert.equal(second.kind, 'noop', 'after the visible link, the wait command is allowed');
  });
});
