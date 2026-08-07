import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { HOST_IDS } from '../../config/model-tiers';
import { currentLocalPreferenceTarget, nextLocalPreferenceStep } from '../../shared/onboarding/local-prefs';
import { openCodeDelegationActive } from '../../shared/performance';
import { readEffectiveState, readProjectPrefs, statePath } from '../../shared/state';
import { preseed } from './preseed';
import type { PreSeed } from './types';

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

// Seed one project in full isolation: its own `.traffic-one/.one.json`, its own
// per-user preference store, its own machine-wide one.json. Host pinned to
// claude because openCodeDelegationActive answers false on the self-hosted hosts
// (opencode, kilo) by design, and buildCaseEnv pins pure-node case runs to claude
// for the same determinism.
function withSeededProject<T>(
  prefix: string,
  seed: PreSeed,
  body: (dir: string, prefsFile: string) => T,
): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const env = process.env;
  const saved = {
    host: env.TRAFFIC_ONE_HOST,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: env.TRAFFIC_ONE_STATE_PATH,
  };
  const prefsFile = path.join(dir, 'preferences.json');
  env.TRAFFIC_ONE_HOST = 'claude';
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefsFile;
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  try {
    assert.equal(preseed(dir, seed), true,
      'the seeded shared state must be on disk, or everything below describes a world that does not exist');
    return body(dir, prefsFile);
  } finally {
    if (saved.host === undefined) delete env.TRAFFIC_ONE_HOST; else env.TRAFFIC_ONE_HOST = saved.host;
    if (saved.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved.prefs;
    if (saved.state === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = saved.state;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DELEGATION_SEED: PreSeed = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { enabled: true, framework: 'react-native-expo' },
  performance: 'high',
  team: { mode: 'subagents', approved: true },
  openCode: true,
  openCodeInstalled: true,
  codeGraphProvider: 'gitnexus',
};

// The delegation-ON branch of preseed. Everything above — and every case in the
// corpus but one — seeds `openCode: false`, so the branch that had to be
// REWRITTEN when state/local-prefs/prefs-split.ts closed the consent route had no
// unit coverage at all.
//
// Read back through the CONSUMER, not the writer: openCodeDelegationActive(
// readEffectiveState(cwd)) is the exact predicate the spawn gate's
// free-delegation push and the maintenance-triage OpenCode-first clause ask.
//
// And asserted as a SEPARATION, because the predicate alone proves nothing about
// WHERE the authorization came from: it would answer yes just the same if the
// consent were being laundered back out of `.traffic-one/.one.json`, which is a
// committed, agent-writable file and therefore the escalation prefs-split closed.
test('preseed turns delegation on through the per-user store, never through the committed state file', () => {
  withSeededProject('t1-preseed-opencode-on-', DELEGATION_SEED, (dir, prefsFile) => {
    assert.equal(openCodeDelegationActive(readEffectiveState(dir)), true,
      'the predicate the spawn gate and the OpenCode-first triage clause ask must answer yes — a case that seeds delegation ON and reads OFF measures a project nobody asked for');

    const consent = readProjectPrefs(dir).openCode as Record<string, unknown> | undefined;
    assert.equal(consent?.enabled, true,
      'the consent belongs in the per-user store, where the wizard\'s own `open-code` answer handler writes it and only it writes it');
    assert.equal(consent?.source, 'prompted', 'in the shape that handler writes');
    assert.equal(typeof consent?.decidedAt, 'string', 'stamped with when it was decided');

    const raw = JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as Record<string, unknown>;
    assert.equal(raw.openCode, undefined,
      'and NOT in `.traffic-one/.one.json`: that file is committed and agent-writable, so a consent value in it cannot be attributed to this user — a seeder that wrote it there would be re-opening the route prefs-split.ts closed');

    // Not "the state file is empty": it deliberately keeps the durable
    // authorization RECORD that spawn gates cite. Pinned so the separation is
    // stated as what it is — the record stays, the consent does not.
    assert.equal((raw.openCodeDelegation as Record<string, unknown> | undefined)?.approved, true,
      'the durable authorization record still belongs in the state file');

    // The discriminator for the claim above. Strip ONLY the consent from the
    // per-user store and leave everything else exactly as it was — the toolchain
    // stamp, and the state file's `openCodeDelegation: { approved: true }`. If the
    // predicate still answered yes, that record would be manufacturing the
    // authorization on its own.
    const stored = JSON.parse(fs.readFileSync(prefsFile, 'utf8')) as Record<string, unknown>;
    delete stored.openCode;
    fs.writeFileSync(prefsFile, `${JSON.stringify(stored)}\n`, 'utf8');
    assert.equal(openCodeDelegationActive(readEffectiveState(dir)), false,
      'with the per-user consent gone, an `openCodeDelegation: { approved: true }` still sitting in the committed state file must NOT reactivate delegation — that is the escalation itself');
  });
});

// The other half of the double gate. `opencode-delegation.assert.ts` expects
// active only when enabled AND installed, and no case in the corpus seeds the
// mixed row — so nothing but this checks that the toolchain stamp is a real
// condition rather than something preseed hands out with the consent.
test('preseed leaves delegation off when OpenCode is consented to but not installed', () => {
  withSeededProject('t1-preseed-opencode-uninstalled-', { ...DELEGATION_SEED, openCodeInstalled: false }, (dir) => {
    const state = readEffectiveState(dir);
    assert.equal((state.openCode as Record<string, unknown> | undefined)?.enabled, true,
      'fixture guard: the consent really was seeded, so the answer below is about the toolchain and nothing else');
    assert.equal(openCodeDelegationActive(state), false,
      'consent alone is not delegation: without a stamped toolchain.opencode.installedVersion the gate must stay shut');
  });
});
