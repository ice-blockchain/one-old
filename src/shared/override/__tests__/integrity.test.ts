// The completeness half of the operator override: what the record says when
// somebody has been at it.
//
// THE DEFECT these characterize is not the mint and not the abuse guard, both
// of which worked. It is the step after: mint an override (the run is correctly
// held at `validating / operator-override-used`), then
// `rm ~/.traffic-one/overrides/<projectKey>/overrides.jsonl`. Every reader then
// saw a clean install — `readOverrideLedger` folded ENOENT, EACCES, an
// oversized file and a failed read into one empty array — the guard read "no
// override was ever minted", and the run settled `verified` with `reason=none`.
// The doctor agreed: `active=0 unvouchable=0 runMinted=0`.
//
// Three witnesses now answer, each surviving a different erasure, and the
// asymmetry between them is the whole design:
//   - LEGIBILITY: only ENOENT is a complete answer. The other three illegible
//     kinds refuse certification while still yielding no token to any gate.
//   - THE SNAPSHOT: written before the ledger line, so it outlives the delete.
//   - THE MINT COUNTER: signed, monotone, and in one.json, so it outlives the
//     whole bucket.
//
// Every test redirects XDG_STATE_HOME into a temp dir: the machine dir holds
// the per-install HMAC key AND (now) the mint counter, so a leak here would
// write both into the developer's own `~/.traffic-one` and a passing test would
// be reading THEIR history.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { probeOverrides } from '../../../runners/doctor/override-probe';
import {
  ONE_SETTINGS_LOCK_TIMEOUT_MS,
  ONE_SETTINGS_NESTED_LOCK_TIMEOUT_MS,
  oneSettingsPath,
} from '../../one-settings';
import { readJsonResult } from '../../fsjson';
import { recordPluginUseChoice, resetPluginUseCache } from '../../state/plugin-use';
import {
  OVERRIDE_LEDGER_ILLEGIBLE_CHECK,
  OVERRIDE_MINT_COUNTER_UNVERIFIABLE_CHECK,
  OVERRIDE_MINT_COUNT_MISMATCH_CHECK,
  OVERRIDE_SNAPSHOT_ORPHANED_CHECK,
  OVERRIDE_SNAPSHOT_SCAN_INCOMPLETE_CHECK,
  activeOverrideToken,
  mintOverride,
  overrideEvidenceReport,
  overrideLedgerPath,
  readOverrideLedgerResult,
  readOverrideMintCounter,
  runUsedOperatorOverride,
} from '../index';
import { recordOverrideMint } from '../mint-counter';
import { overrideSnapshotDir } from '../paths';

// ── fixture ──────────────────────────────────────────────────────────────────

const TEMP_DIRS: string[] = [];
const CLAMPED: string[] = [];
after(() => {
  // Restore before the rm: a mode-000 file defeats a recursive delete on some
  // platforms, and this runs after a FAILED assertion too, which is exactly
  // when per-test cleanup would have been skipped.
  for (const file of CLAMPED) {
    // 0o755 for a directory: without the execute bit a recursive delete cannot
    // descend into it, and one clamped fixture would strand the whole temp tree.
    try { fs.chmodSync(file, fs.statSync(file).isDirectory() ? 0o755 : 0o644); } catch { /* already gone */ }
  }
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  // realpath: macOS's tmpdir is a symlink, and projectRootHash resolves before
  // hashing — an unresolved fixture path would key the ledger differently from
  // every read.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  TEMP_DIRS.push(dir);
  return dir;
}

function withOverrideStore(body: (projectRoot: string) => void): void {
  const saved = process.env.XDG_STATE_HOME;
  const base = tempDir('t1-override-integrity-');
  const projectRoot = path.join(base, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  process.env.XDG_STATE_HOME = path.join(base, 'state');
  resetPluginUseCache();
  recordPluginUseChoice(projectRoot, true, 'test');
  try {
    body(projectRoot);
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
    resetPluginUseCache();
  }
}

function mint(projectRoot: string, runId = 'run-1'): string {
  const result = mintOverride({
    projectRoot, runId, scope: 'gate', target: 'plan-guard', snapshot: { runId, before: 'state-A' },
  });
  assert.equal(result.ok, true, `mint failed: ${result.ok ? '' : result.reason}`);
  return result.ok ? result.snapshotPath : '';
}

/** Make `file` answer `unreadable`, and prove it did. */
function makeUnreadable(file: string): void {
  fs.chmodSync(file, 0o000);
  CLAMPED.push(file);
  assert.equal(
    readJsonResult(file).kind,
    'unreadable',
    'fixture guard: this environment must actually produce an unreadable read (a root uid ignores '
    + 'the mode bits, and an `ok` read here would measure nothing)',
  );
}

function countLines(file: string): number {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length; } catch { return 0; }
}

/** Sleep without a timer, so a synchronous test can wait on another process.
 *  `Atomics.wait` on a buffer nobody notifies is a plain sleep that keeps the
 *  event loop out of it — the mint under measurement is synchronous too. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(file: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    sleepSync(5);
  }
  return false;
}

/** Files a child signals through. Under the fixture's temp root, so the `after`
 *  hook takes them with everything else. */
function childIo(): { ready: string; stop: string; out: string } {
  const dir = tempDir('t1-override-child-');
  return { ready: path.join(dir, 'ready'), stop: path.join(dir, 'stop'), out: path.join(dir, 'out.json') };
}

/** BARE NODE, not tsx: this samples two paths and needs none of the plugin, and
 *  a tsx child costs ~2.0s against ~0.15s for this one. Everything it needs
 *  arrives in the environment, because `node -e` argv handling differs between
 *  the forms and an env var does not care. */
const OBSERVER = `
const fs = require('fs');
const ledger = process.env.T1_LEDGER, lock = process.env.T1_LOCK;
const samples = [];
const buf = new Int32Array(new SharedArrayBuffer(4));
fs.writeFileSync(process.env.T1_READY, 'x');
const deadline = Date.now() + 15000;
while (Date.now() < deadline && !fs.existsSync(process.env.T1_STOP)) {
  const before = fs.existsSync(lock);
  let lines = 0;
  try { lines = fs.readFileSync(ledger, 'utf8').split('\\n').filter((l) => l.trim() !== '').length; } catch {}
  const after = fs.existsSync(lock);
  samples.push([lines, (before || after) ? 1 : 0]);
  Atomics.wait(buf, 0, 0, 2);
}
// Staged and renamed, not written in place: the parent waits on this path
// existing, and a plain write is visible to it EMPTY. Measured as a 1-in-4
// 'Unexpected end of JSON input' before the rename — a torn read of the
// evidence, which is a fine irony for a test about mid-transaction reads.
fs.writeFileSync(process.env.T1_OUT + '.tmp', JSON.stringify(samples));
fs.renameSync(process.env.T1_OUT + '.tmp', process.env.T1_OUT);
`;

/** A second mint's hold, from a real other process: the owner pid is this
 *  child's and it is alive, so the reap arm correctly declines to steal it and
 *  the waiter has to actually wait. */
const HOLDER = `
const fs = require('fs'), path = require('path');
const lock = process.env.T1_LOCK;
fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(lock, 'owner-holder.json'),
  JSON.stringify({ pid: process.pid, token: 'holder', createdAt: Date.now() }),
);
fs.writeFileSync(process.env.T1_READY, 'x');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.T1_HOLD_MS));
fs.rmSync(lock, { recursive: true, force: true });
`;

/** The mint counter's stored record, edited the way something without the key
 *  would have to: the numbers move, the MAC cannot follow. */
function editCounter(edit: (entry: Record<string, unknown>) => void): void {
  const file = oneSettingsPath();
  const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const section = settings.overrideMints as Record<string, Record<string, unknown>>;
  const key = Object.keys(section)[0] as string;
  edit(section[key] as Record<string, unknown>);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
}

// ── legibility ───────────────────────────────────────────────────────────────

test('ENOENT is a complete answer and the other three illegible kinds are not', () => {
  // The non-regression that outranks everything else here: a clean install has
  // never minted an override, is the overwhelmingly common case, and must cost
  // nothing. `absent` is the only non-`ok` kind that is legible.
  withOverrideStore((projectRoot) => {
    const report = overrideEvidenceReport(projectRoot);
    assert.equal(report.ledger, 'absent');
    assert.deepEqual(report.checks, [], 'a project that never minted anything is not accused of anything');
    assert.equal(report.mintCounter.state, 'absent');
  });

  // Garbage where the ledger should be: readable bytes, no enumerable mints.
  withOverrideStore((projectRoot) => {
    fs.mkdirSync(path.dirname(overrideLedgerPath(projectRoot)), { recursive: true });
    fs.writeFileSync(overrideLedgerPath(projectRoot), 'not json at all\n{"v":1}\n', 'utf8');
    const report = overrideEvidenceReport(projectRoot);
    assert.equal(report.ledger, 'corrupt');
    assert.deepEqual(report.checks, [OVERRIDE_LEDGER_ILLEGIBLE_CHECK]);
    assert.equal(activeOverrideToken(projectRoot, 'run-1', 'gate', 'plan-guard'), null, 'and no token is honoured');
  });

  withOverrideStore((projectRoot) => {
    mint(projectRoot);
    makeUnreadable(overrideLedgerPath(projectRoot));
    const report = overrideEvidenceReport(projectRoot);
    assert.equal(report.ledger, 'unreadable');
    assert.deepEqual(report.checks, [OVERRIDE_LEDGER_ILLEGIBLE_CHECK]);
    assert.equal(activeOverrideToken(projectRoot, 'run-1', 'gate', 'plan-guard'), null,
      'a ledger we cannot read lifts nothing — the gate side stays fail-closed toward "no token"');
    assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), false,
      'and the abuse guard cannot see the mint either, which is precisely why the check above exists');
  });

  withOverrideStore((projectRoot) => {
    fs.mkdirSync(path.dirname(overrideLedgerPath(projectRoot)), { recursive: true });
    fs.writeFileSync(overrideLedgerPath(projectRoot), `${'x'.repeat(600 * 1024)}\n`, 'utf8');
    const report = overrideEvidenceReport(projectRoot);
    assert.equal(report.ledger, 'oversized');
    assert.deepEqual(report.checks, [OVERRIDE_LEDGER_ILLEGIBLE_CHECK]);
    assert.equal(activeOverrideToken(projectRoot, 'run-1', 'gate', 'plan-guard'), null);
  });
});

