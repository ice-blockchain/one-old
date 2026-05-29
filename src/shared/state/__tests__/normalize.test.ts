import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeState, readState, requireAddon, statePath, writeState } from '../normalize';
import { readEffectiveState } from '../local-prefs';
import { nextLocalPreferenceStep } from '../../onboarding/local-prefs';

function withPrefs<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-state-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
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

test('writeState keeps local prefs out of .one.json; readEffectiveState merges them back', () => {
  withPrefs((dir) => {
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

    const eff = readEffectiveState(dir);
    assert.equal(eff.codeGraphProvider, 'gitnexus');
    assert.deepEqual(eff.performance, { level: 'high', source: 'prompted' });
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

test('local onboarding preferences are isolated per user for the same project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-state-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const userAPrefs = path.join(dir, 'user-a-preferences.json');
  const userBPrefs = path.join(dir, 'user-b-preferences.json');
  try {
    process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = userAPrefs;
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
      codeGraphProvider: 'gitnexus',
      performance: { level: 'high', source: 'prompted' },
      team: { mode: 'subagents', source: 'prompted', approved: true },
    });

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
    assert.equal('openCode' in userBState, false);
    assert.equal('codeGraphProvider' in userBState, false);
    assert.equal('performance' in userBState, false);
    assert.equal('team' in userBState, false);
    assert.equal(userBState.stack, 'default');
    assert.equal(nextLocalPreferenceStep(userBState), 'open-code');
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
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
