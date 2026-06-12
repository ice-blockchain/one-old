import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RUNNER_SHIMS, ensureRunnerShims, stableBinDir } from '../runner-shims';

function withTmpToolchainRoot(fn: (tmp: string, binDir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't1-shims-'));
  const saved = process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(tmp, 'toolchains');
  try {
    fn(tmp, path.join(tmp, 'bin'));
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
    else process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('ensureRunnerShims writes executable shims next to the toolchain root, idempotently', () => {
  withTmpToolchainRoot((_tmp, binDir) => {
    assert.equal(stableBinDir(), binDir);
    const first = ensureRunnerShims();
    assert.equal(first.dir, binDir);
    assert.equal(first.written.length, RUNNER_SHIMS.length);
    for (const { shim } of RUNNER_SHIMS) {
      const file = path.join(binDir, shim);
      assert.ok(fs.existsSync(file), `missing ${shim}`);
      assert.ok(fs.statSync(file).mode & 0o100, `${shim} not executable`);
    }
    // Second run: identical content → nothing rewritten.
    assert.equal(ensureRunnerShims().written.length, 0);
  });
});

test('shim resolves the plugin root from env and execs the real runner with args', () => {
  withTmpToolchainRoot((tmp, binDir) => {
    ensureRunnerShims();
    const pluginRoot = path.join(tmp, 'plugin');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'scripts', 'token-report.cjs'),
      'console.log("REAL-RUNNER " + process.argv.slice(2).join(","));\nprocess.exit(7);\n',
      'utf8',
    );
    const r = spawnSync(process.execPath, [path.join(binDir, 'token-report.cjs'), '--flag', 'x'], {
      encoding: 'utf8',
      env: { ...process.env, TRAFFIC_ONE_PLUGIN_ROOT: pluginRoot, CODEX_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' },
    });
    assert.match(r.stdout, /REAL-RUNNER --flag,x/);
    assert.equal(r.status, 7); // exit code passthrough
  });
});

test('shim falls back to the NEWEST version in a host plugin cache (numeric sort) when env is unset', () => {
  withTmpToolchainRoot((tmp, binDir) => {
    ensureRunnerShims();
    const home = path.join(tmp, 'home');
    // 2.9.9 vs 2.9.10: lexicographic sort would pick 2.9.9 — numeric must win.
    for (const [ver, body] of [['2.9.9', 'console.log("OLD");'], ['2.9.10', 'console.log("NEW");']] as const) {
      const root = path.join(home, '.codex', 'plugins', 'cache', 'mk', 'traffic-one', ver, 'scripts');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'token-report.cjs'), body, 'utf8');
    }
    const r = spawnSync(process.execPath, [path.join(binDir, 'token-report.cjs')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, TRAFFIC_ONE_PLUGIN_ROOT: '', CODEX_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' },
    });
    assert.match(r.stdout, /NEW/);
    assert.equal(r.status, 0);
  });
});

test('shim errors clearly when no plugin install can be found', () => {
  withTmpToolchainRoot((tmp, binDir) => {
    ensureRunnerShims();
    const r = spawnSync(process.execPath, [path.join(binDir, 'doctor.cjs')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: path.join(tmp, 'empty-home'), TRAFFIC_ONE_PLUGIN_ROOT: '', CODEX_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '' },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no installed plugin provides/);
  });
});
