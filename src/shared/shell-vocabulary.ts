// src/shared/shell-vocabulary.ts
// The shell FACTS both write detectors need: which binaries evaluate code handed
// to them, how a host spells "here is the code", which verbs destroy a file, and
// what a heredoc whose reader is an interpreter looks like.
//
// Why one module rather than two copies. `shared/feature-source.ts` (is this
// command a write, and which Traffic One artifact does it name?) and
// `plan-guard/plan-write/sidecar-shell.ts` (which runtime sidecars would this
// command destroy without naming one?) each grew their own interpreter list,
// eval-flag set, destructive-verb set and heredoc handling. A peer then drove one
// corpus through both and found FOUR defects already fixed in one copy and still
// open in the other, in both directions: the heredoc-reader distinction (only in
// sidecar-shell), a quote before the verb (only in sidecar-shell), `dd of=` /
// `install` (only in sidecar-shell), and `truncate` in the verb set (only in
// feature-source). All four sat in the layer BELOW either module's judgement —
// they are facts about shells, not decisions about ownership — which is the
// measurement this split is built on: share the facts, keep the judgements apart.
//
// The judgements stay apart because they are genuinely different. This file
// exports SOURCE STRINGS and small predicates, never a `commandIsAWrite`:
// feature-source needs call-shaped precision because it answers on commands that
// name no artifact, while sidecar-shell can afford looser vocabulary because it
// only ever reports files it just found on disk under `.traffic-one/runs/`.
// A cross-module corpus test (plan-guard/__tests__/shell-write-vocabulary.test.ts)
// asserts the two do not drift apart again.

/**
 * Binaries that run code handed to them on the command line or on stdin.
 *
 * `nodejs` is Debian's binary name, `ts-node`/`tsx` are the TypeScript wrappers
 * an agent reaches for in this exact repo, and ruby/php ship with macOS.
 */
export const INTERPRETER_NAMES = String.raw`python3?|node(?:js)?|ts-node|tsx|deno|bun|perl|ruby|php`;
export const INTERPRETER_NAME = `(?:${INTERPRETER_NAMES})`;

/**
 * The FILE API each interpreter name reaches for. `node`, `bun`, `tsx` and
 * `ts-node` all evaluate the same `fs` calls, so they are one family; `deno`
 * ships a different surface under the same JavaScript.
 *
 * Every binary spelled in `INTERPRETER_NAMES` must appear here, which is what
 * makes adding a name to that string a red test rather than a silent gap — the
 * symmetry property parses the alternation and looks each token up.
 */
export type InterpreterFamily = 'python' | 'js' | 'deno' | 'perl' | 'ruby' | 'php';

export const INTERPRETER_FAMILY: Readonly<Record<string, InterpreterFamily>> = {
  python: 'python', python3: 'python',
  node: 'js', nodejs: 'js', 'ts-node': 'js', tsx: 'js', bun: 'js',
  deno: 'deno', perl: 'perl', ruby: 'ruby', php: 'php',
};

/** Every literal binary name `INTERPRETER_NAMES` accepts, expanded. */
export const INTERPRETER_BINARIES: readonly string[] = [
  'python', 'python3', 'node', 'nodejs', 'ts-node', 'tsx', 'deno', 'bun', 'perl', 'ruby', 'php',
];

/**
 * WHAT A COMMAND CAN DO TO A FILE, as opposed to what it can be CALLED.
 *
 * This is the axis round 2 got wrong. It said its vocabulary was "closed by
 * CLASS, not by spelling", and both class claims turned out to be spelling
 * lists one level up: the destructive-MODE class was anchored on the literal
 * `open`, so php's `fopen`, ruby's `File.new` and perl's 2-arg form were all
 * outside it, and the in-place FLAG class named two binaries out of five. A
 * rule that enumerates tokens can only forbid what somebody has already been
 * defeated by.
 *
 * So the vocabulary is a MATRIX: capability × interpreter family. Every cell is
 * either covered by a matcher below or declared unreachable in
 * `CAPABILITY_COVERAGE` with the reason. `__tests__/shell-vocabulary-symmetry
 * .test.ts` generates the cells from `INTERPRETER_NAMES` itself and fails on any
 * cell that is neither — so a capability covered for one language and not for
 * another is red BEFORE anyone is defeated by it, and adding an interpreter to
 * the name list reddens one cell per capability until each is answered.
 */
export type WriteCapability = 'delete' | 'truncate' | 'overwrite' | 'rename' | 'copy' | 'spawn';

export const WRITE_CAPABILITIES: readonly WriteCapability[] = [
  'delete', 'truncate', 'overwrite', 'rename', 'copy', 'spawn',
];

export interface EvalWriteFact {
  /** what it does to the file */
  capability: WriteCapability;
  /** the families this matcher answers for */
  families: readonly InterpreterFamily[];
  /** regex source recognising it inside an eval body */
  match: string;
  /** one real eval body per family, so a corpus can be GENERATED from the facts */
  samples: Partial<Record<InterpreterFamily, (path: string) => string>>;
  why: string;
}

/**
 * A destructive MODE, spelled every way the six families spell one.
 *
 * `\b[A-Za-z_]*open` rather than `\bopen` is the whole class fix: `fopen` is
 * php's file-write idiom and failed the word boundary, because `f` and `o` are
 * both word characters — the identical mechanism this vocabulary already
 * records for `unlinkSync`. `(?:\s*\(|\s+)` admits perl's paren-less
 * `open F, ">P"`. The mode may be ANY argument, not the one after the first
 * comma, which is what admits `Path(p).open('w')` (mode first) and
 * `open(p, mode='w')` (mode behind a keyword).
 *
 * The mode string must consist ENTIRELY of mode characters, which is what keeps
 * a path from being read as one: `open('/tmp/w.txt')` contains a `w` and is a
 * read. `\+?>{1,2}` is perl's, both 2-arg (`">$p"`, mode glued to the path) and
 * 3-arg (`'>'`).
 */
const DESTRUCTIVE_MODE_STRING = String.raw`['"](?:[rbtuU+]*[wax][rbtuU+]*|r\+[bt]*|\+?>{1,2}[^'"]*)['"]`;
const OPEN_FAMILY = String.raw`\b(?:[A-Za-z_]*open(?:Sync)?|File\.new|IO\.new)(?:\s*\(|\s+)[^)\n;]*`;

export const EVAL_WRITE_FACTS: readonly EvalWriteFact[] = [
  {
    capability: 'truncate',
    families: ['python', 'js', 'perl', 'ruby', 'php'],
    match: OPEN_FAMILY + DESTRUCTIVE_MODE_STRING,
    samples: {
      python: (p) => `open('${p}', mode='w')`,
      js: (p) => `require('fs').openSync('${p}','w')`,
      perl: (p) => `open(F, ">${p}")`,
      ruby: (p) => `File.new('${p}','w').close`,
      php: (p) => `fclose(fopen('${p}','w'));`,
    },
    why: 'opening for write/append/exclusive truncates or corrupts the record',
  },
  {
    capability: 'truncate',
    families: ['python', 'js', 'perl', 'ruby'],
    // `O_TRUNC`/`O_WRONLY` exist for one purpose, so the constant IS the fact
    // and no `open` anchor is needed — which is also what makes the numeric
    // form reachable at all: it carries no quoted mode to match.
    //
    // The `O_` PREFIX was the fact's own version of the `\bopen` defect it was
    // written to fix: ruby spells the identical flags `File::WRONLY|File::TRUNC`
    // and this fact claimed only python/js/perl, so
    // `ruby -e "File.open(p, File::WRONLY|File::TRUNC).close"` took a 30-byte
    // record to 0 bytes at gate `noop` while the shipped prose claimed "every
    // spelling … and the numeric `O_WRONLY|O_TRUNC`". php has no such constants
    // (it spells modes as `fopen` strings) and deno spells them as an options
    // object, which is why those two families are answered by their own facts
    // rather than added here.
    match: String.raw`\b(?:O_|File::|Fcntl::O_)(?:WRONLY|RDWR|TRUNC|CREAT|APPEND)\b`,
    samples: {
      python: (p) => `import os; os.close(os.open('${p}', os.O_WRONLY|os.O_TRUNC))`,
      js: (p) => `require('fs').openSync('${p}', require('fs').constants.O_WRONLY|require('fs').constants.O_TRUNC)`,
      perl: (p) => `use Fcntl; sysopen(F, "${p}", O_WRONLY|O_TRUNC)`,
      ruby: (p) => `File.open('${p}', File::WRONLY|File::TRUNC).close`,
    },
    why: 'the numeric open flags, which carry no quoted mode',
  },
  {
    capability: 'truncate',
    families: ['deno'],
    match: String.raw`\b(?:truncate|append|write|create)\s*:\s*true\b`,
    samples: { deno: (p) => `Deno.openSync('${p}', {write:true, truncate:true})` },
    why: 'deno spells the mode as an options object',
  },
  {
    capability: 'truncate',
    families: ['python', 'js', 'deno', 'perl', 'ruby', 'php'],
    match: String.raw`\b(?:f?truncate|ftruncate)(?:Sync)?\s*\(|\btruncate\s+(?:['"$@]|[A-Z])|\binplace\s*=\s*True\b`,
    samples: {
      python: (p) => `import os; os.truncate('${p}', 0)`,
      js: (p) => `require('fs').truncateSync('${p}', 0)`,
      deno: (p) => `Deno.truncateSync('${p}', 0)`,
      perl: (p) => `truncate "${p}", 0`,
      ruby: (p) => `File.truncate('${p}', 0)`,
      php: (p) => `ftruncate(fopen('${p}','r+'), 0);`,
    },
    why: 'truncating a record to zero bytes erases it as completely as unlinking it',
  },
  {
    capability: 'delete',
    families: ['python', 'js', 'perl', 'ruby', 'php'],
    match: String.raw`\bunlink(?:Sync)?\b|\brm(?:Sync|dirSync|dir)?\s*(?:\\?['"\x60]\s*\])?(?:\?\.)?[\s\\]*\(`,
    samples: {
      python: (p) => `import os; os.unlink('${p}')`,
      js: (p) => `require('fs').unlinkSync('${p}')`,
      perl: (p) => `unlink "${p}"`,
      ruby: (p) => `File.unlink('${p}')`,
      php: (p) => `unlink('${p}');`,
    },
    why: 'the plain deletion call',
  },
  {
    capability: 'delete',
    families: ['python', 'deno', 'ruby'],
    // `FileUtils\.(?:rm|remove|…)\b` could not match `rm_f` or `remove_file`,
    // because `_` is a word character — the `unlinkSync` mechanism one language
    // over. A PREFIX rule closes the family instead of the two members somebody
    // was defeated by: every destructive FileUtils method starts with one of
    // these stems, and the non-destructive ones (mkdir_p, cd, chmod, compare_file,
    // uptodate?) start with none of them.
    //
    // ROUND 4 NARROWED THIS TO DELETIONS. It used to carry the `mv`/`move`/`cp`/
    // `copy`/`install`/`ln`/`touch` stems and the whole `Deno` write family too,
    // so a rename and a copy were RECOGNISED — the union is what the detector
    // consults — but recognised as a DELETE. The `rename:ruby` and `copy:python`
    // cells therefore read as covered while resting on nothing but their own
    // `families` annotation: no matcher under those capabilities matched the
    // documented spelling. Same defect as (b), one column over, and it is what
    // the per-spelling claim property in the symmetry test found. The stems
    // moved to the capability they actually perform; the union is unchanged, so
    // no command changed verdict.
    match: String.raw`\bFileUtils\.(?:rm|remove)\w*`
      + String.raw`|\bshutil\.rmtree\b`
      + String.raw`|\b(?:File|Dir|Pathname|IO)\.(?:delete|unlink)\b`
      + String.raw`|\bDeno\.remove`
      + String.raw`|\bos\.remove\s*\(`
      + String.raw`|\brmtree\s*\(|\bremove_tree\b`,
    samples: {
      python: (p) => `import shutil; shutil.rmtree('${p}')`,
      deno: (p) => `Deno.removeSync('${p}')`,
      ruby: (p) => `require 'fileutils'; FileUtils.rm_f('${p}')`,
    },
    why: "each runtime's library deletion family, matched by STEM so a suffix cannot escape",
  },
  {
    capability: 'delete',
    families: ['perl', 'php'],
    match: String.raw`\bremove_tree\b|\brmdir\s*[('"$@]`,
    samples: {
      perl: (p) => `use File::Path qw(remove_tree); remove_tree("${p}")`,
      php: (p) => `rmdir('${p}');`,
    },
    why: 'the directory-removal spelling in the two languages without a FileUtils',
  },
  {
    capability: 'overwrite',
    families: ['python', 'js', 'deno', 'perl', 'ruby', 'php'],
    // `write_file`/`spew` are perl's, and they are here because the exemption
    // that used to stand in their place was FALSE. It read: "perl writes
    // through a filehandle obtained from `open`, and the handle carries no
    // path: the destructive-MODE fact answers at the `open`, which is the only
    // place the path appears." Both `File::Slurp::write_file("<p>","")` and
    // `Path::Tiny::path("<p>")->spew_utf8("")` name the path and open nothing,
    // and both took a 30-byte record to 0 bytes at gate `noop`.
    //
    // The property advertised as catching a bad exemption could not: it asked
    // whether a matcher CLAIMED the cell, by reading the hand-written `families`
    // annotation, so it detects an exemption that is redundant and is blind to
    // one that is wrong. That is fixed on the other side — see the
    // documented-spelling property in the symmetry test, which drives real
    // spellings through the matcher instead of reading its annotations.
    match: String.raw`\bwrite(?:File|FileSync|TextFile|TextFileSync)\s*\(`
      + String.raw`|\bappendFile|\bcreateWriteStream`
      + String.raw`|(?<!stdout)(?<!stderr)\.write(?:_text|_bytes)?\s*\(`
      + String.raw`|\b(?:File|IO)\.(?:write|binwrite)\b`
      + String.raw`|\b(?:file_put_contents|fwrite|fputs)\s*\(`
      + String.raw`|\b(?:write_file|append_file|spew(?:_utf8|_raw)?)\s*[('"$@]`
      // moved here from the `delete` fact: deno's write/create family and
      // ruby's `FileUtils.touch` overwrite or create a record, they do not
      // delete one.
      + String.raw`|\bDeno\.(?:writeTextFile|writeFile|truncate|create)`
      + String.raw`|\bFileUtils\.touch\w*`,
    samples: {
      python: (p) => `from pathlib import Path; Path('${p}').write_text('')`,
      js: (p) => `require('fs').writeFileSync('${p}','')`,
      deno: (p) => `Deno.writeTextFileSync('${p}','')`,
      perl: (p) => `use File::Slurp; write_file("${p}", "")`,
      ruby: (p) => `File.write('${p}','')`,
      php: (p) => `file_put_contents('${p}','');`,
    },
    why: 'writing content over a record corrupts it exactly as erasing it does',
  },
  {
    capability: 'rename',
    families: ['python', 'js', 'deno', 'perl', 'ruby', 'php'],
    match: String.raw`\brename(?:s|Sync)?\s*(?:\\?['"\x60]\s*\])?(?:\?\.)?[\s\\]*[('"$@]`
      + String.raw`|\brename\s+(?:['"$@]|[A-Z])`
      + String.raw`|\bPath(?:lib)?\s*\([^)]*\)\s*\.\s*(?:replace|rename)\b`
      + String.raw`|\bFile\.rename\b`
      // moved here from the `delete` fact, which recognised a rename and called
      // it a deletion. `os.replace` is python's documented silent-overwrite
      // rename, and `os.renames` its recursive one — the spelling the peer
      // ground-truthed as taking the record away entirely.
      + String.raw`|\bFileUtils\.(?:mv|move)\w*`
      + String.raw`|\bshutil\.move\b`
      + String.raw`|\bDeno\.rename`
      + String.raw`|\bos\.replace\s*\(`,
    samples: {
      python: (p) => `from pathlib import Path; Path('/dev/null').replace('${p}')`,
      js: (p) => `require('fs').renameSync('/dev/null','${p}')`,
      deno: (p) => `Deno.renameSync('/dev/null','${p}')`,
      perl: (p) => `rename "/dev/null", "${p}"`,
      ruby: (p) => `File.rename('/dev/null','${p}')`,
      php: (p) => `rename('/dev/null','${p}');`,
    },
    why: 'renaming ONTO a path replaces it; renaming it AWAY removes it',
  },
  {
    capability: 'copy',
    families: ['python', 'js', 'deno', 'perl', 'ruby', 'php'],
    match: String.raw`\bcopy(?:2|File|file|_file|_entry|_stream|tree|fileobj)?(?:Sync)?\s*\(|\bcp(?:Sync)?\s*\(`
      // moved here from the `delete` fact for the same reason as the renames
      // above: a copy over a record was recognised, and attributed to deletion.
      + String.raw`|\bFileUtils\.(?:cp|copy|install|ln)\w*`
      + String.raw`|\bshutil\.(?:copy|copy2|copyfile|copytree|copyfileobj|unpack_archive)\b`
      + String.raw`|\bDeno\.copyFile`,
    samples: {
      python: (p) => `import shutil; shutil.copyfile('/dev/null','${p}')`,
      js: (p) => `require('fs').copyFileSync('/dev/null','${p}')`,
      deno: (p) => `Deno.copyFileSync('/dev/null','${p}')`,
      perl: (p) => `use File::Copy; copy("/dev/null","${p}")`,
      ruby: (p) => `require 'fileutils'; FileUtils.copy('/dev/null','${p}')`,
      php: (p) => `copy('/dev/null','${p}');`,
    },
    why: 'copying over a runtime-authored record loses it as completely as deleting it',
  },
  {
    capability: 'spawn',
    families: ['python', 'js', 'deno', 'perl', 'ruby', 'php'],
    // A spawned process is opaque to every path check in this file, so it counts
    // as a write. `(?<![.\w])` keeps `/re/.exec(s)` and `child_process.exec`
    // from double-counting as the bare form — the module handle is matched on
    // its own, which is what covers the async spellings.
    match: String.raw`\bchild_process\b|\bsubprocess\b|\bDeno\.(?:run|Command)\b`
      + String.raw`|\b(?:execSync|spawnSync|execFileSync|popen|Popen)\s*\(`
      + String.raw`|\bos\.(?:system|popen)\s*\(`
      + String.raw`|(?<![.\w])(?:system|exec|shell_exec|passthru|proc_open|spawn)\s*[('"\x60]`,
    samples: {
      python: (p) => `import os; os.system('rm -f ${p}')`,
      js: (p) => `require('child_process').execSync('rm -f ${p}')`,
      deno: (p) => `new Deno.Command('rm', {args:['-f','${p}']}).outputSync()`,
      perl: (p) => `system("rm -f ${p}")`,
      ruby: (p) => `system('rm -f ${p}')`,
      php: (p) => `shell_exec('rm -f ${p}');`,
    },
    why: 'a spawned process performs a write no path check in this file can see',
  },
];

/**
 * Capability × family cells that no matcher answers, each with the reason it
 * needs none. An empty reason is a failure, not a pass — see the symmetry test.
 */
export const CAPABILITY_COVERAGE: Readonly<Record<string, string>> = {};

/** The union of every capability matcher, as one regex source. */
export const EVAL_WRITE_MATCH_SOURCE = EVAL_WRITE_FACTS.map((fact) => fact.match).join('|');

// ─────────────────────────────────────────────────────────────────────────────
// THE READ ALLOWLIST, AND WHY EVERYTHING ABOVE IS NO LONGER WHAT PROTECTS A
// RUNTIME-OWNED PATH.
//
// Everything above answers "do I recognise this destructive verb?". Three
// rounds of this fence have now shipped that shape under three different
// descriptions — a verb alternation, then a class, then a capability × family
// matrix — and a peer has defeated each one the same way, by spelling the
// destruction some other documented way. The matrix was the best of the three
// and it still failed for a structural reason rather than a careless one: its
// cells are capability × FAMILY, so `truncate:ruby` reads as covered through
// the quoted-mode fact and no property it can express is able to ask whether
// ruby's NUMERIC truncate is covered. It was not. `overwrite:php` read as
// covered through `file_put_contents`, so nothing asked about `SplFileObject`.
// A cell was proven to have one spelling and assumed to have all of them.
//
// The escape is not a finer matrix. `reset-record-shell.ts` has been immune to
// this entire class since it shipped, and its header says why in one sentence:
// it asks "is this path named by anything that is not a READ?" instead of "do I
// recognise this verb?". A denylist of verbs is fail-OPEN by construction and
// can only ever refuse what somebody has already been defeated by; an allowlist
// of reads is fail-CLOSED, and a destruction nobody has thought of yet is
// refused because it is not a read, not admitted because it is not on a list.
//
// WHAT IT COSTS AND WHY THAT PRICE IS PAYABLE HERE. An allowlist inversion
// applied to the whole command population is wrong, and this repository has
// already measured it wrong once: it refuses `python3 -c 'import pytest'`,
// `shutil.which('go')`, `node -e "require('./dist/...')"` — the toolchain probes
// `test:env --strict` runs. Every one of those names NO Traffic One path, and
// this predicate is only ever asked about a path literal a caller has already
// found. The population it can refuse is therefore not "developer commands" but
// "an interpreter eval body that spells a `.traffic-one` path", which is a
// population whose legitimate members are reads and nothing else. That is the
// same argument `reset-record-shell.ts` makes for one path, and it survives
// being widened to this one because the anchor widens with it.
//
// So the maintained list is the READ list, and its failure mode inverted with
// it: a read spelling nobody thought of is REFUSED — visible, cheap, and
// reported by whoever hits it — rather than a destruction nobody thought of
// being permitted, which is invisible until a peer spells it. The property that
// pins this is not a row count. It is that a verb which could not be on any
// list at all is refused: see `an invented verb no author could have listed`
// in `__tests__/shell-vocabulary-symmetry.test.ts`. No enumeration passes that
// row; only construction does.

