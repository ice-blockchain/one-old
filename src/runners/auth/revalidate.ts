// src/runners/auth/revalidate.ts
// The background API-key revalidation worker.
//
// Spawned DETACHED from SessionStart (shared/auth/start-revalidation.ts) at
// most once per AUTH_REVALIDATION_CADENCE_MS per machine, with `stdio: 'ignore'`
// and nothing waiting on it. It is therefore the one place in this lane that is
// allowed to spend a 10-second network timeout, and the one place with NO
// channel back to a human — every conclusion it reaches has to be written down
// (shared/auth/revalidation-state.ts) or it never happened.
//
// It does exactly four things and decides none of them:
//   1. read this machine's stored key (shared/auth/simple-auth.ts);
//   2. ask the authenticated MCP surface about it (./validate-key.ts, the same
//      `tools/call` → `updates` Bearer probe the wizard uses at intake);
//   3. do what shared/auth/revalidation.ts says, and record what happened;
//   4. sanitise and persist whatever feed that ONE request also returned.
//
// Step 4 rides along rather than costing a second call, and that is a rate-limit
// decision, not a tidiness one: the server throttles on verified identity (60
// requests/min per USER, across every machine that user owns), so a separate
// liveness ping and feed fetch would spend twice the budget to learn what one
// call already proves. It also means the feed inherits the revalidation cadence
// for free — at most one fetch per machine per AUTH_REVALIDATION_CADENCE_MS.
//
// The items this worker writes are shown by a LATER session. That staleness is
// the design (see shared/auth/updates-store.ts) — the alternative is a 10-second
// network call in front of every session start.
//
// The policy lives next door on purpose. This file is untestable-by-inspection
// (a process, a socket, a 10-second timeout); the decision it enacts is a pure
// function of two values and is held by tests that need none of that.
//
// ── every write here is checked ─────────────────────────────────────────────
// `clearAuthentication` returns false when the canonical settings lock cannot be
// taken, and this is its first and only product caller. A refused clear is
// recorded as `revoke-refused`, which re-opens the cadence immediately (no
// waiting a day while a rejected key keeps working) and raises a session
// advisory. It is never recorded as `revoked`. The same applies to the
// success path's re-stamp: `confirmed-stamp-refused` is a distinct outcome
// from `confirmed` because an un-advanced `auth.updatedAt` means the offline
// grace window is still running from the PREVIOUS confirmation.
//
// The two FEED writes are checked the same way and report through one field,
// `feedWritten`, rather than through the outcome. They are deliberately kept out
// of `RevalidationOutcome`: that union is the verdict on the CREDENTIAL, it
// drives the session advisory, and folding a stale announcements file into
// `revoke-refused` would tell the user a rejected key is still granting access
// when it has in fact just been cleared. So the credential verdict and the feed
// verdict are two facts, reported as two fields, and neither is minted over the
// other's refusal.

import { authEnforced } from '../../shared/auth';
import { clearAuthentication, readSimpleAuth, writeSimpleAuth } from '../../shared/auth/simple-auth';
import {
  recordRevalidationOutcome,
  type RevalidationOutcome,
} from '../../shared/auth/revalidation-state';
import { revalidationAction } from '../../shared/auth/revalidation';
import { safeUpdatesPage } from '../../shared/auth/updates-feed';
import { clearUpdatesStore, readUpdatesStore, recordUpdatesPage } from '../../shared/auth/updates-store';
import { probeAuthenticatedUpdates } from './validate-key';

export type RevalidationRun =
  | { readonly ran: false; readonly reason: 'auth-not-enforced' | 'not-authenticated' }
  | {
    readonly ran: true;
    readonly outcome: RevalidationOutcome;
    readonly recorded: boolean;
    /**
     * How many sanitised items REACHED THE STORE. 0 on every non-ok arm — and
     * also 0 when the store refused the page, because this is a claim about
     * disk, never about what the response contained.
     */
    readonly fetched: number;
    /**
     * Did the feed write this arm owed actually land? `null` when no feed write
     * was owed at all: the two indeterminate arms write nothing by design, and a
     * confirmed probe that returned an empty, un-advancing page has nothing to
     * store. `false` is a DURABLE refusal (an unwritable machine dir, a sidecar
     * path that is not a file) — retrying inside this run would answer the same,
     * so it is reported rather than retried, and the next cadenced probe is the
     * retry. On the revoke arm `false` is the serious one: the previous
     * identity's announcements and their user-bound cursor are still on disk.
     */
    readonly feedWritten: boolean | null;
  };

export interface RevalidateDeps {
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly nowMs?: () => number;
  readonly probe?: typeof probeAuthenticatedUpdates;
}

