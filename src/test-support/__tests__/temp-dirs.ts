// src/test-support/__tests__/temp-dirs.ts
// Temp directories a test file creates, and a teardown assertion that it
// removed every one of them.
//
// WHY THIS EXISTS. The obvious way to write that assertion is to give the file
// a private `mkdtemp` prefix and, on teardown, scan `os.tmpdir()` for anything
// still carrying it:
//
//   const leaked = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(PREFIX));
//   assert.deepEqual(leaked, []);
//
// That reads like an ownership check and is not one. The prefix identifies the
// FILE, not the RUN, and node:test runs test files as concurrent processes —
// so a second run of the same file, or a `--watch` re-run, or one developer
// running the file while CI runs it in a container sharing /tmp, puts
// same-prefix directories in that listing that this process never created and
// must not delete. Each run then reports the other's live fixtures as its own
// leak, and BOTH fail. Measured: four concurrent runs of pipeline.test.ts and
// of deny-expectation.test.ts, each green in isolation, 3 of 4 red together, in
// three consecutive rounds.
//
// A per-run random suffix does not fix it. It narrows the window and leaves the
// same bug: the assertion is still a guess about which directories are ours,
// re-derived from a name, and a name is not provenance. The only thing that
// knows what this run created is this run, at the moment it created it — so
// that is what gets recorded, and the assertion is about THOSE PATHS and
// nothing else. Concurrency then cannot enter into it: two runs track disjoint
// sets and neither can see the other's.
//
// WHAT THIS GIVES UP, and it is a real reduction in coverage rather than a pure
// win. The prefix scan asked "is there anything under this prefix left in the
// temp directory", which catches a leak from a fixture the tracker never saw —
// a bare `fs.mkdtempSync` somewhere else in the file, a helper that makes its
// own scratch tree, or production code under test that creates one and fails to
// remove it. `cleanup()` cannot see any of those, because it asserts about the
// paths it handed out. That was not a property the old form actually held
// (it could not tell such a directory apart from a concurrent run's live
// fixture, which is why it failed), but the intent was real, and a file that
// wants it back for a specific unowned directory should say so directly:
// `withPrivateTmpdir` below is that, and is what src/build/__tests__/
// sync-hosts-install-exercise.test.ts uses to hold code it does not own to the
// same standard.
//
// WHY IT LIVES UNDER __tests__/. Same reason as latency-budget.ts beside it:
// tsconfig.build.json excludes `src/**/__tests__/**` but not
// `src/test-support/**`, so a helper one level up is compiled into the shipped
// hook runtime.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';

export interface TrackedTempDirs {
  /**
   * Create a temp directory, remember it, and return its REAL path.
   *
   * realpath because macOS's `os.tmpdir()` is a symlink (`/var` -> `/private/var`)
   * and code under test that resolves a project root — the override ledger, the
   * run-state readers — keys on the resolved form, so an unresolved fixture path
   * reads a different file than it writes.
   */
  make(): string;
  /**
   * Remove every tracked directory and assert none survived. Call from `after`.
   *
   * Also refuses to pass vacuously: a file whose fixtures stopped being created
   * at all would otherwise satisfy an empty leak check forever. That refusal is
   * suspended under a name filter — see `runIsNameFiltered`.
   */
  cleanup(): void;
}

/**
 * Is this process running a SUBSET of its file's tests?
 *
 * `--test-name-pattern` (and its siblings) reach the per-file child process in
 * `execArgv`, which is the only place they are visible from inside a test. It
 * matters because the vacuity refusal below is a statement about a whole file:
 * "this file creates fixtures, and if it stopped, say so". Under a filter the
 * file deliberately runs a few of its tests, usually none of which touch the
 * filesystem, and `after` still fires — so the refusal turned `--test-name-pattern`,
 * which is how anyone debugs one failing case, into a guaranteed red with a
 * message about vacuity that had nothing to do with what they were looking at.
 */
function runIsNameFiltered(): boolean {
  return [...process.execArgv, ...process.argv.slice(2)].some((arg) => (
    arg.startsWith('--test-name-pattern')
    || arg.startsWith('--test-skip-pattern')
    || arg === '--test-only'
  ));
}

