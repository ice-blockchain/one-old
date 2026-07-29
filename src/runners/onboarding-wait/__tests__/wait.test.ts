import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  beginOnboardingAttempt,
  consentPhaseFailureOutput,
  openCodeRestartWarning,
  preSpawnArchitectDirective,
  preSpawnModelDirective,
  waitForOnboarding,
} from '../index';
import { hostScopedPerformancePrefs, withCursorAvailableModels } from '../../../test-support/host-prefs';
import { resolveModel } from '../../../shared/model-tiers';

// Derived, never hardcoded: which family anchors a tier is editable policy.
const CURSOR_HIGHEST_FAMILY = resolveModel('highest', 'cursor', 'pro') as string;
const CURSOR_HIGHEST_SLUG = `${CURSOR_HIGHEST_FAMILY}-thinking-high`;

// Deterministic seams: a fake clock that advances `step` ms per read, and a no-op
// sleep — so the polling loop is exercised without a real timer or state IO.
function fakeNow(step: number): () => number {
  let t = 0;
  return () => (t += step);
}

test('waitForOnboarding: returns "complete" immediately when onboarding is already done', () => {
  const r = waitForOnboarding('/proj', { isComplete: () => true, now: () => 0, sleep: () => {} });
  assert.equal(r, 'complete');
});

test('waitForOnboarding: returns "pending" once the deadline passes and it never completes', () => {
  const r = waitForOnboarding('/proj', {
    isComplete: () => false,
    timeoutMs: 100,
    intervalMs: 10,
    now: fakeNow(30),
    sleep: () => {},
  });
  assert.equal(r, 'pending');
});

test('waitForOnboarding: returns "complete" when setup finishes mid-wait (after a few polls)', () => {
  let polls = 0;
  const r = waitForOnboarding('/proj', {
    isComplete: () => (++polls >= 3),
    timeoutMs: 10_000,
    intervalMs: 10,
    now: fakeNow(5),
    sleep: () => {},
  });
  assert.equal(r, 'complete');
  assert.equal(polls, 3);
});

test('consent-phase EPERM maps to a clean escalation recipe that keeps the recorded yes', () => {
  // the live 8c-codex crash: `--use --bootstrap-only` ran inside the workspace
  // sandbox and mkdir(~/.traffic-one/projects/…) threw a raw EPERM stack
  const eperm = Object.assign(
    new Error("EPERM: operation not permitted, mkdir '/Users/u/.traffic-one/projects/abc'"),
    { code: 'EPERM' },
  );
  const argv = [
    '--use', '--bootstrap-only', '/proj',
    '--host=codex',
    '--seed-prompt=create a modern learning platform with courses',
    '--sync-session=sess-1',
  ] as const;
  const out = consentPhaseFailureOutput('/proj', 'codex', argv, eperm);
  assert.match(out, /^TRAFFIC_ONE_SETUP_PERMISSION_REQUIRED\n/);
  assert.match(out, /require_escalated/);
  assert.doesNotMatch(out, /at Object\.mkdirSync/); // no raw stack traces
  // the prescribed retry is the ORIGINAL yes command — consent and seed intact
  assert.match(out, /--use/);
  assert.match(out, /--bootstrap-only/);
  assert.match(out, /--seed-prompt=/);
  assert.match(out, /--sync-session=sess-1/);

  // non-permission failures stay terminal diagnostics, not retry loops
  const broken = consentPhaseFailureOutput('/proj', 'codex', argv, new Error('unexpected token in prefs.json'));
  assert.match(broken, /^TRAFFIC_ONE_SETUP_START_FAILED\n/);
  assert.match(broken, /plugin\/runtime failure/);
});

test('openCodeRestartWarning tells the user to restart before continuing development', () => {
  const warning = openCodeRestartWarning();
  assert.match(warning, /TRAFFIC_ONE_RESTART_OPENCODE_REQUIRED/);
  assert.match(warning, /restart OpenCode/i);
  assert.match(warning, /type "continue" or "resume"/i);
  assert.doesNotMatch(warning, /Ctrl\+C/i);
});

test('no close directive exists — the setup tab belongs to the user', async () => {
  // Traffic One neither opens nor closes the browser. The agent-driven browser_tabs
  // close was part of the same "agent drives the browser" model that left users with
  // no link at all (2cu: navigate, claim "links were shared above", close the tab).
  const mod = await import('../index');
  assert.equal('cursorSetupCloseDirective' in mod, false);
});

