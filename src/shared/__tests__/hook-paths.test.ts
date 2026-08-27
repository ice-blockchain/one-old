import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  dirOwnsProject,
  findProjectRootForHookFile,
  isOnboardedProjectRoot,
  isUnclaimedWorkspaceSubPackage,
  packageJsonDeclaresWorkspace,
  projectMembershipRoot,
  projectRelativeHookPath,
  resolveProjectRoot,
  stateRequiresNewProjectMonorepo,
  stripStateDirSuffix,
} from '../hook/paths';

function writeState(dir: string, json: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(json), 'utf8');
}

function writePkg(dir: string, json: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json), 'utf8');
}

test('stateRequiresNewProjectMonorepo: only the named default/realtime profiles require monorepo', () => {
  assert.equal(stateRequiresNewProjectMonorepo({ mode: 'new-project', stack: 'default' }), true);
  assert.equal(stateRequiresNewProjectMonorepo({ mode: 'new-project', stack: 'react-realtime-monorepo' }), true);
  assert.equal(
    stateRequiresNewProjectMonorepo({ mode: 'new-project', stack: 'custom', frontend: 'react-vite', backend: 'supabase' }),
    false,
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

test('projectRelativeHookPath repairs a Kilo macOS absolute path with its slash stripped', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-kilo-rootless-')));
  try {
    const target = path.join(root, '.traffic-one', 'runs', 'R', 'assignments.json');
    const rootless = target.slice(1);
    assert.equal(projectRelativeHookPath(root, root, rootless), '.traffic-one/runs/R/assignments.json');
    assert.equal(resolveProjectRoot(root, rootless), root);
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

test('resolveProjectRoot: a nested onboarded workspace root wins over a farther onboarded workspace ancestor (B10/B11)', () => {
  const umbrella = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-umbrella-')));
  try {
    // Umbrella repo (like ~/Projects/traffic-one): onboarded AND declares workspaces.
    writePkg(umbrella, { private: true, workspaces: ['one', 'tests/*'] });
    writeState(umbrella, { mode: 'existing-codebase', onboardingComplete: true });
    // Nested real project (like tests/claude/3): onboarded AND itself a workspace root.
    const project = path.join(umbrella, 'tests', 'claude', '3');
    writePkg(project, { private: true, workspaces: ['apps/*', 'packages/*'] });
    writeState(project, { mode: 'new-project', onboardingComplete: true });
    const target = path.join(project, 'apps', 'web', 'src', 'main.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x', 'utf8');

    // The NEAREST onboarded workspace root wins — digests/plan must land in the
    // project, never in the umbrella (the tests/claude/3 digests-at-parent bug).
    assert.equal(resolveProjectRoot(project), project);
    assert.equal(resolveProjectRoot(project, target), project);
    assert.equal(resolveProjectRoot(path.join(project, 'apps', 'web'), target), project);
    // The umbrella itself still resolves to the umbrella.
    assert.equal(resolveProjectRoot(umbrella, path.join(umbrella, 'README.md')), umbrella);
  } finally {
    fs.rmSync(umbrella, { recursive: true, force: true });
  }
});

test('resolveProjectRoot: a cwd or file hint inside .traffic-one/** never anchors there (B10)', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-statedrift-')));
  try {
    // UN-onboarded project (no state yet): the fallback previously returned the
    // drifted cwd verbatim, minting a root INSIDE the state tree.
    const drifted = path.join(dir, '.traffic-one', 'skills', 'senior-eng-orchestrator');
    fs.mkdirSync(drifted, { recursive: true });
    assert.equal(resolveProjectRoot(drifted, path.join(dir, 'src', 'a.ts')), dir);
    assert.equal(resolveProjectRoot(drifted), dir);

    // Onboarded: the climb already recovers, but the stripped anchor keeps the
    // file-hint path equally safe.
    writeState(dir, { mode: 'new-project', onboardingComplete: true });
    assert.equal(resolveProjectRoot(drifted, path.join(dir, 'src', 'a.ts')), dir);
    assert.equal(resolveProjectRoot(dir, path.join(dir, '.traffic-one', 'digests', 'r1', 'x.md')), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stripStateDirSuffix truncates at the first .traffic-one segment', () => {
  const sep = path.sep;
  assert.equal(stripStateDirSuffix(`${sep}p${sep}proj${sep}.traffic-one${sep}skills${sep}x`), `${sep}p${sep}proj`);
  assert.equal(stripStateDirSuffix(`${sep}p${sep}proj${sep}.traffic-one`), `${sep}p${sep}proj`);
  assert.equal(stripStateDirSuffix(`${sep}p${sep}proj${sep}src`), `${sep}p${sep}proj${sep}src`);
  assert.equal(stripStateDirSuffix(''), '');
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

test('resolveProjectRoot: a workspace ceiling never escapes above the host workspace (Cursor double-onboarding)', () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-ceiling-')));
  try {
    // A container P with a STRAY onboarded .one.json; the opened Cursor workspace is W = P/sub.
    writeState(parent, { mode: 'new-project', onboardingComplete: true });
    const ws = path.join(parent, 'sub');
    fs.mkdirSync(ws, { recursive: true });
    // A tool path ABOVE the workspace (e.g. the agent reading the parent's rules) —
    // this is what re-rooted resolution to P and spawned the second wizard.
    const outOfTree = path.join(parent, '.traffic-one', 'rules', 'common', 'x.md');

    // WITHOUT a ceiling the unbounded upward walk escapes to the stray parent (the bug).
    assert.equal(resolveProjectRoot(ws, outOfTree), parent);

    // WITH the workspace ceiling it stays at the workspace root — no second wizard.
    assert.equal(resolveProjectRoot(ws, outOfTree, { ceiling: ws }), ws);
    assert.equal(resolveProjectRoot(ws, '', { ceiling: ws }), ws);          // no file → the cwd walk is bounded too
    const terminalCwd = path.join(parent, '.cursor', 'projects', 'Users-u-Projects-sub', 'terminals');
    fs.mkdirSync(terminalCwd, { recursive: true });
    assert.equal(resolveProjectRoot(terminalCwd, '', { ceiling: ws }), ws); // Cursor internal cwd outside workspace → workspace
    const inTree = path.join(ws, 'src', 'a.ts');
    assert.equal(resolveProjectRoot(ws, inTree, { ceiling: ws }), ws);

    // Even when the workspace itself is onboarded, an out-of-tree file can't re-root it.
    writeState(ws, { mode: 'new-project', onboardingComplete: true });
    assert.equal(resolveProjectRoot(ws, outOfTree, { ceiling: ws }), ws);
    assert.equal(resolveProjectRoot(ws, inTree, { ceiling: ws }), ws);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('resolveProjectRoot: a ceiling AT the monorepo root still resolves a sub-package UP to the root', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-ceil-mono-')));
  try {
    // Cursor opened the monorepo root (ceiling = root); the climb to it must survive.
    writePkg(root, { name: 'mono', private: true, workspaces: ['packages/*'] });
    writeState(root, { mode: 'new-project', onboardingComplete: true });
    const ui = path.join(root, 'packages', 'ui');
    const target = path.join(ui, 'src', 'index.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x', 'utf8');
    assert.equal(resolveProjectRoot(root, target, { ceiling: root }), root);
    assert.equal(resolveProjectRoot(ui, target, { ceiling: root }), root);
    assert.equal(resolveProjectRoot(ui, '', { ceiling: root }), root);
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

// ── membership: which project does a directory BELONG to? ────────────────────
// The resolver used to ask only "is an ancestor onboarded / does one declare npm
// workspaces", then fall back to the directory itself. In a Go/polyglot tree with no
// npm workspace that fallback made whatever dir a tool touched its own project:
// observed live, `mercury/strategies` and `agora/handlers/strategies` each got a full
// new-project wizard (detectMode counts files in the RESOLVED root, and a small
// package reads as `new-project`).

function writeFile(file: string, body = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

test('dirOwnsProject: VCS or a language manifest, and never Traffic One state', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-owns-')));
  try {
    assert.equal(dirOwnsProject(root), false, 'a bare dir owns nothing');

    // `.git` as a DIRECTORY (ordinary clone) and as a FILE (worktree/submodule).
    const asDir = path.join(root, 'clone');
    fs.mkdirSync(path.join(asDir, '.git'), { recursive: true });
    assert.equal(dirOwnsProject(asDir), true);
    const asFile = path.join(root, 'worktree');
    writeFile(path.join(asFile, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt');
    assert.equal(dirOwnsProject(asFile), true, '.git is a FILE in a worktree/submodule');

    for (const manifest of ['go.mod', 'package.json', 'composer.json', 'pyproject.toml',
      'Cargo.toml', 'Gemfile', 'pubspec.yaml', 'deno.json']) {
      const dir = path.join(root, `m-${manifest}`);
      writeFile(path.join(dir, manifest));
      assert.equal(dirOwnsProject(dir), true, `${manifest} marks an owned project`);
    }

    // Traffic One state must NOT count: it would make membership self-confirming, so
    // a dir that once accrued stray state would own a project forever and never heal.
    const stateOnly = path.join(root, 'state-only');
    writeState(stateOnly, { mode: 'new-project' });
    assert.equal(dirOwnsProject(stateOnly), false, 'project state is not ownership');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('projectMembershipRoot: a package belongs to its repo; a repo belongs to itself', () => {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-member-')));
  try {
    const repo = path.join(container, 'mercury');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    writeFile(path.join(repo, 'go.mod'), 'module mercury\n');
    const pkg = path.join(repo, 'strategies');
    writeFile(path.join(pkg, 'strategy.go'), 'package strategies\n');
    const deep = path.join(repo, 'handlers', 'strategies');
    writeFile(path.join(deep, 'h.go'), 'package strategies\n');

    assert.equal(projectMembershipRoot(pkg), repo, 'a package belongs to its repo');
    assert.equal(projectMembershipRoot(deep), repo, 'depth does not matter');
    assert.equal(projectMembershipRoot(repo), repo, 'a repo belongs to itself');

    // A nested module owning its own marker is NEVER absorbed into the parent.
    const nested = path.join(repo, 'tools', 'cli');
    writeFile(path.join(nested, 'go.mod'), 'module cli\n');
    assert.equal(projectMembershipRoot(nested), nested, 'a nested module is its own project');

    // The container owns nothing and belongs to nothing — its ancestors are temp
    // roots, where the machine-config guard stops the walk.
    assert.equal(projectMembershipRoot(container), null, 'a marker-less container belongs to nothing');

    // The ceiling is honoured: never climb out of the host workspace root.
    assert.equal(projectMembershipRoot(pkg, pkg), null, 'a ceiling AT the package blocks the climb');
    assert.equal(projectMembershipRoot(pkg, repo), repo, 'a ceiling at the repo still resolves it');
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

// A manifest says "this dir is a module"; it is NOT authority over everything below
// it. Only version control marks a repository boundary. Observed live: a leftover
// `go.mod` in ~/Documents and ~/Documents/projects made an unrelated multi-repo
// workspace resolve to ~/Documents/projects, so every command into it was gated.
test('projectMembershipRoot: a stray manifest in an ancestor never absorbs a child', () => {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-stray-manifest-')));
  try {
    // A junk manifest high in the tree, with NO version control.
    writeFile(path.join(outer, 'go.mod'), 'module leftover\n');
    const workspace = path.join(outer, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });

    assert.equal(projectMembershipRoot(workspace), null,
      'a manifest-only ancestor is not a repository boundary');
    assert.equal(resolveProjectRoot(workspace, ''), outer,
      'resolution follows prefsCapableRoot to the leftover-manifest parent');

    // Leftover go.mod must not hijack a directory that owns itself.
    const owned = path.join(outer, 'owned-git');
    fs.mkdirSync(path.join(owned, '.git'), { recursive: true });
    assert.equal(projectMembershipRoot(owned), owned,
      'a child with its own .git is its own membership root');
    assert.equal(resolveProjectRoot(owned), owned,
      'an owning-git child under a leftover ancestor manifest stays itself');

    // Version control in the same place DOES absorb it — that is the intended signal.
    fs.mkdirSync(path.join(outer, '.git'), { recursive: true });
    assert.equal(projectMembershipRoot(workspace), outer, '.git is the repository boundary');

    // And a manifest still marks the START dir itself as a project.
    const module = path.join(outer, 'svc');
    writeFile(path.join(module, 'go.mod'), 'module svc\n');
    assert.equal(projectMembershipRoot(module), module, 'a module root is its own project');
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('resolveProjectRoot: an un-onboarded package resolves to its repo, not itself', () => {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-member-resolve-')));
  try {
    // Two sibling Go repos under a marker-less container — the Hermatic shape.
    const mercury = path.join(container, 'mercury');
    const agora = path.join(container, 'agora');
    for (const repo of [mercury, agora]) {
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      writeFile(path.join(repo, 'go.mod'), 'module m\n');
    }
    const pkg = path.join(mercury, 'strategies');
    const pkgFile = path.join(pkg, 'strategy.go');
    writeFile(pkgFile, 'package strategies\n');
    const deep = path.join(agora, 'handlers', 'strategies');
    const deepFile = path.join(deep, 'h.go');
    writeFile(deepFile, 'package strategies\n');

    // NOTHING is onboarded anywhere — the window the old resolver got wrong.
    assert.equal(resolveProjectRoot(pkg, pkgFile), mercury);
    assert.equal(resolveProjectRoot(pkg, ''), mercury, 'no file hint (bash-style) resolves too');
    assert.equal(resolveProjectRoot(deep, deepFile), agora);
    // Per-repo isolation is preserved: each repo stays its own project.
    assert.equal(resolveProjectRoot(mercury, path.join(mercury, 'main.go')), mercury);
    assert.equal(resolveProjectRoot(agora, path.join(agora, 'main.go')), agora);
    // A cross-repo target still climbs to ITS OWN repo, never the toucher's.
    assert.equal(resolveProjectRoot(pkg, deepFile), agora, 'the file hint resolves to its own repo');
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('resolveProjectRoot: membership runs AFTER the workspace anchor (monorepo unchanged)', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-member-order-')));
  try {
    // A monorepo sub-package owns a package.json of its own. If membership ran before
    // the workspace anchor it would become its own root and defeat the packages/*
    // leak rule.
    writePkg(root, { name: 'mono', private: true, workspaces: ['packages/*'] });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    const ui = path.join(root, 'packages', 'ui');
    writePkg(ui, { name: 'ui' });
    const uiFile = path.join(ui, 'src', 'index.ts');
    writeFile(uiFile);

    assert.equal(resolveProjectRoot(ui, uiFile), root, 'the workspace root still wins');
    assert.equal(resolveProjectRoot(root, uiFile), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
