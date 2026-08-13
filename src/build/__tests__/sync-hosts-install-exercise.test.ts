import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { trackedTempDirs, withPrivateTmpdir } from '../../test-support/__tests__/temp-dirs';
import {
  exerciseBaseEnv,
  exerciseInstalledRuntime,
  firstInstalledRoot,
  verifyClaude,
  verifyCodex,
  verifyCopilot,
} from '../sync-hosts';
import { makeStubInstall } from './fixtures/stub-install';

const VERSION = '9.9.9';

const dirs = trackedTempDirs('t1-sync-exercise-test-');
after(() => { dirs.cleanup(); });

function writePackageVersion(root: string, version: string): void {
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'traffic-one', version })}\n`, 'utf8');
}

test('the exercise base forwards the ordinary environment and strips everything that could steer a hook', () => {
  const base = exerciseBaseEnv({
    PATH: '/usr/bin',
    TMPDIR: '/tmp/x',
    HOME: '/real/home',
    USERPROFILE: '/real/home',
    NODE_OPTIONS: '--require=/some/preload.cjs',
    XDG_STATE_HOME: '/real/xdg',
    XDG_CONFIG_HOME: '/real/xdg-config',
    TRAFFIC_ONE_HOST: 'codex',
    TRAFFIC_ONE_PLUGIN_ROOT: '/somewhere/else',
    CLAUDE_PLUGIN_ROOT: '/claude',
    CURSOR_PLUGIN_ROOT: '/cursor',
    CODEX_THREAD_ID: 'abc',
    CODEIUM_EDITOR: 'windsurf',
  });

  // Named individually first: each of these changes the VERDICT the exercise
  // reads, so a future edit that reinstates one should fail on the variable it
  // reinstated rather than on an object shape.
  for (const key of ['HOME', 'NODE_OPTIONS', 'XDG_STATE_HOME', 'TRAFFIC_ONE_HOST', 'CURSOR_PLUGIN_ROOT', 'CODEX_THREAD_ID']) {
    assert.equal(base[key], undefined, `${key} survived into the exercise base`);
  }
  // And then the closed set, which is what catches a variable nobody thought to
  // name above.
  assert.deepEqual(base, { PATH: '/usr/bin', TMPDIR: '/tmp/x' });
});

test('firstInstalledRoot picks the candidate that is really an install, and answers null when none is', () => {
  const install = makeStubInstall('firstInstalledRoot');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 't1-not-an-install-'));
  try {
    assert.equal(firstInstalledRoot([empty, install.root]), install.root);
    assert.equal(firstInstalledRoot([empty]), null);
    assert.equal(firstInstalledRoot([]), null);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    install.cleanup();
  }
});

test('a bundle that dispatches verifies, and leaves no scratch tree and no machine state behind', () => {
  const install = makeStubInstall('dispatching bundle');
  const canary = dirs.make();
  try {
    // The scratch tree belongs to exerciseInstalledRuntime, not to this test, so
    // the ownership record the tracker keeps for its own fixtures is not
    // available here. What replaces it is a temp directory only this call can
    // reach: `withPrivateTmpdir` points `os.tmpdir()` at one for the duration,
    // so anything found in it afterwards was put there by the call. The
    // before/after listing of the REAL temp directory that used to stand here
    // was the racy shape this file's neighbours were migrated off — a
    // concurrent run of this file creates a `t1-sync-exercise-` directory
    // between the two listings and is reported as this run's leak — and it was
    // also weaker, because it only ever looked for that one name.
    withPrivateTmpdir(dirs, () => {
      // A base carrying the exact ambient state a maintainer's shell would have.
      // It must not reach the children, and nothing must land in `canary`.
      const result = exerciseInstalledRuntime('claude', install.root, { HOME: canary, TRAFFIC_ONE_AUTH: 'off' });
      assert.deepEqual(result, { state: 'verified' });
      assert.deepEqual(fs.readdirSync(canary), [], 'the verification wrote into the ambient HOME');
    });
  } finally {
    install.cleanup();
  }
});

test('a bundle that is present but does not dispatch is a problem, not a pass', () => {
  const install = makeStubInstall('non-dispatching bundle');
  try {
    // The silent fail-open: exit 0, empty stdout. Every file-presence check in
    // this command reads that install as healthy; a host reads it as "allow".
    install.answer('hook-runtime.cjs', { on: {}, off: {} });
    const result = exerciseInstalledRuntime('claude', install.root, {});
    assert.equal(result.state, 'problem');
    assert.ok(
      result.state === 'problem' && result.detail.includes('did not dispatch'),
      `expected a dispatch problem, got ${JSON.stringify(result)}`,
    );
  } finally {
    install.cleanup();
  }
});

test('a torn install is refused before anything is spawned, and says which half is missing', () => {
  const install = makeStubInstall('torn install');
  try {
    // The CONTENT half of the 'installed' predicate, removed. This is what a
    // dist/ caught mid-gen, a half-extracted archive or an in-flight rsync
    // looks like — and it is a shape the exercise must not spend as evidence.
    fs.rmSync(path.join(install.root, 'rules'), { recursive: true, force: true });
    const result = exerciseInstalledRuntime('claude', install.root, {});
    assert.equal(result.state, 'problem');
    assert.ok(result.state === 'problem' && result.detail.includes("classifies 'unverified'"));
    assert.deepEqual(install.calls(), [], 'the classification must be asserted BEFORE the verdict');
  } finally {
    install.cleanup();
  }
});

test('verifyClaude still reports its two filesystem readings before it runs anything', () => {
  const install = makeStubInstall('verifyClaude static checks');
  const absent = path.join(install.root, 'no-such-cache');
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), 't1-cursor-local-'));
  try {
    const missing = verifyClaude(VERSION, { versionedCache: absent, cursorLocal: path.join(shadow, 'nope') });
    assert.equal(missing.state, 'problem');
    assert.ok(missing.state === 'problem' && missing.detail.includes(`claude cache is missing ${VERSION}`));
    assert.deepEqual(install.calls(), [], 'a missing cache must not be exercised');

    const duplicated = verifyClaude(VERSION, { versionedCache: install.root, cursorLocal: shadow });
    assert.equal(duplicated.state, 'problem');
    assert.ok(duplicated.state === 'problem' && duplicated.detail.includes('will double every hook'));
    assert.deepEqual(install.calls(), [], 'a host with a known problem must not be exercised');
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
    install.cleanup();
  }
});

test('verifyClaude runs the bundle it just confirmed, so a present-but-dead cache fails', () => {
  const healthy = makeStubInstall('verifyClaude healthy');
  const dead = makeStubInstall('verifyClaude dead');
  const noShadow = path.join(os.tmpdir(), `t1-absent-cursor-local-${process.pid}`);
  try {
    assert.deepEqual(
      verifyClaude(VERSION, { versionedCache: healthy.root, cursorLocal: noShadow }),
      { state: 'verified' },
    );
    assert.ok(healthy.calls().length > 0, 'verifyClaude claimed success without running anything');

    dead.answer('cursor-hook-runtime.cjs', { on: { stdout: JSON.stringify({ permission: 'allow' }) }, off: { stdout: '{}' } });
    const result = verifyClaude(VERSION, { versionedCache: dead.root, cursorLocal: noShadow });
    assert.equal(result.state, 'problem');
    assert.ok(result.state === 'problem' && result.detail.includes('did not dispatch'));
  } finally {
    healthy.cleanup();
    dead.cleanup();
  }
});

test('verifyCodex exercises the cache Codex serves, and only when that cache is a shape it can classify', () => {
  const install = makeStubInstall('verifyCodex');
  const unclassifiable = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-cache-'));
  try {
    writePackageVersion(install.root, VERSION);

    // The cache Codex serves IS a classifiable install: exercise it.
    assert.deepEqual(verifyCodex(VERSION, { staged: install.root, cache: install.root }), { state: 'verified' });
    assert.ok(install.calls().length > 0, 'the cache was accepted without being run');

    // A cache whose SHAPE this command cannot classify. verifyCodex's own
    // header says that shape is not verified against a live Codex, so it stays
    // the version reading it always was rather than becoming a false alarm.
    writePackageVersion(unclassifiable, VERSION);
    assert.deepEqual(verifyCodex(VERSION, { staged: install.root, cache: unclassifiable }), { state: 'verified' });

    // And an absent cache is still the honest `unknown` it was, not a dispatch
    // failure invented out of a directory that does not exist.
    const absent = verifyCodex(VERSION, { staged: install.root, cache: path.join(unclassifiable, 'nope') });
    assert.equal(absent.state, 'unknown');
  } finally {
    fs.rmSync(unclassifiable, { recursive: true, force: true });
    install.cleanup();
  }
});

test('verifyCopilot keeps its version reading and adds the dispatch it never had', () => {
  const install = makeStubInstall('verifyCopilot');
  try {
    writePackageVersion(install.root, '0.0.1');
    const stale = verifyCopilot(VERSION, install.root);
    assert.equal(stale.state, 'problem');
    assert.ok(stale.state === 'problem' && stale.detail.includes('copilot copy is 0.0.1'));
    assert.deepEqual(install.calls(), [], 'a stale copy must not be exercised');

    writePackageVersion(install.root, VERSION);
    assert.deepEqual(verifyCopilot(VERSION, install.root), { state: 'verified' });
    assert.ok(install.calls().length > 0, 'verifyCopilot claimed success without running anything');
  } finally {
    install.cleanup();
  }
});
