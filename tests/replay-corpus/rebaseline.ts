// tests/replay-corpus/rebaseline.ts
// The ONE supported way to update tests/replay-corpus/snapshot.txt. Never
// invoked by `npm test`, `npm run gen`, `npm run build`, or
// `npm run golden:update` — it is a deliberate, separate, manual step, named
// so nobody runs it by muscle memory the way `golden:update` gets run.
//
// Usage:
//   npm run replay:rebaseline -- --confirm-verdict-change
//
// Use the SCRIPT, not a bare `npx tsx tests/replay-corpus/rebaseline.ts`: the
// script goes through the same `node --import ./src/build/test-preload.mjs`
// entry the test does, so the snapshot's WRITER and its READER cannot differ in
// environment. This mattered concretely — the corpus was previously captured
// under the maintainer's ambient TRAFFIC_ONE_PLUGIN_ROOT and verified under the
// preload's pinned one, and four agent-model rows diverged on the next run.
// env.ts now pins that root itself (so a bare invocation is no longer WRONG),
// and the post-run assertion below refuses to write if anything moved it during
// the replay. Belt and braces, deliberately: a baseline written under the wrong
// environment is invisible until it wastes someone's afternoon.
//
// Without the flag this refuses to write anything: it runs the full corpus,
// diffs the result against the committed snapshot, and prints that diff (or
// "no changes") so you decide whether writing is warranted BEFORE typing the
// flag. With the flag, it writes the new snapshot and then prints the exact
// same diff again as a mandatory "did you mean to approve this" echo — the
// diff is the last thing on the screen either way, never scrolled past by a
// success banner.

import * as fs from 'fs';
import { CORPUS_PLUGIN_ROOT } from './env';
import { replayCase } from './run-case';
import { ALL_CASES, assertUniqueCaseIds } from './cases';
import { formatSnapshot, SNAPSHOT_PATH } from './snapshot';

function readCurrent(): string {
  try {
    return fs.readFileSync(SNAPSHOT_PATH, 'utf8');
  } catch {
    return '';
  }
}

function diffLines(before: string, after: string): string[] {
  const beforeLines = new Set(before.split('\n').filter((l) => l && !l.startsWith('#')));
  const afterLines = after.split('\n').filter((l) => l && !l.startsWith('#'));
  const beforeSet = beforeLines;
  const afterSet = new Set(afterLines);
  const out: string[] = [];
  for (const line of before.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    if (!afterSet.has(line)) out.push(`- ${line}`);
  }
  for (const line of afterLines) {
    if (!beforeSet.has(line)) out.push(`+ ${line}`);
  }
  return out;
}

async function main(): Promise<void> {
  assertUniqueCaseIds(ALL_CASES);
  const outcomes = [];
  for (const spec of ALL_CASES) outcomes.push(await replayCase(spec));
  // Post-condition, checked before anything is written: the plugin root the
  // corpus pinned is still the plugin root the run finished with. A handler that
  // moved it mid-run would have produced verdicts the verifying test cannot
  // reproduce, and a snapshot written from those is worse than no snapshot.
  if (process.env.TRAFFIC_ONE_PLUGIN_ROOT !== CORPUS_PLUGIN_ROOT) {
    throw new Error(
      'rebaseline: the plugin root moved during the replay — refusing to write a snapshot the '
      + `verifying test cannot reproduce.\n  expected: ${CORPUS_PLUGIN_ROOT}\n  actual:   ${process.env.TRAFFIC_ONE_PLUGIN_ROOT}`,
    );
  }
  const next = formatSnapshot(outcomes);
  const current = readCurrent();
  const diff = diffLines(current, next);

  const confirmed = process.argv.includes('--confirm-verdict-change');
  if (!confirmed) {
    if (diff.length === 0) {
      process.stdout.write('rebaseline: no changes — snapshot already matches the corpus. Nothing to confirm.\n');
      return;
    }
    process.stdout.write(
      `rebaseline: DRY RUN (no flag passed, nothing written). ${diff.length} line(s) would change:\n\n`
      + `${diff.join('\n')}\n\n`
      + 'Every line above must be an intended verdict change (an annotated relaxation/'
      + 'tightening) or a regression you are about to fix instead of paper over. If you '
      + 'have reviewed and intend this, re-run with --confirm-verdict-change to write it.\n',
    );
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(SNAPSHOT_PATH, next, 'utf8');
  process.stdout.write(
    `rebaseline: wrote ${outcomes.length} case outcomes to ${SNAPSHOT_PATH}.\n\n`
    + `${diff.length} line(s) changed — re-read this diff now, it is not a formality:\n\n`
    + `${diff.length ? diff.join('\n') : '(none — snapshot was already up to date)'}\n`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
