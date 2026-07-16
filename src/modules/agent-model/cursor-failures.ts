// Cursor child-transcript reconciliation and correlated retry policy.
//
// Startup failures are unusual on Cursor: Task can emit subagentStart and then
// produce no postToolUse/subagentStop result at all. The only durable result is
// the child JSONL under Cursor's transcript cache. This module correlates that
// result with the immutable SubagentStart observation, persists the outcome,
// retires only the matching live agent, and exposes the exact retry directive to
// the next Task gate and Cursor lifecycle hooks.

import * as fs from 'fs';
import * as path from 'path';

import { deny, followup, context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { currentModelsForTier, resolveTierFallback } from '../../shared/current-model-tiers';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { detectHostPlan } from '../../shared/host-plan';
import { freshCursorModels, pickCursorSlug } from '../../shared/materialize/cursor-models';
import { modelMatchesExpected } from '../../shared/model-tiers';
import { obj } from '../../shared/obj';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';
import {
  claimCursorFollowupsBatch,
  claimCursorSpawnObservation,
  consumeCursorSpawnObservation,
  cursorParentObservationSnapshot,
  inferRoleFromTranscript,
  isResumeCapableAgentId,
  listCursorSpawnObservations,
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
import { cursorAgentPresumedDead } from './cursor-liveness';

const skillBlock = makeSkillBlock(pluginRoot);
const block = (
  name: string,
  vars: Record<string, string | number | null | undefined>,
  fallback: string,
): string => skillBlock('agent-model', name, vars, fallback);

// Keep the fail-closed TypeScript prose byte-identical to the authoritative
// T1BLOCK bodies in skill/SKILL.md. skillBlock applies {{VARS}} to either the
// loaded block or this raw fallback template, so callers must pass these
// templates verbatim rather than maintaining a second interpolated wording.
export const CURSOR_FAILURE_BLOCK_FALLBACKS = {
  'cursor-api-limit-auto-retry': 'Traffic One correlated `{{ROLE}}`\'s Cursor child transcript to an API/usage-limit failure on **{{FAILED}}**. The failed agent is retired. Retry the same role now, without asking the user, on `model: "{{NEXT}}"` — the next exact captured slug from this role\'s original tier. Never announce or attempt a fallback named only by Cursor error prose. The next model is authoritative only when Traffic One supplies its exact slug. Issue the prescribed Task without a pre-tool model announcement, and do not say the replacement is running until a real `subagentStart` proves it.',
  'cursor-api-limit-composer-choice': 'Traffic One correlated `{{ROLE}}`\'s Cursor child transcript to an API/usage-limit failure. The next eligible model in this highest/balanced role\'s original tier is the Composer floor, so pause once for the user\'s choice:\n\n**enable** — Restore API budget for **{{RECOMMENDED}}**, then reply **enable**; I’ll retry on the recommended model.\n\n**fallback** — Proceed now on **{{FALLBACK}}**.\n\nDo not start Composer until the user replies **fallback**. A cheapest-tier role treats Composer as its normal tier model and rotates automatically to its next candidate instead of showing this downgrade choice.',
  'cursor-model-unavailable-runtime-choice': 'Traffic One correlated `{{ROLE}}`\'s Cursor child transcript to an explicit model-unavailable failure for **{{FAILED}}**. This Settings prompt is valid only when the error text explicitly ties a model to “not enabled”, “disabled”, “unavailable”, “invalid”, “unsupported”, “unknown”, or “not found”.\n\n**enable** — Open Cursor Settings → Models, enable **{{FAILED}}**, then reply **enable**; I’ll retry on the recommended model.\n\n**fallback** — Proceed now on **{{FALLBACK}}**.\n\nDo not proceed until the user replies **enable** or **fallback**. The fallback is the next exact captured slug from this role\'s original tier.',
  'cursor-model-failure-generic': 'Traffic One correlated `{{ROLE}}`\'s Cursor child transcript to a non-API failure on **{{FAILED}}**. Use generic recovery and preserve the actual error; do not tell the user to enable a model. Authentication, network, user abort/cancel, context exhaustion, and generic API errors are not evidence that a model is disabled.',
  'cursor-api-limit-terminal': 'Traffic One model rotation is terminal for `{{ROLE}}` in this run: every eligible model that was actually started from the role\'s original tier reached an API/usage limit ({{TRIED}}). Stop retrying this role. The terminal marker remains after individual limit entries expire and clears only when the user replies **enable** or a new run starts; a model absent from Cursor\'s captured list never counts as API-limited.',
} as const;

const CORRELATION_EARLY_TOLERANCE_MS = 1_500;
const CORRELATION_WINDOW_MS = 2 * 60 * 1000;
const FAILURE_STATUSES = new Set(['error', 'failed', 'errored', 'stopped', 'aborted', 'cancelled', 'canceled']);
const SUCCESS_STATUSES = new Set(['completed', 'complete', 'success', 'succeeded', 'done']);

interface ParsedCursorTranscript {
  candidate: CursorTranscriptCandidate;
  role: string | null;
  lineCount: number;
  terminal: boolean;
  failed: boolean;
  error: string;
}

export interface CursorFailureReconcileResult {
  readonly processed: readonly CursorSpawnObservation[];
  readonly ambiguousTranscriptIds: readonly string[];
}

function stringifyErrorValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map(stringifyErrorValue).filter(Boolean).join('\n');
  const record = value as Record<string, unknown>;
  const direct = [
    record.error,
    record.error_message,
    record.errorMessage,
    record.message,
    record.detail,
    record.reason,
  ]
    .map(stringifyErrorValue)
    .filter(Boolean);
  if (direct.length) return direct.join('\n');
  try { return JSON.stringify(record); } catch { return ''; }
}

function parseCursorTranscript(candidate: CursorTranscriptCandidate): ParsedCursorTranscript | null {
  let raw = '';
  try { raw = fs.readFileSync(candidate.filePath, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  let terminalRecord: Record<string, unknown> | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index] as string) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
      const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
      if (type === 'turn_ended' || FAILURE_STATUSES.has(status) || SUCCESS_STATUSES.has(status)) {
        terminalRecord = record;
        break;
      }
    } catch {
      // A partially flushed final line is not terminal yet; a later hook retries.
    }
  }
  const status = terminalRecord && typeof terminalRecord.status === 'string'
    ? terminalRecord.status.trim().toLowerCase()
    : '';
  const terminal = Boolean(terminalRecord)
    && (String(terminalRecord?.type || '').toLowerCase() === 'turn_ended'
      || FAILURE_STATUSES.has(status)
      || SUCCESS_STATUSES.has(status));
  const error = terminalRecord
    ? stringifyErrorValue(
      terminalRecord.error
      ?? terminalRecord.error_message
      ?? terminalRecord.errorMessage
      ?? terminalRecord.message
      ?? terminalRecord.reason,
    )
    : '';
  const failed = terminal && (FAILURE_STATUSES.has(status) || Boolean(error));
  return {
    candidate,
    role: inferRoleFromTranscript(candidate.filePath),
    lineCount: lines.length,
    terminal,
    failed,
    error: error || (failed ? `Cursor subagent ended with status ${status || 'error'}.` : ''),
  };
}

