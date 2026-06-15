import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  findProjectRootForHookFile,
  isOnboardedProjectRoot,
  isUnclaimedWorkspaceSubPackage,
  packageJsonDeclaresWorkspace,
  projectRelativeHookPath,
  resolveProjectRoot,
  stateRequiresNewProjectMonorepo,
} from '../hook-paths';

function writeState(dir: string, json: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(json), 'utf8');
}

function writePkg(dir: string, json: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json), 'utf8');
}

test('stateRequiresNewProjectMonorepo: default/realtime stacks and react+backend require monorepo', () => {
  assert.equal(stateRequiresNewProjectMonorepo({ mode: 'new-project', stack: 'default' }), true);
  assert.equal(stateRequiresNewProjectMonorepo({ mode: 'new-project', stack: 'react-realtime-monorepo' }), true);
  assert.equal(
    stateRequiresNewProjectMonorepo({ mode: 'new-project', stack: 'custom', frontend: 'react-vite', backend: 'supabase' }),
    true,
  );
});

test('stateRequiresNewProjectMonorepo: no backend, wrong mode, or native are not monorepo', () => {
  assert.equal(
    stateRequiresNewProjectMonorepo({ mode: 'new-project', stack: 'custom', frontend: 'react-vite', backend: 'none' }),
    false,
  );
  assert.equal(stateRequiresNewProjectMonorepo({ mode: 'existing-codebase', stack: 'default' }), false);
  // native (mobile-only) state is excluded even when stack would otherwise qualify
  assert.equal(
    stateRequiresNewProjectMonorepo({ mode: 'new-project', stack: 'default', mobile: { framework: 'react-native-expo' }, frontend: 'none', backend: 'none' }),
    false,
  );
  assert.equal(stateRequiresNewProjectMonorepo({} as Record<string, unknown>), false);
});

test('packageJsonDeclaresWorkspace: empty content is treated as a declared workspace', () => {
  assert.equal(packageJsonDeclaresWorkspace(''), true);
  assert.equal(packageJsonDeclaresWorkspace('   '), true);
});

test('packageJsonDeclaresWorkspace: a private pnpm workspace root qualifies', () => {
  const monorepo = JSON.stringify({
    private: true,
    packageManager: 'pnpm@9.1.0',
    workspaces: ['apps/*', 'packages/*'],
  });
  assert.equal(packageJsonDeclaresWorkspace(monorepo), true);

  const pnpmObjForm = JSON.stringify({
    private: true,
    packageManager: 'pnpm@8.0.0',
    workspaces: { packages: ['apps/*'] },
  });
  assert.equal(packageJsonDeclaresWorkspace(pnpmObjForm), true);
});

test('packageJsonDeclaresWorkspace: missing private/workspaces/pnpm fields fail the check', () => {
  assert.equal(packageJsonDeclaresWorkspace(JSON.stringify({ name: 'app' })), false);
  assert.equal(
    packageJsonDeclaresWorkspace(JSON.stringify({ private: true, workspaces: ['apps/*'] })),
    false,
  ); // no pnpm packageManager
  assert.equal(
    packageJsonDeclaresWorkspace(JSON.stringify({ private: true, packageManager: 'npm@10' })),
    false,
  );
  // malformed JSON falls back to "declared" so the gate never hard-fails on parse errors
  assert.equal(packageJsonDeclaresWorkspace('{not json'), true);
});