/**
 * Calls whose PATH ARGUMENT is read. Matched on the dotted callee or its
 * trailing member, so `os.path.exists`, `fs.existsSync` and a bare
 * `existsSync` are one entry.
 *
 * THE MATCH IS LANGUAGE-AGNOSTIC ON PURPOSE and a peer named it as a hidden
 * cost: an entry authored for one family admits the same word in every other,
 * so python's `glob.glob` also admits a bare `glob(` in node, where the name
 * belongs to a different package. Under the statement rule that is a widening of
 * ADMISSION only — whatever the admitted call feeds is a second call in the same
 * statement and is judged on its own — so what it buys is fewer false refusals
 * across families and what it risks is bounded by each entry's own semantics,
 * exactly as the paragraph below says. Priced at the gate rather than argued: on
 * the peer's 23-row ordinary-work corpus the statement rule refuses one row
 * (`o-argv-read`, disclosed), and on the 36-row destruction corpus it denies
 * 31, up from 20 under the nest walk.
 *
 * DELIBERATELY GENEROUS, AND THE STATEMENT RULE IS WHAT MAKES THAT FREE. Two
 * earlier versions of this comment claimed the same freedom on a narrower rule
 * and were false, in the same shape twice:
 *
 *   - Round 4 judged only the INNERMOST call, so every name here was a bypass
 *     primitive: `zipfile.ZipFile(str('<sidecar>'),'w')` resolved to `str`.
 *   - Round 5 judged every call ENCLOSING the occurrence and wrote that an
 *     entry "can no longer admit a destruction SOMEWHERE ELSE in the same
 *     expression". A peer falsified that by putting the destruction in SIBLING
 *     position rather than ancestor position:
 *     `list(map(lambda f: zipfile.ZipFile(f,'w'), ['<sidecar>']))` — the
 *     occurrence's ancestors are `map` and `list`, both on this list, and the
 *     `ZipFile` beside them was never judged. Removing only `list`, `map` and
 *     `sorted` from this list flipped two ground-truthed rows from `noop` to
 *     `deny`, which is the measurement that proves the entries were security
 *     decisions while the docblock said they were not.
 *
 * `occurrenceIsRead` now judges EVERY CALL IN THE STATEMENT, not a path through
 * it, so ancestor and sibling are the same case and there is no third position
 * to move a destruction into. THE PROPERTY THIS LIST NOW HAS, stated as what
 * the code does rather than as what would be convenient: an entry here cannot
 * admit a destruction anywhere in the statement that spells the path, because
 * that destruction is its own call and is judged on its own. What an entry here
 * CAN still do is admit a call that destroys the path ITSELF — adding `ZipFile`
 * would permit `ZipFile(p,'w')` — and that is a property of the single entry,
 * checkable when it is added, pinned by the `ZipFile` and `join` mutants.
 *
 * So the risk an addition carries is bounded by the entry's own semantics
 * instead of by the shape of the expression around it, and that is what makes
 * widening for cost affordable. `path arithmetic is a read, and a destruction
 * reached THROUGH it is not` and `a read entry does not launder a destruction
 * BESIDE the occurrence` in `__tests__/shell-vocabulary-symmetry.test.ts` pin
 * both halves, the second one with its cost rows in the same test.
 */
const READ_CALL_HEADS: ReadonlySet<string> = new Set([
  // node / bun / ts-node
  'readFileSync', 'readFile', 'createReadStream', 'existsSync', 'exists',
  'statSync', 'stat', 'lstatSync', 'lstat', 'readdirSync', 'readdir',
  'realpathSync', 'realpath', 'accessSync', 'access', 'readlinkSync', 'require',
  'fstatSync', 'fstat', 'readSync', 'read', 'opendirSync', 'opendir',
  'statfsSync', 'globSync', 'glob', 'openAsBlob', 'close', 'closeSync',
  'fileURLToPath', 'pathToFileURL', 'createRequire',
  // deno
  'Deno.readTextFileSync', 'Deno.readTextFile', 'Deno.readFileSync', 'Deno.readFile',
  'Deno.statSync', 'Deno.stat', 'Deno.lstatSync', 'Deno.lstat', 'Deno.readDirSync',
  'Deno.readDir', 'Deno.realPathSync', 'Deno.realPath', 'Deno.readLinkSync', 'Deno.readLink',
  // python
  'os.path.exists', 'os.path.isfile', 'os.path.isdir', 'os.path.getsize',
  'os.path.getmtime', 'os.path.abspath', 'os.path.realpath', 'os.path.basename',
  'os.path.dirname', 'os.stat', 'os.listdir', 'os.access', 'os.scandir',
  'getsize', 'getmtime', 'isfile', 'isdir', 'listdir', 'scandir',
  'os.fstat', 'os.lstat', 'os.readlink', 'os.fspath', 'os.walk',
  'os.path.islink', 'os.path.lexists', 'os.path.getctime', 'os.path.getatime',
  'os.path.splitext', 'os.path.split', 'os.path.normpath', 'os.path.relpath',
  'os.path.expanduser', 'os.path.expandvars', 'os.path.commonpath', 'os.path.samefile',
  'islink', 'lexists', 'getctime', 'getatime', 'splitext', 'normpath', 'relpath',
  'expanduser', 'samefile', 'fspath', 'os.close',
  'glob.glob', 'glob.iglob', 'iglob', 'linecache.getline',
  // ruby
  'File.read', 'File.readlines', 'File.binread', 'File.exist?', 'File.exists?',
  'File.file?', 'File.size', 'File.size?', 'File.mtime', 'File.stat', 'File.basename',
  'File.dirname', 'File.expand_path', 'IO.read', 'IO.readlines', 'IO.binread',
  'Dir.glob', 'Dir.entries', 'Dir.children',
  'File.foreach', 'File.zero?', 'File.empty?', 'File.readable?', 'File.writable?',
  'File.executable?', 'File.directory?', 'File.ftype', 'File.identical?', 'File.join',
  'File.extname', 'File.split', 'File.absolute_path', 'File.realpath', 'File.lstat',
  'File.ctime', 'File.atime', 'File.birthtime', 'IO.foreach', 'IO.sysread',
  'Dir.exist?', 'Dir.each_child', 'Dir.empty?', 'Digest::MD5.hexdigest', 'Digest::SHA256.hexdigest',
  // perl
  'read_file', 'stat', 'slurp', 'read_lines', 'read_dir',
  // php
  'file_get_contents', 'file_exists', 'is_file', 'is_dir', 'is_readable',
  'filesize', 'filemtime', 'readfile', 'realpath', 'fgets', 'fread',
  'fclose', 'feof', 'ftell', 'fseek', 'rewind', 'fgetc', 'fgetcsv', 'fscanf',
  'file', 'pathinfo', 'basename', 'dirname', 'filetype', 'fileatime', 'filectime',
  'fileinode', 'fileowner', 'fileperms', 'is_link', 'is_writable', 'is_executable',
  'md5_file', 'sha1_file', 'hash_file', 'mime_content_type', 'scandir', 'opendir',
  // PATH ARITHMETIC. These build or shorten a path and touch no bytes. `join`
  // is the one a peer proved harmless-once-the-nest-is-judged rather than
  // harmless-by-assumption: added to this list while only the innermost call
  // was consulted, it reopened `zipfile.ZipFile(os.path.join(RUN,'run.json'),'w')`
  // at gate `noop` and survived the whole suite. With the enclosing `ZipFile`
  // judged, the same widening changes no verdict, and BOTH halves are pinned:
  // `path arithmetic is a read, and a destruction reached THROUGH it is not` in
  // `__tests__/shell-vocabulary-symmetry.test.ts`.
  'os.path.join', 'path.join', 'path.resolve', 'path.basename', 'path.dirname',
  'path.extname', 'path.relative', 'path.normalize', 'path.parse', 'path.format',
  'join', 'resolve', 'extname', 'relative', 'normalize', 'expand_path',
  // Printing a path is not writing to it.
  //
  // THE COMMENT THAT USED TO BE HERE ARGUED THE WRONG NESTING ORDER, and the
  // argument was true. It said the resolved site is the INNERMOST call, so in
  // `console.log(require('fs').unlinkSync(p))` the site is `unlinkSync` and
  // only a literal handed DIRECTLY to a printer resolves here. Both halves
  // hold — and they are about the order where the DESTRUCTIVE head is
  // innermost. The order that was never considered is the mirror image: the
  // READ head takes the literal and the write encloses it
  // (`ZipFile(str(p),'w')`), where the innermost site is the printer and the
  // destruction is one level out. One order was analysed; the other was the
  // defect. The rule now covers both because it is about the whole NEST rather
  // than about a position in it: every enclosing call must be a read.
  'console.log', 'console.error', 'console.warn', 'console.info', 'console.debug',
  'console.dir', 'console.trace', 'log', 'p', 'pp',
  // The STREAM spellings of the same thing. These are matched as whole dotted
  // heads and the member-only fallback cannot reach them, so `write` never
  // becomes a permitted head: `File.open(p).write(x)` is judged by the chain
  // (`READ_MEMBERS`, which excludes `write`) and stays refused. Measured as a
  // false refusal this round — `sys.stdout.write(open(<sidecar>).read())` was
  // permitted while only the innermost call was judged and refused once the
  // nest was, which is the class of cost P1 was expected to create.
  'sys.stdout.write', 'sys.stderr.write', 'process.stdout.write', 'process.stderr.write',
  'STDOUT.write', 'STDERR.write', 'STDOUT.puts', 'STDERR.puts',
  '$stdout.write', '$stderr.write', '$stdout.puts', '$stderr.puts',
  'print', 'println', 'puts', 'printf', 'sprintf', 'String', 'str',
  'JSON.parse', 'JSON.stringify', 'json.loads', 'json.dumps', 'json.load',
  'load', 'yaml.safe_load', 'yaml.load', 'YAML.load_file', 'csv.reader', 'tomllib.load',
  // PURE COMPUTATION OVER A VALUE THAT HAS ALREADY BEEN READ, and the class the
  // nest walk made necessary rather than optional: `print(len(open(p).read()))`
  // has THREE enclosing calls, and `len` not being here would refuse an
  // ordinary read. A missing entry costs a false refusal — the direction this
  // module accepts being wrong in — and none of these can reach a filesystem.
  'len', 'int', 'float', 'bool', 'list', 'tuple', 'set', 'dict', 'sorted', 'sum',
  'min', 'max', 'any', 'all', 'enumerate', 'repr', 'type', 'hash', 'bytes',
  'bytearray', 'next', 'iter', 'zip', 'map', 'filter', 'reversed', 'round', 'abs',
  'format', 'Number', 'Boolean', 'Array', 'Object.keys', 'Object.values',
  'Object.entries', 'parseInt', 'parseFloat', 'Buffer.from', 'TextDecoder',
  'encodeURIComponent', 'md5', 'sha1', 'sha256', 'hashlib.md5', 'hashlib.sha1',
  'hashlib.sha256', 'Integer', 'Float', 'Hash', 'Marshal.load', 'inspect',
]);

/**
 * Parenthesised language KEYWORDS, which are not calls at all: the paren is
 * grouping. `if (existsSync(p)) …` and `return (path.join(p))` put a read
 * inside one, and the enclosing-nest walk would otherwise resolve a head of
 * `if`/`return`, find it on no list, and refuse an ordinary read.
 */
const GROUPING_HEADS: ReadonlySet<string> = new Set([
  'if', 'elif', 'elsif', 'else', 'while', 'until', 'unless', 'for', 'foreach',
  'switch', 'case', 'when', 'return', 'yield', 'assert', 'not', 'and', 'or',
  'in', 'typeof', 'defined',
  // `echo` is deliberately ABSENT, and not because it prints: it is the
  // left-hand side of `> <path>` and of `echo "<code>" | node`, and the
  // standing ruling that `echo "read <sidecar>"` stays refused is a ruling
  // about the SHELL verb (`SHELL_READ_VERBS`). Admitting it as a paren head
  // here would not reach that judgement, and putting it here anyway would read
  // as re-litigating it.
]);

/** Constructors that merely NAME a path. Harmless alone; what the chain after
 *  them does decides it — `Pathname.new(p).read` is a read and
 *  `Pathname.new(p).delete` is the single token that survived round 3's whole
 *  suite as a mutant. */
const PATH_CONSTRUCTOR_HEADS: ReadonlySet<string> = new Set([
  'Path', 'PurePath', 'PosixPath', 'pathlib.Path', 'Pathname.new', 'Pathname',
  'path', 'file', 'File.new_for_path',
]);

/** Heads that take an OPEN MODE, so the mode argument decides them. Spelled
 *  every way the six families spell one — but note that being ABSENT from this
 *  set is not an escape: an unrecognised head is a write. */
const OPEN_MODE_HEADS: ReadonlySet<string> = new Set([
  'open', 'openSync', 'fopen', 'io.open', 'os.open', 'os.fdopen',
  'File.open', 'File.new', 'IO.new', 'IO.open', 'IO.sysopen', 'sysopen',
  'Deno.open', 'Deno.openSync', 'SplFileObject', 'SplFileInfo', 'fs.openSync',
]);

/**
 * A mode argument that names a READ. AN ALLOWLIST, which is the round-5 fix.
 *
 * What stood here was `DESTRUCTIVE_OPEN_ARGUMENT_RE`, a denylist of destructive
 * modes — literally `INLINE_MUTATION_RE`'s shape surviving inside the function
 * that replaced it. A mode it did not recognise fell through to "this
 * occurrence is a read", and four ground-truthed erasures used that with no
 * wrapper at all: a mode bound to a variable (`m='w'; open(p, m)`) in python,
 * node and ruby, and `os.close(os.open(p, 1|512|1024))` — `O_WRONLY|O_CREAT|
 * O_TRUNC` written numerically, which is not merely unlisted but UNLISTABLE by
 * symbol matching. Being unlistable is the exact property the inversion was
 * adopted to obtain, so the mode branch was the one place still failing open by
 * construction.
 *
 * Inverted, a computed or unrecognised mode refuses, and the vocabulary that
 * has to be complete is the READ one: `'r'`, `'rb'`, `'rt'`, ruby's `'r:UTF-8'`,
 * perl's `'<'` and `'<:encoding(UTF-8)'`, `O_RDONLY` under every scope prefix,
 * deno's `{read:true}`, and an ABSENT mode where every family in
 * `OPEN_MODE_HEADS` defaults to read (or raises, which destroys nothing).
 */
const READ_MODE_STRING_RE = /^['"](?:<|[rbtU]+|[rbtU]+:[\w:().+-]*|<:[\w:().+-]*)['"]$/;
const READ_MODE_CONSTANT_RE = /^(?:[A-Za-z_$][\w$]*(?:\.|::)){0,3}(?:O_)?RDONLY$/;
/** Argument NAMES that carry the mode, so their value must be a read mode.
 *  Any other named argument (`encoding=`, `newline=`, `buffering=`) cannot be
 *  the mode and is accepted without reading its value. */
const MODE_ARGUMENT_NAMES: ReadonlySet<string> = new Set(['mode', 'flag', 'flags', 'access', 'perm']);
/** deno spells the mode as an options object; these are the keys a read may
 *  carry. `write`, `append`, `truncate`, `create` and `createNew` are absent,
 *  which is what makes an unrecognised key refuse. */
const READ_OPTION_KEYS: ReadonlySet<string> = new Set(['read', 'encoding']);
/** What may sit between an opening quote and the path in the SAME quoted run:
 *  perl's 2-arg `open(F, "<$p")` glues the mode to the path, so that argument
 *  carries the path AND the mode. `>`/`>>` cannot appear here — the path
 *  extractors exclude both from a path literal — so an unrecognised prefix is
 *  refused rather than parsed. */
const GLUED_READ_MODE_RE = /^<?(?::[\w:().+-]*)?$/;

/**
 * Members that may follow a path-bearing call and keep it a read.
 *
 * A missing entry costs a false refusal, which is the direction this module
 * accepts being wrong in — and round 5 paid twelve of them, in a shape that was
 * arbitrary rather than principled: `.read()` was permitted and
 * `.read().decode()` refused, `os.path.getsize` permitted and
 * `os.stat().st_size` refused, ruby's `File.stat().size` permitted and node's
 * `statSync().mtimeMs` refused. A maintainer cannot predict which of two
 * equivalent spellings is allowed, and every discovery of one invites widening
 * the list in the direction that used to be dangerous. So the stat fields, the
 * byte/string conversions and the collection folds are all here now.
 *
 * WHAT MAY NEVER BE ADDED, because the member decides the whole chain: `write`,
 * `write_text`, `unlink`, `delete`, `rename`, `replace` (python's documented
 * silent-overwrite rename), `truncate`, `open` (`Path(p).open('w')` is a
 * truncation whose mode this list cannot see), `binwrite`, `spew`, `flush`,
 * `chmod`, `symlink`, `mkdir`, `rmtree`. Each of those is a destruction of the
 * path the chain started from, and no nest walk one level out can help: the
 * write IS the chain.
 */
const READ_MEMBERS: ReadonlySet<string> = new Set([
  'read', 'read_text', 'read_bytes', 'readlines', 'read_lines', 'readline',
  'readlink', 'each_line', 'each_char', 'lines', 'slurp', 'slurp_utf8', 'slurp_raw',
  'binread', 'getline', 'gets', 'close', 'closed?',
  'exists', 'exists?', 'exist?', 'is_file', 'is_dir', 'file?', 'directory?',
  'isFile', 'isDirectory', 'size', 'size?', 'stat', 'lstat', 'mtime', 'ctime',
  'basename', 'dirname', 'parent', 'name', 'stem', 'suffix', 'to_s', 'to_str',
  'to_path', 'toString', 'absolute', 'realpath', 'expand_path', 'resolve',
  'utf8', 'toJSON', 'trim', 'strip', 'chomp', 'split', 'length', 'count',
  'first', 'last', 'each', 'map', 'select', 'join', 'keys', 'values',
  // the stat structures, in all three spellings of the same fields
  'st_size', 'st_mtime', 'st_mtime_ns', 'st_ctime', 'st_atime', 'st_mode',
  'st_nlink', 'st_ino', 'st_dev', 'st_uid', 'st_gid', 'st_birthtime',
  'mtimeMs', 'ctimeMs', 'atimeMs', 'birthtimeMs', 'atime', 'birthtime',
  'blocks', 'blksize', 'mode', 'nlink', 'ino', 'dev', 'uid', 'gid',
  'isSymbolicLink', 'isBlockDevice', 'isCharacterDevice', 'isFIFO', 'isSocket',
  // bytes ⇄ text, and the ordinary string tail of a read
  'decode', 'encode', 'force_encoding', 'valid_encoding?', 'splitlines',
  'lstrip', 'rstrip', 'chars', 'bytes', 'unpack', 'unpack1', 'hexdigest', 'digest',
  'to_i', 'to_f', 'to_a', 'to_h', 'to_sym', 'to_json', 'inspect', 'json',
  'startsWith', 'endsWith', 'start_with?', 'end_with?', 'match', 'match?', 'scan',
  'toLowerCase', 'toUpperCase', 'upcase', 'downcase', 'trimEnd', 'trimStart',
  'substring', 'substr', 'slice', 'indexOf', 'includes', 'include?', 'at',
  // folds over what was read
  'filter', 'reduce', 'flatMap', 'find', 'findIndex', 'sort', 'sort_by', 'uniq',
  'reverse', 'sum', 'min', 'max', 'entries', 'empty?', 'nil?', 'any?', 'all?',
  'each_with_index', 'each_byte', 'each_with_object', 'group_by', 'tally',
  // handle inspection that touches no bytes. `fileno` is safe for the same
  // reason the widening above is: whatever CONSUMES the descriptor is a call
  // enclosing this one, and the walk judges it.
  'fileno', 'tell', 'seek', 'rewind', 'eof?', 'eof', 'readable', 'readable?',
  'external_encoding', 'binmode',
  // pathlib/Pathname shape, which returns a new path and touches nothing
  'parts', 'parents', 'suffixes', 'with_suffix', 'with_name', 'as_posix',
  'relative_to', 'sub_ext', 'each_filename', 'ascend', 'children', 'glob',
]);

/**
 * How many call sites one statement may hold before this judgement gives up.
 *
 * The bound exists because the input is attacker-shaped, and it REPLACES two
 * bounds the enclosing-nest walk needed and that a peer measured as
 * mis-documented: a backward `CALL_SCAN_BOUND` of 600 characters (which also
 * refused a READ padded past it — a priced over-refusal that is simply gone
 * now, because nothing scans backwards) and a `MAX_CALL_NEST` of 12 that bit a
 * read at observable depth 10, because `print(` and the member chain consumed
 * levels the comment did not count. A count of CALLS is the quantity the rule
 * actually spends, so the documented number and the observable number are the
 * same number. Exceeding it is UNRESOLVED, which refuses.
 */
const MAX_CALL_SITES = 200;

const HEAD_CHARACTER_RE = /[\w.:$]/;

/**
 * Statement separators, honoured OUTSIDE a quoted run and at bracket depth 0.
 *
 * QUOTE-AWARENESS IS THE ROUND-6 FIX AND IT IS LOAD-BEARING IN BOTH DIRECTIONS.
 * Round 5 dropped quote tracking here with the argument that "what a string
 * reaches the filesystem THROUGH is a call, and the walk judges every call".
 * A peer falsified it by putting a separator INSIDE a string:
 *
 *     python3 -c "import zipfile; zipfile.ZipFile('; cat x'[0:0] + '<p>','w')"
 *
 * `'; cat x'[0:0]` is the empty string, so the path is unchanged and the file is
 * erased. The quoted `;` ended the backward hunt before it could reach the
 * `ZipFile`, the decision fell to the shell-verb fallback, and the fallback read
 * its verb — `cat` — out of the middle of a Python string literal. Measured:
 * `noop` at the gate, 54 bytes to 22 on disk.
 *
 * A quoted separator no longer splits, so the statement runs through to the
 * `ZipFile` and the call is judged. The reads round 5 dropped this for are
 * unaffected, because they are decided by the enclosing CALL and not by a
 * boundary: perl's `open(my $fh, "<", "<p>")` and `print('a', '<p>')` both have
 * a closing quote between the path and the callee, and neither has a separator.
 *
 * Bracket depth is tracked for the same reason in the other direction:
 * `os.open(p, 1|512|1024)` spells a `|` that is bitwise-or, not a pipe.
 */
const STATEMENT_SEPARATORS = new Set(['\n', ';', '|', '&']);

/**
 * What may precede a `(` whose callee this scan could not read, for it to be a
 * GROUPING paren rather than a call it failed to identify.
 *
 * The distinction decides a bypass. `require('fs')['unlinkSync']('<p>')` and
 * `require('fs').rmSync?.('<p>')` both put the path inside a call with no
 * readable callee, and treating those as grouping would let the surrounding
 * reads (`require`) decide the statement. So an unreadable callee preceded by
 * `]`, `)`, `?` or a quote is OPAQUE and refuses, while one preceded by an
 * operator, a separator or the start of the text is the grouping paren of
 * `(open(p).read())` and decides nothing.
 *
 * THIS IS A FACT ABOUT EXPRESSION GRAMMARS AND ABOUT NOTHING ELSE, said here
 * because leaving it unsaid cost a blocker. In an expression a leading `(`
 * groups a sub-expression; in a SHELL COMMAND LINE the identical character
 * opens a SUBSHELL whose body is a command list, which is a different grammar
 * with a different judgement. `occurrenceIsRead` consulted this set for both,
 * so `(rm -rf .traffic-one/runs)` was one grouping site spanning the whole
 * statement, every site was skipped, and the function returned "read" for a
 * command that deletes every sidecar of every run — at gate `noop`,
 * ground-truthed.
 *
 * WHERE IT IS CONSULTED: `callSitesIn`, over text that has already been
 * reduced to a SIMPLE COMMAND by `shellReadPieces`, which re-enters a subshell
 * or a brace group as its own command list before any of this runs. So by the
 * time a `(` reaches here it cannot be a subshell opener. WHERE IT IS NOT
 * CONSULTED: the shell grammar itself — see `shellStatementHead` and
 * `withGroupingRe-entered`, which own that side.
 */
const EXPRESSION_START_CHARS = new Set([
  '(', '[', '{', ',', '=', ':', ';', '&', '|', '!', '+', '-', '*', '/', '%',
  '^', '~', '<', '>', '\n',
]);

interface PathCallSite {
  /** the dotted callee, e.g. `os.path.exists`; empty when unreadable */
  head: string;
  /** the callee's trailing member, e.g. `exists` */
  member: string;
  /** the call is a MEMBER call on the value beside it (`open(p).read()`,
   *  `path(p)->slurp`), so the chain vocabulary answers for it too */
  memberCall: boolean;
  /** the callee could not be read and the paren is not grouping: refuses */
  opaque: boolean;
  /** the paren groups rather than calls: decides nothing */
  grouping: boolean;
  /** members chained after the call, e.g. `['read']` for `open(p).read()` */
  chain: string[];
  /** first index of the argument text */
  argsStart: number;
  /** one past the last index of the argument text */
  argsEnd: number;
}

/**
 * The bounds of the statement containing `[found,end)`.
 *
 * A statement rather than an expression, because the unit of judgement is what
 * BLOCKER 1 of round 5's review turned on: judging the path through its
 * enclosing calls leaves every OTHER call in the same expression unjudged, and
 * a destruction only has to sit beside the occurrence instead of above it.
 */
function statementBounds(text: string, found: number, end: number): { start: number; stop: number } {
  let start = 0;
  let stop = text.length;
  let quote = '';
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote) {
      if (character === '\\' && quote === '"') { index += 1; continue; }
      if (character === quote) quote = '';
      continue;
    }
    // `find … -exec cat {} \;` escapes the separator so the SHELL does not eat
    // it, and reading it as one splits a permitted read-only sweep in half.
    if (character === '\\') { index += 1; continue; }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
    if (character === '(' || character === '[' || character === '{') { depth += 1; continue; }
    if (character === ')' || character === ']' || character === '}') { depth -= 1; continue; }
    if (depth > 0 || !STATEMENT_SEPARATORS.has(character)) continue;
    if (index < found) { start = index + 1; continue; }
    if (index >= end) { stop = index; break; }
  }
  return { start, stop };
}