test('a garbage line beside a genuine one still leaves the genuine one working', () => {
  // The existing behaviour this must not have broken: `corrupt` returns the
  // lines that DID parse. An appended byte of junk cannot make a live override
  // vanish — it makes the FILE unable to promise it lists every mint, which is
  // a statement about certification, not about the gate.
  withOverrideStore((projectRoot) => {
    mint(projectRoot);
    fs.appendFileSync(overrideLedgerPath(projectRoot), 'garbage\n', 'utf8');
    assert.ok(activeOverrideToken(projectRoot, 'run-1', 'gate', 'plan-guard'));
    assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), true);
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [OVERRIDE_LEDGER_ILLEGIBLE_CHECK]);
  });
});

// ── the mint is one transaction ──────────────────────────────────────────────

test('a mint held off by another mint writes nothing at all, and recovers when that one is done', () => {
  // THE GUARANTEE THE TAKE-BACK RESTS ON, pinned at the only place a single
  // process can observe it. The take-back removes our line BY ID rather than by
  // truncating, so that a concurrent mint's line survives — and by-id alone did
  // not deliver that, because the removal is a read-modify-write and an
  // O_APPEND lands between its two halves. MEASURED across two real processes
  // in `.tmp/override6/interleave.ts`: with the writers unserialised the
  // concurrent mint's genuinely signed line is destroyed, its snapshot is left
  // behind, `override-snapshot-orphaned` fires and the whole project loses
  // `verified`; forcing the same interleaving one read earlier reaches the same
  // block by a second route, the concurrent mint counting our doomed line and
  // signing the counter one ahead of the lines that remain. Both are clear with
  // the transaction below.
  //
  // WHAT THIS TEST CAN SEE without a second process: while a lock this process
  // may not take is held, the mint does not write. That is the observable
  // consequence of serialising, and it is what a mutant removing the lock
  // breaks — the mint then succeeds and both assertions below fail. The
  // cross-process ORDERING itself is not pinned here on purpose: a spawn-based
  // test would buy the property at seconds per run against a suite with a
  // latency budget, and it is the probe's job.
  withOverrideStore((projectRoot) => {
    mint(projectRoot, 'run-0');
    const ledger = overrideLedgerPath(projectRoot);
    const linesBefore = fs.readFileSync(ledger, 'utf8');
    const snapshotDir = overrideSnapshotDir(projectRoot);
    const before = fs.readdirSync(snapshotDir).length;

    // The lock a live mint in another terminal would be holding. `process.pid`
    // is alive by construction, so the reap arm correctly declines to steal it.
    const lockDir = `${ledger}.lock`;
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(lockDir, 'owner-concurrent.json'),
      JSON.stringify({ pid: process.pid, token: 'concurrent', createdAt: Date.now() }),
      'utf8',
    );

    const refused = mintOverride({
      projectRoot, runId: 'run-1', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'run-1' },
    });
    assert.equal(refused.ok, false, 'a mint that cannot take the ledger lock is refused, not squeezed in');
    assert.equal(refused.ok === false && refused.reason, 'ledger-write-failed');
    assert.equal(fs.readFileSync(ledger, 'utf8'), linesBefore, 'and no line landed');
    assert.equal(fs.readdirSync(snapshotDir).length, before,
      'nor a snapshot: a refusal that left one would be an orphan, and an orphan blocks the project');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [],
      'a refused mint accuses nobody — the refusal must cost less than the mint would have');

    // The refusal is the LOCK, not the fixture: the same call succeeds the
    // moment the other mint is finished with it.
    fs.rmSync(lockDir, { recursive: true, force: true });
    const second = mintOverride({
      projectRoot, runId: 'run-1', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'run-1' },
    });
    assert.equal(second.ok, true, 'the operator retries and it works — a refusal, not a wedge');
    assert.equal(overrideEvidenceReport(projectRoot).mintCounter.count, 2);
  });
});

