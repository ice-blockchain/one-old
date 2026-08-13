// src/runners/traffic-one-reset/resets.ts
// A PROJECT-LEVEL RECORD OF EVERY RESET, AND THE ARGUMENT FOR A RECORD RATHER
// THAN A CAP.
//
// obligations.ts makes ONE reset conserving for the bounds that can be carried
// without re-wedging. It cannot make TEN resets conserving, and no carry rule
// can: several bounds are dropped precisely BECAUSE carrying them would deny a
// recovered project its first spawn (the live-agent registry, the exhausted-
// model terminal marker, the frozen model policy). Each of those is a real
// budget, and each reset legitimately refreshes it. So repeated resets remain a
// way to buy budget, and the answer has to sit outside the per-run state that
// the reset moves away from.
//
// This is that outside. It is deliberately a RECORD and not a CAP — and, since
// obligations.ts now reads it, a record that BITES:
//
//   A cap on resets is a wedge with a counter on it. This command exists
//   because a project reached a state no in-product action could leave; the
//   population it serves is, by construction, projects where every other route
//   out is already blocked. A cap says "you may recover four times", and the
//   fifth genuine crash — a machine losing power mid-write, which is the
//   residue case this runner already handles — is unrecoverable forever, with
//   no route back because clearing the counter is itself the blocked action.
//   That trades a laundering vector for a permanent brick, and a permanent
//   brick is the worse outcome.
//
//   A record costs nothing and makes the behaviour legible. Resetting five
//   times in an hour is visible to the operator, visible to the reviewer, and
//   visible to any future gate that wants to read it. The abuse pattern the
//   laundering enables — reach `failed`, reset, retry the thing the ladder was
//   telling you to stop retrying — is not silent any more.
//
//   Legible was not enough on its own, and this file used to stop there: it was
//   WRITE-ONLY, nothing in `src/**` read it, so the dropped bucket refreshed at
//   full value on every cycle with no limit at all. `obligations.ts` reads
//   `count` and widens at WIDEN_AT resets. That is still not a cap — every
//   reset succeeds, at every count, and the successor always admits claims and
//   spawns — it just stops being free: the third recovery hands the successor a
//   bound the first two forgave, whose route out is an answer the product
//   already asks the user for.
//
//   AND THE WIDENING IS NOW RECORDED HERE TOO, not just triggered from here.
//   See `ResetObligation`: a price paid into the store the actor is defeating
//   is defeated by the same capability, so it is paid into this file instead —
//   the one with a single writer and no lease. `recordReset` is that writer,
//   and it is the only one: the discharge half is a READ, not a second write.
//   See `resetObligationFor`, which is where that stopped being a hope.
//
// It lives beside the runs rather than inside one, because a record kept under
// the run being retired is a record the next reset walks away from — the exact
// defect it exists to close. Being a FILE is what keeps it out of the run-id
// namespace, and that is checked rather than assumed: retention.ts enumerates
// `runs/` through a helper that filters `entry.isDirectory()`, so a file there
// is never a candidate run id for any sweep. The dotted name is only a reader's
// hint. A test pins the retention behaviour, because that module is not this
// lane's to keep honest.

import * as path from 'path';

import { readModelChoice } from '../../modules/agent-model/model-choice';
import { obj } from '../../shared/obj';
import { readJson, writeJson } from '../../shared/fsjson';
import { runLedgerFile, runsRoot } from '../../shared/state/run-agent/run-paths';

export const RESETS_FILE = '.resets.json';
/** Bounded so the file cannot grow without limit on a project that resets
 *  often; the count is never truncated, only the per-event detail. */
export const RESET_HISTORY_LIMIT = 50;

export interface ResetEvent {
  readonly at: string;
  readonly from: string;
  readonly to: string;
  /** The retired run's terminal status, so the record shows WHY, not just that. */
  readonly status: string;
  /** Obligation entries carried to the successor, for audit. */
  readonly carried: readonly string[];
}

