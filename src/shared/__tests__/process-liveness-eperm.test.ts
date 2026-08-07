// src/shared/__tests__/process-liveness-eperm.test.ts
// The EPERM direction, pinned across every copy of the process-liveness
// predicate in src/.
//
// `process.kill(pid, 0)` sends no signal; it asks the kernel a permission
// question about a pid, and it fails in two ways that mean OPPOSITE things:
//
//   ESRCH  no such process — the holder is gone, its lease may be reclaimed.
//   EPERM  the process EXISTS and belongs to another uid — it is ALIVE, and
//          reclaiming its lease steals a lock from a running process.
//
// Every lock in this repo authorizes a reclaim with one of these predicates, so
// a single copy that reads EPERM as "dead" hands one user's hook the lock a
// different user's hook is holding. There is no test that would catch it: the
// wrong answer only appears on a multi-uid machine, and every fixture in this
// suite runs every process as the same user.
//
// This is a CENSUS, not a consolidation. The copies are deliberately not merged
// here (folding them into one helper is the host-capability-consolidation wave,
// and a wide mechanical edit would make the sites invisible rather than fixed),
// and the census exists so that living with many copies costs nothing in
// correctness. COPY_COUNT is asserted exactly: adding one more fails this test
// until it has been audited, which is the whole point of pinning a number rather
// than iterating whatever happens to be there.
//
// The census is taken by SHAPE, not by name. It was first written to look for
// the two canonical spellings, `processAlive` and `processDefinitelyDead`, and
// that missed three predicates doing exactly the same job under other names:
// qa-report-v2/build.ts's `processExists`, opencode-roles/apply-latch.ts's
// `pidAlive`, and build/sync-hosts.ts's `isPidAlive`. All three happen to be
// correct, which is precisely why a name-keyed census is the wrong instrument —
// it reported a clean audit while three copies of the audited thing sat outside
// it, and the next author to add a `pidLives` would have inherited the same
// blind spot. Anything that asks the kernel `kill(pid, 0)` and answers a boolean
// is a copy, whatever it is called.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { processAlive } from '../onboarding-server/ensure';

const SRC_ROOT = path.resolve(__dirname, '..', '..');

// Fourteen. Eight were named in the original audit; fixing the four mtime-only
// reclaims added three (run-model-policy.ts, state/codex-model-observation.ts,
// modules/agent-model/exhausted-models.ts — the fourth site, the cursor spawn
// observation lock, needed none, it now takes its lease from
// state/run-agent/locks.ts); widening the census from names to shape surfaced
// the last three, which had been there all along.
const COPY_COUNT = 14;

interface Copy {
  readonly file: string;
  readonly name: string;
  readonly body: string;
}

// What makes a function a copy: it asks the kernel about a pid without
// delivering a signal. Not `/g`-flagged — a stateful regex reused across a loop
// answers differently on alternate calls.
const PROBE = /process\.kill\(\s*\w+\s*,\s*0\s*\)/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every boolean-returning function in the file, brace-matched from its
 * signature so the check reads the whole body and cannot be satisfied by a
 * neighbour's code — then narrowed to the ones that actually probe a pid. */
