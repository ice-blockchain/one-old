// src/modules/plan-guard/scan-coverage.ts
// The one enumeration of how a BOUNDED SCAN can stop reading part of the tree,
// and the one rule that decides whether stopping cost anything.
//
// Five rounds of this plan item were spent patching the route the previous
// review named, and each time a sixth route was one respelling away — because
// every one of the defects was an ABSENCE: a branch with no record call, a
// `continue` where a record belongs, a route with no push site. A mutation score
// says nothing about absences; no mutant can express code that is not there. So
// the mechanism is not another record call. It is that a scan cannot decline to
// read something WITHOUT naming which of these exits it is taking, and that the
// default for an exit nobody has classified is to withdraw coverage.
//
// Round 6 tried to make that true with three closures, one of which was a
// LEXICAL rule: the closure test read the walkers' source and refused a
// `continue` and a `catch`. A denylist of spellings can only ever forbid what
// somebody has already been defeated by, and the peer review of that round
// walked through it twice with tokens the list does not name — an `entries
// .filter(...)` one line UPSTREAM of the walker, and a bare `break` (which
// cannot be banned, because the file cap legitimately uses one). Both silently
// deleted an error-grade finding while the report still read
// `complete: true, skippedEntries: 0` and all 152 tests stayed green.
//
// So the fourth closure is not another spelling. It is ACCOUNTING, at runtime:
//
//   Every entry `readdir` returned must reach a named disposition, and a
//   directory whose in-count does not equal its dispositioned-count is a scan
//   that lost something and says so in the report.
//
// The count is taken INSIDE this module, at the `readdirSync` call itself
// (`ScanCoverage.open`), not from whatever array reaches the walker — that is
// the whole reason the upstream filter cannot escape it. `DirectoryListing`
// keeps its own record of the names `readdir` returned; filtering the array
// that flows onward changes nothing about the set being audited. Whoever does
// not dispose of an entry gets `unaccounted-entry` for it, by name, and that
// exit withdraws coverage like any other.
//
// Four closures now, each failing for a different reason:
//
//   1. TYPE. `ScanExit` is a closed union and the walkers dispose of every entry
//      through an `EntryPlan`/`DirectoryPlan` discriminated union whose switch
//      ends in `assertNever`. A route added next year that returns a new plan
//      shape does not compile.
//   2. DEFAULT. `NO_LOSS` is the explicit list of exits that cost nothing;
//      `withdrawsCoverage` is its negation. A new `ScanExit` member is therefore
//      WITHDRAWING until somebody comes here and argues it into `NO_LOSS`,
//      rather than silently joining the exempt set. Note the honest size of
//      that claim: `NO_LOSS` holds EIGHT of the union's fifteen members, so the
//      exempt set is more than half. The direction is still right and still
//      worth having — a member added without an argument costs something — but
//      "an author must argue their way into the exempt set" is a weaker
//      statement than it sounds, and an earlier round overstated it as a
//      two-element list.
//   3. ACCOUNTING. The invariant above, enforced by `ScanCoverage.open` owning
//      the `readdirSync` and `ScanCoverage.withdrawals` reporting the shortfall
//      on the way out. This is the closure that does not care HOW an entry was
//      dropped: a filter, a `break`, a `slice`, a stride, a helper that
//      swallows the exit and an early `return` all fail identically, because
//      none of them can produce a disposition for an entry they never handled.
//   4. LEXICAL. The closure test still refuses a `continue` and a `catch` in
//      the walkers. Kept because it is cheap and true, DEMOTED because it is a
//      denylist: it is now the weakest of the four and nothing rests on it.
//
// What this module deliberately does NOT do is decide what a withdrawal COSTS.
// That is the verification contract's `truncatedScanUiImpactFloor`, reached
// through `recordScanBoundHit`; here a withdrawal is only ever the statement
// "part of this project went unread, and here is which part".

import * as fs from 'fs';

/**
 * Every disposition a bounded scan may give an entry or a directory it will not
 * read. Ordered no-loss first, and the two halves are separated by `NO_LOSS`
 * below rather than by position — position is documentation, the set is the
 * authority.
 */
