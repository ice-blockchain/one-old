// src/shared/state/run-agent.ts
// Per-agent run-claim machinery under .traffic-one/runs/<runId>/... so parallel
// subagents resolve their own role context. Ported 1:1 from
// scripts/hook-runtime/state/run-agent.cjs.

import { obj, type Rec } from '../obj';
import * as fs from 'fs';
import * as path from 'path';

import { isPluginAuthoringRoot } from '../authoring-root';
import { parseJson, readJson, writeJson } from '../fsjson';
import { normalizeRelPath, type AssignedScope } from '../scope';
import {
  PENDING_AGENT_CLAIM_STALE_MS,
  RUNS_REL_DIR,
  SUBAGENT_STALE_MS,
  VALID_AGENT_ROLES,
} from '../../config/state';
import { stateTimestamp } from './io';
import { activeAgentRole, getSpawnIndex, isSubagentSession, stackFingerprint } from './materialization';
import { writeState } from './normalize';

export function runIdNow(): string {
  return Date.now().toString();
}

// Ensure the project has a currentRunId, WITHOUT the full run-claim ceremony.
// The OpenCode delegation gate runs in all modes and scopes its per-role attempt
// marker by currentRunId, but ensureRunAgentClaim (which mints one) is reached
// only on the new-project path — so on existing-codebase projects a configured
// delegate role would slip past the gate whenever the orchestrator hasn't already
// persisted a run id (e.g. a fresh materialization, or an interrupted/resumed
// session that skipped Phase 0). Mirrors ensureRunAgentClaim's persist pattern;
// writeState splits local prefs back out, so .one.json stays canonical. Returns
// the existing or newly minted run id.
export function ensureCurrentRunId(cwd: string, state: unknown): string {
  const source: Rec = obj(state) ? { ...(state as Rec) } : {};
  const existing = typeof source.currentRunId === 'string' ? source.currentRunId.trim() : '';
  if (existing) return existing;
  const runId = runIdNow();
  source.currentRunId = runId;
  writeState(cwd, source);
  return runId;
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
function assignmentsFile(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'assignments.json');
}
function fallbackClaimsDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'claims');
}
function fallbackClaimFile(cwd: string, runId: string, target: string): string {
  return path.join(fallbackClaimsDir(cwd, runId), `${safePathSegment(target)}.json`);
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

// Codex reports the orchestrator's session_id in every hook payload — even for
// subagent threads — so session_id can't tell threads apart. The only per-thread
// discriminator is transcript_path, whose rollout filename ends with the running
// thread's id (the child's `agent_id`). Parse that canonical UUID.
const ROLLOUT_THREAD_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export function transcriptThreadId(transcriptPath: unknown): string | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const base = transcriptPath.replace(/\\/g, '/').split('/').pop() || '';
  const match = base.match(ROLLOUT_THREAD_RE);
  return match ? (match[1] as string).toLowerCase() : null;
}

// Infer the Traffic One role assigned to a subagent by reading its rollout
// (transcript_path) and matching the spawn assignment. Two anchored shapes cover
// the prompts orchestrators actually write (observed live on Codex):
//   - "You are … senior-X" (within one clause), and
//   - "Traffic One senior-X role / fix-cycle / second pass / fallback …" — the
//     dominant real-world phrasing; without it every Codex worker failed the
//     per-thread self-heal and fell through to racy pending-claim matching.
// Both are clause-anchored so a prompt that ALSO names other roles (e.g. "you are
// senior-frontend … senior-backend owns the API") still resolves the assigned
// role, not a cross-referenced one. Best-effort: returns null if the file is
// unreadable or the assignment isn't present yet (SubagentStart can fire before
// the rollout is flushed; the child's first write re-attempts when it is).
const SPAWN_ROLE_RES = [
  // Structured marker first — the contract every template-driven prompt carries
  // (`[t1-role: senior-x]`); phrasing heuristics below are the fallback.
  /\[t1-role:\s*(senior-(?:architect|frontend|backend|reviewer|tester|shipper))\s*\]/i,
  /\byou are\b[^.\n]{0,40}?\b(senior-(?:architect|frontend|backend|reviewer|tester|shipper))\b/i,
  /\btraffic[\s-]?one\b[^.\n]{0,60}?\b(senior-(?:architect|frontend|backend|reviewer|tester|shipper))\b/i,
] as const;
export function inferRoleFromTranscript(transcriptPath: unknown): string | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  const userTexts: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('"user"')) continue; // cheap prefilter before JSON.parse
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const p = obj((parsed as Rec)?.payload) || obj(parsed) || {};
    if (p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) continue;
    const text = (p.content as unknown[])
      .map((seg) => {
        const s = obj(seg);
        return s && s.type === 'input_text' && typeof s.text === 'string' ? s.text : '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) userTexts.push(text);
  }
  for (let i = userTexts.length - 1; i >= 0; i -= 1) {
    for (const re of SPAWN_ROLE_RES) {
      const match = (userTexts[i] || '').match(re);
      const role = match ? (match[1] as string).toLowerCase() : null;
      if (role && VALID_AGENT_ROLES.has(role)) return role;
    }
  }
  return null;
}

