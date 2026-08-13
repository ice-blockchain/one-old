// ── THE LOAD-BEARING ARM FOR A `driven-bounded` EXCUSE ───────────────────────
// `EXCUSED` in `bounded-read-census.test.ts` lets a call site stand unconverted
// when a MEASUREMENT says it cannot block. Round 4 wrote three such rows about
// `fs.cpSync` and round 6 re-drove them: two thirds of each reason was false, and
// nothing reddened, because a reason is prose and prose does not run.
//
// FALSIFIED, ROUND 6 — the sentence all three rows carried: "node classifies with
// lstat first and throws ERR_FS_CP_FIFO_PIPE / ERR_FS_CP_SOCKET / ELOOP rather
// than opening". True only when the hostile object IS the source. Every caller
// passed a DIRECTORY, and for a directory node v26.5.0 SILENTLY OMITS a FIFO or a
// socket, and ABORTS THE PROCESS on an `a -> b -> a` symlink loop.
//
// So this file is what the row should always have been: the claim, driven, with
// the negative control that pins node's own behaviour beside it. Every arm runs in
// its OWN CHILD under a parent deadline with `killSignal: 'SIGKILL'` and asserts
// `run.signal`, because an abort and a hang are both invisible from inside.
//
// It reds if `copyTreeStrict` stops refusing, if it starts WALKING symlinks (the
// abort comes back), or if a future node stops omitting — the last of which would
// make the ledger's corrected reason stale in the honest direction, and a stale
// reason is the defect this instrument exists to catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PRELOAD = path.join(REPO_ROOT, 'src', 'build', 'test-preload.mjs');
const CHILD = path.join(__dirname, 'copy-tree-child.ts');

// Every bounded arm below returned in under 70 ms when measured; 20 s is the
// distance between "bounded" and "the box is loaded", not a budget.
const CHILD_TIMEOUT_MS = 20_000;

interface Arm {
  readonly shape: string;
  readonly impl: string;
  readonly skipped?: string;
  readonly uncaught?: string;
  readonly sourceEntries?: string[];
  readonly threw?: string | null;
  readonly elapsedMs?: number;
  readonly destinationEntries?: string[];
}

interface Outcome {
  readonly arm: Arm;
  readonly signal: string | null;
  readonly status: number | null;
}

