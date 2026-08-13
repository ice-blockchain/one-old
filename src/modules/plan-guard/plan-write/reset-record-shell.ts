// src/modules/plan-guard/plan-write/reset-record-shell.ts
// THE RESET RECORD'S OWN WRITE FENCE, AND WHY ITS POLARITY IS THE OPPOSITE OF
// EVERY OTHER SHELL SCAN IN THIS DIRECTORY.
//
// `.traffic-one/runs/.resets.json` is the project-level record of every reset
// (runners/traffic-one-reset/resets.ts). It carries `count`, which prices the
// next reset, and the per-successor `terminalRoles` obligation that
// `modelExhaustionTerminalForRole` reads and `correlatedCursorFailureGate`
// denies `cursor-api-limit-terminal` on. MEASURED on a live obligation: record
// intact → terminal `true` → the spawn is denied; record unlinked or truncated →
// `false` → the spawn is ADMITTED. Erasing this file lets a role whose model is
// exhausted respawn with no user answer, and rolls the reset ladder back to
// free.
//
// It had no fence of its own. Every refusal it enjoyed came from
// `strayRunIdInText` reading the FILENAME `.resets.json` as a fabricated run id
// — an accident, and one whose message told the agent to write under
// `.traffic-one/runs/<currentRunId>/` instead, which is not a place this file
// can go. Measured at the real gate before this module existed:
//
//   currentRunId present, run dir present    7 of 27 erasure channels PERMITTED
//   currentRunId ABSENT,  run dir present   22 of 27 PERMITTED (incl. `rm -f`)
//   currentRunId ABSENT,  no run dir        27 of 27 PERMITTED
//
// so the whole defence was conditional on a pointer the record does not need,
// and leaked even with the pointer set.
//
// ── WHY AN ALLOWLIST OF READS RATHER THAN A LIST OF MUTATIONS ────────────────
// sidecar-shell.ts answers "does this command MUTATE a runtime sidecar", and it
// must: those paths sit under a directory an agent legitimately reads, lists,
// greps and copies, so the scan has to name the destructive shapes and let
// everything else through. Every such scan is fail-OPEN by construction — a
// spelling the vocabulary does not carry is admitted, which is exactly how
// `bash -c 'rm -f …'`, `install /dev/null …`, an interpreter heredoc and
// `perl -pi -e` reached this record with a live run pointer in place.
//
// This file has ONE writer, and it is not an agent: `recordReset`, called by the
// operator's own one-shot recovery command, from inside the runtime. No role,
// child or parent has any business writing it, ever, through any channel. That
// makes the honest rule the inverse one — REFUSE every command that names the
// record unless the way it names it is a READ — and the inverse rule is
// fail-CLOSED: a mutation spelling nobody has thought of yet is refused because
// it is not on the read list, not admitted because it is not on the mutation
// list. That property is the point. A fence that holds only while somebody
// else's mutation vocabulary is complete is the same accident this module
// replaces, moved one file over.
//
// The read list is small because the population is small: an agent may look at
// this record, and nothing more. `cat`, `head`, `grep`, `jq`, `wc`, `sed -n`, an
// interpreter read — those are named below. Anything else naming the file is
// refused with `reset-record-owner-gate`, whose prose says plainly that there is
// no correct way to write it.
//
// ── THE SECOND ARM, AND ITS OPPOSITE POLARITY ───────────────────────────────
// A command can destroy the record without naming it, by removing a directory
// that contains it (`rm -rf .traffic-one/runs`, `git clean -fdx`, `git checkout
// -- .traffic-one/runs` in a project whose run state was committed). Here the
// signal is weak — naming a DIRECTORY is ordinary — so this arm keeps the
// fail-open polarity sidecar-shell uses and refuses only the destructive verbs
// listed in DESTRUCTIVE_VERBS. What it asks of an operand is still its own
// question (`coversRecord`, three ancestors and a glob walk over them), because
// sidecar-shell's enumeration cannot see this file at all:
// `runtimeOwnedRunSidecar` requires the `runs/<id>/<entry>` shape and this
// record sits one directory above any run id — deliberately, so that a reset
// cannot walk away from it and a retention sweep cannot collect it
// (obligations.test.ts pins both).
//
// ── THE FACTS ARE SHARED; ONLY THE JUDGEMENTS ARE SEPARATE ──────────────────
// Until round 11 this module ALSO re-derived the shell facts — its own
// `command.split(/[\n;]|&&|\|\||\||&/)` and its own
// `/'([^']*)'|"([^"]*)"|(\S+)/g` tokenizer, the exact pair round 10 replaced in
// sidecar-shell one directory over. Keeping them was filed as duplication and
// measured as a LIVE DIVERGENCE: both are quote-blind, so a separator or a
// quote inside an operand split the two fences' words differently, and the
// difference is only visible where THIS fence is the sole protector. Priced in
// three project states over 52 rows, each ground-truthed against real bash
// first: with a live run present the sidecar fence owns the tree and every
// destructive row is refused by it, but in the FINISHED and POST-RESET states —
// `runs/` holding the record and no live run directory, which is exactly the
// state retention leaves behind and exactly when the record is worth
// destroying — 24 of 26 ground-truthed erasures of `.resets.json` reached gate
// `noop`. `rm -rf "$PWD"/.traffic-one/runs`, `.traffic-one/"runs"`,
// `.traffic\-one/runs`, `~+/…`, a bound name, a subshell, a brace group and a
// `bash -c` body with escaped quotes all erased the record with no refusal.
// The two that were refused were refused by ACCIDENT — the old splitter's
// fragment happened to equal the string `.traffic-one`.
//
// So the facts now come from `shared/shell-vocabulary`: `shellReadPieces` for
// the statement list (quote-aware, re-enters `( … )`, `{ …; }`, `$( … )` and a
// `-c` body, resolves bindings), `shellWordsOf` for the words (a quoted span
// glued to adjacent text stays ONE word), `shellStatementHead` for the command
// word (reserved words, `VAR=x` prefixes and `env`/`timeout` wrappers skipped),
// and stage 5's unresolved/tail/glob handling for what an operand names. The
// JUDGEMENTS stay here and stay opposite: sidecar-shell asks "do I recognise
// this verb as destructive", this file asks "is this path named by anything
// that is not a READ", and that polarity is why this fence has been immune to
// the vocabulary class of defect. It is not folded into the sibling and must
// not be.
//
// Without this arm the record is protected only while some OTHER live run's
// sidecar happens to sit under the same doomed directory, which is a fence made
// of a coincidence.
//
// ── WHAT THIS DOES NOT CLOSE, stated because the version of this comment that
//    claims otherwise is how the last three rounds went wrong ────────────────
// The path must be READABLE FROM THE COMMAND TEXT. A line that hides it behind
// shell evaluation (`cd .traffic-one/runs && rm -rf .`, `rm -rf "$(echo
// .traffic-one)"`, `eval`), or assembles the NAME itself inside interpreter code
// (`os.path.join('.traffic-one','runs','.resets'+'.json')`), is not refused —
// closing that needs an evaluator, not a regex. `cd X && rm .resets.json` IS
// refused, because the basename survives in the text and this module matches on
// it rather than on a resolved path. A project script that erases the record
// (`npm run reset:state`) keeps its bytes in package.json, not in the command.
// Those are breaches this gate cannot see, not routes it permits, and the deny
// prose says so in those words.
//
// ── WHAT IT COSTS, priced rather than discovered later ───────────────────────
// A fail-closed verb rule refuses `echo "see .traffic-one/runs/.resets.json"` —
// the record's path MENTIONED in a shell string, not written. That is a real
// false refusal and it is accepted deliberately, because the alternative was
// measured: admitting `echo`/`printf` re-opens `echo "<code>" | node`, a
// spelling that erased the record end to end (the piece the interpreter runs
// carries no filename of its own, so the mention IS the write). The agent's
// remedy is ordinary — say it through the tool that writes prose, which this
// fence never touches, since the readiness check keys on the write TARGET and
// not on content. A note mentioning the record is unaffected; only spelling it
// into a shell command line is.
// The pre-filter is also two tests wide rather than one, so any command
// containing a destructive verb pays a piece walk plus one `existsSync`. It is
// paid only in projects that hold a live record — a project that has never reset
// leaves this module at the first stat.

