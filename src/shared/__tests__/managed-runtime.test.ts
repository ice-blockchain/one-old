import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
  nodeAsset,
  pythonAsset,
  runtimeAsset,
  NODE_PIN,
  PYTHON_PIN,
} from '../../config/managed-runtimes';
import { ensureManagedRuntime, managedRuntimeAvailable, parseChecksum } from '../managed-runtime';
import { managedRuntimeDir } from '../toolchain-paths';

// ── asset matrix (pure; no network) ──────────────────────────────────────────

test('nodeAsset builds the official nodejs.org tarball + SHASUMS url', () => {
  const a = nodeAsset(NODE_PIN, 'darwin', 'arm64');
  assert.ok(a);
  assert.equal(a!.url, `https://nodejs.org/dist/v${NODE_PIN.version}/node-v${NODE_PIN.version}-darwin-arm64.tar.gz`);
  assert.equal(a!.archiveName, `node-v${NODE_PIN.version}-darwin-arm64.tar.gz`);
  assert.equal(a!.checksumStyle, 'shasums-list');
  assert.equal(a!.binSubdir, `node-v${NODE_PIN.version}-darwin-arm64/bin`);
});

test('nodeAsset maps linux/x64 and rejects unsupported platforms/arches', () => {
  assert.match(nodeAsset(NODE_PIN, 'linux', 'x64')!.url, /node-v.*-linux-x64\.tar\.gz$/);
  assert.equal(nodeAsset(NODE_PIN, 'win32', 'x64'), null);
  assert.equal(nodeAsset(NODE_PIN, 'linux', 'ppc64'), null);
});

test('pythonAsset builds the python-build-standalone install_only asset + sidecar', () => {
  const a = pythonAsset(PYTHON_PIN, 'darwin', 'arm64');
  assert.ok(a);
  assert.match(a!.archiveName, /^cpython-3\.12\.7\+\d{8}-aarch64-apple-darwin-install_only\.tar\.gz$/);
  assert.equal(a!.checksumUrl, `${a!.url}.sha256`);
  assert.equal(a!.checksumStyle, 'sidecar-hex');
  assert.equal(a!.binSubdir, 'python/bin');
});

test('pythonAsset maps the four tranche-1 triples and rejects the rest', () => {
  assert.match(pythonAsset(PYTHON_PIN, 'darwin', 'x64')!.archiveName, /x86_64-apple-darwin/);
  assert.match(pythonAsset(PYTHON_PIN, 'linux', 'x64')!.archiveName, /x86_64-unknown-linux-gnu/);
  assert.match(pythonAsset(PYTHON_PIN, 'linux', 'arm64')!.archiveName, /aarch64-unknown-linux-gnu/);
  assert.equal(pythonAsset(PYTHON_PIN, 'win32', 'x64'), null);
});

test('runtimeAsset returns the resolved version alongside the asset', () => {
  assert.equal(runtimeAsset('node', 'linux', 'arm64')!.version, NODE_PIN.version);
  assert.equal(runtimeAsset('python', 'darwin', 'arm64')!.version, PYTHON_PIN.version);
  assert.equal(runtimeAsset('node', 'sunos', 'sparc'), null);
});

// ── checksum parsing ──────────────────────────────────────────────────────────

const HEX = 'a'.repeat(64);

test('parseChecksum reads a bare sidecar hex (python-build-standalone)', () => {
  assert.equal(parseChecksum('sidecar-hex', `${HEX}\n`, 'whatever.tar.gz'), HEX);
  // tolerant of an optional trailing filename
  assert.equal(parseChecksum('sidecar-hex', `${HEX}  file.tar.gz`, 'file.tar.gz'), HEX);
  assert.equal(parseChecksum('sidecar-hex', 'not-a-hash', 'x'), null);
});

test('parseChecksum picks the matching line out of a SHASUMS list (node)', () => {
  const list = [
    `${'b'.repeat(64)}  node-v22.11.0-linux-x64.tar.gz`,
    `${HEX}  node-v22.11.0-darwin-arm64.tar.gz`,
  ].join('\n');
  assert.equal(parseChecksum('shasums-list', list, 'node-v22.11.0-darwin-arm64.tar.gz'), HEX);
  assert.equal(parseChecksum('shasums-list', list, 'node-v22.11.0-darwin-x64.tar.gz'), null);
});

// ── managedRuntimeDir path shape ──────────────────────────────────────────────

test('managedRuntimeDir is a shared _runtimes/<kind>/<version> store', () => {
  const prev = process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(path.sep, 'tmp', 't1-root');
  try {
    assert.equal(
      managedRuntimeDir('node', '22.11.0'),
      path.join(path.sep, 'tmp', 't1-root', '_runtimes', 'node', '22.11.0'),
    );
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT; else process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = prev;
  }
});

// ── kill-switch (the suite-wide safety the test preload relies on) ─────────────

test('ensureManagedRuntime is a no-op skip when downloads are disabled', () => {
  const prev = process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF;
  process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF = '1';
  try {
    const r = ensureManagedRuntime('python', { minMajor: 3, minMinor: 10 });
    assert.equal(r.ok, false);
    assert.equal(r.action, 'skipped');
    assert.equal(r.path, null);
    assert.match(r.error || '', /disabled/);
    assert.equal(managedRuntimeAvailable('python'), false);
    assert.equal(managedRuntimeAvailable('node'), false);
  } finally {
    if (prev === undefined) delete process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF; else process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF = prev;
  }
});

test('managedRuntimeAvailable reflects platform support when enabled', () => {
  const prevManaged = process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF;
  const prevProbe = process.env.TRAFFIC_ONE_RUNTIME_PROBE_OFF;
  delete process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF;
  delete process.env.TRAFFIC_ONE_RUNTIME_PROBE_OFF;
  try {
    // Expectation is derived from the same matrix, so this holds on every CI arch
    // (true on darwin/linux × x64/arm64, false elsewhere) without a download.
    const supported = runtimeAsset('node', process.platform, process.arch) !== null;
    assert.equal(managedRuntimeAvailable('node'), supported);
  } finally {
    if (prevManaged === undefined) delete process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF; else process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF = prevManaged;
    if (prevProbe === undefined) delete process.env.TRAFFIC_ONE_RUNTIME_PROBE_OFF; else process.env.TRAFFIC_ONE_RUNTIME_PROBE_OFF = prevProbe;
  }
});
