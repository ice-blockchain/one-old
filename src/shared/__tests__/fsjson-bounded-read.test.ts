// src/shared/__tests__/fsjson-bounded-read.test.ts
// fsjson's two readers are BOUNDED, and a shape that cannot be read is PRESENCE
// with a named errno — never absence, and never the arm that carries bytes.
//
// THE DEFECT, DRIVEN BEFORE IT WAS FIXED (one shape per child process under a
// hard SIGKILL alarm, load 7.05-7.33 of 10 cpus, the resolved path printed by
// the child so a case that never reached the code could not pass quietly):
//
//   FIFO at `<project>/.traffic-one/.one.json`  readJsonResult  SIGKILL 12 014 ms
//   FIFO at the same path                       readText        SIGKILL 12 011 ms
//   symlink to /dev/zero at the same path       readJsonResult  SIGKILL 20 151 ms
//   regular file (control)                      both            returned 0 ms
//
// `open(O_RDONLY)` on a FIFO waits for a writer forever and a character device
// answers a read as long as anybody keeps asking. These are HOOK-PATH reads
// behind 102 `readJson` call sites, so the outcome was the one this codebase
// ranks below failing closed: a hook that never returns cannot even be reported.
//
// ── THE TRAP, which is why this is not a substitution ────────────────────────
// Bounding the read is the easy half. The two ways to spend the bound badly are
// each fail-open, and each has a named row below:
//
//   as `absent`   ENOENT means nothing is there and writing is safe. Something
//                 IS there. Every read-modify-write consumer treats absence as a
//                 licence to write.
//   as `corrupt`  an O_NONBLOCK FIFO reads as EOF, so the bytes are EMPTY and
//                 `JSON.parse('')` throws — straight into the one arm that
//                 CARRIES THE BYTES so a caller may preserve them and replace
//                 the file. A hang would have become a licence to destroy it.
//
// ── why the blocking shapes are read in a CHILD ──────────────────────────────
// A blocking open stops this runner's own timer with it, and `npm test` passes no
// `--test-timeout`, so an in-process row against a FIFO would hang the WHOLE
// SUITE indefinitely if the bound ever regressed — a red row is worth more than
// a hung run. Every shape that can block is therefore driven in a child under
// `timeout:`, and `run.signal` is asserted null: with the bound in place the
// child returns in well under a second, and without it the child is killed by
// signal and the row REDS. The shapes that cannot block (a directory, an empty
// regular file, a dangling link, a mode-000 file) are read in process, where
// they are cheaper and just as decisive. Same split, and the same reason, as
// materialize/__tests__/plan-migration-fold-safety.test.ts's MAJOR B.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readJson, readJsonResult, readText } from '../fsjson';

const FSJSON_MODULE = path.join(__dirname, '..', 'fsjson.ts');

/** os.tmpdir(), never a path in this repo: a fixture project under the plugin
 *  SOURCE root is stood down by the authoring-root fence, and a suite that drops
 *  out reports a clean LOWER number rather than a failure. */
