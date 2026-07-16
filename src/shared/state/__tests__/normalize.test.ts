import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeState, readState, requireAddon, statePath, writeState } from '../normalize';
import { mergeProjectHostPrefs, readEffectiveState, writeGlobalCodeGraphProvider } from '../local-prefs';
import { nextLocalPreferenceStep } from '../../onboarding/local-prefs';

// Isolate BOTH the per-project prefs file and one.json (the machine-wide store that
// now holds codeGraphProvider) so tests never read/write the real ~/.traffic-one.
function withPrefs<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-state-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = process.env.TRAFFIC_ONE_STATE_PATH;
  const prevHost = process.env.TRAFFIC_ONE_HOST;
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  process.env.TRAFFIC_ONE_HOST = 'codex';
  process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    if (prevState === undefined) delete process.env.TRAFFIC_ONE_STATE_PATH;
    else process.env.TRAFFIC_ONE_STATE_PATH = prevState;
    if (prevHost === undefined) delete process.env.TRAFFIC_ONE_HOST;
    else process.env.TRAFFIC_ONE_HOST = prevHost;
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
    else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizeState fills bookkeeping + seeds defaults for a stack', () => {
  const s: Record<string, unknown> = { stack: 'default' };
  assert.equal(normalizeState(s, 'new-project'), true);
  assert.equal(s.mode, 'new-project');
  assert.equal(s.confirmed, true);
  assert.equal(s.onboardingComplete, true);
  assert.equal(s.frontend, 'react-vite');
  assert.equal(s.backend, 'supabase');
  assert.deepEqual(s.mobile, { enabled: false, framework: 'none', source: 'none' });
  assert.equal(Array.isArray((s.technologies as Record<string, unknown>).frontend), true);
  assert.equal(s.supabaseFunctionsAutoDeploy, 'ask');
});

test('currentRunId is normalized to the digit string gates expect', () => {
  withPrefs((dir) => {
    writeState(dir, { stack: 'default', mode: 'new-project', currentRunId: 1715091785000 });
    const onDisk = JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
    assert.equal(onDisk.currentRunId, '1715091785000');

    fs.writeFileSync(statePath(dir), JSON.stringify({ stack: 'default', currentRunId: 1715091785001 }), 'utf8');
    assert.equal(readEffectiveState(dir).currentRunId, '1715091785001');
  });
});

test('writeState keeps local prefs out of .one.json; readEffectiveState merges them back', () => {
  withPrefs((dir) => {
    mergeProjectHostPrefs(dir, 'codex', {
      performance: { level: 'high', source: 'prompted' },
      team: { mode: 'subagents', source: 'prompted', approved: true },
      configuredFor: { plan: 'pro', modelsUpdatedAt: '2026-07-12' },
    });
    writeState(dir, {
      stack: 'default', mode: 'new-project',
      codeGraphProvider: 'gitnexus',
      performance: { level: 'high', source: 'prompted' },
    });
    const onDisk = JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
    assert.equal('codeGraphProvider' in onDisk, false);
    assert.equal('performance' in onDisk, false);
    assert.equal(onDisk.stack, 'default');
    assert.equal(typeof onDisk.version, 'string');

    // performance (a per-project pref) merges back from preferences.json …
    const effBefore = readEffectiveState(dir);
    assert.deepEqual(effBefore.performance, { level: 'high', source: 'prompted' });
    // … codeGraphProvider is machine-wide now (one.json), so writeState drops it; it
    // only appears in the effective state once set globally.
    assert.equal('codeGraphProvider' in effBefore, false);
    writeGlobalCodeGraphProvider('gitnexus');
    assert.equal(readEffectiveState(dir).codeGraphProvider, 'gitnexus');
  });
});

test('readState strips local-pref fields embedded in .one.json', () => {
  withPrefs((dir) => {
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(
      statePath(dir),
      JSON.stringify({ stack: 'default', codeGraphProvider: 'gitnexus', performance: { level: 'high' } }),
      'utf8',
    );
    const s = readState(dir);
    assert.equal(s.stack, 'default');
    assert.equal('codeGraphProvider' in s, false);
    assert.equal('performance' in s, false);
  });
});

test('per-user prefs are isolated; codeGraphProvider is shared machine-wide', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-state-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevState = process.env.TRAFFIC_ONE_STATE_PATH;
  const prevHost = process.env.TRAFFIC_ONE_HOST;
  const prevPlan = process.env.TRAFFIC_ONE_USER_PLAN;
  const userAPrefs = path.join(dir, 'user-a-preferences.json');
  const userBPrefs = path.join(dir, 'user-b-preferences.json');
  process.env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  process.env.TRAFFIC_ONE_HOST = 'codex';
  process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = userAPrefs;
    mergeProjectHostPrefs(dir, 'codex', {
      performance: { level: 'high', source: 'prompted' },
      team: { mode: 'subagents', source: 'prompted', approved: true },
      configuredFor: { plan: 'pro', modelsUpdatedAt: '2026-07-12' },
    });
    writeState(dir, {
      stack: 'default',
      mode: 'new-project',
      frontend: 'react-vite',
      backend: 'supabase',
      projectContext: {
        source: 'prompted',
        originalPrompt: 'Build a dashboard',
        summary: 'Dashboard',
        answers: { audience: 'Operators' },
        collectedAt: '2026-01-01T00:00:00Z',
      },
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
      technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
      realtime: 'none',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-01-01T00:00:00Z',
      openCode: { enabled: true, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
      performance: { level: 'high', source: 'prompted' },
      team: { mode: 'subagents', source: 'prompted', approved: true },
    });
    // codeGraphProvider is machine-wide (one.json), not a per-user pref.
    writeGlobalCodeGraphProvider('gitnexus');

    const onDisk = JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
    assert.equal('openCode' in onDisk, false);
    assert.equal('codeGraphProvider' in onDisk, false);
    assert.equal('performance' in onDisk, false);
    assert.equal('team' in onDisk, false);

    const userAState = readEffectiveState(dir);
    assert.equal(userAState.codeGraphProvider, 'gitnexus');
    assert.deepEqual(userAState.performance, { level: 'high', source: 'prompted' });
    assert.equal((userAState.team as Record<string, unknown>).approved, true);

    process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = userBPrefs;
    const userBState = readEffectiveState(dir);
    // user B has their own (empty) prefs …
    assert.equal('openCode' in userBState, false);
    assert.equal('performance' in userBState, false);
    assert.equal('team' in userBState, false);
    assert.equal(userBState.stack, 'default');
    // … but shares the machine-wide codeGraphProvider with user A.
    assert.equal(userBState.codeGraphProvider, 'gitnexus');
    assert.equal(nextLocalPreferenceStep(userBState), 'open-code');
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    if (prevState === undefined) delete process.env.TRAFFIC_ONE_STATE_PATH;
    else process.env.TRAFFIC_ONE_STATE_PATH = prevState;
    if (prevHost === undefined) delete process.env.TRAFFIC_ONE_HOST;
    else process.env.TRAFFIC_ONE_HOST = prevHost;
    if (prevPlan === undefined) delete process.env.TRAFFIC_ONE_USER_PLAN;
    else process.env.TRAFFIC_ONE_USER_PLAN = prevPlan;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('requireAddon gate reflects supabaseAddons status', () => {
  assert.deepEqual(requireAddon({ supabaseAddons: { storage: 'approved' } }, 'storage'), {
    approved: true, skipped: false, status: 'approved', known: true,
  });
  assert.equal(requireAddon({}, 'storage').status, 'pending');
  assert.equal(requireAddon({}, 'bogus').known, false);
});
