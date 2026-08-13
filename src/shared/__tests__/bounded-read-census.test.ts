// src/shared/__tests__/bounded-read-census.test.ts
// AN ALLOWLIST CENSUS of every unbounded read in production source, and the
// enumeration of `bounded-read.ts`'s consumers.
//
// ── why an allowlist and not a list of the files that were cleaned ────────────
// `fs.readFileSync(path)` has no bound at all on two shapes: `open(O_RDONLY)` on
// a FIFO waits for a writer forever, and a character device answers a read as
// long as anybody keeps asking. Four separate rounds have now found the same
// defect at a new set of readers — the two project-state locks, one-settings,
// fsjson's pair, apply-patch's patch target, `projectOwnedGitignore`,
// `readWorkspaceDeclaration` — and each round closed the addresses it could see.
//
// The instrument that was proposed after the first of those rounds was a
// regression pin over the ~12 files it had cleaned. That was RULED AGAINST, on
// the argument this file exists to act on: a list of files that were cleaned is
// a DENYLIST OF FILES. It reds if someone reintroduces a bare read in one of
// those twelve, and it can say nothing whatever about the next site in a
// thirteenth — which is the entire live risk. Neither of the two sites the
// round-2 peer drove to an unbounded hang (`apply-patch.ts`,
// `scaffold-content.ts`) was among the twelve.
//
// So the direction is INVERTED. Every read of a PATH in production source is an
// offender until something says otherwise, and the only four things that say
// otherwise are (1) it reads a DESCRIPTOR that was `fstat`-guarded in the same
// block, (2) it is an `open` this file can PROVE cannot block from its flags,
// (3) it is a stream handed a descriptor from a bounded open, so the path
// argument never reaches the kernel, or (4) it is named in `EXCUSED` below with a
// KIND and the evidence that kind owes. A new bare read in a NEW file
// reds because the file is absent from the allowlist; a new bare read in an
// already-excused file reds because that file's count moved; and a new ROW reds
// because the pinned residue is an equality that only ever falls. That is the
// property a denylist structurally cannot have.
//
// ── AND THE FOURTH IS NOW RARE, WHICH IS ROUND 4'S WHOLE CHANGE ──────────────
// Round 3 leaned on (4) for 111 sites in 67 rows, each excused by an ARGUMENT
// about who controls the path. Its peer drove six of those rows and four hung at
// ~8 s against ~300 ms controls. Reading a call site is precisely what cannot
// tell a bounded one from an unbounded one — that is the reason this lane
// exists — so the remedy was not better arguments but ROUTING: 96 of those sites
// now go through `bounded-read.ts`, where the bound is proved once, and the
// residue is what routing could not reach.
//
// THE SIZE OF THE RESIDUE IS A RATCHET, NOT A CEILING, and that correction is
// round 5's. Round 4 asserted `<= 20` while standing at 15 and therefore shipped
// five sites of prepaid headroom; its peer spent them in one arm (five new
// unbounded reads in a new file, plus a row, census GREEN) and excused a sixth
// with twenty-two junk characters. `RESIDUE_LEDGER` pins both figures exactly and
// may only fall. See the docblock on `EXCUSED` for what a reason must now carry,
// and `bindingsIn` for the resolver change that made routing enforceable rather
// than merely preferred.
//
// ── A CENSUS HAS TWO PREDICATES, AND ROUND 2 GOT BOTH WRONG ──────────────────
// Recorded rather than quietly corrected, because the shape of each mistake is
// what the replacement is built against. The round-2 peer defeated eleven of
// twenty-one planted spellings and drove four of them to SIGKILL at ~8 s.
//
//   WHICH CALLS. The scan was anchored on the literal `readFileSync`, with an
//   optional qualifier that had to be an IDENTIFIER:
//       /(?<![\w$.])(?:[A-Za-z_$][\w$]*\s*\.\s*)?readFileSync\s*\(/g
//   A qualifier that is a CALL defeated it in both directions at once — the
//   lookbehind fails on the `.` and `)` is not an identifier — so
//   `require('fs').readFileSync(p, 'utf8')` was invisible. That is this
//   repository's HOUSE IDIOM: shell-vocabulary.ts uses `require('fs').X` in
//   seven command templates and feature-source.test.ts spells it about forty
//   times. `fsp.readFile`, an aliased `import { readFileSync as rf }`, a
//   callback `fs.readFile`, `openSync`+`readSync` and `createReadStream` were
//   invisible for related reasons.
//
//   WHICH FILES. `isProduction` required `.endsWith('.ts')`, so
//   `src/runners/lighthouse/index.mts` — the module ENTRY of the very directory
//   the bare-import readback is built around — was never scanned at all. And
//   the non-production list matched `/build/` as a SUBSTRING anywhere in the
//   path, so any production directory named `build` silenced the census inside
//   it.
//
// A LONGER ALTERNATION WOULD BE THE SAME INSTRUMENT. This tree has abandoned
// denylists-of-spellings three times (the harness lane deleted its hand-rolled
// YAML reader; the write-detector lane deleted INLINE_MUTATION_RE twice), and
// `bounded-read.ts`'s own design argument is that asking the POSITIVE question
// needs no list of shapes to refuse. So the scan below is an AST walk that
// resolves the `fs` BINDING — however it was spelled — and then classifies the
// resolved API by WHAT IT DOES. The classification is checked for TOTALITY
// against node's own `fs` module at run time (`FS_API_CLASSIFICATION` below), so
// an API nobody here has thought about cannot be silently absent from it.
//
// ── traps, each of which silently guts this census if missed ─────────────────
//   1. `readFileSync(fd)` is safe ONLY after an `fstat` on that SAME fd, in the
//      SAME BLOCK. `scaffold-content.ts`'s `ensureProjectGitignore` qualifies —
//      it holds an fd from `openGitignoreForUpdate` and tests
//      `fs.fstatSync(opened).isFile()` before reading it. An `fstat` on a
//      DIFFERENT descriptor launders nothing, and neither does a SECOND function
//      in the same file that happens to name its own descriptor `opened` (the
//      round-2 guard was file-scoped and admitted exactly that).
//   2. The callee's SPELLING is not the question. An AST binding walk sees the
//      six sites in `runners/lighthouse/cli-args.ts` and `lib.ts` that import
//      `readFileSync` by name, and it also sees `require('fs').readFileSync`,
//      `fsp.readFile` and an alias — none of which the regex could. It also
//      stops seeing the three files whose `readFileSync` sits inside a TEMPLATE
//      LITERAL they emit (`opencode-mcp.ts`, both `wrapper-source.ts`): those
//      are string contents, not calls, and the parser knows the difference where
//      the regex needed three allowlist rows to say so.
//   3. Reachability must follow `require()`. `core/registry.ts` `require`s each
//      runtime module at run time from a `readdir`, so every
//      `src/modules/<id>/<entry>.ts` is an entry point as much as
//      `src/hooks/*-entry.ts` is. Omitting them undercounts by 63 sites and hides
//      `retention.ts`, `codegraph.ts` and every gate.
//
// THE PARAGRAPH HERE WAS FALSE AND IT IS KEPT SO THE NEXT ROUND CAN SEE THE
// SHAPE OF IT. It read: "Trap 3 cannot silently shrink THIS census, because the
// scan is not scoped by reachability at all — every production file is scanned,
// which is strictly stronger than any closure." Every WORD of that is true of the
// code as written and the CONCLUSION is false, which is the most expensive kind
// of comment: a filter is only as strong as nobody narrowing it. The round-4 peer
// added ONE LINE to `isProduction` per arm and planted an unbounded read in the
// subtree it dropped — `src/modules`, `src/hooks`, `src/shared/state`, `src/core`
// — and the census stayed GREEN on all four. I reproduced those and added
// `src/adapters` and `src/config`: six of the seven production roots, silenceable
// with no red, while THIS paragraph presented the question as closed.
//
// So reachability is no longer only a label. The scanned set is the UNION of the
// DERIVED FLOOR — the closure of every entry point the filesystem names, which
// `isProduction` plays no part in building — with the filtered tree, and the
// floor's coverage is read back per root by set equality. See
// `productionSources`. Reachability is still ALSO a label, so a reader can weigh
// an excuse, and the three modules the trap-3 undercount hid are asserted both
// reachable and scanned.
//
// AND THAT WAS THE FOURTH WIDENING, NOT THE END OF IT: the union closed the
// SILENCING EDIT AT THE LEVEL ROUND 4 USED (`isProduction`) and left the level
// below it open. `isTestSource` and `listSources` are consulted to BUILD the union
// and were also the primitives the readbacks recomputed WITH, so a one-line edit
// to either was invisible to every assertion in this file — three arms measured
// green with a planted unbounded read (see 'WHICH FILES, recomputed from a LISTING
// this census's own predicates cannot move', which is the arms' answer and the
// only selection assertion here that calls neither predicate).
//
// ── THE ANTI-VACUITY PROPERTY IS LOAD-BEARING, NOT INCIDENTAL ────────────────
// Read this before "cleaning up" the stale-row assertion into a warning.
//
// A census cannot pass by matching nothing, and round 2's mechanism was the
// allowlist itself: every EXCUSED row must still be FOUND, so the rows doubled
// as one positive control each. The round-2 peer verified it by replacing the
// scan with a matcher that never fires — the census REDS, because all ninety-odd
// excused rows then report "found NONE — delete the row".
//
// THAT MECHANISM IS NOW MOSTLY GONE, AND SAYING SO IS PART OF REMOVING IT.
// Routing 96 of the 111 excused sites into the leaf took the allowlist from 67
// rows to 7, and 7 positive controls is not the same instrument as 67. The
// property did not survive on its own; it was moved:
//
//   the `SPELLINGS` corpus, which proves the UNEXCUSED path reds on synthetic
//   sources for every spelling rounds 2 and 3 admitted — thirty-odd arms that
//   cannot drift from the scanner, because the scanner is a pure function of
//   (name, text) and the corpus calls it directly;
//   `NOT_A_READ`, the same in the other direction, so a scan that flags
//   everything fails too;
//   the PATH_READS coverage test, so no entry in the classification can be
//   demoted without something noticing;
//   the fixture readbacks on the tree scan (>400 files, `.mts` present,
//   `__tests__` absent), so an empty file list cannot pass;
//   and the RESIDUE CEILING on the allowlist, which is the one assertion that
//   holds the METHOD rather than any particular site: an excuse that is an
//   argument rather than a measurement now has to get past a number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

import { EMITTED_BOUNDED_READ_FN, emittedBoundedReadSource } from '../emitted-bounded-read';

const SRC_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(SRC_ROOT, '..');

// ── WHICH FILES: everything the runtime can load ─────────────────────────────

/**
 * PRODUCTION source: what ships in `dist/scripts` and runs in a hook, a runner
 * or a materialization pass. Tests, fixtures, the build and the generator are
 * excluded because a blocking read there hangs a developer's own run, which is
 * reported by the run never finishing — not a hook that cannot report anything.
 * The generated fallbacks file is excluded because it is emitted, not authored.
 *
 * EVERY LOADABLE EXTENSION, not one spelling of one. `.mts` was the whole of
 * round 2's second predicate defect, and `.cts`/`.tsx` are the same hole with a
 * different suffix. The extension test is the one the sibling census in
 * `auth/__tests__/auth-source-census.test.ts` already uses.
 *
 * The non-production directories are matched at the TOP LEVEL of `src/` rather
 * than as a path substring. `src/shared/build/` is production and must be
 * scanned; `${sep}build${sep}` silenced it.
 */
const NON_PRODUCTION_ROOTS = ['build', 'gen', 'test-support', 'test-environment'];
const LOADABLE = /\.[cm]?[jt]sx?$/;

/**
 * Not authored production code: a test, a type declaration, or the emitted
 * fallbacks file.
 *
 * SPLIT OUT OF `isProduction` BECAUSE THE DERIVED FLOOR APPLIES ONLY THIS HALF,
 * and that is the whole reason the split exists rather than a tidy-up. A rule
 * that can remove a file from the floor is the same hole `isProduction` had, one
 * function over — so the test below pins the floor's exclusions by SET EQUALITY:
 * exactly one file, the generated one. A new clause here that swallowed a subtree
 * would grow that set by ninety files and RED, which is the falsifiability the
 * old `files.length > 400` readback (168 files of slack against 569) did not
 * have.
 *
 * FALSIFIED, ROUND 6b — the sentence above is kept because the shape of the
 * mistake is the shape of the defect. The set-equality pin sees a clause added
 * here ONLY FOR FILES INSIDE THE CLOSURE. A clause that swallows a subtree the
 * closure does not reach grows that set by NOTHING, and the round-5 peer drove
 * exactly that: `__fixtures__` added to the first clause, and the
 * `skill-fallbacks.generated.ts` suffix test generalised to
 * /\.generated\.[cm]?tsx?$/ — the tidy-up a second generated file invites — each
 * hid a planted unbounded read with the whole suite GREEN (arms
 * `P5-ISTESTSOURCE-FIXTURES`, `P5-ISTESTSOURCE-GENERATED`). Both red now, against
 * the literal listing in 'WHICH FILES, recomputed from a LISTING this census's own
 * predicates cannot move', which is the only assertion here that does not call
 * this function.
 */
function isTestSource(absolute: string): boolean {
  const segments = path.relative(SRC_ROOT, absolute).split(path.sep);
  if (segments.includes('__tests__')) return true;
  if (/\.test\.[cm]?[jt]sx?$/.test(absolute) || absolute.endsWith('.d.ts')) return true;
  return absolute.endsWith(`${path.sep}skill-fallbacks.generated.ts`);
}

function isProduction(absolute: string): boolean {
  if (isTestSource(absolute)) return false;
  const segments = path.relative(SRC_ROOT, absolute).split(path.sep);
  return !NON_PRODUCTION_ROOTS.includes(segments[0]!);
}

/**
 * A SYMLINK IS NEITHER `isFile()` NOR `isDirectory()`, and that is a hole in
 * file selection rather than in the resolver: `readdirSync({withFileTypes:true})`
 * answers both FALSE for a link, so a production source file that is a link — or
 * a whole production DIRECTORY reached through one — was simply never scanned,
 * whatever it contained. The round-3 peer planted all three variants (a linked
 * `.ts` inside `src`, a linked `.ts` outside it, a linked directory) and the
 * census stayed green on every one.
 *
 * Classified by following the link with `statSync`, because what matters is what
 * the RUNTIME will load, and `require` follows links. A dangling link resolves to
 * nothing and is skipped — there is no source there to scan.
 */
function listSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const target = fs.statSync(absolute);
        isDirectory = target.isDirectory();
        isFile = target.isFile();
      } catch { continue; }
    }
    if (isDirectory) listSources(absolute, out);
    else if (isFile && LOADABLE.test(entry.name)) out.push(absolute);
  }
  return out;
}

/**
 * THE SCANNED SET IS DERIVED, NOT FILTERED, and the difference is round 5's whole
 * change to this half of the census.
 *
 * The header below used to close trap 3 with "the scan is not scoped by
 * reachability at all — every production file is scanned, which is strictly
 * stronger than any closure". That sentence is FALSE and it is recorded here
 * rather than deleted, because the shape of the mistake is the shape of the
 * defect: a filter is only as strong as nobody narrowing it. The round-4 peer
 * narrowed `isProduction` by ONE LINE per arm and planted an unbounded read
 * inside the subtree it dropped — `src/modules` (91 files, every gate),
 * `src/hooks` (all 9 entries), `src/shared/state`, `src/core` — and the census
 * stayed GREEN on every one. I reproduced all four and added two more:
 * `src/adapters` (every host payload parser) and `src/config`. SIX of the SEVEN
 * production roots were silenceable; the seventh, `src/runners`, reds only
 * because it happens to hold `EXCUSED` rows whose "found NONE" assertion is the
 * real control. That is round 2's `${sep}build${sep}`-as-substring defect in a
 * new spelling, and the paragraph that presented it as fixed is the reason it
 * took two rounds to find.
 *
 * So the scanned set is the UNION of two answers to "which files":
 *
 *   THE DERIVED FLOOR — the transitive closure of every entry point the
 *   FILESYSTEM names: `src/hooks/*-entry.ts`, every runtime `module.json`
 *   entry (trap 3), `src/adapters/**`, `core/registry.ts`, `core/pipeline.ts`,
 *   and every `src/runners/<id>/index.{ts,mts,cts}`. 563 of this tree's 569
 *   production files, measured. No edit to `isProduction` can remove a file
 *   from it, because `isProduction` is not consulted to build it — the entry
 *   list comes from `readdir` and the rest comes from the import graph, which
 *   is what `require` will actually load.
 *
 *   THE FILTER — `listSources` minus tests, minus the four non-production
 *   roots. It contributes the six files no entry reaches (three of them
 *   unreachable only because nothing imports them yet) and it keeps the census
 *   strictly wider than the closure, which is the property the false sentence
 *   above was reaching for.
 *
 * A filter edit now costs the attacker the floor as well, and the floor's own
 * readbacks (per-root set equality, plus the three trap-3 files) are in the test
 * below.
 */
function productionSources(): string[] {
  const seen = new Set<string>(listSources(SRC_ROOT).filter(isProduction));
  for (const file of loadableClosure()) if (!isTestSource(file)) seen.add(file);
  return [...seen].sort();
}

// ── WHICH CALLS: the fs API surface, classified by what it DOES ──────────────

/**
 * Every function `fs` and `fs.promises` export, split by whether it OPENS A PATH
 * AND READS WHAT IS AT THE END OF IT. That is the property, and it is the reason
 * this is a classification rather than a list of names to look for: a call is an
 * offender because of what the kernel does with it, not because of how the
 * callee was spelled.
 *
 * TOTALITY IS ASSERTED, and it is what makes this an allowlist rather than a
 * third denylist. Every function node's own `fs` exports must appear in exactly
 * one column below; an API nobody classified REDS with "classify it", so a node
 * upgrade that adds a reader cannot land unnoticed and neither can a spelling
 * somebody invents out of an existing export.
 *
 * fd-FIRST READERS ARE DELIBERATELY IN THE SECOND COLUMN. `read`, `readSync`,
 * `readv` and `readvSync` take a DESCRIPTOR, so they never reach the kernel with
 * a path — whatever OPENED that descriptor is the site, and `open`/`openSync`
 * are in the first column precisely so the `openSync(p,'r')`+`readSync(fd,…)`
 * clipped-reader shape is caught once, at the open, rather than twice.
 *
 * WRITE-ONLY OPENS ARE OUT OF SCOPE HERE AND THE OMISSION IS DELIBERATE, not an
 * oversight: `open(O_WRONLY)` on a FIFO blocks waiting for a READER, which is
 * the same unboundedness reached from the other side. It is a different class
 * with a different population (every durable writer in fsjson.ts, fs-nofollow.ts
 * and every atomic publication), and folding it in here would turn a census into
 * the mechanical rewrite of a hundred and sixty call sites that this file's own
 * header argues against. `isBoundedOpen` below decides write-only from the flags
 * and says so.
 */
const PATH_READS = [
  // opens a path; what happens next is the caller's business
  'open', 'openSync', 'openAsBlob', 'opendir', 'opendirSync',
  // opens a path AND consumes it
  'readFile', 'readFileSync', 'createReadStream', 'ReadStream', 'FileReadStream',
  // opens a SOURCE path and consumes it, to write somewhere else
  'copyFile', 'copyFileSync', 'cp', 'cpSync',
] as const;

