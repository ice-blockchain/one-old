// src/shared/bounded-read.ts
// Reading a file whose SHAPE somebody else chose, in bounded time.
//
// A LEAF on purpose — `fs`, nothing else, ever, for the reason state-root.ts is
// one. THE RULE, which is all this header will say about who depends on it: the
// consumers are whoever imports it, every one of them is reached from the
// dependency-free hook runtime, and anything needing config, a host or a path
// resolver belongs in the caller. `__tests__/bounded-read-census.test.ts`
// enumerates the importers and pins the leaf claim; read the count there, where
// it is derived, and change a caller only after reading that list.
//
// THE RULE REPLACES A HAND-WRITTEN LIST THAT WAS WRONG TWICE, and both false
// versions are recorded rather than quietly corrected, because the shape of the
// mistake is the shape of the defect this file keeps finding. It first read "the
// two callers are one-settings.ts and project-state-lock.ts". It was then
// corrected to "the callers are one-settings.ts, project-state-lock.ts and
// fsjson.ts" — and that version was false by TWELVE FILES on the day it was
// written, in the same round, while the paragraph below it closed "a caller list
// that is allowed to go stale is the same instrument as a copy that is allowed to
// drift". What that cost was not cosmetic: the list was this file's only
// statement about blast radius, so a maintainer tightening the leaf read "three
// callers, all lock/state readers" while in fact moving every plan-readiness
// check, both react-structure scanners, plan-write's reconstruction,
// build-complete and SessionStart. A corrected NUMBER would only have been a
// third thing to keep true, so the number left the file.
//
// fsjson.ts's adoption is what the second version was written for, and it stays
// here because it is the measurement: `readText` and `readJsonResult` were the
// THIRD pair of structurally identical bare readers, planted with the same FIFO
// and hung the same way (DRIVEN, load 7.05 → 7.33: a FIFO
// at `.traffic-one/.one.json` SIGKILLed `readJsonResult` at 12 014 ms and
// `readText` at 12 011 ms, a symlink to `/dev/zero` SIGKILLed at 20 151 ms,
// against a 0 ms regular-file control).
//
// THE CLASS IS BOUNDED BY A CENSUS, NOT BY THIS FILE'S REACH, and that is the
// other half of what the stale list was hiding. Adopting this leaf closes the
// addresses somebody looked at; it says nothing about the next one.
// `__tests__/bounded-read-census.test.ts` inverts that: every call in production
// source that OPENS A PATH AND READS IT is an offender unless it reads an
// `fstat`-guarded descriptor, is an open proved bounded by its flags, or carries
// a one-line reason in that file's allowlist. The allowlist is the count; read it
// there, where it is derived, rather than here.
//
// THIS PARAGRAPH ALSO CARRIED A NUMBER, in the file whose whole lesson is that a
// number in prose goes stale, and it went stale the same round it was written.
// It read "160 sites in 98 files carry a reason today, and a new bare read reds
// whether it lands in one of those files or in a hundred-and-ninety-ninth" —
// where the next file after the ninety-eighth is the ninety-ninth, and where the
// two figures were in any case an artefact of asking only about `readFileSync`.
// Resolving the fs BINDING by AST and classifying the resolved api moved both:
// three rows disappeared (a `readFileSync` inside an emitted template literal is
// not a call), and the clipped `openSync('r')`+`readSync` readers, the
// `createReadStream`s and the `copyFileSync` source reads that no `readFileSync`
// scan could see appeared. The remedy is the one the caller list got: state the
// rule, and leave the arithmetic to the test that derives it.
//
// EXTRACTED RATHER THAN COPIED, and the copy is what this replaces. The
// allowlist below was written for state/project-state-lock.ts, whose lock
// protocol one-settings.ts had already been ported from twice (atomic
// publication, token-addressed reaping, EPERM read as `not-ours`) — and the one
// property that did NOT travel with those ports is the one that bounds the
// read. So the structurally identical readers in one-settings.ts still called
// bare `readFileSync`, and the same planted object hung them the same way. A
// third copy of the argument is a third place to get it wrong; a shared leaf is
// what makes the next port carry it by construction.

