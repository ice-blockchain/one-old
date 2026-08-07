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
  runDir,
  runLedgerFingerprint,
  runsRoot,
} from './run-paths';
import {
  agentRegistryFile,
  idsForRunAgent,
} from './registry-identity';
import {
  isFreshTimestamp,
} from './session-identity';

export type RunAgentUnresolvedReason =
  | 'no-claim'
  | 'run-id-mismatch'
  | 'not-materialized'
  | 'fingerprint-mismatch'
  | 'claim-superseded'
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

// Same-role agent claims filed directly in the run's directory. Subdirectories
// (`superseded/`, `pending/`) are archives and handoffs, never resolution
// records — the same boundary listClaimedAgentEntries draws, redrawn here
// because claims-store.ts cannot be imported from this module.
function sameRoleClaimFiles(cwd: string, runId: string, role: string): Rec[] {
  const out: Rec[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runDir(cwd, runId), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const candidate = readClaimFile(path.join(runDir(cwd, runId), entry.name));
    // `claimId` is what separates a real agent claim from a role-bearing sidecar
    // such as maintenance.json, which must never count as an owner.
    if (!candidate || candidate.role !== role || !firstString(candidate.claimId)) continue;
    if (firstString(candidate.runId) !== runId) continue;
    out.push(candidate);
  }
  return out;
}

/**
 * Does ANOTHER agent hold this claim's role right now?
 *
 * Asked only of a RELEASED claim, and answered only from POSITIVE evidence that
 * a successor exists — never from the absence of evidence about this claim.
 * `status === 'released'` on its own must keep resolving identity: the terminal
 * sweep releases every claim of a settled run, and claims-store.ts says why
 * those claims still have to name their agent afterwards ("Released claims keep
 * resolving identity (see releaseRunClaims), so this only corrects liveness
 * accounting, never resolution"). That holds exactly while no other agent has
 * taken the role, which is the condition checked here and nowhere else.
 *
 * Two witnesses, both requiring the successor to be PRESENT on disk:
 *   - a live same-role claim belonging to a different thread — what a
 *     replacement's bind leaves behind, since claimThreadRole and the
 *     pending-correlation path both write their own claim and release the older
 *     one through releaseSupersededRoleClaimsLocked; and
 *   - a LIVE registry row for the role whose ids are not this claim's and do
 *     name a same-role claim in this run.
 *
 * The presence requirement on the registry witness is load-bearing. A row
 * legitimately names ids no claim carries (Cursor records `tool_*` at spawn and
 * only later upgrades the row to the child's conversation id), so "the row does
 * not name me" alone would report the role's OWN agent as superseded. After the
 * terminal sweep — every claim released, the row untouched and still live —
 * that would strip a working child of its role and deny its in-scope writes,
 * which is the deadlock this reason must not create.
 */
export function releasedClaimRoleTakenOver(cwd: string, claim: Rec): boolean {
  const runId = firstString(claim.runId);
  const role = typeof claim.role === 'string' ? claim.role : '';
  const claimId = firstString(claim.claimId);
  if (!runId || !role || !claimId) return false;
  const sessionId = firstString(claim.sessionId);
  const others = sameRoleClaimFiles(cwd, runId, role).filter((candidate) => (
    firstString(candidate.claimId) !== claimId
    && (!sessionId || firstString(candidate.sessionId) !== sessionId)
  ));
  if (!others.length) return false;
  if (others.some((candidate) => (
    candidate.status !== 'released' && isFreshTimestamp(candidate.createdAt, SUBAGENT_STALE_MS)
  ))) return true;
  const registry = obj(readJson(agentRegistryFile(cwd, runId), null));
  const entry = obj(obj(registry?.agents)?.[role]);
  if (!entry || entry.replaced === true) return false;
  const owned = idsForRunAgent(entry);
  if (!owned.length || (sessionId && owned.includes(sessionId))) return false;
  return others.some((candidate) => {
    const candidateSession = firstString(candidate.sessionId);
    return candidateSession !== null && owned.includes(candidateSession);
  });
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
  // The one status this function reads, and it reads it only to ask a question
  // ABOUT ANOTHER AGENT. Retirement releases the holder's claim
  // (registry-refresh.ts) while the ghost may still be executing, so a released
  // claim that keeps resolving is write authority held at the same time as the
  // replacement's. Gated on `status` first so a live claim pays no extra read.
  if (c.status === 'released' && releasedClaimRoleTakenOver(cwd, c)) return 'claim-superseded';
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

