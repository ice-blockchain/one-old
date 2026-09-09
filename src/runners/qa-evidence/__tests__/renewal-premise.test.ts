// src/runners/qa-evidence/__tests__/renewal-premise.test.ts
// The premise the run lock's staleness window rests on, verified instead of
// asserted.
//
// `QA_RUN_LOCK_STALE_MS` stopped bounding the RUN and started bounding SILENCE
// when renewal landed: the holder re-stamps `refreshedAt` from a
// `setInterval(...).unref()` on its own event loop, so a lock is reclaimable
// only after the holder has failed to turn that loop for fifteen minutes. The
// whole guarantee therefore reduces to one quantity — the longest stretch the
// holding process can go without turning its event loop — and the docblock
// answers it with an enumeration and a margin.
//
// AN ENUMERATION IS EXACTLY THE KIND OF CLAIM THAT ROTS. The one that stood
// there said "the only synchronous stretches left are local fs work", and there
// were three synchronous non-fs stretches at the time it was written. Nothing
// in the tree noticed, because nothing in the tree read it. Two properties are
// verified here, and between them a bound cannot be raised and a blocking call
// cannot be introduced without something going red first:
//
//   THE MARGIN    the bounds are imported, not quoted, so raising one moves the
//                 computed margin; the docblock's own figure is then checked
//                 against it.
//   THE ROSTER    the blocking sites are counted from source, so a new
//                 `spawnSync` or `Atomics.wait` anywhere the runner can reach
//                 fails until it is classified.
//
// What is NOT verified here is that each site's bound is honoured at runtime —
// that belongs to the module that owns the bound, and process-group.test.ts and
// windows-tree-kill.test.ts already hold those. This file is about the
// arithmetic between them and the window.

import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';

import { HTTP_PROBE_SPAWN_TIMEOUT_MS } from '../../../shared/qa-report-v2/build';
import { QA_RUN_LOCK_RENEW_MS, QA_RUN_LOCK_STALE_MS } from '../lock';
import { REAP_SWEEPS, REAP_SWEEP_GAP_MS, TREE_KILL_TIMEOUT_MS } from '../process-group';

const SRC = path.join(__dirname, '..', '..', '..');
const LOCK_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lock.ts'), 'utf8');

/**
 * The three stretches the window's margin is computed from, as VALUES rather
 * than as numerals in a sentence.
 *
 * Each is the bound of one site in the roster below, imported from the module
 * that owns it. That is the difference between this file and the docblock it
 * replaces the trust in: raising `TREE_KILL_TIMEOUT_MS` to a minute is a change
 * to this array without anyone editing this array.
 */
const BOUNDED_STRETCHES: ReadonlyArray<{ site: string; ms: number }> = [
  { site: 'process-group.ts blockFor', ms: REAP_SWEEP_GAP_MS * REAP_SWEEPS },
  { site: 'process-group.ts tree kill', ms: TREE_KILL_TIMEOUT_MS },
  { site: 'qa-report-v2/build.ts probe', ms: HTTP_PROBE_SPAWN_TIMEOUT_MS },
];

const LONGEST = Math.max(...BOUNDED_STRETCHES.map((stretch) => stretch.ms));

