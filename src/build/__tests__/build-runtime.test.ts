import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { SHIMS, assertSafeRuntimeOutput, buildRuntime, writeShims } from '../build-runtime';

test('SHIMS maps every legacy CLI path the host configs/skills/spawns invoke', () => {
  // Hook configs invoke the host runtimes; skills, post-build hints, and deploy
  // gates reference the remaining runner CLIs.
  for (const name of [
    'hook-runtime.cjs', 'cursor-hook-runtime.cjs', 'opencode-hook-runtime.cjs', 'kilo-hook-runtime.cjs', 'windsurf-hook-runtime.cjs', 'devin-hook-runtime.cjs',
    'opencode-host.cjs', 'kilo-host.cjs', 'windsurf-host.cjs', 'one-mcp-sync.cjs', 'doctor.cjs',
    'security-check-runner.cjs', 'token-report.cjs', 'one-mcp-report.cjs', 'one-mcp-host.cjs', 'traffic-one-cleanup.cjs',
    'traffic-one-reset.cjs', 'traffic-one-workspace.cjs',
    'qa-evidence-runner.cjs', 'gitnexus-runner.cjs', 'graphify-runner.cjs',
  ]) {
    assert.ok(name in SHIMS, `missing shim for ${name}`);
  }
  // Each target points into the nested compiled tree.
  assert.equal(SHIMS['hook-runtime.cjs'], './hooks/claude-entry.js');
  assert.equal(SHIMS['opencode-hook-runtime.cjs'], './hooks/opencode-entry.js');
  assert.equal(SHIMS['opencode-host.cjs'], './runners/opencode-host/index.js');
  assert.equal(SHIMS['kilo-hook-runtime.cjs'], './hooks/kilo-entry.js');
  assert.equal(SHIMS['kilo-host.cjs'], './runners/kilo-host/index.js');
  assert.equal(SHIMS['windsurf-hook-runtime.cjs'], './hooks/windsurf-entry.js');
  assert.equal(SHIMS['devin-hook-runtime.cjs'], './hooks/devin-entry.js');
  assert.equal(SHIMS['windsurf-host.cjs'], './runners/windsurf-host/index.js');
  assert.equal(SHIMS['one-mcp-sync.cjs'], './runners/one-mcp-sync/index.js');
  assert.equal(SHIMS['qa-evidence-runner.cjs'], './runners/qa-evidence/index.js');
});

test('writeShims emits a require+main forwarder for each legacy path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-shims-'));
  try {
    const written = writeShims(dir);
    assert.equal(written.length, Object.keys(SHIMS).length);
    for (const [name, target] of Object.entries(SHIMS)) {
      const body = fs.readFileSync(path.join(dir, name), 'utf8');
      assert.ok(body.includes(`require('${target}')`), `${name} should require ${target}`);
      assert.ok(body.includes('m.main'), `${name} should call the entry's main()`);
      assert.ok(body.includes("typeof code === 'number'"), `${name} should preserve async numeric exit codes`);
      assert.ok(body.startsWith("'use strict';"), `${name} should be a CJS module`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRuntime replaces the output tree so deleted source artifacts cannot linger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-runtime-clean-'));
  const outDir = path.join(dir, 'scripts');
  try {
    fs.mkdirSync(path.join(outDir, 'retired'), { recursive: true });
    const stale = path.join(outDir, 'retired', 'orphan.js');
    fs.writeFileSync(stale, 'stale', 'utf8');

    buildRuntime(outDir);

    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(path.join(outDir, 'hooks', 'claude-entry.js')), true);
    assert.equal(fs.existsSync(path.join(outDir, 'hook-runtime.cjs')), true);
    const qaHelp = spawnSync(
      process.execPath,
      [path.join(outDir, 'qa-evidence-runner.cjs'), 'help'],
      { encoding: 'utf8' },
    );
    assert.equal(qaHelp.status, 0, qaHelp.stderr);
    assert.match(qaHelp.stdout, /traffic-one QA evidence runner/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime cleanup accepts only generated scripts and Traffic One-owned temp trees', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const generatedScripts = path.join(repoRoot, 'dist', 'scripts');
  const expectedGeneratedScripts = fs.existsSync(generatedScripts)
    ? fs.realpathSync.native(generatedScripts)
    : path.join(fs.realpathSync.native(repoRoot), 'dist', 'scripts');
  assert.equal(assertSafeRuntimeOutput(generatedScripts), expectedGeneratedScripts);

  const safeTemp = fs.mkdtempSync(path.join(os.tmpdir(), 't1-runtime-safe-'));
  try {
    assert.equal(assertSafeRuntimeOutput(path.join(safeTemp, 'scripts')), path.join(fs.realpathSync.native(safeTemp), 'scripts'));
  } finally {
    fs.rmSync(safeTemp, { recursive: true, force: true });
  }

  // replay-corpus/env.ts remaps HOME to `tmpdir/t1-replay-home-*` and builds
  // the process-leg runtime under `$HOME/traffic-one-plugin/scripts`. That
  // path is both "under home" and an owned temp tree — the allowlist must win.
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 't1-replay-home-'));
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;
    const scripts = path.join(isolatedHome, 'traffic-one-plugin', 'scripts');
    assert.equal(
      assertSafeRuntimeOutput(scripts),
      path.join(fs.realpathSync.native(isolatedHome), 'traffic-one-plugin', 'scripts'),
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }

  for (const unsafe of [
    path.parse(path.resolve('.')).root,
    path.resolve(__dirname, '..', '..', '..'),
    path.resolve(__dirname, '..', '..', '..', 'src'),
    path.resolve(__dirname, '..', '..', '..', '.git'),
    os.homedir(),
    os.tmpdir(),
    path.join(os.tmpdir(), 'unowned-runtime-output'),
  ]) {
    assert.throws(() => assertSafeRuntimeOutput(unsafe), /refusing to clean unsafe runtime output directory/);
  }
});
