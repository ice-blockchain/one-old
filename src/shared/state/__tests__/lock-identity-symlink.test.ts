// `heldLockIds` identifies a lock directory by `<dev>:<ino>` so that a nested
// acquisition under a second SPELLING of one project root re-enters instead of
// waiting for itself. Nothing in the lock suite observed how that identity is
// TAKEN, in either direction: switching `lockIdentity` from `statSync` to
// `lstatSync` — the difference between "the object at this path" and "whatever
// this path leads to" — survived all 53 tests. This file is that pin, and it has
// to have two halves, because either one alone is satisfiable by a wrong fix.
//
//   THE ATTACK. A symlink planted at project B's lock path naming project A's
//   lock directory. Under a FOLLOWING stat, a process holding A reads B's lock
//   path as A's inode, matches `heldLockIds`, and runs B's transaction
//   re-entrantly with nothing whatsoever held for B — in 1 ms, silently, leaving
//   B's lock path as the attacker's link because no rename of ours ever landed.
//   That is the same bypass the pid+token key was retired for, in the same shape,
//   reopened by the key that closed it. Planting it needs write access to the
//   other project, which is the access the whole lock defends against, and the
//   precondition is two nested project locks — a supported, working shape
//   (`withProjectStateLock` nests, and the reset transaction and one-mcp report
//   both take a second project's lock inside the first).
//
//   THE LEGITIMATE CONTROL. `lstat` refuses to follow only the FINAL component,
//   and two spellings of one project reach ONE lock directory through a
//   symlinked ANCESTOR — the final component is a real directory either way. So
//   the fix must leave the re-entry it exists for untouched. A "fix" that
//   refused every collision, or compared resolved path strings instead of
//   inodes, passes the attack row and fails this one.
//
// The premise the old docblock dismissed the attack on is pinned here too, as a
// fixture: it claimed `rename` onto a symlink replaces it and succeeds, so a
// planted link could never reach the collision branch. It does not succeed.
//
// The WEDGE row is the other half of the same defect: a planted link makes
// `rename(dir, symlink)` fail forever and neither reaper could clear one
// (`reapObservedLock` needs a readable owner file, the abandoned-lock reaper
// used to need an EMPTY directory), so every acquisition of that project spun
// the full timeout and threw out of a hook. A denial of service on the recovery
// path a wedged project is the one that needs.
//
// THE WEDGE IS A CLASS, NOT A SPELLING, and the first fix closed one member of
// it. Measured against the same acquisition, each of these produced the
// identical permanent refusal a symlink did — one byte in the cheapest case:
// a `touch`ed regular file, a hard link to one, a FIFO, a non-empty directory
// with no owner file, and a directory holding an unparseable owner file. Two
// sub-classes, closed two different ways, and the split is the protocol's own:
//
//   NOT A DIRECTORY  — never anything this handshake produced, because every
//     acquisition renames a DIRECTORY into place. Cleared unconditionally, with
//     no age or liveness test, because there is no holder it could belong to.
//   A DIRECTORY the owner reader refuses — could be a lock, so what protects a
//     holder is the only evidence that can: a legible pid still running keeps it,
//     and the removal is a COMPARE-AND-SWAP, so a holder that arrives while the
//     reap is deciding keeps its lock whatever the reaper concluded.
//
// THE REMOVAL IS THE PART THAT WAS WRONG, and this file is where it is pinned.
// The widened reaper removed the lock by PATH (`rmSync(lockPath, {recursive})`),
// not by the evidence it had just read, so two ordinary contenders that both
// judged one abandoned lock reclaimable deleted each other's leases: the loser's
// remove landed after the winner's rename and took the winner's directory AND
// its owner file, and then acquired. MEASURED BY THIS LANE, unaided, real
// processes, no interception, against a variant carrying that remove back: 2 000
// contended acquisitions over 250 barriered rounds gave 72 all-pairs overlapping
// hold intervals and 82 holders whose own lock directory changed inode and lost
// its own owner file mid-critical-section; 0 and 0 with the compare-and-swap,
// over 8 000 contended acquisitions in four runs of the same fixture. MISSES are
// a property of that fixture rather than of the lock — its critical section is
// ~12 ms, and the same probe with a heavy one missed 1 303 of 2 000 with the
// overlap and steal counts still 0. The suite was indifferent to HOW the
// removal happened — replacing the observed-owner arm's exact unlink with a
// recursive remove was invisible, and so was the reverse — so both arms are now
// driven through the window between the evidence read and the remove, with
// nothing injected that a competing acquirer does not do itself.
//
// AND THE AGE IS GONE FROM THAT ARM, which is the compare-and-swap's dividend.
// It read the directory's own mtime as a substitute stamp, and an mtime is
// re-armed by ANY modification: the product manufactured exactly that state
// (`reapObservedLock` unlinks the sentinel, then `rmdir`s, so a stray landing
// between the two leaves no owner evidence and a fresh mtime) and every
// acquisition on that project then threw out of a hook for a full stale window.
// What the age was protecting — a LIVE holder whose sentinel was clobbered — is
// not reachable through this protocol, because the owner file is written into the
// staging dir BEFORE the atomic rename, so a lock at the lock path is complete
// from the instant it exists.
//
// IT IS NOW GONE FROM THE OTHER ARM TOO, and that one had it on the shape with
// MORE evidence: a legible owner whose pid answers ESRCH is proof of death, and
// it waited a stale window while a directory with no legible owner at all was
// reclaimed at once. Liveness is the guard on both arms and the compare-and-swap
// is what protects a lease that arrives mid-decision; the age only ever delayed a
// reclaim, and the delay was charged to an honest recent crash.
//
// THE LAST AXIS IS THE SHAPE OF THE OWNER ENTRY ITSELF, and it was the only one
// where a hook could HANG rather than fail. Both readers reached the owner path
// with `fs.readFileSync`, which waits for ever on a FIFO and reads for ever from
// a character device, and the loop's deadline is tested only between iterations —
// so a single `mkfifo` inside a lock directory made every acquisition of that
// project unbounded, measured at 25 s and 60 s with no return. The reader now
// opens with O_NONBLOCK|O_NOFOLLOW and asks `fstat` whether the DESCRIPTOR is a
// regular file, so the class is decided positively rather than by enumerating
// blocking spellings, and two verdicts change with it: a dangling symlink stops
// being scored as absence, and a symlink to a live holder's owner file stops
// borrowing that holder's liveness for a lock it does not hold.
//
// The row that matters most needs no attacker at all: an abandoned lock whose
// owner is dead is reclaimed correctly until a `.DS_Store` lands beside the
// owner file, and then it is refused forever, because the reader wants a
// listing of exactly one parseable owner file and the reaper wanted emptiness.
// A Finder window writes that file; so does a crashed sibling leaving a second
// owner. This is the lock every session start takes.
//
// The LAST wedge in the same family is on the permissions axis rather than the
// clock axis, and the rows for it are here because the argument that first put
// them here was wrong. This port created its lock dirs 0700 and its owner files
// 0600, and the case against that was "a SECOND UID can create the lock directory
// inside a 0755 `.traffic-one/` and then locks everyone else out". It cannot:
// creating an entry inside a directory needs write permission ON it. What is
// really at stake is the WRITE bit and one deployment shape — a `.traffic-one/`
// the machine deliberately shares between uids — where the default mode inherits
// that sharing and a hard 0700 cannot. Three rows below carry it: the modes the
// product creates (as an equality with the umask), what a lock this process may
// not write in does, and what an UNREADABLE one does.
//
// THE BLOCKING-SHAPE ROWS RUN IN CHILD PROCESSES, and that is a repair to this
// suite rather than to the product. A reviewer applied a mutant that dropped
// `O_NONBLOCK` from the owner read, and this file — together with
// shared/__tests__/one-settings-blocking-shapes.test.ts — sat in `open(2)` on its
// own FIFO fixture for over TEN MINUTES under `--test-timeout=30000` without
// emitting a row; both runs were killed by hand, twice in one session, after
// multi-hour hangs. Node's test timeout is a timer on the event loop, and the
// blocked synchronous read is HOLDING that loop, so the timer never fires. A
// regression in the bound therefore did not fail this suite, it WEDGED it, which
// costs a CI job its whole wall clock and reports nothing.
//
// So the acquisition in the blocking-shape table is driven through
// `spawnSync({ timeout })` and `run.signal` is asserted null — a deadline has to
// be enforced from OUTSIDE the process that might hang, which is now measured in
// three languages. The FIXTURES stay here, because planting a FIFO never blocks;
// only reading one does. Every row of that table goes to a child, including the
// shapes that cannot block, because whether a shape blocks is a property of the
// CODE and the next regression is free to pick a different one. Same discipline
// as shared/__tests__/fsjson-bounded-read.test.ts, which had it from the start.
//
// THE SLEEP is the last axis, and it is counted rather than timed. Its mutant —
// `progressed` corrupted after both reap arms, so every reap still works, the
// guard is still spelled `if (!progressed) sleepSync(` and the call site is still
// unique — passes every structural check and hot-spins a hook for the full
// deadline. `sleepSync` reaches the kernel through `Atomics.wait`, a writable
// global, so the sleeps are COUNTABLE, and a count is not a rate: asserting that
// code does not sleep is asserting a lower bound on its speed, and load only ever
// removes speed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ONE_MCP_REPORT_ID_LOCK_RETRY_MS,
  ONE_MCP_REPORT_ID_LOCK_STALE_MS,
  ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS,
} from '../../../config/reporting';
import { withProjectStateLock } from '../project-state-lock';

// The same module object the lock body calls through, so a swap here is visible
// to it. Two rows below need to act INSIDE the window between an observation and
// the syscall that acts on it, and that window is not reachable from outside.
const mutableFs = createRequire(__filename)('fs') as {
  unlinkSync: typeof fs.unlinkSync;
  renameSync: typeof fs.renameSync;
  readdirSync: typeof fs.readdirSync;
};

// Above any pid this kernel issues, so `kill(pid, 0)` raises ESRCH without
// signalling anything. Asserted where it is planted (`abandonedLock` below).
const DEAD_PID_FOR_CAS = 4_194_303;

// DECLARED, not inherited. `acquireProjectStateLock` calls `ensureDir` on the
// state dir, which the consent fence refuses while the use-plugin question is
// unanswered — and it then returns null and runs the body with NO LOCK, which is
// the exact state every assertion below is trying to tell apart from a bypass.
// The suite-wide preload happens to pin this to '0'; a file whose fixtures are
// void without it says so itself.
process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

// THE DEADLINE ITSELF, not a fraction of it, and the change is a measurement
// rather than a taste. This was `TIMEOUT / 2` on the reading that "the fast paths
// here are 1-10 ms" — true idle, and false by an order of magnitude under load:
// a first-iteration reclaim measured 400-628 ms at load 61-102 on this host, and
// the aged nested-directory row failed this bound at load 102 while doing exactly
// what it asserts. A ceiling inside the noise floor is a speed assertion on the
// runner, which is the one class this file counts disarms for.
//
// The property every use of this actually claims is "it did not spin to the
// deadline", and that boundary is EXACT rather than statistical: the loop throws
// only once `Date.now() >= deadline`, so a paid deadline cannot come in under
// ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS however fast the machine is, and a
// first-iteration success cannot reach it unless the whole iteration takes a
// second. The sharper claim — "on the FIRST iteration" — is not available in wall
// clock on a loaded host at all, and it is not what these rows rest on: every
// mutant they exist for (an age gate restored to an arm, a reclaim that refuses a
// shape) flips ACQUIRED to REFUSED, which the assertion above each of these
// reads.
const FAST_MS = ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS;

/**
 * The token a CI step greps out of the suite log to learn how often the clock
 * row's gated half stood itself down.
 *
 * SPELLED ONCE, here, and pinned from outside: `lock-disarm-ci.test.ts` requires
 * this exact literal to appear in this file AND to be named by the workflow step
 * that reports it, so neither half can be renamed away from the other. A count
 * printed into a log nothing reads is the same self-mute as no count at all — the
 * repo already found and fixed that shape once, for the latency budgets.
 */
const CLOCK_DISARM_MARKER = 'T1 LOCK CLOCK DISARM';

interface Fixture {
  readonly root: string;
  /** A project directory and the lock path derived from it. */
  project: (name: string) => { readonly cwd: string; readonly lockPath: string };
  readonly cleanup: () => void;
}

function fixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-lock-ident-')));
  return {
    root,
    project: (name: string) => {
      const cwd = path.join(root, name);
      fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
      return { cwd, lockPath: path.join(cwd, '.traffic-one', '.one.json.report-id.lock') };
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function inode(target: string): string {
  const stat = fs.lstatSync(target, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

function ownerFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.startsWith('owner-'));
}

const PROJECT_STATE_LOCK_MODULE = path.join(__dirname, '..', 'project-state-lock.ts');

/** Generous: it has to cover `tsx` startup plus a whole paid lock deadline, and
 *  its only job is to be shorter than a hang. */
const CHILD_TIMEOUT_MS = 30_000;

interface ChildAcquisition {
  readonly acquired: boolean;
  readonly message: string;
  readonly ms: number;
}

/**
 * One acquisition against an already-planted fixture, in a process that is
 * allowed to die.
 *
 * `run.signal` is the whole point: see this file's header — a userland deadline
 * cannot interrupt a blocking synchronous read, so a child under a hard kill is
 * the only thing that turns a bound regression into a red row instead of a wedged
 * suite. The child inherits this process's environment, so the preload's plugin
 * root and the `TRAFFIC_ONE_ASK_USE_PLUGIN` value declared above travel with it,
 * and it reports the same three facts the in-process rows collect.
 */
function acquireInChild(cwd: string, label: string): ChildAcquisition {
  const driver = path.join(cwd, 'drive-acquire.cjs');
  fs.writeFileSync(driver, [
    'const mod = require(process.argv[2]);',
    'const cwd = process.argv[3];',
    'let acquired = false;',
    "let message = '';",
    'const started = Date.now();',
    'try { mod.withProjectStateLock(cwd, () => { acquired = true; }); }',
    'catch (error) { message = String(error && error.message); }',
    'process.stdout.write(JSON.stringify({ acquired, message, ms: Date.now() - started }));',
  ].join('\n'), 'utf8');

  // SIGKILL rather than spawnSync's default SIGTERM: a signal the child may
  // decline does not enforce a deadline at all. DRIVEN: with the default,
  // spawnSync's own 3 000 ms timeout expired and spawnSync never returned — the
  // parent waits in `waitpid` while the child stays blocked in `open(2)` —
  // against 3 004 ms and a reaped child with `killSignal: 'SIGKILL'`.
  const run = spawnSync(process.execPath, ['--import', 'tsx', driver, PROJECT_STATE_LOCK_MODULE, cwd], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  assert.equal(run.signal, null,
    `[${label}] the acquisition must RETURN rather than block in open(2) — killed by signal means the read is `
    + 'unbounded again. This is the row that has to RED rather than wedge the run: node\'s own test timeout is a '
    + `timer on the event loop a blocked read holds, so it never fires. stderr: ${run.stderr || ''}`);
  assert.equal(run.status, 0, `[${label}] driver failed: ${run.stderr || ''}`);
  return JSON.parse(run.stdout) as ChildAcquisition;
}

test('FIXTURE rename onto a symlink FAILS — the premise the attack was dismissed on', () => {
  const fx = fixture();
  try {
    const staged = path.join(fx.root, 'staged');
    const real = path.join(fx.root, 'real');
    fs.mkdirSync(staged);
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(staged, 'owner-x.json'), '{}', 'utf8');

    for (const [label, target] of [['a directory', real], ['nothing (dangling)', path.join(fx.root, 'absent')]] as const) {
      const link = path.join(fx.root, `link-${label.replace(/\W+/g, '-')}`);
      fs.symlinkSync(target, link);
      const code = ((): string | null => {
        try {
          fs.renameSync(staged, link);
          return null;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code ?? 'unknown';
        }
      })();
      assert.equal(
        code, 'ENOTDIR',
        `rename of a directory onto a symlink naming ${label} must FAIL. The retired claim was that it `
        + 'replaces the link and succeeds, so a planted link could never collide and never reach the '
        + `self-contention branch. Got ${code === null ? 'success' : code}.`,
      );
      assert.equal(fs.existsSync(staged), true, 'and the staged directory is still there, so the loop retries');
      fs.unlinkSync(link);
    }
  } finally {
    fx.cleanup();
  }
});

test('a symlink planted at another project\'s lock path cannot borrow this process\'s hold', () => {
  const fx = fixture();
  try {
    const a = fx.project('project-a');
    const b = fx.project('project-b');
    // Planted BEFORE anything is held, which is all the attacker can do: write
    // one link into a project it can write to.
    fs.symlinkSync(a.lockPath, b.lockPath);

    const observed = withProjectStateLock(a.cwd, () => {
      const heldA = inode(a.lockPath);
      const startedAt = Date.now();
      const inner = withProjectStateLock(b.cwd, () => ({
        elapsedMs: Date.now() - startedAt,
        // What is at B's lock path WHILE B's transaction runs. Under a following
        // stat this is still the attacker's link and nothing is held for B.
        stat: fs.lstatSync(b.lockPath),
        id: inode(b.lockPath),
        owners: ownerFiles(b.lockPath),
      }));
      return { heldA, inner };
    });

    assert.equal(
      observed.inner.stat.isSymbolicLink(), false,
      'B\'s transaction ran while B\'s lock path was STILL the attacker\'s symlink, so no rename of ours '
      + 'ever landed and nothing at all was held for B. That is the bypass: an identity read THROUGH '
      + 'attacker-controlled bytes matched a lock this process holds for a DIFFERENT project.',
    );
    assert.equal(
      observed.inner.stat.isDirectory(), true,
      'B must hold a real lock directory of its own — the planted link is cleared and the handshake\'s '
      + 'rename lands, which is the only outcome that both refuses the bypass and leaves the project usable',
    );
    assert.notEqual(
      observed.inner.id, observed.heldA,
      'and it must be a DIFFERENT directory from the one held for project A. Equal inodes here means the '
      + 'link was followed after all: one lock serving two projects is no lock for the second.',
    );
    assert.equal(
      observed.inner.owners.length, 1,
      `B's lock must carry exactly its own acquirer's owner file, got ${JSON.stringify(observed.inner.owners)}`,
    );
    assert.ok(
      observed.inner.elapsedMs < FAST_MS,
      `refusing the bypass must not cost the full ${ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS}ms deadline: the `
      + `planted link is removable, so B acquires normally. Took ${observed.inner.elapsedMs}ms.`,
    );
    assert.equal(fs.existsSync(b.lockPath), false, 'and B\'s lock is released on the way out');
    assert.equal(fs.existsSync(a.lockPath), false, 'as is A\'s');
    assert.deepEqual(
      fs.readdirSync(path.join(b.cwd, '.traffic-one')), [],
      'no staging directory may be left behind either',
    );
  } finally {
    fx.cleanup();
  }
});

test('two spellings of ONE project still re-enter — the legitimate case the identity key exists for', () => {
  const fx = fixture();
  try {
    const a = fx.project('project-a');
    // A second spelling of the SAME project root: a symlinked ANCESTOR, which is
    // what /var vs /private/var and a linked checkout both are. The lock path's
    // final component is the same real directory under either spelling, so
    // `lstat` sees a directory here and NOT a link — that is the whole reason
    // refusing to follow the final component costs this case nothing.
    const spelling = path.join(fx.root, 'project-a-link');
    fs.symlinkSync(a.cwd, spelling);

    const observed = withProjectStateLock(a.cwd, () => {
      const outerId = inode(a.lockPath);
      const outerOwners = ownerFiles(a.lockPath);
      const startedAt = Date.now();
      const inner = withProjectStateLock(spelling, () => ({
        elapsedMs: Date.now() - startedAt,
        id: inode(path.join(spelling, '.traffic-one', '.one.json.report-id.lock')),
        owners: ownerFiles(a.lockPath),
      }));
      return { outerId, outerOwners, inner };
    });

    assert.equal(
      observed.inner.id, observed.outerId,
      'FIXTURE the two spellings must name ONE inode, or this case is not the one being characterized',
    );
    assert.deepEqual(
      observed.inner.owners, observed.outerOwners,
      'the nested acquisition must RE-ENTER the outer hold: a second owner file means it took a second '
      + 'lease it will also release, and no owner file at all means it is running unserialized',
    );
    assert.ok(
      observed.inner.elapsedMs < FAST_MS,
      'waiting here is waiting for ourselves — the outer frame cannot release until this call returns — so '
      + `the loop would spend its whole ${ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS}ms deadline and throw out of a `
      + `hook. Took ${observed.inner.elapsedMs}ms.`,
    );
  } finally {
    fx.cleanup();
  }
});

test('a planted symlink does not wedge the lock permanently', () => {
  const fx = fixture();
  try {
    const a = fx.project('project-a');
    const elsewhere = path.join(fx.root, 'elsewhere');
    fs.mkdirSync(elsewhere);

    for (const [label, target] of [
      ['a directory', elsewhere],
      ['nothing (dangling)', path.join(fx.root, 'absent')],
    ] as const) {
      fs.symlinkSync(target, a.lockPath);
      const startedAt = Date.now();
      const ran = withProjectStateLock(a.cwd, () => fs.lstatSync(a.lockPath).isDirectory());
      const elapsedMs = Date.now() - startedAt;

      assert.equal(
        ran, true,
        `a lock path holding a symlink naming ${label} must still be acquirable. rename(dir, symlink) `
        + 'fails ENOTDIR and neither reaper can clear a link, so before this every acquisition of this '
        + 'project spun the deadline and threw out of a hook — permanently, for one planted link.',
      );
      assert.ok(
        elapsedMs < FAST_MS,
        `and it must not cost the full deadline either (${label}): took ${elapsedMs}ms`,
      );
      assert.equal(fs.existsSync(a.lockPath), false, 'the lock is released, and the link did not come back');
      assert.equal(
        fs.existsSync(elsewhere), true,
        'clearing the link must unlink the LINK, never recurse into what it named',
      );
    }
  } finally {
    fx.cleanup();
  }
});

test('nor does ANY other non-directory a writer of files can plant', () => {
  const fx = fixture();
  try {
    const plants: readonly (readonly [label: string, plant: (lockPath: string) => void])[] = [
      ['a regular file (one `touch`, zero bytes)', (p) => fs.writeFileSync(p, '', 'utf8')],
      ['a hard link to a regular file', (p) => {
        const src = `${p}.hardlink-source`;
        fs.writeFileSync(src, 'x', 'utf8');
        fs.linkSync(src, p);
      }],
      // POSIX-only, and the point of the row is that the clear is keyed on "not
      // a directory" rather than on a list of kinds somebody enumerated.
      ...(process.platform === 'win32' ? [] : [[
        'a FIFO', (p: string) => { execFileSync('mkfifo', [p]); },
      ] as const]),
    ];

    let index = 0;
    for (const [label, plant] of plants) {
      index += 1;
      const a = fx.project(`nondir-${index}`);
      plant(a.lockPath);
      const startedAt = Date.now();
      const ran = withProjectStateLock(a.cwd, () => fs.lstatSync(a.lockPath).isDirectory());
      const elapsedMs = Date.now() - startedAt;

      assert.equal(
        ran, true,
        `a lock path holding ${label} must still be acquirable. The rename fails ENOTDIR against every `
        + 'one of these exactly as it does against a symlink, and before the clear was widened past the '
        + 'symlink spelling each of them denied every tool call in the project until a human deleted it.',
      );
      assert.ok(elapsedMs < FAST_MS, `and without paying the deadline (${label}): took ${elapsedMs}ms`);
      assert.equal(fs.existsSync(a.lockPath), false, `the lock is released (${label})`);
    }
  } finally {
    fx.cleanup();
  }
});

// A lock directory as a REAL abandoned one looks: a dead owner, stamped well
// before the stale window. `plus` is whatever landed beside the owner file.
function abandonedLock(lockPath: string, plus: string | null): void {
  // Above any pid this kernel issues, so `kill(pid, 0)` raises ESRCH without
  // signalling anything. Asserted below rather than assumed.
  const DEAD_PID = 4_194_303;
  const token = 'deadbeef';
  fs.mkdirSync(lockPath);
  fs.writeFileSync(
    path.join(lockPath, `owner-${token}.json`),
    JSON.stringify({ pid: DEAD_PID, token, createdAt: Date.now() - ONE_MCP_REPORT_ID_LOCK_STALE_MS * 6 }),
    'utf8',
  );
  if (plus) fs.writeFileSync(path.join(lockPath, plus), '', 'utf8');
  assert.throws(
    () => process.kill(DEAD_PID, 0),
    /ESRCH/,
    'FIXTURE the owner pid must be provably dead, or every row below passes for the wrong reason',
  );
}

test('an abandoned lock is reclaimed with a STRAY ENTRY beside its owner file', () => {
  const fx = fixture();
  try {
    // The control is the whole argument: the reaper works perfectly the moment
    // the second entry is absent, so nothing here is about staleness or liveness.
    const rows: readonly (readonly [label: string, plus: string | null])[] = [
      ['CONTROL nothing beside the owner file', null],
      ['a Finder `.DS_Store`', '.DS_Store'],
      ['a second owner file from a crashed sibling', 'owner-other.json'],
      ['an editor swap file', '.owner.json.swp'],
    ];

    let index = 0;
    for (const [label, plus] of rows) {
      index += 1;
      const a = fx.project(`stray-${index}`);
      abandonedLock(a.lockPath, plus);
      const startedAt = Date.now();
      const ran = withProjectStateLock(a.cwd, () => true);
      const elapsedMs = Date.now() - startedAt;

      assert.equal(
        ran, true,
        `an abandoned lock with ${label} must be reclaimable. The owner reader refuses any listing that `
        + 'is not exactly one parseable owner file, so it fell through to a reaper that demanded an EMPTY '
        + 'directory — and one zero-byte file wedged the lock every session start takes, permanently, '
        + 'with no attacker involved.',
      );
      assert.ok(elapsedMs < FAST_MS, `and without paying the deadline (${label}): took ${elapsedMs}ms`);
    }
  } finally {
    fx.cleanup();
  }
});

test('two DEAD owner files are an abandoned lock, whatever their stamps say', () => {
  const fx = fixture();
  try {
    const a = fx.project('two-stamps');
    fs.mkdirSync(a.lockPath);
    // Both pids dead, so no evidence of a holder survives at all. This row used
    // to assert a REFUSAL, on the reading that the newer stamp dated a "younger
    // lease" worth protecting — but a lease whose pid is provably gone is not a
    // lease, and the thing that protects a holder is now the compare-and-swap in
    // the removal rather than any stamp. The guard that replaced it is asserted
    // in the LIVE-owner rows below: one running pid among the owner files, however
    // malformed the rest of the directory, keeps the lock.
    for (const [name, ageMs] of [['owner-fresh.json', 0], ['owner-ancient.json', 3_600_000]] as const) {
      fs.writeFileSync(
        path.join(a.lockPath, name),
        JSON.stringify({ pid: 4_194_303, token: name, createdAt: Date.now() - ageMs }),
        'utf8',
      );
    }

    const startedAt = Date.now();
    assert.equal(
      withProjectStateLock(a.cwd, () => true), true,
      'a lock directory holding nothing but dead owners must be reclaimable: refusing it costs every '
      + 'later acquirer its whole timeout on a project whose holder is provably gone',
    );
    assert.ok(Date.now() - startedAt < FAST_MS, 'and without paying the deadline');
  } finally {
    fx.cleanup();
  }
});

test('a FUTURE-stamped owner cannot make a lock immortal, on either arm', () => {
  const fx = fixture();
  try {
    // `now - createdAt` is negative here, which is `<= stale` for any window, so
    // a raw subtraction refuses the reap forever and a NON-EMPTY lock directory
    // (which contends every time, unlike an empty one, which the rename simply
    // overwrites) becomes a permanent wedge. NEITHER ARM READS A STAMP NOW — the
    // observed arm's age conjunct was the last one, and it is gone — so this row
    // asserts an OUTCOME that no longer depends on a fold:
    //
    //   the OBSERVED arm — exactly one legible owner file — reclaims on death
    //     alone, so an impossible stamp cannot reach a decision at all;
    //   the ABANDONED arm — anything the strict reader refuses — consults no
    //     stamp either.
    //
    // Kept, and kept on BOTH arms, for the reason a removed guard needs a row
    // rather than a note: these are the two shapes that were wedged by a future
    // stamp, and if an age ever comes back to either arm it has to come back
    // folded through `trustworthyAgeSince`. The one age this file still reads is
    // the lock DIRECTORY's mtime in `reapAbandonedLock`'s unreadable-owner arm,
    // which the illegible-owner rows below drive.
    const rows: readonly (readonly [label: string, plus: string | null])[] = [
      ['the observed-owner arm (one legible owner file)', null],
      ['the abandoned arm (a stray beside it)', '.DS_Store'],
    ];
    let index = 0;
    for (const [label, plus] of rows) {
      index += 1;
      const a = fx.project(`future-stamp-${index}`);
      fs.mkdirSync(a.lockPath);
      fs.writeFileSync(
        path.join(a.lockPath, 'owner-future.json'),
        JSON.stringify({ pid: 4_194_303, token: 'future', createdAt: Date.now() + 86_400_000 }),
        'utf8',
      );
      if (plus) fs.writeFileSync(path.join(a.lockPath, plus), '', 'utf8');

      const startedAt = Date.now();
      assert.equal(
        withProjectStateLock(a.cwd, () => true), true,
        `[${label}] an age no clock could have produced is not evidence of freshness. clock-skew.ts `
        + 'states the direction for a lock — `age === null || age > STALE` reclaims — and every arm that '
        + 'reads a stamp has to fold through it.',
      );
      assert.ok(Date.now() - startedAt < FAST_MS, `[${label}] and it is reclaimed without paying the deadline`);
    }
  } finally {
    fx.cleanup();
  }
});

test('but a LIVE owner keeps its lock however illegible the directory has become', () => {
  const fx = fixture();
  try {
    // Old enough that age alone would reclaim it: liveness has to be what
    // refuses, or the widened reaper is just a slower way to break the lock.
    const stamp = Date.now() - ONE_MCP_REPORT_ID_LOCK_STALE_MS * 6;
    const rows: readonly (readonly [label: string, write: (lockPath: string) => void])[] = [
      ['a stray entry beside a live owner file', (p) => {
        fs.writeFileSync(path.join(p, 'owner-live.json'),
          JSON.stringify({ pid: process.pid, token: 'live', createdAt: stamp }), 'utf8');
        fs.writeFileSync(path.join(p, '.DS_Store'), '', 'utf8');
      }],
      // The `pid-only` shape: the timestamp field renamed, which is what a
      // record-shape change to a LIVE holder's sentinel actually looks like.
      ['a live owner whose record the strict reader cannot parse', (p) => {
        fs.writeFileSync(path.join(p, 'owner-live.json'),
          JSON.stringify({ pid: process.pid, token: 'live', acquiredAt: stamp }), 'utf8');
      }],
    ];

    let index = 0;
    for (const [label, write] of rows) {
      index += 1;
      const a = fx.project(`live-${index}`);
      fs.mkdirSync(a.lockPath);
      write(a.lockPath);
      fs.utimesSync(a.lockPath, new Date(stamp), new Date(stamp));

      assert.throws(
        () => withProjectStateLock(a.cwd, () => true),
        /timed out/,
        `${label}: the widened reaper must not take a lease from a process that is still running. Its own `
        + 'pid is the proof, and it outranks every age — this row is what separates reclaiming an '
        + 'abandoned lock from breaking a held one.',
      );
      assert.equal(
        fs.existsSync(path.join(a.lockPath, 'owner-live.json')), true,
        `${label}: and the holder's owner file is still there`,
      );
    }
  } finally {
    fx.cleanup();
  }
});

test('a directory the owner reader cannot read at all is reclaimed at once, aged or not', () => {
  const fx = fixture();
  try {
    const rows: readonly (readonly [label: string, plant: (lockPath: string) => void])[] = [
      ['no owner file at all', (p) => {
        fs.mkdirSync(p);
        fs.writeFileSync(path.join(p, 'junk.txt'), 'x', 'utf8');
      }],
      ['an owner file that is not JSON', (p) => {
        fs.mkdirSync(p);
        fs.writeFileSync(path.join(p, 'owner-x.json'), 'not json', 'utf8');
      }],
      ['a nested DIRECTORY, which `unlink` cannot remove', (p) => {
        fs.mkdirSync(p);
        fs.mkdirSync(path.join(p, 'nested'));
        fs.writeFileSync(path.join(p, 'nested', 'inside.txt'), 'x', 'utf8');
      }],
    ];

    // FRESHNESS IS NO LONGER A GUARD HERE, and the previous version of this row
    // asserted that it was: a fresh illegible directory cost the full deadline on
    // the reading that it "can still be a live holder whose sentinel was
    // clobbered". That state is not reachable through this protocol — the owner
    // file is written into the staging dir before the atomic rename, so a lock at
    // the lock path is never missing it — and what does protect a live holder is
    // the compare-and-swap in the removal, which does not need the directory to
    // be old. Both ages are driven, per shape, and both must acquire.
    let index = 0;
    for (const [label, plant] of rows) {
      for (const aged of [false, true]) {
        index += 1;
        const p = fx.project(`illegible-${index}`);
        plant(p.lockPath);
        if (aged) {
          const stamp = new Date(Date.now() - ONE_MCP_REPORT_ID_LOCK_STALE_MS * 6);
          fs.utimesSync(p.lockPath, stamp, stamp);
        }
        const startedAt = Date.now();
        assert.equal(
          withProjectStateLock(p.cwd, () => true), true,
          `${label}, ${aged ? 'aged' : 'FRESH'}: a lock directory with no live pid in it must be `
          + 'reclaimable. Waiting for it to age was a cost with nothing on the other side of it, and the '
          + 'refusal was not even reliably temporary: the substitute stamp was the directory\'s own mtime, '
          + 'which any modification re-arms.',
        );
        assert.ok(
          Date.now() - startedAt < FAST_MS,
          `${label}, ${aged ? 'aged' : 'fresh'}: reclaimed without paying the deadline`,
        );
        assert.equal(fs.existsSync(p.lockPath), false, `${label}: and released on the way out`);
      }
    }
  } finally {
    fx.cleanup();
  }
});

/**
 * Run `body` with a hook fired the `nth` time `fs.readdirSync` is called on
 * `lockPath`, and another when `process.kill` is asked about `pid`.
 *
 * Those two calls are the LAST read each reaper arm makes before it removes
 * anything — `illegibleLockEvidence`'s listing (the strict owner reader takes the
 * first listing, so the evidence read is the second) and `processAlive` — so a
 * hook there lands in the window between the evidence and the remove. Neither
 * window is reachable from outside the module.
 */
function whileWatching(
  watch: { readdir?: { lockPath: string; nth: number }; kill?: number },
  hook: () => void,
  body: () => void,
): { fired: number } {
  const realReaddir = mutableFs.readdirSync;
  const realKill = process.kill.bind(process);
  let fired = 0;
  let seen = 0;
  if (watch.readdir) {
    mutableFs.readdirSync = ((target: fs.PathLike, ...rest: unknown[]) => {
      const result = (realReaddir as (...args: unknown[]) => unknown)(target, ...rest);
      if (String(target) === watch.readdir!.lockPath) {
        seen += 1;
        if (seen === watch.readdir!.nth) { fired += 1; hook(); }
      }
      return result as string[];
    }) as typeof fs.readdirSync;
  }
  if (watch.kill !== undefined) {
    (process as unknown as Record<string, unknown>).kill = ((pid: number, signal?: string | number) => {
      if (pid === watch.kill && fired === 0) { fired += 1; hook(); }
      return realKill(pid, signal as never);
    }) as typeof process.kill;
  }
  try {
    body();
  } finally {
    mutableFs.readdirSync = realReaddir;
    (process as unknown as Record<string, unknown>).kill = realKill;
  }
  return { fired };
}

/** Exactly what a competing acquirer does once it has judged the same lock
 *  reclaimable, and nothing else: reap it, stage a directory with its own owner
 *  file inside, rename that into place. */
function competitorAcquires(lockPath: string): string {
  fs.rmSync(lockPath, { recursive: true, force: true });
  const staging = `${lockPath}.competitor.pending`;
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(
    path.join(staging, 'owner-competitor.json'),
    JSON.stringify({ pid: process.pid, token: 'competitor', createdAt: Date.now() }),
    'utf8',
  );
  fs.renameSync(staging, lockPath);
  return path.join(lockPath, 'owner-competitor.json');
}

test('neither reaper removes a competitor\'s lease that arrived after the evidence was read', () => {
  // THE BLOCKER, both arms. A reap keyed on the PATH rather than on the evidence
  // deletes the lock directory and the owner file of a holder that arrived while
  // this process was deciding, and then acquires — two writers inside one
  // `.one.json` transaction, silently. Measured by this lane, unaided, across
  // real processes against a variant carrying the recursive remove back: 82
  // directly detected steals and 72 all-pairs overlapping holds in 2 000
  // contended acquisitions, against 0 of each on the shipped code.
  //
  // Deterministic here, and injected through the ONE window each arm has, with
  // nothing an ordinary contender does not do. Both rows were invisible to this
  // suite: the observed arm's exact unlink could be swapped for a recursive
  // remove (mutant R7) and the abandoned arm's per-entry removal for the same
  // (mutant R8) with everything green.
  //
  // WHAT THIS ROW CANNOT SEE, said here rather than left to be discovered: it is
  // a SAFETY assertion, so it survives the ABSENCE of the removal as happily as
  // its correctness. A reaper that removed nothing at all — or was never reached
  // — leaves the competitor's owner file intact, does not acquire, and times out,
  // which is every assertion below satisfied. The `fired` readback closes the
  // "never reached" half. The other half is closed only by the LIVENESS rows
  // above (a stray beside a dead owner, two dead owners, an unreadable
  // directory), each of which fails if the removal stops working; neither
  // population is sufficient alone.
  const fx = fixture();
  try {
    const rows: readonly {
      readonly label: string;
      readonly plant: (lockPath: string) => void;
      readonly watch: (lockPath: string) => Parameters<typeof whileWatching>[0];
    }[] = [
      {
        label: 'the abandoned arm (a stray, so the strict reader refuses)',
        plant: (lockPath) => {
          fs.mkdirSync(lockPath);
          fs.writeFileSync(path.join(lockPath, 'junk.txt'), 'x', 'utf8');
        },
        watch: (lockPath) => ({ readdir: { lockPath, nth: 2 } }),
      },
      {
        label: 'the observed-owner arm (one legible, provably dead owner)',
        plant: (lockPath) => {
          fs.mkdirSync(lockPath);
          fs.writeFileSync(
            path.join(lockPath, 'owner-dead.json'),
            JSON.stringify({
              pid: DEAD_PID_FOR_CAS,
              token: 'dead',
              createdAt: Date.now() - ONE_MCP_REPORT_ID_LOCK_STALE_MS * 6,
            }),
            'utf8',
          );
        },
        watch: () => ({ kill: DEAD_PID_FOR_CAS }),
      },
    ];

    let index = 0;
    for (const row of rows) {
      index += 1;
      const a = fx.project(`cas-${index}`);
      row.plant(a.lockPath);
      let competitorOwner = '';
      let bodyRan = false;
      let thrown: string | null = null;
      const { fired } = whileWatching(
        row.watch(a.lockPath),
        () => { competitorOwner = competitorAcquires(a.lockPath); },
        () => {
          try {
            withProjectStateLock(a.cwd, () => { bodyRan = true; });
          } catch (error) {
            thrown = (error as Error).message;
          }
        },
      );

      assert.equal(fired, 1, `FIXTURE [${row.label}] the competitor must have landed in the window`);
      assert.equal(
        fs.existsSync(competitorOwner), true,
        `[${row.label}] the competitor's OWNER FILE was deleted by a reaper that never observed it. That `
        + 'is the whole defect: the removal has to be keyed on the entries the evidence read, and the '
        + 'directory has to go by `rmdir`, which refuses a non-empty one — so a lease minted in the '
        + 'window survives BY CONSTRUCTION rather than by being noticed.',
      );
      assert.equal(
        bodyRan, false,
        `[${row.label}] and this process must NOT have acquired. It concluded the lock was abandoned on `
        + 'evidence that was true when it read it and false when it acted, so the only safe outcome is to '
        + 'find the directory non-empty and contend.',
      );
      assert.match(
        thrown ?? '', /timed out/,
        `[${row.label}] the contention must end at this loop's own deadline, reported: ${thrown}`,
      );
      fs.rmSync(a.lockPath, { recursive: true, force: true });
    }
  } finally {
    fx.cleanup();
  }
});

test('the deadline is decided AFTER the arms run, so a slow arm cannot buy another iteration', () => {
  // The bound is on TIME, not on iterations, and the difference is only visible
  // when an arm is slow — which it can be, because `illegibleLockEvidence` reads
  // and parses every owner-named file in the directory and nothing bounds what
  // somebody left there. Measured on a live-owner lock carrying four 48 MB owner
  // files, three reps each, as a multiple of the 1000 ms timeout: 1.058–1.134x
  // with the clock read after the arms against 1.168–1.249x with it read before
  // them; 1.019–1.022x against 1.028–1.034x on a thin directory, which is why
  // the usual ~1.02x description was true either way and this is not visible
  // without a pathological shape.
  //
  // Asserted by COUNTING the arms rather than by a wall-clock ratio: the first
  // evidence read is made to take longer than the whole deadline, so a loop that
  // tests the pre-arms instant runs the arms a second time and a loop that tests
  // the post-arms instant throws immediately.
  const fx = fixture();
  try {
    const a = fx.project('deadline-after-arms');
    fs.mkdirSync(a.lockPath);
    // A LIVE pid, so no arm can ever make progress and only the deadline ends it.
    fs.writeFileSync(
      path.join(a.lockPath, 'owner-live.json'),
      JSON.stringify({ pid: process.pid, token: 'live', createdAt: Date.now() }),
      'utf8',
    );
    fs.writeFileSync(path.join(a.lockPath, '.DS_Store'), '', 'utf8');

    const realReaddir = mutableFs.readdirSync;
    let listings = 0;
    mutableFs.readdirSync = ((target: fs.PathLike, ...rest: unknown[]) => {
      const result = (realReaddir as (...args: unknown[]) => unknown)(target, ...rest);
      if (String(target) === a.lockPath) {
        listings += 1;
        if (listings === 1) {
          const until = Date.now() + ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS * 1.5;
          while (Date.now() < until) { /* one very slow arm */ }
        }
      }
      return result as string[];
    }) as typeof fs.readdirSync;

    try {
      assert.throws(() => withProjectStateLock(a.cwd, () => true), /timed out/);
    } finally {
      mutableFs.readdirSync = realReaddir;
    }
    // Two listings is ONE pass of the arms (the strict owner reader, then the
    // evidence read). Four means the loop ran the arms again after a pass that
    // had already overrun the deadline, because it tested the instant the rename
    // failed instead of the instant the arms finished.
    assert.equal(
      listings, 2,
      `the arms ran ${listings / 2} times past a deadline that had already elapsed. The deadline test has `
      + 'to read the clock AFTER the arms, or the loop is bounded by how many iterations it can fit '
      + 'rather than by its own timeout.',
    );
  } finally {
    fx.cleanup();
  }
});

// ── the permissions axis: what this port CREATES, and what it does with an
//    unreadable lock directory it did not create ────────────────────────────

test('an acquisition takes the DEPLOYMENT\'S mode for its lock, not one of its own', (t) => {
  const fx = fixture();
  try {
    const a = fx.project('modes');
    const observed = withProjectStateLock(a.cwd, () => {
      const owners = fs.readdirSync(a.lockPath);
      assert.equal(owners.length, 1, 'FIXTURE a held lock has exactly one owner file');
      return {
        dir: fs.lstatSync(a.lockPath).mode & 0o777,
        owner: fs.lstatSync(path.join(a.lockPath, owners[0]!)).mode & 0o777,
        stateDir: fs.lstatSync(path.dirname(a.lockPath)).mode & 0o777,
      };
    });

    // ASSERTED AS AN EQUALITY WITH THE UMASK, not as "somebody else can read it",
    // and the difference is the whole finding of the row below: an explicit
    // `mode: 0o700` is umask-INDEPENDENT, so on a deployment that deliberately
    // shares `.traffic-one/` between uids it forces the one access shape from
    // which no reclaim is possible. Taking the default keeps that decision where
    // it belongs — with whoever configured the machine — and this equality is the
    // only spelling of the claim that survives being run under a different umask.
    const mask = process.umask();
    assert.equal(
      observed.dir, 0o777 & ~mask,
      `the lock directory was created ${observed.dir.toString(8)} under umask `
      + `0${mask.toString(8).padStart(3, '0')}, so it carries a mode of this lock's own choosing rather `
      + 'than the deployment\'s. A hard 0700 is the shape a shared-state-dir deployment cannot recover '
      + 'from: the evidence read fails for every other uid, and a directory whose entries cannot be '
      + 'enumerated cannot be emptied, so the reap refuses forever.',
    );
    assert.equal(
      observed.owner, 0o666 & ~mask,
      `the owner file was created ${observed.owner.toString(8)} under umask `
      + `0${mask.toString(8).padStart(3, '0')}. It carries a pid, a token and a timestamp: the pid is `
      + 'public, the timestamp is not a secret, and the token is not a capability — it is read in this '
      + 'file alone and only ever compared with the reader\'s OWN token, and self-contention is keyed on '
      + 'the directory\'s dev+ino. `.one.json` is a committed file; nothing guarding it can need '
      + 'confidentiality the guarded file does not have.',
    );
    t.diagnostic(
      `umask 0${mask.toString(8).padStart(3, '0')}: .traffic-one/=${observed.stateDir.toString(8)} `
      + `lock dir=${observed.dir.toString(8)} owner file=${observed.owner.toString(8)}`,
    );
  } finally {
    fx.cleanup();
  }
});

test('what a reclaim needs is WRITE permission on the lock directory — reading it decides nothing', (t) => {
  // THE ROW THE MODE DECISION RESTS ON, and the one that retired the argument it
  // used to rest on. That argument was that 0700 wedges a second uid while 0755
  // lets it "read the evidence and decide liveness properly". The second half is
  // true and buys nothing, because the removal that decision authorizes needs a
  // permission neither mode grants a stranger — so the two are indistinguishable
  // in every shape this protocol can produce, and the mode only starts to matter
  // in the third row, where the deployment has deliberately shared the state dir
  // and the default mode inherits that sharing while a hard 0700 cannot.
  //
  // NO SECOND UID IS INVOLVED, and none can be: that needs root. The mode stands
  // in for the access class on this uid, which is faithful to the kernel's
  // permission check — a non-root OWNER without the bit is refused exactly like a
  // stranger — and is asserted rather than assumed below, because a run as root
  // would pass every row here vacuously.
  const fx = fixture();
  const rows: string[] = [];
  try {
    for (const [label, mode, reclaimable] of [
      ['r-x — what a 0755 lock grants a stranger', 0o555, false],
      ['--- — what a 0700 lock grants a stranger', 0o000, false],
      ['rwx — what a 0775 lock on a SHARED state dir grants its group', 0o777, true],
    ] as const) {
      const a = fx.project(`write-bit-${mode.toString(8)}`);
      fs.mkdirSync(a.lockPath);
      fs.writeFileSync(
        path.join(a.lockPath, 'owner-dead.json'),
        JSON.stringify({ pid: DEAD_PID_FOR_CAS, token: 'dead', createdAt: Date.now() - ONE_MCP_REPORT_ID_LOCK_STALE_MS * 6 }),
        'utf8',
      );
      const stamp = new Date(Date.now() - ONE_MCP_REPORT_ID_LOCK_STALE_MS * 6);
      fs.utimesSync(a.lockPath, stamp, stamp);
      fs.chmodSync(a.lockPath, mode);
      try {
        // FIXTURE: the mode must really deny this process the write, or the row
        // measures nothing — root writes straight through it. Asked by CREATING a
        // name rather than by removing one, so the probe cannot destroy the very
        // owner file the reclaim below is supposed to be refused.
        if (!reclaimable) {
          let createCode = 'SUCCEEDED';
          try {
            fs.writeFileSync(path.join(a.lockPath, 'probe-write'), '', { flag: 'wx' });
          } catch (error) {
            createCode = (error as NodeJS.ErrnoException).code ?? '?';
          }
          assert.equal(
            createCode, 'EACCES',
            `FIXTURE [${label}] writing in the lock directory must be genuinely refused for this `
            + `process; got ${createCode}. Running as root makes every row here vacuous.`,
          );
        }

        const startedAt = Date.now();
        let acquired = false;
        let message = '';
        try {
          withProjectStateLock(a.cwd, () => { acquired = true; });
        } catch (error) {
          message = String((error as Error).message);
        }
        const elapsedMs = Date.now() - startedAt;
        rows.push(`${label}: ${acquired ? `reclaimed in ${elapsedMs}ms` : `refused after ${elapsedMs}ms`}`);

        assert.equal(
          acquired, reclaimable,
          reclaimable
            ? `[${label}] a dead owner's lock must be reclaimable by anyone the DEPLOYMENT gave write `
              + 'permission to. This is the row an explicit 0700 removes: it is umask-independent, so it '
              + 'forces the refusal above onto a machine that had deliberately shared the state dir.'
            : `[${label}] a lock this process may not write in must NOT be reclaimed: removing the owner `
              + 'file needs write permission on the directory. Whether the evidence was readable changed '
              + 'nothing, which is why legibility is not the argument for the mode.',
        );
        if (!acquired) {
          assert.match(message, /timed out/, `[${label}] and it must be this lock's own refusal, not a raw errno`);
        }
      } finally {
        // Restored even when the row fails: an 0000 directory left behind takes
        // the whole fixture's cleanup down with it, and the cleanup's own error
        // then REPLACES the assertion that actually failed.
        try { fs.chmodSync(a.lockPath, 0o755); } catch { /* reclaimed, nothing to restore */ }
      }
    }
    t.diagnostic(`write-bit table — ${rows.join('; ')}`);
  } finally {
    fx.cleanup();
  }
});

test('an UNREADABLE lock directory never throws a raw errno out of the hook, and empties out when it can', () => {
  const fx = fixture();
  try {
    for (const [label, plant, expectAcquired] of [
      ['aged and EMPTY', (p: string) => { fs.mkdirSync(p); }, true],
      ['aged and non-empty', (p: string) => {
        fs.mkdirSync(p);
        fs.writeFileSync(path.join(p, 'owner-x.json'), '{"pid":4194303}', 'utf8');
      }, false],
    ] as const) {
      const a = fx.project(`unreadable-${label.replace(/\W+/g, '-')}`);
      plant(a.lockPath);
      const stamp = new Date(Date.now() - ONE_MCP_REPORT_ID_LOCK_STALE_MS * 6);
      fs.utimesSync(a.lockPath, stamp, stamp);
      fs.chmodSync(a.lockPath, 0o000);
      // mode 000 reproduces, for the running uid, exactly the access a second uid
      // has to a 0700 directory it does not own. root reads straight through it,
      // so the premise is asserted rather than assumed: a green run that proved
      // nothing is the outcome this row exists to avoid.
      let readdirCode = '';
      try { fs.readdirSync(a.lockPath); } catch (error) { readdirCode = (error as NodeJS.ErrnoException).code ?? '?'; }
      assert.equal(
        readdirCode, 'EACCES',
        `FIXTURE [${label}] the planted lock directory must be genuinely unreadable to this process`,
      );

      let acquired = false;
      let thrown: NodeJS.ErrnoException | null = null;
      try {
        withProjectStateLock(a.cwd, () => { acquired = true; });
      } catch (error) {
        thrown = error as NodeJS.ErrnoException;
      }

      assert.equal(
        thrown?.code, undefined,
        `[${label}] a raw errno escaped the hook: ${thrown?.code}. EACCES out of \`renameSync\` is the `
        + 'same shape as the transient EPERM one errno over — the "plan-guard.write gate failed (EPERM)" '
        + 'fail-closed deny — so it belongs in the contended set, where it ends at this loop\'s own '
        + `deadline with this loop's own message. Measured before: ${thrown?.code} in 2 ms.`,
      );
      assert.equal(
        acquired, expectAcquired,
        expectAcquired
          ? `[${label}] an unreadable but EMPTY lock directory must be reclaimable: \`rmdir\` needs write `
            + 'permission on the PARENT, not on the directory, and a live holder\'s lock is never empty '
            + '(the owner file is written before the rename). Refusing it is a wedge with nothing on the '
            + 'other side.'
          : `[${label}] and a non-empty one must NOT be acquired: its entries cannot be enumerated, so `
            + 'nothing can be known about them and nothing can remove them. That residual is an OS limit '
            + 'on a directory this product no longer creates — not state it makes unreclaimable.',
      );
      if (!expectAcquired) {
        assert.match(
          thrown?.message ?? '', /timed out/,
          `[${label}] and it must be reported as this lock's own refusal`,
        );
      }
      try { fs.chmodSync(a.lockPath, 0o755); } catch { /* reclaimed, nothing to restore */ }
    }
  } finally {
    fx.cleanup();
  }
});

test('an owner file that is THERE and unreadable is a holder, not an absence — and is still reclaimable when it ages', (t) => {
  // THE STEAL THIS ROW EXISTS FOR. `reapAbandonedLock` consults no age, so its
  // only guard is `illegibleLockEvidence.livePid` — and that function folded a
  // `readFileSync` FAILURE into the same `catch` as a `JSON.parse` failure, so an
  // owner file this uid may not read scored as evidence of ABSENCE. Driven at
  // load 148.71 before the split: the first row below lost a LIVE holder's fresh
  // lock in 51 ms while the identical readable control refused for 1 011 ms.
  //
  // Reachable without an adversary — an ACL, a hardening pass running
  // `chmod -R g-r`, a transient ESTALE/EIO on a networked home in CI — and it is
  // exactly the shape the mode docblock argues the product supports, so the two
  // paragraphs of one file assumed different numbers of uids.
  //
  // THE THREE `RECLAIM` ROWS ARE NOT PADDING. The fix the evidence invites is
  // "unreadable means assume live", and that installs the permanent wedge
  // run-agent/locks.ts explicitly rejects: refusing outright costs every later
  // acquirer its whole timeout, forever, on a directory that outlives the process
  // that made it. So the sibling's SHAPE is what is taken — presence, then AGE —
  // and these rows are what say so. Row `aged + unreadable` is the escape hatch;
  // rows `stray only` and `torn bytes` are the two shapes the age must NOT reach,
  // the first because the product manufactures it itself (`reapObservedLock`
  // unlinks the sentinel, and a stray landing before its `rmdir` leaves no owner
  // evidence and an mtime stamped by the unlink) and the second because round 6
  // already ruled that a writer mid-write is protected by the compare-and-swap
  // rather than by a clock.
  //
  // NO SECOND UID IS INVOLVED — that needs root. mode 0000 on the owner file
  // reproduces, for this uid, the access a stranger has to a 0600 one, which is
  // faithful to the kernel's permission check and is ASSERTED below rather than
  // assumed, because a run as root passes every row here vacuously.
  const fx = fixture();
  const rows: string[] = [];
  const AGED_MS = ONE_MCP_REPORT_ID_LOCK_STALE_MS * 6;
  try {
    for (const [label, plant, expectAcquired] of [
      ['fresh + UNREADABLE owner, holder ALIVE', (p: string) => {
        fs.mkdirSync(p);
        const owner = path.join(p, 'owner-live.json');
        fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, token: 'live', createdAt: Date.now() }), 'utf8');
        fs.chmodSync(owner, 0o000);
      }, false],
      ['fresh + owner-named DIRECTORY (EISDIR)', (p: string) => {
        fs.mkdirSync(p);
        fs.mkdirSync(path.join(p, 'owner-x.json'));
      }, false],
      ['AGED + UNREADABLE owner', (p: string) => {
        fs.mkdirSync(p);
        const owner = path.join(p, 'owner-live.json');
        fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, token: 'live', createdAt: Date.now() }), 'utf8');
        fs.chmodSync(owner, 0o000);
        const stamp = new Date(Date.now() - AGED_MS);
        fs.utimesSync(p, stamp, stamp);
      }, true],
      ['fresh, stray only, mtime just stamped', (p: string) => {
        fs.mkdirSync(p);
        fs.writeFileSync(path.join(p, '.DS_Store'), '', 'utf8');
      }, true],
      ['fresh + TORN owner bytes', (p: string) => {
        fs.mkdirSync(p);
        fs.writeFileSync(path.join(p, 'owner-torn.json'), '{"pid":', 'utf8');
      }, true],
    ] as const) {
      const a = fx.project(`illegible-${label.replace(/\W+/g, '-')}`);
      plant(a.lockPath);
      const owners = fs.readdirSync(a.lockPath).filter((name) => name.startsWith('owner-'));
      if (label.includes('UNREADABLE')) {
        let readCode = 'READABLE';
        try {
          fs.readFileSync(path.join(a.lockPath, owners[0]!), 'utf8');
        } catch (error) {
          readCode = (error as NodeJS.ErrnoException).code ?? '?';
        }
        assert.equal(
          readCode, 'EACCES',
          `FIXTURE [${label}] the owner file must be genuinely unreadable to this process; got ${readCode}. `
          + 'Running as root makes this row vacuous.',
        );
      }

      const startedAt = Date.now();
      let acquired = false;
      let message = '';
      try {
        withProjectStateLock(a.cwd, () => { acquired = true; });
      } catch (error) {
        message = String((error as Error).message);
      }
      const elapsedMs = Date.now() - startedAt;
      rows.push(`${label}: ${acquired ? `reclaimed in ${elapsedMs}ms` : `refused after ${elapsedMs}ms`}`);

      assert.equal(
        acquired, expectAcquired,
        expectAcquired
          ? `[${label}] this must still be reclaimable. An unreadable owner file is evidence of PRESENCE, `
            + 'not a veto: gating it on liveness it cannot supply makes the lock immortal, and the '
            + 'directory outlives the process that made it, so there is no self-heal and no escape. '
            + 'The two mtime-fresh rows must not be age-gated AT ALL — the product manufactures the first '
            + 'of them itself, and re-arming a refusal on the event that made the lock reclaimable is the '
            + 'wedge the age was removed for.'
          : `[${label}] a LIVE holder lost its lock. An owner file that cannot be READ is not the same `
            + 'claim as "no owner file": every errno but ENOENT says the sentinel is THERE, so it must not '
            + 'reclaim on the same terms as a torn one. Age is the guard that is left — see '
            + 'run-agent/locks.ts `readOwnedLock`, which splits the same two cases for the same reason.',
      );
      if (!acquired) {
        assert.match(message, /timed out/, `[${label}] and it must be this lock's own refusal, not a raw errno`);
      }
      try { for (const name of fs.readdirSync(a.lockPath)) fs.chmodSync(path.join(a.lockPath, name), 0o644); } catch { /* reclaimed */ }
    }
    t.diagnostic(`illegible-owner table — ${rows.join('; ')}`);
  } finally {
    fx.cleanup();
  }
});

