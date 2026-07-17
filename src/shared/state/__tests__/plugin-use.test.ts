import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  clearPluginUseChoice,
  pluginUseDeclined,
  pluginUseEnabled,
  readPluginUseChoice,
  recordPluginUseChoice,
  removeDeclinedProjectArtifacts,
} from '../plugin-use';

function withProject(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-plugin-use-'));
  const prev = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try {
    fn(path.join(dir, 'project'));
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('plugin-use choice: record → read → clear roundtrip, stored OUTSIDE the project', () => {
  withProject((cwd) => {
    fs.mkdirSync(cwd, { recursive: true });
    assert.equal(readPluginUseChoice(cwd), null);
    assert.equal(pluginUseDeclined(cwd), false);
    assert.equal(pluginUseEnabled(cwd), false);

    recordPluginUseChoice(cwd, false, 'command');
    assert.equal(pluginUseDeclined(cwd), true);
    assert.equal(pluginUseEnabled(cwd), false);
    assert.equal(readPluginUseChoice(cwd)?.enabled, false);
    assert.equal(readPluginUseChoice(cwd)?.source, 'command');
    // The choice never creates project files.
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false);

    recordPluginUseChoice(cwd, true, 'command');
    assert.equal(pluginUseDeclined(cwd), false);
    assert.equal(pluginUseEnabled(cwd), true);
    assert.equal(readPluginUseChoice(cwd)?.enabled, true);

    clearPluginUseChoice(cwd);
    assert.equal(readPluginUseChoice(cwd), null);
  });
});

test('decline sweeps a never-onboarded .traffic-one but preserves real onboarded state', () => {
  withProject((cwd) => {
    // Runtime junk only (once-markers) — swept on decline.
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'runs', '.once'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'runs', '.once', 'marker'), 'x', 'utf8');
    recordPluginUseChoice(cwd, false, 'command');
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'runtime-only dir swept');

    // A mode-bearing .one.json is REAL state — never deleted by a decline.
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase' }), 'utf8');
    removeDeclinedProjectArtifacts(cwd);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', '.one.json')), true, 'onboarded state preserved');
  });
});
