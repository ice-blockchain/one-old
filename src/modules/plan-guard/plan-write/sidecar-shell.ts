// src/modules/plan-guard/plan-write/sidecar-shell.ts
// Shell channels that DESTROY runtime-owned run sidecars without ever naming
// one. `shellTrafficOneWriteTargets` makes a named `.traffic-one/runs/<id>/<file>`
// visible to the same gate Write/Edit/apply_patch pass through, which is why
// `rm`, `mv`, `sed -i`, a redirect and a heredoc onto that path are all already
// refused by `runtime-sidecar-owner-gate`. Four channels named no file it could
// see, and all four returned `noop` while deleting `scan-bound.json`,
// `verification-v2.json`, `assignments.json` and `run.json`:
//
//   rm -rf .traffic-one/runs/<id>          the target is the DIRECTORY, and the
//                                          sidecar regex needs a file under it
//   find .traffic-one/runs -name … -delete no path token matches at all
//   node -e "…unlinkSync('…')"             `require('fs').unlinkSync` is not one
//                                          of the write primitives that arms the
//                                          target scan
//   git clean -fdx                         names nothing whatsoever
//
// That was not a cosmetic hole. This round makes `scan-bound.json` load-bearing
// for how much browser evidence a run owes, and shell deletion is exactly what
// these do.
//
// Resolved the same way the named channels are: name the FILES the command would
// destroy, so the deny that follows is the existing per-target one, with a real
// path in it, rather than a second prose surface. Nothing on disk to destroy →
// nothing returned, so a project with no run state keeps every one of these
// commands, and so does an `rm -rf` anywhere outside the runs tree.
//
// WHAT THIS MODULE DOES NOT CLOSE, stated here because the previous version of
// this header asserted the channels were closed and the gate's prose promised
// the same. Both have been narrowed to match; the shipped deny now says the
// refusal holds whenever the path is READABLE FROM THE COMMAND TEXT, and says
// plainly that it does not otherwise.
//
// A peer drove 75 respellings through both detectors against round 6 and found
// five open routes OUTSIDE the four families below, all of which this round
// closes: a two-level `bash -c`, any flag between the shell name and `-c`
// (`bash -o pipefail -c` is a common agent idiom), `git stash push -u -m wip`,
// a heredoc-fed interpreter, and `rmSync` on the runs DIRECTORY rather than a
// file under it. Each fix is annotated at its site, and the comment that
// claimed the first of them was already closed is gone — a header asserting a
// closure that does not exist is this lane's named generative defect, and the
// sentence would have come out whether or not the route did.
//
// FAMILY 3 USED TO BE LISTED HERE AS A DELIBERATE NON-REFUSAL AND THE REASON
// GIVEN WAS FALSE. It read: "`git checkout -- .traffic-one/runs` and `git stash
// push .traffic-one/runs`. Left deliberately: runtime sidecars are untracked,
// and neither command removes an untracked file." Untrackedness is a property
// of the REPOSITORY, not of the path. `.gitignore` never untracks what is
// already committed, and this repo's own `scaffold-content.ts` records
// `.traffic-one/runs/**` — including a 65 KB debug log — having shipped
// committed in the field. Measured in that state, WITH the ignore entry
// present: `git checkout -- .traffic-one/runs`, `git checkout .`, `git restore
// .` and `git reset --hard` each reverted `scan-bound.json` to its committed
// bytes and rolled the reset ladder back to free, all four at gate `noop`. The
// ignore entry is nearly the wrong axis for this channel and the argument is
// not rebuilt on it: `git checkout --` needs the path in the INDEX, and a
// negated `!` entry cannot re-include a file whose parent directory is
// excluded. Every worktree-rewriting git spelling is now refused when its
// pathspec covers the runs tree, via `gitWorktreeRewritePathspecs`.
//
// What remains open, in three families:
//
//   1. The path is hidden by shell EVALUATION, so no static reading can find
//      it: `cd .traffic-one/runs && rm -rf R`, `(cd .traffic-one && rm -rf
//      runs)`, `rm -rf "$(echo .traffic-one/runs)/R"`, `eval "rm -rf …"`.
//      Closing these needs an evaluator, not a regex — a `cd` tracker alone
//      would still miss the other three and would misjudge every compound
//      command that changes directory for an unrelated reason.
//   2. The path is ASSEMBLED inside interpreter code, and ROUND 5 NARROWED THIS
//      to the cases where no complete `.traffic-one` path survives in the
//      command text at all (`'.traffic' + '-one'`, a base64 blob, a name bound
//      earlier and used later). A join or a template literal whose LITERAL part
//      still spells a directory Traffic One owns is refused now: the extraction
//      falls back to that directory (see `note`), and the read/write question is
//      answered from the whole enclosing nest, so
//      `zipfile.ZipFile(os.path.join('<run dir>','run.json'),'w')` refuses at
//      the `ZipFile` even though `os.path.join` is on the read list.
//   3. A project script that does it (`npm run reset:state`). The bytes are in
//      package.json, not in the command.
//
// Plus one bound rather than a family: nesting deeper than `MAX_SHELL_NESTING`
// levels of `-c`. The enumeration bound (`MAX_WALK_DEPTH`) is NOT a residual —
// nested sidecars are real, and every real one is exactly ONE directory below
// the run id: `runs/<id>/debug/` (decision-log.ts:171, claim-capture.ts:57),
// `pending/` and `claims/` (run-agent/run-paths.ts:295,304), `superseded/`
// (run-agent/claim-thread-role.ts:95) and `agent-activity-denies/`
// (run-agent/activity.ts:131).
//
// The previous version of this sentence cited `runs/<id>/qa/evidence/*` as a
// depth-3 writer and no such writer exists: the QA runner writes
// `.traffic-one/reports/qa/<runId>/…` (qa-evidence/run-context.ts,
// qa-report-v2/schema.ts), a SIBLING tree that `runtimeOwnedRunSidecar` does not
// match at all. The only occurrence of that string in non-test `src/` was the
// comment asserting it, and the test that "pinned" the depth created the
// directory in its own fixture — so the assertion held against a shape the
// product never produces. Same class as a deny paragraph citing a closure that
// does not exist, one layer down.
//
// Families 1 and 2 are the honest residue: an agent that WANTS to destroy a
// sidecar can, and what stands between it and the floor is the run-team gate
// refusing unverifiable shell writes, plus the fact that a missing sidecar
// fails closed at settlement rather than passing.

