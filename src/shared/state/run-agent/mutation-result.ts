// src/shared/state/run-agent/mutation-result.ts
// The three-valued outcome every run-state mutation reports, and the split rule
// that decides what a caller may do with each value.
//
// ── Why three values ────────────────────────────────────────────────────────
// Every mutation in this directory used to answer with a boolean, a `void`, a
// count, or a nullable record — and in all four shapes exactly one bit came
// back: "did I get what I wanted?". That bit merges two situations a caller must
// treat OPPOSITELY:
//
//   - PRECONDITION-FAILED. The mutation was correctly refused: the run ledger is
//     closed, the role slot is held by a live thread, the registry row does not
//     match the CAS, the drift was already recorded. The world says no. Retrying
//     changes nothing until the world changes, and proceeding is usually right —
//     the refusal IS the answer.
//
//   - UNAVAILABLE. We could not find out. The owned-dir lock stayed contended
//     past its timeout, or the write chokepoint refused the file. Nothing was
//     read, nothing was decided, nothing was written. Retrying may well succeed.
//
// Collapsed to one bit, the second case is indistinguishable from the first, so
// eleven call sites in this directory silently treated "I could not tell" as "the
// answer is no" — which for a claim mint means a child spawns with no claim at
// all, and for a ledger transition means a run is announced in a state its own
// file does not record.
//
// ── The split rule ──────────────────────────────────────────────────────────
// `unavailable` is NOT uniformly safe to proceed on, and it is not uniformly
// unsafe either:
//
//   - ADVISORY mutations may proceed. They record diagnostics or liveness hints
//     (`recordRunStackDrift`, `markRunAgentReplaced`, the ledger-fingerprint
//     backfill, the Cursor transcript-cache upgrade). Losing one costs a log
//     line or one extra spawn; failing a tool call over it costs the build.
//
//   - CLAIM MINTING and LEDGER TRANSITIONS must retry and then DENY. These are
//     the records the rest of the system counts: a role's claim decides which
//     agent may write which files, and `activeRunClaimCount` decides whether a
//     run may settle. A spawn allowed with no claim produces a child that
//     resolves to no role, writes as the main agent, is invisible to the
//     duplicate-spawn gate, and cannot be released by the terminal sweep. A
//     blanket "never deny on unavailable" is therefore a safety violation, not a
//     convenience.
//
// `retryWhileUnavailable` below is the retry half; the deny half lives at the
// gates, which are the only layer holding a HookResult (see gate-enforcement.ts
// and codex-child-model.ts).

/** What happened to a mutation. See the split rule in this file's header. */
export type MutationOutcome = 'applied' | 'precondition-failed' | 'unavailable';

export interface MutationResult<T = void> {
  readonly outcome: MutationOutcome;
  /** The mutated record, present ONLY on `applied`. */
  readonly value: T | null;
  /**
   * Which precondition failed, or what was unavailable. A stable, machine-ish
   * kebab token (never rendered prose): it is embedded in deny text and read by
   * an operator comparing two runs, so it must not drift with wording.
   */
  readonly reason: string;
}

export function applied<T>(value: T): MutationResult<T> {
  return { outcome: 'applied', value, reason: '' };
}

export function preconditionFailed<T = void>(reason: string): MutationResult<T> {
  return { outcome: 'precondition-failed', value: null, reason };
}

export function unavailable<T = void>(reason: string): MutationResult<T> {
  return { outcome: 'unavailable', value: null, reason };
}

export function isApplied<T>(result: MutationResult<T>): boolean {
  return result.outcome === 'applied';
}

/**
 * The legacy adapter. Every mutation in this directory keeps its historical
 * signature as a one-line wrapper over its `…Result` sibling, so the ~400 call
 * sites (and the whole test suite) that only ever needed "did it happen?" are
 * untouched, while a caller that must apply the split rule asks for the outcome.
 */
export function mutationValue<T>(result: MutationResult<T>): T | null {
  return result.outcome === 'applied' ? result.value : null;
}

/** `true` only on `applied` — the exact bit the boolean-returning mutations used to hand back. */
export function mutationApplied(result: MutationResult<unknown>): boolean {
  return result.outcome === 'applied';
}

// One extra attempt, not many: the owned-dir lock ALREADY retries internally for
// its whole timeout (2s for every store here), so this outer retry exists for
// the causes that timeout cannot absorb — a lock released a moment after we gave
// up, a write chokepoint refusal that has since cleared. A second full lock
// timeout is the worst case this adds to a hook, and it is paid only on the path
// that would otherwise deny.
const UNAVAILABLE_RETRY_ATTEMPTS = 2;
const UNAVAILABLE_RETRY_BACKOFF_MS = 25;
const RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));

/**
 * Run `mutate` again while it reports `unavailable`. `applied` and
 * `precondition-failed` return immediately — re-running a mutation whose
 * precondition genuinely failed would just re-read the same world and burn the
 * caller's hook budget.
 *
 * The backoff is `Atomics.wait`, the same synchronous sleep the lock loop uses:
 * a hook runtime has no event loop to yield to at this point in the call.
 */
export function retryWhileUnavailable<T>(mutate: () => MutationResult<T>): MutationResult<T> {
  let result = mutate();
  for (let attempt = 1; attempt < UNAVAILABLE_RETRY_ATTEMPTS && result.outcome === 'unavailable'; attempt += 1) {
    Atomics.wait(RETRY_WAIT, 0, 0, UNAVAILABLE_RETRY_BACKOFF_MS);
    result = mutate();
  }
  return result;
}
