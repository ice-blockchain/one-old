// src/core/pipeline.ts
// Chain-of-responsibility gate/handler pipeline. Replaces the 5 separate
// PreToolUse processes + the 750-line gates.cjs: handlers matching the input's
// (event, tool class) run in ascending-priority order, a deny short-circuits the
// rest, and the surviving context results are merged.
//
// Also the ONE place every verdict this pipeline produces gets appended to the
// decision log (shared/state/decision-log.ts) — never a handler's job, so a
// future gate can't forget to log itself and there is exactly one call site to
// audit for "does every exit path record?" (see the four `recordDecision`
// call sites below: crash-deny, short-circuit deny, and the merged
// allow/context/noop result. The one exit path that does NOT record is a
// non-PreToolUse handler's thrown error re-propagating to the host lifecycle
// fallback — there is no HookResult to describe there, and the fixed decision
// vocabulary (allow/deny/context/noop) has no fifth "crashed" value to invent
// for it; see the work-item report).
//
// It is also where the compliance detector (shared/state/deny-expectation.ts)
// is consulted, on the same reasoning that put deny-repeat.ts here: whether a
// refusal's remedy was ever applied is a property of ALL denies, and a rule
// wired into one gate leaves the other ~120 uninstrumented. Three sites, each
// gated on the event so no other path pays for it — a PostToolUse closes an
// expectation the completed call resolved, a UserPromptSubmit reports whatever
// the previous turn left unmet, and the deny exit opens one only when the
// refusal ESCALATED. The allow path is untouched: it reads and writes nothing
// for this, which is deliberate — it is the only path on the 150 ms pre-tool
// budget that runs on every tool call.

import type { Ctx, FallbackDenyId, Handler, HookInput, HookResult } from './types';
import type { DenyId } from '../config/deny-ids';
import { handlerMatches } from './events';
import { context, deny, isDeny, mergeResults } from './result';
import {
  overridableDeny,
  overrideAppliedNotice,
  overrideForDeny,
} from '../shared/override';
import {
  appendDecision,
  buildCorrelationId,
  decisionLoggingEnabled,
  decisionsRecorded,
  nextHookSeq,
  type DecisionKind,
  type DecisionRecord,
} from '../shared/state/decision-log';
import { drainStateWrites, type StateWriteRecord } from '../shared/state/state-write-log';
import { DENY_REPEAT_ESCALATE_AT, denyRepeat } from '../shared/state/deny-repeat';
import {
  denyExpectationSubject,
  openDenyExpectation,
  satisfyDenyExpectation,
  takeUnmetDenyExpectations,
  unmetDenyExpectationNotice,
} from '../shared/state/deny-expectation';
import { shrink } from '../shared/state/claim-capture';

export function selectHandlers(handlers: readonly Handler[], ctx: Ctx): Handler[] {
  return handlers
    .filter((handler) => handlerMatches(handler, ctx.input))
    .sort((a, b) => a.priority - b.priority);
}

