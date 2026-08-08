// src/shared/state/__tests__/sigkill-lock-recovery.test.ts
// Recovery from a real SIGKILL, measured against a lease PRODUCTION wrote.
//
// live-holder-lock-theft.test.ts pins the mirror of this: a lock whose owner pid
// is still running must never be stolen, however stale the clock says it is. It
// also asserts the other half — a dead owner's lease is still reclaimable — but
// every fixture for that half PLANTS the owner record by hand
// (`.owner-dead.json`, `.owner-planted.json`, `.owner-held-by-test.json`), and a
// hand-typed record only ever proves that the reaper can read the reaper's own
// idea of the format.
//
// MEASURED, and this is why this file exists: changing the WRITER in
// locks.ts:130 from `{ pid, acquiredAt }` to `{ pid, heldSince }` — leaving
// `readOwnedLock` untouched — keeps the entire suite green (3,764 tests, one
// unrelated failure). Every real lease then becomes illegible to the reaper, so
// `reclaimStaleOwnedDirLock` returns false forever and the FIRST hook process
// killed wedges that lock for good, with each contender burning its whole
// timeout before giving up. The hand-planted fixtures cannot see it, because
// their record is written in the reader's dialect by construction.
//
// The stores that would go with it are the SIX real callers of
// withOwnedDirLock/withOwnedDirLockResult — the run ledger, the agent registry,
// run-agent claims, fallback claims, cursor spawn observations and the decision
// log's hook-sequence counter. Not run-model-policy, codex-model-observation or
// exhausted-models: those are hand-rolled mkdir/mtime locks and share nothing
// with this primitive. Five of the six hang off `runDir(cwd, runId)`, so a wedge
// there is scoped to one run; the sixth is not, and is the widest blast radius
// of the set — `nextHookSeq(cwd, null)` locks
// `<project>/.traffic-one/debug/.decisions-seq.lock`, which no new run replaces.
//
// So the holder here is a real process that takes the lease through the real
// `withOwnedDirLock`, and it is killed with SIGKILL — which runs no `finally`,
// no exit hook and no signal handler, so the release path never executes and the
// bytes left behind are the bytes production leaves behind. Nothing is
// backdated: the lock is genuinely older than `STALE_MS` by the time the
// reclaim is attempted, because the test genuinely waits.

