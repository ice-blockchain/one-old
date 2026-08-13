// THE READ -> UNLINK WINDOW, DRIVEN BY A SECOND PROCESS.
//
// The migration reads every candidate, writes the plan, then unlinks each one:
// 58 ms for one document, 3.7 s for 400, and this codebase states elsewhere that
// parallel hook processes are normal. The peer measured the window but could not
// schedule a writer inside a synchronous migration from ONE process, so
// exploitability was a code read. It is not a code read here — each test below
// spawns a real second process that rewrites the file (or the plan) in a tight
// loop while the migration runs, and asserts on what is left.
//
// WHAT THESE ROWS DO NOT CLAIM: that the race is closed. `lstat` -> re-read ->
// `rmSync` is three syscalls and POSIX offers no compare-and-unlink, so a writer
// landing between the re-read and the unlink still loses. The claim is narrower
// and is what the guard buys: the exposed window shrinks from the whole migration
// — every other document's read AND the plan write — to the gap between two
// adjacent syscalls on one path, and a document that changed anywhere in the wide
// window is reported rather than destroyed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'node:module';
import * as os from 'os';
import * as path from 'path';

import { migrateArchitectureDocsToPlan } from '../plan-migration';
import { resetAuthoringRootCache } from '../../authoring-root';
import { resetPluginUseCache } from '../../state/plugin-use';

/**
 * The rival writer, as a file so a REAL second process runs it.
 *
 * The stop file is a SIGNAL, and a signal is not a bound: the rival is detached and
 * unref'd, so if the parent dies mid-row — a timeout, a SIGKILL, an interrupted run
 * — the fixture directory is removed with the stop file never written, and a loop
 * whose only exit condition is that file spins on a core with nothing left to
 * observe it. One escaped that way and burned 70% of a core for 17h41m, inflating
 * every timing measurement taken on this host meanwhile. So the deadline is the
 * outer bound and the stop file only ever ends the row EARLY.
 */
const RIVAL = `
const fs = require('fs');
const [, , target, stop, mode] = process.argv;
const deadline = Date.now() + 30000;
const payload = mode === 'plan'
  ? (n) => '# Traffic One Plan\\n\\n## Goal\\nrewritten by the rival, pass ' + n + '\\n'
  : (n) => '# rival version ' + n + '\\n\\nRACE ' + n + ' — written by a second process inside the window.\\n';
let i = 0;
while (Date.now() < deadline && !fs.existsSync(stop)) {
  try { fs.writeFileSync(target, payload(i), 'utf8'); } catch { /* the parent may have unlinked it */ }
  i += 1;
}
`;

// The `fs` NAMESPACE is getter-only under the TS loader, so the swap below is
// installed on the CJS exports object every `import * as fs` in this repository
// resolves to. Same object, mutable.
const mutableFs = createRequire(__filename)('fs') as { mkdirSync: typeof fs.mkdirSync; openSync: typeof fs.openSync; rmSync: typeof fs.rmSync };

interface Fixture {
  dir: string;
  doc: string;
  plan: string;
  stop: string;
}

function withFixture(body: (fx: Fixture) => void): void {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 't1-plan-migration-window-'));
  const previousAsk = process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';
  resetAuthoringRootCache();
  resetPluginUseCache();
  try {
    const dir = fs.realpathSync(created);
    fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'),
      JSON.stringify({ mode: 'existing-codebase', stack: 'minimal', onboardingComplete: true, confirmed: true }), 'utf8');
    fs.writeFileSync(path.join(dir, 'rival.cjs'), RIVAL, 'utf8');
    body({
      dir,
      doc: path.join(dir, 'architecture.md'),
      plan: path.join(dir, '.traffic-one', 'plan.md'),
      stop: path.join(dir, 'stop'),
    });
  } finally {
    if (previousAsk === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN;
    else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = previousAsk;
    fs.rmSync(created, { recursive: true, force: true });
    resetAuthoringRootCache();
    resetPluginUseCache();
  }
}

/**
 * Run the migration with a rival process hammering `target`, and hand back both
 * the result and whether the rival ever won a write. Synchronous on purpose: the
 * migration is synchronous, so the only way to have a writer inside its window is
 * for that writer to be a different process.
 */