const NOT_PATH_READS = [
  // metadata only — never opens the object, so no shape can block it
  'access', 'accessSync', 'exists', 'existsSync', 'stat', 'statSync', 'lstat', 'lstatSync',
  'statfs', 'statfsSync', 'fstat', 'fstatSync', 'realpath', 'realpathSync',
  'readlink', 'readlinkSync', 'glob', 'globSync', 'watch', 'watchFile', 'unwatchFile',
  // directory entries, not file contents
  'readdir', 'readdirSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync',
  'mkdtempDisposable', 'mkdtempDisposableSync', 'rmdir', 'rmdirSync',
  // namespace mutation — no open of an existing object's contents
  'rename', 'renameSync', 'unlink', 'unlinkSync', 'rm', 'rmSync',
  'link', 'linkSync', 'symlink', 'symlinkSync',
  // attribute mutation
  'chmod', 'chmodSync', 'chown', 'chownSync', 'lchmod', 'lchmodSync', 'lchown', 'lchownSync',
  'utimes', 'utimesSync', 'lutimes', 'lutimesSync', 'truncate', 'truncateSync',
  'fchmod', 'fchmodSync', 'fchown', 'fchownSync', 'futimes', 'futimesSync',
  'ftruncate', 'ftruncateSync', '_toUnixTimestamp',
  // WRITES — the other side of the same unboundedness, out of this census's scope
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream',
  'WriteStream', 'FileWriteStream', 'Utf8Stream', 'write', 'writeSync', 'writev', 'writevSync',
  // descriptor-first: no path reaches the kernel here, the open above it is the site
  'read', 'readSync', 'readv', 'readvSync',
  'close', 'closeSync', 'fsync', 'fsyncSync', 'fdatasync', 'fdatasyncSync',
  // types and iterators, not calls that touch a path
  'Dir', 'Dirent', 'Stats',
] as const;

const PATH_READ_NAMES: ReadonlySet<string> = new Set<string>(PATH_READS);

// ── WHICH CALLS: resolving the fs binding, however it was spelled ────────────

const FS_SPECIFIERS = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

/** `require('fs')` — the house idiom the round-2 regex could not see. */
function requireSpecifier(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'require') return null;
  const first = node.arguments[0];
  return first && ts.isStringLiteralLike(first) ? first.text : null;
}

interface Bindings {
  /** identifiers holding the fs module itself (or its `promises` namespace) */
  readonly namespaces: Set<string>;
  /** identifiers bound directly to one fs API, under any local name */
  readonly direct: Map<string, string>;
  /** identifiers holding something an fs module was mixed INTO, under any route */
  readonly containers: Set<string>;
  /**
   * Identifiers bound to something SPELLED like a path read off a receiver this
   * file cannot resolve — the RENAME-AWAY family, and the reason it needs its own
   * map rather than a row in `direct`.
   *
   * `direct` means "this name IS an fs api, proved by taint". These are not proved
   * at all: `const { readFileSync: rf } = bar` and `import { readFileSync as rf }
   * from '../barrel'` bind `rf` to something whose only evidence is that somebody
   * spelled a path read somewhere in the binding. That is exactly the burden the
   * NAME BACKSTOP already inverts one level up — a call spelled like a read IS one
   * unless the receiver is PROVED to be something else — and the backstop could not
   * see these because IT LOOKS AT THE CALLEE'S OWN NAME, which the rename threw
   * away. `rf(p)` is spelled like nothing.
   *
   * So the api travels with the binding and the PROOF is re-applied at the call:
   * `root` is the receiver's leftmost identifier where there is one (a destructure
   * or a member capture, where `provablyNotFs` can still clear a local object), and
   * `null` where the value came from ANOTHER MODULE, which is unprovable by
   * construction and therefore stays a site — the same answer round 4 gave the
   * import route it could see.
   */
  readonly aliased: Map<string, { readonly api: string; readonly root: ts.Identifier | null }>;
}

/**
 * WHAT MAKES A RESOLVER DEFEATABLE IN PRINCIPLE, and why this one asks a
 * different question than the two before it.
 *
 * Round 2's scan matched the literal `readFileSync` and was defeated by eleven
 * spellings. Round 3 replaced it with a BINDING WALK — six syntactic forms of
 * "this identifier holds fs" — and the round-3 peer defeated fourteen of
 * eighteen: a namespace parked in an object literal, `Object.assign` over fs, an
 * `await import`, a nested destructure with a rename, a re-export barrel, a
 * class field, an injected default parameter, `import fs = require('fs')`. Each
 * round enumerated the routes it could think of, and each was beaten by the next
 * route. That is not two unlucky lists; it is the same instrument twice, and a
 * third list would be the same instrument a third time.
 *
 * The defect they share is the DIRECTION OF PROOF. Both asked "can I prove this
 * callee is fs?", and answered "no" — the safe-looking answer — for every route
 * they did not model. A census whose default is ADMIT is a denylist of routes,
 * which is precisely what `bounded-read.ts`'s own design argument rejects.
 *
 * So this one asks the two questions that have no list in them:
 *
 *   TAINT, not spelling. Anything DERIVED from an fs module expression is fs,
 *   however it was derived — the propagation below follows initializers,
 *   destructures (nested, renamed), assignments, class fields, parameter
 *   defaults, object literals and `Object.assign`, and it does not care which
 *   syntax carried the value. It runs to a fixed point, so a chain of renames is
 *   a chain of taint.
 *
 *   NAME, with the burden inverted. A call whose callee is spelled like a path
 *   read IS ONE unless the receiver can be PROVED to be something else. That
 *   closes every route the taint cannot see — an fs binding injected from
 *   another file, a barrel re-export, a dependency handed in at construction —
 *   because those all still end in a call named `readFileSync`.
 *
 * THE COST WAS MEASURED BEFORE IT WAS ADOPTED, on this tree: 36 calls in
 * production source are spelled like a path read; the resolver flags 16; of the
 * other 20, eighteen are calls this file already proves bounded (a write-only
 * open, an `fstat`-guarded descriptor) and exactly TWO are not fs at all —
 * `coverage.open(dir, rel)` in two plan-guard scanners, a method on a parameter
 * with a local type. Two false positives is what the stronger question costs
 * here, and both are excluded by the proof below rather than by a name in a list.
 */
/** The leftmost identifier of a receiver chain — `a` in `a.b.c`, null otherwise. */
function rootOf(expression: ts.Expression): ts.Identifier | null {
  let root: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  return ts.isIdentifier(root) ? root : null;
}

function bindingsIn(sf: ts.SourceFile): Bindings {
  const namespaces = new Set<string>();
  const direct = new Map<string, string>();
  const containers = new Set<string>();
  const aliased = new Map<string, { api: string; root: ts.Identifier | null }>();

  /** Does this expression EVALUATE to the fs module (or its promises namespace)? */
  const isFsModule = (node: ts.Node): boolean => {
    const spec = requireSpecifier(node);
    if (spec !== null) return FS_SPECIFIERS.has(spec);
    if (ts.isIdentifier(node)) return namespaces.has(node.text);
    if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      return isFsModule(node.expression);
    }
    // `await import('fs')` — the dynamic form of the same import.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      return !!first && ts.isStringLiteralLike(first) && FS_SPECIFIERS.has(first.text);
    }
    // `Object.assign({}, fs)` and `{ ...fs }` — a COPY of the module is the
    // module for every purpose this census has.
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'Object.assign') {
      return node.arguments.some((argument) => isFsModule(argument));
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.some((property) => ts.isSpreadAssignment(property) && isFsModule(property.expression));
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'promises') return isFsModule(node.expression);
    return false;
  };

  /** The fs API this expression evaluates to — `require('fs').readFileSync`. */
  const fsMemberName = (node: ts.Node): string | null => {
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node)) {
      return fsMemberName(node.expression);
    }
    const reflected = reflectGetOnFs(node, isFsModule);
    if (reflected?.key) return reflected.key;
    if (ts.isPropertyAccessExpression(node) && isFsModule(node.expression)) return node.name.text;
    if (ts.isIdentifier(node)) return direct.get(node.text) ?? null;
    return null;
  };

  /** An object holding fs somewhere inside it — `const deps = { fs }`. */
  const isFsContainer = (node: ts.Node): boolean => {
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.some((property) => {
        if (ts.isShorthandPropertyAssignment(property)) return namespaces.has(property.name.text);
        if (ts.isPropertyAssignment(property)) return isFsModule(property.initializer);
        return false;
      });
    }
    if (ts.isIdentifier(node)) return containers.has(node.text);
    return false;
  };

  /** Carry a read NAME onto a local name whose value this file cannot resolve. */
  const alias = (local: string, api: string, root: ts.Identifier | null): boolean => {
    const had = aliased.get(local);
    if (had && had.api === api) return false;
    aliased.set(local, { api, root });
    return true;
  };

  /** Bind a name (or a destructuring pattern) to whatever the value is. */
  const bind = (name: ts.BindingName, value: ts.Expression | undefined): boolean => {
    if (!value) return false;
    let moved = false;
    if (ts.isIdentifier(name)) {
      if (isFsModule(value) && !namespaces.has(name.text)) { namespaces.add(name.text); moved = true; }
      const member = fsMemberName(value);
      if (member && direct.get(name.text) !== member) { direct.set(name.text, member); moved = true; }
      if (isFsContainer(value) && !containers.has(name.text)) { containers.add(name.text); moved = true; }
      // RENAME-AWAY, ROUTE ONE: a read member captured off a receiver the taint
      // cannot resolve — `const rf = deps.readFileSync`. `member` is null exactly
      // when the receiver is not a known fs binding, which is when the CALL on the
      // new name is the only thing left to classify, and it is spelled `rf(p)`.
      if (!member && ts.isPropertyAccessExpression(value) && PATH_READ_NAMES.has(value.name.text)) {
        moved = alias(name.text, value.name.text, rootOf(value.expression)) || moved;
      }
      return moved;
    }
    if (ts.isObjectBindingPattern(name) && (isFsModule(value) || isFsContainer(value))) {
      for (const element of name.elements) {
        const key = element.propertyName ?? element.name;
        if (!ts.isIdentifier(key)) continue;
        // `const { promises: { readFile: rf } } = require('fs')` — the nested
        // pattern is destructuring the SAME module, one level down.
        if (ts.isObjectBindingPattern(element.name)) {
          for (const inner of element.name.elements) {
            const innerKey = inner.propertyName ?? inner.name;
            if (ts.isIdentifier(innerKey) && ts.isIdentifier(inner.name)
              && direct.get(inner.name.text) !== innerKey.text) {
              direct.set(inner.name.text, innerKey.text);
              moved = true;
            }
          }
          continue;
        }
        if (ts.isIdentifier(element.name)) {
          if (isFsContainer(value) && !isFsModule(value)) {
            // Pulling the fs member OUT of a container: `const { fs } = deps`.
            if (!namespaces.has(element.name.text)) { namespaces.add(element.name.text); moved = true; }
            continue;
          }
          if (direct.get(element.name.text) !== key.text) { direct.set(element.name.text, key.text); moved = true; }
        }
      }
    }
    // RENAME-AWAY, ROUTE TWO: `const { readFileSync: rf } = anything`. The KEY names
    // the api and the local name is arbitrary, so neither the taint (the value is
    // not fs) nor the backstop (the callee is spelled `rf`) sees it. Only for values
    // the branch above did NOT handle — where the value IS fs, `direct` owns it.
    if (ts.isObjectBindingPattern(name) && !isFsModule(value) && !isFsContainer(value)) {
      for (const element of name.elements) {
        const key = element.propertyName ?? element.name;
        if (!ts.isIdentifier(key) || !PATH_READ_NAMES.has(key.text)) continue;
        if (ts.isIdentifier(element.name)) moved = alias(element.name.text, key.text, rootOf(value)) || moved;
      }
    }
    return moved;
  };

  // TO A FIXED POINT, because taint flows forward through declarations that were
  // already visited: `const a = require('fs'); const b = a; const c = b.readFileSync`
  // needs three passes, and a file may declare in any order.
  let moved = true;
  for (let pass = 0; moved && pass < 8; pass += 1) {
    moved = false;
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
        && FS_SPECIFIERS.has(node.moduleSpecifier.text) && node.importClause) {
        const clause = node.importClause;
        if (clause.name && !namespaces.has(clause.name.text)) { namespaces.add(clause.name.text); moved = true; }
        const named = clause.namedBindings;
        if (named && ts.isNamespaceImport(named) && !namespaces.has(named.name.text)) {
          namespaces.add(named.name.text);
          moved = true;
        }
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            const api = (element.propertyName ?? element.name).text;
            if (direct.get(element.name.text) !== api) { direct.set(element.name.text, api); moved = true; }
          }
        }
      }
      // RENAME-AWAY, ROUTE THREE: `import { readFileSync as slurp } from '../barrel'`.
      // Corpus row B13 pins the MIRROR of this — a foreign function renamed TO the fs
      // name, caught by the backstop — and the direction where the fs name is what
      // gets renamed AWAY was open, because after the rename nothing in the calling
      // expression is spelled like a read. A NON-renamed named import needs no row
      // here and gets none: `import { open } from './x'; open(p)` is already a bare
      // call spelled like a path read, which the backstop flags today.
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
        && !FS_SPECIFIERS.has(node.moduleSpecifier.text)
        && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          // ONLY the renamed form. Without the rename the callee is still spelled
          // like a path read and the backstop flags it WITH its own exemptions
          // intact (a same-file local function of that name); aliasing it here too
          // would quietly bypass those and change what an unrelated arm measures.
          if (!element.propertyName) continue;
          const imported = element.propertyName.text;
          if (PATH_READ_NAMES.has(imported)) moved = alias(element.name.text, imported, null) || moved;
        }
      }
      // `import fs = require('fs')` — TypeScript's own import-equals form.
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
        && ts.isStringLiteralLike(node.moduleReference.expression)
        && FS_SPECIFIERS.has(node.moduleReference.expression.text)
        && !namespaces.has(node.name.text)) {
        namespaces.add(node.name.text);
        moved = true;
      }
      if (ts.isVariableDeclaration(node)) moved = bind(node.name, node.initializer) || moved;
      // A class field, and a parameter with a default — two places a dependency
      // is injected without a variable declaration anywhere.
      if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
        moved = bind(node.name, node.initializer) || moved;
      }
      if (ts.isParameter(node)) moved = bind(node.name, node.initializer) || moved;
      // `cached = await import('node:fs')` into an already-declared `let`.
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)) {
        moved = bind(node.left, node.right) || moved;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { namespaces, direct, containers, aliased };
}

/**
 * The SCOPE a declaration governs: the function for a parameter, the nearest
 * enclosing block or source file for anything else.
 *
 * Shared by both exemptions below and by nothing else, because both had the same
 * defect and the fix has to be the same shape in both places — this file has now
 * fixed FILE-SCOPED-EXEMPTION three times (round 2's `fstat` guard, round 3's
 * `flags` binding, round 6b's two here) and each fix was written locally.
 */
function scopeOf(declaration: ts.Node): ts.Node | undefined {
  if (ts.isParameter(declaration)) return declaration.parent;
  let node: ts.Node | undefined = declaration;
  while (node && !ts.isBlock(node) && !ts.isSourceFile(node)) node = node.parent;
  return node;
}

/** Does this declaration's scope ENCLOSE this call? What the language asks. */
function enclosesCall(declaration: ts.Node, at: ts.Node): boolean {
  const scope = scopeOf(declaration);
  if (!scope) return false;
  for (let node: ts.Node | undefined = at; node; node = node.parent) if (node === scope) return true;
  return false;
}

/**
 * Is this receiver PROVABLY not fs? The inverted burden of proof, and the only
 * thing standing between the name backstop and an instrument nobody can satisfy.
 *
 * Two proofs, both local and both cheap:
 *   a TYPE ANNOTATION that is not an fs type — `coverage: ScanCoverage`, the one
 *   real over-flag this tree contains, twice;
 *   a DECLARATION IN THIS FILE whose initializer carries no fs taint — the
 *   `const cache = { readFileSync: … }` of the corpus below.
 *
 * Anything else — a bare parameter, an import, `this.x`, a call result — is NOT
 * proved, and is therefore a site. That is the direction the previous two
 * resolvers had backwards.
 *
 * ── THE PROOF WAS FILE-SCOPED, WHICH IS THE THIRD INSTANCE OF ONE CLASS ──────
 * FALSIFIED, ROUND 6b. This function's walk was `visit(sf)` over the WHOLE FILE
 * with no reference to the call being cleared, so a parameter or a `const` of the
 * same name ANYWHERE in the file proved a receiver in ANY other function. Round 2
 * fixed exactly that for the `fstat` guard ("the round-2 guard was file-scoped and
 * admitted exactly that"), round 3 fixed it for the `flags` binding, round 5 left
 * it standing here — and it laundered corpus row B14 (an fs handed in from another
 * module) with two lines of unrelated code: declare `function unrelated(io: Local)`
 * beside it and `io.readFileSync(p)` in the next function is cleared. DRIVEN
 * before the fix (arm `M6`): 0 sites.
 *
 * So the declaration must ENCLOSE THE CALL, which is what the language means by a
 * name being in scope. `at` is the call site and it is not optional.
 */
function provablyNotFs(root: ts.Identifier, bindings: Bindings, sf: ts.SourceFile, at: ts.Node): boolean {
  if (bindings.namespaces.has(root.text) || bindings.containers.has(root.text)) return false;
  let proved = false;
  const mentionsFs = (text: string): boolean => /\b(?:require\s*\(\s*['"]node:)?fs['"]?\b/.test(text);
  const visit = (node: ts.Node): void => {
    if (proved) return;
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === root.text) {
      if (node.type && !mentionsFs(node.type.getText(sf)) && !node.initializer && enclosesCall(node, at)) proved = true;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === root.text) {
      if (node.initializer && !mentionsFs(node.initializer.getText(sf)) && enclosesCall(node, at)) proved = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return proved;
}

/**
 * Is this expression an fs MODULE, however it was bound?
 *
 * Module-level rather than nested inside `resolveFsApi` because the escape
 * detector needs the same answer about a receiver it is NOT calling.
 */
function onFsNamespace(node: ts.Node, bindings: Bindings): boolean {
  const spec = requireSpecifier(node);
  if (spec !== null) return FS_SPECIFIERS.has(spec);
  if (ts.isIdentifier(node)) return bindings.namespaces.has(node.text);
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === 'promises') return onFsNamespace(node.expression, bindings);
    // A MULTI-SEGMENT QUALIFIER — `deps.fs.readFileSync`, where an fs binding
    // was parked on an object (`const deps = { fs }`). Keyed on the PROPERTY
    // NAME matching a binding this file made, which is a heuristic and errs
    // toward flagging: it costs a false positive only in a file that both
    // imports fs and hangs a same-named property off something else. Round 2's
    // scan admitted this shape outright.
    return bindings.namespaces.has(node.name.text);
  }
  // `(fs as any)`, `(fs!)`, `(fs)` — a cast is not a different module.
  if (ts.isParenthesizedExpression(node)) return onFsNamespace(node.expression, bindings);
  if (ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node)) {
    return onFsNamespace(node.expression, bindings);
  }
  return false;
}

/**
 * `Reflect.get(fs, 'readFileSync')` — A MEMBER ACCESS SPELLED AS A CALL, and the
 * one callee shape the three resolvers before this could not classify.
 *
 * `fs[key]` is caught by the computed-member rule and `fs.readFileSync` by the
 * binding walk, but `Reflect.get` moves the receiver into an ARGUMENT, where the
 * resolver — which classifies exactly three callee shapes (identifier, property
 * access, element access) — never looks. It is the same escape family as the round-4
 * captures: the read leaves the classifier without ever being called where the
 * classifier is looking.
 *
 * `{ key: null }` means the key is not a literal, so the api cannot be named. That
 * is a SITE, not an exemption — the same answer the computed-member rule gives, for
 * the same reason: an unclassifiable read on an fs module must default to flagged.
 *
 * `isFs` is a parameter because the two callers hold different halves of the answer
 * (the taint walk's local `isFsModule` while bindings are still being built, and
 * `onFsNamespace` once they are) and duplicating the shape test is what this file
 * spends its rounds undoing.
 */
function reflectGetOnFs(node: ts.Node, isFs: (candidate: ts.Node) => boolean): { key: string | null } | null {
  // A cast is not a different expression, and here it is not optional either:
  // `Reflect.get` returns `any`, so the shape a type-checked codebase actually
  // writes is `(Reflect.get(fs, key) as (p: string) => string)(p)`.
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return reflectGetOnFs(node.expression, isFs);
  }
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'get') return null;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'Reflect') return null;
  const target = node.arguments[0];
  if (!target || !isFs(target)) return null;
  const key = node.arguments[1];
  return { key: key && ts.isStringLiteralLike(key) ? key.text : null };
}