/**
 * Every call site in `[from,to)`, or null when there are more than the bound.
 *
 * QUOTE-TRANSPARENT on purpose: the code this has to read is nearly always
 * inside a shell quote (`python3 -c "…"`), so a scan that skipped quoted runs
 * would see no calls at all in the population that matters most. The cost is
 * that a paren inside a string literal (`os.unlink(')'[0:0] + '<p>')`) desyncs
 * the depth counter — which can only mis-assign which site CARRIES the path,
 * never remove a site from the set, and the set is what the judgement is over.
 */
function callSitesIn(text: string, from: number, to: number): PathCallSite[] | null {
  const sites: PathCallSite[] = [];
  for (let index = from; index < to; index += 1) {
    if (text[index] !== '(') continue;
    if (sites.length >= MAX_CALL_SITES) return null;
    let cursor = index - 1;
    while (cursor >= from && /\s/.test(text[cursor]!)) cursor -= 1;
    const headEnd = cursor + 1;
    while (cursor >= from && HEAD_CHARACTER_RE.test(text[cursor]!)) cursor -= 1;
    const headStart = cursor + 1;
    const raw = text.slice(headStart, headEnd);
    const head = raw.replace(/^[.:]+/, '');
    const before = headStart > 0 ? text[headStart - 1]! : '';
    let depth = 1;
    let close = -1;
    for (let scan = index + 1; scan < to; scan += 1) {
      if (text[scan] === '(') depth += 1;
      else if (text[scan] === ')') {
        depth -= 1;
        if (depth === 0) { close = scan; break; }
      }
    }
    const chain: string[] = [];
    if (close !== -1) {
      const chainRe = /^\s*(?:\.|->|::)\s*([A-Za-z_]\w*[?!]?)(?:\s*\((?:[^()]*)\))?/;
      let rest = text.slice(close + 1, to);
      for (let step = 0; step < 8; step += 1) {
        const matched = chainRe.exec(rest);
        if (!matched) break;
        chain.push(matched[1]!);
        rest = rest.slice(matched[0].length);
      }
    }
    const groups = !head && (before === '' || EXPRESSION_START_CHARS.has(before));
    sites.push({
      head,
      member: head.slice(head.lastIndexOf('.') + 1),
      memberCall: /^[.:]/.test(raw) || (before === '>' && text[headStart - 2] === '-'),
      opaque: !head && !groups,
      grouping: groups,
      chain,
      argsStart: index + 1,
      argsEnd: close === -1 ? to : close,
    });
  }
  return sites;
}

/** Top-level argument spans of `text[from,to)`, split at commas that are not
 *  inside a nested call, collection, or string. */
function argumentSpans(text: string, from: number, to: number): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let quote = '';
  let start = from;
  for (let index = from; index < to; index += 1) {
    const character = text[index]!;
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
    if (character === '(' || character === '[' || character === '{') { depth += 1; continue; }
    if (character === ')' || character === ']' || character === '}') { depth -= 1; continue; }
    if (character === ',' && depth === 0) {
      spans.push({ start, end: index });
      start = index + 1;
    }
  }
  spans.push({ start, end: to });
  return spans;
}