test('the hold spans the line another process must never see, observed from another process', () => {
  // THE ORDERING ITSELF, which the test above does not pin and said so. That one
  // plants a lock and asserts the mint writes nothing: it survives the removal
  // of concurrency entirely, because it never runs a second process. It owns the
  // CONSEQUENCE of serialising. This owns the guarantee: the doomed line — the
  // append that a failed bump takes back — is never visible to another process
  // without the lock standing over it.
  //
  // Why that is the ordering guarantee and not another consequence: the
  // interleaving that destroyed a genuinely signed line is a read-modify-write
  // straddling somebody else's append. The only thing that makes it impossible
  // is that the whole window in which the ledger is mid-transaction lies inside
  // one hold. This measures exactly that window, from outside the process that
  // owns it, at 2 ms resolution.
  //
  // COST, since round 6 declined this one on cost and was wrong about it: a bare
  // `node -e` observer, no tsx, no plugin load. Measured at 1.16–1.41 s wall
  // over six runs at load average 108–139, against the 5.2 s test already in
  // this file and the 9.8 s spawn test the suite already ships for the
  // project-state lock.
  //
  // IT BINDS, mutated two ways on a copy. Removing the lock entirely kills three
  // tests, this one among them. The discriminating one is narrower: keep the
  // lock for the append and drop it before the bump and the take-back, i.e.
  // exactly "serialises, but the hold does not span the transaction". That
  // kills THIS TEST AND NOTHING ELSE — 166 of 170 samples saw the doomed line
  // unguarded — while the consequence-pin above passes, because a planted lock
  // still refuses the acquire it makes.
  withOverrideStore((projectRoot) => {
    mint(projectRoot, 'run-0');
    const ledger = overrideLedgerPath(projectRoot);
    const lockDir = `${ledger}.lock`;
    const linesBefore = countLines(ledger);
    assert.equal(linesBefore, 1, 'fixture: one settled line to be mid-transaction against');

    // The window is opened by the counter's own lock, held by a pid that really
    // is alive: the bump waits out ONE_SETTINGS_LOCK_TIMEOUT_MS and fails, so the
    // appended line sits in the file for ~half a second before the take-back
    // removes it. Without a stall the window is sub-millisecond and no sampler
    // could be trusted to land inside it.
    const settingsLock = `${oneSettingsPath()}.lock`;
    fs.mkdirSync(settingsLock, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(settingsLock, 'owner-observer.json'),
      JSON.stringify({ pid: process.pid, token: 'observer', createdAt: Date.now() }),
      'utf8',
    );

    const io = childIo();
    const observer = spawn(process.execPath, ['-e', OBSERVER], {
      stdio: 'ignore',
      env: {
        ...process.env, T1_LEDGER: ledger, T1_LOCK: lockDir, T1_READY: io.ready, T1_STOP: io.stop, T1_OUT: io.out,
      },
    });
    try {
      assert.equal(waitForFile(io.ready, 10_000), true, 'fixture: the observer must be sampling before the mint');

      const refused = mintOverride({
        projectRoot, runId: 'run-1', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'run-1' },
      });
      assert.equal(refused.ok === false && refused.reason, 'counter-locked',
        'fixture: the mint must be the one that appends and takes back');

      fs.writeFileSync(io.stop, 'x', 'utf8');
      assert.equal(waitForFile(io.out, 10_000), true, 'fixture: the observer must have reported');
    } finally {
      observer.kill('SIGKILL');
      fs.rmSync(settingsLock, { recursive: true, force: true });
    }

    // [lines, lockSeen] pairs. lockSeen is generous on purpose — it is true if
    // the lock was there either side of the read — so a release racing the
    // sampler cannot manufacture a failure. A mutant that removes the lock
    // cannot benefit from that generosity: there is nothing to see either side.
    const samples = JSON.parse(fs.readFileSync(io.out, 'utf8')) as [number, number][];
    const midTransaction = samples.filter(([lines]) => lines > linesBefore);
    assert.ok(midTransaction.length > 0,
      `ABSENT FIXTURE, not a pass: the observer took ${samples.length} samples and never saw the doomed `
      + 'line, so this run measured nothing about the hold');
    const unguarded = midTransaction.filter(([, lock]) => lock === 0);
    assert.deepEqual(unguarded, [],
      `THE ORDERING: ${unguarded.length} of ${midTransaction.length} samples saw the ledger mid-transaction `
      + 'with no lock over it — another mint reading there would read a line that is about to be removed');

    assert.equal(countLines(ledger), linesBefore, 'and the transaction ended where it started');
  });
});