import * as fs from 'fs';
import * as path from 'path';

import { isDoctorIdArgument } from '../../../shared/doctor-command';
import {
  COMMAND_WORD_PREFIX,
  compressorKeepsInput,
  DESTRUCTIVE_VERBS,
  findWriteAction,
  gitWorktreeRewritePathspecs,
  HEREDOC_INTERPRETER_RE,
  INTERPRETER_NAMES,
  NAMED_OUTPUT_TOOLS,
  namedOutputDestinations,
  OVERWRITE_TOOLS,
  globPatternIsUnreadable,
  globSegmentMatches,
  pathLiteralHasGlob,
  pathLiteralIsUnresolved,
  pathLiteralPrefix,
  REPLACING_COMPRESSORS,
  rsyncIsDryRun,
  SHELL_NAME,
  shellReadPieces,
  shellStatementHead,
  shellWordsOf,
  trafficOnePathsNamedOutsideRead,
  trafficOnePathTail,
  unescapeDoubleQuoted,
  VERB_ANCHOR,
} from '../../../shared/shell-vocabulary';
import { runtimeOwnedRunSidecar } from '../plan-readiness/contracts';

const RUNS_DIR = '.traffic-one/runs';
// Cheap pre-filter: nothing below can fire without one of these verbs, and this
// runs on every shell call the plan gate sees.
//
// The anchor class accepts a QUOTE as well as whitespace and the operators. The
// old class did not, and `bash -c 'rm .traffic-one/runs/R/scan-bound.json'` was
// therefore invisible while `bash -c 'cd . && rm …'` — the same deletion with a
// no-op in front of it, so that a space preceded the verb — was refused.
// Measured on a fixture holding four real sidecars: five nested-shell spellings
// open before, zero after. The exposure was never sidecar-specific: any mutating
// verb as the FIRST token inside a `-c` body sat behind the same anchor.
//
// Both the anchor and the verb list now come from `shared/shell-vocabulary`,
// shared with the write detector in `shared/feature-source.ts`. That module's
// copy of this list had `truncate` while this one did not, and this one had the
// quote in the anchor while that one did not — four such divergences were found
// in one review pass, each already fixed on the other side.
const DESTRUCTIVE_VERB_RE = new RegExp(
  `${VERB_ANCHOR}${COMMAND_WORD_PREFIX}`
  + `(?:${DESTRUCTIVE_VERBS}|${OVERWRITE_TOOLS}|${REPLACING_COMPRESSORS}|${NAMED_OUTPUT_TOOLS}`
  + `|find|git|dd|tar|${INTERPRETER_NAMES})\\b`,
);
/**
 * `sh|bash|… [flags] -c '<body>'`, with the body as a capture.
 *
 * Accepting the quote in the anchor above is necessary and not sufficient: the
 * pre-filter then passes, but `destroyedScopes` tokenizes the piece as
 * `['bash', '-c', 'rm …']` and dispatches on the verb `bash`, which has no arm.
 * So the body is spliced back in as its own command piece before parsing.
 *
 * The FLAG RUN before `-c` is the round-7 fix. The previous spelling required
 * the `-c` immediately after the shell name, so `bash --norc -c '…'`, `bash
 * --noprofile --norc -c '…'` and `bash -o pipefail -c '…'` were all invisible —
 * and the last is a very common agent idiom. Only flags are accepted between
 * them, plus the one bare word an option like `-o` takes as its argument, so
 * this does not start matching `bash script.sh` shapes that never had a `-c`.
 */
const NESTED_SHELL_RE = new RegExp(
  String.raw`\b(?:[^\s;&|]*\/)?${SHELL_NAME}`
  + String.raw`(?:\s+(?:-[a-zA-Z-]+\s+[A-Za-z][\w=.-]*|-[^\s;&|'"]+|\\\n))*?`
  + String.raw`\s+(?:-[a-zA-Z]*c[a-zA-Z]*)\s+(?:'([^']*)'|"((?:\\.|[^"\\])*)")`,
  'g',
);

/**
 * How many times `withNestedShellBodies` re-enters. Two-level `bash -c "bash -c
 * '…'"` needs two, and the bound exists because the input is attacker-shaped:
 * nothing stops a command from nesting fifty deep, and each pass rescans the
 * whole accumulated text.
 */
const MAX_SHELL_NESTING = 4;

/**
 * The nested-shell bodies, appended as sibling commands, to a fixed point.
 *
 * Appended rather than substituted so the OUTER command keeps whatever it also
 * said — `cp x y && bash -c 'rm …'` must be judged on both halves — and so a
 * body that quotes a path harmlessly is judged exactly as it would be at the
 * top level. The wrapper keeps everything EXCEPT the quoted body it handed
 * over, which is emptied: see the note at the replacement for the read that
 * two copies of one path refused.
 *
 * This used to be a SINGLE pass, and the header used to claim that one pass
 * covered two levels: "`bash -c "bash -c '…'"` re-enters through the appended
 * copy". It did not. The appended copy is `bash -c 'rm …'`, which then
 * tokenizes to the verb `bash`, and `destroyedScopes` has no arm for `bash` —
 * so the deletion was invisible to both detectors while a comment asserted the
 * opposite. Now the extraction runs until it stops finding new bodies, bounded
 * by `MAX_SHELL_NESTING`; a command nested deeper than that is not refused, and
 * that is a residual rather than a closure.
 */
