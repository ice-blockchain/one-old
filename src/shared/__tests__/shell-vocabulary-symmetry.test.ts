import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPABILITY_COVERAGE,
  DESTRUCTIVE_VERBS,
  EVAL_WRITE_FACTS,
  EVAL_WRITE_MATCH_SOURCE,
  findWriteAction,
  GIT_WORKTREE_SUBCOMMANDS,
  gitWorktreeRewritePathspecs,
  INTERPRETER_BINARIES,
  INTERPRETER_FAMILY,
  INTERPRETER_NAMES,
  IN_PLACE_COVERAGE,
  IN_PLACE_EDITORS,
  NAMED_OUTPUT_TOOLS,
  OVERWRITE_TOOLS,
  pathIsReadOnlyInText,
  pathLiteralIsTruncated,
  pathLiteralPrefix,
  REPLACING_COMPRESSORS,
  WRITE_CAPABILITIES,
  type InterpreterFamily,
  type WriteCapability,
} from '../shell-vocabulary';
import { shellCommandHasWritePrimitive } from '../feature-source';

// THE SYMMETRY PROPERTY: a capability covered for one language and not for
// another is red BEFORE anybody is defeated by it.
//
// This file exists because round 2 shipped two claims of the form "closed by
// CLASS, not by spelling" and a peer measured both to be spelling lists one
// level up. The destructive-MODE class was anchored on the literal `open`, so
// php's `fopen`, ruby's `File.new` and perl's 2-arg `open(F, ">P")` sat outside
// it; the in-place FLAG class named `sed` and `perl` while `ruby -i` and
// `awk -i inplace` are the same feature. BOTH gaps were in languages
// `INTERPRETER_NAMES` already lists, and every entry that WAS present had been
// added after somebody was defeated by it. A list can only forbid what it has
// already lost to.
//
// So the assertion is not "these 18 rows are closed" — that is the same list one
// round later. It is: the cells of capability × interpreter family are
// GENERATED, from `INTERPRETER_NAMES` itself, and each one must be answered.
// Adding `lua` to that string reddens six cells. Adding a seventh capability
// reddens six more. Neither can be shipped by adding the one spelling that was
// noticed.
//
// The escape hatch is `CAPABILITY_COVERAGE`, and it is deliberately expensive:
// a cell may be declared unreachable only with a REASON, and only if it really
// is unreachable — a stale exemption fails too (see the third test), because a
// declared gap that is quietly covered is a lie in the record, and a covered
// cell that gets a declaration later is how this property would be defeated.

/**
 * The literal binary names a regex alternation accepts, expanded mechanically.
 *
 * Read from `INTERPRETER_NAMES` rather than from a hand-kept list, because a
 * hand-kept list is the defect: the point is that EDITING THAT STRING is what
 * has to redden a test. Anything the expander cannot read fails loudly rather
 * than silently expanding to nothing — a quiet zero here would make every
 * property below vacuous, which is exactly the failure shape this lane keeps
 * finding.
 */
function expandAlternation(source: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of source) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === '|' && depth === 0) { alternatives.push(current); current = ''; continue; }
    current += character;
  }
  alternatives.push(current);

  const expand = (pattern: string): string[] => {
    let results = [''];
    let index = 0;
    while (index < pattern.length) {
      const character = pattern[index]!;
      if (character === '(') {
        assert.ok(pattern.startsWith('(?:', index), `expander cannot read the group at ${index} of ${pattern}`);
        let depthHere = 0;
        let end = index;
        for (; end < pattern.length; end += 1) {
          if (pattern[end] === '(') depthHere += 1;
          if (pattern[end] === ')') { depthHere -= 1; if (depthHere === 0) break; }
        }
        const inner = pattern.slice(index + 3, end);
        const optional = pattern[end + 1] === '?';
        const branches = expandAlternation(inner);
        results = results.flatMap((prefix) => (optional ? [prefix, ...branches.map((b) => prefix + b)]
          : branches.map((b) => prefix + b)));
        index = end + (optional ? 2 : 1);
        continue;
      }
      assert.ok(!'[]{}+*\\'.includes(character), `expander cannot read '${character}' in ${pattern}`);
      if (pattern[index + 1] === '?') {
        results = results.flatMap((prefix) => [prefix, prefix + character]);
        index += 2;
        continue;
      }
      results = results.map((prefix) => prefix + character);
      index += 1;
    }
    return results;
  };
  return [...new Set(alternatives.flatMap(expand))];
}

/** How each family is invoked with an eval body, so a fact becomes a command. */
const INVOKE: Record<InterpreterFamily, (body: string) => string> = {
  python: (body) => `python3 -c ${quote(body)}`,
  js: (body) => `node -e ${quote(body)}`,
  deno: (body) => `deno eval ${quote(body)}`,
  perl: (body) => `perl -e ${quote(body)}`,
  ruby: (body) => `ruby -e ${quote(body)}`,
  php: (body) => `php -r ${quote(body)}`,
};

function quote(body: string): string {
  const single = body.includes("'");
  const double = body.includes('"');
  assert.ok(!(single && double), `sample mixes quote styles and cannot be a shell word: ${body}`);
  return single ? `"${body}"` : `'${body}'`;
}

const SIDECAR = '.traffic-one/runs/run-1/scan-bound.json';

test('every interpreter name the vocabulary accepts is mapped to a file-API family', () => {
  const names = expandAlternation(INTERPRETER_NAMES);
  assert.ok(names.length >= 8, `the alternation expander produced ${names.length} names — it is not reading the source`);
  for (const name of names) {
    assert.ok(
      INTERPRETER_FAMILY[name],
      `\`${name}\` is in INTERPRETER_NAMES with no family: the write vocabulary cannot be asked what it can do`,
    );
  }
  // and no family is claimed for a name the alternation does not accept
  assert.deepEqual([...names].sort(), [...INTERPRETER_BINARIES].sort());
});