/** Is this ONE argument of an open-family call a read mode? */
function readModeArgument(text: string): boolean {
  const argument = text.trim();
  if (!argument) return true;
  if (READ_MODE_STRING_RE.test(argument)) return true;
  if (READ_MODE_CONSTANT_RE.test(argument)) return true;
  if (argument.startsWith('{')) {
    const keys = [...argument.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((match) => match[1]!);
    return keys.length > 0 && keys.every((key) => READ_OPTION_KEYS.has(key));
  }
  // `:(?!:)` IS THE WHOLE DEFENCE AGAINST RUBY'S SCOPE OPERATOR, and it is
  // load-bearing: `::` contains the `:` a keyword argument uses, so without the
  // lookahead `File::WRONLY|File::TRUNC` parses as the argument NAME `File`
  // with the value `:WRONLY|File::TRUNC`, `File` is not a mode name, and the
  // numeric-flags truncation this inversion exists to refuse is admitted.
  //
  // A separate `if (argument.includes('|')) return false;` stood here as well
  // and was removed after the mutation pass: deleting it moved no row and
  // reddened no assertion, while its canary proved the line executed — so it
  // was redundant rather than unfixtured. Every flags spelling it was meant to
  // catch already falls through to the refusal below (`1|512|1024` is not a
  // read-mode string, and `flags=os.O_WRONLY|os.O_TRUNC` is a mode-named
  // argument whose value is not `O_RDONLY`). A guard no fixture can hold is a
  // guard nobody can maintain.
  const named = /^([A-Za-z_$][\w$]*)\s*(?:=>|=|:(?!:))\s*(\S[\s\S]*)$/.exec(argument);
  if (named) {
    const value = named[2]!.trim();
    if (!MODE_ARGUMENT_NAMES.has(named[1]!.toLowerCase())) return true;
    return READ_MODE_STRING_RE.test(value) || READ_MODE_CONSTANT_RE.test(value);
  }
  return false;
}

/**
 * Does this open-family call name a read?
 *
 * Argument POSITION does the one thing the shapes cannot: perl's filehandle
 * (`open(F, "<$p")`, `open(my $fh, '<', $p)`) is a bareword in exactly the
 * shape of python's variable mode (`open(p, m)`), and the difference is that
 * one occupies the FIRST slot while the other does not. So only the first
 * argument is unrestricted; every other argument, before the path or after it,
 * must be a recognised read mode, and the argument carrying the path is checked
 * for a mode GLUED to it — perl's 2-arg form, where `">$p"` is one argument
 * that is both.
 *
 * "Everything before the path is unrestricted" was the first spelling of this
 * and it was a hole rather than a simplification: perl's 3-arg `open(my $fh,
 * ">>", $p)` puts the MODE before the path, so an append that destroys nothing
 * on its own — but is not a read, and opens the record for writing — was
 * admitted. It is pinned in `__tests__/shell-vocabulary-symmetry.test.ts`.
 */
function openArgumentsAreRead(text: string, found: number, end: number, site: PathCallSite): boolean {
  const spans = argumentSpans(text, site.argsStart, site.argsEnd);
  for (const [index, span] of spans.entries()) {
    if (span.end <= found) {
      // Before the path: the filehandle slot, or a mode perl spells here.
      if (index > 0 && !readModeArgument(text.slice(span.start, span.end))) return false;
      continue;
    }
    if (span.start <= found) {
      // The argument that CARRIES the path. Whatever sits between the path and
      // the quote that opens its string is glued to it and is a mode candidate.
      let quote = -1;
      for (let index = found - 1; index >= span.start; index -= 1) {
        const character = text[index]!;
        if (character === "'" || character === '"' || character === '`') { quote = index; break; }
      }
      if (quote === -1) continue; // unquoted path: nothing can be glued to it
      if (!GLUED_READ_MODE_RE.test(text.slice(quote + 1, found))) return false;
      // The string must END at the path, so `open("<sidecar>.bak")` is not read
      // as naming the sidecar. A TRUNCATED literal cannot reach its closing
      // quote by construction — `open(f'…/{run}/scan-bound.json')` yields
      // `…/runs/{run` — and requiring one there refused every interpolated
      // read while the glue check above still answers the only mode question a
      // path-carrying argument can pose (the mode precedes the path in all six
      // families).
      if (!pathLiteralIsTruncated(text.slice(found, end)) && text[end] !== text[quote]) return false;
      continue;
    }
    if (!readModeArgument(text.slice(span.start, span.end))) return false;
  }
  return true;
}

/**
 * Is this ONE resolved call site a read of the path at `[found,end)`?
 *
 * THE CHAIN IS DECISIVE ONLY WHERE THE CALL'S VALUE CAN STILL REACH THE FILE:
 * an open-family HANDLE (`open(p).write(x)`) or a path OBJECT
 * (`Pathname.new(p).delete`), which is where round 3's surviving mutant lived.
 * A content reader's value is bytes, text, a stat record or a plain path
 * STRING, and no method on one of those destroys the path — while the member
 * names after it are unenumerable, because they are the caller's own data:
 * `JSON.parse(readFileSync(p,'utf8')).bound` was refused for the field name
 * `bound`, and no list can contain every key a sidecar might have. Checking a
 * chain that cannot reach the file bought nothing and cost a refusal per JSON
 * field name.
 */
function siteIsRead(text: string, found: number, end: number, site: PathCallSite): boolean {
  const opens = OPEN_MODE_HEADS.has(site.head) || OPEN_MODE_HEADS.has(site.member);
  const constructs = PATH_CONSTRUCTOR_HEADS.has(site.head) || PATH_CONSTRUCTOR_HEADS.has(site.member);
  if ((opens || constructs) && !chainIsRead(site.chain)) return false;
  if (opens) {
    // A call that does NOT carry the path still has to be a read, because it is
    // in the same statement — but the glued-mode question only exists for the
    // argument the path sits in, so the path position collapses onto the first
    // argument (the filehandle slot, which is unrestricted) and every other
    // argument is judged as a mode. `open('other','w')` is not a read;
    // `open('other')` is.
    return siteCarriesPath(site, found, end)
      ? openArgumentsAreRead(text, found, end, site)
      : openArgumentsAreRead(text, site.argsStart, site.argsStart, site);
  }
  if (constructs) return true;
  if (READ_CALL_HEADS.has(site.head) || READ_CALL_HEADS.has(site.member)) return true;
  // A MEMBER call is what `chainIsRead` judges when it follows a call on the
  // same line, and the two vocabularies have to agree: enumerating sites turns
  // `hashlib.md5(open(p,'rb').read()).hexdigest()`'s trailing `.hexdigest()`
  // into a site of its own, and `hexdigest` is a READ_MEMBERS entry rather than
  // a READ_CALL_HEADS one. Without this the chain vocabulary would apply only
  // where a chain happens to be attached to the path-bearing call.
  if (site.memberCall && READ_MEMBERS.has(site.member)) return true;
  return GROUPING_HEADS.has(site.head);
}

function siteCarriesPath(site: PathCallSite, found: number, end: number): boolean {
  return site.argsStart <= found && end <= site.argsEnd;
}

/** The head of the statement in `text[from,to)`. See `shellStatementHead`. */
function statementHead(text: string, from: number, to: number): ShellStatementHead {
  return shellStatementHead(shellWordsOf(text.slice(from, to)));
}

function chainIsRead(chain: readonly string[]): boolean {
  return chain.every((member) => READ_MEMBERS.has(member));
}

/**
 * Is the occurrence a REDIRECT DESTINATION? `>` and `>>` write whatever follows
 * them whatever the verb on the left is, which is the one shape a verb scan
 * structurally cannot see: `awk 'BEGIN{print "" > "<p>"}'` carries the redirect
 * inside awk's own program text, so awk is the verb and the write is invisible
 * to it. `reset-record-shell.ts` has had this arm since it shipped
 * (`REDIRECT_ONTO_RECORD_RE`) and it is the reason that fence refuses the four
 * commands this one returned `noop` for.
 */
function redirectsIntoPath(text: string, found: number): boolean {
  let index = found - 1;
  const quote = text[index];
  if (quote === "'" || quote === '"' || quote === '`') index -= 1;
  while (index >= 0 && (text[index] === ' ' || text[index] === '\t')) index -= 1;
  return index >= 0 && text[index] === '>';
}

/**
 * Is THIS occurrence of the path in a position that only reads it?
 *
 * THE WHOLE STATEMENT, not a path through it. Two narrower units shipped before
 * this one and a peer defeated each by moving the destruction to a position the
 * unit did not cover:
 *
 *   - ONE SITE (round 4): a read head TAKING the literal laundered any
 *     destruction enclosing it — `zipfile.ZipFile(str('<p>'),'w')`.
 *   - THE ENCLOSING NEST (round 5): every ANCESTOR of the occurrence was judged,
 *     so the destruction moved SIDEWAYS —
 *     `list(map(lambda f: zipfile.ZipFile(f,'w'), ['<p>']))`, where the
 *     ancestors are `map` and `list` and the `ZipFile` is a sibling. Four
 *     ground-truthed erasures at gate `noop`.
 *
 * A statement has no third position to move to: every call in it is judged on
 * its own, so ancestor, sibling and descendant are the same case. That also
 * retires the accounting the nest walk needed (how far back a callee may sit,
 * how deep a nest may be) — see `MAX_CALL_SITES`.
 *
 * THE PRICE, measured rather than discovered: the unit is the statement, and a
 * shell WORD is not split into statements (a `;` inside a quoted run is data as
 * often as it is a separator, and treating it as a separator is what BLOCKER 2
 * used). So an interpreter eval body that reads this path AND calls something
 * non-read on an unrelated path in the same body is refused —
 * `python3 -c "import os; os.remove('tmp'); print(open('<p>').read())"`. Zero
 * rows of the 23-row ordinary-work corpus and zero of the 40 pinned reads have
 * that shape; the remedy is two commands, and the failure is visible.
 */
function occurrenceIsRead(text: string, found: number, end: number): boolean {
  // Whatever the verb on the left is, `> <path>` writes the path.
  if (redirectsIntoPath(text, found)) return false;
  const bounds = statementBounds(text, found, end);
  const sites = callSitesIn(text, bounds.start, bounds.stop);
  if (sites === null) return false;
  // Nothing calls the path: the enclosing simple command's own verb decides it,
  // which is the shape `reset-record-shell.ts` uses and where the standing
  // ruling about `echo` lives. The verb is read from the STATEMENT, so it can no
  // longer be lifted out of a string literal by a quoted separator.
  if (!sites.some((site) => siteCarriesPath(site, found, end))) {
    return shellVerbIsRead(statementHead(text, bounds.start, bounds.stop), text, bounds.start, bounds.stop);
  }
  for (const site of sites) {
    if (site.grouping) continue;
    // A callee this scan cannot read is not a read: `fs['unlinkSync'](p)`,
    // `fs.rmSync?.(p)`, `$(…)`.
    if (site.opaque) return false;
    if (!siteIsRead(text, found, end, site)) return false;
  }
  return true;
}

/**
 * Is EVERY occurrence of `pathLiteral` in `text` in a position that only READS
 * it?
 *
 * The whole polarity of this module's newest half. `false` means refuse, and it
 * is what an unrecognised spelling gets — including one that has never been
 * written down anywhere, which is the point.
 *
 * Callers pass a path they have already decided is runtime-owned, so this
 * function never runs on a command that names no such path.
 *
 * WHAT IT STILL CANNOT SEE, and the residue is a VALUE rather than a spelling:
 * a path that reaches the destructive call through a NAME. Each occurrence is
 * judged where it appears, so `p=str('<sidecar>'); zipfile.ZipFile(p,'w')`
 * names the path once, in a read, and destroys it through a variable —
 * ground-truthed at 28 bytes to 22 with this gate at `noop`. Following that
 * needs an interpreter rather than a position.
 *
 * The residue is NARROWER than the shape suggests, and the difference was
 * measured rather than assumed: the same rebind written with a verb the
 * capability table DOES know (`os.unlink(p)`) is still refused, because
 * `shellTrafficOneWriteTargets` names the path from the command text and the
 * fact table sees the verb. The two detectors compose — the vocabulary covers
 * the rebind for verbs it knows, this function covers unknown verbs for paths it
 * can see — and what falls between them is an UNKNOWN verb reached through a
 * NAME.
 *
 * The inverse spelling (`p='<sidecar>'; print(open(p).read())`) is refused,
 * because an assignment is not a read — so the variable arm is asymmetric,
 * refusing a read and admitting a write, and it is disclosed in the shipped
 * prose in those words rather than claimed closed.
 */
export function pathIsReadOnlyInText(text: string, pathLiteral: string): boolean {
  if (!pathLiteral) return true;
  let from = 0;
  for (;;) {
    const found = text.indexOf(pathLiteral, from);
    if (found === -1) return true;
    const end = found + pathLiteral.length;
    from = end;
    if (!occurrenceIsRead(text, found, end)) return false;
  }
}

/**
 * Was this path literal CUT SHORT by an interpolation rather than ended by the
 * string it sits in?
 *
 * The extractors' character class stops at `}`, so
 * `` `.traffic-one/runs/${runId}/run.json` `` yields `.traffic-one/runs/${runId`
 * — which then matches no sidecar contract and no scope, and the command passed
 * as if it had named nothing at all. A PARTIAL PARSE MUST NOT READ AS AN ABSENT
 * TARGET: that is the same false-green shape as a check whose failure mode is
 * empty output read by a comparison that treats empty as fine.
 *
 * The assembled-path residue itself is unchanged and still disclosed — this
 * function does not resolve the interpolation, it reports that there was one so
 * the caller can fall back to the part of the path that IS readable.
 */
export function pathLiteralIsTruncated(literal: string): boolean {
  return literal.includes('{') || literal.includes('$');
}

/** The longest COMPLETE directory prefix of an unresolved literal: everything
 *  up to the last `/` before the first character this stage cannot resolve.
 *  `''` when even the first segment is unresolved, which the caller answers
 *  for. */
export function pathLiteralPrefix(literal: string): string {
  const slash = literal.slice(0, unresolvedCharacterAt(literal)).lastIndexOf('/');
  return slash <= 0 ? '' : literal.slice(0, slash);
}

// ── STAGE 5 OF THE PIPELINE CONTRACT: PATH EXTRACTION ────────────────────────
//
// THE CONTRACT: a literal this stage cannot resolve IN FULL is reported as
// UNREADABLE together with the longest complete directory prefix of it. It is
// never reported as absent, and it is never handed on as though it were a
// complete literal that happens to resolve to nothing.
//
// THE QUESTION IS ASKED AS AN ALLOWLIST, and the reason is the whole history of
// this lane. Round 9 answered it with a DISJUNCTION OF TWO DEFEATS — an
// INTERPOLATION (`pathLiteralIsTruncated`) or an UNEXPANDED GLOB — and a
// denylist of spellings can only forbid what someone has already been defeated
// by. Two more spellings arrived on schedule, each ground-truthed against real
// bash at all 15 files under `.traffic-one/runs` erased, `.resets.json`
// included, at gate `noop`:
//
//   rm -rf .traffic\-one/runs     bash discards the backslash and names the
//                                 tree; this reader kept both characters, so
//                                 the literal named a directory that exists
//                                 nowhere, enumerated nothing, and passed.
//   rm -rf ~+/.traffic-one/runs   `~+` is `$PWD`, so it names THIS project
//                                 whatever HOME is (re-measured with HOME
//                                 pointed away). The literal has no `$` and no
//                                 glob, so stage 5 called it fully resolvable.
//
// Adding `\` and `~` to the disjunction would be the fourth widening of the
// same list, and the fifth spelling is not in the list either. So the polarity
// is inverted: a literal is READABLE only when every character in it DENOTES
// ITSELF to a shell, and anything else is unresolved BY DEFAULT. What is
// enumerated below is therefore the set of characters that have no power to
// change what a word names — a closed question about the shell grammar — rather
// than a set of attacks somebody has already run. The next metacharacter is
// unresolved on the day it arrives.
//
// The glob half of round 9's answer is kept as its own question rather than
// folded in, because a glob is the one unreadable literal this stage can still
// USE: `globbedScope` walks the pattern against the tree. Round 9's eight glob
// spellings (`run?`, `[r]uns`, `[a-z]uns`, `[!x]uns`, `ru*`, `*/*/run.json`,
// `1715*`, `run.jso?`) all remain refused through that path, and `rm -rf *`
// remains permitted by the leading-dot rule.

/**
 * THE CHARACTERS THAT SEPARATE WORDS, which are not the ones JavaScript's `\s`
 * matches, and the difference falsified a shipped promise.
 *
 * Bash splits an unquoted word on IFS, whose default is SPACE, TAB and NEWLINE.
 * JS `\s` additionally matches `\v`, `\f`, `\r` and nineteen Unicode space
 * characters — U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F,
 * U+3000 and U+FEFF. Every one of the nineteen was ground-truthed against real
 * bash with the word UNQUOTED in operand position (`printf '%s\n' a<C>b`, word
 * count from bash's own output): bash forms ONE word for all of them, and for
 * `\v`, `\f` and `\r` too. It splits only on SPACE and TAB, with NEWLINE ending
 * the statement rather than the word.
 *
 * While `\s` stood for "the shell splits here", a name below `.traffic-one/runs`
 * carrying a no-break space — a paste from a browser, a macOS Option-Space, a
 * name copied out of a rendered doc — was cut in two: the remainder read as the
 * runs ROOT and the command was refused, by a gate with nothing to do with what
 * the developer typed, against the shipped sentence promising that a non-ASCII
 * name is not refused. Ground truth for `rm -rf .traffic-one/runs<U+00A0>x` is
 * zero bytes moved in all three project states.
 *
 * Splitting is made bash-correct rather than the promise narrowed, because the
 * whole point of `shellWordsOf` is that a word is what bash says a word is; a
 * narrowed sentence would leave the reader unable to predict any of the other
 * eighteen. What a word MEANS once formed is still stage 5's allowlist question,
 * and a character that is data to bash but not on that allowlist (`\v`, `\f`,
 * `\r`) is still priced at the literal's readable prefix — fail closed, as
 * before, and unchanged by this.
 */
const SHELL_WORD_SEPARATORS = String.raw` \t\n`;
const SHELL_WORD_SEPARATOR_RE = new RegExp(`[${SHELL_WORD_SEPARATORS}]`);

/** `*`, `?` and a bracket class: the shell expands them, so the token Traffic
 *  One is handed names no file. */
const GLOB_METACHARACTER_RE = /[*?[]/;

export function pathLiteralHasGlob(literal: string): boolean {
  return GLOB_METACHARACTER_RE.test(literal);
}

/**
 * The characters that DENOTE THEMSELVES inside a shell word, by class and with
 * the price of each admission stated.
 *
 * - `A-Za-z0-9` and `._-/+,:=%@^!#` — nothing to the shell inside a word. `!`
 *   is history expansion in an INTERACTIVE shell only and `#` opens a comment
 *   only where a word begins; a hook is handed neither position, and excluding
 *   them would refuse `rm -f <run dir>/run.json#1` — a file that is not a
 *   sidecar — with a paragraph about sidecars.
 * - `~` — data everywhere EXCEPT at a word head, which is why the tilde is the
 *   one positional member of this rule (see `unresolvedCharacterAt`). A backup
 *   file is `app.js~` and refusing it would cost an ordinary cleanup.
 * - `}` and `]` — a CLOSER without its opener is data (`echo runs}` prints
 *   `runs}`), and the openers `{` and `[` are not in this set, so an expansion
 *   or a bracket class is still unresolved by its own first character. Measured
 *   rather than reasoned into place: with the closers excluded, the SEGMENT
 *   `runs}` of `rm -rf "${RUNS:?.traffic-one/runs}"` read as unreadable, which
 *   fails closed all the way to a refusal of a command whose `:?` word is an
 *   error message and which destroys nothing (round 8's `r8-permit-default-error`,
 *   ground-truthed).
 * - SPACE and TAB — an unquoted one ends a word rather than sitting in it, so
 *   one that reached a word is data that quoting settled. Admitted for a cost
 *   reason rather than a symmetry one: real directories contain spaces, and
 *   excluding it prices `rm -rf ".traffic-one/my cache"` at its readable prefix
 *   (`.traffic-one`), which enumerates the whole runs tree and refuses an
 *   ordinary cache clean.
 * - Everything above ASCII — every special character of the POSIX shell grammar
 *   is ASCII, so a byte above it is a word constituent by construction. This is
 *   the clause that makes this a set of RULES rather than a longer list of
 *   spellings: a path in any script or language is readable without being
 *   enumerated.
 *
 * Unresolved, then, is everything else, and the classes are worth naming for
 * the reader who arrives here from a refusal: `$` and a backtick (expansion),
 * `\` (escape), `*?[` (globs), `{` (brace expansion and expansion syntax), a
 * leading `~` (tilde expansion — see below), a QUOTE that survived word
 * assembly, and the tokenization operators `;|&<>()`. The last group is the one
 * a reader will question: a quoted span holding one of them is exactly the span
 * `UNSAFE_TO_UNQUOTE_RE` declines to assemble, so a literal carrying one is a
 * literal whose own word boundaries no stage has vouched for, and the honest
 * answer to it is its readable prefix.
 */
const SELF_DENOTING_LITERAL_RE = /^[A-Za-z0-9 \t._\-/+,:=%@^!#}\]~\u0080-\uFFFF]*$/u;

/**
 * Where the first character this stage cannot resolve sits, or the length of
 * the literal when there is none.
 *
 * A LEADING TILDE is position 0 by fiat, and it is the one positional member of
 * the rule: `~`, `~+`, `~-` and `~user` expand only at the start of a word, so
 * `run~1` inside a path is data while `~+/.traffic-one/runs` is a path whose
 * root is a value this stage does not hold. `~+` and `~-` are `$PWD` and
 * `$OLDPWD`, which is why they cannot be dismissed as HOME-relative: they name
 * THIS project under any HOME at all.
 */
function unresolvedCharacterAt(literal: string): number {
  if (literal.startsWith('~')) return 0;
  for (let index = 0; index < literal.length; index += 1) {
    if (!SELF_DENOTING_LITERAL_RE.test(literal[index]!)) return index;
  }
  return literal.length;
}

/** Does every character of this literal denote itself, so that the path it
 *  spells is the path the shell would use? */
export function pathLiteralIsSelfDenoting(literal: string): boolean {
  return unresolvedCharacterAt(literal) === literal.length;
}

/** Not resolvable as written: a character in it denotes something other than
 *  itself to a shell, so the path this literal spells may not be the path the
 *  command names. */
export function pathLiteralIsUnresolved(literal: string): boolean {
  return !pathLiteralIsSelfDenoting(literal);
}

/**
 * Is this glob PATTERN unreadable for a reason that is not the glob?
 *
 * A pattern is the one unresolved literal a caller can still use, so the glob
 * metacharacters are removed before the question is asked: `.traffic-one/run?`
 * is a pattern this stage reads, `${x}*` and `.traffic\-one/*` are patterns
 * carrying something it does not, and the fail-closed answer for those is that
 * the pattern may match anything.
 */
export function globPatternIsUnreadable(pattern: string): boolean {
  return pathLiteralIsUnresolved(pattern.replace(/[*?[\]]/g, ''));
}

/** One glob PATTERN as a regex source. `crossSlash` is the difference between a
 *  parameter-expansion pattern (which matches over any character) and a path
 *  SEGMENT pattern (where `*` stops at a separator). */
function globRegexSource(glob: string, crossSlash: boolean): string {
  const any = crossSlash ? '[\\s\\S]' : '[^/]';
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === '*') { source += `${any}*`; continue; }
    if (character === '?') { source += any; continue; }
    if (character === '[') {
      const shut = glob.indexOf(']', glob[index + 1] === '!' || glob[index + 1] === '^' ? index + 3 : index + 2);
      if (shut !== -1) {
        const body = glob.slice(index + 1, shut);
        const negated = body[0] === '!' || body[0] === '^';
        source += `[${negated ? '^' : ''}${(negated ? body.slice(1) : body).replace(/\\/g, '\\\\')}]`;
        index = shut;
        continue;
      }
    }
    source += character.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
  }
  return source;
}

/** Does this glob match this text as a whole? Used for parameter-expansion
 *  patterns, where `*` crosses everything. */
function globTextMatches(glob: string, text: string): boolean {
  return new RegExp(`^${globRegexSource(glob, true)}$`).test(text);
}

/**
 * Does one glob SEGMENT match one path segment?
 *
 * The leading-dot rule is load-bearing rather than pedantic: `rm -rf *` does NOT
 * reach `.traffic-one`, because the shell does not expand `*` over dotfiles
 * (ground-truthed — the tree survives). A matcher without the rule would refuse
 * every `rm -rf *` in every project.
 */
export function globSegmentMatches(pattern: string, name: string): boolean {
  if (globPatternIsUnreadable(pattern)) return true; // unreadable: fail closed
  if (!pathLiteralHasGlob(pattern)) return pattern === name;
  if (name.startsWith('.') && pattern[0] !== '.') return false;
  return new RegExp(`^${globRegexSource(pattern, false)}$`).test(name);
}

/**
 * Traffic One's own tree, as a path literal in any text — an interpreter eval
 * body, a shell operand, an argument to something nobody has thought of.
 *
 * ONE EXTRACTOR, NOW ACTUALLY CONSUMED BY BOTH JUDGEMENTS. The previous version
 * of this comment said so and the previous code did not: `feature-source.ts`
 * kept a second regex with a different character class, and the round's own
 * header claimed the sharing had closed a divergence it had not touched. Both
 * judgements read `trafficOnePathLiterals` now; what they do with a literal is
 * still their own business and is documented where they differ
 * (`shellTrafficOneWriteTargets` keeps its own decision about which literals
 * are per-target WRITE PATHS, which is a different question from which literals
 * are Traffic One paths).
 *
 * The two character classes are not the same class and that is deliberate. What
 * may FOLLOW `.traffic-one` is a path body, which stops at the shell and
 * expression delimiters below. What may PRECEDE it is a DIRECTORY PREFIX only,
 * so `=`, `(`, `[` and `:` end it as well: they are how a path arrives glued to
 * something that is not a path (`dd of=<path>`, `git show HEAD:<path>`), and
 * swallowing them yields a literal that resolves under nothing and is silently
 * dropped by every consumer.
 */
const PATH_BODY_CHARACTER = String.raw`[^${SHELL_WORD_SEPARATORS}'"\x60;|&<>,)\]}]`;
const PATH_PREFIX_CHARACTER = String.raw`[^${SHELL_WORD_SEPARATORS}'"\x60;|&<>,)\]}=(\[:]`;
export const TRAFFIC_ONE_PATH_RE = new RegExp(
  `${PATH_PREFIX_CHARACTER}*\\.traffic-one(?:\\/${PATH_BODY_CHARACTER}*)?`,
  'g',
);

/** Every Traffic One path literal this text names, in order, deduplicated. */
export function trafficOnePathLiterals(text: string): string[] {
  TRAFFIC_ONE_PATH_RE.lastIndex = 0;
  return [...new Set(text.match(TRAFFIC_ONE_PATH_RE) || [])];
}

// ── STAGE 4 OF THE PIPELINE CONTRACT: EXPANSION AND BINDING RESOLUTION ───────
//
// THE CONTRACT: a value's ORIGIN survives every operator. A name bound by an
// earlier statement is known at every later reference, and an operator this
// stage cannot evaluate resolves to the bound VALUE rather than to nothing.
// Stage 5 may then report a path as unreadable; it may never see a path that
// stage 4 threw away.
//
// WHY IT IS ONE STAGE AND NOT TWO REWRITES. Round 8 shipped two independent
// textual passes — `withParameterDefaults`, which replaced a whole expansion by
// its default word, and `withAssignmentsResolved`, which replaced a reference by
// its bound value — and their COMPOSITION lost the path. `withParameterDefaults`
// ran first and turned `"${RUNS:-nosuch}"` into `nosuch`, so the NAME was gone
// before anything looked for its binding: `RUNS=.traffic-one/runs; rm -rf
// "${RUNS:-nosuch}"` erased every sidecar of every run at gate `noop`
// (ground-truthed 144B/12f → 0B/0f), and so did its `:=` and `-` spellings, an
// indirect `${!n}`, a substring `${R:0}`, and the three modifier forms `${R%X}`,
// `${R#xx}` and `${R/RUNS/runs}` — nine erasures, all at `noop`, all with a
// complete `.traffic-one` literal standing in the command text. Two sequential
// rewrites over a string cannot compose, because the first one destroys the
// evidence the second one needs. So names and expansions are resolved TOGETHER,
// over one value model, in one left-to-right walk.
//
// WHICH OPERATORS, and the answers are ground-truthed rather than symmetric:
//
//   (none)     the value, when the name is bound
//   `:-` `-`   the value when bound, else the WORD
//   `:=` `=`   the value when bound, else the WORD (and bash assigns it)
//   `:+` `+`   the WORD — it is the operand exactly when the name IS set
//   `:?` `?`   the VALUE, never the word: the word is an error message on
//              stderr, and an unset name exits rather than deletes. Round 8
//              left this expansion alone entirely, which is why
//              `R=.traffic-one/runs; rm -rf "${R:?nope}"` erased the tree at
//              `noop` — the operator was right about the WORD and lost the NAME.
//   `%` `%%`   the value with a matching suffix removed
//   `#` `##`   the value with a matching prefix removed
//   `/` `//`   the value with a match replaced
//   `:o[:l]`   the substring
//   `${#N}`    LEFT ALONE: a length is a number and not a path. Ground-truthed —
//              `rm -rf "${#R}"` destroys nothing (144B/12f → 144B/12f), so
//              resolving it would invent a refusal.
//   anything   the VALUE, when the name is bound. An operator nobody has
//   else       written down here must not launder a path, which is the same
//              fail-closed polarity `pathIsReadOnlyInText` has.
//
// FAIL-CLOSED AND SAID OUT LOUD: `${RUNS:-.traffic-one/runs}` with
// `RUNS=scratch` deletes `scratch` (measured), so a hook that cannot read the
// environment refuses a command that may not have destroyed anything. Same
// trade `sidecar-shell.ts` already makes for `$PWD/.traffic-one/runs`.
//
// SINGLE-QUOTED TEXT IS SKIPPED, which is not tidiness. The shell does not
// expand inside `'…'`, so `rm -rf '${RUNS:-.traffic-one/runs}'` removes a file
// whose NAME is that string and no sidecar. Double quotes do not protect an
// expansion and are not skipped — the same asymmetry `withSubstitutionsLifted`
// documents one operator over. An expansion inside a single-quoted `-c` body is
// reached anyway, because `shellReadPieces` re-enters that body as its own text.

/** Every parameter-expansion operator this stage recognises, longest first. */
const EXPANSION_OPERATOR_RE = /^(?::[-=+?]|[-=+?]|%{1,2}|#{1,2}|\/{1,2}|:|\^{1,2}|,{1,2}|@)/;
const EXPANSION_NAME_RE = /^[A-Za-z_]\w*/;

interface ParsedExpansion {
  /** Index just past the closing brace. */
  end: number;
  name: string;
  /** `${!n}` — the value of the name held BY `n`. */
  indirect: boolean;
  /** `${#n}` — a length, which is never a path. */
  length: boolean;
  operator: string;
  word: string;
}

/** The `${…}` whose `$` sits at `open`, parsed, or null. */
function parseExpansion(text: string, open: number): ParsedExpansion | null {
  if (text[open] !== '$' || text[open + 1] !== '{') return null;
  const close = braceSpan(text, open + 1);
  if (close === -1) return null;
  let body = text.slice(open + 2, close);
  const indirect = body.startsWith('!');
  const length = body.startsWith('#') && body.length > 1;
  if (indirect || length) body = body.slice(1);
  const named = EXPANSION_NAME_RE.exec(body);
  if (!named) return null;
  let rest = body.slice(named[0].length);
  if (rest.startsWith('[')) {
    const shut = rest.indexOf(']');
    if (shut === -1) return null;
    rest = rest.slice(shut + 1);
  }
  const operator = EXPANSION_OPERATOR_RE.exec(rest)?.[0] ?? '';
  return { end: close + 1, name: named[0], indirect, length, operator, word: rest.slice(operator.length) };
}

/** What this expansion can put on the command line, or null when the value is
 *  unknown and nothing may be invented for it. */
function expansionValue(spec: ParsedExpansion, bound: ReadonlyMap<string, string>): string | null {
  if (spec.length) return null;
  const direct = bound.get(spec.name);
  const value = spec.indirect ? (direct === undefined ? undefined : bound.get(direct)) : direct;
  switch (spec.operator) {
    case ':-': case '-': case ':=': case '=':
      return value ?? spec.word;
    case ':+': case '+':
      return spec.word;
    case '%': case '%%':
      return value === undefined ? null : withoutGlobbedEnd(value, spec.word, spec.operator === '%%');
    case '#': case '##':
      return value === undefined ? null : withoutGlobbedStart(value, spec.word, spec.operator === '##');
    case '/': case '//':
      return value === undefined ? null : withGlobbedReplacement(value, spec.word, spec.operator === '//');
    case ':':
      return value === undefined ? null : substringOf(value, spec.word);
    default:
      // `''` (a plain reference), `:?`/`?`, and every operator not modelled
      // above: the value, so the ORIGIN survives.
      return value ?? null;
  }
}

/** `${v%pat}` / `${v%%pat}`. */
function withoutGlobbedEnd(value: string, pattern: string, greedy: boolean): string {
  const cuts = [];
  for (let at = value.length; at >= 0; at -= 1) cuts.push(at);
  if (greedy) cuts.reverse();
  for (const at of cuts) {
    if (globTextMatches(pattern, value.slice(at))) return value.slice(0, at);
  }
  return value;
}

/** `${v#pat}` / `${v##pat}`. */
function withoutGlobbedStart(value: string, pattern: string, greedy: boolean): string {
  const cuts = [];
  for (let at = 0; at <= value.length; at += 1) cuts.push(at);
  if (greedy) cuts.reverse();
  for (const at of cuts) {
    if (globTextMatches(pattern, value.slice(0, at))) return value.slice(at);
  }
  return value;
}

/** `${v/pat/rep}` / `${v//pat/rep}`, anchors honoured. */
function withGlobbedReplacement(value: string, word: string, all: boolean): string {
  const at = word.indexOf('/');
  const rawPattern = at === -1 ? word : word.slice(0, at);
  const replacement = at === -1 ? '' : word.slice(at + 1);
  const anchor = rawPattern[0] === '#' ? 'start' : rawPattern[0] === '%' ? 'end' : '';
  const pattern = anchor ? rawPattern.slice(1) : rawPattern;
  if (!pattern) return value;
  const source = globRegexSource(pattern, true);
  const flags = all && !anchor ? 'g' : '';
  const anchored = anchor === 'start' ? `^${source}` : anchor === 'end' ? `${source}$` : source;
  return value.replace(new RegExp(anchored, flags), replacement);
}

/** `${v:off}` / `${v:off:len}`. A non-numeric offset is an arithmetic
 *  expression this stage does not evaluate, and the whole value is the
 *  fail-closed answer. */
function substringOf(value: string, word: string): string {
  const parts = word.split(':');
  if (parts.length > 2 || !/^-?\d+$/.test(parts[0] ?? '')) return value;
  const offset = Number(parts[0]);
  const from = offset < 0 ? Math.max(0, value.length + offset) : offset;
  if (parts.length === 1) return value.slice(from);
  if (!/^-?\d+$/.test(parts[1]!)) return value;
  const length = Number(parts[1]);
  return length < 0 ? value.slice(from, value.length + length) : value.slice(from, from + length);
}

// ── QUOTE REMOVAL, the last step of word assembly ────────────────────────────
//
// The shell removes quotes from a word after expanding it, so `.traffic-'one'/runs`
// and `$'.traffic-one/run\x73'` name the runs tree exactly as `.traffic-one/runs`
// does. Both erased the whole tree at gate `noop` (ground-truthed 144B/12f →
// 0B/0f) while READING as covered: the shipped prose says a path assembled from
// fragments is out of scope when "no complete `.traffic-one` path survives in the
// command text", which is an INTERPRETER-level statement about `'.traffic' +
// '-one'`, and these two are shell-level — the shell reassembles the word before
// any interpreter is involved, and this stage was simply not doing what the shell
// does.
//
// LITERAL SPANS ONLY, which is what keeps this from disturbing the asymmetry
// stage 4 documents: a span holding a `$` or a backtick keeps its quotes, so
// `'${RUNS:-.traffic-one/runs}'` stays the single-quoted literal it is and is
// still not read as an expansion.

/** `\xHH`, `\NNN`, `\uHHHH` and the named escapes of a `$'…'` word. */
const ANSI_C_ESCAPE_RE = /\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|[abefnrtv'"?\\])/g;

const ANSI_C_NAMED: Record<string, string> = {
  a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  "'": "'", '"': '"', '?': '?', '\\': '\\',
};

function ansiCDecoded(body: string): string {
  return body.replace(ANSI_C_ESCAPE_RE, (_match, escape: string) => {
    const head = escape[0]!;
    if (head === 'x') return String.fromCharCode(parseInt(escape.slice(1), 16));
    if (head === 'u' || head === 'U') return String.fromCodePoint(parseInt(escape.slice(1), 16));
    if (head >= '0' && head <= '7') return String.fromCharCode(parseInt(escape, 8));
    return ANSI_C_NAMED[head] ?? escape;
  });
}

/**
 * One statement with its words ASSEMBLED — quotes removed, `$'…'` decoded.
 *
 * A piece that is still a `-c` WRAPPER is left alone: its quoted span holds a
 * COMMAND, not a word, so removing those quotes would strip the wrapper's own
 * body of the quoting the unwrap loop reads it by and hand the read/write
 * question a verb of `bash`. The loop above owns that case up to its depth cap,
 * and the cap's residue is emptied rather than assembled (see
 * `withNestedShellBodies`). Measured: without this guard the double-quoted
 * nested READS at depths 5 and 6 flip to deny — the exact over-refusal the
 * emptying rule exists to prevent.
 */
function withWordsAssembled(text: string): string {
  return WRAPPING_SHELL_RE.test(text) ? text : withQuotesRemoved(text);
}

/**
 * Is removing the quotes around this span guaranteed not to change how the text
 * TOKENIZES?
 *
 * The real shell removes quotes after it has already split words and recognised
 * separators, so a `;` that came out of quotes is no longer a separator to it.
 * Every stage downstream of this one re-tokenizes the text it is handed, so here
 * it WOULD become one: unquoting `grep "foo;bar" <sidecar>` yields a second
 * statement whose verb is `bar`, which is not a recognised read, and a grep with
 * a semicolon in its pattern is answered with a paragraph about atomic
 * publication. That row is in the product suite precisely because an earlier
 * round shipped it, and quote removal reintroduced it (measured, one row).
 *
 * So the operation is confined to spans that hold none of the characters
 * tokenization is decided by — which is every path fragment anyone writes, and
 * the two shapes this exists for.
 */
const UNSAFE_TO_UNQUOTE_RE = new RegExp(`[${SHELL_WORD_SEPARATORS};&|<>()'"\`$]`);

/**
 * The characters an UNQUOTED backslash can be removed in front of.
 *
 * `\-` is `-` to bash, and until round 10 this stage kept both characters
 * unconditionally — so `rm -rf .traffic\-one/runs` carried a `\` the tree never
 * has, matched no sidecar, and erased all 15 files under `.traffic-one/runs` at
 * gate `noop` (ground-truthed). Five spellings of the same one character did the
 * same, and the class is not the character: `\<newline>` is a line continuation
 * that must vanish entirely, and a backslash inside single quotes is a literal
 * backslash that must stay.
 *
 * The set is the SELF-DENOTING characters minus three deliberate omissions,
 * because removing a backslash may not hand the stages below something they
 * would tokenize differently:
 *
 *   `\ `   a quoted-by-backslash SPACE is one word to the shell and two to
 *          anything that re-splits the text, so the pair stays and the word is
 *          left carrying a `\` — which stage 5 now reads as unresolved rather
 *          than as a path (fail closed, and measured as such).
 *   `\~`   removing it would MANUFACTURE a tilde head out of data.
 *   `\*`   likewise a glob out of a literal asterisk.
 *
 * Everything the set does not name keeps its backslash, and stage 5's allowlist
 * answers for the word that results. That pairing is the point: the resolver
 * does what it can PROVE the shell does, and the allowlist catches what it
 * declines to touch, so neither has to be complete on its own.
 */
const ESCAPE_RESOLVES_BEFORE_RE = /[A-Za-z0-9._\-/+,:=%@^!#]/;

/** Text with every LITERAL quoted span replaced by its contents, and every
 *  unquoted backslash escape resolved the way the shell resolves it. */
function withQuotesRemoved(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === '\\') {
      const escaped = text[index + 1];
      // A line continuation is not two characters of a word: it is nothing.
      if (escaped === '\n') { index += 2; continue; }
      if (escaped !== undefined && ESCAPE_RESOLVES_BEFORE_RE.test(escaped)) { out += escaped; index += 2; continue; }
      out += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    const ansiC = character === '$' && text[index + 1] === "'";
    if (character !== "'" && character !== '"' && !ansiC) { out += character; index += 1; continue; }
    const quote = ansiC ? "'" : character;
    const from = ansiC ? index + 2 : index + 1;
    let to = from;
    while (to < text.length && text[to] !== quote) to += quote === '"' && text[to] === '\\' ? 2 : 1;
    if (to >= text.length) { out += character; index += 1; continue; }
    const body = ansiC ? ansiCDecoded(text.slice(from, to)) : text.slice(from, to);
    // A span that is not literal, or whose removal could retokenize the line, is
    // left exactly as written.
    if (UNSAFE_TO_UNQUOTE_RE.test(body)) {
      out += text.slice(index, to + 1);
      index = to + 1;
      continue;
    }
    out += body;
    index = to + 1;
  }
  return out;
}

/**
 * The statements of a shell line WITH their separators, so a caller that must
 * hand the text back unchanged in shape can. `splitStatements` is this with the
 * separators dropped and the pieces trimmed.
 */
function statementSpans(text: string): Array<{ body: string; separator: string }> {
  const spans: Array<{ body: string; separator: string }> = [];
  let start = 0;
  let quote = '';
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote) {
      if (character === '\\' && quote === '"') { index += 1; continue; }
      if (character === quote) quote = '';
      continue;
    }
    if (character === '\\') { index += 1; continue; }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
    if (character === '(' || character === '[' || character === '{') { depth += 1; continue; }
    if (character === ')' || character === ']' || character === '}') { depth -= 1; continue; }
    if (depth > 0 || !STATEMENT_SEPARATORS.has(character)) continue;
    spans.push({ body: text.slice(start, index), separator: character });
    start = index + 1;
  }
  spans.push({ body: text.slice(start), separator: '' });
  return spans;
}

/**
 * One statement with every expansion this stage can resolve replaced by the
 * value it produces.
 *
 * THE SURROUNDING DOUBLE QUOTES GO WITH THE REFERENCE when they wrap nothing
 * else, and both halves of that are measured. A binding to MORE THAN ONE word
 * is a list, and re-quoting it would glue the list into one operand naming no
 * file: `d=(<run.json> <scan-bound>); rm -f "${d[@]}"` destroys both
 * (ground-truthed, 4 files to 2) and with the quotes kept it becomes
 * `rm -f "<a> <b>"`, which resolves under nothing and is refused by no arm. And
 * a value followed by a RELATIVE REMAINDER is one word with the quotes gone:
 * `"$R"/<id>/run.json` is `<value>/<id>/run.json`, which is the whole point of
 * dropping them rather than substituting inside them.
 */
function withValuesExpanded(text: string, bound: ReadonlyMap<string, string>, depth = 0): string {
  let out = '';
  let index = 0;
  let quote = '';
  let quoteAt = -1;
  while (index < text.length) {
    const character = text[index]!;
    if (quote !== "'" && character === '\\') { out += text.slice(index, index + 2); index += 2; continue; }
    if (quote === "'") {
      out += character;
      if (character === "'") { quote = ''; quoteAt = -1; }
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      if (quote === character) { quote = ''; quoteAt = -1; } else if (!quote) { quote = character; quoteAt = index; }
      out += character;
      index += 1;
      continue;
    }
    if (character !== '$') { out += character; index += 1; continue; }
    const braced = parseExpansion(text, index);
    const plain = braced ? null : EXPANSION_NAME_RE.exec(text.slice(index + 1));
    const end = braced ? braced.end : (plain ? index + 1 + plain[0].length : -1);
    const value = braced
      ? expansionValue(braced, bound)
      : (plain ? (bound.get(plain[0]) ?? null) : null);
    if (end === -1 || value === null) { out += character; index += 1; continue; }
    const wrapped = quote === '"' && quoteAt === index - 1 && text[end] === '"';
    if (wrapped) {
      out = out.slice(0, out.length - 1);
      quote = '';
      quoteAt = -1;
    }
    // A VALUE CAN ITSELF BE AN EXPANSION — `"${A:-${B:-<runs dir>}}"` produces
    // the inner `${B:-…}` — so what a value produces is expanded in turn, to a
    // bounded depth because a self-referential binding (`A=$A`) is a value that
    // never settles.
    out += value.includes('$') && depth < MAX_EXPANSION_DEPTH
      ? withValuesExpanded(value, bound, depth + 1)
      : value;
    index = wrapped ? end + 1 : end;
  }
  return out;
}

const MAX_EXPANSION_DEPTH = 4;

/**
 * A whole shell line with stage 4 applied, shape preserved.
 *
 * For the judgement that does NOT split a command into statements — the
 * feature-target scan reads path literals out of the text as a whole — so the
 * text it extracts from is the text the shell would have run.
 */
export function withShellValuesResolved(text: string): string {
  const bound = new Map<string, string>();
  let out = '';
  for (const span of statementSpans(text)) {
    const resolved = withWordsAssembled(withValuesExpanded(span.body, bound));
    const binding = assignmentBinding(resolved);
    if (binding !== null) bound.set(binding.name, binding.value);
    out += resolved + span.separator;
  }
  return out;
}

/** Index of the `}` closing the `{` at `open`, or -1. */
function braceSpan(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '\\') { index += 1; continue; }
    if (character === '{') { depth += 1; continue; }
    if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

/**
 * A DOUBLE-QUOTED body with the shell's escapes resolved: `\"` is a quote, not
 * two path characters.
 *
 * ROUND 8 BLOCKER 1(c). `bash -c "rm -rf \".traffic-one/runs\""` erases every
 * sidecar (ground-truthed) and reached gate `noop`. The review that found it
 * read the mechanism as the two `-c` regexes failing to match an escaped quote;
 * measured, they match fine and the body is unwrapped correctly. What defeats
 * every downstream consumer is that the CAPTURE is the raw text between the
 * quotes, so the body handed on is `rm -rf \".traffic-one/runs\"` — the operand
 * tokenizes as `\".traffic-one/runs\"`, the extractor's character class stops at
 * the `"` and yields the literal `.traffic-one/runs\`, and `runsTreeScope`
 * resolves neither. The literal survives in full and is unusable by one
 * character, which is this lane's oldest failure wearing a new spelling.
 *
 * Only the four characters a double quote actually escapes are resolved (`$`,
 * `` ` ``, `"`, `\`) plus a line continuation; every other backslash is data
 * inside double quotes and stays, so `grep "a\.b"` keeps its regex.
 */
export function unescapeDoubleQuoted(body: string): string {
  return body.replace(/\\(\n)|\\([$`"\\])/g, (_match, newline: string | undefined, escaped: string) => (
    newline === undefined ? escaped : ''
  ));
}

/**
 * The `.traffic-one…` TAIL of a literal whose earlier segments are unreadable,
 * or `''` when the literal does not spell the tree at a segment boundary.
 *
 * `rm -rf "$PWD/.traffic-one/runs"` is the shape this exists for. The operand's
 * first segment interpolates, so no consumer can resolve the literal as a
 * whole — but the REMAINDER names Traffic One's tree in full, and a caller that
 * holds the project root can answer for it. The question is what the rest of
 * the literal spells, not whether the beginning of it was readable.
 *
 * A segment boundary is required so `mydir.traffic-one/runs` — a different
 * directory whose name merely ends the same way — is not read as this one.
 */
export function trafficOnePathTail(literal: string): string {
  const at = literal.indexOf('.traffic-one');
  if (at === -1) return '';
  if (at > 0 && literal[at - 1] !== '/') return '';
  return literal.slice(at);
}

/** The Traffic One paths this text names with something that is not a read. */
export function trafficOnePathsNamedOutsideRead(text: string): string[] {
  return trafficOnePathLiterals(text).filter((literal) => !pathIsReadOnlyInText(text, literal));
}

/**
 * "Here is the code" — every spelling, including the ones a flat list of long
 * options cannot express.
 *
 * `-[a-zA-Z]*[ceEpr]` is the SHORT form as a shell really accepts it: short
 * options bundle, so `python3 -uc '…'` and `perl -pe '…'` are the same request
 * as `-c`/`-e` and were both invisible while the set was a literal `-c|-e|…`
 * alternation. `-p`/`--print` matter because `node -p` evaluates exactly like
 * `node -e` and additionally prints — the single spelling that defeated BOTH
 * detectors at once. `eval` is deno's subcommand form.
 *
 * The bundle form deliberately does not match a long option (`-[a-zA-Z]*`
 * cannot cross the second `-`), which is what keeps `perl -MList::Util -e` from
 * reading its `-M` module argument as the code (measured: still permitted).
 */
export const EVAL_FLAG = String.raw`(?:--eval|--exec|--print|-[a-zA-Z]*[ceEpr]|eval)`;

/** Shells whose `-c` argument is a command, not data. */
export const SHELL_NAMES = String.raw`sh|bash|zsh|dash|ksh|fish`;
export const SHELL_NAME = `(?:${SHELL_NAMES})`;

/**
 * A path-or-bare command word, optionally alias-escaped: `rm`, `/bin/rm`,
 * `\rm` (the idiom for bypassing an `rm -i` alias, which was invisible).
 */
export const COMMAND_WORD_PREFIX = String.raw`\\?(?:[^\s;&|]*\/)?`;

/**
 * What may sit immediately before a verb for it to still be a verb.
 *
 * The QUOTE is the load-bearing member: `bash -c 'rm …'` puts the body's opening
 * quote directly against the verb, so a whitespace-only class made the most
 * ordinary nested-shell deletion there is invisible while `bash -c 'cd . && rm …'`
 * — the same deletion with a no-op in front of it — was refused.
 */
export const VERB_ANCHOR = String.raw`(?:^|[\s;&|('"\x60])`;

/**
 * Verbs that destroy or overwrite file CONTENT.
 *
 * `mkdir` is deliberately absent (creates no content, and refusing it rejected
 * foreground architect scaffolding). `truncate` and `shred` are here because
 * truncating a record to zero bytes erases it as completely as unlinking it, and
 * `unlink` is coreutils' own single-file deletion binary.
 */
export const DESTRUCTIVE_VERBS = String.raw`rm|rmdir|unlink|shred|trash|mv|cp|ln|touch|truncate`;
export const DESTRUCTIVE_VERB = `(?:${DESTRUCTIVE_VERBS})`;

/**
 * Tools that overwrite a destination named in a way the generic operand scan
 * cannot see (`of=`, a LAST operand, a `-C` directory).
 *
 * These must be the COMMAND, not an argument, and the anchor for them is
 * therefore `COMMAND_START` rather than `VERB_ANCHOR`: `npm install`,
 * `pip install`, `brew install` and `go install` all put the word `install` one
 * space after another command, and reading that as a write refuses most of the
 * package manager surface (measured before shipping this).
 */
export const OVERWRITE_TOOLS = String.raw`install|rsync`;
export const OVERWRITE_TOOL = `(?:${OVERWRITE_TOOLS})`;
export const COMMAND_START = String.raw`(?:^|[\n;&|('"\x60])\s*`;

/**
 * Editors whose in-place FLAG is the destructive part, as a TABLE rather than
 * an alternation, because the alternation was the defect.
 *
 * Round 2 fixed the perl/sed asymmetry by adding one name and left `ruby -i`
 * and `awk -i inplace` open — the same capability, in two more languages, one
 * of which (`ruby`) the interpreter list already names. A flat `(?:g?sed|perl)`
 * cannot be asked "which languages have this capability and which of them do
 * you cover?"; a table can, and `IN_PLACE_COVERAGE` below answers the other
 * half by naming, with a reason, every interpreter family that has no in-place
 * flag at all. `__tests__/shell-vocabulary-symmetry.test.ts` fails when a
 * family appears in neither.
 *
 * `shortRun` is the option grammar each binary really has: perl and ruby have
 * bundleable no-argument switches that may precede the `i`, and matching a
 * looser `-[a-zA-Z]*i` there refuses `perl -MList::Util -e 'print 1'` (M, L,
 * i…), a read. gawk's `-i` is `--include`, so it is in-place only when its
 * argument is the `inplace` extension.
 */
export interface InPlaceEditor {
  binary: string;
  family: InterpreterFamily | 'posix';
  /** which bundled short forms carry the in-place `i` */
  shortRun: RegExp;
  /** the in-place flag is only in-place when the NEXT word is this */
  requiresArgument?: string;
  /** options whose argument is a separate word, so the option run survives it */
  optionsWithArgument?: readonly string[];
}

export const IN_PLACE_EDITORS: readonly InPlaceEditor[] = [
  { binary: 'gsed', family: 'posix', shortRun: /^-[a-zA-Z]*i/ },
  { binary: 'sed', family: 'posix', shortRun: /^-[a-zA-Z]*i/ },
  { binary: 'perl', family: 'perl', shortRun: /^-[plnaswW]*i/ },
  { binary: 'ruby', family: 'ruby', shortRun: /^-[plnasw]*i/ },
  { binary: 'gawk', family: 'posix', shortRun: /^-i$/, requiresArgument: 'inplace', optionsWithArgument: ['-v', '-f'] },
  { binary: 'awk', family: 'posix', shortRun: /^-i$/, requiresArgument: 'inplace', optionsWithArgument: ['-v', '-f'] },
];

/** Interpreter families with NO in-place edit flag, each with the reason. */
export const IN_PLACE_COVERAGE: Readonly<Record<InterpreterFamily, string>> = {
  perl: '', ruby: '',
  python: "python's `-i` is the INTERACTIVE prompt, not in-place edit; python rewrites through `fileinput(inplace=True)`, which the eval-body table carries",
  js: 'node/bun/tsx have no in-place edit flag; `-i` is not an option they accept',
  deno: 'deno has no in-place edit flag',
  php: "php's `-i` prints phpinfo(); php rewrites through file_put_contents, which the eval-body table carries",
};

export const IN_PLACE_EDITOR_RE = new RegExp(
  String.raw`(?:^|[\s;&|('"\x60/])(?:${IN_PLACE_EDITORS.map((editor) => editor.binary).join('|')})\b`,
  'g',
);

/**
 * Compressors that REPLACE their operand: after `gzip f` there is no `f`, only
 * `f.gz`. gzip(1)/xz(1) say so in as many words, and a sidecar erased this way
 * is erased exactly as `rm` erases it.
 *
 * These were in NO verb set — not the destructive verbs, not the overwrite
 * tools — because every existing entry was found by being defeated by it, and
 * nobody had been defeated by `gzip` yet.
 *
 * `zstd` keeps its input unless `--rm`, and is listed anyway: the operand set
 * is identical, `--rm` is one token, and refusing a `zstd` of a runtime sidecar
 * costs nothing anybody does.
 */
export const REPLACING_COMPRESSORS =
  String.raw`gzip|gunzip|bzip2|bunzip2|xz|unxz|lzma|unlzma|zstd|unzstd|compress|uncompress`;
export const REPLACING_COMPRESSOR = `(?:${REPLACING_COMPRESSORS})`;

/**
 * The flags that make a compressor leave its input alone: `-c`/`--stdout` sends
 * the result to stdout (where the redirect arm judges it), `-k`/`--keep` keeps
 * the original, `-l`/`--list` and `-t`/`--test` do not write at all. Bundled
 * forms count (`gzip -dc`).
 */
export function compressorKeepsInput(tokens: readonly string[]): boolean {
  return tokens.some((token) => (
    /^--(?:stdout|to-stdout|keep|list|test)$/.test(token)
    || /^-[a-zA-Z]*[cklt]/.test(token)
  ));
}

/**
 * Tools whose write DESTINATION is a flag argument or an extraction directory,
 * so the generic operand scan cannot see it: `sort -o F`, `unzip -d DIR`,
 * `patch FILE`. Same shape as OVERWRITE_TOOLS (`dd of=`, `install`/`rsync`'s
 * last operand, `tar -C`) and found the same way — by asking which coreutils
 * verbs name an output, rather than by being defeated by one.
 */
export const NAMED_OUTPUT_TOOLS = String.raw`sort|unzip|patch`;
export const NAMED_OUTPUT_TOOL = `(?:${NAMED_OUTPUT_TOOLS})`;

/**
 * THE UNION OF THE SHARED SHELL VERB SETS, derived rather than remembered.
 *
 * It is no longer what decides a `find -exec` (see `findWriteAction`); what it
 * is for now is the CROSS-MODULE CENSUS — every verb any shared set carries
 * must have a row driven through both judgements
 * (`plan-guard/__tests__/shell-write-vocabulary.test.ts`), so a verb entering a
 * set that only one judgement acts on is red by construction.
 *
 * It used to be `FIND_ACTION_VERB_LIST`, and the rename records a measured
 * mistake rather than a tidy-up. As a find-action list it was a DENYLIST of
 * writers wearing a derivation: it could only carry verbs some shared set
 * already knew, and a peer walked straight past it with `-exec tee {}` (in no
 * shared set at all), `-exec sh -c '…rm…'`, `-exec bash -c`, `-exec python3 -c`
 * and `-exec env rm` — six ground-truthed erasures of a live `run.json`, every
 * one `noop`. Its companion `FIND_ACTION_EXEMPT` is gone with it: an exemption
 * map whose property could only check that the reason string was non-empty is
 * the one census in this file no real spelling could falsify, and the judgement
 * it guarded no longer consults a census.
 */
export const SHARED_SHELL_VERB_LIST: readonly string[] = [
  ...DESTRUCTIVE_VERBS.split('|'),
  ...REPLACING_COMPRESSORS.split('|'),
  ...OVERWRITE_TOOLS.split('|'),
  ...NAMED_OUTPUT_TOOLS.split('|'),
  ...IN_PLACE_EDITORS.map((editor) => editor.binary),
  'dd',
];

/** Shell binaries as an anchored test, for `-exec sh -c '<body>'`. */
const SHELL_BINARY_RE = new RegExp(`^(?:${SHELL_NAMES})$`);
/** Interpreters as an anchored test, for `-exec python3 -c '<code>'`. */
const INTERPRETER_BINARY_RE = new RegExp(`^(?:${INTERPRETER_NAMES})$`);
const EVAL_FLAG_RE = new RegExp(`^${EVAL_FLAG}$`);

/** The code a `-c`/`-e` style flag hands its binary, or null. */
function evalFlagBody(args: readonly string[]): string | null {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (EVAL_FLAG_RE.test(args[index]!)) return args[index + 1]!;
  }
  return null;
}

/** Is this argv, as a simple command, a READ of the operands handed to it? */
function argvIsRead(argv: readonly string[]): boolean {
  const statement = argv.join(' ');
  return shellVerbIsRead(shellStatementHead(argv), statement, 0, statement.length);
}

/**
 * Does this `-exec`/`-execdir`/`xargs` ACTION write what the sweep matched?
 *
 * INVERTED, and the inversion is the round-7 fix. What stood here asked "is the
 * action verb one of the writers I know", which is the fail-open shape this
 * module retired everywhere else and kept in the one arm where a whole sweep of
 * runtime state hangs on the answer. It asks the read question now: an action
 * that is not a recognised READ writes. `tee` needed no verb set to be caught,
 * and neither will the next writer nobody has written down.
 *
 * A WRAPPER IS NOT A NEW SPELLING TO ENUMERATE, it is a body to re-enter.
 * `-exec sh -c '…' _ {}` puts an interpreter where the verb goes, and the old
 * regex — which required the action verb IMMEDIATELY after `-exec` — was simply
 * false. Extending it with wrapper names would have been the denylist-of-
 * spellings shape this lane has abandoned twice (`INLINE_MUTATION_RE`, the
 * private mutation vocabularies), so the shell body goes through the same
 * command-list reader every other `-c` body goes through, and its own verbs
 * decide it. `-exec sh -c 'cat "$1"' _ {}` stays permitted for a reason rather
 * than by accident.
 *
 * AN INTERPRETER BODY REFUSES, disclosed as a cost rather than claimed as
 * coverage: `-exec python3 -c '<code>' {}` names its operand as `sys.argv[1]`,
 * so there is no path literal for `pathIsReadOnlyInText` to judge and no shell
 * verb to read. The population is a sweep already rooted inside the runs tree,
 * and the remedy is to spell the read with a verb (`-exec cat {}`).
 *
 * STILL DELIBERATELY CONSERVATIVE about the operand's ROLE: `cp {} /backup`
 * reads the matched file and `cp /dev/null {}` destroys it, and telling those
 * apart needs a per-verb operand parse inside `-exec`. Both are refused. What
 * pays for that is narrow by construction — the sweep's root must already cover
 * `.traffic-one/runs` with real sidecars under it.
 */
export function findWriteAction(text: string): boolean {
  if (/(?:^|\s)-delete\b/.test(text)) return true;
  const words = shellWordsOf(text);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (/^-execdir$|^-exec$/.test(word)) {
      const argv: string[] = [];
      for (let scan = index + 1; scan < words.length; scan += 1) {
        const action = words[scan]!;
        if (/^\\?;$/.test(action) || action === '+') break;
        argv.push(action);
      }
      if (execActionWrites(argv)) return true;
      continue;
    }
    if (commandWordVerb(word) !== 'xargs') continue;
    let cursor = index + 1;
    while (cursor < words.length && words[cursor]!.startsWith('-')) {
      const flag = words[cursor]!;
      cursor += XARGS_FLAG_TAKES_ARGUMENT.has(flag) ? 2 : 1;
    }
    if (execActionWrites(words.slice(cursor))) return true;
  }
  return false;
}

/** xargs options whose argument is a SEPARATE word, so the command word is one
 *  further along (`xargs -I {} sh -c …`). Attached forms (`-I{}`, `-n1`) are
 *  one word and need no entry. */
const XARGS_FLAG_TAKES_ARGUMENT: ReadonlySet<string> = new Set([
  '-I', '-i', '-n', '-L', '-P', '-s', '-d', '-E', '-e', '-a',
  '--replace', '--max-args', '--max-procs', '--max-lines', '--delimiter',
  '--eof', '--arg-file', '--max-chars',
]);

/**
 * AN EVAL FLAG IS ONLY AN EVAL FLAG ON A BINARY THAT EVALUATES, and asking the
 * two questions in the other order was round 7's own regression.
 *
 * `EVAL_FLAG` spells "here is the code" as a shell really accepts it, which
 * means the short-option bundle `-[a-zA-Z]*[ceEpr]`. Round 7 asked
 * `evalFlagBody` of EVERY `-exec`/`xargs` action before asking what the action
 * was, so an ordinary reading verb whose short flag happens to END in one of
 * those five letters was read as interpreter code and the sweep refused:
 * `-exec jq -r`, `-exec grep -E`, `-exec grep -c`, `-exec wc -c`,
 * `-exec head -c`, `-exec sort -r`, `-exec tail -c`, `xargs jq -r`,
 * `xargs grep -c`. Round 6 permitted every one; each is a no-op on disk
 * (ground-truthed, 54→54 with every file still present); and the shipped prose
 * named the class as permitted while the code refused it — its own example
 * `-exec grep -l x {}` survived only because `l` is not one of the five letters.
 * A permitted list that is true by a coincidence of spelling is not a list.
 *
 * So the VERB decides what its flags mean. A shell re-enters its `-c` body as a
 * command list, an interpreter carrying an eval flag is refused (the disclosed
 * cost: its operand is `sys.argv[1]` and there is no literal to judge), and
 * anything else is judged by the read question exactly as round 7 intended.
 *
 * BOTH DIRECTIONS ARE PINNED IN THE SAME TEST, deliberately, because this is a
 * boundary a future narrowing can reopen from either side: the wrapper
 * destructions round 7 closed (`-exec sh -c '…rm…'`, `-exec python3 -c`,
 * `-exec tee`, `xargs -I {} sh -c '…rm…'`) stay refused, and the reading verbs
 * above stay permitted.
 */
function execActionWrites(argv: readonly string[]): boolean {
  if (argv.length === 0) return false; // no action at all: the sweep only lists
  const head = shellStatementHead(argv);
  if (!head.verb) return true; // nothing recognisable in command position
  if (SHELL_BINARY_RE.test(head.verb)) {
    const body = evalFlagBody(head.args);
    // A shell running something this cannot read (`-exec sh script.sh {}`).
    if (body === null) return true;
    return shellReadPieces(body).some((piece) => !argvIsRead(shellWordsOf(piece)));
  }
  // An interpreter's code flag: its operand is named inside the code, so there
  // is no literal for `pathIsReadOnlyInText` and no verb for the read question.
  if (INTERPRETER_BINARY_RE.test(head.verb) && evalFlagBody(head.args) !== null) return true;
  return !argvIsRead(argv);
}

/**
 * The destinations one of NAMED_OUTPUT_TOOLS writes, given its argument tokens.
 * Shared so the two judgements cannot learn different halves of it.
 */
export function namedOutputDestinations(verb: string, rest: readonly string[]): string[] {
  const valueOf = (...flags: string[]): string[] => {
    const out: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;
      for (const flag of flags) {
        if (token === flag && rest[index + 1] !== undefined) out.push(rest[index + 1]!);
        else if (token.startsWith(`${flag}=`)) out.push(token.slice(flag.length + 1));
        else if (flag.length === 2 && token.startsWith(flag) && token.length > 2 && !token.startsWith('--')) {
          out.push(token.slice(2));
        }
      }
    }
    return out;
  };
  if (verb === 'sort') return valueOf('-o', '--output');
  // `unzip -o … -d DIR` extracts into DIR, and into the cwd when `-d` is absent.
  if (verb === 'unzip') {
    const dirs = valueOf('-d');
    return dirs.length > 0 ? dirs : ['.'];
  }
  if (verb === 'patch') {
    if (rest.some((token) => token === '--dry-run' || token === '--check')) return [];
    // `-i` names the PATCH, `-o` the output, and a bare operand the file being
    // rewritten in place. `-d` changes directory, so it is a destination too.
    const skip = new Set(['-i', '--input', '-o', '--output', '-d', '--directory', '-p', '--strip', '-B', '-V', '-z', '-r']);
    const operands: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;
      if (skip.has(token)) { index += 1; continue; }
      if (token.startsWith('-')) continue;
      operands.push(token);
    }
    const named = [...operands, ...valueOf('-o', '--output'), ...valueOf('-d', '--directory')];
    // `patch -p1 < d.diff` names nothing and rewrites whatever the diff says,
    // relative to the cwd.
    return named.length > 0 ? named : ['.'];
  }
  return [];
}

/**
 * Does this `git` invocation REWRITE THE WORKTREE, and over which pathspecs?
 *
 * `null` — it does not. `[]` — it does, over the whole tree. Otherwise the
 * pathspecs it names.
 *
 * Shared because both fences got the same premise wrong in the same words.
 * Both retired `git checkout -- <path>` on "runtime sidecars are untracked, and
 * neither command removes an untracked file". Untrackedness is not a property
 * of the path, it is a property of the REPOSITORY: `.gitignore` never untracks
 * what is already committed, and this repo's own `scaffold-content.ts` records
 * `.traffic-one/runs/**` having shipped committed in the field. In that state
 * `git checkout -- .traffic-one/runs` reverts every sidecar to its committed
 * bytes — a stale `scan-bound.json`, a reset ladder rolled back to free — with
 * the ignore entry present and doing nothing about it.
 *
 * So the honest question is not "is it tracked" (which a hook cannot answer
 * without running git) but "would this command overwrite the worktree at a path
 * that covers the runs tree". `git checkout main` answers no by PATH: `main`
 * resolves to a path that covers nothing, which is also what makes passing
 * every operand through as a pathspec safe.
 */
export function gitWorktreeRewritePathspecs(rest: readonly string[]): string[] | null {
  // `git -c core.x=1 -C dir clean -fd`: the porcelain options before the
  // subcommand take separate-word arguments, and reading one as the subcommand
  // is how a verb scan misses the command entirely.
  const globalWithArgument = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
  let cursor = 0;
  while (cursor < rest.length) {
    const token = rest[cursor]!;
    if (globalWithArgument.has(token)) { cursor += 2; continue; }
    if (token.startsWith('-')) { cursor += 1; continue; }
    break;
  }
  const subcommand = rest[cursor] ?? '';
  const args = rest.slice(cursor + 1);
  const has = (...names: string[]): boolean => args.some((token) => names.includes(token));
  /** Pathspecs of the subcommand: everything after `--`, or every non-flag word. */
  const pathspecs = (optionArguments: readonly string[] = []): string[] => {
    const dashdash = args.indexOf('--');
    if (dashdash !== -1) return args.slice(dashdash + 1);
    const out: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]!;
      if (optionArguments.includes(token)) { index += 1; continue; }
      if (token.startsWith('-') && token.length > 1) continue;
      out.push(token);
    }
    return out;
  };
  /** Does this spelling deliberately OVERRIDE git's refusal to clobber a
   *  locally-modified tracked file? That override is the whole class — see
   *  `GIT_WORKTREE_SUBCOMMANDS`. */
  const forces = (): boolean => args.some((token) => (
    token === '--force' || token === '--discard-changes' || token === '--reset'
    || (/^-[a-zA-Z]+$/.test(token) && token.includes('f'))
  ));
  if (subcommand === 'checkout' || subcommand === 'restore' || subcommand === 'switch') {
    // `--staged` alone restores the INDEX and leaves the worktree untouched.
    if (has('--staged', '-S') && !has('--worktree', '-W')) return null;
    // `git switch` is git 2.23's split of `checkout`, and it was missing while
    // `checkout` and `restore` were both here — so `git switch --discard-changes
    // main` performed, under the modern spelling, exactly the operation this
    // function refuses under the older one.
    //
    // A forcing flag discards the worktree WHOLESALE, so the operands (branch
    // names, for `switch` and for `checkout <branch>`) stop bounding it.
    if (forces()) return [];
    const specs = pathspecs(['-b', '-B', '-c', '-C', '--source', '-s', '--conflict', '--pathspec-from-file']);
    return specs.length === 0 ? null : specs;
  }
  if (subcommand === 'checkout-index') {
    // Writes index content over the worktree; `-f` overrides the refusal to
    // overwrite existing files and `-a` does it for every file in the index.
    if (!forces()) return null;
    const specs = pathspecs(['--prefix', '--stage']);
    return specs.length === 0 ? [] : specs;
  }
  if (subcommand === 'read-tree') {
    // Only `-u` writes the worktree at all; `--reset` is what lets it discard
    // local changes while doing so.
    if (!args.some((token) => token === '-u' || token === '--reset')) return null;
    return args.some((token) => token === '-u') ? [] : null;
  }
  if (subcommand === 'sparse-checkout') {
    // `set`/`reapply` REMOVE every path outside the cone from the worktree, and
    // `disable` rewrites it back. None of them asks about local modifications.
    return has('set', 'reapply', 'disable') ? [] : null;
  }
  if (subcommand === 'submodule') {
    return has('update') && forces() ? [] : null;
  }
  if (subcommand === 'merge' || subcommand === 'rebase' || subcommand === 'cherry-pick'
    || subcommand === 'revert' || subcommand === 'am') {
    // The ABORT of each of these is a hard reset to the pre-operation HEAD and
    // clobbers the worktree exactly as `reset --hard` does. The operation
    // ITSELF does not: git refuses to run when local changes to a tracked file
    // would be overwritten, which is the documented protection this whole class
    // is defined by, and refusing every `git merge` in every project would be a
    // false refusal of the commonest command there is. See
    // `GIT_WORKTREE_SUBCOMMANDS` for that census.
    return has('--abort') ? [] : null;
  }
  if (subcommand === 'reset') {
    // reset's operand is a COMMIT, never a pathspec, and only these three modes
    // touch the working tree at all.
    return has('--hard', '--merge', '--keep') ? [] : null;
  }
  if (subcommand === 'rm') {
    // `git rm` deletes from the worktree; `--cached` stops at the index.
    if (has('--cached')) return null;
    const specs = pathspecs();
    return specs.length === 0 ? null : specs;
  }
  if (subcommand === 'stash') {
    // Every stash reverts TRACKED modifications — that is what stashing IS —
    // and `-u`/`-a` only extend it to untracked files. Round 2 refused only the
    // `-u` forms, on the same false premise as `checkout`.
    if (has('pop', 'apply', 'list', 'show', 'drop', 'clear', 'branch', 'create', 'store')) return null;
    if (has('save')) return []; // takes a MESSAGE, never a pathspec
    return pathspecs(['-m', '--message']).filter((token) => token !== 'push');
  }
  if (subcommand === 'mv') {
    // The SOURCES move away; the destination is somewhere else's problem.
    const specs = pathspecs(['-k']);
    return specs.length > 1 ? specs.slice(0, -1) : null;
  }
  if (subcommand === 'clean') {
    // A dry run deletes nothing, and without a force flag `git clean` refuses to
    // run at all — denying either would refuse a command that does nothing.
    if (has('-n', '--dry-run')) return null;
    if (!args.some((token) => token === '--force' || /^-[a-zA-Z]*f/.test(token))) return null;
    return pathspecs(['-e', '--exclude']);
  }
  return null;
}

/**
 * THE CENSUS the function above is held complete against, and the line it draws.
 *
 * Round 3 shipped five subcommands and no completeness property; a peer measured
 * fourteen other worktree-rewriting spellings permitted, `git switch
 * --discard-changes` among them — git 2.23 split `checkout` into `switch` +
 * `restore`, this function had both halves of the split except the one that
 * kept the discarding flag.
 *
 * The line is git's own documented protection: **git refuses to overwrite a
 * locally-modified tracked file, and a spelling belongs here exactly when its
 * purpose is to override that refusal.** That is why `merge`, `rebase`,
 * `cherry-pick`, `revert` and `am` are covered only in their `--abort` form
 * (which is a hard reset) and permitted otherwise — refusing every `git merge`
 * would be a false refusal of the commonest command there is, and git will not
 * clobber a live sidecar with one. It is also why `checkout -f` and `switch
 * --discard-changes` return the WHOLE tree rather than their operands: their
 * operands are branch names and the discard is not bounded by them.
 *
 * HONEST LIMIT, stated because this lane's defect is claiming a closure it does
 * not have: this is a census with a property, not a construction. It cannot
 * discover a git subcommand nobody wrote down — unlike `pathIsReadOnlyInText`,
 * which needs no census at all. What the property buys is that a covered
 * subcommand cannot silently lose its coverage, an exemption cannot exist
 * without a reason, and an exemption that has become false reddens (the same
 * staleness check `CAPABILITY_COVERAGE` gets).
 */
export interface GitWorktreeSubcommand {
  subcommand: string;
  /** argv after `git` whose rewrite MUST be recognised, or null when nothing
   *  this subcommand spells overrides the local-modification protection */
  forcing: readonly string[] | null;
  /** argv after `git` that must stay PERMITTED, so coverage cannot be bought
   *  by refusing the subcommand outright */
  permitted: readonly string[];
  why: string;
}

export const GIT_WORKTREE_SUBCOMMANDS: readonly GitWorktreeSubcommand[] = [
  { subcommand: 'checkout', forcing: ['checkout', '--', '.traffic-one/runs'], permitted: ['checkout', 'main'], why: 'restores pathspecs from the index over local modifications' },
  { subcommand: 'restore', forcing: ['restore', '.'], permitted: ['restore', '--staged', '.'], why: "checkout's worktree half, split out in git 2.23" },
  { subcommand: 'switch', forcing: ['switch', '--discard-changes', 'main'], permitted: ['switch', 'main'], why: "checkout's branch half; --discard-changes is documented as throwing local changes away" },
  { subcommand: 'reset', forcing: ['reset', '--hard'], permitted: ['reset', '--soft', 'HEAD~1'], why: '--hard/--merge/--keep are the modes that touch the worktree' },
  { subcommand: 'rm', forcing: ['rm', '-r', '.traffic-one/runs'], permitted: ['rm', '--cached', 'src/app.ts'], why: 'deletes from the worktree unless --cached' },
  { subcommand: 'mv', forcing: ['mv', '.traffic-one/runs', 'elsewhere'], permitted: ['mv'], why: 'moves tracked paths out of their location' },
  { subcommand: 'stash', forcing: ['stash'], permitted: ['stash', 'pop'], why: 'reverts tracked modifications — that is what stashing is' },
  { subcommand: 'clean', forcing: ['clean', '-fd'], permitted: ['clean', '-n'], why: 'removes untracked files; refuses to run without a force flag' },
  { subcommand: 'checkout-index', forcing: ['checkout-index', '-a', '-f'], permitted: ['checkout-index', '--stage=all'], why: '-f overrides the refusal to overwrite existing worktree files' },
  { subcommand: 'read-tree', forcing: ['read-tree', '-u', '--reset', 'HEAD'], permitted: ['read-tree', 'HEAD'], why: '-u writes the worktree; --reset lets it discard local changes' },
  { subcommand: 'sparse-checkout', forcing: ['sparse-checkout', 'set', 'src'], permitted: ['sparse-checkout', 'list'], why: 'set/reapply remove every out-of-cone path from the worktree entirely' },
  { subcommand: 'submodule', forcing: ['submodule', 'update', '--force'], permitted: ['submodule', 'status'], why: '--force discards submodule worktree changes' },
  { subcommand: 'merge', forcing: ['merge', '--abort'], permitted: ['merge', 'main'], why: '--abort is a hard reset; the merge itself refuses to clobber local changes' },
  { subcommand: 'rebase', forcing: ['rebase', '--abort'], permitted: ['rebase', 'main'], why: '--abort is a hard reset to the pre-rebase HEAD' },
  { subcommand: 'cherry-pick', forcing: ['cherry-pick', '--abort'], permitted: ['cherry-pick', 'abc123'], why: '--abort restores the pre-pick worktree' },
  { subcommand: 'revert', forcing: ['revert', '--abort'], permitted: ['revert', 'HEAD'], why: '--abort restores the pre-revert worktree' },
  { subcommand: 'am', forcing: ['am', '--abort'], permitted: ['am'], why: '--abort restores the pre-am worktree' },
  { subcommand: 'apply', forcing: null, permitted: ['apply', '-R', 'fix.patch'], why: 'the paths it rewrites live in the PATCH FILE, not in the command text — the same family as a project script, which this fence discloses as unreadable rather than closing' },
  { subcommand: 'worktree', forcing: null, permitted: ['worktree', 'add', '--force', '../wt', 'main'], why: 'writes a DIFFERENT working tree at another path; the current one is untouched' },
  { subcommand: 'bisect', forcing: null, permitted: ['bisect', 'reset'], why: 'checks out through the ordinary protection, so a modified sidecar stops it' },
  { subcommand: 'pull', forcing: null, permitted: ['pull'], why: 'fetch plus merge, and inherits merge s refusal to overwrite local changes' },
];

/**
 * A heredoc whose READER is an interpreter or a shell, so the body is code about
 * to run rather than data about to be written.
 *
 * `cat > reviewer.md <<'EOF'` and `python3 <<'PY'` are the same grammar and
 * opposite facts. Both detectors dropped every heredoc body to protect the
 * reviewer-digest carve-out, and `python3 - <<'PY' … os.unlink(…) … PY` was
 * therefore a write primitive nobody could see. The distinction is the command
 * on the left, which the grammar makes available.
 */
export const HEREDOC_INTERPRETER_RE = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:[^\s;&|]*\/)?(?:${SHELL_NAME}|${INTERPRETER_NAME})\b[^\n]*?<<-?\s*['"]?[A-Za-z_]`,
);

/** Heredoc operator, with the terminator word captured. */
export const HEREDOC_OPERATOR_SOURCE =
  String.raw`<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|\\?([A-Za-z_][A-Za-z0-9_]*))`;

/**
 * Is THIS heredoc — the one whose operator ends at `operatorEnd` — read by an
 * interpreter or a shell?
 *
 * Per-heredoc rather than per-command on purpose: a reviewer digest is data even
 * when its findings quote `python3 <<'PY'`, and a whole-command test would
 * promote that digest's body to code.
 */
export function heredocReaderIsInterpreter(command: string, operatorEnd: number): boolean {
  const lineStart = command.lastIndexOf('\n', Math.max(0, operatorEnd - 1)) + 1;
  return HEREDOC_INTERPRETER_RE.test(command.slice(lineStart, operatorEnd));
}

/**
 * First tokens of a simple command that only READ their operands, for a path
 * named in shell position rather than inside a call. Deliberately the same
 * population `reset-record-shell.ts` allows, and deliberately not `echo`,
 * `printf` or `tee` — each of those either writes or is the left-hand side of
 * something that does.
 *
 * BELOW EVERY VERB SET IT CONSULTS, on purpose: three entries here are read only
 * CONDITIONALLY (see `SHELL_READ_VERB_CONDITIONS`), and the conditions are the
 * shared facts about writing that the rest of this file defines. An
 * unconditional entry is a claim that no spelling of the verb writes.
 */
const SHELL_READ_VERBS: ReadonlySet<string> = new Set([
  'cat', 'bat', 'head', 'tail', 'less', 'more', 'nl', 'wc', 'jq', 'yq',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ls', 'stat', 'file', 'du',
  'cmp', 'diff', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum',
  'uniq', 'cut', 'tr', 'column', 'xxd', 'od', 'strings', 'realpath',
  'readlink', 'dirname', 'basename', 'test', '[', '[[', 'true', 'false',
  // `lsof +D <dir>` asks WHO HOLDS A SIDECAR OPEN, which is the first thing to
  // ask when a publish looks stuck, and it has no writing spelling at all: it
  // opens nothing for write and takes no output path. It was refused — a peer
  // measured it as one of three PURE READS in an eight-row undisclosed
  // over-refusal set, all three of them the diagnostic a stuck run needs.
  'lsof',
  // The INTERPRETER binaries are deliberately absent: the only shape that
  // reaches this fallback with one as its first token is `perl -pi -e … <path>`
  // (an eval flag is what arms the arm at all), which is an in-place rewrite,
  // not a read. Admitting them to spare `perl -ne 'print' <path>` would be a
  // fail-open hole shaped exactly like the ones this module is retiring.
  //
  // `sort`, `awk` and `sed` USED TO BE HERE UNCONDITIONALLY, `awk`/`sed` under a
  // comment reading "`awk`/`sed` read unless a flag turns them into writers, and
  // that flag is judged by `inPlaceEditFlag`/`IN_PLACE_EDITORS` rather than
  // here." That is true of `sed -i` and false of `awk 'BEGIN{print "" >
  // "<sidecar>"}'`, which uses no flag at all — the write is a redirect inside
  // awk's own program text. `sort -o <sidecar> <sidecar>` is the same shape with
  // a flag that is not an in-place flag, and `namedOutputDestinations` has known
  // about it since it shipped. All three are now conditioned below on the fact
  // that decides them, and the sibling fence (`reset-record-shell.ts`) refused
  // each of them throughout.
]);

/**
 * Verbs that read SOMETIMES, each with the SHARED FACT that decides which.
 *
 * `tokens` is the argument run of the simple command, `statement` its whole
 * text. Returning false refuses; the direction is deliberate — a condition that
 * cannot be evaluated must not admit.
 */
type ShellReadCondition = (tokens: readonly string[], statement: string) => boolean;

const SHELL_READ_VERB_CONDITIONS: Readonly<Record<string, ShellReadCondition>> = {
  // awk writes through `print > "f"`, `printf > f` and `close(f)` inside its
  // PROGRAM, with no flag and no shell redirect for a verb scan to find. `-i
  // inplace` is gawk's in-place extension.
  //
  // "ANY `>` DISQUALIFIES IT" WAS THE PREVIOUS RULE AND THE SHIPPED PROSE SAID
  // SOMETHING ELSE: it promised "awk with no output redirect" while the code
  // refused awk's COMPARISON operator too, so `awk 'length($0) > 10 {print}'
  // <sidecar>` — an ordinary read, and a row of the peer's over-refusal corpus
  // — drew a deny paragraph about atomic publication that no rewrite of the
  // command could satisfy. The `>` that redirects follows a `print`/`printf` in
  // the same awk statement; the `>` that compares does not. Outside the program
  // text every `>` still disqualifies, because there the shell's own redirect
  // is the write and this function cannot see which side of it the path is on.
  awk: (tokens, statement) => awkReads(tokens, statement) && !inPlaceEditRun('awk', tokens),
  gawk: (tokens, statement) => awkReads(tokens, statement) && !inPlaceEditRun('gawk', tokens),
  sed: (tokens, statement) => !statement.includes('>') && !inPlaceEditRun('sed', tokens),
  gsed: (tokens, statement) => !statement.includes('>') && !inPlaceEditRun('gsed', tokens),
  // `sort -o F` and `sort --output=F` write F, and F is routinely the input.
  sort: (tokens, statement) => !statement.includes('>') && namedOutputDestinations('sort', tokens).length === 0,
  // Reading git history is the commonest ordinary read of a path there is
  // (`git log -- <p>`, `git diff -- <p>`, `git show HEAD:<p>`), and refusing it
  // was a cost this fallback paid for having no way to ask the question. The
  // shared census answers it: `null` means this spelling does not rewrite the
  // worktree at all.
  git: (tokens) => gitWorktreeRewritePathspecs(tokens) === null,
  // A sweep rooted at a path READS it — `find .traffic-one/runs -name '*.json'
  // -exec cat {} \;` is a read-only sweep and is on the gate's permitted list —
  // unless its action writes what it matched. Same shared fact the sidecar scan
  // roots its enumeration on, so a verb entering a shared set cannot make one of
  // them stricter than the other.
  find: (tokens, statement) => !findWriteAction(statement),
  // Only an EXTRACT writes; `tar -czf out.tgz <runs tree>` reads the tree into
  // an archive, which is the same distinction the sidecar scan's `tar` arm draws.
  tar: (tokens) => !tokens.some((token) => token === '--extract' || /^-[^-]*x/.test(token)),
  // A DRY RUN writes nothing BY CONSTRUCTION, and refusing one is the worst row
  // an over-refusal ledger can hold: it is the command a cautious agent reaches
  // for precisely to avoid destroying anything, and the refusal teaches it that
  // caution is what got refused. `rsync -an <runs> <backup>` was `deny` while
  // destroying nothing (ground-truthed). The REAL copy stays refused — that is
  // round 7's read-into-backup decline, upheld twice — so this admits exactly
  // the spelling that cannot write.
  rsync: (tokens) => rsyncIsDryRun(tokens),
  // Extended attributes: `-l`/`-p` LIST them and are among the pure reads a
  // peer measured as refused. `-w` sets one, `-d` deletes one and `-c` clears
  // them all, and an attribute of a runtime sidecar is the runtime's to write,
  // so those three keep refusing.
  xattr: (tokens) => !tokens.some((token) => /^-[a-zA-Z]*[wdc]/.test(token)),
  // DERIVED from the shared set rather than listed: every replacing compressor
  // reads its operand when a keep flag is present (`gzip -c <p> | wc -c` is a
  // pinned read) and replaces it otherwise. `compressorKeepsInput` is the fact
  // both other judgements already use, so a compressor entering
  // `REPLACING_COMPRESSORS` arrives here with the right condition attached
  // instead of being remembered.
  ...Object.fromEntries(REPLACING_COMPRESSORS.split('|').map((verb): [string, ShellReadCondition] => [
    verb, (tokens) => compressorKeepsInput(tokens),
  ])),
};

/** `rsync -n` / `--dry-run`, in every spelling a short-option bundle allows
 *  (`-an`, `-avn`). The long form is exact so `--numeric-ids` cannot pass for
 *  it. */
export function rsyncIsDryRun(tokens: readonly string[]): boolean {
  return tokens.some((token) => token === '--dry-run' || /^-[a-zA-Z]*n/.test(token));
}

/**
 * Is this `awk` invocation a read?
 *
 * THE PROGRAM IS THE ONLY THING THIS ASKS ABOUT, and that is the whole fix.
 * A `>` inside it that follows a `print`/`printf` in the same awk statement
 * (nothing but `;`, `}` or a newline between them) is an output redirect and
 * writes; every other `>` in the program is arithmetic, which is what
 * `awk 'length($0) > 10 {print}' <sidecar>` is — an ordinary read, refused for
 * three rounds with a deny paragraph about atomic publication that no rewrite
 * of the command could satisfy.
 *
 * A `>` OUTSIDE the program is the SHELL's redirect and is not this function's
 * question: `redirectsIntoPath` already refuses the case that matters
 * (`awk '{print}' in.txt > <sidecar>`), and it knows which side of the operator
 * the path is on, which is exactly what a substring test cannot tell.
 *
 * DROPPING IT CHANGES NO GATE OUTCOME TODAY, measured rather than assumed, and
 * the reason is worth writing down because it is not about awk.
 * `awk '{print}' <sidecar> > summary.txt` is still refused — by the OTHER
 * judgement, which reports every `.traffic-one` literal standing beside a write
 * primitive as a write target and cannot see which side of the `>` it is on.
 * `cat <sidecar> > out.txt` is refused identically, so the cost belongs to the
 * redirect rule rather than to this one; it is disclosed in the gate's own
 * prose and declined this round with that measurement, not fixed quietly here.
 *
 * Conservative where it cannot tell: a program that lives in a FILE
 * (`awk -f prog.awk <path>`) is unreadable from here, so any `>` in the command
 * refuses. That fallback is arbitrary rather than principled — the file's
 * contents decide, and this fence cannot open it — and it is kept only because
 * fail-closed is the direction to be arbitrary in.
 */
function awkReads(tokens: readonly string[], statement: string): boolean {
  const program = awkProgram(tokens);
  if (program === null) return !statement.includes('>');
  return !/\b(?:print|printf)\b[^;}\n]*>/.test(program);
}

