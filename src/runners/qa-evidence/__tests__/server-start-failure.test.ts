// src/runners/qa-evidence/__tests__/server-start-failure.test.ts
// A dev-server command the operating system REFUSES must land as the runner's
// inconclusive result, never as the end of the runner.
//
// `startCommandServer` attached no `error` listener, and node delivers exactly
// five spawn failures asynchronously on the child rather than throwing them out
// of `spawn` — ENOENT, EACCES, EAGAIN, EMFILE, ENFILE (internal/child_process.js
// hands those to `process.nextTick`; everything else, the UV_EINVAL a `.cmd`
// earns among it, is thrown and was already caught by `startCommandServer` being
// an async function). So a missing binary, a file without the execute bit, and
// every Windows package-manager wrapper before the shim routing landed all
// arrived as an UNCAUGHT `spawn … ENOENT` that ended the process mid-run.
//
// Measured before this file existed, on darwin with an ordinary missing binary:
// exit 1 with node's uncaught-exception trace, no verdict printed, and — because
// an uncaught exception unwinds nothing — `main`'s `finally` skipped, so neither
// the teardown nor the lock release ran. That is the extreme form of the defect
// this lane exists to close: not a verdict the runner did not measure, but no
// verdict at all, with nothing to tell "the project's server is broken" from
// "the runner fell over", and a dev server left running behind it.
//
// The LOCK is not part of that damage, and an earlier version of this comment
// said it was ("the next run reported `already-running`"). It cannot: the
// holder pid dies with the process, and `lock.ts` reclaims a dead holder on the
// spot — a probe that predates this file. A skipped release leaves a file
// behind, not a wedge, and the only shape that wedges a readable holder is a
// RECYCLED pid, which is the age bound in `lockStale`, not this. Skipping the
// teardown is the real cost and is reason enough for the listener.
//
// The two failures that must never be blurred are the two whose repairs differ:
// a command that NEVER STARTED is a wrong command, and a command that NEVER
// LISTENED is a server that ran and did not bind. Both rows are here, side by
// side, because the distinction is the deliverable.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { killProcessGroup, spawnedGroupId } from '../process-group';
import { startCommandServer } from '../server';
import { type RunnerArgs } from '../types';

// The refusals here are POSIX file-permission and PATH failures, and the
// interrupt-reaper row asks about signal listeners. Skipped explicitly, as
// __tests__/server-teardown.test.ts:39 does.
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX exec failures and signals' : false };
const TEST_TIMEOUT_MS = 30_000;

/**
 * A bound this runner would spend if the refusal were not noticed: long enough
 * that a row finishing inside it proves the wait GAVE UP rather than expired,
 * and short enough that a regression fails the suite instead of hanging it.
 */
const GENEROUS_BOUND_MS = 20_000;

const TEMP_DIRS = new Set<string>();

after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

const LOADED_RUN = {
  sourceHash: 'source',
  fingerprint: 'fingerprint',
  manifest: { files: [], manifestHash: 'build', outputRoot: '.' },
} as never;

interface Refusal {
  dir: string;
  /** A path libuv cannot execute: absent, or present without the execute bit. */
  binary: string;
}

function project(kind: 'absent' | 'not-executable'): Refusal {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-srv-refused-'));
  TEMP_DIRS.add(dir);
  const binary = path.join(dir, kind === 'absent' ? 'dev-server-that-is-not-here' : 'dev-server.sh');
  if (kind === 'not-executable') {
    // Readable, present, and unexecutable: EACCES rather than ENOENT, which is
    // the second of the five asynchronous shapes and the one a project earns by
    // committing a script without its mode bit.
    fs.writeFileSync(binary, '#!/bin/sh\nexec sleep 600\n');
    fs.chmodSync(binary, 0o400);
  }
  return { dir, binary };
}

async function startAndFail(
  dir: string,
  argv: readonly string[],
  timeoutMs: number,
): Promise<{ error: NodeJS.ErrnoException & { kind?: string }; elapsedMs: number }> {
  const args = {
    command: 'browser',
    projectRoot: dir,
    runId: 'server-refusal-probe',
    buildDir: 'dist',
    withLighthouse: false,
    timeoutMs,
    serverCommandJson: JSON.stringify(argv),
  } as unknown as RunnerArgs;
  const startedAtMs = Date.now();
  try {
    await startCommandServer(args, LOADED_RUN);
  } catch (error) {
    return {
      error: error as NodeJS.ErrnoException & { kind?: string },
      elapsedMs: Date.now() - startedAtMs,
    };
  }
  assert.fail('a command that cannot be executed must never yield a serving pair');
}

/**
 * THE DEFECT, from the caller's side.
 *
 * A rejection is what `startCommandServer` already promises its caller for a
 * server that does not come up — `browserCommand` lets it travel to `main`,
 * which prints it and exits 1 — so the refusal has to arrive the same way. That
 * this row can run at all in the test process is the assertion: an unhandled
 * `'error'` event is not catchable, and before the listener existed this file
 * would have taken the whole suite down with it rather than failing.
 */
