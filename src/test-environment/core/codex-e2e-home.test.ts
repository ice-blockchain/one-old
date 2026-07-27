import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { CodexMarketplaceStage } from './current-dist';
import { cleanupCodexE2EHome, createCodexE2EHome } from './codex-e2e-home';

function fixture(): {
  owner: string;
  ambientHome: string;
  stagesRoot: string;
  marketplace: CodexMarketplaceStage;
} {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 't1-codex-e2e-home-'));
  const ambientHome = path.join(owner, 'ambient');
  const stagesRoot = path.join(owner, 'stages');
  fs.mkdirSync(ambientHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stagesRoot, { recursive: true });
  fs.writeFileSync(path.join(ambientHome, 'auth.json'), '{"token":"secret-fixture"}\n', { mode: 0o600 });
  const fingerprint = '0123456789abcdef'.repeat(4);
  const name = 'traffic-one-e2e-0123456789abcdef-Home1';
  return {
    owner,
    ambientHome,
    stagesRoot,
    marketplace: {
      root: path.join(stagesRoot, name),
      stagesRoot,
      name,
      pluginSelector: `traffic-one@${name}`,
      stagedPluginRoot: path.join(stagesRoot, name, 'plugins', 'traffic-one'),
      sourceFingerprint: fingerprint,
      cacheVersion: `0.0.0-e2e.${fingerprint.slice(0, 16)}`,
    },
  };
}

test('isolated Codex home copies only auth into a 0700 marked container and cleans exactly', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.owner, { recursive: true, force: true }));
  const home = createCodexE2EHome(f.ambientHome, f.stagesRoot, f.marketplace);

  assert.equal(fs.statSync(home.path).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home.path, 'auth.json')).mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(path.join(home.path, 'auth.json'), 'utf8'),
    fs.readFileSync(path.join(f.ambientHome, 'auth.json'), 'utf8'),
  );
  assert.deepEqual(
    fs.readdirSync(home.path).sort(),
    ['.traffic-one-e2e-home.json', 'auth.json', 'config.toml'],
  );
  assert.equal(cleanupCodexE2EHome(home).ok, true);
  assert.equal(fs.existsSync(home.path), false);
});

test('isolated Codex home cleanup preserves marker tampering for inspection', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.owner, { recursive: true, force: true }));
  const home = createCodexE2EHome(f.ambientHome, f.stagesRoot, f.marketplace);
  fs.appendFileSync(home.markerPath, '{"tampered":true}\n', 'utf8');

  const cleanup = cleanupCodexE2EHome(home);
  assert.equal(cleanup.ok, false);
  assert.match(cleanup.detail, /marker contents changed/);
  assert.equal(fs.existsSync(home.path), true);
});

test('isolated Codex home rejects an auth source readable by other users', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.owner, { recursive: true, force: true }));
  fs.chmodSync(path.join(f.ambientHome, 'auth.json'), 0o644);

  assert.throws(
    () => createCodexE2EHome(f.ambientHome, f.stagesRoot, f.marketplace),
    /accessible outside its owner/,
  );
});
