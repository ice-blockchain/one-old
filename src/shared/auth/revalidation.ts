// src/shared/auth/revalidation.ts
// THE one place the four fail directions of session-start revalidation are
// decided. Nothing here touches the network, spawns anything, or writes: the
// worker (runners/auth/revalidate.ts) and the hook-side starter
// (start-revalidation.ts) each ask this module what to do and then do it, so a
// policy change is one edit in one file with tests on it, rather than four
// `if` statements that drifted apart at four call sites.
//
// ── the four directions ─────────────────────────────────────────────────────
//
//  1. AUTHORITATIVE REJECTION — fail CLOSED. The gate answered no about THIS
//     KEY: an empty key, or a 401 carrying `error.code: "invalid_token"`.
//     Deliberately NOT every 401 — three of the auth gate's four 401 codes say
//     nothing about the key, and one of them (`unkey_unavailable`) fires when
//     the auth PROVIDER is down, so blanket-clearing on 401 would sign the
//     whole fleet out during someone else's outage. That discrimination lives
//     in runners/auth/validate-key.ts, one layer down, so everything here still
//     sees exactly the two arms offline-grace.ts is written against.
//     Clearing the record is enough: computeOnboarding then returns step
//     'api-key' (onboarding-server/flow.ts) and SessionStart routes that to the
//     setup-pending directive, so the wizard re-opens with no new surface
//     invented for it.
//
//  2. INDETERMINATE, INSIDE THE GRACE WINDOW — fail OPEN, silently. Nobody
//     answered about the key: a timeout, DNS, a 429 from the pre-auth rate
//     limiters, a 5xx, an auth-provider outage. offline-grace.ts already owns
//     exactly this question and is the sole judge of it; this module never
//     re-derives the window.
//
//  3. INDETERMINATE, BEYOND THE GRACE WINDOW — fail OPEN, but SAY SO. This is
//     the one genuine policy edge, and it is decided here, once:
//
//       Clearing the record beyond the window is not a stricter version of
//       failing closed — it is a BRICK. The only way back in is the wizard's
//       api-key page, whose /answer route calls the SAME validateApiKey
//       (runners/onboarding-server/routes.ts) and answers "Could not reach
//       Traffic One to verify the key" on exactly the failure that got the user
//       cleared. So a paying user on a plane would lose local access AND be
//       unable to restore it until they are online — while the revoked user we
//       would be aiming at loses nothing they could not get back by staying
//       offline, since the same unreachability that expired the window is what
//       stops us proving anything about their key.
//
//       The asymmetry therefore runs one way only: the tight direction strands
//       a paying customer with a hard, self-inflicted lockout; the generous
//       direction extends a subscription that this machine cannot currently
//       verify, to a machine that already had it, and that goes on paying the
//       product's remote features nothing. We take the generous direction and
//       make it VISIBLE — one advisory per session naming how long it has been
//       and what to do — so "unverifiable forever" is a state the user can see
//       rather than one the product hides.
//
//  4. A REFUSED LOCAL WRITE is never a success. Two of them exist and both are
//     surfaced rather than swallowed: a refused clearAuthentication (the key
//     was REJECTED and we are still trusting it) re-opens the cadence
//     immediately and raises an advisory; a refused cadence stamp stops the
//     probe from being started at all, because a probe charged to nothing runs
//     again on every session.

import { AUTH_REVALIDATION_CADENCE_MS } from '../../config/auth';
import { trustworthyAgeSince } from '../clock-skew';
import { offlineGraceVerdict } from './offline-grace';
import type { RevalidationState } from './revalidation-state';

/**
 * The validator's answer, expressed structurally so this module (and the whole
 * of shared/) stays free of a runtime import from runners/. __tests__/
 * revalidation.test.ts pins the union to `KeyValidation` at compile time, the
 * same way offline-grace.test.ts pins AuthValidationFailure.
 */
export type AuthValidationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid-api-key' | 'auth-endpoint-unreachable' };

export type RevalidationAction =
  /** The gate said yes. Re-stamp `auth.updatedAt`: it is documented as the
   *  instant of a real successful validation, and this IS one, so the offline
   *  grace window restarts from the last confirmation instead of from intake. */
  | { readonly kind: 'confirm' }
  /** The gate said no. Clear the record and re-open the api-key wizard step. */
  | { readonly kind: 'revoke' }
  /** No answer, inside the window. Do nothing at all — deliberately including
   *  not re-stamping, which is what would turn a bounded grace into an
   *  unbounded one (see offline-grace.ts). */
  | { readonly kind: 'grace'; readonly ageMs: number }
  /** No answer, outside the window. Keep access; the session surface warns. */
  | { readonly kind: 'unconfirmed' };

