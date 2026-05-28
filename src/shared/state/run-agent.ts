// src/shared/state/run-agent.ts
// Per-agent run-claim machinery under .traffic-one/runs/<runId>/... so parallel
// subagents resolve their own role context. Ported 1:1 from
// scripts/hook-runtime/state/run-agent.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { parseJson, readJson, writeJson } from '../fsjson';
import {
  PENDING_AGENT_CLAIM_STALE_MS,
  RUNS_REL_DIR,
  SUBAGENT_STALE_MS,
  VALID_AGENT_ROLES,
} from './constants';
import { stateTimestamp } from './io';
import { activeAgentRole, getSpawnIndex, isSubagentSession, stackFingerprint } from './materialization';
import { writeState } from './normalize';

type Rec = Record<string, unknown>;

function obj(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

export function runIdNow(): string {
  return Date.now().toString();
}

function safePathSegment(value: unknown): string {
  return String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
}

function runsRoot(cwd: string): string {
  return path.join(cwd, RUNS_REL_DIR);
}
function runDir(cwd: string, runId: string): string {
  return path.join(runsRoot(cwd), safePathSegment(runId));
}
function pendingDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'pending');
}
function runAgentFile(cwd: string, runId: string, sessionId: string): string {
  return path.join(runDir(cwd, runId), `${safePathSegment(sessionId)}.json`);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function nestedValue(source: unknown, keys: string[]): unknown {
  let current: unknown = source;
  for (const key of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Rec)[key];
  }
  return current;
}

export interface SessionIdentity {
  sessionId: string | null;
  parentSessionId: string | null;
  isSubagent: boolean;
}

export function hookSessionIdentity(rawInput: unknown): SessionIdentity {
  const data = (rawInput && typeof rawInput === 'object'
    ? (rawInput as Rec)
    : parseJson<Rec>(typeof rawInput === 'string' ? rawInput : '', {}));
  const payload = obj(data.payload) || {};
  const source = obj(data.source) || obj(payload.source) || {};
  const threadSpawn = (nestedValue(source, ['subagent', 'thread_spawn'])
    || nestedValue(data, ['subagent', 'thread_spawn'])
    || nestedValue(payload, ['subagent', 'thread_spawn'])
    || {}) as Rec;

  const sessionId = firstString(
    data.session_id, data.sessionId, data.sessionID, data.id,
    payload.session_id, payload.sessionId, payload.id,
    nestedValue(data, ['session', 'id']), nestedValue(payload, ['session', 'id']),
  );
  const parentSessionId = firstString(
    data.parent_session_id, data.parentSessionId,
    payload.parent_session_id, payload.parentSessionId,
    threadSpawn.parent_thread_id, threadSpawn.parentThreadId,
    threadSpawn.parent_session_id, threadSpawn.parentSessionId,
  );
  const threadSource = firstString(data.thread_source, data.threadSource, payload.thread_source, payload.threadSource);
  const isSubagent = Boolean(
    threadSource === 'subagent'
    || parentSessionId
    || nestedValue(source, ['subagent'])
    || nestedValue(data, ['subagent'])
    || nestedValue(payload, ['subagent']),
  );

  return { sessionId, parentSessionId, isSubagent };
}

function timestampAgeMs(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return Infinity;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? Date.now() - ts : Infinity;
}
function isFreshTimestamp(value: unknown, maxAgeMs: number): boolean {
  return timestampAgeMs(value) <= maxAgeMs;
}

function stateAllowsRunContext(state: unknown, runId: unknown): boolean {
  const s = obj(state);
  if (!s) return false;
  if (typeof runId !== 'string' || !runId) return false;
  if (typeof s.currentRunId === 'string' && s.currentRunId && s.currentRunId !== runId) return false;
  if (!s.materializedStack) return false;
  if (s.materializedStack !== stackFingerprint(s)) return false;
  return true;
}

function claimAllowsState(state: unknown, claim: unknown): boolean {
  const c = obj(claim);
  if (!c) return false;
  if (typeof c.role !== 'string' || !VALID_AGENT_ROLES.has(c.role)) return false;
  if (!stateAllowsRunContext(state, c.runId)) return false;
  if (c.stackFingerprint && c.stackFingerprint !== stackFingerprint(state)) return false;
  if (!isFreshTimestamp(c.createdAt, SUBAGENT_STALE_MS)) return false;
  return true;
}

function runIdsForLookup(cwd: string, state: unknown): string[] {
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

function readClaimFile(filePath: string): Rec | null {
  return obj(readJson(filePath, null));
}

interface PendingClaim {
  filePath: string;
  claim: Rec;
}

function listPendingClaims(cwd: string, runId: string): PendingClaim[] {
  try {
    const dir = pendingDir(cwd, runId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry): PendingClaim | null => {
        const filePath = path.join(dir, entry.name);
        const claim = readClaimFile(filePath);
        return claim ? { filePath, claim } : null;
      })
      .filter((item): item is PendingClaim => item !== null)
      .filter(({ claim }) => isFreshTimestamp(claim.createdAt, PENDING_AGENT_CLAIM_STALE_MS))
      .sort((left, right) => String(left.claim.createdAt).localeCompare(String(right.claim.createdAt)));
  } catch {
    return [];
  }
}

