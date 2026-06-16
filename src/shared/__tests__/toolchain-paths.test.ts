import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { managedNpmBin, managedNpmPrefix, managedVenvBin, managedVenvPython, managedRuntimeDir } from '../toolchain-paths';

// process.platform is read at call time by the path helpers, so the win32 branches
// can only be exercised on a non-Windows CI by temporarily overriding it. ALWAYS
// restore in finally — the node --test runner shares one process, so a leaked
// platform value would contaminate every later test.
function withPlatform(platform: string, fn: () => void): void {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { fn(); } finally { if (orig) Object.defineProperty(process, 'platform', orig); }
}

function withRoot(root: string, fn: () => void): void {
  const prev = process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = root;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT; else process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = prev;
  }
}

const ROOT = path.join(path.sep, 'tmp', 't1-paths-test');

test('managedNpmBin: POSIX uses bin/<name>; Windows is flat <name>.cmd at the prefix root', () => {
  withRoot(ROOT, () => {
    withPlatform('linux', () => {
      const p = managedNpmBin('gitnexus', 'gitnexus');
      assert.equal(p, path.join(managedNpmPrefix('gitnexus'), 'bin', 'gitnexus'));
      assert.equal(p.endsWith('.cmd'), false);
    });
    withPlatform('win32', () => {
      const p = managedNpmBin('gitnexus', 'gitnexus');
      assert.equal(path.basename(p), 'gitnexus.cmd');
      assert.equal(path.dirname(p), managedNpmPrefix('gitnexus')); // flat — no bin/ segment
      assert.equal(p.split(path.sep).includes('bin'), false);
    });
  });
});

test('managedVenvPython / managedVenvBin: POSIX bin/; Windows Scripts/ + .exe', () => {
  withRoot(ROOT, () => {
    withPlatform('linux', () => {
      assert.ok(managedVenvPython('graphify').endsWith(path.join('venv', 'bin', 'python')));
      assert.ok(managedVenvBin('graphify', 'graphify').endsWith(path.join('venv', 'bin', 'graphify')));
    });
    withPlatform('win32', () => {
      assert.ok(managedVenvPython('graphify').endsWith(path.join('venv', 'Scripts', 'python.exe')));
      assert.ok(managedVenvBin('graphify', 'graphify').endsWith(path.join('venv', 'Scripts', 'graphify.exe')));
    });
  });
});

test('managedRuntimeDir is the shared _runtimes/<kind>/<version> store', () => {
  withRoot(ROOT, () => {
    assert.equal(managedRuntimeDir('node', '22.11.0'), path.join(ROOT, '_runtimes', 'node', '22.11.0'));
    assert.equal(managedRuntimeDir('python', '3.12.7'), path.join(ROOT, '_runtimes', 'python', '3.12.7'));
  });
});
