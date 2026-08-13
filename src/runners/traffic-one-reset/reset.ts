// src/runners/traffic-one-reset/reset.ts
// The recovery edge out of a wedged run — THE TRANSACTION, and nothing else.
//
// `failed` is the one ledger status with NO outgoing transition
// (runLedgerTransitionAllowed's final `return false`), and no value of
// `authorizedResume` reopens `verified` or `failed` "through any writer in this
// product" (run-settlement/types.ts, SettlementUpdate.authorizedResume — which
// also says plainly that this is a rule the writers keep rather than a property
// of the file, because `settlementHash` is an UNKEYED digest). Nothing below
// depends on the stronger reading: this runner RETIRES the run rather than
// reopening it, so what it needs is that no writer reopens it, not that no
// writer could. So a
// project whose `currentRunId` names a failed run has nothing it can do inside
// that run: no role can bind a claim in it (runLedgerClaimAdmission -> closed),
// no transition reopens it, and the documented escape — `run-status --status
// failed` — is the fastest way to reach exactly this state. Before this runner
// the only way out was `rm -rf .traffic-one/runs/<id>` plus hand-editing
// `.one.json`, which edits the very file every gate trusts.
//
// RETIRE, NOT SETTLE. This runner never writes the failed run's ledger. It
// leaves the terminal record byte-intact and moves the project off it: the
// pointer goes to a fresh planned run, and the retired run's claims are
// released. Settling would mean punching a hole in the immutability invariant
// above for a caller that does not need one — run-settle.ts already establishes
// the alternative as the sanctioned answer, in `runIsEmptyFailedHusk`, which
// replaces an EMPTY failed run for the same reason ("nothing is lost by
// replacing it") and likewise never transitions it. This runner is that same
// move for a failed run that DOES hold artifacts, with an explicit operator
// invocation standing in for the authorization the automatic path cannot have.
// Nothing is destroyed either way: the retired run's dir, digests and evidence
// stay on disk, only the pointer moves.
//
// ── WHY THIS IS ITS OWN MODULE, and must stay one ───────────────────────────
// It holds a `withProjectStateLock` body, so it may not be able to REACH a
// project-root resolver — not call one, reach one. `withProjectStateLock` is
// re-entrant through a process-local `heldLocks` set keyed by the lock PATH
// STRING, and `shared/hook/paths.ts` resolveProjectRoot is spelling-preserving
// BY CONTRACT (it must not canonicalize: shared/retention.ts isLeakedNestedRoot
// deletes a nested `.traffic-one/` when `resolveProjectRoot(dir) !== dir`, so a
// canonicalizing exit would turn every symlinked or `/tmp` project into a
// deletion candidate). A second spelling entering a nested acquisition
// therefore misses the memo, renames onto the lock directory this process
// already owns, gets ENOTEMPTY and spins to the deadline — measured at
// ~1002ms then a throw, against 1ms for the same spelling.
//
// shared/__tests__/path-spelling-contract.test.ts holds that unreachable by
// IMPORT CLOSURE over every module that acquires the lock, which
// over-approximates call reachability so that an empty result is a proof. The
// deviations lane's decision not to canonicalize rests on that proof, so it has
// to keep holding. This module therefore takes a `cwd` and never derives one;
// index.ts beside it resolves the root and calls in.

import * as fs from 'fs';

import { readJsonResult } from '../../shared/fsjson';
// The wedge has two records and this runner refuses on only one of them. The
// sentence naming the other lives with the module that owns it, so the two
// refusals cannot drift into describing different halves of the same state.
// `runSettlementIllegible` comes with it because the sentence is about the OTHER
// record, so that record decides whether it is said — see the refusal site.
import { bothRunRecordsRemedy, readRunSettlementResult, runSettlementIllegible } from '../../shared/run-settlement';
import { withProjectStateLock } from '../../shared/state/project-state-lock';
import {
  ensureRunLedger,
  legacyStatePath,
  patchState,
  readEffectiveState,
  readState,
  releaseRunClaimsResult,
  runIdNow,
  runLedgerStatusRecord,
  stackFingerprint,
  statePath,
} from '../../shared/state';
// The run-directory path builder, imported for the successor-id existence test.
// It is a pure join over the `cwd` this module is HANDED — see the header on why
// this file may not reach a project-root resolver — and `obligations.ts` below
// already puts it in this module's import closure.
import { runDir } from '../../shared/state/run-agent/run-paths';
import { carryRunObligations, type CarryOutcome } from './obligations';
import { readResetRecord, recordReset } from './resets';