test('declineOutput records the opt-out and never touches the user\'s browser', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { declineOutput } = await import('../index');
  const { writeServerRecord } = await import('../../../shared/onboarding-server/registry');
  const { pluginUseDeclined } = await import('../../../shared/state/plugin-use');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-decline-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    // Even with a wizard tab open, declining says nothing about the browser: a tab
    // the user opened is theirs to close.
    const url = 'http://127.0.0.1:55177/?t=tok';
    writeServerRecord(dir, { pid: process.pid, port: 55177, token: 'tok', url, startedAt: 'x' }, process.env, 'cursor');
    const out = declineOutput(dir, 'cursor');
    assert.match(out, /^TRAFFIC_ONE_DISABLED/, 'terminal disable marker');
    assert.ok(!out.includes('browser_tabs'), 'no tab-closing directive');
    assert.ok(!out.includes(url), 'no wizard URL is echoed back');
    assert.equal(pluginUseDeclined(dir), true, 'choice recorded durably');

    // Ask-first flow: no wizard was ever opened → no tab-close noise. Own prefs
    // path so the first project's server record cannot leak into this one.
    const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-decline2-')));
    env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(fresh, 'prefs.json');
    try {
      const quiet = declineOutput(fresh, 'cursor');
      assert.match(quiet, /^TRAFFIC_ONE_DISABLED/);
      assert.ok(!quiet.includes('browser_tabs'), 'no close directive without an open tab');
    } finally {
      env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyUseChoice records the yes and seeds originalPrompt at decision time (ask-first: first-ever write)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { applyUseChoice } = await import('../index');
  const { readPluginUseChoice } = await import('../../../shared/state/plugin-use');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-use-seed-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    const statePath = path.join(dir, '.traffic-one', '.one.json');
    assert.equal(fs.existsSync(statePath), false, 'ask-first: nothing exists before the yes');
    const seed = 'create a modern learning platform with courses for web development';
    applyUseChoice(dir, ['--use', '--bootstrap-only', dir, '--host=cursor', `--seed-prompt=${seed}`]);
    assert.equal(readPluginUseChoice(dir)?.enabled, true, 'yes recorded durably');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    assert.equal(state.originalPrompt, seed, 'the triggering request is seeded at decision time');

    // Idempotent: a later --use never overwrites the seeded description.
    applyUseChoice(dir, ['--use', dir, '--seed-prompt=ok build it now please']);
    const after = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    assert.equal(after.originalPrompt, seed, 'existing seed preserved');

    // Without a seed argument the yes is recorded and nothing else is written.
    const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-use-seedless-')));
    env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(fresh, 'prefs.json');
    try {
      applyUseChoice(fresh, ['--use', fresh]);
      assert.equal(readPluginUseChoice(fresh)?.enabled, true);
      assert.equal(fs.existsSync(path.join(fresh, '.traffic-one')), false, 'no seed → no project write from the choice itself');
    } finally {
      env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyReconsiderChoice persists exact opt-in before synchronizing', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { applyReconsiderChoice } = await import('../index');
  const { readPluginUseChoice, recordPluginUseChoice } = await import('../../../shared/state/plugin-use');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-reconsider-')));
  const previousPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    recordPluginUseChoice(dir, false, 'command');
    let choiceObservedBySync: unknown;
    let hostObservedBySync: unknown;
    applyReconsiderChoice(dir, 'codex', (syncCwd, syncHost) => {
      choiceObservedBySync = readPluginUseChoice(syncCwd);
      hostObservedBySync = syncHost;
    }, undefined, { ...process.env, TRAFFIC_ONE_DISABLE_ONE_MCP_SYNC: '' }, true);

    assert.deepEqual(choiceObservedBySync && {
      enabled: (choiceObservedBySync as { enabled: boolean }).enabled,
      source: (choiceObservedBySync as { source: string }).source,
    }, { enabled: true, source: 'reconsider' });
    assert.equal(hostObservedBySync, 'codex');
    assert.equal(readPluginUseChoice(dir)?.enabled, true);
  } finally {
    if (previousPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = previousPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('beginOnboardingAttempt syncs before the first wizard-state read on normal and bootstrap paths', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { recordPluginUseChoice } = await import('../../../shared/state/plugin-use');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-begin-onboarding-')));
  const previousPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  const events: string[] = [];
  const sync = ((_cwd: string, host: unknown) => { events.push(`sync:${String(host)}`); }) as never;
  try {
    recordPluginUseChoice(dir, true, 'test');
    beginOnboardingAttempt(dir, 'cursor', [dir], {
      sync,
      env: { ...process.env, TRAFFIC_ONE_DISABLE_ONE_MCP_SYNC: '' },
      featureEnabled: true,
      isDone: () => { events.push('compute'); return false; },
    });
    assert.deepEqual(events, ['sync:cursor', 'compute']);

    events.length = 0;
    beginOnboardingAttempt(dir, 'cursor', ['--bootstrap-only', dir], {
      sync,
      env: { ...process.env, TRAFFIC_ONE_DISABLE_ONE_MCP_SYNC: '' },
      featureEnabled: true,
      isDone: () => { events.push('compute'); return false; },
    });
    assert.deepEqual(events, ['sync:cursor', 'compute']);
  } finally {
    if (previousPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = previousPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('beginOnboardingAttempt persists --use before sync and shares the SessionStart marker', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { readPluginUseChoice } = await import('../../../shared/state/plugin-use');
  const { syncOneMcpAtSessionStart } = await import('../../../modules/session/session-start');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-begin-use-')));
  const previousPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  let calls = 0;
  const sync = ((syncCwd: string, host: unknown) => {
    calls += 1;
    assert.equal(syncCwd, dir);
    assert.equal(host, 'cursor');
    assert.equal(readPluginUseChoice(dir)?.enabled, true, 'consent is durable before public sync');
  }) as never;
  try {
    const session = 'parent-session-1';
    beginOnboardingAttempt(dir, 'cursor', ['--use', '--bootstrap-only', dir, `--sync-session=${session}`], {
      sync,
      env: { ...process.env, TRAFFIC_ONE_DISABLE_ONE_MCP_SYNC: '' },
      featureEnabled: true,
      isDone: () => false,
    });
    assert.equal(calls, 1);

    // The SessionStart path and both waiter commands use the same project +
    // host + session marker, so later surfaces do not issue another request.
    const enabledEnv = { ...process.env, TRAFFIC_ONE_DISABLE_ONE_MCP_SYNC: '' };
    syncOneMcpAtSessionStart(dir, 'cursor', { session_id: session }, enabledEnv, sync);
    beginOnboardingAttempt(dir, 'cursor', [dir, `--sync-session=${session}`], {
      sync,
      env: enabledEnv,
      featureEnabled: true,
      isDone: () => false,
    });
    assert.equal(calls, 1);
  } finally {
    if (previousPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = previousPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('awaitWizardCompletionAck: returns immediately once the server record is gone, bounded otherwise', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { awaitWizardCompletionAck } = await import('../index');
  const { writeServerRecord } = await import('../../../shared/onboarding-server/registry');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-ack-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    // No record (server already shut down after /complete) → no wait at all.
    let started = Date.now();
    awaitWizardCompletionAck(dir, 'cursor', 2000);
    assert.ok(Date.now() - started < 500, 'gone record returns immediately');

    // Live record that never clears → the grace is BOUNDED (never stalls the build).
    writeServerRecord(dir, { pid: process.pid, port: 55175, token: 'tok', url: 'http://127.0.0.1:55175/?t=tok', startedAt: 'x' }, process.env, 'cursor');
    started = Date.now();
    awaitWizardCompletionAck(dir, 'cursor', 400);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 350 && elapsed < 2000, `bounded grace (got ${elapsed}ms)`);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windsurf first-run architect directive uses the always-registered general profile', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-prespawn-')));
  const prevPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
      ...hostScopedPerformancePrefs(
        { level: 'balanced', source: 'prompted' },
        { mode: 'subagents', source: 'prompted', approved: true },
        'pro',
      ),
    }));
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project', stack: 'custom-frontend', frontend: 'nextjs', backend: 'supabase',
      confirmed: true, onboardingComplete: true,
    }));
    const directive = preSpawnArchitectDirective(dir, 'windsurf');
    assert.match(directive, /profile `subagent_general`/);
    assert.match(directive, /\[t1-role: senior-<role>\]/);
    assert.doesNotMatch(directive, /\[t1-role: senior-(?:architect|frontend|backend|reviewer|tester|shipper)\]/);
    assert.match(directive, /\.devin\/agents\/senior-architect\/AGENT\.md/);
    assert.doesNotMatch(directive, /profile `senior-architect`/);
    assert.match(directive, /profile `next-app`/);
    assert.match(directive, /framework `nextjs`/);
    assert.doesNotMatch(directive, /React\/Vite app lives|Turborepo|apps\/web/);
  } finally {
    if (prevPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windsurf first-run directive derives backend-only roles and QA from capabilities', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-windsurf-prespawn-go-')));
  const prevPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fs.writeFileSync(process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
      ...hostScopedPerformancePrefs(
        { level: 'balanced', source: 'prompted' },
        { mode: 'subagents', source: 'prompted', approved: true },
        'pro',
      ),
    }));
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.test/api\n\ngo 1.24\n');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project',
      stack: 'custom-backend',
      frontend: 'none',
      backend: 'go',
      mobile: { framework: 'none' },
      confirmed: true,
      onboardingComplete: true,
    }));
    const directive = preSpawnArchitectDirective(dir, 'windsurf');
    assert.match(directive, /profile `backend-only`/);
    assert.match(directive, /framework `go`/);
    assert.match(directive, /spawn only `senior-backend`/);
    assert.doesNotMatch(directive, /spawn (?:only )?`senior-frontend`/);
    assert.match(directive, /stack-native build\/test\/lint/);
    assert.doesNotMatch(directive, /React\/Vite app lives|Turborepo|apps\/web/);
  } finally {
    if (prevPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── postSetupTriage: the SETUP-COMPLETE continuation gets the routing rubric ──

test('postSetupTriage emits the subagents triage (with OpenCode-first) for the seeded original request', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { postSetupTriage } = await import('../index');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-postsetup-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    // The incident shape: existing codebase (maintenance from detection), team
    // subagents + OpenCode enabled/installed via local prefs, prompt seeded by
    // the setup-required branch.
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
      ...hostScopedPerformancePrefs(
        { level: 'balanced', source: 'prompted' },
        { mode: 'subagents', source: 'prompted', approved: true },
        'pro',
      ),
      openCode: { enabled: true, source: 'prompted' },
      toolchain: { opencode: { installedVersion: '1.15.13' } },
    }), 'utf8');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'existing-codebase', stack: 'custom-frontend', frontend: 'nextjs', backend: 'other',
      confirmed: true, onboardingComplete: true,
      lifecycle: { phase: 'maintenance', source: 'existing-detected', completedAt: '2026-06-11T18:46:12Z' },
      originalPrompt: 'create new page called news and add some dummy data',
    }), 'utf8');

    const triage = postSetupTriage(dir);
    assert.ok(triage.includes('MAINTENANCE PHASE'), 'rubric present');
    assert.ok(triage.includes('opencode_delegate'), 'OpenCode-first routing present');
    assert.ok(triage.includes('runId'), 'fresh runId rendered for delegation');

    // No seeded prompt → silent (nothing to route).
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'existing-codebase', stack: 'custom-frontend', frontend: 'nextjs', backend: 'other',
      confirmed: true, onboardingComplete: true,
      lifecycle: { phase: 'maintenance', source: 'existing-detected', completedAt: '2026-06-11T18:46:12Z' },
    }), 'utf8');
    assert.equal(postSetupTriage(dir), '');
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preSpawnOpenCodeDirective: new-project subagents + OpenCode → Step 0 batch instructions', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { preSpawnOpenCodeDirective } = await import('../index');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-prespawn-oc-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
      ...hostScopedPerformancePrefs(
        { level: 'high', source: 'prompted' },
        { mode: 'subagents', source: 'prompted', approved: true },
        'pro',
      ),
      openCode: { enabled: true, source: 'prompted' },
      toolchain: { opencode: { installedVersion: '1.17.8' } },
    }), 'utf8');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      confirmed: true, onboardingComplete: true,
    }), 'utf8');

    const d = preSpawnOpenCodeDirective(dir);
    assert.ok(d.includes('OpenCode Step 0'), 'directive is recognizable');
    assert.ok(d.includes('opencode_delegate_from_plan'), 'names the MCP tool');
    assert.ok(d.includes('Do NOT spawn implementers in the same assistant message'), 'blocks parallel Step 0 + spawns');
    assert.ok(d.includes('senior-backend'), 'names implementers');
    assert.ok(d.includes(dir), 'includes absolute project root');
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── preSpawnRunIdDirective: front-load gate-minted currentRunId BEFORE the first spawn,
// so the orchestrator never fabricates an ISO run-id in spawn prompts. ──

