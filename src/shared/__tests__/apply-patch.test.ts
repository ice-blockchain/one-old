import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseApplyPatch, patchOperationPaths, patchTextFromToolInput } from '../apply-patch';

const SIMPLE_PATCH = [
  '*** Begin Patch',
  '*** Add File: src/new.ts',
  '+export const value = 1;',
  '*** End Patch',
].join('\n');

test('patchTextFromToolInput normalizes all attested host payload shapes', () => {
  for (const input of [
    SIMPLE_PATCH,
    { input: SIMPLE_PATCH },
    { patch: SIMPLE_PATCH },
    { patchText: SIMPLE_PATCH },
    { patch_text: SIMPLE_PATCH },
    { diff: SIMPLE_PATCH },
    { content: SIMPLE_PATCH },
    { command: SIMPLE_PATCH },
    { output: { args: { patch: SIMPLE_PATCH } } },
    { tool_input: { patch_text: SIMPLE_PATCH } },
  ]) {
    assert.equal(patchTextFromToolInput(input), SIMPLE_PATCH);
  }
  assert.equal(
    patchTextFromToolInput({ content: 'unrelated' }, { output: { args: { patch: SIMPLE_PATCH } } }),
    SIMPLE_PATCH,
    'a patch-looking nested value wins over unrelated sibling content',
  );
});

