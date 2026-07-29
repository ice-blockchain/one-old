// src/shared/state/run-agent/claims-pending.ts
// The pending-claim store: unresolved reasons, listing, expiry pruning,
// and correlation matching.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import {  readJson } from '../../fsjson';
import {
  PENDING_AGENT_CLAIM_STALE_MS,
  SUBAGENT_STALE_MS,
  VALID_AGENT_ROLES,
} from '../../../config/state';
import {
  stackFingerprint,
} from '../materialization';

import {
  firstString,
  pendingDir,
  runLedgerFingerprint,
  runsRoot,
} from './run-paths';
import {
  isFreshTimestamp,
} from './session-identity';

export type RunAgentUnresolvedReason =
  | 'no-claim'
  | 'run-id-mismatch'
  | 'not-materialized'
  | 'fingerprint-mismatch'
  | 'claim-stale';

function stateAllowsRunContext(state: unknown, runId: unknown): RunAgentUnresolvedReason | null {
  const s = obj(state);
  if (!s) return 'no-claim';
  if (typeof runId !== 'string' || !runId) return 'no-claim';
  if (typeof s.currentRunId === 'string' && s.currentRunId && s.currentRunId !== runId) return 'run-id-mismatch';
  // Materialized ASSETS must exist on disk. Their fingerprint is deliberately
  // not re-derived here: `materializedStack` legitimately moves whenever
  // detection re-runs (the team building the app changes what is detected), and
  // binding a live agent to that moving value is the defect this replaces.
  if (!s.materializedStack) return 'not-materialized';
  return null;
}

export function claimRejectReason(cwd: string, state: unknown, claim: unknown): RunAgentUnresolvedReason | null {
  const c = obj(claim);
  if (!c) return 'no-claim';
  if (typeof c.role !== 'string' || !VALID_AGENT_ROLES.has(c.role)) return 'no-claim';
  const stateReason = stateAllowsRunContext(state, c.runId);
  if (stateReason) return stateReason;
  // Frozen-to-frozen: the claim's stamped identity against the run ledger's,
  // never against a live recompute. A claim with no stamp (or a legacy ledger
  // with none) still falls back to run-id scoping, which alone already pins a
  // claim to one project root.
  const frozen = runLedgerFingerprint(cwd, c.runId);
  if (c.stackFingerprint && frozen && c.stackFingerprint !== frozen) return 'fingerprint-mismatch';
  if (!isFreshTimestamp(c.createdAt, SUBAGENT_STALE_MS)) return 'claim-stale';
  return null;
}

export function claimAllowsState(cwd: string, state: unknown, claim: unknown): boolean {
  return claimRejectReason(cwd, state, claim) === null;
}

export function runIdsForLookup(cwd: string, state: unknown): string[] {
  const ids: string[] = [];
  const s = obj(state);
  if (s && typeof s.currentRunId === 'string' && s.currentRunId) ids.push(s.currentRunId);
  try {
    if (fs.existsSync(runsRoot(cwd))) {
      const diskIds = fs.readdirSync(runsRoot(cwd), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const id of diskIds) if (!ids.includes(id)) ids.push(id);
    }
  } catch {
    // best-effort
  }
  return ids;
}

export function readClaimFile(filePath: string): Rec | null {
  return obj(readJson(filePath, null));
}

export interface PendingClaim {
  filePath: string;
  claim: Rec;
}

export function listPendingClaims(cwd: string, runId: string): PendingClaim[] {
  try {
    const dir = pendingDir(cwd, runId);
    if (!fs.existsSync(dir)) return [];
    const out: PendingClaim[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(dir, entry.name);
      const claim = readClaimFile(filePath);
      if (!claim) continue;
      if (!isFreshTimestamp(claim.createdAt, PENDING_AGENT_CLAIM_STALE_MS)) {
        removePendingClaim(filePath);
        continue;
      }
      out.push({ filePath, claim });
    }
    return out
      .sort((left, right) => String(left.claim.createdAt).localeCompare(String(right.claim.createdAt)));
  } catch {
    return [];
  }
}

export function pruneExpiredPendingClaims(cwd: string, runId?: string): number {
  const runIds = typeof runId === 'string' && runId.trim()
    ? [runId.trim()]
    : (() => {
      try {
        return fs.readdirSync(runsRoot(cwd), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    })();
  let removed = 0;
  for (const id of runIds) {
    const dir = pendingDir(cwd, id);
    let before = 0;
    try {
      before = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
    } catch {
      continue;
    }
    listPendingClaims(cwd, id);
    try {
      const after = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
      removed += Math.max(0, before - after);
    } catch {
      removed += before;
    }
  }
  return removed;
}

function newestPending(items: PendingClaim[]): PendingClaim | null {
  if (!items.length) return null;
  return [...items].sort((left, right) => String(right.claim.createdAt).localeCompare(String(left.claim.createdAt)))[0] || null;
}

export function claimModel(claim: Rec): string | null {
  return firstString(claim.model);
}

export function matchingPendingClaim(
  cwd: string,
  state: unknown,
  runId: string,
  role: string,
  parentSessionId: string | null,
  model: string | null = null,
): PendingClaim | null {
  const pending = listPendingClaims(cwd, runId)
    .filter(({ claim }) => claimAllowsState(cwd, state, claim))
    .filter(({ claim }) => claim.role === role);
  const sameParent = pending.filter(({ claim }) => (
    parentSessionId && claim.parentSessionId && claim.parentSessionId === parentSessionId
  ));
  const sameModel = (items: PendingClaim[]) => model
    ? items.filter(({ claim }) => claimModel(claim) === model)
    : [];
  return newestPending(sameModel(sameParent))
    || newestPending(sameModel(pending))
    || newestPending(sameParent)
    || newestPending(pending);
}

// A roleless child may correlate to one pending spawn by immutable parent/model
// metadata, but it must never choose between roles by timestamp. Inspect the
// strongest available bucket first; an ambiguous non-empty bucket fails closed.
export function uniquelyCorrelatedPendingClaim(
  pending: PendingClaim[],
  parentSessionId: string | null,
  model: string | null,
): PendingClaim | null {
  if (parentSessionId && model) {
    const exact = pending.filter(({ claim }) => (
      claim.parentSessionId === parentSessionId && claimModel(claim) === model
    ));
    // Both facts were supplied, so an empty or ambiguous intersection is a
    // failed correlation. Do not weaken it to parent-only/model-only and bind a
    // claim that contradicts one of the child's immutable facts.
    return exact.length === 1 ? exact[0]! : null;
  }
  if (parentSessionId) {
    const sameParent = pending.filter(({ claim }) => claim.parentSessionId === parentSessionId);
    return sameParent.length === 1 ? sameParent[0]! : null;
  }
  if (model) {
    const sameModel = pending.filter(({ claim }) => claimModel(claim) === model);
    return sameModel.length === 1 ? sameModel[0]! : null;
  }
  return null;
}

export function removePendingClaim(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // a leftover pending file is harmless; freshness expires it
  }
}

export function removeSiblingPendingClaims(
  cwd: string,
  state: unknown,
  runId: string,
  role: string,
  parentSessionId: string | null,
  keepClaimId: string | null,
): void {
  if (!parentSessionId) return;
  const pending = listPendingClaims(cwd, runId)
    .filter(({ claim }) => claimAllowsState(cwd, state, claim))
    .filter(({ claim }) => claim.role === role)
    .filter(({ claim }) => claim.parentSessionId === parentSessionId)
    .filter(({ claim }) => !keepClaimId || claim.claimId !== keepClaimId);
  for (const item of pending) removePendingClaim(item.filePath);
}