test('the staleness window keeps two orders of magnitude on the longest synchronous stretch', () => {
  // The claim is a RATIO, so it is asserted as one: a hundredfold is the floor
  // the docblock's reasoning needs ("not within two orders of magnitude"), and
  // it holds however the two ends move. A change that halves the window or
  // decuples a bound is the change this refuses.
  const margin = QA_RUN_LOCK_STALE_MS / LONGEST;
  assert.ok(
    margin >= 100,
    `the longest synchronous stretch is ${LONGEST} ms against a ${QA_RUN_LOCK_STALE_MS} ms window `
    + `(${margin.toFixed(1)}x). The window bounds SILENCE, and a stretch this close to it means a `
    + 'live holder can be robbed mid-run: either lower the bound or raise the window, and re-state '
    + 'the enumeration in lock.ts either way.',
  );

  // And the renewal cadence has to divide the window enough times that losing a
  // handful of ticks in a row is survivable — the second half of the same
  // premise, and the reason a single blocked stretch is not a lost lock.
  const ticksPerWindow = QA_RUN_LOCK_STALE_MS / QA_RUN_LOCK_RENEW_MS;
  assert.ok(ticksPerWindow >= 10, `renewal divides the window only ${ticksPerWindow} times`);
  assert.ok(
    QA_RUN_LOCK_RENEW_MS > LONGEST,
    'a renewal interval shorter than the longest synchronous stretch cannot recover from one',
  );
});

test('the margin lock.ts states is the margin the constants produce', () => {
  // The recurring defect in this lane is prose citing a fact nothing verifies.
  // The docblock names a figure; here it is, recomputed from the constants and
  // compared against the sentence. Bump a bound and the sentence is wrong, and
  // being wrong is now a failure rather than a reading.
  const stated = /(\d+)x margin/.exec(LOCK_SOURCE);
  assert.ok(stated, 'lock.ts no longer states the margin its design rests on');
  assert.equal(
    Number(stated[1]),
    Math.floor(QA_RUN_LOCK_STALE_MS / LONGEST),
    'lock.ts states a margin the constants do not produce',
  );
  assert.match(LOCK_SOURCE, new RegExp(`\\b${LONGEST / 1000} s\\b`),
    'lock.ts names a longest stretch that is not the longest stretch');
});

// ---------------------------------------------------------------------------
// THE ROSTER.
// ---------------------------------------------------------------------------

const BLOCKING = /\b(?:spawnSync|execSync|execFileSync|Atomics\.wait)\b/g;

/**
 * Comments blanked, not removed, so a match's line number still points at the
 * line that produced it. Crude by design: it can miss an occurrence inside a
 * string literal, which is the harmless direction — the roster's job is to
 * notice a new CALL, and a call cannot hide in a string.
 */
function code(file: string): string {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, before: string) => before + ' '.repeat(m.length - before.length));
}

function blockingSites(file: string): string[] {
  const text = code(file);
  const sites: string[] = [];
  for (const match of text.matchAll(BLOCKING)) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const line = text.slice(lineStart, match.index);
    // An import statement names the API without blocking on it; the call sites
    // it enables are counted where they are.
    if (/^\s*import\b/.test(line)) continue;
    sites.push(match[0]);
  }
  return sites;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...tsFiles(full));
    } else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Every module the runner's entry point can reach through a relative import.
 *
 * An OVER-approximation of what the process executes while holding the lock,
 * and deliberately so: reachability of a call is the expensive question and
 * over-approximating it is the safe direction for a guarantee. The cost is
 * paid in the roster below, where a site that is reachable-but-never-called is
 * recorded as such with the reason, rather than in a census that quietly misses
 * a site because no one traced the call.
 */
function reachableModules(): string[] {
  const resolve = (from: string, spec: string): string | null => {
    const base = path.resolve(path.dirname(from), spec);
    for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const seen = new Set<string>();
  const queue = [path.join(__dirname, '..', 'index.ts')];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/from\s+'(\.[^']*)'/g)) {
      const spec = match[1];
      const next = spec ? resolve(file, spec) : null;
      if (next) queue.push(next);
    }
  }
  return [...seen];
}

/**
 * WHERE THE RUNNER CAN BLOCK, and what each site is worth.
 *
 * One row per module, keyed by path relative to `src/`, with the number of
 * blocking call sites in it. Two classes, and the distinction is the whole
 * value of the table:
 *
 *   bounded     the call cannot outlast the recorded bound, so it enters the
 *               margin arithmetic above.
 *   not-called  the module is IMPORTED but the blocking function in it is not
 *               on any path this runner takes. Reachability of a MODULE is what
 *               the census can see; reachability of a CALL is what matters, and
 *               where they differ the difference is recorded with its reason
 *               rather than assumed either way.
 *
 * A new blocking site anywhere in the reachable graph fails the test that reads
 * this, including one added by a lane that has never heard of this lock. That
 * is the intent: the failure asks for one line here, and the line asks whoever
 * added it whether their call can outlast fifteen minutes.
 */
