// src/shared/state/run-agent/claims-store.ts
// Claimed-agent listing, release paths, the claims lock, and
// ensureRunAgentClaim.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import { isNonProjectRoot } from '../../authoring-root';
import { createJsonExclusive, writeJson } from '../../fsjson';
import {
  SUBAGENT_STALE_MS,
  VALID_AGENT_ROLES,
} from '../../../config/state';
import { stateTimestamp } from '../io';
import {
  getSpawnIndex,
} from '../materialization';
import { writeState } from '../normalize';

import {
  ensureCurrentRunId,
  fallbackClaimsDir,
  firstString,
  pendingDir,
  runDir,
  runIdNow,
  runsRoot,
  safePathSegment,
  stackFingerprintPatch,
} from './run-paths';
import {
  withOwnedDirLock,
  withOwnedDirLockResult,
} from './locks';
import {
  applied,
  mutationApplied,
  mutationValue,
  preconditionFailed,
  unavailable,
  type MutationResult,
} from './mutation-result';
import {
  ensureRunLedgerResult,
} from './ledger';
import {
  hookSessionIdentity,
} from './session-identity';
import {
  listPendingClaims,
  readClaimFile,
  removePendingClaim,
} from './claims-pending';
import {
  assignmentForContext,
} from './assignments';
import {
  hasActiveRunClaims,
  resolveRunAgentContext,
} from './context-resolve';
import {
  tryFallbackClaim,
} from './fallback-claims';
import { withFallbackClaimsLockResult } from './fallback-claims';