/**
 * What a successor OWES because the reset that minted it was at or past
 * WIDEN_AT — recorded here rather than inside the store the obligation applies
 * to.
 *
 * ── WHY THE PRICE MOVED HERE ────────────────────────────────────────────────
 * The widening used to be an extra carry INTO `exhausted-models.json`: at
 * WIDEN_AT the carry copied the retired run's `roles[*].terminal` marker into
 * the successor's copy of that same file. So the price rode on the very store
 * the actor is defeating, and one capability bought both halves. MEASURED over
 * six consecutive reset cycles with a live process holding the successor's
 * `exhausted-models.json.lock` on each one: `widened: []` every cycle,
 * `exhausted-models.json` in `failed` every cycle, the terminal marker never
 * reaching a successor — while the identical control widened from cycle 3
 * onward. Under contention it was not a price at all; it was a conditional
 * benefit.
 *
 * This file has ONE writer (`recordReset`, from the operator's own one-shot
 * command, after the transaction), takes no lease, and is never read-modify-
 * written by a hook. Defeating the obligation therefore takes a capability that
 * is strictly greater than the one that drops the bound: holding a lock still
 * fails the carry, and the price lands anyway.
 *
 * ── THAT SENTENCE WAS FALSE FOR ONE ROUND, AND THIS IS WHAT MAKES IT TRUE ───
 * When the price first moved here the discharge moved with it, as a second
 * function that read this record, deleted one key and wrote the whole file
 * back — reached from `clearExhaustedModels` <- `recordPendingModelChoiceReply`
 * <- `modelChoiceReplySweep`, a REGISTERED HOOK HANDLER. So the file had two
 * lease-free read-modify-writers, one of them a hook, and the sentence above
 * described the code nobody had written yet. MEASURED with two real processes
 * running the shipped functions, 300 attempted increments: 300 returned `true`,
 * 228/242/228 were on disk. Every lost increment rolls the ladder BACKWARDS
 * toward free resets — the exact laundering this record exists to price — and
 * the caller is told it landed.
 *
 * RE-DERIVED once the shipped second writer was gone, so the shape had to be
 * reconstructed rather than called: the same lease-free read-modify-write of the
 * whole record in a second process, with its return-if-absent guard dropped so
 * every iteration writes. 300 attempted increments, three trials: 300 returned
 * `true` each time, 175/197/158 on disk against a 301 baseline. The CONTROL is
 * what makes those attributable — the same 300 increments with no second writer
 * land 301 of 301, so nothing here is the recorder losing to itself. The defect
 * reproduces; the original 228/242/228 does NOT reproduce exactly, and should
 * not be read as a constant. It was taken on a differently-shaped second writer
 * and a differently-loaded host, and the loss rate is a property of both.
 *
 * A lease here would close it and is the wrong instrument: the lease is the
 * capability the price is specifically built to survive, so a `.resets.json`
 * lock would hand the actor who already holds `exhausted-models.json.lock` a
 * second one that suppresses the payment too. A CAS retry narrows the window
 * without closing it (check-then-rename is not atomic), and an append-only
 * journal closes it but abandons the bounded-file property RESET_HISTORY_LIMIT
 * exists for, since compaction is the clobbering write again.
 *
 * So the second writer was REMOVED rather than serialized. The discharge is not
 * a write at all: `resetObligationFor` folds it in from the record the product
 * ALREADY keeps of the user's answer.
 *
 * A RUNTIME CHOKEPOINT was the other candidate for KEEPING it to one writer — a
 * module-scoped witness set by `recordReset` and demanded of any write to this
 * path — and it is REJECTED for reasons, not taste. The check has to sit where
 * the write happens, which is `writeJson` in shared/fsjson.ts, so shared code
 * would have to know a runner's path while this module imports that shared code:
 * a layering inversion, and a cycle. Generalizing it into a per-path
 * single-writer registry puts new machinery on the hook path for the sake of one
 * file. And it is bypassed outright by a raw `fs.writeFileSync` — 82 non-test
 * files in `src/` use one — so the coverage it would advertise is exactly the
 * kind of overclaim this docblock exists to retire. Two cheaper things are done
 * instead: `resetsPath` is module-private, so no second writer can IMPORT its way
 * to the path, and the guarantee itself is carried by a behavioural table
 * (`__tests__/obligations.test.ts`) that byte-compares the record across every
 * product entrypoint. It is a development-time invariant, enforced at
 * development time.
 *
 * RE-MEASURED after the move, six cycles per arm, one real hostile process that
 * watches `.one.json` and takes each successor's `exhausted-models.json.lock`
 * the moment the pointer names it (it cannot pre-create the run directory — the
 * reset refuses `successor-id-taken` — so it wins the race the way a live child
 * would). The actor still gets everything it used to get: the lease was held on
 * 6 of 6 successors and the exhaustion row was reported not-carried on 6 of 6.
 * What it no longer gets is the discount — `modelExhaustionTerminalForRole` on
 * the fresh successor reads false, false, TRUE, TRUE, TRUE, TRUE, which is the
 * control's answer exactly. The successor's own store file holds the marker in
 * neither arm, which is the old payment site delivering nothing.
 *
 * Keyed by the SUCCESSOR's run id, because that is the run the gates ask about,
 * and carried forward by each subsequent reset (`resetObligationFor` on the
 * retired run is folded into the next one) so a chain of resets cannot walk away
 * from it one hop at a time.
 */
