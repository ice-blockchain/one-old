import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { planWriteGate } from '../plan-write';
import { shellRuntimeSidecarDestruction } from '../plan-write/sidecar-shell';
import {
  heredocBodies,
  shellCommandHasWritePrimitive,
  shellTrafficOneWriteTargets,
} from '../../../shared/feature-source';
import {
  EVAL_WRITE_FACTS, type InterpreterFamily, pathIsReadOnlyInText, SHARED_SHELL_VERB_LIST,
  TRAFFIC_ONE_PATH_RE,
} from '../../../shared/shell-vocabulary';
import type { Ctx, HookInput, ToolClass, HostId } from '../../../core/types';

// TWO DETECTORS, ONE VOCABULARY — the test that exists because they drifted.
//
// `shared/feature-source.ts` answers "is this command a write, and which Traffic
// One artifact does it name?"; `plan-write/sidecar-shell.ts` answers "which
// runtime sidecars would this command destroy WITHOUT naming one?". They are
// different questions and their answers must differ. What must NOT differ is the
// layer underneath: which binaries evaluate code, how a host spells "here is the
// code", which verbs destroy a file, and when a heredoc body is code.
//
// A peer drove one corpus through both and found FOUR defects already fixed on
// one side and still open on the other, in both directions — the heredoc-reader
// distinction and the quote-before-the-verb anchor were only in sidecar-shell,
// `dd of=`/`install` were only in sidecar-shell, `truncate` was only in
// feature-source. Every one of them sat in the shared-fact layer. That layer is
// now `shared/shell-vocabulary.ts`, and this file is what makes a future
// divergence red: each row below is driven through BOTH detectors.
//
// `namedOnly` IS GONE, and the fact that it could go is the round-6 result. It
// marked the rows where only ONE judgement was expected to answer — "an in-place
// edit or an alias-escaped `rm` must name its operand, so the path-extraction
// route answers and the enumerate-what-you-would-destroy detector has nothing to
// add" — and asserted the emptiness so a row could not be parked there to
// silence a real divergence. Every one of those rows (`gsed -i`, `awk -i
// inplace`, `\rm -f`) is now answered by BOTH, because the sidecar judgement
// stopped asking the read question of interpreter eval bodies only and started
// asking it of every command. There is no legitimate asymmetry left in this list,
// so there is no flag to park a row behind.
//
// ROUND 3: THE ROWS BELOW ARE NO LONGER WHERE THE COVERAGE COMES FROM.
//
// A hand-written row list has the tautology the corpus it replaced had: it can
// only hold what its author thought of, and a peer proved it by injecting a
// divergence into ONE detector's private mutation vocabulary — `rm_f` into the
// write detector alone — and watching the whole suite stay green while a live
// `FileUtils.rm_rf('.traffic-one/runs')` reached the gate as a noop. Adding
// `rm_f` as row 29 would have fixed that one spelling and left the mechanism.
//
// So the cross-module corpus is now GENERATED from the shared fact table
// (`shell-vocabulary`'s EVAL_WRITE_FACTS: capability × interpreter family, with
// one real sample per cell). Every fact the leaf knows is driven through BOTH
// judgements. A fact only one judgement acts on is red by construction — there
// is no row to forget to add, because the row IS the fact.
//
// ROUND 6 CLOSES THE OTHER HALF OF THAT SAME HOLE. The sentence that stood here
// said "the list below stays as the SHELL-level spellings, which are not
// eval-body facts and have no generator", and it was the tautology one level
// over: the generated corpus covered EVAL_WRITE_FACTS cells only, so a
// divergence in a SHELL-level capability — a verb in `DESTRUCTIVE_VERBS`,
// `OVERWRITE_TOOLS`, `REPLACING_COMPRESSORS`, `NAMED_OUTPUT_TOOLS` or
// `IN_PLACE_EDITORS` that only one judgement acts on — was invisible here, and a
// peer proved it by injecting exactly that and watching this file stay green.
// The shell rows are now derived from those five sets too (`SHELL_VERB_ROWS`),
// so a verb entering a shared set generates its own cross-module row and a
// missing SPELLING is a named failure rather than an omission. `SPELLINGS` below
// keeps only what a verb set cannot express: flag grammars, quoting, nesting,
// heredocs and the eval-flag spellings.

const SIDECAR = '.traffic-one/runs/run-1/scan-bound.json';

interface Spelling {
  label: string;
  build: (target: string) => string;
}

