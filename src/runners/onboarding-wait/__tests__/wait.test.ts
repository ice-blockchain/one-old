import { test } from 'node:test';
import assert from 'node:assert/strict';

import { waitForOnboarding } from '../index';

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
