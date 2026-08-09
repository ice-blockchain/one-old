// src/shared/state/deny-expectation.ts
// Was a refusal's REMEDY ever applied?
//
// Every gate in this product refuses in the same shape: "do X, then re-issue".
// Nothing anywhere establishes whether X happened. The run simply carries on,
// and a remedy the agent silently walked away from is indistinguishable — in
// the decision log, in the digest, in the settlement — from one it applied.
// state/deny-repeat.ts is the nearest thing and it answers the opposite
// question: how many times the SAME refusal fired. A loop that stops looping
// looks identical there whether it stopped because the agent fixed the cause or
// because the agent gave up on the action.
//
// This module holds the missing half: a bounded ledger of refusals whose remedy
// was PRESCRIBED and not yet observed, opened at the pipeline's deny exit,
// closed at the pipeline's PostToolUse, and discharged as a report at the
// pipeline's UserPromptSubmit. Like deny-repeat.ts it lives at the CHOKEPOINT
// and nowhere else, for the same reason: a per-gate rule is one every future
// gate author has to remember, and forgetting it is silent.
//
// ── WHICH refusals get one, mechanically ────────────────────────────────────
// Not all of them, and the rule is a PREDICATE rather than a list, so a deny id
// added tomorrow is classified without anyone editing this file.
//
//   an expectation is opened  ⟺  the refusal ESCALATED  ∧  it has a SUBJECT
//
// ESCALATED means deny-repeat.ts returned a count that reached
// DENY_REPEAT_ESCALATE_AT — the same third byte-identical attempt at which the
// deny text stops being informational and starts issuing instructions ("STOP
// RETRYING … do exactly one of: (a) apply the remedy above literally … (b)
// report it in your digest … (c) write your digest with verdict `BLOCKED`").
// Before that moment nothing has been prescribed and there is nothing to be
// unmet; after it, the product has told the agent, in writing, to do one of
// three specific things, and this is the only thing that ever checks.
//
// Reusing that predicate rather than inventing a parallel one is the whole
// point. config/deny-ids.ts already classifies every id against a written bar
// — "THE AGENT RE-ISSUING THIS IS NOT A LOOP THE AGENT CAN BREAK" — and
// escalation is exactly the complement: the refusals with an in-session remedy
// the deny text already names. A new id is escalatable BY DEFAULT (absent from
// NEVER_ESCALATED_DENY_IDS), so it is covered here automatically; an id added
// to that list drops out of here in the same edit, argued once. A second
// hand-maintained roster would diverge from that one on its first entry, and
// the direction it diverged in would be a hole — the argument
// NEVER_OVERRIDABLE_DENY_IDS's own header makes about keeping one list.
//
// It also makes the population SMALL without choosing a number. Measured in
// 17cl (deny-repeat.ts's own corpus): 25 denies in one run, 15 of them repeats
// of four (file, reason) pairs, and ONE pair reached seven. So the escalating
// population is single-digit per run, and the frequent case — a first or second
// refusal the agent then satisfies — writes nothing at all.
//
// A SUBJECT is `tool.filePath` or, failing that, `tool.command`: the thing the
// refused call was about, as the host adapter delivered it. A refusal with
// neither (a spawn refused by role, a policy denial, an apply_patch envelope
// spanning many files) is EXCLUDED, and that exclusion is structural rather
// than editorial: satisfaction here is observed by seeing the same action
// complete, so a refusal with no recognisable action can only ever produce an
// entry that is unsatisfiable by construction. Recording one would manufacture
// exactly the false report this detector exists to avoid.
//
// The pipeline's fail-closed crash deny is excluded too, and separately: it is
// not a gate prescribing a remedy, it is the pipeline failing to decide, and
// its "resolve the Traffic One setup/plugin error" is repaired outside the run.
//
// ── WHAT "satisfied" means, and why the evidence is a PROOF ─────────────────
// An expectation is satisfied when a PostToolUse arrives for the same subject.
//
// That is not a proxy. A PostToolUse means the call ran, which means no gate
// denied it; gates are pure functions of on-disk state (deny-repeat.ts's
// header), so the gate that refused this subject three times would have refused
// it again had the state it objected to not moved. A completed call on the same
// subject therefore PROVES the objection is gone — which is what the remedy was
// for — without this module knowing anything about which gate it was or what it
// wanted.
//
// Two consequences, both deliberate:
//   - the tool's own success is irrelevant. The expectation is about the
//     REFUSAL being resolved, not about the command exiting 0, and a failing
//     command that the gate now permits has still had its remedy applied.
//   - the tool CLASS is not part of the key. `Write`, `Edit`, `MultiEdit` and
//     `apply_patch` are four classes for one act, and a retry through a
//     different one is the same remedy; keying on the class would report it
//     unmet.
//
// The subject is compared as the adapter spelled it, with no path
// normalisation. A retry that spells the same file differently (absolute where
// the refused call was relative) is a MISS, and a miss under-reports — the safe
// direction here, and the reason this is a named limit rather than a heuristic
// that guesses two spellings are one file.
//
// ── WHAT HAPPENS WHEN IT IS UNMET, and why this is the safe direction ───────
// It becomes CONTEXT on the next UserPromptSubmit. Never a deny, on any event.
//
// The tempting alternative — refuse something until the remedy lands — wedges
// runs, and wedges them in the one shape nothing can act its way out of. The
// remedy may be genuinely unsatisfiable (the deny's own option (b) is "report
// it in your digest and let the orchestrator route it to the role that owns
// it", i.e. this agent must NOT re-issue the action), so a detector that
// demanded satisfaction would refuse an agent for correctly obeying the
// instruction that created the expectation. Its own worst case would then be
// permanent. This one's worst case is a paragraph nobody reads.
//
// So the failure direction is stated plainly: THIS DETECTOR CAN ONLY EVER ADD
// INFORMATION. It changes no verdict, it is emitted only on an event where a
// merged context result cannot block anything, and every path through it that
// cannot complete produces silence rather than a claim. Under-reporting is the
// direction it fails in — a refused write, an unusable stamp, a retry spelled
// differently, a run whose human never types again all lose the report and
// nothing else.
//
// UserPromptSubmit is the reporting event because it is the only one in the
// canonical vocabulary that means THE PREVIOUS AGENT TURN IS OVER, which is
// precisely when an outstanding remedy has stopped being work-in-progress. It
// needs no grace period and so invents no number, it fires at most once per
// human message, and it is the product's primary context channel on every host.
// Stop was rejected on measured host behaviour rather than taste: a Stop
// `context` serialises to `hookSpecificOutput.additionalContext` on Claude,
// which documents no such field for that event, and adapters/cursor.ts warns
// that anything other than `followup_message` there "could prevent Cursor from
// enqueueing the turn" — a reporting channel that might wedge a turn end is the
// one thing this must not be.
//
// A report DISCHARGES the expectation: the entry is removed, so each one is
// reported exactly once and the ledger shrinks rather than accumulating a
// `reported` flag nothing reclaims.
//
// ── THE BOUND ───────────────────────────────────────────────────────────────
// Three bounds, all borrowed:
//   - AGE. An entry older than SUBAGENT_STALE_MS (config/state.ts:103, this
//     repo's canonical "this run-scoped agent state is no longer live" window)
//     is reclaimed on the next touch, and so is one whose stamp no clock could
//     have produced (shared/clock-skew.ts). Reclaiming is the bounded direction
//     for both.
//   - CARDINALITY. 64 entries, the bound deny-repeat.ts:37 puts on the counter
//     table this ledger is a strict SUBSET of — an entry can exist only for a
//     signature that counter has already counted to DENY_REPEAT_ESCALATE_AT, so
//     any other number would be a guess, and a larger one would let a derived
//     table outgrow its source. Eviction drops the oldest, which is the entry
//     the age sweep was about to take anyway.
//   - SIZE. Every string stored or rendered goes through `shrink`
//     (state/claim-capture.ts) — the same truncation contract core/pipeline.ts
//     already applies to the decision log's `inputs`, capping a string at 240
//     characters and a list at 20 entries.
//
// The outer reclamation is not this module's at all, which is why it lives in
// `.traffic-one/debug/` rather than anywhere new: shared/retention.ts:432
// already sweeps that directory by TTL, DECLINE_ALWAYS_REMOVED
// (state/plugin-use.ts:416) already deletes it wholesale when a project
// declines, and `debug/` is already in TRAFFIC_ONE_RUN_STATE_ENTRIES
// (architecture-contract/scaffold-content.ts:507), so the generated gitignore
// block covers the file without an entry being added for it.
//
// ── THE FENCE ───────────────────────────────────────────────────────────────
// Every mutation goes through shared/fsjson.ts's chokepoint, so a project whose
// use-plugin question is unanswered gets NOTHING: no ledger, no report, and the
// byte-identity contract holds without this module knowing consent exists. The
// refusal is consumed at every one of the three call sites rather than dropped
// — `openDenyExpectation` answers false, `satisfyDenyExpectation` answers
// `'refused'`, and `takeUnmetDenyExpectations` hands back an EMPTY list, so the
// notice is emitted only when the record of having reported it persisted. That
// last one is the load-bearing one: it is the same rule deny-repeat.ts states
// for its count ("escalate only on a count we actually wrote").
//
// No MACHINE_OWNED_ENTRIES declaration is needed or wanted. The ledger is
// ordinary project state, so on a $HOME-rooted session it is fenced by that
// project's own pending answer exactly as intended — the deadlock that
// exemption exists to prevent is for writers that must run BEFORE consent, and
// a diagnostic must not be one of them.

