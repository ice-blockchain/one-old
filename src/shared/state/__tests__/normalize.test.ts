import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeState, readState, requireAddon, statePath, writeState } from '../normalize';
import { preserveCurrentRunId } from '../project-state-lock';
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

test('writeState never blanks a live currentRunId (F1 lost-update); a new id still rotates', () => {
  withPrefs((dir) => {
    const A = '1715091785000';
    const B = '1715091999999';
    writeState(dir, { stack: 'default', mode: 'new-project', currentRunId: A });
    assert.equal(JSON.parse(fs.readFileSync(statePath(dir), 'utf8')).currentRunId, A);
    // A stale snapshot (e.g. the one-mcp/convergence writer, read before the mint)
    // that lacks currentRunId must NOT clobber the live id — the 11c double-mint cause.
    writeState(dir, { stack: 'default', mode: 'new-project' });
    assert.equal(JSON.parse(fs.readFileSync(statePath(dir), 'utf8')).currentRunId, A,
      'a stale snapshot must not blank currentRunId');
    // A legitimate rotation to a NEW id must still flip the pointer.
    writeState(dir, { stack: 'default', mode: 'new-project', currentRunId: B });
    assert.equal(JSON.parse(fs.readFileSync(statePath(dir), 'utf8')).currentRunId, B,
      'a new minted id must still rotate currentRunId');
  });
});

test('preserveCurrentRunId: fills only when replacement lacks an id; keeps a new/flipped id', () => {
  // absent in replacement, present on disk → restored
  assert.equal(preserveCurrentRunId({ currentRunId: 'A' }, { stack: 'x' }).currentRunId, 'A');
  // present in replacement (a legit flip) → kept, never frozen to the old id
  assert.equal(preserveCurrentRunId({ currentRunId: 'A' }, { currentRunId: 'B' }).currentRunId, 'B');
  // numeric replacement id counts as present → kept as-is
  assert.equal(preserveCurrentRunId({ currentRunId: 'A' }, { currentRunId: 12 }).currentRunId, 12);
  // blank replacement id + no disk id → never invents a real id
  assert.equal(String(preserveCurrentRunId({}, { currentRunId: '  ' }).currentRunId ?? '').trim(), '');
});

test('writeState keeps local prefs out of .one.json; readEffectiveState merges them back', () => {
  withPrefs((dir) => {
    const performanceTarget = { plan: 'pro', appliedFingerprint: 'a'.repeat(64), configVersion: 0 };
    mergeProjectHostPrefs(dir, 'codex', {
      performance: { level: 'high', source: 'prompted', target: performanceTarget },
      team: { mode: 'subagents', source: 'prompted', approved: true },
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
    assert.deepEqual(effBefore.performance, {
      level: 'high', source: 'prompted', target: performanceTarget,
    });
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
    const performanceTarget = { plan: 'pro', appliedFingerprint: 'a'.repeat(64), configVersion: 0 };
    process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = userAPrefs;
    mergeProjectHostPrefs(dir, 'codex', {
      performance: { level: 'high', source: 'prompted', target: performanceTarget },
      team: { mode: 'subagents', source: 'prompted', approved: true },
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
    assert.deepEqual(userAState.performance, {
      level: 'high', source: 'prompted', target: performanceTarget,
    });
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

// writeState is the single funnel for 30+ writers, including ones no resolver sees
// (the onboarding-wait runners take cwd from argv). Observed live: a Go PACKAGE
// inside a repo was initialized as its own project with a full new-project state.
test('writeState refuses to CREATE state in a directory that belongs to an enclosing project', () => {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-veto-')));
  try {
    const repo = path.join(container, 'mercury');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'go.mod'), 'module mercury\n', 'utf8');
    const pkg = path.join(repo, 'strategies');
    fs.mkdirSync(pkg, { recursive: true });

    // A package inside the repo: belongs to `mercury`, owns nothing → refused.
    writeState(pkg, { mode: 'new-project', stack: 'default' });
    assert.equal(fs.existsSync(statePath(pkg)), false, 'no state may be created inside a repo');

    // The repo root itself owns .git → always writable.
    writeState(repo, { mode: 'existing-codebase' });
    assert.equal(fs.existsSync(statePath(repo)), true, 'the repo root is a real project');

    // A nested module owning its own marker is its own project → writable.
    const nested = path.join(repo, 'tools', 'cli');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'go.mod'), 'module cli\n', 'utf8');
    writeState(nested, { mode: 'existing-codebase' });
    assert.equal(fs.existsSync(statePath(nested)), true, 'a nested module is its own project');

    // Creation-time only: a dir that ALREADY owns state keeps updating, so an
    // already-strayed root stays writable until the retention sweep heals it.
    const strayed = path.join(repo, 'handlers');
    fs.mkdirSync(path.join(strayed, '.traffic-one'), { recursive: true });
    fs.writeFileSync(statePath(strayed), JSON.stringify({ mode: 'new-project' }), 'utf8');
    writeState(strayed, { mode: 'existing-codebase', stack: 'custom-backend' });
    assert.equal(readState(strayed).mode, 'existing-codebase', 'existing state still updates');

    // A standalone dir belonging to nothing is unaffected (today's behavior).
    const solo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-veto-solo-')));
    try {
      writeState(solo, { mode: 'new-project' });
      assert.equal(fs.existsSync(statePath(solo)), true, 'a standalone dir is still its own project');
    } finally {
      fs.rmSync(solo, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});
