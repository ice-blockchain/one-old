import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { groupKillsAvailable, killProcessTree, spawnGroupOptions } from '../process-group';

test('spawnGroupOptions detaches a POSIX child so the runner can signal the group', () => {
  assert.equal(spawnGroupOptions({ cwd: '/' }, 'darwin').detached, true);
  assert.equal(spawnGroupOptions({ cwd: '/' }, 'linux').detached, true);
  assert.equal(spawnGroupOptions({ cwd: '/' }, 'win32').detached, false);
});

test('killProcessTree signals the process group on POSIX', async () => {
  if (!groupKillsAvailable()) return;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], spawnGroupOptions({
    stdio: 'ignore',
  }));
  assert.ok(child.pid && child.pid > 0);
  try {
    child.unref();
  } catch {
    /* ignore */
  }
  killProcessTree(child, 'SIGKILL');
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process group still alive after SIGKILL')), 2000);
    child.on('exit', (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  assert.ok(code === null || code !== 0, 'the leader must not exit 0 after a group kill');
});

test('killProcessTree falls back to child.kill when the group signal is unavailable', () => {
  let killed: NodeJS.Signals | undefined;
  killProcessTree({ pid: 1, kill: (signal?: NodeJS.Signals) => { killed = signal; return true; } }, 'SIGTERM', 'win32');
  assert.equal(killed, 'SIGTERM');
});
