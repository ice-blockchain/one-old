import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import {
  SOURCE_SCAN_DIRECTORY_BUDGET,
  SOURCE_SCAN_ENTRY_BUDGET,
  SOURCE_SCAN_SKIP_DIRS,
  countSourceFiles,
  detectMode,
  scanSourceFiles,
} from '../artifacts';
import { SKIP_DIRS } from '../../../config/reporting';
import { SKIP_10K_TREE_ON_WIN32 } from '../../../test-support/__tests__/git-fixture';

// The walk runs in the hook path against a 150ms budget. Measured unbounded on
// this checkout (macOS/APFS, warm, node 26.5, median of 5): 300,000 source files
// 290ms, 200,000 non-source files 164ms returning 0, and 24,000 EMPTY
// DIRECTORIES 465ms — also returning 0. The last one is why there are two
// budgets: a directory open measured ~45x an entry, so an entry budget alone
// leaves the empty-directory tree unbounded.

function withTree(build: (dir: string) => void, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-srcscan-'));
  try {
    build(dir);
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFiles(dir: string, relDir: string, count: number, ext: string): void {
  fs.mkdirSync(path.join(dir, relDir), { recursive: true });
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(path.join(dir, relDir, `f${i}${ext}`), 'x', 'utf8');
  }
}

test('a wide directory fan-out is bounded by the DIRECTORY budget, not just the entry budget', {
  skip: SKIP_10K_TREE_ON_WIN32,
}, () => {
  withTree((dir) => {
    // Every directory is empty, so entries visited stays far below the entry
    // budget while the readdir calls are the entire cost. This is the shape the
    // first cut of this bound missed.
    for (let i = 0; i < SOURCE_SCAN_DIRECTORY_BUDGET + 200; i += 1) {
      fs.mkdirSync(path.join(dir, `d${i}`));
    }
  }, (dir) => {
    const scan = scanSourceFiles(dir);
    assert.ok(
      scan.entriesVisited < SOURCE_SCAN_ENTRY_BUDGET,
      `the entry budget must NOT be what stops this tree (visited ${scan.entriesVisited}) — otherwise the directory budget is untested and 24,000 empty directories cost 465ms`,
    );
    assert.equal(scan.truncated, true, 'an unbounded directory fan-out must report truncation');
    assert.ok(
      scan.directoriesOpened <= SOURCE_SCAN_DIRECTORY_BUDGET,
      `directories opened (${scan.directoriesOpened}) must never exceed the measured budget of ${SOURCE_SCAN_DIRECTORY_BUDGET}`,
    );
  });
});

test('a wide file fan-out is bounded by the ENTRY budget', {
  skip: SKIP_10K_TREE_ON_WIN32,
}, () => {
  withTree((dir) => {
    writeFiles(dir, 'src', SOURCE_SCAN_ENTRY_BUDGET + 500, '.txt');
  }, (dir) => {
    const scan = scanSourceFiles(dir);
    assert.equal(scan.truncated, true, 'a tree wider than the entry budget must report truncation');
    assert.ok(
      scan.entriesVisited <= SOURCE_SCAN_ENTRY_BUDGET + 1,
      `entries visited (${scan.entriesVisited}) must never exceed the measured budget of ${SOURCE_SCAN_ENTRY_BUDGET}`,
    );
    assert.ok(
      scan.directoriesOpened < SOURCE_SCAN_DIRECTORY_BUDGET,
      'the directory budget must NOT be what stops this tree, or the entry budget is untested',
    );
  });
});

// The point of the bound is that a partial count is DISTINGUISHABLE. A truncated
// count reported as a real one is the inversion the bound would otherwise
// introduce: 19,000 of 300,000 reads exactly like a complete 19,000.
test('a complete scan and a truncated scan are distinguishable', () => {
  withTree((dir) => {
    writeFiles(dir, 'src', 12, '.ts');
  }, (dir) => {
    const complete = scanSourceFiles(dir);
    assert.equal(complete.truncated, false, 'a small tree must report a COMPLETE scan');
    assert.equal(complete.count, 12);

    const forced = scanSourceFiles(dir, { entryBudget: 4 });
    assert.equal(forced.truncated, true, 'a scan stopped by a budget must report truncated:true');
    assert.ok(
      forced.count < complete.count,
      'the premise: a truncated count is a FLOOR and is smaller than the true total',
    );
  });
});

// Not the same thing as truncation, and it must not be conflated with it: the
// caller asked a threshold question and the threshold was reached, so the answer
// is complete even though the arithmetic was abandoned.
test('stopAfter ends the walk with a COMPLETE answer, never a truncated one', () => {
  withTree((dir) => {
    writeFiles(dir, 'src', 400, '.ts');
  }, (dir) => {
    const stopped = scanSourceFiles(dir, { stopAfter: 5 });
    assert.equal(stopped.count, 6, 'stopAfter:5 must resolve the <=5 question and stop at the sixth file');
    assert.equal(
      stopped.truncated,
      false,
      'stopAfter is not a budget — reporting it as truncation would tell callers the answer is partial when it is exact',
    );
    assert.ok(
      stopped.entriesVisited < 400,
      `the early exit must actually save work (visited ${stopped.entriesVisited} of 400+)`,
    );
  });
});

test('detectMode answers identically whether or not the walk stops early', () => {
  withTree((dir) => {
    writeFiles(dir, 'src', 5, '.ts');
  }, (dir) => {
    assert.equal(detectMode(dir), 'new-project', 'five source files is still the greenfield side of the ≤5 rule');
    assert.equal(countSourceFiles(dir), 5);
  });

  withTree((dir) => {
    writeFiles(dir, 'src', 6, '.ts');
  }, (dir) => {
    assert.equal(detectMode(dir), 'existing-codebase', 'the sixth source file must flip the mode — the early exit must not move the boundary');
  });
});

// Measured 0.1ms, not a hang: readdir reports the LINK's type, so
// `Dirent.isDirectory()` is false for a symlink and the walk never descends.
// Pinned because "bound the walk so a symlink loop cannot hang it" is the
// plausible-sounding reason to add a bound, and it was never the real one.
test('a symlink cycle terminates because symlinks are not followed at all', () => {
  withTree((dir) => {
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'f.ts'), 'x', 'utf8');
    fs.symlinkSync(dir, path.join(dir, 'a', 'b', 'back'));
    fs.symlinkSync('..', path.join(dir, 'a', 'up'));
  }, (dir) => {
    const scan = scanSourceFiles(dir);
    assert.equal(scan.count, 1, 'the one real source file is counted exactly once');
    assert.equal(scan.truncated, false, 'a cycle must not consume the budget — it is not followed in the first place');
    assert.ok(scan.directoriesOpened <= 4, `a cycle must not multiply directory opens (opened ${scan.directoriesOpened})`);
  });
});