import { test, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { withOwnedDirLock } from '../run-agent/locks';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PRELOAD = path.join(REPO_ROOT, 'src', 'build', 'test-preload.mjs');
const CHILD = path.join(__dirname, 'sigkill-lock-child.ts');

// Small enough that the test can wait out the staleness for real instead of
// backdating anything, and larger than the wait's own scheduling jitter.
const STALE_MS = 750;
// The contended attempt below spends this whole budget on purpose, so it stays
// short; the reclaiming attempt afterwards needs only one pass.
const TIMEOUT_MS = 400;
const RETRY_MS = 25;

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * A machine that could not host the judgement is reported as such rather than
 * flaked or muted — the shape src/test-support/__tests__/latency-budget.ts
 * established for measurements this repo refuses to guess about. The one
 * scenario that lands here is pid REUSE: if the kernel hands the killed child's
 * pid straight to an unrelated process, `processDefinitelyDead` correctly says
 * "alive" and the reclaim is correctly refused, which is neither a pass nor a
 * defect. `T1_` and not `TRAFFIC_ONE_`: src/build/test-preload.mjs wipes the
 * whole `TRAFFIC_ONE_` namespace bar three allowlisted names, so a switch
 * spelled that way would silently never engage.
 */
const STRICT_ENV = 'T1_SIGKILL_LOCK_STRICT';

function inconclusive(t: TestContext, reason: string): void {
  if (process.env[STRICT_ENV] === '1') {
    throw new Error(`SIGKILL lock recovery: INCONCLUSIVE under ${STRICT_ENV}=1 — ${reason}`);
  }
  process.stderr.write(
    `\nTRAFFIC ONE · SIGKILL LOCK RECOVERY INCONCLUSIVE\n  ${reason}\n`
    + `  THE RECLAIM WAS NOT CHECKED ON THIS RUN. This is not a pass. Set ${STRICT_ENV}=1 to make it RED.\n\n`,
  );
  t.diagnostic(`SIGKILL LOCK RECOVERY INCONCLUSIVE · ${reason}`);
  t.skip(`INCONCLUSIVE (reclaim NOT checked) · ${reason}`);
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
}

interface Doomed {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly stderr: () => string;
}

/** Start the holder and wait until it reports, from inside, that it is holding
 * the lease. The pid comes off the marker the child itself wrote, so it is the
 * pid that owns the lock rather than whatever `spawn` happened to return. */
async function doomedHolder(mode: 'hold' | 'gap', lockDir: string, barrier: string): Promise<Doomed> {
  const child = spawn(
    process.execPath,
    [
      '--import', pathToFileURL(PRELOAD).href,
      '--import', 'tsx',
      CHILD,
      JSON.stringify({ mode, lockDir, barrier, staleMs: STALE_MS, timeoutMs: 5_000, retryMs: RETRY_MS }),
    ],
    { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let err = '';
  child.stderr.on('data', (chunk) => { err += String(chunk); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const insideMarker = path.join(barrier, 'inside');
  const readyBy = Date.now() + 60_000;
  while (!fs.existsSync(insideMarker)) {
    assert.ok(Date.now() < readyBy, `the holder never took the lease: ${err || '(no stderr)'}`);
    await settle(20);
  }
  return { child, pid: Number(fs.readFileSync(insideMarker, 'utf8')), closed, stderr: () => err };
}

function ownerRecords(lockDir: string): string[] {
  return fs.readdirSync(lockDir)
    .filter((name) => name.startsWith('.owner-') && name.endsWith('.json'))
    .sort();
}

function tryAcquire(lockDir: string): { held: boolean; ran: boolean; elapsedMs: number } {
  let ran = false;
  const startedAt = Date.now();
  const held = withOwnedDirLock(
    lockDir, TIMEOUT_MS, STALE_MS, RETRY_MS,
    new Int32Array(new SharedArrayBuffer(4)),
    () => { ran = true; },
  );
  return { held, ran, elapsedMs: Date.now() - startedAt };
}

/** SIGKILL by the pid we own, and wait until the kernel agrees it is gone.
 * Deliberately never a pattern match: a `pkill -f` whose pattern appears in the
 * killer's own command line kills the killer. */
async function killAndConfirmGone(doomed: Doomed): Promise<'gone' | 'still-alive'> {
  process.kill(doomed.pid, 'SIGKILL');
  await doomed.closed;
  const goneBy = Date.now() + 5_000;
  while (Date.now() < goneBy) {
    try {
      process.kill(doomed.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
    }
    await settle(20);
  }
  return 'still-alive';
}

// The headline case. Every assertion before the kill exists to make the one
// after it mean something: a reclaim is only interesting if the lease was
// genuinely exclusive first.
test('a lease production wrote, orphaned by SIGKILL, is legible to the reaper and reclaimed', async (t) => {
  const lockDir = path.join(tempDir('t1-sigkill-lock-'), 'held.lock');
  const barrier = tempDir('t1-sigkill-barrier-');
  const doomed = await doomedHolder('hold', lockDir, barrier);

  try {
    // 1. The lease is real and PRODUCTION wrote it — one `.owner-<token>.json`
    //    from locks.ts's own acquire, carrying the holder's pid.
    assert.ok(fs.existsSync(lockDir), 'the holder must have published the lock directory');
    const owners = ownerRecords(lockDir);
    assert.deepEqual(owners.length, 1,
      `the real acquire must leave exactly one owner sentinel: ${JSON.stringify(fs.readdirSync(lockDir))}`);
    const ownerFile = path.join(lockDir, owners[0]!);
    const ownerBytes = fs.readFileSync(ownerFile, 'utf8');
    const record = JSON.parse(ownerBytes) as { pid?: unknown };
    assert.equal(record.pid, doomed.pid,
      `the owner record must name the process actually holding the lease: ${ownerBytes}`);

    // 2. CONTENTION, before anybody dies: this process asks for the same lock
    //    while the holder is provably inside its critical section, and is
    //    refused. Without this, the reclaim below would also be satisfied by a
    //    lock protocol that excludes nobody at all.
    assert.doesNotThrow(() => process.kill(doomed.pid, 0), 'the holder must be alive for the contended attempt');
    const contended = tryAcquire(lockDir);
    assert.doesNotThrow(() => process.kill(doomed.pid, 0),
      'the holder must still be alive AFTER the contended attempt, or it proved nothing');
    assert.equal(contended.held, false,
      `a live holder's lease must not be handed to a second process (elapsed ${contended.elapsedMs} ms)`);
    assert.equal(contended.ran, false, 'the mutation must not run when the lock was never held');
    t.diagnostic(`contended attempt refused after ${contended.elapsedMs} ms against live pid ${doomed.pid}`);

    // 3. SIGKILL. No `finally`, no release, no cleanup — the lease is orphaned
    //    on disk exactly as it would be if the host had killed a hook.
    const fate = await killAndConfirmGone(doomed);
    if (fate === 'still-alive') {
      inconclusive(t, `pid ${doomed.pid} was still answering kill(pid, 0) after SIGKILL, so it was probably reused; `
        + 'a refused reclaim would be correct behaviour and this run cannot tell the two apart');
      return;
    }
    assert.deepEqual(fs.readFileSync(ownerFile, 'utf8'), ownerBytes,
      'SIGKILL must leave the lease exactly as it was: nothing ran to clean it up');

    // 4. Wait out the staleness for real. The record's own `acquiredAt` is the
    //    clock being tested, so nothing here is backdated.
    await settle(STALE_MS + 450);

    // 5. The property. A dead owner's lease is reclaimed, and the mutation runs
    //    under it — this is the assertion the writer/reader format contract
    //    hangs on, and the one that goes red when the two dialects diverge.
    const reclaimed = tryAcquire(lockDir);
    assert.equal(reclaimed.held, true,
      'a lease whose owner was SIGKILLed must be reclaimable: the reaper could not act on the record '
      + `the real acquire left behind (${ownerBytes}), and nothing below reclaims an illegible sentinel — so this `
      + 'store stays wedged until its lock dir goes away, which for the run-scoped five is the end of the run and '
      + 'for the hook-sequence counter is never (see the header)');
    assert.equal(reclaimed.ran, true, 'the mutation must actually run under the reclaimed lock');
    assert.equal(fs.existsSync(ownerFile), false,
      'the orphaned owner sentinel must be gone once its lease has been reclaimed');
    assert.equal(fs.existsSync(lockDir), false,
      'the reclaiming acquirer must also release its own lease, leaving no lock directory behind');
  } finally {
    try { process.kill(doomed.pid, 'SIGKILL'); } catch { /* already dead, which is the happy path */ }
    await doomed.closed;
  }
});

// The second shape a SIGKILL produces, and the one with no pid in it at all:
// killed between the acquire's raw `mkdir` and its owner write. There is no
// sentinel to interrogate, so the reaper's pid check cannot help — the emptiness
// plus the `.reaper` compare-and-swap is what authorizes this reclaim, and
// without it the directory would outlive every process that ever cared about it.
test('a lock directory orphaned in the mkdir-to-owner-write gap by SIGKILL is reclaimed', async (t) => {
  const lockDir = path.join(tempDir('t1-sigkill-gap-'), 'held.lock');
  const barrier = tempDir('t1-sigkill-gap-barrier-');
  const doomed = await doomedHolder('gap', lockDir, barrier);

  try {
    assert.ok(fs.existsSync(lockDir), 'the holder must have published the lock directory');
    assert.deepEqual(fs.readdirSync(lockDir), [],
      'this case is specifically the window where no owner sentinel exists yet');

    // Contention first, for the same reason as above: while the gap is open and
    // its author is alive, the directory still excludes a second acquirer. (It
    // excludes it by being too YOUNG to reclaim, not by any owner record — which
    // is exactly why the reclaim below is worth asserting.)
    const contended = tryAcquire(lockDir);
    assert.doesNotThrow(() => process.kill(doomed.pid, 0), 'the gap holder must still be alive');
    assert.equal(contended.held, false,
      `a fresh lock directory must not be reclaimed out from under its author (elapsed ${contended.elapsedMs} ms)`);
    t.diagnostic(`gap: contended attempt refused after ${contended.elapsedMs} ms against live pid ${doomed.pid}`);

    const fate = await killAndConfirmGone(doomed);
    if (fate === 'still-alive') {
      inconclusive(t, `pid ${doomed.pid} still answered kill(pid, 0) after SIGKILL (probable pid reuse)`);
      return;
    }
    assert.deepEqual(fs.readdirSync(lockDir), [], 'the abandoned directory must still be there, and still empty');

    await settle(STALE_MS + 450);
    const reclaimed = tryAcquire(lockDir);
    assert.equal(reclaimed.held, true,
      'an empty lock directory abandoned by a killed acquirer must be reclaimable, or the store it guards '
      + 'is wedged by a kill that landed in a two-line window');
    assert.equal(reclaimed.ran, true, 'the mutation must actually run under the reclaimed lock');
    assert.equal(fs.existsSync(lockDir), false, 'the reclaimed directory must not be left behind');
  } finally {
    try { process.kill(doomed.pid, 'SIGKILL'); } catch { /* already dead */ }
    await doomed.closed;
  }
});
