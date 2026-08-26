import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { STATE_FILE } from '../../../config/paths';
import { writeSimpleAuth } from '../../auth';
import { detectHost } from '../../host';
import { currentLocalPreferenceTarget } from '../../onboarding/local-prefs';
import { mergeProjectPrefs, readEffectiveState, readProjectPrefs, writeGlobalCodeGraphProvider } from '../../state';
import { applyAnswer, computeOnboarding } from '../flow';
import { effectiveOnboardingState, lacksDurableOnboardingState } from '../flow-view';

const HOST_ENV_KEYS = [
  'TRAFFIC_ONE_HOST',
  'CURSOR_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CODEX_THREAD_ID',
  'TRAFFIC_ONE_WINDSURF_BACKEND',
];

function withProject(committed: Record<string, unknown>, fn: (cwd: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-durable-opencode-')));
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  for (const key of HOST_ENV_KEYS) setEnv(key, undefined);
  setEnv('TRAFFIC_ONE_PROJECT_PREFS_PATH', path.join(dir, 'prefs.json'));
  setEnv('TRAFFIC_ONE_STATE_PATH', path.join(dir, 'one.json'));
  setEnv('XDG_STATE_HOME', path.join(dir, 'state'));
  setEnv('TRAFFIC_ONE_USER_PLAN', 'max');
  writeSimpleAuth('sk-durable-opencode-fixture');
  fs.mkdirSync(path.join(dir, path.dirname(STATE_FILE)), { recursive: true });
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(committed), 'utf8');
  try { fn(dir); } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function durableCheck(cwd: string): boolean {
  const env = process.env;
  const host = detectHost(env);
  const { state } = effectiveOnboardingState(cwd, env);
  return lacksDurableOnboardingState(cwd, state, host, env, currentLocalPreferenceTarget(host, env, cwd));
}

function readStateFile(cwd: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(cwd, STATE_FILE), 'utf8')) as Record<string, unknown>;
}

const COMMITTED = {
  mode: 'existing-codebase',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  realtime: 'none',
  confirmed: true,
  onboardingComplete: true,
  confirmedAt: '2026-01-01T00:00:00Z',
};