function listClaimedAgents(cwd: string, runId: string): Rec[] {
  try {
    const dir = runDir(cwd, runId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => readClaimFile(path.join(dir, entry.name)))
      .filter((claim): claim is Rec => claim !== null);
  } catch {
    return [];
  }
}

function countRunClaimsForRole(cwd: string, runId: string, role: string): number {
  const pending = listPendingClaims(cwd, runId).filter(({ claim }) => claim.role === role).length;
  const claimed = listClaimedAgents(cwd, runId).filter((claim) => claim.role === role).length;
  return pending + claimed;
}

function nextSpawnIndex(cwd: string, state: unknown, runId: string, role: string): number {
  const stateIndex = getSpawnIndex(state, role);
  const diskIndex = countRunClaimsForRole(cwd, runId, role) + 1;
  return Math.max(stateIndex, diskIndex, 1);
}

export function ensureRunAgentClaim(
  cwd: string,
  state: unknown,
  role: string,
  rawInput: unknown,
  metadata: { toolName?: string; agentType?: string; model?: string } = {},
): Rec | null {
  if (!VALID_AGENT_ROLES.has(role)) return null;
  const source: Rec = obj(state) ? { ...(state as Rec) } : {};
  const runId = typeof source.currentRunId === 'string' && source.currentRunId ? source.currentRunId : runIdNow();
  const spawnIndex = nextSpawnIndex(cwd, source, runId, role);
  const identity = hookSessionIdentity(rawInput);
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
    stackFingerprint: stackFingerprint(source),
    toolName: metadata.toolName || null,
    agentType: metadata.agentType || null,
    model: metadata.model || null,
  };

  fs.mkdirSync(pendingDir(cwd, runId), { recursive: true });
  writeJson(path.join(pendingDir(cwd, runId), `${safePathSegment(claimId)}.json`), claim);

  source.currentRunId = runId;
  const existingSpawn = obj(source.spawnIndex);
  source.spawnIndex = existingSpawn ? { ...existingSpawn, [role]: spawnIndex } : { [role]: spawnIndex };
  writeState(cwd, source);

  return claim;
}

export interface RunAgentContext {
  source: string;
  runId: unknown;
  role: unknown;
  spawnIndex: number;
  sessionId: string | null;
  claimId: string | null;
}

function contextFromClaim(claim: Rec, source: string): RunAgentContext {
  return {
    source,
    runId: claim.runId,
    role: claim.role,
    spawnIndex: typeof claim.spawnIndex === 'number' && Number.isInteger(claim.spawnIndex) && claim.spawnIndex > 0
      ? claim.spawnIndex
      : 1,
    sessionId: (claim.sessionId as string) || null,
    claimId: (claim.claimId as string) || null,
  };
}

export function resolveRunAgentContext(
  cwd: string,
  state: unknown,
  rawInput: unknown,
  options: { claimPending?: boolean } = {},
): RunAgentContext | null {
  const identity = hookSessionIdentity(rawInput);
  const shouldClaimPending = options.claimPending !== false;
  const runIds = runIdsForLookup(cwd, state);

  if (identity.sessionId) {
    for (const runId of runIds) {
      const claim = readClaimFile(runAgentFile(cwd, runId, identity.sessionId));
      if (claim && claimAllowsState(state, claim)) {
        return contextFromClaim(claim, 'run-agent');
      }
    }
  }

  if (shouldClaimPending && identity.isSubagent) {
    for (const runId of runIds) {
      const pending = listPendingClaims(cwd, runId).filter(({ claim }) => claimAllowsState(state, claim));
      const matched = pending.find(({ claim }) => (
        identity.parentSessionId && claim.parentSessionId && claim.parentSessionId === identity.parentSessionId
      )) || pending[0];
      if (!matched) continue;

      const sessionId = identity.sessionId || (matched.claim.sessionId as string) || (matched.claim.claimId as string);
      const claimed: Rec = {
        ...matched.claim,
        status: 'claimed',
        sessionId,
        parentSessionId: identity.parentSessionId || matched.claim.parentSessionId || null,
        claimedAt: stateTimestamp(),
      };
      fs.mkdirSync(runDir(cwd, runId), { recursive: true });
      writeJson(runAgentFile(cwd, runId, sessionId), claimed);
      try {
        fs.rmSync(matched.filePath, { force: true });
      } catch {
        // a leftover pending file is harmless; freshness expires it
      }
      return contextFromClaim(claimed, 'run-agent');
    }
  }

  return null;
}

export function hasRunAgentState(cwd: string, state: unknown): boolean {
  const s = obj(state);
  const runId = s && typeof s.currentRunId === 'string' ? s.currentRunId : null;
  if (!runId) return false;
  return fs.existsSync(runDir(cwd, runId));
}

export function legacyRunAgentContext(state: unknown): RunAgentContext | null {
  if (!isSubagentSession(state)) return null;
  const role = activeAgentRole(state);
  if (!role) return null;
  const s = obj(state) || {};
  return {
    source: 'legacy-state',
    runId: s.currentRunId,
    role,
    spawnIndex: getSpawnIndex(state, role) || 1,
    sessionId: null,
    claimId: null,
  };
}
