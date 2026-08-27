import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { dirOwnsProject, projectMembershipRoot } from '../../project-membership';
import {
  defaultProjectPrefsPath,
  prefsCapableRoot,
  prefsCreateRefused,
  readProjectPrefs,
} from '../local-prefs';
import { updateProjectPrefs } from '../local-prefs/prefs-store';

function withTree(fn: (root: string, env: NodeJS.ProcessEnv) => void): void {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-prefs-capable-')));
  // Hash-keyed path, no TRAFFIC_ONE_PROJECT_PREFS_PATH pin: the pin is cwd-blind
  // and would make every directory in the tree share one file, which collapses
  // the already-strayed clause into "the pin exists" for parent and child alike.
  const env: NodeJS.ProcessEnv = {
    HOME: path.join(root, 'home'),
    XDG_STATE_HOME: path.join(root, 'xdg'),
  };
  try {
    fn(root, env);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('prefsCapableRoot: marker-less child under a git parent names the enclosing git root', () => {
  withTree((root, env) => {
    const repo = path.join(root, 'mercury');
    const child = path.join(repo, 'strategies');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

    assert.equal(dirOwnsProject(child), false, 'fixture guard: the package owns nothing');
    assert.equal(prefsCapableRoot(child, env), repo);
    assert.equal(prefsCreateRefused(child, env), true);
  });
});

test('prefsCapableRoot: relative and absolute child spellings return the same absolute repo root', () => {
  withTree((root, env) => {
    const repo = path.join(root, 'mercury');
    const child = path.join(repo, 'strategies');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

    const prev = process.cwd();
    try {
      process.chdir(repo);
      const fromRelative = prefsCapableRoot('strategies', env);
      const fromAbsolute = prefsCapableRoot(child, env);
      assert.equal(fromRelative, path.resolve(repo));
      assert.equal(fromAbsolute, fromRelative);
      assert.ok(path.isAbsolute(fromRelative), 'Layer C embeds this in argv; non-absolute fails the allow-list');
    } finally {
      process.chdir(prev);
    }
  });
});

test('prefsCapableRoot: marker-less child under a package.json-only parent names that parent', () => {
  withTree((root, env) => {
    // projectMembershipRoot's ancestor absorb is VCS-only, so projectMembershipRoot(child)
    // is null here. The veto asks projectMembershipRoot(dirname(child)), and a
    // manifest start-dir IS enclosing — that is the package.json-only shape.
    const parent = path.join(root, 'pkg');
    const child = path.join(parent, 'src');
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(parent, 'package.json'), '{"name":"pkg"}\n', 'utf8');

    assert.equal(fs.existsSync(path.join(parent, '.git')), false, 'fixture guard: no VCS');
    assert.equal(projectMembershipRoot(child), null,
      'fixture guard: VCS-only ancestor absorb does not take the child');
    assert.equal(projectMembershipRoot(path.dirname(path.resolve(child))), parent,
      'fixture guard: dirname-as-start treats the manifest parent as enclosing');
    assert.equal(prefsCapableRoot(child, env), parent);
    assert.equal(prefsCreateRefused(child, env), true);
  });
});

test('prefsCapableRoot: a directory that owns a project names itself', () => {
  withTree((root, env) => {
    const gitDir = path.join(root, 'git-owned');
    fs.mkdirSync(path.join(gitDir, '.git'), { recursive: true });
    assert.equal(dirOwnsProject(gitDir), true);
    assert.equal(prefsCapableRoot(gitDir, env), gitDir);
    assert.equal(prefsCreateRefused(gitDir, env), false);

    const pkgDir = path.join(root, 'pkg-owned');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{"name":"pkg-owned"}\n', 'utf8');
    assert.equal(dirOwnsProject(pkgDir), true);
    assert.equal(prefsCapableRoot(pkgDir, env), pkgDir);
    assert.equal(prefsCreateRefused(pkgDir, env), false);
  });
});

test('prefsCapableRoot: a genuinely unclaimed directory names itself', () => {
  withTree((root, env) => {
    const unclaimed = path.join(root, 'nowhere');
    fs.mkdirSync(unclaimed, { recursive: true });

    assert.equal(dirOwnsProject(unclaimed), false, 'fixture guard: owns nothing');
    assert.equal(projectMembershipRoot(path.dirname(path.resolve(unclaimed))), null,
      'fixture guard: nothing above this dir is a membership root');
    assert.equal(prefsCapableRoot(unclaimed, env), unclaimed);
    assert.equal(prefsCreateRefused(unclaimed, env), false);
  });
});

test('prefsCapableRoot: an already-strayed child with a hash-keyed prefs file stays itself', () => {
  withTree((root, env) => {
    const repo = path.join(root, 'mercury');
    const child = path.join(repo, 'strategies');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

    // Creation-time only: a prefs file already at the hash-keyed path keeps the
    // stray writable. The pin is absent (env above) so this is the real bucket.
    const prefsPath = defaultProjectPrefsPath(child, env);
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    fs.writeFileSync(prefsPath, '{}\n', 'utf8');

    assert.equal(prefsCapableRoot(child, env), child);
    assert.equal(prefsCreateRefused(child, env), false);
  });
});

test('updateProjectPrefs still refuses CREATE on an enclosed child; the parent stays writable', () => {
  withTree((root, env) => {
    const repo = path.join(root, 'mercury');
    const child = path.join(repo, 'strategies');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

    const childPath = defaultProjectPrefsPath(child, env);
    const repoPath = defaultProjectPrefsPath(repo, env);
    assert.equal(fs.existsSync(childPath), false, 'fixture guard: no child bucket yet');

    const refused = updateProjectPrefs(child, env, (current) => ({ ...current, originalPrompt: 'nope' }));
    assert.equal(fs.existsSync(childPath), false, 'CREATE on the enclosed child is still refused');
    assert.equal(Object.prototype.hasOwnProperty.call(refused, 'originalPrompt'), false);
    assert.equal(readProjectPrefs(child, env).originalPrompt, undefined);

    const landed = updateProjectPrefs(repo, env, (current) => ({ ...current, originalPrompt: 'yes' }));
    assert.equal(fs.existsSync(repoPath), true, 'writable baseline: the parent still creates');
    assert.equal(landed.originalPrompt, 'yes');
    assert.equal(readProjectPrefs(repo, env).originalPrompt, 'yes');
    assert.equal(fs.existsSync(childPath), false, 'the parent write did not mint a child bucket');
  });
});
