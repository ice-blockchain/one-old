// tests/replay-corpus/fixture-refusal.test.ts
// A corpus fixture that continues over a refused write does not fail — it
// silently characterizes a DIFFERENT project than the one it names, and the case
// built on it goes green describing the wrong thing. This pins the one fixture
// whose entire identity is a single state write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { cleanupReplayTempTrees, existingCodebaseUndetectable } from './fixtures';
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
