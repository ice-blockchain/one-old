import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { mergeProjectPrefs, projectRootHash, readProjectPrefs } from '../local-prefs';
import { scrubProjectStateLocalPrefs } from '../normalize';

function withPrefs(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-prefs-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fn(dir);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const stamp = (prefs: Record<string, unknown>, tool: string): Record<string, unknown> => {
  const tc = prefs.toolchain as Record<string, Record<string, unknown>>;
  return tc[tool] ?? {};
};

// normalize embeds the initialized-null toolchain skeleton in shared state, so
// every writeState(readState(...)) round-trip merges nulls back into prefs. A
// null patch must never erase a real stamp — otherwise the wizard's install
// task stamps OpenCode and finalize immediately un-stamps it, leaving
// openCodeDelegationActive() false for the whole first build session.
test('toolchain merge: a null-skeleton patch never erases a real stamp', () => {
  withPrefs((cwd) => {
    mergeProjectPrefs(cwd, {
      toolchain: { opencode: { installedVersion: '1.15.13', installedAt: '2026-06-12T06:32:52Z', binPath: '/managed/bin/opencode' } },
    });
    mergeProjectPrefs(cwd, {
      toolchain: { opencode: { installedVersion: null, installedAt: null } },
    });
    const prefs = readProjectPrefs(cwd);
    assert.equal(stamp(prefs, 'opencode').installedVersion, '1.15.13');
    assert.equal(stamp(prefs, 'opencode').installedAt, '2026-06-12T06:32:52Z');
    assert.equal(stamp(prefs, 'opencode').binPath, '/managed/bin/opencode');
  });
});

test('toolchain merge: a real new stamp still overwrites an older one', () => {
  withPrefs((cwd) => {
    mergeProjectPrefs(cwd, { toolchain: { gitnexus: { installedVersion: '1.6.0', installedAt: '2026-01-01T00:00:00Z' } } });
    mergeProjectPrefs(cwd, { toolchain: { gitnexus: { installedVersion: '1.6.4', installedAt: '2026-06-12T00:00:00Z' } } });
    const prefs = readProjectPrefs(cwd);
    assert.equal(stamp(prefs, 'gitnexus').installedVersion, '1.6.4');
    assert.equal(stamp(prefs, 'gitnexus').installedAt, '2026-06-12T00:00:00Z');
  });
});

test('toolchain merge: null patches on never-stamped tools stay null', () => {
  withPrefs((cwd) => {
    mergeProjectPrefs(cwd, { toolchain: { graphify: { installedVersion: null, installedAt: null } } });
    const prefs = readProjectPrefs(cwd);
    assert.equal(stamp(prefs, 'graphify').installedVersion, null);
  });
});

test('scrubProjectStateLocalPrefs strips machine-local prefs a stale runner left in committed .one.json', () => {
  withPrefs((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    const stateFile = path.join(cwd, '.traffic-one', '.one.json');
    // The 6c-shape leak: a RAW .one.json carrying team / toolchain (machine binPath) / performance.
    fs.writeFileSync(stateFile, JSON.stringify({
      mode: 'new-project', stack: 'default', currentRunId: '1',
      performance: { level: 'balanced', source: 'prompted' },
      team: { mode: 'subagents', overrides: { 'senior-frontend': 'highest' } },
      toolchain: { gitnexus: { installedVersion: '1.6.7', binPath: '/Users/x/.traffic-one/toolchains/gitnexus/bin/gitnexus' } },
    }), 'utf8');

    assert.equal(scrubProjectStateLocalPrefs(cwd), true, 'scrubs when local-prefs are present');
    const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(!('performance' in onDisk) && !('team' in onDisk) && !('toolchain' in onDisk), '.one.json no longer carries local-prefs');
    assert.equal(onDisk.currentRunId, '1', 'durable project fields are preserved');
    // The stripped fields were routed to the per-user preferences.json (not lost).
    const prefs = readProjectPrefs(cwd);
    assert.ok('team' in prefs && 'toolchain' in prefs && 'performance' in prefs, 'local-prefs routed to preferences.json');
    // Idempotent: a clean .one.json is a no-op.
    assert.equal(scrubProjectStateLocalPrefs(cwd), false, 'no-op on an already-clean state file');
  });
});

test('readProjectPrefs falls back to hashed prefs when project-local prefs are selected but missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-prefs-fallback-'));
  const cwd = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const prevPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevHome = process.env.HOME;
  const prevXdg = process.env.XDG_STATE_HOME;
  fs.mkdirSync(cwd, { recursive: true });
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(cwd, '.traffic-one', 'preferences.json');
  process.env.HOME = home;
  delete process.env.XDG_STATE_HOME;
  try {
    const hashedPrefs = path.join(home, '.traffic-one', 'projects', projectRootHash(cwd), 'preferences.json');
    fs.mkdirSync(path.dirname(hashedPrefs), { recursive: true });
    fs.writeFileSync(hashedPrefs, JSON.stringify({
      performance: { level: 'balanced', source: 'prompted' },
      team: { mode: 'subagents', source: 'prompted', approved: true },
    }), 'utf8');

    const prefs = readProjectPrefs(cwd);
    assert.deepEqual(prefs.performance, { level: 'balanced', source: 'prompted' });
    assert.deepEqual(prefs.team, { mode: 'subagents', source: 'prompted', approved: true });
  } finally {
    if (prevPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