test('findProjectRootForHookFile + projectRelativeHookPath resolve nested .traffic-one sub-apps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-hookpaths-'));
  try {
    // Nested monorepo sub-app with its own .traffic-one state file.
    const appRoot = path.join(root, 'apps', 'web');
    fs.mkdirSync(path.join(appRoot, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, '.traffic-one', '.one.json'), '{}', 'utf8');
    const target = path.join(appRoot, 'src', 'main.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x', 'utf8');

    const found = findProjectRootForHookFile(root, target);
    assert.equal(found, appRoot);
    assert.equal(projectRelativeHookPath(root, found, target), 'src/main.ts');

    // A file with no enclosing state file falls back to cwd.
    const orphan = path.join(root, 'tools', 'thing.ts');
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, 'x', 'utf8');
    assert.equal(findProjectRootForHookFile(root, orphan), root);

    // Empty file path → cwd / empty relative.
    assert.equal(findProjectRootForHookFile(root, ''), root);
    assert.equal(projectRelativeHookPath(root, root, ''), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isOnboardedProjectRoot: only a mode-bearing .one.json counts', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-onboarded-')));
  try {
    assert.equal(isOnboardedProjectRoot(dir), false);          // no state file
    writeState(dir, { 'one-uid': 'x' });
    assert.equal(isOnboardedProjectRoot(dir), false);          // shallow stray (no mode)
    writeState(dir, { mode: 'new-project' });
    assert.equal(isOnboardedProjectRoot(dir), true);           // real root
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveProjectRoot: a stray shallow sub-package state never shadows the real monorepo root', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-resolveroot-')));
  try {
    // Onboarded monorepo root + a sub-package that accrued a stray shallow state.
    writeState(root, { mode: 'new-project', onboardingComplete: true });
    const appRoot = path.join(root, 'apps', 'web');
    writeState(appRoot, { 'one-uid': 'stray' });               // no mode — not a real root
    const target = path.join(appRoot, 'src', 'main.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x', 'utf8');

    // Resolves to the workspace root whether cwd is the root OR the sub-package.
    assert.equal(resolveProjectRoot(root, target), root);
    assert.equal(resolveProjectRoot(appRoot, target), root);
    assert.equal(resolveProjectRoot(appRoot, ''), root);        // bash-style: no file, sub-package cwd

    // A genuinely nested project (its own mode-bearing state) resolves to itself.
    const nested = path.join(root, 'packages', 'standalone');
    writeState(nested, { mode: 'new-project' });
    const nestedFile = path.join(nested, 'src', 'x.ts');
    fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
    fs.writeFileSync(nestedFile, 'x', 'utf8');
    assert.equal(resolveProjectRoot(root, nestedFile), nested);

    // No onboarded ancestor anywhere → falls back to cwd (gating of a fresh
    // project is unchanged).
    const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-fresh-')));
    try {
      assert.equal(resolveProjectRoot(fresh, path.join(fresh, 'a.ts')), fresh);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveProjectRoot: an UN-onboarded monorepo anchors at the workspace root, not a sub-package', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-wsroot-')));
  try {
    // Workspace root that has NOT been onboarded yet (no mode-bearing .one.json) —
    // exactly the mid-onboarding state where the old code fell back to the cwd and
    // minted a stray .traffic-one into the sub-package.
    writePkg(root, { name: 'mono', private: true, workspaces: ['packages/*', 'apps/*'] });
    const ui = path.join(root, 'packages', 'ui');
    const target = path.join(ui, 'src', 'index.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x', 'utf8');

    // A tool whose cwd OR target is the sub-package resolves UP to the workspace root.
    assert.equal(resolveProjectRoot(ui, ''), root);
    assert.equal(resolveProjectRoot(root, target), root);
    assert.equal(resolveProjectRoot(ui, target), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveProjectRoot: a LEAKED mode-bearing sub-package state never shadows the workspace root', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-leakroot-')));
  try {
    // Onboarded workspace root that DECLARES workspaces…
    writePkg(root, { name: 'mono', private: true, workspaces: ['packages/*'] });
    writeState(root, { mode: 'new-project', onboardingComplete: true });
    // …plus a leaked, mode-bearing .traffic-one inside a sub-package (the incident:
    // it looks like an onboarded root, so the old walk adopted it and re-onboarded).
    const ui = path.join(root, 'packages', 'ui');
    writeState(ui, { mode: 'new-project' });
    const target = path.join(ui, 'src', 'index.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x', 'utf8');

    // The leak is skipped in favor of the workspace root, from either vantage.
    assert.equal(resolveProjectRoot(root, target), root);
    assert.equal(resolveProjectRoot(ui, target), root);
    assert.equal(resolveProjectRoot(ui, ''), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveProjectRoot: a pnpm-workspace.yaml root is recognized as the anchor too', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-wsyaml-')));
  try {
    writePkg(root, { name: 'mono2', private: true });
    fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n', 'utf8');
    const api = path.join(root, 'packages', 'api');
    fs.mkdirSync(api, { recursive: true });
    assert.equal(resolveProjectRoot(api, ''), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isUnclaimedWorkspaceSubPackage: true for a state-less sub-package, false for the root or a state-owning package', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-subpkg-')));
  try {
    writePkg(root, { name: 'mono', private: true, workspaces: ['packages/*'] });
    const ui = path.join(root, 'packages', 'ui');
    fs.mkdirSync(ui, { recursive: true });

    assert.equal(isUnclaimedWorkspaceSubPackage(ui), true);    // inside a workspace, owns no state
    assert.equal(isUnclaimedWorkspaceSubPackage(root), false); // the workspace root itself

    // Once the sub-package owns a state file it is a real root — never blocked.
    writeState(ui, { mode: 'new-project' });
    assert.equal(isUnclaimedWorkspaceSubPackage(ui), false);

    // A standalone dir with no workspace ancestor is never a sub-package.
    const solo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-solo-')));
    try {
      assert.equal(isUnclaimedWorkspaceSubPackage(solo), false);
    } finally {
      fs.rmSync(solo, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveProjectRoot never escapes into the home directory (stray ~/.traffic-one)', () => {
  const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-home-')));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    // This test relies on os.homedir() honoring $HOME (POSIX); assert it up front so
    // a platform that ignores it fails loudly rather than silently passing.
    assert.equal(require('os').homedir(), fakeHome, 'os.homedir() must honor $HOME for this test');
    // A stray mode-bearing state in the home dir — e.g. from running the plugin in ~ once.
    writeState(fakeHome, { mode: 'new-project', onboardingComplete: true });
    // A project under home that has NO state file of its own.
    const proj = path.join(fakeHome, 'work', 'myapp');
    const file = path.join(proj, 'src', 'a.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x', 'utf8');
    // Must fall back to the project dir — never adopt the home-dir state.
    assert.equal(resolveProjectRoot(proj, file), proj);
    assert.equal(resolveProjectRoot(proj, ''), proj);
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('resolveProjectRoot skips an authoring repo with a stray onboarded state file and resolves the parent workspace', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't1-hookpaths-parent-'));
  try {
    // Parent = a real onboarded workspace.
    fs.mkdirSync(path.join(parent, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(parent, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase', stack: 'minimal' }), 'utf8');
    // Nested plugin authoring repo carrying a STRAY onboarded state file (the incident).
    const repo = path.join(parent, 'one');
    fs.mkdirSync(path.join(repo, 'src', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'gen', 'index.ts'), '// gen', 'utf8');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
    fs.mkdirSync(path.join(repo, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.traffic-one', '.one.json'), JSON.stringify({ mode: 'existing-codebase', stack: 'minimal' }), 'utf8');

    const resolved = resolveProjectRoot(parent, path.join(repo, 'src', 'shared', 'x.ts'));
    assert.equal(fs.realpathSync(resolved), fs.realpathSync(parent), 'must skip the authoring repo and adopt the parent workspace');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
