// src/shared/__tests__/one-settings-blocking-shapes.test.ts
// An on-disk shape that would BLOCK a reader is presence, unopened — every
// settings write returns.
//
// THE WORST OUTCOME IN THIS PROTOCOL'S OWN RANKING, reachable with one `mkfifo`,
// and it had already been repaired ONE FILE OVER. state/project-state-lock.ts
// closed it for the canonical project state lock; one-settings.ts carries the
// same protocol, ported twice, and every one of its readers still called bare
// `readFileSync`. DRIVEN before the repair (.tmp/override8/p1-drive.mjs, one
// child per case under a hard 12 000 ms SIGKILL, load 12.98 → 27.44, the
// resolved settings path asserted in the child's own output so a case that
// landed on a different one.json is discarded rather than counted):
//
//   withMachineFileLock at the real override ledger path
//     plain                        2 ms        held
//     dead-pid owner               3 ms        reaped, held
//     FIFO owner entry             HUNG        SIGKILL at 12 011 ms
//     FIFO + a stray beside it     HUNG        SIGKILL at 12 015 ms
//   updateOneSettings — the call every reconciliation goes through
//     plain                        7 ms        written
//     FIFO owner entry             HUNG        SIGKILL at 12 015 ms
//     FIFO + a stray beside it     HUNG        SIGKILL at 12 015 ms
//     a FIFO AT one.json           HUNG        SIGKILL at 12 068 ms
//
// So `traffic-one override` never returned, no deadline fired, nothing was
// logged, and every `updateOneSettings` caller on the machine inherited it —
// the wizard's API key and the consent record included. After the repair every
// row above returns in 1–3 ms.
//
// TWO READERS, and the second is why one row is not enough: with a single entry
// the STRICT reader blocks, and with a stray beside it `observedLockOwner` bails
// on `entries.length !== 1` and `reapAbandonedLock` blocks instead. The release
// is a third. The FIFO AT one.json is a fourth reader and not a lock reader at
// all — `readRawSettings` runs BEFORE the lock is taken, so no lock protocol
// could ever have bounded it.
//
// NO WALL CLOCK CEILING IS ASSERTED, for the reason lock-identity-symlink.ts
// gives at its own rows: what these cells are about is that the call RETURNS,
// and for a refusing shape the deadline throw IS the return.
//
// ── EVERY SHAPE THAT CAN BLOCK IS DRIVEN IN A CHILD, and the paragraph this
// replaces is why ────────────────────────────────────────────────────────────
// It read: "The explicit per-test timeout is what turns a regression from a
// wedged suite into a red one, since a hang has no other failure mode." That is
// FALSE, and it was measured false against this exact file. Node's test timeout
// is a timer on the event loop, and a blocking synchronous `open(2)` is holding
// that loop — so the timer NEVER FIRES. A reviewer applied a mutant that dropped
// `O_NONBLOCK` and this suite, together with
// state/__tests__/lock-identity-symlink.test.ts, sat in `open(2)` on a FIFO for
// over TEN MINUTES under `--test-timeout=30000` without producing a row; the runs
// had to be killed by hand, twice, after multi-hour hangs.
//
// So `{ timeout: CELL_TIMEOUT_MS }` buys nothing against the only failure mode
// these cells have. It is kept because it still bounds the ordinary slow-cell
// case, but it is NOT the instrument, and believing it was is what made a bound
// regression cost a CI job its entire wall clock while reporting nothing.
//
// A deadline has to be enforced from OUTSIDE the process that might hang. That
// is now measured in three languages — Python's `signal.alarm` cannot interrupt
// it, node's `--test-timeout` cannot, and no userland deadline can — so every
// cell below whose product call could block runs in a CHILD under
// `spawnSync({ timeout })`, and `run.signal` is asserted null. With the bound in
// place the child returns in well under a second; without it the child is KILLED
// BY SIGNAL and the row REDS. Same discipline, and the same reason, as
// __tests__/fsjson-bounded-read.test.ts, which had it from the start.
//
// The FIXTURES stay in this process, because planting a FIFO never blocks —
// only reading one does. So the parent still builds every shape and still makes
// every post-condition assertion against the real filesystem; what moves to the
// child is exactly the product call. The cells whose shape CANNOT block (a
// directory, a symlink to a regular file) stay in process, where they are
// cheaper and just as decisive.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ONE_SETTINGS_VERSION } from '../../config/one-settings';
import {
  isOneSettingsLockTimeout,
  oneSettingsPath,
  readCanonicalOneSettings,
  updateOneSettings,
  withMachineFileLock,
} from '../one-settings';

