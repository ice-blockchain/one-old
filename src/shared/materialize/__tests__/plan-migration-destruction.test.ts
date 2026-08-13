// THE DELETE IS KEYED ON THE BLOCK, NOT ON THE MARKER — and this file is the
// only reason to believe it.
//
// Round 4 moved the FOLD to a content key and left the DELETE on
// `persistedPlan.includes(doc.marker)`. The marker lives in `plan.md`, which the
// user owns and edits, and it survives every edit that destroys the content it
// stands for. Three measured routes to a document unlinked with its bytes in no
// file under the project root, all three here.
//
// EVERY TEST BELOW ALSO KILLS THREE MUTANTS, which is the whole point: the old
// marker check was INERT (`planChanged === false` implies every candidate marker
// is already in `basePlan`; `planChanged === true` only proceeds when the guarded
// write returned true, which puts every candidate marker in the file), so
// deleting it and reverting it to the round-3 heading key both survived the full
// suite. Each `assert` here fails for all three of:
//
//   M1  the delete-side check removed outright
//   M2  the check reverted to the heading key   (`includes('### ' + relPath)`)
//   M3  the check reverted to the marker key    (`includes(doc.marker)`)
//
// because in each fixture the plan carries the heading AND the marker and does
// NOT carry the bytes. THE REACHABILITY, stated rather than assumed: a document
// whose marker is already in `basePlan` is not folded, so its block is never
// written, so whether the plan carries it is a fact about the user's file and not
// about anything the migration just did. That is the branch these three fixtures
// enter; see plan-migration-window.test.ts for the other one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { migrateArchitectureDocsToPlan } from '../plan-migration';
import { resetAuthoringRootCache } from '../../authoring-root';
import { resetPluginUseCache } from '../../state/plugin-use';

const LEGACY_BODY = '# Our architecture\n\nHand written by the team, never by Traffic One.\n';
const NEEDLE = 'Hand written by the team';

function withDir(body: (dir: string) => void): void {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 't1-plan-migration-destruction-'));
  const previousAsk = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';
  resetAuthoringRootCache();
  resetPluginUseCache();
  try {
    body(fs.realpathSync(created));
  } finally {
    if (previousAsk === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = previousAsk;
    fs.rmSync(created, { recursive: true, force: true });
    resetAuthoringRootCache();
    resetPluginUseCache();
  }
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

function legacyProject(dir: string, body = LEGACY_BODY): string {
  write(path.join(dir, '.traffic-one', '.one.json'),
    JSON.stringify({ mode: 'existing-codebase', stack: 'minimal', onboardingComplete: true, confirmed: true }));
  const doc = path.join(dir, 'architecture.md');
  write(doc, body);
  return doc;
}

function planPath(dir: string): string {
  return path.join(dir, '.traffic-one', 'plan.md');
}

function planOf(dir: string): string {
  return fs.readFileSync(planPath(dir), 'utf8');
}

/** Does `needle` exist in ANY file under the project root? The ruling's question. */
function bytesSurviveUnder(root: string, needle: string): boolean {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      try {
        if (fs.readFileSync(full, 'utf8').includes(needle)) return true;
      } catch { /* unreadable files carry nothing we can claim */ }
    }
  }
  return false;
}

/** The three mutants all pass what the plan still carries; the block key does not. */
function assertMutantsWouldHaveDeleted(dir: string, relPath: string): void {
  const plan = planOf(dir);
  assert.ok(plan.includes(`### ${relPath}`),
    'M2 pre-condition: the plan still carries the heading, so a heading-keyed delete would fire');
  assert.match(plan, /<!-- traffic-one:migrated /,
    'M3 pre-condition: the plan still carries the marker, so a marker-keyed delete would fire');
}

test('plan migration: prose deleted from the plan and the MARKER KEPT does not license a delete', () => {
  // Route 1, and it is one keystroke: the HTML comment is invisible in every
  // rendered markdown view, so removing the migrated paragraph and leaving the
  // comment is what an editor session looks like. Measured with the marker key:
  // the restored document was unlinked and its bytes were in ZERO files.
  withDir((dir) => {
    const doc = legacyProject(dir);
    migrateArchitectureDocsToPlan(dir);
    write(planPath(dir), planOf(dir).split('\n').filter((line) => !line.includes(NEEDLE)).join('\n'));
    write(doc, LEGACY_BODY);

    const result = migrateArchitectureDocsToPlan(dir);

    assertMutantsWouldHaveDeleted(dir, 'architecture.md');
    assert.deepEqual(result?.migrated, [], 'nothing was removed');
    assert.deepEqual(result?.retained, [{ relPath: 'architecture.md', reason: 'not-carried' }],
      'and the reason is reported, not swallowed');
    assert.equal(fs.readFileSync(doc, 'utf8'), LEGACY_BODY, 'the document survives BYTE FOR BYTE');
    assert.equal(bytesSurviveUnder(dir, NEEDLE), true);
  });
});

test('plan migration: the CONTROL — with the marker removed too, the fold re-runs and keeps everything', () => {
  // Without this row the whole file would pass a delete-side check that always
  // refused. The only difference between this fixture and the one above is one
  // comment line, and it must be the difference between "re-fold" and "leave it",
  // never between "keep" and "destroy".
  withDir((dir) => {
    const doc = legacyProject(dir);
    migrateArchitectureDocsToPlan(dir);
    write(planPath(dir), planOf(dir).split('\n')
      .filter((line) => !line.includes(NEEDLE) && !line.includes('traffic-one:migrated'))
      .join('\n'));
    write(doc, LEGACY_BODY);

    const result = migrateArchitectureDocsToPlan(dir);

    assert.deepEqual(result?.migrated, ['architecture.md'], 'the document IS removed once its bytes are re-folded');
    assert.equal(fs.existsSync(doc), false);
    assert.ok(planOf(dir).includes(LEGACY_BODY), 'and the plan carries the bytes verbatim');
  });
});

