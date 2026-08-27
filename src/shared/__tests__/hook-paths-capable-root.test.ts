import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  WORKSPACE_PROJECT_MODE,
  projectMembershipRoot,
  resolveProjectRoot,
} from '../hook/paths';
import { dirOwnsProject } from '../project-membership';
import { defaultProjectPrefsPath } from '../state/local-prefs';

function writeState(dir: string, json: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(json), 'utf8');
}

describe('resolveProjectRoot aligns with prefsCapableRoot', { concurrency: 1 }, () => {
  function withIsolatedTree(fn: (root: string) => void): void {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-hook-capable-')));
    const saved = {
      HOME: process.env.HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
      TRAFFIC_ONE_ASK_USE_PLUGIN: process.env.TRAFFIC_ONE_ASK_USE_PLUGIN,
    };
    process.env.HOME = path.join(root, 'home');
    process.env.XDG_STATE_HOME = path.join(root, 'xdg');
    delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
    try {
      fn(root);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  test('package.json-only parent: marker-less child resolves to the parent', () => {
    withIsolatedTree((root) => {
      const parent = path.join(root, 'pkg');
      const child = path.join(parent, 'src');
      const fileInChild = path.join(child, 'index.ts');
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(parent, 'package.json'), '{"name":"pkg"}\n', 'utf8');
      fs.writeFileSync(fileInChild, 'export {}\n', 'utf8');

      assert.equal(fs.existsSync(path.join(parent, '.git')), false, 'fixture guard: no VCS');
      assert.equal(projectMembershipRoot(child), null,
        'fixture guard: VCS-only ancestor absorb does not take the child');
      assert.equal(resolveProjectRoot(child), parent);
      assert.equal(resolveProjectRoot(child, fileInChild), parent);
    });
  });

  test('git parent + ceiling === child: membership stays null, resolve names the parent', () => {
    withIsolatedTree((root) => {
      const parent = path.join(root, 'mercury');
      const child = path.join(parent, 'strategies');
      fs.mkdirSync(child, { recursive: true });
      fs.mkdirSync(path.join(parent, '.git'), { recursive: true });

      assert.equal(projectMembershipRoot(child, child), null,
        'the host ceiling still blocks VCS ancestor absorb');
      assert.equal(resolveProjectRoot(child, '', { ceiling: child }), parent);
    });
  });

  test('leaked mode-bearing .one.json in a marker-less child resolves to the git parent', () => {
    withIsolatedTree((root) => {
      const parent = path.join(root, 'mercury');
      const child = path.join(parent, 'strategies');
      fs.mkdirSync(child, { recursive: true });
      fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
      writeState(child, { mode: 'new-project', onboardingComplete: true });

      assert.equal(dirOwnsProject(child), false, 'fixture guard: the leak owns nothing');
      assert.equal(resolveProjectRoot(child), parent);
      assert.notEqual(resolveProjectRoot(child), child,
        'isLeakedNestedRoot predicate: resolve !== child');
    });
  });

  test('same leak + ceiling === child still names the parent', () => {
    withIsolatedTree((root) => {
      const parent = path.join(root, 'mercury');
      const child = path.join(parent, 'strategies');
      fs.mkdirSync(child, { recursive: true });
      fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
      writeState(child, { mode: 'new-project', onboardingComplete: true });

      assert.equal(projectMembershipRoot(child, child), null,
        'fixture guard: ceiling still blocks membership');
      assert.equal(resolveProjectRoot(child, '', { ceiling: child }), parent);
      assert.notEqual(resolveProjectRoot(child, '', { ceiling: child }), child);
    });
  });

  test('a directory that owns a project resolves to itself', () => {
    withIsolatedTree((root) => {
      const gitDir = path.join(root, 'git-owned');
      fs.mkdirSync(path.join(gitDir, '.git'), { recursive: true });
      assert.equal(resolveProjectRoot(gitDir), gitDir);

      const pkgDir = path.join(root, 'pkg-owned');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), '{"name":"pkg-owned"}\n', 'utf8');
      assert.equal(resolveProjectRoot(pkgDir), pkgDir);
    });
  });

  test('already-strayed child with a hash-keyed prefs file and leaked state stays itself', () => {
    withIsolatedTree((root) => {
      const parent = path.join(root, 'mercury');
      const child = path.join(parent, 'strategies');
      fs.mkdirSync(child, { recursive: true });
      fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
      writeState(child, { mode: 'new-project', onboardingComplete: true });
      const prefsPath = defaultProjectPrefsPath(child);
      fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
      fs.writeFileSync(prefsPath, '{}\n', 'utf8');

      assert.equal(resolveProjectRoot(child, '', { ceiling: child }), child);
    });
  });

  test('a registered workspace member stays a root', () => {
    withIsolatedTree((root) => {
      const ws = path.join(root, 'ws');
      const member = path.join(ws, 'storefront');
      fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
      fs.mkdirSync(member, { recursive: true });
      fs.writeFileSync(path.join(member, 'package.json'), '{"name":"storefront"}\n', 'utf8');
      writeState(ws, {
        mode: WORKSPACE_PROJECT_MODE,
        onboardingComplete: true,
        workspaceMembers: [{ path: 'storefront' }],
      });
      writeState(member, { mode: 'existing-codebase', onboardingComplete: true });

      assert.equal(resolveProjectRoot(member), member);
    });
  });

  test('a genuinely unclaimed directory stays itself', () => {
    withIsolatedTree((root) => {
      const unclaimed = path.join(root, 'nowhere');
      fs.mkdirSync(unclaimed, { recursive: true });
      assert.equal(dirOwnsProject(unclaimed), false, 'fixture guard: owns nothing');
      assert.equal(projectMembershipRoot(path.dirname(unclaimed)), null,
        'fixture guard: nothing above this dir is a membership root');
      assert.equal(resolveProjectRoot(unclaimed), unclaimed);
    });
  });
});