const ROSTER: ReadonlyArray<{ module: string; sites: number; note: string }> = [
  // ---- bounded, and in the margin arithmetic ----
  { module: 'runners/qa-evidence/process-group.ts', sites: 2, note: 'bounded: blockFor 5 ms x3 sweeps; taskkill spawnSync at TREE_KILL_TIMEOUT_MS' },
  { module: 'shared/qa-report-v2/build.ts', sites: 1, note: 'bounded: served-build HTTP probe at HTTP_PROBE_SPAWN_TIMEOUT_MS' },
  // ---- bounded, owned elsewhere, smaller than the two above ----
  { module: 'shared/verification-contract/git.ts', sites: 6, note: 'bounded: every git execFileSync carries timeout 3_000' },
  { module: 'shared/architecture-contract/baseline.ts', sites: 6, note: 'bounded: every git execFileSync carries timeout 3_000' },
  { module: 'shared/host/plan.ts', sites: 3, note: 'bounded: sqlite3 -readonly probes at timeout 2_000' },
  { module: 'shared/one-settings.ts', sites: 1, note: 'bounded: sleepSync inside a retry loop with a constant attempt count' },
  { module: 'shared/run-model-policy.ts', sites: 1, note: 'bounded: sleepSync inside a retry loop with a constant attempt count' },
  { module: 'shared/state/codex-model-observation.ts', sites: 1, note: 'bounded: sleepSync inside a retry loop with a constant attempt count' },
  { module: 'shared/state/project-state-lock.ts', sites: 1, note: 'bounded: sleepSync inside the acquisition loop, itself deadline-bounded' },
  { module: 'shared/state/run-agent/locks.ts', sites: 1, note: 'bounded: sleepSync inside the acquisition loop, itself deadline-bounded' },
  { module: 'shared/state/run-agent/mutation-result.ts', sites: 1, note: 'bounded: UNAVAILABLE_RETRY_BACKOFF_MS x UNAVAILABLE_RETRY_ATTEMPTS' },
  // ---- imported, never called from this runner ----
  { module: 'shared/per-user-dir-lock.ts', sites: 1, note: 'bounded: Atomics.wait inside sleepSync, itself deadline-bounded by the lock acquisition loop (retryMs vs deadline)' },
  { module: 'shared/node-floor.ts', sites: 5, note: 'not-called: every spawnSync match is inside nodeFloorGuardSource() emitted launcher strings. The QA runner never executes that generated ES5.' },
  { module: 'shared/exec.ts', sites: 1, note: 'not-called: the runner reaches this module only through spawn-tool\'s resolveWindowsCommand, which calls exec.which — a PATH walk in fs, no child. exec.run/runResult, the 60 s spawnSync, is on no path from qa-evidence.' },
  { module: 'shared/spawn-tool.ts', sites: 3, note: 'not-called: native-process.ts imports the escaping and resolution helpers only; spawnTool itself is never invoked from this runner.' },
  { module: 'shared/runner-shims.ts', sites: 2, note: 'not-called: the shim spawns the runner and is the PARENT process — it holds no lock, and the runner it starts does not import back into it. One of the two sites is inside the shim SOURCE this module emits, which never executes here at all.' },
];

/**
 * The rows whose bound is a literal in the callee rather than a constant this
 * file can import, checked against the callee's source.
 *
 * Without this the notes above would be exactly the kind of sentence this file
 * exists to stop trusting: `timeout: 3_000` in a note proves nothing about the
 * six call sites it describes. Every blocking call in these modules is a `git`
 * or `sqlite3` read with its bound written inline, so the honest check is a
 * count — as many bounds as there are calls.
 */