export interface ResetObligation {
  /** Roles whose terminal model exhaustion the successor inherits. Read by
   *  `modelExhaustionTerminalForRole`; cleared only by the user's own
   *  enable/retry answer, which is the remedy that keeps this a cost. */
  readonly terminalRoles: readonly string[];
}

export interface ResetRecord {
  /** Total resets ever, monotone, never truncated with the history. */
  readonly count: number;
  readonly events: readonly ResetEvent[];
  /** Obligations owed by successor run id. Bounded with the history: a key
   *  whose run no longer appears as an event's `to` is pruned on write. */
  readonly obligations: Readonly<Record<string, ResetObligation>>;
}

const EMPTY: ResetRecord = { count: 0, events: [], obligations: {} };
const NO_OBLIGATION: ResetObligation = { terminalRoles: [] };

/** MODULE-PRIVATE on purpose. Nothing outside this file resolved it even when
 *  it was exported (measured), so un-exporting costs nothing and buys one
 *  thing: a second writer can no longer IMPORT its way to the path, it has to
 *  reassemble it — which is a deliberate act rather than an autocomplete. */
function resetsPath(cwd: string): string {
  return path.join(runsRoot(cwd), RESETS_FILE);
}

export function readResetRecord(cwd: string): ResetRecord {
  const raw = readJson<unknown>(resetsPath(cwd), null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY;
  const value = raw as Record<string, unknown>;
  const count = typeof value.count === 'number' && Number.isFinite(value.count) && value.count >= 0
    ? Math.floor(value.count)
    : 0;
  const events = Array.isArray(value.events)
    ? (value.events.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) as ResetEvent[])
    : [];
  return { count, events, obligations: readObligations(value.obligations) };
}

/** Every field is re-validated on read rather than trusted: this record is a
 *  plain JSON file in the project, and the one thing it now carries is a bound
 *  a gate enforces. A malformed map reads as no obligation, never as a throw. */
function readObligations(raw: unknown): Record<string, ResetObligation> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, ResetObligation> = {};
  for (const [runId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!runId.trim() || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const roles = (value as Record<string, unknown>).terminalRoles;
    if (!Array.isArray(roles)) continue;
    const terminalRoles = [...new Set(roles.filter((role): role is string => typeof role === 'string' && !!role.trim())
      .map((role) => role.trim()))].sort();
    if (terminalRoles.length) out[runId] = { terminalRoles };
  }
  return out;
}