test('a hold longer than the inner budget still admits the waiter', () => {
  // P4's arithmetic, pinned behaviourally. The ledger hold CONTAINS a settings
  // write, so with both deadlines equal the hold can outlast the wait every
  // time and an honest second mint is refused by subtraction rather than by any
  // contention policy. Measured before the fix: uncontended holds 85–145 ms,
  // contended 534–561 ms, against a 500 ms wait.
  //
  // The fixture's hold is derived from the inner budget rather than written as a
  // number, so re-equalising the constants — or shaving the outer one under the
  // inner — turns this red instead of leaving a comment that used to be true.
  assert.ok(ONE_SETTINGS_NESTED_LOCK_TIMEOUT_MS > ONE_SETTINGS_LOCK_TIMEOUT_MS * 2,
    'the outer budget must clear one full inner deadline plus the work around it, with room for a '
    + 'waiter to lose a retry sleep');

  withOverrideStore((projectRoot) => {
    mint(projectRoot, 'run-0');
    const lockDir = `${overrideLedgerPath(projectRoot)}.lock`;
    const holdMs = ONE_SETTINGS_LOCK_TIMEOUT_MS + 200;

    const io = childIo();
    const holder = spawn(process.execPath, ['-e', HOLDER], {
      stdio: 'ignore',
      env: { ...process.env, T1_LOCK: lockDir, T1_READY: io.ready, T1_HOLD_MS: String(holdMs) },
    });
    try {
      assert.equal(waitForFile(io.ready, 10_000), true, 'fixture: the other mint must be holding');
      assert.equal(fs.existsSync(lockDir), true, 'fixture guard: and its lock must be visible here');

      const started = Date.now();
      const second = mintOverride({
        projectRoot, runId: 'run-1', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'run-1' },
      });
      const waited = Date.now() - started;

      assert.equal(second.ok, true,
        `an honest mint behind a ${holdMs}ms hold must WAIT, not be refused (reason: `
        + `${second.ok ? '' : second.reason}) — the outer budget is ${ONE_SETTINGS_NESTED_LOCK_TIMEOUT_MS}ms`);
      assert.ok(waited >= ONE_SETTINGS_LOCK_TIMEOUT_MS,
        `ABSENT FIXTURE, not a pass: the mint returned in ${waited}ms, which is less than the hold it was `
        + 'supposed to wait out — the holder was gone before the mint started');
      assert.equal(overrideEvidenceReport(projectRoot).mintCounter.count, 2,
        'and it landed as a real second mint, counted');
    } finally {
      holder.kill('SIGKILL');
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

test('the take-back runs inside the mint\'s own lock hold rather than queueing behind it', () => {
  // THE HAZARD THE TRANSACTION INTRODUCED, pinned so it cannot come back. With
  // the append, the count, the bump and the take-back under ONE hold, a
  // take-back that acquired the lock again would meet the hold it is already
  // inside, spin to its own deadline and then skip the removal — turning a
  // refused mint into exactly the orphaned line and snapshot the whole
  // transaction exists to prevent. The lock is not reentrant and nothing in the
  // protocol pretends otherwise.
  //
  // Forced with the availability wreck from the counter test: the bump cannot
  // land, so the take-back runs. If it deadlocked, the two assertions below
  // would both fail, and the release assertion after them would catch a hold
  // that was never given back.
  withOverrideStore((projectRoot) => {
    mint(projectRoot, 'run-0');
    const settingsDir = path.dirname(oneSettingsPath());
    fs.chmodSync(settingsDir, 0o500);
    CLAMPED.push(settingsDir);
    let wrote = true;
    try { fs.writeFileSync(path.join(settingsDir, 'probe.tmp'), 'x', 'utf8'); } catch { wrote = false; }
    assert.equal(wrote, false, 'fixture guard: this environment must actually refuse the settings write');

    const refused = mintOverride({
      projectRoot, runId: 'run-1', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'run-1' },
    });
    assert.equal(refused.ok === false && refused.reason, 'counter-unwritable');

    const report = overrideEvidenceReport(projectRoot);
    assert.equal(report.vouchableMints, 1, 'the line was taken back from inside the hold');
    assert.equal(report.orphanSnapshots.length, 0, 'and so was its snapshot');
    assert.equal(fs.existsSync(`${overrideLedgerPath(projectRoot)}.lock`), false,
      'and the hold was released — a lock left behind would stall the next mint for the staleness window');
  });
});

// ── the snapshot outlives the line ───────────────────────────────────────────

test('deleting the ledger leaves the snapshot and the counter to say so', () => {
  withOverrideStore((projectRoot) => {
    const snapshotPath = mint(projectRoot);
    assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), true, 'the guard sees the mint while the line is there');

    fs.rmSync(overrideLedgerPath(projectRoot));

    // The state the whole exercise is about: every ledger-derived reader now
    // reports a clean install.
    assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), false);
    assert.equal(readOverrideLedgerResult(projectRoot).kind, 'absent');
    assert.ok(fs.existsSync(snapshotPath), 'but the snapshot was written first and is still here');

    const report = overrideEvidenceReport(projectRoot);
    assert.deepEqual(report.checks, [OVERRIDE_SNAPSHOT_ORPHANED_CHECK, OVERRIDE_MINT_COUNT_MISMATCH_CHECK],
      'two independent witnesses, so removing either one still leaves the erasure detectable');
    assert.equal(report.orphanSnapshots.length, 1);
    assert.equal(report.orphanSnapshots[0]?.runId, 'run-1');
    assert.equal(report.vouchableLines, 0);
    assert.equal(report.mintCounter.count, 1);

    // …and the doctor names it rather than printing the clean install it used
    // to print.
    const probe = probeOverrides(projectRoot, 'run-1');
    assert.equal(probe.active.length, 0);
    assert.equal(probe.unvouchable, 0);
    assert.equal(probe.runMinted, 0);
    assert.equal(probe.orphanSnapshots, 1);
    assert.deepEqual(probe.discrepancies, report.checks);
  });
});

test('deleting the snapshot too leaves the counter alone, and the counter is enough', () => {
  withOverrideStore((projectRoot) => {
    const snapshotPath = mint(projectRoot);
    fs.rmSync(overrideLedgerPath(projectRoot));
    fs.rmSync(path.dirname(snapshotPath), { recursive: true });

    const report = overrideEvidenceReport(projectRoot);
    assert.deepEqual(report.checks, [OVERRIDE_MINT_COUNT_MISMATCH_CHECK],
      'the bucket is gone and one.json still remembers how many mints it held');
    assert.equal(report.mintCounter.state, 'verified');
    assert.equal(report.mintCounter.count, 1);
  });
});

test('a line whose MAC was edited stops accounting for its own snapshot', () => {
  // One byte in the `mac` field removes the line from the abuse guard
  // (`forged` lines are not records of a mint) without removing the line, which
  // would be the cheapest possible laundering if snapshots were considered
  // accounted for by any line at all.
  withOverrideStore((projectRoot) => {
    mint(projectRoot);
    const file = overrideLedgerPath(projectRoot);
    const line = JSON.parse(fs.readFileSync(file, 'utf8').trim()) as Record<string, unknown>;
    line.mac = 'f'.repeat(64);
    fs.writeFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');

    assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), false, 'the abuse guard alone is defeated');
    const report = overrideEvidenceReport(projectRoot);
    assert.equal(report.ledger, 'ok', 'the line is legible, it is simply not ours');
    assert.deepEqual(report.checks, [OVERRIDE_SNAPSHOT_ORPHANED_CHECK, OVERRIDE_MINT_COUNT_MISMATCH_CHECK]);
  });
});

// ── the counter ──────────────────────────────────────────────────────────────

test('the counter is signed, per project, and counts mints', () => {
  withOverrideStore((projectRoot) => {
    const other = path.join(path.dirname(projectRoot), 'other');
    fs.mkdirSync(other, { recursive: true });
    recordPluginUseChoice(other, true, 'test');

    mint(projectRoot);
    assert.deepEqual(readOverrideMintCounter(projectRoot), { state: 'verified', count: 1, writable: true });
    assert.deepEqual(readOverrideMintCounter(other), { state: 'absent', count: null, writable: true },
      'a project that has not minted has no counter, whatever its neighbours did');

    mint(projectRoot, 'run-2');
    assert.equal(readOverrideMintCounter(projectRoot).count, 2);
    mint(other);
    assert.equal(readOverrideMintCounter(other).count, 1, 'and the neighbour did not clobber it');
    assert.equal(readOverrideMintCounter(projectRoot).count, 2);
    // Two mints, two lines, no discrepancy: the counter accuses nobody while
    // the record it counts is intact.
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, []);
  });
});

