// src/runners/qa-evidence/__tests__/bounded-command-surface.test.ts
// The PROMISE SURFACE of `runBoundedCommand`, termination by termination.
//
// Written to answer one question and no others: if this runner's last
// independent bounded-spawn implementation is folded onto `runBoundedProcess`,
// does anything a caller can observe change? Everything Lighthouse can see of
// that spawn arrives through exactly one channel — a promise that resolves with
// two strings or rejects with an Error — and `runLighthouseOnOwnedServer` then
// turns `error.message` into `blocked-environment` or `failed` by matching a
// regex against it. So the observable is: WHICH terminations resolve, the exact
// text and type of the Error for the ones that reject, and WHEN.
//
// Every assertion here was taken against the pre-fold implementation and must
// keep passing verbatim afterwards. That ordering is the whole value of the
// file: a pin written after a translation records the translation, not the
// behaviour it was supposed to preserve.
//
// THE FOLD IT WAS WRITTEN FOR DID NOT LAND, and these pins are why. Measured
// against a translation that kept every message text deliberately identical,
// four of them still failed, because the two functions do not differ only in
// what they do with the result:
//
//   - a browser holding the audit's stdout: 74 ms here, 20 013 ms folded, on a
//     20 s bound — `runBoundedProcess` settles on `close`, and no pipe with a
//     live writer ever closes, so the verdict waits out the whole bound. At this
//     step's real bound that is two minutes per audit.
//   - 9 MiB of output: resolves here, REJECTS folded — the native path kills at
//     `MAX_NATIVE_PROCESS_OUTPUT`, which turns a working audit into `failed`.
//   - output between 1 and 8 MiB: tail-retained here, head-retained folded, so
//     the 500-character blocker summary quotes a different part of the failure.
//   - a missing binary: node's own ErrnoException here, a rebuilt Error folded,
//     so `code`/`syscall`/`path` are gone (the message text does survive).
//
// The first two are behaviour changes with no defect behind them, in the wrong
// direction, on the shape this lane spent a round proving is real. The
// duplication is worth removing only by a change that keeps them: this file is
// what such a change has to satisfy.
//
// Process groups, `detached` and signal deaths are POSIX, and the shells below
// are too; `__tests__/process-group.test.ts:38` skips for the same reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runBoundedCommand } from '../lighthouse';

const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX process groups' : false };
const TEST_TIMEOUT_MS = 30_000;

const posixTest = (
  name: string,
  options: { timeout?: number },
  fn: () => Promise<void> | void,
): void => { test(name, { ...POSIX_ONLY, ...options }, fn); };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The tail each captured stream is held to. Pinned, not imported: see below. */
const CAPTURE_TAIL_BYTES = 1024 * 1024;

interface Settled {
  outcome: 'resolved' | 'rejected';
  value: { stdout: string; stderr: string } | null;
  error: unknown;
  elapsedMs: number;
}

/**
 * Run the shell and record HOW it ended rather than letting the ending escape.
 *
 * A rejection is half the surface under test here, so it cannot be allowed to
 * fail the test on its own; and the elapsed time is part of the surface too —
 * the difference between settling on a leader's `exit` and settling on its
 * `close` is invisible in the resolved value and worth a hundred seconds to a
 * caller.
 */
