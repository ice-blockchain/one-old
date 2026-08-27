import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { sessionProjectRoot } from '../session-start-setup';
import { defaultProjectPrefsPath } from '../../../shared/state/local-prefs';
import type { Ctx, HookInput } from '../../../core/types';

function sessionCtx(cwd: string, workspaceRoot?: string): Ctx {
  const input: HookInput = {
    event: 'SessionStart',
    host: 'claude',
    cwd,
    workspaceRoot,
    raw: {},
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as Ctx;
}

describe('sessionProjectRoot remaps a marker-less child to the prefs-capable parent', { concurrency: 1 }, () => {
  function withIsolatedTree(fn: (root: string) => void): void {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-layer-c-session-')));
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

  test('child cwd + git parent → parent', () => {
    withIsolatedTree((root) => {
      const parent = path.join(root, 'mercury');
      const child = path.join(parent, 'strategies');
      fs.mkdirSync(child, { recursive: true });
      fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
      assert.equal(sessionProjectRoot(sessionCtx(child)), parent);
    });
  });

  test('child cwd + package.json-only parent → parent', () => {
    withIsolatedTree((root) => {
      const parent = path.join(root, 'pkg');
      const child = path.join(parent, 'src');
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(parent, 'package.json'), '{"name":"pkg"}\n', 'utf8');
      assert.equal(sessionProjectRoot(sessionCtx(child)), parent);
    });
  });

  test('ceiling === child + git parent → still parent', () => {
    withIsolatedTree((root) => {
      const parent = path.join(root, 'mercury');
      const child = path.join(parent, 'strategies');
      fs.mkdirSync(child, { recursive: true });
      fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
      assert.equal(sessionProjectRoot(sessionCtx(child, child)), parent);
    });
  });

  test('owning dir → itself', () => {
    withIsolatedTree((root) => {
      const gitDir = path.join(root, 'git-owned');
      fs.mkdirSync(path.join(gitDir, '.git'), { recursive: true });
      assert.equal(sessionProjectRoot(sessionCtx(gitDir)), gitDir);

      const pkgDir = path.join(root, 'pkg-owned');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), '{"name":"pkg-owned"}\n', 'utf8');
      assert.equal(sessionProjectRoot(sessionCtx(pkgDir)), pkgDir);
    });
  });

  test('already-strayed child with its own hash-keyed prefs file → itself', () => {
    withIsolatedTree((root) => {
      const parent = path.join(root, 'mercury');
      const child = path.join(parent, 'strategies');
      fs.mkdirSync(child, { recursive: true });
      fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
      const prefsPath = defaultProjectPrefsPath(child);
      fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
      fs.writeFileSync(prefsPath, '{}\n', 'utf8');
      // Ceiling === child is what hands the stray to prefsCapableRoot: without a
      // ceiling, resolve already walks to the git parent and never sees the bucket.
      assert.equal(sessionProjectRoot(sessionCtx(child, child)), child);
    });
  });
});
