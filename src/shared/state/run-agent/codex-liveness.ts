// src/shared/state/run-agent/codex-liveness.ts
// Codex live-agent validation against ~/.codex rollouts, with retire and
// rebind replay.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseJson, readJson, readText, writeJson } from '../../fsjson';
import {
  PENDING_AGENT_CLAIM_STALE_MS,
  RUNS_REL_DIR,
  SUBAGENT_STALE_MS,
  VALID_AGENT_ROLES,
} from '../../../config/state';
import { stateTimestamp } from '../io';
import {
  type CodexModelObservation,
  continuationModelOf,
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
  withAgentRegistryLock,
  type RunAgentEntry,
} from './registry';
import {
  annotateClaimRoleSource,
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
): RunAgentEntry | null {
  let result: RunAgentEntry | null = null;
  withAgentRegistryLock(cwd, runId, () => {
    const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
    const agents = obj(registry.agents) || {};
    const current = obj(agents[role]);
    if (!current || current.replaced === true) return;
    const expectedIds = new Set(idsForRunAgent(expected));
    if (!idsForRunAgent(current).some((id) => expectedIds.has(id))) return;
    current.roleSource = strongestRoleSource(source, current.roleSource);
    current.transcriptPath = transcriptPath;
    if (parentSessionId) current.parentSessionId = parentSessionId;
    try {
      writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents });
      result = readRunAgentRegistry(cwd, runId)[role] || null;
    } catch {
      result = null;
    }
  });
  return result;
}

function retireCodexRegistryEntryIfMatches(
  cwd: string,
  runId: string,
  role: string,
  expected: RunAgentEntry,
  reason: string,
): boolean {
  let retired = false;
  withAgentRegistryLock(cwd, runId, () => {
    const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
    const agents = obj(registry.agents) || {};
    const current = obj(agents[role]);
    if (!current || current.replaced === true) return;
    const expectedIds = new Set(idsForRunAgent(expected));
    if (!idsForRunAgent(current).some((id) => expectedIds.has(id))) return;
    current.replaced = true;
    current.replacedAt = stateTimestamp();
    current.replacementReason = reason;
    try {
      writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents });
      retired = true;
    } catch {
      retired = false;
    }
  });
  return retired;
}

export function retireUnverifiedCodexRunAgent(
  cwd: string,
  runId: string,
  role: string,
  entry: RunAgentEntry,
  reason: string = 'explicit-unverified-codex-replacement',
): boolean {
  return retireCodexRegistryEntryIfMatches(cwd, runId, role, entry, reason);
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
      if (claimed && !annotateClaimRoleSource(cwd, runId, claimed.key, claimed.claim, evidence)) {
        return { status: 'conflict', entry, reason: 'codex-claim-evidence-cas-lost' };
      }
      const annotated = annotateCodexRegistryEvidence(
        cwd, runId, requestedRole, entry, evidence.source, transcriptPath!,
        meta!.parentThreadId || currentParentSessionId || entry.parentSessionId,
      );
      return annotated
        ? { status: 'verified-match', entry: annotated }
        : { status: 'conflict', entry, reason: 'codex-registry-evidence-cas-lost' };
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
    return retireCodexRegistryEntryIfMatches(cwd, runId, requestedRole, entry, 'codex-session-meta-missing-stale')
      ? { status: 'stale-retired' }
      : { status: 'conflict', entry, reason: 'codex-stale-retire-cas-lost' };
  }
  return { status: 'unverified', entry, reason };
}

// Mark the role's current agent as replaced (exhausted/dead): the next spawn
// for the role is allowed and the recorder overwrites the entry.