/** The fs API this callee resolves to, or null when it is not an fs call. */
function resolveFsApi(callee: ts.Expression, bindings: Bindings): string | null {
  const reflected = reflectGetOnFs(callee, (candidate) => onFsNamespace(candidate, bindings));
  if (reflected?.key) return reflected.key;
  if (ts.isIdentifier(callee)) return bindings.direct.get(callee.text) ?? null;
  if (ts.isPropertyAccessExpression(callee) && onFsNamespace(callee.expression, bindings)) return callee.name.text;
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
    && onFsNamespace(callee.expression, bindings)) return callee.argumentExpression.text;
  return null;
}

/**
 * The API a READ site resolves to: the binding walk first, then the name.
 *
 * Deliberately NOT used for the `fstat` guard below, which resolves strictly.
 * The two resolutions face opposite ways: a read the census fails to resolve is
 * ADMITTED, so its default must be to flag; a guard it resolves too eagerly is an
 * EXCUSE, so its default must be to withhold. One function with a name backstop
 * for both would have widened the excuse alongside the catch.
 */
function resolveReadApi(callee: ts.Expression, bindings: Bindings, sf: ts.SourceFile): string | null {
  const bound = resolveFsApi(callee, bindings);
  if (bound !== null) return bound;

  // THE RENAME-AWAY ROUTES, resolved BEFORE the name backstop because the whole
  // point of them is that the callee's own name says nothing. The proof that clears
  // a receiver is re-applied here rather than at the binding, so a read name pulled
  // off a LOCAL non-fs object is still cleared (`const rf = cache.readFileSync`),
  // while one pulled out of another module is not: unprovable is a site.
  if (ts.isIdentifier(callee)) {
    const alias = bindings.aliased.get(callee.text);
    if (alias && !(alias.root && provablyNotFs(alias.root, bindings, sf, callee))) return alias.api;
  }

  let name: string | null = null;
  let receiver: ts.Expression | null = null;
  if (ts.isIdentifier(callee)) name = callee.text;
  else if (ts.isPropertyAccessExpression(callee)) { name = callee.name.text; receiver = callee.expression; }
  else if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    name = callee.argumentExpression.text;
    receiver = callee.expression;
  }
  if (name === null || !PATH_READ_NAMES.has(name)) return null;

  // A BARE name that this file declares as an ordinary local function is its
  // own function, not fs — `function readFileSync() {}` shadows nothing here.
  // A bare name it does NOT declare came from somewhere unmodelled, which is
  // exactly the route the taint cannot see, so it stays a site.
  //
  // ── THE SEEK WAS FILE-SCOPED, WHICH IS THE SECOND INSTANCE OF ONE CLASS ────
  // FALSIFIED, ROUND 6b. This walk was `seek(sf)` over the whole file, so a
  // declaration NESTED INSIDE AN UNRELATED FUNCTION cleared every bare read in the
  // file — and it looks like nothing in review, because the nested helper is
  // unrelated by construction. That is the defect round 2 fixed for the `fstat`
  // guard and round 3 fixed for the `flags` binding, in this file, with both fixes
  // named in the comments a few lines from here. DRIVEN before the fix (arm `M1`):
  // the same read that reds on its own returns 0 sites once an unrelated function
  // declares `readFileSync` privately.
  //
  // A VARIABLE declaration counts too, and that half is an over-flag rather than an
  // escape: `const readFileSync = (p: string) => p.length` is as much a local
  // function as the `function` spelling, and the census flagged it. An instrument
  // that cannot be satisfied gets deleted. Deliberately NOT an import binding —
  // corpus row B13 (`import { slurp as readFileSync }`) is a read renamed TO the fs
  // name from a route nothing models, and it must stay a site.
  if (receiver === null) {
    let local = false;
    const seek = (node: ts.Node): void => {
      if (declaresLocalFunction(node, name!) && enclosesCall(node, callee)) local = true;
      ts.forEachChild(node, seek);
    };
    seek(sf);
    return local ? null : name;
  }

  // THE PROOF IS SINGLE-SEGMENT, AND THAT IS ALL IT CAN BE. It reads a type
  // annotation or an initializer off ONE identifier, so it can only speak for a
  // receiver that IS that identifier: `coverage.open(dir, rel)` — the two real
  // over-flags this tree contains — is `coverage` itself, while
  // `deps.io.readFileSync(p)` asks the annotation on `deps` to vouch for the type of
  // `deps.io`, which this file cannot see and TypeScript would not agree it had
  // been told. FALSIFIED, ROUND 6b: the walk took the LEFTMOST identifier of the
  // chain, so one annotated dependency object cleared every read hung off it at any
  // depth (arm `M5`: 0 sites).
  if (ts.isIdentifier(receiver) && provablyNotFs(receiver, bindings, sf, callee)) return null;
  return name;
}

/**
 * Does this node declare `name` as a local function or class — the two things a
 * bare call spelled like a path read may legitimately be?
 *
 * A separate function so the SCOPE test above and the KINDS test here are two
 * decisions rather than one condition; the round-2 and round-3 versions of this
 * launder were both fixed by scoping a test whose kinds nobody re-read.
 */
function declaresLocalFunction(node: ts.Node, name: string): boolean {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text === name;
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.name.text !== name) return false;
  const value = node.initializer;
  return !!value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isClassExpression(value));
}

// ── WHICH CALLS: the two things that make a read bounded ─────────────────────

/**
 * Descriptors this block `fstat`s — trap 1, keyed per identifier AND per
 * enclosing block.
 *
 * The round-2 guard was FILE-scoped, and the round-2 peer showed what that
 * admits: a second function in the same file that opens a descriptor and happens
 * to call it `opened` is excused without any `fstat` of its own. Scoping the
 * guard to the block that contains the `fstat` costs one tree walk and removes
 * the launder, while still not needing a type checker.
 */