// ── THE MIRROR: THE SAME TWO FACTS IN THE SUCCESSOR'S OWN LEDGER ────────────
//
// This file is erasable, and erasing it PAID. `rm`-shaped channels that name it
// are refused by `reset-record-owner-gate`, but a line that hides the path from
// static reading is not — measured through the real `planWriteGate` on a
// materialized fixture driven to WIDEN_AT resets, then run in real bash on that
// same fixture, with the two decisions below re-read afterwards:
//
//   rm -f "$(cat <planted file>)"                     gate noop, record erased
//   eval "rm -rf .traffic-one/runs" (no run dir)      gate noop, record erased
//   node -e "…rmSync('.traf'+'fic-one/…/.res'+'ets.json')"  gate noop, erased
//
// and in every one of them `count` went 3 -> 0 and the obligation
// `[senior-frontend]` -> `[]`, so `modelExhaustionTerminalForRole` flipped true
// -> false and `correlatedCursorFailureGate` stopped denying the respawn of a
// role whose whole rotation is exhausted. FIVE consecutive rounds answered that
// by adding a spelling to the detector and a sixth spelling was found by hand
// each time; all three classes above require following a VALUE at run time,
// which a reader of command text cannot do. So this is not a fourth arm.
//
// The move is retention.ts's REMEDY_PROBE move — stop reasoning about the
// obstacle, establish the thing itself — pointed at the payoff instead of the
// command: the reset stamps the count and the obligation into the successor's
// OWN LEDGER, `runs/<successor>/run.json`, and both readers below take the
// record UNION the mirror. Erasing this file then buys nothing at all.
//
// WHY THAT LEDGER, and it is measured rather than assumed:
//   - the reset ALREADY writes an off-interface field there (`supersedes`, one
//     writer, `reset.ts`), so the mechanism ships today. Unknown fields survive
//     because `writeRunLedgerTransition` builds `{...existing, ...patch}` and
//     both settlement projections spread `...source`/`...existing`. Driven: the
//     stamp survives an ordinary `planned -> active` transition, and
//     `supersedes` survives even the `kind` CLOBBER that ordinary product paths
//     perform by passing their own `kind`.
//   - it is SEPARATELY fenced, and — measured rather than assumed — NOT BETTER
//     fenced. That is a claim an earlier draft of this comment made and the
//     measurement withdrew, which is worth keeping visible: `runs/<id>/run.json`
//     is a `runtimeOwnedRunSidecar`, so `runtime-sidecar-owner-gate` answers for
//     it, and asked class by class at the real gate on the current run's ledger
//     it answers exactly as the record's own fence answers for the record — the
//     path spelled outright, a literal `eval` of the same `rm`, and a printed
//     substitution PLANTED AND USED IN ONE COMMAND (where the plant leaves the
//     literal in the text) are refused at both files, while a value planted in
//     an EARLIER command and a split join are noop at both. So the second copy
//     is not better hidden; it is a DIFFERENT FILE, and that is the whole of
//     what it buys — a line aimed at one of them takes one, and the ladder needs
//     both.
//   - retention RESERVES `currentRunId`, so the mirror is never swept off the
//     run a gate is asking about.
//
// THE RESIDUAL, and it is not small: a class-3 interpreter join that splits the
// ledger's own name reaches the mirror at gate noop, and a tree-wide erasure
// (`rm -rf` whatever a substitution PRINTS) takes both copies in one command
// and costs the agent nothing measurable. What this buys is that erasing THE
// RECORD ALONE stops paying, and that the second copy sits behind a fence that
// refuses two of the three classes. It is not a closure of the value-hiding
// class, which no static reader of command text can close.
//
// A SNAPSHOT, NOT A RE-DERIVATION, and that is the whole of its safety. The
// mirror holds the value `recordReset` is handed, written by the same command in
// the same settlement, so the second source cannot say MORE than the record
// would have. Re-deriving the obligation later — walking `supersedes` and
// re-reading the retired run's `roles[*].terminal` — was the other candidate and
// is REJECTED for a reachable over-widening: this transaction releases claims
// and terminates nothing (obligations.ts rule 4), so a still-live child of the
// retired run can add a terminal marker AFTER the reset, and a re-derivation
// would inherit a bound the reset never imposed.

/** The two fields the reset stamps into the successor's ledger, and the ONE
 *  definition of their names — the writer (reset.ts) and the readers below both
 *  come through here, so a rename cannot leave a reader silently answering
 *  nothing while every test still passes. */
const MIRROR_SEQ = 'resetSeq';
const MIRROR_TERMINAL_ROLES = 'inheritedTerminalRoles';

/**
 * The ledger patch that carries the mirror, for `reset.ts` to merge into the
 * `ensureRunLedger` call it ALREADY makes for the successor.
 *
 * One write, not two, and deliberately: a second, later `ensureRunLedger` would
 * have to name a status, and a child activating the successor in between makes
 * `planned -> planned` inadmissible, so the stamp would be silently lost in
 * exactly the busy project that most needs it.
 */
export function resetLedgerMirror(resetSeq: number, obligation: ResetObligation): Record<string, unknown> {
  return {
    [MIRROR_SEQ]: Math.max(0, Math.floor(resetSeq)),
    [MIRROR_TERMINAL_ROLES]: [...obligation.terminalRoles],
  };
}

interface LedgerMirror {
  readonly resetSeq: number;
  readonly terminalRoles: readonly string[];
}

