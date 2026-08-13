// The plan text this file answers, verbatim: "Canonicalize the project root once
// (realpathSync plus case normalization) and derive all lock paths from it —
// /var vs /private/var, symlinks and case-insensitive APFS produce different
// lock paths for the same state file, silently voiding mutual exclusion."
//
// It was not done, and path-spelling-contract.test.ts beside this file states
// why in prose: the locks are FILESYSTEM compare-and-swaps, two spellings name
// one inode, exclusion holds. That claim was never driven. A settled claim with
// no test is indistinguishable from an oversight — which is exactly how the
// writer half of the same plan's "one durable writer" went missing — so it is
// driven here.
//
// THE CAS CLAIM IS CONDITIONAL, and the condition is not decoration: `rename`
// onto a directory is refused with ENOTEMPTY, but `rename` onto an EMPTY
// directory SUCCEEDS. What makes the project-state lock a compare-and-swap is
// therefore not the rename — it is that every acquirer writes its owner file
// INTO the staging dir before renaming, so a held lock is never empty. An empty
// lock dir is not a lock that fails safe, it is a lock that hands itself over,
// which state/project-state-lock.ts already knows and treats as a FEATURE:
// the sibling families' `reapAbandonedEmptyLock` leans on it, and the
// transient-EPERM retry path
// depends on the overwrite succeeding. Both halves are pinned below, against the
// kernel rather than from the manual page.
//
// REPRODUCED, macOS 25.5.0 / APFS, two REAL processes lined up on a shared
// wall-clock instant, each holding for 700 ms, across three spelling hazards
// (/private/var vs /var, a symlink at the project root, a case variant on a
// case-insensitive volume) and three lock families (withProjectStateLock,
// withOwnedDirLock, acquireQaRunLock). Nine races, nine HELD, no overlap. Both
// controls fired: two contenders on the SAME spelling serialized (so the
// harness sees exclusion), and two contenders on two DIFFERENT directories
// overlapped for the full 700 ms in all three families (so the harness can see
// a violation and the workers really are concurrent).
//
// What the child-process form proves and this file's form does not is that the
// two contenders are separate processes. What this file's form gets instead is
// speed and determinism: the refusal below comes from the kernel, and a nested
// acquisition in ONE process is contention the same way — withOwnedDirLock has
// no process-local memo, so nothing but the filesystem decides it.
//
// THE INVARIANT, stated so a future change can be checked against it: every
// lock path here is a pure STRING DERIVATION of the path it protects
// (`${path.join(path.resolve(cwd), STATE_FILE)}.report-id.lock`, `<runDir>/
// <name>.lock`), so a divergent spelling moves the lock and the protected file
// TOGETHER and the kernel folds both to one inode. Canonicalizing the lock
// derivation alone — the narrow fix the plan reaches for — would break that
// relation and replace a structural guarantee with a coincidence.
//
// The one thing a divergent spelling DOES cost is the last test here, and it is
// in-process, not cross-process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS } from '../../config/reporting';
import { withOwnedDirLock } from '../state/run-agent/locks';
import { withProjectStateLock } from '../state/project-state-lock';
import { recordPluginUseChoice } from '../state/plugin-use';
import { trackedTempDirs } from '../../test-support/__tests__/temp-dirs';

const dirs = trackedTempDirs('t1-lock-spelling-');
const SAVED = {
  prefs: process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
  state: process.env.XDG_STATE_HOME,
  ask: process.env.TRAFFIC_ONE_ASK_USE_PLUGIN,
};