/** awk's program operand: the first word that is not a flag or a flag argument. */
function awkProgram(tokens: readonly string[]): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === '--') return tokens[index + 1] ?? null;
    if (!token.startsWith('-')) return token;
    // `-v x=1`, `-f prog.awk`, `-F ,` take a separate-word argument; `-i
    // inplace` is handled by `inPlaceEditRun` beside this call.
    if (/^-[vfFi]$/.test(token)) index += 1;
  }
  return null;
}

/** Does this simple command carry the in-place edit flag of `binary`? The same
 *  table `feature-source.ts` reads, asked about one known binary. */
function inPlaceEditRun(binary: string, tokens: readonly string[]): boolean {
  const editor = IN_PLACE_EDITORS.find((candidate) => candidate.binary === binary);
  if (!editor) return false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith('-') || token === '--') break;
    if (editor.optionsWithArgument?.includes(token)) { index += 1; continue; }
    if (token === '--in-place' || token.startsWith('--in-place=')) return true;
    if (!editor.shortRun.test(token)) continue;
    if (editor.requiresArgument && tokens[index + 1] !== editor.requiresArgument) continue;
    return true;
  }
  return false;
}

/**
 * SHELL RESERVED WORDS, which are not command words.
 *
 * A fact about the shell's grammar, in the shared leaf because both judgements
 * were reading a verb off the first token of a statement and both were wrong in
 * the same way. `if [ -f <sidecar> ]; then …` has the verb `if`, `for f in
 * <sidecar>; do …` has `for`, `while … done < <sidecar>` has `done` — none of
 * them is a command, none is on any read list, and all four were REFUSED. A
 * peer measured 5 undisclosed refusals of ordinary run inspection in a 47-row
 * corpus, every one of them this. The round that shipped the rule measured its
 * over-refusal cost at ZERO on a corpus containing no shell control flow at
 * all, which is the author-shares-with-the-matcher problem doing exactly what
 * it does.
 *
 * Skipping a reserved word cannot open a hole by itself: it moves the decision
 * to the REAL command word, which is judged by the same allowlist that judged
 * the reserved word. The one exception is `for`/`select`, which BIND their list
 * to a name — see `binds`.
 */
