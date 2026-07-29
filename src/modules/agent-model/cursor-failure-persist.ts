// src/modules/agent-model/cursor-failure-persist.ts
// Persistence of correlated post-tool failures and terminal observation
// finalization.

import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { resolveProjectRoot } from '../../shared/hook/paths';
import {
  claimCursorFollowupsBatch,
  claimCursorSpawnObservation,
  consumeCursorSpawnObservation,
  cursorParentObservationSnapshot,
  inferRoleFromTranscript,
  isResumeCapableAgentId,
  listCursorSpawnObservations,
  normalizeHostCallId,
  listCursorSubagentTranscriptCandidates,
  markCursorSpawnObservationRetryHandled,
  markRunAgentReplacedIfMatches,
  readEffectiveState,
  readRunAgentRegistry,
  refreshCursorRunAgentFromTranscriptCache,
  suppressCursorFollowupsBatch,
  type CursorFollowupClaimRequest,
  type CursorFollowupSuppressionReason,
  type CursorSpawnObservation,
  type CursorTranscriptCandidate,
  type RunAgentEntry,
  updateCursorSpawnObservation,
} from '../../shared/state';
import { classifyModelFailureText, type ModelFailureKind } from './failure-classify';
import {
  exhaustedModelsForRole,
  markModelExhaustionTerminal,
  modelExhaustionTerminalForRole,
  modelIsExhausted,
  recordExhaustedModel,
} from './exhausted-models';
import {
  markModelChoicePrompted,
  modelChoicePrompted,
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
  sameFamily,
  unavailableModelsForRun,
} from './cursor-transcript';
import {
  resolutionFor,
  type ClassifiedTerminalObservation,
} from './cursor-failure-resolution';
import {
  claimCursorParentPendingFollowups,
  compareCursorStart,
  refreshPendingResolution,
  selectCursorFailureForParentRole,
  uniqueParentForRole,
} from './cursor-failure-select';
import { correlatedPostToolObservation } from './cursor-failures';

export function persistCorrelatedCursorPostToolFailure(
  ctx: Ctx,
  role: string,
  requestedModel: string,
  kind: ModelFailureKind,
  error: string,
): CursorSpawnObservation | null {
  if (ctx.host !== 'cursor' || isNonProjectRoot(ctx.cwd)) return null;
  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  if (isNonProjectRoot(cwd)) return null;
  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: 'cursor' });
  const runId = state && typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId) return null;

  let observation = correlatedPostToolObservation(cwd, runId, ctx.input.raw, role, requestedModel);
  if (!observation || observation.retryHandled) return null;

  // A transcript reconciliation pass may have won the race. Reuse its durable
  // result and refresh the choice-dependent directive instead of publishing a
  // second failure or replacing a newer retry.
  if (observation.outcome) {
    const refreshed = refreshPendingResolution(cwd, runId, observation);
    markRunAgentReplacedIfMatches(cwd, runId, refreshed.role, refreshed.toolCallId);
    return refreshed;
  }

  const resultId = observation.childTranscriptId || `posttool-${observation.toolCallId}`;
  if (!observation.childTranscriptId) {
    observation = claimCursorSpawnObservation(cwd, runId, observation.toolCallId, resultId) || observation;
  }
  if (observation.childTranscriptId !== resultId) return null;

  const transcript: ParsedCursorTranscript = {
    candidate: {
      filePath: '',
      parentSessionId: observation.parentSessionId,
      childTranscriptId: resultId,
      birthtimeMs: observation.startedAtMs,
      mtimeMs: observation.startedAtMs,
    },
    role: observation.role,
    lineCount: 1,
    terminal: true,
    failed: true,
    error,
  };
  const classified = persistTerminalClassification(cwd, runId, observation, transcript);
  if (!classified) return null;
  if (kind === 'api-limit' && readModelChoice(cwd, runId) !== 'enable-retry') {
    recordExhaustedModel(cwd, runId, observation.role, observation.requestedModel);
  }
  return finalizeTerminalObservation(cwd, runId, classified);
}
export function persistTerminalClassification(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
  transcript: ParsedCursorTranscript,
): ClassifiedTerminalObservation | null {
  const childId = transcript.candidate.childTranscriptId;
  if (observation.consumedAtMs) return null;
  if (!transcript.failed) {
    consumeCursorSpawnObservation(cwd, runId, childId);
    return null;
  }
  const kind = observation.outcome || classifyModelFailureText(transcript.error);

  // The failed model and tier anchor are immutable fields from SubagentStart;
  // persist only the classified child result here. Resolution runs after every
  // terminal in this scan has reached this point, so concurrent unavailable
  // outcomes cannot prescribe one another.
  const persisted = updateCursorSpawnObservation(cwd, runId, childId, {
    outcome: kind,
    error: transcript.error,
  });
  if (!persisted) return null;
  return { observation: persisted, transcript, kind };
}
function matchingLiveAgentStillActive(cwd: string, runId: string, observation: CursorSpawnObservation): boolean {
  const registry = readRunAgentRegistry(cwd, runId);
  const entry = registry[observation.role];
  if (!entry || entry.replaced) return false;
  return [entry.agentId, entry.toolCallId, entry.resumeId]
    .some((value) => typeof value === 'string' && value === observation.toolCallId);
}
export function finalizeTerminalObservation(
  cwd: string,
  runId: string,
  classified: ClassifiedTerminalObservation,
): CursorSpawnObservation | null {
  const { observation, transcript, kind } = classified;
  const childId = transcript.candidate.childTranscriptId;
  const resolution = resolutionFor(cwd, runId, observation, kind);

  const persisted = updateCursorSpawnObservation(cwd, runId, childId, {
    directive: resolution.directive,
    prescribedModel: resolution.prescribedModel,
  });
  if (!persisted) return null;

  if (kind === 'api-limit') {
    // An enable reply clears all run condemnations. If this old child result is
    // first discovered on that same prompt, do not recreate the ledger the user
    // just cleared; the persisted outcome still enforces the recommended retry.
    if (readModelChoice(cwd, runId) !== 'enable-retry') {
      const recorded = recordExhaustedModel(cwd, runId, observation.role, observation.requestedModel);
      if (!recorded.some((model) => sameFamily(model, observation.requestedModel))) return null;
    }
    if (resolution.terminal
      && !modelExhaustionTerminalForRole(cwd, runId, observation.role)
      && !markModelExhaustionTerminal(cwd, runId, observation.role)) return null;
  }
  if (resolution.choicePrompted) {
    markModelChoicePrompted(cwd, runId);
    if (!modelChoicePrompted(cwd, runId)) return null;
  }
  // Targeted CAS-style retirement: a late transcript cannot kill a newer retry.
  markRunAgentReplacedIfMatches(cwd, runId, observation.role, observation.toolCallId);
  if (matchingLiveAgentStillActive(cwd, runId, observation)) return null;
  return consumeCursorSpawnObservation(cwd, runId, childId);
}
