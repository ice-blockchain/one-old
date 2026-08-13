// src/runners/traffic-one-reset/obligations.ts
// EVERYTHING A GATE HOLDS UNDER `runs/<id>/`, CLASSIFIED, AND THE HALF A RESET
// HAS TO CARRY.
//
// ── the defect this exists to close ─────────────────────────────────────────
// A reset moves `currentRunId`. Every gate obligation in this product is keyed
// by run id, so moving the pointer does not RESET that state, it makes it
// unreachable — and the successor starts with a clean copy of all of it. Three
// of the four properties on the `reset` row of hooks/fail-closed.ts describe
// what the runner WRITES, and the runner satisfies them honestly; none of them
// said anything about what a pointer move DISCARDS.
//
// Measured, on a project driven to terminal `failed` through the OpenCode
// maintenance path (no `run-status --status failed` anywhere): a deny-repeat
// ladder standing at 5 — two draws past DENY_REPEAT_ESCALATE_AT, so the agent
// was being told to stop retrying and report BLOCKED — read 1 on the successor,
// with the escalation paragraph gone. That is a clean, unlogged escape from an
// obligation, bought by reaching a terminal state and asking for the recovery.
//
// ── the rule, and it is a classification not a copy ─────────────────────────
// Every entry below is one of three things:
//
//   BOUND-CARRIED   It exists to stop a loop or spend a budget, AND carrying it
//                   leaves the successor exactly as constrained as the retired
//                   run was — no more, no less. These are carried.
//   BOUND-DROPPED   It bounds something, but carrying it would WEDGE the
//                   successor. Admission is not a story about what is gone; it
//                   is the four rules below, and a row that cannot pass them
//                   belongs in the bucket above.
//   EVIDENCE        It describes work that was done. It belongs to the run that
//                   did it and legitimately stays there.
//
// ── THE ADMISSION RULE FOR `bound-dropped` ──────────────────────────────────
// A previous round let this bucket be reached by telling a plausible story, so
// it now has an entry test. Four rules, each checkable against the row:
//
//   1. WEDGE, NOT INCONVENIENCE. A drop is justified only when carrying leaves
//      the successor with NO in-product remedy and NO self-heal. A remedy is
//      something the AGENT can reach on its own: `[t1-replace-agent]`, the
//      270-second presumed-dead grace, a 10-minute TTL, a staleness reclaim.
//      An answer only a HUMAN can give is not a remedy for this rule — it is a
//      cost, and a cost is what the widening at WIDEN_AT spends (see below).
//      "Carrying it is annoying" is never an admission.
//   2. FINEST GRANULARITY AVAILABLE. A file that mixes a wedge with a bound is
//      SPLIT, not dropped. `debug/deny-repeats.json` proves the runner can
//      carry at sub-file granularity; `exhausted-models.json` and
//      `model-choice-prompted` now do the same at key and predicate level.
//   3. NAME EVERY AXIS. Each `why` must say what the row ADMITS as well as
//      what it refuses. A row that is a bound on two axes and reasoned about on
//      one is not classified, it is half-classified — that is how the live-agent
//      registry lost the verifier-independence record while a paragraph about
//      duplicate spawns read as complete.
//   4. "GONE" MUST MEAN GONE. The transaction runs `releaseRunClaimsResult`:
//      claims deleted, claim files marked released, fallback locks swept. NO
//      PROCESS IS TERMINATED. A row may not say "the children this transaction
//      released" and mean "the children this transaction killed"; a child whose
//      claim was released is still running, still spawning tools, and still
//      writing into the successor. Four rows traded on that conflation and are
//      re-decided below.
//
// The asymmetry that survives all four is worth stating: a bound whose reset
// makes gates STRICTER is not a laundering vector and is not carried. Clearing
// a spent one-shot deny budget, or a marker that ADMITS something, gives the
// successor more refusals, not fewer. An agent gains nothing by resetting to
// reach them, and carrying them would be a gift.
//
// ── what this cannot do alone, and what WIDEN_AT adds ───────────────────────
// Carrying bounds forward makes ONE reset conserving. It cannot by itself make
// TEN resets conserving: a handful of rows are genuinely dropped, and each
// reset legitimately refreshes them, so the dropped bucket used to refresh at
// full value on every cycle without limit. `resets.ts` records every reset, and
// this module READS that record: at WIDEN_AT resets the carry widens (see
// WIDEN_AT). Recovery still always succeeds — it stops being free.

import * as fs from 'fs';
import * as path from 'path';

import { VALID_AGENT_ROLES } from '../../config/state';
import { withExhaustedModelsLock } from '../../modules/agent-model/exhausted-models';
import { readModelChoice } from '../../modules/agent-model/model-choice';
import { appendTextFile, readJson, readText, writeJson, writeTextFile } from '../../shared/fsjson';
import { obj } from '../../shared/obj';
import {
  readCursorSpawnObservationStore,
  withCursorSpawnObservationLock,
  writeCursorSpawnObservationStore,
  type CursorSpawnObservation,
} from '../../shared/state/run-agent/cursor-observations';
import { withAgentRegistryLock } from '../../shared/state/run-agent/registry';
import { runDir } from '../../shared/state/run-agent/run-paths';
import { resetObligationFor, type ResetObligation } from './resets';

export type ObligationClass = 'bound-carried' | 'bound-dropped' | 'evidence';

export interface Obligation {
  /** The entry name directly under `runs/<id>/`. */
  readonly entry: string;
  readonly kind: ObligationClass;
  /** Why it is classified this way — the reason a reader has to be able to check. */
  readonly why: string;
  /** Present only on a row whose carry WIDENS at WIDEN_AT resets: what the extra
   *  carry is, and the remedy that keeps a cost from being a wedge. */
  readonly widened?: string;
}

/**
 * The reset count at which the carry widens, and why this number.
 *
 * `DENY_REPEAT_ESCALATE_AT` is 3: the product's own answer to "how many draws
 * of the same refusal before repetition is itself the evidence" — at three, the
 * deny-repeat ladder stops treating a retry as noise and tells the agent to
 * stop and report BLOCKED. A reset is the same shape of event, so it gets the
 * same number rather than a fresh invented one. Two free recoveries is also the
 * right generosity on the merits: the population this command serves is
 * projects where every other route out is already blocked, and a first crash
 * (a machine losing power mid-write) plus one recurrence is an accident. A
 * third is a pattern.
 */
export const WIDEN_AT = 3;

/**
 * The complete set of `runs/<id>/` entries this product writes.
 *
 * COMPLETENESS IS ENFORCED, not asserted, and now at both ends:
 * __tests__/obligations.test.ts scans every run-scoped path builder in `src/**`
 * and fails on any entry name absent from this table, and separately drives a
 * fixture run through the product's own writers and fails on any entry that
 * reaches disk without a row (`undeclaredRunEntries`). The second half used to
 * be claimed here and did not exist — the function had no production, no caller
 * and no disk-driven test — which is exactly the kind of sentence this table is
 * supposed to make impossible.
 *
 * The scan is no longer blind to names that arrive through a constant, a
 * `${filePath}.lock` template, or a `${<run-scoped path>}${SUFFIX}` quarantine
 * template: measured, 52 of the 52 rows are corroborated by a real writer, where
 * 4 used to be found by hand and could have been withheld silently. Three
 * run-scoped entries live in the lock-template class and a hand sweep had found
 * one — no laundering vector (a lock is never a bound), but the property claimed
 * is completeness of a SET, and a bound could have been sitting there instead.
 *
 * The quarantine class was the last one both halves missed, and it was not
 * hypothetical in either direction: the product writes `agents.json.corrupt` and
 * `run.json.corrupt` from its own self-heal paths, and it writes them precisely
 * in the corrupt-state scenario a reset exists to recover from. Driven through
 * the real healers, both reached disk and the disk-driven half reported them as
 * undeclared — 50 rows against 52 written entries, so the completeness claim was
 * false as stated.
 */
