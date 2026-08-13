// src/runners/qa-evidence/__tests__/lock-dispossession.test.ts
// What happens to the run that LOSES the lock, and which commands are inside
// the lock at all.
//
// Renewal made the steal rare; it did nothing about the steal's consequence.
// `renewLock` is the only place in this system that ever learns "the lock I
// hold now names someone else", and its whole response was to stop its own
// timer and return — the victim went on writing the run directory and exited
// zero, certifying an artifact set a second instance had been writing into.
// That is verbatim the failure the lock's own docblock condemns in the
// pre-renewal state, minus the frequency.
//
// The three rows here are the three halves of the repair that can be observed
// from outside the module: the victim RECORDS the loss, the victim SAYS so, and
// a command that writes the run directory cannot start alongside a live holder
// — which used to be true of two commands out of five while a third rewrote the
// very file the lock protects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { compileArchitecture } from '../../../shared/architecture-contract';
import { compileVerificationContract } from '../../../shared/verification-contract';
import { acquireQaRunLock, qaRunLockDispossessed, releaseQaRunLock } from '../lock';
import { main } from '../index';
import { qaDir } from '../run-context';

/**
 * A renewal cadence a test can outwait, on the REAL clock.
 *
 * The fake-clock version was written first and withdrawn on its own merits,
 * independently of the reporter bug `capturingStdout` describes: what these
 * rows are about is that renewal rides the HOLDER'S OWN EVENT LOOP — the thing
 * that stops turning when the process is blocked or dead — and a mocked clock
 * replaces exactly that. Twenty milliseconds of real interval keeps the
 * property and costs a sixth of a second.
 */
const FAST_RENEW_MS = 20;

/** Long enough for several real renewal ticks, short enough to be free. */
function afterRenewals(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, FAST_RENEW_MS * 8); });
}

function withRunDir(fn: (projectRoot: string, lockPath: string) => Promise<void>): Promise<void> {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-dispossess-')));
  fs.mkdirSync(qaDir(projectRoot, 'R'), { recursive: true });
  return fn(projectRoot, path.join(qaDir(projectRoot, 'R'), '.runner.lock'))
    .finally(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
}

async function withRunDirAsync(fn: (projectRoot: string) => Promise<void>): Promise<void> {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-dispossess-')));
  try {
    fs.mkdirSync(qaDir(projectRoot, 'R'), { recursive: true });
    await fn(projectRoot);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

/**
 * A Node project with a compiled api-only contract, so `stack` has real work to
 * do and takes long enough to be robbed in the middle of.
 */
function contractedNodeProject(cwd: string, scripts: Record<string, string>): void {
  fs.mkdirSync(path.join(cwd, 'internal/api'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'internal/api/handler.txt'), 'handler\n');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'api', scripts }));
  const state = {
    mode: 'existing-codebase',
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'node',
    mobile: { framework: 'none' },
  };
  const architecture = compileArchitecture(cwd, 'R', state, {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'api', name: 'Api', kind: 'feature' }],
  });
  compileVerificationContract(cwd, 'R', state, architecture, { changedPaths: ['internal/api/handler.txt'] });
}

/**
 * Capture what the runner prints WITHOUT swallowing it.
 *
 * The pass-through is the whole point and was learned the hard way. An earlier
 * version returned `true` and dropped the chunk, and rows in this file silently
 * stopped running — nine declared, six then eight reported, under both the spec
 * and TAP reporters, with no error anywhere. The node test runner emits a
 * result line for a FINISHED test asynchronously, so any row whose line
 * happened to be flushed while a later row held `process.stdout` had its result
 * eaten. A harness that can make a red row vanish is worth less than the tidy
 * output it buys.
 */
async function capturingStdout(into: string[], fn: () => Promise<number>): Promise<number> {
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    into.push(String(chunk));
    return original(chunk);
  };
  try {
    return await fn();
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
}

async function stderrDuring(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    lines.push(String(chunk));
    return original(chunk);
  };
  try {
    await fn();
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  return lines.join('');
}

/** The payload a contender writes when it decides this holder is stale. */
function seizedBy(lockPath: string, pid: number): void {
  fs.writeFileSync(lockPath, JSON.stringify({
    pid,
    startedAt: new Date().toISOString(),
    refreshedAt: new Date().toISOString(),
  }));
}

// THE OBSERVATION THAT WAS DISCARDED. A contender overwrites the lock payload
// with its own pid — exactly what `acquireQaRunLock` does when it decides the
// holder is stale — and the victim's next renewal tick finds a stranger's name
// on the file it thinks it owns.
test('a holder whose lock is stolen records the dispossession', async () => {
  await withRunDir(async (projectRoot, lockPath) => {
    const lock = acquireQaRunLock(projectRoot, 'R', FAST_RENEW_MS);
    assert.ok(lock.ok, 'fixture guard: this process must be the holder');
    assert.equal(qaRunLockDispossessed(lockPath), false, 'a fresh tenancy starts undispossessed');

    seizedBy(lockPath, process.pid + 1);
    await afterRenewals();

    assert.equal(
      qaRunLockDispossessed(lockPath),
      true,
      'the only place that can observe the steal must not be the only place that knows about it',
    );
    releaseQaRunLock(lockPath);
  });
});

