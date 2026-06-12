import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { mergeProjectPrefs, readProjectPrefs } from '../local-prefs';

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