test('preSpawnRunIdDirective: new-project → mints currentRunId and prints exact paths', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { preSpawnRunIdDirective } = await import('../index');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-prespawn-runid-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  // Pin the plan so buildRunModelPolicy resolves deterministic tiers on CI, where
  // no real ~/.claude|~/.codex auth exists to detect a paid plan (without this the
  // policy fails to freeze and the directive falls back to MODEL_POLICY_BLOCKED).
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
      ...hostScopedPerformancePrefs(
        { level: 'high', source: 'prompted' },
        { mode: 'subagents', source: 'prompted', approved: true },
        'pro',
      ),
    }), 'utf8');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      confirmed: true, onboardingComplete: true,
    }), 'utf8');

    const d = preSpawnRunIdDirective(dir, 'codex');
    assert.ok(d.includes('Build run-id'), 'directive is recognizable');
    assert.ok(d.includes('never `date`, ISO, or UTC'), 'warns against fabricated ids');
    const one = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', '.one.json'), 'utf8')) as { currentRunId?: string };
    assert.ok(one.currentRunId && /^\d+$/.test(one.currentRunId), 'currentRunId minted as epoch-ms digits');
    assert.ok(d.includes(one.currentRunId!), 'directive carries the minted id');
    assert.ok(d.includes(`.traffic-one/runs/${one.currentRunId}/assignments.json`), 'assignments path');
    assert.ok(d.includes(`.traffic-one/digests/${one.currentRunId}/`), 'digests path');
    assert.ok(d.includes(`Run ID: ${one.currentRunId}`), 'spawn prompt line');

    // Idempotent: reuses existing currentRunId.
    const d2 = preSpawnRunIdDirective(dir, 'codex');
    assert.ok(d2.includes(one.currentRunId!));
    const one2 = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', '.one.json'), 'utf8')) as { currentRunId?: string };
    assert.equal(one2.currentRunId, one.currentRunId);

    // Existing projects with subagents also receive the immutable policy; the
    // run snapshot is a team invariant, not a new-project-only feature.
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'existing-codebase', stack: 'custom-frontend', frontend: 'nextjs', backend: 'other',
      confirmed: true, onboardingComplete: true,
    }), 'utf8');
    assert.match(preSpawnRunIdDirective(dir, 'codex'), /Immutable run model policy is ready/);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN;
    else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preSpawnRunIdDirective: Cursor captures exact picker models before publishing model-policy.json', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {
    preSpawnModelDirective,
    preSpawnRunIdBlocksSetup,
    preSpawnRunIdDirective,
  } = await import('../index');
  const { captureCursorModels } = await import('../../../shared/materialize/cursor-models');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-prespawn-cursor-policy-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(
      hostScopedPerformancePrefs(
        { level: 'high', source: 'prompted' },
        { mode: 'subagents', source: 'prompted', approved: true },
        'pro',
      ),
    ), 'utf8');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      confirmed: true, onboardingComplete: true,
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Traffic One project context\n', 'utf8');
    fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'));

    const required = preSpawnRunIdDirective(dir, 'cursor');
    assert.match(required, /^TRAFFIC_ONE_CURSOR_MODELS_REQUIRED/);
    assert.match(required, /model-gate\.cjs/);
    const runId = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string;
    const policyPath = path.join(dir, '.traffic-one', 'runs', runId, 'model-policy.json');
    assert.equal(fs.existsSync(policyPath), false, 'no incomplete create-once policy is published');

    const pickerModels = [CURSOR_HIGHEST_SLUG, 'gpt-5.6-terra-medium', 'composer-2.5-fast'];
    assert.equal(captureCursorModels(dir, pickerModels, 'pro'), true);
    const ready = preSpawnRunIdDirective(dir, 'cursor');
    assert.match(ready, /Build run-id/);
    assert.equal(fs.existsSync(policyPath), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(policyPath, 'utf8')).cursorAvailableModels, pickerModels);
    const frozenMap = preSpawnModelDirective(dir, 'cursor');
    assert.match(frozenMap, /immutable model policy is ready/i);
    assert.doesNotMatch(frozenMap, /Enumerate the exact model ids|--capture-models/);
    assert.match(frozenMap, /Do NOT capture models again for this run/);

    const runDir = path.join(dir, '.traffic-one', 'runs', runId);
    const baselinePath = path.join(runDir, 'baseline-v1.json');
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
      baseline?: { files?: Array<{ path?: string }> };
    };
    assert.ok(
      baseline.baseline?.files?.some((entry) => entry.path === 'CLAUDE.md'),
      'the materialized root alias is represented in the immutable baseline',
    );

    // A saved model policy is not sufficient if its runtime-owned capability
    // snapshot cannot be validated. The completion runner must re-run bootstrap
    // preflight and report the real failure instead of telling the user to redo
    // the already-saved Performance step.
    fs.rmSync(path.join(runDir, 'capability-v1.json'));
    fs.rmSync(baselinePath);
    fs.writeFileSync(baselinePath, '{}\n', 'utf8');
    const blocked = preSpawnRunIdDirective(dir, 'cursor');
    assert.match(blocked, /^TRAFFIC_ONE_BOOTSTRAP_BLOCKED/);
    assert.equal(preSpawnRunIdBlocksSetup(blocked), true);
    assert.match(blocked, /valid immutable model policy and saved Performance choice/);
    assert.match(blocked, /do not redo onboarding/i);
    assert.doesNotMatch(blocked, /Reopen Performance/i);
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN;
    else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preSpawnOrchestrationDirective: kilo subagents new-project emits spawn-first recipe', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { preSpawnOrchestrationDirective } = await import('../index');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-prespawn-orch-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
      ...hostScopedPerformancePrefs(
        { level: 'balanced', source: 'prompted' },
        { mode: 'subagents', source: 'prompted', approved: true },
        'pro',
      ),
    }), 'utf8');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      confirmed: true, onboardingComplete: true,
    }), 'utf8');

    const d = preSpawnOrchestrationDirective(dir, 'kilo');
    assert.match(d, /senior-architect/i);
    assert.match(d, /subagent_type/i);
    assert.equal(preSpawnOrchestrationDirective(dir, 'cursor'), '');
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── preSpawnModelDirective: front-load capture + per-role map + eligibility BEFORE
// the first spawn, so the team spawns once (no capture/model-tier deny + retry). ──