function drive(shape: string, impl: string): Outcome {
  // The fixture tree is `os.tmpdir()` AT RUNTIME: a directory this repo authors
  // under its own root would be scratch (which belongs in `.tmp/`), and a project
  // shape inside the checkout trips the plugin-source stand-down fence.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-copytree-'));
  try {
    const run = spawnSync(process.execPath, [
      '--import', PRELOAD, '--import', 'tsx', CHILD, root, shape, impl,
    ], {
      cwd: REPO_ROOT, encoding: 'utf8', env: process.env,
      timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL',
    });
    const line = (run.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    return {
      arm: line ? JSON.parse(line) as Arm : { shape, impl },
      signal: run.signal ?? null,
      status: run.status ?? null,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('copyTreeStrict COPIES an ordinary tree — the control every refusal below is measured against', () => {
  const { arm, signal } = drive('control', 'copyTreeStrict');
  assert.equal(signal, null, 'the control must not be killed');
  assert.equal(arm.threw, null, `an ordinary directory must copy: ${String(arm.threw)}`);
  assert.deepEqual(arm.destinationEntries, ['ordinary.txt:file'],
    'ANTI-VACUITY: the refusals below mean nothing unless this arm actually copied the tree');
});

test('copyTreeStrict REFUSES a non-regular entry by name, where cpSync omits it in silence', (t) => {
  const strict = drive('dir-fifo', 'copyTreeStrict');
  if (strict.arm.skipped) { t.skip(`no FIFO available: ${strict.arm.skipped}`); return; }
  assert.equal(strict.signal, null, 'refusing must not require being killed');
  assert.match(String(strict.arm.threw), /cannot copy .*: a FIFO/,
    'the refusal must name the entry and its kind — "there is no backup" is actionable, an errno is not');
  assert.ok(!(strict.arm.destinationEntries ?? []).includes('pipe:fifo'),
    'and it must not have created one');

  // THE NEGATIVE CONTROL, and the whole reason the excused row was wrong: node
  // returns SUCCESS here with the entry missing. If a future node starts throwing,
  // this reds and the ledger's corrected reason gets re-derived — which is the
  // point of pinning the platform claim rather than restating it in prose.
  const plain = drive('dir-fifo', 'cpSync');
  assert.equal(plain.signal, null, 'cpSync does not hang on this shape; it returns');
  assert.equal(plain.arm.threw, null,
    'MEASURED: fs.cpSync over a directory containing a FIFO throws NOTHING on node v26.5.0');
  assert.deepEqual(plain.arm.destinationEntries, ['ordinary.txt:file'],
    'MEASURED: and the destination is missing the FIFO — a backup recorded as taken that cannot reconstruct '
    + 'the source. That is the cost the excused row spelled as "throws ERR_FS_CP_FIFO_PIPE".');
});

test('copyTreeStrict SURVIVES a symlink loop, which ABORTS cpSync past every handler', () => {
  const strict = drive('dir-loop', 'copyTreeStrict');
  assert.equal(strict.signal, null,
    `copyTreeStrict must not be killed by a symlink loop (got ${String(strict.signal)}): it RECREATES a link `
    + 'instead of resolving it, so there is no walk to diverge');
  assert.equal(strict.arm.threw, null, `a loop is data, not an error: ${String(strict.arm.threw)}`);
  assert.deepEqual(strict.arm.destinationEntries, ['a:link', 'b:link', 'ordinary.txt:file'],
    'both links must arrive AS LINKS — dereferencing either is how the loop becomes an infinite path');

  // THE NEGATIVE CONTROL. The peer measured exit 134 with an uncaughtException
  // handler installed; the child here installs one too, so `uncaught: undefined`
  // beside a SIGABRT is evidence the handler never ran, not evidence nobody tried.
  const plain = drive('dir-loop', 'cpSync');
  assert.equal(plain.signal, 'SIGABRT',
    `MEASURED: fs.cpSync ABORTS on an a->b->a loop (got signal ${String(plain.signal)}, status `
    + `${String(plain.status)}). This is why the two backup writers were converted rather than re-argued: a `
    + 'process that dies here leaves no decision record, and "ELOOP" — what the excused row claimed — would '
    + 'have been an ordinary catchable error.');
  assert.equal(plain.arm.uncaught, undefined,
    'and it is NOT catchable: the child installs an uncaughtException handler and it never fires');
});

test('a symlink to a character device is copied as a LINK by both, and read by neither', (t) => {
  const strict = drive('dir-devzero', 'copyTreeStrict');
  if (strict.arm.skipped) { t.skip(`no /dev/zero: ${strict.arm.skipped}`); return; }
  assert.equal(strict.signal, null, 'a link to /dev/zero must not be followed into a read that never ends');
  assert.equal(strict.arm.threw, null, 'recreating the link is not a refusal');
  assert.deepEqual(strict.arm.destinationEntries, ['ordinary.txt:file', 'zero:link'],
    'the link arrives as a link — the bound here is that the tree copy never OPENS what a link points at');
});

test('the third excused cpSync row is bounded by its FILTER, which is what stops the abort', (t) => {
  // `copyCacheWithoutSymlinks` keeps its `cpSync` and stays excused. Its reason was
  // corrected in round 6 and this is the arm that makes the correction load-bearing:
  // the filter refuses EVERY symlink, so the walk cannot reach the shape that
  // aborts, and a FIFO inside the tree is thrown rather than omitted.
  //
  // THE CONTROL RUNS FIRST, AND IT WAS MISSING — the defect this arm had in common
  // with the row it certifies. The row's reason cites a control ("an ordinary
  // directory copies through the same call with the entry present") and this suite
  // did not drive one, so both refusals below were satisfied by ANY refusal.
  // MEASURED: with the filter's condition forced true — a cache copy that refuses
  // everything, copying nothing at all — this suite stayed 5 pass / 0 fail, with
  // the mutated branch proven to have run (the refusal message is its own, and the
  // destination came back EMPTY where the live call copies `ordinary.txt`). A
  // refusal with nothing to compare it to measures nothing — the census says
  // exactly that to every `driven-bounded` row, and the arm enforcing it did not
  // obey it.
  const control = drive('control', 'cacheFilter');
  assert.equal(control.signal, null, 'the control must not be killed');
  assert.equal(control.arm.threw, null,
    `ANTI-VACUITY: the excused call must still COPY an ordinary cache: ${String(control.arm.threw)}`);
  assert.deepEqual(control.arm.destinationEntries, ['ordinary.txt:file'],
    'ANTI-VACUITY: a filter that refuses everything satisfies both refusals below and copies nothing');

  const loop = drive('dir-loop', 'cacheFilter');
  assert.equal(loop.signal, null,
    `the filter must refuse before the walk aborts (got ${String(loop.signal)}) — remove it and this arm SIGABRTs`);
  assert.match(String(loop.arm.threw), /symlink/i,
    'the refusal names the symlink, which is the bound this row is excused by');

  const fifo = drive('dir-fifo', 'cacheFilter');
  if (fifo.arm.skipped) { t.skip(`no FIFO available: ${fifo.arm.skipped}`); return; }
  assert.equal(fifo.signal, null, 'and it does not hang on a FIFO inside the tree');
  assert.notEqual(fifo.arm.threw, null,
    'MEASURED: with dereference:false and a filter, node THROWS for a FIFO inside the tree (ERR_INTERNAL_ASSERTION '
    + 'on v26.5.0 — a node-internal message, but thrown and catchable) rather than omitting it silently. That '
    + 'difference from plain cpSync is the whole of this row\'s excuse and nothing stated it before.');
  // AND THE THROW MUST BE ABOUT THE FIFO. `notEqual(threw, null)` alone cannot tell
  // "throws for this shape" from "throws for every shape": under the mutant above it
  // was the symlink refusal firing on an ordinary file, and this arm passed.
  assert.equal(/symlink/i.test(String(fifo.arm.threw)), false,
    'the FIFO arm is being satisfied by the SYMLINK refusal, which fires on any entry — so this arm is no longer '
    + 'evidence about a FIFO at all');
});