test('an owner-named entry that would BLOCK a reader is presence, unopened — the hook returns', (t) => {
  // THE WORST OUTCOME IN THIS FILE'S OWN RANKING, and it was reachable with one
  // `mkfifo`. Both readers reached the owner path through `fs.readFileSync`, and
  // `open(O_RDONLY)` on a FIFO WAITS for a writer while a character device
  // answers reads forever: DRIVEN one shape per child under a hard alarm, load
  // 68.86 → 83.65, a single acquisition ran 25 s and 60 s WITHOUT RETURNING for a
  // FIFO named `owner-<anything>.json` and for a symlink to `/dev/zero`, fresh
  // and aged, through both readers — with one entry the strict reader blocks,
  // with a stray beside it (so the strict reader bails on `names.length !== 1`)
  // `illegibleLockEvidence` does. The loop's 1 000 ms deadline is tested BETWEEN
  // iterations, so it never ran: "a hook that never returns is worse than one
  // that fails closed — an unbounded loop cannot even be reported", in this
  // file's own words at that test.
  //
  // THE FIX IS AN ALLOWLIST, WHICH IS WHY THESE ROWS DO NOT ENUMERATE KINDS.
  // `readOwnerEntry` opens with O_NONBLOCK|O_NOFOLLOW and asks `fstat` whether
  // the DESCRIPTOR is a regular file; anything else is presence with no liveness
  // evidence, exactly like a file that cannot be read. A denylist of blocking
  // spellings would need one row here per kind and one more for the next kind
  // nobody thought of — the class three lanes have already been defeated by this
  // session. The rows below are therefore SAMPLES of a decided class, and the
  // mutant that proves it is `FSTAT-DROP` (keep the descriptor, drop the kind
  // test), which restores the hang.
  //
  // TWO SHAPES CHANGE VERDICT rather than merely returning, and both were
  // defects:
  //   a DANGLING symlink was ENOENT, i.e. ABSENCE, and was reclaimed in 511 ms
  //     with no age gate at all. The absence side is justified by a name that
  //     VANISHED between the listing and the read — a transient — and a dangling
  //     link does not vanish. Under O_NOFOLLOW the open never resolves it, so it
  //     raises ELOOP and is presence like every other link.
  //   a symlink to a LIVE holder's owner file was FOLLOWED, so another object's
  //     pid answered for this lock: an immortal lock, refused for ever (measured
  //     1 717 ms and 1 910 ms, fresh and aged, both refusing before the change).
  //     That is the permanent wedge this file ranks above a steal, and it is the
  //     same `statSync`-versus-`lstatSync` mistake `observeLockPath` already
  //     refuses at the lock path.
  //
  // NO WALL CLOCK CEILING IS ASSERTED, deliberately. What this row is about is
  // that the call RETURNS, and for the refusing shapes the deadline throw IS the
  // return — a hang fails the row by never finishing. Adding a `< FAST_MS` bound
  // to the reclaiming shapes would import the one assertion class this file
  // documents as load-sensitive for nothing: the elapsed figures are recorded as
  // a diagnostic instead.
  if (process.platform === 'win32') return;
  const fx = fixture();
  const rows: string[] = [];
  try {
    for (const [label, plant, aged, expectAcquired] of [
      ['a FIFO, fresh — the strict reader\'s path', (p: string) => {
        fs.mkdirSync(p);
        execFileSync('mkfifo', [path.join(p, 'owner-fifo.json')]);
      }, false, false],
      ['a FIFO, aged', (p: string) => {
        fs.mkdirSync(p);
        execFileSync('mkfifo', [path.join(p, 'owner-fifo.json')]);
      }, true, true],
      ['a FIFO beside a stray, fresh — the EVIDENCE reader\'s path', (p: string) => {
        fs.mkdirSync(p);
        execFileSync('mkfifo', [path.join(p, 'owner-fifo.json')]);
        fs.writeFileSync(path.join(p, '.DS_Store'), '', 'utf8');
      }, false, false],
      ['a symlink to /dev/zero, aged', (p: string) => {
        fs.mkdirSync(p);
        fs.symlinkSync('/dev/zero', path.join(p, 'owner-devzero.json'));
      }, true, true],
      ['a DANGLING symlink, fresh', (p: string) => {
        fs.mkdirSync(p);
        fs.symlinkSync(path.join(p, 'no-such-target'), path.join(p, 'owner-dangling.json'));
      }, false, false],
      ['a DANGLING symlink, aged', (p: string) => {
        fs.mkdirSync(p);
        fs.symlinkSync(path.join(p, 'no-such-target'), path.join(p, 'owner-dangling.json'));
      }, true, true],
      ['a symlink to a LIVE owner file, aged', (p: string) => {
        fs.mkdirSync(p);
        const real = path.join(fx.root, `borrowed-${path.basename(p)}.json`);
        fs.writeFileSync(real, JSON.stringify({ pid: process.pid, token: 'borrowed', createdAt: Date.now() }), 'utf8');
        fs.symlinkSync(real, path.join(p, 'owner-borrowed.json'));
      }, true, true],
    ] as const) {
      const a = fx.project(`blocking-${label.replace(/\W+/g, '-')}`);
      plant(a.lockPath);
      if (aged) {
        const stamp = new Date(Date.now() - ONE_MCP_REPORT_ID_LOCK_STALE_MS * 6);
        fs.utimesSync(a.lockPath, stamp, stamp);
      }

      // IN A CHILD, under a hard kill — see this file's header. Every row, not
      // just the FIFOs: the borrowed-owner row's planted pid is THIS process's,
      // and this process outlives the child, so the fixture is unchanged by the
      // move.
      const { acquired, message, ms: elapsedMs } = acquireInChild(a.cwd, label);
      rows.push(`${label}: ${acquired ? `reclaimed in ${elapsedMs}ms` : `refused after ${elapsedMs}ms`}`);

      assert.equal(
        acquired, expectAcquired,
        expectAcquired
          ? `[${label}] an aged lock directory whose only owner-named entry cannot be OPENED as a regular `
            + 'file must still be reclaimable — presence is not a veto, and a directory outlives the '
            + 'process that made it, so an outright refusal is a wedge with no self-heal. This row is also '
            + 'where a borrowed liveness claim would show: a followed symlink makes another object\'s pid '
            + 'answer for this lock and refuse for ever.'
          : `[${label}] this is PRESENCE with no liveness evidence, so a fresh lock must be refused rather `
            + 'than reclaimed. A dangling symlink scored as ABSENCE reclaimed a lock in 511 ms with no age '
            + 'gate at all, by the same conflation the evidence reader was repaired for one layer up.',
      );
      if (!acquired) {
        assert.match(
          message, /timed out/,
          `[${label}] and the refusal must be this lock's own, not a raw errno and not a hang: reaching `
          + 'this assertion at all is the property, since a blocking read never returns to be judged',
        );
      } else {
        assert.equal(fs.existsSync(a.lockPath), false, `[${label}] and the reclaimed lock is released`);
      }
    }
    t.diagnostic(`blocking-shape table — ${rows.join('; ')}`);
  } finally {
    fx.cleanup();
  }
});