import * as fs from 'fs';

// Two refusals plus one, and the POSIX-only ones fold to nothing on Windows,
// which has neither shape to refuse.
const REGULAR_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
const OWNER_READ_FLAGS = REGULAR_READ_FLAGS | (fs.constants.O_NOFOLLOW || 0);

// ── THE HOSTILE-SHAPE TAXONOMY, DRIVEN ───────────────────────────────────────
//
// For three rounds the corpus was two shapes: a FIFO, and a symlink to
// /dev/zero. The first person to try a THIRD (a dangling symlink) found a live
// spin in the exhausted-models lock. Two shapes is not a taxonomy, it is the
// example that started the lane, so here is the space enumerated on purpose.
//
// Measured on darwin 25.5.0, each arm in its own child with the deadline
// enforced by the PARENT (spawnSync SIGKILL), because an in-process timer is a
// callback on an event loop that a blocking `open` is holding. The table is
// EXECUTABLE — __tests__/bounded-read-taxonomy.test.ts plants every shape and
// drives every export — because a table in a comment is exactly the instrument
// this lane keeps catching itself using.
//
// The last column is the one that decides how much any of this matters. Git
// stores a symlink as a mode-120000 blob whose contents are the target path, so
// EVERY symlink row arrives through an ordinary `git clone` with no local
// process and no attacker on the box — it arrives in a pull request. A FIFO, a
// socket and a device node have no git representation at all and need somebody
// running `mkfifo` on the machine first.
//
//   SHAPE                  leaf                     caller sees          in git?
//   regular (control)      text                     the bytes            yes
//   FIFO                   fstat refuses            null / ENOTREG       NO
//   hard link to a FIFO    fstat refuses            null / ENOTREG       NO
//   symlink -> FIFO        fstat refuses (regular)  null / ENOTREG       YES 120000
//                          ELOOP at open (owner)    not-ours
//   symlink -> /dev/zero   fstat refuses            null / ENOTREG       YES 120000
//   /dev/zero direct       fstat refuses            null / ENOTREG       NO
//   /dev/random direct     fstat refuses            null / ENOTREG       NO
//   /dev/full direct       ENOENT (absent on mac)   missing-file branch  NO
//   block device           EPERM                    unreadable branch    NO
//   dangling symlink       ENOENT (regular)         missing-file branch  YES 120000
//                          ELOOP  (owner)           not-ours
//   symlink loop           ELOOP                    unreadable branch    YES 120000
//   symlink -> regular     FOLLOWED (regular)       the bytes            YES 120000
//                          ELOOP    (owner)         not-ours
//   symlink chain 41 deep  ELOOP, past SYMLOOP_MAX  unreadable branch    YES 120000
//   directory              fstat refuses            null / ENOTREG       no (a tree)
//   unix socket            ENOTSUP (-102)           unreadable branch    NO
//
// THE ROW ABOVE ALREADY CARRIED A FALSE FIGURE ONCE, mine, in this round. The
// first pass of the probe reported "symlink chain, 41 deep — FOLLOWED, text(8)",
// which would have meant the kernel had no depth limit worth the name. It built
// the chain from the far end and then drove the FIRST link it created, so the
// path under test was one link deep, not forty-one. A real 41-deep chain ELOOPs
// on darwin, where SYMLOOP_MAX is 32. The two cases are now separate rows,
// because they answer differently and the difference is the whole point of the
// depth limit.
//
// NOT ONE ARM BLOCKS. Every refusal is a syscall returning an error or an fstat
// answering a question, and both are immediate. The three FIFO rows are the ones
// that matter, because those are the ones where `fs.readFileSync` on the same
// path is still sitting in `open(2)` when the parent SIGKILLs it at 4004 ms.
//
// TWO ROWS EXPLAIN THE FLAGS, and they are the reason there are two constants.
//
// `REGULAR_READ_FLAGS` deliberately omits O_NOFOLLOW: an ordinary config file is
// allowed to be a symlink, and refusing every link would break projects that did
// nothing wrong. What makes that safe is that the bound does NOT come from
// refusing the link — it comes from O_NONBLOCK (so the open of a FIFO returns
// instead of waiting for a writer) plus `fstat` ON THE DESCRIPTOR (so what is
// classified is the object actually opened, with no window between the check and
// the read). Hence the two symlink-to-hostile rows above refuse at fstat rather
// than at open, and the 41-deep chain to a regular file is simply followed and
// read, which is the correct answer.
//
// `OWNER_READ_FLAGS` adds it because a lock owner sentinel is a DIFFERENT
// question: there, a link is already an answer — the file we wrote is not a link,
// so a link at that path is not our record, and ELOOP means `not-ours` rather
// than `unreadable`. That distinction is what the exhausted-models lock steals
// on when it is lost.
//
// THE CORRECTION ROUND 3 IS OWED. Its allowlist excused
// `scaffold-content.ts`'s `openSync(O_RDWR|O_NOFOLLOW)` on the ground that "that
// OPEN blocks BEFORE the fstat guard, so the fd rule does not reach it". FALSE,
// and in the safe direction: measured above, O_RDWR on a FIFO opens in 0 ms
// (O_RDWR is both ends, so there is nobody to wait for) and O_NOFOLLOW ELOOPs
// every symlink. The site was never plantable. A wrong reason is worse than a
// missing one — it sends the next round at a non-defect — so the row is recorded
// here rather than silently dropped when the file left the allowlist.

