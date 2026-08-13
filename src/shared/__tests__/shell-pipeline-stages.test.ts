// THE PIPELINE-STAGE CONTRACT, pinned AT EACH STAGE BOUNDARY.
//
// Three consecutive adversarial reviews of this lane found their blockers
// upstream of the two judgements the lane audits: first the tokenizer, then the
// extractor, then the scope RESOLVER. Every round closed what it was shown inside
// the judgements and was defeated by a respelling that never reached them, and
// each time the symptom was identical — a permissive verdict with no owner.
//
// The cause is not that any one stage was careless. It is that the only tests
// that existed were END-TO-END: a corpus row is priced at a gate outcome, so a
// stage that answers wrongly is indistinguishable from a stage below it that
// answers rightly about the wrong input, and a stage whose output is compensated
// by a LATER stage looks correct while remaining wrong. Round 9 measured that
// directly: with the stage-2 fix reverted (mutant M19) and with the stage-4 quote
// rule reverted (M20), the whole 95-row destructive corpus still went green,
// because for those rows the other stage happened to cover for it. Both mutants
// were REACHED (23 and 281 executions) and neither was observed. The corpus
// cannot see a stage; only the stage's own boundary can.
//
// So each stage states what it guarantees and is held to it here:
//
//   STAGE 2  SCOPE AND ROOT RESOLUTION (tool-scope.ts). A path it reports must be
//            one the command could really name. Text it cannot resolve is
//            reported as unresolved — never as a path, never as nothing.
//   STAGE 3  TOKENIZATION AND WORD ASSEMBLY (shell-vocabulary.ts). Statements and
//            words as the shell would form them, quotes removed only where that
//            cannot change tokenization.
//   STAGE 4  EXPANSION AND BINDING RESOLUTION. Bindings and expansions resolved
//            TOGETHER over one value model, so a value's origin survives.
//   STAGE 5  PATH EXTRACTION. A literal that cannot be resolved in full is
//            reported unreadable WITH its longest complete directory prefix.
//
// Stage 1 is the raw tool input and stage 6 is the judgement; both are pinned by
// the corpora already.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Ctx, HookInput, ToolClass } from '../../core/types';
import { resolveToolScope } from '../tool-scope';
import {
  globSegmentMatches,
  pathLiteralHasGlob,
  pathLiteralIsUnresolved,
  pathLiteralPrefix,
  shellReadPieces,
  shellWordsOf,
  withShellValuesResolved,
} from '../shell-vocabulary';

const LIVE = '1715091785000';
const RUNS = '.traffic-one/runs';

function ctx(cwd: string, command: string): Ctx {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'codex',
    cwd,
    raw: { tool_name: 'Bash', tool_input: { command } },
    tool: { class: 'shell' as ToolClass, rawName: 'Bash', command },
  };
  return { input, host: 'codex', cwd, now: () => 'x' } as unknown as Ctx;
}

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-stage-'));
  fs.mkdirSync(path.join(root, '.traffic-one', 'runs', LIVE), { recursive: true });
  fs.writeFileSync(path.join(root, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'existing-codebase', stack: 'custom-backend', frontend: 'none', backend: 'go',
  }));
  fs.writeFileSync(path.join(root, '.traffic-one', 'runs', LIVE, 'run.json'), '{"runId":"x"}');
  return root;
}

// ── STAGE 2 ──────────────────────────────────────────────────────────────────

/**
 * The escape this pins, in full, because it is the shape that motivated the
 * contract: `rm -f "$R"/<id>/run.json` is ONE WORD. The absolute-path recognizer
 * accepted any quote as a left delimiter, read the remainder `/<id>/run.json` as
 * an absolute path, and project resolution adopted `/<id>` as the project root —
 * so both judgements ran against a root that does not exist, found nothing, and
 * the erasure went out at `noop` with no diagnostic anywhere.
 *
 * A wrong root is the worst failure available to this stage: it silences every
 * stage below it at once, in the permitting direction, and it is invisible to a
 * corpus priced at gate outcomes because the row simply passes.
 */