export interface ResetResult {
  readonly ok: boolean;
  /** Machine-readable verdict; stable, and the thing tests pin. */
  readonly code: string;
  readonly message: string;
  /** The run this reset was asked about. */
  readonly runId: string;
  /** The successor, present only once the pointer actually moved. */
  readonly freshRunId?: string;
  readonly releasedClaims?: number;
  /** Non-fatal residue: the project is recovered, something downstream was not. */
  readonly warnings: readonly string[];
}

function refusal(runId: string, code: string, message: string): ResetResult {
  return { ok: false, code, message, runId, warnings: [] };
}

/** What the transaction hands back once the pointer has actually moved: the
 *  facts the second phase reports, and nothing it has to re-read. */
interface Committed {
  readonly kind: 'committed';
  readonly fresh: string;
  /** The retired run's terminal status, for the record. */
  readonly status: string;
  /** `.one.json` as it was PUBLISHED and verified inside the hold. The successor
   *  ledger's stack fingerprint is taken from the bytes that actually landed,
   *  and taking it here is what lets that ledger be written outside the hold
   *  without a second read of a file the reset no longer owns. */
  readonly published: ReturnType<typeof readState>;
}

/**
 * Retire `runId` and mint its successor, atomically, under the project state
 * lock.
 *
 * `cwd` is an ALREADY-RESOLVED project root, and the parameter is the module
 * boundary doing its job: every path this function touches is derived from the
 * one spelling its caller resolved, outside the hold. See the header.
 *
 * THE ORDER IS THE CORRECTNESS ARGUMENT, and it is the one triage-directive.ts
 * `beginFreshMaintenanceRun` already documents: publish the new pointer FIRST,
 * then dismantle the outgoing run. Both dismantling steps are only correct
 * because `.one.json` names a different run by the time they run. With the
 * pointer last, a refused write leaves `.one.json` naming a run whose claims
 * have just been released — strictly worse than the wedge this command exists
 * to clear. With the pointer first, the worst intermediate state a crash can
 * leave is "the successor is live and the retired run's claims linger on a run
 * nothing reads as current", which is recovered, not wedged.
 *
 * The ordering is a constraint on the SEQUENCE, not on the hold, which is why
 * both dismantling steps now run in settleReset with the lock released: they
 * still run after a pointer write this function has already verified, and the
 * lock they were holding protected a file neither of them touches.
 *
 * Be precise about WHAT is recovered, because the obvious next sentence is
 * false. The PROJECT is recovered: it names a live run, that run admits claims,
 * and the lingering claims hold nothing current and expire on SUBAGENT_STALE_MS
 * anyway. What does NOT recover the residue is RE-RUNNING THIS COMMAND — the
 * pointer already moved, so a second invocation naming the retired id refuses
 * with `not-current-run`, and one naming the successor refuses with
 * `run-not-failed` (or `ledger-absent`, if even its ledger did not land).
 * Every one of those refusals is correct; none of them sweeps the residue.
 * "Recovered rather than wedged" is a claim about the project, not a claim that
 * a retry finishes the job.
 *
 * So the ONE step that can fail fatally is the pointer write, and it is the
 * step that has not touched anything yet: a refusal there returns with the
 * project byte-identical to how it was found.
 *
 * ── WHY TWO VALIDATIONS RUN BEFORE THE LOCK ─────────────────────────────────
 * Acquiring the project state lock CREATES `.traffic-one/` unconditionally, as
 * its first act, before this body can refuse anything. So the two questions
 * that can be answered without the lock are answered without it: is `runId` a
 * usable argument, and is `cwd` a project at all. Neither reads anything the
 * lock protects — one is a string test, the other an existence test on the two
 * state-file spellings — so hoisting them costs no atomicity, and running them
 * inside the hold cost a directory in every non-project directory the command
 * was ever pointed at. That is not hypothetical: it is how a probe created a
 * `.traffic-one/` in the plugin's own source repository, the one directory this
 * repo forbids outright.
 *
 * The fix belongs on THIS side of the boundary. Making acquisition lazy would
 * be the deeper fix and is not available: `shared/state/project-state-lock.ts`
 * is mid-change in another lane. Refusing before we call it needs nothing from
 * that module and cannot conflict with it.
 *
 * Everything that reads a VALUE stays inside the hold, unchanged.
 */