function listClaimedAgentEntries(cwd: string, runId: string): Array<{ filePath: string; claim: Rec }> {
  try {
    const dir = runDir(cwd, runId);
    if (!fs.existsSync(dir)) return [];
    const out: Array<{ filePath: string; claim: Rec }> = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(dir, entry.name);
      const claim = readClaimFile(filePath);
      if (claim && typeof claim.role === 'string' && VALID_AGENT_ROLES.has(claim.role)) {
        out.push({ filePath, claim });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function listClaimedAgents(cwd: string, runId: string): Rec[] {
  return listClaimedAgentEntries(cwd, runId).map((entry) => entry.claim);
}

// Did a child for this ROLE actually bind (or is it mid-bind) in this run? The
// reuse registry (agents.json) records an agent at SPAWN time and never learns
// whether that child went on to resolve its role, so a registry row alone does
// not prove a usable agent — the reuse gate pairs this with the ledger check to
// tell a working agent apart from one that can never bind.
//
// Role-scoped rather than id-scoped on purpose: claims are keyed by the child's
// own thread id, which does not equal the registry's agentId on every host. A
// still-pending claim counts as bound so a child that is binding right now is
// never treated as dead and replaced out from under itself.
export function runRoleHasBoundClaim(cwd: string, runId: unknown, role: unknown): boolean {
  if (typeof runId !== 'string' || !runId.trim() || typeof role !== 'string' || !role) return false;
  const id = runId.trim();
  const bound = listClaimedAgentEntries(cwd, id)
    .some(({ claim }) => claim.role === role && claim.status !== 'released');
  if (bound) return true;
  return listPendingClaims(cwd, id).some(({ claim }) => claim.role === role);
}

// Terminal claim sweep for a settled run: pending claims are deleted, claimed
// files get status "released" (+releasedAt/releasedReason) so hasActiveRunClaims
// stops counting them while identity resolution (resolveRunAgentContext, the
// nextSpawnIndex disk count, assignmentForContext) keeps working. Only real
// agent claims (claimId present) are touched — role-bearing sidecars such as
// maintenance.json are left alone. Per-file fallback claims under
// `runs/<runId>/claims/` are advisory write locks (tryFallbackClaim), not
// identity records: once the run settles they can only go stale, so the sweep
// DELETES them (observed 8c: 12 architect fallback claims lingered forever
// after a verified settlement).
export function releaseRunClaimsResult(cwd: string, runId: string, reason: string): MutationResult<number> {
  if (typeof runId !== 'string' || !runId.trim() || isNonProjectRoot(cwd)) return preconditionFailed('no-run-id');
  let released = 0;
  // Fixes #2 and #3 of the eleven. Both lock results were discarded, so a
  // contended lock returned the same `0` as an already-swept run — and this
  // count is what run-settle.ts reports as the terminal sweep's work. Neither
  // sweep is retried here: settlement calls this on the way to a terminal
  // transition that has its own result, and the residue it leaves behind expires
  // on SUBAGENT_STALE_MS. What matters is that the caller can TELL.
  const claims = withRunAgentClaimsLockResult<void>(cwd, runId.trim(), () => {
    for (const { filePath } of listPendingClaims(cwd, runId)) {
      removePendingClaim(filePath);
      released += 1;
    }
    for (const { filePath, claim } of listClaimedAgentEntries(cwd, runId)) {
      if (typeof claim.claimId !== 'string' || claim.status === 'released') continue;
      try {
        // Counted only if it actually persisted: a refused write left the claim
        // 'claimed' on disk while the sweep reported it released.
        if (writeJson(filePath, { ...claim, status: 'released', releasedAt: stateTimestamp(), releasedReason: reason })) {
          released += 1;
        }
      } catch {
        // best-effort: an unreleased claim ages out via SUBAGENT_STALE_MS
      }
    }
    return applied(undefined);
  });
  const fallback = withFallbackClaimsLockResult<void>(cwd, runId.trim(), () => {
    try {
      const dir = fallbackClaimsDir(cwd, runId.trim());
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          fs.unlinkSync(path.join(dir, entry.name));
          released += 1;
        } catch {
          // best-effort: a leftover lock only ever goes stale
        }
      }
    } catch {
      // no fallback-claims dir — nothing to sweep
    }
    return applied(undefined);
  });
  // A sweep that could not take EITHER lock did not sweep. Reported as one
  // `unavailable` carrying whichever half failed, so a caller cannot read a
  // partial sweep as a complete one.
  if (claims.outcome === 'unavailable') return unavailable(`claims-${claims.reason}`);
  if (fallback.outcome === 'unavailable') return unavailable(`fallback-${fallback.reason}`);
  return applied(released);
}

export function releaseRunClaims(cwd: string, runId: string, reason: string): number {
  return releaseRunClaimsResult(cwd, runId, reason).value ?? 0;
}

export function releaseAllRunClaims(cwd: string, reason: string): number {
  if (isNonProjectRoot(cwd)) return 0;
  let total = 0;
  try {
    for (const entry of fs.readdirSync(runsRoot(cwd), { withFileTypes: true })) {
      if (entry.isDirectory()) total += releaseRunClaims(cwd, entry.name, reason);
    }
  } catch {
    // no runs dir yet
  }
  return total;
}

// One live agent per role: when a fresh claim is bound for a role, an older
// same-role claim from a DIFFERENT thread that is still 'claimed' is superseded
// — typically a spawn that died before producing any output (observed live: a
// reviewer aborted at startup left its claim 'claimed' until the terminal
// sweep). Released claims keep resolving identity (see releaseRunClaims), so
// this only corrects liveness accounting, never resolution. Caller must hold
// the run's claims lock.
export function releaseSupersededRoleClaimsLocked(
  cwd: string,
  runId: string,
  role: string,
  keepSessionId: string,
  newClaimId: string,
): void {
  for (const { filePath, claim } of listClaimedAgentEntries(cwd, runId)) {
    if (claim.role !== role || claim.status === 'released') continue;
    if (typeof claim.claimId !== 'string') continue; // role-bearing sidecars are not claims
    if (firstString(claim.sessionId) === keepSessionId) continue;
    try {
      writeJson(filePath, {
        ...claim,
        status: 'released',
        releasedAt: stateTimestamp(),
        releasedReason: newClaimId ? `superseded-by-${newClaimId}` : 'superseded',
      });
    } catch {
      // best-effort: an unreleased sibling ages out via SUBAGENT_STALE_MS
    }
  }
}

function countRunClaimsForRole(cwd: string, runId: string, role: string): number {
  const pending = listPendingClaims(cwd, runId).filter(({ claim }) => claim.role === role).length;
  const claimed = listClaimedAgents(cwd, runId).filter((claim) => claim.role === role).length;
  return pending + claimed;
}

export function nextSpawnIndex(cwd: string, state: unknown, runId: string, role: string): number {
  const stateIndex = getSpawnIndex(state, role);
  const diskIndex = countRunClaimsForRole(cwd, runId, role) + 1;
  return Math.max(stateIndex, diskIndex, 1);
}

const RUN_AGENT_CLAIMS_LOCK_TIMEOUT_MS = 2_000;
const RUN_AGENT_CLAIMS_LOCK_STALE_MS = 15_000;
const RUN_AGENT_CLAIMS_LOCK_RETRY_MS = 10;
const RUN_AGENT_CLAIMS_WAIT = new Int32Array(new SharedArrayBuffer(4));

function runAgentClaimsLockDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), '.agent-claims.lock');
}

export function withRunAgentClaimsLock(cwd: string, runId: string, mutate: () => void): boolean {
  return withOwnedDirLock(
    runAgentClaimsLockDir(cwd, runId),
    RUN_AGENT_CLAIMS_LOCK_TIMEOUT_MS,
    RUN_AGENT_CLAIMS_LOCK_STALE_MS,
    RUN_AGENT_CLAIMS_LOCK_RETRY_MS,
    RUN_AGENT_CLAIMS_WAIT,
    mutate,
  );
}