// Stamp every deny leaving the pipeline with the identity a budget/decision
// log needs, without changing anything else about it (same reason, same
// context, same everything else — verdict-neutral).
//   - gateId: only the pipeline knows the handler's registration id, so it is
//     always set here, unconditionally — a handler never supplies its own.
//   - denyId: a handler's own declared id wins; the pipeline only fills a
//     synthetic FallbackDenyId (see types.ts) when the handler left it unset,
//     so the deny is attributable rather than anonymous. This is the ONLY
//     place a fallback is minted; see tests/deny-id-completeness.test.ts for
//     the static gate that keeps real call sites from needing it.
//   - reason: gets the decision log's correlation id appended (when a record
//     will actually be written — see runPipeline's `recording`) — "the
//     correlation id must be echoed into the deny text" per the plan, done
//     HERE (the one place that already stamps deny metadata) so the ~112 real
//     call sites that build deny() never need to know this log exists.
//     `correlationSuffix` is '' when nothing is recorded, so a non-logging
//     project keeps today's exact reason text.
//
//   - repeatSuffix: the deny-repeat escalation (shared/state/deny-repeat.ts),
//     appended FIRST of the three because it is the only one addressed to the
//     agent about what to do next. The operator hatch is NOT stamped here:
//     Claude Code paints the deny reason as a user-visible Error, and printing
//     `--unblock` there is what its Gate blocker UI promotes to Recommended.
//     The hatch still exists in doctor. The ref is a pointer.
//     Also computed by the caller, from the reason as the gate rendered it —
//     see denyRepeat's contract for why it may never see a stamped reason.
//
// TWO exceptions, both about `askUser` (core/result.ts): its `reason` is not
// agent-facing prose, it is the QUESTION rendered inside Cursor's
// approve/reject modal, so appending "(traffic-one ref: run-x:42:9912)" put a
// log pointer inside a yes/no dialog — and `agentMessage`, which the adapter
// emits alongside it, is never stamped, so the two fields disagreed about
// whether a ref exists at all. It also already declares its own id, so the
// fallback below never applies to it.
//
// `overrideSuffix` is kept as a stampDeny parameter so a future caller can
// attach a hatch, but the pipeline currently always passes ''. An approve/reject
// modal is not the place to offer an escape hatch from itself either.
// The id this deny will be KNOWN BY once it leaves — the handler's own, or the
// synthesized fallback. Extracted so the deny-repeat counter can classify the
// same string the decision log records: the exclusion list is a statement about
// declared ids, and asking it about `result.denyId` instead would silently judge
// an un-attributed gate on `undefined` rather than on the identity everything
// downstream sees.
function resolvedDenyId(
  result: Extract<HookResult, { kind: 'deny' }>,
  handlerId: string,
): DenyId | FallbackDenyId {
  return result.denyId ?? `unattributed-handler:${handlerId}`;
}

function stampDeny(
  result: Extract<HookResult, { kind: 'deny' }>,
  handlerId: string,
  correlationSuffix: string,
  overrideSuffix = '',
  repeatSuffix = '',
): HookResult {
  const suffix = result.askUser ? '' : `${repeatSuffix}${overrideSuffix}${correlationSuffix}`;
  return {
    ...result,
    gateId: handlerId,
    denyId: resolvedDenyId(result, handlerId),
    reason: `${result.reason}${suffix}`,
  };
}

// Read `currentRunId` straight off `.traffic-one/.one.json` without pulling in
// the full shared/state surface (that module graph is large, and every other
// consumer of the run id already has a materialized state object in hand —
// the pipeline is the one caller that has only a fresh Ctx). Mirrors the
// string/number normalisation every other canonical reader of this field uses
// (see shared/state/project-state-lock.ts's runIdValue).
function currentRunId(ctx: Ctx): string | null {
  const state = ctx.fsjson.readJson<Record<string, unknown>>(ctx.paths.stateFile(ctx.cwd), {});
  const raw = state ? state.currentRunId : undefined;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(Math.trunc(raw));
  return null;
}

// decision label for the fixed 4-value vocabulary the doctor work item reads.
// `deny` always wins regardless of event (a Stop-event block is still a
// refusal). Otherwise: PreToolUse is the only event whose job is literally
// "may this tool call proceed?" — its non-deny outcome IS an allow, whether
// or not a gate attached context. Every other event (SessionStart,
// UserPromptSubmit, PostToolUse, SubagentStart/Stop, Stop-without-a-deny) is
// not gating a tool call at all, so its non-deny outcome is reported as plain
// `context`/`noop` bookkeeping rather than a fabricated "allow" of nothing.
function decisionKind(event: HookInput['event'], result: HookResult): DecisionKind {
  if (isDeny(result)) return 'deny';
  if (event === 'PreToolUse') return 'allow';
  return result.kind === 'noop' ? 'noop' : 'context';
}

// The decision log's `inputs`: a bounded snapshot of what the verdict was
// actually decided from, never the raw host payload (ctx.input.raw — feature
// code should not read it, and it can be arbitrarily large/host-specific).
// shrink() (claim-capture.ts) caps string length/array length/depth; the
// pipeline still shrinks here (not just inside appendDecision) so the object
// handed to appendDecision is already small on the common path.
function boundedInputs(input: HookInput): Record<string, unknown> {
  return shrink({
    hostHookPoint: input.hostHookPoint,
    workspaceRoot: input.workspaceRoot,
    tool: input.tool,
    prompt: input.prompt,
  }) as Record<string, unknown>;
}

interface DecisionMeta {
  readonly runId: string | null;
  readonly hookSeq: number;
  readonly pid: number;
  readonly correlationId: string;
}

