// The temp-dir tracker's own properties, and the pattern it replaced.
//
// WHY THIS FILE EXISTS AT ALL. Every property temp-dirs.ts argues for in its
// header was, until now, argued for only in that header: leak detection, the
// vacuity refusal, isolation between two same-prefix trackers, and the
// `realpathSync` the docblock calls load-bearing. Confirmed by direct probe
// that all four worked — and that DELETING any one of them broke no test in the
// repository, including the one the docblock singles out. A property nothing
// asserts is a property the next edit removes for free.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isolateTmpEnv, trackedTempDirs, withPrivateTmpdir } from './temp-dirs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const dirs = trackedTempDirs('t1-temp-dirs-test-');
after(() => { dirs.cleanup(); });

/**
 * `node:fs` through the CJS registry, which is the only handle that reaches the
 * `import * as fs` namespace inside temp-dirs.ts — assigning to this test's own
 * namespace object does not (measured: the write is silently dropped and the
 * original function still runs).
 */
const nodeFs = createRequire(__filename)('node:fs') as typeof fs;

function withPatched<K extends keyof typeof fs, T>(name: K, replacement: (typeof fs)[K], body: () => T): T {
  const original = nodeFs[name];
  Object.defineProperty(nodeFs, name, { configurable: true, writable: true, value: replacement });
  try {
    return body();
  } finally {
    Object.defineProperty(nodeFs, name, { configurable: true, writable: true, value: original });
  }
}

test('a directory that survived removal is reported, by path, as this run\'s leak', () => {
  const tracker = trackedTempDirs('t1-leak-row-');
  const leaked = tracker.make();
  // A removal that does not remove. This is the shape `force: true` cannot
  // paper over — EBUSY, EPERM, or a directory something is still writing
  // into — and the only one worth an assertion, because a successful rm needs
  // no check.
  const error = withPatched('rmSync', (() => undefined) as typeof fs.rmSync, () => {
    try {
      tracker.cleanup();
      return null;
    } catch (thrown) {
      return thrown as Error;
    }
  });
  fs.rmSync(leaked, { recursive: true, force: true });

  assert.ok(error, 'cleanup passed while a tracked directory was still on disk');
  assert.match(error.message, /failed to remove temp dirs it created/);
  assert.ok(error.message.includes(leaked), 'the message must name the path, so the leak is findable');
});

test('a file that stopped creating fixtures is refused rather than certified', () => {
  const tracker = trackedTempDirs('t1-vacuous-row-');
  assert.throws(() => { tracker.cleanup(); }, /the leak check is vacuous/);
});

test('the vacuity refusal stands down under a name filter, because that is not a file that stopped', () => {
  // Running one test by name is how anyone debugs one failing case. `after`
  // still fires, no fixture was created, and the refusal above turned that into
  // a guaranteed red whose message was about something else entirely.
  const tracker = trackedTempDirs('t1-filtered-row-');
  const saved = [...process.execArgv];
  process.execArgv.push('--test-name-pattern=something');
  try {
    tracker.cleanup();
  } finally {
    process.execArgv.length = 0;
    process.execArgv.push(...saved);
  }
  // And the leak half is NOT suspended with it: a filtered run that did create
  // a fixture and failed to remove it is still a leak.
  const filtered = trackedTempDirs('t1-filtered-row-');
  const leaked = filtered.make();
  process.execArgv.push('--test-name-pattern=something');
  const error = withPatched('rmSync', (() => undefined) as typeof fs.rmSync, () => {
    try { filtered.cleanup(); return null; } catch (thrown) { return thrown as Error; }
  });
  process.execArgv.length = 0;
  process.execArgv.push(...saved);
  fs.rmSync(leaked, { recursive: true, force: true });
  assert.ok(error, 'the name filter suspended the leak check too');
  assert.match(error.message, /failed to remove temp dirs it created/);
});

test('two trackers sharing one prefix cannot see each other — the whole reason this is not a prefix scan', () => {
  // This is the concurrency case reduced to one process: same prefix, disjoint
  // provenance. Under the `readdirSync(os.tmpdir()).startsWith(PREFIX)` form
  // that this replaced, `first.cleanup()` sees `second`'s live directory in the
  // listing and both runs fail. Measured on the real thing before the
  // migration: four concurrent runs of pipeline.test.ts, three of them red.
  const first = trackedTempDirs('t1-shared-prefix-');
  const second = trackedTempDirs('t1-shared-prefix-');
  const mine = first.make();
  const theirs = second.make();
  assert.notEqual(mine, theirs);

  first.cleanup();
  assert.equal(fs.existsSync(mine), false, 'the first tracker did not remove its own directory');
  assert.equal(fs.existsSync(theirs), true, 'the first tracker deleted, or complained about, a directory it never created');

  second.cleanup();
  assert.equal(fs.existsSync(theirs), false);
});

