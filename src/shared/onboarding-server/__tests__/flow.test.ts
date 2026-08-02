import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { applyAnswer, buildTeamLineup, computeOnboarding } from '../flow';
import { recordPluginUseChoice } from '../../state/plugin-use';
import { writeSimpleAuth } from '../../auth';
import { hostModelSnapshot, modelTierSnapshot, resolveModel } from '../../model-tiers';

// Derived, never hardcoded: which model anchors a tier is editable policy.
const CLAUDE_HIGHEST = resolveModel('highest', 'claude') as string;
import { mergeProjectHostPrefs, mergeProjectPrefs, projectRootHash, readGlobalCodeGraphProvider, readProjectPrefs, readState, writeGlobalCodeGraphProvider, writeState } from '../../state';
import { currentHostModelTarget } from '../../current-model-tiers';
import { writeRuntimeModelSnapshot } from '../../__tests__/support/one-mcp-runtime';

const HOST_ENV_KEYS = [
  'TRAFFIC_ONE_HOST',
  'CURSOR_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CODEX_THREAD_ID',
  'TRAFFIC_ONE_WINDSURF_BACKEND',
] as const;

function withProject(committed: Record<string, unknown> | null, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-flow-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = process.env.TRAFFIC_ONE_STATE_PATH;
  const prevXdgStateHome = process.env.XDG_STATE_HOME;
  const prevHostEnv = new Map<string, string | undefined>();
  for (const key of HOST_ENV_KEYS) {
    prevHostEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  // codeGraphProvider is machine-wide now — isolate one.json so applyAnswer's
  // writeGlobalCodeGraphProvider never touches the real ~/.traffic-one.
  process.env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  process.env.XDG_STATE_HOME = path.join(dir, 'state');
  // This suite exercises post-auth wizard sequencing. The API-key gate itself
  // has dedicated flow/routes tests, so enable canonical auth explicitly here.
  writeSimpleAuth('sk-flow-fixture');
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
    if (prevXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdgStateHome;
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
const hostPrefs = (prefs: unknown, host = 'claude'): Record<string, unknown> => asRec(asRec(asRec(prefs).hosts)[host]);
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
    assert.equal(asRec(hostPrefs(prefs).performance).level, 'high');
    assert.equal(asRec(hostPrefs(prefs).team).approved, true);
    assert.equal(asRec(asRec(hostPrefs(prefs).performance).target).plan, 'max');
    assert.match(String(asRec(asRec(hostPrefs(prefs).performance).target).appliedFingerprint), /^[a-f0-9]{64}$/);
    assert.equal(asRec(asRec(hostPrefs(prefs).performance).target).configVersion, 0);
    // codeGraphProvider is machine-wide (one.json), not a per-project pref.
    assert.equal(readGlobalCodeGraphProvider(), 'gitnexus');
  });
});