test('parseApplyPatch reconstructs add/update/delete/move atomically', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-apply-patch-'));
  try {
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'existing.ts'), 'alpha\nold\nomega\n', 'utf8');
    fs.writeFileSync(path.join(cwd, 'src', 'move.ts'), 'move me\n', 'utf8');
    fs.writeFileSync(path.join(cwd, 'src', 'delete.ts'), 'gone\n', 'utf8');
    const patch = [
      '*** Begin Patch',
      '*** Add File: ./src/new.ts',
      '+export const added = true;',
      '*** Update File: src/existing.ts',
      '@@',
      ' alpha',
      '-old',
      '+new',
      ' omega',
      '*** Update File: src/move.ts',
      '*** Move to: src/moved.ts',
      '@@',
      '-move me',
      '+move better',
      '*** Delete File: src/delete.ts',
      '*** End Patch',
    ].join('\n');

    const result = parseApplyPatch(patch, { baseDir: cwd });
    assert.equal(result.ok, true, result.ok ? undefined : result.error);
    if (!result.ok) return;
    assert.deepEqual(result.operations.map((operation) => operation.kind), ['add', 'update', 'move', 'delete']);
    assert.deepEqual(patchOperationPaths(result.operations), [
      'src/new.ts', 'src/existing.ts', 'src/move.ts', 'src/moved.ts', 'src/delete.ts',
    ]);
    assert.equal(result.operations[0]?.resultContent, 'export const added = true;\n');
    assert.equal(result.operations[1]?.resultContent, 'alpha\nnew\nomega\n');
    assert.equal(result.operations[1]?.addedContent, 'new');
    assert.equal(result.operations[2]?.resultContent, 'move better\n');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('parseApplyPatch rejects malformed and unreconstructable non-empty patches', () => {
  const malformed = parseApplyPatch('*** Begin Patch\n*** Update File: src/a.ts\nnot-a-hunk\n*** End Patch');
  assert.equal(malformed.ok, false);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-apply-patch-invalid-'));
  try {
    const missing = parseApplyPatch([
      '*** Begin Patch',
      '*** Update File: src/missing.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'), { baseDir: cwd });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /missing\.ts|does not exist/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('parseApplyPatch treats Delete File as path-only, including binary targets', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1-apply-patch-delete-'));
  try {
    fs.writeFileSync(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
    const result = parseApplyPatch([
      '*** Begin Patch',
      '*** Delete File: binary.bin',
      '*** End Patch',
    ].join('\n'), { baseDir: cwd });
    assert.equal(result.ok, true, result.ok ? undefined : result.error);
    if (result.ok) assert.deepEqual(result.operations, [{
      kind: 'delete', path: 'binary.bin', addedContent: '',
    }]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ── the patch TARGET is read in bounded time, and the refusal names the shape ─
//
// THE DEFECT, DRIVEN BEFORE IT WAS FIXED, AT TWO LEVELS. These rows are unit
// rows — they call `parseApplyPatch` — so the unit measurement is what they are
// priced against, and the GATE measurement is what says the unit is the gate's
// only bound. Both are on disk. One shape per child, the resolved path printed
// before the read so a case that never reached the code cannot pass quietly.
//
//   AT THE UNIT, `parseApplyPatch(patch, { baseDir })`, 12 000 ms SIGKILL alarm
//   (load 30.58 → 32.24 of 10 cpus):
//     FIFO at the Update File target             SIGKILL 12 009 ms
//     symlink to /dev/zero at the same target    SIGKILL 12 042 ms
//     regular file (control)                     returned 13 ms
//   after: 196 ms and 49 ms, both REFUSED by name, control still `ok` in 10 ms.
//
//   AT THE GATE, `planWriteGate` over a PreToolUse `apply_patch` envelope,
//   20 000 ms SIGKILL (load 4.61 → 4.20 of 10 cpus):
//     FIFO                                       SIGKILL 20 019 ms
//     symlink to /dev/zero                       SIGKILL 20 098 ms
//   after: both DENY in 4 ms with `apply-patch-reconstruction-failed`; the
//   regular-file control reconstructs and the gate walks on to its state check.
//
// WHY THIS SITE IS THE WORST ONE IN THE CLASS. `plan-guard/plan-write/index.ts`
// calls `parseApplyPatch(rawPatchText, { baseDir: patchBase })` inside the
// PreToolUse gate, after the stand-down and consent checks. The path comes from
// the patch TEXT — the agent's own tool call, i.e. prompt-injectable — and the
// object at that path comes from the repository, so a committed
// `symlink -> /dev/zero` arrives through an ordinary clone with no local
// process. `readCurrent`'s `catch` could not see any of it: a catch reports a
// read that RETURNS.
//
// WHY THE BLOCKING SHAPES ARE READ IN A CHILD, and it is not fastidiousness:
// `npm test` passes no `--test-timeout`, and node's test timeout is a timer on
// the event loop a blocked synchronous read is holding, so it never fires even
// when it is passed (MEASURED by the round-1 peer at >10 minutes under
// `--test-timeout=30000`). An in-process row here would WEDGE this suite
// instead of failing it, and a red row is worth more than a hung run. Same
// split, and the same reason, as fsjson-bounded-read.test.ts.

const APPLY_PATCH_MODULE = path.join(__dirname, '..', 'apply-patch.ts');

/** A FIFO, or `null` when the platform has no `mkfifo` — the shape is then
 *  unreachable rather than unpinned, the answer the lock suites give on Windows. */
function plantFifo(at: string): string | null {
  try {
    execFileSync('mkfifo', [at], { stdio: 'ignore' });
  } catch {
    return null;
  }
  assert.equal(fs.lstatSync(at).isFIFO(), true, 'fixture guard: the planted entry must really be a FIFO');
  return at;
}

const UPDATE_PATCH = [
  '*** Begin Patch',
  '*** Update File: notes.md',
  '@@',
  '-alpha',
  '+ALPHA',
  '*** End Patch',
].join('\n');

/**
 * Reconstruct `UPDATE_PATCH` against `baseDir` in a CHILD PROCESS, and fail if
 * the child did not RETURN. Requires apply-patch.ts through `--import tsx` and
 * inherits this process's environment, so the preload's
 * `TRAFFIC_ONE_PLUGIN_ROOT` pin travels and the child reads through the same
 * tree this suite asserts about.
 */
function reconstructInChild(baseDir: string, label: string): { ok: boolean; error?: string } {
  const driver = path.join(baseDir, 'drive-parse.cjs');
  fs.writeFileSync(driver, [
    'const { parseApplyPatch } = require(process.argv[2]);',
    'process.stdout.write(JSON.stringify(parseApplyPatch(process.argv[4], { baseDir: process.argv[3] })));',
  ].join('\n'), 'utf8');

  // SIGKILL rather than spawnSync's default SIGTERM. DRIVEN (load 2.56 of 10
  // cpus) against a child blocked in `open(2)` on a FIFO that had registered a
  // SIGTERM handler: with the default, spawnSync's own 3 000 ms timeout expired
  // and spawnSync STILL NEVER RETURNED — the outer deadline had to SIGKILL it at
  // 15 006 ms, and the blocked child survived as an orphan holding the FIFO open.
  // With `killSignal: 'SIGKILL'`, 3 004 ms and the child reaped.
  //
  // So the deadline was never enforced from outside this process: a signal the
  // child can decline leaves the parent waiting on `waitpid`, which is the same
  // wedge these rows exist to detect, moved one process up. Nothing under test
  // installs a SIGTERM handler today; the row does not need that to stay true.
  const run = spawnSync(process.execPath, ['--import', 'tsx', driver, APPLY_PATCH_MODULE, baseDir, UPDATE_PATCH], {
    encoding: 'utf8',
    timeout: 20_000,
    killSignal: 'SIGKILL',
  });

  assert.equal(run.signal, null,
    `${label}: the reconstruction must RETURN rather than block in open(2) — killed by signal means the bound is gone. `
    + `This is a PreToolUse gate on an agent-supplied path: it never returns, so there is no deny and nothing logged. `
    + `stderr: ${run.stderr || ''}`);
  assert.equal(run.status, 0, `${label}: ${run.stderr || ''}`);
  return JSON.parse(run.stdout) as { ok: boolean; error?: string };
}

function withBase<T>(label: string, fn: (baseDir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `t1-apply-bounded-${label}-`));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a FIFO at the patch target is refused in BOUNDED time — driven at 12 009 ms before', () => {
  withBase('fifo', (dir) => {
    if (plantFifo(path.join(dir, 'notes.md')) === null) return;
    const parsed = reconstructInChild(dir, 'FIFO');
    assert.equal(parsed.ok, false);
    assert.match(parsed.error ?? '', /cannot reconstruct a non-regular file/,
      'and the refusal names the SHAPE');
    assert.equal(fs.lstatSync(path.join(dir, 'notes.md')).isFIFO(), true,
      'the FIFO is still there, unread and unremoved');
  });
});

test('a symlink to /dev/zero at the patch target is refused in BOUNDED time — driven at 12 042 ms before', () => {
  // The read deliberately FOLLOWS links (bounded-read.ts omits O_NOFOLLOW in
  // `readRegularFile`), so the bound cannot come from refusing the link: it
  // comes from O_NONBLOCK applying to what the link resolves to and from the
  // `fstat` being taken on the DESCRIPTOR. A repository may legitimately commit
  // a symlinked source file, so refusing links here would be a behaviour change.
  if (process.platform === 'win32' || !fs.existsSync('/dev/zero')) return;
  withBase('devzero', (dir) => {
    const target = path.join(dir, 'notes.md');
    fs.symlinkSync('/dev/zero', target);
    assert.equal(fs.statSync(target).isCharacterDevice(), true,
      'fixture guard: the link must really resolve to a character device');
    const parsed = reconstructInChild(dir, '/dev/zero link');
    assert.equal(parsed.ok, false);
    assert.match(parsed.error ?? '', /cannot reconstruct a non-regular file/);
  });
});

test('a non-regular patch target is NEVER reported as absent — the deny reason is the agent\'s next action', () => {
  // A DIRECTORY, so this row costs no child: `open(O_RDONLY)` on one returns
  // EISDIR immediately and cannot block. The property is the MESSAGE, and it is
  // load-bearing rather than cosmetic. This string reaches the agent through
  // `apply-patch-reconstruction-failed`, whose remedy is documented at the gate
  // as "re-read the file and rebuild the hunks": told about a non-regular
  // object that advice sends the agent back to read it, and folded into
  // `does not exist` it reads as a file to CREATE. Same ruling, same reason, as
  // plan-write/targets.ts's `target is not a regular file`.
  withBase('directory', (dir) => {
    fs.mkdirSync(path.join(dir, 'notes.md'));
    const parsed = parseApplyPatch(UPDATE_PATCH, { baseDir: dir });
    assert.equal(parsed.ok, false);
    const error = parsed.ok ? '' : parsed.error;
    assert.match(error, /cannot reconstruct a non-regular file/);
    assert.doesNotMatch(error, /does not exist/,
      'something IS at that path; "does not exist" is the one verdict that licenses creating it');
  });
});

test('a genuinely ABSENT patch target still says so — the fold this refusal is kept out of', () => {
  // The other side of the row above: `readRegularFile` THROWS for a path that
  // cannot be opened at all, and that throw must still land in the ENOENT arm.
  // Folding the two together in either direction is the fail-open direction.
  withBase('absent', (dir) => {
    const parsed = parseApplyPatch(UPDATE_PATCH, { baseDir: dir });
    assert.equal(parsed.ok, false);
    const error = parsed.ok ? '' : parsed.error;
    assert.match(error, /does not exist or is unreadable/);
    assert.doesNotMatch(error, /non-regular/);
  });
});
