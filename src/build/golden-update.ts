// src/build/golden-update.ts
// Regenerates tests/golden/generated-manifest.sha256 from the current source
// tree (run via `npm run golden:update`): gen to a scratch dir, hash every
// emitted artifact except the deliberate exclusions, write sorted lines.
// Replaces the error-prone manual set-preserving regen — and because the
// manifest now covers the FULL emitted set, newly added content generators are
// covered automatically instead of being silently invisible to the golden test.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runGen } from '../gen';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Byte copies of repo-root source docs plus the runtime-populated skills seed —
// deliberately not hashed (they are inputs or runtime surface, not generated
// transforms). Keep in sync with the reverse sweep in golden-snapshot.test.ts.
export const GOLDEN_EXCLUDED: ReadonlySet<string> = new Set([
  'CLAUDE.md',
  'README.md',
  'package.json',
  'ref.md',
  'skills/.gitkeep',
]);

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function updateGoldenManifest(
  repoRoot: string = REPO_ROOT,
  manifestPath: string = path.join(repoRoot, 'tests', 'golden', 'generated-manifest.sha256'),
): { count: number; manifestPath: string } {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't1-golden-update-'));
  try {
    const run = runGen({ check: false, root: scratch, sourceRoot: repoRoot });
    const rels = run.written
      .map(toPosix)
      .filter((rel) => !GOLDEN_EXCLUDED.has(rel))
      .sort();
    const lines = rels.map((rel) => `${sha256(path.join(scratch, rel))}  ${rel}`);
    fs.writeFileSync(manifestPath, `${lines.join('\n')}\n`, 'utf8');
    return { count: lines.length, manifestPath };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function main(): void {
  const { count, manifestPath } = updateGoldenManifest();
  process.stdout.write(`golden:update: wrote ${count} entries to ${path.relative(process.cwd(), manifestPath)}\n`);
}

if (require.main === module) main();
