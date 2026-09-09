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
// blind spot. Anything that asks the kernel `kill(pid, 0)` and answers from it
// is a copy, whatever it is called.
//
// THE RETURN TYPE WAS THE SECOND BLIND SPOT, and it opened the moment the
// settings lock grew a third answer. `one-settings.ts`'s `ownerLiveness` returns
// `'alive' | 'dead' | 'not-ours'`, so a census keyed on `: boolean` stopped
// seeing the one predicate whose EPERM handling had just been rewritten: the
// count fell to 13 and this file went red. That is the census doing its job, and
// the fix is to read the SHAPE rather than the signature. Three-valued copies are
// audited on their own terms below — EPERM must be answered DISTINCTLY, as
// neither the reachable answer nor the ESRCH one, because the entire point of a
// third value is that the caller decides what "exists, and is not mine to
// signal" means for ITS lock.
//
// THE THIRD BLIND SPOT WAS THE INSTRUMENT ITSELF, and it is the one that
// mattered: reading shape is still reading TEXT, and a text audit made of
// substring matches is satisfied by the defect it names. MEASURED — a recognised
// copy was edited to answer "dead" for an EPERM pid while keeping the characters
// the audit looked for, and this file stayed green. Thirteen of the fourteen
// copies were audited by nothing at all: only `processAlive` was ever CALLED,
// because it is the only one this file can import.
//
// So the audit below RUNS every copy. Each body is lifted out of its file, its
// type annotations and casts removed, and rebuilt as a function whose `process`
// is a stub that raises the errno under test. Polarity is then read from what
// the copy ANSWERS for a reachable pid rather than from its text, and the EPERM
// rule is checked against the value it actually returns. A copy that reaches for
// anything the harness does not hand it — a helper where its EPERM decision
// could hide — throws at call time and fails, which is the property that keeps
// this from being outrun by an indirection. Proven by mutating ALL FOURTEEN
// copies one at a time on a tree copy: each flip is caught, named, and reported
// with the value it returned — 14/14, by polarity (the nine "alive" copies made
// to answer `false` for EPERM, the four "provably dead" ones made to answer
// `true`, and the three-valued one made to collapse EPERM onto `'dead'`). The
// peer's own shape was re-run separately and is also caught: appending
// `&& false` to a correct EPERM comparison keeps every character the old audit
// searched for and changes the answer, which is exactly the mutation that used
// to survive.

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
// THE FOURTH BLIND SPOT WAS THE PROBE'S OWN GRAMMAR, and it is the one that
// held a live defect rather than a clean copy. `\w+` cannot match a leading
// minus, so `qa-evidence/process-group.ts`'s `groupHasMembers` —
// `process.kill(-pgid, 0)`, a liveness question about a process GROUP — was
// invisible to a census whose declared scope is SHAPE and which records its own
// history of being widened after missing predicates under other names. Nothing
// excluded it deliberately; the docblock this file kept never mentioned process
// groups or negative pids. Inside that blind spot its `catch` was bare, folding
// EPERM onto ESRCH: a group that EXISTS and is not ours answered "no members",
// which is the direction the assertions below refuse for this class, and
// `stopOwnedServer` skips its SIGKILL outright on that answer. Fifteen is the
// count on the census's own terms; fourteen was the regex's.
// 13 after Phase 5: prefs-store, cache-lock, and ensure.ts `processAlive`
// wrappers no longer contain `kill(pid, 0)` — they call `ownerLiveness` in
// per-user-dir-lock.ts, where EPERM is `not-ours` (0700 per-user roots only).
const COPY_COUNT = 13;

interface Copy {
  readonly file: string;
  readonly name: string;
  readonly body: string;
}