const SPELLINGS: Spelling[] = [
  { label: 'baseline inline unlinkSync', build: (p) => `node -e "require('fs').unlinkSync('${p}')"` },
  { label: 'node -p (evaluates like -e)', build: (p) => `node -p "require('fs').unlinkSync('${p}')"` },
  { label: 'node --print', build: (p) => `node --print "require('fs').unlinkSync('${p}')"` },
  { label: 'bundled short flags python3 -uc', build: (p) => `python3 -uc "import os;os.unlink('${p}')"` },
  { label: 'static computed member', build: (p) => `node -e "require('fs')['unlinkSync']('${p}')"` },
  { label: 'optional call', build: (p) => `node -e "require('fs').rmSync?.('${p}')"` },
  { label: "destructive MODE openSync(p,'w')", build: (p) => `node -e "require('fs').openSync('${p}','w')"` },
  { label: 'backslash-newline before the flag', build: (p) => `node \\\n  -e "require('fs').unlinkSync('${p}')"` },
  { label: 'heredoc-fed python3', build: (p) => `python3 - <<'PY'\nimport os\nos.unlink('${p}')\nPY` },
  { label: 'heredoc-fed bash running node -e', build: (p) => `bash <<'SH'\nnode -e "require('fs').unlinkSync('${p}')"\nSH` },
  { label: 'quote directly before the verb', build: (p) => `bash -c "rm -f ${p}"` },
  { label: 'nested shell with a flag run', build: (p) => `bash -o pipefail -c "rm -f ${p}"` },
  { label: 'fish -c', build: (p) => `fish -c 'rm ${p}'` },
  { label: 'truncate inside a login shell', build: (p) => `bash -lc "truncate -s 0 ${p}"` },
  { label: 'ruby File.delete', build: (p) => `ruby -e "File.delete('${p}')"` },
  { label: 'ruby File.write', build: (p) => `ruby -e "File.write('${p}','')"` },
  { label: 'php -r unlink', build: (p) => `php -r "unlink('${p}');"` },
  { label: 'deno eval', build: (p) => `deno eval "Deno.removeSync('${p}')"` },
  { label: 'bun -e', build: (p) => `bun -e "require('fs').unlinkSync('${p}')"` },
  { label: 'dd of=', build: (p) => `dd if=/dev/null of=${p}` },
  { label: 'install from /dev/null', build: (p) => `install -m 644 /dev/null ${p}` },
  { label: 'rsync from /dev/null', build: (p) => `rsync /dev/null ${p}` },
  { label: 'coreutils unlink(1)', build: (p) => `unlink ${p}` },
  { label: 'shred -u', build: (p) => `shred -u ${p}` },
  { label: 'perl bare truncate', build: (p) => `perl -e 'truncate "${p}", 0'` },
  // Verbs that REPLACE their operand rather than removing it. `gzip <file>`
  // leaves `<file>.gz` and no `<file>`; these were in no verb set at all,
  // because every entry that was there had been added after being defeated by
  // it and nobody had yet been defeated by a compressor.
  { label: 'gzip replaces the operand', build: (p) => `gzip -f ${p}` },
  { label: 'xz replaces the operand', build: (p) => `xz -f ${p}` },
  { label: 'bzip2 replaces the operand', build: (p) => `bzip2 -f ${p}` },
  { label: 'zstd --rm', build: (p) => `zstd --rm -f ${p}` },
  { label: 'sort -o names its destination', build: (p) => `sort -o ${p} /dev/null` },
  { label: 'patch rewrites its operand', build: (p) => `patch -p1 -i /dev/null ${p}` },
  // Asymmetric by construction: the operand IS the path, so the extraction route
  // answers and the enumerator has no unnamed destruction to find.
  // `perl -i` and `ruby -i` LEFT `namedOnly` in round 4, which is a
  // strengthening rather than a churn: the sidecar detector's eval arm stopped
  // asking "do I recognise a mutation verb in this body" and started asking
  // "is this path named by something that is not a read", and an in-place
  // rewrite names its operand with an interpreter, which is not a read. Both
  // routes now answer for these two.
  //
  // `gsed -i` AND `awk -i inplace` LEFT IT IN ROUND 6, for the same reason one
  // step further out. They were asymmetric because "neither is an interpreter
  // name, so that arm never arms for them" — the read question was asked only of
  // a command matching `INTERPRETER_EVAL_RE`, which is a denylist of BINARIES
  // guarding a fail-closed judgement, and it is exactly what let `awk 'BEGIN{print
  // "" > "<sidecar>"}'` erase a sidecar at gate `noop`. Every command is asked
  // now, so an in-place rewrite is symmetric whatever binary spells it.
  { label: 'perl -i in place', build: (p) => `perl -i -pe 's/.*//' ${p}` },
  { label: 'gsed -i in place', build: (p) => `gsed -i 's/.*//' ${p}` },
  { label: 'ruby -i in place', build: (p) => `ruby -i -pe 'gsub(/.*/,"")' ${p}` },
  { label: 'gawk -i inplace', build: (p) => `awk -i inplace '{next}' ${p}` },
  // `\rm` escapes the alias, so the piece's first token is `\rm` and no read
  // list carries it — which is now an ANSWER rather than an asymmetry: an
  // unrecognised verb naming a runtime path is refused, and the escape prefix
  // makes the verb unrecognisable in the fail-closed direction.
  { label: 'alias-escaped rm', build: (p) => `\\rm -f ${p}` },
];

/**
 * One command per (capability, interpreter family) cell of the shared fact
 * table. This is the corpus that cannot go stale: it is derived from the facts
 * both judgements are built on, so it grows the moment the leaf learns a fact,
 * and a fact only one judgement acts on has nowhere to hide.
 */