export function resetRun(cwd: string, runId: string): ResetResult {
  // The documented contract, asserted rather than described. Every path below
  // interpolates `runId` into a refusal message or compares it to a pointer, so
  // a blank or non-string argument produces a sentence about run `undefined`
  // and a comparison that cannot succeed. It is also the argument shape that
  // reaches here when a caller forwards an unparsed flag.
  const target = typeof runId === 'string' ? runId.trim() : '';
  if (!target) {
    return refusal(String(runId ?? ''), 'invalid-run-id',
      'a run id is required: pass the id this project is wedged on, as `--run-id <id>`');
  }
  // Is this a project? Cheap, lock-free, and the check that keeps the command
  // from littering a state directory in a directory that has nothing to do with
  // Traffic One. Both spellings, because `readState` accepts both.
  if (!fs.existsSync(statePath(cwd)) && !fs.existsSync(legacyStatePath(cwd))) {
    return refusal(target, 'not-a-project',
      `${cwd} is not a Traffic One project (no .traffic-one/.one.json) — run this from the project root; `
      + 'nothing was created here');
  }

  // THE LOCK ITSELF CAN THROW, and nothing above the CLI catches. Its retry loop
  // ends at a one-second deadline with `new Error(...)`, so two operator
  // invocations racing each other — or one racing any other `.one.json` writer
  // that holds long enough — produced a stack trace where the loser's own code
  // has a refusal ready. `patchState` refusing is a REFUSAL and reads as one; a
  // lock timeout is the same event one layer down and now reads the same way.
  // THE TRANSACTION: the checks, the pointer write and its verify. Nothing in it
  // waits on a store lease — the three that used to be in here are named and
  // measured in settleReset, which is where they now run.
  let phase: Committed | ResetResult;
  try {
    phase = withProjectStateLock(cwd, (): Committed | ResetResult => {
    // `.one.json`'s LEGIBILITY, before any value is read out of it. `readState`
    // answers absent, torn and unreadable with the same `{}` — fsjson.ts's
    // JsonRead comment names that collapse as the defect it is — so without this
    // probe a project with a damaged state file refuses below with
    // `no-current-run`, "there is no wedged run to reset", while the pointer is
    // sitting in the torn bytes. Wrong anywhere; actively harmful in the one
    // command whose callers are by definition holding a broken project, because
    // it points them away from the only file that needs repair.
    //
    // Nothing is written either way, before or after this probe: `patchState`
    // refuses on both kinds too (a patch is defined against a base, and a base
    // it cannot see leaves nothing honest to publish), which also covers a file
    // that becomes illegible after this line — that lands on
    // `state-write-refused`, still inside this lock hold. So this trades a
    // misleading refusal for a true one and changes nothing else.
    //
    // `absent` deliberately falls through, and the reason is NOT that a legacy
    // path might still resolve — `readState` resolves its legacy spelling from
    // the same directory, and the pre-lock check above already established that
    // one of the two exists, so by here an `absent` primary means the LEGACY
    // file is the live one. That is a project this command should serve, not
    // refuse. Falling through hands it to `readState`, which reads exactly that
    // file, and the checks below then judge it on its merits.
    const read = readJsonResult<unknown>(statePath(cwd));
    if (read.kind === 'corrupt' || read.kind === 'unreadable') {
      return refusal(target, `state-${read.kind}`,
        `.traffic-one/.one.json is ${read.kind} — this project's STATE FILE is what is broken, not its run. `
        + 'Repair or restore it and retry; nothing here was changed');
    }
    // Valid JSON that is not an OBJECT. `readJsonResult` says `ok` for an array,
    // a number or a bare string, and `readState` then hands back `{}` for all
    // three, so without this the project lands on `no-current-run` — "there is
    // no wedged run" — while its pointer may be sitting in element 0 of an
    // array. Which is precisely what a hand edit produces, and hand-edited
    // state is this command's stated target population.
    if (read.kind === 'ok' && (typeof read.value !== 'object' || read.value === null || Array.isArray(read.value))) {
      const shape = Array.isArray(read.value) ? 'a JSON array' : `a JSON ${typeof read.value}`;
      return refusal(target, 'state-not-object',
        `.traffic-one/.one.json is ${shape}, not a JSON object — this project's STATE FILE is what is broken, `
        + 'not its run. Repair or restore it and retry; nothing here was changed');
    }

    // THE POINTER, through the product's own coercion rather than a fresh test.
    // `readEffectiveState` applies `normalizeRuntimeIds`, the same number →
    // string coercion `normalize.ts canonicalizeRunPointer` performs on the
    // write side and that the state writer calls unconditionally BECAUSE the
    // numeric shape reaches disk. Spelling the test as `typeof === 'string'`
    // here — as the raw readers do — meant a project whose pointer is the
    // legacy number and names a genuinely failed run was told "this project has
    // no currentRunId": false, and false in the one command whose whole purpose
    // is to be the route out. There was no other route: every writer that would
    // canonicalise the pointer is one the wedge blocks.
    //
    // Only the POINTER is taken from the canonical view; nothing else in this
    // body changes shape.
    const effective = readEffectiveState(cwd);
    const current = typeof effective.currentRunId === 'string' ? effective.currentRunId.trim() : '';
    if (!current) {
      return refusal(target, 'no-current-run',
        'this project has no currentRunId, so there is no wedged run to reset');
    }
    // Only the CURRENT run. Repointing `currentRunId` is the whole operation,
    // so a request about any other run is asking for something this command
    // does not do — and silently resetting the current run instead would be
    // the worst possible reading of a mistyped id.
    if (current !== target) {
      return refusal(target, 'not-current-run',
        `run ${target} is not this project's current run (currentRunId is ${current})`);
    }
    // `runLedgerStatusRecord` reads through `effectiveLegacyRunStatus`, so a V2
    // run behind the rollback barrier — physically `failed`/`agent-failed` in
    // run.json while canonically active, code-delivered or validating — reads
    // as what it CANONICALLY is and is not reset out from under a live team.
    // Reading raw `status` here would have made the barrier mask look like the
    // wedge it is designed to imitate.
    const ledger = runLedgerStatusRecord(cwd, target);
    if (ledger.legibility !== 'ok') {
      // The two-records paragraph is about the SETTLEMENT, so the settlement
      // decides whether it is printed — the same trigger doctor/findings.ts and
      // run-diagnostic-report.ts already use (`illegible` = anything but `ok`
      // and `absent`), rather than this refusal's own cause. Gating it on the
      // LEDGER instead put it in front of an operator with nothing to repair:
      // `ledger-absent` is the ordinary code for a second reset naming the
      // successor inside the half-carried window, where the successor's ledger
      // is milliseconds from existing and neither record is damaged. It still
      // reaches the case it was written for, which is the one that leaves no
      // trace of itself — a removed `run.json` beside a damaged
      // `settlement-v2.json`, where repairing only the ledger lets the reset
      // succeed and every later settlement write refuse.
      const both = runSettlementIllegible(readRunSettlementResult(cwd, target).kind)
        ? ` ${bothRunRecordsRemedy(target)}`
        : '';
      return refusal(target, `ledger-${ledger.legibility}`,
        `run ${target}'s ledger is ${ledger.legibility} — repair or remove `
        + `.traffic-one/runs/${target}/run.json first; this command resets only a legibly failed run.${both}`);
    }
    if (ledger.status !== 'failed') {
      return refusal(target, 'run-not-failed',
        `run ${target} is '${ledger.status ?? 'planned'}', not the terminal 'failed' this command recovers from. `
        + "A 'blocked' run resumes with `run-status --run-id <id> --status active "
        + "--reason user-authorized-extra-cycle`; a planned/active run is not wedged");
    }

    // Never hand the successor an id that already NAMES SOMETHING. `runIdNow()`
    // is epoch-ms, so a run minted, activated and failed inside this millisecond
    // resolves the fresh ledger to the terminal one — and that same-millisecond
    // case was all this guard used to cover, which is narrower than its own
    // reasoning. A clock set backwards (a case this codebase handles explicitly
    // elsewhere — see shared/clock-skew.ts) re-mints an id whose run directory
    // already exists, so the project would be repointed at a pre-existing,
    // possibly FAILED run: re-wedged by its own recovery, and only warned about
    // by the ledger check below. The existence test is the same expression, and
    // it subsumes the identity test (the retired run's own directory exists).
    // Suffixed rather than re-minted in a spin — a busy-wait on the clock is a
    // worse failure mode than a two-character suffix, which stays inside both
    // safePathSegment's charset and the gate grammar's id shape.
    const stamp = runIdNow();
    const fresh = stamp === target || fs.existsSync(runDir(cwd, stamp)) ? `${stamp}-r` : stamp;
    // And the suffixed spelling can be taken too, by a previous reset inside the
    // same millisecond. Refusing beats repointing at somebody else's run: the
    // project is left exactly as it was found, and the caller retries.
    if (fresh !== stamp && (fresh === target || fs.existsSync(runDir(cwd, fresh)))) {
      return refusal(target, 'successor-id-taken',
        `both candidate successor ids (${stamp}, ${fresh}) already name a run directory — `
        + `retry in a moment; run ${target} is untouched`);
    }

    // The one fatal step, and the first one to touch disk. `patchState` merges
    // under this same (re-entrant) lock hold, so it cannot publish a snapshot
    // taken before the read above; `writeState` alone would have to be handed a
    // whole-object base read outside the lock.
    //
    // `spawnIndex` is cleared with the pointer, and it was WORTH RE-EXAMINING
    // under the carry-forward rule in obligations.ts, because at a glance it
    // looks like a per-role budget being refunded. It is not one, and the
    // reason is the DIRECTION rather than the absence of a threshold: there IS
    // a comparison against a constant (session-start-setup.ts's `spawnIndex > 1`
    // selects the slim fix-cycle bundle), reached indirectly, but nothing about
    // it caps a spawn. A HIGHER index buys LESS context, because the second
    // spawn of a role is assumed to be a fix cycle. So carrying it forward
    // would hand the recovered project's first, genuinely-new child the
    // abbreviated bundle meant for a retry — a regression, not a conserved
    // bound. It is cleared for the reason beginFreshMaintenanceRun clears it:
    // it counts role spawns within one run and means nothing in the next.
    if (!patchState(cwd, { currentRunId: fresh, spawnIndex: {} })) {
      return refusal(target, 'state-write-refused',
        'the project state write was refused (unanswered use-plugin consent, or a planted '
        + `.traffic-one/.one.json) — run ${target} is untouched`);
    }
    // Write-then-verify: `patchState` reports the fence's answer, not the
    // file's. A `true` over a pointer that did not land would send the two
    // dismantling steps below at a run that is still current.
    //
    // PINNED — __tests__/reset.test.ts "a pointer write the fence approved but
    // the FILE never took". It was the last check here with no test, and a
    // mutant deleting it survived a whole campaign, which says nothing about the
    // check and everything about the fixtures: the disagreement it watches for
    // needs a write that the fence approves and the filesystem does not publish,
    // and no ordinary fixture produces one. That test swallows exactly the
    // publishing rename of exactly this file, once, and asserts the claim
    // release never runs.
    const published = readState(cwd);
    if ((typeof published.currentRunId === 'string' ? published.currentRunId.trim() : '') !== fresh) {
      return refusal(target, 'state-write-unverified',
        `the project state reported a successful write but .one.json does not name ${fresh} — `
        + `run ${target} is untouched`);
    }

    // AND THAT IS THE WHOLE TRANSACTION. Everything after the verified pointer
    // write — the successor's ledger, the claim release, the obligation carry,
    // the record — is dismantling or publishing that only needs `.one.json` to
    // already name a different run, which it now does. Three of those steps take
    // a store lease, so keeping them here put a contended store on the critical
    // path of every hook. See settleReset.
    return {
      kind: 'committed',
      fresh,
      status: ledger.status ?? 'failed',
      published,
    };
  });
  } catch (error) {
    // THE LOCK ITSELF CAN THROW, and nothing above the CLI catches. Its retry
    // loop ends at a one-second deadline with `new Error(...)`, so two operator
    // invocations racing each other — or one racing any other `.one.json` writer
    // that holds long enough — produced a stack trace where the loser's own code
    // has a refusal ready. `patchState` refusing is a REFUSAL and reads as one; a
    // lock timeout is the same event one layer down and now reads the same way.
    // Reached before anything is written, so the project is as it was found.
    return refusal(target, 'state-lock-unavailable',
      `the project state lock could not be taken (${errorText(error)}) — another Traffic One process is `
      + `holding it; retry in a moment. Run ${target} is untouched`);
  }
  if (!('kind' in phase)) return phase;
  return settleReset(cwd, target, phase);
}

