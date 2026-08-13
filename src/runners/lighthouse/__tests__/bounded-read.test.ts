// src/runners/lighthouse/__tests__/bounded-read.test.ts
// THE BOUND, DRIVEN — every read this bundle performs, against every shape the
// filesystem can put at the end of a project-relative name.
//
// WHY A DRIVEN SUITE AND NOT A REVIEW OF THE CALL SITES. `bounded-read-census
// .test.ts` proves the bundle's reader bounded FROM ITS SOURCE TEXT: O_NONBLOCK in
// the flags, an `fstat` on the descriptor in the same block. That is a static
// property and it is worth having, but reading a call site is precisely what
// cannot tell a bounded read from an unbounded one — four rounds of that census's
// own history are four rounds of somebody arguing a site was safe and a peer
// hanging it at ~8 s. So the claim is measured here instead, through the REAL
// exported call sites, in a child process whose deadline the parent enforces with
// SIGKILL: an unbounded `open(2)` returns to no event loop, so nothing inside the
// child can observe or report it.
//
// WHAT IT COST BEFORE (driven, one child per shape under a parent SIGKILL at
// 8 000 ms — the figure IS the deadline, not a completed read): every one of the
// six synchronous reads in cli-args.ts and lib.ts sat in `open(2)` at
// 8 006-8 017 ms on a FIFO and 8 031-8 055 ms on a symlink to /dev/zero, against
// controls of 233-1 004 ms. The symlink row is the one that decides how much this
// matters: git stores a link as a mode-120000 blob, so `next.config.js ->
// /dev/zero` arrives in a pull request and materialises on `git clone` with no
// local process and nobody with access to the box.
//
// THE NEGATIVE CONTROL IS LOAD-BEARING. Every bounded arm below would also pass
// against a fixture that was never built, a shape that was never planted, or a
// node that had quietly started refusing FIFOs on its own — so the `bare` arm
// reads the SAME planted object the way this bundle read it before the bound, and
// the suite requires it to be KILLED. A green file with that arm passing would be
// measuring nothing.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PRELOAD = path.join(REPO_ROOT, 'src', 'build', 'test-preload.mjs');
const CHILD = path.join(__dirname, 'bounded-read-child.ts');

// THE DEADLINE COVERS THE READ, NOT THE CHILD. Measured: the read itself takes
// 0-20 ms, while node booting with tsx over this bundle takes 3.6-7.7 s and the
// spread is the box's load, not the code's. A single spawn-to-exit deadline
// therefore has to be wide enough for the worst startup, which makes it useless
// as a statement about the read — and at 5 s it was worse than useless, reddening
// arms at random. So the child announces READY once it has imported and built
// its fixture, and only then does this clock start.
const READ_TIMEOUT_MS = 4000;
// Startup has no upper bound worth asserting; this only stops a child that never
// reaches READY from hanging the suite, and it is reported as a separate failure
// so it can never be mistaken for a read that did not return.
const STARTUP_CAP_MS = 120_000;
const READY = '{"ready":true}';

// mkfifo and /dev/zero are POSIX facts. Windows has neither shape to plant, and a
// suite that skipped silently there would be the same instrument as no suite.
const POSIX = process.platform !== 'win32';

interface Arm {
  readonly site: string;
  readonly shape: string;
  readonly ms: number;
  readonly value: unknown;
  readonly threw: string | null;
}

interface Outcome {
  readonly arm: Arm | null;
  readonly signal: string | null;
  readonly ready: boolean;
}

