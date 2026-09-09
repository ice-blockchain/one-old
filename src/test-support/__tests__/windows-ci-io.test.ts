// src/test-support/__tests__/windows-ci-io.test.ts
// windows-latest is off the generate-check matrix. Mass fixture trees still
// skip on local win32 so a maintainer laptop does not recreate the 10k / 25k
// trees that cancelled hosted Windows. A skip that is not pinned comes back
// the next time someone adds a bound-proof tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const MASS_TREE_MARKERS: readonly { readonly file: string; readonly marker: string }[] = [
  { file: 'src/shared/__tests__/architecture-scan-bound.test.ts', marker: '10_001' },
  { file: 'src/shared/__tests__/architecture-scan-bound.test.ts', marker: '9_996' },
  { file: 'src/modules/plan-guard/__tests__/plan-readiness.test.ts', marker: 'i < 10_001' },
  { file: 'src/shared/detection/__tests__/source-scan.test.ts', marker: 'SOURCE_SCAN_ENTRY_BUDGET + 500' },
  { file: 'src/shared/detection/__tests__/source-scan.test.ts', marker: 'SOURCE_SCAN_DIRECTORY_BUDGET + 200' },
  { file: 'src/shared/__tests__/run-settlement.test.ts', marker: 'index < 2_048' },
];

test('every mass fixture tree that cancelled windows-latest still skips on win32', () => {
  for (const row of MASS_TREE_MARKERS) {
    const text = fs.readFileSync(path.join(REPO_ROOT, row.file), 'utf8');
    assert.ok(text.includes(row.marker), `${row.file} must still plant ${row.marker}`);
    assert.ok(
      text.includes('SKIP_10K_TREE_ON_WIN32'),
      `${row.file} plants ${row.marker} and must import SKIP_10K_TREE_ON_WIN32 so a local win32 run does not recreate the tree`,
    );
  }
});

test('generate-check has no windows-latest job', () => {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/generate-check.yml'), 'utf8');
  const matrix = /os:\s*\[([^\]]+)\]/.exec(workflow);
  assert.ok(matrix, 'the generate-check OS matrix is gone or reshaped');
  const runners = matrix![1]!.split(',').map((entry) => entry.trim()).filter(Boolean);
  assert.ok(!runners.includes('windows-latest'), `matrix still lists windows-latest: ${runners.join(', ')}`);
  assert.doesNotMatch(workflow, /runs-on:\s*windows-latest/);
});