test('a legible DEAD owner is reclaimed AT ONCE, however fresh its record — and a live one still is not', () => {
  // THE OBSERVED ARM'S AGE CONJUNCT, REMOVED, and this row is the price it was
  // charging. The arm required `(age === null || age > STALE) && !processAlive`,
  // so a dead owner whose record was written seconds ago was refused for a full
  // ten-second stale window — during which every `.one.json` transaction in that
  // project throws out of a hook, and a SIGKILLed hook is the documented normal
  // case here (22 orphans on one 16co run).
  //
  // MEASURED against `OBSERVED-AGE-RESTORED`, three reps each, load 61 → 55:
  // dead + fresh is minted in 494/847/812 ms shipped and refused 1 881/1 631/
  // 1 648 ms then THROWN with the conjunct back. Dead + aged is minted either
  // way. The second row is what makes the removal safe rather than merely
  // cheap — a LIVE owner with an equally fresh record is refused with the
  // conjunct and without it, so liveness alone is what keeps a lease, and the
  // compare-and-swap in `reapObservedLock` is what protects one that arrives
  // mid-decision (driven in the competitor row above).
  //
  // The asymmetry it removes: an abandoned lock with NO legible owner is
  // reclaimed at once, while one with a perfectly legible DEAD owner waited ten
  // seconds — more evidence, treated more conservatively.
  const fx = fixture();
  try {
    for (const [label, pid, expectAcquired] of [
      ['a DEAD owner, record written just now', DEAD_PID_FOR_CAS, true],
      ['CONTROL a LIVE owner, same fresh record', process.pid, false],
    ] as const) {
      const a = fx.project(`observed-fresh-${expectAcquired ? 'dead' : 'live'}`);
      fs.mkdirSync(a.lockPath);
      // Exactly one correctly-named parseable owner file: the OBSERVED arm, not
      // the abandoned one, is what decides here.
      fs.writeFileSync(
        path.join(a.lockPath, 'owner-observed.json'),
        JSON.stringify({ pid, token: 'observed', createdAt: Date.now() }),
        'utf8',
      );

      let acquired = false;
      let message = '';
      try {
        withProjectStateLock(a.cwd, () => { acquired = true; });
      } catch (error) {
        message = String((error as Error).message);
      }

      assert.equal(
        acquired, expectAcquired,
        expectAcquired
          ? `[${label}] a pid that answers ESRCH is PROOF the holder is gone, not an inference from a `
            + 'clock. Waiting a stale window on top of it charges an honest recent crash ten seconds of '
            + 'hard failures out of a hook, and buys nothing the compare-and-swap in the reclaim does not '
            + 'already give.'
          : `[${label}] and the removal must not reach a holder that is still running: liveness is the `
            + 'guard, and it is the only one this arm has now.',
      );
      if (!acquired) assert.match(message, /timed out/, `[${label}] refused as this lock's own timeout`);
    }
  } finally {
    fx.cleanup();
  }
});