/**
 * Read a path, or null when something is THERE and it is not a regular file.
 * NEVER blocks on what the name leads to.
 *
 * `fs.readFileSync(path)` — which every caller of this used to call — has no
 * bound at all on two shapes. `open(O_RDONLY)` on a FIFO WAITS for a writer,
 * forever, and a character device answers a read as long as anybody keeps
 * asking. DRIVEN twice, at two different sets of readers, one shape per child
 * process under a hard alarm:
 *
 *   state/project-state-lock.ts (the deviations lane, load 68.86 → 83.65) — a
 *   FIFO named `owner-<anything>.json` and a symlink to `/dev/zero` each made a
 *   single acquisition run 25 s and 60 s without returning, fresh and aged, and
 *   through BOTH of that file's readers.
 *
 *   one-settings.ts (load 13.60 → 21.62, one child per case under a 12 000 ms
 *   SIGKILL) — a FIFO at `owner-deadbeef.json` in the lock directory hung
 *   `withMachineFileLock` at the override ledger path and `updateOneSettings`
 *   alike, with the stray-beside-it variant (which routes the read through
 *   `reapAbandonedLock` instead of the strict reader) hanging
 *   too: four cases, four SIGKILLs at 12 000 ms, against controls of 2 ms
 *   (plain), 7 ms and 14 ms (dead-pid owner). `traffic-one override` never
 *   returns there, no timeout fires, nothing is logged, and every
 *   `updateOneSettings` caller on the machine inherits it.
 *
 * A deadline cannot bound it, because a deadline is tested BETWEEN iterations —
 * so a read that blocks inside one is unbounded, which is the outcome
 * project-state-lock.ts ranks worst in its own words: "a hook that never returns
 * is worse than one that fails closed — an unbounded loop cannot even be
 * reported".
 *
 * AN ALLOWLIST — open iff REGULAR — and that is the whole design rather than an
 * implementation note. The enumeration this replaces (catch EISDIR, catch ELOOP,
 * …) is a denylist of spellings: a FIFO and a device node each need their own
 * row in it, and the next kind nobody thought of needs another. Asking the
 * positive question needs no such list, and it is the same shape as the
 * contended-errno set in either lock's retry loop, which is an allowlist for the
 * same reason.
 *
 * DECIDED ON THE DESCRIPTOR, NOT ON THE PATH. `lstat` then `readFileSync` would
 * classify one object and read another: anybody who can write in the directory
 * can substitute the name between the two calls, which is precisely the
 * population these readers exist for. `fstat` describes the object the fd
 * already refers to, so there is nothing left to substitute — the same reason
 * `reapObservedLock` is keyed on what was OBSERVED rather than on a path.
 *
 * Each flag refuses one thing:
 *   O_NONBLOCK   a FIFO with no writer opens instead of waiting (measured: 0 ms).
 *   O_NOFOLLOW   a symlink is refused AT the open (ELOOP) rather than followed.
 *                See `readOwnerEntry`, which is the caller that needs it; it is
 *                about WHOSE evidence answers, not about boundedness, and it is
 *                the one refusal `readRegularFile` deliberately does without.
 *   the fstat    a directory or a device is PRESENCE, unopened, instead of an
 *                EISDIR to classify or an endless read to survive.
 *
 * THE KIND TEST IS NOT REDUNDANT WITH THE FLAGS, and the mutant that proves it
 * fails in a direction worth writing down. `FSTAT-DROP` — keep this exact open,
 * read the descriptor unconditionally — does NOT hang: a FIFO with no writer and
 * O_NONBLOCK reads as EOF, so the bytes are EMPTY. The fresh-FIFO row then STEALS
 * the lock (measured, by the deviations lane: reclaimed where it must refuse)
 * rather than hanging. So the flags remove the block and the fstat is what
 * converts the shape into PRESENCE; each without the other is a different defect.
 *
 * WHERE THOSE EMPTY BYTES LAND IS PER CALLER, and this paragraph used to say
 * they land on "the ABSENCE side of every caller's split" — which was true of the
 * two lock readers it was written for and is FALSE of the third caller. In
 * `readRegularFileResult`'s consumer (fsjson.ts's `readJsonResult`) an empty
 * parse failure is `corrupt`, and `corrupt` is the arm that CARRIES THE BYTES so
 * a caller may preserve them and replace the file. Absence licenses a write;
 * corrupt licenses a REPLACEMENT. So under FSTAT-DROP a FIFO at `.one.json`
 * stops being a hang and becomes a licence to destroy it, and the kind test is
 * load-bearing in two different directions at once.
 *
 * IT THROWS RATHER THAN ANSWERING for a path that cannot be opened at all, and
 * every caller already has a catch: ENOENT — a name that vanished between a
 * listing and this read — is a transient, and folding it into `null` would make
 * "absent" and "present but not a file" the same answer at readers that decide
 * opposite things about them (see `reapAbandonedLock` in both files).
 *
 * THE RESIDUAL IS THE MEDIUM, NOT THE SHAPE, and no flag reachable from here
 * touches it: O_NONBLOCK does not apply to regular files, so a regular file on
 * an unresponsive networked mount still blocks in the kernel, and a 48 MB one is
 * still read in full (project-state-lock.ts's deadline docblock prices that).
 * What the flags remove is every shape whose COST IS UNBOUNDED BY CONSTRUCTION
 * rather than by how much somebody wrote.
 */
