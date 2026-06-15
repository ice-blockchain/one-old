import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { applyAnswer, buildTeamLineup, computeOnboarding } from '../flow';
import { mergeProjectPrefs, readGlobalCodeGraphProvider, readProjectPrefs, readState, writeGlobalCodeGraphProvider, writeState } from '../../state';

const HOST_ENV_KEYS = [
  'CURSOR_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CODEX_THREAD_ID',
] as const;

function withProject(committed: Record<string, unknown> | null, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-flow-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = process.env.TRAFFIC_ONE_STATE_PATH;
  const prevHostEnv = new Map<string, string | undefined>();
  for (const key of HOST_ENV_KEYS) {
    prevHostEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  // codeGraphProvider is machine-wide now — isolate one.json so applyAnswer's
  // writeGlobalCodeGraphProvider never touches the real ~/.traffic-one.
  process.env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  // Pin the detected plan so plan-aware line-up / recommendation assertions are
  // deterministic across machines; tests needing another plan override it inline.
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  process.env.TRAFFIC_ONE_USER_PLAN = 'max';
  if (committed) {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(committed), 'utf8');
  }
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    if (prevState === undefined) delete process.env.TRAFFIC_ONE_STATE_PATH;
    else process.env.TRAFFIC_ONE_STATE_PATH = prevState;
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
    else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    for (const [key, value] of prevHostEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const asRec = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
type TeamMember = ReturnType<typeof buildTeamLineup>[number];

function requireRole(by: Record<string, TeamMember>, role: string): TeamMember {
  const member = by[role];
  assert.ok(member, `missing ${role}`);
  return member;
}

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
    assert.deepEqual(cg.task, { kind: 'onboarding-toolchain' });

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
    // codeGraphProvider is machine-wide (one.json), not a per-project pref.
    assert.equal(readGlobalCodeGraphProvider(), 'gitnexus');
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
    assert.equal(readGlobalCodeGraphProvider(), 'graphify');
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
  const architect = requireRole(by, 'senior-architect');
  const tester = requireRole(by, 'senior-tester');
  const shipper = requireRole(by, 'senior-shipper');
  assert.deepEqual({ tier: architect.tier, model: architect.model }, { tier: 'highest', model: 'opus' });
  assert.deepEqual({ tier: tester.tier, model: tester.model }, { tier: 'cheapest', model: 'haiku' });
  assert.deepEqual({ tier: shipper.tier, model: shipper.model }, { tier: 'balanced', model: 'sonnet' });
  assert.ok(architect.label === 'Architect' && architect.blurb.length > 0);
});

test('buildTeamLineup: balanced uses sonnet for builders, haiku for tester', () => {
  const by = Object.fromEntries(buildTeamLineup('balanced', 'claude').map((m) => [m.role, m]));
  assert.equal(requireRole(by, 'senior-frontend').model, 'sonnet');
  assert.equal(requireRole(by, 'senior-tester').model, 'haiku');
});

test('buildTeamLineup: host changes the concrete model ids (codex)', () => {
  const by = Object.fromEntries(buildTeamLineup('high', 'codex').map((m) => [m.role, m]));
  assert.equal(requireRole(by, 'senior-architect').model, 'gpt-5.5');
  assert.equal(requireRole(by, 'senior-tester').model, 'gpt-5.4-mini');
});

test('buildTeamLineup: low (main-agent) has no subagent line-up', () => {
  assert.deepEqual(buildTeamLineup('low', 'claude'), []);
  assert.deepEqual(buildTeamLineup('nonsense', 'claude'), []);
});

test('buildTeamLineup: a per-role tier override is honored', () => {
  const by = Object.fromEntries(buildTeamLineup('high', 'claude', { 'senior-tester': 'highest' }).map((m) => [m.role, m]));
  // tester is normally cheapest/haiku; the override promotes it
  const tester = requireRole(by, 'senior-tester');
  assert.deepEqual({ tier: tester.tier, model: tester.model }, { tier: 'highest', model: 'opus' });
});

test('computeOnboarding: the team-confirmation step carries the resolved line-up', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    const view = computeOnboarding(cwd);
    assert.equal(view.step, 'team-confirmation');
    assert.equal(view.meta.performanceLevel, 'high');
    assert.equal(view.meta.recommendedTier, 'highest'); // pinned plan 'max' → highest headline tier
    assert.ok(Array.isArray(view.meta.team) && view.meta.team?.length === 6);
    const architect = view.meta.team?.find((m) => m.role === 'senior-architect');
    assert.equal(architect?.model, 'opus');
    // host is resolved (defaults to claude outside a host process) so the UI can label it
    assert.equal(view.meta.host, 'claude');
    // the approve/re-pick options are still present
    assert.deepEqual(view.meta.options?.map((o) => o.id), ['approve', 'repick_performance']);
  });
});