/**
 * Everything after the pointer has moved, and it runs with NO LOCK HELD.
 *
 * ── WHY NONE OF THIS IS IN THE TRANSACTION ──────────────────────────────────
 * Every step below waits on a store lease, and they all used to wait on them
 * inside the project state lock. That lock's contenders time out after ONE
 * SECOND and their timeout path THROWS — the same `.one.json` transaction that
 * every hook needs, failing closed and leaking a deny out of a hook, which
 * project-state-lock.ts's own retry loop names as the outcome it is written to
 * avoid. Its staleness reclaim cannot shorten the hold either, because reclaim
 * requires the owner to be provably dead and the reset process is alive.
 *
 * MEASURED, with a second real process holding one store lease: the carry took
 * 8.8s with the project lock held throughout, and three independently-contended
 * stores gave ~24s by construction. Every hook wanting the state file inside
 * that window failed after one second.
 *
 * The cost was never this command's own latency — it is a one-shot operator
 * command in its own subprocess and nothing bounds it — it was the cost paid by
 * EVERY OTHER PROCESS. So the fix is about the hold, not the budget.
 *
 * ── AND THE FIRST VERSION OF THAT FIX WAS ONLY HALF OF IT ───────────────────
 * Moving the carry out left the successor ledger and the claim release inside,
 * and this docblock then claimed of the remaining hold that "nothing in that set
 * waits on a store lease, so contention cannot lengthen it". FALSE BY
 * CONSTRUCTION, at three leases: `ensureRunLedger` takes `.run-ledger.lock`, and
 * `releaseRunClaimsResult` takes `.agent-claims.lock` and `.claims.lock`, each
 * with its own 2s acquire budget. REPRODUCED: with a live process holding one of
 * them the hold went to 2,255–2,381ms, holding both claim leases 4,231ms, all
 * three 6,144ms — and a concurrent `.one.json` transaction, which is what every
 * hook needs, THREW at ~1,015ms in every one of those rows. That is precisely
 * the harm the move was made to eliminate, shortened from 8.8s to 4s rather than
 * removed. The table below is the same harness run against both boundaries.
 *
 * So the boundary moved to where the sentence is true. THE TRANSACTION IS NOW
 * THE POINTER WRITE AND ITS VERIFY, and nothing else: two `.one.json` operations
 * under the `.one.json` lock, with no store lease reachable from either.
 *
 * RE-MEASURED, both boundaries, on one fixture and one harness: a live process
 * holding each named lease, a second process polling the lock DIRECTORY at 1ms,
 * the hold self-timed from inside the body, and an ordinary `.one.json`
 * transaction released from inside the hold so it is guaranteed to overlap it.
 * The two observers agree to within ~20ms on every row.
 *
 *   held lease(s)          hold BEFORE   hold AFTER   concurrent `.one.json` txn
 *   none                       628ms        146ms     ok / ok
 *   .run-ledger.lock         2,381ms        136ms     THREW at 1,017ms / ok
 *   .agent-claims.lock       2,280ms        147ms     THREW at 1,011ms / ok
 *   .claims.lock             2,255ms        132ms     THREW at 1,019ms / ok
 *   both claim leases        4,231ms        146ms     THREW at 1,016ms / ok
 *   all three                6,144ms        156ms     THREW at 1,013ms / ok
 *
 * The AFTER column is flat in the contention, which is the property the sentence
 * claims, and the last column is why it matters: every contended BEFORE row
 * killed a concurrent `.one.json` transaction at its own one-second deadline —
 * that is a hook failing closed — and no AFTER row does (163–199ms, all
 * completing).
 *
 * The shipped command corroborates the reconstruction rather than being assumed
 * to match it: driven end to end with the same holders and the poller reporting
 * the longest CONTIGUOUS hold, `resetRun` peaks at 148ms / 231ms / 190ms with
 * nothing, one and both claim leases held, and no concurrent transaction ever
 * throws. (Longest-contiguous, not first-to-last sighting: the command takes
 * this lock several times, and a span reads 4,342ms of "held" over a run in
 * which nothing ever waited longer than 280ms.)
 *
 * `ensureRunLedger`'s 2s BUDGET STILL NEEDS NO REDUCTION, which was the open
 * question — but NOT for the reason recorded here until round 8, which was
 * simply false. It said the call "is no longer on any hook's critical path" and
 * that "nothing waits on it but this command's own settlement". Five product
 * callers wait on it and all five are hook paths: `claim-thread-role.ts:239`,
 * `context-resolve.ts:500`, `run-paths.ts:166` (the spawn gate),
 * `triage-directive.ts:120` and `:184`. A contended mint can stall any of them
 * for up to 2s, exactly as it could before this boundary moved.
 *
 * What actually changed is narrower and is all this boundary can claim: that
 * wait is no longer serialized behind the `.one.json` lock. Inside the hold it
 * was additive to a lease every hook needs and killed concurrent transactions at
 * their own 1s deadline (the table above); outside it, the same 2s is paid by
 * this command's own settlement, which is bounded and was asked for by an
 * operator — the whole command runs 4.4s with both claim leases held while every
 * hook around it keeps transacting.
 *
 * So the conclusion survives, on the five callers rather than on their absence:
 * shortening the budget would make a contended ledger mint fail more often at
 * every one of them, trading a reliable mint for latency at five call sites this
 * boundary does not touch. That trade is ledger.ts's to make on its own
 * evidence. It is no longer a question this file's lock hold forces.
 *
 * ── WHAT MOVING THEM OUT COSTS, AND WHY IT IS NOTHING ───────────────────────
 * The project lock protects `.one.json` and nothing else (its file header says
 * so), so it never served the two dismantling steps in the first place. The
 * ordering constraint they DO have is satisfied: publish the pointer first, then
 * dismantle, and the pointer is published and verified before this function is
 * entered.
 *
 * THE ARGUMENT IS NOT "EVERY STORE HAS ITS OWN LEASE", which is what this
 * docblock used to say and is false: FIVE of the eight carried rows take no
 * lease at all — `debug/deny-repeats.json`, `agent-activity`,
 * `agent-activity-denies`, `scan-bound.json` and `model-choice-prompted` are
 * plain read-merge-write against files with no lock path anywhere in the
 * product. The conclusion survives on a different argument, and it is the only
 * one that was ever doing the work: NONE of those five is serialized by the
 * project state lock on its PRODUCT side either. Their in-product writers —
 * `recordDenyRepeat`, `bumpRunAgentActivity`, the marker writers — take no lock
 * and never have, so a carry that holds the project lock excludes exactly none
 * of them and one that does not excludes exactly none of them. Moving them out
 * regresses nothing because the hold was buying nothing. What that leaves is a
 * real lossiness for those five, which is obligations.ts's problem and is
 * settled there per row, not this boundary's.
 *
 * The one thing the hold excluded — a second concurrent reset — is excluded
 * without it, because the pointer already names the successor: an invocation
 * naming the retired id refuses `not-current-run`, and one naming the successor
 * refuses `run-not-failed` once its ledger exists or `ledger-absent` while it
 * does not — the code depends only on how far this function got, and both are
 * refusals that leave the pointer where it is. Pinned AS THE SAFETY OF THE
 * WINDOW below, on a window reached through the shipped command, by
 * `a second reset arriving in the half-carried window can see it but cannot act
 * on it` (__tests__/reset.test.ts); it was a code read until round 7.
 *
 * ── THE WINDOW THIS OPENS, WHICH IS REAL AND IS THE PRICE ───────────────────
 * Between the pointer write and the last carried row there is a period — up to
 * the carry's own 12.5s bound, plus the ledger's 2s and the claim release's two
 * 2s — in which `.one.json` names the successor and the successor does not yet
 * hold everything the retired run held. A reader in that window sees a strictly
 * MORE PERMISSIVE state than the one that settles: a deny ladder reading 1 where
 * it will read 5, a successor that admits a claim its ledger has not opened yet.
 *
 * It is never a CONTRADICTORY one, and that is the property worth stating
 * because it is what makes the window survivable rather than merely brief: every
 * row is published by its own atomic write (fsjson's stage-and-rename), so
 * half-carried is reachable and torn-within-a-row is not. No reader ever sees a
 * ladder count that never existed, a registry row that was never recorded, or a
 * partial exhaustion ledger.
 *
 * Nothing can ACT on the window either. A second reset can observe it, and the
 * two refusals above are what stop it doing anything with it. What the window
 * costs is bounded by what a gate would have denied in it, and every carried row
 * is a bound whose absence permits — never a permission whose absence denies.
 *
 * ── THE CARRY'S OWN BUDGET, unchanged and now the only long step ────────────
 * ONE shared 8s lease budget, plus the single inner acquire each remaining store
 * is still entitled to once the budget has lapsed (2s registry + 2s spawns +
 * 0.5s exhaustion) — 12.5s, and measured 12.54s with all three stores held by
 * live processes, 8.11s with one held (where the other two carried normally).
 * `.resets.json` has one writer — `recordReset`, below — and takes no lease at
 * all, for the same reason this whole phase is out here. That is now true
 * rather than intended: the discharge half briefly made a hook the second
 * lease-free writer of the same file, and it is a fold in `resetObligationFor`
 * instead (resets.ts ResetObligation has the lost-update measurement).
 */