function withRival(fx: Fixture, target: string, mode: 'doc' | 'plan'): { migrated: string[]; retained: string[] } {
  const rival = spawnSync(process.execPath, [
    '-e',
    `const { spawn } = require('child_process');
     const c = spawn(process.execPath, ['${path.join(fx.dir, 'rival.cjs').replace(/\\/g, '\\\\')}', '${target.replace(/\\/g, '\\\\')}', '${fx.stop.replace(/\\/g, '\\\\')}', '${mode}'], { detached: true, stdio: 'ignore' });
     c.unref();
     process.stdout.write(String(c.pid));`,
  ], { encoding: 'utf8' });
  assert.equal(rival.status, 0, 'the rival process must actually start, or the row measures nothing');

  // Give the rival time to be scheduled and land writes; then migrate while it runs.
  const spin = Date.now();
  while (Date.now() - spin < 150) { /* the rival is racing to its first write */ }

  let result;
  try {
    result = migrateArchitectureDocsToPlan(fx.dir);
  } finally {
    fs.writeFileSync(fx.stop, 'stop', 'utf8');
    const settle = Date.now();
    while (Date.now() - settle < 200) { /* let the rival observe the stop file and exit */ }
  }
  return {
    migrated: result?.migrated ?? [],
    retained: (result?.retained ?? []).map((doc) => `${doc.relPath}:${doc.reason}`),
  };
}

test('window: a second process rewriting the document does not get it destroyed with unfolded bytes', () => {
  // The destructive shape: the migration read version N, the plan carries version
  // N, and the file on disk is version N+k. Unlinking it destroys bytes the plan
  // never folded. Either outcome is correct and both are asserted together,
  // because which one happens depends on where the rival's write lands:
  //
  //   retained  the document changed after being read (or was caught truncated
  //             mid-write and read as blank) — reported, left on disk
  //   migrated  the rival lost the race entirely and the bytes on disk are the
  //             bytes in the plan
  //
  // What must NEVER happen is `migrated` with the file's last bytes absent from
  // the plan, and that is the assertion that carries this row.
  //
  // SO IT IS NOT A DETERMINISTIC MUTANT KILL, and two reviews in a row have
  // counted it as one. "Dropping the pre-unlink re-read kills exactly 3 tests"
  // has been reported twice as a fact about the guard; it is TWO DETERMINISTIC
  // KILLS PLUS ONE AT THE SCHEDULER'S DISCRETION. The two are the different-bytes
  // swap below and the item-10 instrument; the third is this row, whenever the
  // rival happens to win.
  //
  // The figure behind that correction needed correcting too, which is the useful
  // part: the 3/2/3 first measured for it came from three DIFFERENT trees (a
  // `git show HEAD:` reconstruction, where HEAD is a mid-session `seed` commit
  // rather than the pre-session anchor), so it was not evidence of nondeterminism
  // on any one tree. Measured on ONE tree since: three runs of the mutant killed
  // 3, 3 and 3, while a run of the same mutant on the same tree recorded 2. Same
  // tree, different counts — so the conclusion survives on sound footing, and any
  // single number for this mutant is a report of one scheduling.
  withFixture((fx) => {
    fs.writeFileSync(fx.doc, '# Ours\n\nthe version the migration will read\n', 'utf8');

    const { migrated, retained } = withRival(fx, fx.doc, 'doc');

    if (migrated.length === 0) {
      assert.equal(retained.length, 1, `the refusal must be reported: ${retained.join(', ')}`);
      assert.match(retained.join(','), /^architecture\.md:(changed|blank|not-carried)$/);
      assert.equal(fs.existsSync(fx.doc), true, 'and the document is still on disk');
      return;
    }
    // It was removed, so the plan must carry the bytes that were on disk. The
    // rival is stopped, so this is the last content it wrote before the unlink.
    assert.deepEqual(migrated, ['architecture.md']);
    const plan = fs.readFileSync(fx.plan, 'utf8');
    assert.ok(plan.includes('the version the migration will read'),
      'a removal is only allowed for bytes the plan carries');
  });
});

