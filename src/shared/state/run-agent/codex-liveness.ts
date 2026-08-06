// src/shared/state/run-agent/codex-liveness.ts
// Codex live-agent validation against ~/.codex rollouts, with retire and
// rebind replay.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {  readJson,  writeJson } from '../../fsjson';
import {
  SUBAGENT_STALE_MS,
} from '../../../config/state';
import { stateTimestamp } from '../io';
import {
  correctCodexChildObservationRole,
  readCodexModelObservation,
} from '../codex-model-observation';
import { readRunModelPolicy } from '../../run-model-policy';

import {
  firstString,
  runAgentFile,
  stackFingerprintPatch,
  uniqueStrings,
} from './run-paths';
import {
  readCodexSessionMetaIdentity,
  strongestRoleSource,
} from './role-evidence';
import {
  hookSessionIdentity,
  timestampAgeMs,
} from './session-identity';
import {
  readClaimFile,
} from './claims-pending';
import {
  agentRegistryFile,
  idsForRunAgent,
  readRunAgentRegistry,
  withAgentRegistryLockResult,
  type RunAgentEntry,
} from './registry';
import {
  applied,
  mutationApplied,
  preconditionFailed,
  retryWhileUnavailable,
  unavailable,
  type MutationResult,
} from './mutation-result';
import {
  annotateClaimRoleSourceResult,
} from './context-resolve';
import {
  authoritativeRebindThreadRole,
  replayAuthoritativeRebindJournal,
} from './rebind-journal';

export type CodexLiveAgentValidation =
  | { status: 'verified-match'; entry: RunAgentEntry }
  | { status: 'rebound' }
  | { status: 'stale-retired' }
  | { status: 'unverified'; entry: RunAgentEntry; reason: string }
  | { status: 'conflict'; entry: RunAgentEntry; reason: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidV7TimestampMs(value: string): number {
  if (!UUID_RE.test(value)) return 0;
  const raw = value.replace(/-/g, '').slice(0, 12);
  const parsed = Number.parseInt(raw, 16);
  return Number.isFinite(parsed) ? parsed : 0;
}

function codexSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = firstString(env.CODEX_HOME) || path.join(os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

function codexDateDirs(root: string, timestampMs: number): string[] {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return [];
  const dirs: string[] = [];
  for (const delta of [-86_400_000, 0, 86_400_000]) {
    const date = new Date(timestampMs + delta);
    const local = [
      String(date.getFullYear()).padStart(4, '0'),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ];
    const utc = [
      String(date.getUTCFullYear()).padStart(4, '0'),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    ];
    dirs.push(path.join(root, ...local), path.join(root, ...utc));
  }
  return uniqueStrings(dirs);
}

function claimForRunAgentEntry(cwd: string, runId: string, entry: RunAgentEntry): { key: string; claim: Rec } | null {
  for (const key of idsForRunAgent(entry)) {
    const claim = readClaimFile(runAgentFile(cwd, runId, key));
    if (claim) return { key, claim };
  }
  return null;
}

function findCodexTranscriptForEntry(
  entry: RunAgentEntry,
  claim: Rec | null,
  rawInput: unknown,
): string | null {
  const ids = uniqueStrings(idsForRunAgent(entry).filter((id) => UUID_RE.test(id.toLowerCase())));
  if (!ids.length) return null;
  for (const candidate of [entry.transcriptPath, firstString(claim?.transcriptPath)]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  const raw = obj(rawInput) || {};
  const payload = obj(raw.payload) || {};
  const currentTranscript = firstString(raw.transcript_path, raw.transcriptPath, payload.transcript_path, payload.transcriptPath);
  const root = codexSessionsRoot();
  const dirs: string[] = [];
  if (currentTranscript) dirs.push(path.dirname(currentTranscript));
  const recordedAtMs = Date.parse(entry.recordedAt || '');
  dirs.push(...codexDateDirs(root, recordedAtMs));
  for (const id of ids) dirs.push(...codexDateDirs(root, uuidV7TimestampMs(id)));

  for (const dir of uniqueStrings(dirs)) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const item of entries) {
      if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
      if (!ids.some((id) => item.name.endsWith(`${id}.jsonl`))) continue;
      return path.join(dir, item.name);
    }
  }
  return null;
}

function annotateCodexRegistryEvidence(
  cwd: string,
  runId: string,
  role: string,
  expected: RunAgentEntry,
  source: string,
  transcriptPath: string,
  parentSessionId: string | null,
): MutationResult<RunAgentEntry> {
  // Fix #4 of the eleven. The lock result was discarded and `result` was only
  // ever set on the success path, so a contended registry lock returned the same
  // `null` as "this row is not the agent we expected".
  //
  // The three-valued answer is returned rather than flattened because its one
  // caller is the LAST step of a reuse that has already verified the child, so
  // the two refusals mean opposite things there: a lost CAS says another writer
  // owns this row, while a contended lock says nothing was read or written at
  // all. Retrying is therefore worth one more lock timeout on a path whose
  // alternative is denying a verified continuation.
  return retryWhileUnavailable(() => withAgentRegistryLockResult<RunAgentEntry>(cwd, runId, () => {
    const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
    const agents = obj(registry.agents) || {};
    const current = obj(agents[role]);
    if (!current || current.replaced === true) return preconditionFailed('row-absent-or-replaced');
    const expectedIds = new Set(idsForRunAgent(expected));
    if (!idsForRunAgent(current).some((id) => expectedIds.has(id))) return preconditionFailed('expected-id-mismatch');
    current.roleSource = strongestRoleSource(source, current.roleSource);
    current.transcriptPath = transcriptPath;
    if (parentSessionId) current.parentSessionId = parentSessionId;
    try {
      if (!writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents })) {
        return unavailable<RunAgentEntry>('registry-write-refused');
      }
      const stored = readRunAgentRegistry(cwd, runId)[role];
      return stored ? applied(stored) : unavailable<RunAgentEntry>('registry-readback-empty');
    } catch {
      return unavailable<RunAgentEntry>('registry-write-failed');
    }
  }));
}