test('an errno OUTSIDE the contended set leaves the loop as itself, rather than being retried until the deadline', () => {
  // THE BRANCH THE CENSUS PUT AT ZERO EXECUTIONS. `if (!contended) throw error;`
  // had no fixture anywhere in the twelve fenced suites, and the mutant that
  // deletes it (`void contended;`, i.e. every errno is retryable) SURVIVED. The
  // row that was offered instead — `E1`, which drops EACCES FROM the contended
  // set — proves only that NARROWING the set matters; it says nothing about an
  // errno outside it, which is the same substitution that let `REL` survive.
  //
  // EXDEV is the honest choice for the fixture: `rename` across devices is a real
  // failure this protocol can meet (a `.traffic-one/` on a different mount from
  // its staging sibling cannot happen, but a bind-mounted or overlayed project
  // root can move the pair apart), and it is not a contention signal in any
  // reading, so retrying it is a full deadline burned inside a hook on a
  // condition that will never clear. What the caller must get is the errno.
  const fx = fixture();
  try {
    const a = fx.project('errno-unclassified');
    const realRename = mutableFs.renameSync;
    let attempts = 0;
    mutableFs.renameSync = ((from: fs.PathLike, to: fs.PathLike, ...rest: unknown[]) => {
      if (String(to) === a.lockPath) {
        attempts += 1;
        const error = new Error(`EXDEV: cross-device link, rename -> '${a.lockPath}'`) as NodeJS.ErrnoException;
        error.code = 'EXDEV';
        throw error;
      }
      return (realRename as (...args: unknown[]) => unknown)(from, to, ...rest) as void;
    }) as typeof fs.renameSync;

    const startedAt = Date.now();
    let thrown: NodeJS.ErrnoException | null = null;
    try {
      withProjectStateLock(a.cwd, () => true);
    } catch (error) {
      thrown = error as NodeJS.ErrnoException;
    } finally {
      mutableFs.renameSync = realRename;
    }
    const elapsedMs = Date.now() - startedAt;

    assert.equal(
      thrown?.code, 'EXDEV',
      `the raw errno must reach the caller; got ${thrown?.code ?? 'no throw at all'} after ${elapsedMs}ms. `
      + 'An unclassified errno swallowed into the contended set is retried against a condition that cannot '
      + 'clear, so the hook pays the whole timeout and then reports a contention that never happened.',
    );
    assert.equal(
      attempts, 1,
      `and it must not be retried: ${attempts} rename attempts. The contended set is an allowlist precisely `
      + 'so that everything outside it ends the loop at once.',
    );
    assert.ok(
      elapsedMs < FAST_MS,
      `and it must be immediate rather than the loop's own deadline: took ${elapsedMs}ms`,
    );
    assert.equal(
      fs.readdirSync(path.dirname(a.lockPath)).filter((name) => name.endsWith('.pending')).length, 0,
      'and the staging directory must be removed on the way out — the `finally` covers the rethrow arm too',
    );
  } finally {
    fx.cleanup();
  }
});