const INVOKE: Record<InterpreterFamily, (body: string) => string> = {
  python: (body) => `python3 -c ${shellQuote(body)}`,
  js: (body) => `node -e ${shellQuote(body)}`,
  deno: (body) => `deno eval ${shellQuote(body)}`,
  perl: (body) => `perl -e ${shellQuote(body)}`,
  ruby: (body) => `ruby -e ${shellQuote(body)}`,
  php: (body) => `php -r ${shellQuote(body)}`,
};

function shellQuote(body: string): string {
  return body.includes("'") ? `"${body}"` : `'${body}'`;
}

/**
 * ONE SPELLING PER MEMBER of the shared shell verb sets. The MEMBERSHIP is
 * derived (`SHARED_SHELL_VERB_LIST` is exactly `DESTRUCTIVE_VERBS ∪
 * OVERWRITE_TOOLS ∪ REPLACING_COMPRESSORS ∪ NAMED_OUTPUT_TOOLS ∪
 * IN_PLACE_EDITORS ∪ {dd}`, and the symmetry suite drives every member through a
 * real `-exec` and a real `xargs`); only the ARGUMENT GRAMMAR is written here, because no set
 * can carry the fact that `dd` names its destination with `of=` and `unzip` with
 * `-d`.
 *
 * A verb entering any of those sets with no entry here reddens
 * `every verb in a shared set has a cross-module row`. That is the property the
 * hand-written list did not have: a shell capability could be added to a shared
 * set, acted on by ONE judgement, and this file stayed green.
 */
const SHELL_VERB_SPELLINGS: Readonly<Record<string, (target: string) => string>> = {
  rm: (p) => `rm -f ${p}`,
  rmdir: (p) => `rmdir ${p}`,
  unlink: (p) => `unlink ${p}`,
  shred: (p) => `shred -u ${p}`,
  trash: (p) => `trash ${p}`,
  mv: (p) => `mv ${p} /tmp/elsewhere`,
  cp: (p) => `cp /dev/null ${p}`,
  ln: (p) => `ln -sf /dev/null ${p}`,
  touch: (p) => `touch ${p}`,
  truncate: (p) => `truncate -s 0 ${p}`,
  install: (p) => `install -m 644 /dev/null ${p}`,
  rsync: (p) => `rsync /dev/null ${p}`,
  sort: (p) => `sort -o ${p} /dev/null`,
  unzip: (p) => `unzip -o /dev/null -d ${p}`,
  patch: (p) => `patch -p1 -i /dev/null ${p}`,
  dd: (p) => `dd if=/dev/null of=${p}`,
  // The in-place editors, each in the flag grammar its own binary really has.
  sed: (p) => `sed -i '' -e 's/.*//' ${p}`,
  gsed: (p) => `gsed -i 's/.*//' ${p}`,
  perl: (p) => `perl -i -pe 's/.*//' ${p}`,
  ruby: (p) => `ruby -i -pe 'gsub(/.*/,"")' ${p}`,
  awk: (p) => `awk -i inplace '{next}' ${p}`,
  gawk: (p) => `gawk -i inplace '{next}' ${p}`,
  // The replacing compressors. `zstd` keeps its input unless `--rm`, which is
  // why the set carries it and `compressorKeepsInput` decides it.
  gzip: (p) => `gzip -f ${p}`,
  gunzip: (p) => `gunzip -f ${p}`,
  bzip2: (p) => `bzip2 -f ${p}`,
  bunzip2: (p) => `bunzip2 -f ${p}`,
  xz: (p) => `xz -f ${p}`,
  unxz: (p) => `unxz -f ${p}`,
  lzma: (p) => `lzma -f ${p}`,
  unlzma: (p) => `unlzma -f ${p}`,
  zstd: (p) => `zstd --rm -f ${p}`,
  unzstd: (p) => `unzstd -f ${p}`,
  compress: (p) => `compress -f ${p}`,
  uncompress: (p) => `uncompress -f ${p}`,
};

/** Members of the shared sets with no cross-module row, each with the reason.
 *  Empty today; the property is what makes adding one expensive. */
const SHELL_VERB_EXEMPT: Readonly<Record<string, string>> = {};

function sharedShellVerbs(): string[] {
  return [...new Set(SHARED_SHELL_VERB_LIST)].sort();
}

function generatedFactRows(target: string): Array<{ label: string; command: string }> {
  const rows: Array<{ label: string; command: string }> = [];
  for (const fact of EVAL_WRITE_FACTS) {
    for (const family of fact.families) {
      const sample = fact.samples[family];
      if (!sample) continue;
      rows.push({
        label: `${fact.capability}:${family} (${fact.why})`,
        command: INVOKE[family](sample(target)),
      });
    }
  }
  return rows;
}

