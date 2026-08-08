// src/shared/auth/offline-grace.ts
// What to do when key validation did not return an answer.
//
// The validator produces two failures that look alike at the call site and are
// not alike at all (runners/auth/validate-key.ts):
//
//   - `invalid-api-key`  — the gate ANSWERED, and the answer was no (401/403).
//     Authoritative. Nothing about being offline makes it less true, so it is
//     not a candidate for grace at any age.
//   - `auth-endpoint-unreachable` — the gate did not answer (DNS, refused
//     connection, timeout, 5xx, a 2xx carrying no JSON-RPC result). This is an
//     UNKNOWN, not a no, and it is the only failure this module graces.
//
// The two arms are the whole point, so the failure reason is an ARGUMENT rather
// than a precondition the caller has to remember: `offlineGraceVerdict` refuses
// a rejection itself, in one place, where a test can hold it.
//
// What is graced: a record on THIS machine that THIS EXACT key already passed
// the same gate at a known time. That record is not a new store — it is the
// canonical `auth` section of one.json (shared/auth/simple-auth.ts), written
// only after `validateApiKey` returned ok, whose `updatedAt` is therefore the
// timestamp of a real successful validation.
//
// Clock skew: this is a PERMISSION GRANTED BY FRESHNESS, so `null` from
// trustworthyAgeMs folds to DENY — the `age !== null && age < WINDOW` spelling
// clock-skew.ts prescribes for exactly this shape. A record stamped further
// ahead of now than any clock could justify would otherwise read as maximally
// fresh forever, i.e. an UNBOUNDED offline grace window granted by editing one
// timestamp. Inside the future-skew allowance a negative age is ordinary jitter
// and clamps to 0, which is correct here: a record written moments ago by a
// slightly fast clock genuinely is the freshest possible validation.
//
// A granted verdict deliberately carries no instruction to write anything. The
// cached record already holds this exact key, so there is nothing to store —
// and re-stamping `updatedAt` on a grace-accept would let a user hold the
// window open indefinitely by resubmitting, which turns a bounded grace into
// the unbounded one it exists to avoid. The window runs from the last REAL
// validation, always.

import { AUTH_OFFLINE_GRACE_MS } from '../../config/auth';
import { trustworthyAgeSince } from '../clock-skew';
import { readSimpleAuth } from './simple-auth';

/** Mirrors the `reason` union of validate-key.ts's failed KeyValidation. */
export type AuthValidationFailure = 'invalid-api-key' | 'auth-endpoint-unreachable';

export type OfflineGraceVerdict =
  | { readonly granted: true; readonly ageMs: number }
  | {
    readonly granted: false;
    readonly reason:
    | 'authoritative-rejection'
    | 'no-cached-validation'
    | 'different-key'
    | 'untrustworthy-stamp'
    | 'grace-expired';
  };

/**
 * Whether an unreachable validator may be answered from this machine's own
 * record of an earlier successful validation of the SAME key.
 *
 * Reads only; never writes, and never re-stamps the cached record.
 */
export function offlineGraceVerdict(
  failure: AuthValidationFailure,
  submittedKey: string,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): OfflineGraceVerdict {
  if (failure !== 'auth-endpoint-unreachable') return { granted: false, reason: 'authoritative-rejection' };
  const cached = readSimpleAuth(env);
  // Absent OR unreadable: readSimpleAuth returns null for a malformed or
  // unsupported one.json envelope too, and an envelope we cannot parse is not
  // evidence that anything validated. Both fold to deny.
  if (!cached) return { granted: false, reason: 'no-cached-validation' };
  // Not a secret comparison: the "attacker" who could exploit a timing side
  // channel here already reads the stored key from the same 0600 file.
  if (cached.apiKey !== String(submittedKey || '').trim()) return { granted: false, reason: 'different-key' };
  const ageMs = trustworthyAgeSince(Date.parse(cached.updatedAt), nowMs);
  if (ageMs === null) return { granted: false, reason: 'untrustworthy-stamp' };
  if (ageMs >= AUTH_OFFLINE_GRACE_MS) return { granted: false, reason: 'grace-expired' };
  return { granted: true, ageMs };
}