test('all hosts: onboarding shows the plan recommendation and persists only the active host', () => {
  const cases = [
    { host: 'claude', plan: 'pro', level: 'balanced', tier: 'balanced' },
    { host: 'codex', plan: 'plus', level: 'balanced', tier: 'balanced' },
    { host: 'codex', plan: 'prolite', level: 'high', tier: 'highest' },
    { host: 'cursor', plan: 'pro', level: 'balanced', tier: 'balanced' },
    { host: 'opencode', plan: 'plus', level: 'balanced', tier: 'balanced' },
    { host: 'copilot', plan: 'pro', level: 'balanced', tier: 'balanced' },
    { host: 'windsurf', plan: 'pro', level: 'balanced', tier: 'balanced' },
    { host: 'kilo', plan: 'free', level: 'low', tier: 'cheapest' },
  ] as const;

  for (const c of cases) {
    withProject(null, (cwd) => {
      process.env.TRAFFIC_ONE_HOST = c.host;
      process.env.TRAFFIC_ONE_USER_PLAN = c.plan;

      const selfHost = c.host === 'opencode' || c.host === 'kilo';
      assert.equal(computeOnboarding(cwd).step, selfHost ? 'performance' : 'open-code', c.host);
      if (!selfHost) assert.equal(applyAnswer(cwd, 'open-code', 'not_now').ok, true, c.host);

      const performance = computeOnboarding(cwd);
      assert.equal(performance.step, 'performance', c.host);
      assert.equal(performance.meta.host, c.host, c.host);
      assert.equal(performance.meta.recommendedLevel, c.level, c.host);
      assert.equal(performance.meta.recommendedTier, c.tier, c.host);
      assert.equal(performance.meta.options?.[0]?.id, c.level, c.host);

      assert.equal(applyAnswer(cwd, 'performance', c.level).ok, true, c.host);
      if (c.level === 'low') {
        assert.equal(computeOnboarding(cwd).step, 'project-context', c.host);
      } else {
        assert.equal(computeOnboarding(cwd).step, 'team-confirmation', c.host);
        assert.equal(applyAnswer(cwd, 'team-confirmation', { action: 'approve' }).ok, true, c.host);
      }

      assert.equal(applyAnswer(cwd, 'project-context', { summary: 'app', answers: { audience: 'teams' } }).ok, true, c.host);
      assert.equal(applyAnswer(cwd, 'mobile', 'web_only').ok, true, c.host);
      assert.equal(applyAnswer(cwd, 'code-graph', 'gitnexus').ok, true, c.host);
      assert.equal(applyAnswer(cwd, 'finalize', null).ok, true, c.host);
      assert.equal(computeOnboarding(cwd).done, true, c.host);

      const prefs = readProjectPrefs(cwd);
      const hosts = asRec(prefs.hosts);
      assert.deepEqual(Object.keys(hosts), [c.host], c.host);
      const active = hostPrefs(prefs, c.host);
      assert.equal(asRec(active.performance).level, c.level, c.host);
      assert.equal(asRec(active.team).mode, c.level === 'low' ? 'main-agent' : 'subagents', c.host);
      if (c.level !== 'low') assert.equal(asRec(active.team).approved, true, c.host);
      assert.equal(
        asRec(asRec(active.performance).target).plan,
        c.plan === 'prolite' ? 'pro' : c.plan,
        c.host,
      );
      assert.match(String(asRec(asRec(active.performance).target).appliedFingerprint), /^[a-f0-9]{64}$/, c.host);
      assert.equal(asRec(asRec(active.performance).target).configVersion, 0, c.host);
      assert.equal(readGlobalCodeGraphProvider(), 'gitnexus', c.host);
    });
  }
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

// The ask-first flow answers consent and runs `--use --bootstrap-only` in the
// SAME session, before SessionStart ever stamps detection — so state has no
// `stack` when done is computed. That must NOT read as "setup complete": it
// skipped the entire wizard (OpenCode, performance, team, code graph) for every
// existing codebase on an already-authenticated machine, including any project
// whose .traffic-one was deleted for a re-setup.
test('existing codebase with a detectable but unstamped stack still gets the wizard', () => {
  withProject(null, (cwd) => {
    // A real Laravel repo: composer manifest + enough source files that
    // detectMode says existing-codebase, but NO .one.json (never stamped).
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^11.0' } }), 'utf8');
    fs.mkdirSync(path.join(cwd, 'app'), { recursive: true });
    for (let i = 0; i < 7; i += 1) {
      fs.writeFileSync(path.join(cwd, 'app', `Model${i}.php`), '<?php\n', 'utf8');
    }
    recordPluginUseChoice(cwd, true, 'command');

    const view = computeOnboarding(cwd);
    assert.equal(view.mode, 'existing-codebase');
    assert.equal(view.done, false, 'an unstamped but detectable stack must not read as setup complete');
    assert.equal(view.step, 'open-code', 'the wizard starts at the first local-preference step');
  });
});

test('existing dir where detection finds nothing routes to AGENT classification (tech-detect)', () => {
  withProject(null, (cwd) => {
    // >5 source files so detectMode says existing-codebase, but no framework
    // manifests — detectStackFromCodebase finds no stack. This used to read as
    // done (the half-onboarded hole): now the session agent must classify.
    fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
    for (let i = 0; i < 7; i += 1) {
      fs.writeFileSync(path.join(cwd, 'scripts', `util${i}.py`), 'print(1)\n', 'utf8');
    }
    recordPluginUseChoice(cwd, true, 'command');

    const view = computeOnboarding(cwd);
    assert.equal(view.mode, 'existing-codebase');
    assert.equal(view.done, false, 'undetectable is no longer done — the agent classifies via --set-tech');
    assert.equal(view.step, 'tech-detect');
    assert.equal(view.meta?.kind, 'waiting', 'the wizard shows the passive waiting page for this step');
  });
});

test('existing project: plan/model drift reopens Performance while metadata-only advances do not', () => {
  const committed = {
    mode: 'existing-codebase', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    realtime: 'none', confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z',
  };
  withProject(committed, (cwd) => {
    process.env.TRAFFIC_ONE_HOST = 'codex';
    process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
    writeGlobalCodeGraphProvider('gitnexus');
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'balanced');
    applyAnswer(cwd, 'team-confirmation', { action: 'approve' });
    assert.equal(computeOnboarding(cwd).done, true);

    const beforePlanChange = fs.readFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, 'utf8');
    process.env.TRAFFIC_ONE_USER_PLAN = 'free';
    const planChanged = computeOnboarding(cwd);
    assert.equal(planChanged.step, 'performance');
    assert.equal(planChanged.meta.repickReason, 'plan-changed');
    assert.equal(planChanged.meta.previousPlan, 'pro');
    assert.equal(planChanged.meta.plan, 'free');
    assert.equal(planChanged.meta.host, 'codex');
    assert.equal(fs.readFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, 'utf8'), beforePlanChange);

    // Reconfigure for the new plan. Server metadata changes with identical
    // applied tiers must not spuriously reopen Performance.
    applyAnswer(cwd, 'performance', 'balanced');
    assert.equal(computeOnboarding(cwd).step, 'team-confirmation');
    applyAnswer(cwd, 'team-confirmation', { action: 'approve' });
    writeRuntimeModelSnapshot('codex', {
      ...hostModelSnapshot('codex', 'free'),
    }, process.env);
    const beforeMetadataChange = fs.readFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, 'utf8');
    assert.equal(computeOnboarding(cwd).done, true);
    assert.equal(fs.readFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, 'utf8'), beforeMetadataChange);

    // Changing a mapped tier changes the semantic fingerprint and reopens.
    const bundled = hostModelSnapshot('codex', 'free');
    writeRuntimeModelSnapshot('codex', {
      ...bundled,
      tiers: {
        ...bundled.tiers,
        highest: ['gpt-new-frontier', ...bundled.tiers.highest],
      },
    }, process.env, 2);
    const beforeCatalogChange = fs.readFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, 'utf8');
    const modelsChanged = computeOnboarding(cwd);
    assert.equal(modelsChanged.step, 'performance');
    assert.equal(modelsChanged.meta.repickReason, 'models-changed');
    // The Performance step no longer ships the tier-catalog card — repickReason
    // is the entire models-changed surface.
    assert.equal('catalogTiers' in modelsChanged.meta, false);
    assert.equal(fs.readFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, 'utf8'), beforeCatalogChange);
  });
});

test('performance and repick update only the active host and preserve Cursor availableModels', () => {
  withProject({ mode: 'existing-codebase', stack: 'default', onboardingComplete: true }, (cwd) => {
    writeGlobalCodeGraphProvider('gitnexus');
    mergeProjectPrefs(cwd, { openCode: { enabled: false, source: 'prompted', decidedAt: '2026-07-12T08:00:00Z' } });
    mergeProjectHostPrefs(cwd, 'cursor', {
      performance: {
        level: 'balanced',
        source: 'prompted',
        target: {
          plan: 'pro',
          appliedFingerprint: currentHostModelTarget('cursor', 'pro').appliedFingerprint,
          configVersion: currentHostModelTarget('cursor', 'pro').configVersion,
        },
      },
      team: { mode: 'subagents', source: 'prompted', approved: true },
      availableModels: {
        models: ['claude-opus-5-thinking-high', 'composer-2.5-fast'],
        capturedAt: '2026-07-12T08:00:00Z',
        target: {
          plan: 'pro',
          appliedFingerprint: currentHostModelTarget('cursor', 'pro').appliedFingerprint,
        },
      },
    });

    process.env.TRAFFIC_ONE_HOST = 'codex';
    process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
    applyAnswer(cwd, 'performance', 'high');
    assert.equal(asRec(asRec(hostPrefs(readProjectPrefs(cwd), 'codex').performance).target).plan, 'pro');
    assert.equal(computeOnboarding(cwd).step, 'team-confirmation');
    applyAnswer(cwd, 'team-confirmation', { action: 'repick_performance' });

    const prefs = readProjectPrefs(cwd);
    assert.equal(hostPrefs(prefs, 'codex').performance, undefined);
    assert.equal(hostPrefs(prefs, 'codex').team, undefined);
    assert.deepEqual(hostPrefs(prefs, 'cursor').availableModels, {
      models: ['claude-opus-5-thinking-high', 'composer-2.5-fast'],
      capturedAt: '2026-07-12T08:00:00Z',
      target: {
        plan: 'pro',
        appliedFingerprint: currentHostModelTarget('cursor', 'pro').appliedFingerprint,
      },
    });
    assert.equal(asRec(hostPrefs(prefs, 'cursor').team).approved, true);
  });
});