export type ScanExit =
  /** The entry's own name is one this scan excludes everywhere (`node_modules`,
   *  `dist`). The tree behind it is not source anybody wrote. */
  | 'excluded-name'
  /** An extension this scan does not judge. A `.png` is not unread source. */
  | 'not-source'
  /** Outside the scopes of the role this scan is judging. Another role's file is
   *  read by another role's scan; nothing about the project went unseen. */
  | 'out-of-scope'
  /** Compiler output beside its own source (`Page.js` next to `Page.tsx`). The
   *  bytes that matter are read under the sibling's name. */
  | 'emitted-sibling'
  /** The same REAL directory already read under another path. */
  | 'already-visited'
  /** A CANDIDATE root that does not exist. Capability profiles carry
   *  alternatives (Next `app` and `src/app`); an absent one holds no files. */
  | 'absent-root'
  /** A link with no target: there is nothing to read and nothing behind it. */
  | 'broken-link'
  /** A link this walk did not follow whose target it read anyway, under the
   *  target's own real path. Nothing is missing from the report.
   *
   *  This is the ONLY no-loss answer a link may get, and the narrowing is the
   *  round-6 blocker: the previous spelling also forgave a link whose target
   *  matches the scan's SKIP predicate, on the argument that "a link named
   *  `assets` pointing at a build cache is the same non-loss as the `dist`
   *  directory beside it". That is true of a link which ADDS an excluded tree
   *  and false of one which REPLACES a source path with an excluded target: a
   *  link whose own name is excluded never reaches the deferred list at all
   *  (the walk tests the entry's name first), so the clause could only ever
   *  fire for a visible name pointing at bytes NO consumer reads under either
   *  name. Measured: `apps/web/src/features/widgets ->
   *  apps/web/src/generated/widgets` holding an error-grade collapsed component
   *  yielded `complete: true`, `skippedEntries: 0`, no STRUCT_COLLAPSED_LINE, no
   *  scan-bound.json and floor `nonvisual`, while the same fixture with the
   *  target one directory to the left — outside the project — recorded the skip
   *  and floored at `visual`. */
  | 'covered-elsewhere'
  /** A link the walk did not follow whose target resolves under a build output
   *  THIS PROJECT DECLARED in its compiled contract.
   *
   *  The second no-loss answer a link may get, and it is deliberately not a
   *  guess from a directory name — that is the clause round 6 deleted, because
   *  a walk cannot tell a laundered source tree from a build cache by looking
   *  at the word `generated`. A declaration can: it is the run's own frozen
   *  input, hashed into `contractHash`, and the compiler refuses one that
   *  contains a compiled source root or a compiled output. Zero filesystem
   *  reads, and nothing the walk observes can move it. */
  | 'declared-build-output'
  /** A link the walk did not follow, whose target nothing else read. The whole
   *  SUBTREE behind it went unjudged. */
  | 'unfollowed-link'
  /** A directory entry that is neither a directory nor a regular file, so the
   *  walk has no arm for it. Non-recognition is not evidence of emptiness. */
  | 'undecidable-entry'
  | 'unreadable-directory'
  /** A directory the walk DISCOVERED and then could not resolve. Distinct from
   *  `absent-root`: something was there when `readdir` listed it. */
  | 'unresolvable-directory'
  | 'unreadable-file'
  /** The walk's own hard file bound. The one exit that was compensated before
   *  this module existed. */
  | 'file-cap'
  /** `readdir` returned this entry and the walk never said what it did with it.
   *  Unreachable in a correct walk — it is the accounting failing to balance,
   *  not a fact about the project — which is exactly why it is a member: it is
   *  the disposition of last resort for an entry that got no other one, and it
   *  is what an upstream filter, a bare `break`, a `slice`, a stride and a
   *  swallowing helper all collapse into. */
  | 'unaccounted-entry'
  /** The walk stopped here because it FOUND what it was looking for, and the
   *  rest of the directory is moot. No loss, and the argument is not "these
   *  entries do not matter" but that the answer is strictly stronger than
   *  anything they could have said: the collapse walk's only caller denies on a
   *  non-null `file`, so a run that reaches this exit is being refused, and the
   *  entries behind it are read by the next walk after the defect is fixed. */
  | 'answer-found';