test('every capability is covered for every family, or declared with a reason', () => {
  const families = [...new Set(Object.values(INTERPRETER_FAMILY))].sort();
  const missing: string[] = [];
  for (const capability of WRITE_CAPABILITIES) {
    for (const family of families) {
      const covered = EVAL_WRITE_FACTS.some((fact) => (
        fact.capability === capability && fact.families.includes(family) && fact.samples[family]
      ));
      const declared = CAPABILITY_COVERAGE[`${capability}:${family}`];
      if (covered) continue;
      if (typeof declared === 'string' && declared.trim().length > 0) continue;
      missing.push(`${capability}:${family}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'these capability × family cells are neither covered by a matcher nor declared unreachable with a reason. '
    + 'A capability that php can perform and ruby cannot is not a thing; a capability this vocabulary reads in '
    + 'ruby and not in php is exactly the defect that produced round 3.',
  );
});

test('no declared gap is stale: a cell that IS covered may not also be excused', () => {
  for (const key of Object.keys(CAPABILITY_COVERAGE)) {
    const [capability, family] = key.split(':') as [string, InterpreterFamily];
    const covered = EVAL_WRITE_FACTS.some((fact) => (
      fact.capability === capability && fact.families.includes(family) && fact.samples[family]
    ));
    assert.equal(
      covered,
      false,
      `CAPABILITY_COVERAGE excuses ${key}, but a matcher covers it. An exemption that is not needed is how the `
      + 'next author excuses one that is.',
    );
  }
});

test("each fact's own samples are matched by that fact's own matcher", () => {
  for (const fact of EVAL_WRITE_FACTS) {
    const matcher = new RegExp(fact.match);
    for (const family of fact.families) {
      const sample = fact.samples[family];
      assert.ok(sample, `${fact.capability}:${family} is claimed by a matcher with no sample to prove it`);
      assert.ok(
        matcher.test(sample(SIDECAR)),
        `${fact.capability}:${family} — the matcher does not match its own sample: ${sample(SIDECAR)}`,
      );
    }
  }
});

test('every generated sample is a write primitive as a real command', () => {
  const composite = new RegExp(EVAL_WRITE_MATCH_SOURCE);
  for (const fact of EVAL_WRITE_FACTS) {
    for (const family of fact.families) {
      const body = fact.samples[family]!(SIDECAR);
      assert.ok(composite.test(body), `${fact.capability}:${family} lost in the composite source: ${body}`);
      const command = INVOKE[family](body);
      assert.equal(
        shellCommandHasWritePrimitive(command),
        true,
        `${fact.capability}:${family} is in the table but not a write at the detector: ${command}`,
      );
    }
  }
});

// The FLAG capability is the second class round 2 claimed and did not have. It
// lives in its own table because it is a property of the BINARY's option
// grammar rather than of an eval body, and it gets the same completeness
// treatment: a family with no in-place editor must say why it has none.
test('the in-place edit capability is answered for every interpreter family', () => {
  const families = [...new Set(Object.values(INTERPRETER_FAMILY))];
  for (const family of families) {
    const editor = IN_PLACE_EDITORS.some((candidate) => candidate.family === family);
    const declared = IN_PLACE_COVERAGE[family];
    assert.ok(
      editor || (typeof declared === 'string' && declared.trim().length > 0),
      `${family} has no in-place editor entry and no reason for having none — the exact shape of the `
      + '`perl` fix that left `ruby -i` open',
    );
    if (editor) {
      assert.equal(declared, '', `${family} has an in-place editor AND a reason for having none`);
    }
  }
});

test('every in-place editor in the table is detected, and is a read without the flag', () => {
  for (const { binary, requiresArgument } of IN_PLACE_EDITORS) {
    const inPlace = requiresArgument
      ? `${binary} -i ${requiresArgument} '{next}' ${SIDECAR}`
      : `${binary} -i -pe 's/.*//' ${SIDECAR}`;
    assert.equal(shellCommandHasWritePrimitive(inPlace), true, inPlace);
    const read = requiresArgument
      ? `${binary} '{print $1}' ${SIDECAR}`
      : `${binary} -ne 'print' ${SIDECAR}`;
    assert.equal(shellCommandHasWritePrimitive(read), false, read);
  }
});

// The two rows this grammar exists to keep permitted. `-i` bundles differently
// in every one of these binaries, and a single loose `-[a-zA-Z]*i` refuses a
// read in three of them.
test('option grammars that would otherwise refuse a read', () => {
  for (const read of [
    "perl -MList::Util -e 'print 1'",      // -M takes an ATTACHED argument containing an i
    "ruby -Ilib -e 'puts 1'",              // -I is not -i
    "awk -v n=1 -f prog.awk data.txt",     // -v's argument must not end the option run
    "awk -i other '{print}' data.txt",     // gawk's -i is --include unless it names `inplace`
    "sed -n '1,20p' notes-i-wrote.md",     // the i is in the FILENAME
  ]) {
    assert.equal(shellCommandHasWritePrimitive(read), false, read);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUND 4. THE CORPUS BELOW DOES NOT COME FROM THE MATCHERS.
//
// Everything above this line asks the fact table about itself. Round 3's
// generated corpus was generated FROM the allowlist, so it inherited the
// author's blind spots wholesale rather than partially: tests 4-5 require ONE
// working sample per claimed cell, which proves a cell has one spelling and
// assumes it has all of them. `truncate:ruby` read as covered through the
// quoted-mode fact, so nothing could ask about ruby's NUMERIC truncate — and it
// was open. `overwrite:php` read as covered through `file_put_contents`, so
// nothing asked about `SplFileObject`.
//
// These spellings are written from LANGUAGE DOCUMENTATION — "how else does this
// language spell truncation?" — which is the question a generator built out of
// the answers it already has cannot ask. Four of them are the peer's, and each
// was ground-truthed against the real interpreter taking a 30-byte record to
// zero.
//
// HONEST RESIDUAL: I authored both this corpus and the matchers, which is weaker
// than the corpus having an independent author. It is mitigated rather than
// solved — by drawing from documentation instead of from the matchers, and by
// the fact that the matchers are no longer what protects a runtime-owned path
// (see `pathIsReadOnlyInText`).
interface DocumentedSpelling {
  capability: WriteCapability;
  family: InterpreterFamily;
  body: (path: string) => string;
}

const DOCUMENTED: readonly DocumentedSpelling[] = [
  // delete
  { capability: 'delete', family: 'python', body: (p) => `import os; os.remove('${p}')` },
  { capability: 'delete', family: 'python', body: (p) => `import pathlib; pathlib.Path('${p}').unlink()` },
  { capability: 'delete', family: 'python', body: (p) => `import shutil; shutil.rmtree('${p}')` },
  { capability: 'delete', family: 'js', body: (p) => `require('fs').unlinkSync('${p}')` },
  { capability: 'delete', family: 'js', body: (p) => `require('fs').rmSync('${p}')` },
  { capability: 'delete', family: 'deno', body: (p) => `Deno.removeSync('${p}')` },
  { capability: 'delete', family: 'deno', body: (p) => `await Deno.remove('${p}')` },
  { capability: 'delete', family: 'perl', body: (p) => `unlink "${p}"` },
  { capability: 'delete', family: 'perl', body: (p) => `use File::Path qw(remove_tree); remove_tree("${p}")` },
  { capability: 'delete', family: 'ruby', body: (p) => `File.delete('${p}')` },
  { capability: 'delete', family: 'ruby', body: (p) => `require 'pathname'; Pathname.new('${p}').delete` },
  { capability: 'delete', family: 'php', body: (p) => `unlink('${p}');` },
  { capability: 'delete', family: 'php', body: (p) => `@unlink('${p}');` },
  // truncate
  { capability: 'truncate', family: 'python', body: (p) => `open('${p}','w').close()` },
  { capability: 'truncate', family: 'python', body: (p) => `import os; os.truncate('${p}', 0)` },
  { capability: 'truncate', family: 'python', body: (p) => `import os; os.close(os.open('${p}', os.O_WRONLY|os.O_TRUNC))` },
  { capability: 'truncate', family: 'js', body: (p) => `require('fs').truncateSync('${p}', 0)` },
  { capability: 'truncate', family: 'js', body: (p) => `require('fs').openSync('${p}','w')` },
  { capability: 'truncate', family: 'deno', body: (p) => `Deno.truncateSync('${p}', 0)` },
  { capability: 'truncate', family: 'deno', body: (p) => `Deno.openSync('${p}', {write:true, truncate:true})` },
  { capability: 'truncate', family: 'perl', body: (p) => `truncate "${p}", 0` },
  { capability: 'truncate', family: 'perl', body: (p) => `open(F, ">${p}")` },
  { capability: 'truncate', family: 'ruby', body: (p) => `File.truncate('${p}', 0)` },
  // the peer's row: ruby spells the numeric flags `File::WRONLY|File::TRUNC`,
  // and the fact that carried them was anchored on the `O_` prefix
  { capability: 'truncate', family: 'ruby', body: (p) => `File.open('${p}', File::WRONLY|File::TRUNC).close` },
  { capability: 'truncate', family: 'php', body: (p) => `fclose(fopen('${p}','w'));` },
  { capability: 'truncate', family: 'php', body: (p) => `ftruncate(fopen('${p}','r+'), 0);` },
  // overwrite
  { capability: 'overwrite', family: 'python', body: (p) => `from pathlib import Path; Path('${p}').write_text('')` },
  // the peer's row: a zip archive OPENED FOR WRITE over a json record
  { capability: 'overwrite', family: 'python', body: (p) => `import zipfile; zipfile.ZipFile('${p}','w').close()` },
  { capability: 'overwrite', family: 'js', body: (p) => `require('fs').writeFileSync('${p}','')` },
  { capability: 'overwrite', family: 'js', body: (p) => `require('fs').createWriteStream('${p}')` },
  { capability: 'overwrite', family: 'deno', body: (p) => `Deno.writeTextFileSync('${p}','')` },
  { capability: 'overwrite', family: 'deno', body: (p) => `Deno.writeFileSync('${p}', new Uint8Array())` },
  // the peer's two rows, which falsified the `overwrite:perl` exemption
  { capability: 'overwrite', family: 'perl', body: (p) => `use File::Slurp; write_file("${p}","")` },
  { capability: 'overwrite', family: 'perl', body: (p) => `use Path::Tiny; path("${p}")->spew_utf8("")` },
  { capability: 'overwrite', family: 'ruby', body: (p) => `File.write('${p}','')` },
  { capability: 'overwrite', family: 'ruby', body: (p) => `IO.binwrite('${p}','')` },
  { capability: 'overwrite', family: 'php', body: (p) => `file_put_contents('${p}','');` },
  // documented, NOT ground-truthed: php is not installed on this machine, and
  // this repository contains no evidence about php's runtime behaviour. The
  // constructor takes an `fopen` mode and `w` truncates.
  { capability: 'overwrite', family: 'php', body: (p) => `$f = new SplFileObject('${p}','w');` },
  // rename
  { capability: 'rename', family: 'python', body: (p) => `import os; os.rename('${p}','x')` },
  // the peer's row: `os.renames`, which the `os\.(?:rename)\s*\(` matcher
  // could not reach because the `s` sits between the verb and its parens
  { capability: 'rename', family: 'python', body: (p) => `import os; os.renames('${p}','gone/x.json')` },
  // `shutil.move` is documented as "recursively move a file or directory". It
  // is here because a mutant that deleted its stem SURVIVED: no documented
  // spelling exercised the stem, so its removal had nothing to fail. That is an
  // absent fixture, not an equivalence, and this row is the fixture.
  { capability: 'rename', family: 'python', body: (p) => `import shutil; shutil.move('${p}','x')` },
  { capability: 'rename', family: 'js', body: (p) => `require('fs').renameSync('/dev/null','${p}')` },
  { capability: 'rename', family: 'js', body: (p) => `require('fs').promises.rename('${p}','x')` },
  { capability: 'rename', family: 'deno', body: (p) => `Deno.renameSync('/dev/null','${p}')` },
  { capability: 'rename', family: 'deno', body: (p) => `await Deno.rename('${p}','x')` },
  { capability: 'rename', family: 'perl', body: (p) => `rename "${p}", "x"` },
  { capability: 'rename', family: 'perl', body: (p) => `use File::Copy; move("${p}","x")` },
  { capability: 'rename', family: 'ruby', body: (p) => `File.rename('${p}','x')` },
  { capability: 'rename', family: 'ruby', body: (p) => `require 'fileutils'; FileUtils.mv('${p}','x')` },
  { capability: 'rename', family: 'php', body: (p) => `rename('/dev/null','${p}');` },
  { capability: 'rename', family: 'php', body: (p) => `rename('${p}','x');` },
  // copy
  { capability: 'copy', family: 'python', body: (p) => `import shutil; shutil.copyfile('/dev/null','${p}')` },
  { capability: 'copy', family: 'python', body: (p) => `import shutil; shutil.copy2('/dev/null','${p}')` },
  { capability: 'copy', family: 'js', body: (p) => `require('fs').copyFileSync('/dev/null','${p}')` },
  { capability: 'copy', family: 'js', body: (p) => `require('fs').cpSync('/dev/null','${p}')` },
  { capability: 'copy', family: 'deno', body: (p) => `Deno.copyFileSync('/dev/null','${p}')` },
  { capability: 'copy', family: 'deno', body: (p) => `await Deno.copyFile('/dev/null','${p}')` },
  { capability: 'copy', family: 'perl', body: (p) => `use File::Copy; copy("/dev/null","${p}")` },
  { capability: 'copy', family: 'perl', body: (p) => `use File::Copy; cp("/dev/null","${p}")` },
  { capability: 'copy', family: 'ruby', body: (p) => `require 'fileutils'; FileUtils.cp('/dev/null','${p}')` },
  { capability: 'copy', family: 'ruby', body: (p) => `IO.copy_stream('/dev/null','${p}')` },
  { capability: 'copy', family: 'php', body: (p) => `copy('/dev/null','${p}');` },
  { capability: 'copy', family: 'php', body: (p) => `copy('${p}','${p}.bak');` },
  // spawn
  { capability: 'spawn', family: 'python', body: (p) => `import os; os.system('rm -f ${p}')` },
  { capability: 'spawn', family: 'python', body: (p) => `import subprocess; subprocess.run(['rm','-f','${p}'])` },
  { capability: 'spawn', family: 'js', body: (p) => `require('child_process').execSync('rm -f ${p}')` },
  { capability: 'spawn', family: 'js', body: (p) => `require('child_process').spawnSync('rm',['-f','${p}'])` },
  { capability: 'spawn', family: 'deno', body: (p) => `new Deno.Command('rm',{args:['-f','${p}']}).outputSync()` },
  { capability: 'spawn', family: 'deno', body: (p) => `Deno.run({cmd:['rm','-f','${p}']})` },
  { capability: 'spawn', family: 'perl', body: (p) => `system("rm -f ${p}")` },
  { capability: 'spawn', family: 'perl', body: (p) => `exec("rm -f ${p}")` },
  { capability: 'spawn', family: 'ruby', body: (p) => `system('rm -f ${p}')` },
  { capability: 'spawn', family: 'ruby', body: (p) => `Process.spawn('rm','-f','${p}')` },
  { capability: 'spawn', family: 'php', body: (p) => `shell_exec('rm -f ${p}');` },
  { capability: 'spawn', family: 'php', body: (p) => `passthru('rm -f ${p}');` },
];

// THE CLOSURE PROPERTY. Every documented spelling above is refused at a
// runtime-owned path — including the eleven the capability vocabulary below
// does NOT recognise. That is the whole shape decision in one assertion: the
// judgement that protects Traffic One's tree does not consult a verb list, so
// its coverage is not bounded by one.
test('every documented destructive spelling names the path outside a read', () => {
  assert.ok(DOCUMENTED.length >= 70, `the corpus has ${DOCUMENTED.length} rows — it is not being read`);
  for (const { capability, family, body } of DOCUMENTED) {
    const text = body(SIDECAR);
    assert.equal(
      pathIsReadOnlyInText(text, SIDECAR), false,
      `${capability}:${family} — a documented destruction reads as a READ: ${text}`,
    );
  }
});

// THE PROPERTY THAT WOULD HAVE CAUGHT A VERB LIST COMING BACK. An invented verb
// cannot be on any list, so only a rule closed by construction refuses it.
// Reverting either judgement to a mutation vocabulary reddens this test and
// nothing else does.
test('an invented verb no author could have listed is refused', () => {
  for (const body of [
    `Zorp::Frobnicate.obliterate('${SIDECAR}')`,
    `import quux; quux.vaporize('${SIDECAR}')`,
    `require('nonesuch').defenestrate('${SIDECAR}')`,
    `blorp("${SIDECAR}")`,
    `$x = new Widget('${SIDECAR}', 'destroy');`,
  ]) {
    assert.equal(pathIsReadOnlyInText(body, SIDECAR), false, body);
  }
});

// The cost side of the same coin, and the reason the read list is the one worth
// maintaining: a missing entry here is a FALSE REFUSAL, which reddens a test
// rather than hiding until a peer spells the destruction.
test('an ordinary read of a runtime-owned path stays a read', () => {
  for (const body of [
    `console.log(require('fs').readFileSync('${SIDECAR}','utf8'))`,
    `require('fs').statSync('${SIDECAR}').size`,
    `console.log(require('${SIDECAR}'))`,
    `console.log('${SIDECAR}')`,
    `print(open('${SIDECAR}').read())`,
    `print(open('${SIDECAR}','rb').read())`,
    `import json; print(json.load(open('${SIDECAR}'))['bound'])`,
    `from pathlib import Path; print(Path('${SIDECAR}').read_text())`,
    `import os; print(os.path.getsize('${SIDECAR}'))`,
    `puts File.read('${SIDECAR}')`,
    `puts File.open('${SIDECAR}','r').read`,
    `require 'pathname'; puts Pathname.new('${SIDECAR}').read`,
    `use Path::Tiny; print path("${SIDECAR}")->slurp_utf8`,
    `echo file_get_contents('${SIDECAR}');`,
    `echo filesize('${SIDECAR}');`,
    `console.log(Deno.readTextFileSync('${SIDECAR}'))`,
    `cat ${SIDECAR}`,
    `grep -n 'bound' ${SIDECAR}`,
    `jq .bound ${SIDECAR}`,
    // ROUND 5. Twelve of these were refused, and the reason they had to be
    // fixed as a class is that the boundary was arbitrary rather than tight:
    // `.read()` was permitted and `.read().decode()` refused, `os.path.getsize`
    // permitted and `os.stat().st_size` refused, ruby's `File.stat().size`
    // permitted and node's `statSync().mtimeMs` refused. A maintainer cannot
    // predict which of two equivalent spellings is allowed, and every discovery
    // invites widening the read list for the wrong reason.
    `print(open('${SIDECAR}','rb').read().decode())`,
    `import os; print(os.stat('${SIDECAR}').st_size)`,
    `console.log(require('fs').statSync('${SIDECAR}').mtimeMs)`,
    `print(len(open('${SIDECAR}').read()))`,
    `import json; print(sorted(json.load(open('${SIDECAR}')).keys()))`,
    `import hashlib; print(hashlib.md5(open('${SIDECAR}','rb').read()).hexdigest())`,
    `if (require('fs').existsSync('${SIDECAR}')) console.log('yes')`,
    // the FIELD NAME after a content read, which no list can enumerate because
    // it is the caller's own data
    `console.log(JSON.parse(require('fs').readFileSync('${SIDECAR}','utf8')).bound)`,
    `console.log(Buffer.from(require('fs').readFileSync('${SIDECAR}')).length)`,
    `console.log(require('path').basename('${SIDECAR}'))`,
    `puts File.readlines('${SIDECAR}').sort.first`,
    `File.foreach('${SIDECAR}') { |l| puts l }`,
    // both perl spellings of a read open: the mode argument's own closing quote
    // sits between the path and the `open` that takes it
    `open(my $fh, "<", "${SIDECAR}") or die; print <$fh>;`,
    `open(F, "<${SIDECAR}") or die; print <F>;`,
    `print(open('${SIDECAR}', encoding='utf-8').read())`,
    `print(open('${SIDECAR}', mode='r').read())`,
    `import os; os.close(os.open('${SIDECAR}', os.O_RDONLY))`,
    `puts File.open('${SIDECAR}','r:UTF-8').read`,
    `Deno.openSync('${SIDECAR}', {read:true})`,
    `fclose(fopen('${SIDECAR}','r'));`,
    `import sys; sys.stdout.write(open('${SIDECAR}').read())`,
    `process.stdout.write(require('fs').readFileSync('${SIDECAR}'))`,
    // a MENTION handed to a printer, in both argument positions. Keyed on
    // quotes, these two split — which is the arbitrary boundary again, one
    // level down.
    `print('read ${SIDECAR}')`,
    `print('a', 'read ${SIDECAR}')`,
  ]) {
    assert.equal(pathIsReadOnlyInText(body, SIDECAR), true, body);
  }
});

// ROUND 5, LEVEL 1 OF THE INVERSION: THE WHOLE CALL NEST, IN BOTH ORDERS.
//
// Round 4 resolved ONE call site per occurrence and accepted it if that site
// was a read, so a read head TAKING the literal laundered any destruction
// enclosing it — `str`, `String`, `sprintf`, `os.path.abspath`,
// `File.expand_path`, `realpathSync` and `resolve` were each a one-word bypass,
// and the wrapped erasures were measured taking a 28-byte record to 22 or 0
// bytes at gate `noop` while the unwrapped spelling denied.
//
// The mirror order (`console.log(unlinkSync(p))`) was the one round 4's comment
// analysed, and it held. Both are here because the rule is now about the nest
// rather than about a position in it, and a fix that only added the missing
// order would be one comment away from the same defect.
test('a read head wrapping the path does not launder a write enclosing it', () => {
  for (const body of [
    // the read head is INNERMOST and the destruction encloses it
    `import zipfile; zipfile.ZipFile(str('${SIDECAR}'),'w').close()`,
    `import os; os.unlink(str('${SIDECAR}'))`,
    `import os; os.unlink(os.path.abspath('${SIDECAR}'))`,
    `import os; os.truncate(os.path.realpath('${SIDECAR}'), 0)`,
    `require('fs').writeFileSync(String('${SIDECAR}'),'')`,
    `const fs=require('fs');fs.unlinkSync(fs.realpathSync('${SIDECAR}'))`,
    `require('fs').unlinkSync(require('path').resolve('${SIDECAR}'))`,
    `File.delete(File.expand_path('${SIDECAR}'))`,
    `unlink(sprintf("${SIDECAR}"))`,
    `import subprocess; subprocess.run(['rm','-f',str('${SIDECAR}')])`,
    `print(open(str('${SIDECAR}'),'w'))`,
    // an invented verb WRAPPED, which no list could hold in either position
    `import quux; quux.vaporize(str('${SIDECAR}'))`,
    // the destructive head is INNERMOST — the order round 4 did analyse
    `console.log(require('fs').unlinkSync('${SIDECAR}'))`,
    `print(open('${SIDECAR}','w'))`,
    `console.log(require('fs').rmSync(require('path').dirname('${SIDECAR}'),{recursive:true}))`,
  ]) {
    assert.equal(pathIsReadOnlyInText(body, SIDECAR), false, body);
  }
});

// ROUND 6: THE UNIT IS THE STATEMENT, SO SIBLING POSITION IS NOT A POSITION.
//
// Round 5 judged the calls ENCLOSING the occurrence and its docblock claimed a
// read entry "can no longer admit a destruction SOMEWHERE ELSE in the same
// expression". A peer falsified that by moving the destruction OUT of the
// occurrence's ancestor chain and BESIDE it: in
// `list(map(lambda f: zipfile.ZipFile(f,'w'), ['<sidecar>']))` the occurrence's
// ancestors are `map` and `list`, both read entries, and the `ZipFile` is a
// sibling nobody walked — measured `noop` at the gate on four ground-truthed
// erasures, and removing `list`/`map`/`sorted` from the read list flipped two of
// them to `deny`, which is what proved those entries were security decisions
// while the docblock said they were cost decisions.
//
// `occurrenceIsRead` now enumerates EVERY call site in the statement that spells
// the path, so ancestor and sibling are the same case and there is no third
// position left to move a destruction into. Each row below is a destruction the
// occurrence does not reach through — a comprehension body, a lambda, a block —
// and the LAST TWO are the reads that make the rule a cost rather than a ban:
// the same shapes with a read in the destruction's place still pass.
test('a read entry does not launder a destruction BESIDE the occurrence', () => {
  const runDir = '.traffic-one/runs/run-1';
  for (const body of [
    `import zipfile; list(map(lambda f: zipfile.ZipFile(f,'w'), ['${SIDECAR}']))`,
    `import glob,zipfile; [zipfile.ZipFile(f,'w') for f in glob.glob('${SIDECAR}')]`,
    `import glob,zipfile; [zipfile.ZipFile(f,'w') for f in sorted(glob.glob('${SIDECAR}'))]`,
    `import os,glob; [os.unlink(f) for f in glob.glob('${SIDECAR}')]`,
    `require('fs');['${SIDECAR}'].map((f) => require('fs').unlinkSync(f))`,
    `require('pathname');Dir.glob('${SIDECAR}').each { |f| Pathname.new(f).delete }`,
  ]) {
    assert.equal(pathIsReadOnlyInText(body, SIDECAR), false, body);
  }
  // The bare runs DIRECTORY reached by a read chain, destroyed in the body —
  // BLOCKER 4's row, which is this same shape one extractor away.
  assert.equal(
    pathIsReadOnlyInText(`import pathlib; [p.unlink() for p in pathlib.Path('${runDir}').glob('*/run.json')]`, runDir),
    false,
  );
  // …and the cost side: a fold over what was READ is still a read.
  assert.equal(
    pathIsReadOnlyInText(`import glob; print(list(map(len, glob.glob('${SIDECAR}'))))`, SIDECAR), true,
  );
  assert.equal(
    pathIsReadOnlyInText(`import pathlib; print([p.name for p in pathlib.Path('${runDir}').glob('*/run.json')])`, runDir),
    true,
  );
});

// WHAT MAKES THE READ LIST SAFE TO WIDEN, built rather than asserted.
//
// A peer's surviving mutant added `os.path.join`/`join` to `READ_CALL_HEADS`:
// 0-of-58 killed, while `zipfile.ZipFile(os.path.join(<run dir>,'run.json'),'w')`
// moved from deny to noop at the real gate. It survived because the enclosing
// call was never consulted. Both halves are pinned here — the widening IS in
// the list, and the erasure through it still refuses — so the property that
// makes the list a cost list rather than a security boundary is a test rather
// than a claim in a docblock.
test('path arithmetic is a read, and a destruction reached THROUGH it is not', () => {
  const runDir = '.traffic-one/runs/run-1';
  assert.equal(pathIsReadOnlyInText(`import os; print(os.path.join('${runDir}','run.json'))`, runDir), true);
  assert.equal(pathIsReadOnlyInText(`console.log(require('path').join('${runDir}','run.json'))`, runDir), true);
  for (const body of [
    `import os,zipfile; zipfile.ZipFile(os.path.join('${runDir}','run.json'),'w').close()`,
    `import os,shutil; shutil.rmtree(os.path.join('${runDir}'))`,
    `require('fs').rmSync(require('path').join('${runDir}','run.json'))`,
  ]) {
    assert.equal(pathIsReadOnlyInText(body, runDir), false, body);
  }
});

// ROUND 5, LEVEL 2: THE MODE ARGUMENT IS AN ALLOWLIST OF READS.
//
// What stood here was a denylist of destructive modes inside the function that
// had replaced a denylist, so a mode it did not recognise read as a read. Four
// ground-truthed erasures used that with no wrapper at all: a mode bound to a
// variable in python, node and ruby, and `os.open(p, 1|512|1024)` — the flags
// written NUMERICALLY, which is not merely unlisted but unlistable by symbol
// matching, the exact property the inversion was adopted to obtain.
test('an unrecognised or computed open mode is not a read', () => {
  for (const body of [
    `m='w'; open('${SIDECAR}', m).close()`,
    `const m='w'; require('fs').openSync('${SIDECAR}', m)`,
    `m='w'; File.open('${SIDECAR}', m).close`,
    `import os; os.close(os.open('${SIDECAR}', 1|512|1024))`,
    `import os; os.close(os.open('${SIDECAR}', 577))`,
    `open('${SIDECAR}', 'w'[0]).close()`,
    `m='w'; open('${SIDECAR}', mode=m).close()`,
    `File.open('${SIDECAR}', mode: 'w').close`,
    `Deno.openSync('${SIDECAR}', {write:true, truncate:true})`,
    `const fs=require('fs');fs.closeSync(fs.openSync('${SIDECAR}', fs.constants.O_WRONLY))`,
    `File.open('${SIDECAR}', File::WRONLY|File::TRUNC).close`,
    `open(F, ">${SIDECAR}")`,
    `open(my $fh, ">>", "${SIDECAR}")`,
  ]) {
    assert.equal(pathIsReadOnlyInText(body, SIDECAR), false, body);
  }
});

// AN ERASURE FAR FROM ITS ARGUMENT STILL REFUSES, AND THE READ BESIDE IT NO
// LONGER DOES — the third assertion here is the one that changed, and it changed
// direction.
//
// The version of this test that shipped with round 5 read: "PRICED, in the same
// measurement: a READ padded the same way refuses too. A 700-character gap
// between a call and its argument is not a shape an agent writes, and the
// alternative is admitting a destruction for being far away." That price existed
// because the judgement HUNTED BACKWARDS from the occurrence for an enclosing
// callee and gave up after `CALL_SCAN_BOUND` characters, so distance was the
// thing being measured, and a bound on a backward hunt cannot tell a read from a
// write. Round 6 enumerates the CALLS OF THE STATEMENT instead. Distance stopped
// being a quantity the rule spends: `print(… 700 spaces … abspath(p))` is two
// reads however far apart they sit, and `os.unlink(… 700 spaces … abspath(p))`
// is a write in the same statement as the path however far apart THEY sit.
//
// The row is kept, pointed the other way, because it is the fixture that
// separates "nothing encloses this" from "I could not see far enough to know" —
// a mutant that collapsed those two SURVIVED round 4 with its canary killed. The
// bound that remains is a count of call sites (`MAX_CALL_SITES`), and the row
// below pins its polarity.
test('an erasure far from its argument refuses; a read far from its argument does not', () => {
  const pad = ' '.repeat(700);
  assert.equal(pathIsReadOnlyInText(`import os; os.unlink(${pad}os.path.abspath('${SIDECAR}'))`, SIDECAR), false);
  assert.equal(pathIsReadOnlyInText(`require('fs').unlinkSync(${pad}require('path').resolve('${SIDECAR}'))`, SIDECAR), false);
  assert.equal(pathIsReadOnlyInText(`import os; print(${pad}os.path.abspath('${SIDECAR}'))`, SIDECAR), true);
  // MORE CALL SITES THAN THE BOUND is unresolved, and unresolved refuses. Both
  // directions are priced here: the padding is calls rather than characters, so
  // the read pays it too, and a statement with two hundred calls in it is not a
  // shape an agent writes.
  const manyReads = `${'len(str('.repeat(120)}'${SIDECAR}'${'))'.repeat(120)}`;
  assert.equal(pathIsReadOnlyInText(`import os; print(${manyReads})`, SIDECAR), false);
});

// ROUND 5, P4: A PARTIAL PARSE MUST NOT READ AS AN ABSENT TARGET.
//
// The path extractors' character class stops at `}`, so an interpolated path
// yields `.traffic-one/runs/${r` — which matched no sidecar contract and no
// scope, so the command passed as if it had named no runtime path at all. Same
// false-green family as a check whose failure mode is empty output read by a
// comparison that treats empty as fine. These two functions are how the caller
// tells a truncation from a complete path and recovers the part that IS
// readable; the interpolation itself is not resolved and stays disclosed.
test('a truncated path literal reports itself and yields its readable prefix', () => {
  assert.equal(pathLiteralIsTruncated('.traffic-one/runs/${r'), true);
  assert.equal(pathLiteralIsTruncated('.traffic-one/runs/{r'), true);
  assert.equal(pathLiteralIsTruncated('.traffic-one/runs/#{r'), true);
  assert.equal(pathLiteralIsTruncated('.traffic-one/runs/$R'), true);
  assert.equal(pathLiteralIsTruncated('.traffic-one/runs/run-1/run.json'), false);
  assert.equal(pathLiteralPrefix('.traffic-one/runs/${r'), '.traffic-one/runs');
  assert.equal(pathLiteralPrefix('.traffic-one/runs/${r}/scan-bound.json'), '.traffic-one/runs');
  assert.equal(pathLiteralPrefix('${root}/runs/x.json'), '');
  // and the read spelled the same way is still a read: the truncated literal
  // cannot reach its closing quote, and requiring one refused every
  // interpolated read of a sidecar
  for (const [body, literal] of [
    [`r='run-1'; print(open(f'.traffic-one/runs/{r}/scan-bound.json').read())`, '.traffic-one/runs/{r'],
    ['const r="x";console.log(require("fs").readFileSync(`.traffic-one/runs/${r}/run.json`,"utf8"))', '.traffic-one/runs/${r'],
  ] as const) {
    assert.equal(pathIsReadOnlyInText(body, literal), true, body);
  }
  for (const [body, literal] of [
    [`import os; r='x'; os.truncate(f'.traffic-one/runs/{r}/scan-bound.json', 0)`, '.traffic-one/runs/{r'],
    ['const r="x";require("fs").unlinkSync(`.traffic-one/runs/${r}/run.json`)', '.traffic-one/runs/${r'],
    [`r="x"; File.delete(".traffic-one/runs/#{r}/run.json")`, '.traffic-one/runs/#'],
  ] as const) {
    assert.equal(pathIsReadOnlyInText(body, literal), false, body);
  }
});

// DERIVED COVERAGE, replacing the ANNOTATION the previous property read.
//
// Round 3's staleness check computed `covered` from
// `fact.families.includes(family) && fact.samples[family]` — hand-written
// annotations that do not derive from the matcher — so it detected an exemption
// that was REDUNDANT and was structurally blind to one that was WRONG. It was
// green on `overwrite:perl` while two ordinary perl spellings took a record to
// zero bytes. Coverage below is COMPUTED, by running the matcher.
function documentedFor(capability: WriteCapability, family: InterpreterFamily): DocumentedSpelling[] {
  return DOCUMENTED.filter((row) => row.capability === capability && row.family === family);
}

const COMPOSITE = new RegExp(EVAL_WRITE_MATCH_SOURCE);

test('every cell the fact table CLAIMS is proven by a documented spelling, not by its own annotation', () => {
  for (const capability of WRITE_CAPABILITIES) {
    for (const family of [...new Set(Object.values(INTERPRETER_FAMILY))].sort()) {
      const claimed = EVAL_WRITE_FACTS.some((fact) => (
        fact.capability === capability && fact.families.includes(family) && fact.samples[family]
      ));
      if (!claimed) continue;
      const documented = documentedFor(capability, family);
      assert.ok(
        documented.length >= 2,
        `${capability}:${family} is claimed with ${documented.length} documented spelling(s). A cell proven by `
        + 'ONE spelling is a cell assumed to have all of them — the defect this corpus exists to price.',
      );
      assert.ok(
        documented.some((row) => COMPOSITE.test(row.body(SIDECAR))),
        `${capability}:${family} is claimed by an annotation no documented spelling confirms`,
      );
    }
  }
});

// THE OTHER DIRECTION, and the one a mutant caught missing.
//
// The property above walks CLAIMED cells and asks the corpus to confirm them.
// That leaves the reverse open, and it is round 3's defect (b) exactly: drop
// `ruby` from the `O_`-flags fact's `families` and NOTHING reddens, because a
// sibling `truncate` fact still claims `truncate:ruby` via its quoted-mode
// spelling. The cell census cannot see it — a cell is one bit, and the mutant
// removes a SPELLING. The annotation silently stops being proven, which is the
// state round 3 shipped in.
//
// So the link is made per-spelling and in the direction the corpus drives: a
// documented spelling the matcher RECOGNISES must be claimed by a fact that
// both matches it and names its family with a sample. A family removed from an
// annotation now reddens on the spellings that family documents, and a
// documented spelling added for an unclaimed family reddens too.
test('every documented spelling the matcher recognises is CLAIMED by the fact that matches it', () => {
  const unclaimed: string[] = [];
  for (const row of DOCUMENTED) {
    const body = row.body(SIDECAR);
    if (!COMPOSITE.test(body)) continue; // pinned as a measured blind spot below
    const claimed = EVAL_WRITE_FACTS.some((fact) => (
      fact.capability === row.capability
      && new RegExp(fact.match).test(body)
      && fact.families.includes(row.family)
      && fact.samples[row.family]
    ));
    if (!claimed) unclaimed.push(`${row.capability}:${row.family} ${row.body('P')}`);
  }
  assert.deepEqual(
    unclaimed, [],
    'a matcher recognises these documented spellings, and no fact CLAIMS the family they are written in. '
    + 'The annotation and the matcher have come apart: the table is being read as covering a family it no '
    + 'longer says it covers, which is how a cell keeps reading as green while a spelling under it goes dark.',
  );
});

test('an exemption a documented spelling falsifies is red', () => {
  for (const key of Object.keys(CAPABILITY_COVERAGE)) {
    const [capability, family] = key.split(':') as [WriteCapability, InterpreterFamily];
    assert.deepEqual(
      documentedFor(capability, family).map((row) => row.body(SIDECAR)), [],
      `CAPABILITY_COVERAGE excuses ${key} as unreachable, and a documented spelling performs it. This is the `
      + 'check the previous staleness property could not make: it asked the matcher whether it CLAIMED the '
      + 'cell, never whether the claim was true.',
    );
  }
});

// The vocabulary's incompleteness, MEASURED and pinned rather than unknown.
//
// These are documented destructions the capability table does not recognise.
// They are refused anyway wherever Traffic One owns the path (the closure
// property above), and they remain the honest residue for the one question with
// no path anchor — `commandAppearsToWriteFeatureSource` over `src/**`. Pinning
// the exact set means widening the vocabulary forces this list to shrink, and
// a spelling silently LEAVING the vocabulary forces it to grow.
// Two left this list in round 4 and neither was aimed at: `IO.copy_stream` and
// `os.renames` became visible as a SIDE EFFECT of moving the mis-attributed
// stems onto the capabilities they perform, because a matcher written for one
// capability generalises over that capability's spellings and not over another's.
// That is the argument for making the table's capability column mean something,
// stated as a measurement rather than as taste.
const VOCABULARY_BLIND_SPELLINGS: readonly string[] = [
  "delete:ruby require 'pathname'; Pathname.new('P').delete",
  "overwrite:php $f = new SplFileObject('P','w');",
  "overwrite:python import zipfile; zipfile.ZipFile('P','w').close()",
  'rename:perl use File::Copy; move("P","x")',
  "spawn:ruby Process.spawn('rm','-f','P')",
];

test('the capability vocabulary\'s blind spellings are exactly the recorded set', () => {
  const blind = DOCUMENTED
    .filter((row) => !COMPOSITE.test(row.body(SIDECAR)))
    .map((row) => `${row.capability}:${row.family} ${row.body('P')}`);
  assert.deepEqual(
    blind.sort(), [...VOCABULARY_BLIND_SPELLINGS].sort(),
    'the vocabulary\'s measured gap moved. It is not a failure to have one — it is a failure to not know it.',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// THE FIND ACTION JUDGEMENT, AND WHY IT IS NO LONGER A CENSUS.
//
// What stood here was a symmetry property between two LISTS: every verb in a
// shared destructive set had to appear in `FIND_ACTION_VERB_LIST` or in
// `FIND_ACTION_EXEMPT` with a reason. Its own comment admitted a census cannot
// discover a verb nobody wrote down, and the admission was the whole story —
// the exemption map was empty, so the only thing the second half could check
// was that a reason string nobody had written was non-empty. It was the one
// property in this file that NO REAL SPELLING COULD FALSIFY, which a peer said
// out loud, and it passed green through six ground-truthed erasures of a live
// `run.json` (`-exec tee {}`, `-exec sh -c '…rm…'`, `bash`, `python3`, `env`).
//
// `findWriteAction` asks the read question now, so the property can be about
// BEHAVIOUR: every verb the shared sets carry is driven through a real `-exec`
// and a real `xargs`, and so are the wrapper shapes and the reads. Any spelling
// anyone can type is admissible evidence against it.

/**
 * The ARGUMENT GRAMMAR that makes a conditional verb write, for the five whose
 * answer depends on their operands. Not a membership list — membership is
 * derived below and this table cannot add to it — but the same fact
 * `SHELL_VERB_SPELLINGS` carries in the cross-module suite: no verb SET can
 * hold that `sort` names its destination with `-o` and `sed` with `-i`.
 */
const WRITING_SPELLING: Readonly<Record<string, string>> = {
  sort: 'sort -o {}',
  sed: "sed -i '' -e 's/.*//' {}",
  gsed: "gsed -i 's/.*//' {}",
  awk: "awk -i inplace '{next}' {}",
  gawk: "gawk -i inplace '{next}' {}",
};

test('every verb in a shared destructive set writes when a find sweep runs it', () => {
  const shared = [
    ...DESTRUCTIVE_VERBS.split('|'),
    ...REPLACING_COMPRESSORS.split('|'),
    ...OVERWRITE_TOOLS.split('|'),
    ...NAMED_OUTPUT_TOOLS.split('|'),
    ...IN_PLACE_EDITORS.map((editor) => editor.binary),
    'tee',
  ];
  assert.ok(shared.length >= 25, `the shared verb sets expanded to ${shared.length} — they are not being read`);
  const permitted = shared.filter((verb) => {
    const action = WRITING_SPELLING[verb] || `${verb} {}`;
    return !findWriteAction(`find ${SIDECAR} -exec ${action} \\;`)
      || !findWriteAction(`find ${SIDECAR} -print0 | xargs -0 -I {} ${action}`);
  });
  assert.deepEqual(
    permitted, [],
    'these verbs destroy a file everywhere else in this vocabulary but are invisible after `-exec`/`xargs`.',
  );
});

// THE COST OF THE INVERSION, MEASURED RATHER THAN ARGUED. The list this
// judgement used to consult could only ask WHICH VERB, so it refused a sweep
// that merely READS with a verb capable of writing — `-exec sort {}` (no `-o`),
// `-exec sed -e … {}` (no `-i`), `-exec awk '{print}' {}` (no redirect). Each
// row here changed answer this round, from refused to permitted, and each is a
// read the same conditions permit outside a `find`. Pinned so the widening is a
// decision with a test on it rather than a side effect nobody wrote down.
test('a find sweep that only READS with a writing-capable verb is permitted', () => {
  for (const action of ["sort {}", "sed -n '1p' {}", "awk '{print}' {}", "gawk '{print}' {}"]) {
    assert.ok(!findWriteAction(`find ${SIDECAR} -exec ${action} \\;`), `refused as a write: ${action}`);
  }
});

test('a find action is judged by what it is not: wrappers are re-entered, reads survive', () => {
  const writes = [
    `find ${SIDECAR} -exec tee {} \\;`,
    `find ${SIDECAR} -exec sh -c 'rm -f "$1"' _ {} \\;`,
    `find ${SIDECAR} -exec bash -c 'printf "" > "$1"' _ {} \\;`,
    `find ${SIDECAR} -exec /bin/sh -c 'rm -f "$1"' _ {} \\;`,
    `find ${SIDECAR} -exec python3 -c 'import sys,os; os.unlink(sys.argv[1])' {} \\;`,
    `find ${SIDECAR} -exec env rm -f {} \\;`,
    `find ${SIDECAR} -execdir rm -f {} \\;`,
    `find ${SIDECAR} -exec zsh -c 'cat "$1"; rm -f "$1"' _ {} \\;`,
    `find ${SIDECAR} -print0 | xargs -0 -I {} sh -c 'rm -f {}'`,
    `find ${SIDECAR} -delete`,
  ];
  for (const command of writes) assert.ok(findWriteAction(command), `permitted as a read: ${command}`);
  const reads = [
    `find ${SIDECAR} -exec cat {} \\;`,
    `find ${SIDECAR} -exec grep -l bound {} \\;`,
    `find ${SIDECAR} -exec sh -c 'cat "$1"' _ {} \\;`,
    `find ${SIDECAR} -exec sh -c 'jq -e .runId "$1"' _ {} \\;`,
    `find ${SIDECAR} -print0 | xargs -0 wc -l`,
    `find ${SIDECAR} -name '*.json' -print`,
    `find ${SIDECAR} -exec awk 'length($0) > 10 {print}' {} \\;`,
  ];
  for (const command of reads) assert.ok(!findWriteAction(command), `refused as a write: ${command}`);
});

/** Would these pathspecs reach the runs tree? `[]` is "the whole worktree". */
function reachesRunsTree(specs: string[] | null): boolean {
  if (specs === null) return false;
  if (specs.length === 0) return true;
  return specs.some((spec) => spec === '.' || spec === '' || spec.startsWith('.traffic-one'));
}

test('every git subcommand in the census is answered, and every exemption still needs its reason', () => {
  assert.ok(GIT_WORKTREE_SUBCOMMANDS.length >= 20, 'the census is too small to be a census');
  for (const { subcommand, forcing, permitted, why } of GIT_WORKTREE_SUBCOMMANDS) {
    assert.ok(why.trim().length > 0, `${subcommand} is in the census with no reason`);
    if (forcing) {
      assert.equal(
        reachesRunsTree(gitWorktreeRewritePathspecs(forcing)), true,
        `git ${forcing.join(' ')} rewrites the worktree over the runs tree and this function does not say so`,
      );
    } else {
      assert.equal(
        reachesRunsTree(gitWorktreeRewritePathspecs(permitted)), false,
        `${subcommand} is exempted from the census — "${why}" — but the function answers for it. A stale `
        + 'exemption is how the next author excuses one that is not stale.',
      );
    }
    // Coverage bought by refusing the subcommand outright is not coverage.
    assert.equal(
      reachesRunsTree(gitWorktreeRewritePathspecs(permitted)), false,
      `git ${permitted.join(' ')} is an ordinary command and must stay permitted`,
    );
  }
});