interface Opened {
  readonly fd: number;
  readonly stat: fs.Stats;
}

/**
 * THE ONLY `openSync` IN THIS FILE, and that is a property rather than a tidy-up.
 *
 * Every export below is this open plus a decision about what to do with the
 * descriptor, so there is exactly one place where flags reach the kernel and
 * exactly one place the census has to trust. The count on this file's allowlist
 * row is 1 for that reason: a second open here would raise it and say so.
 */
function openBounded(filePath: string, flags: number): Opened {
  const fd = fs.openSync(filePath, flags);
  try {
    return { fd, stat: fs.fstatSync(fd) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readRegular(filePath: string, flags: number): string | null {
  const { fd, stat } = openBounded(filePath, flags);
  try {
    return stat.isFile() ? fs.readFileSync(fd, 'utf8') : null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The reader for an entry inside a LOCK DIRECTORY — an owner file, at a name
 * this protocol chose, in a directory this protocol created.
 *
 * O_NOFOLLOW is the difference from `readRegularFile`, and it is about identity
 * rather than about time. Same rule as `observeLockPath`'s `lstatSync`, for the
 * same reason: following a link makes another object's evidence answer for this
 * one. A link to a LIVE holder's owner file used to be read as this lock's own
 * live pid — an immortal lock, refused forever, which is the wedge class these
 * files treat as worse than a steal (measured by the deviations lane: refused
 * 1 717 ms and 1 910 ms fresh and aged, both before that change). Nothing
 * legitimate is ever a symlink here: every owner file is written by the
 * protocol, into a staging directory, under a random token name.
 */
export function readOwnerEntry(entryPath: string): string | null {
  return readRegular(entryPath, OWNER_READ_FLAGS);
}

/**
 * The reader for a file an OPERATOR owns and may reasonably have arranged — the
 * consolidated machine settings file, `one.json`.
 *
 * The link refusal above is deliberately absent, and that is the whole
 * difference. Boundedness does not need it: `O_NONBLOCK` applies to whatever the
 * link resolves to, so a symlink to a FIFO opens instead of waiting, and the
 * `fstat` — still taken on the DESCRIPTOR, so the substitution argument is
 * untouched — answers PRESENCE for the FIFO or the device at the end of it
 * without reading a byte. Only the lock protocol needs to know whose evidence it
 * is reading; a settings file that is a symlink is a configuration, not an
 * impersonation.
 *
 * MEASURED at the read it replaces: a FIFO planted at `one.json` hung
 * `updateOneSettings` (12 068 ms, SIGKILL, load 27.19) before this, in
 * `readRawSettings` — BEFORE the lock, so no lock protocol was involved and the
 * hardened lock could not have helped. It answers `null` in 0 ms after, and the
 * caller maps that onto the malformed-settings refusal it already raises for a
 * DIRECTORY at that path.
 */
export function readRegularFile(filePath: string): string | null {
  return readRegular(filePath, REGULAR_READ_FLAGS);
}

/**
 * What a bounded read FOUND, for a caller that must tell the outcomes apart.
 *
 * `string | null` cannot serve that caller, and the reason is the whole point of
 * this type rather than a convenience: `null` above conflates "something is
 * there and it is not a regular file" with "the open threw", and the open throws
 * for ENOENT too. Absent and unreadable are the one pair that must never be
 * folded — ENOENT means nothing is there and writing is safe, while EACCES/
 * EISDIR/EIO mean something IS there and overwriting is least defensible — so a
 * read-modify-write consumer handed one `null` for both fails OPEN.
 */
export type BoundedRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly errno: string };

/**
 * The errno for a shape the allowlist refused: PROSE NO KERNEL PRODUCES, so an
 * operator reading `cannot be read (not-a-regular-file)` can tell our refusal
 * from the filesystem's. Same convention fsjson.ts's `RefusalReason` already
 * uses in the same `errno` field, and for the same reason.
 *
 * A DIRECTORY is the deliberate exception below: it answers `EISDIR`, which is
 * not a fabrication but the errno the kernel itself produces when the read this
 * function declines to perform is performed. It is also load-bearing beyond this
 * module, and the set is MEASURED rather than asserted — the mutant that folds a
 * directory into the name above reds FOUR rows in THREE files: retention.ts's
 * operator notice `cannot be read (EISDIR)` (two rows: the durable-remedy row and
 * the illegible-nested-root row), __tests__/read-json-result.test.ts's
 * unreadable-not-absent row, and __tests__/fsjson-bounded-read.test.ts's own.
 *
 * Three neighbours that LOOK like pins and are not, counted because an unverified
 * "as pinned by" is worth less than nothing: hook/workspace-members.ts
 * interpolates this errno into its illegibility reason but its suite asserts only
 * the `illegible` kind; one-mcp-report's report-id-illegible-state.test.ts
 * asserts `EISDIR` off a LOCAL raw `readFileSync` helper, which this reader cannot
 * move; and onboarding/seed-prompt.test.ts pins EACCES, not this.
 */
const NOT_REGULAR_ERRNO = 'not-a-regular-file';

/**
 * The reader for a file whose OUTCOMES THE CALLER DECIDES DIFFERENTLY ON —
 * fsjson.ts's `readText` and `readJsonResult`, and through the latter every
 * read-modify-write of `.one.json`, a run ledger or a settlement record. Three
 * kinds here rather than that caller's four: the parse is the caller's business,
 * and the split this reader owes it is presence from absence.
 *
 * MEASURED at the reads it replaces, one shape per child process under a hard
 * alarm (load 7.05-7.33 of 10 cpus): a FIFO at
 * `.traffic-one/.one.json` hung `readJsonResult` (SIGKILL at 12 014 ms) and
 * `readText` (12 011 ms), and a symlink to `/dev/zero` hung `readJsonResult`
 * (20 151 ms), against a 0 ms control on a regular file. Those are hook-path
 * reads, so this was the outcome project-state-lock.ts ranks worst reachable
 * from 102 call sites.
 *
 * A NON-REGULAR FILE IS `unreadable`, NEVER `absent` AND NEVER THE CALLER'S
 * PARSE-FAILURE ARM. Both directions are the fail-open ones and both are pinned
 * by name in fsjson-bounded-read.test.ts:
 *   as `absent`   — "nothing is there" is the verdict that makes writing safe,
 *                   and something IS there.
 *   as `corrupt`  — fsjson's `corrupt` carries the BYTES so a caller may
 *                   preserve them and replace the file, so a FIFO classified
 *                   that way is a licence to destroy it. See the FSTAT-DROP
 *                   paragraph above: that is exactly where the empty bytes of an
 *                   O_NONBLOCK FIFO read would land.
 *
 * SYMLINKS ARE FOLLOWED, like `readRegularFile` and unlike `readOwnerEntry`, and
 * that is a requirement rather than an inheritance: the materialize fixtures
 * resolve the plugin's `rules/` and `skills-catalog/` THROUGH links, fsjson.ts
 * fences no read, and a dangling link must keep reporting ENOENT — i.e. `absent`,
 * which is genuinely "nothing to read here". Boundedness does not need the
 * refusal: O_NONBLOCK applies to whatever the link resolves to and the `fstat` is
 * still taken on the DESCRIPTOR.
 *
 * IT ANSWERS WHERE THE TWO EXPORTS ABOVE THROW, which is the only difference in
 * kind between them and the reason this is a separate function rather than a
 * mapping over `readRegular`. Those two throw so that a caller with its own
 * catch can read `.code` off the ERROR OBJECT (one-settings.ts's ENOENT arm,
 * project-state-lock.ts's `not-ours` EPERM arm); re-throwing a synthesized error
 * to answer here would hand those callers a different object, and re-deriving
 * their answer from this union would change two live consumers this change is
 * required to leave byte-identical. Three shared lines of open+fstat is the
 * cheaper duplication.
 */
export function readRegularFileResult(filePath: string): BoundedRead {
  let fd: number | null = null;
  try {
    const opened = openBounded(filePath, REGULAR_READ_FLAGS);
    fd = opened.fd;
    // The read is REACHED only for a regular file; every other shape is
    // classified from the descriptor without a byte being read, which is what
    // makes a FIFO and a character device bounded rather than empty or endless.
    if (!opened.stat.isFile()) {
      return { kind: 'unreadable', errno: opened.stat.isDirectory() ? 'EISDIR' : NOT_REGULAR_ERRNO };
    }
    return { kind: 'text', text: fs.readFileSync(fd, 'utf8') };
  } catch (error) {
    // The read is inside the same `try` as the open on purpose: EIO on a failing
    // medium arrives from the read, and the caller this exists for folded it into
    // `unreadable` before — losing it here would be the one direction that turns
    // "there are bytes we cannot see" back into "nothing is there".
    const code = (error as { code?: unknown } | null)?.code;
    const errno = typeof code === 'string' && code !== '' ? code : 'unknown';
    return errno === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', errno };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * THE THROWING ARM, and it exists because THE ANSWER SHAPE IS WHAT PRICED THE
 * CONVERSIONS — which is the whole finding of the round that added it.
 *
 * The census's allowlist reached 103 rows and 177 sites, 111 of them at
 * project-controlled paths a hook can reach, and every one of those rows was an
 * ARGUMENT that the site is survivable rather than a conversion. Three rounds
 * wrote better arguments; the round-3 peer then DROVE six of the rows and four
 * hung. Reading is what cannot tell a bounded site from an unbounded one, so an
 * allowlist whose entry cost is a sentence and whose exit cost is a rewrite
 * fills up — the instrument was selecting for prose.
 *
 * The rewrite was expensive for one mechanical reason. Every one of those sites
 * is `fs.readFileSync(p, 'utf8')` inside a `try` whose `catch` already handles
 * "we could not read this", and the two exports above answer with a `null` or a
 * union the caller has no branch for — so converting one site meant inventing a
 * branch, deciding where a non-regular shape lands in THAT caller's split, and
 * defending it. Multiply by 177. This function's answer is the branch the caller
 * already wrote: a non-regular shape throws, so it lands exactly where EACCES,
 * EIO and a torn file already land, and the conversion is a rename.
 *
 * WHAT IT DELIBERATELY DOES NOT BUY, said plainly because the arms above pay for
 * it and this one does not: the caller cannot tell "something is there and it is
 * not a file" from "the open failed", so a read-modify-write consumer that must
 * not overwrite an unreadable file needs `readRegularFileResult` instead (see the
 * `BoundedRead` docblock — absent and unreadable are the one pair that must never
 * be folded). What every caller of THIS function gets is the property the class
 * is about: it returns. A planted FIFO becomes the caller's existing failure arm
 * — at worst a file that gets replaced, which is a repair — instead of a hook
 * that never returns and cannot even report that it did not.
 *
 * The errno is `NOT_REGULAR_ERRNO`, prose no kernel produces, for the same reason
 * the union arm uses it: a caller or an operator can tell OUR refusal from the
 * filesystem's, and a caller keying on `ENOENT` (one-settings.ts's absent arm,
 * project-state-lock.ts's `not-ours` EPERM arm) is untouched because those errnos
 * still arrive from the open unchanged.
 */
export function readRegularFileOrThrow(filePath: string): string {
  const text = readRegular(filePath, REGULAR_READ_FLAGS);
  if (text === null) throw notRegular(filePath);
  return text;
}

/**
 * The BYTES arm of the same conversion: `fs.readFileSync(p)` with no encoding,
 * which is what a hasher, a decoder and an image reader call.
 *
 * A separate export rather than an option because the return type is the whole
 * difference and a union of `string | Buffer` would push a cast into every one
 * of those callers — the same tax that made the null arm expensive.
 */
export function readRegularBytesOrThrow(filePath: string): Buffer {
  const { fd, stat } = openBounded(filePath, REGULAR_READ_FLAGS);
  try {
    if (!stat.isFile()) throw notRegular(filePath);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A DESCRIPTOR on a regular file, for the readers that never wanted the whole
 * file: the `openSync(p, 'r')` + `readSync` head- and tail-clips scattered
 * through the transcript readers, the shim comparison and the artifact probes.
 *
 * The clip was already a size bound and never a shape bound — a 16-byte read of
 * a FIFO waits for a writer exactly as a whole-file read does, and the round-3
 * census said so on five separate rows. Handing back the descriptor keeps every
 * one of those callers' clip logic byte-identical while moving the only part
 * that could block. The caller CLOSES IT, like the `openSync` this replaces, and
 * may `fstat` it for the size — that stat is on the descriptor this function
 * already proved regular, so there is nothing left to substitute.
 */
export function openRegularFd(filePath: string): number {
  const { fd, stat } = openBounded(filePath, REGULAR_READ_FLAGS);
  if (stat.isFile()) return fd;
  fs.closeSync(fd);
  throw notRegular(filePath);
}

const COPY_CHUNK_BYTES = 64 * 1024;

// The destination side of a copy. Spelled in flags rather than as a `'w'`/`'wx'`
// mode string so `O_WRONLY` is present in the text: this is the write class the
// census names as out of its scope, and a proof that has to be inferred from a
// ternary over two mode strings is not one.
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT;

/**
 * A COPY reads its source, and that read is the same unbounded open with a
 * different callee — `fs.copyFileSync(hostile, dest)` blocks in exactly the way
 * `readFileSync(hostile)` does (DRIVEN: see the taxonomy in
 * `__tests__/bounded-read-census.test.ts`).
 *
 * So the copy is performed FROM THE DESCRIPTOR this file proved regular, rather
 * than from the path: open bounded, `fstat`, then a read/write loop.
 *
 * `false` means something was there and it was not a regular file. This docblock
 * used to add that it "is the answer every caller here already had a branch for —
 * they are staging artifacts and config, and a non-file at the source is a thing
 * not to stage", and THAT WAS FALSE when written: of the five call sites, exactly
 * ONE branched on it (`qa-evidence/native.ts`, which `continue`s past an artifact
 * it cannot copy). The others discard it, and the survey of what discarding costs
 * is the reason the sentence is recorded here rather than deleted:
 *
 *   - `opencode/git-sandbox.ts` (the pre-apply backup) could NOT survive it and
 *     now THROWS. Its caller records `{ existed: true, backupPath }` after the
 *     copy returns, and the rollback removes the target BEFORE restoring, so a
 *     dropped `false` turned a rollback into a deletion of the file the backup
 *     exists to protect — DRIVEN, and pinned in
 *     `opencode/__tests__/pre-apply-backup-phantom.test.ts`.
 *   - `shared/skill-filters/index.ts` and `gitnexus/bootstrap-env.ts` discard it
 *     behind a dirent/`statSync` shape check, so `false` needs a race to happen
 *     at all, and its price is an absent mirror entry (re-populated every
 *     SessionStart) or an absent managed binary (whose next exec fails loudly).
 *   - `doctor/codex-hook-trust.ts` discards it and the very next `chmodSync` on
 *     the missing destination throws inside the probe's own try, so the shadow
 *     home reports indeterminate instead of copying a hostile config.
 *
 * The general rule the caller survey yields: discarding `false` is survivable
 * only where the destination's ABSENCE is itself the signal. Where anything
 * downstream records that the copy happened, the answer has to be raised.
 *
 * The mode is carried across because an EXECUTABLE is among the things copied
 * here (the managed gitnexus binary), and `open(dest, 'w')` would have created
 * it 0o644 where `copyFileSync` preserved the bit. Best-effort on purpose:
 * Windows has no mode bits to carry and must not fail the copy over it.
 */
export function copyRegularFile(source: string, destination: string, exclusive = false): boolean {
  const { fd, stat } = openBounded(source, REGULAR_READ_FLAGS);
  try {
    if (!stat.isFile()) return false;
    const out = fs.openSync(destination, WRITE_FLAGS | (exclusive ? fs.constants.O_EXCL : fs.constants.O_TRUNC));
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (read <= 0) break;
        fs.writeSync(out, buffer, 0, read);
      }
      try { fs.fchmodSync(out, stat.mode & 0o777); } catch { /* no mode bits to carry */ }
    } finally {
      fs.closeSync(out);
    }
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

function notRegular(filePath: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${filePath} cannot be read (${NOT_REGULAR_ERRNO})`);
  error.code = NOT_REGULAR_ERRNO;
  return error;
}