import * as fs from 'fs';
import * as path from 'path';

// The path itself lives beside the other gate path patterns, and is NOT imported
// from runners/traffic-one-reset/resets.ts: a hook gate importing a runner is a
// layering inversion (that module's own docblock rejects the mirror-image import
// for the same reason). The two spellings are kept in step behaviourally
// instead — __tests__/reset-record-fence.test.ts assembles the path it drives
// the gate with from `RESETS_FILE`, so renaming the record without touching this
// one reddens a named test rather than silently unfencing the file.
import {
  COMMAND_WORD_PREFIX,
  compressorKeepsInput,
  gitWorktreeRewritePathspecs,
  globPatternIsUnreadable,
  globSegmentMatches,
  NAMED_OUTPUT_TOOLS,
  namedOutputDestinations,
  pathLiteralHasGlob,
  pathLiteralIsUnresolved,
  pathLiteralPrefix,
  REPLACING_COMPRESSORS,
  rsyncIsDryRun,
  shellReadPieces,
  shellStatementHead,
  shellWordsOf,
  trafficOnePathTail,
  VERB_ANCHOR,
} from '../../../shared/shell-vocabulary';

import { RESET_RECORD_REL } from '../plan-readiness/context';

const REPLACING_COMPRESSOR_RE = new RegExp(`^(?:${REPLACING_COMPRESSORS})$`);
const NAMED_OUTPUT_TOOL_RE = new RegExp(`^(?:${NAMED_OUTPUT_TOOLS})$`);

