// state/normalize.ts's `.one.json` funnel: the lost update, the corrupt base,
// and the durable publish.
//
// ── what was ALREADY true, and is asserted here so nothing is built on a guess ─
// project-state-lock.ts exists and writeState really does perform its read
// INSIDE the lock. A lock wrapped around only the write would not prevent a lost
// update, and that is not the shape here. The defect is one level up: every
// caller spelled `writeState(cwd, { ...readState(cwd), ...patch })` takes its
// snapshot BEFORE asking for the lock, so two hooks setting two different fields
// serialize perfectly and the second still erases the first's field. The lock
// was never the missing piece — the re-read was.
//
// Only `one-uid` and `currentRunId` survive that today, because each was lost in
// production once and got its own rescue function afterwards. The first test
// below pins exactly that asymmetry: the two special-cased fields live, an
// ordinary field dies. `patchState` generalizes the rescue instead of extending
// the list of fields that happen to have been rescued.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ONE_UID_FIELD } from '../../../config/reporting';
import { patchState, readState, statePath, writeState } from '../normalize';
import { drainStateWrites } from '../state-write-log';

const REPORT_ID = 'lane-fsjson-durable-id';

// Isolate the per-project prefs file and the machine-wide one.json exactly as
// normalize.test.ts does, so nothing here reads or writes the real
// ~/.traffic-one.
function withProject<T>(label: string, fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `t1lane-merge-${label}-`));
  const saved = {
    prefs: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: process.env.TRAFFIC_ONE_STATE_PATH,
    host: process.env.TRAFFIC_ONE_HOST,
    plan: process.env.TRAFFIC_ONE_USER_PLAN,
  };
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  process.env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  process.env.TRAFFIC_ONE_HOST = 'codex';
  process.env.TRAFFIC_ONE_USER_PLAN = 'pro';
  drainStateWrites();
  try {
    return fn(dir);
  } finally {
    for (const [key, value] of [
      ['TRAFFIC_ONE_PROJECT_PREFS_PATH', saved.prefs],
      ['TRAFFIC_ONE_STATE_PATH', saved.state],
      ['TRAFFIC_ONE_HOST', saved.host],
      ['TRAFFIC_ONE_USER_PLAN', saved.plan],
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

function seed(dir: string): void {
  assert.equal(writeState(dir, {
    stack: 'default',
    mode: 'new-project',
    currentRunId: '1715091785000',
    [ONE_UID_FIELD]: REPORT_ID,
  }), true, 'the fixture must actually persist, or every assertion below is vacuous');
}

// ── the hazard, established rather than assumed ──────────────────────────────

test('the lost update is REAL: a whole-object write drops a field it never saw, and only the two rescued fields survive', () => {
  withProject('lost-update', (dir) => {
    seed(dir);

    // Hook A reads the project state and goes off to do its work.
    const staleSnapshot = readState(dir);
    assert.equal(staleSnapshot.uiLibrary, undefined);

    // Hook B, meanwhile, completes its whole read-modify-write cycle.
    assert.equal(writeState(dir, { ...readState(dir), uiLibrary: 'shadcn' }), true);
    assert.equal(onDisk(dir).uiLibrary, 'shadcn');

    // Hook A now publishes, holding the same lock B held, and re-read inside it
    // — and still erases B's field, because A's SNAPSHOT predates B.
    assert.equal(writeState(dir, { ...staleSnapshot, openCodeDelegation: 'A' }), true);
    const after = onDisk(dir);
    assert.equal(after.openCodeDelegation, 'A');
    assert.equal(after.uiLibrary, undefined,
      'if this ever becomes shadcn, writeState has started merging and this characterization is stale');

    // …while the two fields that were each lost in production once, and each got
    // their own rescue afterwards, DO survive. That asymmetry is the whole
    // argument for a general merge instead of a third rescue function.
    assert.equal(after[ONE_UID_FIELD], REPORT_ID, 'preserveOneMcpReportId still pins the report id');
    assert.equal(after.currentRunId, '1715091785000', 'preserveCurrentRunId still pins the run pointer');
  });
});

test('patchState survives the same interleaving: the merge is against a re-read inside the lock', () => {
  withProject('patch', (dir) => {
    seed(dir);

    // The same two hooks, each declaring only the field it owns. A's decision is
    // still made before B runs — that is the point; what changed is that the
    // BASE is read when the lock is held, not when the decision was taken.
    const aField = 'A';
    assert.equal(patchState(dir, { uiLibrary: 'shadcn' }), true);
    assert.equal(patchState(dir, { openCodeDelegation: aField }), true);

    const after = onDisk(dir);
    assert.equal(after.uiLibrary, 'shadcn', 'the earlier writer\'s field survived the later one');
    assert.equal(after.openCodeDelegation, 'A');
    assert.equal(after.stack, 'default', 'and everything neither of them declared is untouched');
    assert.equal(after[ONE_UID_FIELD], REPORT_ID);
    assert.equal(after.currentRunId, '1715091785000');
  });
});

test('patchState on a project with no state file at all creates one from the declared fields', () => {
  withProject('patch-fresh', (dir) => {
    assert.equal(fs.existsSync(statePath(dir)), false);
    assert.equal(patchState(dir, { mode: 'existing-codebase' }), true);
    assert.equal(onDisk(dir).mode, 'existing-codebase');
  });
});

// ── the corrupt base ─────────────────────────────────────────────────────────

test('a CORRUPT .one.json is preserved beside the file it is replaced by, never simply overwritten', () => {
  withProject('corrupt-quarantine', (dir) => {
    seed(dir);
    // Exactly the shape the item names: a file torn by a crash mid-write, or
    // hand-edited badly. Under `readJson(file, {})` this read as `{}` — and `{}`
    // is what preserveOneMcpReportId and preserveCurrentRunId consult, so the
    // durable report id and the live run pointer went with it.
    const torn = `{"stack":"default","${ONE_UID_FIELD}":"${REPORT_ID}","currentRunId":"17150`;
    fs.writeFileSync(statePath(dir), torn, 'utf8');

    assert.equal(writeState(dir, { stack: 'default', mode: 'new-project' }), true,
      'the project must still be able to heal itself');
    const quarantine = `${statePath(dir)}.corrupt`;
    assert.equal(fs.existsSync(quarantine), true, 'the unreadable bytes were destroyed rather than preserved');
    assert.equal(fs.readFileSync(quarantine, 'utf8'), torn, 'and preserved byte-for-byte, including the id we could not parse');
    assert.equal(onDisk(dir).stack, 'default', 'the live file is healthy again');
  });
});

test('patchState REFUSES a corrupt base instead of writing its fields over one', () => {
  withProject('corrupt-patch', (dir) => {
    seed(dir);
    const torn = '{"stack":"defa';
    fs.writeFileSync(statePath(dir), torn, 'utf8');

    assert.equal(patchState(dir, { uiLibrary: 'shadcn' }), false,
      'a patch is defined against a base; without one there is nothing honest to publish');
    assert.equal(fs.readFileSync(statePath(dir), 'utf8'), torn,
      'and a refused patch leaves the file exactly as it found it');
    assert.equal(fs.existsSync(`${statePath(dir)}.corrupt`), false,
      'nothing was replaced, so nothing needed quarantining');
  });
});

// The kind beyond the three the item asked for, and the one where overwriting is
// least defensible: there ARE bytes there and we cannot copy them.
test('an UNREADABLE .one.json is never replaced, because its bytes cannot be preserved first', () => {
  withProject('unreadable', (dir) => {
    fs.mkdirSync(path.dirname(statePath(dir)), { recursive: true });
    fs.mkdirSync(statePath(dir));

    assert.equal(writeState(dir, { stack: 'default', mode: 'new-project' }), false,
      'a replacement it cannot preserve the previous bytes of must be refused, not performed');
    assert.equal(patchState(dir, { uiLibrary: 'shadcn' }), false);
    assert.equal(fs.statSync(statePath(dir)).isDirectory(), true, 'and the path is left exactly as it was');
  });
});

// ── the durable publish ──────────────────────────────────────────────────────

const cjsFs = createRequire(__filename)('fs') as typeof fs;

test('writeState publishes .one.json through the DURABLE writer, not the plain one', () => {
  withProject('durable', (dir) => {
    seed(dir);
    const realFsync = cjsFs.fsyncSync;
    const synced: string[] = [];
    cjsFs.fsyncSync = ((fd: number) => {
      try {
        synced.push(fs.fstatSync(fd).isDirectory() ? 'dir' : 'file');
      } catch { /* classification only */ }
      return realFsync(fd);
    }) as typeof fs.fsyncSync;
    try {
      assert.equal(writeState(dir, { stack: 'default', mode: 'new-project', uiLibrary: 'shadcn' }), true);
    } finally {
      cjsFs.fsyncSync = realFsync;
    }
    assert.ok(synced.includes('file'),
      'the state file was renamed into place without its data being flushed first — the exact defect this lane closed');
    assert.ok(synced.includes('dir'), 'and the directory entry the rename created was flushed too');
  });
});

test('writeState still reports the fence\'s refusal, and a refused publish is not reported as persisted', () => {
  withProject('fence', (dir) => {
    seed(dir);
    // MOVE-ASIDE PLUS LINK, not a dangling link: writeState READS `.one.json`
    // before it writes, and a dangling link would make that read answer `absent`
    // — the writer would then be refused for a reason the test never controlled.
    // Here the read still resolves (asserted), so the refusal below is the
    // symlink fence on the WRITE and nothing else.
    const state = statePath(dir);
    const real = `${state}.real`;
    fs.renameSync(state, real);
    fs.symlinkSync(real, state);
    const before = fs.readFileSync(real, 'utf8');
    assert.equal(readState(dir).stack, 'default', 'the fixture guard: the read still resolves through the link');
    drainStateWrites();

    assert.equal(writeState(dir, { stack: 'minimal', mode: 'new-project' }), false,
      'a refused publish must never answer true');
    assert.equal(fs.readFileSync(real, 'utf8'), before, 'and nothing was written through the link');
    const records = drainStateWrites();
    assert.ok(records.some((record) => record.op === 'write-json-durable' && !record.ok && record.errno === 'symlink'),
      `expected the durable writer's refusal in the decision log, got ${JSON.stringify(records)}`);
  });
});
