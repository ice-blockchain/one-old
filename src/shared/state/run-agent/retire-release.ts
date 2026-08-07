// src/shared/state/run-agent/retire-release.ts
// The second half of retiring a registry row: everything the retired agent is
// still holding when the row dies.
//
// `replaced = true` retires an agent in the REUSE registry only. Every other
// hold it has outlives the row by its own clock: its identity claim resolves
// until SUBAGENT_STALE_MS (30 min) and keeps write authority with it, its
// per-file fallback locks block every other writer for the same 30 minutes
// (fallback-claims.ts gates a blocking claim on exactly that window), and its
// unconsumed spawn handoff keeps reporting a live agent for the role. The
// registry row itself dies far sooner — CURSOR_RESUME_ID_HARD_MS is 270s — so
// the gap is real and one-sided: the replacement is locked out of every file
// the retired agent touched, while the retired agent can still write them.

import { type Rec } from '../../obj';
import { writeJson } from '../../fsjson';
import { VALID_AGENT_ROLES } from '../../../config/state';
import { stateTimestamp } from '../io';

import {
  firstString,
  runAgentFile,
} from './run-paths';
import {
  idsForRunAgent,
} from './registry-identity';
import {
  listPendingClaims,
  readClaimFile,
  removePendingClaim,
} from './claims-pending';
import {
  releaseFallbackClaimsForHolderUnlocked,
  withFallbackClaimsLockResult,
} from './fallback-claims';
import {
  applied,
  unavailable,
  type MutationResult,
} from './mutation-result';

interface RetiredHolder {
  filePath: string;
  claim: Rec;
}

/**
 * Every key the retired agent could have written a fallback lock under, and
 * NEVER its role.
 *
 * tryFallbackClaim stamps `holder` as `sessionId || claimId || role`, so the
 * role is a legitimate holder value for an agent that had neither id — and
 * releasing by role would release whichever agent holds the role NOW, which
 * after a replacement is the new, live one. That is a strictly worse bug than
 * the one this file fixes, so a role is filtered out of the holder set even if
 * the registry row somehow names one: the cost is that an anonymous agent's
 * locks age out on their own clock, which is exactly today's behaviour.
 *
 * The keys that remain are all id-shaped and all anchored to the CAS'd row:
 * the row's own ids, plus the session and claim ids of the claim files filed
 * under those ids. Nothing here can name an agent the row does not.
 */
function retiredHolderKeys(claims: readonly RetiredHolder[], ids: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const id of ids) keys.add(id);
  for (const { claim } of claims) {
    for (const key of [firstString(claim.sessionId), firstString(claim.claimId)]) {
      if (key) keys.add(key);
    }
  }
  keys.delete('');
  for (const key of keys) if (VALID_AGENT_ROLES.has(key)) keys.delete(key);
  return [...keys];
}

/**
 * Is this pending handoff the retired spawn's, rather than the replacement's?
 *
 * The pending slot is keyed by ROLE (claims-store.ts's pendingClaimFile), so
 * role alone identifies nothing here: after a replacement is spawned the role's
 * handoff is the REPLACEMENT's, and dropping it leaves a child that binds no
 * role. The two keys that cannot describe the successor are the retired agent's
 * own claim id — checked by the caller — and this one: a handoff from the same
 * parent, minted strictly BEFORE the retired row was recorded. A replacement is
 * spawned after retirement, which is after that record, so its handoff is
 * strictly later. Equality keeps the claim: the asymmetry must favour leaving a
 * handoff the replacement may need over dropping it.
 */
function isRetiredSpawnHandoff(claim: Rec, entry: Rec): boolean {
  const parentSessionId = firstString(entry.parentSessionId);
  const claimParent = firstString(claim.parentSessionId);
  if (!parentSessionId || !claimParent || parentSessionId !== claimParent) return false;
  const recordedAtMs = Date.parse(firstString(entry.recordedAt) || '');
  const createdAtMs = Date.parse(firstString(claim.createdAt) || '');
  if (!Number.isFinite(recordedAtMs) || !Number.isFinite(createdAtMs)) return false;
  return createdAtMs < recordedAtMs;
}

/**
 * Release everything the retired row's agent holds. The caller must hold the
 * run's claims lock and its registry lock, and must already have persisted
 * `replaced` — releasing the holds of an agent whose row is still live would
 * hand its files to a second writer.
 *
 * Reported as a MutationResult because a refused write here is not cosmetic: it
 * leaves the transaction half-applied (row retired, holds kept), and only
 * `unavailable` makes the caller retry it.
 */
export function releaseRetiredRunAgentUnlocked(
  cwd: string,
  runId: string,
  role: string,
  entry: Rec,
  reason: string,
): MutationResult<void> {
  const ids = idsForRunAgent(entry);
  const claims: RetiredHolder[] = [];
  for (const id of ids) {
    const filePath = runAgentFile(cwd, runId, id);
    const claim = readClaimFile(filePath);
    if (!claim || claim.role !== role || !firstString(claim.claimId)) continue;
    const claimRunId = firstString(claim.runId);
    if (claimRunId && claimRunId !== runId) continue;
    claims.push({ filePath, claim });
  }

  // The identity claim first, and bail before touching a lock if it will not
  // persist. While it still resolves, the retired agent keeps write authority;
  // freeing its file locks ahead of that would let the replacement into files
  // the ghost can still write, which is the double-writer this prevents rather
  // than causes. Released — not deleted — because a released claim still names
  // its agent for attribution, and stops naming it only once another agent
  // demonstrably owns the role (claims-pending.ts's `claim-superseded`).
  for (const { filePath, claim } of claims) {
    if (claim.status === 'released') continue;
    try {
      if (!writeJson(filePath, {
        ...claim,
        status: 'released',
        releasedAt: stateTimestamp(),
        releasedReason: `retired-${reason}`,
      })) return unavailable<void>('retired-claim-release-refused');
    } catch {
      return unavailable<void>('retired-claim-release-failed');
    }
  }

  const holders = retiredHolderKeys(claims, ids);
  if (holders.length) {
    const fallback = withFallbackClaimsLockResult<void>(cwd, runId, () => {
      for (const holder of holders) {
        if (!releaseFallbackClaimsForHolderUnlocked(cwd, runId, holder).ok) {
          // The exact partial-deletion set is reported by the helper and owned
          // by forward retry, never by rollback: re-planting a lock that was
          // already deleted would re-block the replacement.
          return unavailable<void>('fallback-release-failed');
        }
      }
      return applied(undefined);
    });
    if (fallback.outcome === 'unavailable') {
      return unavailable<void>(fallback.reason === 'lock-unavailable'
        ? 'fallback-lock-unavailable'
        : fallback.reason || 'fallback-release-failed');
    }
  }

  const claimIds = new Set(claims
    .map(({ claim }) => firstString(claim.claimId))
    .filter((id): id is string => Boolean(id)));
  for (const { filePath, claim } of listPendingClaims(cwd, runId)) {
    if (claim.role !== role) continue;
    const pendingClaimId = firstString(claim.claimId);
    const mine = pendingClaimId !== null && claimIds.has(pendingClaimId);
    if (!mine && !isRetiredSpawnHandoff(claim, entry)) continue;
    removePendingClaim(filePath);
  }
  return applied(undefined);
}