function retireCodexRegistryEntryIfMatches(
  cwd: string,
  runId: string,
  role: string,
  expected: RunAgentEntry,
  reason: string,
): MutationResult<void> {
  // Fix #5 of the eleven, the same shape as its sibling above.
  return withAgentRegistryLockResult<void>(cwd, runId, () => {
    const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
    const agents = obj(registry.agents) || {};
    const current = obj(agents[role]);
    if (!current || current.replaced === true) return preconditionFailed('row-absent-or-replaced');
    const expectedIds = new Set(idsForRunAgent(expected));
    if (!idsForRunAgent(current).some((id) => expectedIds.has(id))) return preconditionFailed('expected-id-mismatch');
    current.replaced = true;
    current.replacedAt = stateTimestamp();
    current.replacementReason = reason;
    try {
      // `retired = true` was unconditional on a completed call, so a refused
      // registry file reported a retired agent that is still live.
      if (!writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents })) {
        return unavailable('registry-write-refused');
      }
      return applied(undefined);
    } catch {
      return unavailable('registry-write-failed');
    }
  });
}

// The retire's three-valued face. Exported for the same reason as
// disownConflictedRoleAgentResult: the boolean below cannot tell a contended
// registry lock from "that row is not the agent you named", so the distinction is
// asserted against a held lock in
// __tests__/mutation-result-lock-contract.test.ts.
export function retireUnverifiedCodexRunAgentResult(
  cwd: string,
  runId: string,
  role: string,
  entry: RunAgentEntry,
  reason: string = 'explicit-unverified-codex-replacement',
): MutationResult<void> {
  return retireCodexRegistryEntryIfMatches(cwd, runId, role, entry, reason);
}

export function retireUnverifiedCodexRunAgent(
  cwd: string,
  runId: string,
  role: string,
  entry: RunAgentEntry,
  reason: string = 'explicit-unverified-codex-replacement',
): boolean {
  return mutationApplied(retireUnverifiedCodexRunAgentResult(cwd, runId, role, entry, reason));
}