function fstatGuardScopes(sf: ts.SourceFile, bindings: Bindings): Map<string, ts.Node[]> {
  const scopes = new Map<string, ts.Node[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const api = resolveFsApi(node.expression, bindings);
      if (api === 'fstatSync' || api === 'fstat') {
        const first = node.arguments[0];
        if (first && ts.isIdentifier(first)) {
          let inner: ts.Node = node;
          while (inner.parent && !ts.isBlock(inner.parent) && !ts.isSourceFile(inner.parent)) inner = inner.parent;
          const block = inner.parent;
          if (block) {
            if (!scopes.has(first.text)) scopes.set(first.text, []);
            scopes.get(first.text)!.push(block);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return scopes;
}

/**
 * An `open` this file can PROVE cannot block on a hostile shape, from its flags.
 *
 * Two proofs and nothing else:
 *   O_NONBLOCK   a FIFO with no writer opens instead of waiting. This is what
 *                `bounded-read.ts` passes, and it is the only proof that makes a
 *                READ open safe.
 *   write-only   `O_WRONLY`, or a `'w'`/`'a'`/`'wx'`/`'ax'` mode string. Not
 *                bounded — it blocks on the reader side instead — but out of
 *                this census's class, per the header of the classification above.
 *
 * The flags expression is resolved through ONE level of same-file `const`
 * binding, which is what `const flags = fs.constants.O_WRONLY | …` and
 * `REGULAR_READ_FLAGS` need. A flags value arriving as a PARAMETER cannot be
 * read from here and is therefore NOT proved — the direction that errs toward
 * flagging, and the reason `bounded-read.ts`'s own inner `readRegular` carries an
 * allowlist row instead of an exemption.
 *
 * SCOPED TO THE CALL, not to the file. Round 3 fixed exactly this launder for the
 * `fstat` guard one function above and left it standing here: a file-wide search
 * for `const flags` lets a bounded declaration in ONE function excuse a
 * same-named unbounded open in ANOTHER, which the round-3 peer planted and the
 * census admitted. A declaration only proves anything about a call it encloses,
 * and when two enclosing scopes both declare the name the nearest one wins —
 * which is what the language does.
 */
function constInitializerText(sf: ts.SourceFile, name: string, at: ts.Node): string | null {
  const enclosing: ts.Node[] = [];
  for (let node: ts.Node | undefined = at; node; node = node.parent) enclosing.push(node);
  let found: string | null = null;
  let bestDepth = -1;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      let scope: ts.Node | undefined = node;
      while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      const depth = scope ? enclosing.indexOf(scope) : -1;
      if (depth >= 0 && (bestDepth < 0 || depth < bestDepth)) {
        bestDepth = depth;
        found = node.initializer.getText(sf);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function isBoundedOpen(sf: ts.SourceFile, call: ts.CallExpression | ts.NewExpression): boolean {
  const flags = call.arguments?.[1];
  if (!flags) return false;
  let text = flags.getText(sf);
  if (ts.isIdentifier(flags)) text = constInitializerText(sf, flags.text, call) ?? text;
  if (/O_NONBLOCK/.test(text)) return true;
  if (/O_WRONLY/.test(text)) return true;
  // `'w'`, `'a'`, `'wx'`, `'ax'` and nothing else. NOT `'a+'` or `'w+'`: the `+`
  // makes the descriptor readable, and `open('a+')` on a FIFO blocks exactly as
  // `'r'` does. Round 3's regex accepted the `+`, which admitted a read.
  return /^\s*['"`][wa]x?['"`]\s*$/.test(text);
}

/**
 * A stream that was handed a DESCRIPTOR does not open the path it was also
 * handed — node ignores `path` entirely when `options.fd` is present, which is
 * how `openRegularFd` + `createReadStream` becomes a bounded stream without a
 * second API in the leaf.
 *
 * The `fd` must come from a CALL, not from a bare identifier or a parameter: a
 * descriptor arriving from somewhere this file cannot see is the same
 * unprovable value the flags rule refuses, and `{ fd }` off a parameter would
 * launder any stream at all.
 */
function isDescriptorStream(sf: ts.SourceFile, call: ts.CallExpression | ts.NewExpression): boolean {
  const options = call.arguments?.[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some((property) => (
    ts.isPropertyAssignment(property)
    && ts.isIdentifier(property.name)
    && property.name.text === 'fd'
    && ts.isCallExpression(property.initializer)
    && /Fd\b|openSync/.test(property.initializer.expression.getText(sf))
  ));
}

// ── the scan ─────────────────────────────────────────────────────────────────

interface Site {
  readonly file: string;
  readonly line: number;
  readonly api: string;
  readonly argument: string;
  readonly code: string;
}

/**
 * Every call in `text` that opens a PATH for reading and is not proved bounded.
 *
 * A pure function of (file name, source text), so the corpus test below can feed
 * it synthetic sources — which is how the round-2 defeat table became a
 * permanent fixture instead of a mutant tree somebody has to rebuild.
 *
 * Comments need no handling at all here. The round-2 scan dropped them with a
 * hand-rolled leading-token test that kept trailing comments in scope "which
 * errs toward flagging"; a parser simply does not produce a call node for prose.
 */
function unboundedSitesIn(file: string, text: string): Site[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const bindings = bindingsIn(sf);
  const guards = fstatGuardScopes(sf, bindings);
  const reads = new Set<string>(PATH_READS);
  const lines = text.split('\n');
  const sites: Site[] = [];

  const guardedAt = (name: string, at: ts.Node): boolean => {
    const blocks = guards.get(name);
    if (!blocks) return false;
    for (let node: ts.Node | undefined = at; node; node = node.parent) if (blocks.includes(node)) return true;
    return false;
  };

  const at = (node: ts.Node, api: string, argument: string): Site => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    return {
      file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
      line,
      api,
      argument,
      code: (lines[line - 1] ?? '').trim().slice(0, 120),
    };
  };

  const visit = (node: ts.Node): void => {
    // ── THE THREE SPELLINGS ROUND 4 ADMITTED, all of them ESCAPES rather than
    // calls: the read leaves this file's classifier without ever being called
    // where the classifier is looking. Round 4's peer found them by inspection
    // and verified each ABSENT from production source, so the cost was zero and
    // the exposure was the next dependency-injection shim.
    //
    // (1) A COMPUTED member on an fs module — `(fs as any)[key](p)`. The name is
    //     not knowable at scan time, so it cannot be classified, and an
    //     unclassifiable read on an fs module is a site: the resolver's default
    //     must be to flag (the same argument as the name backstop). A literal
    //     key still resolves normally and is classified by name, so a computed
    //     WRITE pays a false positive here — the price of not being able to read
    //     a variable, and the reason `argument` records the key expression.
    if (ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression)
      && !ts.isStringLiteralLike(node.expression.argumentExpression)
      && onFsNamespace(node.expression.expression, bindings)) {
      sites.push(at(node, '[computed]', node.expression.argumentExpression.getText(sf).replace(/\s+/g, ' ').slice(0, 80)));
    }
    // The same unclassifiable read with the receiver moved into an ARGUMENT, where
    // the three callee shapes this file classifies do not reach: `Reflect.get(fs,
    // key)(p)`. A LITERAL key resolves normally through `resolveFsApi` and is
    // classified by name; only the computed one lands here.
    if (ts.isCallExpression(node)) {
      const reflected = reflectGetOnFs(node.expression, (candidate) => onFsNamespace(candidate, bindings));
      if (reflected && reflected.key === null) {
        sites.push(at(node, '[computed]', node.expression.getText(sf).replace(/\s+/g, ' ').slice(0, 80)));
      }
    }
    // (2)+(3) A read member REFERENCED WITHOUT BEING CALLED — `promisify(fs.readFile)`,
    //     `const io = { read: fs.readFileSync }`, `obj.read = fs.readFileSync`,
    //     `[fs.readFileSync]`. Whatever the receiver does with it later is out of
    //     this file's sight, so the CAPTURE is the site.
    //
    //     A capture into an IDENTIFIER (`const read = fs.readFileSync`, a
    //     parameter default) is deliberately NOT a site: the taint walk binds
    //     that identifier and flags the CALL, which is the better site to report,
    //     and flagging both would double-count against `EXCUSED`'s exact per-file
    //     `sites` figures.
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && !(node.parent && (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node)) {
      const api = resolveFsApi(node as ts.Expression, bindings);
      const parent = node.parent as ts.Node | undefined;
      const intoIdentifier = !!parent
        && (ts.isVariableDeclaration(parent) || ts.isParameter(parent))
        && ts.isIdentifier(parent.name)
        && parent.initializer === node;
      const inTypePosition = !!parent && (ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent));
      if (api && reads.has(api) && !intoIdentifier && !inTypePosition) {
        sites.push(at(node, api, `CAPTURED: ${node.getText(sf).replace(/\s+/g, ' ').slice(0, 60)}`));
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const api = resolveReadApi(node.expression, bindings, sf);
      if (api && reads.has(api)) {
        const first = node.arguments?.[0];
        const isOpen = api === 'open' || api === 'openSync' || api === 'opendir' || api === 'opendirSync';
        const isStream = api === 'createReadStream' || api === 'ReadStream' || api === 'FileReadStream';
        const guarded = !!first && ts.isIdentifier(first) && !isOpen && guardedAt(first.text, node);
        if (!guarded && !(isOpen && isBoundedOpen(sf, node)) && !(isStream && isDescriptorStream(sf, node))) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          sites.push({
            file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
            line,
            api,
            argument: (first ? first.getText(sf) : '').replace(/\s+/g, ' ').slice(0, 80),
            code: (lines[line - 1] ?? '').trim().slice(0, 120),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

// ── reachability, for labelling only (trap 3) ────────────────────────────────

/**
 * A local specifier to the source file the runtime will load.
 *
 * THE `.js` SPELLING IS NOT OPTIONAL FOR THE ONE BUNDLE THIS CENSUS ARGUES ABOUT,
 * and missing it hid that bundle from the closure entirely. `runners/lighthouse/`
 * compiles to ESM, where a relative import MUST carry the emitted extension, so
 * `index.mts:41` reads `from './lib.js'`. Appending `.ts` to that text looks for
 * `lib.js.ts`, finds nothing, and the resolver answered "not a local import" —
 * with the result that `lighthouse/lib.ts` and `lighthouse/cli-args.ts`, the two
 * files carrying the census's own DRIVEN HANG rows, were reachable from no entry
 * point at all. Measured before the fix: they sat in a six-file residue; after it,
 * four files.
 *
 * The trap-3 readback could not catch this because it names three files and all
 * three are `.ts`. So the mapping is stated for every emitted extension, not for
 * the one that bit: `.js` → `.ts`/`.tsx`, `.mjs` → `.mts`, `.cjs` → `.cts`.
 */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const emitted = /\.(js|mjs|cjs)$/.exec(base);
  const stem = emitted ? base.slice(0, -emitted[0].length) : base;
  const extensions = emitted?.[1] === 'mjs' ? ['.mts']
    : emitted?.[1] === 'cjs' ? ['.cts']
      : ['.ts', '.mts', '.cts', '.tsx'];
  const candidates = [
    ...extensions.map((ext) => `${stem}${ext}`),
    ...extensions.map((ext) => path.join(stem, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Static imports, re-exports, `import()` and `require()` — all four pull a module
 * in, and the last is the one trap 3 is about. By AST for the same reason the
 * scan is: a specifier inside a comment or a template literal is not an import,
 * and round 2's regex could not tell.
 */
function localImportsOf(file: string): string[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specs = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specs.add(node.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specs.add(node.moduleReference.expression.text);
    }
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) specs.add(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const out: string[] = [];
  for (const spec of specs) {
    const resolved = resolveSpec(file, spec);
    if (resolved) out.push(resolved);
  }
  return out;
}

function closureOver(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of localImportsOf(file)) if (!seen.has(next)) stack.push(next);
  }
  return seen;
}

/** The 7 hook entries PLUS every runtime module entry — trap 3. */
function hookEntryPoints(): string[] {
  const entries = fs.readdirSync(path.join(SRC_ROOT, 'hooks'))
    .filter((name) => name.endsWith('-entry.ts'))
    .map((name) => path.join(SRC_ROOT, 'hooks', name));
  const modulesDir = path.join(SRC_ROOT, 'modules');
  for (const dir of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const descriptor = path.join(modulesDir, dir.name, 'module.json');
    if (!fs.existsSync(descriptor)) continue;
    const parsed = JSON.parse(fs.readFileSync(descriptor, 'utf8')) as { kind?: string; entry?: string };
    if (parsed.kind !== 'runtime') continue;
    const entry = path.join(modulesDir, dir.name, `${parsed.entry ?? 'index'}.ts`);
    if (fs.existsSync(entry)) entries.push(entry);
  }
  return entries;
}

/**
 * EVERY entry point the filesystem names, which is what makes the scanned set
 * derived rather than filtered (see `productionSources`).
 *
 * Each row is a `readdir`, never a list of files, so a new hook, a new runtime
 * module or a new runner joins the census the day it is added and nobody has to
 * remember to say so:
 *
 *   hooks + runtime module entries   `hookEntryPoints` above — the hook path,
 *                                    where an unbounded read is worst because a
 *                                    hook that never returns cannot report that
 *                                    it did not.
 *   `src/adapters/**`                a host payload is parsed before any module
 *                                    runs, so every adapter is an entry in the
 *                                    only sense that matters here.
 *   `core/registry.ts`, `pipeline.ts` named explicitly rather than trusted to be
 *                                    reached by a static chain: the registry is
 *                                    the file whose run-time `require` of a
 *                                    `readdir`'d directory IS trap 3.
 *   `src/runners/<id>/index.{ts,mts,cts}` a runner is a separate process a hook, a
 *                                    slash command or a host spawns. A hang
 *                                    there is at least visible, which is why the
 *                                    label below still distinguishes them — but
 *                                    "visible" is not "bounded", and 105 of this
 *                                    tree's production files are reachable ONLY
 *                                    from a runner entry.
 */
function runtimeEntryPoints(): string[] {
  const entries = [...hookEntryPoints()];
  const adapters = path.join(SRC_ROOT, 'adapters');
  // `isTestSource`, deliberately NOT `isProduction`: the floor must not depend on
  // the filter it exists to make unnecessary, and this predicate's exclusions are
  // pinned by set equality below.
  if (fs.existsSync(adapters)) entries.push(...listSources(adapters).filter((file) => !isTestSource(file)));
  for (const core of ['registry.ts', 'pipeline.ts']) {
    const file = path.join(SRC_ROOT, 'core', core);
    if (fs.existsSync(file)) entries.push(file);
  }
  const runnersDir = path.join(SRC_ROOT, 'runners');
  for (const dir of fs.readdirSync(runnersDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const ext of ['.ts', '.mts', '.cts']) {
      const entry = path.join(runnersDir, dir.name, `index${ext}`);
      if (fs.existsSync(entry)) entries.push(entry);
    }
  }
  return entries;
}

function loadableClosure(): Set<string> {
  return closureOver(runtimeEntryPoints());
}

// ── THE ALLOWLIST ────────────────────────────────────────────────────────────

/**
 * One row per FILE that still contains unbounded reads, with the exact COUNT and
 * a one-line reason.
 *
 * KEYED BY FILE AND COUNT RATHER THAN BY LINE, deliberately. A `file:line`
 * allowlist churns on every edit above a site and a maintainer renumbering it
 * learns nothing; the count is what makes this an allowlist rather than the
 * denylist-of-files that was ruled against. Adding a bare read to an
 * already-excused file moves its count and REDS, and so does adding one to a
 * file that is not here.
 *
 * A count that is now too HIGH reds as well. That is not pedantry: it is how a
 * conversion gets recorded, and it keeps the converted/excused split in this
 * file's own header from going the way of `bounded-read.ts`'s caller list.
 *
 * WHAT AN EXCUSE MAY BE, WHICH IS THE PART ROUND 3 GOT WRONG.
 *
 * Round 3 carried 111 sites in 67 rows, and every row was an ARGUMENT: this path
 * is machine-owned, this one is a runner so a hang is at least visible, this one
 * the project cannot reach. The round-3 peer drove six of those rows and FOUR
 * hung — `has-assets.ts` 8010 ms, `codegraph.ts` 8008 ms, `locks.ts` 8004 ms,
 * `tool-classify.ts` 8008 ms, against controls of 171/430/318/291 ms. Not four
 * unlucky rows: reading a call site is exactly what cannot tell a bounded one
 * from an unbounded one, which is the whole reason this lane exists. An excuse
 * written that way is a guess with a citation format.
 *
 * So the excuse is no longer the instrument. ROUTING IS. A site goes through
 * `bounded-read.ts` — where the bound is proved once, for everybody — and the
 * census enforces it from then on; that is cheaper per site than the argument
 * was, and it does not depend on anyone's judgement about who owns a path. The
 * residue is what routing could not reach, and each row here says WHICH:
 *
 *   DRIVEN BOUNDED   the api itself refuses every hostile shape, with the
 *                    elapsed ms and the control that show it (the cpSync rows).
 *   UNCONVERTED      the site HANGS, the remedy is proven, and the conversion is
 *                    deferred — with the driven hang that says how much is being
 *                    deferred (the lighthouse rows).
 *   THE LEAF         the file the others route into, which cannot route
 *                    into itself.
 *
 * THE SECOND KIND USED TO READ "BUILD BLOCKED … and there is no fourth kind", and
 * the false version is recorded here rather than replaced because round 4 already
 * corrected its own rows and left the taxonomy above them contradicting the
 * correction — its peer's MINOR 7. The rows below are not blocked: importing the
 * leaf into that bundle is TS6059, but an in-bundle `O_NONBLOCK`+`fstat`-on-fd
 * reader compiles clean under the same emit config and bounds the reads, DRIVEN.
 * They are UNCONVERTED, deferred for ownership, and the taxonomy now says so, so
 * a reader who takes this docblock at its word is no longer told the opposite of
 * what the rows say.
 *
 * THE KIND IS A FIELD NOW, AND THE THREE KINDS WERE PROSE UNTIL THIS ROUND —
 * which is the half of round 4 its peer took apart. The only thing gating a
 * reason was `reason.trim().length >= 20`, so the peer excused a planted
 * unbounded read with the reason `'xxxxxxxxxxxxxxxxxxxxxx'` and the census said
 * nothing (arm I6, reproduced: 6 pass 0 fail). I added the sharper arm: a reason
 * reading `DRIVEN BOUNDED: this path is machine-owned so nobody will ever plant a
 * FIFO at it` — round 3's exact failure mode, wearing round 4's vocabulary — was
 * ALSO admitted (I8, same result). A taxonomy in a docblock cannot refuse
 * anything.
 *
 * So `kind` is a typed field the compiler checks, and each kind owes EVIDENCE A
 * READER CAN RE-RUN, asserted below:
 *
 *   'the-leaf'      only `bounded-read.ts` may claim it, and only once.
 *   'driven-bounded' the reason must name what the hostile shape DID — an errno
 *                    or an `ERR_FS_*` code, or an elapsed figure in ms — AND a
 *                    CONTROL, because a refusal with no control is a measurement
 *                    of nothing.
 *   'unconverted'   the reason must carry the driven elapsed ms of the hang it
 *                    is NOT fixing, and name the shape that produces it.
 *
 * WHAT THIS TRADE BUYS AND WHAT IT DOES NOT, said plainly because the peer's
 * finding will otherwise be read as closed. It does not make a reason TRUE: a
 * lane can type `8 003 ms, control 58 ms` without running anything, and no
 * textual check can tell that from a measurement. What it does is force the
 * excuse to state a FALSIFIABLE fact — which shape, how long, against what
 * control — so the next round can re-run it and find out, which is exactly how
 * round 4 caught its predecessor's `-p src/runners/lighthouse` citation (it
 * answers TS5057, not TS6059). An argument about who owns a path cannot be
 * re-run, and that is the class this refuses: I6 and I8 both RED now.
 * Deliberately NOT a stricter grammar — a reason still writes as prose, because
 * the honest ones above are prose and an instrument nobody can satisfy gets
 * deleted.
 *
 * A CITATION THAT NAMES A REPO PATH MUST RESOLVE, for the same reason. `.tmp`
 * paths are scratch and are explicitly not checkable; a `src/…` or `tests/…`
 * path in a reason is checked to exist, which is the cheapest guard against the
 * one defect round 4 found in round 3's rows — a citation the next round cannot
 * reproduce because the file it names is not there.
 */
type ExcuseKind = 'the-leaf' | 'driven-bounded' | 'unconverted';

interface Excuse {
  readonly file: string;
  readonly sites: number;
  readonly kind: ExcuseKind;
  readonly reason: string;
}

/**
 * THE RESIDUE IS PINNED EXACTLY AND THE PIN ONLY EVER FALLS.
 *
 * Round 4 asserted `residue <= 20` while standing at 15, i.e. it shipped FIVE
 * SITES OF PREPAID HEADROOM, and the peer spent them: a new production file with
 * five unbounded reads plus one `EXCUSED` row left the census GREEN (arm I4,
 * reproduced). A ceiling with slack is an invitation, and round 3's failure mode
 * — 67 rows of argument — is writable again five sites at a time.
 *
 * The other direction was open too, which the peer did not measure and I did: a
 * REAL CONVERSION that removes a row and leaves the number alone was also GREEN
 * (arm I7, residue 15 → 14). So the ceiling recorded neither growth nor progress.
 *
 * The ledger fixes both by construction. The last row is the pin, an EQUALITY on
 * both figures, so growth reds AND a conversion reds until it is recorded — and
 * the ledger itself must be strictly decreasing in sites and non-increasing in
 * rows, so the only way to raise the pin is to append a bigger number, which reds
 * the descent assertion.
 *
 * THAT IS THE PRICE, AND IT IS DELIBERATE: a lane that genuinely needs a new
 * excused site must either convert one elsewhere or edit this rule in the open,
 * where a reviewer sees the ratchet being loosened. The alternative — a ceiling
 * anybody may drift upward inside — is the instrument that has now failed twice.
 */
const RESIDUE_LEDGER = [
  { round: 3, sites: 111, rows: 67 },
  { round: 4, sites: 15, rows: 7 },
  // Round 6: the two cpSync rows are CONVERTED, not re-argued — `copyTreeStrict`
  // replaces both, so there is no site left to excuse. The ratchet is what makes a
  // conversion visible: without this row the equality below reds, which is the
  // point (round 4's ceiling recorded neither growth nor progress).
  { round: 6, sites: 13, rows: 5 },
  // Round 7: the three ESM-runner rows are CONVERTED — the remedy round 4 proved
  // and round 6 deferred for ownership was taken, so seven measured hangs leave
  // the residue at once. See the block above the rows that used to be here.
  { round: 7, sites: 6, rows: 2 },
] as const;

const EXCUSED: readonly Excuse[] = [
  // ── THE LEAF ITSELF, which cannot route through itself ──────────────────────
  { file: 'src/shared/bounded-read.ts', sites: 5, kind: 'the-leaf', reason: 'THE LEAF: `openBounded` takes its flags as a PARAMETER so no textual check can see the O_NONBLOCK in REGULAR_READ_FLAGS/OWNER_READ_FLAGS; the three readFileSync(fd) calls consume the descriptor it fstat-ed, in a different function than the fstat, which is the one thing the block-scoped guard cannot see; the fifth is the DESTINATION open in copyRegularFile, a write whose O_WRONLY is inside WRITE_FLAGS. Every other row in this file is owed a conversion INTO this one, so it can hold no bound of its own' },

  // ── cpSync: RE-DERIVED IN ROUND 6, AND TWO OF THE THREE ROWS ARE GONE ───────
  //
  // FALSIFIED, ROUND 6. All three rows said, in these words: "node classifies with
  // lstat first and throws ERR_FS_CP_FIFO_PIPE / ERR_FS_CP_SOCKET / ELOOP rather
  // than opening (control: regular file copied)". The round-4 measurement behind it
  // drove the hostile object AS THE SOURCE. Both callers passed a DIRECTORY, and
  // that is a different function of node. Re-driven on v26.5.0, one child per arm
  // under a 6 000 ms parent SIGKILL, `uncaughtException` handler installed
  // (driver `p3-taxonomy.mjs`):
  //
  //   source IS a FIFO             → throws ERR_FS_CP_FIFO_PIPE   (the round-4 arm)
  //   dir CONTAINING a FIFO        → RETURNS SUCCESS in 3 ms, destination MISSING it
  //   dir CONTAINING a unix socket → RETURNS SUCCESS in 0 ms, destination MISSING it
  //   dir CONTAINING a → b → a     → SIGABRT, exit 134, uncaught C++
  //                                  std::filesystem_error out of weakly_canonical,
  //                                  NOT seen by try/catch and NOT seen by the
  //                                  uncaughtException handler
  //   dir with a link to /dev/zero → link recreated, 2 ms (never opened)
  //   dir with a dangling link     → link recreated, 1 ms
  //   dir with a link to ITSELF    → link recreated, 1 ms (no walk, so no loop)
  //
  // So "ELOOP" was the wrong cost by a wide margin — an ELOOP is a caught error and
  // an abort is not survivable at all — and "throws on a FIFO" was the right code
  // for the wrong arm, hiding a SILENT OMISSION in the arm the callers use. Neither
  // is a hang, so neither belonged to this lane's headline; both are worse than the
  // row promised, and a reason that is wrong in the direction of comfort is the
  // defect this ledger was built to stop.
  //
  // The two rows that used to sit here — `gitnexus/bootstrap-env.ts` and
  // `opencode/git-sandbox.ts` — are REMOVED, not corrected: both now call
  // `copyTreeStrict` (`src/shared/copy-tree.ts`), which recreates a symlink instead
  // of walking it (no abort: same loop arm returns in 31 ms) and refuses a FIFO,
  // socket or device by name (no omission). That conversion is why RESIDUE_LEDGER
  // gains a round-6 row at 13 sites / 5 rows.
  //
  // The row that STAYS is bounded for a reason nobody had written down: its
  // `filter` throws on ANY symlink, which is also what stops the walk before the
  // abort. Re-driven through the real function, same driver, `impl=cacheFilter`.
  { file: 'src/runners/doctor/codex-hook-schema.ts', sites: 1, kind: 'driven-bounded', reason: 'copyCacheWithoutSymlinks: cpSync of the plugin cache under <$HOME>/.codex, RE-DRIVEN through the real function in round 6 (impl=cacheFilter), and RE-RUNNABLE at src/shared/__tests__/copy-tree-taxonomy.test.ts, which drives the real function per shape in its own child under a parent SIGKILL. It never blocks and never omits: a FIFO or socket INSIDE the tree throws (ERR_INTERNAL_ASSERTION on v26.5.0 — a node-internal message, but thrown and catchable, not the silent omission plain cpSync gives), a FIFO as the source throws ERR_FS_CP_FIFO_PIPE, and EVERY symlink — including the a->b->a loop that ABORTS plain cpSync with SIGABRT — hits this call\'s own filter refusal first, which is the bound and was never the stated reason. Control: an ordinary directory copies through the same call in 20 ms with the entry present. Cost class is the shim\'s, not the wrappers\': a host-owned install cache under $HOME that no pull request can deliver' },

  // ── THE ESM RUNNER: CONVERTED IN ROUND 7, AND ALL THREE ROWS ARE GONE ───────
  //
  // The rows that used to sit here — `runners/lighthouse/cli-args.ts` (5 sites),
  // `lib.ts` (1) and `index.mts` (1) — are REMOVED because the remedy the
  // paragraphs below PROVED was finally taken, not because the argument improved.
  // `src/runners/lighthouse/bounded-read.ts` is the in-bundle reader this row-set
  // predicted: `O_RDONLY|O_NONBLOCK` plus an `fstat` on the descriptor, importing
  // nothing but `node:fs`, compiling under the same `tsconfig.lighthouse.build.json`
  // with NO build change (re-driven: `npx tsc -p tsconfig.lighthouse.build.json
  // --noEmit`, exit 0). All six synchronous reads call `readRegularText`; the
  // stream takes its descriptor from `openRegularFd`, which is what moves the
  // bound onto the fd where `isDescriptorStream` can see it.
  //
  // RE-DRIVEN BEFORE AND AFTER, one child per (site, shape) under a parent SIGKILL
  // at 8 000 ms, plus the stream through the REAL preview server: the six sync
  // sites sat in `open(2)` at 8 006-8 017 ms on a FIFO and 8 031-8 055 ms on a
  // symlink to /dev/zero, and answer in 239-783 ms now, with every control still
  // parsing (`run-abc`, `app-deadbeef`, `bid-12345`, `pnpm`, the contract's
  // 77/1234/2345/99/0.05, and `true` for output: 'export').
  //
  // THE STREAM ROW WAS RIGHT ABOUT THE HANG AND SILENT ABOUT ITS REACH, which is
  // worth recording because the next reader will otherwise price it wrong.
  // `resolveStaticFile` already asked `statSync(candidate).isFile()`, so a FIFO
  // parked at `index.html` is answered 404 and the stream never opens it: the
  // reachable shape is a SUBSTITUTION between that stat and the stream's own open.
  // Driven that way — a swapper flipping the name while requests are in flight —
  // 10 of the first 40 requests never answered (aborted at a 5 000 ms deadline,
  // one at 11 210 ms) and each wedged a libuv threadpool thread permanently;
  // 60 requests against a stable file answered in 19 ms at worst. After the
  // conversion, 400 racing requests all answered (worst 56 ms): 229 pages, 156
  // 404s, and 15 that hit the window and were REFUSED there — 13 with
  // `not-a-regular-file` from the fstat, 2 with EINVAL from the kernel.
  //
  // ── WHAT THE THREE ROWS SAID, KEPT BECAUSE THE SHAPE OF IT IS THE FINDING ───
  // These compiled under their own `rootDir` for a separate ESM bundle, so
  // importing the leaf fails the build outright:
  //
  //   error TS6059: File 'src/shared/bounded-read.ts' is not under 'rootDir'
  //                 'src/runners/lighthouse'
  //
  // DRIVEN, with the project the error actually comes from
  // (`npx tsc -p tsconfig.lighthouse.build.json`, both with and without
  // `--noEmit`). The citation this row carried before was
  // `-p src/runners/lighthouse`, which cannot produce TS6059 because there is no
  // tsconfig at that path — it answers TS5057. The claim was right and the way to
  // reproduce it was not, which is the same defect as a wrong reason: the next
  // round runs the command, sees a different error, and cannot tell which part was
  // wrong.
  //
  // THE ROWS ALSO SAID THE CONVERSION WAS A BUILD CHANGE. THAT IS FALSE, and it
  // is false in the direction that leaves four measured hangs standing — the same
  // over-flagging that round 3's scaffold-content row was corrected for one
  // paragraph at a time. This census admits any open PROVED BOUNDED BY ITS FLAGS,
  // so a fifteen-line reader inside the bundle — `O_RDONLY|O_NONBLOCK` plus an
  // `fstat` on the descriptor, importing nothing but `node:fs` — satisfies it with
  // no build change at all. DRIVEN in a copy: it compiles clean under that exact
  // build config, and the two hangs below become 61 ms and 57 ms while the
  // controls still answer `true` and `r1`.
  //
  // The rows were then held one more round on the ground that the remedy is a
  // SECOND COPY of the two refusals, which is the thing this file's leaf exists to
  // avoid, and that choosing between one more copy and a build change belonged to
  // the lane owning the bundle. That call has now been made — the copy, because
  // the build change moves every emitted path in the bundle — and it is carried
  // where the last version of this argument can be read: the header of
  // `src/runners/lighthouse/bounded-read.ts`, which states why a duplicate of the
  // leaf's rule lives there and must not be "tidied" into a re-import.
  //
  // ONE FIGURE IN THE OLD STREAM ROW WAS MEASURED SOMEWHERE THE RUNNER CANNOT GO,
  // and correcting it is the reason the re-drive above exists. `4005 ms on a FIFO`
  // came from the bare `createReadStream` expression, not from the server: in the
  // shipped handler `resolveStaticFile` stats every candidate first, so the FIFO is
  // a 404 and the hang needs a substitution between that stat and the open. Still a
  // real hang — 10 of 40 requests, each wedging a threadpool thread — but a
  // different cost class from "a Lighthouse artifact hangs the stream", and a round
  // that took the old figure at face value would have looked for it in the wrong
  // place.
];

// ── the tests ────────────────────────────────────────────────────────────────

test('the fs API classification is TOTAL — no export of node\'s own fs is unclassified', () => {
  // What keeps this from being a fourth denylist of spellings. The census asks
  // "does this call open a path and read it", and that question is only
  // answerable if every fs export has been triaged. A node upgrade that adds a
  // reader, or a spelling built out of an export nobody here thought about,
  // lands as an unclassified name and REDS.
  //
  // Asserted in ONE direction on purpose: every function node exports must be
  // classified. The reverse — a classified name node does not export — is left
  // silent because the two columns are shared across node versions and CI may
  // not run the same one as a developer's machine, so a name that is merely
  // absent here is not evidence of anything.
  const exported = new Set<string>();
  for (const key of Object.keys(fs)) if (typeof (fs as Record<string, unknown>)[key] === 'function') exported.add(key);
  for (const key of Object.keys(fs.promises)) {
    if (typeof (fs.promises as unknown as Record<string, unknown>)[key] === 'function') exported.add(key);
  }
  assert.ok(exported.size > 80, `FIXTURE expected node's fs to export many functions, found ${exported.size}`);

  const classified = new Set<string>([...PATH_READS, ...NOT_PATH_READS]);
  const overlap = PATH_READS.filter((name) => (NOT_PATH_READS as readonly string[]).includes(name));
  assert.deepEqual(overlap, [], 'an api cannot be both a path read and not one');

  const unclassified = [...exported].filter((name) => !classified.has(name)).sort();
  assert.deepEqual(unclassified, [],
    'node\'s fs exports an api this census has never classified. Decide what it DOES: if it opens a path and '
    + 'reads what is at the end of it, it belongs in PATH_READS and every call site needs a bound or a row in '
    + 'EXCUSED; otherwise it belongs in NOT_PATH_READS beside the group that explains why it cannot block. '
    + 'Leaving it out is how a census becomes a denylist of the spellings somebody happened to think of.\n\n'
    + `  ${unclassified.join('\n  ')}`);
});

test('every unbounded read of a PATH in production source is EXCUSED with a reason', () => {
  const files = productionSources();

  // ── WHICH FILES, READ BACK FROM THE DERIVED FLOOR ──────────────────────────
  // The readback this replaces was `files.length > 400` against a tree of 569,
  // i.e. 168 FILES OF SLACK, and the round-4 peer spent it: one line added to
  // `isProduction` dropped `src/modules`, `src/hooks`, `src/shared/state` or
  // `src/core` while a planted unbounded read sat inside the dropped subtree, and
  // the census stayed GREEN on all four (reproduced, plus `src/adapters` and
  // `src/config`: arms C1/C3-C7 GREEN against control C2 RED).
  //
  // So the floor is DERIVED and the containment is asserted rather than the count.
  // Every file the runtime can load from an entry point the filesystem names must
  // be in the scanned set; no edit to `isProduction` can shrink that, because
  // `isProduction` does not build it.
  const floor = loadableClosure();
  const scanned = new Set(files);
  const rootsOf = (paths: Iterable<string>): string[] => [...new Set(
    [...paths].map((file) => path.relative(SRC_ROOT, file).split(path.sep)[0]!),
  )].sort();
  const unscanned = [...floor]
    .filter((file) => !isTestSource(file) && !scanned.has(file))
    .map((file) => path.relative(REPO_ROOT, file))
    .sort();
  assert.deepEqual(unscanned, [],
    'a file the RUNTIME LOADS is not being scanned. The scanned set is the union of the derived floor (the '
    + 'closure of every hook entry, runtime module entry, adapter, core registry/pipeline and runner entry '
    + 'the filesystem names) with the filtered tree, so this can only fail if the union itself was rewritten. '
    + 'Do not answer it by narrowing the closure: six of the seven production roots were silenceable through '
    + `isProduction alone before the floor existed.\n\n  ${unscanned.join('\n  ')}`);

  // AND THE FLOOR'S OWN EXCLUSIONS, BY SET EQUALITY — the same hole one function
  // over. `isTestSource` is the only predicate applied to the floor, so a clause
  // added there could drop a subtree exactly as `isProduction` did; naming the
  // excluded files exactly means such a clause has to delete ninety entries from
  // this list to stay green.
  assert.deepEqual(
    [...floor].filter(isTestSource).map((file) => path.relative(REPO_ROOT, file)).sort(),
    ['src/shared/skill-fallbacks.generated.ts'],
    'the floor is excluding something new. Only the EMITTED fallbacks file is excluded from the closure, and '
    + 'only because it is generated rather than authored — a test file inside the runtime closure would be a '
    + 'finding, not an exclusion to widen.');

  // ── AND THE FILTER'S RULE, RECOMPUTED HERE RATHER THAN TRUSTED ─────────────
  // The floor covers what the runtime can REACH, and the arms that made this
  // necessary planted a read in a file nothing imports — dead today, one `import`
  // from live, and a subtree exclusion swallows the whole directory around it
  // either way. So the filter's rule is stated a second time, in the assertion,
  // in terms of the two primitives that are pinned above and below: `isTestSource`
  // (whose exclusions are set-equal to one generated file) and
  // `NON_PRODUCTION_ROOTS` (which may not name a root the runtime loads from).
  // A clause added to `isProduction` now disagrees with this recomputation and
  // REDS; silencing a subtree takes an edit in two places, one of which is an
  // assertion about the tree rather than a predicate over a path.
  //
  // WHAT THAT DOES NOT COVER, FOUND BY THE ROUND-5 PEER AND KEPT HERE IN PLACE:
  // this recomputation calls `isTestSource` and `listSources`, so it cannot see a
  // change TO `isTestSource` or `listSources` — only one to `isProduction`, which
  // is the level the round-4 attack used. The claim above is true as written and
  // was read as covering more than it says. Three one-line arms went green through
  // it; the assertion that catches them walks the tree with NEITHER predicate and
  // lives in 'WHICH FILES, recomputed from a LISTING this census's own predicates
  // cannot move'.
  const byRule = listSources(SRC_ROOT).filter((file) => {
    if (isTestSource(file)) return false;
    return !NON_PRODUCTION_ROOTS.includes(path.relative(SRC_ROOT, file).split(path.sep)[0]!);
  });
  const dropped = byRule.filter((file) => !scanned.has(file)).map((file) => path.relative(REPO_ROOT, file)).sort();
  assert.deepEqual(dropped, [],
    'a file the DOCUMENTED RULE calls production source is not being scanned, so `isProduction` now says '
    + 'something the rule does not. The rule is exactly two clauses — not a test, not under a non-production '
    + `root — and both are pinned here. Six of seven roots were silenceable through a third clause.\n\n  ${dropped.join('\n  ')}`);

  // AND THE ROOT LIST ITSELF, which is the third place the same edit could hide:
  // `NON_PRODUCTION_ROOTS.push('modules')` would satisfy both checks above at
  // once. It cannot name a root the runtime loads from.
  const smuggled = NON_PRODUCTION_ROOTS.filter((root) => rootsOf(floor).includes(root));
  assert.deepEqual(smuggled, [],
    'a NON-PRODUCTION root is one the runtime loads code from. `build`, `gen`, `test-support` and '
    + 'test-environment` are excluded because a blocking read there hangs a developer\'s own run, which the run '
    + `reports by never finishing; a root inside the runtime closure is production by definition.\n\n  ${smuggled.join(', ')}`);

  // PER-ROOT SET EQUALITY, with no slack at all: the floor must reach every
  // production root. A hostile edit to the ENTRY enumeration (dropping the
  // `module.json` walk, say) leaves the roots it fed empty and reds here even
  // though the filter is untouched.
  assert.deepEqual(rootsOf(floor),
    ['adapters', 'config', 'core', 'hooks', 'modules', 'runners', 'shared'],
    'the derived floor no longer reaches every production root, so the entry enumeration lost a door');

  // The FILTER still contributes, and this is the honest statement of what: the
  // files no entry reaches. Four today, all production, none of them loadable
  // from any entry the filesystem names — which is why the census stays a UNION
  // rather than becoming the closure.
  assert.ok(files.length > 400, `FIXTURE expected the whole production tree, found ${files.length} files`);
  assert.equal(files.some((f) => f.endsWith(`${path.sep}retention.ts`)), true,
    'FIXTURE retention.ts is production source');
  assert.equal(files.some((f) => f.includes(`${path.sep}__tests__${path.sep}`)), false,
    'FIXTURE tests are not production source');

  // FIXTURE READBACK, the second predicate — round 2 scanned `.ts` only, so the
  // module ENTRY of the directory trap 2 is built around was never opened.
  assert.equal(files.some((f) => f.endsWith(`${path.sep}lighthouse${path.sep}index.mts`)), true,
    'FIXTURE the .mts module entry beside cli-args.ts and lib.ts must be scanned');
  const extensions = new Set(files.map((f) => path.extname(f)));
  assert.ok(extensions.has('.mts'), `FIXTURE expected .mts among the scanned extensions, found ${[...extensions]}`);

  const byFile = new Map<string, Site[]>();
  for (const file of files) {
    const sites = unboundedSitesIn(file, fs.readFileSync(file, 'utf8'));
    if (sites.length) byFile.set(path.relative(REPO_ROOT, file).split(path.sep).join('/'), sites);
  }

  // TRAP 1 READBACK — the fd shape really is recognised, only for the identifier
  // that was `fstat`ed, and only inside the block that `fstat`ed it.
  const scaffold = path.join(SRC_ROOT, 'shared', 'architecture-contract', 'scaffold-content.ts');
  const scaffoldText = fs.readFileSync(scaffold, 'utf8');
  assert.equal(
    unboundedSitesIn(scaffold, scaffoldText).some((site) => site.argument === 'opened' && site.api === 'readFileSync'),
    false, 'trap 1: a descriptor that was fstat-guarded must NOT be counted as unbounded');
  assert.equal(
    unboundedSitesIn(scaffold, scaffoldText.replace(/fstatSync\(opened\)/g, 'fstatSync(other)'))
      .some((site) => site.argument === 'opened'), true,
    'trap 1: an fstat on a DIFFERENT descriptor launders nothing');

  // TRAP 2 READBACK — a `readFileSync` imported BY NAME, with no `fs.` prefix, is
  // seen at all. A scan anchored on `fs.readFileSync` finds nothing in this file.
  //
  // THE FIXTURE MOVED IN ROUND 7 AND THE MOVE IS THE POINT. It used to assert
  // `sites.length > 0` in `lighthouse/cli-args.ts` and `lib.ts` — i.e. it was
  // anchored on those two files STILL HANGING, so the conversion that bounded them
  // would have red a readback whose subject is the SCANNER. A positive control
  // that a fix breaks is a control that argues against the fix.
  //
  // So it is anchored on the converted bundle's own reader instead, which still
  // spells the bare call and must now be seen as BOUNDED — and the negative arm is
  // a MUTATION of that same real file, which is the half `sites.length > 0` was
  // buying: break the fstat guard and the bare read must reappear. Same shape as
  // the trap-1 readback above, and it cannot be satisfied by the file merely
  // existing.
  const bundleReader = path.join(SRC_ROOT, 'runners', 'lighthouse', 'bounded-read.ts');
  const bundleText = fs.readFileSync(bundleReader, 'utf8');
  assert.equal(/(?<![\w$.])readFileSync\s*\(/.test(bundleText), true,
    'FIXTURE trap 2: runners/lighthouse/bounded-read.ts calls readFileSync with no fs. prefix');
  assert.deepEqual(unboundedSitesIn(bundleReader, bundleText), [],
    'trap 2: the ESM bundle\'s own reader must be proved bounded from its flags and its fstat — it is the one '
    + 'place in that bundle where a path reaches the kernel, and the six converted call sites are only as '
    + 'bounded as it is');
  assert.ok(
    unboundedSitesIn(bundleReader, bundleText.replace(/fstatSync\(fd\)/g, 'fstatSync(other)'))
      .some((site) => site.api === 'readFileSync' && site.argument === 'fd'),
    'trap 2: a bare imported readFileSync must still be COUNTED when the fstat that guards it is on another '
    + 'descriptor — otherwise the green arm above means only that the scan cannot see this file');
  assert.ok(
    unboundedSitesIn(bundleReader, bundleText.replace(/\| \(constants\.O_NONBLOCK \|\| 0\)/g, ''))
      .some((site) => site.api === 'openSync'),
    'trap 2: dropping O_NONBLOCK from the bundle reader\'s flags must red — O_RDONLY alone waits for a writer '
    + 'on a FIFO, and the fstat cannot help a call that never returns from the open');

  const excusedByFile = new Map(EXCUSED.map((row) => [row.file, row]));
  assert.equal(excusedByFile.size, EXCUSED.length, 'the allowlist must not name a file twice');

  // ── WHAT A REASON MUST CARRY, INSTEAD OF TWENTY CHARACTERS ─────────────────
  // The gate this replaces was `reason.trim().length >= 20`, and the round-4 peer
  // walked through it with `'xxxxxxxxxxxxxxxxxxxxxx'`; I walked through it again
  // with `DRIVEN BOUNDED: this path is machine-owned so nobody will ever plant a
  // FIFO at it`, which is round 3's failure mode wearing round 4's vocabulary
  // (arms I6 and I8, both GREEN before this).
  //
  // Each kind owes a fact a reader can RE-RUN. Not a grammar — the honest reasons
  // above are prose and must stay writable — a MINIMUM: what refused, how long it
  // took, and what the control did. A fabricated figure still passes, and saying
  // so is part of the trade: what this buys is that an excuse now makes a
  // falsifiable claim instead of an unfalsifiable assertion about who owns a path,
  // which is how round 4 caught round 3's unreproducible TS6059 citation.
  const ELAPSED = /\b\d[\d\s\u00a0]*ms\b/;
  const ERRNO = /\b(?:ERR_FS_[A-Z_]+|E[A-Z]{3,})\b/;
  const CONTROL = /\bcontrols?\b/i;
  // ONE regex, TWO uses, so the "must resolve" check and the "must be re-runnable"
  // check below cannot come to disagree about what a citation IS. A figure or a
  // pattern copied into two places stops agreeing with itself — measured twice in
  // this tree — so it is derived here and read from this function in both places.
  const citationsIn = (reason: string): string[] => (
    [...reason.matchAll(/(?:^|[\s(`'"])((?:src|tests)\/[\w./-]*[\w])/g)].map((match) => match[1]!)
  );
  const HOSTILE_SHAPE = /\b(?:FIFO|dev\/zero|dev\/random|socket|dangling|symlink|device|directory)\b/i;
  const LEAF_FILE = 'src/shared/bounded-read.ts';
  const thin: string[] = [];
  for (const row of EXCUSED) {
    const reason = row.reason.trim();
    if (row.kind === 'the-leaf') {
      if (row.file !== LEAF_FILE) thin.push(`${row.file}: only ${LEAF_FILE} may claim kind 'the-leaf'`);
      continue;
    }
    if (row.kind === 'driven-bounded') {
      if (!ERRNO.test(reason) && !ELAPSED.test(reason)) {
        thin.push(`${row.file}: kind 'driven-bounded' with no errno and no elapsed ms — what did the hostile shape DO?`);
      }
      if (!CONTROL.test(reason)) thin.push(`${row.file}: kind 'driven-bounded' with no CONTROL — a refusal with nothing to compare it to measures nothing`);
      // AND THE EVIDENCE MUST BE RE-RUNNABLE, which is the half round 6 was missing.
      // Three of these rows were re-driven this round and every error code in all
      // three was WRONG on the shipped node, while each read as a measurement. What
      // let that stand for two rounds is that the only evidence they cited was a
      // `.tmp` path — scratch, deliberately exempt from the existence check above,
      // and gone with the session that wrote it. A row that names a CHECKED-IN
      // driver can be re-run by the round that inherits it, which is the difference
      // between a claim and a fact somebody can still check.
      if (citationsIn(reason).length === 0) {
        thin.push(`${row.file}: kind 'driven-bounded' citing no re-runnable driver — name the src/ or tests/ file `
          + 'that DRIVES this claim, not only the scratch path of the session that measured it once');
      }
      continue;
    }
    if (!ELAPSED.test(reason)) thin.push(`${row.file}: kind 'unconverted' with no driven elapsed ms — say how much hang is being deferred`);
    if (!HOSTILE_SHAPE.test(reason)) thin.push(`${row.file}: kind 'unconverted' naming no hostile shape — say WHICH object produces the hang`);
  }
  assert.equal(EXCUSED.filter((row) => row.kind === 'the-leaf').length, 1,
    'exactly one row is THE LEAF, and it is the file every other row is owed a conversion into');
  // A CITATION MUST RESOLVE. `.tmp` paths are scratch and deliberately not
  // checkable; a `src/` or `tests/` path in a reason is, and an unreproducible
  // citation is the defect round 4 found in round 3's lighthouse rows.
  for (const row of EXCUSED) {
    for (const cited of citationsIn(row.reason)) {
      assert.equal(fs.existsSync(path.join(REPO_ROOT, cited)), true,
        `${row.file}: the reason cites ${cited}, which does not exist. A citation the next round cannot follow `
        + 'is the same defect as a wrong reason — it sends the reader at a non-defect.');
    }
  }
  assert.deepEqual(thin, [],
    'an EXCUSED row does not carry the evidence its kind owes. The three kinds were prose in round 4 and the '
    + 'only gate was twenty characters, so a planted read was excused by junk and again by an ARGUMENT that '
    + 'merely spelled "DRIVEN BOUNDED" — both admitted. Route the site through bounded-read.ts, or state what '
    + `you measured: the shape, the elapsed ms, the control.\n\n  ${thin.join('\n  ')}`);

  // THE RESIDUE IS PINNED EXACTLY, AND THE PIN ONLY FALLS.
  //
  // What this replaces was `residue <= 20` asserted while the tree stood at 15 —
  // five sites of prepaid headroom, and the round-4 peer spent all five: a new
  // production file with FIVE unbounded reads plus one `EXCUSED` row left the
  // census GREEN (arm I4, reproduced). The same ceiling was silent in the other
  // direction too, which nobody had measured: a real conversion that removes a row
  // and leaves the number alone was GREEN as well (arm I7, residue 15 → 14), so
  // the "ceiling" recorded neither a regression nor progress.
  //
  // Both figures are equalities against the ledger's last row, so growth reds and
  // an unrecorded conversion reds; and the ledger must DESCEND, so raising the pin
  // means appending a bigger number and taking that argument in the open. The
  // price is real and deliberate: a lane with a genuinely new excused site must
  // convert one elsewhere or loosen this rule visibly. A ceiling anybody may drift
  // upward inside is the instrument that has now failed twice.
  const descent: string[] = [];
  for (const [index, row] of RESIDUE_LEDGER.entries()) {
    const previous = RESIDUE_LEDGER[index - 1];
    if (!previous) continue;
    if (row.sites >= previous.sites) descent.push(`round ${row.round}: ${row.sites} sites is not fewer than round ${previous.round}'s ${previous.sites}`);
    if (row.rows > previous.rows) descent.push(`round ${row.round}: ${row.rows} rows is more than round ${previous.round}'s ${previous.rows}`);
  }
  assert.deepEqual(descent, [],
    'THE RATCHET ONLY TIGHTENS. RESIDUE_LEDGER must fall in sites and never rise in rows: the residue is what '
    + 'routing could not reach, and a round that needs MORE of it is a round that has started excusing again. '
    + 'If that is genuinely the right call, say so here in prose and take the argument — do not append the '
    + `number quietly.\n\n  ${descent.join('\n  ')}`);
  assert.ok(RESIDUE_LEDGER.length >= 2, 'FIXTURE the ledger records the descent, not just today');

  const pin = RESIDUE_LEDGER[RESIDUE_LEDGER.length - 1]!;
  const residue = EXCUSED.reduce((total, row) => total + row.sites, 0);
  assert.deepEqual({ sites: residue, rows: EXCUSED.length }, { sites: pin.sites, rows: pin.rows },
    `the excused residue is ${residue} sites in ${EXCUSED.length} files and the ledger pins `
    + `${pin.sites} in ${pin.rows}. UP means a lane has started excusing again — round 3 stood at 111 sites in `
    + '67 rows and four of the six rows its peer drove HUNG at ~8 s against ~300 ms controls, because each row '
    + 'was an argument about who owns a path rather than a measurement. DOWN means a conversion landed and was '
    + 'not recorded: append a row to RESIDUE_LEDGER, which is the only way the ratchet tightens. Either way the '
    + 'number is not the fix — routing the site through bounded-read.ts is.');

  const hookReachable = closureOver(hookEntryPoints());
  // TRAP 3 READBACK — the closure follows `require()` through the runtime module
  // registry. Omitting the module entries hid exactly these.
  //
  // IT USED TO PIN ONLY THE LABEL, which is the round-4 peer's NIT 8 and was fair:
  // `closureOver` was independent of the file selection, so the arms that dropped
  // whole subtrees left this green and the readback protected the WORD
  // "HOOK-REACHABLE" rather than the scanning of those 63 sites. Now the floor is
  // the scanned set (see `productionSources`), so a closure that loses a door loses
  // the files as well, and both are asserted: these three by name here, every root
  // by set equality above.
  for (const hidden of ['shared/retention.ts', 'shared/codegraph.ts', 'modules/plan-guard/index.ts']) {
    const absolute = path.join(REPO_ROOT, 'src', hidden);
    assert.equal(hookReachable.has(absolute), true,
      `FIXTURE trap 3: ${hidden} must be hook-reachable — a closure that misses it undercounts by 63 sites`);
    assert.equal(scanned.has(absolute), true, `FIXTURE trap 3: ${hidden} must be SCANNED, not merely labelled`);
  }
  // The ESM bundle's own internals, which the resolver could not see until this
  // round: `index.mts` imports `./lib.js`, the spelling ESM requires, so the two
  // files carrying this census's DRIVEN HANG rows were reachable from no entry at
  // all. Pinned by name because the three rows above are all `.ts` and could not
  // have caught it.
  for (const esm of ['runners/lighthouse/lib.ts', 'runners/lighthouse/index.mts']) {
    assert.equal(floor.has(path.join(REPO_ROOT, 'src', esm)), true,
      `FIXTURE the ESM bundle must be reachable: ${esm} — a resolver that cannot follow './lib.js' loses it`);
  }
  const label = (file: string): string => (
    hookReachable.has(path.join(REPO_ROOT, file)) ? 'HOOK-REACHABLE' : 'runner/other'
  );

  const unexcused: string[] = [];
  const stale: string[] = [];
  for (const [file, sites] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    const row = excusedByFile.get(file);
    if (!row) {
      unexcused.push(`  { file: '${file}', sites: ${sites.length}, reason: '' }, // ${label(file)}\n`
        + sites.map((site) => `      ${file}:${site.line}  ${site.api}  ${site.code}`).join('\n'));
      continue;
    }
    if (row.sites !== sites.length) {
      stale.push(`${file}: allowlist says ${row.sites}, found ${sites.length} — ${label(file)}\n`
        + sites.map((site) => `      ${site.line}  ${site.api}  ${site.code}`).join('\n'));
    }
  }
  for (const row of EXCUSED) {
    if (!byFile.has(row.file)) stale.push(`${row.file}: allowlist says ${row.sites}, found NONE — delete the row`);
  }

  assert.deepEqual(
    unexcused, [],
    `${unexcused.length} production file(s) open a path for reading with no bound and are not in EXCUSED.\n`
    + 'open(O_RDONLY) on a FIFO waits for a writer forever and a character device answers a read as long as '
    + 'anybody keeps asking, so on those two shapes this call NEVER RETURNS — in a hook that means no deny, '
    + 'no timeout and no decision record, the outcome this codebase ranks below failing closed. Route the read '
    + 'through shared/bounded-read.ts (readRegularFile / readRegularFileResult / readOwnerEntry), or add the '
    + 'file to EXCUSED with a one-line reason saying why the shape cannot arrive there or why the cost is '
    + `accepted.\n\n${unexcused.join('\n')}`,
  );

  assert.deepEqual(
    stale, [],
    'the allowlist counts no longer match the tree. A count that went UP is a new unbounded read in a file '
    + 'that was already excused for other reasons — the reason on the row was not written about this site, so '
    + 'read it before raising the number. A count that went DOWN is a conversion, and lowering it is how the '
    + `conversion gets recorded.\n\n${stale.join('\n')}`,
  );
});

// ── the round-2 defeat table, as a permanent fixture ─────────────────────────

/**
 * Every spelling the round-2 peer planted, with the verdict its census returned.
 * ELEVEN of these were GREEN — admitted, undetected — and four of those the peer
 * drove to SIGKILL at ~8 s against a FIFO or a `/dev/zero` link.
 *
 * They are synthetic sources rather than a mutant tree because `unboundedSitesIn`
 * is a pure function of (name, text): the corpus costs milliseconds, cannot drift
 * away from the scanner, and does not need a copy of the repository to re-run.
 * That is the half of the anti-vacuity argument the allowlist cannot make — the
 * allowlist proves the scan still FINDS what it excuses, and this proves the
 * UNEXCUSED path reds, for spellings nothing in the tree uses today.
 */
interface Spelling {
  readonly id: string;
  readonly round2: 'RED' | 'GREEN';
  readonly source: string;
  /**
   * The 1-based line that must be the one flagged, for arms where "some site was
   * found" is too weak an answer.
   *
   * B01 is why this exists. It plants a bounded `flags` in one function and an
   * unbounded one in another, and the mutant that reverts the scoping to
   * file-wide SWAPS which of the two is flagged rather than flagging neither —
   * so the site count stays at one and an arm that only counted sites SURVIVED
   * the mutation. Measured, not reasoned about: mutation M2 came back `fail=0`
   * before this field existed.
   */
  readonly at?: number;
  /**
   * The EXACT number of sites this spelling must yield, for arms where flagging
   * it twice is its own defect (C05: the capture rule must not double-count an
   * ordinary alias, because `EXCUSED` pins per-file counts exactly).
   */
  readonly sites?: number;
}

const SPELLINGS: readonly Spelling[] = [
  { id: 'A01 fs.readFileSync', round2: 'RED', source: 'import * as fs from \'fs\';\nexport const f = (p: string) => fs.readFileSync(p, \'utf8\');\n' },
  { id: 'A02 named import, bare call', round2: 'RED', source: 'import { readFileSync } from \'fs\';\nexport const f = (p: string) => readFileSync(p, \'utf8\');\n' },
  { id: 'A03 destructured require', round2: 'RED', source: 'const { readFileSync } = require(\'fs\');\nexport const f = (p: string) => readFileSync(p, \'utf8\');\n' },
  { id: 'A04 aliased import', round2: 'GREEN', source: 'import { readFileSync as rf } from \'fs\';\nexport const f = (p: string) => rf(p, \'utf8\');\n' },
  { id: 'A05 fsp namespace from fs/promises', round2: 'GREEN', source: 'import * as fsp from \'fs/promises\';\nexport const f = (p: string) => fsp.readFile(p, \'utf8\');\n' },
  { id: 'A06 fs.promises.readFile', round2: 'GREEN', source: 'import * as fs from \'fs\';\nexport const f = async (p: string) => await fs.promises.readFile(p, \'utf8\');\n' },
  { id: 'A07 callback readFile', round2: 'GREEN', source: 'import * as fs from \'fs\';\nexport const f = (p: string) => fs.readFile(p, () => undefined);\n' },
  { id: 'A08 inline require(\'fs\') — the HOUSE IDIOM', round2: 'GREEN', source: 'export const f = (p: string) => require(\'fs\').readFileSync(p, \'utf8\');\n' },
  { id: 'A09 two-segment qualifier', round2: 'GREEN', source: 'import * as fs from \'fs\';\nconst deps = { fs };\nexport const f = (p: string) => deps.fs.readFileSync(p);\n' },
  { id: 'A10 readFileSync(fd) with NO fstat', round2: 'RED', source: 'import * as fs from \'fs\';\nexport const f = (p: string) => { const fd = fs.openSync(p, \'r\'); return fs.readFileSync(fd, \'utf8\'); };\n' },
  { id: 'A11 fstat on a DIFFERENT fd', round2: 'RED', source: 'import * as fs from \'fs\';\nexport const f = (p: string, other: number) => { const fd = fs.openSync(p, \'r\'); fs.fstatSync(other); return fs.readFileSync(fd, \'utf8\'); };\n' },
  { id: 'A12 fd laundered by NAME REUSE across functions', round2: 'GREEN', source: 'import * as fs from \'fs\';\nexport function guarded(p: string) { const opened = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); if (fs.fstatSync(opened).isFile()) return fs.readFileSync(opened, \'utf8\'); return null; }\nexport function laundered(p: string) { const opened = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); return fs.readFileSync(opened, \'utf8\'); }\n' },
  { id: 'A18 openSync + readSync clipped reader', round2: 'GREEN', source: 'import * as fs from \'fs\';\nexport const f = (p: string) => { const fd = fs.openSync(p, \'r\'); const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); return b; };\n' },
  { id: 'A19 createReadStream', round2: 'GREEN', source: 'import * as fs from \'fs\';\nexport const f = (p: string) => fs.createReadStream(p);\n' },
  { id: 'A20 default import from node:fs', round2: 'RED', source: 'import fs from \'node:fs\';\nexport const f = (p: string) => fs.readFileSync(p, \'utf8\');\n' },
  { id: 'A21 a tiny local helper', round2: 'RED', source: 'import * as fs from \'fs\';\nconst slurp = (p: string) => fs.readFileSync(p, \'utf8\');\nexport const f = (p: string) => slurp(p);\n' },
  { id: 'element access off the namespace', round2: 'GREEN', source: 'import * as fs from \'fs\';\nexport const f = (p: string) => fs[\'readFileSync\'](p, \'utf8\');\n' },
  { id: 'copyFileSync from a hostile SOURCE', round2: 'GREEN', source: 'import * as fs from \'fs\';\nexport const f = (a: string, b: string) => fs.copyFileSync(a, b);\n' },

  // ── the ROUND-3 defeat table: fourteen spellings its binding walk admitted ──
  // Round 3 answered round 2's eleven with a binding walk and was beaten by
  // these. They are here for the record and as regression fixtures, but the
  // reason they are caught is NOT that they were enumerated — the taint
  // propagation and the name backstop above close routes nobody has thought of
  // yet, which is the only property that survived two previous lists.
  { id: 'B01 file-scoped `flags` launder — the exact class round 3 fixed for fstat and left here', round2: 'GREEN', at: 3, source: 'import * as fs from \'fs\';\nexport function safe(p: string) { const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK; return fs.openSync(p, flags); }\nexport function unsafe(p: string) { const flags = fs.constants.O_RDONLY; return fs.openSync(p, flags); }\n' },
  { id: 'B02 namespace parked on an object property', round2: 'GREEN', source: 'const mod = { fs: require(\'fs\') };\nexport const f = (p: string) => mod.fs.readFileSync(p, \'utf8\');\n' },
  { id: 'B03 Object.assign over the module', round2: 'GREEN', source: 'import * as real from \'fs\';\nconst shim = Object.assign({}, real);\nexport const f = (p: string) => shim.readFileSync(p, \'utf8\');\n' },
  { id: 'B04 spread copy of the module', round2: 'GREEN', source: 'import * as real from \'fs\';\nconst shim = { ...real };\nexport const f = (p: string) => shim.readFileSync(p, \'utf8\');\n' },
  { id: 'B05 await import', round2: 'GREEN', source: 'export async function f(p: string) { const mod = await import(\'node:fs\'); return mod.readFileSync(p, \'utf8\'); }\n' },
  { id: 'B06 await import assigned to an outer let', round2: 'GREEN', source: 'let cached: typeof import(\'fs\') | null = null;\nexport async function f(p: string) { cached = await import(\'fs\'); return cached.readFileSync(p, \'utf8\'); }\n' },
  { id: 'B07 nested destructure with a rename', round2: 'GREEN', source: 'const { promises: { readFile: grab } } = require(\'fs\');\nexport const f = (p: string) => grab(p, \'utf8\');\n' },
  { id: 'B08 class field holding the module', round2: 'GREEN', source: 'import * as fs from \'fs\';\nexport class Reader { private io = fs; read(p: string) { return this.io.readFileSync(p, \'utf8\'); } }\n' },
  { id: 'B09 injected dependency as a default parameter', round2: 'GREEN', source: 'export function make(read = require(\'fs\').readFileSync) { return (p: string) => read(p, \'utf8\'); }\n' },
  { id: 'B10 import fs = require(\'fs\')', round2: 'GREEN', source: 'import fs = require(\'fs\');\nexport const f = (p: string) => fs.readFileSync(p, \'utf8\');\n' },
  { id: 'B11 the \'a+\' mode, which is READABLE', round2: 'GREEN', source: 'import * as fs from \'fs\';\nexport const f = (p: string) => fs.openSync(p, \'a+\');\n' },
  { id: 'B12 the \'r+\' mode', round2: 'GREEN', source: 'import * as fs from \'fs\';\nexport const f = (p: string) => fs.openSync(p, \'r+\');\n' },
  { id: 'B13 a rename through a route nothing models — the NAME BACKSTOP', round2: 'GREEN', source: 'import { slurp as readFileSync } from \'../elsewhere\';\nexport const f = (p: string) => readFileSync(p, \'utf8\');\n' },
  { id: 'B14 an fs handed in from another module entirely', round2: 'GREEN', source: 'import { io } from \'../deps\';\nexport const f = (p: string) => io.readFileSync(p, \'utf8\');\n' },
  { id: 'B15 a re-export barrel', round2: 'GREEN', source: 'import { readFileSync } from \'../fs-barrel\';\nexport const f = (p: string) => readFileSync(p, \'utf8\');\n' },
  { id: 'B16 a descriptor stream whose fd is a bare parameter', round2: 'GREEN', source: 'import * as fs from \'fs\';\nexport const f = (p: string, fd: number) => fs.createReadStream(p, { fd });\n' },
  { id: 'B17 opendirSync, which opens a path like any other', round2: 'GREEN', source: 'import * as fs from \'fs\';\nexport const f = (p: string) => fs.opendirSync(p);\n' },
  { id: 'B18 cp of a hostile SOURCE tree', round2: 'GREEN', source: 'import * as fs from \'fs\';\nexport const f = (a: string, b: string) => fs.cp(a, b, () => undefined);\n' },
  // A TWO-HOP CHAIN, DECLARED AFTER USE, which is what the taint loop is FOR.
  // Added because mutation M5 — capping the propagation at a single pass —
  // survived the whole corpus: every other arm binds in one traversal, so the
  // fixed point was load-bearing in principle and dead in practice. Here the
  // first pass learns only `alias`, the second learns `later` from it, and until
  // it does, `later`'s initializer mentions no fs and `provablyNotFs` clears the
  // call outright.
  { id: 'B19 a two-hop rename chain declared after its use', round2: 'GREEN', at: 1, source: 'export const f = (p: string) => later.readFileSync(p, \'utf8\');\nconst later = alias;\nconst alias = require(\'fs\');\n' },

  // ── the ROUND-4 defeat table: three spellings ITS scan admitted ─────────────
  // Found by round 4's peer, by inspection, and verified ABSENT from production
  // source at the time (no `promisify`, no aliased fs import, no `fs/promises`
  // binding anywhere) — so the cost was zero and the exposure was the next
  // dependency-injection shim. All three are ESCAPES: the read leaves the
  // classifier without being called where the classifier looks. Caught now by
  // the capture rule and the computed-member rule in `unboundedSitesIn`.
  { id: 'C01 a COMPUTED member off the fs namespace', round2: 'GREEN', at: 2, source: 'import * as fs from \'fs\';\nexport const f = (p: string, key: string) => (fs as any)[key](p, \'utf8\');\n' },
  { id: 'C02 promisify of a read member', round2: 'GREEN', at: 3, source: 'import * as fs from \'fs\';\nimport { promisify } from \'util\';\nconst read = promisify(fs.readFile);\nexport const f = (p: string) => read(p, \'utf8\');\n' },
  { id: 'C03 a read member RENAMED onto an object property', round2: 'GREEN', at: 2, source: 'import * as fs from \'fs\';\nconst io = { read: fs.readFileSync };\nexport const f = (p: string) => io.read(p, \'utf8\');\n' },
  { id: 'C04 a read member ASSIGNED onto an existing object', round2: 'GREEN', at: 3, source: 'import * as fs from \'fs\';\nconst io: { read?: unknown } = {};\nio.read = fs.readFileSync;\nexport const f = (p: string) => (io.read as (p: string) => string)(p);\n' },
  // The capture rule's OTHER half, and the reason it exempts identifiers: this
  // shape must be flagged EXACTLY ONCE, at the call on line 3. Flagging the
  // capture too would double-count every ordinary alias against `EXCUSED`'s
  // per-file `sites` figures, which are exact — so the pin is the COUNT.
  { id: 'C05 a capture into an IDENTIFIER — the CALL is the site, and only that', round2: 'RED', at: 3, sites: 1, source: 'import * as fs from \'fs\';\nconst read = fs.readFileSync;\nexport const f = (p: string) => read(p, \'utf8\');\n' },

  // ── the ROUND-6b table: the ESCAPES OF THE EXEMPTIONS THEMSELVES ────────────
  // Round 5 closed the routes a VALUE can take to a call. These are the routes the
  // two EXEMPTIONS take to clearing one, plus the two shapes where the read NAME
  // survives only as a key. Every row is compilable TypeScript with a real read in
  // it, and every one returned ZERO SITES against the shipped scanner before the
  // change beside it (DRIVEN).
  //
  // PROVENANCE IS MARKED, and it is not decoration. `[peer]` rows were enumerated
  // by the round-5 peer review this round answers; `[mine]` rows I derived from the
  // reader code — a corpus that shares an author with the matcher reproduces the
  // matcher, so what the round found by ITSELF is worth stating separately. Two of
  // the three `[mine]` rows are the FILE-SCOPED-EXEMPTION class in a place nobody
  // had looked (`provablyNotFs`) and the OVER-flag mirror of the fix for it.
  //
  // D01 IS THE THIRD INSTANCE OF ONE DEFECT IN THIS FILE. Round 2 fixed a
  // file-scoped `fstat` guard; round 3 fixed a file-scoped `flags` binding and said
  // so in a comment forty lines above the file-scoped `seek` it left; round 5 added
  // six assertions that all rest on it. The launder is invisible in review because
  // the nested helper is unrelated by construction — that is the whole mechanism.
  { id: 'D01 [peer S1] a NESTED same-name declaration launders every bare read in the file', round2: 'GREEN', at: 3, source: 'import { readFileSync } from \'../fs-barrel\';\nexport function unrelated(n: number) { function readFileSync(x: number) { return x + 1; } return readFileSync(n); }\nexport const f = (p: string) => readFileSync(p, \'utf8\');\n' },
  { id: 'D02 [peer S5] a named import renamed AWAY from the fs name — B13\'s mirror', round2: 'GREEN', at: 2, sites: 1, source: 'import { readFileSync as slurp } from \'../fs-barrel\';\nexport const f = (p: string) => slurp(p, \'utf8\');\n' },
  { id: 'D03 [peer S4] a destructure whose KEY is the read name, renamed away', round2: 'GREEN', at: 3, sites: 1, source: 'import { bar } from \'../deps\';\nconst { readFileSync: rf } = bar;\nexport const f = (p: string) => rf(p, \'utf8\');\n' },
  { id: 'D04 [mine] a read member CAPTURED off an unresolvable receiver and renamed', round2: 'GREEN', at: 3, sites: 1, source: 'import { deps } from \'../deps\';\nconst rf = deps.readFileSync;\nexport const f = (p: string) => rf(p, \'utf8\');\n' },
  { id: 'D05 [peer S2] a MULTI-SEGMENT receiver cleared by the annotation on its ROOT', round2: 'GREEN', at: 2, source: 'interface Deps { io: { readFileSync(p: string, e: string): string } }\nexport const f = (deps: Deps, p: string) => deps.io.readFileSync(p, \'utf8\');\n' },
  { id: 'D06 [mine] the RECEIVER PROOF was file-scoped too — an unrelated function\'s parameter clears B14', round2: 'GREEN', at: 3, source: 'import { io } from \'../deps\';\nexport function unrelated(io: { helper(): void }) { io.helper(); }\nexport const f = (p: string) => io.readFileSync(p, \'utf8\');\n' },
  { id: 'D07 [peer S3] Reflect.get with a COMPUTED key — a member access spelled as a call', round2: 'GREEN', at: 2, source: 'import * as fs from \'fs\';\nexport const f = (p: string, key: string) => (Reflect.get(fs, key) as (p: string, e: string) => string)(p, \'utf8\');\n' },
  { id: 'D08 [mine] Reflect.get with a LITERAL key — classified by name, counted ONCE', round2: 'GREEN', at: 2, sites: 1, source: 'import * as fs from \'fs\';\nexport const f = (p: string) => Reflect.get(fs, \'readFileSync\')(p, \'utf8\');\n' },
];

/** Sources that must stay GREEN — an over-flagging census is a census nobody keeps. */
const NOT_A_READ: readonly { readonly id: string; readonly source: string }[] = [
  { id: 'the same name on something that is not fs', source: 'const cache = { readFileSync: (p: string) => p };\nexport const f = (p: string) => cache.readFileSync(p);\n' },
  { id: 'a readFileSync inside a template literal this module EMITS', source: 'export const shim = `const fs = require(\'fs\');\\nfs.readFileSync(process.argv[2], \'utf8\');\\n`;\n' },
  { id: 'a readFileSync named in prose', source: '// fs.readFileSync(p) is what this module deliberately does NOT do.\nexport const f = 1;\n' },
  { id: 'an fstat-guarded descriptor, in the same block', source: 'import * as fs from \'fs\';\nexport function f(p: string) { const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); if (!fs.fstatSync(fd).isFile()) return null; return fs.readFileSync(fd, \'utf8\'); }\n' },
  { id: 'an O_NONBLOCK open', source: 'import * as fs from \'fs\';\nexport const f = (p: string) => fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);\n' },
  { id: 'an exclusive-create open, which cannot block', source: 'import * as fs from \'fs\';\nexport const f = (p: string) => fs.openSync(p, \'wx\');\n' },
  { id: 'a write-only open — a different class, named as such', source: 'import * as fs from \'fs\';\nexport function f(p: string) { const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT; return fs.openSync(p, flags); }\n' },
  { id: 'metadata only', source: 'import * as fs from \'fs\';\nexport const f = (p: string) => fs.existsSync(p) && fs.statSync(p).isFile() && fs.readdirSync(p).length > 0;\n' },

  // ── what the NAME BACKSTOP must not cost ────────────────────────────────────
  // The backstop flags any call spelled like a path read unless the receiver is
  // PROVED to be something else, and these are the two proofs. Both were
  // measured against this tree before the rule was adopted: of 36 calls spelled
  // like a path read, the resolver already bound 16 and eighteen more are opens
  // this file proves bounded; the residue was exactly TWO — `coverage.open(dir,
  // rel)` in the plan-guard scanners, a method on a parameter with a local type.
  // If either proof is weakened the census starts flagging those, and an
  // instrument nobody can satisfy gets deleted.
  { id: 'a method on a parameter with a NON-fs type annotation', source: 'interface Coverage { open(dir: string, rel: string): void }\nexport const f = (coverage: Coverage, dir: string, rel: string) => coverage.open(dir, rel);\n' },
  { id: 'a same-file local function that happens to share the name', source: 'function readFileSync(p: string) { return p.length; }\nexport const f = (p: string) => readFileSync(p);\n' },
  { id: 'a descriptor stream whose fd came from a bounded open', source: 'import * as fs from \'fs\';\nimport { openRegularFd } from \'./bounded-read\';\nexport const f = (p: string) => fs.createReadStream(p, { fd: openRegularFd(p), autoClose: true });\n' },
  { id: 'a write-only open declared in ANOTHER function, not laundering this one', source: 'import * as fs from \'fs\';\nexport function w(p: string) { const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT; return fs.openSync(p, flags); }\nexport function w2(p: string) { const flags = fs.constants.O_WRONLY; return fs.openSync(p, flags); }\n' },

  // ── what the CAPTURE rule must not cost ─────────────────────────────────────
  // It fires on a read member referenced without being called, so these are the
  // references it must leave alone or every file that touches fs at all reds.
  { id: 'a NON-read member captured — writes are a different census', source: 'import * as fs from \'fs\';\nexport const w = { write: fs.writeFileSync, exists: fs.existsSync };\n' },
  { id: 'a metadata member handed to a helper', source: 'import * as fs from \'fs\';\nexport const f = (walk: (s: (p: string) => unknown) => void) => walk(fs.statSync);\n' },
  { id: 'a computed member on something that is NOT fs', source: 'const api: Record<string, (p: string) => string> = {};\nexport const f = (p: string, key: string) => api[key](p);\n' },
  { id: 'a computed WRITE member on fs, spelled as a literal — still classified by name', source: 'import * as fs from \'fs\';\nexport const f = (p: string, d: string) => fs[\'writeFileSync\'](p, d);\n' },

  // ── what the ROUND-6b tightenings must not cost ─────────────────────────────
  // Every escape closed above narrows an exemption, and an exemption narrowed too
  // far flags honest code — which is how an instrument gets deleted. These are the
  // three answers that had to stay GREEN, and the first is a defect of the OLD rule
  // rather than a cost of the new one.
  //
  // A `const` arrow of that name was FLAGGED before this round: the local-function
  // exemption knew `function` and `class` and not the spelling this repository
  // actually writes. So scoping that test came with widening its kinds, and both
  // halves are pinned — here, and by D01 above.
  { id: 'a same-file local ARROW that happens to share the name', source: 'const readFileSync = (p: string) => p.length;\nexport const f = (p: string) => readFileSync(p);\n' },
  { id: 'a read name pulled off a LOCAL non-fs object and renamed — the proof still clears it', source: 'const cache = { readFileSync: (p: string) => p };\nconst rf = cache.readFileSync;\nexport const f = (p: string) => rf(p);\n' },
  { id: 'a same-scope parameter with a non-fs type STILL proves its own receiver', source: 'interface Coverage { open(dir: string, rel: string): void }\nexport function scan(coverage: Coverage, dir: string) { coverage.open(dir, \'a\'); coverage.open(dir, \'b\'); }\n' },
];

test('the CENSUS-DEFEAT corpus: every spelling round 2 admitted is now caught, and nothing innocent is', () => {
  const admitted: string[] = [];
  for (const spelling of SPELLINGS) {
    const sites = unboundedSitesIn(path.join(SRC_ROOT, 'shared', 'probe.ts'), spelling.source);
    if (sites.length === 0) admitted.push(`${spelling.id} (round 2: ${spelling.round2})`);
    else if (spelling.at !== undefined && !sites.some((site) => site.line === spelling.at)) {
      admitted.push(`${spelling.id}: flagged line(s) ${sites.map((s) => s.line).join(',')}, not ${spelling.at}`
        + ' — the RIGHT call has to be the one caught, or a launder that merely moves the flag survives');
    } else if (spelling.sites !== undefined && sites.length !== spelling.sites) {
      admitted.push(`${spelling.id}: ${sites.length} sites, expected exactly ${spelling.sites}`
        + ` (${sites.map((s) => `${s.api}@${s.line}`).join(', ')})`);
    }
  }
  assert.deepEqual(admitted, [],
    'a spelling of an unbounded read is invisible to this census. Eleven of these were invisible to round 2\'s '
    + 'regex and the peer drove four of them to SIGKILL at ~8 s on a FIFO and on a /dev/zero link, one of them '
    + '(`require(\'fs\').readFileSync`) being this repository\'s own house idiom. Do NOT answer this with a longer '
    + 'alternation — resolve the BINDING and classify the resolved api, which is what the scan above does.\n\n'
    + `  ${admitted.join('\n  ')}`);

  const overFlagged: string[] = [];
  for (const clean of NOT_A_READ) {
    const sites = unboundedSitesIn(path.join(SRC_ROOT, 'shared', 'probe.ts'), clean.source);
    if (sites.length > 0) overFlagged.push(`${clean.id}: ${sites.map((s) => `${s.api}(${s.argument})`).join(', ')}`);
  }
  assert.deepEqual(overFlagged, [],
    'the census is flagging something that does not open a path for reading. An instrument nobody can satisfy '
    + `gets deleted, and then there is none.\n\n  ${overFlagged.join('\n  ')}`);

  // FIXTURE READBACK for this corpus: the scanner must be capable of answering
  // BOTH ways, or one of the two assertions above is vacuous.
  assert.ok(SPELLINGS.length >= 35 && NOT_A_READ.length >= 16, 'FIXTURE the corpus must cover both directions');
});

test('every PATH_READS entry is LOAD-BEARING — moving one to NOT_PATH_READS must red', () => {
  // A HOLE IN THE PARTITION rather than in the resolver, and it is the quieter
  // of the two failure modes. The round-3 peer moved SIX names out of PATH_READS
  // and into NOT_PATH_READS one at a time — `openAsBlob`, `opendir`,
  // `opendirSync`, `cp`, `ReadStream`, `FileReadStream` — and the whole file
  // stayed green on every one, because nothing in the tree and nothing in the
  // corpus used them. A classification no test depends on is a comment.
  //
  // It matters because the TOTALITY test above only asks that every fs export be
  // classified SOMEWHERE. Demoting a real reader satisfies totality perfectly
  // and silently stops counting it, and the next file to call `opendirSync` on a
  // project path lands unflagged with a green suite behind it.
  //
  // So each name gets a synthetic call it must flag. Generated rather than
  // hand-written: a hand-written list is the thing that went stale, and a
  // generated one cannot fall behind PATH_READS by construction.
  const dead: string[] = [];
  for (const api of PATH_READS) {
    const source = `import * as fs from 'fs';\nexport const f = (p: string) => fs.${api}(p);\n`;
    if (unboundedSitesIn(path.join(SRC_ROOT, 'shared', 'probe.ts'), source).length === 0) dead.push(api);
  }
  assert.deepEqual(dead, [],
    'a PATH_READS entry is not actually counted as a read by the scan, so moving it to NOT_PATH_READS would '
    + 'change nothing and no test would notice. The peer demoted six names exactly this way with zero reds.\n\n'
    + `  ${dead.join('\n  ')}`);

  // AND THE OTHER DIRECTION: a NOT_PATH_READS name must NOT be counted, or the
  // partition is decorative in the opposite way — the census would flag whatever
  // it liked and the columns would explain nothing.
  const spurious: string[] = [];
  for (const api of ['statSync', 'existsSync', 'readdirSync', 'writeFileSync', 'unlinkSync', 'readSync']) {
    const source = `import * as fs from 'fs';\nexport const f = (p: string) => fs.${api}(p);\n`;
    if (unboundedSitesIn(path.join(SRC_ROOT, 'shared', 'probe.ts'), source).length > 0) spurious.push(api);
  }
  assert.deepEqual(spurious, [], `a NOT_PATH_READS name is being counted as a read:\n  ${spurious.join('\n  ')}`);
});

/**
 * The reads this repository EMITS AS SOURCE, with the BOUND each one carries.
 *
 * A read inside a string is not a call, and the scan is right not to flag it —
 * `NOT_A_READ` pins that on purpose. But some of those strings are source a HOST
 * runs: the runner shim, the OpenCode MCP launcher and both host wrappers, all
 * running before any plugin path is known. Round 4 presented "the parser knows the
 * difference" as a precision win, which left the class this lane exists to close
 * shipping in launchers with nothing in the tree saying so — its peer's MINOR 6.
 *
 * ── THE SENTENCE THIS ROW-SET REPLACES WAS FALSE, AND IT IS THE FINDING ──────
 * The list was flat and the two wrapper entries carried this comment:
 *
 *   "both host wrappers emit `JSON.parse(readFileSync(stateFile,'utf8'))` into
 *    the wrapper a host runs. SAME COST CLASS AS THE SHIM — a foreground command
 *    that does not return — and same reason they cannot import the leaf."
 *
 * and the docblock closed "both paths are under `$HOME`, so the pull-request
 * delivery route this lane exists to close does not reach them". Both are FALSE of
 * the wrappers, and false in the direction that excused them. The shim reads
 * `<$HOME>/.traffic-one/windsurf-plugin-root`, which no pull request can write. The
 * wrappers' `validTrafficOneRoot`/`readTrafficOneMarker` walk UPWARD from the
 * host's cwd, so their path is `<project>/.traffic-one/.one.json` — and git stores
 * a symlink as a mode-120000 blob, so `.one.json -> /dev/zero` arrives in an
 * ordinary pull request and materialises on `git clone` with no local process.
 * Nor is the cost a foreground command: it is a HOOK, at host plugin load. DRIVEN,
 * both wrappers, one arm per child under a parent SIGKILL at 8 000 ms: /dev/zero
 * symlink 8 068 ms (opencode) and 8 064 ms (kilo), FIFO 8 017 ms both, against
 * controls of 30 ms and 45 ms in-child. Two clone-deliverable unbounded reads sat
 * ENUMERATED-AND-EXCUSED because one sentence asserted a delivery route instead of
 * measuring one.
 *
 * ── SO THE ROW CARRIES A BOUND, AND THE BOUND IS THE ASSERTION ───────────────
 * `bound: 'inline-fstat'` means the emitted text opens with `O_NONBLOCK` and
 * `fstat`s the DESCRIPTOR — the leaf's rule, spelled once in
 * `shared/emitted-bounded-read.ts` and interpolated, because four hand-written
 * copies of a three-line argument is exactly how `bounded-read.ts` came to exist.
 * Each such row is checked HERE for the bound in its own text, and DRIVEN in
 * `__tests__/emitted-read-bound.test.ts`, which runs the emitted source and both
 * wrappers against a planted `/dev/zero` link and a FIFO with the deadline enforced
 * by the parent — and carries its own unbounded twin as a negative control, so a
 * green arm cannot be an absent fixture.
 *
 * `bound: 'unbounded'` is still available and still honest for a path no pull
 * request can deliver, but the reason must now NAME the delivery route it claims
 * immunity from, so the next round can test that claim rather than re-read it.
 *
 * What the pin buys: a NEW emitted read cannot appear without a decision, and an
 * existing one cannot be re-described as harmless without saying what would have
 * to be true.
 */
interface EmittedRead {
  readonly file: string;
  /**
   * The number of distinct LINES in this file that emit a read, pinned exactly for
   * the reason `EXCUSED` pins its own counts: without it, a file already on the
   * list may grow a third emitted read and the set equality above stays green.
   */
  readonly sites: number;
  readonly bound: 'inline-fstat' | 'unbounded';
  readonly reason: string;
}

const EMITTED_READS: readonly EmittedRead[] = [
  {
    file: 'src/shared/emitted-bounded-read.ts',
    sites: 2,
    bound: 'inline-fstat',
    reason: 'THE EMITTED BOUND ITSELF: one comment-free line (the `node -e` consumer must stay one line) '
      + 'declaring openSync(O_RDONLY|O_NONBLOCK) + fstatSync(fd).isFile() + closeSync, answering null for a '
      + 'non-regular shape. DRIVEN in __tests__/emitted-read-bound.test.ts against a FIFO and a symlink to '
      + '/dev/zero, with a plain readFileSync of the same object as the negative control (SIGKILL)',
  },
  {
    file: 'src/runners/opencode-host/wrapper-source.ts',
    sites: 2,
    bound: 'inline-fstat',
    reason: 'The OpenCode host wrapper reads <project>/.traffic-one/.one.json and <project>/.opencode/'
      + 'traffic-one.json while walking UPWARD from the host cwd — a CLONE-DELIVERABLE path (git mode 120000). '
      + 'Was 8 068 ms to SIGKILL on a /dev/zero symlink and 8 017 ms on a FIFO against a 30 ms control; now '
      + '91 ms and 68 ms through the emitted bound',
  },
  {
    file: 'src/runners/kilo-host/wrapper-source.ts',
    sites: 2,
    bound: 'inline-fstat',
    reason: 'The Kilo host wrapper, same two project-relative reads and the same clone-delivery route. Was '
      + '8 064 ms to SIGKILL on a /dev/zero symlink and 8 017 ms on a FIFO against a 45 ms control; now 91 ms '
      + 'and 75 ms, and the regular-file control still denies fail-closed exactly as before',
  },
  {
    file: 'src/config/opencode-mcp.ts',
    sites: 1,
    bound: 'inline-fstat',
    reason: '`node -e` source for the MCP launcher Cursor starts with no plugin root; its identity read is '
      + '<HOST-PROVIDED *_PLUGIN_ROOT>/package.json, an install directory, so the pull-request route does NOT '
      + 'reach it — a lower cost class than the wrappers, bounded anyway because the fix is one interpolation '
      + 'of the shared emitted reader',
  },
  {
    file: 'src/shared/runner-shims.ts',
    sites: 1,
    bound: 'unbounded',
    reason: 'The version-stable runner shim reads <$HOME>/.traffic-one/windsurf-plugin-root, a path written '
      + 'only by this plugin under the user\'s own home: NO CLONE and NO PULL REQUEST can deliver a shape '
      + 'there, and planting one needs a local process that already has write access to $HOME. The cost if it '
      + 'ever is planted is a foreground runner command that does not return, visible to whoever ran it, not a '
      + 'hook the host waits on silently. DECLINED rather than blocked: the same emittedBoundedReadSource '
      + 'interpolation would bound it, and the shim\'s content is asserted by several suites that a future '
      + 'round should re-run rather than a round with a blocker in hand',
  },
];

test('every read this repo EMITS AS SOURCE is enumerated with its BOUND — a string is not a call, but it is still a read', () => {
  const emitters = new Set<string>();
  const detail: string[] = [];
  // The API NAMES, textually, inside a string or template — deliberately not the
  // resolver: emitted source has no bindings this file can walk, so the name is
  // all there is.
  //
  // NARROWED TO THE CONSUMING READS, and the wide version is recorded because its
  // result is the argument for narrowing: `open`/`copyFile`/`cp` in TEXT also
  // matched 12 sites in `shared/shell-vocabulary.ts` and one 20 kB gate paragraph
  // in `plan-guard/plan-readiness/index.ts` — a shell gate's own WRITE samples
  // (`open('${p}', mode='w')`) and prose about destructive spellings, neither of
  // which is emitted source. A mode string cannot be classified from inside a
  // string literal, so an instrument that flags them names the wrong files and
  // gets deleted; `readFileSync`/`readFile`/`createReadStream`/`openAsBlob` need
  // no mode to be a read.
  //
  // THE EMITTED READER'S OWN NAME IS IN THE SET, and so is the INTERPOLATION of
  // the constant that carries it (`${EMITTED_BOUNDED_READ_FN}(`, which is what the
  // source text of a converted call site actually reads). Without both, converting
  // an emitted read to the bounded reader would REMOVE the file from this
  // enumeration — the instrument would stop recording that the wrapper reads a
  // project path at all, and could no longer tell a conversion from a rename away
  // from the fs name, which is precisely the spelling that defeats a name-based
  // detector. The placeholder form names the IMPORT BINDING, so renaming the import
  // drops the file out of the set and REDS the equality below: the direction that
  // fails loudly.
  //
  // COUNTED PER LINE, not per string node, and that is not a detail: the whole
  // emitted wrapper is ONE template expression, so a per-node count collapses its
  // two reads into one and a THIRD read added beside them would move nothing. The
  // count is the number of distinct lines carrying a match, which is stable when
  // code moves and changes when a read is added or converted — the same property
  // `EXCUSED`'s per-file counts have, for the same reason.
  const emitted = new RegExp(
    '(?:\\$\\{EMITTED_BOUNDED_READ_FN\\}'
    + `|\\b(?:readFileSync|readFile|createReadStream|openAsBlob|${EMITTED_BOUNDED_READ_FN}))\\s*\\(`,
    'g',
  );
  const sitesByFile = new Map<string, Set<number>>();
  for (const file of productionSources()) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        const start = node.getStart(sf);
        for (const match of node.getText(sf).matchAll(emitted)) {
          const line = sf.getLineAndCharacterOfPosition(start + (match.index ?? 0)).line + 1;
          emitters.add(rel);
          if (!sitesByFile.has(rel)) sitesByFile.set(rel, new Set<number>());
          sitesByFile.get(rel)!.add(line);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  for (const [rel, lines] of sitesByFile) for (const line of [...lines].sort((a, b) => a - b)) detail.push(`${rel}:${line}`);
  assert.deepEqual([...emitters].sort(), EMITTED_READS.map((row) => row.file).sort(),
    'the set of production files that EMIT an fs read as source has moved. A read inside a string is not a call — '
    + 'the census is right to leave it alone — but it is source a HOST will run, and the launchers that carry one '
    + 'today do so before any plugin path is known, so they cannot import the bounded reader. Either bound it '
    + 'inline (interpolate emittedBoundedReadSource, which is O_NONBLOCK + fstat on the descriptor) and add the '
    + 'file here with bound: \'inline-fstat\', or add it with bound: \'unbounded\' and a reason that NAMES the '
    + `delivery route it claims immunity from.\n\n  sites: ${detail.sort().join('\n  ')}`);

  // ── EVERY ROW'S BOUND IS CHECKED, NOT TAKEN ────────────────────────────────
  // The claim `inline-fstat` is only worth what backs it, so each such file must
  // carry the bound in its own text: either it IS the emitter of the shared line
  // (O_NONBLOCK + fstat + isFile) or it interpolates it. A hand-rolled fourth copy
  // reds here and should — the copies are what this lane keeps paying for.
  //
  // And an `unbounded` row must make a FALSIFIABLE claim about delivery rather than
  // an assertion about who owns a path: round 3 excused 111 sites with the latter
  // and four of the six its peer drove hung. The route is the thing that decides
  // the cost class, so the route is what the reason has to name.
  const drifted = EMITTED_READS
    .filter((row) => (sitesByFile.get(row.file)?.size ?? 0) !== row.sites)
    .map((row) => `${row.file}: pinned ${row.sites} emitted read line(s), found ${sitesByFile.get(row.file)?.size ?? 0}`);
  assert.deepEqual(drifted, [],
    'the per-file count of EMITTED read lines moved. UP means a new read was emitted into a file already on this '
    + 'list — the bound on the row was not written about it, so read the row before raising the number. DOWN '
    + `means one was converted or removed, and lowering it is how that gets recorded.\n\n  ${drifted.join('\n  ')}`);

  // THE BOUND IS READ OFF THE EMITTED TEXT, NOT OFF THE FILE, and the difference
  // is measured rather than assumed. Mutation P1-FSTAT-DROP (the flags kept, the
  // kind test deleted from the emitted string) left this file's PROSE full of the
  // words `fstatSync` and `isFile()` — so a check over the file text passed the
  // mutant, and only the driven suite killed it (2 of 9 failed, this test not among
  // them). What the emitting FUNCTION returns cannot be satisfied by a comment.
  const emittedBound = emittedBoundedReadSource('probeFs');
  assert.match(emittedBound, /O_NONBLOCK/,
    'the EMITTED bound no longer passes O_NONBLOCK, so an open of a FIFO with no writer waits for one');
  assert.match(emittedBound, /fstatSync\([a-zA-Z]+\)\.isFile\(\)/,
    'the EMITTED bound no longer fstats the DESCRIPTOR and asks whether it is a regular file. O_NONBLOCK alone '
    + 'does not bound it: a FIFO then reads as EMPTY BYTES, which at a .one.json reader is not a hang but a '
    + 'licence to replace the file (see bounded-read.ts\'s FSTAT-DROP paragraph)');
  assert.equal(/readFileSync\(f\b/.test(emittedBound), false,
    'the EMITTED bound is reading the PATH again rather than the descriptor it proved regular');

  const unproved: string[] = [];
  const ROUTE = /\b(?:clone|pull request|120000|\$HOME|HOME-owned|host-provided)\b/i;
  for (const row of EMITTED_READS) {
    const text = fs.readFileSync(path.join(REPO_ROOT, row.file), 'utf8');
    if (row.bound === 'inline-fstat') {
      // Either this file IS the emitter of the bound asserted just above, or it
      // interpolates it. A hand-rolled fourth copy reds here and should — the
      // copies are what this lane keeps paying for.
      const isTheEmitter = row.file === 'src/shared/emitted-bounded-read.ts';
      const interpolatesIt = text.includes('emittedBoundedReadSource');
      if (!isTheEmitter && !interpolatesIt) {
        unproved.push(`${row.file}: claims bound 'inline-fstat' but does not interpolate `
          + 'emittedBoundedReadSource, the one emitted copy of the leaf\'s rule');
      }
      continue;
    }
    if (!ROUTE.test(row.reason)) {
      unproved.push(`${row.file}: bound 'unbounded' with no DELIVERY ROUTE named — say how a hostile shape `
        + 'would have to arrive at that path ($HOME-owned? host-provided? clone-deliverable at mode 120000?), '
        + 'because the route is what decides whether leaving it is survivable');
    }
  }
  assert.deepEqual(unproved, [], `an EMITTED_READS row does not carry what its bound owes.\n\n  ${unproved.join('\n  ')}`);

  // ANTI-VACUITY: an empty set would satisfy `deepEqual` against an empty pin, so
  // the pin itself must be non-empty, the detector must have fired, and at least
  // one row must be a real inline bound — a pin whose every row said 'unbounded'
  // would be the enumeration this replaced.
  assert.ok(EMITTED_READS.length >= 5 && detail.length >= 5,
    `FIXTURE the emitted-read detector found ${detail.length} sites in ${emitters.size} files`);
  assert.ok(EMITTED_READS.some((row) => row.bound === 'inline-fstat'),
    'FIXTURE at least one emitted read must be BOUNDED inline, or this pin is the enumeration it replaced');
});

test('a source file the census cannot SEE is a hole too — symlinks and .mjs', () => {
  // NOT A RESOLVER QUESTION. `readdirSync({ withFileTypes: true })` answers FALSE
  // to both `isFile()` and `isDirectory()` for a symlink, so before this round a
  // production source file that was a link — or an entire production directory
  // reached through one — was never opened, whatever it contained. Round 2 also
  // globbed `.ts` only, which is how `runners/lighthouse/index.mts` went
  // unscanned for two rounds while sitting between two files the corpus pins by
  // name.
  //
  // Both are latent: this tree has no symlinked sources today, and the only
  // non-`.ts` loadables under `src` are in `build/` and `test-environment/`,
  // which are not production. Asserted anyway, because "latent" is what every
  // one of these was until it was not.
  const files = productionSources();
  assert.ok(files.length > 400, `FIXTURE expected the whole production tree, found ${files.length} files`);

  const scratch = path.join(REPO_ROOT, '.tmp', 'bounded4', 'census-visibility');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(path.join(scratch, 'real'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'real', 'hidden.ts'), 'import * as fs from \'fs\';\nexport const f = (p: string) => fs.readFileSync(p);\n');
  fs.writeFileSync(path.join(scratch, 'plain.mjs'), 'import * as fs from \'fs\';\nexport const f = (p) => fs.readFileSync(p);\n');
  try {
    fs.symlinkSync(path.join(scratch, 'real', 'hidden.ts'), path.join(scratch, 'linked.ts'));
    fs.symlinkSync(path.join(scratch, 'real'), path.join(scratch, 'linked-dir'));
    fs.symlinkSync(path.join(scratch, 'nowhere.ts'), path.join(scratch, 'dangling.ts'));
  } catch {
    return; // no symlink privilege (Windows CI); the .mjs half below still runs
  }

  const seen = listSources(scratch).map((file) => path.relative(scratch, file).split(path.sep).join('/')).sort();
  assert.deepEqual(seen, ['linked-dir/hidden.ts', 'linked.ts', 'plain.mjs', 'real/hidden.ts'],
    'the scan must follow a symlinked source FILE and a symlinked DIRECTORY — the runtime does, because '
    + '`require` resolves through links — must scan `.mjs`, and must skip a DANGLING link, where there is no '
    + 'source to scan and `statSync` throws');
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('WHICH FILES, recomputed from a LISTING this census\'s own predicates cannot move', () => {
  // THE FOURTH WIDENING, AND WHY THIS TEST IS NOT A FIFTH.
  //
  // Round 2 matched `${sep}build${sep}` as a substring. Round 3 scoped a guard
  // file-wide. Round 4 added a clause to `isProduction`. Round 5 stopped filtering
  // and DERIVED the floor, then recomputed `isProduction` in the assertion "in
  // terms of the only two primitives it is allowed to use". Each round guarded the
  // level the last attack used, and the round-5 peer walked one level down again:
  // a recomputation that calls `isTestSource` and `listSources` CANNOT SEE A CHANGE
  // TO `isTestSource` OR `listSources`. Measured, three arms, each ONE LINE plus a
  // planted unbounded read, all GREEN against the shipped selector:
  //
  //   `isTestSource`'s generated-file clause generalised from the one emitted file
  //   to /\.generated\.[cm]?tsx?$/ — the obvious tidy-up the moment a SECOND
  //   generated file appears — hid `shared/probe-p5a.generated.ts`.
  //
  //   `listSources` skipping a directory named `vendor` hid `shared/vendor/…`.
  //
  //   `isTestSource` also excluding `__fixtures__` hid `shared/__fixtures__/…`.
  //
  // So this assertion uses NEITHER predicate. It walks `src` itself and spells the
  // exclusions as LITERALS, which is the one shape the file under audit cannot
  // narrow: an exclusion has to be TYPED HERE, in a test whose diff says
  // "stop scanning these files", rather than expressed as a clause in a predicate
  // whose diff says "tidy up a suffix test".
  //
  // THE DUPLICATION IS THE POINT AND IT IS NOT A DRIFT HAZARD OF THE USUAL KIND.
  // This lane's standing rule is that a figure copied into two places stops
  // agreeing with itself — true, and the reason `citationsIn` is defined once and
  // the residue figures are derived. Here DISAGREEMENT IS THE SIGNAL: the two
  // spellings are compared on every run, in both directions, and a divergence
  // fails rather than rots. A genuinely new non-production root now costs two
  // edits, one of them here.
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      // `statSync` FOLLOWS the link, as `require` does — the visibility hole above
      // is a property of the tree, so it must not be re-introduced here.
      const stats = fs.statSync(absolute, { throwIfNoEntry: false });
      if (!stats) continue;
      if (stats.isDirectory()) walk(absolute, out);
      else if (stats.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) out.push(absolute);
    }
    return out;
  };

  // The exclusions, as literals. NOT `NON_PRODUCTION_ROOTS`, NOT `isTestSource`:
  // `NON_PRODUCTION_ROOTS.push('modules')` is the third hiding place the peer named
  // and it satisfies every other check in this file at once.
  const NOT_PRODUCTION_HERE = ['build', 'gen', 'test-support', 'test-environment'];
  const EMITTED_NOT_AUTHORED = ['shared/skill-fallbacks.generated.ts'];
  const relative = (file: string): string => path.relative(SRC_ROOT, file).split(path.sep).join('/');
  const expected = walk(SRC_ROOT).map(relative).filter((rel) => {
    if (NOT_PRODUCTION_HERE.includes(rel.split('/')[0]!)) return false;
    if (rel.split('/').includes('__tests__')) return false;
    if (/\.test\.[cm]?[jt]sx?$/.test(rel) || rel.endsWith('.d.ts')) return false;
    return !EMITTED_NOT_AUTHORED.includes(rel);
  }).sort();

  const actual = productionSources().map(relative).sort();

  // FIXTURE READBACK: both sides must be the whole tree, or an empty-vs-empty
  // equality passes while the walk is broken.
  assert.ok(expected.length > 400, `FIXTURE the literal walk found ${expected.length} files`);
  assert.ok(actual.length > 400, `FIXTURE the census scanned ${actual.length} files`);

  const hidden = expected.filter((rel) => !actual.includes(rel));
  assert.deepEqual(hidden, [],
    'a file that IS production source by the literal rule spelled out in this test is NOT being scanned. '
    + 'Three one-line edits to `isTestSource` and `listSources` each hid a planted unbounded read from every '
    + 'other assertion in this file, so this one asks the filesystem instead. If the file genuinely should '
    + 'not be scanned, say which and why by editing the literals ABOVE — and then explain, in the same diff, '
    + `why a hook must never load it.\n\n  ${hidden.join('\n  ')}`);

  const surplus = actual.filter((rel) => !expected.includes(rel));
  assert.deepEqual(surplus, [],
    'the census is scanning a file the literal rule excludes. This direction is not a safety hole, it is a '
    + 'DIVERGENCE: the two spellings of "which files" have stopped agreeing, and the whole value of the '
    + `second spelling is that it disagrees loudly rather than rotting.\n\n  ${surplus.join('\n  ')}`);
});

// ── P3: the consumers of the leaf are ENUMERATED, never hand-listed ──────────

test('bounded-read.ts states the RULE about its consumers rather than a list that goes stale', () => {
  // WHY THIS TEST EXISTS, and it is not tidiness about docs. `bounded-read.ts`'s
  // header carried a hand-written caller list and that list was WRONG TWICE. It
  // first read "the two callers are one-settings.ts and project-state-lock.ts"
  // and was corrected to three when fsjson.ts adopted the leaf; the round that
  // wrote the correction left the tree with FIFTEEN importers, so the sentence
  // was false by twelve files inside the same round — in a file whose very next
  // paragraph closes "a caller list that is allowed to go stale is the same
  // instrument as a copy that is allowed to drift".
  //
  // It is not a NIT because that list is the file's ONLY statement about blast
  // radius. A maintainer tightening the leaf read "three callers, all lock/state
  // readers" while in fact moving every plan-readiness check, both
  // react-structure scanners, plan-write's reconstruction, `build-complete` and
  // SessionStart.
  //
  // So the remedy is NOT a corrected number. A number in prose can go stale a
  // third time. The header now states the RULE — a leaf, `fs` only, consumers are
  // whoever imports it — and this test is the enumeration.
  const leaf = path.join(SRC_ROOT, 'shared', 'bounded-read.ts');
  const text = fs.readFileSync(leaf, 'utf8');

  const importers = productionSources()
    .filter((file) => file !== leaf && localImportsOf(file).includes(leaf))
    .map((file) => path.relative(REPO_ROOT, file))
    .sort();

  // FIXTURE READBACK — a renamed leaf or a broken resolver leaves this empty.
  assert.ok(importers.length >= 15,
    `FIXTURE expected the leaf to have many importers, found ${importers.length}`);

  // THE LEAF CLAIM, which is the half of the header that must stay true for the
  // hook runtime to stay dependency-free.
  const localImports = localImportsOf(leaf);
  assert.deepEqual(localImports, [],
    `bounded-read.ts must import nothing local — it is a leaf, and every one of its ${importers.length} `
    + 'consumers is reached from the dependency-free hook runtime. Anything needing config, a host or a path '
    + 'resolver belongs in the caller.');
  assert.deepEqual(
    [...text.matchAll(/^import\s+.*?from\s+'([^']+)';/gm)].map((m) => m[1]),
    ['fs'],
    '`fs` is the only import, and the header says so',
  );

  // AND THE HEADER MUST NOT GO BACK TO ENUMERATING. Two shapes are forbidden,
  // and this regex is calibrated against the two sentences that were actually
  // wrong rather than against what a stale list might look like in the abstract:
  //
  //   "the two callers are one-settings.ts and project-state-lock.ts"   (false)
  //   "the callers are …one-settings.ts, …project-state-lock.ts and …fsjson.ts"
  //                                                    (false, by twelve files)
  //
  // The first counts; the second does not, and naming the members is the same
  // instrument either way. So a present-tense claim about who the callers ARE is
  // what reds, whether or not it carries a digit.
  //
  // The historical record of both false versions stays in the header on purpose —
  // this file's own rule is that a claim a change falsifies gets updated and the
  // record says what the false version said — so a line that is explicitly
  // reporting a PAST version is exempt. That exemption is keyed on the past-tense
  // marker, not on the content, so it cannot be used to smuggle a live claim.
  // WHAT IS FORBIDDEN IS A LIST OR A COUNT, not the word "consumers". The RULE
  // the header now states — "the consumers are whoever imports it" — has to stay
  // sayable, so the two shapes that were actually wrong are what reds: a NUMBER
  // of consumers, and a claim about who they ARE that names a `.ts` file.
  const COUNTS = /\b(?:one|two|three|four|five|\d+)\s+(?:callers?|consumers?|importers?)\b/i;
  const NAMES = /\b(?:callers?|consumers?|importers?)\s+(?:is|are)\b[^\n]*\.ts/i;
  // The recorded history of both false versions is exempt, and the exemption is
  // keyed on a HISTORICAL marker within a two-line window rather than on the
  // content — sentences here wrap, so the marker is often on the line above the
  // claim. Deliberately not the word "read": this is a file about reading, and an
  // exemption that any mention of reading satisfies exempts everything.
  const HISTORICAL = /\b(?:used to|was|were|until|false version|no longer|first read|had been|already false)\b/i;
  const lines = text.split('\n');
  const claims = lines
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter((row) => COUNTS.test(row.text) || NAMES.test(row.text))
    .filter((row) => !lines.slice(Math.max(0, row.line - 3), row.line).some((near) => HISTORICAL.test(near)));
  assert.deepEqual(claims.map((row) => `bounded-read.ts:${row.line}  ${row.text.trim()}`), [],
    'the header is naming or counting its consumers again, in the present tense. That sentence was wrong '
    + 'TWICE — first at two callers, then at three when there were fifteen — in a file whose next paragraph '
    + 'says a caller list allowed to go stale is the same instrument as a copy allowed to drift. State the '
    + `RULE and leave the enumeration to this test. Today it is:\n  ${importers.join('\n  ')}`);
});