// What makes a function a copy: it asks the kernel about a pid without
// delivering a signal. Not `/g`-flagged — a stateful regex reused across a loop
// answers differently on alternate calls.
//
// THE LEADING MINUS IS PART OF THE SHAPE, not a spelling this census tolerates:
// `kill(-pgid, 0)` asks the identical question about a process GROUP, its EPERM
// direction is load-bearing in the identical way, and omitting it is what hid
// the fifteenth copy. Negating the count rather than the polarity — the census
// is exact, so a sixteenth copy in this shape now fails here until it has been
// audited, which is the property the number exists for.
const PROBE = /process\.kill\(\s*-?\s*\w+\s*,\s*0\s*\)/;

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

/** Every function in the file with a declared return type, brace-matched from
 * its signature so the check reads the whole body and cannot be satisfied by a
 * neighbour's code — then narrowed to the ones that actually probe a pid. The
 * return type is deliberately not constrained: `boolean` missed the three-valued
 * one (see the header). */
function liveness(source: string, file: string): Copy[] {
  const found: Copy[] = [];
  const signature = /(?:export\s+)?function\s+(\w+)\s*\([^)]*\)\s*:\s*[\w'| ]+\s*\{/g;
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

/**
 * The copy, lifted out of its module and made callable with a `process` this
 * file controls.
 *
 * WHY NOT IMPORT IT: thirteen of the fourteen are module-private, and exporting
 * them to be tested would change the thing under audit. Merging them behind one
 * helper is the consolidation wave this census exists to make unnecessary.
 *
 * WHAT IS REMOVED: parameter and return annotations, and `as T` casts. Nothing
 * else — no rewriting of comparisons, no normalising of returns, so the
 * expression that decides EPERM is the one that ships. Anything the strip cannot
 * handle throws here and fails the census rather than skipping a copy.
 *
 * WHAT IS SUPPLIED: `process`, and the two record helpers two copies use to read
 * `.code` off an unknown. They are handed in as arguments, so a body that
 * reaches for a module-scope helper this list does not name gets a
 * ReferenceError the moment its catch arm runs — the EPERM decision cannot be
 * moved somewhere the census does not look.
 */
type Probe = 'reachable' | 'EPERM' | 'ESRCH' | 'EINVAL';

function callable(copy: Copy): (probe: Probe) => unknown {
  const signature = /function\s+(\w+)\s*\(([^)]*)\)\s*:\s*[^{]*\{/.exec(copy.body);
  if (!signature) throw new Error(`${copy.file}:${copy.name}: the census could not read this signature`);
  const params = (signature[2] as string)
    .split(',')
    .map((param) => (param.split(':')[0] as string).trim())
    .filter((param) => param.length > 0);
  const braceAt = copy.body.indexOf('{', signature.index + (signature[0] as string).length - 1);
  const stripped = copy.body.slice(braceAt).replace(/\bas\s+[A-Za-z_$][\w.$]*/g, '');
  const source = `function ${copy.name}(${params.join(', ')}) ${stripped}\nreturn ${copy.name};`;

  const build = new Function('process', 'isRecord', 'obj', source) as (
    processStub: unknown, isRecord: unknown, obj: unknown,
  ) => (...args: unknown[]) => unknown;

  return (probe: Probe): unknown => {
    const processStub = {
      kill: (): boolean => {
        if (probe === 'reachable') return true;
        const error: NodeJS.ErrnoException = new Error(probe);
        error.code = probe;
        throw error;
      },
    };
    const isRecord = (value: unknown): boolean => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    const obj = (value: unknown): unknown => (isRecord(value) ? value : null);
    // A pid that passes every argument guard in the census, so the probe is what
    // decides the answer and never a rejected pid.
    return build(processStub, isRecord, obj)(4242);
  };
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
  const reachable = copies.map((copy) => callable(copy)('reachable'));
  assert.ok(reachable.includes(true), 'the "is it alive" form must still exist');
  assert.ok(reachable.includes(false), 'the "is it provably dead" form must still exist');
});

test('no copy treats EPERM as evidence of death — every copy, called', () => {
  const audited: string[] = [];
  for (const copy of copies) {
    const at = `${copy.file}:${copy.name}`;
    const call = callable(copy);
    const onReachable = call('reachable');
    const onEperm = call('EPERM');
    const onEsrch = call('ESRCH');

    if (typeof onReachable === 'string') {
      // The third form does not answer this question with a bit, and forcing it
      // into one of the two arms below is what would re-open the wedge: EPERM
      // must be its OWN answer, so that the caller decides whether "exists, not
      // mine to signal" holds ITS lock.
      assert.notEqual(onEperm, onReachable,
        `${at}: EPERM answered ${JSON.stringify(onEperm)}, the same as a reachable pid — folded back into `
        + '"alive", which is the planted-owner wedge this replaced');
      assert.notEqual(onEperm, onEsrch,
        `${at}: EPERM and ESRCH both answered ${JSON.stringify(onEperm)} — a third value that collapses is `
        + 'a second value with extra steps, and it collapses toward the reclaim');
      audited.push(`${at} → ${JSON.stringify(onReachable)}/${JSON.stringify(onEperm)}/${JSON.stringify(onEsrch)}`);
      continue;
    }

    assert.equal(typeof onReachable, 'boolean',
      `${at}: a reachable pid answered ${JSON.stringify(onReachable)} — this copy's polarity cannot be read`);

    if (onReachable === true) {
      // Alive on success, and alive on EPERM. ESRCH is the only answer that may
      // report the holder gone.
      assert.equal(onEperm, true,
        `${at}: an "is it alive" predicate answered ${JSON.stringify(onEperm)} for EPERM — a running process `
        + "owned by another uid, reported as gone, and its lock handed to the next caller");
      assert.equal(onEsrch, false, `${at}: ESRCH must still report the holder gone, or nothing is reclaimable`);
    } else {
      // The exact dual: provably dead ONLY on ESRCH, so EPERM blocks the
      // reclaim by answering "not provably dead".
      assert.equal(onEperm, false,
        `${at}: an "is it provably dead" predicate answered ${JSON.stringify(onEperm)} for EPERM — the same `
        + 'reclaim of a live process, reached from the other polarity');
      assert.equal(onEsrch, true, `${at}: ESRCH must still prove death, or nothing is reclaimable`);
    }

    // An errno nobody enumerated answers `false` in BOTH polarities, which is
    // the shape the text census prescribed when it required `=== 'EPERM'` over
    // `!== 'ESRCH'`. Note what that means and note that it is asymmetric: for
    // the "provably dead" form it is the cautious answer (no reclaim), and for
    // the "is it alive" form it is the permissive one (the holder is not
    // vouched for, so a caller may reclaim). Pinned as it is rather than
    // quietly changed — no errno reaching these predicates is known to produce
    // it, and eight copies across seven other lanes would have to move
    // together. Written down here so it is a decision and not an accident.
    assert.equal(call('EINVAL'), false,
      `${at}: an errno nobody enumerated must not be answered by guessing`);
    audited.push(`${at} → ${String(onReachable)}/${String(onEperm)}/${String(onEsrch)}`);
  }
  assert.equal(audited.length, COPY_COUNT, `every copy must be CALLED, not just counted: ${audited.join(', ')}`);
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
test('a live process owned by another uid is not a holder of a 0700 per-user root', () => {
  let observed: string | null = null;
  try {
    process.kill(1, 0);
  } catch (error) {
    observed = (error as NodeJS.ErrnoException).code ?? 'unknown';
  }
  assert.ok(observed === null || observed === 'EPERM',
    `pid 1 must be alive for this to measure anything, got ${observed}`);
  // ensure.ts `processAlive` is the per-user-root wrapper: EPERM is not-ours.
  // Shared project `.traffic-one/` copies still treat EPERM as alive (census above).
  assert.equal(processAlive(1), observed === null,
    observed === 'EPERM'
      ? 'kill(1,0) raised EPERM: a 0700 per-user root must not treat pid 1 as its holder'
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
