import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import {
  compareSemver,
  getToolSpec,
  isToolUsable,
  loadSpec,
  managedNpmBin,
  managedNpmPrefix,
  managedToolDir,
  managedVenvBin,
  managedVenvPython,
  mergeToolchainStamp,
  toolInstallSpec,
  toolRuntime,
  toolStatus,
  toolchainRoot,
} from '../index';

test('loadSpec / getToolSpec read the curated spec (via __dirname)', () => {
  const spec = loadSpec();
  assert.ok(Object.keys(spec).length >= 4);
  assert.equal(getToolSpec('gitnexus')?.recommended, '1.6.9');
  assert.equal(getToolSpec('graphify')?.recommended, '0.9.13');
  assert.equal(getToolSpec('graphify')?.minimum, '0.4.0');
  assert.equal(getToolSpec('opencode')?.npmPackage, 'opencode-ai');
  assert.equal(getToolSpec('opencode')?.recommended, '1.15.13');
  assert.equal(getToolSpec('not-a-tool'), null);
});

test('toolInstallSpec targets LATEST, not the recommended pin', () => {
  // pip-managed: unpinned package name (the published name is intentionally double-y).
  assert.equal(toolInstallSpec('graphify'), 'graphifyy');
  // npm-managed: <pkg>@latest, never @<recommended>.
  assert.equal(toolInstallSpec('opencode'), 'opencode-ai@latest');
  assert.equal(toolInstallSpec('gitnexus'), 'gitnexus@latest');
  // No package manager declared → no install spec.
  assert.equal(toolInstallSpec('gitleaks'), null);
  assert.equal(toolInstallSpec('not-a-tool'), null);
});

test('toolRuntime reports the declared language runtime + minimum', () => {
  assert.deepEqual(toolRuntime('graphify'), { runtime: 'python', minMajor: 3, minMinor: 10 });
  const gitnexus = toolRuntime('gitnexus');
  assert.equal(gitnexus.runtime, 'node');
  assert.equal(gitnexus.minMajor, 22);
  // A tool with no declared runtime degrades to a null/zero shape (never throws).
  assert.deepEqual(toolRuntime('gitleaks'), { runtime: null, minMajor: 0, minMinor: 0 });
  assert.deepEqual(toolRuntime('not-a-tool'), { runtime: null, minMajor: 0, minMinor: 0 });
});

test('isToolUsable accepts current/outdated, rejects the rest', () => {
  assert.equal(isToolUsable('current'), true);
  assert.equal(isToolUsable('outdated'), true);
  assert.equal(isToolUsable('too-old'), false);
  assert.equal(isToolUsable('missing'), false);
  assert.equal(isToolUsable('unknown'), false);
});

test('toolchainRoot honours TRAFFIC_ONE_TOOLCHAIN_ROOT, then XDG_STATE_HOME', () => {
  const savedRoot = process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  const savedXdg = process.env.XDG_STATE_HOME;
  try {
    process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(path.sep, 'tmp', 't1-explicit');
    assert.equal(toolchainRoot(), path.resolve(path.join(path.sep, 'tmp', 't1-explicit')));
    delete process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
    process.env.XDG_STATE_HOME = path.join(path.sep, 'tmp', 'xdg');
    assert.equal(toolchainRoot(), path.join(path.sep, 'tmp', 'xdg', 'traffic-one', 'toolchains'));
  } finally {
    if (savedRoot === undefined) delete process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT; else process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = savedRoot;
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = savedXdg;
  }
});

test('managed path helpers build venv + npm-prefix layouts under the root', () => {
  const savedRoot = process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT;
  try {
    process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = path.join(path.sep, 'tmp', 't1-root');
    assert.equal(managedToolDir('graphify'), path.join(path.sep, 'tmp', 't1-root', 'graphify'));
    assert.ok(managedVenvBin('graphify', 'graphify').includes(path.join('graphify', 'venv')));
    assert.ok(managedVenvPython('graphify').includes(path.join('graphify', 'venv')));
    assert.equal(managedNpmPrefix('opencode'), path.join(path.sep, 'tmp', 't1-root', 'opencode', 'npm-prefix'));
    assert.ok(managedNpmBin('opencode', 'opencode').includes(path.join('opencode', 'npm-prefix', 'bin')));
  } finally {
    if (savedRoot === undefined) delete process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT; else process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT = savedRoot;
  }
});

test('compareSemver orders semvers and rejects non-semver', () => {
  assert.equal(compareSemver('1.0.0', '2.0.0'), -1);
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0);
  assert.equal(compareSemver('2.1.0', '2.0.9'), 1);
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0); // leading v tolerated
  assert.equal(compareSemver('1.2', '1.2.0'), null); // not 3-part
  assert.equal(compareSemver('abc', '1.0.0'), null);
  assert.equal(compareSemver(null, '1.0.0'), null);
});

test('toolStatus classifies installed vs spec', () => {
  assert.equal(toolStatus('gitnexus', '1.6.9').status, 'current');
  assert.equal(toolStatus('gitnexus', '1.6.4').status, 'outdated');
  assert.equal(toolStatus('graphify', '0.9.13').status, 'current');
  assert.equal(toolStatus('graphify', '0.8.40').status, 'outdated');
  assert.equal(toolStatus('gitnexus', '2.0.0').status, 'current');
  assert.equal(toolStatus('gitnexus', '0.5.0').status, 'too-old'); // < minimum 1.0.0
  assert.equal(toolStatus('gitnexus', '1.2.0').status, 'outdated'); // >= min, < recommended
  assert.equal(toolStatus('gitnexus', null).status, 'missing');
  assert.equal(toolStatus('not-a-tool', '1.0.0').status, 'unknown');
});

test('mergeToolchainStamp writes an installedVersion/installedAt entry', () => {
  const state = mergeToolchainStamp({}, 'gitnexus', { version: '1.6.4', at: '2026-01-01T00:00:00Z' });
  const tc = state.toolchain as Record<string, { installedVersion: string; installedAt: string }>;
  assert.deepEqual(tc.gitnexus, { installedVersion: '1.6.4', installedAt: '2026-01-01T00:00:00Z' });
  // a missing version stamps null
  const s2 = mergeToolchainStamp(state, 'graphify', { version: null });
  const tc2 = s2.toolchain as Record<string, { installedVersion: string | null }>;
  assert.equal(tc2.graphify?.installedVersion, null);
});
