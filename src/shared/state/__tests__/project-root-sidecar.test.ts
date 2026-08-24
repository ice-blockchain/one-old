import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isNonProjectRoot } from '../../authoring-root';
import { materializeProjectAssets } from '../../materialize/materialize';
import {
  defaultProjectPrefsPath,
  mergeProjectPrefs,
  projectPrefsPath,
  projectRootHash,
  projectRootSidecarPath,
  readProjectRootSidecar,
  resolvedProjectRoot,
  writeProjectPrefs,
  writeProjectRootSidecar,
} from '../local-prefs';
import { updateProjectPrefs } from '../local-prefs/prefs-store';
import { recordPluginUseChoice, resetPluginUseCache } from '../plugin-use';

function withIsolatedDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sidecar-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function isolatedEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: path.join(dir, 'home'),
    XDG_STATE_HOME: path.join(dir, 'xdg'),
    ...extra,
  };
}

function withIsolatedProcessHome(dir: string, fn: () => void): void {
  const prevHome = process.env.HOME;
  const prevXdg = process.env.XDG_STATE_HOME;
  const prevPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.HOME = path.join(dir, 'home');
  process.env.XDG_STATE_HOME = path.join(dir, 'xdg');
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  try {
    fn();
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdg;
    if (prevPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
  }
}

function sidecarFilesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) walk(full);
      else if (name === 'root') found.push(full);
    }
  };
  walk(root);
  return found;
}

function assertSidecar(cwd: string, prefsPath: string): void {
  const sidecarPath = projectRootSidecarPath(prefsPath);
  const expected = resolvedProjectRoot(cwd);
  assert.equal(fs.readFileSync(sidecarPath, 'utf8'), `${expected}\n`);
  assert.equal(fs.statSync(sidecarPath).mode & 0o777, 0o600);
  assert.equal(readProjectRootSidecar(sidecarPath), expected);
  assert.equal(readProjectRootSidecar(path.dirname(prefsPath)), expected);
}

test('writeProjectPrefs writes sibling root containing resolvedProjectRoot(cwd)', () => {
  withIsolatedDir((dir) => {
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const prefsPath = path.join(dir, 'prefs.json');
    const env = isolatedEnv(dir, { TRAFFIC_ONE_PROJECT_PREFS_PATH: prefsPath });

    writeProjectPrefs(cwd, { originalPrompt: 'sidecar-write' }, env);

    assert.equal(fs.existsSync(prefsPath), true);
    assertSidecar(cwd, prefsPath);
  });
});

test('updateProjectPrefs / mergeProjectPrefs refreshes the sidecar if cwd is the same', () => {
  withIsolatedDir((dir) => {
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const prefsPath = path.join(dir, 'prefs.json');
    const env = isolatedEnv(dir, { TRAFFIC_ONE_PROJECT_PREFS_PATH: prefsPath });
    const sidecarPath = projectRootSidecarPath(prefsPath);

    writeProjectPrefs(cwd, { originalPrompt: 'first' }, env);
    fs.writeFileSync(sidecarPath, '/stale/path\n', 'utf8');
    assert.equal(readProjectRootSidecar(sidecarPath), '/stale/path');

    updateProjectPrefs(cwd, env, (current) => ({ ...current, originalPrompt: 'updated' }));
    assertSidecar(cwd, prefsPath);

    fs.writeFileSync(sidecarPath, '/stale/again\n', 'utf8');
    mergeProjectPrefs(cwd, { originalPrompt: 'merged' }, env);
    assertSidecar(cwd, prefsPath);
  });
});

test('TRAFFIC_ONE_PROJECT_PREFS_PATH sidecar is that file\'s sibling root, not under home', () => {
  withIsolatedDir((dir) => {
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const prefsPath = path.join(dir, 'custom', 'prefs.json');
    const env = isolatedEnv(dir, { TRAFFIC_ONE_PROJECT_PREFS_PATH: prefsPath });

    writeProjectPrefs(cwd, { originalPrompt: 'custom-path' }, env);

    assert.equal(projectPrefsPath(cwd, env), path.resolve(prefsPath));
    assertSidecar(cwd, prefsPath);
    assert.equal(fs.existsSync(path.join(env.HOME as string, '.traffic-one')), false);
    assert.equal(fs.existsSync(path.join(env.XDG_STATE_HOME as string, 'traffic-one')), false);
  });
});