// Long enough that a loaded host never trips it, short enough that a hang is
// reported instead of inherited.
const CELL_TIMEOUT_MS = 30_000;
// Small on purpose: every refusing cell below pays it in full.
const LOCK_WAIT_MS = 300;

const scratch: string[] = [];

function fixture(name: string): { root: string; env: NodeJS.ProcessEnv; settings: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `t1-onesettings-${name}-`));
  scratch.push(root);
  const env = { ...process.env, XDG_STATE_HOME: root };
  const settings = oneSettingsPath(env);
  fs.mkdirSync(path.dirname(settings), { recursive: true, mode: 0o700 });
  return { root, env, settings };
}

function writeSettings(at: string): void {
  fs.writeFileSync(at, `${JSON.stringify({ schemaVersion: ONE_SETTINGS_VERSION, codeGraphProvider: null }, null, 2)}\n`);
}

function fifo(at: string): void {
  execFileSync('mkfifo', [at]);
  assert.equal(fs.lstatSync(at).isFIFO(), true, 'fixture guard: the planted entry must actually be a FIFO');
}

function ownerRecord(lockDir: string, token: string, pid: number): void {
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(lockDir, `owner-${token}.json`), JSON.stringify({ pid, token, createdAt: Date.now() }));
}

/** Held, or the refusal it returned instead. Never a hang — that is the point.
 *  IN PROCESS: only for a fixture whose shape cannot block. Anything that can
 *  block goes through `inChild` below. */
function tryHold(file: string): { held: boolean; timedOut: boolean; elapsedMs: number } {
  const startedAt = Date.now();
  let held = false;
  let timedOut = false;
  try {
    withMachineFileLock(file, () => { held = true; }, LOCK_WAIT_MS);
  } catch (error) {
    timedOut = isOneSettingsLockTimeout(error);
    if (!timedOut) throw error;
  }
  return { held, timedOut, elapsedMs: Date.now() - startedAt };
}

const ONE_SETTINGS_MODULE = path.join(__dirname, '..', 'one-settings.ts');

/** Whatever the one product call answered, from a process that is allowed to die. */
interface ChildOutcome {
  readonly held?: boolean;
  readonly timedOut?: boolean;
  readonly threw?: string | null;
  readonly readOk?: boolean;
  readonly swapped?: string;
  readonly error?: string;
  readonly ms: number;
}

/**
 * Run ONE product call against an already-planted fixture in a CHILD PROCESS, and
 * fail if the child did not RETURN.
 *
 * `run.signal` is the assertion that matters. A userland deadline cannot
 * interrupt a blocking synchronous read — see this file's header — so a child
 * under `timeout:` with a hard kill is the only thing that converts a bound
 * regression into a red row rather than a wedged run. The child requires
 * one-settings.ts through `--import tsx` and inherits this process's environment,
 * so the preload's `TRAFFIC_ONE_PLUGIN_ROOT` pin and the ask-first value declared
 * above both travel with it.
 */
