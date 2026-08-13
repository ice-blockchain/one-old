// tests/replay-corpus/fixture-refusal.test.ts
// A corpus fixture that continues over a refused write does not fail — it
// silently characterizes a DIFFERENT project than the one it names, and the case
// built on it goes green describing the wrong thing. This pins the two fixtures
// whose entire identity is a single write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { cleanupReplayTempTrees, existingCodebaseUndetectable, resetRecordedMainAgent } from './fixtures';
import { readJson } from '../../src/shared/fsjson';
import type { Rec } from '../../src/shared/obj';

test.after(cleanupReplayTempTrees);

test('existingCodebaseUndetectable throws rather than hand back a project with no mode on disk', () => {
  const baseline = existingCodebaseUndetectable('claude');
  const statePath = path.join(baseline, '.traffic-one', '.one.json');
  assert.equal(readJson<Rec>(statePath, {} as Rec).mode, 'existing-codebase',
    'writable baseline: the mode IS the fixture, and it reached disk');

  // The builder names its own directory (a counter under one fixture root), so
  // the fence can be planted at the path the NEXT call will write. A dangling
  // link is the right instrument here and only here: the directory is brand new,
  // so nothing in the builder reads state back — and fsjson refuses a symlink at
  // the destination whether or not it resolves.
  const root = path.dirname(baseline);
  const seq = Number(path.basename(baseline).split('-')[0]) + 1;
  const nextDir = path.join(root, `${String(seq).padStart(3, '0')}-existing-undetectable`);
  const fenced = path.join(nextDir, '.traffic-one', '.one.json');
  fs.mkdirSync(path.dirname(fenced), { recursive: true });
  fs.symlinkSync(path.join(root, 'nowhere.json'), fenced);

  assert.throws(
    () => existingCodebaseUndetectable('claude'),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /the state write fence refused/);
      // Proves the throw came from the guarded write and not from an earlier
      // step: the path it names is the one that was fenced.
      assert.ok(message.includes(fenced), `names the refused path (${message})`);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(root, 'nowhere.json')), false, 'nothing was written through the link');
});

// The second such fixture, and the reason it is worth a test of its own is the
// pair of cases standing on it: `plan-guard.reset-record-erased-by-shell` expects
// the reset-record fence to DENY, and `plan-guard.reset-record-read-allowed`
// expects the same fixture to ALLOW a read of the record. The fence returns early
// unless the record is really on disk — so over a refused `recordReset` the deny
// case reds for the wrong reason and the ALLOW control still passes, having
// measured nothing. A green row that measured nothing is the one failure a corpus
// cannot report, which is why the fixture has to refuse to exist instead.
test('resetRecordedMainAgent throws rather than hand back a project that never reset', () => {
  const baseline = resetRecordedMainAgent('claude');
  assert.ok(fs.existsSync(path.join(baseline, '.traffic-one', 'runs', '.resets.json')),
    'writable baseline: the record IS the fixture, and it reached disk');

  // Same directory prediction as above, and a dangling link again for a second
  // reason: `recordReset` reads the record before rewriting it, through a
  // readJson that answers its fallback for an absent file — so an unresolvable
  // link leaves the read intact and refuses only the write.
  const root = path.dirname(baseline);
  const seq = Number(path.basename(baseline).split('-')[0]) + 1;
  const nextDir = path.join(root, `${String(seq).padStart(3, '0')}-greenfield-main-agent`);
  const fenced = path.join(nextDir, '.traffic-one', 'runs', '.resets.json');
  fs.mkdirSync(path.dirname(fenced), { recursive: true });
  fs.symlinkSync(path.join(root, 'no-record.json'), fenced);

  assert.throws(
    () => resetRecordedMainAgent('claude'),
    (error: unknown) => {
      const message = String((error as Error).message);
      assert.match(message, /the write fence refused/);
      assert.ok(message.includes(fenced), `names the refused path (${message})`);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(root, 'no-record.json')), false, 'nothing was written through the link');
});
