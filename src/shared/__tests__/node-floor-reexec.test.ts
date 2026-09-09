import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NODE_PIN, runtimeAsset } from '../../config/managed-runtimes';
import { NODE_FLOOR_MAJOR, NODE_FLOOR_REEXEC_ENV, nodeFloorGuardSource } from '../node-floor';
import { ensureManagedRuntime } from '../managed-runtime';
import { hostNodeBelowFloor, hostNodeMajor, reexecUnderManagedNodeIfBelowFloor } from '../node-floor-reexec';
import { managedRuntimeDir } from '../toolchain-paths';

const TMP_PREFIX = 't1-lane-nfreexec-';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function fakeVersionPreload(dir: string, version: string): string {
  const file = path.join(dir, `fake-node-${version}.js`);
  fs.writeFileSync(
    file,
    `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n`,
    'utf8',
  );
  return file;
}

function writeFakeManagedNode(file: string, payload: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    '#!/usr/bin/env node\n'
    + "if (process.argv[2] === '--version') { process.stdout.write('v22.11.0\\n'); process.exit(0); }\n"
    + `process.stdout.write(${JSON.stringify(payload)});\n`
    + 'process.exit(0);\n',
    { mode: 0o755 },
  );
  try { fs.chmodSync(file, 0o755); } catch { /* windows */ }
}

function pinToolchain(dir: string): () => void {
  const saved = {
    TRAFFIC_ONE_TOOLCHAIN_ROOT: process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT,
    TRAFFIC_ONE_MANAGED_RUNTIME_OFF: process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF,
    TRAFFIC_ONE_RUNTIME_PROBE_OFF: process.env.TRAFFIC_ONE_RUNTIME_PROBE_OFF,
  };
  process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(dir, 'toolchains');
  process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF = '1';
  process.env.TRAFFIC_ONE_RUNTIME_PROBE_OFF = '1';
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function pinnedNodeBin(dir: string): string | null {
  const restore = pinToolchain(dir);
  try {
    const sel = runtimeAsset('node', process.platform, process.arch);
    if (!sel) return null;
    const bin = process.platform === 'win32' ? 'node.exe' : 'node';
    return path.join(managedRuntimeDir('node', NODE_PIN.version), sel.asset.binSubdir, bin);
  } finally {
    restore();
  }
}

test('hostNodeBelowFloor tracks NODE_FLOOR_MAJOR', () => {
  assert.equal(hostNodeMajor(`${NODE_FLOOR_MAJOR}.0.0`), NODE_FLOOR_MAJOR);
  assert.equal(hostNodeBelowFloor(`${NODE_FLOOR_MAJOR}.0.0`), false);
  assert.equal(hostNodeBelowFloor(`${NODE_FLOOR_MAJOR - 4}.20.4`), true);
  assert.ok(
    !hostNodeBelowFloor(),
    `this suite runs on Node ${process.versions.node}, so the in-process helper must no-op`,
  );
});

test('reexecUnderManagedNodeIfBelowFloor is a no-op at or above the floor', () => {
  assert.equal(reexecUnderManagedNodeIfBelowFloor({ stdin: '{}' }), 'ok');
});

test('ensureManagedRuntime uses a cached Node even when downloads are disabled', () => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}cache-`));
  const restore = pinToolchain(dir);
  try {
    const bin = pinnedNodeBin(dir);
    if (!bin) return;
    writeFakeManagedNode(bin, 'unused');
    const r = ensureManagedRuntime('node', { minMajor: NODE_FLOOR_MAJOR });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'used-managed');
    assert.equal(r.path, bin);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('below the floor the ES5 guard re-execs a cached managed Node and does not warn', () => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}guard-`));
  try {
    const toolchain = path.join(dir, 'toolchains');
    const bin = path.join(toolchain, '_runtimes', 'node', '22.11.0', 'node');
    writeFakeManagedNode(bin, 'MANAGED-REEXEC\n');
    const old = `${NODE_FLOOR_MAJOR - 4}.20.4`;
    const preload = fakeVersionPreload(dir, old);
    const ran = spawnSync(process.execPath, ['--require', preload, '-e', nodeFloorGuardSource()], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        TRAFFIC_ONE_TOOLCHAIN_ROOT: toolchain,
        [NODE_FLOOR_REEXEC_ENV]: '',
      },
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, 'MANAGED-REEXEC\n');
    assert.doesNotMatch(ran.stderr, /Continuing anyway/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('below the floor with no managed Node the ES5 guard still warns and continues', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}warn-`));
  try {
    const old = `${NODE_FLOOR_MAJOR - 4}.20.4`;
    const preload = fakeVersionPreload(dir, old);
    const ran = spawnSync(process.execPath, ['--require', preload, '-e', nodeFloorGuardSource()], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        TRAFFIC_ONE_TOOLCHAIN_ROOT: path.join(dir, 'empty-toolchains'),
      },
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, '');
    assert.match(ran.stderr, /Continuing anyway/);
    assert.match(ran.stderr, new RegExp(`floor of Node ${NODE_FLOOR_MAJOR}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the TypeScript re-exec helper hands stdin to the managed Node', () => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}helper-`));
  try {
    const bin = pinnedNodeBin(dir);
    if (!bin) return;
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(
      bin,
      '#!/usr/bin/env node\n'
      + "if (process.argv[2] === '--version') { process.stdout.write('v22.11.0\\n'); process.exit(0); }\n"
      + "var s = ''; process.stdin.on('data', function (c) { s += c; });\n"
      + "process.stdin.on('end', function () { process.stdout.write('STDIN:' + s); process.exit(0); });\n",
      { mode: 0o755 },
    );
    try { fs.chmodSync(bin, 0o755); } catch { /* windows */ }
    const source = path.join(REPO_ROOT, 'src', 'shared', 'node-floor-reexec.ts');
    const ran = spawnSync(
      process.execPath,
      [
        '--import',
        './src/build/test-preload.mjs',
        '--import',
        'tsx',
        '-e',
        `Object.defineProperty(process.versions, 'node', { value: '${NODE_FLOOR_MAJOR - 4}.20.4' });`
        + `const { reexecUnderManagedNodeIfBelowFloor } = require(${JSON.stringify(source)});`
        + 'reexecUnderManagedNodeIfBelowFloor({ stdin: "hook-payload" });'
        + 'process.stdout.write("CONTINUED");',
      ],
      {
        encoding: 'utf8',
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          TRAFFIC_ONE_TOOLCHAIN_ROOT: path.join(dir, 'toolchains'),
          TRAFFIC_ONE_MANAGED_RUNTIME_OFF: '1',
          TRAFFIC_ONE_RUNTIME_PROBE_OFF: '1',
        },
      },
    );
    assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
    assert.match(ran.stdout, /STDIN:hook-payload/);
    assert.doesNotMatch(ran.stdout, /CONTINUED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