export const RUN_OBLIGATIONS: readonly Obligation[] = [
  // ── carried ───────────────────────────────────────────────────────────────
  {
    entry: 'debug',
    kind: 'bound-carried',
    why: 'holds deny-repeats.json, the escalation ladder — the one bound whose carry cannot deny anything new, '
      + 'because the counter never blocks (deny-repeat.ts: "deliberately does NOT block") and only appends the '
      + 'STOP-RETRYING paragraph to a refusal that was going to fire anyway. Only that file is carried; the '
      + 'decision log and the claim/plan-guard captures beside it are evidence and stay with the retired run.',
  },
  {
    entry: 'agent-activity',
    kind: 'bound-carried',
    why: 'the exploration tally the cap reads: `<role>.log`, one line per tool call, tagged with the CHILD id. '
      + 'Carried by APPENDING the retired log to the successor\'s, because every line in each file is a distinct '
      + 'tool call — a genuinely new child still starts at zero, and a child that survives the reset stays over '
      + 'its cap. Copy-if-absent lost the whole retired tally the moment one surviving child logged one call '
      + 'into the successor first.',
  },
  {
    entry: 'agent-activity-denies',
    kind: 'bound-carried',
    why: 'the other half of the same bound, and carried WITH it or the carry would be a regression: the tally '
      + 'says "over cap" and this marker says "the one consolidation deny that buys has been spent". Presence IS '
      + 'the value, so the merge is a union — a marker either run has is a marker the successor has.',
  },
  {
    entry: 'scan-bound.json',
    kind: 'bound-carried',
    why: 'a durable `{bound:true}` flag that RAISES the required-evidence floor for the rest of the run '
      + '(boundedScanTruncated). Dropping it lowers a floor an agent did not earn the right to lower. Merged as '
      + 'a boolean OR: a floor either run raised stays raised, and a successor that already raised it is never '
      + 'overwritten with the retired reason.',
  },
  {
    entry: 'exhausted-models.json',
    kind: 'bound-carried',
    why: 'SPLIT, per rule 2, because the file holds two different things. `roles[*].entries` are the TTL '
      + 'condemnations whose whole job is to stop the loop the incident just ran: dropped, `modelIsExhausted` '
      + 'reads false and the rate-limited model is immediately admissible for the same role again, which is a '
      + 'refund of exactly the bound. They are carried (union by model, keeping the later stamp, so a '
      + 'condemnation is never shortened). `roles[*].terminal` — "every tier candidate was attempted", '
      + 'non-expiring — is NOT carried at a first reset: a successor with no admissible model for a role cannot '
      + 'spawn it at all, and the only route back is clearExhaustedModels, which the product reserves for the '
      + "user's own \"I fixed the budget\" answer. That the entries self-heal in ten minutes argues for carrying "
      + 'them, not against: a short TTL is what makes the carry SAFE, never what makes the drop harmless.',
    widened: 'at WIDEN_AT resets the successor inherits `roles[*].terminal` — as an OBLIGATION RECORDED IN '
      + '`.resets.json`, not as an extra carry into this file. A project on its third recovery is the pattern the '
      + 'marker describes, and the cost — the exhausted role needs the user\'s enable/retry answer before it '
      + 'spawns again — is a cost, not a brick: the reset still succeeds, claims still bind, every other role '
      + 'still has its rotation. Sited outside this store because a price carried INTO the store being defeated '
      + 'is defeated by the same capability: measured over six cycles with the successor\'s lease held, the '
      + 'terminal marker reached no successor at all while the control widened from cycle 3. See '
      + 'resets.ts ResetObligation.',
  },
  {
    entry: 'model-choice-prompted',
    kind: 'bound-carried',
    why: 'read as a prompt-at-most-once marker it looks stricter to clear, and on that axis it is. Rule 3: it '
      + 'has a second axis, and that one is a LATCH. With no recorded choice this marker is the only input to '
      + 'modelChoiceReplyPending on the Composer-floor path, and two gates deny on that predicate — plan-write '
      + '("build paused ... do not spawn subagents, scaffold directly, or edit project files until the user '
      + 'replies") and subagent-bind ("this subagent must stop now and must not write files"). Measured: '
      + 'pending before the reset, false after, with nobody having replied. A pause waiting on a HUMAN is not a '
      + 'budget, and releasing it is not a strictness. Carried ONLY when the retired run recorded no choice: '
      + 'copying the marker over an answered run would manufacture a pause the retired run was never in, which '
      + 'rule 1 forbids in the other direction.',
  },
  {
    entry: 'agents.json',
    kind: 'bound-carried',
    why: 'RE-DECIDED, on both axes (rules 1, 3 and 4). It was dropped as "the duplicate-same-role-spawn deny, '
      + 'naming agents that no longer exist" — but this transaction releases CLAIMS, it terminates nothing, so '
      + 'the children it names may all still be running. On the duplicate-spawn axis the carry is an '
      + 'inconvenience with three remedies, not a wedge: agent-reuse-continue names the continuation call and '
      + '[t1-replace-agent], liveRunAgent refuses any row whose parentSessionId differs from the live session '
      + 'and ages every row out at SUBAGENT_STALE_MS, and the Cursor await-cursor-id branch self-heals in '
      + '<=270s via cursorAgentPresumedDead. The axis that decides is the one the old row never mentioned: this '
      + 'registry IS the verifier-independence record. verdictAgentConflict reads it to refuse a senior-reviewer '
      + 'continuing an id already recorded for senior-frontend, it does not age out, and dropping it hands a '
      + 'reset a way to launder exactly that. Merged per role, successor rows winning, so a child that bound in '
      + 'the successor first is never overwritten.',
  },
  {
    entry: 'cursor-spawns.json',
    kind: 'bound-carried',
    why: 'RE-DECIDED (rules 1 and 4). It was dropped as observations describing "children released by this '
      + 'transaction" — but this module exists to OUTLIVE the child: its own docstring keeps the spawn-time '
      + 'facts "so a later child transcript can be correlated even after the live-agent registry entry has been '
      + 'retired". Dropping it refunds the correlated-failure prescription ("retry role R only on model X") and '
      + 'the retryHandled one-shot. Carrying costs the successor a NAMED ADMISSIBLE MODEL for one role, which '
      + 'is determinate rather than wedging. Merged by toolCallId, successor rows winning, through the store\'s '
      + 'own writer so the 128-row newest-wins cap has one owner. NARROWED, because the first version of this '
      + 'row silently overrode its NEIGHBOURS\' conditionals: a carried row is a FINISHED resolution, and '
      + 'refreshing it against the successor re-derived, from its own carried inputs, both the terminal '
      + 'exhaustion marker the row above withholds until WIDEN_AT and the human-reply latch the row below '
      + 'carries only conditionally. Measured at zero prior resets with nothing widened, the bound reserved for '
      + 'the third reset was present after the first. Each carried row is therefore stamped with the run that '
      + 'observed it and refreshPendingResolution declines to re-derive one; a genuinely new failure in the '
      + 'successor is a new row, resolves normally, and mints on its own merits.',
  },

  // ── bound, but dropped, because carrying it WEDGES ────────────────────────
  { entry: '.agents.lock', kind: 'bound-dropped', why: 'a lease over agents.json, not a bound on anything. The file it guards is now carried; the lease is not, and must not be: a lock directory arriving in a run no live process holds serialises nothing while blocking every writer until its own staleness reclaim fires.' },
  {
    entry: 'model-policy.json',
    kind: 'bound-dropped',
    why: 'freezes the per-role model prescription and its policyId; the spawn gate denies a spawn whose policy '
      + 'id does not match the bootstraps published against it. Carried without those bootstraps it is an '
      + 'orphan policy id, which run-paths.ts records as an incident of its own. Not widened either: the '
      + 'successor publishes its own policy, and two policy ids over one run is the state this file exists to '
      + 'make impossible.',
  },
  { entry: 'model-policy.json.lock', kind: 'bound-dropped', why: 'the lock DIRECTORY over model-policy.json (`${filePath}.lock` holding owner.json), dropped with the file it guards; a lease carried into a run whose publisher does not exist blocks the successor\'s own publish until its stale reclaim.' },
  {
    entry: 'bootstrap',
    kind: 'bound-dropped',
    why: 'per-role bootstrap envelopes gating spawns, scoped to the retired policy id and the work units of a '
      + 'run that ended. The successor publishes its own; carrying these blocks that. Nothing here bounds an '
      + 'agent that the carried registry and model ledger do not already bound.',
  },
  { entry: 'exhausted-models.json.lock', kind: 'bound-dropped', why: 'the lock over exhausted-models.json (`${filePath}.lock`), dropped while its file is carried at sub-key granularity; a lock outliving its process protects nothing and blocks every recorder until STORE_LOCK_STALE_MS.' },
  {
    entry: 'opencode-gateway-down',
    kind: 'bound-dropped',
    why: 'a circuit breaker over an EXTERNAL service, not over the agent. It bounds nothing an agent chose, so '
      + 'carrying it would conserve no budget and only cost one re-detection; markers.ts already documents a '
      + 'new run id as how it clears. Not a widening candidate for the same reason — there is nothing here to '
      + 'launder.',
  },
  {
    entry: 'opencode-attempts',
    kind: 'bound-dropped',
    why: 'the marker that ADMITS a paid spawn once free delegation was tried. Clearing it makes the gate '
      + 'stricter (delegation must be attempted again), so it is not a laundering vector — and carrying it '
      + 'would be a gift, which is why it is not widened either.',
  },
  { entry: 'opencode-gate-denies', kind: 'bound-dropped', why: 'a spent one-shot deny budget; clearing it gives the successor one MORE refusal, never fewer. Carrying it would hand the successor a deny it has not earned the right to skip.' },
  { entry: 'verify-gate-denies', kind: 'bound-dropped', why: 'the same, in its own directory so it cannot consume the budget above; cleared in the strict direction for the same reason.' },
  {
    entry: 'model-choice.json',
    kind: 'bound-dropped',
    why: "the user's recorded answer, and INSEPARABLE from the prompted marker above — the pair was reasoned "
      + 'about on one row and had to be reasoned about on both. Both recordable answers are permissive: '
      + '`use-fallback` is the standing permission to spawn off the picked model, and `enable-retry` both '
      + 'suppresses exhaustion recording and calls clearExhaustedModels. Carrying either refunds a permission '
      + 'and, worse, cancels the latch the marker conserves (readModelChoice short-circuits '
      + 'modelChoiceReplyPending). Dropping it makes the successor re-ask, which is the strict direction, and it '
      + 'is what makes carrying the marker mean "still waiting" rather than "already answered".',
  },
  { entry: 'model-advisory', kind: 'bound-dropped', why: 'a show-once marker for the model advisory; clearing it permits one more advisory, never one fewer. Gates nothing, so there is no bound to conserve and nothing to widen.' },
  { entry: 'model-gate-prompted.json', kind: 'bound-dropped', why: 'a 5-minute freshness marker that lets a runner PROCEED; clearing it fails closed, not open, and carrying it would admit one unearned pass.' },
  {
    entry: 'opencode-plan-batch',
    kind: 'bound-dropped',
    why: 'per-role completion markers for a delegation batch that is over. A missing marker keeps the '
      + 'fail-closed batch gate ACTIVE, so clearing them is the strict direction and carrying them would '
      + 'satisfy a gate with a finished run\'s work.',
  },
  { entry: 'opencode-applying', kind: 'bound-dropped', why: 'a mutual-exclusion latch for apply-back, held by a hook process that has since exited (hooks are short-lived; the latch is not a record of an agent). Carrying a latch nothing holds serialises nothing and blocks the successor\'s first apply-back.' },
  { entry: 'opencode-queue.json', kind: 'bound-dropped', why: 'the delegation queue state machine for work that will not be delegated now; carried, the successor inherits a queue whose units its own assignments do not name, which is a state machine with no subject rather than a bound.' },
  { entry: 'opencode-units.json', kind: 'bound-dropped', why: 'the work units of a delegation queue that will not be drained now; the successor compiles its own from its own plan, and a carried set would contradict them.' },
  { entry: '.cursor-spawns.lock', kind: 'bound-dropped', why: 'the lease over cursor-spawns.json, not the observations themselves — those are now carried. A lease is bound to the process that took it, and that process has exited; carrying it only delays the successor\'s first record until the stale reclaim.' },
  {
    entry: 'codex-model-observations.json',
    kind: 'bound-dropped',
    why: 'identity-bound observations whose mismatch/conflict verdicts deny a child. RE-JUSTIFIED (rule 4): the '
      + 'old reason was "bound to child threads this transaction released", which conflates a released claim '
      + 'with a dead thread. The real reason is mechanical and survives the correction — evaluate() flips any '
      + 'observation whose recorded policyId differs from the CURRENT run policy to terminal '
      + '`conflict`/policy-mismatch, and the successor necessarily mints a new policyId (model-policy.json is '
      + 'dropped above). So a carried row does not conserve a verdict, it manufactures a terminal one against a '
      + 'child that may still be alive, with no route back inside the run. That is the wedge rule 1 names, and '
      + 'it also disqualifies the row from widening.',
  },
  { entry: 'codex-model-observations.json.lock', kind: 'bound-dropped', why: 'the lock DIRECTORY over codex-model-observations.json (`${filePath}.lock` holding owner.json), dropped with the store it guards for the same reason as its siblings: a lease is not a bound, and one carried past its holder blocks writers until LOCK_STALE_MS.' },
  {
    entry: 'transactions',
    kind: 'bound-dropped',
    why: 'in-flight two-phase claim rebind journals. The subject really is gone here, and precisely: '
      + 'releaseRunClaimsResult DELETES the pending claims these journals would resume, so a carried journal '
      + 'names reservations that no longer exist on disk. The claim, not the child, is what this transaction '
      + 'ends.',
  },
  {
    entry: 'pending',
    kind: 'bound-dropped',
    why: 'pending claim reservations, deleted by the whole-run release this transaction performs — the one '
      + 'family of rows where "gone" is literal, because the release does the deleting itself. It bounds no '
      + 'agent: the child that held one re-binds in the successor.',
  },
  { entry: 'claims', kind: 'bound-dropped', why: 'per-file fallback write-ownership locks, DELETED by the same release (they are advisory write locks, not identity records, and once the run settles they can only go stale). Nothing to carry, and the writer they served re-takes one in the successor.' },
  { entry: '.claims.lock', kind: 'bound-dropped', why: 'the lease over the per-file fallback claim locks, which the whole-run release sweeps; the lease is bound to the hook process that took it and serialises nothing in the successor.' },
  { entry: '.agent-claims.lock', kind: 'bound-dropped', why: 'the lease over the claim store; the claims it guards are released by this transaction and the process that held it has exited, so it has nothing left to serialise and would only block the successor\'s first bind.' },
  { entry: '.run-ledger.lock', kind: 'bound-dropped', why: "the retired ledger's lease; the ledger itself is never touched by this runner, and a lease over an immutable terminal record protects nothing." },

  // ── evidence ──────────────────────────────────────────────────────────────
  { entry: 'run.json', kind: 'evidence', why: "the retired run's terminal ledger, kept byte-identical — that is the immutability invariant this runner refuses to punch." },
  {
    entry: 'run.json.corrupt',
    kind: 'evidence',
    why: 'the run ledger\'s bytes as they were when they stopped parsing, preserved BESIDE the file by the one '
      + 'writer allowed to heal it (run-settlement/projection.ts writeLegacyProjection). It is evidence in the '
      + 'strictest sense available: unparseable bytes nothing can read a bound out of, kept only so the loss is '
      + 'auditable. It belongs to the run that produced it, and the successor writes its own ledger. Not '
      + 'hypothetical and not a template — the heal path runs in exactly the corrupt-state incident this command '
      + 'recovers from.',
  },
  {
    entry: 'agents.json.corrupt',
    kind: 'evidence',
    why: 'the same quarantine, one file over: the live-agent registry\'s unparseable bytes, preserved by '
      + 'recordRunAgentUnlocked before the only whole-registry republisher heals over them. The registry ITSELF '
      + 'is carried (see agents.json), and this is not a second copy of it — it is the bytes no reader could '
      + 'parse, so it conserves no verifier-independence record and carrying it would only move a corpse.',
  },
  { entry: 'settlement-v2.json', kind: 'evidence', why: 'the hash-signed canonical settlement of the run that ended.' },
  { entry: 'maintenance.json', kind: 'evidence', why: 'the maintenance-run terminal verdict — and, through the settlement reconciler, one of the ways a run reaches `failed` without run-status.' },
  { entry: 'architecture-v1.json', kind: 'evidence', why: 'the compiled architecture contract; the successor compiles its own from source.' },
  { entry: 'architecture-input-v1.json', kind: 'evidence', why: 'the exact plan text the architecture contract was compiled from, kept so the compilation can be audited against its input.' },
  { entry: 'capability-v1.json', kind: 'evidence', why: 'the runtime capabilities frozen at that run\'s start; the successor freezes its own, which describes the machine it will actually run on.' },
  { entry: 'host-capability-v1.json', kind: 'evidence', why: 'the host capability snapshot frozen at that run\'s start; the successor freezes its own from the live host, which is the more accurate answer.' },
  { entry: 'baseline-v1.json', kind: 'evidence', why: 'the immutable pre-run snapshot the run\'s deltas are measured against; a successor measured against it would report the retired run\'s work as its own.' },
  { entry: 'assignments.json', kind: 'evidence', why: 'compiled per-role work units. It IS the write fence\'s authority, but it describes a plan for a run that ended; the successor republishes.' },
  { entry: 'verification-v2.json', kind: 'evidence', why: 'the hash-pinned required-checks list, recompiled per run from source.' },
  { entry: 'qa-acceptance-v1.json', kind: 'evidence', why: 'a signed acceptance of one specific QA report.' },
  {
    entry: 'qa-stack-resolution-v1.json',
    kind: 'evidence',
    why: 'what the QA RUNNER resolved for each required stack check in that run — the unforgeable half of the '
      + 'report exemption (shared/qa-report-v2/stack-resolution.ts), written run-scoped precisely so '
      + '`runtimeOwnedRunSidecar` refuses it to every agent. Dropping it can only make the successor STRICTER: '
      + '`stackCommandUndeclared` reads false on an absent record, so the successor is refused every exemption '
      + 'until its own runner resolves again (pinned by qa-evidence/__tests__/exemption-provenance.test.ts, "an '
      + 'honest exemption stops being granted when the runtime record is gone"). Carrying would also be inert: '
      + '`parse()` rejects a record whose `runId` is not the run being asked about, so a copy would have to be '
      + 'REWRITTEN under the successor\'s id to be readable at all — which is minting evidence for a run that '
      + 'resolved nothing.',
  },
  { entry: 'structure-report.json', kind: 'evidence', why: 'the react-structure scan output (its truncation flag is duplicated into scan-bound.json, which IS carried).' },
  { entry: 'quality-findings.jsonl', kind: 'evidence', why: 'batched findings folded into completion digests.' },
  { entry: 'superseded', kind: 'evidence', why: 'immutable claim history, already excluded from the active-claim scan by name.' },
  { entry: 'opencode-digest-units', kind: 'evidence', why: 'the per-role digest units produced by delegation during that run; they describe completed delegated work, not a budget.' },
  { entry: 'opencode-plan-block.md', kind: 'evidence', why: 'the plan directive text preserved verbatim for that run; the successor preserves its own when its plan is written.' },
  { entry: 'delegated-model-observations.json', kind: 'evidence', why: 'which model actually served a delegation; observational, gates nothing.' },
];

