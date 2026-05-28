import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { isInPluginCache, isManagedPluginCachePath, pluginRoot } from '../paths';

test('isManagedPluginCachePath detects both Claude and Codex managed cache installs', () => {
  const claude = ['', 'home', 'u', '.claude', 'plugins', 'cache', 'traffic-one'].join(path.sep);
  const codex = ['', 'home', 'u', '.codex', 'plugins', 'cache', 'traffic-one'].join(path.sep);
  assert.equal(isManagedPluginCachePath(claude), true);
  assert.equal(isManagedPluginCachePath(codex), true);
  // A normal project checkout is NOT a managed cache path (so materialization runs).
  assert.equal(isManagedPluginCachePath(['', 'home', 'u', 'projects', 'myapp'].join(path.sep)), false);
  // A .claude dir that is not the plugins/cache subtree is not flagged.
  assert.equal(isManagedPluginCachePath(['', 'home', 'u', '.claude', 'projects', 'x'].join(path.sep)), false);
});

test('isInPluginCache reflects the resolved plugin root', () => {
  const saved = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  try {
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = ['', 'home', 'u', '.claude', 'plugins', 'cache', 'traffic-one'].join(path.sep);
    assert.equal(pluginRoot(), process.env.TRAFFIC_ONE_PLUGIN_ROOT);
    assert.equal(isInPluginCache(), true);
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = ['', 'home', 'u', 'dev', 'traffic-one'].join(path.sep);
    assert.equal(isInPluginCache(), false);
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = saved;
  }
});