function inChild(action: 'tryHold' | 'update' | 'releaseSwap', target: string, stateHome: string, label: string): ChildOutcome {
  const driver = path.join(stateHome, `drive-${action}.cjs`);
  fs.writeFileSync(driver, [
    "const fs = require('fs');",
    "const path = require('path');",
    "const { execFileSync } = require('child_process');",
    'const mod = require(process.argv[2]);',
    'const [action, target, stateHome, lockWaitMs] = process.argv.slice(3);',
    'const env = { ...process.env, XDG_STATE_HOME: stateHome };',
    'const out = {};',
    'const started = Date.now();',
    "if (action === 'tryHold') {",
    '  let held = false;',
    '  try { mod.withMachineFileLock(target, () => { held = true; }, Number(lockWaitMs)); }',
    '  catch (error) {',
    '    out.timedOut = mod.isOneSettingsLockTimeout(error);',
    '    if (!out.timedOut) out.error = String(error && error.message);',
    '  }',
    '  out.held = held;',
    "} else if (action === 'update') {",
    "  try { mod.updateOneSettings({ codeGraphProvider: 'x' }, env); out.threw = null; }",
    '  catch (error) { out.threw = String(error && error.message); }',
    '  out.readOk = mod.readCanonicalOneSettings(env).ok;',
    "} else if (action === 'releaseSwap') {",
    '  const lockDir = `${target}.lock`;',
    '  mod.withMachineFileLock(target, () => {',
    '    const [ownerName] = fs.readdirSync(lockDir);',
    '    out.swapped = path.join(lockDir, ownerName);',
    '    fs.unlinkSync(out.swapped);',
    "    execFileSync('mkfifo', [out.swapped]);",
    '  }, Number(lockWaitMs));',
    '}',
    'out.ms = Date.now() - started;',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n'), 'utf8');

  const run = spawnSync(process.execPath, [
    '--import', 'tsx', driver, ONE_SETTINGS_MODULE, action, target, stateHome, String(LOCK_WAIT_MS),
  ], { encoding: 'utf8', timeout: CELL_TIMEOUT_MS });

  assert.equal(run.signal, null,
    `${label}: \`${action}\` must RETURN rather than block in open(2) — killed by signal means the bound is `
    + 'gone. This is the row that has to red instead of wedging the suite: node\'s own test timeout is a timer '
    + `on the event loop the blocked read is holding, so it never fires. stderr: ${run.stderr || ''}`);
  assert.equal(run.status, 0, `${label}: ${run.stderr || ''}`);
  const outcome = JSON.parse(run.stdout) as ChildOutcome;
  assert.equal(outcome.error, undefined, `${label}: unexpected error from the child — ${outcome.error}`);
  return outcome;
}

test.after(() => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test('a FIFO owner entry is presence with no liveness claim — the STRICT reader returns', { timeout: CELL_TIMEOUT_MS }, (t) => {
  const fx = fixture('fifo-strict');
  const ledger = path.join(fx.root, 'traffic-one', 'overrides', 'k', 'overrides.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
  fs.mkdirSync(`${ledger}.lock`, { recursive: true, mode: 0o700 });
  // A name the STRICT grammar accepts, so `observedLockOwner` is the reader that
  // meets it: `owner-<hex>.json`, one entry, nothing else in the directory.
  fifo(path.join(`${ledger}.lock`, 'owner-deadbeef.json'));

  const attempt = inChild('tryHold', ledger, fx.root, 'FIFO, strict reader');
  t.diagnostic(`FIFO, strict reader: ${attempt.held ? 'reaped and held' : 'refused'} in ${attempt.ms} ms`);
  assert.equal(attempt.held, true,
    'an entry that cannot be OPENED as a regular file makes no liveness claim, so this lock is abandoned and '
    + 'must be reclaimable — and above all the call must RETURN. Before the bound it did neither: the open '
    + 'waited for a writer that never came, with the deadline tested between iterations it never reached.');
});

test('a FIFO beside a stray routes through the ABANDONED reader, which returns too', { timeout: CELL_TIMEOUT_MS }, (t) => {
  const fx = fixture('fifo-reaper');
  const ledger = path.join(fx.root, 'traffic-one', 'overrides', 'k', 'overrides.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
  fs.mkdirSync(`${ledger}.lock`, { recursive: true, mode: 0o700 });
  fifo(path.join(`${ledger}.lock`, 'owner-deadbeef.json'));
  // The stray is what takes the strict reader out of the picture
  // (`entries.length !== 1`), leaving `reapAbandonedLock` to do the reading —
  // a second copy of the same defect that one row cannot reach.
  fs.writeFileSync(path.join(`${ledger}.lock`, '.DS_Store'), '');

  const attempt = inChild('tryHold', ledger, fx.root, 'FIFO + stray, abandoned reader');
  t.diagnostic(`FIFO + stray, abandoned reader: ${attempt.held ? 'reaped and held' : 'refused'} in ${attempt.ms} ms`);
  assert.equal(attempt.held, true, 'the second reader must be bounded exactly as the first is');
});

test('a FIFO beside a LIVE owner does not steal the lock — a null read is not an absent owner', { timeout: CELL_TIMEOUT_MS }, (t) => {
  // The property the widening is not allowed to cost, and the cell that decides
  // whether "unreadable → keep looking" was the right shape. `reapAbandonedLock`
  // asks whether ANYONE in the directory is alive, so a shape it cannot read
  // must move it to the NEXT entry rather than end the search: a `break` or an
  // early `return` here hands a running holder's lock to the next caller, and
  // the FIFO can be listed first.
  const fx = fixture('fifo-live');
  const ledger = path.join(fx.root, 'traffic-one', 'overrides', 'k', 'overrides.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
  ownerRecord(`${ledger}.lock`, 'live', process.pid);
  fifo(path.join(`${ledger}.lock`, 'owner-000000.json'));

  // The LIVE owner is THIS process's pid, and it stays live for as long as the
  // child runs, so moving the acquisition into a child costs the fixture nothing.
  const attempt = inChild('tryHold', ledger, fx.root, 'FIFO + live owner');
  t.diagnostic(`FIFO + live owner: ${attempt.held ? 'STOLE the lock' : 'refused'} in ${attempt.ms} ms`);
  assert.equal(attempt.held, false, 'a live holder must keep its lock however unreadable a neighbour entry is');
  assert.equal(attempt.timedOut, true, 'and the refusal must be this lock\'s own timeout, not a raw errno');
  assert.ok(fs.existsSync(path.join(`${ledger}.lock`, `owner-live.json`)),
    "the live owner's record must survive — a reclaim unlinks it");
});

test('a symlink in the lock directory cannot borrow another object\'s liveness', { timeout: CELL_TIMEOUT_MS }, (t) => {
  // O_NOFOLLOW, and the wedge it refuses. A link to a LIVE holder's owner file
  // makes another object's pid answer for THIS lock: the lock is then refused
  // for ever, with no age gate in this protocol to expire it and no process
  // anywhere holding it. Presence, like every other non-regular shape, is what
  // keeps it reclaimable.
  const fx = fixture('symlink-borrow');
  const ledger = path.join(fx.root, 'traffic-one', 'overrides', 'k', 'overrides.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
  const borrowed = path.join(fx.root, 'borrowed-owner.json');
  fs.writeFileSync(borrowed, JSON.stringify({ pid: process.pid, token: 'borrowed', createdAt: Date.now() }));
  fs.mkdirSync(`${ledger}.lock`, { recursive: true, mode: 0o700 });
  fs.symlinkSync(borrowed, path.join(`${ledger}.lock`, 'owner-borrowed.json'));

  const attempt = tryHold(ledger);
  t.diagnostic(`symlink to a live owner file: ${attempt.held ? 'reclaimed' : 'REFUSED'} in ${attempt.elapsedMs} ms`);
  assert.equal(attempt.held, true,
    'a link is not a record this protocol wrote, and reading through it makes an unrelated live pid hold a '
    + 'lock nobody is holding — permanently, since this protocol consults no age');
});

test('a FIFO AT one.json is refused rather than opened — the read BEFORE the lock', { timeout: CELL_TIMEOUT_MS }, (t) => {
  // The address no lock protects: `readRawSettings` runs at the top of
  // `updateOneSettings`, before `acquireSettingsLock` is reached, so the
  // hardened lock protocol was never in the picture. The population that can
  // plant a FIFO in the lock directory can plant one here — it is the same
  // directory.
  const fx = fixture('settings-fifo');
  fifo(fx.settings);

  const attempt = inChild('update', fx.settings, fx.root, 'FIFO at one.json');
  t.diagnostic(`FIFO at one.json: refused in ${attempt.ms} ms`);
  assert.match(String(attempt.threw), /malformed/,
    'a settings file that is not a regular file must take the refusal a DIRECTORY at that path already took');
  assert.equal(attempt.readOk, false, 'and the read side reports it rather than blocking on it');
  assert.equal(fs.lstatSync(fx.settings).isFIFO(), true, 'the FIFO is still there, unread and unremoved');
});

test('a SYMLINKED one.json is still an operator\'s settings file, and is read', { timeout: CELL_TIMEOUT_MS }, () => {
  // The deliberate asymmetry between the two readers, pinned so it is a decision
  // rather than a leftover. An owner file inside a lock directory is written by
  // the protocol at a name it chose, so a link there is somebody else's
  // evidence and is refused; `one.json` is an operator's file at a documented
  // path, and a dotfiles checkout that links it is a configuration. Boundedness
  // does not depend on the refusal — the cell below is the proof, since the link
  // TARGET decides and a link to a FIFO is still refused without blocking.
  const fx = fixture('settings-symlink');
  const real = path.join(fx.root, 'elsewhere-one.json');
  writeSettings(real);
  fs.symlinkSync(real, fx.settings);

  const read = readCanonicalOneSettings(fx.env);
  assert.equal(read.ok, true, 'a symlinked settings file must not read as malformed');
  assert.equal(read.settings.schemaVersion, ONE_SETTINGS_VERSION);
});

test('a symlink AT one.json pointing to a FIFO is refused without blocking', { timeout: CELL_TIMEOUT_MS }, () => {
  // What the followed link is allowed to cost, and it costs nothing: the open is
  // still non-blocking and the kind is still decided on the DESCRIPTOR, so the
  // FIFO at the end of the link answers PRESENCE without a byte being read.
  const fx = fixture('settings-symlink-fifo');
  const target = path.join(fx.root, 'blocking-target');
  fifo(target);
  fs.symlinkSync(target, fx.settings);

  const attempt = inChild('update', fx.settings, fx.root, 'symlink at one.json to a FIFO');
  assert.match(String(attempt.threw), /malformed/);
  assert.equal(attempt.readOk, false);
});

test('a DIRECTORY at one.json is refused exactly as it always was', { timeout: CELL_TIMEOUT_MS }, () => {
  // The control for the two rows above: this is the one non-regular shape that
  // could never hang (EISDIR is immediate), and it already took the malformed
  // refusal. The repair moves the blocking shapes onto the answer this one was
  // always given rather than inventing a verdict for them.
  const fx = fixture('settings-dir');
  fs.mkdirSync(fx.settings);
  assert.throws(() => updateOneSettings({ codeGraphProvider: 'x' }, fx.env), /malformed/);
  assert.equal(readCanonicalOneSettings(fx.env).ok, false);
});

test('a holder whose OWN owner file is swapped mid-hold releases without hanging and without guessing', { timeout: CELL_TIMEOUT_MS }, (t) => {
  // The third reader. The proof of ownership the release rests on is a read of a
  // path INSIDE the lock directory, so anybody who can write there can replace
  // our own record while we hold it — driven here by a body that does exactly
  // that to itself, which is how state/project-state-lock.ts drove the same
  // reader. Two properties, and the second is the one a mutant reaches for:
  // the release must RETURN (a FIFO there used to block it, leaving the lock
  // published for ever), and it must not rename away a directory whose record it
  // could not verify — "never unlink a lock we cannot prove we own" is this
  // function's own rule, and an unreadable record is not proof.
  //
  // Leaving it is not a wedge, which is why refusing is affordable: the next
  // acquirer reads the same unreadable entry, makes no liveness claim from it,
  // and reclaims. That second acquisition is asserted below rather than argued.
  const fx = fixture('release-swap');
  const ledger = path.join(fx.root, 'traffic-one', 'overrides', 'k', 'overrides.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
  const lockDir = `${ledger}.lock`;

  // BOTH halves run in children: the hold's own RELEASE reads the swapped record,
  // and so does the reclaim below. The swap has to happen inside the body, so the
  // body travels to the child with it; the parent still owns every assertion, all
  // of which are filesystem state the child left behind.
  const held = inChild('releaseSwap', ledger, fx.root, 'release with a swapped owner record');
  const swapped = String(held.swapped);
  t.diagnostic(`release with a swapped owner record: returned in ${held.ms} ms`);

  assert.equal(fs.existsSync(lockDir), true,
    'the release renamed away a lock directory whose owner record it could not read — the one thing it '
    + 'refuses to do, since an unverifiable record is exactly the case where the directory may be somebody '
    + "else's lease rather than ours");
  assert.equal(fs.lstatSync(swapped).isFIFO(), true, 'and the planted record is still there, unread');
  assert.equal(inChild('tryHold', ledger, fx.root, 'reclaim after a refused release').held, true,
    'and the next acquirer must still reclaim it, or refusing to release would be a wedge rather than caution');
});

test('a settings write still lands when nothing hostile is planted', { timeout: CELL_TIMEOUT_MS }, () => {
  // The cell that stops every refusal above from being satisfiable by a
  // primitive that refuses everything.
  const fx = fixture('control');
  writeSettings(fx.settings);
  updateOneSettings({ codeGraphProvider: 'graphify' }, fx.env);
  const read = readCanonicalOneSettings(fx.env);
  assert.equal(read.ok, true);
  assert.equal(read.settings.codeGraphProvider, 'graphify');
  assert.equal(tryHold(fx.settings).held, true, 'and an uncontended lock is still takeable');
});