test('default bucket sidecar is under globalTrafficOneDir/projects/<hash>/root', () => {
  withIsolatedDir((dir) => {
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const env = isolatedEnv(dir);

    writeProjectPrefs(cwd, { originalPrompt: 'default-bucket' }, env);

    const prefsPath = defaultProjectPrefsPath(cwd, env);
    assert.equal(
      prefsPath,
      path.join(env.XDG_STATE_HOME as string, 'traffic-one', 'projects', projectRootHash(cwd), 'preferences.json'),
    );
    assertSidecar(cwd, prefsPath);
    assert.equal(fs.existsSync(path.join(env.HOME as string, '.traffic-one')), false);
  });
});

test('writeProjectRootSidecar is best-effort: a missing parent does not throw', () => {
  withIsolatedDir((dir) => {
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    const blocker = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocker, 'file\n', 'utf8');
    const env = isolatedEnv(dir, {
      TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(blocker, 'nested', 'prefs.json'),
    });

    assert.doesNotThrow(() => writeProjectRootSidecar(cwd, env));
    assert.doesNotThrow(() => writeProjectRootSidecar('', env));
    assert.equal(readProjectRootSidecar(path.join(blocker, 'nested')), null);
  });
});

test('materializeProjectAssets on plugin-authoring root does not write a sidecar', () => {
  withIsolatedDir((dir) => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    assert.equal(isNonProjectRoot(repoRoot), true);

    withIsolatedProcessHome(dir, () => {
      materializeProjectAssets(repoRoot, {});
      const prefsPath = defaultProjectPrefsPath(repoRoot);
      assert.equal(fs.existsSync(projectRootSidecarPath(prefsPath)), false);
      assert.equal(readProjectRootSidecar(path.dirname(prefsPath)), null);
    });
  });
});

test('nested-member create refusal does not write a sidecar', () => {
  withIsolatedDir((dir) => {
    const repo = path.join(dir, 'repo');
    const cwd = path.join(repo, 'packages', 'api');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"repo"}\n', 'utf8');
    fs.writeFileSync(path.join(repo, '.git'), 'gitdir: elsewhere\n', 'utf8');
    const env = isolatedEnv(dir);

    updateProjectPrefs(cwd, env, (current) => ({ ...current, originalPrompt: 'nope' }));

    const prefsPath = defaultProjectPrefsPath(cwd, env);
    assert.equal(fs.existsSync(prefsPath), false);
    assert.equal(fs.existsSync(projectRootSidecarPath(prefsPath)), false);
    assert.equal(readProjectRootSidecar(path.dirname(prefsPath)), null);
  });
});

test('materialize consented path writes a sidecar', () => {
  withIsolatedDir((dir) => {
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"sidecar-consented"}\n', 'utf8');

    withIsolatedProcessHome(dir, () => {
      try {
        recordPluginUseChoice(cwd, true, 'test');
        const prefsPath = defaultProjectPrefsPath(cwd);
        const sidecarPath = projectRootSidecarPath(prefsPath);
        fs.writeFileSync(sidecarPath, '/stale/materialize-path\n', 'utf8');
        materializeProjectAssets(cwd, {});
        assert.equal(fs.existsSync(sidecarPath), true);
        assert.equal(readProjectRootSidecar(sidecarPath), resolvedProjectRoot(cwd));
      } finally {
        resetPluginUseCache();
      }
    });
  });
});

test('materialize consent refusal does not write a sidecar', () => {
  withIsolatedDir((dir) => {
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"sidecar-pending"}\n', 'utf8');

    const prevAsk = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    withIsolatedProcessHome(dir, () => {
      process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
      try {
        resetPluginUseCache();
        const result = materializeProjectAssets(cwd, {});
        assert.equal(result.skipped, 'plugin-use-not-permitted');
        const prefsPath = defaultProjectPrefsPath(cwd);
        assert.equal(fs.existsSync(projectRootSidecarPath(prefsPath)), false);
        assert.deepEqual(sidecarFilesUnder(path.join(dir, 'home')), []);
        assert.deepEqual(sidecarFilesUnder(path.join(dir, 'xdg')), []);
      } finally {
        resetPluginUseCache();
        if (prevAsk === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
        else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = prevAsk;
      }
    });
  });
});