/**
 * The exits that cost nothing, stated as a LIST so that everything else costs
 * something: a `ScanExit` member added without touching this set withdraws
 * coverage by default, which is the direction five rounds of this plan item
 * failed in.
 *
 * The exempt set is MOST of the union: 10 of 17. The default is the property
 * worth having and it holds — a member added here by nobody still costs — but
 * "an author must argue their way into the exempt set" is a proportionally
 * weaker claim than a small exempt set would make it, and a reader deserves the
 * ratio rather than the impression. The two numbers are checked against the
 * arrays by the closure test, because a hand-maintained tally in a comment is
 * the same stale-prose defect the deny-id catalog has already been caught by
 * twice, and this one had already drifted by one before anybody read it.
 */
const NO_LOSS: ReadonlySet<ScanExit> = new Set<ScanExit>([
  'excluded-name',
  'not-source',
  'out-of-scope',
  'emitted-sibling',
  'already-visited',
  'absent-root',
  'broken-link',
  'covered-elsewhere',
  'declared-build-output',
  'answer-found',
]);

export function withdrawsCoverage(exit: ScanExit): boolean {
  return !NO_LOSS.has(exit);
}

/** Every exit a walker may take, for the closure test's fixture readback. */
export const SCAN_EXITS: readonly ScanExit[] = [
  'excluded-name', 'not-source', 'out-of-scope', 'emitted-sibling', 'already-visited',
  'absent-root', 'broken-link', 'covered-elsewhere', 'declared-build-output', 'unfollowed-link',
  'undecidable-entry', 'unreadable-directory', 'unresolvable-directory', 'unreadable-file',
  'file-cap', 'unaccounted-entry', 'answer-found',
];

/**
 * The exits a walk may hand to a WHOLE REMAINDER of a directory at once — the
 * only two ways either walk legitimately stops reading a directory part-way.
 *
 * The narrowness is the point, and so is the disclosure. A bulk disposition is
 * the one shape that can launder a silent drop into a named one, because it
 * satisfies the accounting for entries nobody looked at. `file-cap` withdraws
 * coverage, so laundering through it costs the truncated-scan floor and shows
 * up in the report. `answer-found` does NOT, and an
 * `abandonFrom(entry, 'answer-found')` written where no answer was found would
 * therefore drop entries for free.
 *
 * That is a real residual and it is stated rather than papered over. What the
 * accounting buys is the transition from an ABSENCE — a `continue`, a `break`,
 * a filter, no code at all — to a written, typed, greppable claim in a
 * two-member enum. A reviewer can find every one of them; nobody can find code
 * that is not there. Widening this union is the edit to argue about.
 */
export type BulkExit = 'file-cap' | 'answer-found';

/**
 * One directory, as `readdir` returned it, with the ledger's own record of what
 * was in it.
 *
 * `entries` is handed onward for the walk to iterate, and the walk may do
 * whatever it likes with that array — filter it, slice it, stride it, abandon
 * it half way. None of that reaches `names`, which was taken inside `open()`
 * from the `readdirSync` result before anything could touch it, and `names` is
 * what the audit compares against. That asymmetry is the whole mechanism.
 */
export interface DirectoryListing {
  /** Exactly what `readdir` returned, in the order it returned it. */
  readonly entries: readonly fs.Dirent[];
  /** One entry's subject, as the ledger will name it if nobody disposes of it. */
  subject(entry: DirentLike): string;
  /**
   * Name what happened to one entry. Every entry `readdir` returned needs one
   * of these before `withdrawals` is read, and an `exit` plan records its
   * withdrawal here too — so a walker that stops calling this stops recording
   * exits AND starts failing the audit, rather than going quiet.
   */
  disposed(entry: DirentLike, plan: EntryDisposition): void;
  /**
   * This entry and every entry `readdir` listed after it, under one bulk exit.
   * The file cap, and nothing else: see `BulkExit`.
   */
  abandonFrom(entry: DirentLike, kind: BulkExit): void;
}

/**
 * What a walker's plan union looks like from here. Structural rather than
 * imported so both walkers' unions satisfy it without this module knowing
 * either one's non-exit arms.
 */
export type EntryDisposition = { action: 'exit'; kind: ScanExit } | { action: string };

/** The part of `fs.Dirent` this module uses. */
export interface DirentLike { readonly name: string }