test('plan migration: a FORMATTER re-wrapping the folded prose does not license a delete', () => {
  // Route 2. No human decision at all: a markdown formatter enforcing a column
  // limit re-wraps the paragraph and leaves the comment alone.
  const body = '# Our architecture\n\nHand written by the team, never by Traffic One, and this sentence is long enough that a formatter enforcing a column limit will re-wrap it.\n';
  withDir((dir) => {
    const doc = legacyProject(dir, body);
    migrateArchitectureDocsToPlan(dir);
    write(planPath(dir), planOf(dir).replace(
      'Hand written by the team, never by Traffic One, and this sentence is long enough that a formatter enforcing a column limit will re-wrap it.',
      'Hand written by the team, never by Traffic One, and this sentence is\nlong enough that a formatter enforcing a column limit will re-wrap it.',
    ));
    write(doc, body);

    const result = migrateArchitectureDocsToPlan(dir);

    assertMutantsWouldHaveDeleted(dir, 'architecture.md');
    assert.deepEqual(result?.migrated, []);
    assert.deepEqual(result?.retained, [{ relPath: 'architecture.md', reason: 'not-carried' }]);
    assert.equal(fs.readFileSync(doc, 'utf8'), body, 'the exact bytes are still on disk');
  });
});

test('plan migration: with nothing to fold the plan is not RE-NORMALIZED, which would strand the retried delete', () => {
  // THE THIRD UNPINNED CLAIM. `migrateArchitectureDocsToPlan`'s docblock argues at
  // length that rebuilding `nextPlan` from `existingPlan.trimEnd()` when nothing
  // was folded "would trim the trailing newlines of the last folded document out
  // of the block that licenses its delete, stranding any document whose unlink
  // had to be retried" — and reinstating exactly that survived all 81 tests. A
  // measured hazard with no row is a claim, not a guard.
  //
  // THE SHAPE, and none of it is contrived. The document's body ends in a blank
  // line, so its block ends in two newlines. The user deletes the section
  // sentinel — a supported shape the fold's own fallback path is written for —
  // which leaves that block's trailing newlines at the END of the file, the one
  // place a `trimEnd` can reach them. The document then comes back with the same
  // bytes (a revert, a merge, a re-created file), so nothing is folded and the
  // delete is a retry against a plan that already carries it.
  //
  // Re-normalized, the write goes ahead, the plan LOSES those two bytes, the
  // block is no longer carried, and the document is retained `not-carried` — and
  // it is stranded, not deferred: every later pass trims an already-trimmed plan,
  // so the block never comes back and the file is never removed.
  const body = '# Our architecture\n\nHand written by the team, never by Traffic One.\n\n';
  withDir((dir) => {
    const doc = legacyProject(dir, body);
    migrateArchitectureDocsToPlan(dir);
    const withoutSentinel = planOf(dir).split('<!-- traffic-one:migrated-notes:end -->')[0] ?? '';
    write(planPath(dir), withoutSentinel);
    assert.ok(withoutSentinel.endsWith('\n\n\n'),
      'the fixture only measures anything if the folded block\'s own newlines are what a trimEnd would take');
    write(doc, body);

    const result = migrateArchitectureDocsToPlan(dir);

    assert.deepEqual(result?.migrated, ['architecture.md'],
      'the retry finds its own block still there and completes the delete');
    assert.equal(fs.existsSync(doc), false);
    assert.equal(planOf(dir), withoutSentinel,
      'and the plan is BYTE-IDENTICAL: nothing was folded, so nothing was written');
  });
});

test('plan migration: a marker that reached the plan from ANOTHER document deletes nothing', () => {
  // Route 3. The marker's path field is honoured, so a marker for A cannot delete
  // B — but its PROVENANCE was never checked, and any writer of the plan can put
  // any marker in it. Closed twice over: a document carrying runtime marker
  // grammar is not a candidate at all (plan-migration-directives.test.ts), and
  // the marker reaching the plan by ANY other route — a hand edit, a merge, a
  // generator — still does not license the delete, which is what this row pins.
  withDir((dir) => {
    // Learn the root document's marker the way any plan writer could: fold it
    // once in a throwaway project.
    const probe = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-plan-migration-probe-')));
    let marker: string;
    try {
      legacyProject(probe);
      migrateArchitectureDocsToPlan(probe);
      marker = /<!-- traffic-one:migrated architecture\.md sha256:[0-9a-f]+ -->/.exec(planOf(probe))?.[0] ?? '';
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
    assert.notEqual(marker, '', 'the fixture needs the real marker for these bytes');

    const doc = legacyProject(dir);
    write(planPath(dir), `# Traffic One Plan\n\n## Migrated Legacy Plan Notes\n\n### architecture.md\n${marker}\n\nsomeone else's summary of the file, not the file\n`);

    const result = migrateArchitectureDocsToPlan(dir);

    assertMutantsWouldHaveDeleted(dir, 'architecture.md');
    assert.deepEqual(result?.migrated, []);
    assert.deepEqual(result?.retained, [{ relPath: 'architecture.md', reason: 'not-carried' }]);
    assert.equal(fs.readFileSync(doc, 'utf8'), LEGACY_BODY);
    assert.equal(bytesSurviveUnder(dir, NEEDLE), true);
  });
});