const NO_MIRROR: LedgerMirror = { resetSeq: 0, terminalRoles: [] };

/** Every field re-validated on read, exactly as `readResetRecord` re-validates
 *  the record: this is a plain JSON file in the project, and an unreadable or
 *  malformed mirror answers "no mirror" rather than throwing on a gate path. */
function readLedgerMirror(cwd: string, runId: string): LedgerMirror {
  const ledger = obj(readJson<unknown>(runLedgerFile(cwd, runId), null));
  if (!ledger) return NO_MIRROR;
  const seq = ledger[MIRROR_SEQ];
  const roles = ledger[MIRROR_TERMINAL_ROLES];
  return {
    resetSeq: typeof seq === 'number' && Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0,
    terminalRoles: Array.isArray(roles)
      ? [...new Set(roles.filter((role): role is string => typeof role === 'string' && !!role.trim())
        .map((role) => role.trim()))].sort()
      : [],
  };
}

/**
 * How many resets this project had recorded BEFORE the one being performed —
 * the record's `count`, floored by what the current run's own ledger says.
 *
 * The floor never exceeds the truth: the mirror is the count as it stood when
 * this run was minted, so on an intact project the two agree and the `max` is
 * the record's own answer. An erased record reads 0 and the floor is what keeps
 * the ladder from rolling back to free.
 *
 * `recordReset` is deliberately NOT changed to write the floor: it is the one
 * writer and its arithmetic stays `count + 1` over what is on disk. The stamp
 * for the successor is computed from THIS answer instead, so the mirror stays
 * monotone across an erasure even while the record itself restarts.
 */
export function priorResetCount(cwd: string, runId: string): number {
  const recorded = readResetRecord(cwd).count;
  if (typeof runId !== 'string' || !runId.trim()) return recorded;
  return Math.max(recorded, readLedgerMirror(cwd, runId.trim()).resetSeq);
}