function withNestedShellBodies(command: string): string {
  let text = command;
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_SHELL_NESTING; depth += 1) {
    const bodies: string[] = [];
    const emptied = text.replace(NESTED_SHELL_RE, (whole: string, single?: string, doubled?: string) => {
      // A double-quoted body is RAW text and its escapes are still in it. See
      // `unescapeDoubleQuoted`: `bash -c "rm -rf \".traffic-one/runs\""` erased
      // every sidecar at gate `noop` because the operand tokenized as
      // `\".traffic-one/runs\"` and the literal came out one character too long.
      const body = (single ?? (doubled === undefined ? '' : unescapeDoubleQuoted(doubled))).trim();
      if (body && !seen.has(body)) {
        seen.add(body);
        bodies.push(body);
      }
      // The body is re-added below as a sibling command, so a COPY left inside
      // the wrapper makes the same path occur TWICE: once judged on its real
      // verb and once on `bash`, which owns no read arm. The read tests here
      // require EVERY occurrence to be a read, so the second copy refused
      // `bash -c 'bash -c '"'"'cat <a run sidecar>'"'"''` — a permitted read at
      // depth 1 — from depth 2 up.
      //
      // Emptied ONLY when the body carries a `.traffic-one` literal, which is
      // the only shape that can duplicate an occurrence. Emptying every body
      // instead re-opened five ground-truthed destructions in one run of the
      // corpus: `find <runs> -exec sh -c 'rm -f "$1"' _ {} \;` keeps its PATH in
      // the wrapper and its WRITE in the body, and `execActionWrites` reads that
      // body to classify the action — hand it `sh -c ''` and the action looks
      // like a read, so the `find` operand became read-only and the deletion
      // went to `noop`. Never the rest of the line either, because
      // `cp x y && bash -c '…'` must still be judged on the half that is not
      // the nest.
      if (!body.includes('.traffic-one')) return whole;
      const quoted = single !== undefined ? single.length : (doubled as string).length;
      return `${whole.slice(0, whole.length - quoted - 2)}''`;
    });
    if (bodies.length === 0) return text;
    text = `${emptied}\n${bodies.join('\n')}`;
  }
  return text;
}
// EVERY COMMAND IS JUDGED BY AN ALLOWLIST OF READS, NOT A MUTATION VOCABULARY.
//
// A private alternation of destructive spellings stood here through round 2, and
// round 3 replaced it with the shared capability × family fact table. A peer
// defeated both, the same way each time and with spellings taken from ordinary
// language documentation rather than from anything exotic:
// `File.open(p, File::WRONLY|File::TRUNC)`, `zipfile.ZipFile(p,'w')`,
// `os.renames(p, …)`, `File::Slurp::write_file(p,"")`,
// `Path::Tiny::path(p)->spew_utf8("")` — every one of them erasing a 30-byte
// record while this gate returned `noop`. Deleting the single token `delete`
// from the alternation that used to be here left the whole 8-file fence suite
// green (227/0) while `Pathname.new(p).delete` went from refused to invisible.
//
// The vocabulary is gone rather than widened, and there is now no line here to
// mutate. `pathIsReadOnlyInText` asks the question `reset-record-shell.ts` has
// been asking since it shipped — is this path named by anything that is not a
// READ? — which is fail-CLOSED: a destruction nobody has thought of yet is
// refused because it is not a read.
//
// ROUND 5 FINISHED THAT INVERSION AT THE TWO LEVELS IT HAD NOT REACHED, both of
// which were measured as live erasures at gate `noop`: the enclosing CALL NEST
// (one read head around the path — `str(…)`, `os.path.abspath(…)` — laundered
// any destruction outside it, six ground-truthed rows) and the MODE ARGUMENT,
// which was still a denylist, so a computed mode (`m='w'; open(p,m)`,
// `os.open(p, 1|512|1024)`) read as a read. Both are now allowlists over the
// same anchor.
//
// ROUND 6 REMOVED THE LAST PLACE THE OLD POLARITY STILL LIVED HERE: WHICH
// COMMANDS GET ASKED. The question was asked only of a command that matched
// `INTERPRETER_EVAL_RE` — an interpreter with an eval flag or a heredoc — so a
// PLAIN SHELL WRITER naming the sidecar outright was judged by the verb arms
// below and by nothing else, and the verb arms are a denylist. A peer
// ground-truthed four erasures through that gap, each `noop` here while
// `reset-record-shell.ts` refused the identical command on the identical file:
//
//   awk 'BEGIN{print "" > "<sidecar>"}'        no flag, no shell redirect: the
//                                              write is inside awk's program
//   curl -s -o <sidecar> file:///dev/null      -o truncates its output
//   openssl enc -in /dev/null -out <sidecar>   -out truncates
//   ex -sc '%d|x' <sidecar>                    an ex script rewrites in place
//
// None of the four is exotic and none was in any verb set — which is the
// standing property of verb sets, not a gap in this one. The read question is
// now asked of EVERY piece of EVERY command (`shellReadPieces` ×
// `trafficOnePathsNamedOutsideRead`), and the verb sets are kept only for the
// arm where they are the only instrument available: a destruction that names no
// runtime path at all (`rm -rf .`, `git clean -fdx`), where there is no
// occurrence to judge the position of.
//
// The affordability argument rests on the anchor this arm already had: it never
// runs on a command that does not spell a `.traffic-one` path, so the toolchain
// probes that killed an allowlist inversion in round 1 (`python3 -c 'import
// pytest'`, `node -e "require('./dist/…')"`) cannot reach it. Widening WHICH
// commands are asked does not widen that anchor.
//
// Two priced consequences, recorded because each reverses an earlier deliberate
// narrowing:
//   - `python3 -c "import os; os.removedirs('<run dir>')"` is refused again. It
//     raises on a non-empty directory and so destroys nothing on any scope this
//     module reports for, and round 3 removed the refusal for exactly that
//     reason. Keeping it permitted now would need a list of verbs known to be
//     harmless — an enumeration in the fail-open direction, which is the shape
//     being retired.
//   - a path named in shell position by a verb this fence does not recognise as
//     a read is refused whatever that verb does, so `cp <sidecar> /tmp/x` (a
//     READ of the sidecar, whose destination is elsewhere) and `echo "see
//     <sidecar>"` are refused. That is the same ruling `reset-record-shell.ts`
//     has shipped since it existed, in the same words, and the remedy for both
//     is a verb the fence knows.
//
// `-delete`, or a sweep whose ACTION WRITES what it matched — `findWriteAction`
// in the shared vocabulary, asked by this module (which roots the sweep) and by
// the read judgement (which asks whether `find <runs tree> -name '*.json' -exec
// cat {} \;` is reading the path it names). Both judgements have to agree about
// which actions write, so the question has one implementation.
//
// It asks the READ question, inverted this round from a derived list of writing
// verbs. The list was itself a fix — five words remembered here, missing
// `shred` and `truncate`, nine `noop` rows beside a denying `-exec rm -f {} +` —
// and derivation moved the failure rather than ending it: a peer put an
// INTERPRETER where the action verb goes (`-exec sh -c '…rm…'`, and the `bash`,
// `python3` and `env` spellings of the same idea) and added `-exec tee {}`, a
// verb no shared set carries at all. Six more erasures of a live `run.json`, all
// `noop`. What an action is not is now the question, and a `-c` body is
// re-entered as a command list rather than being a spelling to enumerate.
//
// THE PATH LITERAL is `trafficOnePathLiterals` in the shared vocabulary, and it
// is consumed by both judgements — a sentence that stood here while it was
// false. `feature-source.ts` kept its own `targetRe` with a different character
// class, and the claim rested on a cross-module TEST reading the shared regex
// rather than on either judgement doing so. Both call the shared extractor now.
// What they still do differently is FILTER, deliberately and for a reason
// written down at `VISIBLE_WRITE_TARGET_RE`: that module names per-target write
// PATHS, so it drops `.traffic-one/runs` (a directory, and the most destructive
// target there is) precisely because this module enumerates what lives under it
// and names those files instead. Measured across every corpus row: the
// unification moved zero rows in either direction.