const RESET_RECORD_NAME = '.resets.json';
const RUNS_DIR = '.traffic-one/runs';

// Cheap pre-filter, and the whole cost on the overwhelming majority of shell
// calls. TWO alternatives, because one of them was not enough: a command that
// names neither the record nor the tree above it can still destroy it through
// the WORKING DIRECTORY. Measured with the path test alone, `git clean -fdx` was
// the single surviving escape of 27 — it names nothing whatsoever, and arm 2
// resolves its implicit `.` operand to the project root, which contains the
// record.
//
// The anchor and the command-word prefix are the shared ones, which is not
// tidiness either: this module's own pair carried neither the backtick nor the
// ALIAS ESCAPE, so `\git clean -fdx` — the ordinary idiom for bypassing a `git`
// alias, naming no path at all — left this module at this line while destroying
// the record (ground-truthed, 1 file to 0). `MENTIONS_RE` cannot save that one:
// the command spells nothing.
const MENTIONS_RE = /\.resets\.json|\.traffic-one/;
const DESTRUCTIVE_VERB_RE = new RegExp(
  `${VERB_ANCHOR}${COMMAND_WORD_PREFIX}`
  + `(?:rm|rmdir|unlink|trash|mv|find|git|dd|install|rsync|tar|${REPLACING_COMPRESSORS}|${NAMED_OUTPUT_TOOLS})\\b`,
);

/**
 * Verbs that only READ their operands. A piece naming the record with one of
 * these is permitted; a piece naming it with anything else is refused.
 *
 * Deliberately excluded, each for a reason rather than by omission:
 *   `echo`/`printf`/`:`  — the left-hand side of `> <record>`, and the body of
 *                          `echo "<code>" | node`.
 *   `tee`/`cp`/`install`/`dd` — writers whose destination is an operand.
 *   `git`                — `git checkout --`/`git stash`/`git clean` all name
 *                          paths, and telling the read subcommands from the
 *                          writing ones is a second parse for a file that is
 *                          gitignored anyway, so no git command needs it.
 *   `awk`                — its program string can carry `print > "file"`, so the
 *                          write hides where a verb scan cannot see it.
 *   `sed`/`sort`/`yq`    — handled below: each has ONE flag that turns it into a
 *                          writer, and is a read without it.
 *   `find`               — reaches the record through a directory operand, which
 *                          is arm 2's business.
 *
 * A verb on this list with a WRITING FLAG is the failure mode this list has, and
 * it is the same shape as the eval vocabulary's: `sort` was here unconditionally
 * while `sort -o <record> /dev/null` truncates the record, and `yq` was here
 * while `yq -i` is yq's documented in-place edit. Both were found by asking
 * which entries CAN write rather than by being defeated by one; a new entry has
 * to be checked the same way, which is what `WRITES_WITH_FLAG` records.
 */