test.after(() => {
  for (const [key, value] of Object.entries({
    TRAFFIC_ONE_PROJECT_PREFS_PATH: SAVED.prefs,
    XDG_STATE_HOME: SAVED.state,
    TRAFFIC_ONE_ASK_USE_PLUGIN: SAVED.ask,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  dirs.cleanup();
});

interface Spellings {
  /** The canonical spelling, and the project that actually exists. */
  readonly real: string;
  /** Same directory, symlinked at the root. */
  readonly linked: string;
  /** Same directory, reached through the `/var` -> `/private/var` link. */
  readonly viaVar: string | null;
  /** Same directory, different case — null on a case-SENSITIVE volume. */
  readonly cased: string | null;
  /** The composed-Unicode project the row below is a second spelling OF. */
  readonly composed: string;
  /**
   * Same directory, composed vs decomposed Unicode — null on a volume that does
   * not fold the two. A FOURTH hazard, and the one that most cleanly answers the
   * plan text: HFS+ normalizes to NFD on write, APFS preserves what it is given
   * but compares folded, and the two spellings arrive from different places for
   * free — a checkout name typed on macOS versus the same name from a git index,
   * a JSON config, or a shell completion. Two byte strings, one inode.
   */
  readonly unicode: string | null;
}

/**
 * One project, every spelling this machine can produce for it.
 *
 * `trackedTempDirs.make()` hands back a realpath'd root, so the non-canonical
 * twin is rebuilt from `os.tmpdir()`'s own unresolved form — on macOS that is
 * the `/var` -> `/private/var` link, for free, and on Linux there is none and
 * the row is skipped rather than faked.
 */
function project(): Spellings {
  const root = dirs.make();
  const real = path.join(root, 'MyProj');
  fs.mkdirSync(path.join(real, '.traffic-one', 'runs', 'R'), { recursive: true });
  const linked = path.join(root, 'alias');
  fs.symlinkSync(real, linked);

  // The NFC/NFD pair needs its own directory: the composed name has to be the
  // one on disk for the decomposed spelling to be a SECOND spelling of it.
  const composed = path.join(root, 'Cafe\u0301Proj'.normalize('NFC'));
  fs.mkdirSync(path.join(composed, '.traffic-one', 'runs', 'R'), { recursive: true });
  const decomposed = composed.normalize('NFD');
  const unicode = decomposed !== composed && fs.existsSync(decomposed) ? decomposed : null;

  // The unresolved spelling of the SAME tracked root, if this platform has one.
  const unresolvedRoot = findUnresolvedTwin(root);
  const viaVar = unresolvedRoot === null ? null : path.join(unresolvedRoot, 'MyProj');

  const lowered = path.join(root, 'myproj');
  const cased = fs.existsSync(lowered) ? lowered : null;

  // The consent fence, recorded under EVERY spelling: projectRootHash folds
  // symlinks but not CASE (pinned in path-spelling-contract.test.ts), so a
  // missing answer under one spelling would make the lock stand down for a
  // reason that has nothing to do with path derivation, and every assertion
  // below would pass vacuously.
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(root, 'prefs.json');
  process.env.XDG_STATE_HOME = path.join(root, 'machine-state');
  for (const spelling of [real, linked, viaVar, cased, composed, unicode]) {
    if (spelling) recordPluginUseChoice(spelling, true, 'test');
  }
  return { real, linked, viaVar, cased, composed, unicode };
}

/**
 * A second, NON-canonical spelling of `dir`, or null if this platform has none.
 * macOS's `/var` -> `/private/var` is the only one that exists for free.
 */
function findUnresolvedTwin(dir: string): string | null {
  const parts = dir.split(path.sep);
  for (let i = parts.length; i > 1; i -= 1) {
    const prefix = parts.slice(0, i).join(path.sep);
    const candidate = path.join(path.sep, 'var', ...parts.slice(i));
    if (prefix === path.join(path.sep, 'private', 'var') && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Every hazard this machine can construct, as (label, first spelling, second
 * spelling of THAT SAME directory). Three rows share the one project; the
 * Unicode row carries its own, because a decomposed name is only a second
 * spelling of the composed directory it was decomposed from.
 */
interface SpellingRow { readonly label: string; readonly base: string; readonly alt: string }

function alternatives(p: Spellings): readonly SpellingRow[] {
  const rows: SpellingRow[] = [{ label: 'a symlink at the project root', base: p.real, alt: p.linked }];
  if (p.viaVar) rows.push({ label: '/var vs /private/var', base: p.real, alt: p.viaVar });
  if (p.cased) rows.push({ label: 'a case variant on a case-insensitive volume', base: p.real, alt: p.cased });
  if (p.unicode) rows.push({ label: 'Unicode NFC vs NFD', base: p.composed, alt: p.unicode });
  return rows;
}

const LOCK = { timeoutMs: 120, staleMs: 60_000, retryMs: 5 } as const;

function lockDirFor(cwd: string): string {
  return path.join(cwd, '.traffic-one', 'runs', 'R', '.spelling.lock');
}

test('a divergent spelling does not void mutual exclusion — the refusal comes from the kernel', () => {
  const p = project();
  const rows = alternatives(p);

  // FIXTURE READBACK. Every row must be a genuine second spelling of ONE
  // directory; a row that is two directories would report "excluded" for the
  // trivial reason and prove nothing.
  assert.ok(rows.length >= 1, 'FIXTURE this platform produced no alternative spelling at all');
  // macOS is where all four hazards exist, and it is the machine this was
  // reproduced on. Letting it quietly degrade to the symlink row alone would
  // drop the spellings the plan text actually names.
  if (process.platform === 'darwin') {
    assert.deepEqual(
      rows.map((row) => row.label),
      [
        'a symlink at the project root',
        '/var vs /private/var',
        'a case variant on a case-insensitive volume',
        'Unicode NFC vs NFD',
      ],
      'FIXTURE on macOS all four spelling hazards must be constructible',
    );
  }
  for (const { label, base, alt } of rows) {
    assert.notEqual(alt, base, `FIXTURE [${label}] must be a DIFFERENT string`);
    assert.equal(
      fs.statSync(alt).ino, fs.statSync(base).ino,
      `FIXTURE [${label}] must be the SAME inode`,
    );
    assert.notEqual(
      lockDirFor(alt), lockDirFor(base),
      `[${label}] the two spellings no longer derive DIFFERENT lock path strings. If that is because `
      + 'the lock derivation now CANONICALIZES, this test has stopped answering the plan text and the '
      + 'lock has lost the property that makes exclusion sound: the lock path is a pure STRING '
      + 'DERIVATION of the file it protects, so a divergent spelling moves the lock and the protected '
      + 'file TOGETHER and the kernel folds both to one inode. Canonicalizing the lock alone leaves the '
      + 'protected path un-canonicalized and replaces that structural guarantee with a coincidence. It '
      + 'also cannot be done where it would be needed: `realpathSync` THROWS ENOENT on a path that does '
      + 'not exist yet (pinned below), which is every project onboarding has not created a '
      + '`.traffic-one` directory in — the exact moment the first lock is taken.',
    );
  }

  for (const { label, base, alt } of rows) {
    let outerRan = false;
    let innerHeld: boolean | null = null;
    const held = withOwnedDirLock(
      lockDirFor(base), LOCK.timeoutMs, LOCK.staleMs, LOCK.retryMs,
      new Int32Array(new SharedArrayBuffer(4)),
      () => {
        outerRan = true;
        // withOwnedDirLock keeps NO process-local memo, so this contends
        // through the filesystem exactly as a second process would.
        innerHeld = withOwnedDirLock(
          lockDirFor(alt), LOCK.timeoutMs, LOCK.staleMs, LOCK.retryMs,
          new Int32Array(new SharedArrayBuffer(4)),
          () => { /* two holders in one critical section, if we get here */ },
        );
      },
    );
    assert.equal(held, true, `FIXTURE [${label}] the outer lock must be taken`);
    assert.equal(outerRan, true, `FIXTURE [${label}] the critical section must run`);
    assert.equal(
      innerHeld, false,
      `[${label}] a second spelling took a lock this process already holds. The lock is a `
      + 'non-recursive mkdir and both spellings name one inode, so this can only mean the lock '
      + 'derivation stopped being a pure string derivation of the protected path. '
      + 'Cross-process reproduction on this machine: 9 races (3 spellings x 3 lock families), '
      + '9 HELD, with a two-different-directories control that overlapped for the full 700 ms.',
    );
  }

  // The control. If a lock at an UNRELATED path were also refused, the row
  // above would be measuring a broken lock rather than exclusion.
  const other = dirs.make();
  fs.mkdirSync(path.join(other, '.traffic-one', 'runs', 'R'), { recursive: true });
  process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(other, 'prefs.json');
  recordPluginUseChoice(other, true, 'test');
  let unrelatedHeld: boolean | null = null;
  withOwnedDirLock(
    lockDirFor(p.real), LOCK.timeoutMs, LOCK.staleMs, LOCK.retryMs,
    new Int32Array(new SharedArrayBuffer(4)),
    () => {
      unrelatedHeld = withOwnedDirLock(
        lockDirFor(other), LOCK.timeoutMs, LOCK.staleMs, LOCK.retryMs,
        new Int32Array(new SharedArrayBuffer(4)),
        () => { /* a different project must not be blocked by this one */ },
      );
    },
  );
  assert.equal(unrelatedHeld, true, 'CONTROL two different projects must not exclude each other');
});

// ── what a divergent spelling USED to cost, and no longer does ───────────────

// `withProjectStateLock`'s process-local re-entrancy memo is a Set keyed by the
// lock path STRING, so a nested acquisition under a second spelling missed it,
// contended with a lock THIS process holds, and — since no reap fires against a
// live owner whose pid is our own — spun to the 1 s acquisition deadline and
// threw out of a hook. Measured before the fix, one row per hazard:
// 1004 / 1007 / 1004 / 1006 ms, then "traffic-one project state lock timed out
// after 1000ms", against 1 ms for the same-spelling control.
//
// It was held unreachable by an import-closure proof
// (path-spelling-contract.test.ts) and that proof is worth keeping, but a
// hand-maintained static argument standing between a hook and a throw is the
// wrong load-bearing member. state/project-state-lock.ts now answers the
// question directly at the point of contention: it stats the directory it
// collided with, and a dev+ino it already holds is not a contender, it is us.
// Re-entering is the same answer the fast path gives to the same nesting
// spelled identically. (It used to ask this of the OWNER FILE's pid and token
// instead — see the three-sided discriminator below for why that could not
// decide it.)
//
// So the closure proof is demoted from "the fix" to an early warning — it still
// fails loudly when a lock body gains the ability to re-derive a root, which is
// worth knowing for reasons beyond this deadline — and this test now pins the
// structural property: EVERY spelling of one project is re-entrant, at memo
// speed, and none of them can throw.
/** Renames whose DESTINATION is a project-state lock, which is one per iteration
 * of the acquisition loop — the staging directory is renamed into place, and a
 * failure of that rename is the collision the loop then reasons about. Release
 * renames the other way (out of the lock path) and is deliberately not counted.
 * Counted through the same `fs` module object the lock body calls, since that is
 * the only place the count exists.
 *
 * Matched on the BASENAME rather than on a path string, which is the whole point
 * of the file: a nested acquisition under a second spelling renames onto a
 * different string naming the same inode, and a string comparison here would
 * count it as zero and read as re-entrancy. Every row of this file drives one
 * project, so a basename match cannot pick up a stranger's lock. */
function whileCountingLockRenames(body: () => void): number {
  const mutableFs = createRequire(__filename)('fs') as { renameSync: typeof fs.renameSync };
  const real = mutableFs.renameSync;
  let onto = 0;
  mutableFs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (path.basename(String(to)) === '.one.json.report-id.lock') onto += 1;
    return real(from, to);
  }) as typeof fs.renameSync;
  try {
    body();
  } finally {
    mutableFs.renameSync = real;
  }
  return onto;
}

test('a nested acquisition is re-entrant under EVERY spelling, not just the memoized one', () => {
  const p = project();
  const rows = alternatives(p);
  assert.ok(rows.length >= 1, 'FIXTURE this platform produced no alternative spelling');

  // "DECIDED AT THE FIRST COLLISION" IS A COUNT, NOT A DURATION, and this row
  // used to assert it with a 500 ms cap. Each iteration of the acquisition loop
  // is exactly one `rename` onto the lock path, so the shipped answer is the
  // outer acquisition's own rename plus ONE collision, and a loop that cannot
  // recognise itself spends its whole retry budget instead: measured 65 renames
  // against 2, with the mutant's ceiling ~100 (timeout/retry) whatever the
  // machine. The cap could not say that without also saying how fast this machine
  // is: it reddened the SHIPPED path at load average 67, where one contended
  // iteration costs 14-20 ms, while the failing side it was chosen to catch
  // (1004/1007/1004/1006 ms) never moved. The wall clock is kept below purely as
  // a deadlock detector, at a multiple of the deadline it is bounded by rather
  // than at a figure between the two populations.
  let sameSpellingRan = false;
  const sameSpellingCollisions = whileCountingLockRenames(() => {
    withProjectStateLock(p.real, () => {
      withProjectStateLock(p.real, () => { sameSpellingRan = true; });
    });
  });
  assert.equal(sameSpellingRan, true, 'CONTROL a nested acquisition under ONE spelling is re-entrant');
  assert.equal(
    sameSpellingCollisions, 1,
    'CONTROL the memoized nesting must not contend at all beyond the outer acquisition\'s own rename: '
    + `${sameSpellingCollisions} renames onto the lock path`,
  );

  for (const { label, base, alt } of rows) {
    let innerRan = false;
    let thrown: string | null = null;
    const t1 = Date.now();
    const collisions = whileCountingLockRenames(() => {
      try {
        withProjectStateLock(base, () => {
          withProjectStateLock(alt, () => { innerRan = true; });
        });
      } catch (error) {
        thrown = (error as Error).message;
      }
    });
    const elapsedMs = Date.now() - t1;

    // The count first, deliberately: the throw below is the SYMPTOM this row was
    // written for and the count is the property, so a regression should report
    // how many times the loop went round rather than that it eventually gave up.
    assert.equal(
      collisions, 2,
      `[${label}] re-entrancy must be decided at the FIRST collision, not after a spin: the outer frame `
      + 'is below us on the stack and cannot release until we return, so every further iteration is a wait '
      + 'on ourselves. Expected the outer acquisition\'s own rename plus exactly one collision from the '
      + `nested one; counted ${collisions} renames onto the lock path in ${elapsedMs} ms, ${thrown}`,
    );
    assert.equal(
      thrown, null,
      `[${label}] a second spelling of a lock this process holds must not throw out of a hook. `
      + 'The self-contention branch in state/project-state-lock.ts recognises our own pid and token on '
      + `the owner file it collided with. Measured before that branch existed: ~1005 ms, then this. `
      + `This run: ${elapsedMs} ms, ${thrown}`,
    );
    assert.equal(innerRan, true, `[${label}] the inner body must run`);
    assert.ok(
      elapsedMs < ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS * 3,
      `[${label}] and the call must return at all: took ${elapsedMs} ms against a `
      + `${ONE_MCP_REPORT_ID_LOCK_TIMEOUT_MS} ms acquisition deadline`,
    );
  }
});

// The discriminator, from THREE sides. The branch used to accept a pid+token
// conjunction and the first two rows below were written for its two conjuncts;
// the third is the leg neither of them covered, and it is the one that was
// actually broken.
//
//   pid alone is not enough — pids are reused, so a dead stranger's lock can
//     wear ours, and it must still take the liveness path rather than be
//     mistaken for our own hold;
//   token alone is not enough — the token is what we could positively
//     recognise, but recognising a string is not recognising a PROCESS, and an
//     owner file is a thing on disk that any other writer can produce;
//   BOTH TOGETHER are still not enough — and this is the leg the conjunction
//     could not express at all. `heldTokens` was keyed by the token, so a match
//     proved "this process minted this for SOME lock" and never "for THIS
//     lock". A byte-for-byte copy of our own LIVE owner file, planted at a
//     DIFFERENT project's lock, satisfied both conjuncts and re-entered in
//     1 ms — running a `.one.json` transaction with no hold at all, silently,
//     where before that branch existed the same planted file cost a stall and a
//     loud throw. The branch now identifies the collided-with DIRECTORY by
//     dev+ino instead, which is lock-specific and is not a claim anything an
//     attacker writes can make.
//
// The first two rows are kept as the pid/token regression even though the
// implementation no longer reads either field: what they assert is a BEHAVIOUR
// (a planted owner file is a contender), and that behaviour must survive
// whatever the branch is keyed on next.
//
// Every row plants an owner with a FRESH `createdAt`, so no reap can fire on age
// and the branch under test is the only thing that could end the acquisition
// early. Each row therefore costs one acquisition timeout, which is the price of
// asserting that the lock still WAITS.
function lockPathFor(cwd: string): string {
  return `${path.join(path.resolve(cwd), '.traffic-one', '.one.json')}.report-id.lock`;
}

function plantOwner(lockPath: string, owner: { pid: number; token: string }): void {
  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(lockPath, `owner-${owner.token}.json`),
    JSON.stringify({ ...owner, createdAt: Date.now() }),
    { encoding: 'utf8', mode: 0o600 },
  );
}

function tokenOfLiveHold(lockPath: string): string {
  const names = fs.readdirSync(lockPath);
  assert.equal(names.length, 1, 'FIXTURE a held lock has exactly one owner file');
  const token = /^owner-(.+)\.json$/.exec(names[0]!)?.[1];
  assert.ok(token, `FIXTURE could not read the live token off ${names[0]}`);
  return token;
}

test('an owner file wearing our pid but a token we do not hold is a CONTENDER, not ourselves', () => {
  const p = project();
  const lockPath = lockPathFor(p.real);
  // Our own pid, deliberately: `processAlive` says yes, so the ONLY thing that
  // could end this acquisition early is the token half of the condition.
  plantOwner(lockPath, { pid: process.pid, token: 'not-a-token-this-process-minted' });

  let bodyRan = false;
  let thrown: string | null = null;
  try {
    withProjectStateLock(p.real, () => { bodyRan = true; });
  } catch (error) {
    thrown = (error as Error).message;
  }

  assert.equal(bodyRan, false, 'the body must NOT run: this lock belongs to somebody else');
  assert.match(
    thrown ?? '', /project state lock timed out/,
    'a live foreign owner must still be waited for and then reported. If this passed the body through, '
    + 'the self-contention branch is keying on the pid alone and a pid-reusing OS now hands one project '
    + `two concurrent .one.json writers. Got: ${thrown}`,
  );

  fs.rmSync(lockPath, { recursive: true, force: true });
});

test('an owner file carrying a token we DO hold, under another pid, is a contender too', () => {
  const mine = project();
  const theirs = project();
  const theirLock = lockPathFor(theirs.real);

  let bodyRan = false;
  let thrown: string | null = null;
  withProjectStateLock(mine.real, () => {
    // A token this process minted and is holding RIGHT NOW, read off our own
    // live lock — the strongest string a stranger's owner file could carry.
    // pid 1 is alive on every supported platform, so liveness cannot end this
    // acquisition either.
    plantOwner(theirLock, { pid: 1, token: tokenOfLiveHold(lockPathFor(mine.real)) });
    try {
      withProjectStateLock(theirs.real, () => { bodyRan = true; });
    } catch (error) {
      thrown = (error as Error).message;
    }
  });

  assert.equal(bodyRan, false, 'the body must NOT run: another process owns that project\'s lock');
  assert.match(
    thrown ?? '', /project state lock timed out/,
    'a token match alone identifies a STRING, not a process: whoever wrote that owner file is not this '
    + 'process, and letting its body through puts two writers inside one project\'s .one.json '
    + `transaction. Got: ${thrown}`,
  );

  fs.rmSync(theirLock, { recursive: true, force: true });
});

test('OUR OWN live owner file, copied byte for byte to another project\'s lock, is a contender', () => {
  // The leg a pid+token conjunction structurally could not decide, and the one
  // that was broken: both conjuncts hold — our real pid, our real live token —
  // and the lock is still SOMEBODY ELSE'S. Planting this needs nothing but
  // write access to the other project, which is the access the lock exists to
  // survive, and the old branch re-entered on it in 1 ms and ran the
  // transaction unserialized.
  //
  // With the pid placeholder this row used to carry (`pid: 1`) it is the test
  // above and passes either way; with the REAL pid it is red against a
  // token-keyed branch and green against an inode-keyed one.
  const mine = project();
  const theirs = project();
  const theirLock = lockPathFor(theirs.real);

  let bodyRan = false;
  let thrown: string | null = null;
  withProjectStateLock(mine.real, () => {
    const myLock = lockPathFor(mine.real);
    const names = fs.readdirSync(myLock);
    assert.equal(names.length, 1, 'FIXTURE a held lock has exactly one owner file');
    fs.mkdirSync(theirLock, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(theirLock, names[0]!),
      fs.readFileSync(path.join(myLock, names[0]!)),
      { mode: 0o600 },
    );
    // FIXTURE READBACK: the copy really is byte-identical and really does wear
    // this process's pid, or the row proves nothing.
    const planted = JSON.parse(fs.readFileSync(path.join(theirLock, names[0]!), 'utf8')) as { pid: number };
    assert.equal(planted.pid, process.pid, 'FIXTURE the planted owner must carry OUR pid');

    const startedAt = Date.now();
    try {
      withProjectStateLock(theirs.real, () => { bodyRan = true; });
    } catch (error) {
      thrown = (error as Error).message;
    }
    assert.ok(
      Date.now() - startedAt > 200,
      'a re-entrant decision is reached in ~1 ms; anything that fast here means the branch accepted a '
      + 'file the other project could write',
    );
  });

  assert.equal(
    bodyRan, false,
    'the body must NOT run. It is another project\'s lock, on another inode, and the only thing saying '
    + 'otherwise is a file anyone with write access to that project could have produced.',
  );
  assert.match(
    thrown ?? '', /project state lock timed out/,
    'self-contention must be decided from the DIRECTORY (dev+ino), not from the owner file\'s contents. '
    + 'Keying on the token alone proves "this process minted this for SOME lock", never "for THIS lock", '
    + `and the failure is a silently unserialized state transaction. Got: ${thrown}`,
  );

  fs.rmSync(theirLock, { recursive: true, force: true });
});

test('every alternative spelling of one project names one dev+ino — what the branch now keys on', () => {
  // The positive half, asserted directly rather than inferred from the timing
  // of the re-entrancy test above. If two spellings did NOT name one inode, an
  // inode-keyed branch would answer "not us" for the exact case it exists to
  // serve, and every nested acquisition under a second spelling would go back
  // to spinning to the deadline — the ~1005 ms hazard, silently restored. It is
  // also the same fact the CAS argument in this file's header rests on, so a
  // platform where it stops holding breaks far more than this branch.
  const p = project();
  const rows = alternatives(p);
  assert.ok(rows.length >= 1, 'FIXTURE this platform produced no alternative spelling');
  for (const { label, base, alt } of rows) {
    const a = fs.statSync(base, { bigint: true });
    const b = fs.statSync(alt, { bigint: true });
    assert.equal(`${a.dev}:${a.ino}`, `${b.dev}:${b.ino}`, `[${label}] two spellings, one directory`);
  }
});

// ── the two load-bearing facts the prose rests on, driven ────────────────────

// Both are quoted as reasons elsewhere (the CAS qualifier in this file's header
// and in state/project-state-lock.ts; the ENOENT throw in the tripwire message
// above and in that same docblock) and neither was asserted anywhere. A reason
// nobody checks is a reason that can quietly stop being true.
test('the rename CAS holds only against a NON-EMPTY lock dir, and realpath throws on a path not created yet', () => {
  const root = dirs.make();

  const from = path.join(root, 'staging');
  const ontoEmpty = path.join(root, 'empty-lock');
  fs.mkdirSync(from, { recursive: true });
  fs.mkdirSync(ontoEmpty, { recursive: true });
  fs.renameSync(from, ontoEmpty);
  assert.equal(
    fs.existsSync(ontoEmpty), true,
    'rename onto an EMPTY directory SUCCEEDS. This is why the owner file is written INTO the staging '
    + 'dir before the rename, and why an empty lock can be treated as free.',
  );

  const from2 = path.join(root, 'staging2');
  const ontoHeld = path.join(root, 'held-lock');
  fs.mkdirSync(from2, { recursive: true });
  fs.mkdirSync(ontoHeld, { recursive: true });
  fs.writeFileSync(path.join(ontoHeld, 'owner-x.json'), '{}', 'utf8');
  assert.throws(
    () => fs.renameSync(from2, ontoHeld),
    (error: NodeJS.ErrnoException) => error.code === 'ENOTEMPTY' || error.code === 'EEXIST',
    'rename onto a lock dir holding an owner file is refused — THAT is the compare-and-swap',
  );

  assert.throws(
    () => fs.realpathSync(path.join(root, 'not-yet', 'project')),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    'realpathSync throws on a path that does not exist yet. Onboarding hits exactly this: the first '
    + 'lock is taken for a project with no `.traffic-one` directory, so "canonicalize the lock path" '
    + 'is not merely redundant, it is unavailable at the moment it would first be needed.',
  );
  assert.throws(
    () => fs.realpathSync(path.join(root, 'leaf-that-is-absent')),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    'and an absent LEAF under an existing parent throws too — it is not only the missing-parent case',
  );
});
