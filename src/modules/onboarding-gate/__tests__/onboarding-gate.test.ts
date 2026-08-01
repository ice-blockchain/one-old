import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { onboardingGate } from '../handler';
import { onboardingStopGate } from '../stop';
import { recordMainOnboardingSession } from '../../../shared/onboarding-server/onboarding-session';
import { writeServerRecord } from '../../../shared/onboarding-server/registry';
import { onboardingBootstrapCommand, onboardingDeclineCommand, onboardingUseBootstrapCommand, onboardingUseCommand, onboardingWaitCommand } from '../../../shared/onboarding-server/wait-command';
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';
import type { Ctx, HookInput, HookResult, HostId, ToolClass } from '../../../core/types';
import { initializeToolchainState } from '../../../shared/state/toolchain';
import { writeGlobalCodeGraphProvider } from '../../../shared/state';
import { hostScopedPerformancePrefs } from '../../../test-support/host-prefs';
import { writeSimpleAuth } from '../../../shared/auth';
import { captureCursorModels } from '../../../shared/materialize/cursor-models';
import { modelGateCommand } from '../../../shared/model-gate-command';
import { runModelPolicyPath } from '../../../shared/run-model-policy';
import { doctorCommand } from '../../../shared/doctor-command';
import {  type LocalFallback } from '../../../shared/onboarding-server/wizard-links';
import { noteBrowserArrival } from '../../../shared/onboarding-server/browser-arrival';
import { claudeWaitBackgroundDeniedReason, claudeWaitLinkFirstReason, stopSetupLinkPostedReason, stopSetupLinksShownReason, stopSetupRequiredReason } from '../../../shared/onboarding-server/claude-setup';
import { codexWaitLinkFirstReason } from '../../../shared/onboarding-server/codex-setup';
import { cursorWaitLinkFirstReason } from '../../../shared/onboarding-server/cursor-setup';

// These tests exercise the setup-wizard flow itself, which under the shipped
// ask-first default (ASK_USE_PLUGIN_FIRST) only starts after the user's
// recorded yes. Pin the runtime override off so the wizard paths stay directly
// testable; the ask-first question's own test sets the flag to '1' explicitly.
process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

// The dashboard deep link the gate surfaces for the seeded server record (port+token
// in the fragment; default dashboard base since no TRAFFIC_ONE_DASHBOARD_URL is set).
const DASH_URL = 'https://traffic.io/onboarding/agent#p=55222&t=tok';
const LOCAL_URL = 'http://127.0.0.1:55222/local?t=tok';