// Bounds on the enumeration below. A run directory holds a handful of sidecars;
// these exist so a pathological tree cannot turn one hook into a filesystem walk.
const MAX_WALK_ENTRIES = 2_000;
const MAX_WALK_DEPTH = 6;

/**
 * THE SHARED WORD SPLITTER, and the reason it is shared is a blocker rather
 * than tidiness.
 *
 * This module owned a private tokenizer whose quoted-span branch ended a word at
 * the closing quote, so `rm -rf "$PWD"/.traffic-one/runs` — ONE word to the
 * shell — arrived here as two operands, and the second of them
 * (`/.traffic-one/runs`) is an absolute path resolving outside the project root.
 * `relativeTarget` therefore answered null, no scope was noted, and the whole
 * runs tree went at gate `noop` while every individual stage honoured its own
 * row. `shellWordsOf` is stage 3 of the pipeline contract and it forms the words
 * the shell forms, which is the unit every question below this line is asked
 * about.
 */
const shellTokens = shellWordsOf;

/**
 * Heredoc BODIES are data, not commands: a reviewer digest written as
 * `cat > …/reviewer.md <<'EOF'` whose findings quote `rm -rf .traffic-one/runs/…`
 * must not be refused for quoting it (the class observed in 8c-codex). The
 * caller already extracts the bodies, so drop those lines rather than re-parse
 * the heredoc grammar here.
 *
 * Unless an INTERPRETER is reading them, in which case they are the command and
 * dropping them is how the whole channel went unseen.
 */
function withoutHeredocLines(command: string, heredocBody: string): string {
  if (!heredocBody) return command;
  if (HEREDOC_INTERPRETER_RE.test(command)) return command;
  const bodyLines = new Set(heredocBody.split('\n'));
  return command
    .split('\n')
    .filter((line) => !bodyLines.has(line))
    .join('\n');
}

function relativeTarget(operand: string, workdir: string, projectRoot: string): string | null {
  if (!operand || operand.startsWith('-')) return null;
  const root = path.resolve(projectRoot);
  const absolute = path.isAbsolute(operand) ? path.resolve(operand) : path.resolve(workdir, operand);
  if (absolute === root) return '';
  if (!absolute.startsWith(`${root}${path.sep}`)) return null;
  return absolute.slice(root.length + 1).split(path.sep).join('/');
}

// Does removing this path take runtime sidecars with it? The project root and
// `.traffic-one` are ancestors of the runs tree; anything at or under
// `.traffic-one/runs` is the tree itself or a slice of it.
//
// A trailing `/*` is the same deletion written with the shell's expansion
// instead of the directory's name. Traffic One never sees the expansion — the
// hook is handed the literal token — so `rm -rf .traffic-one/*` used to resolve
// to the path `.traffic-one/*`, which is under nothing, and passed. Only a
// TRAILING run of `*` segments is unwrapped, and only down to a NON-EMPTY
// prefix: `.traffic-one/*/runs` names something this function cannot answer
// for, and a bare `rm -rf *` genuinely does not reach `.traffic-one` because
// the shell does not expand `*` over dotfiles. Guessing either way would be
// this same mistake pointed in the other direction.
//
// Returns the directory to enumerate, or null when the command reaches no
// sidecar — the glob prefix, not the token, because `sidecarsUnder` has to stat
// a path that exists.
/**
 * The runs-tree scope an OPERAND covers, or null.
 *
 * Three questions in order, and the order is the whole content: a literal this
 * module can resolve outright is resolved; a literal cut short by an
 * interpolation falls back to the longest complete DIRECTORY PREFIX; and a
 * literal whose prefix is unreadable falls back to what the REMAINDER spells,
 * because `$PWD/.traffic-one/runs` names Traffic One's tree under any root and
 * this module is handed the root.
 *
 * The empty prefix is the trap the last two rounds each fell into from opposite
 * sides. `runsTreeScope('')` covers EVERYTHING — it is how `rm -rf .` reaches
 * the enumeration — so treating an unreadable prefix as an empty one refuses
 * `rm -f "$f"`, and treating it as unanswerable permits `rm -rf
 * "$PWD/.traffic-one/runs"`. It is neither: it is a signal to ask the tail.
 */
function readableScope(rel: string): string | null {
  if (pathLiteralHasGlob(rel)) return globbedScope(rel);
  if (!pathLiteralIsUnresolved(rel)) return runsTreeScope(rel);
  const prefix = pathLiteralPrefix(rel);
  if (prefix) {
    const direct = runsTreeScope(prefix);
    if (direct !== null) return direct;
  }
  const tail = trafficOnePathTail(rel);
  if (!tail) return null;
  const literal = pathLiteralIsUnresolved(tail) ? pathLiteralPrefix(tail) : tail;
  return literal ? runsTreeScope(literal) : null;
}