test('make() returns a resolved path even when the temp directory is reached through a symlink', () => {
  // The docblock calls this load-bearing and nothing asserted it: code under
  // test that resolves a project root (the override ledger, the run-state
  // readers) keys on the resolved form, so an unresolved fixture path reads a
  // different file than it writes.
  //
  // The symlink is built here rather than relying on macOS's `/var` ->
  // `/private/var`, so the row can fail on Linux too. On a runner whose
  // `os.tmpdir()` is already canonical, an assertion that only compared a path
  // to its own realpath would be true with the call removed.
  const base = dirs.make();
  const real = path.join(base, 'real');
  const link = path.join(base, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);

  const restoreTmp = isolateTmpEnv(link);
  let made: string;
  try {
    assert.equal(os.tmpdir(), link, 'the redirect did not take, so this row proves nothing');
    made = trackedTempDirs('t1-symlinked-').make();
  } finally {
    restoreTmp();
  }

  assert.equal(made.startsWith(`${real}${path.sep}`), true, `make() returned an unresolved path: ${made}`);
  assert.equal(made.startsWith(`${link}${path.sep}`), false, 'make() handed back the symlinked path');
  assert.equal(made, fs.realpathSync(made));
});

test('withPrivateTmpdir catches a scratch tree left by code the test does not own', () => {
  // The positive: a body that cleans up passes, and the redirect really moved
  // os.tmpdir() while it ran.
  let seen = '';
  withPrivateTmpdir(dirs, () => {
    seen = os.tmpdir();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'someone-elses-'));
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  assert.notEqual(seen, '');
  assert.equal(os.tmpdir().startsWith(seen), false, 'TMPDIR was not restored');

  // The negative, under ANY name: the before/after listing this replaced only
  // looked for one prefix.
  assert.throws(
    () => withPrivateTmpdir(dirs, () => { fs.mkdtempSync(path.join(os.tmpdir(), 'unexpected-name-')); }),
    /left a scratch tree behind/,
  );
  const restored = process.env.TMPDIR;
  assert.equal(restored === undefined || !restored.includes('t1-temp-dirs-test-'), true,
    'TMPDIR was left pointing at the private directory after a failure');
});

test('withPrivateTmpdir refuses an async body instead of silently checking nothing', () => {
  // The signature is generic in `T`, so `async () => {}` type-checks and returns
  // a pending promise. Both of this helper's jobs then happen at the wrong time:
  // the emptiness assertion reads a directory the body has not written to, and
  // TMPDIR is restored while the body is still using it — so the check passes and
  // the body's strays land in the REAL temp directory. Documenting that was the
  // other option; refusing it is cheaper than a comment nobody reads.
  assert.throws(
    () => withPrivateTmpdir(dirs, async () => {
      fs.mkdtempSync(path.join(os.tmpdir(), 'async-body-'));
    }),
    /body is asynchronous/,
  );
  // And the refusal is not a leak: the finally clause still restores TMPDIR.
  const restored = process.env.TMPDIR;
  assert.equal(restored === undefined || !restored.includes('t1-temp-dirs-test-'), true);
});

// ── the pattern, pinned shut ────────────────────────────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.tmp') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Calls that LIST a directory. `readdirSync` was the whole set, which made the
 * tripwire a tripwire for one spelling: `fs.promises.readdir`, `opendirSync` and
 * `globSync` reach the same listing and were all invisible.
 */