function withProject<T>(label: string, fn: (statePath: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `t1-fsjson-bounded-${label}-`));
  try {
    const stateDir = path.join(dir, '.traffic-one');
    fs.mkdirSync(stateDir, { recursive: true });
    return fn(path.join(stateDir, '.one.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A FIFO, or `null` when the platform has no `mkfifo` — the shape is then
 *  unreachable rather than unpinned, which is the same answer the lock suites
 *  give on Windows. */
function plantFifo(at: string): string | null {
  try {
    execFileSync('mkfifo', [at], { stdio: 'ignore' });
  } catch {
    return null;
  }
  assert.equal(fs.lstatSync(at).isFIFO(), true, 'fixture guard: the planted entry must really be a FIFO');
  return at;
}

type Reader = 'readJsonResult' | 'readText' | 'readJson';

/**
 * Read `target` with one of fsjson's readers in a CHILD PROCESS, and fail if it
 * did not RETURN.
 *
 * The child requires fsjson.ts through `--import tsx` (the idiom
 * plan-migration-fold-safety.test.ts established) and inherits this process's
 * environment, so the preload's `TRAFFIC_ONE_PLUGIN_ROOT` pin travels with it and
 * the child is reading through the same tree the suite is asserting about.
 */
function readInChild(reader: Reader, target: string, label: string): unknown {
  const driver = path.join(path.dirname(path.dirname(target)), 'drive-read.cjs');
  fs.writeFileSync(driver, [
    'const fsjson = require(process.argv[2]);',
    'const answer = fsjson[process.argv[3]](process.argv[4], { fallback: true });',
    'process.stdout.write(JSON.stringify({ answer: answer === undefined ? null : answer }));',
  ].join('\n'), 'utf8');

  const run = spawnSync(process.execPath, ['--import', 'tsx', driver, FSJSON_MODULE, reader, target], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, TRAFFIC_ONE_ASK_USE_PLUGIN: '0' },
  });

  assert.equal(run.signal, null,
    `${label}: ${reader} must RETURN rather than block on the open — killed by signal means the bound is gone.`
    + ` stderr: ${run.stderr || ''}`);
  assert.equal(run.status, 0, `${label}: ${run.stderr || ''}`);
  return (JSON.parse(run.stdout) as { answer: unknown }).answer;
}

// ── boundedness, per blocking shape and per reader ───────────────────────────

test('a FIFO at .one.json is read in BOUNDED time by both readers — driven at 12 014 ms and 12 011 ms before', () => {
  withProject('fifo-bounded', (statePath) => {
    if (plantFifo(statePath) === null) return;
    assert.deepEqual(
      readInChild('readJsonResult', statePath, 'FIFO'),
      { kind: 'unreadable', errno: 'not-a-regular-file' },
      'the shape is presence, unopened, and it says which shape',
    );
    assert.equal(readInChild('readText', statePath, 'FIFO'), null,
      'readText folds it where a DIRECTORY at this path already landed');
    assert.equal(fs.lstatSync(statePath).isFIFO(), true, 'and the FIFO is still there, unread and unremoved');
  });
});

test('a symlink to /dev/zero at .one.json is presence, unopened — driven at 20 151 ms before', () => {
  // The read path deliberately FOLLOWS symlinks (bounded-read.ts omits
  // O_NOFOLLOW there), so the bound cannot come from refusing the link: it comes
  // from O_NONBLOCK applying to what the link resolves to and from the `fstat`
  // being taken on the DESCRIPTOR.
  if (process.platform === 'win32' || !fs.existsSync('/dev/zero')) return;
  withProject('devzero-bounded', (statePath) => {
    fs.symlinkSync('/dev/zero', statePath);
    assert.equal(fs.statSync(statePath).isCharacterDevice(), true,
      'fixture guard: the link must really resolve to a character device');
    assert.deepEqual(
      readInChild('readJsonResult', statePath, '/dev/zero link'),
      { kind: 'unreadable', errno: 'not-a-regular-file' },
    );
    assert.equal(readInChild('readText', statePath, '/dev/zero link'), null);
  });
});

test('the 102 call sites: readJson answers its FALLBACK for a FIFO instead of never answering', () => {
  // `readJson`'s signature is unchanged and every non-`ok` kind still maps to the
  // caller's fallback, so the whole point at those sites is that the call
  // RETURNS. Nothing about the fallback moved; what moved is that there is one.
  withProject('fifo-readjson', (statePath) => {
    if (plantFifo(statePath) === null) return;
    assert.deepEqual(readInChild('readJson', statePath, 'FIFO'), { fallback: true });
  });
});

// ── the trap, both directions, one named row each ────────────────────────────

test('TRAP 1: a non-regular file is NEVER `absent` — absence is the verdict that licenses a write', () => {
  withProject('trap-absent', (statePath) => {
    if (plantFifo(statePath) === null) return;
    const read = readInChild('readJsonResult', statePath, 'FIFO') as { kind: string; errno?: string };
    assert.notEqual(read.kind, 'absent',
      'something IS there. `absent` means nothing is, and every read-modify-write consumer writes on it');
    assert.equal(read.kind, 'unreadable');
    assert.ok(read.errno && read.errno !== 'unknown' && read.errno.length > 1,
      'and the errno is NAMED, so an operator reading `cannot be read (…)` learns which shape it was');
  });
});

test('TRAP 2: a non-regular file is NEVER `corrupt` — that arm carries bytes and licenses a REPLACEMENT', () => {
  // The direction a careless adoption takes, and it is worse than the hang it
  // removes: `readRegularFile`-style readers answer `null` for a non-regular
  // file, an O_NONBLOCK FIFO reads as EOF, and empty text parses to nothing —
  // so `corrupt` with `text: ''` is where a FIFO lands unless the kind is
  // classified from the descriptor first. `corrupt` is the arm whose contract is
  // "preserve these bytes, then replace the file".
  withProject('trap-corrupt', (statePath) => {
    if (plantFifo(statePath) === null) return;
    const read = readInChild('readJsonResult', statePath, 'FIFO') as { kind: string; text?: string };
    assert.notEqual(read.kind, 'corrupt',
      'a FIFO whose emptiness is an artefact of HOW WE OPENED IT must not be reported as damaged content');
    assert.equal(read.text, undefined, 'and no bytes are carried, because none were read');
    assert.equal(fs.lstatSync(statePath).isFIFO(), true, 'the shape survives the read that refused it');
  });
});

test('the empty REGULAR file the FIFO must not borrow: still `corrupt`, still WITH its bytes', () => {
  // The other side of TRAP 2, and the reason it cannot be closed by making empty
  // text `unreadable` instead: an empty regular file is the literal signature of
  // an O_TRUNC open that never got its write, and `corrupt` carrying `''` is what
  // lets a caller preserve and replace it. Both verdicts are needed; only the
  // SHAPE tells them apart.
  withProject('empty-regular', (statePath) => {
    fs.writeFileSync(statePath, '', 'utf8');
    assert.deepEqual(readJsonResult(statePath), { kind: 'corrupt', text: '' });
    assert.equal(readText(statePath), '', 'and readText still distinguishes empty bytes from no bytes');
  });
});

// ── behaviour identity for every shape that was already reachable ────────────

test('a DIRECTORY still answers unreadable(EISDIR) — the errno an operator notice prints verbatim', () => {
  // Preserved deliberately rather than folded into the new name. EISDIR is the
  // errno the kernel produces for the read this reader now declines to perform,
  // and folding it MEASURABLY breaks four rows in three files: this one,
  // read-json-result.test.ts's unreadable-not-absent row, and two retention rows
  // that assert the operator notice `cannot be read (EISDIR)` verbatim. (Driven:
  // the `dir-folded` mutant. Three neighbours that look like pins are not —
  // workspace-members asserts only the `illegible` kind, report-id-illegible-state
  // reads its errno through a local raw `readFileSync`, and seed-prompt pins
  // EACCES.) A directory arriving as `not-a-regular-file` would be a behaviour
  // change dressed as a bug fix.
  withProject('directory', (statePath) => {
    fs.mkdirSync(statePath);
    assert.deepEqual(readJsonResult(statePath), { kind: 'unreadable', errno: 'EISDIR' });
    assert.equal(readText(statePath), null);
  });
});

test('reads still FOLLOW symlinks, and a dangling link is still `absent`', () => {
  // The materialize fixtures resolve the plugin's rules/ and skills-catalog/
  // THROUGH links, and fsjson fences no read: __tests__/fsjson-symlink-fence.test.ts
  // owns the write side, this row owns the read side of the same rule.
  withProject('symlink', (statePath) => {
    const real = path.join(path.dirname(statePath), 'real.json');
    fs.writeFileSync(real, '{"resolved":true}\n', 'utf8');
    fs.symlinkSync(real, statePath);
    assert.deepEqual(readJsonResult(statePath), { kind: 'ok', value: { resolved: true } });
    assert.equal(readText(statePath), '{"resolved":true}\n');

    const dangling = path.join(path.dirname(statePath), 'dangling.json');
    fs.symlinkSync(path.join(path.dirname(statePath), 'never-created.json'), dangling);
    assert.deepEqual(readJsonResult(dangling), { kind: 'absent' },
      'ENOENT through a link is genuinely "nothing to read here", and the open reports it as such');
    assert.equal(readText(dangling), null);
  });
});

test('a mode-000 file is unreadable(EACCES): presence by PERMISSION, distinct from presence by SHAPE', () => {
  // Skipped for a root-ish user, who reads straight through mode 000 — the reason
  // the sibling suites plant a directory for their portable `unreadable` fixture.
  if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) return;
  withProject('eacces', (statePath) => {
    fs.writeFileSync(statePath, '{"a":1}\n', 'utf8');
    fs.chmodSync(statePath, 0o000);
    assert.deepEqual(readJsonResult(statePath), { kind: 'unreadable', errno: 'EACCES' },
      'the errno the OPEN gave, not our own name for it — the two are told apart on purpose');
    assert.equal(readText(statePath), null);
    fs.chmodSync(statePath, 0o600);
  });
});

test('an ordinary read is untouched: ok with the value, and readText with the exact bytes', () => {
  withProject('control', (statePath) => {
    const bytes = '{"stack":"default","currentRunId":"17150917850"}\n';
    fs.writeFileSync(statePath, bytes, 'utf8');
    assert.deepEqual(readJsonResult(statePath), { kind: 'ok', value: { stack: 'default', currentRunId: '17150917850' } });
    assert.equal(readText(statePath), bytes, 'byte-for-byte, including the trailing newline');
    assert.deepEqual(readJson(statePath, { fb: true }), { stack: 'default', currentRunId: '17150917850' });
    assert.deepEqual(readJson(path.join(path.dirname(statePath), 'nope.json'), { fb: true }), { fb: true });
  });
});