test('stage 2: a residue after a CLOSING quote never becomes a path or a root', () => {
  const root = project();
  try {
    for (const command of [
      `R=${RUNS}; rm -f "$R"/${LIVE}/run.json`,
      `R=${RUNS}; rm -f "\${R}"/${LIVE}/run.json`,
      `R=${RUNS}; rm -rf "$R"/${LIVE}`,
      `R=${RUNS}; for f in "$R"/*/run.json; do rm -f "$f"; done`,
    ]) {
      const scope = resolveToolScope(ctx(root, command));
      assert.equal(scope.projectRoot, root, `re-anchored the project root: ${command}`);
      const invented = scope.targets.filter((target) => target.path.startsWith(`/${LIVE}`));
      assert.deepEqual(invented, [], `invented an absolute path from a word remainder: ${command}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * FAIL-CLOSED, not silent. The residue is dropped as a PATH and kept as
 * EVIDENCE: the whole word joins `unresolvedWriteTargets`, which is what the
 * callers of this resolver use to refuse a write they cannot verify. Dropping it
 * outright would trade one fail-open for another.
 */
test('stage 2: the word it cannot resolve is reported unresolved', () => {
  const root = project();
  try {
    const scope = resolveToolScope(ctx(root, `R=${RUNS}; rm -f "$R"/${LIVE}/run.json`));
    assert.ok(
      scope.unresolvedWriteTargets.some((target) => target.includes(`${LIVE}/run.json`)),
      `the unresolvable word was dropped entirely: ${JSON.stringify(scope.unresolvedWriteTargets)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * THE COST OF THE FIX, measured rather than assumed: a genuine absolute operand
 * after a quoted argument is still seen. The guard is one character wide — the
 * delimiter must be the closing quote ITSELF — so `grep "x" /etc/hosts` keeps its
 * operand and only `"x"/etc/hosts`, which is one word to the shell, loses it.
 */
test('stage 2: a real absolute operand beside a quoted one is still seen', () => {
  const root = project();
  try {
    const scope = resolveToolScope(ctx(root, `grep "foo" ${root}/notes.txt`));
    assert.ok(
      scope.targets.some((target) => target.path === path.join(root, 'notes.txt')),
      `lost a real absolute operand: ${JSON.stringify(scope.targets.map((target) => target.path))}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── STAGE 3 ──────────────────────────────────────────────────────────────────

/**
 * Word assembly, and both directions of it. The shell reassembles
 * `.traffic-'one'/runs` and `$'.traffic-one/run\x73'` into the same path as
 * `.traffic-one/runs`, and this stage did not — which read as covered by the
 * shipped residue list ("no complete `.traffic-one` literal survives"), a
 * statement about INTERPRETER-level assembly that these two never reach.
 */
test('stage 3: literal quoted spans are removed and $\'…\' is decoded', () => {
  for (const [command, expected] of [
    ["rm -rf .traffic-'one'/runs", `rm -rf ${RUNS}`],
    ['rm -rf ".traffic-one"/runs', `rm -rf ${RUNS}`],
    ["rm -rf .traffic-one/'runs'", `rm -rf ${RUNS}`],
    ["rm -rf $'.traffic-one/run\\x73'", `rm -rf ${RUNS}`],
    ["rm -rf $'.traffic-one/\\x72uns'", `rm -rf ${RUNS}`],
  ] as const) {
    assert.equal(withShellValuesResolved(command), expected, command);
  }
});

/**
 * AND THE LIMIT ON IT, which is not fastidiousness: every stage below this one
 * re-tokenizes the text it is handed, so a quote whose removal would introduce a
 * SEPARATOR must stay. `grep "foo;bar" <sidecar>` unquoted is two statements and
 * the second one's verb is `bar`, which no read list names — a grep with a
 * semicolon in its pattern answered with a paragraph about atomic publication.
 * That row is in the product suite because an earlier round shipped it once.
 */
test('stage 3: a span whose removal would retokenize keeps its quotes', () => {
  const command = `grep "foo;bar" ${RUNS}/${LIVE}/run.json`;
  assert.equal(withShellValuesResolved(command), command);
  assert.deepEqual(shellReadPieces(command), [command]);
});

/**
 * THE COMPOSITION PROPERTY, and it is stated as a property rather than as the
 * three inputs that exposed it.
 *
 * Round 9 pinned four stage GUARANTEES and nothing pinned their COMPOSITION, so
 * `rm -rf "$PWD"/.traffic-one/runs` erased all 15 files under the runs tree at
 * gate `noop` while every stage honoured its own row: the word was split at the
 * closing quote, and the residue `/.traffic-one/runs` reached stage 5 as an
 * absolute path with no `$` and no glob — fully readable by its own rule,
 * resolving outside the project, enumerating nothing.
 *
 * The property: GLUING A QUOTED SPAN TO ADJACENT TEXT CANNOT INCREASE THE WORD
 * COUNT. Whatever quoting a head is written in, `<head><tail>` with no space in
 * it is ONE operand, and the operand is the head's contents followed by the
 * tail. Asserted over a cross product rather than over the three demonstrated
 * escapes, because the escape was never about `$PWD`: it was about the unit.
 *
 * Ground truth is bash's own word splitting, measured with
 * `printf '%s\n' <operands>` over each row (one line per word the shell formed)
 * and recorded here as the expected count. Every head below produced exactly one
 * word.
 */
test('stage 3: a quoted span glued to adjacent text stays in ONE word', () => {
  const heads: Array<[string, string]> = [
    ['"$PWD"', '$PWD'],
    ['"${PWD}"', '${PWD}'],
    ['"$HOME"', '$HOME'],
    ["'literal'", 'literal'],
    ['".traffic-one"', '.traffic-one'],
    ['"a b"', 'a b'],
    ['""', ''],
  ];
  const tails = ['/.traffic-one/runs', `/${RUNS}`, '/x', '/.traffic-one/runs/run.json'];
  for (const [head, contents] of heads) {
    for (const tail of tails) {
      const words = shellWordsOf(`rm -rf ${head}${tail}`);
      assert.deepEqual(
        words,
        ['rm', '-rf', `${contents}${tail}`],
        `a word was split at a quote boundary: rm -rf ${head}${tail}`,
      );
    }
  }
  // And the other direction, which is the same property read backwards: a space
  // between two quoted spans is still two words.
  assert.deepEqual(shellWordsOf('rm -rf "$PWD" /x'), ['rm', '-rf', '$PWD', '/x']);
  assert.deepEqual(shellWordsOf(`cp "a b" "c d"`), ['cp', 'a b', 'c d']);
});

/**
 * PROVENANCE, which is the half an allowlist cannot supply. A word one stage
 * could not resolve must not reach stage 5 looking clean: the unresolved piece
 * stays IN the word, so the `$` that stage 4 declined to expand is still there
 * when stage 5 asks whether the literal denotes what it spells.
 *
 * The residue of the family-1 escape was readable precisely because it had been
 * handed on as a word of its own — separated from the evidence that something in
 * it was unresolved.
 */
test('stage 3: an unresolved piece of a word survives in the word', () => {
  for (const [command, operand] of [
    ['rm -rf "$PWD"/.traffic-one/runs', '$PWD/.traffic-one/runs'],
    ['rm -rf "$(pwd)"/.traffic-one/runs', '$/.traffic-one/runs'],
    ['rm -rf "${PWD}"/.traffic-one/runs', '${PWD}/.traffic-one/runs'],
  ] as const) {
    const [piece] = shellReadPieces(command);
    const words = shellWordsOf(piece ?? '');
    assert.equal(words[2], operand, command);
    assert.equal(pathLiteralIsUnresolved(words[2] ?? ''), true, `the residue read as a clean literal: ${command}`);
  }
});

/**
 * ESCAPE RESOLUTION, all three of the cases bash distinguishes, because a fix
 * that handled only the middle one would break the first.
 *
 * `rm -rf .traffic\-one/runs` erased all 15 files at `noop`: to bash `\-` is
 * `-`, and this stage kept both characters. The round-9 peer measured the
 * mutant that strips them at reachability ZERO in the stage suite — no row of it
 * evaluated that line at all — which is what an unowned sub-language looks like
 * from the instrument side.
 */
test('stage 3: an unquoted backslash resolves the way the shell resolves it', () => {
  // \<char>: the character, unescaped.
  assert.equal(withShellValuesResolved('rm -rf .traffic\\-one/runs'), `rm -rf ${RUNS}`);
  assert.equal(withShellValuesResolved('rm -rf .traffic-one/run\\s'), `rm -rf ${RUNS}`);
  assert.equal(withShellValuesResolved('rm -rf .\\traffic-one/runs'), `rm -rf ${RUNS}`);
  assert.equal(withShellValuesResolved('\\find . -delete'), 'find . -delete');
  // \<newline>: a line continuation is NOTHING, not two characters of a word.
  // Stripping only the backslash would leave a newline the splitter reads as a
  // statement separator, which is the row this used to be pinned by.
  assert.equal(withShellValuesResolved('node \\\n -e "x"'), 'node  -e x');
  // Inside SINGLE quotes a backslash is a literal backslash, and inside double
  // quotes it escapes only four characters — so neither is resolved. The quoted
  // span may still be unwrapped (it is a literal), and what matters is that the
  // BACKSLASH survives that: bash names a file whose name contains one, which is
  // not this tree, and stage 5 must therefore read the word as unresolved rather
  // than as `.traffic-one/runs`.
  assert.equal(withShellValuesResolved("rm -rf '.traffic\\-one/runs'"), 'rm -rf .traffic\\-one/runs');
  assert.equal(pathLiteralIsUnresolved('.traffic\\-one/runs'), true);
  assert.equal(withShellValuesResolved('grep "a\\.b" package.json'), 'grep a\\.b package.json');
  // AND THE THREE DELIBERATE OMISSIONS, each of which would manufacture
  // something out of data: a separator, a tilde head, a glob. The pair stays and
  // stage 5's allowlist answers for the word.
  assert.equal(withShellValuesResolved('rm -rf a\\;b'), 'rm -rf a\\;b');
  assert.equal(withShellValuesResolved('rm -rf \\~/x'), 'rm -rf \\~/x');
  assert.equal(withShellValuesResolved('find . -name \\*.json'), 'find . -name \\*.json');
});

// ── STAGE 4 ──────────────────────────────────────────────────────────────────

/**
 * ONE VALUE MODEL, and the reason it has to be one. Round 8 fixed parameter
 * defaults and shell bindings as two sequential textual rewrites; the first
 * replaced `"${RUNS:-nosuch}"` with `nosuch`, so the NAME was gone before the
 * second one looked for a binding. Nine whole-tree erasures at gate `noop`
 * followed, and the three modifier operators were never modelled at all.
 *
 * Each row here is `<statement list>` → `<the operand the shell would run>`, and
 * the last three are the no-ops: an operator that does NOT produce this tree must
 * not be made to, or the closure is bought with an over-refusal.
 */
test('stage 4: bindings and expansions resolve together, per operator', () => {
  for (const [command, expected] of [
    [`RUNS=${RUNS}; rm -rf "\${RUNS:-nosuch}"`, `rm -rf ${RUNS}`],
    [`RUNS=${RUNS}; rm -rf "\${RUNS:=nosuch}"`, `rm -rf ${RUNS}`],
    [`RUNS=${RUNS}; rm -rf "\${RUNS-nosuch}"`, `rm -rf ${RUNS}`],
    [`RUNS=${RUNS}; rm -rf "\${RUNS:?nope}"`, `rm -rf ${RUNS}`],
    ['RUNS=x; rm -rf "${RUNS:+.traffic-one/runs}"', `rm -rf ${RUNS}`],
    [`rm -rf "\${NOPE:-${RUNS}}"`, `rm -rf ${RUNS}`],
    [`p=${RUNS}; n=p; rm -rf "\${!n}"`, `rm -rf ${RUNS}`],
    [`R=${RUNS}; rm -rf "\${R:0}"`, `rm -rf ${RUNS}`],
    [`R=${RUNS}ZZ; rm -rf "\${R:0:17}"`, `rm -rf ${RUNS}`],
    [`R=${RUNS}X; rm -rf "\${R%X}"`, `rm -rf ${RUNS}`],
    [`R=${RUNS}Xtail; rm -rf "\${R%%X*}"`, `rm -rf ${RUNS}`],
    [`R=xx${RUNS}; rm -rf "\${R#xx}"`, `rm -rf ${RUNS}`],
    ['R=.traffic-one/RUNS; rm -rf "${R/RUNS/runs}"', `rm -rf ${RUNS}`],
    [`a=.traffic-one; b="$a/runs"; rm -rf "\${b:-nosuch}"`, `rm -rf ${RUNS}`],
    [`rm -rf "\${A:-\${B:-${RUNS}}}"`, `rm -rf ${RUNS}`],
    // …and the operators that produce something else. Bash agrees with every
    // one of these (ground-truthed on 3.2.57): greedy prefix removal leaves
    // `traffic-one/runs`, the replacement leaves `runsr`, and a LENGTH is a
    // number. An implementation that answered `.traffic-one/runs` here would
    // refuse three commands that destroy nothing.
    [`R=zz/${RUNS}; rm -rf "\${R##*/.}"`, 'rm -rf traffic-one/runs'],
    ['R=.traffic-one/XunsX; rm -rf "${R//X/r}"', 'rm -rf .traffic-one/runsr'],
    [`R=${RUNS}; rm -rf "\${#R}"`, 'rm -rf "${#R}"'],
  ] as const) {
    const pieces = shellReadPieces(command);
    assert.deepEqual(pieces, [expected], command);
  }
});

/**
 * THE QUOTES GO WITH THE REFERENCE, which is stage 4's half of the P1 word.
 * `"$R"/<id>/run.json` is one operand and re-quoting the value would produce
 * `"<value>/<id>/run.json"`… which resolves under nothing at all once a list is
 * involved (`"${d[@]}"` becomes one operand naming no file). Measured as a
 * mutant: keeping the quotes (M20) is invisible to the whole 95-row corpus and
 * observable here.
 */
test('stage 4: a reference wrapped in its own quotes becomes one word', () => {
  assert.deepEqual(
    shellReadPieces(`R=${RUNS}; rm -f "$R"/${LIVE}/run.json`),
    [`rm -f ${RUNS}/${LIVE}/run.json`],
  );
  assert.deepEqual(
    shellReadPieces(`d=(${RUNS}/${LIVE}/run.json ${RUNS}/${LIVE}/scan-bound.json); rm -f "\${d[@]}"`),
    [`rm -f ${RUNS}/${LIVE}/run.json ${RUNS}/${LIVE}/scan-bound.json`],
  );
});

/**
 * SINGLE QUOTES ARE NOT AN EXPANSION, and the asymmetry is deliberate: the shell
 * expands nothing inside `'…'`, so `rm -rf '${RUNS:-<runs dir>}'` removes a file
 * whose NAME is that string and no sidecar (ground-truthed no-op). A value model
 * that expanded it anyway would refuse a command that cannot destroy anything.
 */
test('stage 4: nothing is expanded inside single quotes', () => {
  const command = `RUNS=${RUNS}; rm -rf '\${RUNS:-nosuch}'`;
  assert.deepEqual(shellReadPieces(command), ["rm -rf '${RUNS:-nosuch}'"]);
});

// ── STAGE 5 ──────────────────────────────────────────────────────────────────

/**
 * TWO WAYS TO BE UNREADABLE, and until round 9 only one was modelled. An
 * INTERPOLATION was reported unreadable; an UNEXPANDED GLOB was handed on as
 * though it were a complete literal, so `.traffic-one/run?` resolved to a path
 * that exists nowhere, enumerated nothing, and erased the tree at `noop`.
 */
test('stage 5: an unexpanded glob is unreadable, exactly like an interpolation', () => {
  for (const literal of [
    '.traffic-one/run?', '.traffic-one/[r]uns', '.traffic-one/ru*',
    '.traffic-one/[a-z]uns', '.traffic-one/[!x]uns', `${RUNS}/*/run.json`,
    `${RUNS}/1715*`, `${RUNS}/*/run.jso?`,
  ]) {
    assert.equal(pathLiteralHasGlob(literal), true, literal);
    assert.equal(pathLiteralIsUnresolved(literal), true, literal);
  }
  for (const literal of [`${RUNS}/${LIVE}/run.json`, '.traffic-one', 'dist/assets/app.js']) {
    assert.equal(pathLiteralIsUnresolved(literal), false, literal);
  }
  assert.equal(pathLiteralIsUnresolved('${RUNS}/run.json'), true);
  assert.equal(pathLiteralPrefix(`${RUNS}/\${id}/run.json`), RUNS);
});

/**
 * THE LEADING-DOT RULE IS LOAD-BEARING. `rm -rf *` does not reach `.traffic-one`,
 * because the shell does not expand `*` over dotfiles (ground-truthed: the tree
 * survives). A segment matcher without it would refuse every `rm -rf *` in every
 * project — the largest over-refusal available in this lane.
 */
test('stage 5: glob segments match as the shell matches them', () => {
  assert.equal(globSegmentMatches('*', '.traffic-one'), false);
  assert.equal(globSegmentMatches('.*', '.traffic-one'), true);
  assert.equal(globSegmentMatches('.traffic-*', '.traffic-one'), true);
  assert.equal(globSegmentMatches('run?', 'runs'), true);
  assert.equal(globSegmentMatches('run?', 'cache'), false);
  assert.equal(globSegmentMatches('[r]uns', 'runs'), true);
  assert.equal(globSegmentMatches('[a-z]uns', 'runs'), true);
  assert.equal(globSegmentMatches('[!x]uns', 'runs'), true);
  assert.equal(globSegmentMatches('[!r]uns', 'runs'), false);
  assert.equal(globSegmentMatches('c?che', 'runs'), false);
  assert.equal(globSegmentMatches('1715*', LIVE), true);
  assert.equal(globSegmentMatches('17150053*', LIVE), false);
  assert.equal(globSegmentMatches('*', 'runs'), true);
  assert.equal(globSegmentMatches('runs', 'runs'), true);
  assert.equal(globSegmentMatches('runs', 'cache'), false);
  // A segment this stage cannot read matches ANYTHING: fail-closed is the
  // direction to be arbitrary in.
  assert.equal(globSegmentMatches('${id}', 'runs'), true);
  // …including one made unreadable by something that is NOT a glob. A pattern
  // carrying a kept backslash used to compare unequal and filter a whole
  // enumeration away (`find . -name \*.json -delete`, 15 files to 2 at `noop`).
  assert.equal(globSegmentMatches('\\*.json', 'run.json'), true);
});

/**
 * READABILITY IS AN ALLOWLIST, which is the round-10 inversion and the third
 * time this lane has had to change the KIND of a rule rather than widen a list.
 *
 * Round 9 asked "is this literal unreadable?" as a disjunction of two DEFEATS —
 * an interpolation or a glob — and a denylist of spellings can only forbid what
 * someone has already been defeated by. Two more arrived: a backslash and a
 * tilde head, each erasing all 15 files under the runs tree at gate `noop`.
 *
 * The question is now "does every character DENOTE ITSELF to a shell?", so the
 * enumerated set is the characters that have no power to change what a word
 * names, and ANYTHING ELSE — including a metacharacter nobody here has thought
 * of — is unresolved on the day it arrives. This test is written as that
 * property over the whole ASCII range plus a byte above it, rather than as a
 * list of the spellings that motivated it.
 */
test('stage 5: readability is an ALLOWLIST, so an unknown metacharacter is unresolved', () => {
  // Written out from `bash(1)`'s special characters rather than from the
  // implementation's regex: everything a shell leaves alone inside a word.
  const denoteThemselves = new Set([
    ...'abcdefghijklmnopqrstuvwxyz',
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    ...'0123456789',
    // `~` is here because this loop puts the character in the MIDDLE of a word,
    // where a tilde is data; at a word head it is an expansion, and that case is
    // asserted separately below.
    ...'._-/+,:=%@^!#}]~', ' ', '\t',
  ]);
  for (let code = 32; code < 127; code += 1) {
    const character = String.fromCharCode(code);
    const literal = `.traffic-one/runs/a${character}b`;
    assert.equal(
      pathLiteralIsUnresolved(literal),
      !denoteThemselves.has(character),
      `character ${JSON.stringify(character)} (0x${code.toString(16)}) is on the wrong side of the allowlist`,
    );
  }
  // Every special character of the POSIX shell grammar is ASCII, so a byte above
  // it is a word constituent by construction — the clause that makes this a rule
  // rather than a longer list.
  assert.equal(pathLiteralIsUnresolved('.traffic-one/cache/café'), false);
  assert.equal(pathLiteralIsUnresolved('.traffic-one/cache/日本語'), false);
  // A control character is not a word constituent anybody spelled on purpose.
  assert.equal(pathLiteralIsUnresolved('.traffic-one/runs/a\u0007b'), true);
  // The five members that carry today's escapes, named so a future reader can
  // see which class each belongs to.
  for (const literal of ['a$b', 'a`b', 'a\\b', 'a{b', 'a[b', "a'b", 'a"b', 'a;b', 'a|b', 'a>b', 'a(b']) {
    assert.equal(pathLiteralIsUnresolved(literal), true, literal);
  }
  // A TILDE IS POSITIONAL, and it is the one member of the rule that is: `~`,
  // `~+`, `~-` and `~user` expand only at the start of a word. `~+` is `$PWD`,
  // so it names THIS project whatever HOME is — which is why it cannot be
  // dismissed as a HOME-relative variant.
  assert.equal(pathLiteralIsUnresolved('~+/.traffic-one/runs'), true);
  assert.equal(pathLiteralIsUnresolved('~-/.traffic-one/runs'), true);
  assert.equal(pathLiteralIsUnresolved('~/.traffic-one/runs'), true);
  assert.equal(pathLiteralIsUnresolved('~user/x'), true);
  assert.equal(pathLiteralIsUnresolved('dist/app.js~'), false);
  assert.equal(pathLiteralIsUnresolved('.traffic-one/run~1/x'), false);
});

/**
 * The prefix half of stage 5's contract, over the SAME inverted question: the
 * longest complete directory prefix is cut at the first character this stage
 * cannot resolve, whatever that character is. Round 9 cut at `{` and `$` only,
 * so a literal made unreadable by anything else was handed on whole.
 */
test('stage 5: the longest complete prefix cuts at the first unresolved character', () => {
  assert.equal(pathLiteralPrefix(`${RUNS}/\${id}/run.json`), RUNS);
  assert.equal(pathLiteralPrefix(`${RUNS}/$id/run.json`), RUNS);
  assert.equal(pathLiteralPrefix(`${RUNS}/${LIVE}/run\\.json`), `${RUNS}/${LIVE}`);
  assert.equal(pathLiteralPrefix(`${RUNS}/${LIVE}/a\`b`), `${RUNS}/${LIVE}`);
  assert.equal(pathLiteralPrefix('~+/.traffic-one/runs'), '');
  assert.equal(pathLiteralPrefix('$PWD/.traffic-one/runs'), '');
});