test('team step carries the host model menu (modelChoices) so each agent is selectable', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    const view = computeOnboarding(cwd);
    assert.equal(view.step, 'team-confirmation');
    // claude (default host) → opus/sonnet/haiku, one entry per capability tier.
    assert.deepEqual(view.meta.modelChoices, [
      { tier: 'highest', model: 'opus' },
      { tier: 'balanced', model: 'sonnet' },
      { tier: 'cheapest', model: 'haiku' },
    ]);
  });
});

test('team step model menu follows the detected host (codex → gpt-5.x)', () => {
  withProject(null, (cwd) => {
    process.env.CODEX_PLUGIN_ROOT = '/tmp/codex-root';
    try {
      applyAnswer(cwd, 'open-code', 'not_now');
      applyAnswer(cwd, 'performance', 'high');
      const view = computeOnboarding(cwd);
      assert.equal(view.meta.host, 'codex');
      assert.deepEqual(view.meta.modelChoices?.map((c) => c.model), ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
    } finally {
      delete process.env.CODEX_PLUGIN_ROOT;
    }
  });
});

test('team approve with per-agent model overrides persists them under team.overrides', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    // The wizard sends only the roles the user changed away from the shown default.
    assert.ok(applyAnswer(cwd, 'team-confirmation', { action: 'approve', overrides: { 'senior-tester': 'highest' } }).ok);
    const team = asRec(readProjectPrefs(cwd).team);
    assert.equal(team.approved, true);
    assert.deepEqual(asRec(team.overrides), { 'senior-tester': 'highest' });
    // …and that stored override drives the resolved line-up (tester jumps to opus).
    const lineup = buildTeamLineup('high', 'claude', asRec(team.overrides));
    assert.equal(lineup.find((m) => m.role === 'senior-tester')?.model, 'opus');
  });
});

test('team approve with an empty overrides object stores no overrides', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    assert.ok(applyAnswer(cwd, 'team-confirmation', { action: 'approve', overrides: {} }).ok);
    const team = asRec(readProjectPrefs(cwd).team);
    assert.equal(team.approved, true);
    assert.equal(team.overrides, undefined);
  });
});

test('team step reads as a single "Start the build" confirmation (continue alias approves)', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    const view = computeOnboarding(cwd);
    assert.equal(view.step, 'team-confirmation');
    assert.equal(view.meta.title, 'Your team');
    assert.deepEqual(view.meta.options?.map((o) => o.label), ['Start the build', 'Re-pick performance']);
    // "Start the build" (continue) is the single confirmation — it approves the team.
    assert.ok(applyAnswer(cwd, 'team-confirmation', { action: 'continue' }).ok);
    assert.equal(asRec(readProjectPrefs(cwd).team).approved, true);
    assert.equal(computeOnboarding(cwd).step, 'project-context');
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

test('plan-aware line-up: free runs the team cheaper than the (max-shaped) default', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    process.env.TRAFFIC_ONE_USER_PLAN = 'free';
    const view = computeOnboarding(cwd);
    const by = Object.fromEntries((view.meta.team || []).map((m) => [m.role, m]));
    // headline plan tier (free) is surfaced for the wizard; per-role tiers may differ
    assert.equal(view.meta.recommendedTier, 'cheapest');
    // free + high: builders drop to balanced/sonnet; the hand-tuned tester stays cheapest
    assert.equal(requireRole(by, 'senior-architect').tier, 'balanced');
    assert.equal(requireRole(by, 'senior-architect').model, 'sonnet');
    assert.equal(requireRole(by, 'senior-tester').tier, 'cheapest');
  });
});

test('plan-aware performance step: the recommended option follows the plan', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    process.env.TRAFFIC_ONE_USER_PLAN = 'free';
    const view = computeOnboarding(cwd);
    assert.equal(view.step, 'performance');
    assert.equal(view.meta.recommendedLevel, 'low');
    assert.equal(view.meta.recommendedTier, 'cheapest'); // headline plan tier surfaced on the step
    assert.equal(view.meta.options?.[0]?.id, 'low'); // recommended floats to the top
    assert.ok(/Recommended/.test(view.meta.options?.[0]?.hint || ''));
  });
});

test('plan-aware performance step: OpenCode bumps the recommendation only once it is installed', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'enable');
    process.env.TRAFFIC_ONE_USER_PLAN = 'free';
    // Enabled but NOT installed yet → no tier-shift (don't promise pricier
    // models for an offload that can't run). free plan recommends 'low'.
    assert.equal(computeOnboarding(cwd).meta.recommendedLevel, 'low');
    // Once OpenCode is actually installed (stamped), the recommendation bumps.
    mergeProjectPrefs(cwd, { toolchain: { opencode: { installedVersion: '1.15.13', installedAt: '2026-01-01T00:00:00Z' } } });
    const view = computeOnboarding(cwd);
    assert.equal(view.meta.recommendedLevel, 'balanced'); // host-eligible OpenCode = one step up
    assert.equal(view.meta.options?.[0]?.id, 'balanced');
  });
});

