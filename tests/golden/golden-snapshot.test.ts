import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runGen } from '../../src/gen';

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

test('golden manifest is non-empty + well-formed', () => {
  const entries = readManifest();
  assert.ok(entries.length >= 270, `expected the full generated tree, got ${entries.length}`);
});

test('every generated artifact matches its golden hash (byte-identical)', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't1-golden-'));
  try {
    runGen({ check: false, root: scratch, sourceRoot: REPO_ROOT });
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
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