test('window: a second process rewriting the PLAN does not get the document destroyed', () => {
  // The other half, and the reason the delete key is re-read FROM DISK rather than
  // reused from the text just written: a concurrent plan rewrite (another hook
  // process, an editor, a formatter) drops the block between the write and the
  // unlink, and then the plan does not carry the bytes.
  //
  // A REAL SECOND PROCESS, but fired ONCE at a chosen instant rather than looped:
  // a rival hammering in a loop also lands in the residual gap between the guard's
  // read and `rmSync`, where nothing can save the document (see the header), so a
  // looping fixture measures the gap this row is not about and fails at whatever
  // rate the scheduler picks. Here the rival runs between the plan write and the
  // guard's read, which is the wide window the guard exists for.
  withFixture((fx) => {
    fs.writeFileSync(fx.doc, '# Ours\n\nbytes that must not vanish\n', 'utf8');
    const realOpen = mutableFs.openSync;
    let fired = false;
    // The plan is opened three times — the pre-fold read, the write, the guard's
    // read-back — and only the last one has the block on disk. Reading it is how
    // this fixture tells them apart, and the read has to swallow its own ENOENT:
    // an exception here surfaces as the MIGRATION's IO failure, which is a
    // different row than the one being measured.
    const carriesBlock = (file: string): boolean => {
      try {
        return fs.readFileSync(file, 'utf8').includes('traffic-one:migrated');
      } catch {
        return false;
      }
    };
    mutableFs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      if (!fired && String(args[0]).endsWith('plan.md') && carriesBlock(String(args[0]))) {
        fired = true;
        const rival = spawnSync(process.execPath, ['-e',
          `require('fs').writeFileSync(${JSON.stringify(fx.plan)}, '# Traffic One Plan\\n\\n## Goal\\nthe rival rewrote this\\n', 'utf8')`,
        ], { encoding: 'utf8' });
        assert.equal(rival.status, 0, 'the rival process must actually run');
      }
      return realOpen(...args);
    }) as typeof fs.openSync;

    let result;
    try {
      result = migrateArchitectureDocsToPlan(fx.dir);
    } finally {
      mutableFs.openSync = realOpen;
    }

    assert.equal(fired, true, 'the fixture must actually have rewritten the plan inside the window');
    assert.equal(fs.readFileSync(fx.plan, 'utf8').includes('bytes that must not vanish'), false,
      'the rival did clobber the block, so the plan is NOT a witness any more');
    assert.deepEqual(result?.migrated, [], 'and nothing was removed on the strength of a plan that no longer carries it');
    assert.deepEqual((result?.retained ?? []).map((doc) => `${doc.relPath}:${doc.reason}`), ['architecture.md:not-carried']);
    assert.equal(fs.existsSync(fx.doc), true, 'the document is still on disk with its bytes');
  });
});

test('window: a plan rewritten BETWEEN two unlinks stops the second one', () => {
  // Why the plan witness is re-read per document rather than once before the loop.
  // The loop is 3.7 s long for 400 documents, so one read licensed 399 unlinks on
  // evidence that could already be stale — and a plan rewrite is not exotic:
  // another hook process, an editor, a formatter.
  //
  // The rival here keeps the FIRST document's block and drops the second's, so no
  // bytes are lost by the fixture itself and the row measures exactly one thing:
  // whether the second unlink still believes a read taken before the first.
  withFixture((fx) => {
    const second = path.join(fx.dir, 'packages', 'ui', 'architecture.md');
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fs.writeFileSync(fx.doc, '# Root\n\nroot bytes\n', 'utf8');
    fs.writeFileSync(second, '# UI\n\nui bytes that must not vanish\n', 'utf8');

    const realRm = mutableFs.rmSync;
    let fired = false;
    mutableFs.rmSync = ((...args: Parameters<typeof fs.rmSync>) => {
      const out = realRm(...args);
      if (!fired && String(args[0]).endsWith(`architecture.md`) && !String(args[0]).includes('packages')) {
        fired = true;
        const kept = fs.readFileSync(fx.plan, 'utf8').split('### packages/ui/architecture.md')[0];
        const rival = spawnSync(process.execPath, ['-e',
          `require('fs').writeFileSync(${JSON.stringify(fx.plan)}, ${JSON.stringify(kept)}, 'utf8')`,
        ], { encoding: 'utf8' });
        assert.equal(rival.status, 0, 'the rival process must actually run');
      }
      return out;
    }) as typeof fs.rmSync;

    let result;
    try {
      result = migrateArchitectureDocsToPlan(fx.dir);
    } finally {
      mutableFs.rmSync = realRm;
    }

    assert.equal(fired, true, 'the fixture must actually have rewritten the plan between the two unlinks');
    assert.deepEqual(result?.migrated, ['architecture.md'], 'the first document was licensed and is gone');
    assert.deepEqual((result?.retained ?? []).map((doc) => `${doc.relPath}:${doc.reason}`),
      ['packages/ui/architecture.md:not-carried']);
    assert.equal(fs.existsSync(second), true, 'the second document survives with its bytes');
    const plan = fs.readFileSync(fx.plan, 'utf8');
    assert.ok(plan.includes('root bytes'), 'and the first document\'s bytes are still carried');
    assert.equal(plan.includes('ui bytes that must not vanish'), false, 'while the plan is no longer a witness for the second');
  });
});

