import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { GOLDEN_EXCLUDED, materializeGoldenTree } from '../../src/build/golden-update';

// Golden snapshot of every artifact the generator must reproduce byte-for-byte:
// the 4 host configs, 5 manifests, AGENTS.md, and the content trees (skills,
// skills-catalog, rules, agents, .cursor/rules). Captured from the original
// hand-authored tree. The generator must still produce these bytes under dist.

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(__dirname, 'generated-manifest.sha256');

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

interface Entry { hash: string; rel: string; }

function readManifest(): Entry[] {
  const text = fs.readFileSync(MANIFEST, 'utf8');
  const entries: Entry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    // Format: "<64-hex>  <relpath>" (shasum -a 256).
    const match = trimmed.match(/^([0-9a-f]{64})\s{2}(.+)$/);
    assert.ok(match, `malformed manifest line: ${line}`);
    entries.push({ hash: match![1]!, rel: match![2]! });
  }
  return entries;
}

// Deliberately no entry-count floor. Any constant here is either stale the
// moment a generator is added or so far below the real count (a `>= 270`
// against 456 entries let 40% of the tree vanish) that it certifies nothing.
// Exact coverage is proven by the next test in both directions — every
// manifest line must exist in the freshly materialized tree, and every file in
// that tree must be in the manifest — which is strictly stronger than any
// count. What is worth asserting here is what that test cannot see: a manifest
// that lists the same path twice would silently let one of the two hashes
// never be compared.
test('golden manifest is non-empty, well-formed, and lists each path once', () => {
  const entries = readManifest();
  assert.ok(entries.length > 0, 'golden manifest is empty — run `npm run golden:update`');
  const seen = new Set<string>();
  const duplicated = entries.map((e) => e.rel).filter((rel) => !seen.add(rel));
  assert.deepEqual(duplicated, [], `golden manifest lists the same path more than once:\n${duplicated.join('\n')}`);
});

test('every generated artifact matches its golden hash (byte-identical)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't1-golden-'));
  try {
    // The SAME recipe `npm run golden:update` uses (gen, then the build's own
    // copyModuleDescriptors for the scripts/modules subtree gen never emits),
    // so refreshing the manifest cannot produce a tree this test can't
    // reproduce. Because the module assets arrive through the real build step
    // rather than a copy of src/, a build that stopped shipping gate prose
    // fails here instead of silently shipping the TS fallback wording.
    materializeGoldenTree(scratch, REPO_ROOT);
    const entries = readManifest();
    const missing: string[] = [];
    const drifted: string[] = [];
    for (const { hash, rel } of entries) {
      const abs = path.join(scratch, rel);
      if (!fs.existsSync(abs)) {
        missing.push(rel);
        continue;
      }
      if (sha256(abs) !== hash) drifted.push(rel);
    }
    assert.deepEqual(missing, [], `generated artifacts missing from the scratch plugin:\n${missing.join('\n')}`);
    assert.deepEqual(drifted, [], `generated artifacts drifted from the golden snapshot:\n${drifted.join('\n')}`);

    // Reverse sweep — additions-aware: every generated file must be hashed in
    // the manifest (or deliberately excluded), so a new emitter can't ship
    // unsnapshotted bytes. Refresh with `npm run golden:update`.
    const inManifest = new Set(entries.map((e) => e.rel));
    const unhashed: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(abs); continue; }
        const rel = path.relative(scratch, abs).split(path.sep).join('/');
        if (!inManifest.has(rel) && !GOLDEN_EXCLUDED.has(rel)) unhashed.push(rel);
      }
    };
    walk(scratch);
    assert.deepEqual(unhashed.sort(), [], `generated artifacts not covered by the golden manifest (run \`npm run golden:update\`):\n${unhashed.join('\n')}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