async function settle(
  command: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<Settled> {
  const startedAt = Date.now();
  try {
    const value = await runBoundedCommand(command, argv, cwd, timeoutMs);
    return { outcome: 'resolved', value, error: null, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { outcome: 'rejected', value: null, error, elapsedMs: Date.now() - startedAt };
  }
}

function shell(script: string, cwd: string, timeoutMs: number): Promise<Settled> {
  return settle('/bin/sh', ['-c', script], cwd, timeoutMs);
}

function rejectionMessage(settled: Settled): string {
  assert.equal(settled.outcome, 'rejected', 'this termination must REJECT, and it resolved');
  assert.ok(settled.error instanceof Error, `a rejection must be an Error, got ${typeof settled.error}`);
  return (settled.error as Error).message;
}

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-lh-surface-'));
}

// ── the two resolving terminations ───────────────────────────────────────────

posixTest('a run that exits 0 resolves with both streams as captured', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = scratch();
  try {
    const settled = await shell("printf 'out'; printf 'err' 1>&2; exit 0", dir, 5_000);
    assert.equal(settled.outcome, 'resolved', `exit 0 must resolve, rejected with ${String(settled.error)}`);
    assert.deepEqual(settled.value, { stdout: 'out', stderr: 'err' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The bookkeeping half: a settled run leaves the host's interrupt disposition
 * exactly as it found it.
 *
 * `reapOnInterrupt` installs process-wide `SIGINT`/`SIGTERM`/`exit` listeners
 * while a group is live, and a handled SIGINT no longer terminates by default —
 * so a run that forgot to deregister would silently stop this process from
 * answering Ctrl-C. Counted as a DELTA because the test runner has handlers of
 * its own. `process-group.test.ts:849` pins the same property for the other
 * spawn; this is the same claim for this one.
 */
posixTest('a settled run deregisters its interrupt reaper', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = scratch();
  const counts = (): string => (['SIGINT', 'SIGTERM', 'exit'] as const)
    .map((event) => `${event}=${process.listenerCount(event)}`).join(' ');
  try {
    const before = counts();
    await shell('exit 0', dir, 5_000);
    assert.equal(counts(), before, 'a bounded run must leave the host signal disposition as it found it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the rejecting terminations ───────────────────────────────────────────────

posixTest('a non-zero exit rejects naming the code, quoting stderr', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = scratch();
  try {
    const settled = await shell("printf 'boom'; printf 'bad flag' 1>&2; exit 7", dir, 5_000);
    assert.equal(rejectionMessage(settled), 'Lighthouse exited 7: bad flag');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// `stderr || stdout`: a CLI that reports its failure on stdout is the ordinary
// case for a `--quiet` tool, and the message must not be an empty tail.
posixTest('a non-zero exit with an empty stderr quotes stdout instead', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = scratch();
  try {
    const settled = await shell("printf 'only on stdout'; exit 3", dir, 5_000);
    assert.equal(rejectionMessage(settled), 'Lighthouse exited 3: only on stdout');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A signal death has NO exit code, and the signal name takes the code's place
 * in the message.
 *
 * This is the termination a translation loses most easily: `code ?? signal` reads
 * as a fallback for a missing number, and the fallback is the whole content of
 * the message for every OOM kill, segfault and external SIGTERM.
 */
posixTest('a signal death names the signal where the exit code would be', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = scratch();
  try {
    const settled = await shell("printf 'dying' 1>&2; kill -TERM $$", dir, 5_000);
    assert.equal(rejectionMessage(settled), 'Lighthouse exited SIGTERM: dying');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const BOUND_MS = 1_000;
/**
 * How late the bound's own rejection may arrive.
 *
 * TIGHT ON PURPOSE. This implementation rejects from the timer callback itself,
 * so the reading is the bound plus one group kill (three sweeps, 5 ms apart at
 * worst) — measured at single-digit milliseconds past the bound. The window is
 * 250 ms rather than 10 because a loaded box is the population that matters,
 * and it is still far below any settlement path that waits for a second timer.
 */
const BOUND_SETTLE_WINDOW_MS = 250;

posixTest('the bound rejects with the bound it was given, and at it', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = scratch();
  try {
    const settled = await shell('sleep 30', dir, BOUND_MS);
    assert.equal(rejectionMessage(settled), `Lighthouse timed out after ${BOUND_MS}ms`);
    assert.ok(
      settled.elapsedMs >= BOUND_MS && settled.elapsedMs < BOUND_MS + BOUND_SETTLE_WINDOW_MS,
      `the bound must be a bound: expected settlement in [${BOUND_MS}, ${BOUND_MS + BOUND_SETTLE_WINDOW_MS}) ms, `
      + `took ${settled.elapsedMs} ms`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A spawn that never starts rejects with NODE'S OWN error object, untouched.
 *
 * Both halves are load-bearing. The message is what
 * `runLighthouseOnOwnedServer` matches `/enoent/i` against to answer
 * `blocked-environment` rather than `failed` — a missing browser or an
 * unexecutable CLI is an environment the run cannot be blamed for — and the
 * `code`/`syscall`/`path` properties are what any other caller of an exported
 * function would reach for. A rebuilt `new Error(text)` keeps the first and
 * silently drops the second.
 */
posixTest('a binary that does not exist rejects with the spawn error itself', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = scratch();
  const missing = path.join(dir, 'node_modules', '.bin', 'lighthouse');
  try {
    const settled = await settle(missing, ['--quiet'], dir, 5_000);
    const error = settled.error as NodeJS.ErrnoException;
    assert.equal(rejectionMessage(settled), `spawn ${missing} ENOENT`);
    assert.equal(error.code, 'ENOENT', 'the spawn error must keep its code');
    assert.equal(error.syscall, `spawn ${missing}`, 'the spawn error must keep its syscall');
    assert.ok(
      /chrome.*(?:not found|missing|launch|executable)|enoent|permission/i.test(error.message),
      'and the message must be the one the caller reads as blocked-environment',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── what output does, and does not, do ───────────────────────────────────────

/**
 * Output is CAPPED AS A TAIL and never stops the run.
 *
 * Two independent claims, both observable. The cap keeps the LAST megabyte of
 * each stream, so a chatty failure reports the lines nearest the failure rather
 * than the banner it opened with — and it does not kill, so no volume of output
 * can turn a completed audit into a cut-short one. `runBoundedProcess` answers
 * both differently (8 MiB across BOTH streams, head-retained, and a kill at the
 * cap), which is why this is pinned by observation rather than by importing a
 * constant.
 */
posixTest('output past the tail cap keeps the end of the stream, not the start', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = scratch();
  try {
    const emitter = path.join(dir, 'chatty.js');
    fs.writeFileSync(emitter, [
      "process.stderr.write('HEAD-MARKER' + 'x'.repeat(1_500_000) + 'TAIL-MARKER');",
      'process.exitCode = 1;',
      '',
    ].join('\n'));
    const settled = await settle(process.execPath, [emitter], dir, 20_000);
    const message = rejectionMessage(settled);
    assert.ok(message.startsWith('Lighthouse exited 1: '), `unexpected rejection: ${message.slice(0, 120)}`);
    assert.ok(message.endsWith('TAIL-MARKER'), 'the tail of the stream must survive');
    assert.ok(!message.includes('HEAD-MARKER'), 'and the head is what is dropped');
    assert.equal(
      message.length - 'Lighthouse exited 1: '.length,
      CAPTURE_TAIL_BYTES,
      'each stream is held to exactly the last megabyte',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

posixTest('a run that writes far more than the native output bound still runs to completion', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = scratch();
  try {
    const emitter = path.join(dir, 'flood.js');
    // 9 MiB, past `MAX_NATIVE_PROCESS_OUTPUT`, which the native path answers by
    // KILLING the run. Lighthouse writes its evidence to a file, so output
    // volume here is never a reason to stop an audit that is working.
    fs.writeFileSync(emitter, [
      "process.stdout.write('y'.repeat(9 * 1024 * 1024));",
      '',
    ].join('\n'));
    const settled = await settle(process.execPath, [emitter], dir, 20_000);
    assert.equal(
      settled.outcome,
      'resolved',
      `a noisy audit that exits 0 must still resolve, rejected with ${String(settled.error)}`,
    );
    assert.equal(settled.value?.stdout.length, CAPTURE_TAIL_BYTES);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the termination that decides whether the fold is a fold ──────────────────

/**
 * A BROWSER STILL HOLDING THE AUDIT'S STDOUT MUST NOT DELAY ITS RESULT.
 *
 * The shape is the one `server-teardown.test.ts:488` uses for the leak: a
 * wrapper that starts a long-lived child and exits 0, where the child inherited
 * fd 1 and therefore holds the pipe open after its parent is gone. `exit` has
 * fired; `close` cannot, because a pipe with a live writer does not end.
 *
 * This implementation settles on `exit`, so the audit's verdict is available the
 * moment the CLI is done — and Lighthouse's evidence is the JSON artifact on
 * disk, not the stream, so there is nothing left to wait for. A settlement path
 * that waits for `close` instead cannot answer until the bound expires, and this
 * step's bound is at least `LIGHTHOUSE_MIN_TIMEOUT_MS` — two minutes of waiting
 * for a result that was ready immediately, on the one shape this lane spent a
 * round proving is real.
 */
const HOLDER_BOUND_MS = 20_000;
const HOLDER_SETTLE_CEILING_MS = 2_000;

posixTest('a browser left holding the audit stdout does not delay the audit result', { timeout: TEST_TIMEOUT_MS }, async () => {
  const dir = scratch();
  let holderPid = 0;
  try {
    const pidFile = path.join(dir, 'chrome.pid');
    const chrome = path.join(dir, 'chrome.js');
    fs.writeFileSync(chrome, [
      "const fs = require('fs');",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'setTimeout(() => {}, 600000);',
      '',
    ].join('\n'));
    const script = `${JSON.stringify(process.execPath)} ${JSON.stringify(chrome)} &\n`
      + `while [ ! -s ${JSON.stringify(pidFile)} ]; do sleep 0.02; done\n`;
    const settled = await shell(script, dir, HOLDER_BOUND_MS);
    assert.equal(
      settled.outcome,
      'resolved',
      `the wrapper exited 0, so the audit succeeded — rejected with ${String(settled.error)}`,
    );
    assert.ok(
      settled.elapsedMs < HOLDER_SETTLE_CEILING_MS,
      'a result that is ready must not wait for a pipe the browser is holding: expected settlement within '
      + `${HOLDER_SETTLE_CEILING_MS} ms of a ${HOLDER_BOUND_MS} ms bound, took ${settled.elapsedMs} ms`,
    );
    holderPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(holderPid > 1, 'fixture guard: the stand-in browser never started');
  } finally {
    if (holderPid > 1 && alive(holderPid)) {
      try { process.kill(holderPid, 'SIGKILL'); } catch { /* gone */ }
    }
    await sleep(0);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