test('new project: complete shared state without local prefs still asks local-preference steps', () => {
  const committed = {
    mode: 'new-project',
    version: '2.9.226',
    originalPrompt: 'create a modern learning platform',
    projectContext: {
      source: 'prompted',
      originalPrompt: 'create a modern learning platform',
      summary: 'create a modern learning platform',
      answers: {},
      collectedAt: '2026-01-01T00:00:00Z',
    },
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-01-01T00:00:00Z',
    realtime: 'none',
    technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
    supabaseFunctionsAutoDeploy: 'ask',
    supabaseAddons: {},
  };
  withProject(committed, (cwd) => {
    writeGlobalCodeGraphProvider('gitnexus');
    assert.deepEqual(readProjectPrefs(cwd), {});
    assert.equal(computeOnboarding(cwd).done, false);
    assert.equal(computeOnboarding(cwd).step, 'open-code');

    process.argv.push('--host=opencode');
    try {
      assert.equal(computeOnboarding(cwd).done, false);
      assert.equal(computeOnboarding(cwd).step, 'performance');
    } finally {
      process.argv.pop();
    }
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

test('finalize persists an explicit React + Go prompt as a custom full stack immediately', () => {
  withProject(null, (cwd) => {
    const prompt = 'create a modern learning platform in react with go as backend with courses for web development. use latest tech, make it responsive. no admin area for now.';
    writeState(cwd, { mode: 'new-project', originalPrompt: prompt });
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'low');
    applyAnswer(cwd, 'project-context', { summary: '', answers: {} });
    applyAnswer(cwd, 'mobile', 'web_only');
    applyAnswer(cwd, 'code-graph', 'gitnexus');
    assert.equal(computeOnboarding(cwd).step, 'finalize');
    assert.ok(applyAnswer(cwd, 'finalize', null).ok);
    const s = readState(cwd);
    assert.equal(s.stack, 'custom-stack');
    assert.equal(s.frontend, 'react-vite');
    assert.equal(s.backend, 'go');
  });
});

test('finalize reconciles early Go artifacts before first SessionStart', () => {
  withProject(null, (cwd) => {
    writeState(cwd, { mode: 'new-project', originalPrompt: 'create a SaaS platform with auth and a dashboard' });
    fs.writeFileSync(path.join(cwd, 'go.mod'), 'module example.com/app\n', 'utf8');
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'low');
    applyAnswer(cwd, 'project-context', { summary: '', answers: {} });
    applyAnswer(cwd, 'mobile', 'web_only');
    applyAnswer(cwd, 'code-graph', 'gitnexus');
    assert.ok(applyAnswer(cwd, 'finalize', null).ok);
    const s = readState(cwd);
    assert.equal(s.stack, 'custom-backend');
    assert.equal(s.frontend, 'react-vite');
    assert.equal(s.backend, 'go');
    assert.ok(String((asRec(s).evidence as unknown[] | undefined)?.[0] || '').includes('Go backend artifacts'));
  });
});

test('finalize does not flip Supabase state for a stray .go file without a module marker', () => {
  withProject(null, (cwd) => {
    writeState(cwd, { mode: 'new-project', originalPrompt: 'create a SaaS platform with auth and a dashboard' });
    fs.mkdirSync(path.join(cwd, 'services', 'api'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'services', 'api', 'scratch.go'), 'package scratch\n', 'utf8');
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'low');
    applyAnswer(cwd, 'project-context', { summary: '', answers: {} });
    applyAnswer(cwd, 'mobile', 'web_only');
    applyAnswer(cwd, 'code-graph', 'gitnexus');
    assert.ok(applyAnswer(cwd, 'finalize', null).ok);
    const s = readState(cwd);
    assert.equal(s.stack, 'default');
    assert.equal(s.frontend, 'react-vite');
    assert.equal(s.backend, 'supabase');
  });
});

test('finalize: NO captured prompt + blank form does NOT collapse to minimal (the 9b regression)', () => {
  withProject(null, (cwd) => {
    // 9b reproduction: the Cursor user-prompt-submit hook no-op'd (no prompt text in the
    // host payload), so seedOriginalPrompt never ran and the wizard form was blank →
    // promptSignal === ''. Pre-fix this derived stack=minimal/none/none. The no-signal
    // floor must scaffold the default build stack instead (a build WAS intended).
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'low');
    applyAnswer(cwd, 'project-context', { summary: '', answers: {} });
    applyAnswer(cwd, 'mobile', 'web_only');
    applyAnswer(cwd, 'code-graph', 'gitnexus');
    assert.equal(computeOnboarding(cwd).step, 'finalize');
    applyAnswer(cwd, 'finalize', null);
    const s = readState(cwd);
    assert.notEqual(s.stack, 'minimal');
    assert.equal(s.stack, 'default');
    assert.equal(s.frontend, 'react-vite');
    assert.equal(s.backend, 'supabase');
  });
});

test('finalize: an EXPLICIT brochure request is preserved (the no-signal floor does not over-fire)', () => {
  withProject(null, (cwd) => {
    // "static landing page" carries promptHasStackSignal===true (wantsStaticSite),
    // so the floor must NOT fire — the intentional brochure shape is honored. It
    // is a FRONTEND with no backend, not a stack with no implementer.
    writeState(cwd, { mode: 'new-project', originalPrompt: 'a simple static landing page' });
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'low');
    applyAnswer(cwd, 'project-context', { summary: '', answers: {} });
    applyAnswer(cwd, 'mobile', 'web_only');
    applyAnswer(cwd, 'code-graph', 'gitnexus');
    applyAnswer(cwd, 'finalize', null);
    const s = readState(cwd);
    assert.equal(s.stack, 'custom-frontend');
    assert.equal(s.frontend, 'react-vite');
    assert.equal(s.backend, 'none');
  });
});

test('finalize: ionic + a brochure prompt lands on custom-frontend, not the Turborepo default', () => {
  withProject(null, (cwd) => {
    // The `if (stack === 'minimal') stack = 'default'` remap in deriveStack is gone
    // with the classifier arm that fed it. Ionic still forces a web frontend and a
    // backend, but it no longer PROMOTES the stack id: `default` carries the
    // pnpm/Turborepo contract (stateRequiresNewProjectMonorepo), and a brochure
    // brief never asked for one. This also removes a real inconsistency — the same
    // request phrased as "a React Vite app with no backend" already derived
    // custom-frontend on this exact path.
    writeState(cwd, { mode: 'new-project', originalPrompt: 'a simple static landing page' });
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'low');
    applyAnswer(cwd, 'project-context', { summary: '', answers: {} });
    applyAnswer(cwd, 'mobile', 'ionic_capacitor');
    applyAnswer(cwd, 'code-graph', 'gitnexus');
    assert.ok(applyAnswer(cwd, 'finalize', null).ok);
    const s = readState(cwd);
    assert.equal(s.stack, 'custom-frontend');
    assert.equal(s.frontend, 'react-vite');
    assert.equal(s.backend, 'supabase');
    assert.equal(asRec(s.mobile).framework, 'ionic-capacitor');
  });
});