const BY_ENTRY = new Map(RUN_OBLIGATIONS.map((row) => [row.entry, row]));

export function obligationFor(entry: string): Obligation | null {
  return BY_ENTRY.get(entry) ?? null;
}

/**
 * Entries on disk under `runs/<id>/` that this table has not classified.
 *
 * DISK-DRIVEN, and that is the correction: this used to take a list of names
 * and treat EVERY top-level `*.json` as a per-session claim file, which made a
 * future gate's `budget.json` silently unreportable — the one shape the
 * enumeration most needs to catch. It also had no production and no caller, so
 * the header's claim that a test "drives a fixture run and fails on any entry
 * that reaches disk without a row" described nothing.
 *
 * Claim files are an open set by construction (named for the child's own thread
 * id), so they are still recognised by shape rather than listed — but by the
 * PRODUCT's own definition of the shape, not by the extension. `claims-store.ts
 * listClaimedAgentEntries` reads a top-level `*.json`, requires it to parse as
 * an object whose `role` is in VALID_AGENT_ROLES, and the sweep additionally
 * touches only rows carrying a `claimId`; role-bearing sidecars such as
 * `maintenance.json` are deliberately left alone. That is the test applied
 * here, so anything the claim machinery would not recognise as a claim is
 * reported rather than waved through.
 *
 * The atomic writers' own STAGING SIBLINGS are the second open set, and they get
 * a shape exclusion for the same reason rather than rows: their names carry a
 * pid, a counter or a random suffix, so there is no finite set to enumerate. They
 * are direct children of the run directory — every one is a sibling of its
 * destination — and the `finally` that unlinks them requires the process to
 * SURVIVE, so a kill or a power loss between write and rename leaves them behind,
 * which is precisely the residue incident this runner exists for. All three were
 * reported as undeclared. No laundering vector (a half-written staging file is not
 * a bound), but that was equally true of the lock class, and the property this
 * table claims is completeness of a SET.
 */