// The single call site every exit path funnels through. Never throws, never
// changes what the caller already decided — see decision-log.ts's own
// fail-open contract for the write itself; this wrapper additionally covers
// the (much rarer) case where BUILDING the record throws, via ctx.log.warn
// (visible, unlike a bare catch — "not silently swallowed" applies to this
// path too, not just the disk write).
//
// Both `repeatCount` and `stateWrites` arrive as PARAMETERS rather than being
// pulled from a module-level slot in here. `repeatCount` comes from the same deny
// exit that rendered the escalation into the reason, so the number in the record
// is by construction the number the agent was shown; it used to travel through a
// single slot in shared/state/state-write-log.ts because the count was computed
// deep inside one gate's call stack and had no other way out, and that slot is
// gone now that the counter runs at the exit itself.
//
// `stateWrites` still has a module-level buffer — its sender genuinely is deep in
// a call stack (fsjson.ts's chokepoint) — but the DRAIN moved out to `settle`
// below. state-write-log.ts's header rests the safety of that buffer on it being
// emptied once per runPipeline call whichever way the call leaves, and draining
// it in here made that conditional on T1_DECISION_LOG: a logging-off install
// never emptied it, so in any process that dispatches more than one hook (the
// replay corpus, test:env, doctor's run reconstruction) up to 64 records from one
// invocation stayed visible to the next.
//
// repeatCount is attached only to a DENY, and only when a count exists: `null`
// means the id is excluded from counting by policy (deny-repeat.ts's
// denyRepeatCounted), which is a different fact from "refused once" and must not
// be recorded as a number.
function recordDecision(
  ctx: Ctx,
  result: HookResult,
  meta: DecisionMeta,
  repeatCount: number | null,
  stateWrites: StateWriteRecord[],
): void {
  try {
    const record: DecisionRecord = {
      ts: new Date().toISOString(),
      correlationId: meta.correlationId,
      runId: meta.runId,
      hookSeq: meta.hookSeq,
      pid: meta.pid,
      event: ctx.input.event,
      host: ctx.host,
      decision: decisionKind(ctx.input.event, result),
      gateId: isDeny(result) ? (result.gateId ?? null) : null,
      denyId: isDeny(result) ? (result.denyId ?? null) : null,
      ...(isDeny(result) && result.denyTarget ? { denyTarget: result.denyTarget } : {}),
      ...(isDeny(result) && repeatCount !== null ? { repeatCount } : {}),
      inputs: boundedInputs(ctx.input),
      stateWrites,
    };
    appendDecision(ctx.cwd, record);
  } catch (error) {
    ctx.log.warn(`decision-log record build failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runPipeline(handlers: readonly Handler[], ctx: Ctx): Promise<HookResult> {
  const logging = decisionLoggingEnabled();
  // Whether a record will actually LAND on disk — strictly stronger than
  // "logging is enabled", because appendDecision also declines a non-project
  // root and any project whose use-plugin answer is still outstanding or was
  // "no". The echoed ref must obey that same fence: handing the user
  // `(traffic-one ref: …)` for a decisions.jsonl that was never written sends
  // them, and `doctor`, hunting evidence that does not exist. This is
  // decision-log.ts's OWN exported predicate — the literal expression
  // appendDecision checks — called rather than re-derived here, so the suffix
  // condition and the write condition cannot drift apart again.
  // Deliberately does NOT gate recordDecision itself: that call still runs, with
  // appendDecision's fence deciding the write.
  const recording = decisionsRecorded(ctx.cwd);
  // Resolved at most once per invocation, by whoever needs it first: the
  // decision log for every record, the operator-override lookup on a deny, the
  // deny-repeat counter on every deny. Reading `.one.json` twice in one hook
  // call is waste; letting those paths see `null` whenever logging happens to be
  // off (T1_DECISION_LOG=false) would silently scope every lookup to "no run",
  // making a legitimately minted token invisible and giving every refusal its
  // own untracked count, on exactly the installs that turned logging off.
  // The counter is what makes this read reachable on a logging-off deny at all;
  // an ALLOW still reads nothing, there and here.
  let resolvedRunId: string | null | undefined;
  const runIdOnce = (): string | null => {
    if (resolvedRunId === undefined) resolvedRunId = currentRunId(ctx);
    return resolvedRunId;
  };
  const runId = logging ? runIdOnce() : null;
  const hookSeq = logging ? nextHookSeq(ctx.cwd, runId) : 0;
  const pid = process.pid;
  const correlationId = buildCorrelationId(runId, hookSeq, pid);
  const correlationSuffix = recording ? `\n\n(traffic-one ref: ${correlationId})` : '';
  const meta: DecisionMeta = { runId, hookSeq, pid, correlationId };

  // Every exit funnels through here so the module-level state-write buffer is
  // emptied on ALL of them, logging or not — the invariant state-write-log.ts's
  // header rests that buffer's safety on. `if (logging) recordDecision(...)` at
  // each exit did not hold it, because the drain lived inside recordDecision.
  const settle = (result: HookResult, repeatCount: number | null = null): void => {
    const stateWrites = drainStateWrites();
    if (logging) recordDecision(ctx, result, meta, repeatCount, stateWrites);
  };

  // ── the compliance detector's CLOSE leg ────────────────────────────────────
  // This call ran, so no gate refused it, so whatever was refusing this subject
  // has stopped — see deny-expectation.ts for why that is a proof rather than a
  // proxy. Before the handler loop because the action already happened: what a
  // POST-event gate goes on to say about it cannot un-run it. `'none'` is the
  // overwhelmingly common answer (nothing is open) and costs one absent-file
  // read; only `'refused'` is worth a line, and it gets one rather than being
  // dropped — the chokepoint has already recorded the write itself.
  if (ctx.input.event === 'PostToolUse') {
    const subject = denyExpectationSubject(ctx.input.tool);
    if (subject && satisfyDenyExpectation(ctx.cwd, subject) === 'refused') {
      ctx.log.debug(`deny-expectation: closing ${subject} was refused; it stays open`);
    }
  }

  const collected: HookResult[] = [];
  for (const handler of selectHandlers(handlers, ctx)) {
    let result: HookResult;
    try {
      result = await handler.run(ctx);
    } catch (error) {
      // Every host adapter knows how to serialize a canonical deny, but several
      // host entry wrappers historically converted a thrown hook into an empty
      // success response. Never allow a tool merely because a gate crashed.
      if (ctx.input.event === 'PreToolUse') {
        const code = error && typeof error === 'object' && typeof (error as NodeJS.ErrnoException).code === 'string'
          ? ` (${String((error as NodeJS.ErrnoException).code)})`
          : '';
        const crashDeny = deny(`Traffic One ${handler.id} gate failed${code}; this tool call is blocked fail-closed. Retry after resolving the Traffic One setup/plugin error.`, { denyId: 'pipeline-handler-crashed' });
        // Counted like any other refusal, and it is the loop that was most
        // invisible: a gate that threw three times will throw the fourth, and
        // the message names a remedy ("resolve the Traffic One setup/plugin
        // error") the agent cannot apply from inside the run — so "report
        // BLOCKED" is the honest exit and nothing else was ever going to say
        // so. Nothing may LIFT this deny either, which is the plainest evidence
        // that never-overridable and never-escalated are different sets.
        const crashResult = crashDeny as Extract<HookResult, { kind: 'deny' }>;
        const crashRepeat = denyRepeat(ctx.cwd, runIdOnce(), { ...crashResult, denyId: resolvedDenyId(crashResult, handler.id) });
        const stamped = stampDeny(crashResult, handler.id, correlationSuffix, '', crashRepeat.suffix);
        settle(stamped, crashRepeat.count);
        return stamped;
      }
      throw error;
    }
    if (isDeny(result)) {
      // The ONE place an operator override is consulted, for the same reason
      // this is the one place a deny is stamped: the alternative is ~112 call
      // sites each deciding for themselves whether they are overridable, and
      // the never-overridable list holding only for the ones that remembered
      // to ask. Everything here is a READ — no token is written, marked used,
      // or expired by this path.
      //
      // The predicate is asked FIRST, before the run id is resolved: it is
      // pure, and the overwhelming majority of refusals are not overridable
      // (never-overridable ids, askUser prompts, every non-PreToolUse event),
      // so this keeps them from reading `.one.json` for an answer they cannot
      // use — which on a T1_DECISION_LOG=false install would be a new read on
      // a path that previously did none.
      const denyInput = { event: ctx.input.event, denyId: result.denyId, askUser: result.askUser };
      const overridable = overridableDeny(denyInput);
      const override = overridable ? overrideForDeny(ctx.cwd, runIdOnce(), handler.id, denyInput) : null;
      if (override) {
        // Skip THIS gate's refusal and keep going, rather than returning an
        // allow: an override names one gate, so every later handler must still
        // get its turn to deny. The notice rides the merged context so the
        // agent's transcript records that enforcement was relaxed here.
        collected.push(context(overrideAppliedNotice(override, handler.id, String(result.denyId ?? ''))));
        continue;
      }
      // Counted only now, AFTER the override lookup: an overridden deny never
      // leaves the pipeline (the `continue` above), so counting it earlier would
      // charge the agent for a refusal it never saw. Every gate reaches this one
      // line, which is the whole point — the counter was wired into exactly one
      // gate's own call stack, so the other ~120 could refuse identically forever
      // with nothing counting. Given the gate's own `reason` (never the stamped
      // one — see denyRepeat) and the OUTGOING identity, so that the exclusion
      // rule and the decision log judge the same id.
      const repeat = denyRepeat(ctx.cwd, runIdOnce(), { ...result, denyId: resolvedDenyId(result, handler.id) });
      // ── the compliance detector's OPEN leg ────────────────────────────────
      // Exactly the refusals that just ESCALATED, which is the moment the deny
      // text stops informing and starts prescribing ("STOP RETRYING — do
      // exactly one of…"). `repeat.count` is already computed one line up, so
      // this decides for free and the first two attempts write nothing. The
      // subject comes from the pipeline's OWN tool input rather than
      // `denyTarget`, because the later PostToolUse that closes it reads the
      // same field — a key derived from what gates choose to put in
      // `denyTarget` would have to mean the same thing on both events.
      //
      // Nothing here may change the verdict, so the refusal of the record's own
      // write has no branch to take; it is reported instead of swallowed, the
      // way state/plugin-use.ts reports an unrecorded consent answer.
      if (repeat.count !== null && repeat.count >= DENY_REPEAT_ESCALATE_AT) {
        const subject = denyExpectationSubject(ctx.input.tool);
        if (subject && !openDenyExpectation(ctx.cwd, runIdOnce(), subject, String(resolvedDenyId(result, handler.id)))) {
          ctx.log.debug(`deny-expectation: recording the unmet remedy for ${subject} was refused`);
        }
      }
      // Never print `--unblock` on a hook deny. Claude Code paints the reason
      // as a user-visible Error and its Gate blocker UI promotes the hatch to
      // Recommended (observed: live Claude session, parent write in
      // maintenance). The hatch still exists in doctor; advertising it here
      // drives users away and trains the agent to offer it.
      const overrideSuffix = '';
      const stamped = stampDeny(result, handler.id, correlationSuffix, overrideSuffix, repeat.suffix); // short-circuit
      settle(stamped, repeat.count);
      return stamped;
    }
    collected.push(result);
  }
  // ── the compliance detector's REPORT leg ──────────────────────────────────
  // A new user prompt is the only event in the canonical vocabulary that means
  // the previous AGENT turn is over, so an expectation still open here is one
  // the turn ended without satisfying — no grace period to invent, and no
  // number to pick. Context, never a deny: a detector that refused something
  // would wedge exactly the agent that obeyed the escalation's own "report it
  // in your digest and let the orchestrator route it" instruction.
  //
  // AFTER the loop, so a handler's deny short-circuits past it: the notice
  // would be discarded with the merged result, and the take has already
  // consumed the entries. Losing a turn's report to a deny that the agent will
  // see anyway is cheaper than losing it silently, and the next prompt reports
  // it. `takeUnmetDenyExpectations` answers with an empty list when the
  // discharge did not persist, which is what keeps a fenced project from being
  // told the same thing on every prompt forever.
  if (ctx.input.event === 'UserPromptSubmit') {
    const unmet = takeUnmetDenyExpectations(ctx.cwd);
    if (unmet.length) collected.push(context(unmetDenyExpectationNotice(unmet)));
  }
  const merged = mergeResults(collected);
  settle(merged);
  return merged;
}
