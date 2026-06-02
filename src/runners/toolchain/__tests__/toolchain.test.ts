import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareSemver, getToolSpec, loadSpec, mergeToolchainStamp, toolStatus } from '../index';

test('loadSpec / getToolSpec read the curated spec (via __dirname)', () => {
  const spec = loadSpec();
  assert.ok(Object.keys(spec).length >= 4);
  assert.equal(getToolSpec('gitnexus')?.recommended, '1.6.4');
  assert.equal(getToolSpec('graphify')?.minimum, '0.4.0');
  assert.equal(getToolSpec('opencode')?.npmPackage, 'opencode-ai');
  assert.equal(getToolSpec('not-a-tool'), null);
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
  assert.equal(toolStatus('gitnexus', '1.6.4').status, 'current');
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