test('node_modules and .git are skipped at any depth', () => {
  withTree((dir) => {
    writeFiles(dir, 'src', 3, '.ts');
    writeFiles(dir, path.join('packages', 'a', 'node_modules', 'dep'), 40, '.js');
    writeFiles(dir, path.join('.git', 'objects'), 40, '.js');
  }, (dir) => {
    assert.equal(countSourceFiles(dir), 3, 'only the project\'s own sources count');
  });
});

// `node_modules` and `.git` were the ENTIRE exclusion list, so every other
// ecosystem's dependency tree counted as the project's own code. A `.venv` is
// Python's `node_modules`.
test('dependency, build-output and cache directories are not the project\'s own source', () => {
  const planted = ['.venv', 'venv', 'vendor', 'dist', 'build', 'target', '__pycache__', '.next', '.svelte-kit', '.gradle', 'Pods', '.tox'];
  withTree((dir) => {
    writeFiles(dir, 'src', 3, '.ts');
    for (const name of planted) writeFiles(dir, path.join(name, 'inner'), 20, '.py');
    // At depth too: a monorepo package's own `.venv` is no more the project's
    // source than the root's is.
    writeFiles(dir, path.join('packages', 'api', '.venv', 'lib'), 20, '.py');
  }, (dir) => {
    for (const name of planted) {
      assert.ok(SOURCE_SCAN_SKIP_DIRS.has(name), `${name} must be excluded — it is a dependency tree or a build output, not source`);
    }
    assert.equal(
      countSourceFiles(dir),
      3,
      'only the project\'s own sources count; 243 here would mean a `.venv` feeds the new-project bar and the orphaning veto',
    );
  });
});

// Not "a list that happens to agree with SKIP_DIRS" — the same set object,
// minus one documented name. A restated copy drifts the moment either side
// gains an ecosystem, and this repo already carries two such lists.
test('the skip set is DERIVED from the SKIP_DIRS authority, not restated beside it', () => {
  assert.ok(
    SKIP_DIRS.size > 30,
    `non-vacuity: SKIP_DIRS must be the broad authority this derives from (size ${SKIP_DIRS.size})`,
  );
  const missing = [...SKIP_DIRS].filter((name) => (
    !SOURCE_SCAN_SKIP_DIRS.has(name) && name !== 'generated' && name !== '__generated__'
  ));
  assert.deepEqual(missing, [], 'every SKIP_DIRS name except the documented codegen carve-out must be excluded from the count');
  const extra = [...SOURCE_SCAN_SKIP_DIRS].filter((name) => !SKIP_DIRS.has(name));
  assert.deepEqual(extra, [], 'nothing may be excluded that the authority does not name — that is how a third parallel list starts');
});