export async function runAuthRevalidation(
  env: NodeJS.ProcessEnv = process.env,
  deps: RevalidateDeps = {},
): Promise<RevalidationRun> {
  if (!authEnforced(env)) return { ran: false, reason: 'auth-not-enforced' };
  const record = readSimpleAuth(env);
  if (!record) return { ran: false, reason: 'not-authenticated' };

  const probe = deps.probe ?? probeAuthenticatedUpdates;
  const options: { endpoint?: string; timeoutMs?: number; cursor?: string } = {};
  if (deps.endpoint !== undefined) options.endpoint = deps.endpoint;
  if (deps.timeoutMs !== undefined) options.timeoutMs = deps.timeoutMs;
  // Resume where the last page stopped. Verbatim, unread: the cursor is
  // server-issued, user-bound and version-tagged, and this client's only
  // contract with it is to hand back the exact bytes it was handed.
  const cursor = readUpdatesStore(env).cursor;
  if (cursor) options.cursor = cursor;
  const { validation, result: payload } = await probe(record.apiKey, options);

  const now = deps.nowMs ?? Date.now;
  const action = revalidationAction(validation, record.apiKey, now(), env);
  let fetched = 0;
  let feedWritten: boolean | null = null;
  let outcome: RevalidationOutcome;
  switch (action.kind) {
    case 'confirm':
      // A REAL successful validation, which is precisely what `auth.updatedAt`
      // is documented to record — so re-stamping it here is what makes the
      // offline grace window mean "seven days since the endpoint last confirmed
      // this key" instead of "seven days since the user typed it in". It does
      // NOT reopen the hazard offline-grace.ts guards against: that one is
      // about re-stamping on a GRACE ACCEPT, where nothing was confirmed.
      outcome = restamp(record.apiKey, env) ? 'confirmed' : 'confirmed-stamp-refused';
      // The feed rides on the SAME response, and only this arm has one. It is
      // folded in after the credential work so a failure to persist prose can
      // never change the verdict on the key.
      ({ fetched, written: feedWritten } = persistFeed(payload, now(), env));
      break;
    case 'revoke':
      outcome = clearAuthentication(env) ? 'revoked' : 'revoke-refused';
      // The feed belongs to the identity behind the key that was just rejected.
      // Leaving it on disk would hand one user's announcements to whoever signs
      // in next, and would keep replaying a cursor bound to the old user that
      // the server now rejects on every page. That is a cross-user data
      // exposure, so a refused clear is REPORTED — it used to be dropped, which
      // made the one write on this path whose refusal matters most the only one
      // nobody could see.
      feedWritten = clearUpdatesStore(env);
      break;
    case 'grace':
    case 'unconfirmed':
      // Deliberately no write of any kind on either arm. The record stays as it
      // is, and the window keeps running from the last real confirmation.
      outcome = 'unreachable';
      break;
  }
  return { ran: true, outcome, fetched, feedWritten, recorded: recordRevalidationOutcome(outcome, now(), env) };
}

interface FeedPersist {
  /** Items that reached the store. Never a count of items merely RECEIVED. */
  readonly fetched: number;
  /** The write's answer, or `null` when no write was owed. See `feedWritten`. */
  readonly written: boolean | null;
}

/**
 * Sanitise the feed off a confirmed probe and fold it into the machine store.
 * Reports how many items survived AND whether they landed — 0 items covers "the
 * server sent none", "the tool reported a backend fault", and "nothing in the
 * payload was renderable", which are the same instruction to the caller: show
 * nothing new.
 *
 * The count and the write's answer are returned together because they are the
 * same fact seen twice. This used to discard `recordUpdatesPage`'s boolean and
 * then `return page.items.length`, so a refused write was reported to the caller
 * as N items persisted — the count was minted one line after the only thing
 * that could have contradicted it was thrown away.
 *
 * Wrapped, because this is the one part of the worker that parses REMOTE PROSE.
 * A throw here would abandon the outcome record that the whole cadence depends
 * on, and the credential half of this run has already succeeded by the time it
 * is reached. shared/auth/updates-feed.ts is written not to throw; this is the
 * belt to that pair of braces.
 */
function persistFeed(
  payload: Record<string, unknown> | undefined,
  nowMs: number,
  env: NodeJS.ProcessEnv,
): FeedPersist {
  try {
    const page = safeUpdatesPage(payload);
    // An empty page still advances nothing and writes nothing: `recordUpdatesPage`
    // would only re-stamp `fetchedAt`, and a write is not free on a path that
    // runs on every machine.
    if (page.items.length === 0 && !page.nextCursor) return { fetched: 0, written: null };
    if (!recordUpdatesPage(page, nowMs, env)) return { fetched: 0, written: false };
    return { fetched: page.items.length, written: true };
  } catch {
    // Nothing was parsed, so nothing was owed to disk — not a refusal.
    return { fetched: 0, written: null };
  }
}

/** `writeSimpleAuth` throws (rather than returning false) when the envelope is
 *  unwritable — a future schema, a held lock. A refused re-stamp must not read
 *  as a confirmed one, and must never take the process down. */
function restamp(apiKey: string, env: NodeJS.ProcessEnv): boolean {
  try {
    writeSimpleAuth(apiKey, env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Always exit 0. Nothing waits on this process, so a non-zero code reaches no
 * one; what it WOULD do is put a spurious crash in the host's process
 * accounting for a best-effort background task.
 */
export async function main(): Promise<number> {
  try {
    await runAuthRevalidation();
  } catch {
    // Unreported by construction: stdio is 'ignore'. The cadence stamp the hook
    // wrote before spawning is what keeps a repeatedly-crashing worker from
    // being retried on every session.
  }
  return 0;
}

if (require.main === module) {
  void main();
}