async function drive(site: string, shape: string): Promise<Outcome> {
  // `os.tmpdir()` at RUNTIME: a project-shaped fixture inside this checkout would
  // trip the plugin-source stand-down fence, and scratch this repo AUTHORS belongs
  // under `.tmp/`. A fixture the test runner creates is neither.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-lhbound-'));
  try {
    return await new Promise<Outcome>((resolve) => {
      const child = spawn(process.execPath, [
        '--import', PRELOAD, '--import', 'tsx', CHILD, root, site, shape,
      ], { cwd: REPO_ROOT, env: process.env });
      let out = '';
      let deadline: NodeJS.Timeout | null = null;
      // SIGKILL, not SIGTERM: a process parked in an uninterruptible `open(2)`
      // can ignore a catchable signal, and a deadline that can be ignored is not
      // one.
      const startup = setTimeout(() => child.kill('SIGKILL'), STARTUP_CAP_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        out += chunk;
        if (deadline || !out.includes(READY)) return;
        clearTimeout(startup);
        deadline = setTimeout(() => child.kill('SIGKILL'), READ_TIMEOUT_MS);
      });
      child.on('close', (_code, signal) => {
        clearTimeout(startup);
        if (deadline) clearTimeout(deadline);
        const line = out.trim().split('\n')
          .filter((row) => row.startsWith('{') && row !== READY).pop();
        resolve({
          arm: line ? JSON.parse(line) as Arm : null,
          signal: signal ?? null,
          ready: out.includes(READY),
        });
      });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Startup is not the measurement, so a child that never got there is not a hang. */
function assertReady(outcome: Outcome, site: string): void {
  assert.equal(outcome.ready, true,
    `the ${site} child never announced READY, so nothing below measures a read: it failed to import, to build `
    + `its fixture, or it was killed at the ${STARTUP_CAP_MS} ms startup cap.`);
}

/**
 * Every read this bundle makes, with the answer a healthy project gives and the
 * answer a shape that cannot be read must give.
 *
 * `refused` is the deliberate part. A bound that turned every read into `null`
 * would satisfy "it returns" and destroy the runner, so each row states where a
 * refusal LANDS in that site's own split — and every one of them is an arm the
 * site already had for an unparseable or missing file, which is why the
 * conversion changed no control.
 */
const SITES: readonly { site: string; control: unknown; refused: unknown; where: string }[] = [
  // `'Infinity'` as a string is the child's JSON crossing, not the runner's
  // answer: an undeclared metric is an UNREACHABLE bound (the contract set no
  // budget, so do not gate that metric) and JSON has no way to say so. It is
  // spelled here rather than folded to null because null is what a REFUSED read
  // produces, and those two must not become the same observation.
  { site: 'contract', control: { performanceMin: 77, fcpMax: 1234, lcpMax: 'Infinity', tbtMax: 'Infinity', clsMax: 'Infinity' }, refused: null, where: 'the run contract\'s budget — refused means "no contract", so the CLI defaults gate the audit' },
  { site: 'runid', control: 'run-abc', refused: null, where: '.traffic-one/.one.json — refused means "not a Traffic One run", so the report directory is unscoped' },
  { site: 'html', control: 'app-deadbeef', refused: null, where: 'the built entry asset — refused means "not built with this layout", so the report carries no build tag' },
  { site: 'buildid', control: 'bid-12345', refused: null, where: '.next/BUILD_ID — same fallback as html, one layout further down' },
  { site: 'readjson', control: { json: { name: 'fx', packageManager: 'pnpm@9.0.0' }, packageManager: 'pnpm' }, refused: { json: null, packageManager: 'npm' }, where: 'package.json — refused means "no declaration", so detection falls back to npm' },
  { site: 'nextconfig', control: true, refused: false, where: 'next.config.js — refused means "no evidence of a static export", so the runner previews it the ordinary way' },
];

// SERIAL ON PURPOSE, and this was measured rather than assumed. Each arm is a
// whole node+tsx boot over this bundle — 3.6-7.7 s of wall clock for ~0.6 s of
// CPU — so overlapping four of them took this file from 150 s to 50 s and looked
// free. It is not: node runs test FILES in parallel, and the neighbour
// `preview-start-failure.test.ts` times a real runner against a 4 000 ms
// readiness budget, which the extra load pushed to 5 234 ms. A suite that reds
// the file next to it is not faster, it is broken.
describe('the bundle\'s reads, driven against every shape', { concurrency: 1 }, () => {
  for (const row of SITES) {
    test(`${row.site}: a regular file still reads — ${row.where}`, async () => {
      const outcome = await drive(row.site, 'control');
      const { arm, signal } = outcome;
      assertReady(outcome, row.site);
      assert.equal(signal, null, 'the control must not be killed');
      assert.equal(arm?.threw, null, `the control must not throw: ${String(arm?.threw)}`);
      assert.deepEqual(arm?.value, row.control,
        'A BOUND THAT EMPTIES THE READ IS NOT A FIX. This arm is why every refusal below is worth anything: '
        + 'the site must still parse a normal file into exactly what the runner acts on.');
    });

    for (const shape of ['fifo', 'devzero'] as const) {
      test(`${row.site}: a ${shape} is REFUSED, not waited on`, { skip: POSIX ? false : 'POSIX shapes' }, async () => {
        const outcome = await drive(row.site, shape);
        const { arm, signal } = outcome;
        assertReady(outcome, row.site);
        assert.equal(signal, null,
          `${row.site} was KILLED at the ${READ_TIMEOUT_MS} ms deadline on a ${shape}, i.e. it never returned. `
          + 'open(O_RDONLY) on a FIFO waits for a writer forever and a character device answers a read as long as '
          + 'anybody keeps asking; the bound is O_NONBLOCK plus an fstat on the DESCRIPTOR (../bounded-read.ts).');
        assert.deepEqual(arm?.value, row.refused,
          'the refusal must land where this site\'s existing fallback lands, and nowhere else');
      });
    }
  }

  test('a DANGLING link is absent, not refused — the two must not fold together', async () => {
    const outcome = await drive('runid', 'dangling');
    assertReady(outcome, 'runid');
    assert.equal(outcome.signal, null, 'a dangling link is ENOENT at the open and must return at once');
    assert.equal(outcome.arm?.value, null, 'nothing is there, so there is no run id');
  });

  test('a DIRECTORY at a file path is refused without reading it', async () => {
    const outcome = await drive('runid', 'directory');
    assertReady(outcome, 'runid');
    assert.equal(outcome.signal, null, 'a directory must be classified from the descriptor, not read');
    assert.equal(outcome.arm?.value, null, 'a directory is not a run id');
  });

  test('the static preview STREAMS a regular file, and refuses a FIFO in front of the stream', async () => {
    const control = await drive('stream', 'control');
    assertReady(control, 'stream');
    assert.equal(control.signal, null, 'the control must not be killed');
    assert.equal(control.arm?.value, 'REAL PAGE',
      'the preview server must still serve the bytes: the descriptor is handed to createReadStream, which '
      + 'ignores the path when `options.fd` is present');

    if (!POSIX) return;
    const fifo = await drive('stream', 'fifo');
    assertReady(fifo, 'stream');
    assert.equal(fifo.signal, null,
      'the stream site was KILLED on a FIFO. This is the site resolveStaticFile stats before opening, so the '
      + 'shape arrives by SUBSTITUTION between the stat and the open — and each one that lands wedges a libuv '
      + 'threadpool thread until file I/O in the whole process stops.');
    assert.equal(fifo.arm?.threw, 'not-a-regular-file',
      'a non-regular shape must throw in front of the stream, where the handler\'s own catch answers 500 — not '
      + 'as an `error` event on a stream nobody is listening to');
  });

  test('THE NEGATIVE CONTROL: the same object, read the way this bundle read it before, HANGS', { skip: POSIX ? false : 'POSIX shapes' }, async () => {
    const outcome = await drive('bare', 'fifo');
    const { arm, signal } = outcome;
    assertReady(outcome, 'bare');
    assert.equal(signal, 'SIGKILL',
      'A PLAIN readFileSync OF A FIFO RETURNED. Every bounded arm in this file is measured against this one, so '
      + 'if the unbounded read has stopped blocking then the fixture, the shape or the platform has changed and '
      + 'the green arms above are measuring nothing. Find out which before deleting this test.');
    assert.equal(arm, null, 'a read that never returns writes no result line');
  });
});