const READ_ONLY_VERBS = new Set([
  'cat', 'bat', 'head', 'tail', 'less', 'more', 'nl', 'wc', 'jq', 'yq',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ls', 'stat', 'file', 'du',
  'cmp', 'diff', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum',
  'sort', 'uniq', 'cut', 'tr', 'column', 'xxd', 'od', 'strings', 'realpath',
  'readlink', 'dirname', 'basename', 'test', '[', '[[', 'true', 'false',
]);

/** Read-list verbs that write when one flag is present, and which flag it is. */
const WRITES_WITH_FLAG: Readonly<Record<string, (tokens: readonly string[]) => boolean>> = {
  sort: (tokens) => tokens.some((token) => token === '-o' || token === '--output' || /^-o./.test(token)),
  yq: (tokens) => tokens.some((token) => token === '-i' || token === '--inplace' || /^-[a-zA-Z]*i$/.test(token)),
  jq: () => false, // jq has no in-place mode; a `jq … > file` is the redirect arm's
};

/** Interpreters whose record-naming piece is judged by the read-call peel
 *  below rather than by its verb. */
const INTERPRETERS = new Set(['node', 'deno', 'bun', 'python', 'python2', 'python3', 'perl', 'ruby', 'php']);

/**
 * A read call together with its whole argument list, so it can be PEELED off an
 * interpreter body: whatever names the record after the peel names it somewhere
 * other than a read.
 *
 * `open` is the one entry that needs its mode inspected — `open(p,'w')` is the
 * commonest truncation there is — so it is matched separately below and only
 * removed when no write/append/exclusive mode follows the path.
 */
