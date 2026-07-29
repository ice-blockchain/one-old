// src/modules/agent-model/cursor-failure-prose.ts
// Block prose closures, the verbatim SKILL.md fallbacks, correlation
// windows, and the shared status/transcript shapes.

import { deny, followup, context, noop } from '../../core/result';
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

const skillBlock = makeSkillBlock(pluginRoot);
export const block = (
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

export const CORRELATION_EARLY_TOLERANCE_MS = 1_500;
export const CORRELATION_WINDOW_MS = 2 * 60 * 1000;
export const FAILURE_STATUSES = new Set(['error', 'failed', 'errored', 'stopped', 'aborted', 'cancelled', 'canceled']);
export const SUCCESS_STATUSES = new Set(['completed', 'complete', 'success', 'succeeded', 'done']);

export interface ParsedCursorTranscript {
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