test('finalize: expo + a brochure prompt is byte-identical to the pre-change outcome', () => {
  withProject(null, (cwd) => {
    // The deleted `if (stack === 'minimal') stack = 'custom-frontend'` was a true
    // no-op: the classifier now returns custom-frontend for this prompt directly.
    writeState(cwd, { mode: 'new-project', originalPrompt: 'a simple static landing page' });
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'low');
    applyAnswer(cwd, 'project-context', { summary: '', answers: {} });
    applyAnswer(cwd, 'mobile', 'react_native_expo');
    applyAnswer(cwd, 'code-graph', 'gitnexus');
    assert.ok(applyAnswer(cwd, 'finalize', null).ok);
    const s = readState(cwd);
    assert.equal(s.stack, 'custom-frontend');
    assert.equal(s.frontend, 'none');
    assert.equal(s.backend, 'supabase');
  });
});

test('finalize: a thin originalPrompt is rescued by the typed project-context answers (not minimal)', () => {
  withProject(null, (cwd) => {
    // The bug case: a later "ok build it" became the seed, which alone derives a
    // bare frontend shell carrying none of the real project's surfaces.
    writeState(cwd, { mode: 'new-project', originalPrompt: 'ok build it' });
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'low');
    // The user describes the real project in the wizard form.
    applyAnswer(cwd, 'project-context', { summary: 'a marketplace', answers: { audience: 'freelancers and clients', features: 'user accounts, payments, an admin dashboard' } });
    applyAnswer(cwd, 'mobile', 'web_only');
    applyAnswer(cwd, 'code-graph', 'gitnexus');
    assert.equal(computeOnboarding(cwd).step, 'finalize');
    applyAnswer(cwd, 'finalize', null);
    const s = readState(cwd);
    assert.equal(s.stack, 'default', 'answers fold into the stack signal even though originalPrompt was thin');
    assert.equal(s.frontend, 'react-vite');
    assert.equal(s.backend, 'supabase');
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
  assert.deepEqual({ tier: architect.tier, model: architect.model }, { tier: 'highest', model: CLAUDE_HIGHEST });
  assert.deepEqual({ tier: tester.tier, model: tester.model }, { tier: 'cheapest', model: 'claude-haiku-4-5' });
  assert.deepEqual({ tier: shipper.tier, model: shipper.model }, { tier: 'balanced', model: 'claude-sonnet-5' });
  assert.ok(architect.label === 'Architect' && architect.blurb.length > 0);
});

test('buildTeamLineup: balanced uses sonnet for builders, haiku for tester', () => {
  const by = Object.fromEntries(buildTeamLineup('balanced', 'claude').map((m) => [m.role, m]));
  assert.equal(requireRole(by, 'senior-frontend').model, 'claude-sonnet-5');
  assert.equal(requireRole(by, 'senior-tester').model, 'claude-haiku-4-5');
});

test('buildTeamLineup: host changes the concrete model ids (codex)', () => {
  const by = Object.fromEntries(buildTeamLineup('high', 'codex').map((m) => [m.role, m]));
  assert.equal(requireRole(by, 'senior-architect').model, 'gpt-5.6-sol');
  assert.equal(requireRole(by, 'senior-tester').model, 'gpt-5.6-terra');
});

test('buildTeamLineup: low (main-agent) has no subagent line-up', () => {
  assert.deepEqual(buildTeamLineup('low', 'claude'), []);
  assert.deepEqual(buildTeamLineup('nonsense', 'claude'), []);
});

test('buildTeamLineup: a per-role tier override is honored', () => {
  const by = Object.fromEntries(buildTeamLineup('high', 'claude', { 'senior-tester': 'highest' }).map((m) => [m.role, m]));
  // tester is normally cheapest/haiku; the override promotes it
  const tester = requireRole(by, 'senior-tester');
  assert.deepEqual({ tier: tester.tier, model: tester.model }, { tier: 'highest', model: CLAUDE_HIGHEST });
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
    assert.equal(architect?.model, CLAUDE_HIGHEST);
    // host is resolved (defaults to claude outside a host process) so the UI can label it
    assert.equal(view.meta.host, 'claude');
    // the approve/re-pick options are still present
    assert.deepEqual(view.meta.options?.map((o) => o.id), ['approve', 'repick_performance']);
  });
});

test('declined project: computeOnboarding is terminally done with the declined flag', () => {
  withProject(null, (cwd) => {
    recordPluginUseChoice(cwd, false, 'command');
    const view = computeOnboarding(cwd);
    assert.equal(view.done, true);
    assert.equal(view.step, null);
    assert.equal(view.meta.declined, true);
    // No project files exist for a declined project.
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false);
  });
});

test('team step offers the first two models from every tier without cross-tier deduplication', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    const view = computeOnboarding(cwd);
    assert.equal(view.step, 'team-confirmation');
    const choices = view.meta.modelChoices || [];
    // The picker offers the row's concrete models (the host alias tail is not a choice).
    for (const tier of ['highest', 'balanced'] as const) {
      assert.deepEqual(
        choices.filter((choice) => choice.tier === tier).map((choice) => choice.model),
        modelTierSnapshot('claude', undefined)[tier].slice(0, 2),
        `${tier} choices track the configured row`,
      );
    }
    assert.deepEqual(choices.filter((choice) => choice.tier === 'cheapest').map((choice) => choice.model), [
      'claude-haiku-4-5', 'claude-sonnet-4-6',
    ]);
    assert.equal(
      choices.filter((choice) => choice.model === 'claude-sonnet-4-6').length,
      2,
      'the same model remains a distinct Balanced and Cheapest choice',
    );
    assert.equal(choices.find((choice) => choice.model === 'claude-opus-5')?.label, 'Opus 5');
  });
});

test('Claude lineup surfaces concrete generation labels; concrete hosts get none', () => {
  const lineup = buildTeamLineup('high', 'claude');
  const architect = lineup.find((m) => m.role === 'senior-architect');
  assert.equal(architect?.model, CLAUDE_HIGHEST);
  // Every Anthropic id in the lineup carries a readable generation label, whichever
  // model currently anchors the tier.
  assert.ok((architect?.modelLabel ?? '').length > 0, 'architect model has a generation label');
  const tester = lineup.find((m) => m.role === 'senior-tester');
  assert.equal(tester?.model, resolveModel('cheapest', 'claude'));
  assert.ok((tester?.modelLabel ?? '').length > 0, 'tester model has a generation label');
  // Concrete ids (copilot & co.) are already readable — no label.
  const copilot = buildTeamLineup('high', 'copilot');
  assert.equal(copilot.find((m) => m.role === 'senior-architect')?.modelLabel, undefined);
});

test('team step model menu follows Codex and exposes both verified v2 models across its tiers', () => {
  withProject(null, (cwd) => {
    process.env.CODEX_PLUGIN_ROOT = '/tmp/codex-root';
    try {
      applyAnswer(cwd, 'open-code', 'not_now');
      applyAnswer(cwd, 'performance', 'high');
      const view = computeOnboarding(cwd);
      assert.equal(view.meta.host, 'codex');
      assert.deepEqual(view.meta.modelChoices, [
        { tier: 'highest', model: 'gpt-5.6-sol' },
        { tier: 'balanced', model: 'gpt-5.6-terra' },
        { tier: 'cheapest', model: 'gpt-5.6-terra' },
      ]);
      assert.deepEqual(
        [...new Set(view.meta.modelChoices?.map((choice) => choice.model))],
        ['gpt-5.6-sol', 'gpt-5.6-terra'],
      );
    } finally {
      delete process.env.CODEX_PLUGIN_ROOT;
    }
  });
});