// mtime is a last-write timestamp and therefore unsafe for ordinary child
// transcripts. The sole fallback is the incident's startup-failure shape: a
// terminal one-line JSONL whose filesystem does not expose birthtime.
function correlationTimeMs(transcript: ParsedCursorTranscript): number | null {
  if (Number.isFinite(transcript.candidate.birthtimeMs) && transcript.candidate.birthtimeMs > 0) {
    return transcript.candidate.birthtimeMs;
  }
  if (transcript.terminal && transcript.lineCount === 1
    && Number.isFinite(transcript.candidate.mtimeMs) && transcript.candidate.mtimeMs > 0) {
    return transcript.candidate.mtimeMs;
  }
  return null;
}

function compatibleObservation(
  observation: CursorSpawnObservation,
  transcript: ParsedCursorTranscript,
): boolean {
  if (observation.parentSessionId !== transcript.candidate.parentSessionId) return false;
  const transcriptAt = correlationTimeMs(transcript);
  if (!transcriptAt) return false;
  const delta = transcriptAt - observation.startedAtMs;
  return delta >= -CORRELATION_EARLY_TOLERANCE_MS && delta <= CORRELATION_WINDOW_MS;
}

function sameFamily(left: string, right: string): boolean {
  return modelMatchesExpected(left, right) || modelMatchesExpected(right, left);
}

