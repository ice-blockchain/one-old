import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { applyAnswer, buildTeamLineup, computeOnboarding } from '../flow';
import { readProjectPrefs, readState, writeState } from '../../state';

function withProject(committed: Record<string, unknown> | null, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-flow-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  if (committed) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(committed), 'utf8');
  }
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const asRec = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});

test('new-project: the full wizard sequence completes onboarding', () => {
  withProject(null, (cwd) => {
    assert.equal(computeOnboarding(cwd).step, 'open-code');
    assert.ok(applyAnswer(cwd, 'open-code', 'not_now').ok);

    assert.equal(computeOnboarding(cwd).step, 'performance');
    assert.ok(applyAnswer(cwd, 'performance', 'high').ok);

    assert.equal(computeOnboarding(cwd).step, 'team-confirmation');
    assert.ok(applyAnswer(cwd, 'team-confirmation', { action: 'approve' }).ok);

    assert.equal(computeOnboarding(cwd).step, 'project-context');
    assert.ok(applyAnswer(cwd, 'project-context', { answers: { audience: 'devs' }, summary: 'a dev tool' }).ok);

    assert.equal(computeOnboarding(cwd).step, 'mobile');
    assert.ok(applyAnswer(cwd, 'mobile', 'web_only').ok);

    assert.equal(computeOnboarding(cwd).step, 'code-graph');
    const cg = applyAnswer(cwd, 'code-graph', 'gitnexus');
    assert.ok(cg.ok);
    assert.deepEqual(cg.task, { kind: 'code-graph', provider: 'gitnexus' });

    assert.equal(computeOnboarding(cwd).step, 'finalize');
    assert.ok(applyAnswer(cwd, 'finalize', null).ok);

    const view = computeOnboarding(cwd);
    assert.equal(view.done, true);
    assert.equal(view.step, null);

    const committed = readState(cwd);
    assert.equal(committed.onboardingComplete, true);
    assert.equal(typeof committed.stack, 'string');

    const prefs = readProjectPrefs(cwd);
    assert.equal(asRec(prefs.openCode).enabled, false);
    assert.equal(asRec(prefs.performance).level, 'high');
    assert.equal(asRec(prefs.team).approved, true);
    assert.equal(prefs.codeGraphProvider, 'gitnexus');
  });
});

test('new-project: performance "low" skips the team-confirmation step', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'low');
    assert.equal(computeOnboarding(cwd).step, 'project-context');
  });
});

test('new-project: team-confirmation "re-pick" returns to the performance step', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    assert.equal(computeOnboarding(cwd).step, 'team-confirmation');
    applyAnswer(cwd, 'team-confirmation', { action: 'repick_performance' });
    assert.equal(computeOnboarding(cwd).step, 'performance');
  });
});

test('existing project: only the local-preference steps are asked, then done', () => {
  const committed = {
    mode: 'existing-codebase',
    stack: 'minimal',
    frontend: 'none',
    backend: 'other',
    realtime: 'none',
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-01-01T00:00:00Z',
  };
  withProject(committed, (cwd) => {
    assert.equal(computeOnboarding(cwd).step, 'open-code');
    applyAnswer(cwd, 'open-code', 'enable');
    assert.equal(computeOnboarding(cwd).step, 'performance');
    applyAnswer(cwd, 'performance', 'low');
    // low ⇒ main-agent ⇒ no team confirmation
    assert.equal(computeOnboarding(cwd).step, 'code-graph');
    applyAnswer(cwd, 'code-graph', 'graphify');
    const view = computeOnboarding(cwd);
    assert.equal(view.done, true);
    assert.equal(view.step, null);
    assert.equal(readProjectPrefs(cwd).codeGraphProvider, 'graphify');
  });
});

test('invalid answers are rejected', () => {
  withProject(null, (cwd) => {
    assert.equal(applyAnswer(cwd, 'performance', 'turbo').ok, false);
    assert.equal(applyAnswer(cwd, 'code-graph', 'neo4j').ok, false);
    assert.equal(applyAnswer(cwd, 'mobile', 'smartwatch').ok, false);
    assert.equal(applyAnswer(cwd, 'nonsense-step', 'x').ok, false);
  });
});