// lacksDurableOnboardingState used to carry a compensating line that copied
// `openCode` off the state object when the effective view had none:
//
//   if (!effective.openCode && state.openCode) effective.openCode = state.openCode;
//
// It was there because `.one.json` used to be a SOURCE of that consent —
// extractProjectPrefs routed a leaked `openCode` into the per-user store, so
// readEffectiveState (the function that supplies `state` at the guard's only
// caller, onboarding-server/flow.ts) could see a consent the guard's own
// readProjectPrefs read could not. Consent is now taken exclusively from the
// per-user store (prefs-split.ts's UNROUTED_PROJECT_PREF_KEYS), so both sides
// of that condition read the same source and it can no longer differ.
//
// These two shapes are pinned here so a future re-route of `openCode` cannot
// silently turn a state-file copy back into an answered wizard step.
//
// The discriminating assertion is the direct `durableCheck` one, not the
// step/done pins: measured against a mutant that resurrects the line reading
// `.one.json` directly, the guard flips to "satisfied" while `computeOnboarding`
// still reports `open-code`/not-done, because flow.ts's own
// nextLocalPreferenceStep has already reached the same conclusion one branch
// earlier. The step/done assertions are therefore the "changes nothing
// observable" pins, and the guard assertion is the one with teeth.
test('the wizard step and done are decided by the per-user consent, not by a copy in .one.json', () => {
  withProject(COMMITTED, (cwd) => {
    writeGlobalCodeGraphProvider('gitnexus');

    // ── consent PRESENT: the real wizard answer, recorded in the per-user store.
    assert.equal(computeOnboarding(cwd).step, 'open-code', 'fixture guard: the consent step is the one being answered');
    assert.equal(applyAnswer(cwd, 'open-code', 'enable').ok, true, 'writable baseline: the answer lands');
    assert.equal(applyAnswer(cwd, 'performance', 'low').ok, true, 'writable baseline: the performance answer lands');
    assert.equal(applyAnswer(cwd, 'code-graph', 'gitnexus').ok, true, 'writable baseline: this project acks the picker');

    const answered = computeOnboarding(cwd);
    assert.equal(answered.done, true, 'consent present: onboarding is done');
    assert.equal(answered.step, null, 'consent present: no step is pending');
    assert.equal(durableCheck(cwd), false, 'consent present: the durable-state guard is satisfied');
    assert.ok(readProjectPrefs(cwd).openCode, 'fixture guard: the consent lives in the per-user store');

    // ── consent ABSENT from the store, PRESENT in the committed state file.
    // Exactly the shape the deleted line compensated for: move the recorded
    // answer out of the per-user store and into `.traffic-one/.one.json`.
    const prefsPath = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH as string;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')) as Record<string, unknown>;
    const consent = prefs.openCode;
    assert.ok(consent, 'fixture guard: there is a recorded consent to move');
    delete prefs.openCode;
    fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    fs.writeFileSync(
      path.join(cwd, STATE_FILE),
      JSON.stringify({ ...readStateFile(cwd), openCode: consent }),
      'utf8',
    );

    assert.equal(readProjectPrefs(cwd).openCode, undefined, 'fixture guard: the store no longer carries the consent');
    assert.ok(readStateFile(cwd).openCode, 'fixture guard: the state file does');
    assert.equal(
      readEffectiveState(cwd).openCode,
      undefined,
      'the state file copy is not a consent source, so it never reaches effective state either',
    );

    const laundered = computeOnboarding(cwd);
    assert.equal(laundered.done, false, 'consent absent from the store: onboarding is NOT done');
    assert.equal(laundered.step, 'open-code', 'consent absent from the store: the consent step re-opens');
    assert.equal(durableCheck(cwd), true, 'and the durable-state guard is what says so');
  });
});

// Prefs can answer `openCode` while `.one.json` still lacks `openCodeDelegation`
// (a failed patch that wrote prefs first, or an older project enabled before
// the durable field existed). The step must reopen until the shared field
// lands; a state-file `openCode` copy still is not consent (test above).
test('prefs-answered OpenCode reopens until openCodeDelegation is on disk', () => {
  withProject(COMMITTED, (cwd) => {
    writeGlobalCodeGraphProvider('gitnexus');
    mergeProjectPrefs(cwd, { openCode: { enabled: true, source: 'prompted' } });

    const missing = computeOnboarding(cwd);
    assert.equal(missing.step, 'open-code', 'prefs without durable openCodeDelegation reopen the step');
    assert.equal(missing.done, false);
    assert.equal(readStateFile(cwd).openCodeDelegation, undefined, 'fixture guard: the durable field is absent');
    assert.ok(readProjectPrefs(cwd).openCode, 'fixture guard: prefs already answered');

    assert.equal(applyAnswer(cwd, 'open-code', 'enable').ok, true, 'the write that records the durable field lands');
    const after = computeOnboarding(cwd);
    assert.notEqual(after.step, 'open-code', 'once the durable field is on disk the step is no longer open-code');
    assert.equal(after.step, 'performance');
    assert.equal((readStateFile(cwd).openCodeDelegation as { approved?: boolean } | undefined)?.approved, true);
  });

  withProject({
    ...COMMITTED,
    openCodeDelegation: { approved: true, source: 'onboarding', decidedAt: '2026-01-01T00:00:00Z' },
  }, (cwd) => {
    writeGlobalCodeGraphProvider('gitnexus');
    mergeProjectPrefs(cwd, { openCode: { enabled: true, source: 'prompted' } });
    const view = computeOnboarding(cwd);
    assert.notEqual(view.step, 'open-code', 'durable approved:true is enough to leave open-code');
    assert.equal(view.step, 'performance');
  });
});
