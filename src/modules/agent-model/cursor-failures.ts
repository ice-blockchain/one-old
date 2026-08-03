// src/modules/agent-model/cursor-failures.ts
// Cursor failure correlation: persistence + the transcript reconciler +
// the lifecycle hook and spawn-time gate. Parsing, resolution policy,
// abort forensics, and selection live in the sibling modules.

import { deny, followup, context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { obj } from '../../shared/obj';
import {
  readRunModelPolicy,
} from '../../shared/run-model-policy';
import {
  claimCursorSpawnObservation,
  listCursorSpawnObservations,
  listCursorSubagentTranscriptCandidates,
  markCursorSpawnObservationRetryHandled,
  readEffectiveState,
  suppressCursorFollowupsBatch,
  type CursorFollowupSuppressionReason,
  type CursorSpawnObservation,
} from '../../shared/state';
import {
  exhaustedModelsForRole,
  modelExhaustionTerminalForRole,
  recordExhaustedModel,
} from './exhausted-models';
import {
  readModelChoice,
} from './model-choice';

import {
  CURSOR_FAILURE_BLOCK_FALLBACKS,
  block,
  type CursorFailureReconcileResult,
  type ParsedCursorTranscript,
} from './cursor-failure-prose';
import {
  compatibleObservation,
  correlationTimeMs,
  exactRecommendedModel,
  parseCursorTranscript,
  sameExactSlug,
  unavailableModelsForRun,
} from './cursor-transcript';
import {
  type ClassifiedTerminalObservation,
} from './cursor-failure-resolution';
import {
  exactCursorLifecycleTarget,
  parentTranscriptWasUserAborted,
  rawLifecycleTimeMs,
  rawParentSessionIds,
  stopHasParentUserAbort,
  subagentStopHasChildUserAbort,
  subagentStopHasParentUserAbort,
  withNormalizedSpelling,
} from './cursor-abort-detect';
import {
  claimCursorParentPendingFollowups,
  compareCursorStart,
  refreshPendingResolution,
  selectCursorFailureForParentRole,
  uniqueParentForRole,
} from './cursor-failure-select';
import { finalizeTerminalObservation, persistTerminalClassification } from './cursor-failure-persist';

function cursorPostToolResultIds(raw: unknown): Set<string> {
  const data = obj(raw) || {};
  const payload = obj(data.payload) || {};
  const ids = [
    data.tool_call_id,
    data.toolCallId,
    data.tool_use_id,
    data.toolUseId,
    data.subagent_id,
    data.subagentId,
    payload.tool_call_id,
    payload.toolCallId,
    payload.tool_use_id,
    payload.toolUseId,
    payload.subagent_id,
    payload.subagentId,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  // BOTH spellings: stores written after the chunk-prefix fix hold the normalized id, older
  // ledgers hold the raw "16\nfc_…" one. A superset keeps correlation working across the
  // upgrade instead of silently missing every comparison.
  return new Set(ids.flatMap((value) => withNormalizedSpelling(value)));
}

export function correlatedPostToolObservation(
  cwd: string,
  runId: string,
  raw: unknown,
  role: string,
  requestedModel: string,
): CursorSpawnObservation | null {
  const observations = listCursorSpawnObservations(cwd, runId);
  const resultIds = cursorPostToolResultIds(raw);
  if (resultIds.size) {
    // An explicit tool identity is authoritative. Never fall back to a newer
    // same-role spawn if Cursor delivered an old result after that retry began.
    return observations.find((observation) => (
      resultIds.has(observation.toolCallId) && observation.role === role
    )) || null;
  }

  // Some Cursor builds omit a call id from postToolUse. Correlate only when the
  // immutable start ledger leaves one unique role+parent+exact-model candidate;
  // ambiguity is not permission to condemn a model or retire an agent.
  const parentIds = rawParentSessionIds(raw);
  if (!parentIds.size || !requestedModel) return null;
  const candidates = observations.filter((observation) => (
    observation.role === role
    && parentIds.has(observation.parentSessionId)
    && sameExactSlug(observation.requestedModel, requestedModel)
  ));
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * Persist a structured Cursor postToolUse failure into the same immutable
 * observation/result ledger used by child-transcript reconciliation. This is
 * what lets the next Task use the no-marker correlated retry gate. A synthetic
 * result id reserves the observation when no child transcript was necessary;
 * it is never treated as evidence that a transcript or model switch existed.
 */

// Phase 1 is intentionally limited to durable facts from the transcript. It
// does not mutate model-choice/exhaustion state and it does not retire or consume
// anything. If the hook process stops here, a later pass can safely resume.


// Phase 2 publishes the directive, applies idempotent ledgers/markers, retires
// the matching false-live entry, and only then marks the child consumed. Every
// failed prerequisite leaves consumedAtMs unset so the next hook replays it.

/** Scan, correlate, persist facts, resolve, retire matching agents, then consume. */
export function reconcileCursorSubagentFailures(ctx: Ctx): CursorFailureReconcileResult {
  if (ctx.host !== 'cursor' || isNonProjectRoot(ctx.cwd)) return { processed: [], ambiguousTranscriptIds: [] };
  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  if (isNonProjectRoot(cwd)) return { processed: [], ambiguousTranscriptIds: [] };
  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'cursor' });
  const runId = state && typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId) return { processed: [], ambiguousTranscriptIds: [] };

  let observations = listCursorSpawnObservations(cwd, runId);
  if (!observations.length) return { processed: [], ambiguousTranscriptIds: [] };
  const parsed = listCursorSubagentTranscriptCandidates(cwd, ctx.input.raw)
    .map(parseCursorTranscript)
    .filter((item): item is ParsedCursorTranscript => item !== null)
    .sort((left, right) => (correlationTimeMs(left) || Infinity) - (correlationTimeMs(right) || Infinity));
  if (!parsed.length) return { processed: [], ambiguousTranscriptIds: [] };

  const byChild = new Map(observations
    .filter((observation) => observation.childTranscriptId)
    .map((observation) => [observation.childTranscriptId as string, observation]));

  // Reserve/claim role-bearing transcripts first. The explicit role is stronger
  // than timestamp proximity and removes that start from roleless ambiguity.
  for (const transcript of parsed.filter((item) => item.role)) {
    const childId = transcript.candidate.childTranscriptId;
    if (byChild.has(childId)) continue;
    const candidates = observations
      .filter((observation) => !observation.childTranscriptId)
      .filter((observation) => observation.role === transcript.role)
      .filter((observation) => compatibleObservation(observation, transcript))
      .sort((left, right) => compareCursorStart(right, left));
    const selected = candidates[0];
    if (!selected) continue;
    const claimed = claimCursorSpawnObservation(cwd, runId, selected.toolCallId, childId);
    if (claimed) {
      byChild.set(childId, claimed);
      observations = observations.map((item) => item.toolCallId === claimed.toolCallId ? claimed : item);
    }
  }

  const ambiguous: string[] = [];
  // A roleless startup-error transcript is claimable only when reservations
  // leave exactly one parent+time-compatible unconsumed start.
  for (const transcript of parsed.filter((item) => !item.role && item.terminal)) {
    const childId = transcript.candidate.childTranscriptId;
    if (byChild.has(childId)) continue;
    const candidates = observations
      .filter((observation) => !observation.childTranscriptId)
      .filter((observation) => compatibleObservation(observation, transcript));
    if (candidates.length !== 1) {
      if (candidates.length > 1) ambiguous.push(childId);
      continue;
    }
    const claimed = claimCursorSpawnObservation(cwd, runId, candidates[0]!.toolCallId, childId);
    if (claimed) {
      byChild.set(childId, claimed);
      observations = observations.map((item) => item.toolCallId === claimed.toolCallId ? claimed : item);
    }
  }

  const classified: ClassifiedTerminalObservation[] = [];
  for (const transcript of parsed) {
    if (!transcript.terminal) continue;
    const observation = byChild.get(transcript.candidate.childTranscriptId);
    if (!observation || observation.consumedAtMs) continue;
    const result = persistTerminalClassification(cwd, runId, observation, transcript);
    if (result) classified.push(result);
  }
  // Every correlated failure is now visible to unavailableModelsForRun before
  // any fallback is resolved. Publish all API-limit evidence as a second batch
  // as well, so two same-role limits found together cannot prescribe one
  // another. An enable reply intentionally keeps this historical evidence out
  // of the freshly-cleared run ledger.
  if (readModelChoice(cwd, runId) !== 'enable-retry') {
    for (const item of classified) {
      if (item.kind === 'api-limit') {
        recordExhaustedModel(cwd, runId, item.observation.role, item.observation.requestedModel);
      }
    }
  }
  // This ordering is especially important for parallel explicit-unavailable
  // results, whose exclusions come from the persisted observation outcomes.
  const processed = classified
    .map((item) => finalizeTerminalObservation(cwd, runId, item))
    .filter((item): item is CursorSpawnObservation => item !== null);
  return { processed, ambiguousTranscriptIds: ambiguous };
}