test('plan-aware performance step: Codex bumps the OpenCode recommendation like every host (host-agnostic)', () => {
  withProject(null, (cwd) => {
    process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Codex Desktop';
    process.env.TRAFFIC_ONE_USER_PLAN = 'free';
    applyAnswer(cwd, 'open-code', 'enable');
    mergeProjectPrefs(cwd, { toolchain: { opencode: { installedVersion: '1.15.13', installedAt: '2026-01-01T00:00:00Z' } } });

    // Installed OpenCode bumps the recommendation on Codex exactly as elsewhere —
    // no per-host / per-model gate.
    const view = computeOnboarding(cwd);
    assert.equal(view.meta.host, 'codex');
    assert.equal(view.meta.recommendedLevel, 'balanced');
    assert.equal(view.meta.options?.[0]?.id, 'balanced');
  });
});

test('open-code answer records the delegation authorization in committed .one.json (not just prefs)', () => {
  withProject({ mode: 'existing-codebase' }, (cwd) => {
    assert.ok(applyAnswer(cwd, 'open-code', 'enable').ok);
    const one = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(one.openCodeDelegation?.approved, true);
    assert.equal(one.openCodeDelegation?.source, 'onboarding');
    assert.ok(one.openCodeDelegation?.decidedAt);
    // prefs still carry the per-user toggle
    const prefs = JSON.parse(fs.readFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, 'utf8'));
    assert.equal(prefs.openCode?.enabled, true);
  });
});

test('open-code "not now" records approved:false (an explicit decision, not an omission)', () => {
  withProject({ mode: 'existing-codebase' }, (cwd) => {
    assert.ok(applyAnswer(cwd, 'open-code', 'not_now').ok);
    const one = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one', '.one.json'), 'utf8'));
    assert.equal(one.openCodeDelegation?.approved, false);
  });
});

// ── Skipped code-graph step must still run the install task ──────────────────────
// On any machine after its first project, codeGraphProvider is already set
// machine-wide, the code-graph step never surfaces, and the install task used to
// never fire — leaving OpenCode unstamped in the new project's prefs and
// delegation silently inactive for the whole first build (observed 2026-06-12 on
// Codex). The flow's terminal answer now fires the task whenever an opted-in
// tool is unstamped.

test('new-project: skipped code-graph step fires the install task at finalize', () => {
  withProject(null, (cwd) => {
    writeGlobalCodeGraphProvider('gitnexus'); // a previous project chose it
    applyAnswer(cwd, 'open-code', 'enable');
    applyAnswer(cwd, 'performance', 'balanced');
    applyAnswer(cwd, 'team-confirmation', { action: 'approve' });
    applyAnswer(cwd, 'project-context', { answers: {}, summary: 'a web app' });
    applyAnswer(cwd, 'mobile', 'web_only');
    // code-graph is pre-resolved: the wizard goes straight to finalize…
    assert.equal(computeOnboarding(cwd).step, 'finalize');
    // …and finalize must kick the consolidated install (OpenCode enabled, unstamped).
    const fin = applyAnswer(cwd, 'finalize', null);
    assert.ok(fin.ok);
    assert.deepEqual(fin.task, { kind: 'onboarding-toolchain' });
  });
});

test('new-project: finalize fires no task when the opted-in toolchain is already stamped', () => {
  withProject(null, (cwd) => {
    writeGlobalCodeGraphProvider('gitnexus');
    mergeProjectPrefs(cwd, { toolchain: { gitnexus: { installedVersion: '1.6.4' } } });
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'low');
    applyAnswer(cwd, 'project-context', { answers: {}, summary: 'x' });
    applyAnswer(cwd, 'mobile', 'web_only');
    const fin = applyAnswer(cwd, 'finalize', null);
    assert.ok(fin.ok);
    assert.equal(fin.task, undefined);
  });
});

test('new-project: mid-wizard answers never fire the install task (no stack committed yet)', () => {
  withProject(null, (cwd) => {
    writeGlobalCodeGraphProvider('gitnexus');
    const first = applyAnswer(cwd, 'open-code', 'enable');
    assert.ok(first.ok);
    // Firing here would block the wizard's next question on a minutes-long install.
    assert.equal(first.task, undefined);
  });
});

test('existing project: skipped code-graph fires the install task on the last preference answer', () => {
  withProject({ mode: 'existing-codebase', stack: 'minimal', frontend: 'none', backend: 'other', onboardingComplete: true }, (cwd) => {
    writeGlobalCodeGraphProvider('gitnexus');
    mergeProjectPrefs(cwd, { toolchain: { gitnexus: { installedVersion: '1.6.4' } } });
    applyAnswer(cwd, 'open-code', 'enable');
    const last = applyAnswer(cwd, 'performance', 'low');
    assert.ok(last.ok);
    assert.deepEqual(last.task, { kind: 'onboarding-toolchain' });
    assert.equal(computeOnboarding(cwd).done, true);
  });
});