/**
 * Run `body` with `fs.unlinkSync` intercepted for `lockPath`.
 *
 * `before` runs INSIDE the observe→act window the clear leaves open; `after`
 * runs once the object is really gone. Two different rows need the two sides,
 * and neither window is reachable from outside the module.
 */
function whileInterceptingUnlink(
  lockPath: string,
  hooks: {
    before?: (calls: number) => void;
    after?: (calls: number) => void;
    /** Fail the clear instead of performing it, so the iteration makes no
     *  progress. One row needs a FRUITLESS iteration whose work is otherwise the
     *  same as a progressing one; `after` never runs on that path, because
     *  nothing was cleared. */
    refuse?: boolean;
  },
  body: () => void,
): number {
  const real = mutableFs.unlinkSync;
  let calls = 0;
  mutableFs.unlinkSync = ((target: fs.PathLike, ...rest: unknown[]) => {
    const mine = String(target) === lockPath;
    if (mine) {
      calls += 1;
      hooks.before?.(calls);
      if (hooks.refuse) {
        const refusal = new Error(`EACCES: permission denied, unlink '${lockPath}'`) as NodeJS.ErrnoException;
        refusal.code = 'EACCES';
        throw refusal;
      }
    }
    const result = (real as (...args: unknown[]) => unknown)(target, ...rest);
    if (mine) hooks.after?.(calls);
    return result as void;
  }) as typeof fs.unlinkSync;
  try {
    body();
  } finally {
    mutableFs.unlinkSync = real;
  }
  return calls;
}

test('clearing a stray object is scoped by unlink REFUSING a directory, in the observe→act window', () => {
  const fx = fixture();
  try {
    const a = fx.project('unlink-race');
    const elsewhere = path.join(fx.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, a.lockPath);

    // The clear re-resolves the PATH rather than acting on the inode it observed,
    // so the window between the two is real. This row puts a live holder's lock
    // directory into it: what has to save that directory is the syscall refusing
    // a directory, and nothing else does. A recursive remove passes every other
    // row in this file — it declines to follow a link too — and deletes it here.
    const token = 'racer';
    const ownerFile = path.join(a.lockPath, `owner-${token}.json`);
    whileInterceptingUnlink(a.lockPath, {
      before: (calls) => {
        if (calls !== 1) return;
        fs.rmSync(a.lockPath); // the link the acquirer observed
        fs.mkdirSync(a.lockPath);
        fs.writeFileSync(
          ownerFile,
          JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }),
          'utf8',
        );
      },
    }, () => {
      assert.throws(
        () => withProjectStateLock(a.cwd, () => true),
        /timed out/,
        'a live holder arrived in the window, so this acquisition must contend for it and time out',
      );
    });

    assert.equal(
      fs.existsSync(a.lockPath) && fs.lstatSync(a.lockPath).isDirectory(), true,
      'the lock directory that replaced the link inside the window must SURVIVE the clear. `unlinkSync` '
      + 'fails on a directory, which is the entire reason the unconditional clear is safe; a recursive '
      + 'remove would take a live holder\'s lock and every other row here would stay green.',
    );
    assert.equal(fs.existsSync(ownerFile), true, 'with its owner file, so the holder still owns it');
    assert.equal(fs.existsSync(elsewhere), true, 'and what the link named is untouched, as ever');
    fs.rmSync(a.lockPath, { recursive: true, force: true });
  } finally {
    fx.cleanup();
  }
});

test('the held identity is the directory we STAGED, not whatever the path leads to afterwards', () => {
  const fx = fixture();
  try {
    const a = fx.project('provenance');
    // A second spelling of the same project, so a nested acquisition reaches the
    // identity branch rather than the `heldLocks` string memo.
    const spelling = path.join(fx.root, 'provenance-link');
    fs.symlinkSync(a.cwd, spelling);
    const impostor = path.join(fx.root, 'impostor');
    fs.mkdirSync(impostor);
    fs.writeFileSync(path.join(impostor, 'owner-impostor.json'),
      JSON.stringify({ pid: process.pid, token: 'impostor', createdAt: Date.now() }), 'utf8');

    // `heldLockIds` claims its members are ids of directories THIS process
    // created. Re-observing the path after the rename reads whatever is there at
    // that instant instead — and this row puts something else there, in exactly
    // that instant. The two spellings then disagree about what the outer frame
    // holds: under the honest identity the collision is a stranger and contends;
    // under the re-observed one the outer hold vouches for the impostor and the
    // nested transaction runs re-entrantly over a lock nobody took.
    const realRename = mutableFs.renameSync;
    let swapped = false;
    mutableFs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      realRename(from, to);
      if (String(to) === a.lockPath && !swapped) {
        swapped = true;
        realRename(a.lockPath, `${a.lockPath}.moved-aside`);
        realRename(impostor, a.lockPath);
      }
    }) as typeof fs.renameSync;

    try {
      withProjectStateLock(a.cwd, () => {
        assert.equal(swapped, true, 'FIXTURE the swap must have landed, or this row proves nothing');
        assert.throws(
          () => withProjectStateLock(spelling, () => true),
          /timed out/,
          'the object substituted at the lock path is not a lock this process holds, and the nested '
          + 'acquisition must contend for it. Re-entering here means the identity was taken from the '
          + 'PATH after the rename rather than from the directory we staged.',
        );
      });
    } finally {
      mutableFs.renameSync = realRename;
    }
  } finally {
    fx.cleanup();
  }
});