test('preSpawnModelDirective: Cursor new-project subagents → capture + per-role map + eligibility self-check', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { preSpawnModelDirective } = await import('../index');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-prespawn-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    // tests/22 shape: high level, subagents, frontend overridden to highest.
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(
      hostScopedPerformancePrefs(
        { level: 'high', source: 'prompted' },
        { mode: 'subagents', source: 'prompted', approved: true, overrides: { 'senior-frontend': 'highest' } },
        'pro',
      ),
    ), 'utf8');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      confirmed: true, onboardingComplete: true,
    }), 'utf8');

    const d = preSpawnModelDirective(dir, 'cursor');
    assert.ok(d.includes('cursor-models.json'), 'step 1 front-loads the model capture');
    assert.ok(d.includes('senior-architect') && d.includes('senior-frontend'), 'per-role map present');
    assert.ok(d.includes(CURSOR_HIGHEST_FAMILY), 'tier family appears as eligibility reference');
    assert.ok(d.includes('never guess an uncaptured id') || d.includes('after step 2'), 'does not advertise an uncaptured guess as a spawn param');
    assert.ok(d.includes('spawn map'), 'step 3 points at model-gate spawn map output');
    // Step 2 mandates running the model-gate command, which is what pops the USER prompt
    // (permission:"ask") when a picked model is unavailable — instead of the agent deciding.
    assert.ok(d.includes('model-gate.cjs'), 'step 2 runs the model-gate command (the user-prompt trigger)');
    assert.ok(/prompt|fallback|enable|STOP/i.test(d), 'explains the user must reply before spawning');

    // Codex prints nothing (its spawn contract rides the orchestrator prose);
    // Claude prints nothing HERE only because no policy is frozen yet for a
    // claude run — see the dedicated Claude spawn-map test below.
    assert.equal(preSpawnModelDirective(dir, 'claude'), '', 'claude without frozen policy → no directive');
    assert.equal(preSpawnModelDirective(dir, 'codex'), '', 'codex → no directive');

    // A main-agent level (no subagents) → silent.
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(
      hostScopedPerformancePrefs(
        { level: 'low', source: 'prompted' },
        { mode: 'subagents', source: 'prompted', approved: true },
        'pro',
      ),
    ), 'utf8');
    assert.equal(preSpawnModelDirective(dir, 'cursor'), '', 'low/main-agent level → no directive');
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preSpawnModelDirective: Claude new-project subagents → per-role spawn map from the frozen policy', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { preSpawnModelDirective, preSpawnRunIdDirective } = await import('../index');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-prespawn-claude-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_USER_PLAN = 'max';
  try {
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(
      hostScopedPerformancePrefs(
        { level: 'balanced', source: 'prompted' },
        { mode: 'subagents', source: 'prompted', approved: true, overrides: { 'senior-architect': 'highest' } },
        'max',
      ),
    ), 'utf8');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      confirmed: true, onboardingComplete: true,
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Traffic One project context\n', 'utf8');
    fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'));

    // Before the policy is frozen there is nothing authoritative to print.
    assert.equal(preSpawnModelDirective(dir, 'claude'), '', 'no frozen policy → no directive');

    // Freeze the policy exactly like real setup completion does (no capture
    // step on Claude — the policy mints straight away).
    const runIdDirective = preSpawnRunIdDirective(dir, 'claude');
    assert.match(runIdDirective, /Build run-id/);
    const runId = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', '.one.json'), 'utf8')).currentRunId as string;
    const policy = JSON.parse(fs.readFileSync(
      path.join(dir, '.traffic-one', 'runs', runId, 'model-policy.json'), 'utf8',
    )) as { roles: Record<string, { preferredModel: string }> };

    // 2cl regression: the first spawn went out without a `model` param because
    // nothing the root read carried the concrete per-role map. The directive
    // must front-load plugin-namespaced subagent_type + the model value the
    // Agent tool actually ACCEPTS. 6cl regression: printing the full policy id
    // (`model: "claude-opus-4-8"`) made the first spawn fail the host's own
    // InputValidationError (the tool's `model` enum is sonnet|opus|haiku|fable)
    // — so the row must carry the ALIAS, with the policy id alongside.
    const d = preSpawnModelDirective(dir, 'claude');
    assert.ok(d.includes(`run \`${runId}\``), 'names the frozen run');
    assert.ok(d.includes('subagent_type: "traffic-one:senior-architect"'), 'plugin-namespaced agent type');
    const architectModel = policy.roles['senior-architect']!.preferredModel;
    const expectedAlias = ['fable', 'opus', 'haiku', 'sonnet'].find((alias) => architectModel.toLowerCase().includes(alias));
    assert.ok(expectedAlias, `policy model ${architectModel} maps to a known Agent-tool alias`);
    assert.ok(
      d.includes(`model: "${expectedAlias}" (policy model: ${architectModel})`),
      'architect row passes the Agent-tool alias and names the frozen policy id',
    );
    assert.ok(!/model: "claude-/.test(d), 'no row tells the orchestrator to pass a full model id');
    assert.match(d, /sonnet\|opus\|haiku\|fable/, 'states the Agent tool enum explicitly');
    assert.ok(d.includes('senior-frontend') && d.includes('senior-tester'), 'map covers the team roles');
    assert.match(d, /failed to run agent/, 'explains how the host renders a model-less spawn deny');
    // The frozen policy — not live prefs — is the authority: the map keeps
    // printing for this run even if preferences change afterwards.
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(
      hostScopedPerformancePrefs(
        { level: 'low', source: 'prompted' },
        { mode: 'subagents', source: 'prompted', approved: true },
        'max',
      ),
    ), 'utf8');
    assert.match(preSpawnModelDirective(dir, 'claude'), /spawn map/i, 'frozen policy outlives pref edits');
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preSpawnModelDirective: with capture, lists exact picker ids including family anchors', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { preSpawnModelDirective } = await import('../index');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-prespawn-cap-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    const prefs = hostScopedPerformancePrefs(
      { level: 'high', source: 'prompted' },
      { mode: 'subagents', source: 'prompted', approved: true },
      'pro',
    );
    withCursorAvailableModels(
      prefs,
      [CURSOR_HIGHEST_SLUG, 'gpt-5.6-terra', 'gpt-5.4-mini'],
      'pro',
    );
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(prefs), 'utf8');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      confirmed: true, onboardingComplete: true,
    }), 'utf8');

    const d = preSpawnModelDirective(dir, 'cursor');
    // This directive is emitted in the session that just materialized
    // `.cursor/agents/**`, so it recommends Cursor's built-in worker: the
    // role-named type is not in the type list this session captured and the
    // spawn comes back "Couldn't start" (1cu, 3cu). The role binds via the
    // `[t1-role: …]` prompt marker either way.
    assert.ok(d.includes(`senior-architect → subagent_type: "generalPurpose", model: ${CURSOR_HIGHEST_SLUG}`), 'exact slug in preview');
    assert.ok(d.includes('senior-shipper → subagent_type: "generalPurpose", model: gpt-5.6-terra'), 'captured balanced id equal to its family anchor is preserved');
    assert.ok(d.includes('senior-tester → subagent_type: "generalPurpose", model: gpt-5.4-mini'), 'captured cheapest id equal to its family anchor is preserved');
    assert.ok(!d.includes('model: (after step 2'), 'captured family-anchor id is not replaced by a placeholder');
    assert.ok(d.includes('Couldn\'t start'), 'the map explains why the built-in type is the recommended one');
    assert.ok(d.includes('[t1-role: senior-<role>]'), 'the role marker stays mandatory');
    assert.ok(d.includes('Never build the role inline.'));
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── announceWizardUrl: the URL reaches the Cursor user via the wait command's OWN
// stdout (the one channel Cursor renders) — not via user_message (dropped on
// user-prompt-submit) or the agent reposting additional_context (composer won't). ──

