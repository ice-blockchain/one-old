import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { SHIMS, writeShims } from '../build-runtime';

test('SHIMS maps every legacy CLI path the host configs/skills/spawns invoke', () => {
  // The hook configs invoke hook-runtime.cjs / cursor-hook-runtime.cjs; the
  // session module spawns traffic-one-auth.cjs; skills + the post-build hint +
  // the deploy gate reference the runner CLIs.
  for (const name of [
    'hook-runtime.cjs', 'cursor-hook-runtime.cjs', 'opencode-hook-runtime.cjs', 'windsurf-hook-runtime.cjs',
    'opencode-host.cjs', 'windsurf-host.cjs', 'traffic-one-auth.cjs', 'doctor.cjs',
    'security-check-runner.cjs', 'token-report.cjs', 'one-mcp-report.cjs', 'traffic-one-cleanup.cjs',
    'gitnexus-runner.cjs', 'graphify-runner.cjs',
  ]) {
    assert.ok(name in SHIMS, `missing shim for ${name}`);
  }
  // Each target points into the nested compiled tree.
  assert.equal(SHIMS['hook-runtime.cjs'], './hooks/claude-entry.js');
  assert.equal(SHIMS['opencode-hook-runtime.cjs'], './hooks/opencode-entry.js');
  assert.equal(SHIMS['opencode-host.cjs'], './runners/opencode-host/index.js');
  assert.equal(SHIMS['windsurf-hook-runtime.cjs'], './hooks/windsurf-entry.js');
  assert.equal(SHIMS['windsurf-host.cjs'], './runners/windsurf-host/index.js');
  assert.equal(SHIMS['traffic-one-auth.cjs'], './runners/auth/index.js');
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