export function withRunAgentClaimsLockResult<T>(
  cwd: string,
  runId: string,
  mutate: () => MutationResult<T>,
): MutationResult<T> {
  return withOwnedDirLockResult(
    runAgentClaimsLockDir(cwd, runId),
    RUN_AGENT_CLAIMS_LOCK_TIMEOUT_MS,
    RUN_AGENT_CLAIMS_LOCK_STALE_MS,
    RUN_AGENT_CLAIMS_LOCK_RETRY_MS,
    RUN_AGENT_CLAIMS_WAIT,
    mutate,
  );
}

/**
 * The pending claim's slot: ONE file per role, not one per claim id.
 *
 * This filename IS the compare-and-swap. Under the old
 * `pending/<claimId>.json` every writer minted a fresh random id, so no two
 * writers ever addressed the same path and the exclusive create could not fail —
 * rebind-journal-io.ts even calls that pair "the pending-claim CAS", but a
 * compare-and-swap on a name nobody else writes compares nothing. Keyed by ROLE
 * the name is contended by construction, which is what makes `O_CREAT|O_EXCL`
 * mean something: exactly one of N concurrent minters for a role creates the
 * file and the rest get EEXIST.
 *
 * The invariant it buys is the one the rest of the system already assumes and
 * nothing enforced — at most one UNCONSUMED spawn handoff per role per run.
 * `activeRunClaimCount` counts pending claims, and a role with two of them
 * reports two live agents and vetoes settlement for as long as they take to
 * expire.
 *
 * Nothing else may derive this path from a claim id: readers list the directory
 * and match on the `claimId` INSIDE each file (listPendingClaims,
 * removePendingClaimsByIdUnlocked), which is filename-agnostic and therefore
 * still finds `<claimId>.json` files left by an older build.
 */
function pendingClaimFile(cwd: string, runId: string, role: string): string {
  return path.join(pendingDir(cwd, runId), `${safePathSegment(role)}.json`);
}

/**
 * The CAS lost — may this minter take the slot anyway?
 *
 * "Someone else won" has to mean someone ELSE. A parent that retries the same
 * role after a failed attempt collides with its OWN earlier handoff, and the
 * codebase already rules on that case: removeSiblingPendingClaims collapses a
 * parent's same-role pending claims to the newest at bind time, and
 * matchingPendingClaim prefers the newest. Deferring to the incumbent instead
 * would bind the retried child to the ABANDONED attempt's claim — measured
 * against `Cursor child bind prefers the matching exact-model pending claim`,
 * where a family-slug spawn fails, the parent respawns with the exact model, and
 * the child must carry the retry's claim and not the dead guess's.
 *
 * So: supersede when the incumbent is this parent's, defer when it is another
 * parent's. Either way the slot holds exactly ONE claim, which is the invariant
 * that keeps `activeRunClaimCount` honest — the two cases differ only in WHICH
 * claim survives.
 *
 * An unknown parent on either side supersedes: some hosts omit the session id,
 * two claims that cannot be told apart are more likely one parent retrying than
 * two anonymous rivals, and newest-wins is what every reader here already
 * prefers. An unreadable or unparseable incumbent supersedes too — it can never
 * be matched to a child, so leaving it in place would strand the role.
 */
function supersedesPendingClaim(file: string, parentSessionId: string | null): boolean {
  const incumbent = readClaimFile(file);
  if (!incumbent) return true;
  const held = firstString(incumbent.parentSessionId);
  if (!held || !parentSessionId) return true;
  return held === parentSessionId;
}

/**
 * Mint this role's pending claim for the run, reporting WHY when it does not
 * happen. CLAIM MINTING is the non-advisory half of mutation-result.ts's split
 * rule: its `unavailable` must be retried and then denied, because a spawn
 * allowed with no claim produces a child that binds no role, writes as the main
 * agent, and cannot be swept when the run settles.
 *
 * `precondition-failed` is the opposite and must NOT deny:
 *   - `role-pending-claim-held` — the CAS lost to a DIFFERENT parent session.
 *     Its handoff for this role is already on disk and the child this spawn
 *     starts will bind to THAT claim, so blocking the spawn adds nothing.
 *   - `ledger-not-active` — the run is closed. Respawning cannot fix it; the
 *     gates that care already have their own ledger-closed denies with the
 *     resume remedy in them.
 */