export interface ScanCoverage {
  /**
   * Dispose of one entry. The ONLY way a bounded scan may decline to read
   * something — a bare `continue` beside this call is what the closure test
   * refuses.
   */
  exit(kind: ScanExit, subject: string): void;
  /**
   * `readdir` this directory under the ledger's accounting.
   *
   * The one `readdirSync` a bounded scan may call, and the reason the count is
   * taken here rather than at the plan function's return: a filter applied
   * between the syscall and the walker would otherwise shrink the population
   * before it was ever counted, which is precisely how round 6 was defeated.
   *
   * @param dirRel The directory's own project-relative path, `.` for the root.
   * @returns null when the directory cannot be read; the caller names
   *   `unreadable-directory` for it, which is a disposition of the DIRECTORY
   *   and needs no listing.
   */
  open(dir: string, dirRel: string): DirectoryListing | null;
  /**
   * The walk stopped before draining its stack, so directories it promised to
   * descend into and never reached are covered by the truncation the caller is
   * already reporting rather than audited a second time.
   *
   * Omitting this call makes the audit STRICTER, not weaker — a capped walk
   * that forgets it reports every undrained directory as unaccounted, which
   * reds the file-cap fixtures immediately. That direction is deliberate: every
   * way of getting the accounting wrong should be loud.
   */
  settleEarly(): void;
  /**
   * Human-readable statements of what went unread, in encounter order,
   * followed by one per entry `readdir` returned that nobody disposed of.
   *
   * A GETTER, and deliberately: the audit is on the path the report is built
   * from rather than behind a `settle()` call a walker could omit. Reading this
   * is how a scan's output leaves this module, so a scan cannot report without
   * being audited.
   */
  readonly withdrawals: readonly string[];
  /**
   * The subjects of entries that reached no disposition, and of directories a
   * `descend` promised and nothing redeemed, without the message prefix. Empty
   * on every correct walk; non-empty means the walk's accounting does not
   * balance and the caller must say so rather than report a number.
   */
  readonly unaccounted: readonly string[];
}

const WITHDRAWAL_MESSAGE: Readonly<Record<ScanExit, string>> = {
  'excluded-name': '',
  'not-source': '',
  'out-of-scope': '',
  'emitted-sibling': '',
  'already-visited': '',
  'absent-root': '',
  'broken-link': '',
  'covered-elsewhere': '',
  'declared-build-output': '',
  'unfollowed-link': 'source scan did not follow symbolic link:',
  'undecidable-entry': 'source scan cannot classify directory entry',
  'unreadable-directory': 'cannot read source directory',
  'unresolvable-directory': 'cannot resolve source directory',
  'unreadable-file': 'cannot read source file',
  'file-cap': 'source scan exceeded its file bound at',
  'unaccounted-entry': 'source scan did not account for directory entry',
  'answer-found': '',
};

/**
 * What a directory entry IS, with the one fallback that keeps
 * `undecidable-entry` honest.
 *
 * `readdir(withFileTypes)` reports UNKNOWN on filesystems that do not fill in
 * `d_type` — several network and fuse filesystems — and there every `isX()`
 * answers false. Without the `lstat` fallback a walk over such a mount would
 * classify EVERY entry as undecidable and withdraw the whole tree: fail-closed,
 * but uselessly so. One extra syscall on the rare unknown entry buys the
 * distinction, and what is left over is a socket, a fifo or a device node,
 * which really is a shape no walk here has an arm for.
 */
export function entryKind(
  dirent: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean },
  absolute: string,
  lstat: (target: string) => { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean },
): 'directory' | 'file' | 'link' | 'other' {
  if (dirent.isSymbolicLink()) return 'link';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  let stat: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
  try {
    stat = lstat(absolute);
  } catch {
    return 'other';
  }
  if (stat.isSymbolicLink()) return 'link';
  if (stat.isDirectory()) return 'directory';
  return stat.isFile() ? 'file' : 'other';
}

/**
 * A withdrawal ledger for one walk.
 *
 * Bounded at `limit` entries because the message list is reported verbatim and
 * a pathological tree could otherwise turn one finding into a megabyte. The
 * COUNT keeps growing past the bound — the floor keys on "any", and a truncated
 * message list that under-reported the count would be this plan item again one
 * level down.
 */