function liveness(source: string, file: string): Copy[] {
  const found: Copy[] = [];
  const signature = /(?:export\s+)?function\s+(\w+)\s*\([^)]*\)\s*:\s*boolean\s*\{/g;
  for (let match = signature.exec(source); match; match = signature.exec(source)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (let i = end; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    const body = source.slice(match.index, end + 1);
    if (!PROBE.test(body)) continue;
    found.push({ file: path.relative(SRC_ROOT, file), name: match[1]!, body });
  }
  return found;
}

/** What the copy answers when the probe SUCCEEDS — the text between the
 * `kill(pid, 0)` and its `catch`. A copy's polarity is decided here rather than
 * from its name, because the name is the one thing about a predicate that
 * carries no guarantee: `processExists`, `pidAlive` and `isPidAlive` are all
 * `processAlive` under another spelling. The slice starts AT the probe so an
 * argument guard's own `return false` cannot be mistaken for the answer. */
function answerOnReachable(copy: Copy): 'alive' | 'dead' | null {
  const probe = copy.body.search(PROBE);
  const catchAt = copy.body.indexOf('catch', probe);
  const tryTail = copy.body.slice(probe, catchAt < 0 ? undefined : catchAt);
  if (/return\s+true;/.test(tryTail)) return 'alive';
  if (/return\s+false;/.test(tryTail)) return 'dead';
  return null;
}

const copies = sourceFiles(SRC_ROOT)
  .flatMap((file) => liveness(fs.readFileSync(file, 'utf8'), file))
  .sort((a, b) => a.file.localeCompare(b.file));

test('every process-liveness predicate is accounted for', () => {
  assert.equal(copies.length, COPY_COUNT,
    `the liveness predicate census changed — audit the new copy's EPERM direction and update COPY_COUNT: ${
      copies.map((c) => `${c.file}:${c.name}`).join(', ')}`);
  // Both polarities must still exist. A refactor that turned every copy into the
  // positive form would otherwise pass the direction check below while silently
  // deleting the distinction it rests on — and the negating form is the one that
  // authorizes reclaims, so it is the half that must never quietly disappear.
  assert.ok(copies.some((c) => answerOnReachable(c) === 'alive'),
    'the "is it alive" form must still exist');
  assert.ok(copies.some((c) => answerOnReachable(c) === 'dead'),
    'the "is it provably dead" form must still exist');
});

test('no copy treats EPERM as evidence of death', () => {
  for (const copy of copies) {
    const at = `${copy.file}:${copy.name}`;
    const answer = answerOnReachable(copy);
    assert.notEqual(answer, null,
      `${at}: a reachable pid must produce a literal true/false, or this copy's polarity cannot be read`);

    if (answer === 'alive') {
      // Alive on success, and alive on EPERM. The catch must key on EPERM and
      // must NOT key on ESRCH: `return code !== 'ESRCH'` would be equivalent
      // today but silently reclassifies every OTHER errno as alive.
      assert.match(copy.body, /===\s*'EPERM'/, `${at}: EPERM must be the catch's positive case`);
      assert.doesNotMatch(copy.body, /'ESRCH'/,
        `${at}: a predicate that answers "alive" for a reachable pid must decide on EPERM, not on ESRCH`);
    } else {
      // The exact dual: dead ONLY on ESRCH, so EPERM (and every other errno)
      // answers "not provably dead" and blocks the reclaim.
      assert.match(copy.body, /===\s*'ESRCH'/, `${at}: only ESRCH may prove death`);
      assert.doesNotMatch(copy.body, /'EPERM'/,
        `${at}: a predicate that answers "not alive" for a reachable pid must not name EPERM — ESRCH alone decides`);
    }
  }
});

// The census above reads source text, so it cannot catch a copy whose text is
// right and whose behaviour is not. This half asks the kernel.
//
// pid 1 is init/launchd: it exists on every POSIX machine for the life of the
// boot, and it is owned by root. Run as an ordinary user, `kill(1, 0)` raises
// EPERM — the exact error the predicates disagree about — and run as root it
// succeeds. Both paths must answer "alive", which is what makes this assertion
// meaningful whoever runs it, while the guard below records which path was
// actually exercised so a root-only CI cannot quietly reduce it to the easy one.
test('a live process owned by another uid reads as alive', () => {
  let observed: string | null = null;
  try {
    process.kill(1, 0);
  } catch (error) {
    observed = (error as NodeJS.ErrnoException).code ?? 'unknown';
  }
  assert.ok(observed === null || observed === 'EPERM',
    `pid 1 must be alive for this to measure anything, got ${observed}`);
  assert.equal(processAlive(1), true,
    observed === 'EPERM'
      ? 'kill(1,0) raised EPERM and the predicate must still call pid 1 alive'
      : 'running as root: kill(1,0) succeeded, so pid 1 is alive by the easy path');
});

test('an absent pid reads as dead, so a genuinely abandoned lease is still reclaimable', () => {
  // Above every platform's pid_max, so it cannot exist and cannot be recycled
  // onto a live process between the probe and the assertion.
  const absent = 0x7FFFFFFF;
  assert.throws(() => process.kill(absent, 0), /ESRCH/, 'the fixture pid must be provably absent');
  assert.equal(processAlive(absent), false);
});

test('a malformed pid is never reported alive and never authorizes a reclaim', () => {
  // 0 and -1 are the dangerous ones: POSIX reads them as "my process group" and
  // "every process I may signal", so a predicate that forwarded them to
  // process.kill would answer "alive" for a lock record carrying no pid at all.
  for (const pid of [0, -1, -12345, 1.5, Number.NaN]) {
    assert.equal(processAlive(pid), false, `pid ${pid} must not read as a live holder`);
  }
});