export function cursorFailureReconcileHook(ctx: Ctx): HookResult {
  if (ctx.host !== 'cursor') return noop();
  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  const result = reconcileCursorSubagentFailures(ctx);
  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'cursor' });
  const runId = state && typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId) return noop();

  if (ctx.input.event === 'Stop' || ctx.input.event === 'SubagentStop') {
    const observations = listCursorSpawnObservations(cwd, runId);
    const target = exactCursorLifecycleTarget(ctx.input.event, ctx.input.raw, observations);
    if (!target) return noop();
    const observedAtMs = rawLifecycleTimeMs(ctx.input.raw);
    const parentRows = observations.filter((observation) => (
      observation.parentSessionId === target.parentSessionId
    ));

    const structuredParentAbort = ctx.input.event === 'Stop'
      ? stopHasParentUserAbort(ctx.input.raw)
      : subagentStopHasParentUserAbort(ctx.input.raw);
    if (structuredParentAbort) {
      const reason: CursorFollowupSuppressionReason = ctx.input.event === 'Stop'
        ? 'stop-user-abort'
        : 'subagent-stop-parent-user-abort';
      suppressCursorFollowupsBatch(cwd, runId, {
        scope: 'parent',
        parentSessionId: target.parentSessionId,
        observedAtMs,
        reason,
      });
      return noop();
    }
    if (parentTranscriptWasUserAborted(cwd, ctx.input.raw, target.parentSessionId, parentRows)) {
      suppressCursorFollowupsBatch(cwd, runId, {
        scope: 'parent',
        parentSessionId: target.parentSessionId,
        observedAtMs,
        reason: 'parent-transcript-user-abort',
      });
      return noop();
    }

    // A SubagentStop abort belongs to that exact child, not to the orchestrator.
    // This aborted lifecycle event is not permission to continue siblings; a
    // later normal Stop may claim the remaining parent-wide batch.
    if (ctx.input.event === 'SubagentStop' && target.subagent
      && subagentStopHasChildUserAbort(ctx.input.raw)) {
      suppressCursorFollowupsBatch(cwd, runId, {
        scope: 'child',
        toolCallId: target.subagent.toolCallId,
        parentSessionId: target.parentSessionId,
        observedAtMs,
        reason: 'subagent-stop-user-abort',
      });
      return noop();
    }

    const claimed = claimCursorParentPendingFollowups(
      cwd,
      runId,
      state,
      ctx.input.raw,
      target.parentSessionId,
      observedAtMs,
    );
    if (!claimed.length) return noop();
    return followup(claimed
      .sort((left, right) => left.role.localeCompare(right.role) || compareCursorStart(left, right))
      .map((observation) => observation.directive)
      .filter((directive): directive is string => Boolean(directive))
      .join('\n\n'));
  }

  // Prompt/session context and lifecycle Stop share the same complete-parent
  // batch CAS. Whichever hook owns it returns the directives; the other no-ops.
  // Raw reconciliation alone never marks delivery, and followupEmitted does not
  // weaken the explicit next-Task recovery gate.
  const explicitParents = rawParentSessionIds(ctx.input.raw);
  const processedParents = new Set(result.processed.map((observation) => observation.parentSessionId));
  const parentSessionId = explicitParents.size === 1
    ? [...explicitParents][0]!
    : (explicitParents.size === 0 && processedParents.size === 1
      ? [...processedParents][0]!
      : null);
  if (!parentSessionId) return noop();
  const observedAtMs = rawLifecycleTimeMs(ctx.input.raw);
  const claimed = claimCursorParentPendingFollowups(
    cwd,
    runId,
    state,
    ctx.input.raw,
    parentSessionId,
    observedAtMs,
  );
  const directives = claimed
    .sort((left, right) => (
      left.parentSessionId.localeCompare(right.parentSessionId)
      || left.role.localeCompare(right.role)
      || compareCursorStart(left, right)
    ))
    .map((observation) => observation.directive)
    .filter((directive): directive is string => Boolean(directive));
  return directives.length ? context(directives.join('\n\n')) : noop();
}

