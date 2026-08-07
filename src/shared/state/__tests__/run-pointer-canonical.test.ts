// The run pointer that `.one.json` publishes, and the raw readers that consume it.
//
// ── the asymmetry this file exists for ───────────────────────────────────────
// `currentRunId` has two readerships. `readEffectiveState` coerces it on the way
// out (local-prefs/index.ts `normalizeRuntimeIds`: number → string, string →
// trimmed), so everything reading through that funnel is insulated from whatever
// shape is actually on disk. The RAW readers are not, and there are ~30 of them,
// every one spelling the test the same way:
//
//     typeof state.currentRunId === 'string' ? state.currentRunId.trim() : ''
//
// A number fails that test. Not "reads oddly" — reads as NO CURRENT RUN. The one
// that decides something irreversible is shared/retention.ts `readCurrentRunId`,
// which parses `.one.json` straight off disk and whose answer seeds the retention
// keep set: with no current run the sweep is free to reclaim the directory of the
// run an agent is working in right now.
//
// `normalizeState` already coerces, and its placement says the author knew this
// was not a stack question — the coercion sits AHEAD of that function's own
// `if (!s.stack) return changed`. `writeState`, the funnel all ~34 project-state
// writers pass through, is what never let it run: it calls normalizeState only
// when `source.stack` is a string. So the single publish path shared by every
// writer was the one that could persist a shape the raw readers cannot see.
//
// ── what these tests are, and are not ────────────────────────────────────────
// Reachability, stated honestly: no minter in this tree produces a numeric id
// today (they all stamp `String(Date.now())`-shaped ids), so the input this
// closes arrives from HISTORY — an `.one.json` written by an older plugin, the
// same provenance the `number` branch in normalizeState and the `number` branch
// in project-state-lock.ts `runIdValue` were both written for. Neither of those
// was deleted as unreachable, and this is the third member of that set. The
// tests below assert the coercion, not a live incident.
//
// Fixture honesty: every write asserts `true` before anything is read back, so a
// refused publish cannot make a later assertion pass against stale bytes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { normalizeState, patchState, readState, statePath, writeState } from '../normalize';

