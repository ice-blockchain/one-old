import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseApplyPatch, patchOperationPaths, patchTextFromToolInput } from '../apply-patch';

const SIMPLE_PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new.ts',
  '+export const value = 1;',
  '*** End Patch',
].join('\n');

test('patchTextFromToolInput normalizes all attested host payload shapes', () => {
  for (const input of [
    SIMPLE_PATCH,
    { input: SIMPLE_PATCH },
    { patch: SIMPLE_PATCH },
    { patchText: SIMPLE_PATCH },
    { patch_text: SIMPLE_PATCH },
    { diff: SIMPLE_PATCH },
    { content: SIMPLE_PATCH },
    { command: SIMPLE_PATCH },
    { output: { args: { patch: SIMPLE_PATCH } } },
    { tool_input: { patch_text: SIMPLE_PATCH } },
  ]) {
    assert.equal(patchTextFromToolInput(input), SIMPLE_PATCH);
  }
  assert.equal(
    patchTextFromToolInput({ content: 'unrelated' }, { output: { args: { patch: SIMPLE_PATCH } } }),
    SIMPLE_PATCH,
    'a patch-looking nested value wins over unrelated sibling content',
  );
});

test('parseApplyPatch reconstructs add/update/delete/move atomically', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-apply-patch-'));
  try {
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'existing.ts'), 'alpha\nold\nomega\n', 'utf8');
    fs.writeFileSync(path.join(cwd, 'src', 'move.ts'), 'move me\n', 'utf8');
    fs.writeFileSync(path.join(cwd, 'src', 'delete.ts'), 'gone\n', 'utf8');
    const patch = [
      '*** Begin Patch',
      '*** Add File: ./src/new.ts',
      '+export const added = true;',
      '*** Update File: src/existing.ts',
      '@@',
      ' alpha',
      '-old',
      '+new',
      ' omega',
      '*** Update File: src/move.ts',
      '*** Move to: src/moved.ts',
      '@@',
      '-move me',
      '+move better',
      '*** Delete File: src/delete.ts',
      '*** End Patch',
    ].join('\n');

    const result = parseApplyPatch(patch, { baseDir: cwd });
    assert.equal(result.ok, true, result.ok ? undefined : result.error);
    if (!result.ok) return;
    assert.deepEqual(result.operations.map((operation) => operation.kind), ['add', 'update', 'move', 'delete']);
    assert.deepEqual(patchOperationPaths(result.operations), [
      'src/new.ts', 'src/existing.ts', 'src/move.ts', 'src/moved.ts', 'src/delete.ts',
    ]);
    assert.equal(result.operations[0]?.resultContent, 'export const added = true;\n');
    assert.equal(result.operations[1]?.resultContent, 'alpha\nnew\nomega\n');
    assert.equal(result.operations[1]?.addedContent, 'new');
    assert.equal(result.operations[2]?.resultContent, 'move better\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('parseApplyPatch rejects malformed and unreconstructable non-empty patches', () => {
  const malformed = parseApplyPatch('*** Begin Patch\n*** Update File: src/a.ts\nnot-a-hunk\n*** End Patch');
  assert.equal(malformed.ok, false);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-apply-patch-invalid-'));
  try {
    const missing = parseApplyPatch([
      '*** Begin Patch',
      '*** Update File: src/missing.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'), { baseDir: cwd });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /missing\.ts|does not exist/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('parseApplyPatch treats Delete File as path-only, including binary targets', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-apply-patch-delete-'));
  try {
    fs.writeFileSync(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
    const result = parseApplyPatch([
      '*** Begin Patch',
      '*** Delete File: binary.bin',
      '*** End Patch',
    ].join('\n'), { baseDir: cwd });
    assert.equal(result.ok, true, result.ok ? undefined : result.error);
    if (result.ok) assert.deepEqual(result.operations, [{
      kind: 'delete', path: 'binary.bin', addedContent: '',
    }]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
