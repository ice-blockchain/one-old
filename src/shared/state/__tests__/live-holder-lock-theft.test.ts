// src/shared/state/__tests__/live-holder-lock-theft.test.ts
// Four lock acquire routines that reclaimed a held lease on ELAPSED TIME ALONE,
// measured against the one thing elapsed time cannot decide: whether the holder
// is still running.
//
// Every lock here already had a sound compare-and-swap for the UNCONTENDED case
// (mkdir, or O_EXCL create). The defect was entirely in the stale path. A lock
// dir's mtime is stamped when it is created and never advances while its owner
// works, so "older than staleMs" says the holder has been busy for a while — not
// that it died. Each site then removed the lease anyway, and two of the four
// were even storing the owner's pid at the time without ever reading it back.
//
// WHY EVERY FIXTURE AGES THE LOCK BY BOTH MEASURES
//
// `holdLock*` below backdates the directory/file mtime AND the owner record's own
// timestamp, so the lock is unambiguously stale under the old rule and under the
// new one. That is what makes these tests discriminating: a test that only
// backdated mtime would pass after the fix merely because the new code reads a
// different clock, proving nothing about liveness. Here the ONLY thing standing
// between the contender and the lease is that the holder's pid is alive — and it
// is this test process, so it is alive by construction and cannot flake.
//
// A stale lock still being reclaimable is NOT the property under test and is
// deliberately asserted separately at the end: without that half, a fix that
// simply never reclaimed anything would pass everything above and wedge every
// lock in production the first time a hook was SIGKILLed.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { currentHostModelTarget } from '../../current-model-tiers';
import { ensureRunModelPolicy, readRunModelPolicy, runModelPolicyPath } from '../../run-model-policy';
import { observeCodexChildModel, readCodexModelObservation } from '../codex-model-observation';
import {
  exhaustedModelsForRole,
  recordExhaustedModel,
} from '../../../modules/agent-model/exhausted-models';
import { withCursorSpawnObservationLock } from '../run-agent/cursor-observations';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PRELOAD = path.join(REPO_ROOT, 'src', 'build', 'test-preload.mjs');
const HOLDER = path.join(__dirname, 'live-holder-lock-child.ts');

// Longer than the largest staleMs any site under test uses (cursor spawn
// observations, 15s), so one constant ages every lock past every threshold.
const AGED_MS = 20 * 60 * 1000;

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function project(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function runDir(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', runId);
}

function backdate(target: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(target, when, when);
}

/** A DIRECTORY lock held by this live process, aged past every staleness rule:
 * the owner record carries our pid and an old acquisition time, and the
 * directory's mtime is backdated to match. `ownerName` is the sentinel the site
 * under test looks for. */
function holdLockDir(lockDir: string, ownerName: string): string {
  fs.mkdirSync(lockDir, { recursive: true });
  const ownerFile = path.join(lockDir, ownerName);
  fs.writeFileSync(ownerFile, JSON.stringify({
    pid: process.pid,
    at: Date.now() - AGED_MS,
    acquiredAt: Date.now() - AGED_MS,
  }));
  backdate(ownerFile, AGED_MS);
  backdate(lockDir, AGED_MS);
  return ownerFile;
}

/** The same, for the one site whose lock is a FILE rather than a directory. */
function holdLockFile(lockFile: string): void {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, `${process.pid} ${Date.now() - AGED_MS}\n`, 'utf8');
  backdate(lockFile, AGED_MS);
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
}

// ---------------------------------------------------------------------------
// Site 1 — cursor spawn observations. The headline proof: TWO PROCESSES INSIDE
// ONE CRITICAL SECTION.
// ---------------------------------------------------------------------------