function withProject<T>(label: string, fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `t1laneA-runptr-${label}-`));
  const saved = {
    prefs: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: process.env.TRAFFIC_ONE_STATE_PATH,
    host: process.env.TRAFFIC_ONE_HOST,
  };
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  process.env.TRAFFIC_ONE_HOST = 'codex';
  try {
    return fn(dir);
  } finally {
    for (const [key, value] of [
      ['TRAFFIC_ONE_PROJECT_PREFS_PATH', saved.prefs],
      ['TRAFFIC_ONE_STATE_PATH', saved.state],
      ['TRAFFIC_ONE_HOST', saved.host],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function onDisk(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as Record<string, unknown>;
}

// shared/retention.ts `readCurrentRunId`, transcribed. Kept as a local copy on
// purpose: retention.ts is not this lane's file, and what is being pinned is the
// SHAPE contract between the writer and every raw reader of it, not that one
// module's internals. If retention's spelling ever loosens, this still states
// what `.one.json` is required to publish.
function rawReaderSees(dir: string): string | null {
  const state = JSON.parse(fs.readFileSync(statePath(dir), 'utf8')) as Record<string, unknown>;
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  return runId || null;
}

test('writeState canonicalizes a legacy NUMERIC currentRunId on a STACKLESS publish', () => {
  withProject('numeric-stackless', (dir) => {
    assert.equal(
      writeState(dir, { mode: 'new-project', currentRunId: 1786117326973 }),
      true,
      'the publish must land, or the assertion below reads a file that was never written',
    );
    const after = onDisk(dir);
    assert.equal(typeof after.currentRunId, 'string',
      'a number on disk is invisible to every raw reader, which all test `typeof === "string"`');
    assert.equal(after.currentRunId, '1786117326973');
  });
});

test('the raw retention reader can see the live run after a stackless publish', () => {
  withProject('retention-visibility', (dir) => {
    assert.equal(writeState(dir, { mode: 'new-project', currentRunId: 1786117326973 }), true);
    assert.equal(rawReaderSees(dir), '1786117326973',
      'null here is the defect: retention drops the live run from its keep set and may reclaim it');
  });
});

test('writeState trims a padded currentRunId on a stackless publish', () => {
  withProject('padded-stackless', (dir) => {
    assert.equal(writeState(dir, { mode: 'new-project', currentRunId: '  1786117326973\n' }), true);
    assert.equal(onDisk(dir).currentRunId, '1786117326973',
      'untrimmed ids reach path joins in the raw readers that do not trim');
  });
});

test('patchState publishes a canonical run pointer too, since it lands through writeState', () => {
  withProject('patch-stackless', (dir) => {
    assert.equal(writeState(dir, { mode: 'new-project', currentRunId: 1786117326973 }), true);
    // The realistic loop: the numeric id is already on disk, readState hands it
    // back as a number, and an unrelated patch re-publishes the whole object.
    assert.equal(typeof readState(dir).currentRunId, 'string',
      'if this is a number the value round-trips unhealed forever');
    assert.equal(patchState(dir, { lifecycle: { phase: 'maintenance' } }), true);
    assert.equal(onDisk(dir).currentRunId, '1786117326973');
    assert.equal(rawReaderSees(dir), '1786117326973');
  });
});

test('an ALL-WHITESPACE currentRunId is still treated as absent and rescued from the on-disk id', () => {
  withProject('whitespace', (dir) => {
    assert.equal(writeState(dir, { stack: 'default', mode: 'new-project', currentRunId: '1715091785000' }), true);
    assert.equal(onDisk(dir).currentRunId, '1715091785000', 'seed must be real or the rescue below proves nothing');

    // Trimming this to '' instead of leaving it alone would publish a BLANK
    // pointer, and preserveCurrentRunId would have nothing to rescue: the next
    // run claim mints a second run (observation 11c). Absent beats blank.
    assert.equal(writeState(dir, { stack: 'default', mode: 'new-project', currentRunId: '   ' }), true);
    assert.equal(onDisk(dir).currentRunId, '1715091785000',
      'the live pointer must survive a publish that carries only whitespace');
  });
});

test('normalizeState reports the run-pointer coercion in its changed flag on a stackless state', () => {
  const stackless: Record<string, unknown> = { mode: 'new-project', currentRunId: 1786117326973 };
  assert.equal(normalizeState(stackless), true,
    'callers persist only when normalizeState says something changed; a silent coercion never lands');
  assert.equal(stackless.currentRunId, '1786117326973');

  const alreadyCanonical: Record<string, unknown> = { mode: 'new-project', currentRunId: '1786117326973' };
  assert.equal(normalizeState(alreadyCanonical), false,
    'a canonical pointer must not report a change, or every hook republishes .one.json for nothing');
});

// The writeState-level whitespace test above cannot see this, and that is worth
// saying rather than leaving as a gap someone rediscovers: through writeState the
// two behaviours are INDISTINGUISHABLE, because preserveCurrentRunId treats `''`
// and `'   '` alike and rescues the on-disk id either way. normalizeState is the
// layer where the difference is observable, and it has sixteen OTHER callers that
// do not go through writeState — converge.ts and converge-from-write.ts spend the
// returned boolean directly to decide whether to publish at all.
test('normalizeState leaves an ALL-WHITESPACE run pointer alone instead of blanking it', () => {
  const blankish: Record<string, unknown> = { mode: 'new-project', currentRunId: '   ' };
  assert.equal(normalizeState(blankish), false,
    'blanking a pointer is a CHANGE, and a caller that publishes on `changed` would then persist it');
  assert.equal(blankish.currentRunId, '   ',
    'an id that trims to nothing must stay untouched: absent is rescuable, blank-on-disk is not');
});
