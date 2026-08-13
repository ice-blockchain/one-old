// src/modules/plan-guard/__tests__/scan-coverage-closure.test.ts
//
// The assertions here are the reason this round is not a sixth patch.
//
// Five rounds of `impact-floor` each closed the termination route the previous
// review named, and each time a sixth was one respelling away. The last peer ran
// 20 mutants and killed 20 — and still found three substantive defects, because
// all three were ABSENCES: a route with no record-push, a branch with no record
// call, a `continue` where a record belongs. No mutant can express code that is
// not there, and no fixture can exercise a route nobody has written yet.
//
// Round 6 answered that with three closures, one of which was LEXICAL: this
// file read the walkers' source and refused a `continue` and a `catch`. The
// peer review of that round walked through it twice. An `entries.filter(…)` one
// line upstream of the walker, and a bare `break` (which cannot be banned,
// because the file cap legitimately uses one) each deleted an error-grade
// finding while the report read `complete: true, skippedEntries: 0` and all 152
// tests stayed green. A denylist of spellings can only forbid what somebody has
// already been defeated by; the spelling nobody thought of is the one that gets
// you.
//
// So the load moved off the token rules and onto ACCOUNTING, which is the first
// group of tests below and is not about spellings at all:
//
//   every entry `readdir` returned must reach a named disposition, and a
//   directory whose in-count does not equal its dispositioned-count is a scan
//   that lost something and says so in the report.
//
// The count is taken inside `ScanCoverage.open`, at the `readdirSync` call, so
// nothing between the syscall and the report can shrink the population being
// audited. An upstream filter, a `break`, a `slice`, an index stride, a helper
// that swallows the exit and an early `return` fail identically under it,
// because none of them can produce a disposition for an entry they never
// handled — which is the property the previous six rounds kept missing by one
// respelling.
//
// The shape rules are kept below, demoted rather than deleted:
//
//   * a `continue` or a `catch` appearing anywhere in either walker
//   * a plan function growing a `catch` that falls through instead of returning
//   * a plan function returning something that is not a named disposition
//   * a new `ScanExit` member reaching the no-loss set without an argument
//   * `withdrawsCoverage` being rewritten as membership in a WITHDRAWING list,
//     which would make the default silent again
//
// Note what is NOT here and never was, because an earlier round claimed it: no
// rule forbids a bare `return` in the walkers. It could not — both walkers end
// in one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SCAN_EXITS, scanCoverage, withdrawsCoverage, type ScanExit } from '../scan-coverage';

const MODULE_DIR = path.resolve(__dirname, '..');
const COVERAGE_SRC = path.join(MODULE_DIR, 'scan-coverage.ts');
const STRUCTURE_WALK_SRC = path.join(MODULE_DIR, 'react-structure', 'scan.ts');
const COLLAPSE_WALK_SRC = path.join(MODULE_DIR, 'plan-readiness', 'checks.ts');

/**
 * The two BOUNDED SCANS this plan item is about, and the plan functions that
 * are the only places either of them may decide not to read something.
 *
 * Listing the functions is not the same mistake as listing the termination
 * routes. A route is a thing that can be added silently; these four are the
 * ONLY doors into the walkers, they are named in the walkers' own signatures,
 * and deleting one to escape the rule deletes the walk with it.
 */
const WALKERS: ReadonlyArray<{ file: string; fn: string }> = [
  { file: STRUCTURE_WALK_SRC, fn: 'walkSourceTree' },
  { file: COLLAPSE_WALK_SRC, fn: 'walkCollapseTree' },
];

const PLANNERS: ReadonlyArray<{ file: string; fn: string }> = [
  { file: STRUCTURE_WALK_SRC, fn: 'planSourceDirectory' },
  { file: STRUCTURE_WALK_SRC, fn: 'planSourceEntry' },
  { file: COLLAPSE_WALK_SRC, fn: 'planCollapseDirectory' },
  { file: COLLAPSE_WALK_SRC, fn: 'planCollapseEntry' },
];