function settleReset(cwd: string, target: string, committed: Committed): ResetResult {
  const { fresh } = committed;
  const warnings: string[] = [];

  // The successor's ledger. Best-effort by design: an ABSENT ledger reads as
  // `planned` and admits claims (runLedgerClaimAdmission), so the next claim
  // mint creates it and the project is usable either way — but a caller is
  // told, because "usable" and "as intended" are different sentences. That
  // tolerance is also what lets it run out here: the window in which the
  // successor is current with no ledger of its own is a window the product
  // already has to be correct in, because a hook can read the new pointer the
  // instant it lands whether or not this process still holds the lock.
  const successor = ensureRunLedger(cwd, fresh, {
    status: 'planned',
    kind: 'run-reset',
    stackFingerprint: stackFingerprint(committed.published),
    supersedes: target,
  });
  if (!successor || successor.status !== 'planned') {
    warnings.push(`the successor run ${fresh} has no 'planned' ledger yet; the first spawn will open one`);
  }

  // Everything the retired run still holds. `releaseRunClaimsResult` is the
  // existing whole-run primitive (pending claims deleted, claim files marked
  // released, the per-file fallback locks under runs/<id>/claims swept) and is
  // exactly what run-status runs on its own `failed` path — there is no second
  // claim-release path here.
  const released = releaseRunClaimsResult(cwd, target, 'run-reset');
  if (released.outcome === 'unavailable') {
    // Non-fatal on purpose: the pointer has already moved, so these claims are
    // held on a run nothing resolves as current, and they expire on
    // SUBAGENT_STALE_MS regardless.
    warnings.push(`the retired run's claims were not released (${released.reason}); `
      + 'they hold nothing current and expire on their own');
  }

  // THE OBLIGATIONS THE POINTER MOVE WOULD OTHERWISE LAUNDER.
  //
  // Every gate obligation in this product is keyed by run id, so moving the
  // pointer does not reset that state, it makes it UNREACHABLE — and the
  // successor starts clean. Measured before this call existed: a deny-repeat
  // ladder standing at 5, two past the threshold that produces the
  // "stop retrying and report BLOCKED" instruction, read 1 on the successor.
  // Reaching terminal `failed` is something an agent can do on its own (an
  // OpenCode delegation that fails terminally with fallback disallowed writes
  // it, and the settlement reconciler adopts it at the next prompt boundary),
  // so that was a clean, unlogged escape from an escalated ladder.
  //
  // obligations.ts classifies every `runs/<id>/` entry and carries only the
  // bounds whose carry cannot deny the successor anything the retired run was
  // not already denied. Deliberately AFTER the pointer move and non-fatal: a
  // failure here leaves a recovered project missing part of an obligation,
  // where hoisting it above the pointer would risk leaving a project pointed
  // at a run whose claims are about to be released. That trade is the same
  // one the claim release makes, for the same reason.
  //
  // The record is READ here, and that is the loop's only bound. It was
  // write-only: nothing in `src/**` consulted it, so the dropped bucket
  // refreshed at full value on every cycle without limit. `priorResets` is
  // the count as it stands BEFORE this reset is appended, so the reset being
  // performed is the (count + 1)-th, and at WIDEN_AT the carry widens.
  const priorResets = readResetRecord(cwd).count;
  // THE OUTER BOUNDARY, and it is the belt to obligations.ts's per-row braces.
  // Every row there is individually guarded and lands in `failed`, so a throw
  // reaching here means the carry could not even be entered — and the one thing
  // that must still happen is the record below. Without a boundary anywhere the
  // exception propagated out of the CLI as a stack trace, and the widening ladder
  // — the entire answer to "repeated resets buy budget" — was BYPASSED for every
  // reset that reached the throwing path, because the reset was never recorded.
  let carried: CarryOutcome = { carried: [], failed: [], widened: [], obligation: { terminalRoles: [] } };
  try {
    carried = carryRunObligations(cwd, target, fresh, { priorResets });
  } catch (error) {
    warnings.push(`the obligation carry could not run (${errorText(error)}); every carried bound `
      + `restarts in ${fresh}, and this reset is still counted`);
  }
  if (carried.failed.length > 0) {
    warnings.push(`these gate obligations did not carry to ${fresh}: ${carried.failed.join(', ')}; `
      + 'the recovered project is usable but those bounds restart');
  }
  // Not a warning: the widening is the intended behaviour of a repeated
  // reset, and a caller that has just been given a stricter successor should
  // be told which bound followed it rather than discovering it at the next
  // spawn deny.
  if (carried.widened.length > 0) {
    warnings.push(`this project has reset ${priorResets + 1} times, so the successor inherits `
      + `(${carried.widened.join(', ')}): recovery still succeeded, and clearing a terminal model exhaustion `
      + 'now needs your enable/retry answer');
  }

  // THE VISIBLE HALF — and, since the carry above reads `priorResets` off it,
  // the half that also BOUNDS the loop. One reset is conserving for the bounds
  // that can be carried; several bounds are legitimately dropped (see
  // obligations.ts), so repeated resets stayed a way to buy budget until this
  // record stopped being write-only. The append is here, after the carry that
  // consulted it, so a reset is counted only once it has actually happened.
  //
  // COUNTED EVEN WHEN THE CARRY FAILED, deliberately, and the asymmetry is worth
  // naming rather than fixing: such a reset spends a widening step and delivers
  // none of the conservation that step is priced against. Making the count
  // conditional on a clean carry would be strictly worse — holding a store lease,
  // or planting one file at the successor's run path, would then buy an
  // uncounted reset, and unlimited uncounted resets are exactly the laundering
  // the ladder exists to price. The rows that did not carry are named in the
  // warnings above, which is the honest report of the trade.
  //
  // AND THIS CALL NOW CARRIES THE PRICE AS WELL AS THE COUNT. The widening used
  // to be an extra carry into `exhausted-models.json`, so the one capability
  // that drops that bound — holding its lease — also suppressed the price
  // (measured: six cycles, zero widenings, against a control widening from
  // cycle 3). `carried.obligation` is computed from unlocked reads and is
  // written here, by the same one-writer, lease-free call that counts the
  // reset. A carry that failed completely still pays.
  let recorded = false;
  try {
    recorded = recordReset(cwd, {
      at: new Date().toISOString(),
      from: target,
      to: fresh,
      status: committed.status,
      carried: carried.carried,
    }, carried.obligation);
  } catch (error) {
    warnings.push(`the reset record could not be written (${errorText(error)})`);
  }
  if (!recorded) {
    warnings.push('this reset was not added to .traffic-one/runs/.resets.json; the recovery itself is complete');
  }

  return {
    ok: true,
    code: 'reset',
    message: `retired failed run ${target} and minted ${fresh}`,
    runId: target,
    freshRunId: fresh,
    releasedClaims: released.value ?? 0,
    warnings,
  };
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300) || 'unknown error';
}
