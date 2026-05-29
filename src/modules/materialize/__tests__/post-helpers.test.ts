import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  isProjectMemoryWritePath,
  projectRootForPathHint,
  projectRootFromStateFilePath,
  projectRootsFromToolInputHints,
} from '../post-helpers';

function withProject(fn: (root: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-posthelp-')));
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), '{}', 'utf8');
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('isProjectMemoryWritePath: project memory yes; generated/digests/manifest no', () => {
  assert.equal(isProjectMemoryWritePath('.traffic-one/product.md'), true);
  assert.equal(isProjectMemoryWritePath('./.traffic-one/stack.md'), true); // leading ./ stripped
  // only ROOT-relative .traffic-one paths count (callers pass project-relative paths)
  assert.equal(isProjectMemoryWritePath('a/b/.traffic-one/stack.md'), false);
  assert.equal(isProjectMemoryWritePath('.traffic-one/digests/run/architect.md'), false);
  assert.equal(isProjectMemoryWritePath('.traffic-one/rules/core.md'), false);
  assert.equal(isProjectMemoryWritePath('.traffic-one/skills/x/SKILL.md'), false);
  assert.equal(isProjectMemoryWritePath('.traffic-one/manifest.json'), false);
  assert.equal(isProjectMemoryWritePath('src/app.ts'), false);
});

test('projectRootFromStateFilePath resolves the project root from a .one.json path', () => {
  assert.equal(projectRootFromStateFilePath(path.join('/a/b', '.traffic-one', '.one.json')), path.resolve('/a/b'));
  assert.equal(projectRootFromStateFilePath('/a/b/foo.json'), path.resolve('/a/b'));
});

test('projectRootForPathHint walks up to the nearest .traffic-one project; rejects flags/urls/vars', () => {
  withProject((root) => {
    const nested = path.join(root, 'apps', 'web', 'src', 'main.ts');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, 'x', 'utf8');
    assert.equal(projectRootForPathHint(root, nested), root);
    assert.equal(projectRootForPathHint(root, 'apps/web/src/main.ts'), root); // relative
    assert.equal(projectRootForPathHint(root, '--flag'), null);
    assert.equal(projectRootForPathHint(root, 'https://x.com/y'), null);
    assert.equal(projectRootForPathHint(root, '$HOME/x'), null);
    assert.equal(projectRootForPathHint(os.tmpdir(), ''), null);
  });
});

test('projectRootsFromToolInputHints collects roots from file_path + command tokens', () => {
  withProject((root) => {
    const nested = path.join(root, 'apps', 'api', 'src');
    fs.mkdirSync(nested, { recursive: true });
    assert.deepEqual(projectRootsFromToolInputHints(root, { file_path: path.join(nested, 'x.ts') }), [root]);
    // a command referencing a path token inside the project resolves to the root
    const roots = projectRootsFromToolInputHints(root, { command: `cat ${path.join('apps', 'api', 'src')}/x.ts` });
    assert.ok(roots.includes(root));
    assert.deepEqual(projectRootsFromToolInputHints(root, { command: 'ls -la' }), []);
  });
});