function sidecarProject(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-shellvocab-'));
  const runDir = path.join(dir, '.traffic-one', 'runs', 'run-1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'scan-bound.json'), JSON.stringify({ bound: true }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ runId: 'run-1' }), 'utf8');
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('every erasing spelling is seen by the write detector', () => {
  for (const { label, build } of SPELLINGS) {
    const command = build(SIDECAR);
    assert.equal(shellCommandHasWritePrimitive(command), true, `${label}: ${command}`);
    assert.ok(
      shellTrafficOneWriteTargets(command).includes(SIDECAR),
      `${label} names the sidecar but it is not a visible write target: ${command}`,
    );
  }
});

test('the same vocabulary answers in the sidecar detector', () => {
  const project = sidecarProject();
  try {
    for (const { label, build } of SPELLINGS) {
      const command = build(SIDECAR);
      const found = shellRuntimeSidecarDestruction(
        command, project.dir, project.dir, heredocBodies(command), 2, 'run-1',
      );
      assert.deepEqual(found, [SIDECAR], `${label}: ${command}`);
    }
  } finally {
    project.cleanup();
  }
});

// THE GENERATED DIFFERENTIAL. Not a list of rows somebody remembered: one row
// per cell of the shared capability table, driven through both judgements. A
// divergence injected into either private vocabulary now reddens this — which is
// the property a peer falsified by injecting `rm_f` into one side and watching
// 93/93 stay green.
test('every shared FACT is acted on by BOTH judgements', () => {
  const project = sidecarProject();
  try {
    const rows = generatedFactRows(SIDECAR);
    assert.ok(rows.length >= 30, `the generator produced ${rows.length} rows — it is not reading the fact table`);
    for (const { label, command } of rows) {
      assert.equal(
        shellCommandHasWritePrimitive(command), true,
        `${label}: the write detector does not act on a fact the shared table carries: ${command}`,
      );
      assert.deepEqual(
        shellRuntimeSidecarDestruction(command, project.dir, project.dir, heredocBodies(command), 2, 'run-1'),
        [SIDECAR],
        `${label}: the sidecar detector does not act on a fact the shared table carries: ${command}`,
      );
    }
  } finally {
    project.cleanup();
  }
});

// THE SHELL-LEVEL HALF OF THE GENERATED DIFFERENTIAL, and the reason it exists
// is a measured miss rather than a symmetry argument: a peer added one capability
// to one judgement (M1 — a verb acted on by the sidecar enumerator only; M2 — a
// verb acted on by the write detector only) and this file stayed green, because
// the derived corpus above covers eval-body cells and the shell rows were a list
// somebody wrote down.
test('every verb in a shared set has a cross-module row', () => {
  const missing = sharedShellVerbs().filter((verb) => (
    !SHELL_VERB_SPELLINGS[verb] && !SHELL_VERB_EXEMPT[verb]
  ));
  assert.deepEqual(
    missing, [],
    'a verb entered a shared verb set with no cross-module spelling: add one to '
    + 'SHELL_VERB_SPELLINGS, or exempt it in SHELL_VERB_EXEMPT with a reason',
  );
  const stale = Object.keys(SHELL_VERB_EXEMPT).filter((verb) => !sharedShellVerbs().includes(verb));
  assert.deepEqual(stale, [], 'an exemption names a verb that is no longer in any shared set');
  // The derivation must actually be reading the sets. A count is the cheapest
  // guard against `SHARED_SHELL_VERB_LIST` becoming empty or unexported.
  assert.ok(sharedShellVerbs().length >= 25, `derived ${sharedShellVerbs().length} shared verbs`);
});

test('every shared shell VERB is acted on by BOTH judgements', () => {
  const project = sidecarProject();
  try {
    for (const verb of sharedShellVerbs()) {
      const build = SHELL_VERB_SPELLINGS[verb];
      if (!build) continue; // exempted, with a reason, by the property above
      const command = build(SIDECAR);
      assert.equal(
        shellCommandHasWritePrimitive(command), true,
        `shared verb ${verb}: the write detector does not act on it: ${command}`,
      );
      assert.deepEqual(
        shellRuntimeSidecarDestruction(command, project.dir, project.dir, heredocBodies(command), 2, 'run-1'),
        [SIDECAR],
        `shared verb ${verb}: the sidecar detector does not act on it: ${command}`,
      );
    }
  } finally {
    project.cleanup();
  }
});

// P4 OF ROUND 5'S REVIEW: THE TWO EXTRACTORS AND WHAT IS STILL ASYMMETRIC.
//
// `sidecar-shell.ts` carried a private copy of the path-literal regex; it is now
// the shared `TRAFFIC_ONE_PATH_RE`, and this row pins the case the copies
// disagreed about — `.traffic-one/runs` with NO trailing segment, which is the
// most destructive target there is.
//
// THE REMAINING DIVERGENCE IS STATED RATHER THAN CLAIMED CLOSED.
// `feature-source.ts`'s own `targetRe` requires `runs/` plus at least one further
// character, because its output is fed to the gate as a per-target write path and
// `.traffic-one/runs` is not a path any per-target ownership contract answers
// for. So the DIRECTORY is visible to the sidecar judgement (which enumerates
// what lives under it and names those files) and invisible to the target
// extraction (which would have nothing to say about it). That is a deliberate
// difference in what the two answers are FOR, and the assertion below records
// both halves so it cannot drift into an accident.
test('the shared path-literal extractor sees the bare runs directory, and the target scan deliberately does not', () => {
  TRAFFIC_ONE_PATH_RE.lastIndex = 0;
  const command = `node -e "require('fs').rmSync('.traffic-one/runs', {recursive:true})"`;
  assert.deepEqual(command.match(TRAFFIC_ONE_PATH_RE), ['.traffic-one/runs']);
  assert.deepEqual(`rm -rf .traffic-one`.match(TRAFFIC_ONE_PATH_RE), ['.traffic-one']);
  assert.deepEqual(
    `${'x'.repeat(3)} .traffic-one/runs/run-1/run.json`.match(TRAFFIC_ONE_PATH_RE),
    ['.traffic-one/runs/run-1/run.json'],
  );
  // the deliberate half: no per-target write path for a directory
  assert.deepEqual(shellTrafficOneWriteTargets(command), []);
  // …and the destruction is still answered, by the judgement whose answer it is
  const project = sidecarProject();
  try {
    assert.ok(shellRuntimeSidecarDestruction(command, project.dir, project.dir, '', 4, 'run-1').includes(SIDECAR));
  } finally {
    project.cleanup();
  }
});

// The routes M12 and M14 were written to protect, which a peer measured this
// file did NOT cover — both were killed only by plan-write.test.ts, so the
// cross-module test could not tell whether its own subject still had them.
test('two-level nesting and the bare runs directory are seen by both judgements', () => {
  const project = sidecarProject();
  try {
    for (const command of [
      `bash -c "bash -c 'rm -rf .traffic-one/runs'"`,        // MAX_SHELL_NESTING
      `bash -c "bash -c \\"bash -c 'rm -rf .traffic-one/runs'\\""`,
      'rm -rf .traffic-one/runs',                            // the bare runs directory
      'rm -rf .traffic-one/runs/',
      `node -e "require('fs').rmSync('.traffic-one/runs', {recursive:true})"`,
    ]) {
      const found = shellRuntimeSidecarDestruction(
        command, project.dir, project.dir, heredocBodies(command), 4, 'run-1',
      );
      assert.ok(found.includes(SIDECAR), `${command} → ${JSON.stringify(found)}`);
    }
  } finally {
    project.cleanup();
  }
});

// THE ENUMERATION DEPTH, which was a surviving mutant (`MAX_WALK_DEPTH` 6→1
// survived all three test files) on a branch no fixture ever reached. At depth 1
// a directory-scoped deletion silently stops reporting nested sidecars, so the
// deny paragraph names fewer artifacts than the command destroys.
//
// ROUND 4 CORRECTS WHAT THIS PINS. It used to create `runs/<id>/qa/evidence/`
// in its own fixture and assert on it, citing "the QA runner writes
// `runs/<id>/qa/evidence/*`". It does not — it writes
// `.traffic-one/reports/qa/<runId>/…`, a sibling tree the sidecar predicate does
// not match, and the only occurrence of that string in non-test `src/` was the
// comment claiming it. So the depth-3 assertion was pinned against a shape the
// product never produces, which makes it evidence about the fixture and not
// about the bound.
//
// Every REAL writer under `runs/<id>/` is exactly one directory deep — `debug/`,
// `pending/`, `claims/`, `superseded/`, `agent-activity-denies/` — so that is
// what this fixture builds and what the assertion is about. The bound keeps
// headroom over the deepest real shape rather than over an invented one.
test('a directory-scoped deletion reports NESTED sidecars, not just top-level ones', () => {
  const project = sidecarProject();
  try {
    const runDir = path.join(project.dir, '.traffic-one', 'runs', 'run-1');
    for (const dir of ['debug', 'pending', 'claims', 'superseded', 'agent-activity-denies']) {
      fs.mkdirSync(path.join(runDir, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(runDir, 'debug', 'decisions.jsonl'), '[]', 'utf8');
    fs.writeFileSync(path.join(runDir, 'claims', 'senior-frontend.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(runDir, 'superseded', 'senior-backend.json'), '{}', 'utf8');
    const found = shellRuntimeSidecarDestruction(
      'rm -rf .traffic-one/runs', project.dir, project.dir, '', 20, 'run-1',
    );
    for (const nested of [
      '.traffic-one/runs/run-1/debug/decisions.jsonl',
      '.traffic-one/runs/run-1/claims/senior-frontend.json',
      '.traffic-one/runs/run-1/superseded/senior-backend.json',
    ]) {
      assert.ok(found.includes(nested), `a nested sidecar was not reported: ${nested} — ${JSON.stringify(found)}`);
    }
  } finally {
    project.cleanup();
  }
});

test('a read of a sidecar is a write to neither detector', () => {
  const project = sidecarProject();
  try {
    for (const command of [
      `node -e "console.log(require('fs').readFileSync('${SIDECAR}','utf8'))"`,
      `node -p "require('fs').statSync('${SIDECAR}').size"`,
      `python3 -uc "print(open('${SIDECAR}').read())"`,
      `bash -c "cat ${SIDECAR}"`,
      `ruby -e "puts File.read('${SIDECAR}')"`,
      `sed -n '1,20p' ${SIDECAR}`,
      `find .traffic-one/runs -name '*.json' -type f`,
      'npm install',
      'tar -czf artifacts.tgz dist/',
      // ROUND 3 negatives, one per class the round widened. Each is the read
      // that the class fix must not swallow: a compressor that writes to stdout
      // instead of replacing its operand, a `sort` with no output flag, a git
      // command whose scope misses the runs tree or that never touches the
      // worktree, an interpreter open in a READ mode, and the option grammars
      // that a loose `-i` match would refuse.
      `gzip -c ${SIDECAR} | wc -c`,
      `sort ${SIDECAR} | head -3`,
      'git status --porcelain',
      'git checkout main',
      'git diff -- .traffic-one/runs',
      'git restore --staged .traffic-one',
      'git reset --soft HEAD~1',
      `python3 -c "print(open('${SIDECAR}','rb').read())"`,
      `php -r "echo file_get_contents('${SIDECAR}');"`,
      "perl -MList::Util -e 'print 1'",
      `awk '{print $1}' ${SIDECAR}`,
      // ROUND 4 reads. Each is a spelling the eval arm's read allowlist must
      // carry, and the cost of a missing entry is exactly this row going red —
      // a false refusal, found here rather than by whoever hits it.
      `ruby -e "puts File.open('${SIDECAR}','r').read"`,
      `ruby -e "require 'pathname'; puts Pathname.new('${SIDECAR}').read"`,
      `python3 -c "import json; print(json.load(open('${SIDECAR}'))['bound'])"`,
      `python3 -c "from pathlib import Path; print(Path('${SIDECAR}').read_text())"`,
      `python3 -c "import os; print(os.path.getsize('${SIDECAR}'))"`,
      `node -e "console.log(require('${SIDECAR}'))"`,
      `node -e "console.log('${SIDECAR}')"`,
      `perl -e 'use Path::Tiny; print path("${SIDECAR}")->slurp_utf8'`,
      `php -r "echo filesize('${SIDECAR}');"`,
      `deno eval "console.log(Deno.readTextFileSync('${SIDECAR}'))"`,
      // The path in SHELL position, in a command the eval arm has armed for.
      // This is the row that broke when the simple-command scan treated a quote
      // as a command boundary and read `grep -n 'x' <path>` as verbless.
      `python3 -c "print(1)" && grep -n 'bound' ${SIDECAR}`,
    ]) {
      assert.equal(shellCommandHasWritePrimitive(command), false, command);
      assert.deepEqual(
        shellRuntimeSidecarDestruction(command, project.dir, project.dir, '', 2, 'run-1'),
        [],
        command,
      );
    }
  } finally {
    project.cleanup();
  }
});

function writeCtx(cwd: string, toolInput: Record<string, unknown>): Ctx {
  const input: HookInput = {
    event: 'PreToolUse', host: 'claude' as HostId, cwd,
    raw: { tool_name: 'Bash', tool_input: toolInput },
    tool: { class: 'shell' as ToolClass, rawName: 'Bash' },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function materializedSidecarProject(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-shellvocab-gate-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  const t1 = path.join(dir, '.traffic-one');
  fs.mkdirSync(path.join(t1, 'rules', 'common'), { recursive: true });
  fs.mkdirSync(path.join(t1, 'skills', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(t1, 'rules', 'common', 'auth-gate.md'), 'r', 'utf8');
  fs.writeFileSync(path.join(t1, 'skills', 'project-memory', 'SKILL.md'), 's', 'utf8');
  fs.writeFileSync(path.join(t1, 'manifest.json'), JSON.stringify({
    generatedBy: 'traffic-one', stack: 'default', rules: ['rules/common/auth-gate.md'], skills: ['project-memory'],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'x\n<!-- GENERATED BY traffic-one: project-local active rules -->\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'see agents', 'utf8');
  fs.writeFileSync(path.join(t1, 'plan.md'), 'plan', 'utf8');
  fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify({
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { framework: 'none' }, onboardingComplete: true,
    materializedStack: 'default|react-vite|supabase|none', currentRunId: 'run-1',
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({
    performance: { level: 'low', source: 'prompted' }, team: { mode: 'main-agent', source: 'prompted' },
  }), 'utf8');
  const runDir = path.join(t1, 'runs', 'run-1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'scan-bound.json'), JSON.stringify({
    bound: true, reason: 'source scan exceeds 10000 files', recordedAt: 'x',
  }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
    schemaVersion: 1, runId: 'run-1', status: 'planned',
  }), 'utf8');
  return {
    dir,
    cleanup: () => {
      if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
      else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
      if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the gate outcome, not the predicate: these erasures are refused end to end', () => {
  // The price of a miss, at the gate. Each of these returned `noop` — the run
  // continuing with its scan bound, verification contract or run record silently
  // gone — and each now draws `runtime-sidecar-owner-gate`.
  for (const build of [
    (p: string) => `node -p "require('fs').unlinkSync('${p}')"`,
    (p: string) => `node -e "require('fs')['unlinkSync']('${p}')"`,
    (p: string) => `node -e "require('fs').openSync('${p}','w')"`,
    (p: string) => `python3 - <<'PY'\nimport os\nos.unlink('${p}')\nPY`,
    (p: string) => `bash -lc "truncate -s 0 ${p}"`,
    (p: string) => `ruby -e "File.delete('${p}')"`,
    (p: string) => `perl -e 'truncate "${p}", 0'`,
    (p: string) => `install -m 644 /dev/null ${p}`,
    // ROUND 3. Every row below reached `noop` at this gate while erasing the
    // sidecar, and each is the CLASS its neighbours are in, not a new spelling:
    // the destructive-MODE class in the languages `\bopen` could not reach,
    // ruby's `rm_f` (the `unlinkSync` word-boundary mechanism one language
    // over), the compressors that replace their operand, and every git spelling
    // that rewrites the worktree in a project whose run state was committed.
    (p: string) => `php -r "fclose(fopen('${p}','w'));"`,
    (p: string) => `php -r "copy('/dev/null','${p}');"`,
    (p: string) => `ruby -e "File.new('${p}','w').close"`,
    (p: string) => `perl -e 'open(F, ">${p}"); close F;'`,
    (p: string) => `node -e "require('fs').openSync('${p}', require('fs').constants.O_WRONLY|require('fs').constants.O_TRUNC)"`,
    (p: string) => `python3 -c "import os; os.close(os.open('${p}', os.O_WRONLY|os.O_TRUNC))"`,
    (p: string) => `python3 -c "open('${p}', mode='w')"`,
    (p: string) => `python3 -c "from pathlib import Path; Path('${p}').open('w')"`,
    (p: string) => `python3 -c "from pathlib import Path; Path('/dev/null').replace('${p}')"`,
    (p: string) => `ruby -e "require 'fileutils'; FileUtils.rm_f('${p}')"`,
    (p: string) => `ruby -e "require 'fileutils'; FileUtils.remove_file('${p}')"`,
    (p: string) => `ruby -e "system('rm -f ${p}')"`,
    (p: string) => `php -r "shell_exec('rm -f ${p}');"`,
    (p: string) => `ruby -i -pe 'gsub(/.*/,"")' ${p}`,
    (p: string) => `awk -i inplace '{next}' ${p}`,
    (p: string) => `gzip -f ${p}`,
    (p: string) => `zstd --rm -f ${p}`,
    (p: string) => `sort -o ${p} /dev/null`,
    (p: string) => `patch -p1 -i /dev/null ${p}`,
    () => 'unzip -o /dev/null -d .traffic-one/runs',
    () => 'git checkout -- .traffic-one/runs',
    () => 'git checkout .',
    () => 'git restore .',
    () => 'git reset --hard',
    () => 'git stash push .traffic-one/runs',
    () => "ruby -e \"require 'fileutils'; FileUtils.rm_rf('.traffic-one/runs')\"",
    // ROUND 4 — THE FIVE ERASURES A PEER GROUND-TRUTHED AGAINST THE REAL
    // INTERPRETERS while this gate returned `noop`, each taking a 30-byte record
    // to 0 bytes (or removing it outright). Not one of them is closed by a new
    // entry in a mutation vocabulary: the eval arm stopped consulting one.
    (p: string) => `ruby -e "File.open('${p}', File::WRONLY|File::TRUNC).close"`,
    (p: string) => `python3 -c "import zipfile; zipfile.ZipFile('${p}','w').close()"`,
    (p: string) => `python3 -c "import os; os.renames('${p}','gone/x.json')"`,
    (p: string) => `perl -MFile::Slurp -e 'write_file("${p}","")'`,
    (p: string) => `perl -MPath::Tiny -e 'path("${p}")->spew_utf8("")'`,
    // The surviving mutant of round 3, priced at one token in one file with a
    // green suite. There is no token here to delete any more.
    (p: string) => `ruby -e "require 'pathname'; Pathname.new('${p}').delete"`,
    // php is NOT installed on this machine, so this row is reasoned from the
    // documented constructor (it takes an `fopen` mode and `w` truncates) and
    // measured at the gate. The destruction itself is not ground-truthed here,
    // unlike the five above.
    (p: string) => `php -r "$f = new SplFileObject('${p}','w');"`,
    // A verb no vocabulary could carry, because it does not exist. This row is
    // the whole claim: the refusal comes from construction, not enumeration, and
    // reverting the arm to any denylist reddens it.
    (p: string) => `ruby -e "Zorp::Frobnicate.obliterate('${p}')"`,
    (p: string) => `python3 -c "import quux; quux.vaporize('${p}')"`,
    // Priced reversal, disclosed rather than hidden: `os.removedirs` raises on a
    // non-empty directory and so destroys nothing on any scope this detector
    // reports for. Round 3 removed the refusal for that reason. Keeping it
    // permitted now would need a list of verbs known to be harmless — an
    // enumeration in the fail-open direction, which is the shape being retired.
    () => `python3 -c "import os; os.removedirs('.traffic-one/runs/run-1')"`,
    // `find`/`xargs` ACTION VERBS. `shred` and `truncate` are members of
    // `DESTRUCTIVE_VERBS`, imported at the top of the module whose private
    // five-word alternation did not carry them, and the gate's prose names both.
    () => "find .traffic-one/runs -name 'scan-bound.json' -exec shred -u {} \\;",
    () => "find .traffic-one/runs -name '*.json' -exec truncate -s 0 {} \\;",
    () => "find .traffic-one/runs -name '*.json' -exec gzip {} \\;",
    () => "find .traffic-one/runs -name '*.json' -exec sed -i '' 's/.*//' {} \\;",
    () => "find .traffic-one/runs -name '*.json' -exec cp /dev/null {} \\;",
    () => "find .traffic-one/runs -name '*.json' -execdir shred -u {} \\;",
    () => "find .traffic-one/runs -name '*.json' -print0 | xargs -0 shred -u",
    () => "find .traffic-one/runs -name '*.json' | xargs truncate -s 0",
    () => "find .traffic-one/runs -name '*.json' | xargs sed -i '' 's/.*//'",
    // `cp` armed the pre-filter and matched no dispatch arm.
    () => 'cp -R backup/. .traffic-one/runs',
    // Worktree rewrites that override git's refusal to clobber a modified
    // tracked file. `switch` is the modern spelling of the `checkout` this
    // fence already refused.
    () => 'git switch --discard-changes main',
    () => 'git sparse-checkout set src',
    () => 'git checkout-index -a -f',
    () => 'git read-tree -u --reset HEAD',
    () => 'git merge --abort',
    () => 'git rebase --abort',
    () => 'git checkout -f main',
    () => 'git submodule update --init --force',
  ]) {
    const project = materializedSidecarProject();
    try {
      const command = build(SIDECAR);
      const result = planWriteGate(writeCtx(project.dir, { command }));
      assert.equal(result.kind, 'deny', command);
      if (result.kind === 'deny') {
        assert.equal((result as { denyId?: string }).denyId, 'runtime-sidecar-owner-gate', command);
      }
    } finally {
      project.cleanup();
    }
  }
});

// THE PRICE OF THE POLARITY, pinned as a cost rather than left to be discovered.
//
// Inverting the eval arm buys refusal of spellings nobody has written down, and
// the bill is here: a path BOUND TO A VARIABLE before it is read. The literal's
// occurrence sits at an assignment, an assignment is not a read, and the fence
// cannot follow the binding without becoming an interpreter. So this reads as a
// write and is refused, though it only prints the file.
//
// It is two rows out of a 101-row corpus driven through the real gate
// (0/64 of the permitted population is refused otherwise), the failure is
// VISIBLE — the developer is told no and can spell the path inline — and the
// alternative polarity's failure is silent destruction. If this list ever grows
// past "an assignment", the trade has changed and should be re-argued.
test('the fail-closed polarity refuses a variable-bound read, and that is the cost', () => {
  for (const command of [
    `python3 -c "p='${SIDECAR}'; print(open(p).read())"`,
    `node -e "const p='${SIDECAR}'; console.log(require('fs').readFileSync(p,'utf8'))"`,
  ]) {
    assert.equal(
      pathIsReadOnlyInText(command, SIDECAR), false,
      `this row records an accepted FALSE REFUSAL and it stopped happening: ${command}. `
      + 'If the fence learned to follow a binding, delete the row and say so.',
    );
  }
  // and the same read, spelled inline, is permitted — so the remedy is real
  for (const command of [
    `python3 -c "print(open('${SIDECAR}').read())"`,
    `node -e "console.log(require('fs').readFileSync('${SIDECAR}','utf8'))"`,
  ]) {
    assert.equal(pathIsReadOnlyInText(command, SIDECAR), true, `the inline remedy is refused too: ${command}`);
  }
});

test('reads of the same sidecar are still permitted end to end', () => {
  for (const command of [
    `node -e "console.log(require('fs').readFileSync('${SIDECAR}','utf8'))"`,
    `node -p "require('./package.json').version"`,
    `sed -n '1,20p' ${SIDECAR}`,
    // THE POPULATION THAT PRICES THE INVERSION. Round 1 killed an allowlist
    // inversion with exactly these: the `test:env --strict` toolchain probes.
    // They stay permitted for a structural reason rather than a lucky one —
    // none of them spells a `.traffic-one` path, and the arm is only ever asked
    // about a path a caller has already found.
    "python3 -c 'import pytest'",
    `python3 -c "import shutil; print(shutil.which('go'))"`,
    `node -e "require('./dist/scripts/hooks/pre-tool-use.js')"`,
    "perl -e 'exit 0'",
    `node -e "console.log(process.version)"`,
    `python3 -c "import json,sys; json.dump({'a':1}, sys.stdout)"`,
    // Ordinary git that must not be swept up by the worktree census.
    'git merge main',
    'git rebase main',
    'git switch main',
    'git cherry-pick abc123',
    'git revert HEAD',
    'git pull',
    'git apply -R fix.patch',
    'git worktree add --force ../wt main',
    'git bisect reset',
    'git stash pop',
    'git sparse-checkout list',
    'git submodule status',
    // A read-only `find` sweep rooted in the runs tree keeps working: the
    // action-verb set is destructive verbs, not every verb.
    "find .traffic-one/runs -name '*.json' -exec cat {} \\;",
    "find .traffic-one/runs -name '*.json' -exec grep -l bound {} \\;",
  ]) {
    const project = materializedSidecarProject();
    try {
      assert.equal(planWriteGate(writeCtx(project.dir, { command })).kind, 'noop', command);
    } finally {
      project.cleanup();
    }
  }
});