import * as path from 'path';

import { STATE_DIR } from '../../config/paths';
import { SUBAGENT_STALE_MS } from '../../config/state';
import { isNonProjectRoot } from '../authoring-root';
import { trustworthyAgeSince } from '../clock-skew';
import { readJson, writeJson } from '../fsjson';
import { shrink } from './claim-capture';
import { stateTimestamp } from './io';

/** The bound deny-repeat.ts:37 puts on the table this ledger is a subset of. */
const MAX_OPEN_EXPECTATIONS = 64;

interface DenyExpectationEntry {
  /** The declared cause, for the report. Never the key: two gates refusing one
   *  subject are one remedy, and one completed call resolves both. */
  readonly denyId: string;
  /** When the escalation was issued (stateTimestamp, ISO). */
  readonly at: string;
  /** The run it was issued in, for an operator reading the file. Not logic:
   *  resolving the current run would cost a `.one.json` read on PostToolUse,
   *  which is the whole reason this ledger is project-scoped rather than
   *  run-scoped. Age reclamation covers what run rotation would have. */
  readonly runId: string;
}

type Ledger = Record<string, DenyExpectationEntry>;

/** One unmet expectation, as handed to the caller that will report it. */
export interface UnmetDenyExpectation {
  readonly subject: string;
  readonly denyId: string;
  readonly at: string;
}