export const SHELL_RESERVED_WORDS: ReadonlySet<string> = new Set([
  'if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done',
  'case', 'esac', 'in', 'function', 'coproc', 'time', '!', '{', '}',
]);

/**
 * Commands that run ANOTHER command and write nothing themselves, so the word
 * after them is the command word.
 *
 * Same direction as the reserved words above: transparency moves the decision
 * to the real verb rather than admitting anything. `env rm -rf <runs tree>` was
 * `noop` and `env cat <sidecar>` was refused — one hole and one false refusal
 * from the same missing fact.
 *
 * `sudo`/`doas` are here for completeness of the class, not because a hook can
 * do anything about privilege.
 */
export const TRANSPARENT_COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  'env', 'nohup', 'command', 'builtin', 'exec', 'sudo', 'doas', 'setsid',
  'stdbuf', 'nice', 'ionice', 'timeout',
]);

/** Prefixes above whose FIRST operand is their own argument, not the command. */
const PREFIX_TAKES_ONE_ARGUMENT: ReadonlySet<string> = new Set(['timeout', 'nice', 'ionice']);

export interface ShellStatementHead {
  /** the command word, `''` when the statement has none */
  verb: string;
  /** the words after the command word */
  args: readonly string[];
  /** `for NAME in …` / `select NAME in …`: `args` BIND to this name */
  binds: string;
  /** the statement is a bare INPUT redirection (`done < <sidecar>`) */
  redirectionOnly: boolean;
}