export function undeclaredRunEntries(dir: string): string[] {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const item of names) {
    const name = item.name;
    if (BY_ENTRY.has(name)) continue;
    if (item.isFile() && name.endsWith('.json') && isClaimFile(path.join(dir, name))) continue;
    if (item.isFile() && STAGING_SIBLING.test(name)) continue;
    out.push(name);
  }
  return out.sort();
}

/**
 * The three staging-sibling templates fsjson.ts writes, and nothing wider.
 *
 * `writeJson` stages `<dest>.<pid>.tmp`, `writeJsonDurable`
 * `<dest>.<pid>.<epochMs>.<hex>.tmp` and `writeJsonSet`
 * `<dest>.<pid>.<index>.set.tmp`. The `.json` is not decoration: all three
 * writers serialize JSON, so every destination they can stage against ends in
 * `.json` — which keeps a foreign `*.tmp`, the shape a future gate's own scratch
 * file would have, reported rather than waved through.
 */
const STAGING_SIBLING = /\.json\.\d+(?:\.\d+\.[0-9a-z]+|\.\d+\.set)?\.tmp$/;

function isClaimFile(file: string): boolean {
  const claim = obj(readJson<unknown>(file, null));
  if (!claim) return false;
  return typeof claim.claimId === 'string' && !!claim.claimId
    && typeof claim.role === 'string' && VALID_AGENT_ROLES.has(claim.role);
}

export interface CarryOutcome {
  /** Entries actually carried, for the caller to report. */
  readonly carried: readonly string[];
  /** Declared as carried but not persisted — non-fatal, and named. */
  readonly failed: readonly string[];
  /** The extra obligations a reset at or past WIDEN_AT imposes, for the caller
   *  to report. Derived from the same computation as `obligation` below, so a
   *  reported widening and a recorded one cannot disagree. */
  readonly widened: readonly string[];
  /**
   * What the successor OWES, for `recordReset` to persist in `.resets.json`.
   *
   * NOT A RESULT OF ANY CARRY, deliberately: it is computed from an unlocked
   * read of the retired run plus the retired run's own recorded obligation, so
   * no store lease is on its path and holding one cannot suppress it. That is
   * the whole of MAJOR 2 — see resets.ts ResetObligation for the six-cycle
   * measurement that moved it out of `exhausted-models.json`.
   */
  readonly obligation: ResetObligation;
}

const DENY_REPEATS = 'deny-repeats.json';

/**
 * How long a carry keeps insisting on a store's lease before reporting the row
 * as not carried.
 *
 * Each store's own acquire loop already waits — 2s for the agent registry and
 * the spawn store, 500ms for the model ledger — and then answers "busy". Those
 * budgets are sized for a HOOK, which must never stall a tool call and can
 * afford to skip a best-effort write. This caller is neither: it is a one-shot
 * operator command, it is the only writer that can move a bound out of a run
 * that is about to stop being read, and a lease it walks away from is a bound
 * the successor never receives. Measured against a real second process holding
 * the registry lease for 2.5s: a single attempt timed out and BOTH carried
 * verifier-independence rows were reported as failed and lost — the laundering
 * path this carry exists to close, reachable by anything that can hold a lock
 * for longer than a hook is willing to wait.
 *
 * So the answer to contention is to wait longer rather than to write anyway.
 * Bounded, because a lease whose holder is genuinely gone is reclaimed by the
 * lock's own staleness rules within this window, and because a reset that never
 * returns is worse than one that names what did not carry.
 *
 * ONE BUDGET FOR THE WHOLE CARRY, not one per store, and the difference is the
 * only thing about this number a reader should have to check. Three
 * independently-contended stores against a per-store budget is ~24s BY
 * CONSTRUCTION (measured: 8.8s with one real holder on one store); against a
 * shared deadline the whole carry is bounded by this figure plus the ONE inner
 * acquire loop each remaining store is entitled to (2s registry + 2s spawns +
 * 500ms exhaustion = 12.5s), because `underLease` always makes its first
 * attempt. MEASURED with three live holders, one per store: 12.54s, all three
 * named in `failed`; with one holder: 8.11s, and the other two carried. Nothing
 * is lost by sharing it: a store the deadline has already lapsed against still
 * gets that single attempt, which is exactly what a pre-budget carry gave every
 * store.
 *
 * None of it is paid under the project state lock any more — reset.ts's
 * `settleReset` runs the whole carry after the transaction has released — so
 * this budget now bounds only the operator's own one-shot command.
 */
const CARRY_LEASE_BUDGET_MS = 8_000;