test('computeOnboarding explicit env owns the preference target and model metadata', () => {
  withProject({ mode: 'existing-codebase', stack: 'default', onboardingComplete: true }, (cwd) => {
    const env = {
      ...process.env,
      TRAFFIC_ONE_HOST: 'codex',
      TRAFFIC_ONE_USER_PLAN: 'pro',
      TRAFFIC_ONE_STATE_PATH: path.join(cwd, 'explicit-one.json'),
      XDG_STATE_HOME: path.join(cwd, 'explicit-state'),
      TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'explicit-preferences.json'),
      TRAFFIC_ONE_AUTH: '1',
    } as NodeJS.ProcessEnv;
    writeSimpleAuth('sk-explicit-flow', env);
    writeGlobalCodeGraphProvider('gitnexus', env);
    writeRuntimeModelSnapshot('codex', {
      plan: 'pro',
      tiers: {
        highest: ['explicit-highest', 'explicit-highest-fallback'],
        balanced: ['explicit-balanced', 'explicit-balanced-fallback'],
        cheapest: ['explicit-cheapest', 'explicit-cheapest-fallback'],
      },
    }, env);
    mergeProjectPrefs(cwd, {
      openCode: { enabled: false, source: 'prompted', decidedAt: '2026-07-15T00:00:00Z' },
    }, env);
    assert.equal(applyAnswer(cwd, 'performance', 'balanced', env).ok, true);
    const performance = asRec(hostPrefs(readProjectPrefs(cwd, env), 'codex').performance);
    assert.deepEqual(performance.target, {
      plan: 'pro',
      appliedFingerprint: currentHostModelTarget('codex', 'pro', env).appliedFingerprint,
      configVersion: currentHostModelTarget('codex', 'pro', env).configVersion,
    });

    const view = computeOnboarding(cwd, env);
    assert.equal(view.step, 'team-confirmation');
    assert.equal(view.meta.host, 'codex');
    assert.deepEqual(view.meta.modelChoices?.map((choice) => choice.model), [
      'explicit-highest',
      'explicit-highest-fallback',
      'explicit-balanced',
      'explicit-balanced-fallback',
      'explicit-cheapest',
      'explicit-cheapest-fallback',
    ]);
    assert.equal(view.meta.team?.find((member) => member.role === 'senior-architect')?.model, 'explicit-balanced');
  });
});

test('Windsurf Free recommends Low, offers both quota-free models, and maps its default team to SWE-1.6', () => {
  withProject(null, (cwd) => {
    process.env.TRAFFIC_ONE_HOST = 'windsurf';
    process.env.TRAFFIC_ONE_USER_PLAN = 'free';
    applyAnswer(cwd, 'open-code', 'not_now');

    const perf = computeOnboarding(cwd);
    assert.equal(perf.step, 'performance');
    assert.equal(perf.meta.host, 'windsurf');
    assert.equal(perf.meta.recommendedLevel, 'low');
    assert.equal(perf.meta.recommendedTier, 'cheapest');
    assert.equal(perf.meta.options?.[0]?.id, 'low');

    applyAnswer(cwd, 'performance', 'balanced');
    const view = computeOnboarding(cwd);
    assert.equal(view.step, 'team-confirmation');
    assert.equal(view.meta.host, 'windsurf');
    assert.deepEqual(view.meta.modelChoices, [
      { tier: 'highest', model: 'SWE-1.7' },
      { tier: 'highest', model: 'SWE-1.6' },
      { tier: 'balanced', model: 'SWE-1.7' },
      { tier: 'balanced', model: 'SWE-1.6' },
      { tier: 'cheapest', model: 'SWE-1.6' },
      { tier: 'cheapest', model: 'SWE-1.7' },
    ]);
    const by = Object.fromEntries((view.meta.team || []).map((m) => [m.role, m]));
    assert.equal(requireRole(by, 'senior-architect').tier, 'cheapest');
    assert.equal(requireRole(by, 'senior-architect').model, 'SWE-1.6');
    assert.equal(requireRole(by, 'senior-tester').model, 'SWE-1.6');
    assert.ok(!(view.meta.modelChoices || []).some((c) => /opus|sonnet|haiku/i.test(c.model)));
  });
});

test('Windsurf Cascade offers only Low/main-agent and rejects subagent answers', () => {
  withProject(null, (cwd) => {
    process.env.TRAFFIC_ONE_HOST = 'windsurf';
    process.env.TRAFFIC_ONE_WINDSURF_BACKEND = 'cascade';
    process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
    applyAnswer(cwd, 'open-code', 'not_now');

    const perf = computeOnboarding(cwd);
    assert.equal(perf.step, 'performance');
    assert.equal(perf.meta.recommendedLevel, 'low');
    assert.deepEqual(perf.meta.options?.map((option) => option.id), ['low']);
    assert.deepEqual(applyAnswer(cwd, 'performance', 'balanced'), {
      ok: false,
      error: 'Cascade supports main-agent mode only',
    });
    assert.deepEqual(applyAnswer(cwd, 'team-confirmation', 'approve'), {
      ok: false,
      error: 'Cascade does not expose a subagent runner',
    });

    assert.equal(applyAnswer(cwd, 'performance', 'low').ok, true);
    const prefs = readProjectPrefs(cwd);
    assert.equal(asRec(hostPrefs(prefs, 'windsurf').performance).level, 'low');
    assert.equal(asRec(hostPrefs(prefs, 'windsurf').team).mode, 'main-agent');
  });
});

test('Windsurf Pro exposes the first two selector models for each tier', () => {
  withProject(null, (cwd) => {
    process.env.TRAFFIC_ONE_HOST = 'windsurf';
    process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'balanced');

    const view = computeOnboarding(cwd);
    assert.equal(view.step, 'team-confirmation');
    assert.deepEqual(
      view.meta.modelChoices?.filter((choice) => choice.tier === 'balanced').map((choice) => choice.model),
      ['SWE-1.7', 'SWE-1.6 Fast'],
    );
    const by = Object.fromEntries((view.meta.team || []).map((m) => [m.role, m]));
    assert.equal(requireRole(by, 'senior-architect').model, 'SWE-1.7');
    assert.equal(requireRole(by, 'senior-tester').model, 'SWE-1.6');
  });
});