/**
 * The runs-tree scope an operand carrying an UNEXPANDED GLOB covers, or null.
 *
 * AUTHORITATIVE for a globbed operand rather than one more fallback, and that is
 * the difference between closing the escape and buying an over-refusal with it.
 * The prefix fallback the interpolation path uses would answer `.traffic-one` for
 * `rm -rf .traffic-one/c?che` — a pattern that cannot match `runs` at all
 * (ground-truthed: the cache goes, the tree survives) — and refuse an ordinary
 * cache clean with a paragraph about `run.json`. So the pattern is WALKED
 * against the tree instead, segment by segment: a literal segment must be equal,
 * a globbed one must match, an interpolated one matches anything. Nothing
 * reaches the enumeration unless the pattern can really name this tree.
 *
 * The scope returned is the longest COMPLETE directory prefix — the part before
 * the first unreadable segment — because `sidecarsUnder` has to stat a path that
 * exists. The pattern itself is carried alongside it (`globPath`), so a pattern
 * that reaches the tree but names only PART of it filters the enumeration:
 * `rm -rf .traffic-one/runs/17150053*` names one finished run and must not be
 * priced as if it named the live one.
 *
 * WHICH OF THE TWO ACTUALLY DECIDES, measured rather than assumed: the walk below
 * is a FAST REJECT and not the fence. A mutant that deletes its `return null`
 * (M21) survives every suite in this lane at 114 executions of the mutated line,
 * because `globCoversPath` re-asks the same question of every enumerated sidecar
 * and answers it the same way — including for `rm -rf *`, where the leading-dot
 * rule is what keeps `.traffic-one` out. The walk is kept for the enumeration it
 * avoids, and is recorded here as unpinned so a later round does not mistake it
 * for the thing that closes the glob escape. `globCoversPath` is that thing, and
 * `r9-permit-glob-finished` is the row that pins it (mutant M22, killed).
 */
function globbedScope(rel: string): string | null {
  const segments = rel.split('/').filter((segment) => segment !== '' && segment !== '.');
  const required = RUNS_DIR.split('/');
  for (let index = 0; index < required.length; index += 1) {
    const segment = segments[index];
    // The operand is SHORTER than the tree and matched all the way down
    // (`.traffic-*`): removing it removes the tree.
    if (segment === undefined) break;
    if (!globSegmentMatches(segment, required[index]!)) return null;
  }
  const readable: string[] = [];
  for (const segment of segments) {
    if (pathLiteralIsUnresolved(segment)) break;
    readable.push(segment);
  }
  return readable.join('/');
}

/**
 * Does a globbed operand cover this sidecar — the file itself or any directory
 * above it?
 *
 * `rm -rf .traffic-one/run?` removes a DIRECTORY three levels above the sidecar,
 * so matching the pattern against the sidecar's own path would answer no. The
 * ancestors are what the pattern names.
 */
function globCoversPath(glob: string, sidecar: string): boolean {
  const pattern = glob.split('/').filter((segment) => segment !== '' && segment !== '.');
  const parts = sidecar.split('/');
  if (pattern.length > parts.length) return false;
  return pattern.every((segment, index) => globSegmentMatches(segment, parts[index]!));
}

function runsTreeScope(rel: string): string | null {
  const literal = rel.replace(/(?:\/\*)+$/, '');
  if (literal !== rel && literal === '') return null;
  const covers = literal === ''
    || literal === '.traffic-one'
    || literal === RUNS_DIR
    || literal.startsWith(`${RUNS_DIR}/`);
  return covers ? literal : null;
}

/**
 * The run the fence is protecting, or '' for "no run is live" — which routes
 * into the branch that protects EVERY run.
 *
 * `shellRuntimeSidecarDestruction` used to derive this with `.trim()` and a
 * non-empty test, so ANY non-empty string narrowed the enumeration and a value
 * no run directory can ever equal narrowed it to NOTHING. Measured at the gate
 * on a fixture holding two runs with real sidecars: with `currentRunId` set to
 * `..`, `.`, `/tmp/x`, `a/b`, a NUL, `../../../../../../tmp/t1-escape`, an id
 * 400 characters long, `<id>/`, or any well-shaped id naming no run at all,
 * `rm -rf .traffic-one` and `rm -rf .traffic-one/runs` both went from DENY to
 * PERMIT. Nothing escapes the project — the narrowing is simply switched off, so
 * the fence finds nothing to protect and the whole-tree wipe succeeds.
 *
 * TWO QUESTIONS, and the second is the one that matters. A SHAPE test alone
 * (`..` is not an id) closes the path-flavoured spellings and leaves
 * `currentRunId: 'no-such-run'` disarming the fence exactly as before, which
 * would be six literal values fixed and the general case open.
 *
 * The shape is `isDoctorIdArgument` (shared/doctor-command.ts) rather than a
 * regex written here: it is the repository's own id grammar, documented there as
 * the charset `safePathSegment` treats as a safe on-disk segment and shared with
 * tool-classify, reset-command, override and the reset runner. It is what the
 * MINTERS produce — `runIdNow()`'s epoch-ms string and the reset runner's
 * `${runIdNow()}-r` successor, whose own comment (reset.ts:319) justifies the
 * suffix as staying "inside both safePathSegment's charset and the gate
 * grammar's id shape". `/^\d{13}$/` was the tempting alternative and would have
 * been wrong in the expensive direction: it rejects that `-r` successor and
 * every legacy id `ensureCurrentRunId` hands back verbatim, so it would refuse
 * REAL runs.
 *
 * EXISTENCE is asked of the runs directory's own DIRECTORY entries rather than
 * with `existsSync`, and neither half of that is pedantry.
 *
 * The entry NAME, because this hook runs on case-insensitive filesystems, where
 * `existsSync` answers yes for `RUN-1` when only `run-1` exists — and the
 * comparison in `otherRun` is case-SENSITIVE, so that mismatch would skip every
 * sidecar of the run it was pointing at. An exact entry match cannot disagree
 * with that comparison. Every id the shape admits is `safePathSegment`-
 * invariant, so the name compared here is the name `runDir` builds.
 *
 * A real DIRECTORY, because a SYMLINK entry defeated the shape and the existence
 * test together: measured with `runs/run-linked` linked to a run directory
 * outside the project and `currentRunId: 'run-linked'`, both whole-tree wipes
 * PERMITTED again. The narrowing fired on the link's name while `sidecarsUnder`
 * — which walks `isDirectory()` entries and so does not follow it — could see
 * nothing under it to protect, leaving every real run classified as somebody
 * else's. The two questions have to be asked about the same kind of entry, and
 * `runDir` only ever makes a real directory.
 *
 * The cost of failing closed here is already-shipped behaviour: absent, empty
 * and whitespace pointers all protect every run today, so a pointer that names
 * no run protects every run too. What that costs is housekeeping — `rm -rf
 * .traffic-one/runs/<finished id>` is refused while the pointer is damaged —
 * and the module header has promised exactly this since the narrowing shipped:
 * the narrowing must not be reachable by breaking the thing it reads.
 */
function liveRunId(value: unknown, projectRoot: string): string {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  if (!isDoctorIdArgument(id)) return '';
  try {
    const entries = fs.readdirSync(path.join(projectRoot, RUNS_DIR), { withFileTypes: true });
    return entries.some((entry) => entry.name === id && entry.isDirectory()) ? id : '';
  } catch {
    // No readable runs tree: nothing to narrow, and `sidecarsUnder` enumerates
    // nothing either, so this costs no refusal.
    return '';
  }
}