export function ensureRunAgentClaimResult(
  cwd: string,
  state: unknown,
  role: string,
  rawInput: unknown,
  metadata: { toolName?: string; agentType?: string; model?: string; roleSource?: string } = {},
): MutationResult<Rec> {
  if (!VALID_AGENT_ROLES.has(role)) return preconditionFailed('invalid-role');
  if (isNonProjectRoot(cwd)) return preconditionFailed('authoring-root'); // never claim runs in the plugin's own repo
  const source: Rec = obj(state) ? { ...(state as Rec) } : {};
  // Missing-id fallback flows through the serialized mint (adopting a
  // concurrently persisted id) — a bare runIdNow() here parented the claim
  // under an orphan run no other gate call could see (13c-codex sibling mints).
  const runId = typeof source.currentRunId === 'string' && source.currentRunId
    ? source.currentRunId
    : ensureCurrentRunId(cwd, state);
  if (!source.currentRunId) source.currentRunId = runId;
  const identity = hookSessionIdentity(rawInput);
  const minted = withRunAgentClaimsLockResult<Rec>(cwd, runId, () => {
    const ledger = ensureRunLedgerResult(cwd, runId, {
      status: 'active',
      kind: 'agent-claim',
      ...stackFingerprintPatch(cwd, runId, source),
    });
    // A LEDGER TRANSITION that could not be recorded is not a closed run, and
    // this is the join where the two halves of the split rule meet: the mint
    // inherits the ledger's `unavailable` verbatim so the gate above retries and
    // denies, instead of the old `ledger?.status !== 'active'` test that read an
    // unwritable ledger and a blocked one as the same refusal.
    if (ledger.outcome === 'unavailable') return unavailable<Rec>(`ledger-${ledger.reason}`);
    if (ledger.value?.status !== 'active') return preconditionFailed<Rec>('ledger-not-active');
    // Counts pending claims for the role, and listPendingClaims prunes expired
    // ones as it goes — so a handoff abandoned by a spawn that never started
    // frees the role's slot here rather than blocking it until it ages out.
    const spawnIndex = nextSpawnIndex(cwd, source, runId, role);
    const claimId = `${role}-${spawnIndex}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const claim: Rec = {
      version: 1,
      runId,
      claimId,
      role,
      spawnIndex,
      status: 'pending',
      parentSessionId: identity.sessionId || null,
      createdAt: stateTimestamp(),
      ...stackFingerprintPatch(cwd, runId, source),
      toolName: metadata.toolName || null,
      agentType: metadata.agentType || null,
      model: metadata.model || null,
      roleSource: metadata.roleSource || 'spawn-input',
    };
    // No raw mkdir first: createJsonExclusive creates the parent through the
    // same fence it writes through, and the mkdirSync that used to be here ran
    // ahead of it unfenced.
    const file = pendingClaimFile(cwd, runId, role);
    const created = createJsonExclusive(file, claim);
    if (created === 'refused') return unavailable<Rec>('pending-claim-write-refused');
    if (created === 'exists' && !supersedesPendingClaim(file, identity.sessionId)) {
      return preconditionFailed<Rec>('role-pending-claim-held');
    }
    // Superseding its own earlier handoff, which is a REWRITE of the same slot,
    // so it goes through writeJson (atomic replace) rather than the exclusive
    // create that just told us the slot is taken.
    if (created === 'exists' && !writeJson(file, claim)) {
      return unavailable<Rec>('pending-claim-write-refused');
    }
    return applied(claim);
  });
  if (minted.outcome !== 'applied' || !minted.value) return minted;
  const persistedClaim = minted.value;

  source.currentRunId = runId;
  const existingSpawn = obj(source.spawnIndex);
  const claimedSpawnIndex = typeof persistedClaim.spawnIndex === 'number' ? persistedClaim.spawnIndex : 1;
  source.spawnIndex = existingSpawn ? { ...existingSpawn, [role]: claimedSpawnIndex } : { [role]: claimedSpawnIndex };
  // `applied` used to be returned over this write unconditionally, which minted a
  // MutationResult claiming a mutation the fence had refused half of: the claim row
  // is on disk under `runId` while `.one.json` still names a different current run,
  // and every consumer then acts correctly on a lie. `unavailable` is the same
  // outcome the two pending-claim refusals above report, and it is the one that is
  // safe: gate-enforcement.ts's claimMintDeny retries and then DENIES the spawn on
  // `unavailable`, while `precondition-failed` lets it proceed — a spawn allowed
  // over an unrecorded run is exactly the child that binds no role.
  if (!writeState(cwd, source)) return unavailable<Rec>('run-state-write-refused');

  return minted;
}

export function ensureRunAgentClaim(
  cwd: string,
  state: unknown,
  role: string,
  rawInput: unknown,
  metadata: { toolName?: string; agentType?: string; model?: string; roleSource?: string } = {},
): Rec | null {
  return mutationValue(ensureRunAgentClaimResult(cwd, state, role, rawInput, metadata));
}