/**
 * What run `runId` owes because of the reset that minted it — AND THE DISCHARGE,
 * folded in here rather than written back, which is what keeps this file to one
 * writer (see `ResetObligation`).
 *
 * The remedy for a widened role is the user's own "I fixed the budget / I
 * re-enabled the model" answer; that is not a new thing to record, because the
 * product already records it, per run, in `model-choice.json`. So the discharge
 * is a JOIN against a record that already exists instead of a mutation of this
 * one. Nothing a hook runs writes here.
 *
 * IT IS THE SAME EVENT, not merely a correlated one. `enable-retry` reaches
 * `clearExhaustedModels` — the old caller of the delete — from exactly one
 * product path, `recordPendingModelChoiceReply`, which writes the choice FIRST
 * and returns early when that write is refused. So the answer is on disk at
 * every call that used to reach the delete, and at no other.
 *
 * Both consumers read the obligation through here (the gate's terminal reader
 * and obligations.ts's `terminalRolesToWiden`, which folds a retired run's
 * obligation into its successor's), so a discharged obligation cannot resurrect
 * one reset later — the behaviour the delete had, from one definition instead of
 * two. The COUNT is untouched by any of this: the reset still happened, and the
 * next reset is still priced.
 *
 * `model-choice.json` is `bound-dropped` at every reset (obligations.ts), so the
 * answer discharges the run that was given it and never the successor.
 *
 * ── "IT ADDS NO FORGEABLE SURFACE" IS TRUE. THE ARGUMENT THAT WAS HERE FOR IT
 *    WAS FALSE, AND FALSE IN THE DIRECTION IT WAS USED ────────────────────────
 * The sentence this replaces said an actor who can write that file can already
 * grant itself `use-fallback`, which is STRICTLY LARGER. MEASURED at the gate,
 * three arms on one fixture holding a live obligation for `senior-frontend`:
 *
 *   recorded answer   obligation            terminal   correlatedCursorFailureGate
 *   none              ["senior-frontend"]   true       deny cursor-api-limit-terminal
 *   use-fallback      ["senior-frontend"]   true       deny cursor-api-limit-terminal
 *   enable-retry      []                    false      null — ADMITTED
 *
 * `use-fallback` buys nothing at this gate. The two answers are INCOMPARABLE,
 * and in this direction `enable-retry` is the larger one: it clears the terminal
 * check above, which runs BEFORE the `readModelChoice` that `use-fallback`'s own
 * grants hang off. So the discharge for the whole fold rested on a comparison
 * that runs the wrong way.
 *
 * WHAT HOLDS INSTEAD is containment, and it is measured at the product's own
 * write fence rather than inferred from both files being "in the project":
 * `runtimeOwnedRunSidecar` matches `runs/<id>/model-choice.json`, and
 * `planReadinessViolations` refuses it to every agent, child and parent with
 * `runtime-sidecar-owner-gate`.
 *
 * THE ARGUMENT THAT USED TO FINISH THAT PARAGRAPH WAS TRUE AS A FACT AND WRONG
 * AS A DEFENCE, and it is recorded because it is the shape to watch for. It
 * said: that same fence does NOT match `runs/.resets.json` — one directory up,
 * outside the `runs/<id>/<entry>` shape the pattern requires — so "the file the
 * fold READS is better defended than the file the fold protects", and therefore
 * an actor who can write the answer "could always have deleted the record the
 * answer discharges, with strictly less to defeat. The fold hands that actor
 * nothing new."
 *
 * The premise was correct and is still correct: the sidecar pattern cannot match
 * this path, deliberately. The inference from it was the defect. It read a hole
 * in the record's defences as a reason not to mind a second one, when the
 * measurement it was standing next to says the record was the LEAST defended
 * bound of the three and the price of the whole ladder sits on it. Driven
 * through the real `planWriteGate`: 7 of 27 erasure channels on this path
 * PERMITTED with a live run pointer, all 27 permitted without one — the only
 * refusal came from `strayRunIdInText` misreading `.resets.json` as a fabricated
 * run id, which is not a fence, and which told the writer to write under
 * `.traffic-one/runs/<currentRunId>/` instead.
 *
 * WHAT MAKES THE ORIGINAL CLAIM SIMPLY TRUE NOW is that the record has a fence
 * of its own rather than a borrowed one: `reset-record-owner-gate`
 * (modules/plan-guard/plan-readiness/index.ts, with
 * plan-write/reset-record-shell.ts reading the shell shapes) refuses every
 * channel the gate can see, reads no run pointer, and measures 0 escapes across
 * the same 27 channels in every pointer variant. So the two files are now
 * comparably defended, each by the gate that describes it, and the fold really
 * does hand an actor nothing new — for the reason the sentence claimed rather
 * than in spite of it. Pinned at the gate in
 * modules/plan-guard/__tests__/reset-record-fence.test.ts; not pinned from here,
 * because a citation this file cannot verify is what went wrong the first time.
 *
 * And the capability this price is actually built to survive — holding
 * `exhausted-models.json.lock` — still buys nothing here, which is the claim the
 * whole file exists to keep true.
 *
 * ── THE DISCHARGE IS NOW A STANDING STATE, NOT AN EVENT. ACCEPTED, WITH THE
 *    REASON, BECAUSE IT WAS NOT A DECISION ANYONE RECORDED ────────────────────
 * The delete was reachable only through `recordPendingModelChoiceReply`, which
 * returns early unless `modelChoiceReplyPending` — the product must actually
 * have ASKED. This fold has no latch: any `model-choice.json` reading
 * `enable-retry` discharges, prompt or no prompt, hook or no hook. Accepted, on
 * the containment above rather than by oversight — the only actor that can
 * produce the state without the event is one that can already write
 * `runs/<id>/`, and that actor has a shorter route to the same outcome.
 * WITHIN one run the two readings also coincide: a run's obligation is written
 * by `recordReset` at the moment that run is MINTED as a successor, and the
 * successor id is chosen to name no existing directory (reset.ts suffixes, then
 * refuses `successor-id-taken`), so there is no answer on disk for it to read
 * when the obligation lands. The cross-run case is closed separately and
 * behaviourally — see obligations.test.ts, "the remedy is scoped to the run that
 * was given it, so it cannot discharge a successor".
 *
 * ── IT READS TWO SOURCES NOW, AND THE DISCHARGE STILL COMES FIRST ────────────
 * The answer is the record UNION the mirror in the successor's own ledger (see
 * THE MIRROR above), because this file is erasable through channels no reader of
 * command text can see and erasing it PAID. The discharge is evaluated before
 * either source is consulted, so the user's answer clears both; that ordering is
 * pinned as a behavioural row rather than trusted to this paragraph.
 */
