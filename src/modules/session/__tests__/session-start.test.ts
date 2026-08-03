import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { runSessionStart, runSessionStartAuthed } from '../session-start';
import type { Ctx, HookInput } from '../../../core/types';
import { initializeToolchainState } from '../../../shared/state/toolchain';
import { writeGlobalCodeGraphProvider } from '../../../shared/state';
import { writeServerRecord } from '../../../shared/onboarding-server/registry';
import { writeSimpleAuth } from '../../../shared/auth';
import { currentLocalPreferenceTarget } from '../../../shared/onboarding/local-prefs';
import { mergeProjectPrefs } from '../../../shared/state/local-prefs';
import { HOST_IDS } from '../../../config/model-tiers';

// These tests exercise the setup-wizard flow itself, which under the shipped
// ask-first default (ASK_USE_PLUGIN_FIRST) only starts after the user's
// recorded yes. Pin the runtime override off so the wizard paths stay directly
// testable; the ask-first question has dedicated tests that set the flag to '1'.
process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

function ctx(cwd: string): Ctx {
  const input: HookInput = { event: 'SessionStart', host: 'claude', cwd, raw: {} };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function ctxHost(cwd: string, host: HookInput['host']): Ctx {
  const input: HookInput = { event: 'SessionStart', host, cwd, raw: {} };
  return { input, host, cwd, now: () => 'x' } as unknown as Ctx;
}

// A temp project with isolated prefs. Tests that exercise the full SessionStart
// entry write canonical auth explicitly; runSessionStartAuthed tests only the
// post-gate body.
function withProject(state: Record<string, unknown> | null, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sstart-'));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = env.TRAFFIC_ONE_STATE_PATH;
  const prevXdgState = env.XDG_STATE_HOME;
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  // Canonical auth and codeGraphProvider are machine-wide (one.json) — isolate it.
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.XDG_STATE_HOME = path.join(dir, 'state');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  if (state) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
  }
  try { fn(dir); } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    if (prevState === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = prevState;
    if (prevXdgState === undefined) delete env.XDG_STATE_HOME; else env.XDG_STATE_HOME = prevXdgState;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function localPrefs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const {
    performance = { level: 'low', source: 'prompted' },
    team = { mode: 'main-agent', source: 'prompted' },
    ...rest
  } = extra;
  const rawPerformance = performance as Record<string, unknown>;
  const hosts = Object.fromEntries(HOST_IDS.map((host) => [host, {
    performance: {
      ...rawPerformance,
      target: rawPerformance.target ?? currentLocalPreferenceTarget(host, process.env),
    },
    team: { ...(team as Record<string, unknown>) },
  }]));
  return {
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
    hosts,
    toolchain: initializeToolchainState({}),
    ...rest,
  };
}

function writeLocalPrefs(extra: Record<string, unknown> = {}): void {
  const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  assert.ok(prefsPath, 'test prefs path must be configured');
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(localPrefs(extra)), 'utf8');
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
    ...extra,
  };
}

function newProjectSharedState(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
    projectContext: {
      source: 'prompted',
      originalPrompt: 'Build a dashboard',
      summary: 'Dashboard MVP',
      answers: { audience: 'Operators' },
      collectedAt: '2026-01-01T00:00:00Z',
    },
    realtime: 'none',
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

function writeExistingNextCodebase(cwd: string): void {
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'x', dependencies: { next: '15.0.0', react: '19.0.0' } }), 'utf8');
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(path.join(cwd, 'src', `file-${i}.tsx`), `export const value${i} = ${i};\n`, 'utf8');
  }
}

function assertOpenCodeSetupTextIsSanitized(text: string): void {
  assert.ok(text.toLowerCase().includes('setup'), 'OpenCode setup text still explains setup is required');
  for (const unsafe of ['.claude/launch.json', 'preview_start', 'node_repl', 'const fs', 'do NOT', 'Do NOT']) {
    assert.ok(!text.includes(unsafe), `OpenCode setup text must not include ${unsafe}`);
  }
}

test('runSessionStart is a noop in the plugin authoring root (before any auth probe)', () => {
  assert.equal(runSessionStart(ctx(process.cwd())).kind, 'noop');
});