test('Kilo Balanced/High line-up uses native Kilo Auto tiers with a free tester fallback', () => {
  withProject(null, (cwd) => {
    process.env.TRAFFIC_ONE_HOST = 'kilo';
    process.env.TRAFFIC_ONE_USER_PLAN = 'free';
    applyAnswer(cwd, 'open-code', 'not_now');

    const perf = computeOnboarding(cwd);
    assert.equal(perf.step, 'performance');
    assert.equal(perf.meta.host, 'kilo');
    assert.equal(perf.meta.recommendedLevel, 'low');
    assert.equal(perf.meta.recommendedTier, 'cheapest');

    applyAnswer(cwd, 'performance', 'balanced');
    const balanced = computeOnboarding(cwd);
    assert.equal(balanced.step, 'team-confirmation');
    assert.deepEqual(
      balanced.meta.modelChoices?.filter((choice) => choice.tier === 'balanced').map((choice) => choice.model),
      ['kilo/kilo-auto/balanced', 'kilo/kilo-auto/efficient'],
    );
    const balancedBy = Object.fromEntries((balanced.meta.team || []).map((m) => [m.role, m]));
    assert.equal(requireRole(balancedBy, 'senior-architect').model, 'kilo/kilo-auto/balanced');
    assert.equal(requireRole(balancedBy, 'senior-frontend').model, 'kilo/kilo-auto/balanced');
    assert.equal(requireRole(balancedBy, 'senior-tester').model, 'kilo/kilo-auto/free');
    assert.ok(!(balanced.meta.team || []).some((m) => m.model.startsWith('opencode/')));

    applyAnswer(cwd, 'team-confirmation', 'repick_performance');
    applyAnswer(cwd, 'performance', 'high');
    const high = computeOnboarding(cwd);
    const highBy = Object.fromEntries((high.meta.team || []).map((m) => [m.role, m]));
    assert.equal(requireRole(highBy, 'senior-architect').model, 'kilo/kilo-auto/frontier');
    assert.equal(requireRole(highBy, 'senior-reviewer').model, 'kilo/kilo-auto/frontier');
    assert.equal(requireRole(highBy, 'senior-shipper').model, 'kilo/kilo-auto/balanced');
    assert.equal(requireRole(highBy, 'senior-tester').model, 'kilo/kilo-auto/free');
    assert.ok(!(high.meta.team || []).some((m) => m.model.startsWith('opencode/')));
  });
});

test('Copilot Pro onboarding recommends Balanced and lists distinct paid subagent models', () => {
  withProject(null, (cwd) => {
    process.env.TRAFFIC_ONE_HOST = 'copilot';
    process.env.TRAFFIC_ONE_USER_PLAN = 'Copilot Pro';
    applyAnswer(cwd, 'open-code', 'not_now');

    const perf = computeOnboarding(cwd);
    assert.equal(perf.step, 'performance');
    assert.equal(perf.meta.host, 'copilot');
    assert.equal(perf.meta.recommendedLevel, 'balanced');
    assert.equal(perf.meta.recommendedTier, 'balanced');
    assert.equal(perf.meta.options?.[0]?.id, 'balanced');

    applyAnswer(cwd, 'performance', 'balanced');
    const view = computeOnboarding(cwd);
    assert.equal(view.step, 'team-confirmation');
    assert.equal(view.meta.host, 'copilot');
    assert.deepEqual(
      view.meta.modelChoices?.filter((choice) => choice.tier === 'balanced').map((choice) => choice.model),
      ['gpt-5.6-terra', 'claude-sonnet-5'],
    );
    const by = Object.fromEntries((view.meta.team || []).map((m) => [m.role, m]));
    assert.equal(requireRole(by, 'senior-frontend').tier, 'balanced');
    assert.equal(requireRole(by, 'senior-frontend').model, 'gpt-5.6-terra');
    assert.equal(requireRole(by, 'senior-backend').model, 'gpt-5.6-terra');
    assert.equal(requireRole(by, 'senior-tester').tier, 'cheapest');
    assert.equal(requireRole(by, 'senior-tester').model, 'gpt-5-mini');
    assert.ok(new Set((view.meta.team || []).map((m) => m.model)).size > 1, 'Balanced Copilot team must not collapse to one mini model');
  });
});

test('team approve with per-agent model overrides persists them under team.overrides', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    // The wizard sends only the roles the user changed away from the shown default.
    assert.ok(applyAnswer(cwd, 'team-confirmation', { action: 'approve', overrides: { 'senior-tester': 'highest' } }).ok);
    const team = asRec(hostPrefs(readProjectPrefs(cwd)).team);
    assert.equal(team.approved, true);
    assert.deepEqual(asRec(team.overrides), { 'senior-tester': 'highest' });
    // …and that stored override drives the resolved line-up (tester jumps to Fable).
    const lineup = buildTeamLineup('high', 'claude', asRec(team.overrides));
    assert.equal(lineup.find((m) => m.role === 'senior-tester')?.model, CLAUDE_HIGHEST);
  });
});

test('team approve persists exact same-tier model selections for every visible role', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    const view = computeOnboarding(cwd);
    const modelSelections = Object.fromEntries(
      (view.meta.team || []).map((member) => [member.role, member.model]),
    );
    modelSelections['senior-architect'] = 'claude-opus-5';
    modelSelections['senior-tester'] = 'claude-sonnet-4-6';

    assert.deepEqual(
      applyAnswer(cwd, 'team-confirmation', { action: 'approve', modelSelections }),
      { ok: true },
    );
    const team = asRec(hostPrefs(readProjectPrefs(cwd)).team);
    assert.deepEqual(asRec(team.modelSelections), modelSelections);
  });
});

test('team approve persists a cross-tier override together with the exact selected model', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    const view = computeOnboarding(cwd);
    const modelSelections = Object.fromEntries(
      (view.meta.team || []).map((member) => [member.role, member.model]),
    );
    modelSelections['senior-architect'] = 'claude-sonnet-5';

    assert.deepEqual(
      applyAnswer(cwd, 'team-confirmation', {
        action: 'approve',
        overrides: { 'senior-architect': 'balanced' },
        modelSelections,
      }),
      { ok: true },
    );
    const team = asRec(hostPrefs(readProjectPrefs(cwd), 'claude').team);
    assert.deepEqual(asRec(team.overrides), { 'senior-architect': 'balanced' });
    assert.equal(asRec(team.modelSelections)['senior-architect'], 'claude-sonnet-5');
  });
});

test('plan-aware overrides preserve a Codex Free tier change even when the exact model is shared', () => {
  withProject(null, (cwd) => {
    process.env.TRAFFIC_ONE_HOST = 'codex';
    process.env.TRAFFIC_ONE_USER_PLAN = 'free';
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    const view = computeOnboarding(cwd);
    const modelSelections = Object.fromEntries(
      (view.meta.team || []).map((member) => [member.role, member.model]),
    );
    modelSelections['senior-architect'] = 'gpt-5.6-sol';
    // Terra belongs to both rows. The explicit tier pair must survive even
    // though the exact model id alone cannot distinguish this selection.
    modelSelections['senior-tester'] = 'gpt-5.6-terra';

    assert.deepEqual(
      applyAnswer(cwd, 'team-confirmation', {
        action: 'approve',
        overrides: {
          'senior-architect': 'highest',
          'senior-tester': 'balanced',
        },
        modelSelections,
      }),
      { ok: true },
    );
    const team = asRec(hostPrefs(readProjectPrefs(cwd), 'codex').team);
    assert.deepEqual(asRec(team.overrides), {
      'senior-architect': 'highest',
      'senior-tester': 'balanced',
    });

    const reloaded = buildTeamLineup(
      'high',
      'codex',
      asRec(team.overrides),
      { host: 'codex', plan: 'free' },
      process.env,
      asRec(team.modelSelections),
    );
    const architect = reloaded.find((member) => member.role === 'senior-architect');
    const tester = reloaded.find((member) => member.role === 'senior-tester');
    assert.deepEqual({ tier: architect?.tier, model: architect?.model }, {
      tier: 'highest', model: 'gpt-5.6-sol',
    });
    assert.deepEqual({ tier: tester?.tier, model: tester?.model }, {
      tier: 'balanced', model: 'gpt-5.6-terra',
    });
  });
});

