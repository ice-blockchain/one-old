import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { clearEmitMarker, emittedWithin, firstEmitThisSession, stampEmitMarker } from '../once';

function withDir(fn: (cwd: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-once-')));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('clearEmitMarker forgets a stamped cross-surface marker so it can re-emit', () => {
  withDir((cwd) => {
    stampEmitMarker(cwd, 'setup-link-nudge:abc');
    assert.equal(emittedWithin(cwd, 'setup-link-nudge:abc', 60_000), true, 'stamp is visible');
    clearEmitMarker(cwd, 'setup-link-nudge:abc');
    assert.equal(emittedWithin(cwd, 'setup-link-nudge:abc', 60_000), false, 'cleared marker no longer suppresses');
  });
});

test('clearEmitMarker is a no-op on a missing marker and never touches session-keyed markers', () => {
  withDir((cwd) => {
    // Missing marker → desired state already; must not throw.
    clearEmitMarker(cwd, 'never-stamped');

    // A session-keyed once marker shares the label but not the -shared suffix.
    assert.equal(firstEmitThisSession(cwd, 'setup-link-nudge:abc', 'sess-1'), true);
    clearEmitMarker(cwd, 'setup-link-nudge:abc');
    assert.equal(firstEmitThisSession(cwd, 'setup-link-nudge:abc', 'sess-1'), false,
      'the session once-marker survives a shared-marker clear');
  });
});
