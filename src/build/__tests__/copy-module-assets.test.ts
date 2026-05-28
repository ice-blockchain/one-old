import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { copyModuleDescriptors } from '../copy-module-assets';

test('copyModuleDescriptors copies each module.json into the compiled tree, ignoring code/tests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-copyassets-'));
  try {
    const src = path.join(root, 'src-modules');
    const out = path.join(root, 'out-modules');
    // Two real-shaped modules + one dir without a descriptor.
    for (const id of ['session', 'graphify']) {
      fs.mkdirSync(path.join(src, id, 'skill'), { recursive: true });
      fs.writeFileSync(path.join(src, id, 'module.json'), JSON.stringify({ id, kind: 'runtime' }), 'utf8');
      fs.writeFileSync(path.join(src, id, 'index.ts'), 'export const handlers = [];', 'utf8');
      fs.writeFileSync(path.join(src, id, 'skill', 'SKILL.md'), '# skill', 'utf8');
    }
    fs.mkdirSync(path.join(src, 'no-descriptor'), { recursive: true });
    fs.writeFileSync(path.join(src, 'no-descriptor', 'notes.txt'), 'x', 'utf8');

    const { copied } = copyModuleDescriptors(src, out);
    assert.deepEqual(copied, [path.join('graphify', 'module.json'), path.join('session', 'module.json')]);
    // Descriptors land in the compiled tree...
    assert.ok(fs.existsSync(path.join(out, 'session', 'module.json')));
    assert.ok(fs.existsSync(path.join(out, 'graphify', 'module.json')));
    // ...but .ts, skill prose, and descriptor-less dirs do not.
    assert.equal(fs.existsSync(path.join(out, 'session', 'index.ts')), false);
    assert.equal(fs.existsSync(path.join(out, 'session', 'skill')), false);
    assert.equal(fs.existsSync(path.join(out, 'no-descriptor')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('copyModuleDescriptors on the real src/modules finds every descriptor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-copyassets-real-'));
  try {
    const srcModules = path.resolve(__dirname, '..', '..', 'modules');
    const { copied } = copyModuleDescriptors(srcModules, path.join(root, 'out'));
    // Every runtime module ships a module.json the compiled runtime needs.
    assert.ok(copied.includes(path.join('session', 'module.json')));
    assert.ok(copied.includes(path.join('graphify', 'module.json')));
    assert.ok(copied.length >= 6, `expected the real module set, got ${copied.length}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('copyModuleDescriptors tolerates a missing source dir', () => {
  assert.deepEqual(copyModuleDescriptors('/no/such/modules/dir', '/tmp/whatever'), { copied: [] });
});