/**
 * How long a lapsed attempt waits before the next one.
 *
 * THE LATENT HOT SPIN, closed rather than argued about. Both store acquire loops
 * can answer "not held" IMMEDIATELY and for reasons that are not contention — an
 * unusable lock PATH reports as "lease unavailable", not as a refused write, so
 * the docblock's "only contention is repeated" protection does not cover it — and
 * this loop had no sleep at all, so such a store would burn the whole budget on
 * back-to-back syscalls. A sleep costs a genuinely contended carry nothing (the
 * store's own 500ms-2s acquire loop dominates every iteration) and converts an
 * unbounded spin into ~40 iterations/second worst case.
 *
 * IT IS LOAD-BEARING AND THE BRANCH IS REACHABLE — which is the correction of
 * this docblock's previous claim, and the correction is about the FIXTURE, not
 * about the code. It said the defended state "needs an acquire that answers 'not
 * held' IMMEDIATELY, and no reachable input produces one", cited 571 attempts
 * against 564 without the sleep, and concluded the mutant was equivalent. Both
 * halves were wrong the same way: `acquireOwnedDirLock` (run-agent/locks.ts) has
 * exactly that immediate answer as its FIRST statement — `if
 * (!ensureDir(path.dirname(lockDir))) return null` — with no inner retry loop
 * behind it, and it is reached whenever the successor's run directory can
 * neither be found nor created. The 571-vs-564 fixture never executed that line:
 * its acquires all ran the store's own 2s inner loop, which dominates a 25ms
 * caller-side sleep completely, so the two numbers looked like noise BECAUSE THE
 * BRANCH WAS NEVER ENTERED.
 *
 * RE-MEASURED with `.traffic-one/runs` at mode 0500, so every acquire is
 * instant, over the same 8s budget and counting the acquire's own `mkdirSync`:
 *
 *   with this sleep      261 attempts,   195ms CPU over 8,003ms  (2%)
 *   with it removed    8,152 attempts, 2,492ms CPU over 8,036ms  (31%)
 *
 * 31x the syscalls for the same result. Pinned in
 * __tests__/obligations.test.ts, on that fixture, with the reachability of the
 * branch asserted before anything is measured — the general form of the mistake
 * being corrected is that a measurement taken where the code under test does not
 * execute is not evidence about that code, and "the numbers look like noise" is
 * a reason to check reachability first.
 */
const CARRY_LEASE_RETRY_MS = 25;

const CARRY_LEASE_WAIT = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(CARRY_LEASE_WAIT, 0, 0, ms);
  } catch {
    // Atomics.wait is unavailable on the main thread of some restricted hosts.
    const until = Date.now() + ms;
    while (Date.now() < until) { /* bounded spin */ }
  }
}

/** The one deadline every contended carry in a single `carryRunObligations`
 *  call shares. See CARRY_LEASE_BUDGET_MS. */
function carryLeaseDeadline(): number {
  return Date.now() + CARRY_LEASE_BUDGET_MS;
}

/**
 * Run `attempt` until it reports the lease was HELD, or `deadline` lapses.
 *
 * `attempt` distinguishes "the lease was not available" from "the write itself
 * refused": only the first is worth repeating, and treating a refused write as
 * contention would spin the whole budget on a read-only filesystem.
 */
function underLease<T>(attempt: () => { held: boolean; value: T }, busy: T, deadline: number): T {
  for (;;) {
    const outcome = attempt();
    if (outcome.held) return outcome.value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return busy;
    sleepSync(Math.min(CARRY_LEASE_RETRY_MS, remaining));
  }
}

// ── THE FIVE UNLEASED ROWS, and what each one's writer discipline is ────────
// Three of the eight carried rows take a store lease and are serialised by it.
// The other five have no lease anywhere in the product, so the ONLY thing
// standing between this carry and a concurrent product writer is the shape of
// the write. Enumerated, because "it was already like that" describes a defect
// rather than justifying one, and because a reader deciding to add a sixth row
// needs the rule rather than five precedents:
//
//   debug/deny-repeats.json   FLOORS, re-read and re-raised. The one row with a
//                             genuinely lossy neighbour (an unlocked
//                             read-increment-write), and the one with a residual
//                             — bounded and stated on carryDenyRepeats.
//   agent-activity/<role>.log APPEND, on the writer's own O_APPEND primitive.
//                             Was a read-modify-write and lost lines; see
//                             carryActivityLogs for the measurement.
//   agent-activity-denies/*   CREATE-IF-ABSENT, one file per marker. Presence is
//                             the whole value, so a concurrent creator writes
//                             the same fact; no shared document exists to lose
//                             an update from, and a partial read of a marker's
//                             diagnostic content cannot change a verdict.
//   scan-bound.json           MONOTONE FLAG, published only when the successor
//                             does not already hold it, by one atomic
//                             temp+rename. Both writers only ever set `bound`
//                             to true, so the field a reader looks at cannot
//                             regress whichever write lands second.
//   model-choice-prompted     CREATE-IF-ABSENT, same argument as the marker dir:
//                             the file's existence is the latch and its content
//                             is a stamp nothing branches on.
//
// So one row needed fixing, one needed a discipline it did not have, and three
// are lossless by construction rather than by luck.

/**
 * `debug/deny-repeats.json`, merged rather than copied: the successor may
 * already hold counts (nothing stops a gate firing between the pointer write
 * and this call), and the ladder is monotone, so the higher of the two is the
 * only answer that cannot lose a loop.
 *
 * PUBLISHED AS FLOORS, RE-READ AFTER WRITING, and both halves are the writer
 * discipline this row has and the product's own incrementer does not.
 * `deny-repeat.ts` countDenyRepeat is an unlocked read-increment-write, and
 * there is no lease anywhere on this file, so a plain merge-and-publish here
 * could be undone by the very next deny — it reads a base that predates our
 * write and republishes it. Raising floors is idempotent, so the loop below can
 * simply do it again; a merge that produced a whole document could not.
 *
 * THE RESIDUAL, stated: an increment landing between our read and our write is
 * still lost, and nothing available here closes it — the incrementer takes no
 * lock, so a lock taken only on this side serialises nothing. What bounds the
 * harm is what the counter DOES: it never blocks (deny-repeat.ts: "deliberately
 * does NOT block"), it only appends a STOP-RETRYING paragraph to a refusal that
 * was going to fire anyway, and the merge is a MAX, so the successor can never
 * end below the retired run's count. The cost of the whole window is therefore
 * at most one extra deny before the ladder escalates, against a file whose own
 * writer loses the same way to itself.
 */
function carryDenyRepeats(cwd: string, from: string, to: string): boolean | null {
  const source = path.join(runDir(cwd, from), 'debug', DENY_REPEATS);
  if (!fs.existsSync(source)) return null;
  const retired = readJson<Record<string, number>>(source, {}) || {};
  const floors: Record<string, number> = {};
  for (const [signature, count] of Object.entries(retired)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) continue;
    floors[signature] = count;
  }
  if (Object.keys(floors).length === 0) return null;
  return raiseCountFloors(path.join(runDir(cwd, to), 'debug', DENY_REPEATS), floors);
}

/** How many times a floor-raise re-reads and republishes before reporting the
 *  row not carried. TWO ARE STRUCTURAL — one pass raises, and the pass that
 *  finds its floors already standing is the verify that reports success — so a
 *  value of 1 reports every carry as failed even when its write landed. Three
 *  buys exactly one retry beyond that, which is the right shape for a file
 *  written by short, rare, unlocked increments: a third pass losing as well means
 *  a deny storm rather than a race worth waiting out. */
const CARRY_FLOOR_ATTEMPTS = 3;

function raiseCountFloors(target: string, floors: Record<string, number>): boolean {
  for (let attempt = 0; attempt < CARRY_FLOOR_ATTEMPTS; attempt += 1) {
    const current = readJson<Record<string, number>>(target, {}) || {};
    const merged = { ...current };
    let raises = false;
    for (const [signature, count] of Object.entries(floors)) {
      const held = typeof merged[signature] === 'number' ? merged[signature] as number : 0;
      if (held >= count) continue;
      merged[signature] = count;
      raises = true;
    }
    // Every floor already stands — including the pass right after our own write,
    // which is how this doubles as the verify. Writing again would only widen
    // the window for the next increment to fall into.
    if (!raises) return true;
    if (!writeJson(target, merged)) return false;
  }
  return false;
}

