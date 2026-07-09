import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { updateGoldenManifest } from '../golden-update';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('golden:update ignores runtime plugin-root env vars and reads the source checkout', () => {
  const saved = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-golden-env-'));
  try {
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = path.join(REPO_ROOT, 'dist');
    const manifest = path.join(dir, 'generated-manifest.sha256');
    const result = updateGoldenManifest(undefined, manifest);
    assert.equal(result.manifestPath, manifest);
    assert.ok(result.count > 250, `expected a full generated manifest, got ${result.count}`);
    assert.match(fs.readFileSync(manifest, 'utf8'), /\.cursor\/rules\/core\.mdc/);
    assert.match(fs.readFileSync(manifest, 'utf8'), /\.devin\/rules\/core\.md/);
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