test('a dev-server command that cannot be executed rejects rather than ending the runner', { ...POSIX_ONLY, timeout: TEST_TIMEOUT_MS }, async () => {
  const fix = project('absent');
  const { error } = await startAndFail(fix.dir, [fix.binary], GENEROUS_BOUND_MS);
  assert.equal(
    error.kind,
    'unavailable',
    'a process that never started is `unavailable` — the kind runBoundedProcess already answers with',
  );
  assert.equal(
    (error.cause as NodeJS.ErrnoException | undefined)?.code,
    'ENOENT',
    "the operating system's own errno must survive on the cause",
  );
  assert.match(
    error.message,
    /could not be executed/,
    'the message must say the command was refused',
  );
  assert.match(
    error.message,
    new RegExp(fix.binary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'and it must name the command the operator has to repair',
  );
  assert.doesNotMatch(
    error.message,
    /did not listen/,
    'a command that never ran must never be reported as a server that never bound',
  );
});

// The second asynchronous shape, and the only other one reachable without
// exhausting a system limit. It must classify identically: `unavailable` is
// about whether a process started, not about why it did not.
test('a dev-server command present but not executable is the same inconclusive result', { ...POSIX_ONLY, timeout: TEST_TIMEOUT_MS }, async () => {
  const fix = project('not-executable');
  const { error } = await startAndFail(fix.dir, [fix.binary], GENEROUS_BOUND_MS);
  assert.equal(error.kind, 'unavailable');
  assert.equal((error.cause as NodeJS.ErrnoException | undefined)?.code, 'EACCES');
  assert.match(error.message, /could not be executed/);
});

/**
 * The OTHER failure, kept apart from the one above.
 *
 * A server that starts and never binds is a different repair — the command is
 * right and the server is broken or slow — so it keeps the readiness message
 * verbatim and carries no kind. Without this row the two could converge on one
 * spelling and nothing would notice, which is the blur this file exists to
 * prevent.
 */
test('a server that starts and never listens keeps the readiness timeout, with no refusal claimed', { ...POSIX_ONLY, timeout: TEST_TIMEOUT_MS }, async () => {
  const fix = project('absent');
  const bound = 1_200;
  // Executable, alive, and deliberately silent. Bounded by its own `sleep` as
  // well as by the runner's group kill, so a regression in the kill cannot leave
  // this suite holding an inherited pipe.
  const { error, elapsedMs } = await startAndFail(fix.dir, ['sh', '-c', 'exec sleep 3'], bound);
  assert.equal(error.message, `server command did not listen within ${bound}ms`);
  assert.equal(error.kind, undefined, 'a server that ran must not be reported as one that could not be executed');
  assert.ok(elapsedMs >= bound, `the readiness wait must spend its bound, not give up early (${elapsedMs}ms)`);
});

/**
 * The bound is not the cost of a refusal, and that is why the reason is threaded
 * INTO the wait rather than raced against it.
 *
 * A race would reject at once and leave `waitForHttp` polling a port nothing
 * will ever bind, on 100 ms timers nobody unrefs — the runner would print its
 * verdict and then hold the process open for the rest of `--timeout-ms`. So this
 * row is about the process being free to exit, measured as the wait ending: 130
 * ms and 106 ms for the two shapes against a 20 s bound.
 */
test('a refused command gives up inside a poll, not at the bound', { ...POSIX_ONLY, timeout: TEST_TIMEOUT_MS }, async () => {
  const fix = project('absent');
  const { elapsedMs } = await startAndFail(fix.dir, [fix.binary], GENEROUS_BOUND_MS);
  assert.ok(
    elapsedMs < 5_000,
    `a refusal must not be paid for at the readiness bound (${elapsedMs}ms of ${GENEROUS_BOUND_MS}ms)`,
  );
});

/**
 * Nothing of a child that never existed may outlive the rejection.
 *
 * The reaper is registered BEFORE the readiness wait (deliberately — the window
 * that matters is the one before the pair is returned), so the refusal path is
 * the one path that reaches it with no group to reap. A registration left behind
 * is the bug process-group.ts warns about in its own words: a handled SIGINT no
 * longer terminates by default, so a runner that had merely once tried to start
 * a dev server would stop answering Ctrl-C. Same claim as
 * __tests__/bounded-command-surface.test.ts's reaper row, for the site that has
 * no result object to hang it on.
 */
test('a command that never started leaves no interrupt reaper behind', { ...POSIX_ONLY, timeout: TEST_TIMEOUT_MS }, async () => {
  const fix = project('absent');
  const before = {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  };
  await startAndFail(fix.dir, [fix.binary], GENEROUS_BOUND_MS);
  assert.deepEqual(
    { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') },
    before,
    'the interrupt reaper must be deregistered by the failure path that registered it',
  );
});

/**
 * The teardown primitives, against the child a refused spawn still hands back.
 *
 * `spawn` returns a ChildProcess whatever happens, and every teardown path in
 * this runner was written for one that started. Measured on darwin: a refused
 * spawn leaves `pid` UNDEFINED and `exitCode` set to the raw errno (-2 for
 * ENOENT), so the group id is never derived, `-pgid` is never formed from
 * `NaN`, and the leader-only fallback finds no handle to signal. The Windows
 * half of the same claim is __tests__/windows-tree-kill.test.ts's pid-less row.
 */
test('a refused spawn is never addressed as a process group', { ...POSIX_ONLY, timeout: TEST_TIMEOUT_MS }, async () => {
  const fix = project('absent');
  const refused = spawn(fix.binary, [], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // The listener under test at the real site, attached here for the same reason:
  // without it this row would end the suite instead of asserting anything.
  const refusals: NodeJS.ErrnoException[] = [];
  refused.on('error', (error: NodeJS.ErrnoException) => refusals.push(error));
  await new Promise((resolve) => { setTimeout(resolve, 200); });
  assert.equal(refusals.length, 1, 'fixture guard: the spawn must really have been refused');
  assert.equal(refused.pid, undefined, 'a refused spawn has no pid to name a group with');
  assert.equal(
    spawnedGroupId(refused, true),
    null,
    'so no group id is snapshotted, however the spawn was detached',
  );
  assert.equal(
    killProcessGroup(null, refused, 'SIGKILL'),
    true,
    'and teardown reports the nothing it found as settled rather than throwing',
  );
});