const NO_HEAD: ShellStatementHead = { verb: '', args: [], binds: '', redirectionOnly: false };

/** A command word as the verb it names: path stripped, alias escape stripped. */
function commandWordVerb(word: string): string {
  const bare = word.replace(/^\\?['"`]+/, '');
  return bare.slice(bare.lastIndexOf('/') + 1);
}

/**
 * The COMMAND WORD of one simple command, with the shell grammar in front of it
 * skipped: reserved words, variable assignments (`LC_ALL=C rm …`) and
 * transparent wrappers.
 *
 * `verb: ''` means there is no command word to judge, which REFUSES — the two
 * shapes that reach it are a `for` list nobody resolved and a statement whose
 * first word this function could not classify.
 */
export function shellStatementHead(words: readonly string[]): ShellStatementHead {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word === 'for' || word === 'select') {
      const name = words[index + 1] ?? '';
      // `for ((i=0;i<3;i++))` is arithmetic, not a word list: no binding, and
      // nothing here can answer for it.
      if (!/^[A-Za-z_]\w*$/.test(name)) return NO_HEAD;
      const listAt = words[index + 2] === 'in' ? index + 3 : index + 2;
      return { verb: '', args: words.slice(listAt), binds: name, redirectionOnly: false };
    }
    // `case SUBJECT in PATTERN) …`: neither the subject nor the pattern list is
    // a command word, and nothing skipped either. `case` and `esac` and `in`
    // are all in the reserved set, so the word that became the verb was the
    // SUBJECT (`x`, `$mode`) — never a read — and `case x in a) cat <sidecar>
    // ;; esac` was refused while the shipped prose named `case` among the words
    // that are skipped to reach the verb. Ground-truthed as a no-op; the same
    // construct around an `rm` still reaches the `rm`. A pattern list always
    // ends at its `)`, and the subject can only end in one through a
    // substitution, which `withSubstitutionsLifted` has already lifted out.
    if (word === 'case') {
      let cursor = words[index + 2] === 'in' ? index + 3 : index + 1;
      while (cursor < words.length && !words[cursor]!.endsWith(')')) cursor += 1;
      index = cursor; // nothing closed the pattern: no command word, refuses
      continue;
    }
    if (SHELL_RESERVED_WORDS.has(word)) continue;
    if (/^[A-Za-z_]\w*=/.test(word)) continue;
    // A statement that only redirects INPUT reads its operand: `done < <sidecar>`
    // is the tail of an ordinary `while read … done` loop. Output redirection
    // never reaches here — `redirectsIntoPath` has already refused it.
    //
    // A FILE DESCRIPTOR NUMBER IS PART OF THE OPERATOR, not a command word:
    // `exec 3< <sidecar>; cat <&3` is a pure read through fd 3 and it was
    // refused, because `3<` did not start with `<` and became the verb. `3<>`
    // is deliberately excluded — it opens for READ AND WRITE — and `3>` never
    // matches at all.
    if (/^\d*<(?!>)/.test(word)) {
      return { verb: '', args: words.slice(index), binds: '', redirectionOnly: true };
    }
    const verb = commandWordVerb(word);
    if (TRANSPARENT_COMMAND_PREFIXES.has(verb)) {
      let cursor = index + 1;
      while (cursor < words.length && (words[cursor]!.startsWith('-') || /^[A-Za-z_]\w*=/.test(words[cursor]!))) {
        cursor += 1;
      }
      if (PREFIX_TAKES_ONE_ARGUMENT.has(verb)) cursor += 1;
      index = cursor - 1;
      continue;
    }
    return { verb, args: words.slice(index + 1), binds: '', redirectionOnly: false };
  }
  return NO_HEAD;
}

