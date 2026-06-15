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
  const legacyRootState = ['.traffic-one', 'json'].join('.');
  assert.equal(isStateFilePath('.traffic-one/.one.json'), true);
  assert.equal(isStateFilePath('a/b/.traffic-one/.one.json'), true);
  assert.equal(isStateFilePath(legacyRootState), false);
  assert.equal(isStateFilePath('src/x.ts'), false);
});

test('isMutatingPreToolUse flags writes/edits/mutating shell, allows read-only', () => {
  assert.equal(isMutatingPreToolUse('Write', { file_path: 'x' }), true);
  assert.equal(isMutatingPreToolUse('Edit', { old_string: 'a', new_string: 'b' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'rm -rf x' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'echo hi > f' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'ls -la' }), false);
  assert.equal(isMutatingPreToolUse('Read', { file_path: 'x' }), false);

  // Hardened write vectors that previously slipped through the read-only allowance.
  assert.equal(isMutatingPreToolUse('Bash', { command: 'dd if=/dev/zero of=out.bin' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'ln -s a b' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'chmod +x build.sh' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'truncate -s 0 log' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'git checkout -- src/app.ts' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'git restore .' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'pip install requests' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'cargo add serde' }), true);
  // Inline interpreter eval (the named bypass): writes without a visible redirect.
  assert.equal(isMutatingPreToolUse('Bash', { command: `python -c "open('x','w').write('y')"` }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: `node -e "require('fs').writeFileSync('x','y')"` }), true);

  // Read-only diagnostics MUST still pass (the WebStorm-style investigation case).
  assert.equal(isMutatingPreToolUse('Bash', { command: 'cat /var/log/app.log' }), false);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'grep -r error src' }), false);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'ps aux | grep webstorm' }), false);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'git status' }), false);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'node --version' }), false);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'python analyze.py' }), false);
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