test('window: a candidate REWRITTEN with different bytes inside the window is not destroyed', () => {
  // THE GUARD'S OWN REASON FOR EXISTING, and until this row nothing pinned it.
  // `stillTheFileWeRead` is an `lstat` AND a content comparison, and the only
  // fixture that entered it was the directory swap below — which the `lstat`
  // answers on its own. So the suite pinned "not a regular file" and never pinned
  // "different bytes": dropping the RE-READ survived the whole 72-test suite,
  // measured, with the newer bytes destroyed. The doc-rival row above cannot pin
  // it either, by design — it accepts `changed|blank|not-carried` or `migrated`,
  // because which one happens is the scheduler's choice.
  //
  // Same anchor as the directory swap: the plan write's `mkdirSync` of
  // `.traffic-one/`, by which point every document has been read and no unlink has
  // started. That is the WIDE window, the one the guard is supposed to close.
  withFixture((fx) => {
    const read = '# Ours\n\nthe version the migration reads\n';
    const newer = '# Ours\n\nA SECOND VERSION, written while the migration was in flight\n';
    fs.writeFileSync(fx.doc, read, 'utf8');
    const realMkdir = mutableFs.mkdirSync;
    let swapped = false;
    mutableFs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
      const out = realMkdir(...args);
      if (!swapped && String(args[0]).endsWith('.traffic-one')) {
        swapped = true;
        fs.writeFileSync(fx.doc, newer, 'utf8');
      }
      return out;
    }) as typeof fs.mkdirSync;

    let result;
    try {
      result = migrateArchitectureDocsToPlan(fx.dir);
    } finally {
      mutableFs.mkdirSync = realMkdir;
    }

    assert.equal(swapped, true, 'the fixture must actually have rewritten the document inside the window');
    assert.deepEqual(result?.migrated, [], 'nothing is removed on the strength of bytes that are no longer there');
    assert.deepEqual((result?.retained ?? []).map((doc) => `${doc.relPath}:${doc.reason}`), ['architecture.md:changed']);
    assert.equal(fs.readFileSync(fx.doc, 'utf8'), newer, 'and the NEWER bytes are still on disk');
    const plan = fs.readFileSync(fx.plan, 'utf8');
    assert.ok(plan.includes('the version the migration reads'), 'the plan carries the version it did read');
    assert.equal(plan.includes('A SECOND VERSION'), false, 'and never carried the one it did not');
  });
});

