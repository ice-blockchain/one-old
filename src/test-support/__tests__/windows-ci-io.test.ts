// src/test-support/__tests__/windows-ci-io.test.ts
// windows-latest cancelled at the 60m hang ceiling twice: first on 10k-file
// git/PNG trees (CRLF warning flood + Defender), then at 59m 10s AFTER those
// trees were skipped, because source-scan still wrote 25_500 files and the
// scanner still opened every other fixture. A skip that is not pinned comes
// back the next time someone adds a bound-proof tree. The Defender step is
// the same: deleting it returns the 59m cancel and a refuse-step red that
// looks like "no pass count" because the suite never finished.

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
      `${row.file} plants ${row.marker} and must import SKIP_10K_TREE_ON_WIN32 so windows-latest does not recreate the tree`,
    );
  }
});

test('generate-check turns Defender and autocrlf off on windows-latest before npm test', () => {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/generate-check.yml'), 'utf8');
  const unblock = workflow.indexOf('Unblock Windows test I/O');
  const tests = workflow.indexOf('\n      - name: Tests\n');
  assert.ok(unblock !== -1, 'the Windows I/O step must exist');
  assert.ok(tests !== -1, 'the Tests step must exist');
  assert.ok(unblock < tests, 'Defender must be off before npm test, not after');
  assert.match(workflow, /DisableRealtimeMonitoring/);
  assert.match(workflow, /core\.autocrlf false/);
  assert.match(workflow, /timeout-minutes: 60/);
});

test('windows-latest splits npm test across three shards so one runner cannot burn the hour', () => {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/generate-check.yml'), 'utf8');
  assert.match(workflow, /shard: \[1, 2, 3\]/);
  assert.match(workflow, /T1_TEST_SHARDS: \$\{\{ matrix\.os == 'windows-latest' && 3 \|\| 1 \}\}/);
  assert.match(workflow, /npm test -- --test-shard="\$shard\/\$denom"/);
  assert.match(workflow, /if \[ "\$RUNNER_OS" = Windows \]; then floor=400; fi/);
  const pkg = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  assert.match(pkg, /--test-timeout=180000/, 'a hung file must die instead of eating the 60m job');
});