export function scanCoverage(limit = 50): ScanCoverage {
  const recorded: string[] = [];
  let total = 0;
  const listings: Array<{ dirRel: string; names: readonly string[]; accounted: Set<string> }> = [];
  // The second half of the accounting. `descend` is the one disposition that
  // does not finish the entry — it promises the walk will come back and read
  // it — so a promise nobody redeemed is the same loss as an entry nobody
  // disposed of, and it is how a "descend into at most N subdirectories"
  // fan-out guard would otherwise drop whole subtrees while satisfying the
  // in-count. Redeemed by `open` (the directory was read) or by any `exit`
  // naming it (already-visited, unresolvable, unreadable).
  const promised = new Map<string, true>();
  const redeemed = new Set<string>();
  let stoppedEarly = false;

  // The bound, shared by the recorded withdrawals and the audited ones so the
  // count keeps rising past the message list either way.
  const place = (list: string[], running: number, message: string): void => {
    if (list.length < limit) list.push(message);
    else if (list.length === limit) list.push(`(+${running - limit} further withdrawals not listed)`);
    else list[limit] = `(+${running - limit} further withdrawals not listed)`;
  };
  const subjectOf = (dirRel: string, name: string): string => (
    dirRel === '' || dirRel === '.' ? name : `${dirRel}/${name}`
  );
  const orphans = (): string[] => {
    const out: string[] = [];
    for (const listing of listings) {
      for (const name of listing.names) {
        if (!listing.accounted.has(name)) out.push(subjectOf(listing.dirRel, name));
      }
    }
    if (stoppedEarly) return out;
    for (const subject of promised.keys()) {
      if (!redeemed.has(subject)) out.push(subject);
    }
    return out;
  };
  const record = (kind: ScanExit, subject: string): void => {
    redeemed.add(subject);
    if (!withdrawsCoverage(kind)) return;
    total += 1;
    place(recorded, total, `${WITHDRAWAL_MESSAGE[kind]} ${subject}`.trim());
  };

  return {
    exit: record,
    settleEarly(): void {
      stoppedEarly = true;
    },
    get unaccounted(): readonly string[] {
      return orphans();
    },
    get withdrawals(): readonly string[] {
      const missing = orphans();
      if (missing.length === 0) return recorded;
      // Rendered onto a COPY, with a running total seeded from the recorded
      // one, so reading this twice cannot double-count and so the bound behaves
      // exactly as it does for an ordinary withdrawal.
      const out = [...recorded];
      let running = total;
      for (const subject of missing) {
        running += 1;
        place(out, running, `${WITHDRAWAL_MESSAGE['unaccounted-entry']} ${subject}`);
      }
      return out;
    },
    open(dir: string, dirRel: string): DirectoryListing | null {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return null;
      }
      // Taken HERE, from the syscall's own result. Nothing downstream — not the
      // plan function, not the walker, not a helper either of them calls — can
      // shrink this set, because nothing downstream is holding it.
      const listing = { dirRel, names: entries.map((entry) => entry.name), accounted: new Set<string>() };
      listings.push(listing);
      redeemed.add(dirRel);
      return {
        entries,
        subject: (entry) => subjectOf(dirRel, entry.name),
        disposed(entry: DirentLike, plan: EntryDisposition): void {
          listing.accounted.add(entry.name);
          if (plan.action === 'exit') record((plan as { kind: ScanExit }).kind, subjectOf(dirRel, entry.name));
          else if (plan.action === 'descend') promised.set(subjectOf(dirRel, entry.name), true);
        },
        abandonFrom(entry: DirentLike, kind: BulkExit): void {
          const from = listing.names.indexOf(entry.name);
          const rest = from === -1 ? listing.names : listing.names.slice(from);
          // Overrides any disposition already given to `entry` itself: the cap
          // is discovered inside the arm that was about to collect it, so it is
          // abandoned too, and saying `collect` about a file that is not in the
          // report would be the same lie one entry small.
          for (const name of rest) listing.accounted.add(name);
          record(kind, `${subjectOf(dirRel, rest[0] ?? '')} and ${rest.length - 1} further entries`);
        },
      };
    },
  };
}

/**
 * The compile-time half of the closure. Every `switch` over a walker's plan
 * union ends here, so a plan shape added without an arm is a type error rather
 * than a silent fallthrough into "keep going, record nothing".
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled scan disposition ${JSON.stringify(value)}`);
}