function ledgerPath(cwd: string): string {
  return path.join(cwd, STATE_DIR, 'debug', 'deny-expectations.json');
}

/** The bounded key. `shrink` rather than a private slice so a subject is
 *  truncated by the same contract on the way in and on the way out — two
 *  spellings of one truncation rule is two ways for a key to miss itself. */
function boundedSubject(value: string): string {
  return String(shrink(value.trim()));
}

/**
 * What this refusal is ABOUT, or '' when nothing recognisable.
 *
 * Structural rather than `ToolInput`: shared/ does not depend on core/ for a
 * shape this small, the same call deny-repeat.ts's DenyRepeatInput makes, and it
 * keeps this callable from a test with no pipeline.
 */
export function denyExpectationSubject(
  tool: { readonly filePath?: string; readonly command?: string } | undefined,
): string {
  const filePath = (tool?.filePath ?? '').trim();
  if (filePath) return boundedSubject(filePath);
  const command = (tool?.command ?? '').trim();
  return command ? boundedSubject(command) : '';
}

/**
 * Live entries only, oldest first. Applies both reclamation rules on every read,
 * so nothing needs a sweep of its own: an entry older than SUBAGENT_STALE_MS or
 * carrying a stamp no clock could have produced is gone, and what survives is
 * capped at MAX_OPEN_EXPECTATIONS.
 */
function liveEntries(cwd: string, nowMs: number): [string, DenyExpectationEntry][] {
  const raw = readJson<Ledger>(ledgerPath(cwd), {} as Ledger);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const live: [string, DenyExpectationEntry][] = [];
  for (const [subject, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Partial<DenyExpectationEntry>;
    const at = typeof entry.at === 'string' ? entry.at : '';
    const age = trustworthyAgeSince(Date.parse(at), nowMs);
    if (age === null || age > SUBAGENT_STALE_MS) continue;
    live.push([subject, {
      denyId: typeof entry.denyId === 'string' ? entry.denyId : '',
      at,
      runId: typeof entry.runId === 'string' ? entry.runId : '',
    }]);
  }
  live.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at));
  return live.slice(-MAX_OPEN_EXPECTATIONS);
}

function toLedger(entries: readonly [string, DenyExpectationEntry][]): Ledger {
  const out: Ledger = {};
  for (const [subject, entry] of entries) out[subject] = entry;
  return out;
}