const LISTING_CALL = /\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob)\s*\(/g;
/** The shared temp root, in the spellings that reach it. */
const TEMP_ROOT = /(?:\b[\w$]+\.)?tmpdir\s*\(\)|process\.env\.(?:TMPDIR|TEMP|TMP)\b/;

/** The balanced argument list of the call whose `(` is at `open`. */
function argumentList(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/**
 * Sites that list the shared temp directory, however the argument is spelled.
 *
 * Reading the ARGUMENT LIST rather than the line is what widened this. The
 * previous form required `readdirSync(` and `tmpdir()` to be adjacent, so
 * `readdirSync(path.join(os.tmpdir(), …))`, a template literal, and any call
 * broken across lines by the formatter all slipped through — and it separately
 * flagged every `= os.tmpdir()` in the repository as an "alias", which catches a
 * genuine dodge and also flags `if (dir === os.tmpdir())` (the last `=` of `===`)
 * and every innocent `const base = os.tmpdir()` that only ever builds a path.
 * An alias is now an offender when a listing call actually USES it.
 */
function tempDirScanSites(text: string): string[] {
  const lines = text.split('\n').map((line) => {
    const trimmed = line.trimStart();
    // The header of temp-dirs.ts quotes the pattern to explain it, and a quoted
    // counterexample is the opposite of a reintroduction.
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') ? '' : line;
  });
  const code = lines.join('\n');

  const aliases = new Set<string>();
  for (const line of lines) {
    const bound = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.+)$/.exec(line);
    // A binding, so `===` cannot look like one, and the right-hand side must BE
    // the temp root rather than something built from it: `mkdtempSync(join(tmpdir(), …))`
    // is the correct idiom and names a directory this run created.
    if (bound && TEMP_ROOT.test(bound[2]!) && !/mkdtemp|mkdir|writeFile|open|join\s*\([^)]*,/.test(bound[2]!)) {
      aliases.add(bound[1]!);
    }
  }

  const offenders: string[] = [];
  for (const match of code.matchAll(LISTING_CALL)) {
    const open = match.index + match[0].length - 1;
    const argument = argumentList(code, open);
    const namesTempRoot = TEMP_ROOT.test(argument)
      || [...aliases].some((alias) => new RegExp(`\\b${alias}\\b`).test(argument));
    if (!namesTempRoot) continue;
    const line = code.slice(0, match.index).split('\n').length;
    offenders.push(`${line}: ${lines[line - 1]!.trim()}`);
  }
  return offenders;
}

test('the tripwire recognises the shape rather than one spelling of it', () => {
  // Twelve spellings of the same defect. Six of these were invisible to the
  // previous form, which required `readdirSync(` and `tmpdir()` to be adjacent
  // on one line.
  for (const source of [
    "const leaked = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(P));",
    "const leaked = fs.readdirSync(os.tmpdir(), { withFileTypes: true });",
    "const leaked = readdirSync(tmpdir());",
    "const tmp = os.tmpdir();\nconst leaked = fs.readdirSync(tmp);",
    "const leaked = fs.readdirSync(path.join(os.tmpdir()));",
    "const leaked = fs.readdirSync(`${os.tmpdir()}`);",
    "const leaked = await fs.promises.readdir(os.tmpdir());",
    "const leaked = await fsp.readdir(os.tmpdir());",
    "const dir = fs.opendirSync(os.tmpdir());",
    "const leaked = fs.globSync(path.join(os.tmpdir(), 't1-*'));",
    "const leaked = fs.readdirSync(\n  os.tmpdir(),\n);",
    "const leaked = fs.readdirSync(process.env.TMPDIR!);",
  ]) {
    assert.notDeepEqual(tempDirScanSites(source), [], `not detected:\n${source}`);
  }

  // And the innocent shapes. The last two are the false positives the previous
  // alias rule produced: a comparison whose `===` ends in `=`, and a binding that
  // only ever builds a path.
  for (const source of [
    "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-x-'));",
    "const entries = fs.readdirSync(myOwnFixtureDir);",
    "const entries = fs.readdirSync(path.join(tracked, 'runs'));",
    "// const leaked = fs.readdirSync(os.tmpdir());",
    " *   const leaked = fs.readdirSync(os.tmpdir()).filter(…);",
    "if (resolved === os.tmpdir()) return;\nconst entries = fs.readdirSync(project);",
    "const base = os.tmpdir();\nconst file = path.join(base, 'x');\nfs.readdirSync(path.dirname(file));",
  ]) {
    assert.deepEqual(tempDirScanSites(source), [], `false positive:\n${source}`);
  }
});

test('no test asks the shared temp directory which of its entries belong to this run', () => {
  // The census that produced this rule, taken against the commit this work
  // started from rather than against the working tree: the pattern had exactly
  // FIVE sites. Two (plan-guard/deny-target-offender, state/deny-repeat-escalation)
  // were migrated in an earlier round. The three left — core/pipeline,
  // state/deny-expectation, and the milder before/after variant in
  // build/sync-hosts-install-exercise — are migrated here; the first two were
  // reproducibly red 3 runs in 4 under four concurrent invocations, each
  // reporting a neighbour's live fixture as its own leak. This row is what
  // stops a sixth.
  //
  // It pins the SHAPE, not every conceivable spelling: a listing of the shared
  // temp root, however the argument is written, plus the aliasing that would
  // hide one. A determined rewrite can still get around it, which is why the
  // argument lives in temp-dirs.ts's header and this is only the tripwire.
  const offenders: string[] = [];
  for (const file of [...sourceFiles(path.join(REPO_ROOT, 'src')), ...sourceFiles(path.join(REPO_ROOT, 'tests'))]) {
    if (file === __filename) continue;
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    for (const site of tempDirScanSites(fs.readFileSync(file, 'utf8'))) offenders.push(`${relative}:${site}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'these read the shared temp directory to work out what this run created, which is a guess from a name'
    + ' and not provenance — two concurrent runs of the same file see each other\'s live fixtures and both'
    + ' fail:\n'
    + `${offenders.map((offender) => `  ${offender}`).join('\n')}\n`
    + 'FIX: track what the run creates, with trackedTempDirs() from'
    + ' src/test-support/__tests__/temp-dirs.ts. For a scratch tree created by the code UNDER test rather'
    + ' than by the test, use withPrivateTmpdir() from the same module.',
  );
});
