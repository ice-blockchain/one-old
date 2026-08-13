// src/test-support/__tests__/budget-census.ts
// Which assertions in this repository hold a WALL CLOCK to a number?
//
// WHY THIS IS NOT "WHICH FILES IMPORT THE INSTRUMENT". That was the previous
// definition, and it is the error of counting the population that already
// adopted the fix: every file using assertLatencyBudget is by construction a
// file whose budget the instrument governs, so the answer was guaranteed
// complete about itself and silent about everything else. It missed a 150 ms
// p95 assertion in the plan-guard tests — same threshold, same 250 samples,
// same 20 warmups, same percentile index as the budget the three-valued
// instrument was built for — written by hand with `assert.ok(p95 < 150)`. It
// imported nothing, so it was invisible; it was not named by the serial job, so
// it was never measured anywhere a verdict is possible; and it ran only inside
// the parallel suite, which the instrument's own header says is not evidence in
// either direction. Un-enforced and flake-prone at the same time.
//
// So the census starts from the SHAPE instead: a clock read, a difference, and
// an assertion comparing something derived from that difference against a
// numeric literal. That finds the hand-rolled ones whatever they import and
// whatever they call their variables.
//
// WHAT IT CANNOT SEE, stated because the whole argument above is that this file
// finds the SHAPE rather than the import — and a shape-finder with unlisted
// blind spots is an import-checker wearing a better sentence. It matches an
// assertion line carrying `<identifier> <op> <number>` where the identifier is
// reachable from a clock difference, so three spellings pass it unseen:
//
//   - an inline threshold with no name on the left, e.g.
//     `assert.ok(performance.now() - t0 < 150)` — there is no identifier to
//     seed or to close over;
//   - a threshold held in a named constant, `assert.ok(p95 < BUDGET_MS)` — the
//     comparison's right-hand side has to be a numeric literal (or arithmetic
//     over literals) for the recorded claim to say what the bound IS;
//   - an assertion split across lines, since the scan is per line.
//
// None of the three exists in this repo today, which is why they are recorded
// here instead of implemented: each one costs either a real parser or a looser
// pattern whose extra rows get the classification below rubber-stamped. If one
// appears, this list is where to start.
//
// WHAT IT DELIBERATELY DOES NOT DECIDE. It cannot tell a latency BUDGET ("this
// path is fast") from a boundedness assertion ("this wait was capped, and here
// is a threshold with 40x of slack in it"). Both are wall-clock claims and both
// belong in the count; which one a site is, is a judgement, and
// latency-budget-ci.test.ts records that judgement per site rather than letting
// this file guess. A census that quietly filtered by intent would be the same
// mistake in a new place.

/** One assertion that compares a timing-derived value against a number. */
export interface WallClockClaim {
  /** Repo-relative, forward-slashed. */
  readonly file: string;
  /** 1-based line of the assertion. */
  readonly line: number;
  /** Normalized `<identifier> <op> <number>`, stable across reformatting. */
  readonly claim: string;
  /** True when the comparison caps the elapsed time — the direction contention breaks. */
  readonly upperBound: boolean;
}

const CLOCK = /performance\.now\(\)|Date\.now\(\)|process\.hrtime(?:\.bigint)?\(\)/;
const ASSERTION = /\bassert(?:\.[A-Za-z]+)?\s*\(/;
/**
 * `x < 150`, `150 > x`, either operator direction, `_` separators allowed, and
 * the threshold may be arithmetic: `elapsed < 250 * 40` is a 10 s bound written
 * as its origin times its slack, and recording it as `< 250` would report a
 * threshold forty times stricter than the one in the file.
 */
const NUMBER = String.raw`\d[\d_]*(?:\.\d+)?(?:\s*[*/+-]\s*\d[\d_]*(?:\.\d+)?)*`;
const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`;
const COMPARISON = new RegExp(
  `(${IDENTIFIER})\\s*(<=?|>=?)\\s*(${NUMBER})|(${NUMBER})\\s*(<=?|>=?)\\s*(${IDENTIFIER})`,
  'g',
);

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * Identifiers in this file that hold, or are derived from, an elapsed time.
 *
 * Seeded from a clock difference and closed transitively, because the shape the
 * census has to catch spreads the value over three statements:
 *
 *   durations.push(performance.now() - started);   // seed:    durations
 *   durations.sort((a, b) => a - b);
 *   const p95 = durations[Math.floor(durations.length * 0.95)]!;   // closure: p95
 *   assert.ok(p95 < 150);                          // the claim
 *
 * Nothing here parses TypeScript. The closure is over textual mentions, which
 * over-approximates — a variable that merely mentions a timing variable joins
 * the set — and that direction is the safe one: an extra candidate produces an
 * extra row a human classifies once, a missing one produces an un-enforced
 * budget nobody sees.
 */
function timingDerived(codeLines: readonly string[]): Set<string> {
  const derived = new Set<string>();
  const declare = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.*)$/;
  const mutate = /^\s*([A-Za-z_$][\w$]*)\s*(?:\+|-|\*|\/)?=\s*(.*)$/;
  const push = /([A-Za-z_$][\w$]*)\.push\(\s*(.*)$/;

  for (const line of codeLines) {
    // A difference of two clock reads is the only seed. `Date.now()` alone is a
    // timestamp, and this repo is full of those.
    if (!CLOCK.test(line) || !line.includes('-')) continue;
    for (const pattern of [declare, mutate, push]) {
      const match = pattern.exec(line);
      if (match) derived.add(match[1]!);
    }
  }
  if (derived.size === 0) return derived;

  const mentions = (text: string): boolean => (
    [...derived].some((name) => new RegExp(`\\b${name}\\b`).test(text))
  );
  // A fixpoint, bounded: each pass can only add, and the chains in practice are
  // two or three links long.
  for (let pass = 0; pass < 8; pass += 1) {
    const before = derived.size;
    for (const line of codeLines) {
      for (const pattern of [declare, push]) {
        const match = pattern.exec(line);
        if (match && mentions(match[2] ?? '')) derived.add(match[1]!);
      }
    }
    if (derived.size === before) break;
  }
  return derived;
}

/**
 * Every wall-clock threshold assertion in one source file.
 *
 * `text` is the file's contents; `file` is only used to label the rows.
 */
export function wallClockClaimsIn(file: string, text: string): WallClockClaim[] {
  if (!CLOCK.test(text)) return [];
  const lines = text.split('\n');
  const codeLines = lines.map((line) => (isCommentLine(line) ? '' : line));
  const derived = timingDerived(codeLines);
  if (derived.size === 0) return [];

  const claims: WallClockClaim[] = [];
  for (const [index, line] of codeLines.entries()) {
    if (!ASSERTION.test(line)) continue;
    for (const match of line.matchAll(COMPARISON)) {
      const identifier = match[1] ?? match[6] ?? '';
      const operator = match[2] ?? match[5] ?? '';
      const literal = (match[3] ?? match[4] ?? '').replace(/_/g, '');
      const root = identifier.split('.')[0] ?? '';
      if (!derived.has(root)) continue;
      // `x < n` and `n > x` are the same claim; normalize to the first form so
      // the recorded judgement does not depend on which way it was written.
      const flipped = match[4] !== undefined;
      const normalizedOperator = flipped ? operator.replace('<', '\u0000').replace('>', '<').replace('\u0000', '>') : operator;
      claims.push({
        file,
        line: index + 1,
        claim: `${identifier} ${normalizedOperator} ${literal}`,
        upperBound: normalizedOperator.startsWith('<'),
      });
    }
  }
  return claims;
}