/**
 * Record that a refusal of `subject` has escalated and its remedy has not been
 * observed. Answers whether the record actually PERSISTED — the caller has no
 * verdict to change on a refusal (a diagnostic may never move a gate) but it
 * must not be told a record exists when none does.
 *
 * Re-opening an existing subject refreshes it rather than adding a second entry:
 * the fourth and fifth identical refusal are the same outstanding remedy, and
 * the freshest stamp is the one whose age means anything.
 */
export function openDenyExpectation(
  cwd: string,
  runId: string | null | undefined,
  subject: string,
  denyId: string,
): boolean {
  const key = boundedSubject(subject);
  if (!key || isNonProjectRoot(cwd)) return false;
  try {
    const now = Date.now();
    const entries = liveEntries(cwd, now).filter(([existing]) => existing !== key);
    entries.push([key, {
      denyId: boundedSubject(String(denyId || '')),
      at: stateTimestamp(),
      runId: String(runId || ''),
    }]);
    return writeJson(ledgerPath(cwd), toLedger(entries.slice(-MAX_OPEN_EXPECTATIONS)));
  } catch {
    // A diagnostic that throws would change a gate's verdict through the
    // pipeline's fail-closed crash deny. The write's own failure is already on
    // the decision record via the fsjson chokepoint's stateWrites.
    return false;
  }
}

/** Three outcomes, because "nothing was open" is a normal and frequent answer
 *  and must not read as the fence declining us. */
export type DenyExpectationClose = 'closed' | 'none' | 'refused';

/**
 * `subject` just completed, so whatever was refusing it no longer is. Closes
 * every expectation for that subject — two gates refusing one file are one
 * remedy, and the completed call cleared both.
 */
export function satisfyDenyExpectation(cwd: string, subject: string): DenyExpectationClose {
  const key = boundedSubject(subject);
  if (!key || isNonProjectRoot(cwd)) return 'none';
  try {
    const now = Date.now();
    const entries = liveEntries(cwd, now);
    const kept = entries.filter(([existing]) => existing !== key);
    if (kept.length === entries.length) return 'none';
    return writeJson(ledgerPath(cwd), toLedger(kept)) ? 'closed' : 'refused';
  } catch {
    return 'refused';
  }
}

/**
 * Every expectation still outstanding, REMOVED from the ledger as it is handed
 * over — a report discharges what it reports, so each one is delivered once.
 *
 * The empty list is what a refused discharge looks like, deliberately: a caller
 * that emitted the notice anyway would repeat it on every later prompt, because
 * nothing recorded that it had already been said. Reporting nothing is the
 * bounded failure; reporting forever is not.
 */
export function takeUnmetDenyExpectations(cwd: string): UnmetDenyExpectation[] {
  if (isNonProjectRoot(cwd)) return [];
  try {
    const entries = liveEntries(cwd, Date.now());
    if (!entries.length) return [];
    if (!writeJson(ledgerPath(cwd), {} as Ledger)) return [];
    return entries.map(([subject, entry]) => ({ subject, denyId: entry.denyId, at: entry.at }));
  } catch {
    return [];
  }
}

/**
 * The paragraph an unmet set earns. Bounded by `shrink`'s array cap (20) for the
 * same reason every other capture in this directory is bounded by it.
 *
 * It prescribes nothing new. The remedy was already named by the deny that
 * escalated, and repeating a guess at it here would be this module inventing
 * gate semantics it deliberately does not know; what it adds is the one fact
 * nothing else in the product carries — that the refusal was never resolved.
 */
export function unmetDenyExpectationNotice(unmet: readonly UnmetDenyExpectation[]): string {
  if (!unmet.length) return '';
  const lines = (shrink(unmet.map((entry) => (entry.denyId
    ? `- \`${entry.subject}\` (${entry.denyId})`
    : `- \`${entry.subject}\``))) as string[]).join('\n');
  return `Traffic One refused ${unmet.length === 1 ? 'this action' : 'these actions'} repeatedly in the previous turn, told you to stop retrying and apply the remedy, and never saw ${unmet.length === 1 ? 'it' : 'them'} succeed:\n${lines}\n\nNothing is blocked by this notice. Before continuing, do one of: apply the remedy the refusal named and re-issue the action; or state in your digest that it is BLOCKED, naming the refusal, so the orchestrator can route it to whoever owns it. Do not leave it unsaid — a remedy nobody applied and nobody reported is indistinguishable from work that was done.`;
}