/**
 * `agent-activity/<role>.log`, CONCATENATED, and the merge rule is the whole
 * point of the function.
 *
 * The previous carry copied a directory entry by entry and skipped any target
 * that already existed. `carryDenyRepeats` next door MAX-merges and its comment
 * says why: a gate can fire between the pointer write and the carry, and the
 * higher of the two is the only answer that cannot lose a loop. The identical
 * window applies here, and skip-if-exists is on the losing side of it — one
 * tool call from a still-live child creates `<role>.log` in the successor
 * first, and a retired 120-call over-cap tally was then dropped whole, refunding
 * the exploration cap.
 *
 * Concatenation rather than a MAX, because the ladder and the tally count
 * different things. Two ladder files count DRAWS OF THE SAME SIGNATURE, where
 * the successor's number may already include what the retired one saw. Two
 * activity logs are append-only records of DISTINCT tool calls: every line in
 * the retired log is a call no line in the successor's log describes. Summing
 * them is not conservative, it is exact, and `readRunAgentActivity` counts
 * lines per child id, so order does not matter. Chained resets accumulate
 * correctly for the same reason.
 *
 * SO THIS ONE ROW IS NOT IDEMPOTENT — applying the same (from, to) pair twice
 * doubles the tally — and that is settled rather than merely noted, because the
 * doubling would be a real over-count of a real budget. Nothing can apply it
 * twice. The carry runs AFTER the pointer move, deliberately (reset.ts states
 * the order and why), so the crash window the question asks about is on the
 * other side: a crash mid-carry leaves `.one.json` already naming the
 * successor. Re-running the command cannot retry the carry from there — the
 * retired id refuses `not-current-run` and the successor id refuses
 * `run-not-failed` or `ledger-absent` depending on how far settlement got, all
 * three pinned on a reached window in reset.test.ts — and nothing else in `src/**`
 * calls `carryRunObligations`. A retry therefore does not exist to be doubled.
 * If a future caller ever wants one, this row is the one that has to change
 * first: append is the wrong shape for a resumable step, and per-child-id line
 * identity is what a resumable version would have to de-duplicate on.
 *
 * ── WRITTEN AS AN APPEND, because the OTHER writer is one ────────────────────
 * This used to read the successor's log, concatenate, and write the whole file
 * back. Every line of that file is put there by `bumpRunAgentActivity`, which
 * appends one line on an `O_APPEND` fd from any live child, and a
 * read-modify-write against an appender loses whatever lands between its two
 * halves. MEASURED against a child appending continuously: 2 lines of ~200,000
 * gone, in a 7ms window — small, and exactly the direction that refunds a cap.
 * The truncate also made the file briefly SHORT rather than briefly stale, so a
 * cap read racing the carry could see a tally near zero.
 *
 * The discipline is to use the writer's own primitive: one `O_APPEND` write per
 * retired log, no read of the target at all, so a concurrent bump cannot be
 * overwritten — it simply lands before or after ours. The leading newline is
 * what keeps our first line from fusing with a last line that has none;
 * `readRunAgentActivity` skips the blank line that produces when the file was
 * already newline-terminated, which is the ordinary case.
 *
 * The residual is stated rather than argued away: `appendAll` loops until the
 * payload is written, so a retired log large enough to need more than one
 * `write(2)` can have another child's line spliced between our chunks. Nothing
 * is LOST when that happens — both writers' bytes are in the file — and at most
 * the one line straddling the boundary is mis-attributed, which moves `total` by
 * zero and `bySession` by one. A whole-file rewrite loses lines outright, so
 * this is the strictly smaller failure, and it is the same one every appender in
 * this codebase already accepts.
 */
function carryActivityLogs(cwd: string, from: string, to: string): boolean | null {
  const source = path.join(runDir(cwd, from), 'agent-activity');
  const names = listFiles(source).filter((name) => name.endsWith('.log'));
  if (names.length === 0) return null;
  const targetDir = path.join(runDir(cwd, to), 'agent-activity');
  let ok = true;
  for (const name of names) {
    const retired = readText(path.join(source, name));
    if (retired === null || retired.trim() === '') continue;
    if (!appendTextFile(path.join(targetDir, name), `\n${withTrailingNewline(retired)}`)) ok = false;
  }
  return ok;
}

function withTrailingNewline(text: string): string {
  if (!text) return '';
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** A flat directory of PRESENCE markers, where existing is the whole value and
 *  the content is diagnostic. The merge is therefore a union: a marker either
 *  run holds is one the successor holds, and a target that already exists is
 *  left alone because both spellings mean the same "spent". */
function carryMarkerDir(cwd: string, from: string, to: string, entry: string): boolean | null {
  const source = path.join(runDir(cwd, from), entry);
  const names = listFiles(source);
  if (names.length === 0) return null;
  const targetDir = path.join(runDir(cwd, to), entry);
  let ok = true;
  for (const name of names) {
    const text = readText(path.join(source, name));
    if (text === null) continue;
    const target = path.join(targetDir, name);
    if (fs.existsSync(target)) continue;
    if (!writeTextFile(target, text)) ok = false;
  }
  return ok;
}

function listFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isFile())
      .map((item) => item.name);
  } catch {
    return [];
  }
}

/** `scan-bound.json`, merged as a boolean OR over the one field its reader
 *  looks at (`boundedScanTruncated`: `bound === true`). A floor either run
 *  raised stays raised; a successor that already raised it keeps its own reason
 *  and stamp rather than being overwritten with the retired run's. */
function carryScanBound(cwd: string, from: string, to: string): boolean | null {
  const source = path.join(runDir(cwd, from), 'scan-bound.json');
  const retired = obj(readJson<unknown>(source, null));
  if (!retired || retired.bound !== true) return null;
  const target = path.join(runDir(cwd, to), 'scan-bound.json');
  if (obj(readJson<unknown>(target, null))?.bound === true) return true;
  return writeJson(target, retired);
}

interface ExhaustedRoleShape {
  entries?: unknown;
  terminal?: unknown;
}

/**
 * `exhausted-models.json` at sub-key granularity: the TTL `entries`, and ONLY
 * the entries.
 *
 * The non-expiring `terminal` marker is no longer copied here at any reset
 * count. It travels as a recorded obligation instead (`.resets.json`, one
 * writer, no lease), because a price paid into the store the actor is defeating
 * is defeated by the same capability — see resets.ts ResetObligation for the
 * six-cycle measurement. A successor's OWN terminal marker is untouched: this
 * merge only ever adds entries.
 *
 * Written in the reader's own v2 shape (`{version:2, roles:{…}}`), which
 * `readStore` normalizes anyway, so a legacy retired file is upgraded by being
 * carried. Entries are unioned per model with the LATER stamp kept — never the
 * earlier one, which would shorten a live condemnation — and an entry with no
 * stamp at all (a legacy row, which never expires within a run) beats every
 * stamped one for the same reason.
 *
 * UNDER THE STORE'S OWN LEASE. Every product writer of this file serializes on
 * `exhausted-models.json.lock`; the project state lock this runner holds is a
 * different path and a different lease and excludes none of them. Not through
 * `recordExhaustedModel`, which would be the tidier route and is the wrong one:
 * it stamps the entry with the CALLER's clock and prunes the store against it,
 * so replaying a retired stamp would both shorten the condemnation this merge
 * exists to preserve and expire a successor entry stamped later.
 */
function carryExhaustedModels(cwd: string, from: string, to: string, deadline: number): boolean | null {
  const retired = readExhaustedRoles(path.join(runDir(cwd, from), 'exhausted-models.json'));
  if (!retired) return null;
  // The busy answer is a SENTINEL rather than a plausible value: this store's
  // lock reports contention by handing back the fallback, so a fallback that
  // could also be a real result would make the two indistinguishable.
  const busy = Symbol('busy');
  return underLease<boolean | null>(() => {
    const result = withExhaustedModelsLock<boolean | null | typeof busy>(
      cwd, to, busy, () => mergeExhaustedModels(cwd, to, retired),
    );
    return result === busy ? { held: false, value: false } : { held: true, value: result };
  }, false, deadline);
}

/** The merge itself, and it runs ONLY under the lease taken above: the target
 *  is read here, inside the hold, so a recorder that lands between the retired
 *  read and this write is merged rather than overwritten. */
function mergeExhaustedModels(
  cwd: string,
  to: string,
  retired: Record<string, ExhaustedRoleShape>,
): boolean | null {
  const target = path.join(runDir(cwd, to), 'exhausted-models.json');
  const merged = readExhaustedRoles(target) ?? {};
  let anything = false;
  for (const [role, state] of Object.entries(retired)) {
    const retiredEntries = Array.isArray(state.entries) ? state.entries : [];
    const current = merged[role] ?? { entries: [] };
    const currentEntries = Array.isArray(current.entries) ? [...current.entries] : [];
    for (const raw of retiredEntries) {
      const entry = obj(raw);
      const model = typeof entry?.model === 'string' ? entry.model.trim() : (typeof raw === 'string' ? raw.trim() : '');
      if (!model) continue;
      const index = currentEntries.findIndex((item) => modelOf(item) === model);
      if (index < 0) {
        currentEntries.push(raw);
      } else if (laterStamp(currentEntries[index], raw)) {
        currentEntries[index] = raw;
      }
      anything = true;
    }
    const next: ExhaustedRoleShape = { entries: currentEntries };
    // The SUCCESSOR's own marker, preserved. The retired run's never arrives
    // here — it is recorded as an obligation instead.
    if (current.terminal) next.terminal = current.terminal;
    if (currentEntries.length || next.terminal) merged[role] = next;
  }
  if (!anything) return null;
  return writeJson(target, { version: 2, roles: merged });
}