test('team step reload preserves a valid exact model selection in its original tier', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    const first = computeOnboarding(cwd);
    const modelSelections = Object.fromEntries(
      (first.meta.team || []).map((member) => [member.role, member.model]),
    );
    modelSelections['senior-architect'] = 'claude-opus-5';
    mergeProjectHostPrefs(cwd, 'claude', {
      team: { mode: 'subagents', source: 'prompted', modelSelections },
    });

    const reloaded = computeOnboarding(cwd);
    assert.equal(reloaded.step, 'team-confirmation');
    assert.equal(
      reloaded.meta.team?.find((member) => member.role === 'senior-architect')?.model,
      'claude-opus-5',
    );
    assert.equal(
      reloaded.meta.team?.find((member) => member.role === 'senior-tester')?.model,
      'claude-haiku-4-5',
    );
  });
});

test('team approve rejects cross-tier or incomplete exact model selections', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    const view = computeOnboarding(cwd);
    const modelSelections = Object.fromEntries(
      (view.meta.team || []).map((member) => [member.role, member.model]),
    );

    const crossTier = { ...modelSelections, 'senior-architect': 'claude-sonnet-5' };
    assert.deepEqual(
      applyAnswer(cwd, 'team-confirmation', { action: 'approve', modelSelections: crossTier }),
      { ok: false, error: 'Architect model is not available in the highest tier' },
    );

    const hiddenThird = { ...modelSelections, 'senior-architect': 'opus' };
    assert.deepEqual(
      applyAnswer(cwd, 'team-confirmation', { action: 'approve', modelSelections: hiddenThird }),
      { ok: false, error: 'Architect model is not available in the highest tier' },
    );

    const { 'senior-tester': _missing, ...incomplete } = modelSelections;
    assert.deepEqual(
      applyAnswer(cwd, 'team-confirmation', { action: 'approve', modelSelections: incomplete }),
      { ok: false, error: 'team model selections must cover the visible team exactly' },
    );
    assert.notEqual(asRec(hostPrefs(readProjectPrefs(cwd)).team).approved, true);
  });
});

test('team approve with an empty overrides object stores no overrides', () => {
  withProject(null, (cwd) => {
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    assert.ok(applyAnswer(cwd, 'team-confirmation', { action: 'approve', overrides: {} }).ok);
    const team = asRec(hostPrefs(readProjectPrefs(cwd)).team);
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
    assert.equal(asRec(hostPrefs(readProjectPrefs(cwd)).team).approved, true);
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
    assert.equal(view.meta.team?.find((m) => m.role === 'senior-frontend')?.model, 'claude-sonnet-5');
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
    process.env.TRAFFIC_ONE_HOST = 'codex';
    applyAnswer(cwd, 'open-code', 'not_now');
    applyAnswer(cwd, 'performance', 'high');
    process.env.TRAFFIC_ONE_USER_PLAN = 'free';
    const view = computeOnboarding(cwd);
    const by = Object.fromEntries((view.meta.team || []).map((m) => [m.role, m]));
    // headline plan tier (free) is surfaced for the wizard; per-role tiers may differ
    assert.equal(view.meta.recommendedTier, 'cheapest');
    // free + high: builders drop to balanced; the hand-tuned tester stays cheapest
    assert.equal(requireRole(by, 'senior-architect').tier, 'balanced');
    assert.equal(requireRole(by, 'senior-architect').model, 'gpt-5.6-terra');
    assert.equal(requireRole(by, 'senior-tester').tier, 'cheapest');
  });
});

test('plan-aware performance step: the recommended option follows the plan', () => {
  withProject(null, (cwd) => {
    process.env.TRAFFIC_ONE_HOST = 'codex';
    applyAnswer(cwd, 'open-code', 'not_now');
    process.env.TRAFFIC_ONE_USER_PLAN = 'free';
    const view = computeOnboarding(cwd);
    assert.equal(view.step, 'performance');
    assert.equal(view.meta.recommendedLevel, 'low');
    assert.equal(view.meta.recommendedTier, 'cheapest'); // headline plan tier surfaced on the step
    assert.equal(view.meta.host, 'codex');
    assert.equal(view.meta.plan, 'free');
    assert.equal('catalogTiers' in view.meta, false); // tier-catalog card removed from the step
    assert.equal(view.meta.repickReason, 'initial');
    assert.equal(view.meta.options?.[0]?.id, 'low'); // recommended floats to the top
    assert.ok(/Recommended/.test(view.meta.options?.[0]?.hint || ''));
  });
});

test('plan-aware performance step: OpenCode installation does not change the recommendation', () => {
  withProject(null, (cwd) => {
    process.env.TRAFFIC_ONE_HOST = 'codex';
    applyAnswer(cwd, 'open-code', 'enable');
    process.env.TRAFFIC_ONE_USER_PLAN = 'free';
    // The plan alone owns model/performance selection.
    assert.equal(computeOnboarding(cwd).meta.recommendedLevel, 'low');
    mergeProjectPrefs(cwd, { toolchain: { opencode: { installedVersion: '1.15.13', installedAt: '2026-01-01T00:00:00Z' } } });
    const view = computeOnboarding(cwd);
    assert.equal(view.meta.recommendedLevel, 'low');
    assert.equal(view.meta.options?.[0]?.id, 'low');
  });
});

