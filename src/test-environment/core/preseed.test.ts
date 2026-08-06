import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOST_IDS } from '../../config/model-tiers';
import { currentLocalPreferenceTarget, nextLocalPreferenceStep } from '../../shared/onboarding/local-prefs';
import { readEffectiveState, readProjectPrefs, statePath } from '../../shared/state';
import { preseed } from './preseed';

test('preseed writes complete performance preferences for the active host across all hosts', () => {
  for (const host of HOST_IDS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `t1-preseed-${host}-`));
    const env = process.env;
    const saved = {
      host: env.TRAFFIC_ONE_HOST,
      plan: env.TRAFFIC_ONE_USER_PLAN,
      prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
      state: env.TRAFFIC_ONE_STATE_PATH,
    };
    env.TRAFFIC_ONE_HOST = host;
    env.TRAFFIC_ONE_USER_PLAN = 'free';
    env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'preferences.json');
    env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');

    try {
      assert.equal(preseed(dir, {
        mode: 'new-project',
        stack: 'default',
        frontend: 'react-vite',
        backend: 'supabase',
        mobile: { enabled: false, framework: 'none' },
        performance: 'balanced',
        team: { mode: 'subagents', approved: true },
        openCode: false,
        codeGraphProvider: 'gitnexus',
        projectContext: { originalPrompt: 'Build an app with users and an admin dashboard' },
      }), true, `${host}: the seeded shared state must be on disk, or the prefs below describe a world that does not exist`);

      const prefs = readProjectPrefs(dir);
      const active = (prefs.hosts as Record<string, Record<string, unknown>>)[host];
      assert.ok(active, host);
      const target = currentLocalPreferenceTarget(host);
      assert.deepEqual(active.performance, { level: 'balanced', source: 'prompted', target }, host);
      assert.deepEqual(active.team, { mode: 'subagents', source: 'prompted', approved: true }, host);
      assert.deepEqual(Object.keys(prefs.hosts as Record<string, unknown>), [host], host);
      assert.equal(nextLocalPreferenceStep(readEffectiveState(dir), host), null, host);
    } finally {
      if (saved.host === undefined) delete env.TRAFFIC_ONE_HOST; else env.TRAFFIC_ONE_HOST = saved.host;
      if (saved.plan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = saved.plan;
      if (saved.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved.prefs;
      if (saved.state === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = saved.state;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// A harness that continues over a refused write measures something other than
// what it names, and this is the seed EVERY case's world is built from — so the
// refusal has to reach the caller that can report it (case-runner's
// `seedRefusal`) rather than dying one frame below it.
//
// MOVE-ASIDE, not a dangling link: writeState re-reads `.one.json` under the lock
// before replacing it (preserveCurrentRunId), so a dangling link would break that
// read, preseed would bail on its own precondition, and the case would pass
// having proved nothing. The first seed IS the writable baseline — it also
// creates the file the fence then moves aside.
test('a pre-seed the state write fence refused is reported, not absorbed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-preseed-refused-'));
  const env = process.env;
  const saved = { host: env.TRAFFIC_ONE_HOST, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH };
  env.TRAFFIC_ONE_HOST = 'claude';
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'preferences.json');
  const seed = {
    mode: 'new-project' as const,
    stack: 'default',
    frontend: 'react-vite',
    backend: 'none',
    mobile: { enabled: false, framework: 'none' as const },
  };

  try {
    assert.equal(preseed(dir, seed), true, 'writable baseline: an unfenced seed reports that it landed');
    assert.equal(readEffectiveState(dir).stack, 'default',
      'writable baseline: and the seeded state really is readable back — the promise this test is about');

    const target = statePath(dir);
    const aside = `${target}.aside`;
    const before = fs.readFileSync(target, 'utf8');
    fs.renameSync(target, aside);
    fs.symlinkSync(aside, target);
    assert.equal(fs.readFileSync(target, 'utf8'), before,
      'fixture guard: reads still resolve through the link, so preseed reaches its write');

    assert.equal(preseed(dir, { ...seed, backend: 'supabase' }), false,
      'a seed the fence refused must say so: the caller reports blocked-environment instead of measuring an unseeded project');
    assert.equal(readEffectiveState(dir).backend, 'none',
      'fixture guard: the second seed really was refused — disk still holds the first one');
  } finally {
    if (saved.host === undefined) delete env.TRAFFIC_ONE_HOST; else env.TRAFFIC_ONE_HOST = saved.host;
    if (saved.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved.prefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