test('runSessionStartAuthed from a workspace package resolves to the ancestor project root', () => {
  withProject({
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    onboardingComplete: true,
    confirmed: true,
    materializedStack: 'default|react-vite|supabase|none',
  }, (cwd) => {
    writeLocalPrefs({
      performance: { level: 'high', source: 'prompted' },
      team: { mode: 'subagents', source: 'prompted', approved: true },
    });
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@9.0.0', workspaces: ['apps/*'] }), 'utf8');
    const app = path.join(cwd, 'apps', 'web');
    fs.mkdirSync(app, { recursive: true });
    const result = runSessionStartAuthed(ctx(app));
    assert.equal(result.kind, 'context');
    const memoryDir = '.traffic' + '-one';
    assert.equal(fs.existsSync(path.join(cwd, memoryDir, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(app, memoryDir)), false);
  });
});

test('nested SessionStart checks the canonical project Performance target, not the hook process cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sstart-root-target-'));
  const cwd = path.join(dir, 'workspace');
  const home = path.join(dir, 'home');
  const app = path.join(cwd, 'apps', 'web');
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify(newProjectSharedState({
    materializedStack: 'default|react-vite|supabase|none',
  })), 'utf8');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    private: true,
    packageManager: 'pnpm@9.0.0',
    workspaces: ['apps/*'],
  }), 'utf8');

  const env = process.env;
  const previous = {
    home: env.HOME,
    xdgState: env.XDG_STATE_HOME,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: env.TRAFFIC_ONE_STATE_PATH,
    plan: env.TRAFFIC_ONE_USER_PLAN,
  };
  env.HOME = home;
  delete env.XDG_STATE_HOME;
  delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_STATE_PATH = path.join(home, 'one.json');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    const target = currentLocalPreferenceTarget('claude', env, cwd);
    mergeProjectPrefs(cwd, localPrefs({
      performance: {
        level: 'high',
        source: 'prompted',
        target: {
          plan: target.plan,
          appliedFingerprint: target.appliedFingerprint === '0'.repeat(64)
            ? '1'.repeat(64)
            : '0'.repeat(64),
          configVersion: target.configVersion,
        },
      },
      team: { mode: 'subagents', source: 'prompted', approved: true },
    }));
    writeGlobalCodeGraphProvider('graphify');

    const result = runSessionStartAuthed(ctx(app));
    assert.equal(result.kind, 'context');
    assert.match(result.kind === 'context' ? result.systemMessage || '' : '', /setup required/);
  } finally {
    if (previous.home === undefined) delete env.HOME; else env.HOME = previous.home;
    if (previous.xdgState === undefined) delete env.XDG_STATE_HOME; else env.XDG_STATE_HOME = previous.xdgState;
    if (previous.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = previous.prefs;
    if (previous.state === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = previous.state;
    if (previous.plan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = previous.plan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runSessionStart DEFERS a pristine new-project (writes no state) so a non-coding prompt stays dormant', () => {
  withProject(null, (cwd) => {
    writeSimpleAuth('sk-session-start');
    // SessionStart fires before any prompt; on a fresh dir it must NOT activate
    // Traffic One. Codex opens a scratch dir per task, so every session would
    // otherwise look like a new project and trip the onboarding gate even for a
    // non-coding question. It stays silent and writes nothing — so the
    // UserPromptSubmit coding-intent guard still sees a pristine project and can
    // skip a non-coding prompt.
    const r = runSessionStart(ctx(cwd));
    assert.equal(r.kind, 'noop');
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', '.one.json')), false, 'no state written at SessionStart');
    // The authed body (what UserPromptSubmit re-runs for a CODING prompt) still
    // activates and writes state — the deferral is SessionStart-only, not a
    // global disable.
    assert.equal(runSessionStartAuthed(ctx(cwd)).kind, 'context');
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', '.one.json')), true, 'authed body activates + writes state');
  });
});

test('Flow 3: a new project with no Traffic One state points at the setup wizard + baseline rules', () => {
  withProject(null, (cwd) => {
    const r = runSessionStartAuthed(ctx(cwd));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.toLowerCase().includes('setup'), 'points at the setup wizard');
      assert.ok(r.context.includes('Baseline rules'));
    }
  });
});

test('Flow 1: an onboarded existing project with local prefs gets the packed rule bundle header', () => {
  withProject(existingState(), (cwd) => {
    writeLocalPrefs();
    const r = runSessionStartAuthed(ctx(cwd));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('stack: minimal'));
      assert.ok(r.context.includes('mode: existing-codebase'));
    }
  });
});

test('parent SessionStart safely migrates legacy custom-backend React defaults only when no frontend artifacts exist', () => {
  withProject(existingState({
    stack: 'custom-backend',
    frontend: 'react-vite',
  }), (cwd) => {
    writeLocalPrefs();
    assert.equal(runSessionStartAuthed(ctx(cwd)).kind, 'context');
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(state.frontend, 'none');
  });
});

test('parent SessionStart never migrates an active run or an ambiguous legacy custom-backend project', () => {
  withProject(existingState({
    stack: 'custom-backend',
    frontend: 'react-vite',
    currentRunId: 'active-legacy',
  }), (cwd) => {
    writeLocalPrefs();
    const runDir = path.join(cwd, '.traffic-one', 'runs', 'active-legacy');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      version: 1,
      runId: 'active-legacy',
      status: 'active',
    }));
    assert.equal(runSessionStartAuthed(ctx(cwd)).kind, 'context');
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(state.frontend, 'react-vite');
  });

  withProject(existingState({
    stack: 'custom-backend',
    frontend: 'react-vite',
  }), (cwd) => {
    writeLocalPrefs();
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
      dependencies: { next: '15.0.0', react: '19.0.0' },
    }));
    assert.equal(runSessionStartAuthed(ctx(cwd)).kind, 'context');
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(state.frontend, 'react-vite');
  });
});

test('maintenance SessionStart does not mint a run before a runtime-only prompt is classified', () => {
  withProject(existingState(), (cwd) => {
    writeLocalPrefs({ team: { mode: 'subagents', source: 'prompted', approved: true } });
    assert.equal(runSessionStartAuthed(ctx(cwd)).kind, 'context');
    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(state.currentRunId, undefined);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'runs')), false);
  });
});

test('SessionStart policy freeze does not resume or upgrade a completed legacy maintenance run', () => {
  withProject(newProjectSharedState({
    currentRunId: 'legacy-maintenance',
    phase: 'maintenance',
    materializedStack: 'default|react-vite|supabase|none',
  }), (cwd) => {
    writeLocalPrefs({ team: { mode: 'subagents', source: 'prompted', approved: true } });
    const ledgerPath = path.join(cwd, '.traffic-one', 'runs', 'legacy-maintenance', 'run.json');
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      runId: 'legacy-maintenance',
      status: 'completed',
      outcome: 'verified',
      createdAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T01:00:00.000Z',
    }));

    assert.equal(runSessionStartAuthed(ctx(cwd)).kind, 'context');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(ledger.status, 'completed');
    assert.equal(ledger.qaContractVersion, undefined);
  });
});

// ── Parent policy preflight: a null policy has three distinct causes and only
// one of them is repaired by Performance. ──

function writeSubagentPrefs(): void {
  writeLocalPrefs({
    performance: { level: 'high', source: 'prompted' },
    team: { mode: 'subagents', source: 'prompted', approved: true },
  });
}

// The first SessionStart of a subagents project mints the run AND publishes
// model-policy.json plus the capability/baseline bootstrap, so a follow-up
// session can break exactly one layer and assert which message the parent gets.
function freezeSubagentRun(cwd: string): { runId: string; runDir: string } {
  writeSubagentPrefs();
  const first = runSessionStartAuthed(ctx(cwd));
  assert.equal(first.kind, 'context');
  if (first.kind === 'context') {
    assert.ok(first.context.startsWith('═══ traffic-one'), 'a fully bootstrapped run gets the normal header');
    assert.doesNotMatch(first.context, /TRAFFIC_ONE_(MODEL_POLICY|BOOTSTRAP)_BLOCKED|TRAFFIC_ONE_CURSOR_MODELS_REQUIRED/);
  }
  const runId = String(JSON.parse(
    fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'),
  ).currentRunId);
  const runDir = path.join(cwd, '.traffic-one', 'runs', runId);
  assert.equal(fs.existsSync(path.join(runDir, 'model-policy.json')), true, 'the run froze its create-once policy');
  return { runId, runDir };
}

function breakParentBootstrap(runDir: string): void {
  fs.rmSync(path.join(runDir, 'capability-v1.json'), { force: true });
  fs.writeFileSync(path.join(runDir, 'baseline-v1.json'), '{}\n', 'utf8');
}

test('SessionStart reports a frozen run whose parent bootstrap failed as BOOTSTRAP_BLOCKED', () => {
  withProject(newProjectSharedState(), (cwd) => {
    const { runId, runDir } = freezeSubagentRun(cwd);
    breakParentBootstrap(runDir);
    const blocked = runSessionStartAuthed(ctx(cwd));
    assert.equal(blocked.kind, 'context');
    if (blocked.kind !== 'context') return;
    assert.ok(blocked.context.startsWith('TRAFFIC_ONE_BOOTSTRAP_BLOCKED'), blocked.context.slice(0, 120));
    assert.ok(blocked.context.includes(`Run ${runId} already has a valid immutable model policy`));
    assert.match(blocked.context, /capability baseline and parent bootstrap/);
    assert.match(blocked.context, /do not redo onboarding/i);
    // The wizard cannot rebase a create-once policy — never send the user there.
    assert.doesNotMatch(blocked.context, /Reopen Performance/i);
    assert.match(String(blocked.systemMessage), /capability baseline and parent bootstrap/);
  });
});

test('SessionStart names the frozen host when the run belongs to another host', () => {
  withProject(newProjectSharedState(), (cwd) => {
    const { runId, runDir } = freezeSubagentRun(cwd);
    breakParentBootstrap(runDir);
    const blocked = runSessionStartAuthed(ctxHost(cwd, 'codex'));
    assert.equal(blocked.kind, 'context');
    if (blocked.kind !== 'context') return;
    assert.ok(blocked.context.startsWith('TRAFFIC_ONE_MODEL_POLICY_BLOCKED'), blocked.context.slice(0, 120));
    assert.ok(blocked.context.includes(`Run ${runId} is frozen for claude, not codex`));
    assert.match(blocked.context, /Start a new parent run for the active host/);
    assert.doesNotMatch(blocked.context, /Reopen Performance/i);
    assert.doesNotMatch(blocked.context, /TRAFFIC_ONE_BOOTSTRAP_BLOCKED/);
  });
});

// NEGATIVE: the new arms must not swallow the state they do not describe. A
// published-but-unreadable create-once policy is NOT a bootstrap failure.
test('SessionStart keeps the Performance message when no valid policy was ever frozen', () => {
  withProject(newProjectSharedState({ currentRunId: 'run-corrupt' }), (cwd) => {
    writeSubagentPrefs();
    const policyPath = path.join(cwd, '.traffic-one', 'runs', 'run-corrupt', 'model-policy.json');
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, '{ not json', 'utf8');
    const blocked = runSessionStartAuthed(ctx(cwd));
    assert.equal(blocked.kind, 'context');
    if (blocked.kind !== 'context') return;
    assert.ok(blocked.context.startsWith('TRAFFIC_ONE_MODEL_POLICY_BLOCKED'), blocked.context.slice(0, 120));
    assert.match(blocked.context, /Reopen Performance/);
    assert.doesNotMatch(blocked.context, /TRAFFIC_ONE_BOOTSTRAP_BLOCKED/);
  });
});

// NEGATIVE: capture is the only action that repairs an UNPUBLISHED Cursor
// policy — offering it against a published one is busy-work that hid the real
// blocker behind a model-picker chore.
test('cursor: model capture is not offered once a create-once policy is published', () => {
  withProject(newProjectSharedState(), (cwd) => {
    const { runId, runDir } = freezeSubagentRun(cwd);
    breakParentBootstrap(runDir);
    const blocked = runSessionStartAuthed(ctxHost(cwd, 'cursor'));
    assert.equal(blocked.kind, 'context');
    if (blocked.kind !== 'context') return;
    assert.doesNotMatch(blocked.context, /TRAFFIC_ONE_CURSOR_MODELS_REQUIRED/);
    assert.doesNotMatch(blocked.context, /--capture-models/);
    assert.ok(blocked.context.includes(`Run ${runId} is frozen for claude, not cursor`));
  });
});

test('cursor: an unpublished run still asks for the Task-picker capture first', () => {
  withProject(newProjectSharedState(), (cwd) => {
    writeSubagentPrefs();
    const blocked = runSessionStartAuthed(ctxHost(cwd, 'cursor'));
    assert.equal(blocked.kind, 'context');
    if (blocked.kind !== 'context') return;
    assert.ok(blocked.context.startsWith('TRAFFIC_ONE_CURSOR_MODELS_REQUIRED'), blocked.context.slice(0, 120));
    const runId = String(JSON.parse(
      fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'),
    ).currentRunId);
    assert.equal(
      fs.existsSync(path.join(cwd, '.traffic-one', 'runs', runId, 'model-policy.json')),
      false,
      'no incomplete create-once policy is published',
    );
  });
});

test('runSessionStartAuthed prunes stale pending run claims during startup hygiene', () => {
  withProject(existingState({ currentRunId: 'run-prune' }), (cwd) => {
    writeLocalPrefs();
    const pending = path.join(cwd, '.traffic-one', 'runs', 'run-prune', 'pending');
    fs.mkdirSync(pending, { recursive: true });
    fs.writeFileSync(path.join(pending, 'old.json'), JSON.stringify({
      version: 1,
      runId: 'run-prune',
      claimId: 'old',
      role: 'senior-backend',
      status: 'pending',
      createdAt: '1970-01-01T00:00:00Z',
    }), 'utf8');
    fs.writeFileSync(path.join(pending, 'fresh.json'), JSON.stringify({
      version: 1,
      runId: 'run-prune',
      claimId: 'fresh',
      role: 'senior-frontend',
      status: 'pending',
      createdAt: new Date().toISOString(),
    }), 'utf8');
    assert.equal(runSessionStartAuthed(ctx(cwd)).kind, 'context');
    const remaining = fs.readdirSync(pending).filter((name) => name.endsWith('.json'));
    assert.deepEqual(remaining, ['fresh.json']);
  });
});

test('Flow 1: an onboarded existing project without local prefs asks only local-pref steps', () => {
  withProject(existingState(), (cwd) => {
    const r = runSessionStartAuthed(ctx(cwd));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.equal(r.systemMessage, 'traffic-one [minimal] setup required');
      assert.ok(r.context.toLowerCase().includes('setup'));
      assert.equal(r.promptRequest, undefined);
    }
  });
});

test('opencode: onboarded existing project without local prefs uses sanitized setup text', () => {
  withProject(existingState(), (cwd) => {
    const r = runSessionStartAuthed(ctxHost(cwd, 'opencode'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.equal(r.systemMessage, 'traffic-one [minimal] setup required');
      assertOpenCodeSetupTextIsSanitized(r.context);
    }
  });
});

test('Flow 1: an onboarded new project with shared state + local prefs runs normally', () => {
  withProject(newProjectSharedState(), (cwd) => {
    writeLocalPrefs();
    const r = runSessionStartAuthed(ctx(cwd));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('stack: default'));
      assert.ok(r.context.includes('mode: new-project'));
      const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
      assert.equal('openCode' in onDisk, false);
      assert.equal('performance' in onDisk, false);
      assert.equal('team' in onDisk, false);
      assert.equal('codeGraphProvider' in onDisk, false);
    }
  });
});

test('SessionStart does not flip Supabase state for a stray .go file without a module marker', () => {
  withProject(newProjectSharedState(), (cwd) => {
    fs.mkdirSync(path.join(cwd, 'services', 'api'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'services', 'api', 'scratch.go'), 'package scratch\n', 'utf8');
    writeLocalPrefs();
    assert.equal(runSessionStartAuthed(ctx(cwd)).kind, 'context');
    const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(onDisk.stack, 'default');
    assert.equal(onDisk.frontend, 'react-vite');
    assert.equal(onDisk.backend, 'supabase');
  });
});

test('Flow 1: an onboarded new project without local prefs asks local-pref steps', () => {
  withProject(newProjectSharedState(), (cwd) => {
    const r = runSessionStartAuthed(ctx(cwd));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.equal(r.systemMessage, 'traffic-one [setup required]');
      assert.ok(r.context.toLowerCase().includes('setup'));
      assert.equal(r.promptRequest, undefined);
    }
  });
});

test('opencode: onboarded new project without local prefs uses sanitized setup text', () => {
  withProject(newProjectSharedState(), (cwd) => {
    const r = runSessionStartAuthed(ctxHost(cwd, 'opencode'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.equal(r.systemMessage, 'traffic-one [setup required]');
      assertOpenCodeSetupTextIsSanitized(r.context);
    }
  });
});

// The dashboard deep link for the seeded record below (default dashboard base).
const DASH_URL_51999 = 'https://traffic.io/onboarding/agent#p=51999&t=t';

test('cursor: a pending new project surfaces the dashboard setup URL in the user-facing systemMessage', () => {
  const prev = process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
  process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1'; // never spawn a real detached server in tests
  try {
    withProject({ mode: 'new-project' }, (cwd) => {
      // A live server record → ensureOnboardingServer reuses its URL (no spawn).
      writeServerRecord(cwd, { pid: process.pid, port: 51999, token: 't', url: 'http://127.0.0.1:51999/?t=t', startedAt: 'x' }, process.env, 'cursor');
      const r = runSessionStartAuthed(ctxHost(cwd, 'cursor'));
      assert.equal(r.kind, 'context');
      if (r.kind === 'context') {
        assert.ok(r.systemMessage?.includes(DASH_URL_51999), 'cursor user_message carries the dashboard setup URL');
      }
    });
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN; else process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = prev;
  }
});

test('windsurf: a pending new project surfaces a compact host-only wizard directive', () => {
  const prev = process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
  process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  try {
    withProject({ mode: 'new-project' }, (cwd) => {
      const url = 'http://127.0.0.1:51998/?t=windsurf';
      const dashboardUrl = 'https://traffic.io/onboarding/agent#p=51998&t=windsurf';
      writeServerRecord(cwd, { pid: process.pid, port: 51998, token: 'windsurf', url, startedAt: 'x' }, process.env, 'windsurf');
      const r = runSessionStartAuthed(ctxHost(cwd, 'windsurf'));
      assert.equal(r.kind, 'context');
      if (r.kind === 'context') {
        assert.ok(r.systemMessage?.includes(dashboardUrl), 'Windsurf user_message carries the dashboard setup URL');
        assert.ok(r.context.includes('standalone clickable setup link'));
        for (const foreign of ['Claude Code', 'Cursor:', 'Codex Desktop', '.claude/launch.json', 'preview_start', 'node_repl']) {
          assert.ok(!r.context.includes(foreign), `Windsurf setup must not include ${foreign}`);
        }
      }
    });
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN; else process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = prev;
  }
});

test('all hosts now surface the dashboard setup URL in the banner (onboarding UI opens in the browser)', () => {
  const prev = process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN;
  process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  try {
    withProject({ mode: 'new-project' }, (cwd) => {
      writeServerRecord(cwd, { pid: process.pid, port: 51999, token: 't', url: 'http://127.0.0.1:51999/?t=t', startedAt: 'x' }, process.env, 'claude');
      const r = runSessionStartAuthed(ctx(cwd)); // host=claude
      assert.equal(r.kind, 'context');
      if (r.kind === 'context') {
        assert.ok(r.systemMessage?.startsWith('traffic-one [setup required]'));
        assert.ok(r.systemMessage?.includes(DASH_URL_51999), 'claude banner now carries the dashboard link too');
      }
    });
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN; else process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = prev;
  }
});

test('Flow 2: an existing codebase with no state auto-detects, writes state, then asks local prefs', () => {
  withProject(null, (cwd) => {
    writeExistingNextCodebase(cwd);
    const r = runSessionStartAuthed(ctx(cwd));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.equal(r.systemMessage, 'traffic-one [custom-frontend] setup required');
      assert.ok(r.context.includes('auto-detected'));
      assert.ok(r.context.toLowerCase().includes('setup'));
      assert.equal(r.promptRequest, undefined);
    }
    const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(onDisk.mode, 'existing-codebase');
    assert.equal(onDisk.stack, 'custom-frontend');
    assert.equal(onDisk.frontend, 'nextjs');
    assert.equal('openCode' in onDisk, false);
  });
});

test('ask-first: a pristine new project gets ONLY the question — no state, no prefs, no wizard', () => {
  withProject(null, (cwd) => {
    const prevAsk = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
    try {
      const r = runSessionStartAuthed(ctx(cwd));
      assert.equal(r.kind, 'context');
      if (r.kind === 'context') {
        assert.match(r.context, /Do you want to use the Traffic One plugin/);
        assert.ok(!r.context.includes('http://127.0.0.1'), 'NO wizard URL before the user says yes');
      }
      assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'no project .traffic-one before the answer');
      assert.equal(fs.existsSync(path.join(cwd, 'prefs.json')), false, 'no per-user prefs before the answer');
    } finally {
      if (prevAsk === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
      else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = prevAsk;
    }
  });
});

test('ask-first Flow 2: an existing codebase is NOT auto-detected or materialized before the yes', () => {
  withProject(null, (cwd) => {
    const prevAsk = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
    try {
      writeExistingNextCodebase(cwd);
      const r = runSessionStartAuthed(ctx(cwd));
      assert.equal(r.kind, 'context');
      if (r.kind === 'context') {
        assert.match(r.context, /Do you want to use the Traffic One plugin/);
        assert.ok(!r.context.includes('auto-detected'), 'no auto-detect announcement pre-decision');
        assert.ok(!r.context.includes('http://127.0.0.1'), 'NO wizard URL before the user says yes');
      }
      assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'a "no" must leave the repo byte-identical');
      assert.equal(fs.existsSync(path.join(cwd, 'prefs.json')), false, 'no per-user prefs before the answer');
    } finally {
      if (prevAsk === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
      else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = prevAsk;
    }
  });
});

function subagentCtx(cwd: string): Ctx {
  // parent_session_id ⇒ hookSessionIdentity().isSubagent === true
  const input: HookInput = { event: 'SessionStart', host: 'claude', cwd, raw: { parent_session_id: 'parent-abc', session_id: 'child-xyz' } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function codexTranscriptSubagentCtx(cwd: string): Ctx {
  const parentThread = '11111111-1111-4111-8111-111111111111';
  const childThread = '22222222-2222-4222-8222-222222222222';
  const input: HookInput = {
    event: 'SessionStart',
    host: 'codex',
    cwd,
    raw: {
      // Codex reports the parent session id in child hooks. The rollout filename
      // is the only reliable child-thread discriminator in this payload shape.
      session_id: parentThread,
      transcript_path: path.join(cwd, 'sessions', `${childThread}.jsonl`),
    },
  };
  return { input, host: 'codex', cwd, now: () => 'x' } as unknown as Ctx;
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

test('subagent: never opens setup or the API-key wizard for an un-onboarded project', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    // A MAIN agent here would hit the auth gate / setup directive; the subagent must not.
    const r = runSessionStart(subagentCtx(cwd));
    if (r.kind === 'context') {
      assert.ok(!/setup required|quick setup|setup wizard|onboarding/i.test(r.context || ''), 'subagent must not be onboarded');
    } else {
      assert.equal(r.kind, 'noop');
    }
    assert.ok(!/authenticat/i.test(String((r as { systemMessage?: string }).systemMessage || '')), 'subagent must not be asked to authenticate');
  });
});

test('Codex transcript-thread mismatch takes the child fast path before model refresh, auth, or onboarding', () => {
  withProject({ mode: 'new-project' }, (cwd) => {
    const globalSettings = process.env.TRAFFIC_ONE_STATE_PATH;
    assert.ok(globalSettings);

    const r = runSessionStart(codexTranscriptSubagentCtx(cwd));

    assert.equal(r.kind, 'noop');
    assert.equal(
      fs.existsSync(globalSettings),
      false,
      'a child SessionStart must not write machine settings',
    );
  });
});

test('subagent: a materialized project hands back rules, never onboarding', () => {
  withProject(existingState(), (cwd) => {
    writeLocalPrefs();
    materializeFixture(cwd, 'minimal');
    const r = runSessionStart(subagentCtx(cwd));
    const text = r.kind === 'context' ? (r.context || '') : '';
    assert.ok(!/setup required|quick setup|setup wizard/i.test(text), 'subagent never onboarded even when materialized');
    assert.ok(!/authenticat/i.test(String((r as { systemMessage?: string }).systemMessage || '')));
  });
});
