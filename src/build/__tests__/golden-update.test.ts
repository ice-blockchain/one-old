import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GOLDEN_EXCLUDED, materializeGoldenTree, updateGoldenManifest } from '../golden-update';

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
    const text = fs.readFileSync(manifest, 'utf8');
    assert.match(text, /\.cursor\/rules\/core\.mdc/);
    assert.match(text, /\.devin\/rules\/core\.md/);
    // The build-emitted scripts/modules subtree gen never writes: descriptors
    // AND gate prose, produced by the real copyModuleDescriptors, so the
    // manifest this command writes covers what an install actually receives.
    assert.match(text, /scripts\/modules\/session\/module\.json/);
    assert.match(text, /scripts\/modules\/session\/skill\/SKILL\.md/);
    // The plugin root's package.json is IN the byte gate. It was excluded, and
    // that single exclusion took every shipped .js file out of the only
    // byte-level gate the tree has: see the note on GOLDEN_EXCLUDED.
    assert.match(text, /^[0-9a-f]{64} {2}package\.json$/m);
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A snapshot proves a byte MOVED; it cannot say the move is fatal, and the only
// way to clear a legitimate move (a version bump) is to accept the new bytes
// wholesale. These two fields are the ones where accepting them wholesale ships
// a dead install, so they are asserted by name, on the EMITTED file, in the
// spelling an install receives.
test('the emitted plugin package.json keeps the two fields every shipped script depends on', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't1-golden-pkg-'));
  try {
    const written = materializeGoldenTree(scratch, REPO_ROOT);
    assert.ok(written.includes('package.json'), 'gen no longer emits a plugin-root package.json');
    assert.equal(GOLDEN_EXCLUDED.has('package.json'), false, 'package.json must stay inside the byte gate');
    const pkg = JSON.parse(
      fs.readFileSync(path.join(scratch, 'package.json'), 'utf8'),
    ) as { type?: unknown; engines?: { node?: unknown } };

    // `npm run build` compiles src/ to CommonJS (tsconfig.build.json), so every
    // file under dist/scripts/** is `exports.x = …` / `require(…)`. Node decides
    // which module system a bare `.js` file is by the NEAREST package.json
    // `type`, and dist/package.json is that file for the whole tree: flip this
    // to 'module' and all ~500 emitted scripts die on their first line with
    // `ReferenceError: exports is not defined` — every hook, every runner, on
    // every host.
    assert.equal(pkg.type, 'commonjs');

    // The Node floor. The runtime uses >=22 APIs, and hosts/CI read this field
    // to refuse an incompatible Node BEFORE installing rather than failing at
    // the first hook. README.md advertises the same floor (asserted against
    // package.json engines in tests/readme-claims.test.ts), so a change here
    // that is not mirrored there makes the install instructions wrong.
    assert.equal(pkg.engines?.node, '>=22');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
