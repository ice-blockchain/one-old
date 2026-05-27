import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  findProjectRootForHookFile,
  packageJsonDeclaresWorkspace,
  projectRelativeHookPath,
  stateRequiresNewProjectMonorepo,
} from '../hook-paths';

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