function sidecarsUnder(projectRoot: string, rel: string): string[] {
  const scope = rel === '' || rel === '.traffic-one' ? RUNS_DIR : rel;
  const found: string[] = [];
  let seen = 0;
  const visit = (relDir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || seen >= MAX_WALK_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(projectRoot, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen >= MAX_WALK_ENTRIES) return;
      const child = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) visit(child, depth + 1);
      else if (entry.isFile() && runtimeOwnedRunSidecar(child)) found.push(child);
    }
  };
  try {
    const stat = fs.statSync(path.join(projectRoot, scope));
    if (stat.isFile()) return runtimeOwnedRunSidecar(scope) ? [scope] : [];
    if (!stat.isDirectory()) return [];
  } catch {
    return [];
  }
  visit(scope, 0);
  return found.sort();
}

/**
 * The tokens with `<flag> <value>` pairs removed, for options whose argument is
 * a separate word. `operandsOf` cannot know which flags take one, and reading
 * an option's argument as a path is how `git stash push -u -m wip` became a
 * one-pathspec command that named nothing (that case now lives in the shared
 * `gitWorktreeRewritePathspecs`; `truncate -s 0 <glob>` still needs this).
 */
function withoutOptionArguments(tokens: string[], flags: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (flags.includes(tokens[index]!)) {
      index += 1;
      continue;
    }
    out.push(tokens[index]!);
  }
  return out;
}

/** Every non-flag operand of one simple command, `--` honoured. */
function operandsOf(tokens: string[]): string[] {
  const operands: string[] = [];
  let flagsDone = false;
  for (const token of tokens) {
    if (!flagsDone && token === '--') { flagsDone = true; continue; }
    if (!flagsDone && token.startsWith('-') && token.length > 1) continue;
    operands.push(token);
  }
  return operands;
}

/**
 * `find . -name '*.log' -delete` sweeps the project root but can never match a
 * sidecar, and refusing it with a paragraph about `run.json` would be a lie. So
 * a find expression's own `-name`/`-path` patterns filter the enumeration:
 * present and matching nothing → the command destroys nothing here. No
 * pattern (`find .traffic-one/runs -delete`) filters nothing, which is correct.
 */
function findNamePatterns(tokens: string[]): Array<{ glob: string; wholePath: boolean }> {
  const patterns: Array<{ glob: string; wholePath: boolean }> = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const flag = tokens[index]!;
    if (/^-i?name$/.test(flag)) patterns.push({ glob: tokens[index + 1]!, wholePath: false });
    else if (/^-i?(?:path|wholename)$/.test(flag)) patterns.push({ glob: tokens[index + 1]!, wholePath: true });
  }
  return patterns;
}

/**
 * Does a find pattern match this name?
 *
 * A PATTERN THIS STAGE CANNOT READ MATCHES EVERYTHING, because the only thing
 * these patterns do is NARROW a refusal, and a filter that cannot be read must
 * not narrow one. Round 10 measured the cost of the other direction:
 * `find . -name \*.json -delete` erased 13 of the 15 files under
 * `.traffic-one/runs` at gate `noop` while `find . -name '*.json' -delete` — the
 * same sweep, quoted instead of escaped — was refused. The escaped pattern
 * reached here carrying a backslash the tree never has, so it matched no
 * sidecar and filtered the whole enumeration away. Stage 3 deliberately leaves
 * `\*` unresolved (removing it would manufacture a glob out of data), which is
 * exactly the residue this guard exists to answer for.
 */
function globMatches(glob: string, value: string): boolean {
  if (globPatternIsUnreadable(glob)) return true;
  const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i').test(value);
}

interface DestroyedScope {
  rel: string;
  patterns: Array<{ glob: string; wholePath: boolean }>;
  /** The operand as written when it carries an unexpanded glob: `rel` is the
   *  directory that can be statted, this is what the pattern actually names. */
  globPath?: string;
}