const READ_CALL_RE = new RegExp(
  String.raw`\b(?:readFileSync|readFile|createReadStream|existsSync|statSync|lstatSync|readdirSync`
  + String.raw`|realpathSync|accessSync|read_text|read_bytes|getsize|isfile|is_file|getmtime|exists)\s*\([^)]*\)`,
  'g',
);
const READ_OPEN_RE = /\bopen\s*\(\s*(['"][^'"]*['"])\s*(?:,\s*['"][rbtU+]*['"]\s*)?\)/g;

/** Verbs that destroy or overwrite a DIRECTORY operand. Arm 2 only. */
const DESTRUCTIVE_VERBS = new Set([
  'rm', 'rmdir', 'unlink', 'trash', 'mv', 'find', 'git', 'dd', 'install', 'rsync', 'tar',
  ...REPLACING_COMPRESSORS.split('|'), ...NAMED_OUTPUT_TOOLS.split('|'),
]);

const FIND_DELETE_RE =
  /(?:^|\s)-delete\b|(?:^|\s)-exec(?:dir)?\s+(?:[^\s]*\/)?(?:rm|rmdir|unlink|trash|mv)\b|\|\s*xargs\b[\s\S]*?(?:^|\s)(?:[^\s]*\/)?(?:rm|rmdir|unlink)\b/;

/** A heredoc whose reader is an interpreter or a shell: the body is code, not
 *  data. Same distinction sidecar-shell draws, and for the same reason — a
 *  reviewer digest written with `cat > … <<'EOF'` may QUOTE a command that
 *  erases the record without being that command. */
const HEREDOC_INTERPRETER_RE =
  /(?:^|[\s;&|(])(?:[^\s;&|]*\/)?(?:sh|bash|zsh|dash|ksh|fish|node|deno|bun|python3?|perl|ruby|php)\b[^\n]*?<<-?\s*['"]?[A-Za-z_]/;

function withoutHeredocData(command: string, heredocBody: string): string {
  if (!heredocBody) return command;
  if (HEREDOC_INTERPRETER_RE.test(command)) return command;
  const bodyLines = new Set(heredocBody.split('\n'));
  return command.split('\n').filter((line) => !bodyLines.has(line)).join('\n');
}

/**
 * The statement list and the words of one statement, both from the shared
 * pipeline. `shellReadPieces` already replaces a `sh -c '<body>'` wrapper by its
 * body (the wrapper piece carries no operand of its own — its only operand IS
 * the body — so keeping it would refuse `bash -c 'cat <record>'` on the verb
 * `bash`, a read this fence has no reason to refuse), re-enters subshells,
 * brace groups and command substitutions, and resolves shell bindings.
 */
const commandPieces = shellReadPieces;
const shellTokens = shellWordsOf;

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

/** An interpreter body names the record somewhere other than a read call. The
 *  read calls are peeled off WITH their arguments first, so a body that only
 *  reads has nothing left to match. */
function interpreterWritesRecord(piece: string): boolean {
  const peeled = piece
    .replace(READ_CALL_RE, ' ')
    .replace(READ_OPEN_RE, ' ');
  return peeled.includes(RESET_RECORD_NAME);
}

/** `sed -n '1,80p' <record>` is a read; `sed -i …` is not, and a `sed` with
 *  neither is a stream filter whose output goes wherever the shell sends it. */
function sedIsRead(tokens: string[]): boolean {
  if (tokens.some((token) => token === '-i' || token.startsWith('-i') || token === '--in-place')) return false;
  return tokens.some((token) => token === '-n' || (token.startsWith('-') && !token.startsWith('--') && token.includes('n')));
}

/** The record named as a redirect DESTINATION, whatever the verb on the left.
 *  `cat template > <record>` has the verb of a read and the effect of a write. */
const REDIRECT_ONTO_RECORD_RE = /(?:^|[^\w>])>{1,2}\s*['"]?[^\s'"|;&]*\.resets\.json/;

function namedWriteOfRecord(piece: string): boolean {
  if (!piece.includes(RESET_RECORD_NAME)) return false;
  if (REDIRECT_ONTO_RECORD_RE.test(piece)) return true;
  const head = shellStatementHead(shellTokens(piece));
  // A statement that only redirects INPUT reads its operand (`done < <record>`).
  if (head.redirectionOnly) return false;
  // No command word to judge: a `for` list nothing could bind, or a first word
  // the shared head could not classify. Fail CLOSED, as everything else here
  // does — this arm is only reached by a piece that NAMES the record.
  if (!head.verb) return true;
  const { verb } = head;
  if (INTERPRETERS.has(verb)) return interpreterWritesRecord(piece);
  if (verb === 'sed') return !sedIsRead([...head.args]);
  const conditional = WRITES_WITH_FLAG[verb];
  if (conditional) return conditional(head.args);
  // Fail CLOSED: an unrecognised verb naming this record is refused. This is
  // the whole polarity of the module — see the header.
  return !READ_ONLY_VERBS.has(verb);
}

function relativeTarget(operand: string, workdir: string, projectRoot: string): string | null {
  if (!operand || operand.startsWith('-')) return null;
  const root = path.resolve(projectRoot);
  const absolute = path.isAbsolute(operand) ? path.resolve(operand) : path.resolve(workdir, operand);
  if (absolute === root) return '';
  if (!absolute.startsWith(`${root}${path.sep}`)) return null;
  return absolute.slice(root.length + 1).split(path.sep).join('/');
}

/**
 * Does destroying this LITERAL path take the record with it? The project root,
 * `.traffic-one` and `.traffic-one/runs` are the three ancestors; anything
 * deeper is inside a run and cannot reach a file that sits above every run id.
 */
function coversRecord(rel: string): boolean {
  return rel === '' || rel === '.traffic-one' || rel === RUNS_DIR;
}

/**
 * Does an operand carrying an UNEXPANDED GLOB cover the record?
 *
 * Walked segment by segment against the record's own path with the shared
 * matcher, rather than unwrapped as a trailing `/*` was until round 11. The old
 * rule stripped a trailing run of `/*` and asked about what was left, which
 * answered `.traffic-one/runs` for `rm -rf .traffic-one/runs/*` and refused it —
 * with the reset-ladder paragraph — while bash's `*` does not expand over
 * dotfiles and the record SURVIVES that command (ground-truthed in all three
 * states: files 4->1, `.resets.json` kept). Clearing finished runs and keeping
 * the ledger is exactly what an agent should be able to do. The leading-dot rule
 * lives in `globSegmentMatches`, so `rm -rf *` still does not reach
 * `.traffic-one` and `rm -rf .traffic-one/*` still does reach `runs`.
 */
function globCoversRecord(rel: string): boolean {
  const pattern = rel.split('/').filter((segment) => segment !== '' && segment !== '.');
  const parts = RESET_RECORD_REL.split('/');
  if (pattern.length === 0) return true;
  if (pattern.length > parts.length) return false;
  return pattern.every((segment, index) => globSegmentMatches(segment, parts[index]!));
}

/**
 * What an operand names, asked in the order stage 5 asks it: a glob is walked,
 * a literal this stage can resolve is resolved, and a literal it cannot is
 * priced at its longest complete directory PREFIX and then at what its
 * `.traffic-one` TAIL spells.
 *
 * The tail is what `rm -rf "$PWD/.traffic-one/runs"` needs — the operand's head
 * interpolates, so nothing can resolve the literal whole, but the remainder
 * names this tree under any root and this module is handed the root. Same
 * fail-closed trade `sidecar-shell.ts` prices at `readableScope`: refusing
 * another project's runs tree costs a rewrite, permitting this one's costs the
 * record.
 */
function operandCoversRecord(operand: string, workdir: string, projectRoot: string): boolean {
  const rel = relativeTarget(operand, workdir, projectRoot);
  if (rel === null) return false;
  if (pathLiteralHasGlob(rel)) return globCoversRecord(rel);
  if (!pathLiteralIsUnresolved(rel)) return coversRecord(rel);
  const prefix = pathLiteralPrefix(rel);
  if (prefix && coversRecord(prefix)) return true;
  const tail = trafficOnePathTail(rel);
  if (!tail) return false;
  const literal = pathLiteralIsUnresolved(tail) ? pathLiteralPrefix(tail) : tail;
  return literal !== '' && coversRecord(literal);
}

/** A `-name`/`-path` pattern against a name. A PATTERN THIS STAGE CANNOT READ
 *  MATCHES EVERYTHING, because these patterns only ever NARROW a refusal:
 *  `find .traffic-one/runs -name \*.json -delete` reached here carrying a
 *  backslash the tree never has, matched nothing, filtered the whole refusal
 *  away and erased the record (ground-truthed). The same guard the sibling
 *  fence carries, from the same shared fact. */
function globMatchesName(glob: string, value: string): boolean {
  if (globPatternIsUnreadable(glob)) return true;
  const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i').test(value);
}

/** `find . -name '*.log' -delete` reaches the record's directory and cannot
 *  match the record, so refusing it would name a destruction that does not
 *  happen. Present-and-matching-nothing → this command destroys nothing here;
 *  no pattern at all filters nothing, which is correct. */
function findPatternsAdmitRecord(tokens: string[]): boolean {
  const patterns: Array<{ glob: string; wholePath: boolean }> = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const flag = tokens[index]!;
    if (/^-i?name$/.test(flag)) patterns.push({ glob: tokens[index + 1]!, wholePath: false });
    else if (/^-i?(?:path|wholename)$/.test(flag)) patterns.push({ glob: tokens[index + 1]!, wholePath: true });
  }
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => globMatchesName(
    pattern.glob,
    pattern.wholePath ? RESET_RECORD_REL : RESET_RECORD_NAME,
  ));
}

function ancestorDestruction(piece: string, workdir: string, projectRoot: string, findDeletes: boolean): boolean {
  const head = shellStatementHead(shellTokens(piece));
  const { verb } = head;
  if (!verb || !DESTRUCTIVE_VERBS.has(verb)) return false;
  const rest = [...head.args];
  const covers = (operand: string): boolean => operandCoversRecord(operand, workdir, projectRoot);
  if (verb === 'rm' || verb === 'rmdir' || verb === 'unlink' || verb === 'trash') {
    return operandsOf(rest).some(covers);
  }
  if (verb === 'mv') {
    // Moving the directory away destroys the record in place; the destination is
    // somebody else's problem.
    return operandsOf(rest).slice(0, -1).some(covers);
  }
  if (verb === 'find') {
    if (!findDeletes || !findPatternsAdmitRecord(rest)) return false;
    const stopAt = rest.findIndex((token) => token.startsWith('-') && token.length > 1
      && !/^-[HLPEXdsx]+$/.test(token));
    const paths = (stopAt === -1 ? rest : rest.slice(0, stopAt)).filter((token) => !token.startsWith('-'));
    return paths.length === 0 ? covers('.') : paths.some(covers);
  }
  if (verb === 'dd') {
    return rest.some((token) => token.startsWith('of=') && covers(token.slice(3)));
  }
  if (verb === 'install' || verb === 'rsync') {
    // A DRY RUN writes nothing wherever its destination points, so there is no
    // destination here to have anything to say about. The sibling fence stopped
    // refusing `rsync -an <runs dir> <backup>` in round 10 and the shipped prose
    // says so; this copy did not, so the refusal survived from THIS gate and the
    // prose sentence was false — measured, all three states, `rsync -an` and
    // `rsync -a --dry-run` refused with `reset-record-owner-gate` against a
    // ground truth of zero bytes moved. A refused dry run is the worst false
    // refusal either fence can produce: it is the command reached for in order
    // to destroy nothing.
    if (verb === 'rsync' && rsyncIsDryRun(rest)) return false;
    const operands = operandsOf(rest);
    return operands.length > 0 && covers(operands[operands.length - 1]!);
  }
  if (verb === 'tar') {
    if (!rest.some((token) => token === '--extract' || /^-[^-]*x/.test(token))) return false;
    for (let index = 0; index < rest.length - 1; index += 1) {
      if ((rest[index] === '-C' || rest[index] === '--directory') && covers(rest[index + 1]!)) return true;
    }
    return false;
  }
  if (verb === 'git') {
    // This branch used to refuse only `stash -u/-a` and a forced `clean`, on the
    // premise that "`git stash push` and `git checkout --` leave UNTRACKED files
    // alone, and this record is untracked by construction (`.traffic-one` is
    // gitignored)". The second half is false: gitignore never untracks what is
    // already committed, and `scaffold-content.ts` records exactly that state
    // shipping in the field. Measured with the ignore entry present and the
    // record committed, `git checkout -- .traffic-one/runs` and `git reset
    // --hard` both rolled `count` and `terminalRoles` back — which by this
    // module's own opening measurement ADMITS a spawn that should be denied.
    // The named spellings (`git checkout -- <record>`) were saved only by this
    // file's fail-closed verb polarity; the directory-scoped ones had nothing.
    const pathspecs = gitWorktreeRewritePathspecs(rest);
    if (pathspecs === null) return false;
    return pathspecs.length === 0 ? covers('.') : pathspecs.some(covers);
  }
  // `gzip -r .traffic-one` replaces every file under it, this record included.
  if (REPLACING_COMPRESSOR_RE.test(verb)) {
    return !compressorKeepsInput(rest) && operandsOf(rest).some(covers);
  }
  // `unzip -o … -d <dir>` extracts over the record's directory; `sort -o`/`patch`
  // name a destination the operand scan cannot see.
  if (NAMED_OUTPUT_TOOL_RE.test(verb)) {
    return namedOutputDestinations(verb, rest).some(covers);
  }
  return false;
}

/**
 * `.traffic-one/runs/.resets.json` as a write target, when this command would
 * destroy or overwrite it. Fed to the plan gate as an ordinary target, so the
 * refusal is the per-target `reset-record-owner-gate` with a real path in it
 * rather than a second prose surface.
 *
 * Nothing on disk to destroy → nothing returned, so a project that has never
 * reset keeps every one of these commands. That narrowness is deliberate and is
 * what keeps the fail-closed arm affordable: the population it refuses reads is
 * projects that hold a live reset record, and the only read it costs them is one
 * spelled with a verb nobody uses to read.
 */
export function shellResetRecordDestruction(
  command: unknown,
  workdir: unknown,
  projectRoot: unknown,
  heredocBody = '',
): string[] {
  if (typeof command !== 'string' || !command.trim()) return [];
  if (typeof workdir !== 'string' || !path.isAbsolute(workdir)) return [];
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) return [];
  if (!MENTIONS_RE.test(command) && !DESTRUCTIVE_VERB_RE.test(command)) return [];
  try {
    if (!fs.existsSync(path.join(projectRoot, RESET_RECORD_REL))) return [];
  } catch {
    return [];
  }
  const scanned = withoutHeredocData(command, heredocBody);
  const findDeletes = FIND_DELETE_RE.test(scanned);
  for (const piece of commandPieces(scanned)) {
    if (namedWriteOfRecord(piece)) return [RESET_RECORD_REL];
    if (ancestorDestruction(piece, workdir, projectRoot, findDeletes)) return [RESET_RECORD_REL];
  }
  return [];
}