export interface SessionIdentity {
  sessionId: string | null;
  parentSessionId: string | null;
  isSubagent: boolean;
  // The running thread id parsed from transcript_path — the reliable per-thread
  // key on Codex (where session_id is always the parent). Null when absent.
  threadId: string | null;
  // The raw transcript_path (the running thread's rollout) — read to infer the role
  // of a Codex subagent that has no claim yet.
  transcriptPath: string | null;
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

  // NOTE: Cursor DOES send session_id (== conversation_id) on every event
  // (verified across all event types in captured cursor.hooks logs), so data.session_id
  // below already resolves it — no conversation_id alias is needed.
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
  const transcriptPath = firstString(data.transcript_path, data.transcriptPath, payload.transcript_path, payload.transcriptPath);
  const threadId = transcriptThreadId(transcriptPath);
  const threadSource = firstString(data.thread_source, data.threadSource, payload.thread_source, payload.threadSource);
  const isSubagent = Boolean(
    threadSource === 'subagent'
    || parentSessionId
    || nestedValue(source, ['subagent'])
    || nestedValue(data, ['subagent'])
    || nestedValue(payload, ['subagent']),
  );

  return { sessionId, parentSessionId, isSubagent, threadId, transcriptPath };
}

// True when the hook is firing inside a SUBAGENT thread (not the parent/main
// agent). On Claude a subagent has its own session_id plus a parent_session_id; on
// Codex every thread reports the parent's session_id, so the reliable per-thread
// discriminator is a transcript threadId that differs from the reported session_id.
// Used to keep parent-only flows (onboarding wizard) from ever running in a worker.
export function isSubagentThread(rawInput: unknown): boolean {
  const id = hookSessionIdentity(rawInput);
  return id.isSubagent || Boolean(id.threadId && id.sessionId && id.threadId !== id.sessionId);
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
  if (isPluginAuthoringRoot(cwd)) return null; // never claim runs in the plugin's own repo
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

  // Exact claim match. threadId (from transcript_path) is the reliable Codex key —
  // a subagent's tool-call hook reports the parent's session_id, so try threadId
  // first, then session_id (the per-thread id on Claude).
  const exactKeys = [identity.threadId, identity.sessionId].filter((v): v is string => Boolean(v));
  for (const runId of runIds) {
    for (const key of exactKeys) {
      const claim = readClaimFile(runAgentFile(cwd, runId, key));
      if (claim && claimAllowsState(state, claim)) {
        return contextFromClaim(claim, 'run-agent');
      }
    }
  }

  // Codex self-heal: a subagent thread (threadId differs from the parent session_id
  // Codex reports) with no claim yet — infer its role from its own transcript and
  // stake the claim now. This runs at the child's first gated write, by which point
  // the rollout carries the spawn assignment (SubagentStart can fire before it does).
  const inferredRole = shouldClaimPending && identity.transcriptPath
    ? inferRoleFromTranscript(identity.transcriptPath)
    : null;
  if (shouldClaimPending && identity.threadId && identity.sessionId && identity.threadId !== identity.sessionId) {
    if (inferredRole) {
      const ctx = claimThreadRole(cwd, state, identity.threadId, inferredRole, { parentSessionId: identity.sessionId });
      if (ctx) return ctx;
    }
  }

  if (shouldClaimPending && identity.isSubagent) {
    for (const runId of runIds) {
      // When the thread's transcript reveals its role, never claim a different
      // role's pending file: parallel fix-cycle workers spawn near-simultaneously
      // and FIFO matching hands the frontend worker the backend claim (observed
      // live — the misclaimed worker then fails every scope check and the run
      // deadlocks until the orchestrator improvises).
      const pending = listPendingClaims(cwd, runId)
        .filter(({ claim }) => claimAllowsState(state, claim))
        .filter(({ claim }) => !inferredRole || claim.role === inferredRole);
      const matched = pending.find(({ claim }) => (
        identity.parentSessionId && claim.parentSessionId && claim.parentSessionId === identity.parentSessionId
      )) || pending[0];
      if (!matched) continue;

      // Key the claimed file by the PER-THREAD id when we have one. On Codex,
      // identity.sessionId is the parent's session for every worker thread — using
      // it as the key made all parallel workers collide on one claim file (each
      // overwrite re-pointed every worker's resolution at the last-claimed role).
      const sessionId = identity.threadId || identity.sessionId || (matched.claim.sessionId as string) || (matched.claim.claimId as string);
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

// Create a claimed role context keyed by an explicit thread id. Used by the Codex
// SubagentStart hook: Codex fires no PreToolUse for spawns (so the agent-model gate
// never stakes a pending claim) and reports the parent's session_id on the child's
// later tool calls — the child is identifiable only by its transcript thread id
// (== the SubagentStart `agent_id`). We persist a claim under that id with the role
// inferred from the child's spawn prompt, so the child's write hook resolves its role
// by exact threadId match. Idempotent: an existing valid claim is returned as-is.
export function claimThreadRole(
  cwd: string,
  state: unknown,
  threadId: string,
  role: string,
  options: { parentSessionId?: string | null } = {},
): RunAgentContext | null {
  if (!VALID_AGENT_ROLES.has(role)) return null;
  if (typeof threadId !== 'string' || !threadId.trim()) return null;
  if (isPluginAuthoringRoot(cwd)) return null; // never claim runs in the plugin's own repo
  const id = threadId.trim();
  const source: Rec = obj(state) ? { ...(state as Rec) } : {};
  const runId = typeof source.currentRunId === 'string' && source.currentRunId ? source.currentRunId : runIdNow();

  const existing = readClaimFile(runAgentFile(cwd, runId, id));
  if (existing && claimAllowsState(state, existing)) {
    return contextFromClaim(existing, 'subagent-start');
  }

  const spawnIndex = nextSpawnIndex(cwd, source, runId, role);
  const claim: Rec = {
    version: 1,
    runId,
    claimId: `${role}-${spawnIndex}-${id.slice(-8)}`,
    role,
    spawnIndex,
    status: 'claimed',
    sessionId: id,
    parentSessionId: firstString(options.parentSessionId),
    createdAt: stateTimestamp(),
    claimedAt: stateTimestamp(),
    stackFingerprint: stackFingerprint(source),
  };
  fs.mkdirSync(runDir(cwd, runId), { recursive: true });
  writeJson(runAgentFile(cwd, runId, id), claim);
  // Deliberately NOT writeState() here. Parallel subagents self-heal their claims
  // near-simultaneously on their first writes, and writeState does a non-atomic
  // read-modify-rewrite of the shared .one.json — concurrent calls would clobber it.
  // The per-thread claim file written above is the source of truth, and
  // runIdsForLookup() scans the runs/ dir on disk, so resolution needs no
  // currentRunId/spawnIndex stamp (the orchestrator already stamps currentRunId
  // during onboarding; nextSpawnIndex counts claim files on disk).
  return contextFromClaim(claim, 'subagent-start');
}

export function hasRunAgentState(cwd: string, state: unknown): boolean {
  const s = obj(state);
  const runId = s && typeof s.currentRunId === 'string' ? s.currentRunId : null;
  if (!runId) return false;
  return fs.existsSync(runDir(cwd, runId));
}

// True when any subagent is currently in flight across all runs: a fresh pending
// claim (within PENDING_AGENT_CLAIM_STALE_MS) or a fresh claimed agent (within
// SUBAGENT_STALE_MS). Used by the build-completion heuristic to never flip a
// project to maintenance phase while an orchestration run is still active.
// `options.since` is the lifecycle completion watermark: claims created at or
// before it belong to a FINISHED run and do not count — without it, a completed
// build's claims would look "active" for up to 30 minutes and suppress the
// post-build triage directive at exactly the moment the user starts iterating.
export function hasActiveRunClaims(cwd: string, state: unknown, options: { since?: string | null } = {}): boolean {
  const sinceTs = typeof options.since === 'string' && options.since.trim() ? Date.parse(options.since) : NaN;
  const afterWatermark = (claim: Rec): boolean => {
    if (!Number.isFinite(sinceTs)) return true;
    const created = typeof claim.createdAt === 'string' ? Date.parse(claim.createdAt) : NaN;
    return !Number.isFinite(created) || created > sinceTs;
  };
  for (const runId of runIdsForLookup(cwd, state)) {
    if (listPendingClaims(cwd, runId).some(({ claim }) => afterWatermark(claim))) return true;
    if (listClaimedAgents(cwd, runId).some((claim) => isFreshTimestamp(claim.createdAt, SUBAGENT_STALE_MS) && afterWatermark(claim))) return true;
  }
  return false;
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

// --- Explicit per-run write assignments (scope manifest) -------------------
// The architect authors .traffic-one/runs/<runId>/assignments.json: a disjoint
// partition of the writable surface into role-owned scopes. The run-team gate reads
// it to allow/deny feature-source writes by ASSIGNED SCOPE rather than by guessed
// path-kind. Any feature path outside every assignment is governed by tryFallbackClaim,
// so the gate can never hard-deadlock. Roles here are free-form (NOT validated against
// VALID_AGENT_ROLES) so future streams (e.g. senior-mobile) are purely additive.

export interface AssignmentEntry {
  role: string;
  agentKey?: string;
  summary?: string;
  scope: AssignedScope;
}

export interface RunManifest {
  version: number;
  runId: string;
  createdAt?: string;
  createdBy?: string;
  stackFingerprint?: string;
  assignments: AssignmentEntry[];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

// Normalize the manifest's raw role entries. The canonical shape is an `assignments`
// ARRAY (`[{ role, scope:{ include, exclude } }]`). Some orchestrators deviate and emit
// a `roles` OBJECT instead (observed live: gpt-5.5 wrote
// `roles: { "<role>": { ownedPaths, readOnlyPaths, notes } }`), which the strict array
// reader rejected → the run-team scope gate resolved no scope and the rotation guard
// couldn't see the run. Tolerate that shape by mapping ownedPaths→scope.include and
// readOnlyPaths→scope.exclude (the role must not write another role's read-only paths).
function rawAssignmentEntries(raw: Rec): unknown[] {
  if (Array.isArray(raw.assignments)) return raw.assignments;
  const roles = obj(raw.roles);
  if (!roles) return [];
  const entries: unknown[] = [];
  for (const [role, value] of Object.entries(roles)) {
    const v = obj(value);
    if (!v) continue;
    const include = stringArray(v.ownedPaths).length ? stringArray(v.ownedPaths) : stringArray(v.include);
    const exclude = stringArray(v.readOnlyPaths).length ? stringArray(v.readOnlyPaths) : stringArray(v.exclude);
    entries.push({ role, scope: exclude.length ? { include, exclude } : { include } });
  }
  return entries;
}

// Read + validate the run's assignment manifest. Returns null when absent or
// structurally invalid. The manifest's runId dir is the same fingerprint-guarded run
// that resolved the agent's claim, so no extra fingerprint check is needed here.
// Tolerant of the `roles`-object schema deviation (see rawAssignmentEntries).
export function readRunAssignments(cwd: string, runId: unknown): RunManifest | null {
  if (typeof runId !== 'string' || !runId) return null;
  const raw = obj(readJson(assignmentsFile(cwd, runId), null));
  if (!raw) return null;
  const assignments: AssignmentEntry[] = [];
  for (const entry of rawAssignmentEntries(raw)) {
    const e = obj(entry);
    if (!e) continue;
    const scope = obj(e.scope);
    const include = scope ? stringArray(scope.include) : [];
    if (include.length === 0) continue;
    const role = typeof e.role === 'string' && e.role
      ? e.role
      : (typeof e.agentKey === 'string' && e.agentKey ? e.agentKey : null);
    if (!role) continue;
    const exclude = scope ? stringArray(scope.exclude) : [];
    assignments.push({
      role,
      agentKey: typeof e.agentKey === 'string' && e.agentKey ? e.agentKey : undefined,
      summary: typeof e.summary === 'string' ? e.summary : undefined,
      scope: exclude.length ? { include, exclude } : { include },
    });
  }
  if (!assignments.length) return null;
  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    runId: typeof raw.runId === 'string' && raw.runId ? raw.runId : runId,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : undefined,
    stackFingerprint: typeof raw.stackFingerprint === 'string' ? raw.stackFingerprint : undefined,
    assignments,
  };
}

// Resilient assignment lookup for the run-team gate. The architect SHOULD write
// assignments under `currentRunId`, but a RUN-ID SPLIT (the orchestrator generated a
// stray id — e.g. an ISO `date` string — instead of reading currentRunId) lands them
// under a DIFFERENT runs/<id>/ dir. Reading only currentRunId's path then returns null,
// so the gate can resolve no scope and blocks EVERY implementer write (observed: 36
// run-team denies → all subagents "Couldn't start"). Fall back to the NEWEST
// runs/<id>/assignments.json present so scope resolution survives the split. Ownership
// is matched by ROLE within the manifest, so a manifest from a stray run-id is still
// correct. (The orchestrator prose also eliminates the split at the source.)
export function readRunAssignmentsResilient(cwd: string, preferredRunId: unknown): RunManifest | null {
  const preferred = readRunAssignments(cwd, preferredRunId);
  if (preferred) return preferred;
  let newest: { runId: string; mtime: number } | null = null;
  try {
    const runsBase = path.join(cwd, '.traffic-one', 'runs');
    for (const entry of fs.readdirSync(runsBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let mtime = 0;
      try { mtime = fs.statSync(assignmentsFile(cwd, entry.name)).mtimeMs; } catch { continue; }
      if (!newest || mtime > newest.mtime) newest = { runId: entry.name, mtime };
    }
  } catch {
    // no runs dir — nothing to recover
  }
  return newest ? readRunAssignments(cwd, newest.runId) : null;
}

// --- Verification settlement (terminal verdict) ----------------------------
// A digest FILE exists from the moment its role first runs (Phase 3) and is
// re-emitted on every fix-cycle pass, so EXISTENCE never means "done" — the
// verdict LINE inside must be terminal. Canonical tokens (orchestrator SKILL +
// prompt-templates): reviewer `APPROVED` (vs `CHANGES_REQUESTED`), tester
// `TESTS_GREEN` (vs `TESTS_FAILING`). The opencode runner emits `DELEGATED_OK`
// until the orchestrator normalizes it — also non-terminal here by design.

function digestDir(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'digests', safePathSegment(runId));
}
function readDigest(cwd: string, runId: string, name: string): string {
  try {
    return fs.readFileSync(path.join(digestDir(cwd, runId), name), 'utf8');
  } catch {
    return '';
  }
}

// True when run <runId>'s verification has TERMINALLY settled: a shipper digest
// (written only post-deploy, after reviewer+tester already passed) exists, OR
// reviewer PASSED and tester PASSED. The canonical tester token is `TESTS_GREEN`,
// but orchestrators deviate (observed live: gpt-5.5 wrote the tester digest with
// `verdict: APPROVED`), so a tester is "passed" when it carries a passing token
// (`TESTS_GREEN`/`APPROVED`) AND no NON-terminal token (`TESTS_FAILING` = failing,
// `DELEGATED_OK` = delegated-but-unverified). A `CHANGES_REQUESTED` reviewer or a
// mid-fix-cycle `TESTS_FAILING` tester stays non-terminal. The "passing token present
// AND non-terminal token absent" shape avoids a false positive from a digest that
// merely mentions the other token.
export function runReachedTerminalVerdict(cwd: string, runId: unknown): boolean {
  if (typeof runId !== 'string' || !runId) return false;
  if (readDigest(cwd, runId, 'shipper.md').trim()) return true;
  const reviewer = readDigest(cwd, runId, 'reviewer.md');
  const tester = readDigest(cwd, runId, 'tester.md');
  const reviewerApproved = /\bAPPROVED\b/.test(reviewer) && !/\bCHANGES_REQUESTED\b/.test(reviewer);
  const testerPassed = /\b(TESTS_GREEN|APPROVED)\b/.test(tester) && !/\b(TESTS_FAILING|DELEGATED_OK)\b/.test(tester);
  return reviewerApproved && testerPassed;
}

// Schema-agnostic "an orchestrated run exists under <runId>" check — raw artifact
// EXISTENCE, never manifest parsing (so it survives the `roles`-schema deviation and
// any future shape). Used by the maintenance-rotation guard to decide whether a run is
// real before refusing to rotate its id. assignments.json OR an implementer/architect
// digest both prove the architect ran for this id.
export function runHasOrchestratedArtifacts(cwd: string, runId: unknown): boolean {
  if (typeof runId !== 'string' || !runId) return false;
  try {
    if (fs.existsSync(assignmentsFile(cwd, runId))) return true;
    const dd = digestDir(cwd, runId);
    return ['architect.md', 'frontend.md', 'backend.md', 'reviewer.md', 'tester.md'].some((n) => fs.existsSync(path.join(dd, n)));
  } catch {
    return false;
  }
}

// True when ANY run dir under .traffic-one/digests has a terminal verdict. The
// build-completion heuristic scans all run dirs (it does not assume currentRunId).
export function anyRunReachedTerminalVerdict(cwd: string): boolean {
  try {
    const base = path.join(cwd, '.traffic-one', 'digests');
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && runReachedTerminalVerdict(cwd, entry.name)) return true;
    }
  } catch {
    // best-effort — no digests dir means nothing has reached verification
  }
  return false;
}

// Resolve which assignment a writing agent owns. Prefer an indexed agentKey
// (`<role>#<spawnIndex>`), then a role-named agentKey, then the sole entry for the
// role. Null when the role maps to zero or ambiguously-many entries.
export function assignmentForContext(manifest: RunManifest, ctx: RunAgentContext): AssignmentEntry | null {
  const role = typeof ctx.role === 'string' && ctx.role ? ctx.role : null;
  if (!role) return null;
  const indexed = `${role}#${ctx.spawnIndex}`;
  const byIndexed = manifest.assignments.find((a) => a.agentKey === indexed);
  if (byIndexed) return byIndexed;
  const byRoleKey = manifest.assignments.find((a) => a.agentKey === role);
  if (byRoleKey) return byRoleKey;
  const byRole = manifest.assignments.filter((a) => a.role === role);
  return byRole.length === 1 ? (byRole[0] as AssignmentEntry) : null;
}

// Dynamic first-write claim for a feature path outside every assignment: the first
// agent to write it records a per-path lock so a DIFFERENT live agent is blocked, but
// the first writer (and that same agent re-writing) is never blocked. This is the
// totality guarantee — no feature path can be "owned by nobody -> hard block". Per-path
// file (never the shared .one.json) so parallel agents on different paths don't contend.
// Best-effort: if the lock can't be written, the writer is allowed.
export function tryFallbackClaim(
  cwd: string,
  ctx: RunAgentContext,
  target: string,
): { blocked: boolean; holder?: string } {
  const runId = ctx && ctx.runId != null ? String(ctx.runId) : '';
  if (!runId) return { blocked: false };
  if (isPluginAuthoringRoot(cwd)) return { blocked: false }; // no claim files in the plugin's own repo
  const myKey = String(ctx.sessionId || ctx.claimId || ctx.role || '');
  const file = fallbackClaimFile(cwd, runId, normalizeRelPath(target));
  const existing = obj(readJson(file, null));
  if (existing
    && isFreshTimestamp(existing.createdAt, SUBAGENT_STALE_MS)
    && typeof existing.holder === 'string' && existing.holder
    && existing.holder !== myKey) {
    return { blocked: true, holder: existing.holder };
  }
  const claim: Rec = {
    version: 1,
    runId,
    path: normalizeRelPath(target),
    holder: myKey,
    role: typeof ctx.role === 'string' ? ctx.role : null,
    sessionId: ctx.sessionId || null,
    createdAt: stateTimestamp(),
  };
  try {
    fs.mkdirSync(fallbackClaimsDir(cwd, runId), { recursive: true });
    writeJson(file, claim);
  } catch {
    // best-effort lock; never block the writer on a lock-write failure
  }
  return { blocked: false };
}

// ── Per-run live-agent registry (subagent reuse) ──────────────────────────────
// .traffic-one/runs/<runId>/agents.json maps role → the LIVE agent id returned
// by the host's spawn tool. The PostToolUse recorder writes it; the PreToolUse
// reuse gate denies a SECOND same-role spawn and points the orchestrator at the
// recorded id, so the role's later tasks continue ONE agent (SendMessage) and
// the rules+skills context loads once per role instead of once per task.
// Entries are parent-session-bound: an in-process agent dies with its parent
// session, so an id recorded by ANOTHER session never blocks a spawn.

export const REPLACE_AGENT_MARKER = '[t1-replace-agent]';

// Continuation needs the host's send-to-agent tool. On Codex that is
// send_input — native to the multi_agent toolset, always present, no flag (so
// the one-live-agent registry/dedup must be ON there by default; keying only on
// the Claude flag silently disabled the whole regime on Codex). On Claude it is
// SendMessage, which only registers when the agent-teams feature flag was set
// at session start. An explicit falsy flag still switches it off everywhere.
export function subagentContinuationAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = String(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (env.CODEX_PLUGIN_ROOT || env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || env.CODEX_THREAD_ID) return true;
  return flag !== '';
}

function agentRegistryFile(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'agents.json');
}

export interface RunAgentEntry {
  agentId: string;
  role: string;
  model: string | null;
  agentType: string | null;
  parentSessionId: string | null;
  recordedAt: string;
  tasks: number;
  replaced: boolean;
}

export function readRunAgentRegistry(cwd: string, runId: string): Record<string, RunAgentEntry> {
  const raw = obj(readJson(agentRegistryFile(cwd, runId), null));
  const agents = raw ? obj(raw.agents) : null;
  if (!agents) return {};
  const out: Record<string, RunAgentEntry> = {};
  for (const [role, value] of Object.entries(agents)) {
    const entry = obj(value);
    if (!entry || typeof entry.agentId !== 'string' || !entry.agentId) continue;
    out[role] = {
      agentId: entry.agentId,
      role,
      model: typeof entry.model === 'string' ? entry.model : null,
      agentType: typeof entry.agentType === 'string' ? entry.agentType : null,
      parentSessionId: typeof entry.parentSessionId === 'string' ? entry.parentSessionId : null,
      recordedAt: typeof entry.recordedAt === 'string' ? entry.recordedAt : '',
      tasks: typeof entry.tasks === 'number' && Number.isInteger(entry.tasks) && entry.tasks > 0 ? entry.tasks : 1,
      replaced: entry.replaced === true,
    };
  }
  return out;
}

export function recordRunAgent(
  cwd: string,
  runId: string,
  role: string,
  entry: { agentId: string; model?: string | null; agentType?: string | null; parentSessionId?: string | null },
): void {
  if (!VALID_AGENT_ROLES.has(role)) return;
  if (isPluginAuthoringRoot(cwd)) return; // never write run state in the plugin's own repo
  const agents = readRunAgentRegistry(cwd, runId) as Rec;
  const prior = obj(agents[role]);
  agents[role] = {
    agentId: entry.agentId,
    model: entry.model || null,
    agentType: entry.agentType || null,
    parentSessionId: entry.parentSessionId || null,
    recordedAt: stateTimestamp(),
    tasks: prior && prior.agentId === entry.agentId && typeof prior.tasks === 'number' ? (prior.tasks as number) + 1 : 1,
    replaced: false,
  };
  try {
    fs.mkdirSync(runDir(cwd, runId), { recursive: true });
    writeJson(agentRegistryFile(cwd, runId), { version: 1, agents });
  } catch {
    // best-effort registry; reuse falls back to fresh spawns when unwritable
  }
}

// The live (reusable) agent for a role, or null. parentSessionId binding: when
// BOTH sides are known they must match — an agent spawned by a different parent
// session no longer exists in-process. When either side is unknown (host did
// not surface a session id), fall back to a freshness window instead of
// blocking forever on a stale registry.
export function liveRunAgent(
  cwd: string,
  runId: string,
  role: string,
  parentSessionId: string | null,
): RunAgentEntry | null {
  const entry = readRunAgentRegistry(cwd, runId)[role];
  if (!entry || entry.replaced) return null;
  if (entry.parentSessionId && parentSessionId) {
    return entry.parentSessionId === parentSessionId ? entry : null;
  }
  return isFreshTimestamp(entry.recordedAt, SUBAGENT_STALE_MS) ? entry : null;
}

// Mark the role's current agent as replaced (exhausted/dead): the next spawn
// for the role is allowed and the recorder overwrites the entry.
export function markRunAgentReplaced(cwd: string, runId: string, role: string): void {
  if (isPluginAuthoringRoot(cwd)) return;
  const agents = readRunAgentRegistry(cwd, runId) as Rec;
  const entry = obj(agents[role]);
  if (!entry) return;
  entry.replaced = true;
  try {
    writeJson(agentRegistryFile(cwd, runId), { version: 1, agents });
  } catch {
    // best-effort
  }
}