test('window: a candidate whose DIRECTORY is re-pointed out of the project inside the window is not unlinked', () => {
  // THE CONTAINMENT HALF OF THE PRE-UNLINK GUARD, and it is a third check beside
  // the `lstat` and the content comparison rather than a restatement of either.
  // `removePath` is `rmSync`, which resolves every intermediate component AT
  // UNLINK TIME, so `packages` swapped for a symlink after the read sends the
  // delete out of the project along a path the candidate loop already vetted.
  //
  // THE OUTSIDE FILE CARRIES IDENTICAL BYTES, deliberately, and that is what
  // makes this row pin containment and nothing else: `lstat` says regular file
  // and the content comparison says the same bytes, so those two pass and only
  // "does this path still resolve where we read it" can refuse. With the
  // containment check removed the outside document is DELETED.
  const body = '# UI\n\nui bytes that belong to somebody else\n';
  withFixture((fx) => {
    const packagesRoot = path.join(fx.dir, 'packages');
    const ours = path.join(packagesRoot, 'ui', 'architecture.md');
    fs.mkdirSync(path.dirname(ours), { recursive: true });
    fs.writeFileSync(ours, body, 'utf8');
    const outside = path.join(fx.dir, '..', `outside-${path.basename(fx.dir)}`);
    const victim = path.join(outside, 'ui', 'architecture.md');
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, body, 'utf8');

    const realMkdir = mutableFs.mkdirSync;
    let swapped = false;
    mutableFs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
      const out = realMkdir(...args);
      if (!swapped && String(args[0]).endsWith('.traffic-one')) {
        swapped = true;
        fs.rmSync(packagesRoot, { recursive: true, force: true });
        fs.symlinkSync(fs.realpathSync(outside), packagesRoot);
      }
      return out;
    }) as typeof fs.mkdirSync;

    let result;
    try {
      result = migrateArchitectureDocsToPlan(fx.dir);
      assert.equal(swapped, true, 'the fixture must actually have re-pointed the directory inside the window');
      assert.deepEqual(result?.migrated, [], 'nothing is unlinked through a path that no longer lands in this project');
      assert.deepEqual((result?.retained ?? []).map((doc) => `${doc.relPath}:${doc.reason}`),
        ['packages/ui/architecture.md:changed']);
      assert.equal(fs.existsSync(victim), true, 'and the outside document is still there');
      assert.equal(fs.readFileSync(victim, 'utf8'), body);
    } finally {
      // The outside tree is a SIBLING of the fixture, so `withFixture`'s own
      // cleanup does not reach it — and it has to be removed after the assertions
      // rather than in the same breath as restoring the spy, which is how the
      // first draft of this row deleted its own victim and then failed on it.
      mutableFs.mkdirSync = realMkdir;
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('window: a candidate that becomes a DIRECTORY inside the window keeps its whole tree', () => {
  // `removePath` is `rmSync(recursive: true, force: true)`, so the directory and
  // everything under it went. Read it as a file, delete it as one: `lstat` says
  // regular file immediately before the unlink or nothing is removed. Deterministic
  // rather than raced — the swap is performed at the one instant the window exists.
  withFixture((fx) => {
    fs.writeFileSync(fx.doc, '# Ours\n\nthe file the migration reads\n', 'utf8');
    const realMkdir = mutableFs.mkdirSync;
    let swapped = false;
    // Anchored on the plan write's own `mkdirSync` of `.traffic-one/`: every
    // document has been read by then and the unlink loop has not started, which is
    // the wide window — the one the guard is supposed to close. The narrow gap
    // between the guard's re-read and `rmSync` is three syscalls wide and is NOT
    // closed; see this file's header.
    mutableFs.mkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
      const out = realMkdir(...args);
      if (!swapped && String(args[0]).endsWith('.traffic-one')) {
        swapped = true;
        fs.rmSync(fx.doc);
        realMkdir(fx.doc);
        fs.writeFileSync(path.join(fx.doc, 'notes.md'), 'a whole tree the migration must not take\n', 'utf8');
      }
      return out;
    }) as typeof fs.mkdirSync;

    let retained: string[];
    try {
      const result = migrateArchitectureDocsToPlan(fx.dir);
      retained = (result?.retained ?? []).map((doc) => `${doc.relPath}:${doc.reason}`);
      assert.deepEqual(result?.migrated, []);
    } finally {
      mutableFs.mkdirSync = realMkdir;
    }

    assert.equal(swapped, true, 'the fixture must actually have swapped the file for a directory');
    assert.deepEqual(retained, ['architecture.md:changed']);
    assert.equal(fs.existsSync(path.join(fx.doc, 'notes.md')), true, 'the tree is intact');
  });
});