// `noop` carries no meta, so narrow before reading the user-facing channel.
const sysMsg = (r: HookResult): string => ('systemMessage' in r ? r.systemMessage ?? '' : '');

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
  for (const host of ['claude', 'codex', 'cursor', 'opencode', 'kilo', 'copilot', 'windsurf'] as const) {
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
        // Foreground, deliberately: backgrounding the waiter sends its output —
        // including the setup link it re-prints — to a task file the user never
        // opens, which is how a turn ended with the user waiting on a link they had
        // never been shown. Must agree with the SKILL block's own wording.
        assert.match(denied.reason, /in the FOREGROUND of this turn, never as a background task/,
          'yes path keeps the waiter in the visible turn');
        assert.ok(!denied.reason.includes('IN THE BACKGROUND'), 'no contradictory background instruction');
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

test('plugin authoring cwd does not stand down for an absolute target in an incomplete real project', () => {
  withProject({
    mode: 'new-project',
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'go',
    mobile: { framework: 'none' },
    onboardingComplete: false,
  }, (project) => {
    const authoring = fs.mkdtempSync(path.join(os.tmpdir(), 't1-onbgate-authoring-target-'));
    try {
      fs.mkdirSync(path.join(authoring, 'src', 'gen'), { recursive: true });
      fs.writeFileSync(path.join(authoring, 'src', 'gen', 'index.ts'), 'export {};\n');
      fs.writeFileSync(path.join(authoring, 'package.json'), JSON.stringify({ name: 'traffic-one' }));
      const result = onboardingGate(ctx(authoring, 'Write', 'file-write', {
        file_path: path.join(project, 'src', 'server.go'),
        content: 'package main\n',
      }));
      assert.equal(result.kind, 'deny');
      const command = `cd "${project}" && touch src/worker.go`;
      const shellResult = onboardingGate(ctx(authoring, 'Bash', 'shell', { command }));
      assert.equal(shellResult.kind, 'deny');
      assert.equal(fs.existsSync(path.join(authoring, '.traffic-one')), false);
    } finally {
      fs.rmSync(authoring, { recursive: true, force: true });
    }
  });
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
      const rawName = host === 'codex' ? 'exec_command' : (host === 'cursor' ? 'before-shell-execution' : 'Bash');
      assert.equal(
        onboardingGate(ctxHost(host, cwd, rawName, 'shell', { command: doctorCommand() })).kind,
        'noop',
        `${host}: the exact read-only doctor must not be trapped by the failing launcher gate`,
      );
      const fakeDoctor = onboardingGate(ctxHost(host, cwd, rawName, 'shell', {
        command: doctorCommand().replace(/doctor\.cjs/, 'doctor-copy.cjs'),
      }));
      if (host === 'windsurf') {
        assert.equal(fakeDoctor.kind, 'noop', 'Windsurf retains its existing terminal-failure read-only orientation carve-out');
      } else {
        assert.equal(fakeDoctor.kind, 'deny', `${host}: a near-collision doctor script remains blocked`);
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

// Kilo shares OpenCode's wrapper and the same prompt-injection sensitivity: the
// full multi-host deny block (code blocks + "do NOT…" overrides) reads as a
// hijack attempt and the model refuses it. Kilo used to fall through to that
// block while prompt-submit/session-start already treated it like OpenCode.
test('Kilo setup deny is minimal: link + wait command, no restart sentinel, no behavioral overrides', () => {
  withProject(null, (cwd) => {
    const r = onboardingGate(ctxHost('kilo', cwd, 'write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes(DASH_URL), 'deny reason carries the dashboard setup URL');
      assert.ok(r.reason.includes('immediately run this wait command'), 'agent must run wait without another user prompt');
      assert.ok(!r.reason.includes('TRAFFIC_ONE_RESTART_OPENCODE_REQUIRED'),
        'the waiter emits the restart sentinel only on OpenCode — promising it on Kilo is false prose');
      assert.ok(!r.reason.includes('do NOT'), 'no behavioral overrides that trip the injection filter');
      assert.ok(!r.reason.includes('```'), 'no code blocks that trip the injection filter');
      assert.ok(!r.reason.includes('CONTINUE AUTOMATICALLY'), 'the full multi-host walkthrough must not leak to Kilo');
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

// Cursor collapses a blocked command into "ran N commands", so this deny is
// agent-visible but NOT user-visible. Observed live (cursor-17c): the agent got the
// block, never reposted the URL, and told the user to "use the setup link from the
// previous message" — a message that never contained one.
test('Cursor first wait deny ORDERS the agent to post the setup link in chat', () => {
  withProject(null, (cwd) => {
    const url = 'http://127.0.0.1:51500/?t=curwait';
    const dashboardUrl = 'https://traffic.io/onboarding/agent#p=51500&t=curwait';
    const localUrl = 'http://127.0.0.1:51500/local?t=curwait';
    writeServerRecord(cwd, { pid: process.pid, port: 51500, token: 'curwait', url, startedAt: 'x' }, process.env, 'cursor');
    const wait = onboardingWaitCommand(cwd, 'cursor');
    const r = onboardingGate(ctxCursor(cwd, 'before-shell-execution', 'shell', { command: wait }, 'cursor-main'));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes(dashboardUrl), 'the hosted link must be present');
      assert.ok(r.reason.includes(localUrl),
        'with no probe verdict yet the local fallback is included — the safe default');
      assert.match(r.reason, /NEXT CHAT MESSAGE/,
        'the agent must be told to repost the link where the user can actually see it');
      assert.match(r.reason, /NOT visible to the user/,
        'the deny must name its own invisibility, or the agent assumes the link was shown');
      assert.ok(r.reason.includes('TRAFFIC_ONE_SETUP_COMPLETE'));
    }
  });
});

// Suppression must require evidence the user actually RECEIVED the link, never
// evidence that some surface produced text containing it. The old marker was
// stamped by the bootstrap's collapsed stdout and by agent-facing deny reasons, so
// one invisible producer silenced every visible one (2cu, 5cu).
test('Cursor wait deny is suppressed only once the server sees the browser arrive', () => {
  withProject(null, (cwd) => {
    const url = 'http://127.0.0.1:51500/?t=curwait';
    const dashboardUrl = 'https://traffic.io/onboarding/agent#p=51500&t=curwait';
    writeServerRecord(cwd, { pid: process.pid, port: 51500, token: 'curwait', url, startedAt: 'x' }, process.env, 'cursor');
    const wait = onboardingWaitCommand(cwd, 'cursor');

    // Producing the link somewhere is NOT delivery — the deny must still fire.
    const before = onboardingGate(ctxCursor(cwd, 'before-shell-execution', 'shell', { command: wait }, 'cursor-main'));
    assert.equal(before.kind, 'deny', 'without an observed browser the link keeps being offered');

    // The wizard actually loaded in a browser.
    noteBrowserArrival(cwd, 'curwait', process.env, 'cursor');
    const after = onboardingGate(ctxCursor(cwd, 'before-shell-execution', 'shell', { command: wait }, 'cursor-second'));
    assert.equal(after.kind, 'noop', 'the wait proceeds instead of demanding a post over an open wizard');
  });
});

test('a shell command that opens the setup URL in a browser is denied during onboarding', () => {
  withProject(null, (cwd) => {
    const url = 'http://127.0.0.1:51500/?t=curwait';
    writeServerRecord(cwd, { pid: process.pid, port: 51500, token: 'curwait', url, startedAt: 'x' }, process.env, 'cursor');
    for (const command of [
      "open 'https://traffic.io/onboarding/agent#p=51500&t=curwait'",
      'xdg-open https://traffic.io/onboarding/agent',
      'open http://127.0.0.1:51500/local?t=curwait',
    ]) {
      const r = onboardingGate(ctxCursor(cwd, 'before-shell-execution', 'shell', { command }, 'cursor-main'));
      assert.equal(r.kind, 'deny', `${command} must not auto-open the wizard`);
      if (r.kind === 'deny') assert.match(r.reason, /does not open the setup link for the user/);
    }
    // An ordinary orientation command is not treated as a browser open. (Cursor
    // still denies the first gated tool with the setup recipe — that is the
    // onboarding gate doing its normal job, not this check firing.)
    const ls = onboardingGate(ctxCursor(cwd, 'before-shell-execution', 'shell', { command: 'ls -la' }, 'cursor-main'));
    if (ls.kind === 'deny') {
      assert.doesNotMatch(ls.reason, /does not open the setup link for the user/);
    }
  });
});

// Claude Code collapses hook output and blocked commands the same way Cursor
// collapses "ran N commands" — observed live on 1.0.43: ask-first yes, bootstrap
// + wait ran, the wait was retried as a background task, and the user never saw
// a link. The first wait deny orders the visible repost; the retry proceeds.
test('Claude first wait deny ORDERS the agent to post the setup link in chat, then the retry proceeds', () => {
  withProject(null, (cwd) => {
    const wait = onboardingWaitCommand(cwd, 'claude');
    const first = onboardingGate(ctxHost('claude', cwd, 'Bash', 'shell', { command: wait }));
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') {
      assert.ok(first.reason.includes(DASH_URL), 'the hosted link must be present');
      assert.match(first.reason, /NEXT CHAT MESSAGE/,
        'the agent must be told to repost the link where the user can actually see it');
      assert.match(first.reason, /NOT visible to the user/,
        'the deny must name its own invisibility, or the agent assumes the link was shown');
      assert.match(first.reason, /run_in_background: false/,
        'the foreground requirement is spelled out where the agent decides how to re-run');
      assert.ok(first.reason.includes('TRAFFIC_ONE_SETUP_COMPLETE'));
    }
    const second = onboardingGate(ctxHost('claude', cwd, 'Bash', 'shell', { command: wait }));
    assert.notEqual(second.kind, 'deny', 'the allowed retry proceeds into the blocking wait');
  });
});

test('Claude wait deny is suppressed only once the server sees the browser arrive', () => {
  withProject(null, (cwd) => {
    const wait = onboardingWaitCommand(cwd, 'claude');
    noteBrowserArrival(cwd, 'tok', process.env, 'claude');
    const r = onboardingGate(ctxHost('claude', cwd, 'Bash', 'shell', { command: wait }));
    assert.notEqual(r.kind, 'deny', 'the wait proceeds instead of demanding a post over an open wizard');
  });
});

test('Claude: a backgrounded onboarding runner is denied EVERY time; foreground never hits that deny', () => {
  withProject(null, (cwd) => {
    const wait = onboardingWaitCommand(cwd, 'claude');
    for (let attempt = 1; attempt <= 2; attempt++) {
      const r = onboardingGate(ctxHost('claude', cwd, 'Bash', 'shell', { command: wait, run_in_background: true }));
      assert.equal(r.kind, 'deny', `backgrounded attempt ${attempt} is denied — no once/session pass`);
      if (r.kind === 'deny') {
        assert.match(r.reason, /requested with run_in_background: true/);
        assert.match(r.reason, /run_in_background: false/);
        assert.ok(r.reason.includes(DASH_URL), 'the live link rides the deny');
        assert.ok(r.reason.includes(wait), 'the SAME command is prescribed for the foreground re-run');
      }
    }
    // A backgrounded ask-first bootstrap is caught by the same deny.
    const bootstrap = onboardingUseBootstrapCommand(cwd, 'claude');
    const b = onboardingGate(ctxHost('claude', cwd, 'Bash', 'shell', { command: bootstrap, run_in_background: true }));
    assert.equal(b.kind, 'deny', 'a backgrounded --use --bootstrap-only buries the printed link too');
    // Foreground may still get the link-first deny, but never the background one.
    const fg = onboardingGate(ctxHost('claude', cwd, 'Bash', 'shell', { command: wait, run_in_background: false }));
    if (fg.kind === 'deny') {
      assert.doesNotMatch(fg.reason, /requested with run_in_background: true/,
        'a foreground run must never be blamed for backgrounding');
    }
  });
});

test('Claude: ask-first pending still denies a backgrounded runner but releases the foreground consent path', () => {
  const prev = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
  try {
    withProject(null, (cwd) => {
      const bootstrap = onboardingUseBootstrapCommand(cwd, 'claude');
      const bg = onboardingGate(ctxHost('claude', cwd, 'Bash', 'shell', { command: bootstrap, run_in_background: true }));
      assert.equal(bg.kind, 'deny', 'the background deny precedes the ask-first release');
      const fg = onboardingGate(ctxHost('claude', cwd, 'Bash', 'shell', { command: bootstrap }));
      assert.equal(fg.kind, 'noop', 'the foreground consent command stays released while ask-first is pending');
    });
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = prev;
  }
});

test('the Claude wait-link TS fallback stays verbatim with its skill block', () => {
  const block = fs.readFileSync(
    path.join(__dirname, '..', 'skill', 'SKILL.md'), 'utf8',
  ).split('<!-- T1BLOCK:BEGIN claude-wait-link-first -->')[1]?.split('<!-- T1BLOCK:END')[0]?.trim() || '';
  assert.ok(block.length > 0, 'the skill block must exist');
  const rendered = block
    .replace(/\{\{URL\}\}/g, 'U')
    .replace(/\{\{LOCAL_FALLBACK\}\}/g, 'L')
    .replace(/\{\{WAIT_CMD\}\}/g, 'W');
  assert.equal(claudeWaitLinkFirstReason('U', 'L' as LocalFallback, 'W'), rendered,
    'a missing SKILL.md must never soften this gate — keep the TS fallback byte-identical');
});

test('the Claude background-deny TS fallback stays verbatim with its skill block', () => {
  const block = fs.readFileSync(
    path.join(__dirname, '..', 'skill', 'SKILL.md'), 'utf8',
  ).split('<!-- T1BLOCK:BEGIN claude-wait-background-denied -->')[1]?.split('<!-- T1BLOCK:END')[0]?.trim() || '';
  assert.ok(block.length > 0, 'the skill block must exist');
  const rendered = block
    .replace(/\{\{URL_LINE\}\}/g, 'U')
    .replace(/\{\{WAIT_CMD\}\}/g, 'W');
  assert.equal(claudeWaitBackgroundDeniedReason('U', 'W'), rendered,
    'a missing SKILL.md must never soften this gate — keep the TS fallback byte-identical');
});

// Copilot renders systemMessage on both wire surfaces including a deny, so the
// wait command rides the nudge and the mutating denies carry the banner — one
// TTL cadence for both.
test('Copilot wait command carries the banner in systemMessage; TTL and browser arrival suppress it', () => {
  withProject(null, (cwd) => {
    const wait = onboardingWaitCommand(cwd, 'copilot');
    const first = onboardingGate(ctxHost('copilot', cwd, 'bash', 'shell', { command: wait }));
    assert.notEqual(first.kind, 'deny', 'the copilot waiter is never blocked');
    assert.ok(sysMsg(first).includes(DASH_URL), 'the user gets the link at the moment the agent blocks');
    const again = onboardingGate(ctxHost('copilot', cwd, 'bash', 'shell', { command: wait }));
    assert.equal(sysMsg(again), '', 'the TTL keeps one banner per cadence');
  });
  withProject(null, (cwd) => {
    noteBrowserArrival(cwd, 'tok', process.env, 'copilot');
    const wait = onboardingWaitCommand(cwd, 'copilot');
    const r = onboardingGate(ctxHost('copilot', cwd, 'bash', 'shell', { command: wait }));
    assert.equal(sysMsg(r), '', 'no re-offer over an open wizard');
  });
});

test('Copilot mutating deny carries the banner once per TTL', () => {
  withProject(null, (cwd) => {
    const first = onboardingGate(ctxHost('copilot', cwd, 'write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(first.kind, 'deny');
    assert.ok(sysMsg(first).includes(DASH_URL), 'the deny is the guaranteed user-visible moment on Copilot');
    const second = onboardingGate(ctxHost('copilot', cwd, 'write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(second.kind, 'deny', 'the repeat deny still blocks');
    assert.equal(sysMsg(second), '', 'the banner respects the shared TTL cadence');
  });
});

test('Windsurf wait command carries the banner — Cascade renders hook stdout under show_output', () => {
  withProject(null, (cwd) => {
    const wait = onboardingWaitCommand(cwd, 'windsurf');
    const r = onboardingGate(ctxWindsurf(cwd, 'run_command', 'shell', { command: wait }));
    assert.notEqual(r.kind, 'deny', 'the windsurf waiter is never blocked');
    assert.ok(sysMsg(r).includes(DASH_URL), 'the banner reaches Cascade stdout via systemMessage');
  });
});

// On Codex the deny reason is the ONLY channel that reaches the model, so the
// first wait command carries a self-contained link-first deny with a marker
// independent of the orientation walkthrough's.
test('Codex first wait command is denied once with the clickable link, then the retry proceeds', () => {
  withProject(null, (cwd) => {
    const wait = onboardingWaitCommand(cwd, 'codex');
    const first = onboardingGate(ctxHost('codex', cwd, 'exec_command', 'shell', { command: wait }));
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') {
      assert.ok(first.reason.includes(DASH_URL), 'the hosted link must be present');
      assert.match(first.reason, /NEXT MESSAGE/, 'the repost order is explicit');
      assert.ok(first.reason.includes(wait), 'the exact wait command rides the deny');
      assert.ok(first.reason.includes('TRAFFIC_ONE_SETUP_COMPLETE'));
    }
    const second = onboardingGate(ctxHost('codex', cwd, 'exec_command', 'shell', { command: wait }));
    assert.notEqual(second.kind, 'deny', 'the allowed retry proceeds into the blocking wait');
  });
});

test('Codex wait deny is independent of the orientation walkthrough marker', () => {
  withProject(null, (cwd) => {
    // Burn the walkthrough marker on an orientation call first (its deny carries
    // the recipe but the agent may never post the link).
    const orientation = onboardingGate(ctxHost('codex', cwd, 'exec_command', 'shell', { command: 'pwd' }));
    assert.equal(orientation.kind, 'deny', 'codex orientation gets the full walkthrough deny');
    const wait = onboardingWaitCommand(cwd, 'codex');
    const r = onboardingGate(ctxHost('codex', cwd, 'exec_command', 'shell', { command: wait }));
    assert.equal(r.kind, 'deny', 'the wait link-first deny still fires on its own marker');
    if (r.kind === 'deny') assert.match(r.reason, /only channel that reaches you/);
  });
});

test('Codex wait deny is suppressed only once the server sees the browser arrive', () => {
  withProject(null, (cwd) => {
    noteBrowserArrival(cwd, 'tok', process.env, 'codex');
    const wait = onboardingWaitCommand(cwd, 'codex');
    const r = onboardingGate(ctxHost('codex', cwd, 'exec_command', 'shell', { command: wait }));
    assert.notEqual(r.kind, 'deny', 'the wait proceeds instead of demanding a post over an open wizard');
  });
});

test('the Codex wait-link TS fallback stays verbatim with its skill block', () => {
  const block = fs.readFileSync(
    path.join(__dirname, '..', 'skill', 'SKILL.md'), 'utf8',
  ).split('<!-- T1BLOCK:BEGIN codex-wait-link-first -->')[1]?.split('<!-- T1BLOCK:END')[0]?.trim() || '';
  assert.ok(block.length > 0, 'the skill block must exist');
  const rendered = block
    .replace(/\{\{URL\}\}/g, 'U')
    .replace(/\{\{LOCAL_FALLBACK\}\}/g, 'L')
    .replace(/\{\{WAIT_CMD\}\}/g, 'W');
  assert.equal(codexWaitLinkFirstReason('U', 'L' as LocalFallback, 'W'), rendered,
    'a missing SKILL.md must never soften this gate — keep the TS fallback byte-identical');
});

test('the Cursor wait-link TS fallback stays verbatim with its skill block', () => {
  const block = fs.readFileSync(
    path.join(__dirname, '..', 'skill', 'SKILL.md'), 'utf8',
  ).split('<!-- T1BLOCK:BEGIN cursor-wait-link-first -->')[1]?.split('<!-- T1BLOCK:END')[0]?.trim() || '';
  assert.ok(block.length > 0, 'the skill block must exist');
  const rendered = block
    .replace(/\{\{URL\}\}/g, 'U')
    .replace(/\{\{LOCAL_FALLBACK\}\}/g, 'L')
    .replace(/\{\{WAIT_CMD\}\}/g, 'W');
  assert.equal(cursorWaitLinkFirstReason('U', 'L' as LocalFallback, 'W'), rendered,
    'a missing SKILL.md must never soften this gate — keep the TS fallback byte-identical');
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

test('existing project with missing local prefs: claude orientation flows; the first mutating call denies with the recipe', () => {
  withProject(existingState(), (cwd) => {
    // Claude renders a denied read as a failed tool card and its prompt-hook
    // context is reliable, so read-only orientation flows during setup and the
    // one-time full recipe lands on the first mutating call instead. The release
    // now RIDES the setup link in the user-facing systemMessage: a session that only
    // reads used to produce no visible surface at all, leaving the link in a
    // collapsed tool result the user never saw.
    const orientation = onboardingGate(ctx(cwd, 'Bash', 'shell', { command: 'ls -la' }));
    assert.notEqual(orientation.kind, 'deny', 'orientation is never blocked');
    assert.match(sysMsg(orientation), /setup required/, 'the user sees the link');
    assert.ok(sysMsg(orientation).includes(DASH_URL));
    if (orientation.kind === 'context') {
      assert.equal(orientation.context, '', 'empty context → zero prompt tokens on Claude');
    }
    const first = onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') assert.ok(first.reason.includes(DASH_URL), 'first deny carries the dashboard setup URL');
    // Recipe delivered this session → read-only orientation still flows, and the
    // nudge is rate-limited so a read burst yields one line, not one per call.
    const again = onboardingGate(ctx(cwd, 'Bash', 'shell', { command: 'ls -la' }));
    assert.notEqual(again.kind, 'deny');
    assert.equal(sysMsg(again), '', 'within the TTL the nudge stays quiet');
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
    const first = onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(first.kind, 'context', 'the first parent action publishes the immutable run/policy context without blocking');
    assert.equal(onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' })).kind, 'noop');
  });
});

test('incomplete new project: claude orientation (ls) flows, the first write gets the recipe, later writes get the repeat', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    // Read-only orientation flows on claude even before any deny was delivered —
    // and carries the setup link in the user-facing systemMessage, so a read-only
    // opening turn still shows the user something clickable.
    const orientation = onboardingGate(ctx(cwd, 'Bash', 'shell', { command: 'ls -la' }));
    assert.notEqual(orientation.kind, 'deny', 'orientation is never blocked');
    assert.ok(sysMsg(orientation).includes(DASH_URL), 'the release carries the link');
    // fd/discard redirects on a compound orientation command are not writes (B6):
    // this exact shape was denied as "setup still pending" in tests/claude/3.
    assert.notEqual(onboardingGate(ctx(cwd, 'Bash', 'shell', {
      command: `ls -la ${cwd} 2>/dev/null; echo "---"; ls -la ${cwd}/.traffic-one 2>/dev/null | head -40`,
    })).kind, 'deny');
    const first = onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') assert.ok(first.reason.includes(DASH_URL), 'first deny carries the dashboard setup URL');
    // A mutating write still denies after the one-time recipe (short repeat block, still URL-bearing).
    const write = onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(write.kind, 'deny');
    if (write.kind === 'deny') assert.ok(write.reason.includes(DASH_URL));
  });
});

// A session that only READS used to produce no user-visible surface at all while
// setup was pending: the link lived in a collapsed tool result and a background task
// output file, so the user had nothing to click and setup could never complete.
// The waiter is often the LAST tool call of the turn — the agent runs it and blocks
// for minutes, frequently as a background task whose banner lands in a file the user
// never opens. Observed live: "Ran 2 commands → Waiting for setup completion", four
// minutes, no link anywhere visible. After this call there are no more PreToolUse
// events, so it is the final chance to put the link in front of the user.
test('claude: the wait command carries the link on every layer — link-first deny, then the nudge on the allowed retry', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    const wait = onboardingWaitCommand(cwd, 'claude');
    // First attempt: the link-first deny orders the visible repost (the nudge
    // alone proved insufficient — hook output renders collapsed on Claude).
    const first = onboardingGate(ctx(cwd, 'Bash', 'shell', { command: wait }));
    assert.equal(first.kind, 'deny');
    if (first.kind === 'deny') assert.ok(first.reason.includes(DASH_URL));
    // The retry proceeds into the blocking wait, and the user still gets the
    // link at the moment the agent blocks — nothing fires after it.
    const retry = onboardingGate(ctx(cwd, 'Bash', 'shell', { command: wait }));
    assert.notEqual(retry.kind, 'deny', 'the retry must never be blocked');
    assert.ok(sysMsg(retry).includes(DASH_URL), 'the user gets the link at the moment the agent blocks');
  });
});

test('claude: read-only orientation stops nudging once the browser demonstrably arrives', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    const before = onboardingGate(ctx(cwd, 'Bash', 'shell', { command: 'ls -la' }));
    assert.ok(sysMsg(before).includes(DASH_URL), 'the link is offered while setup is pending');

    // The wizard actually loaded in the user's browser → re-offering would read as
    // "start over" mid-setup, so the nudge stands down.
    noteBrowserArrival(cwd, 'tok', process.env, 'claude');
    const after = onboardingGate(ctx(cwd, 'Read', 'file-read', { file_path: 'src/app.ts' }));
    assert.equal(after.kind, 'noop', 'no surface once the user has it open');
  });
});

test('a wizard record with no usable URL never nudges (no placeholder links)', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    // Port 0 / tokenless → agentOnboardingUrls yields an empty dashboard URL.
    writeServerRecord(cwd, { pid: process.pid, port: 0, token: '', url: 'http://127.0.0.1:0/', startedAt: 'x' }, process.env, 'claude');
    const r = onboardingGate(ctx(cwd, 'Bash', 'shell', { command: 'ls -la' }));
    assert.equal(sysMsg(r), '', 'never emit a placeholder URL');
  });
});

test('claude: the link keeps being offered until the server sees the wizard open', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    // Producing the links on some other surface is NOT evidence the user saw them:
    // the bootstrap's stdout is collapsed on several hosts and deny reasons are
    // agent-facing. Every deny must therefore still carry the URL.
    const rawA = { tool_name: 'Write', tool_input: { file_path: 'src/a.ts', content: 'x' }, session_id: 'claude-main' };
    const inputA: HookInput = { event: 'PreToolUse', host: 'claude', cwd, raw: rawA, tool: { class: 'file-write', rawName: 'Write' } };
    const a = onboardingGate({ input: inputA, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx);
    assert.equal(a.kind, 'deny');
    if (a.kind === 'deny') assert.ok(a.reason.includes(DASH_URL), 'first deny carries the clickable URL');

    // The wizard actually loaded in the user's browser.
    noteBrowserArrival(cwd, 'tok', process.env, 'claude');
    const rawB = { tool_name: 'Write', tool_input: { file_path: 'src/b.ts', content: 'x' }, session_id: 'claude-main' };
    const inputB: HookInput = { event: 'PreToolUse', host: 'claude', cwd, raw: rawB, tool: { class: 'file-write', rawName: 'Write' } };
    const b = onboardingGate({ input: inputB, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx);
    assert.equal(b.kind, 'deny');
    if (b.kind === 'deny') {
      assert.ok(!b.reason.includes(DASH_URL), 'do not re-print a link over a wizard the user has open');
      assert.ok(/open in their browser/i.test(b.reason), 'the claim is backed by an observed arrival');
      assert.ok(b.reason.includes("'--host=claude'"), 'still prescribes the wait command');
    }
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

const cursorCaptureCommand = (cwd: string): string => [
  modelGateCommand(cwd, 'cursor'),
  "'--capture-models'",
  "'claude-fable-5-thinking-high'",
  "'gpt-5.6-terra-medium'",
  "'composer-2.5-fast'",
].join(' ');

test('Cursor: missing model capture admits only the exact active-project recovery command', () => {
  withProject(completeNewProject(), (cwd) => {
    writeLocalPrefs();
    materializeFixture(cwd, 'default');
    const ordinary = onboardingGate(ctxCursor(
      cwd,
      'before-shell-execution',
      'shell',
      { command: 'pwd' },
      'cursor-parent',
      '/x/transcript.jsonl',
    ));
    assert.equal(ordinary.kind, 'deny');
    if (ordinary.kind === 'deny') assert.match(ordinary.reason, /Cursor models required/);

    const exact = onboardingGate(ctxCursor(
      cwd,
      'before-shell-execution',
      'shell',
      { command: cursorCaptureCommand(cwd) },
      'cursor-parent',
      '/x/transcript.jsonl',
    ));
    assert.equal(exact.kind, 'noop', 'the prescribed capture must reach the runner instead of self-deadlocking');

    const falseCommands = [
      cursorCaptureCommand(path.join(path.dirname(cwd), 'sibling')),
      cursorCaptureCommand(cwd).replace("'--host=cursor'", "'--host=claude'"),
      cursorCaptureCommand(cwd).replace(/model-gate\.cjs/, 'evil-model-gate.cjs'),
      `${cursorCaptureCommand(cwd)} && touch /tmp/t1-capture-bypass`,
      `${cursorCaptureCommand(cwd)} > /tmp/t1-capture-output`,
    ];
    for (const command of falseCommands) {
      const result = onboardingGate(ctxCursor(
        cwd,
        'before-shell-execution',
        'shell',
        { command },
        'cursor-parent',
        '/x/transcript.jsonl',
      ));
      assert.equal(result.kind, 'deny', `must not exempt: ${command}`);
    }
  });
});

test('Cursor: a fresh but partial capture can be replaced before policy publication', () => {
  withProject(completeNewProject(), (cwd) => {
    writeLocalPrefs();
    materializeFixture(cwd, 'default');
    assert.equal(captureCursorModels(cwd, ['claude-fable-5-thinking-high'], 'pro'), true);

    const ordinary = onboardingGate(ctxCursor(
      cwd,
      'before-shell-execution',
      'shell',
      { command: 'pwd' },
      'cursor-parent-partial',
      '/x/transcript.jsonl',
    ));
    assert.equal(ordinary.kind, 'deny');
    if (ordinary.kind === 'deny') {
      assert.match(ordinary.reason, /Cursor models required/);
      assert.match(ordinary.reason, /highest|balanced/);
    }

    assert.equal(onboardingGate(ctxCursor(
      cwd,
      'before-shell-execution',
      'shell',
      { command: cursorCaptureCommand(cwd) },
      'cursor-parent-partial',
      '/x/transcript.jsonl',
    )).kind, 'noop');
  });
});

test('Cursor: capture cannot repair or replace a corrupt create-once run policy', () => {
  withProject(completeNewProject(), (cwd) => {
    writeLocalPrefs();
    materializeFixture(cwd, 'default');
    const first = onboardingGate(ctxCursor(
      cwd,
      'before-shell-execution',
      'shell',
      { command: 'pwd' },
      'cursor-parent-corrupt',
      '/x/transcript.jsonl',
    ));
    assert.equal(first.kind, 'deny');
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8')) as Record<string, unknown>;
    const runId = String(state.currentRunId || '');
    assert.ok(runId);
    const policyPath = runModelPolicyPath(cwd, runId);
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, '{}\n', 'utf8');

    const capture = onboardingGate(ctxCursor(
      cwd,
      'before-shell-execution',
      'shell',
      { command: cursorCaptureCommand(cwd) },
      'cursor-parent-corrupt',
      '/x/transcript.jsonl',
    ));
    assert.equal(capture.kind, 'deny');
    if (capture.kind === 'deny') assert.match(capture.reason, /model policy unavailable/);
  });
});

test('Cursor: a saved model policy with an unavailable bootstrap reports repair, not repeated onboarding', () => {
  withProject(completeNewProject(), (cwd) => {
    writeLocalPrefs();
    materializeFixture(cwd, 'default');
    fs.rmSync(path.join(cwd, 'CLAUDE.md'));
    fs.symlinkSync('AGENTS.md', path.join(cwd, 'CLAUDE.md'));
    assert.equal(captureCursorModels(cwd, [
      'claude-fable-5-thinking-high',
      'gpt-5.6-terra-medium',
      'composer-2.5-fast',
    ], 'pro'), true);

    const first = onboardingGate(ctxCursor(
      cwd,
      'before-shell-execution',
      'shell',
      { command: 'pwd' },
      'cursor-parent-bootstrap',
      '/x/transcript.jsonl',
    ));
    assert.notEqual(first.kind, 'deny');
    const state = JSON.parse(
      fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'),
    ) as { currentRunId?: string };
    assert.ok(state.currentRunId);
    const runDir = path.join(cwd, '.traffic-one', 'runs', state.currentRunId!);
    const baselinePath = path.join(runDir, 'baseline-v1.json');
    assert.equal(fs.existsSync(baselinePath), true);

    fs.rmSync(path.join(runDir, 'capability-v1.json'));
    fs.rmSync(baselinePath);
    fs.writeFileSync(baselinePath, '{}\n', 'utf8');

    const blocked = onboardingGate(ctxCursor(
      cwd,
      'before-shell-execution',
      'shell',
      { command: 'pwd' },
      'cursor-parent-bootstrap',
      '/x/transcript.jsonl',
    ));
    assert.equal(blocked.kind, 'deny');
    if (blocked.kind === 'deny') {
      assert.match(blocked.reason, /run bootstrap unavailable/);
      assert.match(blocked.reason, /Performance and immutable model policy are already saved/);
      assert.match(blocked.reason, /Do not redo onboarding/);
      assert.doesNotMatch(blocked.reason, /Reopen Performance/);
    }
  });
});

test('non-Cursor hosts freeze policy without Cursor availableModels', () => {
  const hosts: HostId[] = ['claude', 'codex', 'opencode', 'copilot', 'windsurf', 'kilo'];
  for (const host of hosts) {
    withProject(completeNewProject(), (cwd) => {
      writeLocalPrefs();
      materializeFixture(cwd, 'default');
      const rawName = host === 'codex' ? 'exec_command' : 'Bash';
      const result = onboardingGate(ctxHost(host, cwd, rawName, 'shell', { command: 'pwd' }));
      assert.notEqual(result.kind, 'deny', `${host} must not depend on Cursor-only model capture`);
    });
  }
});

test('the Cursor capture recovery is never exempted on another host', () => {
  const hosts: HostId[] = ['claude', 'codex', 'opencode', 'copilot', 'windsurf', 'kilo'];
  for (const host of hosts) {
    withProject({ ...completeNewProject(), currentRunId: `run-${host}` }, (cwd) => {
      writeLocalPrefs();
      materializeFixture(cwd, 'default');
      const policyPath = runModelPolicyPath(cwd, `run-${host}`);
      fs.mkdirSync(path.dirname(policyPath), { recursive: true });
      fs.writeFileSync(policyPath, '{}\n', 'utf8');
      const rawName = host === 'codex' ? 'exec_command' : 'Bash';
      const result = onboardingGate(ctxHost(host, cwd, rawName, 'shell', {
        command: cursorCaptureCommand(cwd),
      }));
      assert.equal(result.kind, 'deny', `${host} must not admit a Cursor-only recovery command`);
      if (result.kind === 'deny') assert.match(result.reason, /model policy unavailable/);
    });
  }
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

// ── The Stop backstop: a turn must not END with setup pending, a live wizard,
// and no delivered link. Every in-turn surface is agent-facing or collapsed on
// Claude/Codex (observed live on 1.0.43) — Stop is the last enforcement point. ──

function ctxStop(host: HostId, cwd: string, rawExtra: Record<string, unknown> = {}): Ctx {
  const raw = { session_id: `${host}-stop-main`, ...rawExtra };
  const input: HookInput = { event: 'Stop', host, cwd, raw };
  return { input, host, cwd, now: () => 'x' } as unknown as Ctx;
}

test('Stop backstop blocks a pending-setup turn end and re-delivers the link (claude + codex)', () => {
  for (const host of ['claude', 'codex'] as const) {
    withProject(null, (cwd) => {
      const r = onboardingStopGate(ctxStop(host, cwd));
      assert.equal(r.kind, 'deny', `${host}: the turn end is blocked once`);
      if (r.kind === 'deny') {
        assert.ok(r.reason.includes(DASH_URL), `${host}: the block carries the live link`);
        assert.match(r.reason, /run_in_background: false/, `${host}: the foreground wait is prescribed`);
        assert.ok(r.reason.includes('TRAFFIC_ONE_SETUP_COMPLETE'));
      }
    });
  }
});

test('Stop backstop passes when stop_hook_active is set — one forced continuation per turn', () => {
  withProject(null, (cwd) => {
    const r = onboardingStopGate(ctxStop('claude', cwd, { stop_hook_active: true }));
    assert.equal(r.kind, 'noop');
  });
});

test('Stop backstop stays quiet without a LIVE wizard record — unengaged sessions end normally', () => {
  withProject(null, (cwd) => {
    // Overwrite the seeded record with a dead pid: liveWizardLink must treat it
    // as no engagement (a Q&A turn in an un-onboarded directory must end freely).
    writeServerRecord(cwd, { pid: 999999999, port: 55222, token: 'tok', url: 'http://127.0.0.1:55222/?t=tok', startedAt: 'x' }, process.env, 'claude');
    const r = onboardingStopGate(ctxStop('claude', cwd));
    assert.equal(r.kind, 'noop');
  });
});

test('Stop backstop never fights the ask-first question or a declined project', () => {
  const prev = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
  try {
    withProject(null, (cwd) => {
      const r = onboardingStopGate(ctxStop('claude', cwd));
      assert.equal(r.kind, 'noop', 'ask-first pending: the turn must end so the user can answer');
    });
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = prev;
  }
  withProject(null, (cwd) => {
    recordPluginUseChoice(cwd, false, 'command');
    const r = onboardingStopGate(ctxStop('claude', cwd));
    assert.equal(r.kind, 'noop', 'a declined project never re-surfaces setup at turn end');
  });
});

test('Stop backstop stands down on a complete project and on subagent threads', () => {
  withProject(existingState(), (cwd) => {
    writeLocalPrefs();
    const r = onboardingStopGate(ctxStop('claude', cwd));
    assert.equal(r.kind, 'noop', 'complete onboarding: nothing to deliver');
  });
  withProject(null, (cwd) => {
    const r = onboardingStopGate(ctxStop('claude', cwd, { parent_session_id: 'parent-session' }));
    assert.equal(r.kind, 'noop', 'subagents never onboard');
  });
});

test('Stop backstop with the wizard open swaps to the links-shown prose instead of reposting', () => {
  withProject(null, (cwd) => {
    noteBrowserArrival(cwd, 'tok', process.env, 'claude');
    const r = onboardingStopGate(ctxStop('claude', cwd));
    assert.equal(r.kind, 'deny', 'the backstop still keeps the turn on the waiter (Devin precedent)');
    if (r.kind === 'deny') {
      assert.ok(!r.reason.includes(DASH_URL), 'no repost over an open wizard');
      assert.match(r.reason, /open in their browser/);
      assert.ok(r.reason.includes('TRAFFIC_ONE_SETUP_COMPLETE'));
    }
  });
});

test('the stop-setup TS fallbacks stay verbatim with their skill blocks', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skill', 'SKILL.md'), 'utf8');
  const required = skill.split('<!-- T1BLOCK:BEGIN stop-setup-required -->')[1]?.split('<!-- T1BLOCK:END')[0]?.trim() || '';
  assert.ok(required.length > 0, 'stop-setup-required block must exist');
  assert.equal(
    stopSetupRequiredReason('U', 'L' as LocalFallback, 'W'),
    required.replace(/\{\{URL\}\}/g, 'U').replace(/\{\{LOCAL_FALLBACK\}\}/g, 'L').replace(/\{\{WAIT_CMD\}\}/g, 'W'),
    'a missing SKILL.md must never soften this gate — keep the TS fallback byte-identical',
  );
  const linksShown = skill.split('<!-- T1BLOCK:BEGIN stop-setup-links-shown -->')[1]?.split('<!-- T1BLOCK:END')[0]?.trim() || '';
  assert.ok(linksShown.length > 0, 'stop-setup-links-shown block must exist');
  assert.equal(
    stopSetupLinksShownReason('W'),
    linksShown.replace(/\{\{WAIT_CMD\}\}/g, 'W'),
    'a missing SKILL.md must never soften this gate — keep the TS fallback byte-identical',
  );
});

test('Cursor Stop enqueues the setup followup while pending, and defers to the open wizard', () => {
  withProject(null, (cwd) => {
    recordMainOnboardingSession(cwd, 'cursor-stop-main');
    const r = onboardingStopGate(ctxStop('cursor', cwd));
    assert.equal(r.kind, 'context', 'cursor gets a followup, not a deny');
    if (r.kind === 'context') {
      assert.ok(r.followupMessage, 'the continuation rides followup_message');
      assert.ok(String(r.followupMessage).includes(DASH_URL), 'the followup carries the live link');
      assert.ok(String(r.followupMessage).includes('TRAFFIC_ONE_SETUP_COMPLETE'));
    }
  });
  withProject(null, (cwd) => {
    recordMainOnboardingSession(cwd, 'cursor-stop-main');
    noteBrowserArrival(cwd, 'tok', process.env, 'cursor');
    const r = onboardingStopGate(ctxStop('cursor', cwd));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(!String(r.followupMessage).includes(DASH_URL), 'no repost over an open wizard');
      assert.match(String(r.followupMessage), /open in their browser/);
    }
  });
});

test('Cursor Stop stays quiet on a foreign (subagent) conversation', () => {
  withProject(null, (cwd) => {
    recordMainOnboardingSession(cwd, 'orchestrator-conv');
    const r = onboardingStopGate(ctxStop('cursor', cwd, { session_id: 'some-child-conv' }));
    assert.equal(r.kind, 'noop', 'a non-main Cursor conversation is a subagent — never trap it on setup');
  });
});

test('the onboarding Stop handler outranks agent-model on the cursor-stop followup slot', async () => {
  const gate = await import('../index');
  const agentModel = await import('../../agent-model/index');
  const stopHandler = gate.handlers.find((h) => h.id === 'onboarding-gate.stop');
  assert.ok(stopHandler, 'the Stop handler must be registered');
  assert.ok(stopHandler.subcommands?.includes('cursor-stop'), 'cursor-stop must route to the backstop');
  assert.ok(stopHandler.subcommands?.includes('onboarding-stop'), 'onboarding-stop must route to the backstop');
  const agentModelStop = agentModel.handlers.find((h) => h.id === 'agent-model.cursor-stop');
  assert.ok(agentModelStop, 'the agent-model cursor-stop handler still exists');
  assert.ok(stopHandler.priority < agentModelStop.priority,
    'mergeResults keeps the FIRST followup — setup re-delivery must run first');
});

test('OpenCode/Kilo session.idle gets the one-line toast text, TTL-bounded, silent over an open wizard', () => {
  for (const host of ['opencode', 'kilo'] as const) {
    withProject(null, (cwd) => {
      const first = onboardingStopGate(ctxStop(host, cwd));
      assert.equal(first.kind, 'context', `${host}: idle delivery is a context/systemMessage, never a deny`);
      const message = sysMsg(first);
      assert.ok(message.includes(DASH_URL), `${host}: the toast text carries the link`);
      assert.ok(!message.includes('```'), `${host}: injection-safe one-line form`);
      assert.ok(!message.includes('do NOT'), `${host}: no behavioral overrides`);
      const second = onboardingStopGate(ctxStop(host, cwd));
      assert.equal(second.kind, 'noop', `${host}: session.idle can fire every turn — the TTL bounds it`);
    });
  }
  withProject(null, (cwd) => {
    noteBrowserArrival(cwd, 'tok', process.env, 'opencode');
    const r = onboardingStopGate(ctxStop('opencode', cwd));
    assert.equal(r.kind, 'noop', 'a toast adds nothing while the user is mid-setup');
  });
});

// ── Assistant-posted link = delivery evidence. Validated live (16cl/019fbca1 on
// 1.0.45): the compliant model posted the link right after bootstrap, and the
// arrival-only link-first deny ordered a DUPLICATE post in the seconds before
// the user could click. A link in an assistant transcript message now stands the
// deny down; tool output alone never does. ──

const CLAUDE_ASSISTANT_POST = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: `Open this link to complete setup:\n\n${DASH_URL}` }] },
});
const CLAUDE_TOOL_RESULT_ONLY = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content: `TRAFFIC_ONE_SETUP_READY\nSetup link: ${DASH_URL}` }] },
});