export function validateCodexLiveRunAgent(
  cwd: string,
  state: unknown,
  rawInput: unknown,
  runId: string,
  requestedRole: string,
  entry: RunAgentEntry,
): CodexLiveAgentValidation {
  let claimed = claimForRunAgentEntry(cwd, runId, entry);
  const transcriptPath = findCodexTranscriptForEntry(entry, claimed?.claim || null, rawInput);
  const meta = transcriptPath ? readCodexSessionMetaIdentity(transcriptPath) : null;
  const hookIdentity = hookSessionIdentity(rawInput);
  const currentParentSessionId = hookIdentity.parentSessionId || hookIdentity.sessionId;

  const childId = idsForRunAgent(entry).find((id) => UUID_RE.test(id)) || entry.agentId;
  const policy = readRunModelPolicy(cwd, runId);
  let observation = readCodexModelObservation(cwd, runId, idsForRunAgent(entry));
  if (!policy || !observation) {
    return {
      status: 'unverified',
      entry,
      reason: !policy ? 'codex-run-model-policy-missing' : 'codex-observed-model-missing',
    };
  }
  if (observation.policyId !== policy.policyId) {
    return { status: 'conflict', entry, reason: 'codex-observed-model-policy-mismatch' };
  }
  const invalidIdentity = !meta
    || !meta.threadId
    || meta.threadId.toLowerCase() !== childId.toLowerCase()
    || Boolean(meta.parentThreadId && entry.parentSessionId && meta.parentThreadId !== entry.parentSessionId)
    || Boolean(meta.parentThreadId && currentParentSessionId && meta.parentThreadId !== currentParentSessionId);

  // A mismatch caused only by a provisional role is recoverable once the same
  // child exposes correction-grade line-zero metadata. Re-evaluate the already
  // observed model; never substitute the requested parent model. A conflict is
  // terminal and invalid/mismatched identity is never allowed to correct state.
  if (observation.status !== 'conflict'
    && !invalidIdentity
    && meta!.role.kind === 'evidence'
    && observation.role !== meta!.role.evidence.role) {
    observation = correctCodexChildObservationRole(
      cwd,
      runId,
      childId,
      meta!.role.evidence.role,
    );
    if (!observation) {
      return { status: 'conflict', entry, reason: 'codex-authoritative-role-model-mismatch' };
    }
  }
  if (observation.status === 'mismatch' || observation.status === 'conflict') {
    return { status: 'conflict', entry, reason: `codex-observed-model-${observation.status}` };
  }
  if (observation.status !== 'verified' || !observation.actualModel) {
    return { status: 'unverified', entry, reason: 'codex-observed-model-not-verified' };
  }
  if (!entry.model || entry.model !== observation.actualModel) {
    return { status: 'conflict', entry, reason: 'codex-registry-observed-model-mismatch' };
  }
  if (observation.parentSessionId && entry.parentSessionId
    && observation.parentSessionId !== entry.parentSessionId) {
    return { status: 'conflict', entry, reason: 'codex-observed-parent-registry-mismatch' };
  }
  if (observation.parentSessionId && currentParentSessionId
    && observation.parentSessionId !== currentParentSessionId) {
    return { status: 'conflict', entry, reason: 'codex-observed-parent-hook-mismatch' };
  }

  if (!invalidIdentity && meta!.role.kind === 'evidence') {
    const evidence = meta!.role.evidence;
    if (observation.role !== evidence.role) {
      observation = correctCodexChildObservationRole(cwd, runId, childId, evidence.role);
      if (!observation || observation.status !== 'verified' || observation.actualModel !== entry.model) {
        retireCodexRegistryEntryIfMatches(
          cwd,
          runId,
          requestedRole,
          entry,
          'codex-authoritative-role-model-mismatch',
        );
        return { status: 'conflict', entry, reason: 'codex-authoritative-role-model-mismatch' };
      }
    }
    if (evidence.role === requestedRole) {
      const replay = replayAuthoritativeRebindJournal(cwd, state, runId, childId);
      if (replay.status === 'blocked') {
        return { status: 'conflict', entry, reason: 'codex-authoritative-rebind-cleanup-pending' };
      }
      if (replay.status === 'complete') claimed = claimForRunAgentEntry(cwd, runId, entry);
      if (claimed && claimed.claim.role !== requestedRole) {
        const rebound = authoritativeRebindThreadRole(cwd, state, runId, childId, claimed.claim, evidence, {
          parentSessionId: meta!.parentThreadId || currentParentSessionId || entry.parentSessionId,
          model: observation.actualModel,
          transcriptPath,
          expectedRegistryRole: requestedRole,
          expectedRegistryIds: idsForRunAgent(entry),
        });
        return rebound
          ? { status: 'verified-match', entry: readRunAgentRegistry(cwd, runId)[requestedRole] || entry }
          : { status: 'conflict', entry, reason: 'codex-claim-registry-role-split' };
      }
      if (claimed) {
        // The same split as the registry annotation below, for the same reason and
        // one function earlier: `cas-lost` says another writer owns this claim,
        // while a contended CLAIMS lock says nothing was read or written at all.
        // Measured before the fix: 2016ms — one full claims-lock timeout — handed
        // to the gate as a lost compare-and-swap.
        const annotatedClaim = annotateClaimRoleSourceResult(cwd, runId, claimed.key, claimed.claim, evidence);
        if (annotatedClaim.outcome !== 'applied') {
          return {
            status: 'conflict',
            entry,
            reason: annotatedClaim.outcome === 'unavailable'
              ? `codex-claim-evidence-${annotatedClaim.reason}`
              : 'codex-claim-evidence-cas-lost',
          };
        }
      }
      const annotated = annotateCodexRegistryEvidence(
        cwd, runId, requestedRole, entry, evidence.source, transcriptPath!,
        meta!.parentThreadId || currentParentSessionId || entry.parentSessionId,
      );
      if (annotated.outcome === 'applied' && annotated.value) {
        return { status: 'verified-match', entry: annotated.value };
      }
      // Everything above this line VERIFIED the child; only the provenance
      // write-back failed. `cas-lost` therefore has to stay reserved for the
      // lost compare-and-swap, or a contended registry lock reads as "another
      // writer owns this row" and the gate's `agent-reuse-await-codex-meta`
      // prose sends the orchestrator to wait for a rollout flush that already
      // happened. The status stays `conflict` for BOTH deliberately: `unverified`
      // is what lets a justified [t1-replace-agent] retire the row, and retiring
      // a child whose role we just proved would trade two seconds of contention
      // for a destroyed live agent.
      return {
        status: 'conflict',
        entry,
        reason: annotated.outcome === 'unavailable'
          ? `codex-registry-evidence-${annotated.reason}`
          : 'codex-registry-evidence-cas-lost',
      };
    }

    const baseClaim: Rec = claimed?.claim || {
      version: 1,
      runId,
      claimId: `${requestedRole}-1-${childId.slice(-8)}`,
      role: requestedRole,
      spawnIndex: 1,
      status: 'claimed',
      sessionId: childId,
      parentSessionId: entry.parentSessionId,
      createdAt: entry.recordedAt || stateTimestamp(),
      claimedAt: entry.recordedAt || stateTimestamp(),
      ...stackFingerprintPatch(cwd, runId, state),
      model: entry.model,
    };
    const rebound = authoritativeRebindThreadRole(cwd, state, runId, childId, baseClaim, evidence, {
      parentSessionId: meta!.parentThreadId || currentParentSessionId || entry.parentSessionId,
      model: observation.actualModel,
      transcriptPath,
      expectedRegistryRole: requestedRole,
      expectedRegistryIds: idsForRunAgent(entry),
    });
    return rebound
      ? { status: 'rebound' }
      : { status: 'conflict', entry, reason: 'codex-authoritative-role-rebind-failed' };
  }

  if (!invalidIdentity && meta!.role.kind === 'conflict') {
    return { status: 'conflict', entry, reason: 'codex-session-meta-role-conflict' };
  }

  const reason = invalidIdentity
    ? 'codex-session-meta-missing-or-mismatched'
    : 'codex-session-meta-role-absent';
  if (timestampAgeMs(entry.recordedAt) > SUBAGENT_STALE_MS) {
    // `retireCodexRegistryEntryIfMatches` answers with a MutationResult, and an
    // object is always truthy: the ternary that used to be here reported EVERY
    // call as `stale-retired`, including a contended registry lock and a refused
    // write, which told the reuse gate the role was free while its live row sat
    // unretired on disk — and made `codex-stale-retire-cas-lost` unreachable.
    const retired = retireCodexRegistryEntryIfMatches(cwd, runId, requestedRole, entry, 'codex-session-meta-missing-stale');
    if (retired.outcome === 'applied') return { status: 'stale-retired' };
    return {
      status: 'conflict',
      entry,
      reason: retired.outcome === 'unavailable'
        ? `codex-stale-retire-${retired.reason}`
        : 'codex-stale-retire-cas-lost',
    };
  }
  return { status: 'unverified', entry, reason };
}

// Mark the role's current agent as replaced (exhausted/dead): the next spawn
// for the role is allowed and the recorder overwrites the entry.
