// Shared Cursor no-resume liveness policy.
//
// Cursor records a tool-call id (`tool_<uuid>` legacy, `fc_<call-id>` current) at
// SubagentStart before a resumable child UUID is
// available. A healthy child normally exposes that UUID through the transcript
// cache within seconds. Until then, a later Task must not duplicate it. We use
// the same two conservative windows everywhere that needs to reason about an
// unterminated start: 90 seconds with independent death evidence, otherwise 270
// seconds. This module deliberately does not classify or exhaust models.

import {
  CURSOR_RESUME_ID_GRACE_MS,
  CURSOR_RESUME_ID_HARD_MS,
  SUBAGENT_STALE_MS,
} from '../../config/state';
import {
  ageAttestsLiveness,
  continuationAgentId,
  type RunAgentEntry,
} from '../../shared/state';

interface CursorLivenessOptions {
  corroborated: boolean;
  /** Immutable SubagentStart time, used when the registry row is absent. */
  startedAtMs?: number;
  nowMs?: number;
}

export function cursorAgentPresumedDead(
  live: RunAgentEntry | null,
  options: CursorLivenessOptions,
): boolean {
  // A continuation id is a PRECONDITION for resuming an agent, never evidence
  // that the agent is running: it is minted from the spawn result (or harvested
  // from a transcript that may have been written and abandoned) and nothing ever
  // revokes it. Returning "not dead" on its presence made the row immortal with
  // no time bound at all, which is a permanent deadlock for the one caller that
  // can reach it with an id in hand — cursor-failure-select.ts refreshes the
  // resume UUID and then asks this question, so an upgraded row masked the
  // role's finalized failure forever and its retry follow-up was never emitted.
  //
  // The id changes WHICH window applies, not whether one does. With no id we are
  // waiting for something a healthy child produces in seconds, so the 90/270s
  // windows bound that wait. With an id there is nothing left to wait for and
  // the only remaining question is whether the row is stale, which is
  // SUBAGENT_STALE_MS everywhere else in the system — the same bound
  // liveRunAgent applies to this row and claims-pending.ts applies to the write
  // authority of the agent it names. No new number: a resume-capable agent stops
  // being protected here exactly when it stops counting as live anywhere else.
  const maxAgeMs = live && continuationAgentId(live, 'cursor')
    ? SUBAGENT_STALE_MS
    : (options.corroborated ? CURSOR_RESUME_ID_GRACE_MS : CURSOR_RESUME_ID_HARD_MS);
  const registryTime = live && typeof live.recordedAt === 'string'
    ? Date.parse(live.recordedAt)
    : NaN;
  const recordedAtMs = Number.isFinite(registryTime)
    ? registryTime
    : (typeof options.startedAtMs === 'number' && Number.isFinite(options.startedAtMs)
      ? options.startedAtMs
      : NaN);
  // Through the shared predicate rather than a local branch. An absent or
  // unparseable stamp used to return "not dead" right here, which is the exact
  // inverse of what ageAttestsLiveness says about the same input — a row that
  // cannot say when it was recorded was immortal, and so was one stamped in the
  // future. Ignorance is not life: with no usable stamp there is no attestation.
  const age = (options.nowMs ?? Date.now()) - recordedAtMs;
  return !ageAttestsLiveness(age, maxAgeMs);
}
