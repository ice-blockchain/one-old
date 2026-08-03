import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { opencodeSubagentBind } from '../opencode-subagent-bind';
import { readEffectiveState, resolveRunAgentContext } from '../../../shared/state';
import type { Ctx, HookInput, HostId } from '../../../core/types';
import { hostScopedPerformancePrefs } from '../../../test-support/host-prefs';
import { ensureRunModelPolicy } from '../../../shared/run-model-policy';

function withProject(stateExtra: Record<string, unknown>, fn: (cwd: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-oc-bind-')));
  const env = process.env;
  const previous = {
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: env.TRAFFIC_ONE_STATE_PATH,
    xdgState: env.XDG_STATE_HOME,
    plan: env.TRAFFIC_ONE_USER_PLAN,
  };
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.XDG_STATE_HOME = path.join(dir, 'state');
  env.TRAFFIC_ONE_USER_PLAN = 'free';
  const { team: teamExtra, performance: performanceExtra, ...sharedExtra } = stateExtra;
  const team = teamExtra && typeof teamExtra === 'object'
    ? teamExtra as Record<string, unknown>
    : { mode: 'subagents', source: 'prompted', approved: true };
  const performance = performanceExtra && typeof performanceExtra === 'object'
    ? performanceExtra as Record<string, unknown>
    : { level: team.mode === 'main-agent' ? 'low' : 'high', source: 'prompted' };
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none',
    currentRunId: '1782492658872',
    ...sharedExtra,
  }), 'utf8');
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(
    hostScopedPerformancePrefs(performance, team, 'free'),
  ), 'utf8');
  try {
    fn(dir);
  } finally {
    if (previous.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = previous.prefs;
    if (previous.state === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = previous.state;
    if (previous.xdgState === undefined) delete env.XDG_STATE_HOME; else env.XDG_STATE_HOME = previous.xdgState;
    if (previous.plan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = previous.plan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function freezeRunPolicy(cwd: string, host: 'opencode' | 'kilo'): void {
  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: host });
  assert.ok(
    ensureRunModelPolicy(cwd, '1782492658872', host, state, { ...process.env, TRAFFIC_ONE_HOST: host }),
    `test fixture could not freeze ${host} run policy`,
  );
}

function ctxFor(cwd: string, prompt: string, sessionId: string, host: HostId = 'opencode'): Ctx {
  const input: HookInput = {
    event: 'UserPromptSubmit', host, cwd, prompt,
    raw: { session_id: sessionId, prompt },
  };
  return { input, host, cwd, now: () => 'x' } as unknown as Ctx;
}

function readState(cwd: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
}

test('opencode subagent bind: a [t1-role:] spawn prompt claims the child session → its writes resolve', () => {
  withProject({}, (cwd) => {
    freezeRunPolicy(cwd, 'opencode');
    const prompt = '[t1-role: senior-frontend]\n\nYou are the Senior Frontend Engineer. Run ID: 1782492658872';
    opencodeSubagentBind(ctxFor(cwd, prompt, 'ses_child_fe'));
    // The child session is now a resolved senior-frontend claim — its tool writes
    // resolve instead of falling through to "main agent" (the tests/11d failure).
    const resolved = resolveRunAgentContext(cwd, readState(cwd), { session_id: 'ses_child_fe' }, { claimPending: false });
    assert.ok(resolved, 'claim resolves for the bound child session');
    assert.equal(resolved?.role, 'senior-frontend');
  });
});

test('opencode subagent bind: Kilo uses the same marker-based child-session claim path', () => {
  withProject({}, (cwd) => {
    freezeRunPolicy(cwd, 'kilo');
    const prompt = '[t1-role: senior-backend]\n\nYou are the Senior Backend Engineer. Run ID: 1782492658872';
    opencodeSubagentBind(ctxFor(cwd, prompt, 'ses_kilo_child_be', 'kilo'));
    const resolved = resolveRunAgentContext(cwd, readState(cwd), { session_id: 'ses_kilo_child_be' }, { claimPending: false });
    assert.ok(resolved, 'claim resolves for the Kilo-bound child session');
    assert.equal(resolved?.role, 'senior-backend');
  });
});

test('opencode subagent bind: no role marker → no claim (orchestrator/user prompts are untouched)', () => {
  withProject({}, (cwd) => {
    opencodeSubagentBind(ctxFor(cwd, 'create a modern learning platform with courses', 'ses_orchestrator'));
    assert.equal(resolveRunAgentContext(cwd, readState(cwd), { session_id: 'ses_orchestrator' }, { claimPending: false }), null);
  });
});

test('opencode subagent bind: inert on other hosts (they bind via SubagentStart)', () => {
  withProject({}, (cwd) => {
    opencodeSubagentBind(ctxFor(cwd, '[t1-role: senior-backend]\nYou are senior-backend', 'ses_claude_child', 'claude'));
    assert.equal(resolveRunAgentContext(cwd, readState(cwd), { session_id: 'ses_claude_child' }, { claimPending: false }), null);
  });
});

test('opencode subagent bind: inert outside subagents mode', () => {
  withProject({ team: { mode: 'main-agent', source: 'prompted' } }, (cwd) => {
    opencodeSubagentBind(ctxFor(cwd, '[t1-role: senior-frontend]\nYou are senior-frontend', 'ses_main_child'));
    assert.equal(resolveRunAgentContext(cwd, readState(cwd), { session_id: 'ses_main_child' }, { claimPending: false }), null);
  });
});
