import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openCodeRestartWarning, waitForOnboarding } from '../index';

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

test('openCodeRestartWarning tells the user to restart before continuing development', () => {
  const warning = openCodeRestartWarning();
  assert.match(warning, /TRAFFIC_ONE_RESTART_OPENCODE_REQUIRED/);
  assert.match(warning, /restart OpenCode/i);
  assert.match(warning, /type "continue" or "resume"/i);
  assert.doesNotMatch(warning, /Ctrl\+C/i);
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
      team: { mode: 'subagents', source: 'prompted', approved: true },
      performance: { level: 'balanced', source: 'prompted' },
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
      team: { mode: 'subagents', source: 'prompted', approved: true },
      performance: { level: 'high', source: 'prompted' },
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
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
      team: { mode: 'subagents', source: 'prompted', approved: true },
      performance: { level: 'high', source: 'prompted' },
    }), 'utf8');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      confirmed: true, onboardingComplete: true,
    }), 'utf8');

    const d = preSpawnRunIdDirective(dir);
    assert.ok(d.includes('Build run-id'), 'directive is recognizable');
    assert.ok(d.includes('never `date`, ISO, or UTC'), 'warns against fabricated ids');
    const one = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', '.one.json'), 'utf8')) as { currentRunId?: string };
    assert.ok(one.currentRunId && /^\d+$/.test(one.currentRunId), 'currentRunId minted as epoch-ms digits');
    assert.ok(d.includes(one.currentRunId!), 'directive carries the minted id');
    assert.ok(d.includes(`.traffic-one/runs/${one.currentRunId}/assignments.json`), 'assignments path');
    assert.ok(d.includes(`.traffic-one/digests/${one.currentRunId}/`), 'digests path');
    assert.ok(d.includes(`Run ID: ${one.currentRunId}`), 'spawn prompt line');

    // Idempotent: reuses existing currentRunId.
    const d2 = preSpawnRunIdDirective(dir);
    assert.ok(d2.includes(one.currentRunId!));
    const one2 = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', '.one.json'), 'utf8')) as { currentRunId?: string };
    assert.equal(one2.currentRunId, one.currentRunId);

    // Non-new-project → silent.
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'existing-codebase', stack: 'custom-frontend', frontend: 'nextjs', backend: 'other',
      confirmed: true, onboardingComplete: true,
    }), 'utf8');
    assert.equal(preSpawnRunIdDirective(dir), '');
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
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
      team: { mode: 'subagents', source: 'prompted', approved: true, overrides: { 'senior-frontend': 'highest' } },
      performance: { level: 'high', source: 'prompted' },
    }), 'utf8');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      confirmed: true, onboardingComplete: true,
    }), 'utf8');

    const d = preSpawnModelDirective(dir, 'cursor');
    assert.ok(d.includes('cursor-models.json'), 'step 1 front-loads the model capture');
    assert.ok(d.includes('senior-architect') && d.includes('senior-frontend'), 'per-role map present');
    assert.ok(d.includes('claude-opus-4-8'), 'tier family appears as eligibility reference');
    assert.ok(d.includes('never pass the bare family') || d.includes('after step 2'), 'does not advertise bare family as spawn param');
    assert.ok(d.includes('spawn map'), 'step 3 points at model-gate spawn map output');
    // Step 2 mandates running the model-gate command, which is what pops the USER prompt
    // (permission:"ask") when a picked model is unavailable — instead of the agent deciding.
    assert.ok(d.includes('model-gate.cjs'), 'step 2 runs the model-gate command (the user-prompt trigger)');
    assert.ok(/prompt|fallback|enable|STOP/i.test(d), 'explains the user must reply before spawning');

    // Non-Cursor hosts print nothing (model-capture is Cursor-specific).
    assert.equal(preSpawnModelDirective(dir, 'claude'), '', 'claude → no directive');
    assert.equal(preSpawnModelDirective(dir, 'codex'), '', 'codex → no directive');

    // A main-agent level (no subagents) → silent.
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
      team: { mode: 'subagents', source: 'prompted', approved: true },
      performance: { level: 'low', source: 'prompted' },
    }), 'utf8');
    assert.equal(preSpawnModelDirective(dir, 'cursor'), '', 'low/main-agent level → no directive');
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preSpawnModelDirective: with capture, lists exact build slugs not bare families', async () => {
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
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
      team: { mode: 'subagents', source: 'prompted', approved: true },
      performance: { level: 'high', source: 'prompted' },
    }), 'utf8');
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
      confirmed: true, onboardingComplete: true,
    }), 'utf8');
    fs.writeFileSync(path.join(dir, '.traffic-one', 'cursor-models.json'), JSON.stringify({
      models: ['claude-opus-4-8-thinking-medium', 'composer-2.5-fast'],
      plan: 'pro',
      capturedAt: new Date().toISOString(),
    }), 'utf8');

    const d = preSpawnModelDirective(dir, 'cursor');
    assert.ok(d.includes('senior-architect → claude-opus-4-8-thinking-medium'), 'exact slug in preview');
    assert.ok(!d.includes('senior-architect → claude-opus-4-8\n'), 'bare family not listed as spawn value');
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
    announceWizardUrl(dir, (s) => { out += s; });
    assert.equal(out, '', 'no server record → no banner');

    // Live record → the literal URL is printed for the user to click.
    writeServerRecord(dir, { pid: process.pid, port: 55174, token: 'tok', url: 'http://127.0.0.1:55174/?t=tok', startedAt: 'x' });
    out = '';
    announceWizardUrl(dir, (s) => { out += s; });
    assert.ok(out.includes('http://127.0.0.1:55174/?t=tok'), 'banner carries the live wizard URL');
    assert.equal(out.match(/http:\/\/127\.0\.0\.1:55174\/\?t=tok/g)?.length, 2, 'banner repeats the URL near the waiting line for compact terminals');
    assert.match(out, /SETUP WIZARD/i, 'banner is recognizable to the user');

    // Placeholder (:0/) → never surfaced.
    writeServerRecord(dir, { pid: process.pid, port: 0, token: '', url: 'http://127.0.0.1:0/?t=pending', startedAt: 'x' });
    out = '';
    announceWizardUrl(dir, (s) => { out += s; });
    assert.equal(out, '', 'placeholder URL is not surfaced');
  } finally {
    if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
