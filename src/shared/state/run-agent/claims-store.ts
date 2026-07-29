// src/shared/state/run-agent/claims-store.ts
// Claimed-agent listing, release paths, the claims lock, and
// ensureRunAgentClaim.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import { isNonProjectRoot } from '../../authoring-root';
import { parseJson, readJson, readText, writeJson } from '../../fsjson';
import {
  PENDING_AGENT_CLAIM_STALE_MS,
  RUNS_REL_DIR,
  SUBAGENT_STALE_MS,
  VALID_AGENT_ROLES,
} from '../../../config/state';
import { stateTimestamp } from '../io';
import {
  activeAgentRole,
  getSpawnIndex,
  isSubagentSession,
  stackFingerprint,
  UNKNOWN_STACK_FINGERPRINT,
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
} from './locks';
import {
  ensureRunLedger,
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
import { withFallbackClaimsLock } from './fallback-claims';

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
export function releaseRunClaims(cwd: string, runId: string, reason: string): number {
  if (typeof runId !== 'string' || !runId.trim() || isNonProjectRoot(cwd)) return 0;
  let released = 0;
  withRunAgentClaimsLock(cwd, runId.trim(), () => {
    for (const { filePath } of listPendingClaims(cwd, runId)) {
      removePendingClaim(filePath);
      released += 1;
    }
    for (const { filePath, claim } of listClaimedAgentEntries(cwd, runId)) {
      if (typeof claim.claimId !== 'string' || claim.status === 'released') continue;
      try {
        writeJson(filePath, { ...claim, status: 'released', releasedAt: stateTimestamp(), releasedReason: reason });
        released += 1;
      } catch {
        // best-effort: an unreleased claim ages out via SUBAGENT_STALE_MS
      }
    }
  });
  withFallbackClaimsLock(cwd, runId.trim(), () => {
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
  });
  return released;
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

export function ensureRunAgentClaim(
  cwd: string,
  state: unknown,
  role: string,
  rawInput: unknown,
  metadata: { toolName?: string; agentType?: string; model?: string; roleSource?: string } = {},
): Rec | null {
  if (!VALID_AGENT_ROLES.has(role)) return null;
  if (isNonProjectRoot(cwd)) return null; // never claim runs in the plugin's own repo
  const source: Rec = obj(state) ? { ...(state as Rec) } : {};
  // Missing-id fallback flows through the serialized mint (adopting a
  // concurrently persisted id) — a bare runIdNow() here parented the claim
  // under an orphan run no other gate call could see (13c-codex sibling mints).
  const runId = typeof source.currentRunId === 'string' && source.currentRunId
    ? source.currentRunId
    : ensureCurrentRunId(cwd, state);
  if (!source.currentRunId) source.currentRunId = runId;
  const identity = hookSessionIdentity(rawInput);
  let claim: Rec | null = null;
  const locked = withRunAgentClaimsLock(cwd, runId, () => {
    const ledger = ensureRunLedger(cwd, runId, {
      status: 'active',
      kind: 'agent-claim',
      ...stackFingerprintPatch(cwd, runId, source),
    });
    if (ledger?.status !== 'active') return;
    const spawnIndex = nextSpawnIndex(cwd, source, runId, role);
    const claimId = `${role}-${spawnIndex}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    claim = {
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
    fs.mkdirSync(pendingDir(cwd, runId), { recursive: true });
    writeJson(path.join(pendingDir(cwd, runId), `${safePathSegment(claimId)}.json`), claim);
  });
  const persistedClaim = claim as Rec | null;
  if (!locked || !persistedClaim) return null;

  source.currentRunId = runId;
  const existingSpawn = obj(source.spawnIndex);
  const claimedSpawnIndex = typeof persistedClaim.spawnIndex === 'number' ? persistedClaim.spawnIndex : 1;
  source.spawnIndex = existingSpawn ? { ...existingSpawn, [role]: claimedSpawnIndex } : { [role]: claimedSpawnIndex };
  writeState(cwd, source);

  return persistedClaim;
}