/**
 * The roles whose terminal exhaustion the successor inherits — the whole of the
 * widening, computed WITHOUT taking a single lease.
 *
 * Two sources, unioned, and the second one is what makes a chain of resets
 * unable to walk away from the price one hop at a time:
 *
 *   - the RETIRED RUN's own `roles[*].terminal` markers, read with a plain
 *     unlocked read (every product reader of this store reads it unlocked too —
 *     `readStore` takes no lease);
 *   - the obligation ALREADY RECORDED against the retired run, because after
 *     this change a widened marker never lands in a successor's store file, so
 *     the retired run's file is not where a previously-imposed obligation lives.
 *
 * Under WIDEN_AT the answer is empty: the first two recoveries are free, which
 * is the decision WIDEN_AT documents and this function does not revisit.
 */
function terminalRolesToWiden(cwd: string, from: string, widen: boolean): string[] {
  if (!widen) return [];
  const roles = new Set(resetObligationFor(cwd, from).terminalRoles);
  const retired = readExhaustedRoles(path.join(runDir(cwd, from), 'exhausted-models.json')) ?? {};
  for (const [role, state] of Object.entries(retired)) {
    if (state.terminal) roles.add(role);
  }
  return [...roles].sort();
}

function readExhaustedRoles(file: string): Record<string, ExhaustedRoleShape> | null {
  const raw = obj(readJson<unknown>(file, null));
  if (!raw) return null;
  const source = obj(raw.roles) ?? raw;
  const out: Record<string, ExhaustedRoleShape> = {};
  for (const [role, value] of Object.entries(source)) {
    if (role === 'version' || role === 'roles') continue;
    if (Array.isArray(value)) out[role] = { entries: value };
    else {
      const state = obj(value);
      if (!state) continue;
      out[role] = {
        entries: Array.isArray(state.entries) ? state.entries : (Array.isArray(state.models) ? state.models : []),
        ...(state.terminal ? { terminal: state.terminal } : {}),
      };
    }
  }
  return Object.keys(out).length ? out : null;
}

function modelOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const entry = obj(value);
  return typeof entry?.model === 'string' ? entry.model.trim() : '';
}

/** True when `candidate` condemns for LONGER than `current` — a missing stamp
 *  never expires within a run, so it outranks every stamped row. */
function laterStamp(current: unknown, candidate: unknown): boolean {
  const a = stampOf(current);
  const b = stampOf(candidate);
  if (b === null) return true;
  if (a === null) return false;
  return b > a;
}