// AND IT REACHES A HUMAN, on the channel the runner already uses for anything
// that happens while a sweep is in flight. Chosen over a thrown error because
// the contender is already writing: aborting here would leave a half-written
// artifact set on top of a live one, so the run finishes and then refuses to be
// believed. The exit code is the other half — see the module's own docblock and
// `withLockVerdict` in index.ts.
test('a dispossessed holder says so on stderr, naming the pid that took it', async () => {
  await withRunDir(async (projectRoot, lockPath) => {
    const lock = acquireQaRunLock(projectRoot, 'R', FAST_RENEW_MS);
    assert.ok(lock.ok);
    const thief = process.pid + 1;

    const said = await stderrDuring(async () => {
      seizedBy(lockPath, thief);
      await afterRenewals();
    });
    assert.match(said, /run lock LOST/, 'the victim must be told it is no longer alone');
    assert.match(said, new RegExp(String(thief)), 'and told who took it, because the fix is to re-run alone');
    releaseQaRunLock(lockPath);
  });
});

// A TORN OR ABSENT PAYLOAD IS NOT A THEFT, and reporting it as one would make
// the message worthless: an ordinary release removes the file, and a report on
// every release is a report nobody reads. Only a readable payload naming
// another pid is evidence that a second instance is in the directory.
test('a lock that has merely vanished is not reported as a theft', async () => {
  await withRunDir(async (projectRoot, lockPath) => {
    const lock = acquireQaRunLock(projectRoot, 'R', FAST_RENEW_MS);
    assert.ok(lock.ok);

    const said = await stderrDuring(async () => {
      fs.rmSync(lockPath);
      await afterRenewals();
    });
    assert.equal(said, '', 'a released lock is not a stolen one');
    assert.equal(qaRunLockDispossessed(lockPath), false);
  });
});

// THE HALF THAT REACHES THE CALLER. A stderr line reaches a human watching the
// run; the exit code reaches whatever invoked the runner, and it is the half
// that decides anything, because a dispossessed run that exits 0 hands back a
// verdict over artifacts a second instance was writing into.
//
// Driven through `main` with the theft landing MID-RUN, because that is the
// only place the two halves meet: the dispatch has to finish its command and
// then refuse to be believed, rather than abort on top of a live contender's
// half-written artifact set.
test('a run that loses its lock mid-flight exits non-zero however its command went', async () => {
  await withRunDirAsync(async (projectRoot) => {
    // A run long enough to be robbed in the middle of, and a PASSING one: the
    // interesting exit code to override is a zero, and a command that failed on
    // its own would let this row pass without the wrapper existing.
    contractedNodeProject(projectRoot, {
      build: 'node -e ""',
      test: 'node -e "setTimeout(() => {}, 1500)"',
    });
    const lockPath = path.join(qaDir(projectRoot, 'R'), '.runner.lock');
    const said: string[] = [];
    const startedAt = Date.now();
    let stolen = false;

    const run = capturingStdout(said, () => main(
      ['stack', '--project-root', projectRoot, '--run-id', 'R'],
      projectRoot,
      FAST_RENEW_MS,
    ));
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        stolen = fs.existsSync(lockPath);
        if (stolen) seizedBy(lockPath, process.pid + 1);
        resolve();
      }, 200);
    });
    const code = await run;

    assert.ok(stolen, 'fixture guard: the lock must have been held when the contender wrote to it');
    assert.ok(Date.now() - startedAt > 200 + FAST_RENEW_MS, 'fixture guard: the run must outlast the steal');
    assert.equal(qaRunLockDispossessed(lockPath), true, 'fixture guard: the steal must have been observed');
    assert.equal(code, 3, 'a run that no longer owns its directory must not report the command\'s own verdict');
    assert.match(said.join(''), /"status":"lock-lost"/);
    assert.match(said.join(''), /"commandExitCode":0/,
      'and the command\'s own verdict is reported rather than erased — it is not believable, it is not lost');
  });
});

// ---------------------------------------------------------------------------
// WHICH COMMANDS ARE INSIDE THE LOCK.
// ---------------------------------------------------------------------------

// `stack` and `lighthouse` were outside it, and neither is a reader: `stack`
// publishes `report-v2.json` and the runtime resolution record the exemption
// rests on, and `lighthouse` publishes the same report and can rewrite it again
// through `persistGateRejection`. So an unlocked command mutated the exact
// artifact the lock exists to protect, while a `browser` run could be holding
// the lock over it. Driven through `main` rather than through
// `acquireQaRunLock`, because what is under test is the DISPATCH's coverage.
for (const command of ['stack', 'browser', 'native', 'lighthouse'] as const) {
  test(`\`${command}\` refuses to start against a live holder`, async () => {
    await withRunDirAsync(async (projectRoot) => {
      const holder = acquireQaRunLock(projectRoot, 'R');
      assert.ok(holder.ok, 'fixture guard: the test must own the lock first');
      const said: string[] = [];
      const code = await capturingStdout(said, () => main(
        [command, '--project-root', projectRoot, '--run-id', 'R'],
        projectRoot,
      ));
      assert.equal(code, 3, `${command} writes the run directory and must not start beside another instance`);
      assert.match(said.join(''), /already-running/);
      releaseQaRunLock(holder.lockPath);
    });
  });
}

// The one command that stays outside, and the reason it is not an oversight:
// `manifest` writes nothing. Locking a pure reader would make an ordinary
// inspection fail with code 3 against a running sweep — a cost with nothing
// bought — so the exclusion is a decision, and this row is what makes it one
// rather than a leftover.
test('`manifest` is not locked, because it writes nothing', async () => {
  await withRunDirAsync(async (projectRoot) => {
    const holder = acquireQaRunLock(projectRoot, 'R');
    assert.ok(holder.ok);
    const said: string[] = [];
    const code = await capturingStdout(said, () => main(
      ['manifest', '--project-root', projectRoot, '--run-id', 'R'],
      projectRoot,
    ));
    assert.notEqual(code, 3, 'a reader must not be refused by a lock');
    assert.doesNotMatch(said.join(''), /already-running/);
    releaseQaRunLock(holder.lockPath);
  });
});