export function trackedTempDirs(prefix: string): TrackedTempDirs {
  const created: string[] = [];
  return {
    make(): string {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
      created.push(dir);
      return dir;
    },
    cleanup(): void {
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
      // `force` swallows ENOENT but not EBUSY, EPERM or a non-empty directory
      // whose removal raced something still writing into it, which is the leak
      // shape worth catching: a fixture the suite is still holding open.
      const survived = created.filter((dir) => fs.existsSync(dir));
      assert.deepEqual(survived, [], `this run failed to remove temp dirs it created: ${survived.join(', ')}`);
      if (created.length === 0 && !runIsNameFiltered()) {
        assert.fail(`no temp dirs were ever created under ${prefix} — the leak check is vacuous`);
      }
    },
  };
}

/**
 * Run `body` with `os.tmpdir()` pointed at a directory nothing else can be
 * using, then assert that directory is empty.
 *
 * This is the ownership check for scratch trees THIS process did not create:
 * code under test that calls `fs.mkdtempSync(os.tmpdir(), …)` itself and is
 * supposed to clean up after itself. A before/after diff of the real temp
 * directory is the shape that reaches for, and it is racy in exactly the way
 * the prefix scan above is — a concurrent run of the same file creates a
 * matching directory between the two listings and is reported as this run's
 * leak. Redirecting `TMPDIR` removes the race instead of narrowing it: every
 * entry in the private directory afterwards was put there by `body`.
 *
 * THREE LIMITS, all narrower than the paragraph above sounds.
 *
 * 1. IN-PROCESS ONLY. "Sees a stray under any name" holds for code running in
 *    THIS process. `os.tmpdir()` re-reads `process.env.TMPDIR` on every call, so
 *    a redirect reaches any in-process caller — but a CHILD process only inherits
 *    it if its environment is inherited, and a spawn that pins `env: {…}` is
 *    outside this check entirely. That is not hypothetical: the one caller,
 *    src/build/__tests__/sync-hosts-install-exercise.test.ts, exercises an
 *    installer through spawned host CLIs. What this asserts there is that the
 *    in-process half left nothing behind, and a stray written by a child under
 *    its own pinned TMPDIR is invisible to it.
 * 2. SYNCHRONOUS BODIES ONLY, and that is enforced below rather than documented.
 *    The signature is generic in `T`, so an `async` body type-checks and returns
 *    a pending promise — at which point the emptiness assertion runs against a
 *    directory nothing has written to yet, and `TMPDIR` is restored while the
 *    body is still using it. Both halves of the check silently become
 *    assertions about nothing.
 * 3. POSIX ONLY. `os.tmpdir()` reads `TMPDIR` on POSIX and `TEMP`/`TMP` on
 *    Windows, so on Windows the redirect does not take and the private directory
 *    stays empty — which this function would then report as a pass. The
 *    assertion below refuses that rather than certifying it. This repo's CI is
 *    ubuntu-latest and macOS; a Windows runner would need the other two names
 *    set, and would need them checked, not assumed.
 *
 * `TMPDIR` is process-global, so this must not be used from tests that run
 * concurrently inside one process. node:test runs the tests of a file
 * sequentially, which is the only place this is used.
 */
export function withPrivateTmpdir<T>(dirs: TrackedTempDirs, body: () => T): T {
  const home = dirs.make();
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = home;
  try {
    // Limit 3, checked at the one moment it is checkable. A redirect that did
    // not take makes every assertion below vacuous.
    assert.equal(
      os.tmpdir(),
      home,
      `redirecting TMPDIR did not move os.tmpdir() (it reads TEMP/TMP on Windows), so this check would pass`
      + ' by looking at a directory nothing was ever going to be written to',
    );
    const result = body();
    // Limit 2, refused rather than documented. Restoring the environment and
    // reading the directory both happen HERE, and an async body has done
    // neither of the things they are about.
    assert.equal(
      typeof (result as { then?: unknown } | null | undefined)?.then,
      'undefined',
      'withPrivateTmpdir got a thenable back, so its body is asynchronous. The emptiness assertion and the'
      + ' TMPDIR restore below both run before that body has finished, which makes this check an assertion'
      + ' about an empty directory and leaves the body running against a restored TMPDIR. Use a synchronous'
      + ' body, or add an async twin that awaits before it asserts.',
    );
    assert.deepEqual(fs.readdirSync(home), [], `left a scratch tree behind in ${home}`);
    return result;
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}
