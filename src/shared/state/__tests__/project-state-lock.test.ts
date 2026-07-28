import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { withProjectStateLock } from '../project-state-lock';

// 3cl regression: macOS surfaces a transient EPERM on the lock-acquire rename
// when it races another hook process's release — by the time the loser looks,
// the lock dir is gone, so the old "EPERM is contended only while lockPath
// exists" classification rethrew and the pipeline turned it into a
// fail-closed deny ("plan-guard.write gate failed (EPERM)"). EPERM must retry
// like every other contention signal.
test('a transient EPERM on lock acquire retries instead of escaping the hook', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-state-lock-'));
  // Star-import namespaces are getter-only under tsx; patch the shared CJS
  // module object that the lock module actually calls through.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mutableFs = require('fs') as Record<string, unknown>;
  const realRename = fs.renameSync;
  let denied = 0;
  mutableFs.renameSync = (from: fs.PathLike, to: fs.PathLike): void => {
    if (denied < 2 && String(to).endsWith('.report-id.lock')) {
      denied += 1;
      const error = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error; // lock dir does NOT exist at this moment — the raced-release shape
    }
    realRename(from, to);
  };
  try {
    const result = withProjectStateLock(dir, () => 'ran');
    assert.equal(result, 'ran');
    assert.equal(denied, 2, 'the stub actually exercised the EPERM path');
  } finally {
    mutableFs.renameSync = realRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
