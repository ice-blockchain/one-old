// src/shared/auth/revalidation-state.ts
// The machine-level record of "when did this machine last ask the authority
// about its key, and what did the authority say?".
//
// It is one of the two machine sidecars; ./machine-sidecar.ts holds the shared
// reasoning for where they live, why they are not fields of one.json, and why
// they are written through raw `fs` rather than the fenced project-tree helpers.
//
// MACHINE level, deliberately, not per project: the key is one credential for
// the whole machine, and a per-project cadence would multiply one machine-wide
// question by (projects x sessions).

import {
  isoNoMs,
  machineSidecarPath,
  readMachineSidecar,
  writeMachineSidecar,
} from './machine-sidecar';

export const REVALIDATION_STATE_FILE = 'auth-revalidation.json';
const REVALIDATION_STATE_VERSION = 1;

/**
 * What the last completed probe concluded. Deliberately NOT "graced" vs
 * "expired": whether an unreachable endpoint is still inside the offline grace
 * window depends on how much time has passed SINCE, so that classification is
 * recomputed at read time (revalidation.ts) and never frozen here.
 */
export type RevalidationOutcome =
  /** The authority answered yes; `auth.updatedAt` was re-stamped. */
  | 'confirmed'
  /** The authority answered yes; the re-stamp of `auth.updatedAt` was refused. */
  | 'confirmed-stamp-refused'
  /** 401/403 — the authority answered no, and the local record was cleared. */
  | 'revoked'
  /** 401/403 — the authority answered no, and clearAuthentication REFUSED. */
  | 'revoke-refused'
  /** No answer (DNS, refused, timeout, 5xx, a 2xx with no JSON-RPC result). */
  | 'unreachable';

export interface RevalidationState {
  /** When a probe was last STARTED. Stamped by the hook before it spawns the
   *  worker, so a worker that never runs still consumes its cadence slot. */
  readonly attemptedAt: string;
  /** Absent until a worker has actually finished one probe. */
  readonly outcome?: RevalidationOutcome;
  readonly outcomeAt?: string;
}

export function revalidationStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return machineSidecarPath(REVALIDATION_STATE_FILE, env);
}

function isOutcome(value: unknown): value is RevalidationOutcome {
  return value === 'confirmed' || value === 'confirmed-stamp-refused'
    || value === 'revoked' || value === 'revoke-refused' || value === 'unreachable';
}

/**
 * `null` for absent, unreadable, or malformed — all three mean "this machine
 * has no usable history", which is the same input the cadence treats as due.
 * Never throws and never rewrites the file it could not parse.
 */
export function readRevalidationState(env: NodeJS.ProcessEnv = process.env): RevalidationState | null {
  const raw = readMachineSidecar(REVALIDATION_STATE_FILE, REVALIDATION_STATE_VERSION, env);
  if (!raw) return null;
  const attemptedAt = typeof raw.attemptedAt === 'string' ? raw.attemptedAt.trim() : '';
  if (!attemptedAt) return null;
  const state: { attemptedAt: string; outcome?: RevalidationOutcome; outcomeAt?: string } = { attemptedAt };
  if (isOutcome(raw.outcome)) {
    state.outcome = raw.outcome;
    if (typeof raw.outcomeAt === 'string' && raw.outcomeAt.trim()) state.outcomeAt = raw.outcomeAt.trim();
  }
  return state;
}

/**
 * FALSE when the write was refused, and every caller spends that boolean: the
 * hook must not spawn a probe it could not charge to the cadence (it would then
 * spawn on EVERY session), and the worker must not let a refused outcome read
 * as a recorded one.
 */
function writeRevalidationState(state: RevalidationState, env: NodeJS.ProcessEnv): boolean {
  return writeMachineSidecar(REVALIDATION_STATE_FILE, REVALIDATION_STATE_VERSION, { ...state }, env);
}

/**
 * Charge a cadence slot before the probe is started.
 *
 * The PREVIOUS outcome is carried forward rather than cleared, and that is
 * load-bearing for the session advisory: the advisory is driven by the last
 * CONCLUDED outcome, so clearing it here would blank the warning for every
 * session between this stamp and the worker's own write — permanently, if the
 * worker never completes. An attempt in flight beside the last conclusion is
 * exactly what an advisory should be reading.
 */
export function stampRevalidationAttempt(
  nowMs: number,
  previous: RevalidationState | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const next: { attemptedAt: string; outcome?: RevalidationOutcome; outcomeAt?: string } = { attemptedAt: isoNoMs(nowMs) };
  if (previous?.outcome) {
    next.outcome = previous.outcome;
    if (previous.outcomeAt) next.outcomeAt = previous.outcomeAt;
  }
  return writeRevalidationState(next, env);
}

/**
 * Record what the probe concluded, preserving the attempt stamp the hook wrote
 * so the worker cannot extend its own cadence slot. A state that vanished
 * underneath the worker (cleared, relocated) is re-created with the outcome
 * instant as the attempt instant — the cadence is then measured from the only
 * timestamp that still exists, which is later than the real attempt and
 * therefore errs toward waiting rather than toward hammering.
 */
export function recordRevalidationOutcome(
  outcome: RevalidationOutcome,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const stamp = isoNoMs(nowMs);
  const previous = readRevalidationState(env);
  return writeRevalidationState({
    attemptedAt: previous?.attemptedAt || stamp,
    outcome,
    outcomeAt: stamp,
  }, env);
}
