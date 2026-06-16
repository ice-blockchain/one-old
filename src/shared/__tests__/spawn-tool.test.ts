import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawnTool, escapeCmdArgument, escapeCmdCommand } from '../spawn-tool';

// On POSIX spawnTool is a thin passthrough; on windows-latest CI this runs the
// real node.exe (an .exe → passthrough too). Either way it confirms the wrapper
// preserves the SpawnSyncReturns<string> shape and actually runs the process.
test('spawnTool runs a process and returns the string result shape', () => {
  const r = spawnTool(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal((r.stdout || '').trim(), 'ok');
});

test('spawnTool surfaces a non-zero exit', () => {
  const r = spawnTool(process.execPath, ['-e', 'process.exit(3)'], { encoding: 'utf8' });
  assert.equal(r.status, 3);
});

// The cmd.exe escaping is a pure string transform — fully verifiable without
// Windows. These guard the security-sensitive metacharacter handling (a raw
// `cmd /c` of free-form text would mis-parse or inject).
test('escapeCmdArgument caret-escapes cmd metacharacters and percent', () => {
  assert.equal(escapeCmdArgument('install'), '^"install^"');
  assert.equal(escapeCmdArgument('a&b'), '^"a^&b^"');
  assert.equal(escapeCmdArgument('x|y>z<w'), '^"x^|y^>z^<w^"');
  assert.equal(escapeCmdArgument('100%'), '^"100^%^"');
  // a space inside an arg is caret-escaped too, so the arg stays one token
  assert.equal(escapeCmdArgument('add && operator'), '^"add^ ^&^&^ operator^"');
});

test('escapeCmdCommand caret-escapes a spaced command path so it stays one token', () => {
  assert.equal(escapeCmdCommand('C:\\Tools\\npm.cmd'), 'C:\\Tools\\npm.cmd');
  assert.equal(escapeCmdCommand('C:\\Program Files\\nodejs\\npm.cmd'), 'C:\\Program^ Files\\nodejs\\npm.cmd');
});