export function resetObligationFor(cwd: string, runId: string): ResetObligation {
  if (typeof runId !== 'string' || !runId.trim()) return NO_OBLIGATION;
  const id = runId.trim();
  // THE DISCHARGE IS AHEAD OF BOTH SOURCES, AND THE ORDER IS THE LOAD-BEARING
  // PART OF THE MIRROR. A remedy that ran after the union would clear the record
  // and hand the same obligation straight back out of the ledger — the exact
  // behaviour the delete used to have and that this fold exists to replace,
  // resurrected by a second copy. It is a TEST ROW rather than this sentence:
  // __tests__/record-erasure.test.ts, 'the enable/retry answer discharges the
  // MIRROR too, because the discharge is ahead of both sources', which fails
  // with the answer ignored if the two lines below are reordered.
  if (readModelChoice(cwd, id) === 'enable-retry') return NO_OBLIGATION;
  const recorded = readResetRecord(cwd).obligations[id]?.terminalRoles ?? [];
  const mirrored = readLedgerMirror(cwd, id).terminalRoles;
  if (recorded.length === 0 && mirrored.length === 0) return NO_OBLIGATION;
  // Union, so either copy alone is the whole answer; a role in both is one role.
  return { terminalRoles: [...new Set([...recorded, ...mirrored])].sort() };
}

/**
 * Append one reset to the record.
 *
 * The ATOMIC writer, not the durable one, and that was a deliberate reversal.
 * Durability is superficially attractive here — the record's whole job is to
 * outlive trouble — but `writeJsonDurable`'s set is bounded on purpose, and its
 * admission rule is "the artifact was minted once and is already observed off
 * this machine". This record is neither: it is local project state, and nothing
 * outside this machine has acted on it. What durability would actually buy is
 * the narrow window where the process survives long enough to return but the
 * machine loses power before the page cache flushes, at the cost of joining a
 * five-member set that exists to stay small. The atomic writer already
 * guarantees the file is never torn, which is the failure that would matter.
 *
 * Non-fatal, because a project that cannot write its record still needs its
 * recovery to complete. The failure is returned rather than thrown so the
 * caller can name it in the warnings instead of losing it.
 *
 * THE OBLIGATION IS WRITTEN BY THE SAME CALL THAT COUNTS THE RESET, which is
 * what makes the price undefeatable by the capability that defeats the bound:
 * one writer, one file, no lease, and no dependence on whether any carry
 * succeeded. See `ResetObligation`.
 *
 * THIS FUNCTION IS THAT ONE WRITER, and both halves of the claim are checked
 * rather than asserted. That no OTHER function writes the file is pinned
 * BEHAVIOURALLY, by driving each product entrypoint that could plausibly
 * acquire a write and byte-comparing the record across it
 * (`__tests__/obligations.test.ts`, "`.resets.json` is byte-identical across
 * every product entrypoint but the reset itself"). It used to be pinned by a
 * source scan for the three spellings of the path, and that instrument was
 * defeated in one character by an adversarial review — a template literal, a
 * file-local constant, and a path reassembled from `runsRoot`, wired into a
 * registered hook handler, entirely green. The scan is kept as a tripwire for
 * the naive spelling and is no longer what the claim rests on. That this
 * function does not race ITSELF is the window argument in
 * reset.ts: a second reset naming the retired id refuses `not-current-run` and
 * one naming the successor refuses `run-not-failed` or `ledger-absent`, so no
 * second invocation ever reaches this line while a first is in it.
 */
export function recordReset(cwd: string, event: ResetEvent, obligation?: ResetObligation): boolean {
  const current = readResetRecord(cwd);
  const events = [...current.events, event].slice(-RESET_HISTORY_LIMIT);
  const obligations: Record<string, ResetObligation> = { ...current.obligations };
  if (obligation && obligation.terminalRoles.length) obligations[event.to] = obligation;
  // Bounded with the history for the same reason the history is bounded, and on
  // the same key: an obligation whose successor has aged out of `events` names a
  // run no reader can still be asking about — every reader keys on the CURRENT
  // run id, and a run that far back cannot be it.
  const live = new Set(events.map((item) => item.to));
  for (const runId of Object.keys(obligations)) {
    if (!live.has(runId)) delete obligations[runId];
  }
  return writeJson(resetsPath(cwd), { count: current.count + 1, events, obligations });
}