/**
 * Enforce a persisted correlated result on the next role spawn, even after the
 * failed live agent was retired and without requiring [t1-replace-agent].
 */
export function correlatedCursorFailureGate(
  ctx: Ctx,
  cwd: string,
  runId: string,
  role: string,
  passedModel: string,
): HookResult | null {
  if (ctx.host !== 'cursor' || !runId) return null;
  reconcileCursorSubagentFailures(ctx);
  if (modelExhaustionTerminalForRole(cwd, runId, role)) {
    const tried = exhaustedModelsForRole(cwd, runId, role).join(', ') || 'recorded tier candidates';
    return deny(block('cursor-api-limit-terminal', { ROLE: role, TRIED: tried },
      CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-api-limit-terminal']));
  }
  const parentIds = rawParentSessionIds(ctx.input.raw);
  const parentSessionId = parentIds.size === 1
    ? [...parentIds][0]!
    : uniqueParentForRole(cwd, runId, role);
  if (!parentSessionId) return null;
  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'cursor' });
  const selected = selectCursorFailureForParentRole(cwd, runId, parentSessionId, role, {
    state,
    raw: ctx.input.raw,
  });
  if (!selected) return null;
  const pending = refreshPendingResolution(cwd, runId, selected.head);
  // The finalized head permanently shadows older rows. Lifecycle suppression
  // blocks only an unsolicited follow-up; an explicit next Task must still obey
  // and may settle the correlated recovery prescription.
  if (!pending.outcome || pending.retryHandled) return null;
  const choice = readModelChoice(cwd, runId);

  if (pending.outcome === 'generic') return null; // model is not condemned; generic recovery may retry it

  if (choice === 'enable-retry') {
    const policy = readRunModelPolicy(cwd, runId);
    if (!policy || policy.host !== 'cursor') {
      return deny(`traffic-one — immutable model-policy.json is missing or corrupt for run ${runId}; start a repaired parent run before retrying ${role}.`);
    }
    const recommended = exactRecommendedModel(policy, pending);
    return sameExactSlug(passedModel, recommended) ? null : deny(
      `traffic-one — ${role} is waiting for the user's enable/retry choice. Re-send the same role on the recommended model="${recommended}" after completing the selected budget/Settings remedy; do not use a fallback.`,
    );
  }

  if (pending.outcome === 'api-limit' && pending.prescribedModel
    && /^composer/i.test(pending.prescribedModel) && pending.tier !== 'cheapest'
    && choice !== 'use-fallback') {
    return deny(pending.directive || 'traffic-one — choose enable or fallback before using the Composer floor.');
  }
  if (pending.outcome === 'model-unavailable' && choice !== 'use-fallback') {
    return deny(pending.directive || 'traffic-one — choose enable or fallback before retrying an unavailable model.');
  }
  if (!pending.prescribedModel) return deny(pending.directive || 'traffic-one — no exact next model is currently available.');
  return sameExactSlug(passedModel, pending.prescribedModel)
    ? null
    : deny(pending.directive || `traffic-one — retry ${role} on model="${pending.prescribedModel}".`);
}