/**
 * Is a path named in SHELL POSITION by this statement read-only?
 *
 * The verb decides, and a verb this function does not recognise refuses. That is
 * a denylist read backwards and it is the weakest arm in this file — but the
 * arm it feeds is `occurrenceIsRead`'s LAST resort, reached only when nothing
 * CALLS the path, and the alternative (recognising writers) is what BLOCKER 3
 * was: `awk`, `curl -o`, `openssl -out` and `ex -sc '%d|x'` all erased a sidecar
 * at gate `noop` because no writer list named them.
 *
 * The VERB is `shellStatementHead`'s, not the statement's first token: a
 * reserved word is not a command, and reading one as a verb refused four
 * ordinary control-flow reads.
 */
function shellVerbIsRead(head: ShellStatementHead, text: string, from: number, to: number): boolean {
  if (head.redirectionOnly) return true;
  if (!head.verb) return false;
  const statement = text.slice(from, to);
  const condition = SHELL_READ_VERB_CONDITIONS[head.verb];
  if (condition) return condition(head.args, statement);
  return SHELL_READ_VERBS.has(head.verb);
}

/**
 * `sh|bash|… [flags] -c '<body>'` as a WHOLE piece, body captured. Anchored,
 * because this is used to REPLACE a piece by its body.
 */
const WRAPPING_SHELL_RE = new RegExp(
  String.raw`^\s*(?:[^\s;&|]*\/)?${SHELL_NAME}`
  + String.raw`(?:\s+(?:-[a-zA-Z-]+\s+[A-Za-z][\w=.-]*|-[^\s;&|'"]+))*?`
  + String.raw`\s+(?:-[a-zA-Z]*c[a-zA-Z]*)\s+(?:'([^']*)'|"((?:\\.|[^"\\])*)")\s*$`,
);

/**
 * The simple commands of a shell line, for a judgement that is made PER
 * COMMAND: quote-aware separators, and a `sh -c '<body>'` wrapper replaced by
 * its body.
 *
 * Both halves are load-bearing and each was measured.
 *
 * QUOTE-AWARE, unlike the two hand-rolled `command.split(/[\n;]|&&|…/)` in the
 * consumers: splitting `python3 -c "import zipfile; ZipFile('; cat x'[0:0] +
 * '<p>','w')"` on raw separators cuts the eval body into three fragments, and the
 * fragment holding the path no longer holds the call that destroys it — which is
 * BLOCKER 2 of round 5's review reached by a different road.
 *
 * REPLACED rather than appended, for the reason `reset-record-shell.ts` gives:
 * the wrapper piece has no operand of its own — its only operand IS the body —
 * so keeping it refuses `bash -c 'cat <p>'` on the verb `bash`, a read no fence
 * has a reason to refuse.
 */
export function shellReadPieces(command: string): string[] {
  let pieces = statementsOf(command);
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth += 1) {
    let unwrapped = false;
    pieces = pieces.flatMap((piece) => {
      const nested = WRAPPING_SHELL_RE.exec(piece);
      const body = wrapperBody(nested);
      if (body) {
        unwrapped = true;
        return statementsOf(body);
      }
      const grouped = groupingBody(piece);
      if (grouped !== null) {
        unwrapped = true;
        return statementsOf(grouped);
      }
      const substituted = withSubstitutionsLifted(piece);
      if (substituted !== null) {
        unwrapped = true;
        return substituted.flatMap((part) => statementsOf(part));
      }
      return [piece];
    });
    if (!unwrapped) break;
  }
  return withLoopBindingsResolved(resolveShellValues(pieces));
}

/**
 * The body of a matched `-c` wrapper, as the shell would run it.
 *
 * A SINGLE-quoted body is already literal. A DOUBLE-quoted one is the raw text
 * between the quotes and its escapes are still in it — see
 * `unescapeDoubleQuoted` for the erasure that survived on those two characters.
 */
function wrapperBody(nested: RegExpExecArray | null): string {
  if (!nested) return '';
  if (nested[1] !== undefined) return nested[1].trim();
  return nested[2] === undefined ? '' : unescapeDoubleQuoted(nested[2]).trim();
}

/**
 * The simple commands of a piece of shell text.
 *
 * Round 8 normalised parameter expansions HERE, once per re-entry, and round 9
 * moved that to stage 4 (`resolveShellValues`, applied to the finished piece
 * list) because an expansion cannot be resolved before the ASSIGNMENTS that
 * bind its name have been seen, and the assignments are other pieces. Nothing
 * is lost by the move: an expansion inside a single-quoted `-c` body is literal
 * to the outer shell and live to the inner one, and this function is what
 * re-enters that body — so the body's own expansions still reach stage 4 as
 * pieces of their own.
 */
function statementsOf(text: string): string[] {
  return splitStatements(text);
}

/**
 * The body of a piece that is nothing but a GROUPING: `( … )` (a subshell) or
 * `{ … ; }` (a brace group). `null` when the piece is not one.
 *
 * THE GRAMMAR BOUNDARY THE ROUND-6 REVIEW'S BLOCKER 2 LIVED ON. A leading `(`
 * in a shell command line opens a subshell whose body is a COMMAND LIST — it is
 * not the grouping paren of an expression, and it is not part of the first
 * word. `(rm -rf .traffic-one/runs)` therefore defeated three judgements at
 * once, each for its own reason: the sidecar scan tokenized the verb as `(rm`,
 * `callSitesIn` classified the whole statement as one grouping site and
 * `occurrenceIsRead` skips those, and the target extractor's character class
 * stopped at the `)`. Ground-truthed: every sidecar of every run deleted, gate
 * `noop`.
 *
 * Re-entering the body as a command list is the one fix that answers for all
 * three, because all three consume the pieces this function feeds. Stripping
 * the paren in ONE judgement would have left the other two blind, which is how
 * the class survived five rounds.
 *
 * A brace group is re-entered for the same reason and a different one: it is
 * refused today only because `{` is an unrecognised verb, and that accident
 * turns into a hole the moment reserved words are skipped — `{ cat <sidecar>;
 * rm -rf <runs tree>; }` is ONE statement to the splitter (the `;` sits at
 * bracket depth 1), so its first command would decide the whole group.
 */
function groupingBody(piece: string): string | null {
  const text = piece.trim();
  const open = text[0];
  if (open !== '(' && open !== '{') return null;
  const close = open === '(' ? ')' : '}';
  // `((…))` is ARITHMETIC evaluation, not a nested subshell, and it runs no
  // command at all (ground-truthed: it destroys nothing). Re-entering it as a
  // command list would invent a command the shell never runs.
  if (open === '(' && text[1] === '(') return null;
  let depth = 0;
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote) {
      if (character === '\\' && quote === '"') { index += 1; continue; }
      if (character === quote) quote = '';
      continue;
    }
    if (character === '\\') { index += 1; continue; }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
    if (character === open) { depth += 1; continue; }
    if (character !== close) continue;
    depth -= 1;
    // The group must span the whole piece; anything after it is a different
    // command and the splitter has not seen it yet.
    if (depth === 0) return index === text.length - 1 ? text.slice(1, index) : null;
  }
  return null;
}

/**
 * A piece with every COMMAND SUBSTITUTION lifted out: the outer text with each
 * `$( … )` / `` ` … ` `` span blanked, followed by each body as its own piece.
 * `null` when the piece holds no substitution.
 *
 * The body of a substitution is a command list, exactly as a subshell's is, and
 * the value that reaches the outer command is its OUTPUT rather than its text.
 * Both halves matter: `echo $(rm -rf <runs tree>)` must be judged on the `rm`
 * (it was, by accident — the scan read `$` as an unknown callee), and `echo
 * $(cat <sidecar>)` must be judged on the `cat` rather than on the `echo`,
 * which is one of the false refusals this round is paying off. Process
 * substitution (`diff <(jq . <sidecar>) …`) is the same grammar and was the
 * same accident, one operator over.
 *
 * THE SPAN IS REPLACED BY `$`, NOT BY A SPACE, and the character is chosen
 * rather than convenient: a substitution inside a path operand is an
 * INTERPOLATION, and `$` is what every path extractor in this file already
 * reads as one. Blanking `$(pwd)` out of `rm -rf "$(pwd)/.traffic-one/runs"`
 * would leave ` /.traffic-one/runs`, a path resolving under nothing, and would
 * re-open the very deletion the operand-tail fallback in `sidecar-shell.ts`
 * exists to catch. Leaving a `$` keeps the operand truncated-with-a-readable-
 * remainder, which is a shape both consumers already answer for.
 */
function withSubstitutionsLifted(piece: string): string[] | null {
  const bodies: string[] = [];
  let outer = '';
  let quote = '';
  for (let index = 0; index < piece.length; index += 1) {
    const character = piece[index]!;
    if (quote === "'") {
      outer += character;
      if (character === "'") quote = '';
      continue;
    }
    if (character === '\\') { outer += piece.slice(index, index + 2); index += 1; continue; }
    if (character === "'" || character === '"') {
      // Double quotes do NOT protect a substitution: `"$(cat p)"` still runs it.
      if (quote === character) quote = ''; else if (!quote) quote = character;
      outer += character;
      continue;
    }
    let bodyStart = -1;
    let substitution = -1;
    if (character === '`') {
      substitution = backtickSpan(piece, index);
      bodyStart = index + 1;
    } else if (character === '$' && piece[index + 1] === '(' && piece[index + 2] !== '(') {
      substitution = parenSpan(piece, index + 1);
      bodyStart = index + 2;
    } else if ((character === '<' || character === '>') && piece[index + 1] === '('
      && (index === 0 || /\s/.test(piece[index - 1]!))) {
      // Process substitution, which the shell only reads as one when the paren
      // is glued to the operator at the start of a word: `print(1 > (2))` in an
      // eval body is arithmetic and must stay untouched.
      substitution = parenSpan(piece, index + 1);
      bodyStart = index + 2;
    }
    if (substitution === -1) { outer += character; continue; }
    bodies.push(piece.slice(bodyStart, substitution));
    outer += '$';
    index = substitution;
  }
  return bodies.length > 0 ? [outer, ...bodies] : null;
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function parenSpan(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let index = open; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote) {
      if (character === '\\' && quote === '"') { index += 1; continue; }
      if (character === quote) quote = '';
      continue;
    }
    if (character === '\\') { index += 1; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '(') { depth += 1; continue; }
    if (character === ')' && --depth === 0) return index;
  }
  return -1;
}

/** Index of the backtick closing the one at `open`, or -1. */
function backtickSpan(text: string, open: number): number {
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] === '\\') { index += 1; continue; }
    if (text[index] === '`') return index;
  }
  return -1;
}

/**
 * `for NAME in <words>` re-entered with the binding RESOLVED: the list
 * statement is dropped and every `$NAME` in the loop body is replaced by the
 * words it iterates.
 *
 * The alternative was to treat `for` as one more transparent reserved word,
 * which is what the review's remedy suggested and what a measurement refused:
 * `for f in <runs tree>/*​/run.json; do rm -f "$f"; done` would then read its
 * verb off the loop LIST — a statement that touches no bytes — and permit a
 * deletion of every run record on disk. Today that command is refused only by
 * the accident that `for` is on no read list, and the accident had to be
 * replaced by a reason before it could be removed.
 *
 * Resolved rather than approximated, because the binding is exactly what the
 * loop does: `cat "$f"` over a list of sidecars IS a read of those sidecars and
 * `rm -f "$f"` IS a deletion of them, and after substitution each is judged by
 * its own verb with the paths in argument position. A loop whose body never
 * mentions the name uses the list for nothing, and the paths correctly vanish
 * from the judged text. An UNRESOLVED binding (no body, or a body this cannot
 * find) keeps `verb: ''` and refuses.
 */
function withLoopBindingsResolved(pieces: readonly string[]): string[] {
  if (!pieces.some((piece) => shellStatementHead(shellWordsOf(piece)).binds)) return [...pieces];
  const out: string[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]!;
    const head = shellStatementHead(shellWordsOf(piece));
    if (!head.binds || head.args.length === 0) { out.push(piece); continue; }
    const body = pieces.slice(index + 1);
    const done = body.findIndex((part) => /^done\b/.test(part.trim()));
    if (done === -1) { out.push(piece); continue; } // unresolvable: refuses on `verb: ''`
    const list = head.args.join(' ');
    for (const part of body.slice(0, done)) out.push(withNameResolved(part, head.binds, list));
    index += done;
  }
  return out;
}

/**
 * STAGE 4 over a piece list: every statement resolved against the bindings the
 * statements before it established, left to right.
 *
 * The assignment statement itself is DROPPED, which is not tidiness either: an
 * assignment writes nothing, and a piece with no verb refuses (`shellVerbIsRead`
 * answers false for `verb: ''`), so keeping it would refuse every command that
 * binds a name to a path it then reads.
 *
 * ROUND 8 BLOCKER 1(b), and the mechanism is worth stating because it is the
 * third round this branch has produced a blocker. `d=(.traffic-one/runs);
 * rm -rf "${d[0]}"` erases every sidecar of every run (ground-truthed 54 bytes
 * to absent, 0 files left) and reached gate `noop`, because `callSitesIn` saw
 * the `(` of `d=(…)`, found no callee before it, and `=` is in
 * `EXPRESSION_START_CHARS` — so the whole statement was one GROUPING site,
 * `occurrenceIsRead` skips those, and the path was "read". That is the branch
 * round 6's subshell blocker lived on: round 7 fixed the `(` that STARTS a
 * piece and left the `(` that follows `=`. A mutant that removes `=` from that
 * set still SURVIVES the whole fence suite with the branch executing 3 times,
 * which is what an absent fixture looks like from the instrument side.
 *
 * Resolving is the fix rather than re-classifying the paren, and the difference
 * is not stylistic. Teaching `callSitesIn` that `=(` is a shell array would
 * make the assignment REFUSE — an assignment writes nothing (measured: `d=(…)`
 * alone leaves all four sidecars) — and would then refuse `d=(<runs tree>);
 * ls "${d[0]}"` as well, buying a blocker with an over-refusal. With the
 * binding resolved, `rm -rf "${d[0]}"` becomes `rm -rf <runs tree>` and is
 * refused by the arm that has always refused it, while `ls "${d[0]}"` becomes
 * `ls <runs tree>` and is permitted by the arm that has always permitted it.
 * Both directions are ground-truthed and both are pinned.
 *
 * The shipped prose already promised this: the unseen residue is a path "BOUND
 * TO A NAME in an INTERPRETER", and it says a shell `for` binding IS resolved.
 * A shell assignment is the same sentence.
 *
 * A value this cannot read stays unresolved and the reference stays in the
 * text, where `pathLiteralIsTruncated` answers for it — an assignment whose
 * value is a command substitution has already been lifted into its own piece by
 * `withSubstitutionsLifted`, so the destruction inside it is judged there.
 */
function resolveShellValues(pieces: readonly string[]): string[] {
  const out: string[] = [];
  const bound = new Map<string, string>();
  for (const piece of pieces) {
    const text = withWordsAssembled(withValuesExpanded(piece, bound));
    const binding = assignmentBinding(text);
    if (binding === null) { out.push(text); continue; }
    bound.set(binding.name, binding.value);
  }
  return out;
}

/** `NAME=<word>` or `NAME=( <words> )` as a WHOLE statement, or null. A prefix
 *  assignment (`LC_ALL=C rm …`) is not one: its value is not a single word, and
 *  `shellStatementHead` already skips it to reach the real verb. */
function assignmentBinding(piece: string): { name: string; value: string } | null {
  const text = piece.trim();
  const array = /^([A-Za-z_]\w*)=\(([\s\S]*)\)$/.exec(text);
  if (array) return { name: array[1]!, value: shellWordsOf(array[2]!).join(' ') };
  const scalar = /^([A-Za-z_]\w*)=(.*)$/.exec(text);
  if (!scalar) return null;
  const words = shellWordsOf(scalar[2]!);
  if (words.length > 1) return null; // `LC_ALL=C rm -rf …`: a prefix, not a binding
  return { name: scalar[1]!, value: words[0] ?? '' };
}

/**
 * `text` with every reference to `name` replaced by the words it is bound to.
 *
 * THE SURROUNDING DOUBLE QUOTES GO WITH IT when they wrap nothing else, because
 * a binding to MORE THAN ONE word is a list and re-quoting it would glue the
 * list into a single operand that names no file. `d=(<run.json> <scan-bound>);
 * rm -f "${d[@]}"` destroys both (ground-truthed, 4 files to 2), and with the
 * quotes kept it would have become `rm -f "<a> <b>"` — one operand, resolving
 * under nothing, refused by no arm.
 */
function withNameResolved(text: string, name: string, value: string): string {
  const reference = String.raw`\$\{${name}(?:\[[^\]]*\])?\}|\$${name}\b`;
  return text.replace(new RegExp(String.raw`"(?:${reference})"|${reference}`, 'g'), value);
}

/** How many `-c` wrappers `shellReadPieces` unwraps. The same bound the two
 *  consumers use for the same attacker-shaped reason. */
const MAX_WRAPPER_DEPTH = 4;

/** Separator-split honouring quotes, escapes and bracket depth — the same rules
 *  `statementBounds` applies, so a piece and a statement cannot disagree about
 *  where a command ends. */
function splitStatements(text: string): string[] {
  return statementSpans(text).map((span) => span.body.trim()).filter(Boolean);
}

/**
 * The WORDS of a simple command, as the shell forms them: whitespace separates,
 * quotes are removed, and a quoted span GLUED to adjacent text stays part of the
 * SAME word.
 *
 * THE LAST CLAUSE IS THE WHOLE POINT, and it is a composition defect rather than
 * a parsing nicety. Both tokenizers this replaces were an alternation whose
 * first branch was a quoted span
 * (`/'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g`), so a word BEGINNING with a quote
 * ended at the closing quote and the remainder of the word became a token of its
 * own:
 *
 *   rm -rf "$PWD"/.traffic-one/runs   ->   ["rm", "-rf", "$PWD", "/.traffic-one/runs"]
 *
 * Every stage then honoured its own row over the wrong unit. Stage 2 refused to
 * re-root and recorded the word unresolved; stage 3 refused to unquote a span
 * holding a `$`; and the residue `/.traffic-one/runs` reached stage 5 as an
 * ABSOLUTE path with no `$` and no glob — fully readable by its own rule,
 * resolving outside the project root, enumerating nothing. All 15 files under
 * `.traffic-one/runs` erased at gate `noop`, ground-truthed, with the braced,
 * `$(pwd)` and `$OLDPWD` spellings behaving identically, while both controls (the
 * quote closing after the PATH, and no quotes at all) were correctly refused.
 * The escape was one character of quoting moved one position.
 *
 * Joining the word is what carries PROVENANCE forward: the `$PWD` the shell would
 * have expanded stays inside the operand, so the unresolved-ness of one piece of
 * a word is still visible to the stage that decides whether the word names a
 * path. A residue can no longer be laundered into a clean literal by being
 * handed on as a word of its own.
 */
export function shellWordsOf(statement: string): string[] {
  const out: string[] = [];
  let word = '';
  let open = false;
  let index = 0;
  while (index < statement.length) {
    const character = statement[index]!;
    if (SHELL_WORD_SEPARATOR_RE.test(character)) {
      if (open) out.push(word);
      word = '';
      open = false;
      index += 1;
      continue;
    }
    open = true;
    if (character === "'" || character === '"') {
      const close = quotedSpanEnd(statement, index);
      // An UNTERMINATED quote is a syntax error to the shell, so there is no
      // word the shell would form here to agree with; the rest of the text is
      // taken as the word's body, which is what the alternation did too.
      word += statement.slice(index + 1, close === -1 ? statement.length : close);
      index = close === -1 ? statement.length : close + 1;
      continue;
    }
    word += character;
    index += 1;
  }
  if (open) out.push(word);
  return out;
}

/** Index of the quote closing the one at `open`, or -1. A backslash escapes the
 *  closing quote inside a DOUBLE-quoted span only, which is the shell's own
 *  asymmetry. */
function quotedSpanEnd(text: string, open: number): number {
  const quote = text[open]!;
  for (let index = open + 1; index < text.length; index += 1) {
    if (quote === '"' && text[index] === '\\') { index += 1; continue; }
    if (text[index] === quote) return index;
  }
  return -1;
}
