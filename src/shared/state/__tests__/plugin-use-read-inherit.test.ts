import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { usePluginQuestionPending } from '../../onboarding-server/flow-view';
import { dirOwnsProject } from '../../project-membership';
import {
  defaultProjectPrefsPath,
  prefsCapableRoot,
  prefsCreateRefused,
} from '../local-prefs';
import {
  pluginUseEnabled,
  projectWritesPermitted,
  readPluginUseChoice,
  recordPluginUseChoice,
  resetPluginUseCache,
} from '../plugin-use';

// HOME/XDG isolated and TRAFFIC_ONE_PROJECT_PREFS_PATH unset so hashes are real.
// The pin is cwd-blind and would collapse parent and child onto one file.
function withMercuryTree(fn: (repo: string, child: string, env: NodeJS.ProcessEnv) => void): void {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-plugin-use-inherit-')));
  const env: NodeJS.ProcessEnv = {
    HOME: path.join(root, 'home'),
    XDG_STATE_HOME: path.join(root, 'xdg'),
    TRAFFIC_ONE_ASK_USE_PLUGIN: '1',
  };
  const repo = path.join(root, 'mercury');
  const child = path.join(repo, 'strategies');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  resetPluginUseCache();
  try {
    fn(repo, child, env);
  } finally {
    resetPluginUseCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('consent read inherits the enclosing prefs-capable root after the parent answers yes', () => {
  withMercuryTree((repo, child, env) => {
    assert.equal(dirOwnsProject(child), false, 'fixture guard: the package owns nothing');
    assert.equal(prefsCapableRoot(child, env), repo);
    assert.equal(recordPluginUseChoice(repo, true, 'command', env), true);

    assert.equal(readPluginUseChoice(child, env)?.enabled, true);
    assert.equal(pluginUseEnabled(child, env), true);
    assert.equal(projectWritesPermitted(child, env), true);
    assert.equal(usePluginQuestionPending(child, env), false);
  });
});

test('recordPluginUseChoice on a marker-less child still vetoes; parent yes is unchanged', () => {
  withMercuryTree((repo, child, env) => {
    assert.equal(recordPluginUseChoice(repo, true, 'command', env), true);
    const childPrefs = defaultProjectPrefsPath(child, env);
    assert.equal(fs.existsSync(childPrefs), false, 'fixture guard: no child bucket yet');

    const original = process.stderr.write;
    process.stderr.write = ((() => true) as unknown) as typeof process.stderr.write;
    try {
      assert.equal(recordPluginUseChoice(child, false, 'command', env), false);
    } finally {
      process.stderr.write = original;
    }
    assert.equal(readPluginUseChoice(repo, env)?.enabled, true, 'parent stays enabled');
    assert.equal(pluginUseEnabled(child, env), true, 'child read still follows the parent yes');
    assert.equal(fs.existsSync(childPrefs), false, 'child hash-keyed prefs file still absent');
  });
});

test('unanswered parent: child pending and write-fence match the parent', () => {
  withMercuryTree((repo, child, env) => {
    assert.equal(readPluginUseChoice(repo, env), null, 'fixture guard: parent unanswered');
    assert.equal(usePluginQuestionPending(child, env), true);
    assert.equal(usePluginQuestionPending(repo, env), true);
    assert.equal(projectWritesPermitted(child, env), false);
    assert.equal(projectWritesPermitted(repo, env), false);
  });
});

test('already-strayed child with its own hash-keyed decline is not inherited over', () => {
  withMercuryTree((repo, child, env) => {
    assert.equal(recordPluginUseChoice(repo, true, 'command', env), true);

    const childPrefs = defaultProjectPrefsPath(child, env);
    fs.mkdirSync(path.dirname(childPrefs), { recursive: true });
    fs.writeFileSync(childPrefs, `${JSON.stringify({
      pluginUse: { enabled: false, source: 'command', decidedAt: '2026-01-01T00:00:00.000Z' },
    })}\n`, 'utf8');
    resetPluginUseCache();

    assert.equal(prefsCreateRefused(child, env), false, 'fixture guard: existing stray bucket stays writable');
    assert.equal(prefsCapableRoot(child, env), child, 'reads stay on the child, not the parent');
    assert.equal(readPluginUseChoice(child, env)?.enabled, false);
    assert.equal(pluginUseEnabled(child, env), false);
    assert.equal(readPluginUseChoice(repo, env)?.enabled, true, 'parent yes is untouched');
  });
});