test('an edited counter is refused, in either direction, and cannot be walked backwards', () => {
  withOverrideStore((projectRoot) => {
    mint(projectRoot);
    mint(projectRoot, 'run-2');

    editCounter((entry) => { entry.count = 99; });
    assert.equal(readOverrideMintCounter(projectRoot).state, 'unverifiable', 'the MAC does not follow the number');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [OVERRIDE_MINT_COUNTER_UNVERIFIABLE_CHECK]);

    editCounter((entry) => { delete entry.mac; });
    assert.equal(readOverrideMintCounter(projectRoot).state, 'unverifiable', 'an unsigned counter is not a counter');

    // Walked DOWN and left unsigned — the shape of an attempt to buy back room
    // to delete lines. The next mint re-signs it at the ledger's own length, so
    // the discount is never granted.
    editCounter((entry) => { entry.count = 0; });
    mint(projectRoot, 'run-3');
    const restored = readOverrideMintCounter(projectRoot);
    assert.equal(restored.state, 'verified');
    assert.equal(restored.count, 3, 'monotone: it adopts the visible history rather than starting over');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, []);
    fs.rmSync(overrideLedgerPath(projectRoot));
    assert.ok(overrideEvidenceReport(projectRoot).checks.includes(OVERRIDE_MINT_COUNT_MISMATCH_CHECK));
  });
});

test('an absent counter never accuses an install that predates it', () => {
  // The rule, stated as the test: a counter is created by a mint, so an install
  // that minted before this code existed has ledger lines and no counter. That
  // shape must stay silent, or shipping the check would fail every project that
  // ever used the feature.
  withOverrideStore((projectRoot) => {
    mint(projectRoot);
    mint(projectRoot, 'run-2');
    const file = oneSettingsPath();
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete settings.overrideMints;
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');

    assert.equal(readOverrideMintCounter(projectRoot).state, 'absent');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [],
      'two ledger lines and no counter is a pre-existing install, not an erasure');

    // …and it is still silent when the envelope itself cannot be read. Not
    // because that is harmless — it is the cheaper half of a measured residual
    // (see mint-counter.ts) — but because `unreadable` and `absent` exhibit the
    // same thing, which is no counter, and `absent` is pinned eligible by the
    // assertion above. Refusing on one of two indistinguishable states costs a
    // project with a damaged one.json its certification and leaves the verdict
    // reachable through the state that must stay eligible.
    fs.writeFileSync(file, 'not json', 'utf8');
    assert.equal(readOverrideMintCounter(projectRoot).state, 'unreadable');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, []);
  });
});

test('a counter whose bump does not land is refused a mint, not handed a free erasure', () => {
  // THE DEFECT, prospective rather than retrospective and therefore worse: the
  // WRITE path validates `one.json`'s schemaVersion and the READ path does not,
  // so one unknown integer in that file froze the counter forever while every
  // read reported a signed, healthy number. Nothing fired; the doctor called the
  // witness healthy; and from then on every mint was a free erasure, measured at
  // the real settlement writer. The two counter residuals that ARE documented
  // (`absent`, `unreadable`) both leave a distinguishable state — this one
  // reported health.
  //
  // FOUR WRECKS, in two classes, and the second class is why the first fix was
  // not enough. `writable` asks whether the envelope's BYTES parse; the last two
  // rows below leave those bytes perfectly valid and stop the write anyway, so
  // the pre-flight answers `true` and the mint used to succeed with the counter
  // frozen at its old value. What refuses them is the OBSERVED bump: the number
  // is read back, and a mint whose number did not move is taken back.
  //
  // Closed at the mint rather than at the read, because that is where the
  // asymmetry is: a counter that cannot advance must not be allowed to fall
  // behind. Refusing certification instead would wedge every project with a
  // damaged one.json, which is the mistake `absent` already taught.
  //
  // THE REFUSAL NAMES WHICH CLASS FIRED, and that column is load-bearing rather
  // than cosmetic: `counter-unwritable` is what the operator is told when the
  // envelope's contents are the problem, and the three causes printed under it
  // are all contents. A contended lock is none of them, so it refuses under its
  // own name and the printed advice stops being false for it.
  const wrecks = [
    // ── CONTENT: visible to the pre-flight, refused before anything is written.
    ['an unknown schemaVersion', false, 'counter-unwritable', (file: string): void => {
      const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      settings.schemaVersion = 99;
      fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
    }],
    ['a directory at its path', false, 'counter-unwritable', (file: string): void => {
      fs.rmSync(file, { force: true });
      fs.mkdirSync(file, { recursive: true });
    }],
    // ── AVAILABILITY: invisible to any predicate over the contents.
    // A planted lock owner naming a pid that really is alive. The reap arm is
    // correct to respect it — a live owner holds its lock, and that is the rule
    // protecting every honest writer — so this wreck is not closable at the lock
    // and every settings write throws at the deadline for as long as the file
    // sits there. Exactly the shape the mint has to survive by OBSERVING its own
    // write rather than by asking whether the envelope looks writable.
    // (The pid-1 variant, where the liveness check itself was wrong, is closed
    // on its own terms — see the settings-lock test below.)
    ['a lock owner naming a live pid', true, 'counter-locked', (file: string): void => {
      const lockDir = `${file}.lock`;
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(lockDir, 'owner-deadbeef.json'),
        JSON.stringify({ pid: process.pid, token: 'deadbeef', createdAt: Date.now() - 10 * 60 * 1000 }),
        'utf8',
      );
    }],
    // The parent directory made unwritable. The writer stages a temp file beside
    // the target and renames; lock acquisition mkdirs in the same directory. Both
    // fail — while the override bucket, a SUBDIRECTORY of the machine dir, keeps
    // taking the ledger append and the snapshot, which is what made this one
    // reach a successful mint with a frozen witness.
    // …and this one is NOT `counter-locked`, which is the distinction earning
    // its keep: the lock cannot even be staged here, so the failure is the
    // directory rather than a holder, and waiting would not fix it.
    ['an unwritable parent directory', true, 'counter-unwritable', (file: string): void => {
      const dir = path.dirname(file);
      fs.chmodSync(dir, 0o500);
      CLAMPED.push(dir);
      let wrote = true;
      try { fs.writeFileSync(path.join(dir, 'probe.tmp'), 'x', 'utf8'); } catch { wrote = false; }
      assert.equal(wrote, false,
        'fixture guard: this environment must actually refuse the write (a root uid ignores the mode bits)');
    }],
  ] as const;

  for (const [label, parses, expectedReason, wreck] of wrecks) {
    withOverrideStore((projectRoot) => {
      mint(projectRoot, 'run-0');
      const before = readOverrideMintCounter(projectRoot);
      assert.equal(before.count, 1);
      wreck(oneSettingsPath());
      assert.equal(readOverrideMintCounter(projectRoot).writable, parses,
        `${label}: what the CONTENT predicate can and cannot see`);

      const refused = mintOverride({
        projectRoot, runId: 'run-1', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'run-1' },
      });
      assert.equal(refused.ok, false, `${label}: a mint that cannot be counted is not minted`);
      assert.equal(refused.ok === false && refused.reason, expectedReason,
        `${label}: the refusal must name the cause that actually fired`);
      assert.equal(activeOverrideToken(projectRoot, 'run-1', 'gate', 'plan-guard'), null,
        `${label}: and no gate is relaxed by it`);

      if (!parses) {
        // Nothing was written, so there is nothing to take back.
        fs.rmSync(oneSettingsPath(), { force: true, recursive: true });
        return;
      }
      // The availability wrecks get as far as the snapshot and the line, so the
      // refusal has to leave the project as it found it: one mint, one line, one
      // snapshot, and a report that accuses nobody. A leftover snapshot would be
      // an orphan and would wedge certification for a mint that never happened —
      // the refusal would then cost the project more than the mint would have.
      // Every read below is a read: neither wreck touches legibility.
      const report = overrideEvidenceReport(projectRoot);
      assert.equal(report.vouchableMints, 1, `${label}: the refused line was taken back`);
      assert.equal(report.orphanSnapshots.length, 0, `${label}: and so was its snapshot`);
      assert.deepEqual(report.checks, [], `${label}: a refused mint accuses nobody`);
      assert.equal(readOverrideMintCounter(projectRoot).count, 1,
        `${label}: the counter is where it was, not ahead of the lines`);
    });
  }
});