function destroyedScopes(command: string, workdir: string, projectRoot: string): DestroyedScope[] {
  const scopes: DestroyedScope[] = [];
  const note = (operand: string, patterns: DestroyedScope['patterns'] = []): void => {
    const rel = relativeTarget(operand, workdir, projectRoot);
    if (rel === null) return;
    // A PARTIAL PARSE MUST NOT READ AS AN ABSENT TARGET. On a template-literal
    // path the extractor yields `.traffic-one/runs/${r` — its character class
    // stops at `}` — and that truncated string statted as nothing, enumerated
    // nothing, and the command passed as if it had named no runtime path at
    // all. A `$RUN_ID` operand in an ordinary `rm -rf .traffic-one/runs/$R`
    // failed the same way. Both fall back to the longest part of the path that
    // IS readable, which is a scope this module can enumerate.
    //
    // PRICED: `rm -rf .traffic-one/runs/$OLD_RUN` is now refused where the same
    // deletion with the id spelled out is permitted housekeeping, because a
    // variable id may be the live run and this fence cannot tell. The remedy is
    // to spell the id. Resolving it is family 1 above — an evaluator, not a
    // regex.
    //
    // AN EMPTY READABLE PREFIX USED TO FALL BACK TO `.traffic-one`, WHICH IS A
    // PATH THE COMMAND NEVER NAMED. The fallback read `pathLiteralPrefix(rel) ||
    // '.traffic-one'`, so every operand whose FIRST segment is interpolated —
    // `rm -rf "$(pwd)/dist"`, `rm -f "$f"`, `rm -rf "$TMPDIR/scratch"`,
    // `mv "$src" dist/out.js`, `cp assets/logo.svg "$dest"` — resolved to the
    // runs tree, enumerated the live run's sidecars, and was refused with a
    // paragraph naming `run.json`. Five ordinary build and loop commands, none
    // of which mentions Traffic One at all; a peer measured all five and the
    // remedy the deny text offered was unrelated to what the agent had typed.
    //
    // THE FIX FOR THAT WAS TOO WIDE AND THE SENTENCE THAT JUSTIFIED IT WAS
    // FALSE. It read: "An unreadable first segment is a scope this module
    // cannot answer for, and the honest answer to a question it cannot answer
    // is to say nothing." For `rm -rf "$PWD/.traffic-one/runs"` that is false
    // twice over — the module is handed the workdir AND the project root, and
    // the operand spells the runs tree in full after the interpolation. The
    // condition discarded the operand on what its FIRST segment looked like,
    // whatever the rest of it said, and six ground-truthed deletions of a live
    // `run.json` went out at `noop`: `$PWD`, `$(pwd)`, `${PWD}`, a `./` in the
    // middle, a named file at the end, and a variable root nobody can resolve.
    //
    // The question is what the REMAINDER spells. An operand with no complete
    // `.traffic-one` literal left in it is still discarded — which is what
    // keeps all five ordinary rows above permitted BY CONSTRUCTION rather than
    // by measurement, since not one of them mentions Traffic One at all.
    //
    // PRICED, and it is a real cost rather than a free narrowing: an
    // interpolated root that is NOT this project's — `rm -rf
    // "$HOME/.traffic-one/runs"` in a project that happens to hold a live run —
    // is refused, because a hook cannot resolve `$HOME` and the suffix names
    // the tree under any root. Refusing another project's runs tree costs an
    // agent one rewrite; permitting this one's costs the run.
    const scope = readableScope(rel);
    if (scope === null) return;
    scopes.push(pathLiteralHasGlob(rel) ? { rel: scope, patterns, globPath: rel } : { rel: scope, patterns });
  };
  // `find … | xargs rm` spans a pipe, so the deletion action is looked for in
  // the whole command; the roots still come from find's own operands.
  const findDeletes = findWriteAction(command);
  // THE SAME PIECES THE READ ARM BELOW JUDGES, which is the round-7 correction
  // and not a tidy-up. This loop used to split on `/[\n;]|&&|\|\||\||&/` and
  // read `tokens[0]` as the verb, a private splitter one screen above a shared
  // one. It differed in three ways that were each a measured escape: it split
  // inside quotes (`rm -f "a;b"`), it never re-entered a SUBSHELL, so
  // `(rm -rf .traffic-one/runs)` tokenized as the verb `(rm` and matched no
  // arm, and it read shell KEYWORDS as command words, so `do rm -rf .` and
  // `then find . -name run.json -delete` were verbs named `do` and `then`.
  // Three ground-truthed erasures of a live `run.json`, all `noop`, all of them
  // invisible to a fix at any one of the three call sites — which is precisely
  // why the splitter is shared now.
  for (const piece of shellReadPieces(command)) {
    const head = shellStatementHead(shellTokens(piece));
    const verb = head.verb;
    if (!verb) continue;
    const rest = [...head.args];
    if (verb === 'rm' || verb === 'rmdir' || verb === 'unlink' || verb === 'trash' || verb === 'shred') {
      for (const operand of operandsOf(rest)) note(operand);
      continue;
    }
    // `truncate -s 0 <path>` leaves the file in place with nothing in it, which
    // for a sidecar the runtime is the sole author of is the same loss as `rm`.
    // Reachable here only via a GLOB (`truncate -s 0 .traffic-one/runs/R/*`) —
    // a literal path is named, so `shellTrafficOneWriteTargets` sees it first —
    // and `-s`'s value is an option ARGUMENT, not an operand.
    if (verb === 'truncate') {
      for (const operand of operandsOf(withoutOptionArguments(rest, ['-s', '--size', '-r', '--reference']))) {
        note(operand);
      }
      continue;
    }
    if (verb === 'mv') {
      // Moving a run directory away destroys it in place; the DESTINATION is
      // someone else's problem (and usually outside the project).
      const operands = operandsOf(rest);
      for (const operand of operands.slice(0, -1)) note(operand);
      continue;
    }
    if (verb === 'find' && findDeletes) {
      // find's paths precede its first predicate; no path means the cwd.
      const stopAt = rest.findIndex((token) => token.startsWith('-') && token.length > 1
        && !/^-[HLPEXdsx]+$/.test(token));
      const paths = (stopAt === -1 ? rest : rest.slice(0, stopAt)).filter((token) => !token.startsWith('-'));
      const patterns = findNamePatterns(rest);
      if (paths.length === 0) note('.', patterns);
      for (const operand of paths) note(operand, patterns);
      continue;
    }
    // OVERWRITE, not deletion: these leave a file at the path with somebody
    // else's bytes in it, which is the same loss for a sidecar the runtime is
    // the sole author of. Each names its destination differently, which is why
    // the generic operand scan above never saw them: `dd` uses `of=`, `install`
    // and `rsync` use their LAST operand, `tar` uses `-C`.
    if (verb === 'dd') {
      for (const token of rest) {
        if (token.startsWith('of=')) note(token.slice(3));
      }
      continue;
    }
    if (verb === 'install' || verb === 'rsync' || verb === 'cp') {
      // `rsync` without `--delete` adds files rather than removing them, but it
      // still overwrites a sidecar it happens to carry, so the destination is
      // judged either way.
      //
      // `cp` is here because it was in `DESTRUCTIVE_VERBS` — so it armed the
      // pre-filter at the top of this file — and then fell through every arm
      // below, which made `cp -R <backup>/. .traffic-one/runs` a command this
      // module started scanning and then enumerated nothing for. `install` and
      // `rsync` are the identical "destination is the last operand" shape and
      // each had an arm. A verb that arms the filter and matches no arm is the
      // most expensive kind of miss, because the cost is paid and the answer is
      // still no.
      // A dry run writes nothing wherever its destination points, so it is not
      // a destination this arm has anything to say about (`rsync -an <backup>
      // <runs tree>`).
      if (verb === 'rsync' && rsyncIsDryRun(rest)) continue;
      const operands = operandsOf(rest);
      if (operands.length > 0) note(operands[operands.length - 1]!);
      continue;
    }
    if (verb === 'tar') {
      // Only an EXTRACT writes; `-c`/`--create` reads the tree into an archive.
      const extracts = rest.some((token) => token === '--extract' || /^-[^-]*x/.test(token));
      if (!extracts) continue;
      for (let index = 0; index < rest.length - 1; index += 1) {
        if (rest[index] === '-C' || rest[index] === '--directory') note(rest[index + 1]!);
      }
      continue;
    }
    // Every git spelling that REWRITES THE WORKTREE, decided by the shared fact
    // `gitWorktreeRewritePathspecs` — `checkout`/`restore`/`reset --hard`/`rm`/
    // `stash`/`clean -f`. Round 2 refused only `stash -u`/`-a` and a forced
    // `clean`, and retired the rest on "runtime sidecars are untracked, and
    // neither command removes an untracked file". That premise is about the
    // REPOSITORY, not the path: `.gitignore` never untracks what is already
    // committed, and `scaffold-content.ts` records `.traffic-one/runs/**`
    // shipping committed in the field. Measured in that state, with the ignore
    // entry present: `git checkout -- .traffic-one/runs`, `git checkout .`,
    // `git restore .` and `git reset --hard` each reverted `scan-bound.json` to
    // its committed bytes and rolled the reset ladder back, at gate `noop`.
    if (verb === 'git') {
      const pathspecs = gitWorktreeRewritePathspecs(rest);
      if (pathspecs === null) continue;
      if (pathspecs.length === 0) note('.');
      for (const operand of pathspecs) note(operand);
      continue;
    }
    // `gzip <sidecar>` leaves `<sidecar>.gz` and no `<sidecar>`. Same loss as
    // `rm`, and in no verb set until round 3 asked which coreutils verbs replace
    // their operand instead of waiting to be defeated by one.
    if (new RegExp(`^(?:${REPLACING_COMPRESSORS})$`).test(verb)) {
      if (compressorKeepsInput(rest)) continue;
      for (const operand of operandsOf(rest)) note(operand);
      continue;
    }
    // `sort -o`, `unzip -d`, `patch`: the destination is a flag argument or the
    // extraction directory, which the generic operand scan cannot see — the same
    // shape as `dd of=` and `tar -C` above.
    if (new RegExp(`^(?:${NAMED_OUTPUT_TOOLS})$`).test(verb)) {
      for (const operand of namedOutputDestinations(verb, rest)) note(operand);
      continue;
    }
  }
  // THE READ QUESTION, over every simple command rather than over eval bodies
  // only — see the header. PER PIECE, because the judgement is about the
  // position the path is named IN: judging the whole command text would ask one
  // question about `cp x y && rm <sidecar>` and answer it from whichever piece
  // lost. `shellReadPieces` also unwraps `bash -c '<body>'`, without which the
  // wrapper's own verb (`bash`) would decide a body that reads.
  //
  // The find patterns are carried through for the same reason the find arm above
  // has them: `find <runs tree> -name '*.log' -delete` reaches the tree and can
  // match no sidecar, so refusing it would name a destruction that does not
  // happen. A piece with no `-name`/`-path` filters nothing.
  for (const piece of shellReadPieces(command)) {
    const patterns = findNamePatterns(shellTokens(piece));
    for (const literal of trafficOnePathsNamedOutsideRead(piece)) note(literal, patterns);
  }
  return [...new Set(scopes)];
}