test('a re-planting adversary cannot keep the acquisition loop alive past its deadline', (t) => {
  const fx = fixture();
  try {
    const a = fx.project('spin');
    const elsewhere = path.join(fx.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, a.lockPath);

    // Re-plant for longer than the whole deadline, so the loop can never reach a
    // clear path of its own accord. Before the deadline governed the clear arm,
    // this ran 10 404 hot iterations with no sleep and no throw and was still
    // going at 3x the deadline: an unbounded loop inside a hook, which cannot
    // even be reported the way a fail-closed deny can.
    const startedAt = Date.now();
    const replantUntil = startedAt + ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS * 3;
    let elapsedMs = 0;
    // Every entry into the clear arm is one iteration's start, so the interval
    // between two consecutive entries is one whole iteration INCLUDING whatever
    // it waited. The QUICKEST of them is the figure both phases below report.
    //
    // SAMPLING STOPS SHORT OF THE DEADLINE, because the last waits are truncated:
    // the loop sleeps `min(retry, deadline - now)`, so the iterations inside the
    // final retry window wait for less than the delay and the last one waits for
    // nothing at all. Including them made a fruitless phase report 1.95 ms — the
    // truncated tail, not the wait — which is a measurement of the wrong thing in
    // the direction that hides the mutant.
    //
    // AND IT COUNTS ITS SAMPLES, because the cutoff gives this instrument a
    // VACUOUS MODE and the vacuous mode used to print itself ARMED. `smallest`
    // starts at Infinity and is only ever written when a mark lands before the
    // cutoff, so fewer than two marks inside the window leaves it at Infinity —
    // which satisfies `fruitless.ms >= RETRY/2` and reported
    // `ARMED (Infinityms >= 5ms)`. DRIVEN: a mutant moving the cutoff into the
    // past kept the suite green while announcing the floor armed. That is the
    // failure the comment below condemns, one step worse: an assertion that
    // stands itself down silently is bad, and one that stands itself down while
    // claiming to be armed cannot even be counted. `intervals` is what the
    // fixture floor asks about, so the vacuous mode is a RED rather than a shape
    // the report cannot distinguish.
    const quickest = (cutoffMs: number) => {
      let previous: number | null = null;
      let intervals = 0;
      let smallest = Number.POSITIVE_INFINITY;
      return {
        mark: () => {
          const at = performance.now();
          if (at > cutoffMs) return;
          if (previous !== null) {
            intervals += 1;
            smallest = Math.min(smallest, at - previous);
          }
          previous = at;
        },
        get ms(): number { return smallest; },
        /** Marks that landed inside the cutoff, PAIRED. Zero means `ms` is Infinity. */
        get intervals(): number { return intervals; },
      };
    };
    const untilShortOfDeadline = () => performance.now()
      + ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS - 2 * ONE_MCP_REPORT_ID_LOCK_RETRY_MS;
    // NOT ONE ASSERTION UNTIL THE DIAGNOSTIC HAS BEEN EMITTED, and the phases
    // therefore RECORD their outcome instead of judging it. This looks like a
    // style choice and is not: the marker below is this machine's only report of
    // how often the gated half stands down, another file asserts that it really
    // reaches stdout, and an `assert.throws` here made both of those conditional
    // on a wall clock race. MEASURED — the mutant that lowercases the emitted
    // marker SURVIVED a mutation run at load 88, because phase A had failed first
    // (its adversary stops re-planting at 3x the deadline, so one iteration slow
    // enough to outlast that lets the acquisition succeed) and the reader could
    // not tell a suppressed marker from an absent one. Measure, report, then
    // judge — in that order — and the report is unconditional.
    const progressing = quickest(untilShortOfDeadline());
    let phaseA = 'nothing was thrown at all';
    const clears = whileInterceptingUnlink(a.lockPath, {
      before: progressing.mark,
      after: () => {
        if (Date.now() >= replantUntil) return;
        try { fs.symlinkSync(elsewhere, a.lockPath); } catch { /* the loop got there first */ }
      },
    }, () => {
      try {
        withProjectStateLock(a.cwd, () => {
          // A body that runs means the adversary lost the race outright, which
          // is a fine outcome for the product and a useless one for this row.
          throw new Error('acquired');
        });
      } catch (error) {
        phaseA = String((error as Error).message);
      }
      elapsedMs = Date.now() - startedAt;
    });

    // PHASE B: the same wedged lock path, with the clear REFUSED rather than
    // performed. Nothing needs re-planting — the symlink survives every
    // iteration — and no arm can report progress, so every iteration is one the
    // sleep is actually for. Both loops wait here; only their phase A differs.
    // Phase A leaves the adversary's last re-plant behind, so this is usually a
    // no-op; it is here so the phase does not depend on which side won the last
    // iteration.
    if (!fs.existsSync(a.lockPath)) fs.symlinkSync(elsewhere, a.lockPath);
    const phaseBIsNonDirectory = !fs.lstatSync(a.lockPath).isDirectory();
    const fruitless = quickest(untilShortOfDeadline());
    let phaseB = 'nothing was thrown at all';
    const fruitlessIterations = whileInterceptingUnlink(a.lockPath, {
      before: fruitless.mark,
      refuse: true,
    }, () => {
      try {
        withProjectStateLock(a.cwd, () => { throw new Error('acquired'); });
      } catch (error) {
        phaseB = String((error as Error).message);
      }
    });

    // THE CONTROL PHASE, and the reason there is one. "Only a fruitless iteration
    // waits" is the whole point of the sleep being conditional, and a loop that
    // sleeps on EVERY iteration — including the ones that cleared something and
    // could retry the rename at once — takes the same elapsed time and throws the
    // same error, so neither elapsed time nor the message can tell them apart.
    //
    // A COUNT can, but only on an idle machine, and this one is not idle. An
    // always-sleeping loop cannot exceed timeout/retry iterations BY CONSTRUCTION
    // (100 here), and the shipped loop cleared 4 827 times idle — but 49, 101 and
    // 73 times in three reps at load average 67, which is ordinary here. A fixed
    // floor of 100 fails the SHIPPED loop about as often as it catches the mutant:
    // the populations overlap, because the discriminator is a 10 ms wait and one
    // loaded iteration's own work is 14-20 ms.
    //
    // The QUICKEST interval alone is not enough either, for the same reason one
    // step removed: it needs one unpreempted iteration out of dozens, and under a
    // mutation run's own load it did not get one (12.28 ms, above the 10 ms delay,
    // reported against the SHIPPED loop).
    //
    // ONE DIRECTION NEEDS NO PRECONDITION, and the earlier spelling of this row
    // asserted the other one. Every SAMPLED fruitless iteration contains a
    // `sleepSync(10)`; `Atomics.wait` does not return early when nothing notifies
    // it, and the truncated tail is excluded by the cutoff above, so the quickest
    // fruitless interval has a hard 10 ms floor that load can only raise. That is
    // asserted unconditionally. "A progressing iteration is FAST" is the reverse —
    // a lower bound on this machine's SPEED — and it is the one load destroys, so
    // it keeps its precondition and the disarm is COUNTED: an assertion that
    // silently stands itself down is worse than one that never fires, because
    // afterwards nothing distinguishes the two.
    //
    // THE FLOOR IS WHAT THE PRECONDITION USED TO DISCARD. The gate was
    // `progressing.ms < retry/2` — the progressing figure — so a busy machine threw
    // the whole comparison away; and the mutant this row could not see at all
    // (`progressed` corrupted AFTER both reap arms, so the guard below and its
    // single call site both survive) has its signature in the FRUITLESS figure:
    // measured 0.15-0.16 ms against a shipped 9.58-11.29 ms, at load 74-88, three
    // reps each. Comparing the two phases would fire on it too and is deliberately
    // NOT what is asserted, because that form reads the progressing minimum, and
    // the 12.28 ms sample above against a shipped fruitless 10.6 ms is a red run on
    // the SHIPPED loop. The floor never reads that figure.
    //
    // The DETERMINISTIC kill for both directions is the next test, which counts the
    // sleeps instead of timing them; this row is the same claim in wall clock, and
    // it is the one that also proves the loop terminates at its deadline.
    const waitedExtraMs = fruitless.ms - progressing.ms;
    const measurable = progressing.ms < ONE_MCP_REPORT_ID_LOCK_RETRY_MS / 2;
    // EMITTED BEFORE EVERY ASSERTION IN THIS ROW, including the two phases' own,
    // deliberately. It used to sit at the end of the test, so the one record
    // anywhere of how often this machine stands the gated half down was absent on
    // exactly the runs that went red — every mutant run that killed this row lost
    // it, and a mutation of the marker itself survived because a phase failing
    // first is indistinguishable from a marker that stopped being printed.
    // `t.diagnostic` is queued to the reporter and flushed when the test finishes
    // either way, so the only thing that ever suppressed it was program order.
    //
    // The marker is a CONSTANT rather than prose because a `t.diagnostic` line is
    // printed where nothing reads it: `npm test` output is teed to a log no job
    // greps and no job uploads, so a gate that disarms on every run in CI would
    // look exactly like one that never disarms. `lock-disarm-ci.test.ts` is the
    // half of the repair that lives in this repo — it pins this marker's spelling
    // and requires the CI step that greps it to keep naming it.
    t.diagnostic(
      `${CLOCK_DISARM_MARKER} disarms=${measurable ? 0 : 1} of 1 — unconditional fruitless floor ARMED `
      + `(${fruitless.ms.toFixed(2)}ms >= ${ONE_MCP_REPORT_ID_LOCK_RETRY_MS / 2}ms over `
      + `${fruitless.intervals} sampled intervals); gated progressing-speed assertion `
      + `${measurable ? 'ARMED' : 'DISARMED'} (progressing ${progressing.ms.toFixed(2)}ms over `
      + `${progressing.intervals} intervals, fruitless ${fruitless.ms.toFixed(2)}ms, `
      + `difference ${waitedExtraMs.toFixed(2)}ms)`,
    );

    // The phases' own verdicts, judged here rather than where they were measured.
    assert.equal(
      phaseBIsNonDirectory, true,
      'FIXTURE phase B needs a non-directory at the lock path, so the clear arm is the one that runs',
    );
    assert.match(
      phaseA, /timed out/,
      `the loop must end at its OWN deadline with a throw, and phase A ended with \`${phaseA}\`. `
      + '`acquired` means the re-planting adversary lost the race outright — a fine outcome for the '
      + 'product and a useless one for this row, and on a loaded host it means an iteration outlasted the '
      + `${ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS * 3}ms re-plant window.`,
    );
    assert.match(
      phaseB, /timed out/,
      `CONTROL a lock path nothing can clear must still end at the deadline with a throw, not \`${phaseB}\``,
    );
    assert.ok(
      clears > 1 && fruitlessIterations > 1,
      `FIXTURE both phases must go round at least twice to have an interval at all; `
      + `${clears} progressing, ${fruitlessIterations} fruitless`,
    );
    // THE FLOOR'S OWN PRECONDITION, and it is an assertion rather than a gate on
    // purpose: an unsampled phase makes `ms` Infinity, and Infinity passes the
    // floor below while meaning that nothing was measured at all.
    assert.ok(
      fruitless.intervals >= 1 && Number.isFinite(fruitless.ms),
      `FIXTURE the fruitless phase sampled ${fruitless.intervals} interval(s) inside the cutoff, so the `
      + `floor below would read ${fruitless.ms}ms and pass without measuring anything. Iterations were `
      + `${fruitlessIterations}, so the loop ran — what failed is that fewer than two of its marks landed `
      + 'before the cutoff, which needs an iteration slower than the whole retry window.',
    );
    assert.ok(
      fruitless.ms >= ONE_MCP_REPORT_ID_LOCK_RETRY_MS / 2,
      `a FRUITLESS iteration must WAIT: the quickest took ${fruitless.ms.toFixed(2)}ms against a `
      + `${ONE_MCP_REPORT_ID_LOCK_RETRY_MS}ms retry delay, and every sampled interval carries a full delay. `
      + 'A loop that computes `progressed` wrongly after its reap arms keeps both structural properties '
      + 'below and hot-spins the entire deadline out inside a hook at a fraction of a millisecond per '
      + 'iteration, which is what this figure sees. Load can only make an interval LONGER, so nothing '
      + 'about this machine can produce this failure.',
    );
    if (measurable) {
      assert.ok(
        waitedExtraMs > ONE_MCP_REPORT_ID_LOCK_RETRY_MS / 2,
        `a fruitless iteration must wait and a progressing one must not, and the quickest of each differ by `
        + `${waitedExtraMs.toFixed(2)}ms (${progressing.ms.toFixed(2)}ms progressing, `
        + `${fruitless.ms.toFixed(2)}ms fruitless) against a ${ONE_MCP_REPORT_ID_LOCK_RETRY_MS}ms retry delay. `
        + 'A successful clear must retry the rename immediately rather than sleeping first: the sleep exists '
        + 'for FRUITLESS iterations, and making it unconditional is invisible to elapsed time and to the '
        + 'error message.',
      );
    }
    // THE DISARM RECORD IS REPORTED ABOVE, armed or not, and it is the only
    // record anywhere of how often this machine stands the gated half down.
    // Counted over eight runs of this suite: 5 of 5 armed at load 63-102, then 1
    // armed and 3 DISARMED over four further reps at load 55 — 3 disarms in 9,
    // and not monotone in load, because what the gate reads is the quickest
    // PROGRESSING interval and one preempted iteration is enough to raise it. So
    // the gated half is worth roughly two runs in three here and cannot be relied
    // on for any single one; the floor above and the counted sleeps in the next
    // row are what actually hold. An earlier round claimed the reverse extreme
    // ("INCONCLUSIVE on every run on this host") and no artefact supported either
    // figure, because nothing counted.

    // THE SPELLING HALF, kept and DEMOTED. It pins a spelling rather than a
    // behaviour, and the mutant that shows what that costs is in the test below:
    // `progressed` corrupted after the arms passes both regexes here, survived two
    // of three reps of the whole twelve-suite run, and hot-spins a hook for a full
    // second. What this half still buys is a name for the thing the two
    // behavioural rows are about, at no wall clock, in the same spirit as the
    // import-closure proof in __tests__/lock-path-spelling-exclusion.test.ts,
    // which is likewise kept as an early warning rather than as the fix.
    const loopSource = fs.readFileSync(path.join(__dirname, '..', 'project-state-lock.ts'), 'utf8');
    const sleepCalls = loopSource.match(/(?<!function )sleepSync\(/g) ?? [];
    assert.equal(
      sleepCalls.length, 1,
      `the acquisition loop must call sleepSync exactly once; found ${sleepCalls.length} call sites, so the `
      + 'guard below is no longer the only thing standing between progress and a wait',
    );
    assert.match(
      loopSource,
      /\n\s*if \(!progressed\) sleepSync\(/,
      'the sleep must be guarded by `if (!progressed)`: only a fruitless iteration waits, and an '
      + 'unconditional sleep is invisible to every clock on a loaded machine',
    );
    // THE ONE GENUINELY TWO-DIRECTIONAL ASSERTION IN THIS FILE, and its margin is
    // written down because it is not large. Everything else here is a count or a
    // floor that load can only move in the passing direction; this is a CEILING
    // on wall clock, so a loaded runner pushes it towards red. Measured worst
    // case for a single contended acquisition in an isolated probe: 1 621 ms at
    // load 60, against this 2 000 ms bound. It is not widened because the
    // adversary above re-plants until 3x the deadline, so anything at or past 3x
    // makes the row vacuous — "ended when the adversary tired" would pass. The
    // usable range is therefore 1x to 3x and 2x is its middle; a red here is a
    // real report about the runner rather than a threshold to raise.
    assert.ok(
      elapsedMs < ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS * 2,
      `and it must end NEAR that deadline rather than whenever the adversary tires: took ${elapsedMs}ms `
      + `against a ${ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS}ms deadline (the adversary re-plants until `
      + `${ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS * 3}ms, so this bound cannot be raised past that without `
      + 'asserting nothing)',
    );
  } finally {
    fx.cleanup();
  }
});

/** What one contended acquisition did, counted rather than timed. */
interface SleepCensus {
  /** Rename attempts onto the lock path — exactly one per pass round the retry
   *  loop, so this is the iteration count even when nothing slept. */
  readonly iterations: number;
  /** `Atomics.wait` calls, i.e. sleeps the loop actually performed. */
  readonly sleeps: number;
}

/**
 * Count the loop's sleeps and iterations through the two globals that carry them,
 * and delegate both honestly so the run terminates exactly as it would unobserved.
 *
 * `sleepSync` reaches the kernel through `Atomics.wait`, which is a writable
 * property of a global object — the same monkey-patch idiom this file already uses
 * for `fs.unlinkSync`, one layer down. `renameSync` onto the lock path is called
 * once per iteration, and it is counted SEPARATELY on purpose: a loop that never
 * sleeps has a sleep count of zero and an iteration count in the thousands, and
 * without the second number "0 sleeps" cannot tell a loop that had no reason to
 * wait from one that burned its whole deadline hot.
 */
function sleepCensus(lockPath: string, body: () => void): SleepCensus {
  const realWait = Atomics.wait;
  const realRename = mutableFs.renameSync;
  let iterations = 0;
  let sleeps = 0;
  mutableFs.renameSync = ((from: fs.PathLike, to: fs.PathLike, ...rest: unknown[]) => {
    if (String(to) === lockPath) iterations += 1;
    return (realRename as (...args: unknown[]) => unknown)(from, to, ...rest) as void;
  }) as typeof fs.renameSync;
  (Atomics as unknown as { wait: unknown }).wait = ((...args: unknown[]) => {
    sleeps += 1;
    return (realWait as (...a: unknown[]) => unknown).apply(Atomics, args);
  });
  try {
    body();
  } finally {
    mutableFs.renameSync = realRename;
    (Atomics as unknown as { wait: unknown }).wait = realWait;
  }
  return { iterations, sleeps };
}

test('the sleep is COUNTED, not timed: none on a progressing iteration, one on every fruitless one, and no spin', (t) => {
  // THE MUTANT THIS ROW EXISTS FOR is the one the row above cannot see and the
  // structural half cannot see either: `progressed` corrupted AFTER both reap arms
  // have run. Every reap still works, `sleepSync` still has exactly one call site,
  // and the guard is still spelled `if (!progressed) sleepSync(` — so both regexes
  // pass — while the loop hot-spins for the entire 1000 ms deadline on every
  // fruitless iteration, inside a hook. Against the twelve fenced suites it
  // survived two reps of three; the verdict was a coin flip on machine load.
  //
  // WHY COUNTING SURVIVES A LOADED MACHINE when every clock instrument drowned:
  // asserting that code does NOT sleep is asserting a LOWER BOUND ON ITS SPEED,
  // and load only ever removes speed. A COUNT of the syscall is not a rate at all.
  // Measured on this host at load average 74-88, three reps of each cell, the two
  // fixtures below separating in opposite directions:
  //
  //   variant                              progressing sleeps   fruitless sleeps   fruitless iterations
  //   shipped                              0, 0, 0              56, 53, 55         57, 54, 56
  //   L14 sleep unconditional              24, 27, 31           56, 61, 58         57, 62, 59
  //   L15 progressed always true           0, 0, 0              0, 0, 0            2 570, 3 208, 1 773
  //   L16 progressed corrupted late        0, 0, 0              0, 0, 0            1 056, 1 618, 1 459
  //
  // Zero against tens, in both directions, and no load can turn 0 into 55 or 55
  // into 0. The shipped loop's fruitless sleeps are its iterations minus exactly
  // one in every rep — the last iteration throws at the deadline before reaching
  // the sleep — which is why the assertion below is an equality up to that one.
  const fx = fixture();
  try {
    // THE INSTRUMENT, PROVEN LIVE BEFORE IT IS TRUSTED. `sleepSync` only reaches
    // `Atomics.wait` while a SharedArrayBuffer is available; on a host where it is
    // not, it busy-waits instead and every count here would read 0 — which is the
    // mutant's exact signature. So the wrapper is asked to count a wait this row
    // performs itself, and a blind instrument fails loudly rather than passing.
    const selfTest = sleepCensus('', () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    });
    assert.equal(
      selfTest.sleeps, 1,
      'FIXTURE the sleep counter must be able to see a wait at all. If `Atomics.wait` is not patchable '
      + 'or SharedArrayBuffer is unavailable here, sleepSync takes its busy-wait fallback and every count '
      + 'below reads 0 for a correct loop — indistinguishable from the mutant, so this row would pass '
      + 'vacuously.',
    );

    // FIXTURE A, every iteration PROGRESSES: a non-directory at the lock path,
    // re-planted after each clear, so the clear arm reports progress every time and
    // a correct loop never waits.
    const a = fx.project('sleep-progressing');
    const elsewhere = path.join(fx.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, a.lockPath);
    const replantUntil = Date.now() + ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS * 3;
    let clears = 0;
    const progressing = sleepCensus(a.lockPath, () => {
      clears = whileInterceptingUnlink(a.lockPath, {
        after: () => {
          if (Date.now() >= replantUntil) return;
          try { fs.symlinkSync(elsewhere, a.lockPath); } catch { /* the loop got there first */ }
        },
      }, () => {
        assert.throws(
          () => withProjectStateLock(a.cwd, () => { throw new Error('acquired'); }),
          /timed out/,
          'FIXTURE the adversary must outlast the deadline, or this cell measured an acquisition',
        );
      });
    });
    assert.ok(
      clears > 1 && progressing.iterations > 1,
      `FIXTURE the progressing fixture must go round more than once: ${clears} clears, `
      + `${progressing.iterations} iterations`,
    );
    assert.equal(
      progressing.sleeps, 0,
      `a loop that CLEARED something must retry the rename at once, and this one waited `
      + `${progressing.sleeps} times across ${progressing.iterations} iterations that every one of them `
      + `made progress on (${clears} clears). The sleep is for fruitless iterations; making it `
      + 'unconditional costs a hook up to the whole retry delay per clear and is invisible to elapsed '
      + 'time, to the error message, and to any count of iterations.',
    );

    // FIXTURE B, no iteration can progress: a lock held by a LIVE, legible owner.
    // Nothing is clearable (it is a directory), the observed-owner arm is refused
    // by `processAlive`, and the abandoned arm never runs. Every iteration is one
    // the sleep exists for.
    const b = fx.project('sleep-fruitless');
    fs.mkdirSync(b.lockPath);
    fs.writeFileSync(
      path.join(b.lockPath, 'owner-liveholder.json'),
      JSON.stringify({ pid: process.pid, token: 'liveholder', createdAt: Date.now() }),
      'utf8',
    );
    const fruitless = sleepCensus(b.lockPath, () => {
      assert.throws(
        () => withProjectStateLock(b.cwd, () => { throw new Error('acquired'); }),
        /timed out/,
        'FIXTURE a live legible holder must not be reapable, or this cell measured a reclaim',
      );
    });
    assert.ok(
      fruitless.iterations > 1,
      `FIXTURE the fruitless fixture must go round more than once: ${fruitless.iterations} iterations`,
    );
    assert.ok(
      fruitless.sleeps >= fruitless.iterations - 1,
      `every FRUITLESS iteration but the last must wait: ${fruitless.sleeps} sleeps across `
      + `${fruitless.iterations} iterations against a live holder that nothing can clear or reap. A loop `
      + 'that computes `progressed` wrongly keeps the guard, keeps its single call site, passes both '
      + 'regexes below — and never waits.',
    );
    // AND THE SPIN, WHICH IS THE DEFECT ITSELF. The count above says the loop
    // waited; this says it did not burn the deadline hot, and it is the assertion
    // no row had. An always-sleeping loop cannot exceed timeout/retry iterations
    // BY CONSTRUCTION, so the bound is that ceiling with room for the arms' own
    // work, and it is load-robust in the direction that matters: a slower machine
    // runs FEWER iterations, never more. Measured: 54-57 shipped against
    // 1 056-1 618 for the mutant, three reps each.
    const spinBound = 3 * (ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS / ONE_MCP_REPORT_ID_LOCK_RETRY_MS);
    assert.ok(
      fruitless.iterations <= spinBound,
      `the loop must not SPIN on a fruitless iteration: ${fruitless.iterations} passes round a `
      + `${ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS}ms deadline is above the ${spinBound} an honest `
      + `${ONE_MCP_REPORT_ID_LOCK_RETRY_MS}ms wait per iteration can produce. This is what a hook burning `
      + 'a full second of CPU looks like from outside: same elapsed time, same error message, same '
      + 'sleep spelling.',
    );
    t.diagnostic(
      `sleep census — progressing: ${progressing.sleeps} sleeps / ${progressing.iterations} iterations `
      + `(${clears} clears); fruitless: ${fruitless.sleeps} sleeps / ${fruitless.iterations} iterations `
      + `(spin bound ${spinBound})`,
    );
  } finally {
    fx.cleanup();
  }
});

test('a release proves ownership from the owner record\'s CONTENT, not from the path still being there', () => {
  // AN ABSENT FIXTURE, FOUND BY COUNTING RATHER THAN BY MUTATING. A branch-hit
  // census over these twelve suites — a counter on every branch a mutant sits
  // on — put `release: token mismatch` at 0 executions out of 1 074 collisions
  // and 58 releases, and a mutant that deletes the comparison outright therefore
  // survived the whole suite. That is an absent fixture and not an equivalent
  // program: nothing here ever put a FOREIGN owner record at the path a release
  // reads, so the one line that tells a lock of ours from a lock at our path was
  // never executed.
  //
  // The other way for that path to hold something not ours — a competitor's
  // directory, with its own `owner-<their-token>.json` — never reaches the
  // comparison at all: our owner NAME carries our token, so the read throws
  // ENOENT and the catch returns. Only a rewrite of the record at our own name
  // reaches it, which needs write access inside `.traffic-one/` — precisely the
  // actor `acquireProjectStateLock`'s mode docblock already grants can rename
  // this lock aside whatever its permissions. The check is defence in depth
  // against that actor, and the direction it errs in is deliberate: it leaves a
  // directory behind (later reaped on liveness, like any other abandoned lock)
  // rather than deleting a lease whose record says someone else holds it.
  const fx = fixture();
  try {
    // THE CONTROL FIRST, so "the directory survived" cannot be read as "release
    // never removes anything".
    const control = fx.project('release-control');
    withProjectStateLock(control.cwd, () => {
      assert.equal(fs.lstatSync(control.lockPath).isDirectory(), true, 'FIXTURE the control must hold a lock');
    });
    assert.equal(
      fs.existsSync(control.lockPath), false,
      'FIXTURE an untouched acquisition must release its own lock, or the row below proves nothing',
    );

    const a = fx.project('release-foreign-record');
    let ownerPath = '';
    withProjectStateLock(a.cwd, () => {
      const owners = ownerFiles(a.lockPath);
      assert.equal(owners.length, 1, `FIXTURE one owner file inside the held lock, found ${owners.length}`);
      ownerPath = path.join(a.lockPath, owners[0]!);
      const mine = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
      assert.equal(typeof mine.token, 'string', 'FIXTURE the owner record must carry a token to overwrite');
      // The rewrite, at our own name: same pid, same stamp, a different token.
      // Everything the release reads is legible; only the ownership claim moved.
      fs.writeFileSync(ownerPath, JSON.stringify({ ...mine, token: 'not-ours' }), 'utf8');
    });

    assert.equal(
      fs.existsSync(a.lockPath), true,
      'the release removed a lock whose own owner record says it is not ours. `releaseProjectStateLock` '
      + 'renames the lock directory aside and then removes it recursively, so dropping the token '
      + 'comparison destroys a lease held by whoever wrote that record — the same destruction the '
      + 'reapers\' compare-and-swap exists to prevent, on the way out instead of on the way in.',
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(ownerPath, 'utf8')).token, 'not-ours',
      'and it must leave the foreign record untouched rather than rewriting it',
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(a.lockPath)).filter((name) => name.endsWith('.released')), [],
      'nor may it leave a `.released` staging name behind: the rename must not have happened at all, '
      + 'which is a different claim from the directory merely existing at the end',
    );
  } finally {
    fx.cleanup();
  }
});