test('a bump that lands in an envelope the next reader does not see is reported as no bump', () => {
  // WHAT THE OBSERVATION BUYS BEYOND THE THROW, isolated. Under both wrecks
  // above the settings write also THROWS, so a bump that only reported whether
  // its write raised would refuse them too — the two are indistinguishable
  // there, and a reader could conclude the re-read is decoration. It is not:
  // the contract is "the number moved", and the number moving is a property of
  // what a LATER READER sees, not of what this call's write returned.
  //
  // The state that separates them, and the one an attacker with a shell has for
  // free: the envelope is restored underneath the bump between the write and the
  // read. Modelled here at `recordOverrideMint` — the seam it owns — by pointing
  // the machine dir at a copy taken before the write, the moment the write
  // lands. Nothing throws, the write really did land, and the counter the next
  // reader will consult is still at the old number.
  withOverrideStore((projectRoot) => {
    mint(projectRoot, 'run-0');
    const live = process.env.XDG_STATE_HOME as string;
    const liveCount = (): number | null => readOverrideMintCounter(projectRoot).count;
    /** Hands the bump `live` until its write lands at `at`, then `dest`. */
    const swapAt = (at: number, dest: string): NodeJS.ProcessEnv => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      Object.defineProperty(env, 'XDG_STATE_HOME', {
        enumerable: true,
        get: () => (liveCount() === at ? dest : live),
      });
      return env;
    };

    // A verified counter at the OLD number: the restored envelope, and the
    // shape the erasure wants — a mint that happened, with a witness that
    // never heard of it.
    const restored = `${live}-restored`;
    fs.cpSync(live, restored, { recursive: true });
    assert.equal(recordOverrideMint(projectRoot, 1, swapAt(2, restored)), 'not-observed',
      'THE POINT: the write succeeded and the bump still refuses, because the number it aimed '
      + 'for is not the number the next reader finds — and it is `not-observed` rather than `locked`, '
      + 'which is the distinction the mint\'s refusal message is built on');
    assert.equal(liveCount(), 2, 'fixture guard: the write really did land — this is not a failed write');
    assert.equal(readOverrideMintCounter(projectRoot, { ...process.env, XDG_STATE_HOME: restored }).count, 1,
      'and the envelope a later reader gets is still at the old number');

    // A counter that is HIGHER than the target and does not verify. The number
    // alone would satisfy the bump; a number nobody signed says nothing, so the
    // state has to be read too — the same argument as the reconciliation pin,
    // at the other end of the same witness.
    const unsigned = `${live}-unsigned`;
    fs.cpSync(live, unsigned, { recursive: true });
    const envelope = JSON.parse(fs.readFileSync(path.join(unsigned, ...oneSettingsPath()
      .slice(live.length + 1).split(path.sep)), 'utf8')) as Record<string, Record<string, { count: number }>>;
    for (const entry of Object.values(envelope.overrideMints ?? {})) entry.count = 5;
    fs.writeFileSync(path.join(unsigned, ...oneSettingsPath()
      .slice(live.length + 1).split(path.sep)), JSON.stringify(envelope, null, 2), 'utf8');
    const seen = readOverrideMintCounter(projectRoot, { ...process.env, XDG_STATE_HOME: unsigned });
    assert.deepEqual([seen.state, seen.count], ['unverifiable', 5], 'fixture guard: high, and unsigned');
    assert.equal(recordOverrideMint(projectRoot, 1, swapAt(3, unsigned)), 'not-observed',
      'a number this install cannot vouch for is not a number that moved');
  });
});