/**
 * What the worker must do with one probe result, for the key it probed with.
 *
 * `key` is the key read from the record moments earlier, so offlineGraceVerdict's
 * "does the submitted key match the cached one?" arm re-reads the record and
 * answers a slightly different but strictly better question here: did the
 * record change underneath this probe? If it did, the verdict is not granted,
 * we land on 'unconfirmed', and nothing is written — which is the right answer
 * for a probe whose subject no longer exists.
 */
export function revalidationAction(
  result: AuthValidationOutcome,
  key: string,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): RevalidationAction {
  if (result.ok) return { kind: 'confirm' };
  if (result.reason === 'invalid-api-key') return { kind: 'revoke' };
  const grace = offlineGraceVerdict(result.reason, key, nowMs, env);
  return grace.granted ? { kind: 'grace', ageMs: grace.ageMs } : { kind: 'unconfirmed' };
}

export type RevalidationDueReason =
  | 'never-probed'
  | 'cadence-elapsed'
  | 'untrustworthy-stamp'
  | 'unresolved-revocation'
  | 'unconfirmed-beyond-grace';

export interface SessionRevalidationPlan {
  /** Start a probe now? */
  readonly due: boolean;
  readonly dueReason: RevalidationDueReason | 'within-cadence';
  /** One line for the session header, or null when there is nothing to say. */
  readonly advisory: string | null;
}

/**
 * Whether an unreachable-endpoint history has now outlived the grace window,
 * asked of the SAME judge the worker asked, so the session surface and the
 * worker can never disagree about where the window ends.
 */
function beyondGrace(key: string, nowMs: number, env: NodeJS.ProcessEnv): boolean {
  return !offlineGraceVerdict('auth-endpoint-unreachable', key, nowMs, env).granted;
}

// Neither advisory names the key, not even a suffix of it. Both strings land in
// agent-visible session context, which is transcribed into transcripts, logs
// and pasted issues, and the user has exactly one key — a hint would identify
// nothing they do not already know while putting bytes of a bearer credential
// somewhere it is copied by default.
function unconfirmedAdvisory(state: RevalidationState, nowMs: number): string {
  const sinceMs = trustworthyAgeSince(Date.parse(state.outcomeAt || state.attemptedAt), nowMs);
  const days = sinceMs === null ? null : Math.floor(sinceMs / (24 * 60 * 60 * 1000));
  const howLong = days === null || days < 1 ? 'for some time' : `for ${days} day${days === 1 ? '' : 's'}`;
  return [
    `Traffic One has not been able to confirm this machine's subscription ${howLong}:`,
    'the check could not be completed (no network, or the sign-in provider is down) and the',
    'offline grace window has lapsed. Traffic One keeps running with the key already stored here —',
    'reconnect and it re-confirms itself automatically on a later session. Nothing to do otherwise.',
  ].join(' ');
}

function revokeRefusedAdvisory(): string {
  return [
    'Traffic One could not invalidate this machine\'s API key after the server REJECTED it:',
    'another writer holds the Traffic One settings file, so the rejected key is still stored and',
    'still granting access. Nothing was silently accepted — Traffic One retries on the next',
    'session and re-opens the API-key page as soon as the record can be removed.',
  ].join(' ');
}

/**
 * The session-start question, answered from state that is already in hand plus
 * at most one extra small read.
 *
 * Reading order is the cost order. `state === null` (never probed) and the
 * two unresolved outcomes short-circuit before any grace read; the steady-state
 * path — a machine that was confirmed a few hours ago — reaches the arithmetic
 * on the third line and reads nothing further.
 *
 * Clock skew: this is an ACTION BLOCKED BY FRESHNESS (the probe is suppressed
 * while the stamp is fresh), so clock-skew.ts's prescription folds `null` to
 * ALLOW — a stamp dated further ahead than any clock justifies must not be able
 * to suppress revalidation forever, which is a one-line edit of one file away
 * from being an unbounded bypass of this entire lane.
 */
export function sessionRevalidationPlan(
  key: string,
  state: RevalidationState | null,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): SessionRevalidationPlan {
  if (!state) return { due: true, dueReason: 'never-probed', advisory: null };

  // A rejection we could not act on is the one state the product must never
  // sit on for a cadence period: access is live on a key the server said no to.
  if (state.outcome === 'revoke-refused') {
    return { due: true, dueReason: 'unresolved-revocation', advisory: revokeRefusedAdvisory() };
  }

  if (state.outcome === 'unreachable' && beyondGrace(key, nowMs, env)) {
    return {
      due: true,
      dueReason: 'unconfirmed-beyond-grace',
      advisory: unconfirmedAdvisory(state, nowMs),
    };
  }

  const ageMs = trustworthyAgeSince(Date.parse(state.attemptedAt), nowMs);
  if (ageMs === null) return { due: true, dueReason: 'untrustworthy-stamp', advisory: null };
  if (ageMs >= AUTH_REVALIDATION_CADENCE_MS) return { due: true, dueReason: 'cadence-elapsed', advisory: null };
  return { due: false, dueReason: 'within-cadence', advisory: null };
}