const INLINE_BOUNDS: ReadonlyArray<{ module: string; bound: string; ms: number }> = [
  { module: 'shared/verification-contract/git.ts', bound: 'timeout: 3_000', ms: 3_000 },
  { module: 'shared/architecture-contract/baseline.ts', bound: 'timeout: 3_000', ms: 3_000 },
  { module: 'shared/host/plan.ts', bound: 'timeout: 2000', ms: 2_000 },
];

test('every place the runner can block on a synchronous call is one this premise has counted', () => {
  const found = new Map<string, number>();
  for (const file of reachableModules()) {
    const count = blockingSites(file).length;
    if (count > 0) found.set(path.relative(SRC, file), count);
  }

  const recorded = new Map(ROSTER.map((row) => [row.module, row.sites]));
  const unrecorded = [...found].filter(([module]) => !recorded.has(module));
  assert.deepEqual(
    unrecorded.map(([module, count]) => `${module} (${count})`),
    [],
    'a module the QA evidence runner can reach gained a synchronous blocking call that this premise '
    + 'has not counted. The run lock treats fifteen minutes of silence as a dead holder, and a '
    + 'synchronous call is silence. Add a row to ROSTER in this file saying what bounds it — or that '
    + 'nothing on this runner\'s paths calls it — and, if it is longer than the current longest, '
    + 'restate the enumeration in lock.ts.',
  );

  const moved = [...found]
    .filter(([module, count]) => recorded.get(module) !== count)
    .map(([module, count]) => `${module}: ${recorded.get(module)} recorded, ${count} found`);
  assert.deepEqual(moved, [], 'the count of blocking call sites in a counted module changed');

  const vanished = ROSTER.map((row) => row.module).filter((module) => !found.has(module));
  assert.deepEqual(vanished, [], 'ROSTER names a module with no blocking calls left in it — drop the row');
});

test('a roster note claiming an inline bound is a note the callee bears out', () => {
  for (const row of INLINE_BOUNDS) {
    const sites = ROSTER.find((entry) => entry.module === row.module)?.sites;
    assert.ok(sites, `${row.module} is not on the roster`);
    const source = code(path.join(SRC, row.module));
    assert.equal(
      [...source.matchAll(new RegExp(row.bound.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].length,
      sites,
      `${row.module} has ${sites} blocking calls and a different number of \`${row.bound}\` bounds — `
      + 'one of them is unbounded, or the bound moved and this roster still quotes the old one.',
    );
    assert.ok(
      row.ms < LONGEST,
      `${row.module} is bounded at ${row.ms} ms, which is longer than the ${LONGEST} ms the lock's `
      + 'margin is computed from — the enumeration in lock.ts names the wrong longest stretch.',
    );
  }
});

test('the runner\'s own modules block only where the margin says they do', () => {
  // The outer roster is an over-approximation over a hundred and eighty
  // modules, most of which belong to other lanes. THIS is the tight half: in
  // the runner's own tree and the report modules it writes with, the blocking
  // sites are exactly the ones the margin was computed from, so a synchronous
  // hashing pass added HERE — the change the docblock's premise is most exposed
  // to — is red without anyone having to notice the arithmetic.
  const own = [
    path.join(SRC, 'runners', 'qa-evidence'),
    path.join(SRC, 'shared', 'qa-report-v2'),
  ].flatMap((dir) => tsFiles(dir));

  const sites = own.flatMap((file) => blockingSites(file).map((api) => `${path.relative(SRC, file)} ${api}`)).sort();
  assert.deepEqual(sites, [
    'runners/qa-evidence/process-group.ts Atomics.wait',
    'runners/qa-evidence/process-group.ts spawnSync',
    'shared/qa-report-v2/build.ts spawnSync',
  ]);
});