test('a planted lock owner naming a process nobody may signal is not a live holder', () => {
  // The second bug the same plant produces, and it is wider than the override:
  // ONE file in `one.json.lock/` naming pid 1 made EVERY write to the machine
  // settings envelope throw — the mint counter, the reconciliations, and the
  // wizard's API key — until a human found the directory. `kill(1, 0)` answers
  // EPERM, and the liveness check read EPERM as "alive", so the stale-reap arm
  // never fired.
  //
  // EPERM means "not mine to ask about", which for a lock inside a 0700 per-user
  // machine dir cannot be a holder: every writer of that lock runs as this user.
  // A pid we CAN signal is still respected — that arm is the wreck the mint test
  // above uses, and it must keep working, so both are asserted here.
  withOverrideStore((projectRoot) => {
    mint(projectRoot, 'run-0');
    const lockDir = `${oneSettingsPath()}.lock`;
    const plant = (pid: number): void => {
      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(lockDir, 'owner-deadbeef.json'),
        JSON.stringify({ pid, token: 'deadbeef', createdAt: Date.now() - 10 * 60 * 1000 }),
        'utf8',
      );
    };

    plant(1);
    const afterForged = mintOverride({
      projectRoot, runId: 'run-1', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'run-1' },
    });
    assert.equal(afterForged.ok, true, 'a stale lock nobody may signal is reaped, not obeyed');
    assert.equal(readOverrideMintCounter(projectRoot).count, 2);
    assert.equal(fs.existsSync(lockDir), false, 'and the planted directory is gone');

    // P5's arm: a holder that is provably GONE and whose stamp is SECONDS old.
    // This is what an OOM-kill leaves, and the staleness floor used to refuse it
    // for the rest of a ten-second window — MEASURED at 656 ms of waiting and
    // then a refusal, for a pid nobody had to guess about. Age is no longer
    // consulted for an owner we can read, so this is a reap.
    const corpse = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.ok(corpse.pid && corpse.pid > 0, 'fixture: a real pid to bury');
    let dead = false;
    try { process.kill(corpse.pid as number, 0); } catch { dead = true; }
    assert.equal(dead, true, 'fixture guard: the pid must actually be gone, or this measures the live arm');
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      // A HEX token, because the owner-file grammar is `owner-[a-f0-9]+.json`
      // and a name outside it is not an owner this protocol will read — which
      // routes the fixture to the empty-directory arm and measures nothing.
      path.join(lockDir, 'owner-dead0f.json'),
      JSON.stringify({ pid: corpse.pid, token: 'dead0f', createdAt: Date.now() }),
      'utf8',
    );
    const started = Date.now();
    const afterCorpse = mintOverride({
      projectRoot, runId: 'run-2', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'run-2' },
    });
    assert.equal(afterCorpse.ok, true,
      `a dead holder's young lock is reaped, not obeyed (reason: ${afterCorpse.ok ? '' : afterCorpse.reason})`);
    assert.ok(Date.now() - started < ONE_SETTINGS_LOCK_TIMEOUT_MS,
      'and it is reaped on the first retry rather than waited out — a reap that only happens at the '
      + 'deadline is a refusal wearing a success');
    assert.equal(readOverrideMintCounter(projectRoot).count, 3);

    plant(process.pid);
    const afterLive = mintOverride({
      projectRoot, runId: 'run-3', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'run-3' },
    });
    assert.equal(afterLive.ok, false, 'a live owner still holds its lock');
    assert.equal(afterLive.ok === false && afterLive.reason, 'counter-locked',
      'and the refusal says CONTENTION rather than accusing a file that parses perfectly');
    fs.rmSync(lockDir, { recursive: true, force: true });
  });
});

test('a wedged settings lock is recovered, and a live one is still not stolen', () => {
  // THE STANDING CLAUSE'S PORT, measured where it is felt: the settings lock is
  // taken by every mint, so anything that wedges it wedges the operator's only
  // way out of a deny. Two shapes used to wedge it FOREVER — not for a staleness
  // window, forever — and neither needs an attacker.
  //
  // ONE BYTE AT THE LOCK PATH. `rename(dir, non-dir)` fails ENOTDIR, and neither
  // reaper could touch a file: one needs a readable owner file, the other needed
  // a readable DIRECTORY. Every settings write on the machine then spun its
  // deadline and threw.
  //
  // ONE STRAY INSIDE AN ABANDONED LOCK. The old reaper demanded the directory be
  // EMPTY, and the product manufactures the non-empty version itself: the
  // observed-owner reap unlinks the owner file and then rmdirs, so anything
  // landing between those two lines leaves exactly this.
  withOverrideStore((projectRoot) => {
    mint(projectRoot, 'run-0');
    const lockPath = `${oneSettingsPath()}.lock`;

    fs.writeFileSync(lockPath, '', 'utf8');
    const overStray = mintOverride({
      projectRoot, runId: 'run-1', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'run-1' },
    });
    assert.equal(overStray.ok, true,
      `a file at the lock path is not a lock and must not outlast one mint (reason: ${
        overStray.ok ? '' : overStray.reason})`);
    assert.equal(fs.existsSync(lockPath), false, 'and it is gone rather than waited out');

    const corpse = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    const buryWith = (stray: string, pid: number): void => {
      fs.rmSync(lockPath, { recursive: true, force: true });
      fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(lockPath, 'owner-c0ffee.json'),
        JSON.stringify({ pid, token: 'c0ffee', createdAt: Date.now() - 60_000 }),
        'utf8',
      );
      fs.writeFileSync(path.join(lockPath, stray), '', 'utf8');
    };

    // A stray beside a DEAD owner: two entries, so the strict owner reader
    // refuses to name an owner at all and the abandoned arm has to decide it.
    buryWith('.DS_Store', corpse.pid as number);
    const overStrew = mintOverride({
      projectRoot, runId: 'run-2', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'run-2' },
    });
    assert.equal(overStrew.ok, true,
      `an abandoned lock with something beside it is still abandoned (reason: ${
        overStrew.ok ? '' : overStrew.reason})`);

    // THE GUARD THE WIDENING NEEDS: the same illegible shape over a pid that is
    // ALIVE keeps its lock. The reap reads a pid out of any owner-named file
    // however malformed the rest is, precisely so this case cannot be reached by
    // dropping a second file next to a running holder's owner file.
    buryWith('.DS_Store', process.pid);
    const overLive = mintOverride({
      projectRoot, runId: 'run-3', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'run-3' },
    });
    assert.equal(overLive.ok, false, 'a live holder keeps its lock even when its directory is illegible');
    assert.equal(overLive.ok === false && overLive.reason, 'counter-locked');
    assert.equal(fs.existsSync(lockPath), true, 'and the lock is still standing');
    fs.rmSync(lockPath, { recursive: true, force: true });
  });
});

test('a token stamped by a clock a year ahead expires on the reader, and still counts', () => {
  // The TTL is a bound the MINT applies off a local clock nothing authenticates,
  // and nothing re-checked it: a machine reading a year ahead signs a perfectly
  // well-formed 24-hour token that is live for a year of real time, because the
  // only question asked at read time was whether the far end was in the future.
  // The MAC verifies here — this is not a forgery, it is the honest command run
  // on a machine with a wrong clock, which is why the read side has to have an
  // opinion at all.
  //
  // `expired` rather than `forged`: the mint really happened, so it keeps
  // counting toward the abuse guard and the counter. Only the gate relaxation is
  // withheld.
  withOverrideStore((projectRoot) => {
    const yearAhead = Date.now() + 365 * 24 * 60 * 60 * 1000;
    const result = mintOverride({
      projectRoot, runId: 'run-1', scope: 'gate', target: 'plan-guard', snapshot: { runId: 'run-1' },
      nowMs: yearAhead,
    });
    assert.equal(result.ok, true);

    assert.equal(activeOverrideToken(projectRoot, 'run-1', 'gate', 'plan-guard'), null,
      'a token issued in the future is not live now, whatever its own far end says');
    assert.equal(runUsedOperatorOverride(projectRoot, 'run-1'), true,
      'and the run still paid for it: the line is genuine and the mint happened');
    assert.deepEqual(overrideEvidenceReport(projectRoot).checks, [],
      'nor is it an accusation about the record — the MAC verifies and nothing is missing');
  });
});

