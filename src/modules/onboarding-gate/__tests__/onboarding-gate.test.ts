import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { onboardingGate } from '../handler';
import { recordMainOnboardingSession } from '../../../shared/onboarding-server/onboarding-session';
import { writeServerRecord } from '../../../shared/onboarding-server/registry';
import { onboardingWaitCommand } from '../../../shared/onboarding-server/wait-command';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';
import { initializeToolchainState } from '../../../shared/state/toolchain';
import { writeGlobalCodeGraphProvider } from '../../../shared/state';
import { hostScopedPerformancePrefs } from '../../../test-support/host-prefs';

function ctx(cwd: string, rawName: string, cls: ToolClass, toolInput: Record<string, unknown>): Ctx {
  const input: HookInput = { event: 'PreToolUse', host: 'claude', cwd, raw: { tool_name: rawName, tool_input: toolInput }, tool: { class: cls, rawName } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
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
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  // codeGraphProvider + auth-choice are machine-wide (one.json) — isolate it.
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  // Never spawn a real wizard server from a unit test; ensure() hands back a
  // deterministic placeholder URL instead.
  env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  if (state) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
  }
  try { fn(dir); } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    if (prevState === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = prevState;
    if (prevNoSpawn === undefined) delete env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN; else env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = prevNoSpawn;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
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

test('noop inside the plugin authoring root', () => {
  assert.equal(onboardingGate(ctx(process.cwd(), 'Write', 'file-write', { file_path: 'x.ts', content: 'x' })).kind, 'noop');
});

test('new project with no Traffic One state: a mutating feature write is denied with the wizard URL', () => {
  withProject(null, (cwd) => {
    const r = onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes('http://127.0.0.1'), 'deny reason carries the wizard URL');
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
      assert.ok(r.reason.includes('http://127.0.0.1'), 'deny reason carries the wizard URL');
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
    writeServerRecord(cwd, { pid: process.pid, port: 51444, token: 'windsurf', url, startedAt: 'x' }, process.env, 'windsurf');
    const r = onboardingGate(ctxWindsurf(cwd, 'write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes(url));
      assert.ok(r.reason.includes(`[Open Traffic One setup](${url})`));
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
    writeServerRecord(cwd, { pid: process.pid, port: 51445, token: 'windsurf-read', url, startedAt: 'x' }, process.env, 'windsurf');
    assert.equal(
      onboardingGate(ctxWindsurf(cwd, 'Bash', 'shell', { command: 'ls -la' })).kind,
      'noop',
      'Windsurf must not render harmless orientation as a failed command',
    );
    const write = onboardingGate(ctxWindsurf(cwd, 'write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(write.kind, 'deny');
    if (write.kind === 'deny') assert.ok(write.reason.includes(url));
  });
});

test('existing project with Traffic One state but no local prefs: mutating tools are denied with the wizard URL', () => {
  withProject(existingState(), (cwd) => {
    materializeFixture(cwd);
    const r = onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.ok(r.reason.includes('http://127.0.0.1'), 'deny reason carries the wizard URL');
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
    if (first.kind === 'deny') assert.ok(first.reason.includes('http://127.0.0.1'), 'first deny carries the wizard URL');
    // Recipe delivered this session → subsequent read-only orientation flows.
    assert.equal(onboardingGate(ctx(cwd, 'Bash', 'shell', { command: 'ls -la' })).kind, 'noop');
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
    if (first.kind === 'deny') assert.ok(first.reason.includes('http://127.0.0.1'), 'first deny carries the wizard URL');
    // Recipe delivered → subsequent read-only orientation flows.
    assert.equal(onboardingGate(ctx(cwd, 'Bash', 'shell', { command: 'ls -la' })).kind, 'noop');
    // A mutating write still denies after the one-time recipe (short repeat block, still URL-bearing).
    const write = onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: 'src/app.ts', content: 'export const x = 1;' }));
    assert.equal(write.kind, 'deny');
    if (write.kind === 'deny') assert.ok(write.reason.includes('http://127.0.0.1'));
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
      assert.ok(first.reason.includes(`Open the Traffic One setup wizard: ${url}`), 'deny carries a direct clickable URL line');
      assert.ok(first.reason.includes(command), 'deny tells the agent to re-run the wait command');
    }

    const second = onboardingGate(ctxCursor(cwd, 'before-shell-execution', 'shell', { command }, 'main-conv', '/x/transcript.jsonl'));
    assert.equal(second.kind, 'noop', 'after the visible link, the wait command is allowed');
  });
});