/**
 * The body of `function <name>(…) {…}`, brace-matched, comments and strings
 * stripped.
 *
 * Every failure path here is an assertion rather than a best guess, and that is
 * not defensive tidiness. The first draft found the body by taking the first
 * `{` after the first `)`, which on a function whose RETURN TYPE is an object
 * literal silently extracted the type annotation instead — so the rule below
 * was reading eight lines of field declarations, found no `continue` in them,
 * and passed. A planted `continue` in that walker survived. An extractor that
 * quietly reads the wrong region is precisely the failure this plan item is
 * about, one level up: a check that reports clean because it did not look.
 */
function functionBody(file: string, name: string, requireLoop = false): string {
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1,
    `${path.basename(file)} no longer declares ${name}(). The walk it names is the`
    + ' subject of the impact-floor plan item; if it was renamed, rename it here too'
    + ' rather than deleting the rule that keeps it honest.');
  // The parameter list, paren-matched — the params are an object type, so the
  // first `)` in the text is nowhere near the end of it.
  let index = source.indexOf('(', start);
  let parens = 0;
  for (; index < source.length; index += 1) {
    if (source[index] === '(') parens += 1;
    else if (source[index] === ')') {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  // Between the parameter list and the body there may be a return type, and it
  // must be a NAMED one: an inline object type is indistinguishable from a body
  // to a brace matcher, which is how the extractor read the wrong region.
  const afterParams = source.slice(index + 1);
  const signature = /^(\s*:\s*[A-Za-z_$][\w$.]*(?:<[^{}]*>)?)?\s*\{/.exec(afterParams);
  assert.ok(signature,
    `${name}() does not declare a named return type. Give it one (an interface`
    + ' or a type alias) — an inline object return type cannot be told apart from'
    + ' the function body by this rule, and a rule that reads the wrong region'
    + ' passes a walker that drops entries silently.');
  const open = index + 1 + signature[0].length - 1;
  let depth = 0;
  let cursor = open;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1;
    else if (source[cursor] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  assert.equal(depth, 0, `${name}() body is unbalanced; the rule cannot read it`);
  const body = strip(source.slice(open + 1, cursor));
  assert.ok(body.trim().length > 0, `${name}() body as read by this rule is empty`);
  // A WALK contains a loop. Without this the rule could be reading some
  // adjacent region and proving nothing about the walk.
  if (requireLoop) {
    assert.match(body, /\b(for|while)\b/,
      `${name}() body as read by this rule contains no loop, so the rule is`
      + ' reading the wrong region and proving nothing.');
  }
  return body;
}

/**
 * Comments and string bodies removed, so the word `continue` inside a sentence
 * explaining why there is no `continue` does not fail the rule that there is
 * none. Deliberately crude — it only has to be right about this repo's own
 * source, which it reads.
 */
function strip(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/** A directory holding `names`, cleaned up by the caller. */
function directoryOf(names: readonly string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-ledger-'));
  for (const name of names) fs.writeFileSync(path.join(dir, name), '');
  return dir;
}

test('an entry readdir returned and nobody disposed of is named, by the ledger, in the report', () => {
  // The invariant itself, driven directly. Nothing here is about how an entry
  // came to be dropped — the ledger only knows what `readdir` handed it and
  // what came back.
  const dir = directoryOf(['a.tsx', 'b.tsx', 'c.tsx']);
  try {
    const ledger = scanCoverage();
    const listing = ledger.open(dir, 'apps/web/src');
    assert.ok(listing, 'the ledger must be able to open a readable directory');
    assert.equal(listing.entries.length, 3);
    assert.equal(ledger.unaccounted.length, 3, 'nothing disposed of yet');

    listing.disposed(listing.entries.find((entry) => entry.name === 'a.tsx')!, { action: 'collect' });
    listing.disposed(listing.entries.find((entry) => entry.name === 'b.tsx')!, { action: 'exit', kind: 'not-source' });
    assert.deepEqual([...ledger.unaccounted], ['apps/web/src/c.tsx']);

    // And it reaches the REPORT, through the same channel every other
    // withdrawal uses, rather than a side table a caller has to remember to ask
    // for. `not-source` is no-loss, so the only withdrawal is the one nobody
    // named.
    assert.deepEqual([...ledger.withdrawals],
      ['source scan did not account for directory entry apps/web/src/c.tsx']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the audited population is the one readdir returned, not the array the walk was handed', () => {
  // Round 6's first surviving mutant was `entries: entries.filter((e) =>
  // !e.name.startsWith('.'))` inside the plan function: a well-formed
  // `{ action: 'read' }` literal, no `continue`, no `catch`, nothing for the
  // type closure to catch, and an error-grade finding gone. Filtering is
  // simulated here exactly — the walk disposes only of what it kept.
  const dir = directoryOf(['.client', 'main.tsx']);
  try {
    const ledger = scanCoverage();
    const listing = ledger.open(dir, 'apps/web/src')!;
    for (const entry of listing.entries.filter((entry) => !entry.name.startsWith('.'))) {
      listing.disposed(entry, { action: 'collect' });
    }
    assert.deepEqual([...ledger.unaccounted], ['apps/web/src/.client'],
      'the filtered-out entry must still be audited: the count was taken at the'
      + ' readdirSync, which is upstream of anything a plan function can filter');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('leaving the entry loop early is accounted for whatever token leaves it', () => {
  // Round 6's second surviving mutant was a bare `break`, chosen because the
  // rule bans `continue` and cannot ban `break` — the file cap uses one. The
  // ledger does not know what a `break` is; it knows three names went in and
  // one came back. A `slice`, an index stride and an early `return` produce the
  // identical shortfall, which is the point of counting instead of reading.
  const dir = directoryOf(['aaa.tsx', 'vendor.tsx', 'zeta.tsx']);
  try {
    for (const stop of ['break', 'slice', 'stride'] as const) {
      const ledger = scanCoverage();
      const listing = ledger.open(dir, 'apps/web/src')!;
      const entries = [...listing.entries].sort((a, b) => a.name.localeCompare(b.name));
      if (stop === 'break') {
        for (const entry of entries) {
          if (entry.name === 'vendor.tsx') break;
          listing.disposed(entry, { action: 'collect' });
        }
      } else if (stop === 'slice') {
        for (const entry of entries.slice(0, 1)) listing.disposed(entry, { action: 'collect' });
      } else {
        for (let index = 0; index < entries.length; index += 3) {
          listing.disposed(entries[index]!, { action: 'collect' });
        }
      }
      assert.deepEqual([...ledger.unaccounted].sort(),
        ['apps/web/src/vendor.tsx', 'apps/web/src/zeta.tsx'], stop);
      // `zeta.tsx` is the tell. It has nothing to do with the edit; it is lost
      // because it sorts after the stopping point, which is the `aaa-link`
      // defect from round 2 respelled. The ledger names it too.
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a descend that promises to read a directory and never does is a loss too', () => {
  // The in-count/dispositioned-count identity on its own has a gap, and this
  // closes it: `descend` is the only disposition that does not FINISH an entry.
  // A "descend into at most N subdirectories" fan-out guard disposes of every
  // entry, balances the count perfectly, and still drops whole subtrees. So a
  // promise must be redeemed — by the ledger opening that directory, or by an
  // exit naming it.
  const dir = directoryOf([]);
  try {
    fs.mkdirSync(path.join(dir, 'kept'));
    fs.mkdirSync(path.join(dir, 'dropped'));
    const ledger = scanCoverage();
    const listing = ledger.open(dir, 'apps/web/src')!;
    for (const entry of listing.entries) listing.disposed(entry, { action: 'descend' });
    assert.deepEqual([...ledger.unaccounted].sort(),
      ['apps/web/src/dropped', 'apps/web/src/kept'], 'both promised, neither redeemed');

    ledger.open(path.join(dir, 'kept'), 'apps/web/src/kept');
    ledger.exit('already-visited', 'apps/web/src/dropped');
    assert.deepEqual([...ledger.unaccounted], [], 'reading it or naming an exit for it redeems it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a walk that stops early owes the truncation it reports, not a second finding', () => {
  // `settleEarly` is the only suppression in the accounting, and it can only
  // make the audit weaker in the direction the caller is ALREADY reporting as
  // incomplete. Forgetting it is loud (every undrained directory becomes a
  // finding); calling it does not forgive a single entry `readdir` returned.
  const dir = directoryOf(['orphan.tsx']);
  try {
    fs.mkdirSync(path.join(dir, 'never-reached'));
    const ledger = scanCoverage();
    const listing = ledger.open(dir, 'apps/web/src')!;
    listing.disposed(
      listing.entries.find((entry) => entry.name === 'never-reached')!,
      { action: 'descend' },
    );
    ledger.settleEarly();
    assert.deepEqual([...ledger.unaccounted], ['apps/web/src/orphan.tsx'],
      'the undrained directory is the truncation; the undisposed entry is still a loss');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a walk may abandon a directory remainder only by naming a bulk exit that costs', () => {
  // The one legitimate way to stop part-way, and therefore the one shape that
  // could launder a silent drop into a named one. `file-cap` withdraws
  // coverage, so laundering through it pays the truncated-scan floor.
  const dir = directoryOf(['a.tsx', 'b.tsx', 'c.tsx']);
  try {
    const ledger = scanCoverage();
    const listing = ledger.open(dir, 'apps/web/src')!;
    const entries = [...listing.entries].sort((a, b) => a.name.localeCompare(b.name));
    listing.disposed(entries[0]!, { action: 'collect' });
    listing.abandonFrom(entries[1]!, 'file-cap');
    assert.deepEqual([...ledger.unaccounted], [], 'the remainder is accounted for');
    assert.equal(ledger.withdrawals.length, 1);
    assert.match(ledger.withdrawals[0]!, /file bound at apps\/web\/src\/b\.tsx and 1 further entries/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the bulk-exit union stays the two exits it can justify', () => {
  // `BulkExit` is the accounting's only escape hatch, and `answer-found` is its
  // only free member. Widening it — a no-loss `excluded-name`, say — would let
  // a future edit dispose of a directory remainder for nothing, which is this
  // plan item's defect with a type annotation on it. The rule is that widening
  // is an edit HERE, argued, rather than a call site nobody reads.
  const source = strip(fs.readFileSync(COVERAGE_SRC, 'utf8'));
  assert.match(source, /export type BulkExit\s*=\s*''\s*\|\s*''\s*;/,
    'BulkExit must stay a two-member union of string literals');
  const declared = /export type BulkExit =([^;]*);/.exec(
    fs.readFileSync(COVERAGE_SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' '),
  );
  assert.ok(declared);
  assert.deepEqual([...declared[1]!.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]),
    ['file-cap', 'answer-found']);
});

test('both walkers take their entries from the ledger and nowhere else', () => {
  // A backstop, and labelled as one: the accounting can only audit directories
  // it opened, so a walk that called `readdirSync` itself would step around it.
  // This is a lexical rule and carries the weakness of every lexical rule — it
  // is here because the cheap version of that bypass is worth catching, not
  // because the property rests on it. The expensive version (hand-rolling a
  // `DirectoryListing` so the plan function still typechecks) is a disclosed
  // residual on `BulkExit`, and is a written act rather than an absence.
  for (const walker of [STRUCTURE_WALK_SRC, COLLAPSE_WALK_SRC]) {
    const body = strip(fs.readFileSync(walker, 'utf8'));
    assert.equal(/\breaddir(?:Sync)?\s*\(/.test(body), false,
      `${path.basename(walker)} calls readdir directly. A bounded scan reads a`
      + ' directory through ScanCoverage.open, which counts the entries at the'
      + ' syscall; a readdir the ledger never saw is a subtree the audit cannot'
      + ' account for.');
  }
});

test('neither bounded scan can dispose of an entry without naming a disposition', () => {
  for (const walker of WALKERS) {
    const body = functionBody(walker.file, walker.fn, true);
    // A bare `continue` is how all three collapse-walk defects and the two
    // structure-walk ones were spelled: the entry is dropped, the loop moves on,
    // nothing anywhere records that part of the project went unread. There is no
    // legitimate use of one in a walker that routes every entry through a plan
    // union — the "keep going" case is an arm of the union, not a control-flow
    // token — so the rule is simply that there are none.
    assert.equal(/(^|[^\w.])continue\b/.test(body), false,
      `${walker.fn}() contains a \`continue\`. Every way this walk declines to read`
      + ' something must be a ScanExit returned by its plan function, so that'
      + ' `withdrawsCoverage` decides whether it cost anything. A `continue` here'
      + ' skips that decision, which is the defect this plan item exists for.');
    // Same argument for `catch`: an I/O failure swallowed in the loop is an
    // unread subtree with no record. Failures belong in the plan functions,
    // where the only thing a catch may do is name an exit.
    assert.equal(/(^|[^\w.])catch\b/.test(body), false,
      `${walker.fn}() contains a \`catch\`. A read that failed is a withdrawal;`
      + ' handle it in the plan function so it comes back as a named ScanExit.');
  }
});

test('every plan function answers with a named disposition, on every path including failure', () => {
  for (const planner of PLANNERS) {
    const body = functionBody(planner.file, planner.fn);
    const returns = [...body.matchAll(/\breturn\b\s*([\s\S]{0,24})/g)];
    assert.ok(returns.length > 0, `${planner.fn}() returns nothing`);
    for (const match of returns) {
      assert.match(match[1]!, /^\{\s*action:/,
        `${planner.fn}() has a \`return\` that is not a named disposition:`
        + ` \`return ${match[1]!.trim()}…\`. Every answer must be an EntryPlan or`
        + ' DirectoryPlan literal, so the walker\'s switch is exhaustive and a new'
        + ' shape is a type error rather than a silent fallthrough.');
    }
    // A `catch` that does anything other than answer immediately is the
    // absence this plan item keeps finding: the failure is observed and then
    // forgotten. Requiring the return to be the catch block's first token is
    // stricter than requiring one somewhere inside it, and deliberately.
    for (const match of body.matchAll(/\bcatch\b[^{]*\{\s*([\s\S]{0,20})/g)) {
      assert.match(match[1]!, /^return\s*\{\s*action:/,
        `${planner.fn}() has a \`catch\` that does not immediately name a ScanExit.`
        + ' A failed read is a withdrawal; say which one before doing anything else.');
    }
  }
});

test('a scan exit nobody has classified withdraws coverage, by construction', () => {
  // The DIRECTION is the whole point. `withdrawsCoverage` is the negation of an
  // explicit no-loss list, so a member added to `ScanExit` next year withdraws
  // until somebody goes to `NO_LOSS` and argues it out. Spelled the other way
  // round — a WITHDRAWING list, negated — the same edit would join the exempt
  // set silently, which is the shape of every defect in rounds 1 through 5.
  const source = strip(fs.readFileSync(COVERAGE_SRC, 'utf8'));
  assert.match(source, /function withdrawsCoverage\([^)]*\)\s*:\s*boolean\s*\{\s*return\s*!\s*NO_LOSS\.has\(/,
    'withdrawsCoverage must remain the NEGATION of the no-loss set. If it becomes'
    + ' membership in a withdrawing set, an unclassified exit stops costing'
    + ' anything and this plan item regresses in silence.');

  // And the negation is load-bearing at runtime, not only in the source text: a
  // kind that is in no list at all is treated as a loss. No fixture can reach
  // this through a walker — that is exactly why it is asserted directly.
  const unclassified = 'route-invented-next-year' as unknown as ScanExit;
  assert.equal(withdrawsCoverage(unclassified), true);
  const ledger = scanCoverage();
  ledger.exit(unclassified, 'apps/web/src/features/widgets');
  assert.equal(ledger.withdrawals.length, 1);
  assert.match(ledger.withdrawals[0]!, /apps\/web\/src\/features\/widgets/);
});

test('the exported exit list and the union cannot drift apart', () => {
  // `SCAN_EXITS` is what a reader (and the closure test above) treats as the
  // enumeration. If the union grows and the list does not, the closure is
  // reasoning about a stale set. The type already forces WITHDRAWAL_MESSAGE to
  // stay complete; this covers the one member the compiler cannot.
  // Comments only — the members ARE string literals, so `strip` would eat them,
  // and every member of this union carries a paragraph of justification whose
  // punctuation would otherwise end the declaration early.
  const source = fs.readFileSync(COVERAGE_SRC, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const union = source.slice(source.indexOf('export type ScanExit ='));
  const members = new Set(
    [...union.slice(0, union.indexOf(';')).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!),
  );
  assert.deepEqual([...members].sort(), [...SCAN_EXITS].sort(),
    'SCAN_EXITS and the ScanExit union disagree. Add the new member to both —'
    + ' and note that leaving it out of NO_LOSS is the correct default, not an'
    + ' oversight.');
});

test('the exempt-set tally in the prose is the tally in the arrays', () => {
  // A number in a comment is a claim, and this one was WRONG when a reviewer
  // checked it: the header said an eight-member exempt set against a fourteen-
  // member union while the arrays held nine against sixteen, and the argument
  // built on it ("an author must argue their way in") is only as strong as the
  // ratio. Rather than fix the digits and wait for them to rot again, the digits
  // are now readable and read.
  const source = fs.readFileSync(COVERAGE_SRC, 'utf8');
  const claimed = /The exempt set is MOST of the union: (\d+) of (\d+)\./.exec(source);
  assert.ok(claimed, 'the NO_LOSS header must state the ratio it is claiming, in digits');
  const exempt = SCAN_EXITS.filter((exit) => !withdrawsCoverage(exit));
  assert.equal(Number(claimed[1]), exempt.length,
    `the NO_LOSS header claims ${claimed[1]} exempt exits; ${exempt.length} do not withdraw`);
  assert.equal(Number(claimed[2]), SCAN_EXITS.length,
    `the NO_LOSS header claims a ${claimed[2]}-member union; SCAN_EXITS has ${SCAN_EXITS.length}`);
  assert.ok(exempt.length * 2 > SCAN_EXITS.length,
    'the exempt set is no longer most of the union, so the header now UNDERSTATES the'
    + ' property. Reword it rather than leaving a pessimistic claim in place.');
});

test('every exit either costs nothing or can say what went unread', () => {
  // A withdrawing exit with an empty message would record a withdrawal the
  // report cannot describe — the count would rise and the reader would learn
  // nothing about which part of the project went unjudged.
  for (const exit of SCAN_EXITS) {
    if (!withdrawsCoverage(exit)) continue;
    const ledger = scanCoverage();
    ledger.exit(exit, 'some/path.tsx');
    assert.equal(ledger.withdrawals.length, 1, exit);
    assert.ok(ledger.withdrawals[0]!.length > 'some/path.tsx'.length + 4,
      `${exit} withdraws coverage but says nothing about why`);
  }
});

test('the withdrawal ledger stays bounded without under-reporting the count', () => {
  // Messages are reported verbatim, so a pathological tree could otherwise turn
  // one finding into a megabyte. What must NOT be bounded is the count: a
  // truncated list that also truncated the total would be this plan item again,
  // one level down — a bound that forgives what it could not fit.
  const ledger = scanCoverage(3);
  for (let index = 0; index < 50; index += 1) ledger.exit('unfollowed-link', `link-${index}`);
  assert.equal(ledger.withdrawals.length, 4);
  assert.match(ledger.withdrawals[3]!, /\+47 further withdrawals/);
});