test('a snapshot renamed to look accounted for is still an orphan', () => {
  // `<sometokenid>.json.json` — the scan stripped exactly one `.json` before
  // testing membership and `namedSnapshots` held both the bare token id and
  // `<id>.json`, so a file no surviving line had ever heard of was treated as
  // accounted for by one that had. Composed with a frozen counter it was fully
  // green. Matched exactly now, in both directions.
  withOverrideStore((projectRoot) => {
    const snapshotPath = mint(projectRoot);
    const dir = path.dirname(snapshotPath);
    fs.copyFileSync(snapshotPath, `${snapshotPath}.json`);
    const report = overrideEvidenceReport(projectRoot);
    assert.deepEqual(report.checks, [OVERRIDE_SNAPSHOT_ORPHANED_CHECK]);
    assert.deepEqual(report.orphanSnapshots.map((orphan) => orphan.id),
      [path.basename(snapshotPath)],
      'the line accounts for its own file and for nothing whose name merely starts with it');
    assert.ok(fs.existsSync(path.join(dir, path.basename(snapshotPath))));
  });
});

test('a clean install is clean all the way through the doctor probe', () => {
  withOverrideStore((projectRoot) => {
    const { repairCommand, ...probe } = probeOverrides(projectRoot, 'run-1');
    // Exhaustive on purpose: a new completeness field that defaults to an
    // accusing value would fail the overwhelmingly common case, and this is
    // where that would be caught. `repairCommand` is split off because it
    // resolves an absolute path off the running machine's home dir.
    assert.deepEqual(probe, {
      active: [], unvouchable: 0, forgedLines: 0, malformedLines: 0, runMinted: 0, ledger: 'absent',
      duplicateLines: 0, orphanSnapshots: 0, mintCounter: 'absent', mintCounterCount: null,
      vouchableMints: 0, mintCounterWritable: true, snapshotScanAsked: true, reconciliations: 0,
      excused: [], discrepancies: [],
    });
    assert.match(repairCommand, /doctor\.cjs' --reconcile-overrides$/);
  });
});

// ── the scan has a bound, and says so when it hits it ────────────────────────

test('a snapshot directory too large to read is reported as unread, not as clean', () => {
  // A reachable settlement refusal that nothing exercised. Both arms matter for
  // opposite reasons: the BOUND is what stops a flooded directory from making
  // settlement read it all, and the refusal is what stops the flood from being
  // read as a clean bucket — the same "we could not look, so we said nothing
  // was there" this whole file is about, one layer down.
  withOverrideStore((projectRoot) => {
    const snapshotPath = mint(projectRoot);
    const dir = path.dirname(snapshotPath);
    for (let i = 0; i < 300; i += 1) {
      fs.writeFileSync(path.join(dir, `pad-${String(i).padStart(4, '0')}.json`), '{}', 'utf8');
    }
    const report = overrideEvidenceReport(projectRoot);
    assert.equal(report.snapshotCount, 301);
    assert.equal(report.snapshotScanComplete, false);
    assert.ok(report.checks.includes(OVERRIDE_SNAPSHOT_SCAN_INCOMPLETE_CHECK));
    assert.ok(report.orphanSnapshots.length <= 256, 'and it stopped reading at the bound');
  });

  // The other arm: a directory that will not list at all. ENOENT is the one
  // failed listing that IS a complete answer (a clean install has no bucket) —
  // every other errno is a gap.
  withOverrideStore((projectRoot) => {
    const snapshotPath = mint(projectRoot);
    const dir = path.dirname(snapshotPath);
    fs.chmodSync(dir, 0o000);
    CLAMPED.push(dir);
    let listed = true;
    try { fs.readdirSync(dir); } catch { listed = false; }
    assert.equal(listed, false,
      'fixture guard: this environment must actually refuse the listing (a root uid ignores the mode bits)');
    const report = overrideEvidenceReport(projectRoot);
    assert.equal(report.snapshotScanComplete, false, 'EACCES on the directory is not "no snapshots"');
    assert.ok(report.checks.includes(OVERRIDE_SNAPSHOT_SCAN_INCOMPLETE_CHECK));
  });
});

// ── the count is of MINTS, not of lines ──────────────────────────────────────

test('a duplicated ledger line cannot buy back a deleted one', () => {
  // The attack this closes, and it needed nothing but the ledger file: mint for
  // the run you want hidden, mint a decoy, then write the DECOY's signed line
  // twice and delete the real one. Counting lines, both surviving witnesses
  // agreed — two vouchable lines against a counter of two, and the snapshot of
  // the deleted mint was deleted with it. Counting distinct token ids, the
  // copies collapse into the one mint they attest to.
  withOverrideStore((projectRoot) => {
    const hiddenSnapshot = mint(projectRoot, 'run-hidden');
    mint(projectRoot, 'run-decoy');
    const lines = fs.readFileSync(overrideLedgerPath(projectRoot), 'utf8').trim().split('\n');
    const decoy = lines[1] as string;
    fs.writeFileSync(overrideLedgerPath(projectRoot), `${decoy}\n${decoy}\n`, 'utf8');
    fs.rmSync(path.dirname(hiddenSnapshot), { recursive: true });

    const report = overrideEvidenceReport(projectRoot);
    assert.equal(report.ledger, 'ok', 'both copies parse and both verify — the MAC covers the line, not its position');
    assert.equal(report.vouchableLines, 2, 'two lines survive the read');
    assert.equal(report.vouchableMints, 1, 'attesting to ONE mint between them');
    assert.equal(report.mintCounter.count, 2);
    assert.ok(report.checks.includes(OVERRIDE_MINT_COUNT_MISMATCH_CHECK),
      'so the counter still outnumbers the mints and certification stays refused');

    // Reported even though it changes no verdict: nothing else would say it.
    assert.equal(probeOverrides(projectRoot, 'run-hidden').duplicateLines, 1);
  });
});

test('padding the ledger before an honest mint cannot run the counter away from the history', () => {
  // The same missing dedupe, pointed the other way: `recordOverrideMint` adopts
  // whatever the ledger seems to show, so junk-padding it before a legitimate
  // mint used to drive the counter somewhere the real history could never reach
  // again — a permanent refusal, arrived at through the supported command.
  withOverrideStore((projectRoot) => {
    mint(projectRoot, 'run-1');
    const line = fs.readFileSync(overrideLedgerPath(projectRoot), 'utf8').trim();
    fs.writeFileSync(overrideLedgerPath(projectRoot), `${line}\n`.repeat(4), 'utf8');
    mint(projectRoot, 'run-2');

    const report = overrideEvidenceReport(projectRoot);
    assert.equal(report.vouchableMints, 2, 'four copies of one line plus one genuine second mint');
    assert.equal(report.mintCounter.count, 2, 'and the counter followed the mints, not the line count');
    assert.deepEqual(report.checks, [],
      'so an honest project that was padded is not permanently wedged by its own next mint');
  });
});
