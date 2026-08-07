// src/shared/clock-skew.ts
// One place that decides whether an age is USABLE, and deliberately no place
// that decides what to do about it.
//
// Every freshness test in this repo is spelled `now - stamp` against a
// threshold, and a stamp written AHEAD of `now` makes that difference NEGATIVE.
// A negative age passes every `< window` test and fails every `> stale` test,
// so one bad stamp reads as maximally fresh FOREVER — and the two spellings
// fail in opposite directions from the same input:
//
//   - a freshness window (`age < WINDOW`) stays open forever: a deploy stays
//     approved, a self-heal cooldown never ends, a retry never fires;
//   - a staleness window (`age > STALE`) never opens: a lock is never
//     reclaimable and every later acquirer times out.
//
// Both are wrong, but they are not fixed by the same edit, so this module
// refuses to make that choice. `trustworthyAgeMs` only CLASSIFIES — it returns
// `null` for an age no clock can justify — and each call site folds `null` in
// the direction that is safe THERE, in one visible expression:
//
//   permission granted by freshness  →  age !== null && age < WINDOW   (deny)
//   an action blocked by freshness   →  age !== null && age < WINDOW   (allow)
//   a lock held until it goes stale  →  age === null || age > STALE    (reclaim)
//
// The direction is therefore reviewable at the site instead of buried in a
// shared boolean, which is the whole reason `ageAttestsLiveness` had to be
// added beside `isFreshTimestamp` rather than replacing it.
//
// Two ages are unusable:
//   - non-finite (an absent or unparseable stamp, conventionally Infinity);
//   - more than STATE_TIMESTAMP_FUTURE_SKEW_MS ahead of now. Inside that
//     allowance a negative age is ordinary jitter and clamps to zero (a stamp
//     that young IS maximally fresh); beyond it, the clock that wrote the stamp
//     stepped, and nothing it says is evidence about anything.

import { STATE_TIMESTAMP_FUTURE_SKEW_MS } from '../config/state';

/**
 * The age, or `null` when no clock could have produced it. Ages inside the
 * future-skew allowance clamp to 0 so callers never see a negative number.
 */
export function trustworthyAgeMs(ageMs: number): number | null {
  if (!Number.isFinite(ageMs)) return null;
  if (ageMs < -STATE_TIMESTAMP_FUTURE_SKEW_MS) return null;
  return ageMs > 0 ? ageMs : 0;
}

/**
 * `trustworthyAgeMs(nowMs - stampMs)` for the epoch-ms stamps that mtimes and
 * lock sentinels carry. A non-finite stamp is unusable for the same reason a
 * non-finite age is; an ABSENT stamp is the caller's own question, because
 * "never stamped" and "stamped by a broken clock" do not always fold the same
 * way (a missing self-heal lock means the cooldown never started; a missing
 * security stamp means the check never ran).
 */
export function trustworthyAgeSince(stampMs: number, nowMs: number): number | null {
  if (!Number.isFinite(stampMs)) return null;
  return trustworthyAgeMs(nowMs - stampMs);
}