// The carve-out, and the reason it is a carve-out rather than an oversight.
// SKIP_DIRS pays for over-skipping in verification-diff noise; this count pays
// for it in a relocation that orphans code, so the name that is committed source
// in the project's own language stays visible.
test('committed codegen still counts as the project\'s own source', () => {
  withTree((dir) => {
    writeFiles(dir, 'generated', 30, '.ts');
    writeFiles(dir, '__generated__', 4, '.ts');
  }, (dir) => {
    assert.equal(countSourceFiles(dir), 34, 'generated/ is tracked, in the project\'s language, and not reproducible from anything else in the tree');
    assert.equal(
      detectMode(dir),
      'existing-codebase',
      'excluding it would read this project as greenfield AND tell the orphaning veto there is nothing here — both halves of the relocation check at once',
    );
  });
});

// `capabilityProfileForProject` ANDs `mode === 'new-project'` with
// `!webAppHoldsSource(...)`, so one count decides both. Widening the exclusions
// moves the mode toward `new-project`, which is the uncorrectable direction —
// the veto is the only thing left standing, and it has to hold on the shape that
// caused the misread.
test('a project whose own source sits beside a dependency tree still fires the orphaning veto', () => {
  withTree((dir) => {
    writeFiles(dir, path.join('.venv', 'lib', 'site-packages'), 400, '.py');
    fs.writeFileSync(path.join(dir, 'main.py'), 'x', 'utf8');
  }, (dir) => {
    assert.equal(
      detectMode(dir),
      'new-project',
      'the premise: with the `.venv` discounted this one-file project reads greenfield, and nothing downstream reopens that',
    );
    // What webAppHoldsSource asks, with its own stopAfter.
    const veto = scanSourceFiles(dir, { stopAfter: 0 });
    assert.equal(veto.count > 0 || veto.truncated, true, 'so the veto is the only guard left, and one real file must still trip it');
  });
});

// A truncated count is a floor, and exclusions change what is counted BEFORE the
// budget trips — so they also change WHICH trees truncate. The direction is the
// safe one (less work reached the budget), but it is worth pinning: a tree that
// stops truncating starts answering the veto from its count alone.
test('excluding dependency trees makes truncation LESS likely, never more', () => {
  withTree((dir) => {
    for (let i = 0; i < 60; i += 1) writeFiles(dir, path.join('node_modules', `dep${i}`), 5, '.js');
    for (let i = 0; i < 60; i += 1) writeFiles(dir, path.join('.venv', 'lib', `pkg${i}`), 5, '.py');
    writeFiles(dir, 'src', 2, '.ts');
  }, (dir) => {
    const scan = scanSourceFiles(dir);
    assert.equal(scan.count, 2, 'the premise: both planted trees are excluded');
    assert.equal(scan.truncated, false, 'and neither consumed the budget');
    assert.ok(
      scan.directoriesOpened < 10,
      `an excluded subtree costs one entry, not a walk (opened ${scan.directoriesOpened} directories)`,
    );
  });
});

// Depth-first recursion made truncation depend on readdir order, so a project
// whose own sources sit beside a vendored tree could truncate to 0 and tell
// `webAppHoldsSource` there was no source here to orphan.
test('under truncation the partial count fills from the top of the tree down', () => {
  withTree((dir) => {
    // `vendor/` is a deep chain, so a depth-first walk sinks into it and spends
    // the whole budget before it ever reaches `src/` — which sits at the same
    // depth as `vendor` itself and holds the project's own code. Breadth-first
    // reaches `src` on the second level, before descending anywhere.
    // Non-source files, so only the budget they consume is under test — not
    // whether they are counted.
    // Named to sort BEFORE `src`, so readdir hands the vendored tree over
    // first and the traversal order is what decides the outcome.
    let deep = path.join(dir, 'a_vendor');
    for (let level = 0; level < 40; level += 1) {
      writeFiles(dir, path.relative(dir, deep), 30, '.txt');
      deep = path.join(deep, 'nested');
    }
    writeFiles(dir, 'src', 4, '.ts');
  }, (dir) => {
    const scan = scanSourceFiles(dir, { entryBudget: 40 });
    assert.equal(scan.truncated, true, 'the premise: this scan is budget-stopped');
    assert.equal(
      scan.count,
      4,
      `a truncated scan must still see the project's OWN source rather than sinking into a vendored subtree (counted ${scan.count}) — a 0 here tells the orphaning veto there is nothing to lose`,
    );
  });
});