test('finalize derives the stack from the seeded original prompt (not minimal)', () => {
  withProject(null, (cwd) => {
    // UserPromptSubmit seeds the request before the wizard runs:
    writeState(cwd, { mode: 'new-project', originalPrompt: 'create a modern learning platform with courses and an admin area to manage courses and users' });
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'low');
    applyAnswer(cwd, 'project-context', { summary: '', answers: {} }); // user left the form blank
    applyAnswer(cwd, 'mobile', 'web_only');
    applyAnswer(cwd, 'code-graph', 'gitnexus');
    assert.equal(computeOnboarding(cwd).step, 'finalize');
    applyAnswer(cwd, 'finalize', null);
    const s = readState(cwd);
    assert.equal(s.stack, 'default');
    assert.equal(s.frontend, 'react-vite');
    assert.equal(s.backend, 'supabase');
    // summary falls back to the prompt, not the "MVP" placeholder
    assert.ok(String(asRec(s.projectContext).summary).includes('learning platform'));
  });
});

test('buildTeamLineup: high performance maps each role to its tier + claude model', () => {
  const team = buildTeamLineup('high', 'claude');
  assert.equal(team.length, 6);
  assert.deepEqual(team.map((m) => m.role), [
    'senior-architect', 'senior-frontend', 'senior-backend', 'senior-reviewer', 'senior-tester', 'senior-shipper',
  ]);
  const by = Object.fromEntries(team.map((m) => [m.role, m]));
  assert.deepEqual({ tier: by['senior-architect'].tier, model: by['senior-architect'].model }, { tier: 'highest', model: 'opus' });
  assert.deepEqual({ tier: by['senior-tester'].tier, model: by['senior-tester'].model }, { tier: 'cheapest', model: 'haiku' });
  assert.deepEqual({ tier: by['senior-shipper'].tier, model: by['senior-shipper'].model }, { tier: 'balanced', model: 'sonnet' });
  assert.ok(by['senior-architect'].label === 'Architect' && by['senior-architect'].blurb.length > 0);
});

test('buildTeamLineup: balanced uses sonnet for builders, haiku for tester', () => {
  const by = Object.fromEntries(buildTeamLineup('balanced', 'claude').map((m) => [m.role, m]));
  assert.equal(by['senior-frontend'].model, 'sonnet');
  assert.equal(by['senior-tester'].model, 'haiku');
});

test('buildTeamLineup: host changes the concrete model ids (codex)', () => {
  const by = Object.fromEntries(buildTeamLineup('high', 'codex').map((m) => [m.role, m]));
  assert.equal(by['senior-architect'].model, 'gpt-5.5');
  assert.equal(by['senior-tester'].model, 'gpt-5-mini');
});

test('buildTeamLineup: low (main-agent) has no subagent line-up', () => {
  assert.deepEqual(buildTeamLineup('low', 'claude'), []);
  assert.deepEqual(buildTeamLineup('nonsense', 'claude'), []);
});

test('buildTeamLineup: a per-role tier override is honored', () => {
  const by = Object.fromEntries(buildTeamLineup('high', 'claude', { 'senior-tester': 'highest' }).map((m) => [m.role, m]));
  // tester is normally cheapest/haiku — the override promotes it
  assert.deepEqual({ tier: by['senior-tester'].tier, model: by['senior-tester'].model }, { tier: 'highest', model: 'opus' });
});

test('computeOnboarding: the team-confirmation step carries the resolved line-up', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    const view = computeOnboarding(cwd);
    assert.equal(view.step, 'team-confirmation');
    assert.equal(view.meta.performanceLevel, 'high');
    assert.ok(Array.isArray(view.meta.team) && view.meta.team?.length === 6);
    const architect = view.meta.team?.find((m) => m.role === 'senior-architect');
    assert.equal(architect?.model, 'opus');
    // host is resolved (defaults to claude outside a host process) so the UI can label it
    assert.equal(view.meta.host, 'claude');
    // the approve/re-pick options are still present
    assert.deepEqual(view.meta.options?.map((o) => o.id), ['approve', 'repick_performance']);
  });
});

test('existing project: the team step also carries the resolved line-up', () => {
  const committed = {
    mode: 'existing-codebase', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    realtime: 'none', confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z',
  };
  withProject(committed, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'balanced');
    const view = computeOnboarding(cwd);
    assert.equal(view.step, 'team-confirmation');
    assert.equal(view.meta.team?.length, 6);
    assert.equal(view.meta.team?.find((m) => m.role === 'senior-frontend')?.model, 'sonnet');
  });
});

test('finalize falls back to the MVP answers when no prompt was captured', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'low');
    applyAnswer(cwd, 'project-context', { summary: '', answers: { coreFlows: 'users sign up, browse a marketplace of listings, checkout with payments' } });
    applyAnswer(cwd, 'mobile', 'web_only');
    applyAnswer(cwd, 'code-graph', 'gitnexus');
    applyAnswer(cwd, 'finalize', null);
    // marketplace + payments + signup → backend needed → default stack, not minimal
    assert.equal(readState(cwd).stack, 'default');
  });
});