/**
 * Runtime-owned run sidecars a mutating shell command would destroy WITHOUT
 * naming one, project-relative and present on disk. Fed to the plan gate as
 * ordinary write targets, so `runtime-sidecar-owner-gate` refuses them with the
 * same paragraph and the same deny id it already uses for `rm <sidecar>`.
 *
 * `limit` bounds the paragraphs one refusal can render: the family is refused as
 * a family, and an agent that has been told `run.json` is runtime-owned does not
 * need the other four spelled out to understand that `rm -rf` on the directory
 * is the same refusal.
 *
 * `currentRunId` narrows the enumeration to the run being protected, and it
 * fixes a refusal this gate should never have made. `runtimeOwnedRunSidecar` is
 * run-id-agnostic, so `rm -rf .traffic-one/runs/OTHER` — deleting a FINISHED
 * run's directory, ordinary housekeeping, and on the gate's own permitted list —
 * enumerated into that directory and was denied with a paragraph about atomic
 * publication. A sidecar under another run's id is nobody's live evidence.
 * Whole-tree spellings are untouched: `rm -rf .traffic-one/runs` still reaches
 * the current run's sidecars and is still refused.
 *
 * Empty or unresolvable `currentRunId` protects EVERY run, because "no run is
 * live" is also what an unreadable state file looks like and the narrowing must
 * not be reachable by breaking the thing it reads. This sentence stood here
 * while only its EMPTY half was implemented — see `liveRunId` for what
 * "unresolvable" now means and for the measurement of what it used to cost.
 */
export function shellRuntimeSidecarDestruction(
  command: unknown,
  workdir: unknown,
  projectRoot: unknown,
  heredocBody = '',
  limit = 2,
  currentRunId = '',
): string[] {
  if (typeof command !== 'string' || !command.trim()) return [];
  if (typeof workdir !== 'string' || !path.isAbsolute(workdir)) return [];
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) return [];
  const scanned = withNestedShellBodies(withoutHeredocLines(command, heredocBody));
  // TWO ALTERNATIVES, and the second is what the round-6 arm needs. The verb
  // pre-filter answers for a command that destroys the tree WITHOUT naming it
  // (`rm -rf .`, `git clean -fdx`), and it must stay: no path literal appears.
  // But it also decided, silently, which commands the READ question was ever
  // asked of — so `awk`, `curl -o`, `openssl -out` and `ex -sc` left the module
  // at this line, before any judgement, because no verb set names them. A
  // command that spells a `.traffic-one` path is now asked whatever its verb is,
  // which is the same two-test pre-filter `reset-record-shell.ts` uses
  // (`MENTIONS_RE || DESTRUCTIVE_VERB_RE`) and for the same measured reason.
  if (!DESTRUCTIVE_VERB_RE.test(scanned) && !scanned.includes('.traffic-one')) return [];
  const live = liveRunId(currentRunId, projectRoot);
  const otherRun = (sidecar: string): boolean => {
    if (!live) return false;
    const rest = sidecar.slice(`${RUNS_DIR}/`.length);
    const runId = rest.slice(0, rest.indexOf('/'));
    return Boolean(runId) && runId !== live;
  };
  const targets: string[] = [];
  for (const scope of destroyedScopes(scanned, workdir, projectRoot)) {
    for (const sidecar of sidecarsUnder(projectRoot, scope.rel)) {
      const matched = scope.patterns.length === 0 || scope.patterns.some((pattern) => (
        globMatches(pattern.glob, pattern.wholePath ? sidecar : path.basename(sidecar))
      ));
      const named = scope.globPath === undefined || globCoversPath(scope.globPath, sidecar);
      if (matched && named && !otherRun(sidecar) && !targets.includes(sidecar)) targets.push(sidecar);
    }
  }
  return targets.sort().slice(0, Math.max(1, limit));
}