test('announceWizardUrl prints the live wizard URL from the server record (and skips when absent/placeholder)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { announceWizardUrl } = await import('../index');
  const { writeServerRecord } = await import('../../../shared/onboarding-server/registry');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-wizurl-')));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    // No record yet → prints nothing.
    let out = '';
    announceWizardUrl(dir, (s) => { out += s; }, 'cursor');
    assert.equal(out, '', 'no server record → no banner');

    // Live record → the dashboard setup link is printed for the user to click.
    writeServerRecord(dir, { pid: process.pid, port: 55174, token: 'tok', url: 'http://127.0.0.1:55174/?t=tok', startedAt: 'x' }, process.env, 'cursor');
    out = '';
    const prevDash = env.TRAFFIC_ONE_DASHBOARD_URL;
    env.TRAFFIC_ONE_DASHBOARD_URL = 'https://dash.example.test';
    try {
      announceWizardUrl(dir, (s) => { out += s; }, 'cursor');
    } finally {
      if (prevDash === undefined) delete env.TRAFFIC_ONE_DASHBOARD_URL; else env.TRAFFIC_ONE_DASHBOARD_URL = prevDash;
    }
    const dashLink = 'https://dash.example.test/onboarding/agent#p=55174&t=tok';
    assert.ok(out.includes(dashLink), 'banner carries the dashboard setup URL');
    assert.equal(out.split(dashLink).length - 1, 2, 'banner repeats the URL near the waiting line for compact terminals');
    assert.match(out, /TRAFFIC ONE SETUP/i, 'banner is recognizable to the user');

    // THIS runner just printed its own banner → it does not print the same block
    // twice back-to-back. Scoped to the banner alone: it gates no other surface.
    writeServerRecord(dir, { pid: process.pid, port: 55174, token: 'tok', url: 'http://127.0.0.1:55174/?t=tok', startedAt: 'x' }, process.env, 'cursor');
    out = '';
    announceWizardUrl(dir, (s) => { out += s; }, 'cursor');
    assert.ok(!out.includes('http://127.0.0.1:55174'), 'the runner does not reprint its own banner immediately');
    assert.match(out, /Waiting for Traffic One setup/i, 'compact wait line still explains the block');

    // Placeholder (:0/) → never surfaced.
    writeServerRecord(dir, { pid: process.pid, port: 0, token: '', url: 'http://127.0.0.1:0/?t=pending', startedAt: 'x' }, process.env, 'cursor');
    out = '';
    announceWizardUrl(dir, (s) => { out += s; }, 'cursor');
    assert.equal(out, '', 'placeholder URL is not surfaced');
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap output does NOT silence the waiter — its stdout is not proof the user saw the link', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { announceWizardUrl, bootstrapReadyOutput } = await import('../index');
  const { writeServerRecord } = await import('../../../shared/onboarding-server/registry');
  const { noteBrowserArrival } = await import('../../../shared/onboarding-server/browser-arrival');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-bootstrap-marker-')));
  const previousPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const previousDashboard = process.env.TRAFFIC_ONE_DASHBOARD_URL;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_DASHBOARD_URL = 'https://dash.example.test';
  try {
    const token = 'bootstrap-token';
    const dashboard = `https://dash.example.test/onboarding/agent#p=55188&t=${token}`;
    const local = `http://127.0.0.1:55188/local?t=${token}`;
    const ready = bootstrapReadyOutput(dir, token, dashboard, local, 'cursor');
    assert.match(ready, /TRAFFIC_ONE_SETUP_READY/);
    assert.ok(ready.includes(dashboard));
    assert.match(ready, /does not count as showing it/i,
      'the bootstrap must tell the agent its own stdout is not delivery');
    assert.doesNotMatch(ready, /do not print the URLs again/i,
      'the old show-once instruction is what agents echoed back as "link already shared above"');

    writeServerRecord(dir, {
      pid: process.pid,
      port: 55188,
      token,
      url: `http://127.0.0.1:55188/?t=${token}`,
      startedAt: 'x',
    }, process.env, 'cursor');
    // Cursor collapses the bootstrap's stdout, so the waiter must STILL show the link.
    let waiter = '';
    announceWizardUrl(dir, (chunk) => { waiter += chunk; }, 'cursor', 'bootstrap_session');
    assert.match(waiter, /onboarding\/agent/, 'the waiter re-offers the link the user may never have seen');

    // Once the wizard is actually open in a browser, it goes quiet.
    noteBrowserArrival(dir, token, process.env, 'cursor');
    let quiet = '';
    announceWizardUrl(dir, (chunk) => { quiet += chunk; }, 'cursor', 'bootstrap_session');
    assert.doesNotMatch(quiet, /onboarding\/agent/);
    assert.match(quiet, /open in your browser/i);
  } finally {
    if (previousPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = previousPrefs;
    if (previousDashboard === undefined) delete process.env.TRAFFIC_ONE_DASHBOARD_URL;
    else process.env.TRAFFIC_ONE_DASHBOARD_URL = previousDashboard;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('announceWizardUrl ignores a legacy marker and emits the direct /local fallback when no probe verdict exists', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { announceWizardUrl } = await import('../index');
  const { writeServerRecord } = await import('../../../shared/onboarding-server/registry');
  const { stampEmitMarker } = await import('../../../shared/once');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-wizurl-legacy-')));
  const previousPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const previousDashboard = process.env.TRAFFIC_ONE_DASHBOARD_URL;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_DASHBOARD_URL = 'https://dash.example.test';
  try {
    writeServerRecord(dir, {
      pid: process.pid,
      port: 55179,
      token: 'fresh-token',
      url: 'http://127.0.0.1:55179/?t=fresh-token',
      startedAt: 'x',
    }, process.env, 'cursor');
    stampEmitMarker(dir, 'wizard-url-shown');
    let out = '';
    announceWizardUrl(dir, (chunk) => { out += chunk; }, 'cursor');
    assert.match(out, /https:\/\/dash\.example\.test\/onboarding\/agent#p=55179&t=fresh-token/);
    assert.match(out, /http:\/\/127\.0\.0\.1:55179\/local\?t=fresh-token/);
  } finally {
    if (previousPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = previousPrefs;
    if (previousDashboard === undefined) delete process.env.TRAFFIC_ONE_DASHBOARD_URL;
    else process.env.TRAFFIC_ONE_DASHBOARD_URL = previousDashboard;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