function stampOf(value: unknown): number | null {
  const at = obj(value)?.at;
  if (typeof at !== 'string') return null;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `agents.json`, merged per role with the SUCCESSOR winning: a child that bound
 * in the successor between the pointer write and this call is never overwritten
 * by the retired run's row for the same role, while every role only the retired
 * run recorded still arrives — which is what keeps verdictAgentConflict able to
 * see the id it has to refuse. Every other top-level field (the replacement
 * `history`) comes from whichever side has one, successor first.
 *
 * UNDER THE REGISTRY'S OWN LEASE, and that is not belt-and-braces. Every
 * product writer of this file goes through `withAgentRegistryLock`, and the
 * project state lock this runner holds is a different path and a different
 * lease, so it excludes none of them. Reproduced with a second real process:
 * the pointer moves, a live child in the successor takes the registry lease and
 * starts its own read-modify-write, an unlocked carry writes straight through
 * it, and the child then commits the base it had read — both carried
 * verifier-independence rows gone, which is the exact laundering path this row
 * exists to close. The reverse interleaving loses the child's own row, which is
 * what the successor-wins rule exists to prevent.
 *
 * ONLY THE TARGET'S LEASE IS TAKEN, and only the target is read inside it. Two
 * held at once would be a lock-ordering hazard for a gain that is not
 * available anyway: the retired run keeps writers (rule 4 — this transaction
 * releases claims, it kills nothing), so a stale retired read can lose a row
 * recorded after the pointer moved. That row describes a run nothing resolves
 * as current; the successor's rows are the ones a gate reads.
 */
function carryRunAgents(cwd: string, from: string, to: string, deadline: number): boolean | null {
  const retired = obj(readJson<unknown>(path.join(runDir(cwd, from), 'agents.json'), null));
  const retiredAgents = obj(retired?.agents);
  if (!retired || !retiredAgents || Object.keys(retiredAgents).length === 0) return null;
  return underLease(() => {
    let wrote = false;
    const held = withAgentRegistryLock(cwd, to, () => {
      const target = path.join(runDir(cwd, to), 'agents.json');
      const current = obj(readJson<unknown>(target, null)) ?? {};
      const currentAgents = obj(current.agents) ?? {};
      wrote = writeJson(target, {
        ...retired,
        ...current,
        agents: { ...retiredAgents, ...currentAgents },
      });
    });
    // A lease we never got is worth waiting for; a write that refused is not.
    return { held, value: wrote };
  }, false, deadline);
}

/**
 * `cursor-spawns.json`, merged by `toolCallId` with the successor winning,
 * under the store's own lease and THROUGH THE STORE'S OWN READER AND WRITER.
 *
 * The lock for the reason `carryRunAgents` takes one. The reader/writer because
 * this merge used to re-implement the store's newest-wins 128-row cap as a
 * literal and then claim, in this comment, that the carry "can never hand the
 * reader a store it would truncate differently" — true only for as long as two
 * copies of the rule agreed by hand. `writeCursorSpawnObservationStore` applies
 * the ordering and the cap, so the claim is now structural.
 *
 * ── THE SUPPRESSION STAMP, AND THE ROWS IT MAY NOT BE APPLIED TO ─────────────
 * A carried row that RESOLVED in the retired run is a finished resolution
 * rather than a fresh observation, and refreshPendingResolution refuses to
 * re-derive one: re-derivation against the successor re-mints, from that row's
 * own carried inputs, the two bounds the table next door deliberately withholds.
 * The stamp of an already-carried row is left alone, so a chained reset keeps
 * naming the run that actually saw the spawn.
 *
 * `outcome !== null && directive !== null` IS THE CONDITION, and it is the whole
 * of the row's soundness. The stamp means ALREADY RESOLVED IN AN EARLIER RUN, and
 * a resolution is the DIRECTIVE: it is what `resolutionFor` produces, what the
 * follow-up driver requires before it will emit anything, and the only thing a
 * suppressed re-derivation could have preserved. A row with no directive has no
 * resolution to keep, so suppressing its derivation conserves nothing and costs
 * the successor the only route by which that failure reaches its parent.
 *
 * BOTH WEAKER SPELLINGS ARE REACHABLE, and each loses a different half:
 *
 *   `true` (stamp everything) stamps a row with NO outcome, and those rows exist
 *   BY CONSTRUCTION: rule 4 above — this transaction releases claims and
 *   terminates nothing — so a child spawned in the retired run and still alive at
 *   reset time has exactly that row. It fails in the SUCCESSOR, the outcome is
 *   recorded onto the same row, and the stamp (which nothing clears) makes the
 *   refresh hand the row straight back.
 *
 *   `outcome !== null` stamps the WINDOW, and the window is a two-write sequence
 *   the product performs on every correlated failure:
 *   cursor-failure-persist.ts `persistTerminalClassification` writes the outcome,
 *   and only then does `finalizeTerminalObservation` — or, on a head finalized
 *   without one, the parent's own follow-up pass through
 *   `refreshPendingResolution` — derive the directive. Between those two writes a
 *   row has an outcome and no resolution. A reset landing there stamped a row
 *   whose resolution had never been derived, and the stamp then permanently
 *   suppressed the derivation.
 *
 * Both end in the same place, and MEASURED against a control differing only in
 * whether a reset landed in the window: the control ends with `stamp: null`, a
 * directive and ONE follow-up; with the reset, `stamp: <retired id>`, no
 * directive and ZERO. The parent is never told its child died, and the silence is
 * permanent because the stamp survives every subsequent reset. That is not the
 * bound this row conserves; it is a liveness hole, and the Phase 1 exit criterion
 * is a matrix in which every cell permits at least one action.
 *
 * WHAT THE WINDOW COSTS INSTEAD, stated rather than hidden: an unstamped window
 * row IS re-derived in the successor, so its resolution can mint — from carried
 * inputs — the terminal exhaustion marker the table withholds until WIDEN_AT.
 * That is the strict direction and it is bounded by the window (one row, one
 * reset, only while the retired run's own follow-up pass had not yet run). It
 * buys the successor a refusal, never a permission, so it is not a laundering
 * vector; suppressing it costs the parent the death notice, which is not
 * recoverable by anything the agent can reach. Over-strict is live; silent is
 * not.
 */
function carryCursorSpawns(cwd: string, from: string, to: string, deadline: number): boolean | null {
  const retired = readCursorSpawnObservationStore(cwd, from).observations;
  if (retired.length === 0) return null;
  return underLease(() => {
    let wrote = false;
    const done = withCursorSpawnObservationLock(cwd, to, (): boolean => {
      const byId = new Map<string, CursorSpawnObservation>();
      for (const row of retired) {
        byId.set(row.toolCallId, isFinishedResolution(row)
          ? { ...row, carriedFromRunId: row.carriedFromRunId || from }
          : row);
      }
      for (const row of readCursorSpawnObservationStore(cwd, to).observations) byId.set(row.toolCallId, row);
      // The writer's own answer, not the lease's. It used to be discarded — the
      // store writer returned void — so a REFUSED write was reported as carried,
      // in the warnings and in the audit record, while the neighbouring carry
      // propagated its writer's boolean.
      wrote = writeCursorSpawnObservationStore(cwd, to, [...byId.values()]);
      return true;
    });
    return { held: done === true, value: done === true && wrote };
  }, false, deadline);
}

/** A spawn observation the retired run finished with: an outcome AND the
 *  directive that outcome resolved to. See carryCursorSpawns for why both, and
 *  for the two weaker spellings and what each one silences.
 *
 *  WHICH CONJUNCT IS LOAD-BEARING, since a mutation campaign asks and only one
 *  of the two answers is honest: `directive !== null` is. Dropping it is the
 *  blocker, pinned by carry-integrity's window test.
 *
 *  Dropping `outcome !== null` changes no reachable behaviour — but NOT for the
 *  reason recorded here until round 8, which was "the only two writers of
 *  `directive` both patch a row whose outcome was persisted first, so no product
 *  path produces a directive without one". That is refutable and was refuted: a
 *  `{outcome: null, directive: <string>}` row was built through the product's own
 *  store writer and read back, because the store validates each field's SHAPE and
 *  never their PAIRING. A hand-edited store is this command's stated target
 *  population, so the state is reachable.
 *
 *  The real reason is at the consumer, and it survives a third writer appearing:
 *  `carriedFromRunId` has exactly ONE reader, `refreshPendingResolution`, which
 *  returns at `!observation.outcome` (cursor-failure-select.ts:189) BEFORE it
 *  reaches `if (observation.carriedFromRunId) return observation` (:208). A stamp
 *  on an outcome-null row is therefore inert at the only place that reads it.
 *  The conjunct stays because the stamp asserts "resolved earlier" about a
 *  resolution that was never derived — a false record, even an inert one, and the
 *  same class of thing as the window row. */
function isFinishedResolution(row: CursorSpawnObservation): boolean {
  return row.outcome !== null && row.directive !== null;
}

/**
 * `model-choice-prompted`, carried ONLY while the latch is genuinely pending.
 *
 * The marker means two different things depending on its neighbour. With no
 * `model-choice.json` it is the pause `modelChoiceReplyPending` reads and two
 * gates deny on — a latch waiting on a human, which a pointer move must not
 * release. With a recorded choice it means only "do not prompt again", and
 * copying it forward while the answer stays behind would invent a pause the
 * retired run was never in: the successor would read pending with no prompt
 * left to fire. So the retired run's own answer decides, and the file is copied
 * verbatim (its content is a stamp, not a value).
 *
 * "ITS OWN ANSWER" IS THE PRODUCT'S READER, NOT THE FILE'S EXISTENCE, and the
 * two are not the same question. `modelChoiceReplyPending` short-circuits on
 * `readModelChoice(...) !== null`, which PARSES; an `existsSync` here declined
 * the carry for a `model-choice.json` holding an unrecognised status, or the
 * truncated bytes the writer's own refusal path documents. Both reproduced: the
 * retired run is genuinely paused on a human reply, the carry declines, and the
 * pointer move releases a latch waiting on a human — the one thing this row's
 * justification says it must never do. Asking the reader answers the question
 * the latch is actually defined by, so an unparseable answer is no answer and
 * the pause follows.
 */
function carryModelChoiceLatch(cwd: string, from: string, to: string): boolean | null {
  const source = path.join(runDir(cwd, from), 'model-choice-prompted');
  const stamp = readText(source);
  if (stamp === null) return null;
  if (readModelChoice(cwd, from) !== null) return null;
  const target = path.join(runDir(cwd, to), 'model-choice-prompted');
  if (fs.existsSync(target)) return true;
  return writeTextFile(target, stamp);
}

export interface CarryOptions {
  /**
   * How many resets this project had ALREADY recorded before the one being
   * performed. At or past WIDEN_AT the carry widens; see WIDEN_AT.
   */
  readonly priorResets?: number;
}

/**
 * Carry every `bound-carried` obligation from the retired run to its successor.
 *
 * BEST-EFFORT AND NON-FATAL, deliberately: this runs AFTER the pointer has
 * moved, so a failure here leaves a recovered project that is missing part of
 * an obligation, while turning it fatal would leave a project pointed at a run
 * whose claims are about to be released. The caller reports what did not carry
 * rather than pretending it did — see reset.ts's warnings, which is the same
 * shape the claim release already uses.
 *
 * "NON-FATAL" IS ENFORCED PER ROW, because it was documented and false. Not one
 * of these carries had an error boundary, and the first statement of a store lock
 * is an unguarded recursive directory create: a NON-DIRECTORY occupying the
 * successor's run path (a file planted at `runs/<fresh>`, and one byte is enough)
 * made `withAgentRegistryLock` throw, and the exception propagated through this
 * function, through the transaction, and out of the CLI as a stack trace. What
 * that cost was not one row: the pointer had already moved, the retired claims
 * were already released, and the THREE carries after the thrower never ran —
 * including the verifier-independence record this table calls the deciding axis —
 * with no warning naming them, because the caller that assembles warnings never
 * resumed. A boundary per row keeps the remaining rows running and puts every
 * thrower in `failed`, where the caller already reports it.
 */
export function carryRunObligations(cwd: string, from: string, to: string, options: CarryOptions = {}): CarryOutcome {
  const carried: string[] = [];
  const failed: string[] = [];
  const widened: string[] = [];
  const record = (entry: string, outcome: boolean | null): void => {
    if (outcome === null) return;
    (outcome ? carried : failed).push(entry);
  };
  /** One row, and its throw is that row's failure rather than the reset's. */
  const attempt = <T>(entry: string, carry: () => T, thrown: T): T => {
    try {
      return carry();
    } catch {
      failed.push(entry);
      return thrown;
    }
  };
  const priorResets = typeof options.priorResets === 'number' && Number.isFinite(options.priorResets)
    ? Math.max(0, Math.floor(options.priorResets))
    : 0;
  // The reset being performed is the (priorResets + 1)-th, so the third one
  // widens: two free recoveries, then the cost.
  const widen = priorResets + 1 >= WIDEN_AT;
  const deadline = carryLeaseDeadline();

  record(`debug/${DENY_REPEATS}`,
    attempt(`debug/${DENY_REPEATS}`, () => carryDenyRepeats(cwd, from, to), null));
  record('agent-activity', attempt('agent-activity', () => carryActivityLogs(cwd, from, to), null));
  record('agent-activity-denies',
    attempt('agent-activity-denies', () => carryMarkerDir(cwd, from, to, 'agent-activity-denies'), null));
  record('scan-bound.json', attempt('scan-bound.json', () => carryScanBound(cwd, from, to), null));
  record('exhausted-models.json',
    attempt('exhausted-models.json', () => carryExhaustedModels(cwd, from, to, deadline), null));
  // NOT inside `attempt`, and not conditional on any carry above: this is the
  // price, and the whole point of re-siting it is that no store's availability
  // decides whether it is paid. Its two inputs are unlocked reads; the write is
  // the caller's `recordReset`, which happens even when every carry failed.
  const terminalRoles = terminalRolesToWiden(cwd, from, widen);
  if (terminalRoles.length) {
    widened.push(`exhausted-models terminal: ${terminalRoles.join(', ')}`);
  }
  record('agents.json', attempt('agents.json', () => carryRunAgents(cwd, from, to, deadline), null));
  record('cursor-spawns.json',
    attempt('cursor-spawns.json', () => carryCursorSpawns(cwd, from, to, deadline), null));
  record('model-choice-prompted', attempt('model-choice-prompted', () => carryModelChoiceLatch(cwd, from, to), null));

  return { carried, failed, widened, obligation: { terminalRoles } };
}