function ctxClaudeWait(cwd: string, command: string, transcriptPath: string): Ctx {
  const raw = { tool_name: 'Bash', tool_input: { command }, session_id: 'claude-main', transcript_path: transcriptPath };
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd, raw, tool: { class: 'shell', rawName: 'Bash' } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

test('Claude wait proceeds with no deny once the assistant has posted the link', () => {
  withProject(null, (cwd) => {
    const transcript = path.join(cwd, 'session.jsonl');
    fs.writeFileSync(transcript, `${CLAUDE_ASSISTANT_POST}\n`, 'utf8');
    const wait = onboardingWaitCommand(cwd, 'claude');
    const r = onboardingGate(ctxClaudeWait(cwd, wait, transcript));
    assert.equal(r.kind, 'noop', 'a posted link is delivery evidence — no deny, no duplicate order');
  });
});

test('Claude wait deny still fires when the link exists ONLY in tool output', () => {
  withProject(null, (cwd) => {
    const transcript = path.join(cwd, 'session.jsonl');
    fs.writeFileSync(transcript, `${CLAUDE_TOOL_RESULT_ONLY}\n`, 'utf8');
    const wait = onboardingWaitCommand(cwd, 'claude');
    const r = onboardingGate(ctxClaudeWait(cwd, wait, transcript));
    assert.equal(r.kind, 'deny', 'collapsed tool output is exactly the invisible producer that must not suppress');
    if (r.kind === 'deny') assert.match(r.reason, /NOT visible to the user/);
  });
});

test('Codex wait proceeds with no deny once the assistant has posted the link in the rollout', () => {
  const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-codexhome-')));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    withProject(null, (cwd) => {
      const dayDir = path.join(codexHome, 'sessions', '2026', '08', '01');
      fs.mkdirSync(dayDir, { recursive: true });
      fs.writeFileSync(path.join(dayDir, 'rollout-2026-08-01T12-00-00-codex-main.jsonl'), `${JSON.stringify({
        type: 'event_msg',
        payload: { type: 'agent_message', message: `Complete the Traffic One setup here:\n\n${DASH_URL}` },
      })}\n`, 'utf8');
      const wait = onboardingWaitCommand(cwd, 'codex');
      const r = onboardingGate(ctxHost('codex', cwd, 'exec_command', 'shell', { command: wait }));
      assert.equal(r.kind, 'noop', 'the rollout is the Codex transcript — a posted link stands the deny down');
    });
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

// Cursor twins of the Claude/Codex rows above. Cursor was the host left with NO
// evidence path on either the wait gate or Stop — it reads its own transcript
// from `~/.cursor/projects/<slug-of-cwd>/agent-transcripts/<id>/<id>.jsonl`, and
// the slug is derived from the cwd, so dropping `cwd` from the evidence input
// silently makes every Cursor session look like the link was never posted.
function withCursorTranscript(
  cwd: string,
  sessionId: string,
  line: string,
  fn: () => void,
): void {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-cursorproj-')));
  const prev = process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
  process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = root;
  try {
    const slug = path.resolve(fs.realpathSync(cwd))
      .replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
      .replace(/[/:\s]+/g, '-');
    const dir = path.join(root, slug, 'agent-transcripts', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${line}\n`, 'utf8');
    fn();
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR;
    else process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const CURSOR_ASSISTANT_POST = JSON.stringify({
  role: 'assistant',
  message: { content: [{ type: 'text', text: `Complete the Traffic One setup here:\n\n${DASH_URL}` }] },
});
// The dominant real shape, and the one the unit fixture only half-covered: the
// URL reaches the transcript inside a TOOL CALL (`open '<url>'`), which the user
// never sees. That must not stand the deny down.
const CURSOR_TOOL_USE_ONLY = JSON.stringify({
  role: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `open '${DASH_URL}'` } }] },
});

test('Cursor wait proceeds with no deny once the assistant has posted the link', () => {
  withProject(null, (cwd) => {
    withCursorTranscript(cwd, 'cursor-main', CURSOR_ASSISTANT_POST, () => {
      const wait = onboardingWaitCommand(cwd, 'cursor');
      const r = onboardingGate(ctxHost('cursor', cwd, 'Bash', 'shell', { command: wait }));
      assert.equal(r.kind, 'noop', 'a posted link is delivery evidence on Cursor too');
    });
  });
});

test('Cursor wait deny still fires when the link exists ONLY inside a tool call', () => {
  withProject(null, (cwd) => {
    withCursorTranscript(cwd, 'cursor-main', CURSOR_TOOL_USE_ONLY, () => {
      const wait = onboardingWaitCommand(cwd, 'cursor');
      const r = onboardingGate(ctxHost('cursor', cwd, 'Bash', 'shell', { command: wait }));
      assert.equal(r.kind, 'deny', 'an `open` call is not the user seeing the link');
      if (r.kind === 'deny') assert.match(r.reason, /NOT visible to the user/);
    });
  });
});

test('Stop with the link already posted keeps the turn on the waiter WITHOUT reposting', () => {
  withProject(null, (cwd) => {
    const transcript = path.join(cwd, 'session.jsonl');
    fs.writeFileSync(transcript, `${CLAUDE_ASSISTANT_POST}\n`, 'utf8');
    const r = onboardingStopGate(ctxStop('claude', cwd, { transcript_path: transcript }));
    assert.equal(r.kind, 'deny', 'the backstop still holds the turn open on the waiter');
    if (r.kind === 'deny') {
      assert.ok(!r.reason.includes(DASH_URL), 'no repost — the link is already in the conversation');
      assert.match(r.reason, /already posted in the conversation/);
      assert.ok(r.reason.includes('TRAFFIC_ONE_SETUP_COMPLETE'));
    }
  });
});

test('the stop-setup-link-posted TS fallback stays verbatim with its skill block', () => {
  const block = fs.readFileSync(
    path.join(__dirname, '..', 'skill', 'SKILL.md'), 'utf8',
  ).split('<!-- T1BLOCK:BEGIN stop-setup-link-posted -->')[1]?.split('<!-- T1BLOCK:END')[0]?.trim() || '';
  assert.ok(block.length > 0, 'the skill block must exist');
  assert.equal(
    stopSetupLinkPostedReason('W'),
    block.replace(/\{\{WAIT_CMD\}\}/g, 'W'),
    'a missing SKILL.md must never soften this gate — keep the TS fallback byte-identical',
  );
});