// This is the assertion the whole change exists for, and it needs a second real
// process. The holder is not simulated: it is inside `mutate()`, spinning, when
// this process asks for the same lock. A fixture that merely planted a lock
// record would show a lease being taken from something that LOOKS live; this
// shows the exclusive section itself being violated, which is the actual harm —
// `withCursorSpawnObservationLock` exists so that a read-modify-write of
// cursor-spawns.json cannot interleave with another, and two writers inside it
// lose one of the two updates.
test('cursor spawn lock: a live holder mid-mutation is not joined by a second writer', async () => {
  const cwd = project('t1-live-holder-cursor-');
  const runId = 'run-two-holders';
  const barrier = project('t1-live-holder-barrier-');
  fs.mkdirSync(runDir(cwd, runId), { recursive: true });

  const holder = spawn(
    process.execPath,
    [
      '--import', pathToFileURL(PRELOAD).href,
      '--import', 'tsx',
      HOLDER,
      JSON.stringify({ cwd, runId, barrier }),
    ],
    { cwd: REPO_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let holderErr = '';
  holder.stderr.on('data', (chunk) => { holderErr += String(chunk); });
  const holderDone = new Promise<number | null>((resolve) => { holder.on('close', resolve); });
  const release = (): void => {
    try { fs.writeFileSync(path.join(barrier, 'release'), ''); } catch { /* already gone */ }
  };

  try {
    const insideMarker = path.join(barrier, 'holder-inside');
    const readyBy = Date.now() + 60_000;
    while (!fs.existsSync(insideMarker)) {
      assert.ok(Date.now() < readyBy, `holder never entered its critical section: ${holderErr}`);
      await settle(20);
    }
    const holderPid = Number(fs.readFileSync(insideMarker, 'utf8'));

    // The holder is now provably inside `mutate()`. Age its lease exactly as a
    // long-running mutation would: nothing about the holder changes, only the
    // clock. This is the whole scenario — the observation store is written by
    // hook processes that can legitimately be slow, and 15s of work is not death.
    const lockDir = path.join(runDir(cwd, runId), '.cursor-spawns.lock');
    assert.ok(fs.existsSync(lockDir), 'the holder must have published the lock directory');
    for (const name of fs.readdirSync(lockDir)) backdate(path.join(lockDir, name), AGED_MS);
    backdate(lockDir, AGED_MS);

    let entered = false;
    const result = withCursorSpawnObservationLock(cwd, runId, () => {
      entered = true;
      return 'second-writer';
    });

    const holderStillInside = fs.existsSync(insideMarker)
      && !fs.existsSync(path.join(barrier, 'holder-exited'));
    assert.ok(holderStillInside, 'the holder must still be in its critical section for this to measure anything');
    // A live pid, checked at the moment of the claim — not an inference from a
    // marker file. `process.kill(pid, 0)` throwing ESRCH here would mean the
    // holder died and the reclaim was legitimate.
    assert.doesNotThrow(() => process.kill(holderPid, 0), 'the holder process must be alive');

    assert.equal(entered, false,
      'two processes were inside withCursorSpawnObservationLock at once: the lock reclaimed a live holder\'s lease on directory mtime alone');
    assert.equal(result, null, 'a contender that cannot take the lock must report null, not a mutation result');
    assert.ok(fs.existsSync(lockDir),
      'the live holder\'s lock directory must survive a contender\'s stale sweep');

    release();
    assert.equal(await holderDone, 0, `holder exited badly: ${holderErr}`);
  } finally {
    release();
    holder.kill('SIGKILL');
    await holderDone.catch(() => null);
  }
});

// ---------------------------------------------------------------------------
// Sites 2-4 — the same defect, measured in-process. The holder here is THIS
// process (a pid that is alive by construction), which is enough for every site
// whose harm is "the lease was taken", and avoids three more forked fixtures.
// ---------------------------------------------------------------------------

// Reported as "stores a pid in owner.json and then never consults it" — confirmed.
test('run model policy lock: an aged lease held by a live pid is not stolen', () => {
  const cwd = project('t1-live-holder-policy-');
  const runId = 'policy-live-holder';
  const env = {
    ...process.env,
    TRAFFIC_ONE_HOST: 'codex',
    TRAFFIC_ONE_USER_PLAN: 'pro',
    XDG_STATE_HOME: path.join(cwd, 'state'),
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'preferences.json'),
  };
  const target = currentHostModelTarget('codex', 'pro', env);
  const state = {
    mode: 'new-project',
    performance: {
      level: 'balanced',
      source: 'prompted',
      target: { plan: 'pro', appliedFingerprint: target.appliedFingerprint, configVersion: target.configVersion },
    },
    team: { mode: 'subagents', approved: true, source: 'prompted' },
  };

  const policyPath = runModelPolicyPath(cwd, runId);
  const ownerFile = holdLockDir(`${policyPath}.lock`, 'owner.json');

  assert.equal(
    ensureRunModelPolicy(cwd, runId, 'codex', state, env),
    null,
    'a policy publication must not proceed by evicting a live lock holder',
  );
  assert.equal(fs.existsSync(policyPath), false,
    'the create-once policy path must not be published under a stolen lock');
  assert.ok(fs.existsSync(ownerFile),
    'the live holder\'s owner record must survive: the contender\'s recursive rmSync destroyed the whole lease');
});

// Reported as the same defect as the policy lock — confirmed, same shape.
test('codex model observation lock: an aged lease held by a live pid is not stolen', () => {
  const cwd = project('t1-live-holder-codex-');
  const env = {
    ...process.env,
    TRAFFIC_ONE_HOST: 'codex',
    TRAFFIC_ONE_USER_PLAN: 'pro',
    XDG_STATE_HOME: path.join(cwd, 'state'),
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(cwd, 'preferences.json'),
  };
  const target = currentHostModelTarget('codex', 'pro', env);
  const runId = 'codex-live-holder';
  const state = {
    mode: 'new-project',
    performance: {
      level: 'high',
      source: 'prompted',
      target: { plan: 'pro', appliedFingerprint: target.appliedFingerprint, configVersion: target.configVersion },
    },
    team: { mode: 'subagents', approved: true, source: 'prompted' },
  };
  // The policy is a precondition of observing anything, and it is published
  // BEFORE the lock is planted so this test measures the observation lock only.
  assert.ok(ensureRunModelPolicy(cwd, runId, 'codex', state, env), 'fixture policy must publish');

  const storePath = path.join(runDir(cwd, runId), 'codex-model-observations.json');
  const ownerFile = holdLockDir(`${storePath}.lock`, 'owner.json');

  assert.equal(
    observeCodexChildModel(cwd, runId, {
      childId: 'child-a',
      parentSessionId: 'parent',
      role: 'senior-frontend',
      actualModel: 'gpt-5.6-sol',
      source: 'PreToolUse',
    }),
    null,
    'an observation must report "not recorded" rather than evict a live lock holder',
  );
  assert.equal(fs.existsSync(storePath), false, 'no observation may be written under a stolen lock');
  assert.equal(readCodexModelObservation(cwd, runId, ['child-a']), null);
  assert.ok(fs.existsSync(ownerFile), 'the live holder\'s owner record must survive');
});

// Reported as "writes pid+time as PLAIN TEXT into the lock file, never parses it
// back, reclaims on mtime" — confirmed, and the pid really is on disk unread.
test('exhausted models lock: an aged lease held by a live pid is not stolen', () => {
  const cwd = project('t1-live-holder-exhausted-');
  const runId = 'exhausted-live-holder';
  const role = 'senior-backend';
  const storePath = path.join(runDir(cwd, runId), 'exhausted-models.json');
  holdLockFile(`${storePath}.lock`);

  assert.deepEqual(
    recordExhaustedModel(cwd, runId, role, 'gpt-5.6-terra-medium'),
    [],
    'a refused write must report the list that is still ON DISK, not an optimistic one',
  );
  assert.equal(fs.existsSync(storePath), false,
    'the condemnation ledger must not be written under a lock stolen from a live holder');
  assert.deepEqual(exhaustedModelsForRole(cwd, runId, role), []);
  assert.equal(
    fs.readFileSync(`${storePath}.lock`, 'utf8').trim().split(' ')[0],
    String(process.pid),
    'the live holder\'s lock file must survive intact',
  );
});

// ---------------------------------------------------------------------------
// The other half: a lease whose owner is genuinely GONE must still be reclaimed.
// ---------------------------------------------------------------------------

// Without this, every assertion above is satisfied by a lock that never reclaims
// anything — which would wedge each of these stores for the rest of the run the
// first time a hook process was killed, a strictly worse outcome than the defect
// being fixed. A pid that cannot exist stands in for the dead owner: 0x7FFFFFFF
// is above every platform's pid_max, so `kill(pid, 0)` reports ESRCH ("no such
// process") rather than EPERM, and it can never be recycled onto a live process
// the way a recently-exited pid can.
const DEAD_PID = 0x7FFFFFFF;

test('a lease whose owner is definitely dead is still reclaimed at every site', () => {
  const cwd = project('t1-dead-holder-');
  const runId = 'dead-holder';
  assert.throws(() => process.kill(DEAD_PID, 0), /ESRCH/,
    'the fixture pid must be provably absent, or these reclaims prove nothing');

  const cursorLock = path.join(runDir(cwd, runId), '.cursor-spawns.lock');
  fs.mkdirSync(cursorLock, { recursive: true });
  const cursorOwner = path.join(cursorLock, '.owner-dead.json');
  fs.writeFileSync(cursorOwner, JSON.stringify({ pid: DEAD_PID, acquiredAt: Date.now() - AGED_MS }));
  backdate(cursorOwner, AGED_MS);
  backdate(cursorLock, AGED_MS);
  assert.equal(withCursorSpawnObservationLock(cwd, runId, () => 'ran'), 'ran',
    'a dead owner\'s cursor spawn lease must be reclaimable');

  const storePath = path.join(runDir(cwd, runId), 'exhausted-models.json');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const exhaustedLock = `${storePath}.lock`;
  fs.writeFileSync(exhaustedLock, `${DEAD_PID} ${Date.now() - AGED_MS}\n`, 'utf8');
  backdate(exhaustedLock, AGED_MS);
  assert.deepEqual(recordExhaustedModel(cwd, runId, 'senior-backend', 'gpt-5.6-terra-medium'),
    ['gpt-5.6-terra-medium'],
    'a dead owner\'s exhausted-models lease must be reclaimable');
});

// A lock directory left behind by an OLDER BUILD has no owner record at all —
// the cursor spawn lock never wrote one. Those directories are on disk in every
// project the previous build touched, and a fix that only understood its own
// sentinel would refuse them until their run directory was deleted by hand.
test('an empty, aged lock directory from a build with no owner sentinel is reclaimed', () => {
  const cwd = project('t1-legacy-lock-');
  const runId = 'legacy-lock';
  const lockDir = path.join(runDir(cwd, runId), '.cursor-spawns.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  backdate(lockDir, AGED_MS);
  assert.equal(withCursorSpawnObservationLock(cwd, runId, () => 'ran'), 'ran',
    'a legacy ownerless lock directory must not wedge the store forever');
});