// Cursor's Task model parameter is a concrete offered slug. Family matching is
// correct for exhaustion/unavailability sets, but a correlated retry may bypass
// the normal degradation gates only on the exact slug we prescribed.
function sameExactSlug(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

// Roles whose spawn failed into the enable/fallback decision this run. The
// model-choice gate uses this to SCOPE the pause: a healthy in-flight sibling
// role (no pending failure of its own) keeps working while the user decides.
// Consumed-ness is irrelevant here — the pause outlives observation consumption;
// only an applied retry (retryHandled) releases the role.
export function rolesAwaitingModelChoice(cwd: string, runId: string): Set<string> {
  const roles = new Set<string>();
  for (const observation of listCursorSpawnObservations(cwd, runId)) {
    if (observation.retryHandled) continue;
    if (observation.outcome === 'api-limit' || observation.outcome === 'model-unavailable') {
      roles.add(observation.role);
    }
  }
  return roles;
}

function unavailableModelsForRun(cwd: string, runId: string): string[] {
  // An explicit enable-retry choice means the user has fixed availability. Until
  // then, positive unavailable outcomes remain run-level exclusions so parallel
  // roles do not retry the same disabled slug.
  if (readModelChoice(cwd, runId) === 'enable-retry') return [];
  return listCursorSpawnObservations(cwd, runId)
    .filter((observation) => observation.outcome === 'model-unavailable')
    .map((observation) => observation.requestedModel);
}

function exactRecommendedModel(cwd: string, observation: CursorSpawnObservation): string {
  const captured = freshCursorModels(cwd, detectHostPlan('cursor'));
  return pickCursorSlug([observation.expectedModel], captured) || observation.expectedModel;
}

interface FailureResolution {
  kind: ModelFailureKind;
  directive: string;
  prescribedModel: string | null;
  terminal: boolean;
  choicePrompted: boolean;
}

function apiResolution(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
): FailureResolution {
  const plan = detectHostPlan('cursor');
  const captured = freshCursorModels(cwd, plan);
  const choice = readModelChoice(cwd, runId);
  const exhausted = [
    ...exhaustedModelsForRole(cwd, runId, observation.role),
    observation.requestedModel,
  ];
  const fallback = resolveTierFallback({
    tier: observation.tier,
    exhaustedModels: exhausted,
    unavailableModels: unavailableModelsForRun(cwd, runId),
    // Passing even an empty capture is intentional: a guessed family is not an
    // exact Cursor slug, and an absent family belongs to availability recovery.
    capturedModels: captured,
  }, 'cursor', plan);

  if (choice === 'enable-retry') {
    const recommended = exactRecommendedModel(cwd, observation);
    return {
      kind: 'api-limit',
      prescribedModel: recommended,
      terminal: false,
      choicePrompted: false,
      directive: `Traffic One recorded the run-level **enable** choice after ${observation.role}'s API/usage-limit failure. Restore API budget for **${recommended}** and retry this role on that exact Cursor slug; do not rotate to a fallback for this pending decision.`,
    };
  }

  if (fallback) {
    const composerFloor = /^composer/i.test(fallback.family);
    if (composerFloor && observation.tier !== 'cheapest') {
      if (choice !== 'use-fallback') {
        const recommended = exactRecommendedModel(cwd, observation);
        return {
          kind: 'api-limit',
          prescribedModel: fallback.model,
          terminal: false,
          choicePrompted: true,
          directive: block('cursor-api-limit-composer-choice', {
            ROLE: observation.role,
            RECOMMENDED: recommended,
            FALLBACK: fallback.model,
          }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-api-limit-composer-choice']),
        };
      }
    }
    return {
      kind: 'api-limit',
      prescribedModel: fallback.model,
      terminal: false,
      choicePrompted: false,
      directive: block('cursor-api-limit-auto-retry', {
        ROLE: observation.role,
        FAILED: observation.requestedModel,
        NEXT: fallback.model,
      }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-api-limit-auto-retry']),
    };
  }

  const row = currentModelsForTier(observation.tier, 'cursor', plan);
  const allActuallyLimited = row.length > 0
    && row.every((family) => exhausted.some((model) => sameFamily(model, family)));
  const composerWasAccepted = observation.tier === 'cheapest' || readModelChoice(cwd, runId) === 'use-fallback';
  if (allActuallyLimited && composerWasAccepted) {
    return {
      kind: 'api-limit',
      prescribedModel: null,
      terminal: true,
      choicePrompted: false,
      directive: block('cursor-api-limit-terminal', {
        ROLE: observation.role,
        TRIED: exhausted.join(', '),
      }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-api-limit-terminal']),
    };
  }

  const unavailable = unavailableModelsForRun(cwd, runId);
  const firstUnavailable = row.find((family) => unavailable.some((model) => sameFamily(model, family))
    && !exhausted.some((model) => sameFamily(model, family)));
  if (firstUnavailable) {
    const recommended = exactRecommendedModel(cwd, observation);
    return {
      kind: 'api-limit',
      prescribedModel: recommended,
      terminal: false,
      choicePrompted: true,
      directive: `Traffic One correlated ${observation.role}'s API-limit failure, but every remaining exact candidate in its original ${observation.tier} tier is explicitly model-unavailable. **enable** — Open Cursor Settings → Models, enable **${recommended}** and restore its API budget, then reply **enable**; I’ll retry that exact recommended slug. This is an availability flow, not “all models exhausted”. The unavailable tier candidate was **${firstUnavailable}**.`,
    };
  }

  const firstAbsent = row.find((family) => !captured.some((model) => sameFamily(model, family))
    && !exhausted.some((model) => sameFamily(model, family)));
  if (firstAbsent) {
    const recommended = exactRecommendedModel(cwd, observation);
    return {
      kind: 'api-limit',
      prescribedModel: recommended,
      terminal: false,
      choicePrompted: true,
      directive: `Traffic One correlated ${observation.role}'s API-limit failure, but no exact captured fallback remains in its original ${observation.tier} tier. **${firstAbsent}** is absent from Cursor's captured model list, so this is an availability decision, not “all models exhausted”. **enable** — Open Cursor Settings → Models, enable/re-capture **${recommended}** and restore its API budget, then reply **enable**; I’ll retry that exact recommended slug. Do not guess a slug or silently change tiers.`,
    };
  }

  return {
    kind: 'api-limit',
    prescribedModel: null,
    terminal: false,
    choicePrompted: false,
    directive: `Traffic One correlated ${observation.role}'s API-limit failure, but could not resolve an exact next Cursor slug from the role's original ${observation.tier} tier. Refresh the captured Cursor model list and use generic recovery; do not infer a model switch from the transcript error text.`,
  };
}

function modelUnavailableResolution(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
): FailureResolution {
  const plan = detectHostPlan('cursor');
  const captured = freshCursorModels(cwd, plan);
  const fallback = resolveTierFallback({
    tier: observation.tier,
    exhaustedModels: exhaustedModelsForRole(cwd, runId, observation.role),
    unavailableModels: [...unavailableModelsForRun(cwd, runId), observation.requestedModel],
    capturedModels: captured,
  }, 'cursor', plan);
  const fallbackLabel = fallback?.model || `the next enabled ${observation.tier}-tier model after re-capture`;
  const choice = readModelChoice(cwd, runId);
  if (choice === 'enable-retry') {
    const recommended = exactRecommendedModel(cwd, observation);
    return {
      kind: 'model-unavailable',
      prescribedModel: recommended,
      terminal: false,
      choicePrompted: false,
      directive: `Traffic One recorded the run-level **enable** choice after ${observation.role}'s explicit model-unavailable failure. Open Cursor Settings → Models, enable **${observation.requestedModel}**, then retry this role on the exact recommended slug **${recommended}**.`,
    };
  }
  if (choice === 'use-fallback' && fallback) {
    return {
      kind: 'model-unavailable',
      prescribedModel: fallback.model,
      terminal: false,
      choicePrompted: false,
      directive: `Traffic One correlated ${observation.role}'s Cursor child transcript to an explicit model-unavailable failure for **${observation.requestedModel}**. The user already selected fallback. **fallback** — Proceed now on **${fallback.model}**, the next exact captured slug in this role's original tier.`,
    };
  }
  return {
    kind: 'model-unavailable',
    prescribedModel: fallback?.model || null,
    terminal: false,
    choicePrompted: !choice,
    directive: block('cursor-model-unavailable-runtime-choice', {
      ROLE: observation.role,
      FAILED: observation.requestedModel,
      FALLBACK: fallbackLabel,
    }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-model-unavailable-runtime-choice']),
  };
}

function genericResolution(observation: CursorSpawnObservation): FailureResolution {
  return {
    kind: 'generic',
    prescribedModel: null,
    terminal: false,
    choicePrompted: false,
    directive: block('cursor-model-failure-generic', {
      ROLE: observation.role,
      FAILED: observation.requestedModel,
    }, CURSOR_FAILURE_BLOCK_FALLBACKS['cursor-model-failure-generic']),
  };
}

function resolutionFor(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
  kind: ModelFailureKind,
): FailureResolution {
  if (kind === 'api-limit') return apiResolution(cwd, runId, observation);
  if (kind === 'model-unavailable') return modelUnavailableResolution(cwd, runId, observation);
  return genericResolution(observation);
}

interface ClassifiedTerminalObservation {
  observation: CursorSpawnObservation;
  transcript: ParsedCursorTranscript;
  kind: ModelFailureKind;
}

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
  return new Set(ids.map((value) => value.trim()));
}

function correlatedPostToolObservation(
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

// Phase 1 is intentionally limited to durable facts from the transcript. It
// does not mutate model-choice/exhaustion state and it does not retire or consume
// anything. If the hook process stops here, a later pass can safely resume.
function persistTerminalClassification(
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

// Phase 2 publishes the directive, applies idempotent ledgers/markers, retires
// the matching false-live entry, and only then marks the child consumed. Every
// failed prerequisite leaves consumedAtMs unset so the next hook replays it.
function finalizeTerminalObservation(
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

function compareCursorStart(
  left: Pick<CursorSpawnObservation, 'startedAtMs' | 'toolCallId'>,
  right: Pick<CursorSpawnObservation, 'startedAtMs' | 'toolCallId'>,
): number {
  return left.startedAtMs - right.startedAtMs || left.toolCallId.localeCompare(right.toolCallId);
}

function matchingRegistryEntry(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
): RunAgentEntry | null {
  const entry = readRunAgentRegistry(cwd, runId)[observation.role];
  if (!entry || entry.replaced) return null;
  if (entry.parentSessionId && entry.parentSessionId !== observation.parentSessionId) return null;
  const observationIds = new Set([
    observation.toolCallId,
    observation.childTranscriptId || '',
  ].filter(Boolean));
  return [entry.agentId, entry.resumeId, entry.toolCallId]
    .some((value) => typeof value === 'string' && observationIds.has(value))
    ? entry
    : null;
}

interface CursorFailureSelectionOptions {
  state: unknown;
  raw: unknown;
  nowMs?: number;
  corroborated?: boolean;
  /** Settle inspects only starts strictly older than the start being recorded. */
  before?: Pick<CursorSpawnObservation, 'startedAtMs' | 'toolCallId'>;
}

interface CursorFailureSelection {
  head: CursorSpawnObservation;
  latest: CursorSpawnObservation;
}

function resumeCandidateForUnterminatedStart(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
  raw: unknown,
): CursorTranscriptCandidate | null {
  const observations = listCursorSpawnObservations(cwd, runId);
  const candidates = listCursorSubagentTranscriptCandidates(
    cwd,
    raw,
    observation.parentSessionId,
  )
    .filter((candidate) => inferRoleFromTranscript(candidate.filePath) === observation.role)
    .filter((candidate) => isResumeCapableAgentId(candidate.childTranscriptId))
    .sort((left, right) => {
      const leftAt = Number.isFinite(left.birthtimeMs) && left.birthtimeMs > 0
        ? left.birthtimeMs
        : left.mtimeMs;
      const rightAt = Number.isFinite(right.birthtimeMs) && right.birthtimeMs > 0
        ? right.birthtimeMs
        : right.mtimeMs;
      return rightAt - leftAt || right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath);
    });
  const newest = candidates[0];
  if (!newest) return null;
  const parsed = parseCursorTranscript(newest);
  if (!parsed || !compatibleObservation(observation, parsed)) return null;
  const owner = observations.find((item) => item.childTranscriptId === newest.childTranscriptId);
  return owner && owner.toolCallId !== observation.toolCallId ? null : newest;
}

// A newer, unterminated SubagentStart is a possible live retry and therefore
// masks the older finalized failure. Refresh the transcript-derived resume UUID
// before applying the shared 90/270-second policy. Expiry only retires the exact
// registry entry for this start; it never classifies or exhausts its model.
function unterminatedStartStillMasks(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
  options: CursorFailureSelectionOptions,
): boolean {
  // The generic role refresh always takes the newest role-bearing transcript.
  // Verify that transcript is compatible with this immutable start first, or an
  // older finalized child's UUID could be attached to a later tool_<id> and keep
  // the retry falsely live forever.
  if (resumeCandidateForUnterminatedStart(cwd, runId, observation, options.raw)) {
    refreshCursorRunAgentFromTranscriptCache(
      cwd,
      options.state,
      options.raw,
      runId,
      observation.role,
      observation.parentSessionId,
    );
  }
  const exactLive = matchingRegistryEntry(cwd, runId, observation);

  const corroborated = options.corroborated === true
    || observation.outcome !== null
    || modelIsExhausted(cwd, runId, observation.role, observation.requestedModel);
  if (!cursorAgentPresumedDead(exactLive, {
    corroborated,
    startedAtMs: observation.startedAtMs,
    nowMs: options.nowMs,
  })) return true;

  markRunAgentReplacedIfMatches(cwd, runId, observation.role, observation.toolCallId);
  return false;
}

// Stable selector for one parent+role stream. The newest consumed row is the
// permanent finalized head, even when already handled/suppressed or successful;
// older failures must never resurface. Starts after that head mask it while they
// may still be live. Selection and CAS fingerprints use only immutable start
// fields, never updatedAt (which follow-up/choice refreshes legitimately change).
function selectCursorFailureForParentRole(
  cwd: string,
  runId: string,
  parentSessionId: string,
  role: string,
  options: CursorFailureSelectionOptions,
): CursorFailureSelection | null {
  const observations = listCursorSpawnObservations(cwd, runId)
    .filter((observation) => observation.parentSessionId === parentSessionId && observation.role === role)
    .filter((observation) => !options.before || compareCursorStart(observation, options.before) < 0)
    .sort(compareCursorStart);
  const latest = observations.at(-1);
  if (!latest) return null;
  const finalized = observations.filter((observation) => observation.consumedAtMs !== null).at(-1);
  if (!finalized) return null;

  const laterUnterminated = observations.filter((observation) => (
    compareCursorStart(observation, finalized) > 0 && observation.consumedAtMs === null
  ));
  for (const blocker of laterUnterminated) {
    if (unterminatedStartStillMasks(cwd, runId, blocker, options)) return null;
  }
  return { head: finalized, latest };
}

function uniqueParentForRole(cwd: string, runId: string, role: string): string | null {
  const parents = new Set(listCursorSpawnObservations(cwd, runId)
    .filter((observation) => observation.role === role)
    .map((observation) => observation.parentSessionId));
  return parents.size === 1 ? [...parents][0]! : null;
}

function refreshPendingResolution(
  cwd: string,
  runId: string,
  observation: CursorSpawnObservation,
): CursorSpawnObservation {
  if (!observation.outcome || !observation.childTranscriptId) return observation;
  const resolution = resolutionFor(cwd, runId, observation, observation.outcome);
  if (resolution.choicePrompted) markModelChoicePrompted(cwd, runId);
  if (resolution.terminal && !modelExhaustionTerminalForRole(cwd, runId, observation.role)) {
    markModelExhaustionTerminal(cwd, runId, observation.role);
  }
  if (observation.directive === resolution.directive
    && observation.prescribedModel === resolution.prescribedModel) return observation;
  return updateCursorSpawnObservation(cwd, runId, observation.childTranscriptId, {
    directive: resolution.directive,
    prescribedModel: resolution.prescribedModel,
  }) || observation;
}

function claimCursorParentPendingFollowups(
  cwd: string,
  runId: string,
  state: unknown,
  raw: unknown,
  parentSessionId: string,
  observedAtMs: number,
): CursorSpawnObservation[] {
  // Transcript/liveness and resolution refreshes happen outside the state
  // lock. Converge on one stable parent snapshot: this includes every role and
  // every terminal/action transition, so a role finalized concurrently cannot
  // be omitted into a second follow-up. The state CAS recomputes the same full
  // fingerprint under lock and rejects any later transition atomically.
  let snapshot = cursorParentObservationSnapshot(cwd, runId, parentSessionId);
  let requests: CursorFollowupClaimRequest[] = [];
  for (let pass = 0; snapshot && pass < 3; pass += 1) {
    const roles = [...new Set(snapshot.observations.map((observation) => observation.role))].sort();
    const prepared: Omit<CursorFollowupClaimRequest, 'expectedParentFingerprint'>[] = [];
    for (const role of roles) {
      const selected = selectCursorFailureForParentRole(
        cwd,
        runId,
        parentSessionId,
        role,
        { state, raw, nowMs: observedAtMs },
      );
      if (!selected) continue;
      const head = refreshPendingResolution(cwd, runId, selected.head);
      if (!head.outcome || !head.childTranscriptId || !head.directive
        || head.retryHandled || head.followupEmitted || head.followupSuppressed) continue;
      prepared.push({
        parentSessionId,
        role,
        childTranscriptId: head.childTranscriptId,
        toolCallId: head.toolCallId,
        expectedLatestToolCallId: selected.latest.toolCallId,
        expectedLatestStartedAtMs: selected.latest.startedAtMs,
        directive: head.directive,
        prescribedModel: head.prescribedModel,
      });
    }
    const after = cursorParentObservationSnapshot(cwd, runId, parentSessionId);
    if (!after) return [];
    if (after.fingerprint !== snapshot.fingerprint) {
      snapshot = after;
      continue;
    }
    requests = prepared.map((request) => ({
      ...request,
      expectedParentFingerprint: snapshot!.fingerprint,
    }));
    break;
  }
  return requests.length
    ? claimCursorFollowupsBatch(cwd, runId, requests, observedAtMs)
    : [];
}

function rawParentSessionIds(raw: unknown): Set<string> {
  const data = obj(raw) || {};
  const payload = obj(data.payload) || {};
  const explicit = [
    data.parent_conversation_id,
    data.parentConversationId,
    payload.parent_conversation_id,
    payload.parentConversationId,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const values = explicit.length ? explicit : [
    data.session_id,
    data.sessionId,
    data.conversation_id,
    data.conversationId,
    payload.session_id,
    payload.sessionId,
    payload.conversation_id,
    payload.conversationId,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return new Set(values.map((value) => value.trim()));
}

const USER_ABORT_TEXT_RE = /\buser\s+(?:aborted|cancelled|canceled)\s+(?:the\s+)?request\b|\brequest\s+(?:was\s+)?(?:aborted|cancelled|canceled)\s+by\s+(?:the\s+)?user\b|\bUSER[_-](?:ABORTED|CANCELLED|CANCELED)\b/i;

function structuredAbortValue(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return USER_ABORT_TEXT_RE.test(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 1) return false;
  const record = value as Record<string, unknown>;
  if (record.user_aborted === true || record.userAborted === true
    || record.cancelled_by_user === true || record.canceled_by_user === true
    || record.cancelledByUser === true || record.canceledByUser === true) return true;
  return [
    record.error,
    record.error_message,
    record.errorMessage,
    record.message,
    record.reason,
    record.detail,
    record.code,
    record.status,
  ]
    .some((item) => structuredAbortValue(item, depth + 1));
}

function recordHasStructuredAbort(record: Record<string, unknown>): boolean {
  if (record.user_aborted === true || record.userAborted === true
    || record.cancelled_by_user === true || record.canceled_by_user === true
    || record.cancelledByUser === true || record.canceledByUser === true) return true;
  return [
    record.error,
    record.error_message,
    record.errorMessage,
    record.message,
    record.reason,
    record.detail,
    record.code,
    record.status,
  ]
    .some((value) => structuredAbortValue(value));
}

function lifecycleStatusIsAborted(record: Record<string, unknown>): boolean {
  const status = typeof record.status === 'string' ? record.status.trim().toLowerCase() : '';
  return status === 'aborted' || status === 'cancelled' || status === 'canceled';
}

function rawLifecycleRecord(raw: unknown): { data: Record<string, unknown>; payload: Record<string, unknown> } {
  const data = obj(raw) || {};
  return { data, payload: obj(data.payload) || {} };
}

function stopHasParentUserAbort(raw: unknown): boolean {
  const { data, payload } = rawLifecycleRecord(raw);
  return lifecycleStatusIsAborted(data)
    || lifecycleStatusIsAborted(payload)
    || recordHasStructuredAbort(data)
    || recordHasStructuredAbort(payload);
}

function subagentStopHasChildUserAbort(raw: unknown): boolean {
  const { data, payload } = rawLifecycleRecord(raw);
  return lifecycleStatusIsAborted(data)
    || lifecycleStatusIsAborted(payload)
    || recordHasStructuredAbort(data)
    || recordHasStructuredAbort(payload);
}

function subagentStopHasParentUserAbort(raw: unknown): boolean {
  const { data, payload } = rawLifecycleRecord(raw);
  const parent = obj(data.parent) || {};
  const payloadParent = obj(payload.parent) || {};
  const parentFields: Record<string, unknown> = {
    error: data.parent_error ?? data.parentError ?? payload.parent_error ?? payload.parentError,
    error_message: data.parent_error_message ?? data.parentErrorMessage
      ?? payload.parent_error_message ?? payload.parentErrorMessage,
    message: data.parent_message ?? data.parentMessage ?? payload.parent_message ?? payload.parentMessage,
    reason: data.parent_reason ?? data.parentReason ?? payload.parent_reason ?? payload.parentReason,
    code: data.parent_code ?? data.parentCode ?? payload.parent_code ?? payload.parentCode,
    status: data.parent_status ?? data.parentStatus ?? payload.parent_status ?? payload.parentStatus,
    user_aborted: data.parent_user_aborted ?? data.parentUserAborted
      ?? payload.parent_user_aborted ?? payload.parentUserAborted,
  };
  return lifecycleStatusIsAborted(parentFields)
    || lifecycleStatusIsAborted(parent)
    || lifecycleStatusIsAborted(payloadParent)
    || recordHasStructuredAbort(parentFields)
    || recordHasStructuredAbort(parent)
    || recordHasStructuredAbort(payloadParent);
}

function latestParentTurnWasUserAborted(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const record = JSON.parse(lines[index] as string) as unknown;
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      const item = record as Record<string, unknown>;
      const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
      const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
      if (type !== 'turn_ended' && !FAILURE_STATUSES.has(status) && !SUCCESS_STATUSES.has(status)) continue;
      return recordHasStructuredAbort(item);
    } catch {
      // Ignore an incomplete tail line and continue to the latest complete turn.
    }
  }
  return false;
}

function parentTranscriptWasUserAborted(
  cwd: string,
  raw: unknown,
  parentSessionId: string,
  pending: readonly CursorSpawnObservation[],
): boolean {
  // Parent transcripts are read ONLY as a cancellation guard; they never enter
  // failure classification/correlation. Child results still come exclusively
  // from subagents/*.jsonl.
  const wanted = new Map(pending
    .filter((observation) => observation.childTranscriptId)
    .map((observation) => [observation.childTranscriptId as string, observation.parentSessionId]));
  if (!wanted.size) return false;
  for (const candidate of listCursorSubagentTranscriptCandidates(cwd, raw)) {
    const parentId = wanted.get(candidate.childTranscriptId);
    if (!parentId || parentId !== parentSessionId || parentId !== candidate.parentSessionId) continue;
    const parentPath = path.join(path.dirname(path.dirname(candidate.filePath)), `${parentId}.jsonl`);
    try {
      const stat = fs.statSync(parentPath);
      const start = Math.max(0, stat.size - 32_768);
      const fd = fs.openSync(parentPath, 'r');
      try {
        const bytes = Buffer.alloc(stat.size - start);
        fs.readSync(fd, bytes, 0, bytes.length, start);
        if (latestParentTurnWasUserAborted(bytes.toString('utf8'))) return true;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // No parent transcript (or a concurrently rotating file) → raw hook data
      // remains the only cancellation evidence; do not suppress optimistically.
    }
  }
  return false;
}

function rawLifecycleTimeMs(raw: unknown): number {
  const { data, payload } = rawLifecycleRecord(raw);
  for (const value of [
    data.timestamp, data.occurred_at, data.occurredAt, data.ended_at, data.endedAt,
    payload.timestamp, payload.occurred_at, payload.occurredAt, payload.ended_at, payload.endedAt,
  ]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value < 1_000_000_000_000 ? value * 1000 : value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return Date.now();
}

function rawSubagentIds(raw: unknown): Set<string> {
  const { data, payload } = rawLifecycleRecord(raw);
  return new Set([
    data.subagent_id, data.subagentId, data.tool_call_id, data.toolCallId,
    payload.subagent_id, payload.subagentId, payload.tool_call_id, payload.toolCallId,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim()));
}

interface CursorLifecycleTarget {
  parentSessionId: string;
  subagent: CursorSpawnObservation | null;
}

function exactCursorLifecycleTarget(
  event: Ctx['input']['event'],
  raw: unknown,
  observations: readonly CursorSpawnObservation[],
): CursorLifecycleTarget | null {
  const parents = rawParentSessionIds(raw);
  if (parents.size !== 1) return null;
  const parentSessionId = [...parents][0]!;
  if (event === 'Stop') return { parentSessionId, subagent: null };
  if (event !== 'SubagentStop') return null;
  const childIds = rawSubagentIds(raw);
  if (!childIds.size) return null;
  const matches = observations.filter((observation) => (
    observation.parentSessionId === parentSessionId
    && [...childIds].some((childId) => (
      observation.toolCallId === childId || observation.childTranscriptId === childId
    ))
  ));
  return matches.length === 1 ? { parentSessionId, subagent: matches[0]! } : null;
}

/** Handler for Cursor session/prompt/stop/subagentStop reconciliation passes. */
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
    const recommended = exactRecommendedModel(cwd, pending);
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
export interface CursorRetryStart {
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
  const expected = choice === 'enable-retry'
    ? exactRecommendedModel(cwd, pending)
    : pending.prescribedModel;
  if (!expected || !sameExactSlug(start.startedModel, expected)) return null;
  if (pending.outcome === 'api-limit' && /^composer/i.test(expected)
    && pending.tier !== 'cheapest' && choice !== 'use-fallback') return null;
  if (pending.outcome === 'model-unavailable' && choice !== 'use-fallback' && choice !== 'enable-retry') return null;
  return markCursorSpawnObservationRetryHandled(cwd, runId, pending.childTranscriptId);
}