test('plan-aware performance step: Codex selection is independent of OpenCode delegation', () => {
  withProject(null, (cwd) => {
    process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Codex Desktop';
    process.env.TRAFFIC_ONE_USER_PLAN = 'free';
    applyAnswer(cwd, 'open-code', 'enable');
    mergeProjectPrefs(cwd, { toolchain: { opencode: { installedVersion: '1.15.13', installedAt: '2026-01-01T00:00:00Z' } } });

    const view = computeOnboarding(cwd);
    assert.equal(view.meta.host, 'codex');
    assert.equal(view.meta.recommendedLevel, 'low');
    assert.equal(view.meta.options?.[0]?.id, 'low');
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

test('computeOnboarding: shared onboardingComplete without a prefs file is not done', () => {
  const committed = {
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    projectContext: { source: 'prompted', summary: 'x', answers: {}, collectedAt: '2026-01-01T00:00:00Z' },
    technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-01-01T00:00:00Z',
  };
  withProject(committed, (cwd) => {
    writeGlobalCodeGraphProvider('gitnexus');
    fs.rmSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, { force: true });
    const view = computeOnboarding(cwd);
    assert.equal(view.done, false);
    assert.equal(view.step, 'open-code');
    assert.equal(view.meta.step, 'open-code');
  });
});

test('computeOnboarding: canonical hashed user preferences complete onboarding', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-flow-legacy-prefs-'));
  const cwd = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const prevPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = process.env.TRAFFIC_ONE_STATE_PATH;
  const prevHome = process.env.HOME;
  const prevXdg = process.env.XDG_STATE_HOME;
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  const prevHost = process.env.TRAFFIC_ONE_HOST;
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  delete process.env.TRAFFIC_ONE_STATE_PATH;
  process.env.HOME = home;
  process.env.TRAFFIC_ONE_USER_PLAN = 'max';
  process.env.TRAFFIC_ONE_HOST = 'claude';
  delete process.env.XDG_STATE_HOME;
  try {
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
      projectContext: {
        source: 'prompted',
        originalPrompt: 'Build responsive learning platform',
        summary: 'responsive learning platform',
        answers: {},
        collectedAt: '2026-01-01T00:00:00Z',
      },
      technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
      openCodeDelegation: { approved: true, source: 'onboarding', decidedAt: '2026-01-01T00:00:00Z' },
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-01-01T00:00:00Z',
    }), 'utf8');
    const hashedPrefs = path.join(home, '.traffic-one', 'projects', projectRootHash(cwd), 'preferences.json');
    fs.mkdirSync(path.dirname(hashedPrefs), { recursive: true });
    fs.writeFileSync(hashedPrefs, JSON.stringify({
      hosts: {
        claude: {
          performance: {
            level: 'balanced',
            source: 'prompted',
            target: {
              plan: 'max',
              appliedFingerprint: currentHostModelTarget('claude', 'max').appliedFingerprint,
              configVersion: currentHostModelTarget('claude', 'max').configVersion,
            },
          },
          team: { mode: 'subagents', source: 'prompted', approved: true },
        },
      },
      toolchain: {
        gitnexus: { installedVersion: '1.6.8', installedAt: '2026-07-01T12:25:50Z' },
        graphify: { installedVersion: null, installedAt: null },
        opencode: { installedVersion: '1.17.12', installedAt: '2026-07-01T12:25:50Z' },
        gitleaks: { installedVersion: null, installedAt: null },
        trufflehog: { installedVersion: null, installedAt: null },
      },
    }), 'utf8');
    fs.mkdirSync(path.join(home, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(home, '.traffic-one', 'one.json'), JSON.stringify({
      schemaVersion: 3,
      auth: {
        version: 1,
        authenticated: true,
        apiKey: 'sk-hashed-prefs-fixture',
        updatedAt: '2026-07-15T00:00:00Z',
      },
      codeGraphProvider: 'gitnexus',
      hosts: {},
    }), 'utf8');

    const view = computeOnboarding(cwd);
    assert.equal(view.done, true);
    assert.equal(view.step, null);
  } finally {
    if (prevPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevState === undefined) delete process.env.TRAFFIC_ONE_STATE_PATH;
    else process.env.TRAFFIC_ONE_STATE_PATH = prevState;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
    else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    if (prevHost === undefined) delete process.env.TRAFFIC_ONE_HOST;
    else process.env.TRAFFIC_ONE_HOST = prevHost;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeOnboarding: an unstamped team never leaks the raw "team" step (kind-less meta crashed the wizard)', () => {
  // The call-agents reproduction (2026-07-10): valid performance but NO team state
  // at all → needsTeamConfirmation is false (it requires a valid team), so
  // nextOnboardingStep returns the raw id 'team', which is NOT a wizard step. It
  // used to reach metaForStep unmapped, producing meta:{step:'team'} with no
  // kind/title — the wizard client then crashed with appendChild-on-undefined
  // ("Connection issue"). The flow must re-ask 'performance' instead (its answer
  // stamps both performance AND the derived team).
  const committed = {
    mode: 'new-project',
    stack: 'custom-backend',
    frontend: 'react-vite',
    backend: 'go',
    openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
    performance: { level: 'high', source: 'prompted' },
    // no `team` key → hasValidTeamState false
  };
  withProject(committed, (cwd) => {
    const view = computeOnboarding(cwd);
    assert.equal(view.step, 'performance');
    assert.equal(view.meta.kind, 'single_select');
    assert.ok(view.meta.title, 'meta must carry renderable copy');
    assert.ok(view.meta.question, 'meta must carry renderable copy');
  });
});

test('computeOnboarding: fail-closed durable check keeps step metadata in sync', () => {
  const committed = {
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    mobile: { enabled: false, framework: 'none', source: 'prompted' },
    projectContext: { source: 'prompted', summary: 'x', answers: {}, collectedAt: '2026-01-01T00:00:00Z' },
    technologies: { frontend: ['react', 'vite'], backend: ['supabase', 'postgres'], mobile: [] },
    openCode: { enabled: true, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
    performance: { level: 'low', source: 'prompted' },
    team: { mode: 'main-agent', source: 'prompted' },
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-01-01T00:00:00Z',
  };
  withProject(committed, (cwd) => {
    writeGlobalCodeGraphProvider('gitnexus');
    fs.rmSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string, { force: true });
    process.argv.push('--host=opencode');
    try {
      const view = computeOnboarding(cwd);
      assert.equal(view.done, false);
      assert.ok(view.step, 'durable recovery selects a setup step');
      assert.equal(view.meta.step, view.step);
      assert.notEqual(view.meta.kind, 'done');
    } finally {
      process.argv.pop();
    }
  });
});

test('new-project: an unwritable user home never falls back to project-local preferences', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-flow-local-'));
  const blockedHome = path.join(dir, 'blocked-home');
  fs.writeFileSync(blockedHome, 'not-a-directory', 'utf8');
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  const prevHome = process.env.HOME;
  const prevPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = process.env.TRAFFIC_ONE_STATE_PATH;
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  process.env.HOME = blockedHome;
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  delete process.env.TRAFFIC_ONE_STATE_PATH;
  process.env.TRAFFIC_ONE_USER_PLAN = 'max';
  try {
    const { resolveTrafficOneEnv } = require('../../state/traffic-one-paths');
    const resolved = resolveTrafficOneEnv(cwd, 'claude', process.env);
    assert.equal(resolved.TRAFFIC_ONE_PROJECT_PREFS_PATH, undefined);
    assert.equal(resolved.TRAFFIC_ONE_STATE_PATH, undefined);
    assert.throws(() => applyAnswer(cwd, 'open-code', 'not_now'));
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'preferences.json')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'machine.json')), false);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevState === undefined) delete process.env.TRAFFIC_ONE_STATE_PATH; else process.env.TRAFFIC_ONE_STATE_PATH = prevState;
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN; else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
