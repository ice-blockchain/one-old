import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { copyModuleDescriptors, listModuleIdsWithDescriptor, listModuleSkillDocs } from '../copy-module-assets';

test('copyModuleDescriptors copies each module.json + skill/*.md into the compiled tree, ignoring code/tests', () => {
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

    const { copied, moduleIds } = copyModuleDescriptors(src, out);
    assert.deepEqual(copied, [
      path.join('graphify', 'module.json'),
      path.join('graphify', 'skill', 'SKILL.md'),
      path.join('session', 'module.json'),
      path.join('session', 'skill', 'SKILL.md'),
    ]);
    // moduleIds is a distinct MODULE count, not a file count — the
    // no-descriptor dir never counts even though it has files on disk.
    assert.deepEqual([...moduleIds].sort(), ['graphify', 'session']);
    // Descriptors AND skill prose land in the compiled tree (skillBlock reads it)...
    assert.ok(fs.existsSync(path.join(out, 'session', 'module.json')));
    assert.ok(fs.existsSync(path.join(out, 'graphify', 'module.json')));
    assert.ok(fs.existsSync(path.join(out, 'session', 'skill', 'SKILL.md')));
    // ...but .ts and descriptor-less dirs do not.
    assert.equal(fs.existsSync(path.join(out, 'session', 'index.ts')), false);
    assert.equal(fs.existsSync(path.join(out, 'no-descriptor')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('copyModuleDescriptors on the real src/modules finds every descriptor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-copyassets-real-'));
  try {
    const srcModules = path.resolve(__dirname, '..', '..', 'modules');
    const { copied, moduleIds } = copyModuleDescriptors(srcModules, path.join(root, 'out'));
    // Every runtime module ships a module.json the compiled runtime needs.
    assert.ok(copied.includes(path.join('session', 'module.json')));
    assert.ok(copied.includes(path.join('graphify', 'module.json')));
    // skill prose is shipped too (e.g. the session auth-gate wording).
    assert.ok(copied.includes(path.join('session', 'skill', 'SKILL.md')));
    assert.ok(copied.length >= 6, `expected the real module set, got ${copied.length}`);
    // moduleIds must agree exactly with the descriptor-bearing dirs on disk.
    assert.deepEqual([...moduleIds].sort(), [...listModuleIdsWithDescriptor(srcModules)].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listModuleIdsWithDescriptor and listModuleSkillDocs agree with copyModuleDescriptors on the real tree', () => {
  const srcModules = path.resolve(__dirname, '..', '..', 'modules');
  const ids = listModuleIdsWithDescriptor(srcModules);
  const docs = listModuleSkillDocs(srcModules);
  assert.ok(ids.size >= 6, `expected the real module set, got ${ids.size}`);
  for (const doc of docs) {
    assert.ok(ids.has(doc.moduleId), `skill doc for unknown module ${doc.moduleId}`);
  }
});

test('copyModuleDescriptors tolerates a missing source dir', () => {
  const result = copyModuleDescriptors('/no/such/modules/dir', '/tmp/whatever');
  assert.deepEqual(result.copied, []);
  assert.deepEqual([...result.moduleIds], []);
});