// Called only after a real SubagentStart, which is the proof that a prescribed
// model actually ran. PreToolUse acceptance alone never settles a retry.
interface CursorRetryStart {
  parentSessionId: string;
  role: string;
  startedToolCallId: string;
  startedModel: string;
}

export function settleCorrelatedCursorRetryOnStart(
  cwd: string,
  runId: string,
  start: CursorRetryStart,
): CursorSpawnObservation | null {
  const own = listCursorSpawnObservations(cwd, runId).find((observation) => (
    observation.parentSessionId === start.parentSessionId
    && observation.role === start.role
    && observation.toolCallId === start.startedToolCallId
    && sameExactSlug(observation.requestedModel, start.startedModel)
  ));
  if (!own) return null;
  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'cursor' });
  const selected = selectCursorFailureForParentRole(
    cwd,
    runId,
    start.parentSessionId,
    start.role,
    { state, raw: {}, before: own },
  );
  const pending = selected?.head;
  if (!pending?.childTranscriptId || !pending.outcome
    || pending.retryHandled) return null;
  const choice = readModelChoice(cwd, runId);
  if (pending.outcome === 'generic') {
    return markCursorSpawnObservationRetryHandled(cwd, runId, pending.childTranscriptId);
  }
  const policy = readRunModelPolicy(cwd, runId);
  const expected = choice === 'enable-retry'
    ? (policy?.host === 'cursor' ? exactRecommendedModel(policy, pending) : null)
    : pending.prescribedModel;
  if (!expected || !sameExactSlug(start.startedModel, expected)) return null;
  if (pending.outcome === 'api-limit' && /^composer/i.test(expected)
    && pending.tier !== 'cheapest' && choice !== 'use-fallback') return null;
  if (pending.outcome === 'model-unavailable' && choice !== 'use-fallback' && choice !== 'enable-retry') return null;
  return markCursorSpawnObservationRetryHandled(cwd, runId, pending.childTranscriptId);
}

export { CURSOR_FAILURE_BLOCK_FALLBACKS } from './cursor-failure-prose';
export { rolesAwaitingModelChoice } from './cursor-transcript';
export { persistCorrelatedCursorPostToolFailure } from './cursor-failure-persist';
