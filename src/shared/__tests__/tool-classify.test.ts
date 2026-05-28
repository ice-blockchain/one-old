import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  commandFromToolInput,
  isMutatingPreToolUse,
  isReadOnlyOrientationToolUse,
  isShellToolName,
  isStateFileOnlyPatch,
  isStateFilePath,
  isWriteLikeToolName,
  normalizedToolName,
} from '../tool-classify';

test('tool-name classification (host-prefixed names normalized)', () => {
  assert.equal(normalizedToolName('mcp.Bash'), 'Bash');
  assert.equal(isShellToolName('Bash'), true);
  assert.equal(isShellToolName('exec_command'), true);
  assert.equal(isShellToolName('Write'), false);
  assert.equal(isWriteLikeToolName('Edit'), true);
  assert.equal(isWriteLikeToolName('apply_patch'), true);
  assert.equal(commandFromToolInput({ command: 'ls' }), 'ls');
});

test('isStateFilePath matches the .one.json state files anywhere', () => {
  assert.equal(isStateFilePath('.traffic-one/.one.json'), true);
  assert.equal(isStateFilePath('a/b/.traffic-one/.one.json'), true);
  assert.equal(isStateFilePath('.traffic-one.json'), true);
  assert.equal(isStateFilePath('src/x.ts'), false);
});

test('isMutatingPreToolUse flags writes/edits/mutating shell, allows read-only', () => {
  assert.equal(isMutatingPreToolUse('Write', { file_path: 'x' }), true);
  assert.equal(isMutatingPreToolUse('Edit', { old_string: 'a', new_string: 'b' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'rm -rf x' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'echo hi > f' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'ls -la' }), false);
  assert.equal(isMutatingPreToolUse('Read', { file_path: 'x' }), false);
});

test('isReadOnlyOrientationToolUse allows orientation, not mutation/spawns', () => {
  assert.equal(isReadOnlyOrientationToolUse('Read', {}), true);
  assert.equal(isReadOnlyOrientationToolUse('Bash', { command: 'pwd' }), true);
  assert.equal(isReadOnlyOrientationToolUse('Bash', { command: 'rm x' }), false);
  assert.equal(isReadOnlyOrientationToolUse('Task', {}), false);
});

test('isStateFileOnlyPatch detects an apply_patch touching only the state file', () => {
  assert.equal(isStateFileOnlyPatch('apply_patch', { patch: '*** Update File: .traffic-one/.one.json\n+x' }), true);
  assert.equal(isStateFileOnlyPatch('apply_patch', { patch: '*** Update File: src/app.ts\n+x' }), false);
  assert.equal(isStateFileOnlyPatch('Bash', { command: 'ls' }), false);
});
