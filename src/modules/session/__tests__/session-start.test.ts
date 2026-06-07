import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { runSessionStart, runSessionStartAuthed } from '../session-start';
import type { Ctx, HookInput } from '../../../core/types';
import { initializeToolchainState } from '../../../shared/state/toolchain';
import { stackFingerprint, writeOrchestrationPlan } from '../../../shared/state';

function ctx(cwd: string): Ctx {
  const input: HookInput = { event: 'SessionStart', host: 'claude', cwd, raw: {} };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

// A temp project with isolated prefs. The post-auth body (runSessionStartAuthed)
// needs no auth — SessionStart's forced remote probe is tested separately.
function withProject(state: Record<string, unknown> | null, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sstart-'));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  if (state) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(state), 'utf8');
  }
  try { fn(dir); } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function localPrefs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
    performance: { level: 'low', source: 'prompted' },
    team: { mode: 'main-agent', source: 'prompted' },
    codeGraphProvider: 'graphify',
    toolchain: initializeToolchainState({}),
    ...extra,
  };
}

function writeLocalPrefs(extra: Record<string, unknown> = {}): void {
  const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  assert.ok(prefsPath, 'test prefs path must be configured');
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(localPrefs(extra)), 'utf8');
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

test('runSessionStart is a noop in the plugin authoring root (before any auth probe)', () => {
  assert.equal(runSessionStart(ctx(process.cwd())).kind, 'noop');
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

function subagentCtx(cwd: string): Ctx {
  // parent_session_id ⇒ hookSessionIdentity().isSubagent === true
  const input: HookInput = { event: 'SessionStart', host: 'claude', cwd, raw: { parent_session_id: 'parent-abc', session_id: 'child-xyz' } };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
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

test('subagent: never runs onboarding/auth on an un-onboarded project (no setup-required, no auth prompt)', () => {
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

test('subagent first-spawn role context: a declared plan narrows the role-scoped rules + skills', () => {
  withProject(null, (cwd) => {
    const RUN = '1700000000077';
    const sharedState: Record<string, unknown> = {
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'none' },
      onboardingComplete: true, currentRunId: RUN,
    };
    const fp = stackFingerprint(sharedState);
    sharedState.materializedStack = fp;
    const t1 = path.join(cwd, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify(sharedState), 'utf8');
    writeLocalPrefs({ performance: { level: 'high', source: 'prompted' }, team: { mode: 'subagents', source: 'prompted', approved: true } });
    materializeFixture(cwd, 'default');

    // Claim a senior-frontend thread keyed by the subagent's session id (exact-match path).
    fs.mkdirSync(path.join(t1, 'runs', RUN), { recursive: true });
    fs.writeFileSync(path.join(t1, 'runs', RUN, 'child-xyz.json'), JSON.stringify({
      version: 1, runId: RUN, claimId: 'senior-frontend-1-x', role: 'senior-frontend', spawnIndex: 1,
      status: 'claimed', sessionId: 'child-xyz', parentSessionId: 'parent-abc',
      createdAt: new Date().toISOString(), claimedAt: new Date().toISOString(), stackFingerprint: fp,
    }), 'utf8');

    // Narrow senior-frontend to ONLY the i18n rule + the i18n-text skill.
    const written = writeOrchestrationPlan(cwd, {
      version: 1, runId: RUN, taskClass: 'minor', roster: ['senior-frontend'], graph: [['senior-frontend']],
      roles: { 'senior-frontend': { tier: 'cheapest', rules: ['rules/frontend/i18n.md'], skills: ['i18n-text'] } },
    });
    assert.ok(written, 'plan should validate');

    const r = runSessionStart(subagentCtx(cwd));
    assert.equal(r.kind, 'context');
    const text = r.kind === 'context' ? (r.context || '') : '';
    // The claim resolved to senior-frontend (role header proves the plan-aware path ran).
    assert.ok(/senior-frontend \(run 1700000000077\)/.test(text), 'resolved the senior-frontend role context');
    // Skill directive narrowed to exactly the one allowed skill (create-component etc. dropped).
    assert.ok(/\[ACTIVE SKILLS[^\n]*\bi18n-text\b/.test(text), 'skills narrowed to i18n-text');
    assert.ok(!/\[ACTIVE SKILLS[^\n]*\bcreate-component\b/.test(text), 'out-of-scope skill dropped by the plan');
  });
});

test('subagent role context falls back to the full role scope when the feature is disabled', () => {
  withProject(null, (cwd) => {
    const RUN = '1700000000078';
    const sharedState: Record<string, unknown> = {
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'none' },
      onboardingComplete: true, currentRunId: RUN,
    };
    const fp = stackFingerprint(sharedState);
    sharedState.materializedStack = fp;
    const t1 = path.join(cwd, '.traffic-one');
    fs.mkdirSync(t1, { recursive: true });
    fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify(sharedState), 'utf8');
    writeLocalPrefs({ performance: { level: 'high', source: 'prompted' }, team: { mode: 'subagents', source: 'prompted', approved: true } });
    materializeFixture(cwd, 'default');
    fs.mkdirSync(path.join(t1, 'runs', RUN), { recursive: true });
    fs.writeFileSync(path.join(t1, 'runs', RUN, 'child-xyz.json'), JSON.stringify({
      version: 1, runId: RUN, claimId: 'senior-frontend-1-x', role: 'senior-frontend', spawnIndex: 1,
      status: 'claimed', sessionId: 'child-xyz', parentSessionId: 'parent-abc',
      createdAt: new Date().toISOString(), claimedAt: new Date().toISOString(), stackFingerprint: fp,
    }), 'utf8');
    writeOrchestrationPlan(cwd, {
      version: 1, runId: RUN, taskClass: 'minor', roster: ['senior-frontend'], graph: [['senior-frontend']],
      roles: { 'senior-frontend': { tier: 'cheapest', rules: ['rules/frontend/i18n.md'], skills: ['i18n-text'] } },
    });

    const prev = process.env.TRAFFIC_ONE_DISABLE_ORCHESTRATION;
    process.env.TRAFFIC_ONE_DISABLE_ORCHESTRATION = '1';
    try {
      const r = runSessionStart(subagentCtx(cwd));
      const text = r.kind === 'context' ? (r.context || '') : '';
      // Disabled ⇒ the plan is ignored; the full stack-active skill set returns (not narrowed).
      assert.ok(/senior-frontend \(run 1700000000078\)/.test(text), 'resolved the senior-frontend role context');
      assert.ok(/\[ACTIVE SKILLS[^\n]*\bcreate-component\b/.test(text), 'disabled feature → full role skill scope');
    } finally {
      if (prev === undefined) delete process.env.TRAFFIC_ONE_DISABLE_ORCHESTRATION;
      else process.env.TRAFFIC_ONE_DISABLE_ORCHESTRATION = prev;
    }
  });
});
