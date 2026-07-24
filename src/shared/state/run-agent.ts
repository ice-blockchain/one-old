// src/shared/state/run-agent.ts
// Per-agent run-claim machinery under .traffic-one/runs/<runId>/... so parallel
// subagents resolve their own role context. Ported 1:1 from
// scripts/hook-runtime/state/run-agent.cjs.

import { obj, type Rec } from '../obj';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isNonProjectRoot } from '../authoring-root';
import { STATE_FILE } from '../../config/paths';
import { parseJson, readJson, writeJson } from '../fsjson';
import { normalizeRelPath, type AssignedScope } from '../scope';
import {
  PENDING_AGENT_CLAIM_STALE_MS,
  RUNS_REL_DIR,
  SUBAGENT_STALE_MS,
  VALID_AGENT_ROLES,
} from '../../config/state';
import { TIER_IDS, type TierId } from '../../config/model-tiers';
import { stateTimestamp } from './io';
import { activeAgentRole, getSpawnIndex, isSubagentSession, stackFingerprint } from './materialization';
import { writeState } from './normalize';
import { withProjectStateLock } from './project-state-lock';
import {
  type CodexModelObservation,
  correctCodexChildObservationRole,
  readCodexModelObservation,
} from './codex-model-observation';
import { readRunModelPolicy } from '../run-model-policy';
import { isQaBrowserBridgeEligible, readQaReportV1, type QaReportValidationResult } from '../qa-report';

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
  const existing = typeof source.currentRunId === 'string'
    ? source.currentRunId.trim()
    : (typeof source.currentRunId === 'number' && Number.isFinite(source.currentRunId) ? String(Math.trunc(source.currentRunId)) : '');
  if (existing) {
    // Reading/freezing policy for an existing id is not itself a resume. In
    // particular SessionStart calls this on every subagent-enabled project.
    // Actual worker claims and the unresolved-run continue path activate the
    // ledger and upgrade legacy evidence semantics at their action boundary.
    return existing;
  }
  // Mint-once: serialize the check-and-mint with every canonical .one.json
  // writer and RE-READ the on-disk state under the lock. Parallel first tool
  // calls each run their own hook process off a pre-mint state snapshot; each
  // minting independently produced three runs/<id>/ trees with divergent model
  // policies in one session (observed 13c-codex — the orchestrator then read an
  // orphan policy id and the run-id gate denied its first spawn). Late arrivals
  // must ADOPT the persisted id, not mint a sibling.
  let runId = '';
  let minted = false;
  const mint = () => {
    runId = runIdNow();
    minted = true;
    source.currentRunId = runId;
    writeState(cwd, source);
  };
  try {
    withProjectStateLock(cwd, () => {
      const onDisk = readJson<Rec>(path.join(cwd, STATE_FILE), {});
      const diskRaw = onDisk.currentRunId;
      const diskId = typeof diskRaw === 'string'
        ? diskRaw.trim()
        : (typeof diskRaw === 'number' && Number.isFinite(diskRaw) ? String(Math.trunc(diskRaw)) : '');
      if (diskId) {
        runId = diskId;
        source.currentRunId = diskId;
        return;
      }
      mint(); // writeState re-enters the already-held project-state lock
    });
  } catch {
    // Lock acquisition failed (timeout/contention edge): keep the previous
    // unserialized behavior rather than failing the caller's hook outright.
    if (!runId) mint();
  }
  if (minted) {
    ensureRunLedger(cwd, runId, { status: 'planned', kind: 'spawn-gate', stackFingerprint: stackFingerprint(source) });
  }
  // Keep the caller's in-memory `state` in sync so a later ensureRunAgentClaim (which
  // reads currentRunId off the SAME state object) reuses THIS id instead of minting a
  // second one. Without this the spawn's run markers (OpenCode attempts, model
  // advisory/choice) land under an orphaned id that never matches the persisted
  // currentRunId that subsequent gate calls read back.
  if (obj(state)) (state as Rec).currentRunId = runId;
  return runId;
}

function safePathSegment(value: unknown): string {
  const segment = String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
  // `.` and `..` survive the character allowlist but are never safe directory
  // names. Keep legacy sanitization behavior while preventing path traversal.
  if (segment === '.') return '_';
  if (segment === '..') return '__';
  return segment;
}

function runsRoot(cwd: string): string {
  return path.join(cwd, RUNS_REL_DIR);
}
function runDir(cwd: string, runId: string): string {
  return path.join(runsRoot(cwd), safePathSegment(runId));
}
function runLedgerFile(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'run.json');
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
function authoritativeRebindJournalFile(cwd: string, runId: string, threadId: string): string {
  return path.join(runDir(cwd, runId), 'transactions', `rebind-${safePathSegment(threadId)}.json`);
}

export const RUN_LEDGER_TRANSITION_HISTORY_LIMIT = 32;

export type RunLedgerStatus = 'planned' | 'active' | 'completed' | 'blocked' | 'failed';
export type RunLedgerOutcome =
  | 'verified'
  | 'shipped'
  | 'review-cycle-cap'
  | 'test-cycle-cap'
  | 'environment-blocked'
  | 'agent-failed';

export interface RunLedgerTransitionOptions {
  status: RunLedgerStatus;
  outcome?: RunLedgerOutcome;
  reason?: string;
  kind?: string;
  stackFingerprint?: string;
  /** Internal compatibility path for terminal settlement of a pre-ledger run. */
  preserveLegacyQaContract?: boolean;
}

const RUN_LEDGER_STATUSES = new Set<RunLedgerStatus>(['planned', 'active', 'completed', 'blocked', 'failed']);
const RUN_LEDGER_OUTCOMES = new Set<RunLedgerOutcome>([
  'verified',
  'shipped',
  'review-cycle-cap',
  'test-cycle-cap',
  'environment-blocked',
  'agent-failed',
]);
const RUN_LEDGER_LOCK_TIMEOUT_MS = 2_000;
const RUN_LEDGER_LOCK_STALE_MS = 15_000;
const RUN_LEDGER_LOCK_RETRY_MS = 10;
const RUN_LEDGER_WAIT = new Int32Array(new SharedArrayBuffer(4));

function isRunLedgerStatus(value: unknown): value is RunLedgerStatus {
  return typeof value === 'string' && RUN_LEDGER_STATUSES.has(value as RunLedgerStatus);
}

function isRunLedgerOutcome(value: unknown): value is RunLedgerOutcome {
  return typeof value === 'string' && RUN_LEDGER_OUTCOMES.has(value as RunLedgerOutcome);
}

function isTerminalRunLedgerStatus(status: RunLedgerStatus): boolean {
  return status === 'completed' || status === 'blocked' || status === 'failed';
}

function runLedgerTransitionAllowed(from: RunLedgerStatus, to: RunLedgerStatus, reason: unknown): boolean {
  if (from === to) return true;
  if (from === 'planned') return to === 'active' || to === 'blocked' || to === 'failed' || to === 'completed';
  if (from === 'active') return to === 'completed' || to === 'blocked' || to === 'failed';
  if (from === 'blocked') return to === 'active' && reason === 'user-authorized-extra-cycle';
  return false;
}

function outcomeAllowedForStatus(status: RunLedgerStatus, outcome: RunLedgerOutcome | undefined): boolean {
  if (!outcome) return status === 'planned' || status === 'active';
  if (status === 'completed') return outcome === 'verified' || outcome === 'shipped';
  if (status === 'blocked') {
    return outcome === 'review-cycle-cap' || outcome === 'test-cycle-cap' || outcome === 'environment-blocked';
  }
  return status === 'failed' && outcome === 'agent-failed';
}

function terminalOutcomeTransitionAllowed(
  status: RunLedgerStatus,
  previous: RunLedgerOutcome | undefined,
  requested: RunLedgerOutcome | undefined,
): boolean {
  if (previous === requested || previous === undefined) return true;
  // A verified run may later be shipped without reopening it. Other terminal
  // outcomes are immutable so replay or reconciliation cannot rewrite history.
  return status === 'completed' && previous === 'verified' && requested === 'shipped';
}

function runLedgerHistory(value: unknown): Rec[] {
  if (!Array.isArray(value)) return [];
  return value.filter(obj).slice(-RUN_LEDGER_TRANSITION_HISTORY_LIMIT);
}

function runLedgerLockDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), '.run-ledger.lock');
}

function withRunLedgerLock(cwd: string, runId: string, mutate: () => void): boolean {
  return withOwnedDirLock(
    runLedgerLockDir(cwd, runId),
    RUN_LEDGER_LOCK_TIMEOUT_MS,
    RUN_LEDGER_LOCK_STALE_MS,
    RUN_LEDGER_LOCK_RETRY_MS,
    RUN_LEDGER_WAIT,
    mutate,
  );
}

function writeRunLedgerTransition(
  cwd: string,
  id: string,
  patch: Rec,
  options: { requireValidTransition: boolean },
): Rec | null {
  const now = stateTimestamp();
  const existing = obj(readJson(runLedgerFile(cwd, id), null)) || {};
  const isNew = Object.keys(existing).length === 0;
  const currentStatus = isRunLedgerStatus(existing.status) ? existing.status : 'planned';
  const requestedStatus = isRunLedgerStatus(patch.status) ? patch.status : currentStatus;
  const reason = typeof patch.reason === 'string' ? patch.reason : undefined;
  if (options.requireValidTransition && !runLedgerTransitionAllowed(currentStatus, requestedStatus, reason)) return null;

  const priorOutcome = isRunLedgerOutcome(existing.outcome) ? existing.outcome : undefined;
  const requestedOutcome = isRunLedgerOutcome(patch.outcome)
    ? patch.outcome
    : (requestedStatus === currentStatus ? priorOutcome : undefined);
  if (options.requireValidTransition && !outcomeAllowedForStatus(requestedStatus, requestedOutcome)) return null;
  if (options.requireValidTransition
    && requestedStatus === currentStatus
    && !terminalOutcomeTransitionAllowed(requestedStatus, priorOutcome, requestedOutcome)) return null;
  if (options.requireValidTransition && requestedStatus === 'completed') {
    const idempotentTerminal = currentStatus === 'completed' && requestedOutcome === priorOutcome;
    if (!idempotentTerminal && !runCompletionEvidenceAllows(cwd, id, requestedOutcome)) return null;
  }

  const createdAt = typeof existing.createdAt === 'string' && existing.createdAt ? existing.createdAt : now;
  const statusChanged = isNew || requestedStatus !== currentStatus;
  const outcomeChanged = requestedOutcome !== priorOutcome;
  const transitionChanged = statusChanged || outcomeChanged;
  const history = runLedgerHistory(existing.transitionHistory);
  if (transitionChanged) {
    history.push({
      from: isNew ? null : currentStatus,
      to: requestedStatus,
      at: now,
      ...(requestedOutcome ? { outcome: requestedOutcome } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  const resumesLegacyRun = !isNew && existing.qaContractVersion !== 1 && requestedStatus === 'active';
  const preserveLegacyQaContract = isNew && patch.preserveLegacyQaContract === true;
  const qaContractVersion = existing.qaContractVersion === 1
    || patch.qaContractVersion === 1
    || (isNew && !preserveLegacyQaContract)
    || resumesLegacyRun
    ? 1
    : undefined;
  const activatesQaContract = qaContractVersion === 1 && (
    existing.qaContractVersion !== 1
    || (requestedStatus === 'active' && currentStatus !== 'active')
  );
  const next: Rec = {
    ...existing,
    ...patch,
    version: typeof existing.version === 'number' ? existing.version : 1,
    runId: typeof existing.runId === 'string' && existing.runId ? existing.runId : id,
    status: requestedStatus,
    kind: typeof patch.kind === 'string' && patch.kind
      ? patch.kind
      : (typeof existing.kind === 'string' && existing.kind ? existing.kind : 'planned'),
    createdAt,
    statusUpdatedAt: transitionChanged
      ? now
      : (typeof existing.statusUpdatedAt === 'string' && existing.statusUpdatedAt ? existing.statusUpdatedAt : createdAt),
    transitionHistory: history.slice(-RUN_LEDGER_TRANSITION_HISTORY_LIMIT),
    updatedAt: now,
  };
  if (qaContractVersion === 1) next.qaContractVersion = 1;
  else delete next.qaContractVersion;
  if (qaContractVersion === 1) {
    next.qaContractActivatedAt = activatesQaContract
      // Lifecycle timestamps intentionally retain legacy whole-second precision;
      // QA freshness needs milliseconds so evidence created just before a resume
      // in the same second cannot slip past the activation boundary.
      ? new Date().toISOString()
      : (typeof existing.qaContractActivatedAt === 'string' && existing.qaContractActivatedAt
        ? existing.qaContractActivatedAt
        : createdAt);
  } else {
    delete next.qaContractActivatedAt;
  }
  delete next.preserveLegacyQaContract;
  // Resume authorization belongs to the immutable transition entry, not to the
  // ledger's mutable top level where a later write could make it look current.
  delete next.reason;

  if (requestedOutcome) next.outcome = requestedOutcome;
  else delete next.outcome;
  if (isTerminalRunLedgerStatus(requestedStatus)) {
    next.finishedAt = typeof existing.finishedAt === 'string' && existing.finishedAt && !statusChanged
      ? existing.finishedAt
      : now;
  } else {
    delete next.finishedAt;
  }
  try {
    fs.mkdirSync(runDir(cwd, id), { recursive: true });
    writeJson(runLedgerFile(cwd, id), next);
    return next;
  } catch {
    return null;
  }
}

export function ensureRunLedger(cwd: string, runId: unknown, patch: Rec = {}): Rec | null {
  if (isNonProjectRoot(cwd)) return null;
  if (typeof runId !== 'string' || !runId.trim()) return null;
  const id = runId.trim();
  let result: Rec | null = null;
  const locked = withRunLedgerLock(cwd, id, () => {
    result = writeRunLedgerTransition(cwd, id, patch, { requireValidTransition: true });
  });
  return locked ? result : null;
}

// The single status-mutation entry point for orchestration settlement. Replaying
// the same terminal transition is idempotent; a blocked run may become active only
// after the parent records the exact user-authorized resume reason.
export function transitionRunStatus(
  cwd: string,
  runId: unknown,
  options: RunLedgerTransitionOptions,
): Rec | null {
  if (isNonProjectRoot(cwd)) return null;
  if (typeof runId !== 'string' || !runId.trim()) return null;
  const id = runId.trim();
  let result: Rec | null = null;
  const locked = withRunLedgerLock(cwd, id, () => {
    result = writeRunLedgerTransition(cwd, id, options as unknown as Rec, { requireValidTransition: true });
  });
  return locked ? result : null;
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

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
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

export type RoleEvidenceAuthority = 'authoritative' | 'explicit' | 'heuristic';

export interface RoleEvidence {
  role: string;
  source: string;
  authority: RoleEvidenceAuthority;
}

// Evidence is persisted across hooks, so precedence must survive beyond the
// resolver invocation that first saw it. Host/session metadata is the strongest
// correction tier; an exact task_name may repair only weaker legacy evidence,
// while readable prompt evidence is compatibility-only.
function roleSourceTier(source: unknown): number {
  if (typeof source !== 'string' || !source) return 0;
  if (source.startsWith('codex-session-meta-') && source !== 'spawn-task-name') return 3;
  if (source === 'host-declared-role'
    || source === 'host-agent-role'
    || source === 'host-agent-path'
    || source === 'host-agent-type'
    || source === 'host-subagent-type'
    || source === 'host-profile'
    || source === 'host-agent-name') return 3;
  if (source === 'spawn-task-name') return 2;
  if (source.includes('marker') || source.includes('declaration')) return 1;
  return 0;
}

function isCorrectionGradeEvidence(
  evidence: RoleEvidence | null | undefined,
  existingSource?: unknown,
): evidence is RoleEvidence {
  if (!evidence || evidence.authority !== 'authoritative') return false;
  const incomingTier = roleSourceTier(evidence.source);
  // Correction requires strictly stronger evidence. Conflicting host/session
  // metadata — or two exact task_name values — is an unresolved same-tier
  // conflict, never a last-writer-wins rebind.
  return incomingTier >= 2 && roleSourceTier(existingSource) < incomingTier;
}

function strongestRoleSource(incoming: unknown, existing: unknown): string | null {
  const next = firstString(incoming);
  const prior = firstString(existing);
  if (!next) return prior;
  if (!prior) return next;
  return roleSourceTier(next) >= roleSourceTier(prior) ? next : prior;
}

export type RoleEvidenceResolution =
  | { kind: 'evidence'; evidence: RoleEvidence }
  | { kind: 'conflict'; candidates: RoleEvidence[] }
  | { kind: 'none' };

export interface CodexSessionMetaIdentity {
  threadId: string | null;
  parentThreadId: string | null;
  role: RoleEvidenceResolution;
}

const ROLE_MARKER_RE = /\[t1-role:\s*((?:senior[-_](?:architect|frontend|backend|reviewer|tester|shipper)|quick[-_]fix)(?:[-_]\d+)?)\s*\]/ig;
// Line-anchored variant for the roleless-Codex-meta fallthrough: only a marker
// deliberately placed at the START of a line in the SPAWN PROMPT is identity —
// a marker quoted mid-prose in inherited context must never grant a role.
const ROLE_MARKER_LINE_ANCHORED_RE = /^[ \t]*\[t1-role:\s*((?:senior[-_](?:architect|frontend|backend|reviewer|tester|shipper)|quick[-_]fix)(?:[-_]\d+)?)\s*\]/igm;
const ROLE_DECLARATION_RES = [
  /\byou are\b[^.\n]{0,40}?\b(senior-(?:architect|frontend|backend|reviewer|tester|shipper))\b/i,
  /\btraffic[\s-]?one\b[^.\n]{0,60}?\b(senior-(?:architect|frontend|backend|reviewer|tester|shipper))\b/i,
] as const;

// Normalize only an exact role-shaped namespace/path leaf. Host-generic values
// such as `default`, `worker`, or `general` are absent evidence, not conflicts.
export function normalizeRoleIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const leaf = (value.trim().replace(/\\/g, '/').split(/[/:]/).pop() || '').trim().toLowerCase();
  const withoutReplacement = leaf.replace(/(?:_|-)([1-9]\d*)$/, '');
  const role = withoutReplacement.replace(/_/g, '-');
  return VALID_AGENT_ROLES.has(role) ? role : null;
}

function resolveRoleCandidates(candidates: RoleEvidence[]): RoleEvidenceResolution {
  if (!candidates.length) return { kind: 'none' };
  const roles = new Set(candidates.map((candidate) => candidate.role));
  return roles.size === 1
    ? { kind: 'evidence', evidence: candidates[0]! }
    : { kind: 'conflict', candidates };
}

function roleCandidate(value: unknown, source: string, authority: RoleEvidenceAuthority): RoleEvidence | null {
  const role = normalizeRoleIdentity(value);
  return role ? { role, source, authority } : null;
}

function compactCandidates(values: Array<RoleEvidence | null>): RoleEvidence[] {
  return values.filter((value): value is RoleEvidence => Boolean(value));
}

function codexSessionMetaIdentityFromRecord(parsed: unknown): CodexSessionMetaIdentity | null {
  const record = obj(parsed);
  if (!record || record.type !== 'session_meta') return null;
  const payload = obj(record.payload) || {};
  const source = obj(payload.source) || {};
  const subagent = obj(source.subagent) || {};
  const spawn = obj(subagent.thread_spawn) || obj(subagent.threadSpawn) || {};
  const threadSource = firstString(payload.thread_source, payload.threadSource);
  if (threadSource !== 'subagent' && !obj(source.subagent)) return null;

  const hostCandidates = compactCandidates([
    roleCandidate(payload.agent_type, 'codex-session-meta-agent-type', 'authoritative'),
    roleCandidate(payload.agentType, 'codex-session-meta-agent-type', 'authoritative'),
    roleCandidate(payload.subagent_type, 'codex-session-meta-subagent-type', 'authoritative'),
    roleCandidate(payload.subagentType, 'codex-session-meta-subagent-type', 'authoritative'),
    roleCandidate(spawn.agent_type, 'codex-session-meta-agent-type', 'authoritative'),
    roleCandidate(spawn.agentType, 'codex-session-meta-agent-type', 'authoritative'),
    roleCandidate(spawn.subagent_type, 'codex-session-meta-subagent-type', 'authoritative'),
    roleCandidate(spawn.subagentType, 'codex-session-meta-subagent-type', 'authoritative'),
    roleCandidate(payload.agent_role, 'codex-session-meta-agent-role', 'authoritative'),
    roleCandidate(payload.agentRole, 'codex-session-meta-agent-role', 'authoritative'),
    roleCandidate(spawn.agent_role, 'codex-session-meta-spawn-role', 'authoritative'),
    roleCandidate(spawn.agentRole, 'codex-session-meta-spawn-role', 'authoritative'),
    roleCandidate(payload.agent_path, 'codex-session-meta-agent-path', 'authoritative'),
    roleCandidate(payload.agentPath, 'codex-session-meta-agent-path', 'authoritative'),
    roleCandidate(spawn.agent_path, 'codex-session-meta-spawn-path', 'authoritative'),
    roleCandidate(spawn.agentPath, 'codex-session-meta-spawn-path', 'authoritative'),
  ]);
  const hostResolution = resolveRoleCandidates(hostCandidates);
  const taskNameResolution = resolveRoleCandidates(compactCandidates([
    roleCandidate(payload.task_name, 'spawn-task-name', 'authoritative'),
    roleCandidate(payload.taskName, 'spawn-task-name', 'authoritative'),
    roleCandidate(spawn.task_name, 'spawn-task-name', 'authoritative'),
    roleCandidate(spawn.taskName, 'spawn-task-name', 'authoritative'),
  ]));
  return {
    threadId: firstString(payload.id, payload.thread_id, payload.threadId),
    parentThreadId: firstString(
      payload.parent_thread_id, payload.parentThreadId,
      spawn.parent_thread_id, spawn.parentThreadId,
      spawn.parent_session_id, spawn.parentSessionId,
    ),
    role: hostResolution.kind !== 'none' ? hostResolution : taskNameResolution,
  };
}

const CODEX_SESSION_META_LINE_MAX_BYTES = 128 * 1024;

function readFirstLineCapped(filePath: string, maxBytes: number = CODEX_SESSION_META_LINE_MAX_BYTES): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < maxBytes) {
      const size = Math.min(16 * 1024, maxBytes - offset);
      const buffer = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buffer, 0, size, offset);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(10);
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : Buffer.from(chunk));
      if (newline >= 0) break;
      offset += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

// Head-capped whole-file read for the readable-record role scan below. The spawn
// prompt (and its `[t1-role: …]` marker) lands within the first few records of a
// child rollout, so a bounded head read recovers it without loading a potentially
// very large transcript; a trailing partial line simply fails JSON.parse and is
// skipped by the scanners.
const TRANSCRIPT_ROLE_SCAN_MAX_BYTES = 1024 * 1024;

function readHeadCapped(filePath: string, maxBytes: number = TRANSCRIPT_ROLE_SCAN_MAX_BYTES): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return bytesRead > 0 ? buffer.subarray(0, bytesRead).toString('utf8') : '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

export function readCodexSessionMetaIdentity(transcriptPath: unknown): CodexSessionMetaIdentity | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const line = readFirstLineCapped(transcriptPath).trim();
  if (!line) return null;
  try {
    return codexSessionMetaIdentityFromRecord(JSON.parse(line));
  } catch {
    return null;
  }
}
// Pull the text of a user-authored line from EITHER host transcript shape:
//   - Codex: { payload?: { type:'message', role:'user', content:[{type:'input_text',text}] } }
//   - Cursor: { role:'user', message:'<string>' }  (or message:{ content:'<string>'|[{text}] })
// Returns '' for non-user lines / unknown shapes. Cursor's subagent transcript is the
// {role, message} shape — parsing only the Codex shape returned null for every Cursor
// subagent, so the run-team gate could not resolve a Cursor role and hard-denied its
// writes (run-team-not-subagent). The `[t1-role: senior-X]` marker rides the spawn
// prompt, which lands as a user line on both hosts.
function userLineText(parsed: unknown): string {
  const o = obj(parsed) || {};
  const p = obj(o.payload) || o;
  // Codex shape.
  if (p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
    return (p.content as unknown[])
      .map((seg) => { const s = obj(seg); return s && s.type === 'input_text' && typeof s.text === 'string' ? s.text : ''; })
      .filter(Boolean)
      .join('\n');
  }
  // Cursor shape: top-level role + message (string, or {content:string|[{text}]}).
  if (o.role === 'user') {
    const m = o.message;
    if (typeof m === 'string') return m;
    const mo = obj(m);
    if (mo) {
      if (typeof mo.content === 'string') return mo.content;
      if (Array.isArray(mo.content)) {
        return (mo.content as unknown[])
          .map((seg) => { const s = obj(seg); return s && typeof s.text === 'string' ? s.text : ''; })
          .filter(Boolean)
          .join('\n');
      }
    }
  }
  return '';
}

export function inferRoleEvidenceFromTranscript(transcriptPath: unknown): RoleEvidenceResolution {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return { kind: 'none' };
  // Current Codex rollouts are decided from capped line zero when it carries role
  // evidence (task_name → agent_path). When line zero parses but names NO role —
  // a spawn issued without task_name leaves agent_path/agent_role null (observed
  // 13c-codex: the architect looped on "role not observable" and the whole team
  // was unusable) — recover the role from the SPAWN PROMPT: the FIRST readable
  // user record is plaintext in current child rollouts and, per the spawn
  // contract, carries a LINE-ANCHORED `[t1-role: …]` marker. Only that exact
  // shape is evidence here — a marker quoted mid-prose in inherited context or
  // any LATER user record never authenticates a role, and a line-zero role
  // CONFLICT stays terminal (prose must not outvote contradictory host identity).
  const currentCodexMeta = readCodexSessionMetaIdentity(transcriptPath);
  if (currentCodexMeta && currentCodexMeta.role.kind !== 'none') return currentCodexMeta.role;
  if (currentCodexMeta) {
    const head = readHeadCapped(transcriptPath);
    if (!head) return { kind: 'none' };
    let firstUserText = '';
    for (const line of head.split('\n')) {
      if (!line.includes('"user"')) continue; // cheap prefilter before JSON.parse
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const text = userLineText(parsed);
      if (text) {
        firstUserText = text;
        break;
      }
    }
    if (!firstUserText) return { kind: 'none' };
    const anchored: RoleEvidence[] = [];
    ROLE_MARKER_LINE_ANCHORED_RE.lastIndex = 0;
    for (let match = ROLE_MARKER_LINE_ANCHORED_RE.exec(firstUserText); match; match = ROLE_MARKER_LINE_ANCHORED_RE.exec(firstUserText)) {
      const candidate = roleCandidate(match[1], 'user-role-marker', 'explicit');
      if (candidate) anchored.push(candidate);
    }
    return resolveRoleCandidates(anchored);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return { kind: 'none' };
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
    const text = userLineText(parsed);
    if (text) userTexts.push(text);
  }

  const markerCandidates: RoleEvidence[] = [];
  for (const text of userTexts) {
    ROLE_MARKER_RE.lastIndex = 0;
    for (let match = ROLE_MARKER_RE.exec(text); match; match = ROLE_MARKER_RE.exec(text)) {
      const candidate = roleCandidate(match[1], 'user-role-marker', 'explicit');
      if (candidate) markerCandidates.push(candidate);
    }
  }
  const markerResolution = resolveRoleCandidates(markerCandidates);
  if (markerResolution.kind !== 'none') return markerResolution;

  const declarationCandidates: RoleEvidence[] = [];
  for (const text of userTexts) {
    for (const re of ROLE_DECLARATION_RES) {
      const match = text.match(re);
      const candidate = match ? roleCandidate(match[1], 'user-role-declaration', 'heuristic') : null;
      if (candidate) declarationCandidates.push(candidate);
    }
  }
  return resolveRoleCandidates(declarationCandidates);
}

export function inferRoleFromTranscript(transcriptPath: unknown): string | null {
  const resolution = inferRoleEvidenceFromTranscript(transcriptPath);
  return resolution && resolution.kind === 'evidence' ? resolution.evidence.role : null;
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
  // Claude agent-teams worker id (`agent_id`) — a STABLE per-worker key stamped on
  // every payload (unlike Codex, the transcript is the parent's). Null elsewhere.
  agentId: string | null;
  // The role the host declares via `agent_type` (agent-teams), canonicalized to a
  // Traffic One role; null when absent or not a role. Lets a team worker bind its
  // claim without transcript inference. See project_agent_teams_claim_deadlock.
  declaredRole: string | null;
  // Two role-bearing host identity fields named different valid roles. Generic
  // fields are filtered before this check; a real conflict must never fall
  // through to pending-claim correlation.
  declaredRoleConflict: boolean;
  // Best-effort model id from the hook payload. Cursor child writes can arrive
  // after multiple failed/retried Task spawns for the same role; matching by model
  // lets the binder consume the successful exact-slug pending claim instead of an
  // older family-alias claim that produced a visible "Couldn't start" card.
  model: string | null;
}

export function hookSessionIdentity(rawInput: unknown): SessionIdentity {
  const data = (rawInput && typeof rawInput === 'object'
    ? (rawInput as Rec)
    : parseJson<Rec>(typeof rawInput === 'string' ? rawInput : '', {}));
  const payload = obj(data.payload) || {};
  const topSource = obj(data.source);
  const payloadSource = obj(payload.source);
  const sourceCandidates = [topSource, payloadSource].filter((value): value is Rec => Boolean(value));
  const threadSpawnCandidates = [
    ...sourceCandidates.flatMap((source) => {
      const subagent = obj(source.subagent);
      return subagent ? [obj(subagent.thread_spawn), obj(subagent.threadSpawn)] : [];
    }),
    obj(nestedValue(data, ['subagent', 'thread_spawn'])),
    obj(nestedValue(data, ['subagent', 'threadSpawn'])),
    obj(nestedValue(payload, ['subagent', 'thread_spawn'])),
    obj(nestedValue(payload, ['subagent', 'threadSpawn'])),
  ].filter((value): value is Rec => Boolean(value));
  const threadSpawn = threadSpawnCandidates[0] || {};

  // Cursor usually sends session_id (== conversation_id), but some event shapes have
  // drifted across versions. Treat conversation_id as a fallback so child-session
  // writes can still bind their per-run role claim.
  const sessionId = firstString(
    data.session_id, data.sessionId, data.sessionID, data.id,
    payload.session_id, payload.sessionId, payload.id,
    data.conversation_id, data.conversationId, payload.conversation_id, payload.conversationId,
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
  // Claude agent-teams stamps the worker's stable id + role directly on every
  // payload (agent_id / agent_type) and sends NO parent_session_id, no `subagent`
  // block, and the PARENT's session_id/transcript. Read them so a team worker is
  // recognized as a subagent and its claim binds by agent_id.
  // Cursor's subagent-start payload carries the spawned id as `subagent_id`
  // (= tool_<uuid>) and the role as `subagent_type` (Claude uses agent_id/agent_type;
  // Codex carries neither). Read Cursor's spellings too so a Cursor subagent is
  // recognized as a subagent and its reuse id + role are captured.
  const agentId = firstString(data.agent_id, data.agentId, payload.agent_id, payload.agentId, data.subagent_id, payload.subagent_id);
  const declaredRoles = uniqueStrings([
    data.agent_type, data.agentType, payload.agent_type, payload.agentType,
    data.subagent_type, data.subagentType, payload.subagent_type, payload.subagentType,
    data.agent_role, data.agentRole, payload.agent_role, payload.agentRole,
    data.agent_path, data.agentPath, payload.agent_path, payload.agentPath,
    threadSpawn.agent_type, threadSpawn.agentType,
    threadSpawn.subagent_type, threadSpawn.subagentType,
    threadSpawn.agent_role, threadSpawn.agentRole,
    ...threadSpawnCandidates.flatMap((spawn) => [
      spawn.agent_type, spawn.agentType,
      spawn.subagent_type, spawn.subagentType,
      spawn.agent_role, spawn.agentRole,
      spawn.agent_path, spawn.agentPath,
    ]),
  ].map(normalizeRoleIdentity).filter((role): role is string => Boolean(role)));
  const declaredRole = declaredRoles.length === 1 ? declaredRoles[0]! : null;
  const declaredRoleConflict = declaredRoles.length > 1;
  const model = firstString(
    data.model, payload.model,
    data.subagent_model, data.subagentModel,
    payload.subagent_model, payload.subagentModel,
    nestedValue(data, ['tool_input', 'model']), nestedValue(data, ['toolInput', 'model']),
    nestedValue(payload, ['tool_input', 'model']), nestedValue(payload, ['toolInput', 'model']),
  );
  const isSubagent = Boolean(
    threadSource === 'subagent'
    || parentSessionId
    || (agentId && (declaredRole || declaredRoleConflict))
    || sourceCandidates.some((source) => Boolean(obj(source.subagent)))
    || nestedValue(data, ['subagent'])
    || nestedValue(payload, ['subagent']),
  );

  return {
    sessionId,
    parentSessionId,
    isSubagent,
    threadId,
    transcriptPath,
    agentId,
    declaredRole,
    declaredRoleConflict,
    model,
  };
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

function claimModel(claim: Rec): string | null {
  return firstString(claim.model);
}

function matchingPendingClaim(
  cwd: string,
  state: unknown,
  runId: string,
  role: string,
  parentSessionId: string | null,
  model: string | null = null,
): PendingClaim | null {
  const pending = listPendingClaims(cwd, runId)
    .filter(({ claim }) => claimAllowsState(state, claim))
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
function uniquelyCorrelatedPendingClaim(
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

function removePendingClaim(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // a leftover pending file is harmless; freshness expires it
  }
}

function removeSiblingPendingClaims(
  cwd: string,
  state: unknown,
  runId: string,
  role: string,
  parentSessionId: string | null,
  keepClaimId: string | null,
): void {
  if (!parentSessionId) return;
  const pending = listPendingClaims(cwd, runId)
    .filter(({ claim }) => claimAllowsState(state, claim))
    .filter(({ claim }) => claim.role === role)
    .filter(({ claim }) => claim.parentSessionId === parentSessionId)
    .filter(({ claim }) => !keepClaimId || claim.claimId !== keepClaimId);
  for (const item of pending) removePendingClaim(item.filePath);
}

// --- Cursor spawn observations ---------------------------------------------
//
// Cursor can emit `subagentStart` without ever emitting a matching Task result or
// subagentStop. Keep the immutable facts known at spawn time in a separate,
// run-scoped ledger so a later child transcript can be correlated even after the
// live-agent registry entry has been retired. Classification deliberately lives in
// the agent-model layer; this module only owns the one-to-one persistence
// primitives and accepts the classifier's eventual outcome/directive.

export const CURSOR_SPAWN_OBSERVATION_LIMIT = 128;

export type CursorSpawnObservationOutcome = 'api-limit' | 'model-unavailable' | 'generic';
export type CursorFollowupSuppressionReason =
  | 'stop-user-abort'
  | 'subagent-stop-user-abort'
  | 'subagent-stop-parent-user-abort'
  | 'parent-transcript-user-abort';

export interface CursorSpawnObservationInput {
  parentSessionId: string;
  toolCallId: string;
  role: string;
  requestedModel: string;
  tier: TierId;
  expectedModel: string;
  startedAtMs?: number;
}

export interface CursorSpawnObservation {
  parentSessionId: string;
  toolCallId: string;
  role: string;
  requestedModel: string;
  tier: TierId;
  expectedModel: string;
  startedAtMs: number;
  childTranscriptId: string | null;
  outcome: CursorSpawnObservationOutcome | null;
  error: string | null;
  directive: string | null;
  prescribedModel: string | null;
  followupEmitted: boolean;
  followupSuppressed: boolean;
  followupSuppressedAtMs: number | null;
  followupSuppressionReason: CursorFollowupSuppressionReason | null;
  retryHandled: boolean;
  claimedAtMs: number | null;
  consumedAtMs: number | null;
  updatedAtMs: number;
}

export interface CursorSpawnObservationUpdate {
  outcome?: CursorSpawnObservationOutcome | null;
  error?: string | null;
  directive?: string | null;
  prescribedModel?: string | null;
  followupEmitted?: boolean;
  retryHandled?: boolean;
}

// Snapshot produced by the agent-model selector immediately before a lifecycle
// continuation is claimed. `expectedLatest*` fingerprints the newest immutable
// SubagentStart for this parent+role, which may be a newer no-resume attempt the
// selector has already allowed to age past the 90/270-second liveness window.
// A start recorded after selection changes that fingerprint and invalidates the
// whole parent batch instead of letting concurrent Stop hooks split it.
export interface CursorFollowupClaimRequest {
  parentSessionId: string;
  expectedParentFingerprint: string;
  role: string;
  childTranscriptId: string;
  toolCallId: string;
  expectedLatestToolCallId: string;
  expectedLatestStartedAtMs: number;
  directive: string;
  prescribedModel: string | null;
}

export interface CursorParentObservationSnapshot {
  parentSessionId: string;
  fingerprint: string;
  observations: CursorSpawnObservation[];
}

export interface CursorParentFollowupSuppressionRequest {
  scope: 'parent';
  parentSessionId: string;
  observedAtMs: number;
  reason:
    | 'stop-user-abort'
    | 'subagent-stop-parent-user-abort'
    | 'parent-transcript-user-abort';
}

export interface CursorChildFollowupSuppressionRequest {
  scope: 'child';
  toolCallId: string;
  parentSessionId?: string;
  observedAtMs: number;
  reason: 'subagent-stop-user-abort';
}

export type CursorFollowupSuppressionRequest =
  | CursorParentFollowupSuppressionRequest
  | CursorChildFollowupSuppressionRequest;

interface CursorSpawnObservationStore {
  version: 1;
  observations: CursorSpawnObservation[];
}

const CURSOR_SPAWN_OUTCOMES: ReadonlySet<string> = new Set(['api-limit', 'model-unavailable', 'generic']);
const CURSOR_FOLLOWUP_SUPPRESSION_REASONS: ReadonlySet<string> = new Set([
  'stop-user-abort',
  'subagent-stop-user-abort',
  'subagent-stop-parent-user-abort',
  'parent-transcript-user-abort',
]);
const CURSOR_PARENT_FOLLOWUP_SUPPRESSION_REASONS: ReadonlySet<string> = new Set([
  'stop-user-abort',
  'subagent-stop-parent-user-abort',
  'parent-transcript-user-abort',
]);
const CURSOR_SPAWN_LOCK_TIMEOUT_MS = 2_000;
const CURSOR_SPAWN_LOCK_STALE_MS = 15_000;
const CURSOR_SPAWN_LOCK_RETRY_MS = 10;
const CURSOR_TRANSCRIPT_EARLY_TOLERANCE_MS = 1_500;
const CURSOR_SPAWN_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function cursorSpawnObservationFile(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'cursor-spawns.json');
}

function cursorSpawnObservationLockDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), '.cursor-spawns.lock');
}

function validCursorTranscriptId(value: unknown): string | null {
  const id = firstString(value);
  if (!id || id.includes('..') || /[\\/]/.test(id)) return null;
  return id.slice(0, 200);
}

function finiteMs(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function boundedCursorSpawnText(value: unknown, maxLength: number): string | null {
  const text = firstString(value);
  return text ? text.slice(0, maxLength) : null;
}

function normalizeCursorSpawnObservation(value: unknown): CursorSpawnObservation | null {
  const item = obj(value);
  if (!item) return null;
  const parentSessionId = firstString(item.parentSessionId, item.parent_session_id);
  const toolCallId = firstString(item.toolCallId, item.tool_call_id, item.observationId);
  const role = firstString(item.role);
  const requestedModel = firstString(item.requestedModel, item.requested_model, item.model);
  const expectedModel = firstString(item.expectedModel, item.expected_model, item.expected);
  const rawTier = firstString(item.tier);
  const tier = rawTier && (TIER_IDS as readonly string[]).includes(rawTier) ? rawTier as TierId : null;
  const startedAtMs = finiteMs(item.startedAtMs, item.started_at_ms, item.startedAt, item.createdAt);
  if (!parentSessionId || !toolCallId || !role || !VALID_AGENT_ROLES.has(role)
    || !requestedModel || !tier || !expectedModel || !startedAtMs) return null;

  const childTranscriptId = validCursorTranscriptId(item.childTranscriptId ?? item.child_transcript_id);
  const rawOutcome = firstString(item.outcome);
  const outcome = rawOutcome && CURSOR_SPAWN_OUTCOMES.has(rawOutcome)
    ? rawOutcome as CursorSpawnObservationOutcome
    : null;
  const error = boundedCursorSpawnText(item.error, 8_192);
  const directive = boundedCursorSpawnText(item.directive, 8_192);
  const prescribedModel = boundedCursorSpawnText(item.prescribedModel ?? item.prescribed_model, 300);
  const claimedAtMs = finiteMs(item.claimedAtMs, item.claimed_at_ms, item.claimedAt);
  const consumedAtMs = finiteMs(item.consumedAtMs, item.consumed_at_ms, item.consumedAt);
  const followupSuppressed = item.followupSuppressed === true || item.followup_suppressed === true;
  const rawSuppressionReason = firstString(item.followupSuppressionReason, item.followup_suppression_reason);
  const followupSuppressionReason = rawSuppressionReason
    && CURSOR_FOLLOWUP_SUPPRESSION_REASONS.has(rawSuppressionReason)
    ? rawSuppressionReason as CursorFollowupSuppressionReason
    : null;
  const followupSuppressedAtMs = followupSuppressed
    ? finiteMs(
      item.followupSuppressedAtMs,
      item.followup_suppressed_at_ms,
      item.followupSuppressedAt,
      item.followup_suppressed_at,
    )
    : null;
  const updatedAtMs = finiteMs(item.updatedAtMs, item.updated_at_ms, item.updatedAt)
    || followupSuppressedAtMs || consumedAtMs || claimedAtMs || startedAtMs;
  return {
    parentSessionId,
    toolCallId,
    role,
    requestedModel,
    tier,
    expectedModel,
    startedAtMs,
    childTranscriptId,
    outcome,
    error,
    directive,
    prescribedModel,
    followupEmitted: item.followupEmitted === true || item.followup_emitted === true,
    followupSuppressed,
    followupSuppressedAtMs: followupSuppressed ? (followupSuppressedAtMs || updatedAtMs) : null,
    followupSuppressionReason: followupSuppressed ? followupSuppressionReason : null,
    retryHandled: item.retryHandled === true || item.retry_handled === true,
    claimedAtMs,
    consumedAtMs,
    updatedAtMs,
  };
}

function readCursorSpawnObservationStore(cwd: string, runId: string): CursorSpawnObservationStore {
  const raw = readJson<unknown>(cursorSpawnObservationFile(cwd, runId), null);
  const record = obj(raw);
  // Tolerate the pre-versioned array and the early `spawns` key so an in-flight
  // run survives a plugin upgrade. Invalid/duplicate rows are ignored rather than
  // weakening the child-transcript one-to-one invariant.
  const values = Array.isArray(raw)
    ? raw
    : (Array.isArray(record?.observations) ? record.observations : (Array.isArray(record?.spawns) ? record.spawns : []));
  const seenTools = new Set<string>();
  const seenChildren = new Set<string>();
  const observations: CursorSpawnObservation[] = [];
  for (const value of values) {
    const observation = normalizeCursorSpawnObservation(value);
    if (!observation || seenTools.has(observation.toolCallId)) continue;
    if (observation.childTranscriptId && seenChildren.has(observation.childTranscriptId)) continue;
    seenTools.add(observation.toolCallId);
    if (observation.childTranscriptId) seenChildren.add(observation.childTranscriptId);
    observations.push(observation);
  }
  observations.sort((a, b) => a.startedAtMs - b.startedAtMs || a.toolCallId.localeCompare(b.toolCallId));
  return { version: 1, observations: observations.slice(-CURSOR_SPAWN_OBSERVATION_LIMIT) };
}

function cursorParentObservationFingerprint(
  observations: readonly CursorSpawnObservation[],
  parentSessionId: string,
): string {
  const rows = observations
    .filter((observation) => observation.parentSessionId === parentSessionId)
    .sort((left, right) => (
      left.startedAtMs - right.startedAtMs || left.toolCallId.localeCompare(right.toolCallId)
    ))
    .map((observation) => [
      observation.parentSessionId,
      observation.role,
      observation.toolCallId,
      observation.startedAtMs,
      observation.requestedModel,
      observation.tier,
      observation.expectedModel,
      observation.childTranscriptId,
      observation.claimedAtMs,
      observation.outcome,
      observation.error,
      observation.directive,
      observation.prescribedModel,
      observation.consumedAtMs,
      observation.followupEmitted,
      observation.followupSuppressed,
      observation.followupSuppressedAtMs,
      observation.followupSuppressionReason,
      observation.retryHandled,
    ]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function writeCursorSpawnObservationStore(cwd: string, runId: string, observations: CursorSpawnObservation[]): void {
  const store: CursorSpawnObservationStore = {
    version: 1,
    observations: [...observations]
      .sort((a, b) => a.startedAtMs - b.startedAtMs || a.toolCallId.localeCompare(b.toolCallId))
      .slice(-CURSOR_SPAWN_OBSERVATION_LIMIT),
  };
  writeJson(cursorSpawnObservationFile(cwd, runId), store);
}

function withCursorSpawnObservationLock<T>(cwd: string, runId: string, mutate: () => T): T | null {
  const lockDir = cursorSpawnObservationLockDir(cwd, runId);
  const deadline = Date.now() + CURSOR_SPAWN_LOCK_TIMEOUT_MS;
  try { fs.mkdirSync(path.dirname(lockDir), { recursive: true }); } catch { return null; }
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch {
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > CURSOR_SPAWN_LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) return null;
      Atomics.wait(CURSOR_SPAWN_LOCK_WAIT, 0, 0, CURSOR_SPAWN_LOCK_RETRY_MS);
    }
  }
  try {
    return mutate();
  } finally {
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

export function listCursorSpawnObservations(cwd: string, runId: string): CursorSpawnObservation[] {
  if (!runId || isNonProjectRoot(cwd)) return [];
  return readCursorSpawnObservationStore(cwd, runId).observations;
}

/**
 * One-read snapshot for a parent lifecycle pass. The caller derives its complete
 * role set and selection from these rows, then supplies the fingerprint to the
 * batch CAS. Any start/result/action transition after this read invalidates the
 * complete continuation instead of allowing a stale subset to be emitted.
 */
export function cursorParentObservationSnapshot(
  cwd: string,
  runId: string,
  parentSessionId: string,
): CursorParentObservationSnapshot | null {
  const parentId = firstString(parentSessionId);
  if (!runId || !parentId || isNonProjectRoot(cwd)) return null;
  const observations = readCursorSpawnObservationStore(cwd, runId).observations
    .filter((observation) => observation.parentSessionId === parentId)
    .map((observation) => ({ ...observation }));
  return {
    parentSessionId: parentId,
    fingerprint: cursorParentObservationFingerprint(observations, parentId),
    observations,
  };
}

// Record the facts known at subagentStart. A repeated tool-call id is idempotent
// and never rewrites the immutable spawn anchor, even if a later hook carries
// different metadata.
export function recordCursorSpawnObservation(
  cwd: string,
  runId: string,
  input: CursorSpawnObservationInput,
): CursorSpawnObservation | null {
  if (!runId || isNonProjectRoot(cwd)) return null;
  const startedAtMs = finiteMs(input.startedAtMs) || Date.now();
  const candidate = normalizeCursorSpawnObservation({
    ...input,
    startedAtMs,
    childTranscriptId: null,
    outcome: null,
    error: null,
    directive: null,
    prescribedModel: null,
    followupEmitted: false,
    followupSuppressed: false,
    followupSuppressedAtMs: null,
    followupSuppressionReason: null,
    retryHandled: false,
    claimedAtMs: null,
    consumedAtMs: null,
    updatedAtMs: startedAtMs,
  });
  if (!candidate) return null;
  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    const existing = store.observations.find((item) => item.toolCallId === candidate.toolCallId);
    if (existing) return existing;
    store.observations.push(candidate);
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return candidate;
  });
}

// Attach one child transcript to one spawn observation. Both directions are
// unique: a transcript can never be claimed by two starts, and a start can never
// be rebound to a different transcript. Repeating the same claim is idempotent.
export function claimCursorSpawnObservation(
  cwd: string,
  runId: string,
  toolCallId: string,
  childTranscriptId: string,
  nowMs: number = Date.now(),
): CursorSpawnObservation | null {
  const toolId = firstString(toolCallId);
  const childId = validCursorTranscriptId(childTranscriptId);
  if (!runId || !toolId || !childId || isNonProjectRoot(cwd)) return null;
  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    const target = store.observations.find((item) => item.toolCallId === toolId);
    if (!target) return null;
    const claimedElsewhere = store.observations.some((item) => (
      item.toolCallId !== toolId && item.childTranscriptId === childId
    ));
    if (claimedElsewhere || (target.childTranscriptId && target.childTranscriptId !== childId)) return null;
    if (target.childTranscriptId === childId) return target;
    target.childTranscriptId = childId;
    target.claimedAtMs = finiteMs(nowMs) || Date.now();
    target.updatedAtMs = target.claimedAtMs;
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return target;
  });
}

export function cursorSpawnObservationForChild(
  cwd: string,
  runId: string,
  childTranscriptId: string,
): CursorSpawnObservation | null {
  const childId = validCursorTranscriptId(childTranscriptId);
  if (!runId || !childId || isNonProjectRoot(cwd)) return null;
  return readCursorSpawnObservationStore(cwd, runId).observations
    .find((item) => item.childTranscriptId === childId) || null;
}

export function updateCursorSpawnObservation(
  cwd: string,
  runId: string,
  childTranscriptId: string,
  patch: CursorSpawnObservationUpdate,
  nowMs: number = Date.now(),
): CursorSpawnObservation | null {
  const childId = validCursorTranscriptId(childTranscriptId);
  if (!runId || !childId || isNonProjectRoot(cwd)) return null;
  if (patch.outcome !== undefined && patch.outcome !== null && !CURSOR_SPAWN_OUTCOMES.has(patch.outcome)) return null;
  if (patch.error !== undefined && patch.error !== null && typeof patch.error !== 'string') return null;
  if (patch.directive !== undefined && patch.directive !== null && typeof patch.directive !== 'string') return null;
  if (patch.prescribedModel !== undefined && patch.prescribedModel !== null && typeof patch.prescribedModel !== 'string') return null;
  if (patch.followupEmitted !== undefined && typeof patch.followupEmitted !== 'boolean') return null;
  if (patch.retryHandled !== undefined && typeof patch.retryHandled !== 'boolean') return null;
  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    const target = store.observations.find((item) => item.childTranscriptId === childId);
    if (!target) return null;
    if (patch.outcome !== undefined) target.outcome = patch.outcome;
    if (patch.error !== undefined) target.error = boundedCursorSpawnText(patch.error, 8_192);
    if (patch.directive !== undefined) target.directive = boundedCursorSpawnText(patch.directive, 8_192);
    if (patch.prescribedModel !== undefined) target.prescribedModel = boundedCursorSpawnText(patch.prescribedModel, 300);
    // Action ownership is monotonic. A generic patch may set the marker, but it
    // can never reopen a one-shot follow-up/retry already claimed by another hook.
    if (patch.followupEmitted === true) target.followupEmitted = true;
    if (patch.retryHandled === true) target.retryHandled = true;
    target.updatedAtMs = finiteMs(nowMs) || Date.now();
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return target;
  });
}

function cursorObservationComesAfter(
  left: CursorSpawnObservation,
  right: CursorSpawnObservation,
): boolean {
  return left.startedAtMs > right.startedAtMs
    || (left.startedAtMs === right.startedAtMs && left.toolCallId > right.toolCallId);
}

function latestCursorObservation(
  observations: readonly CursorSpawnObservation[],
  predicate: (observation: CursorSpawnObservation) => boolean,
): CursorSpawnObservation | null {
  let latest: CursorSpawnObservation | null = null;
  for (const observation of observations) {
    if (!predicate(observation)) continue;
    if (!latest || cursorObservationComesAfter(observation, latest)) latest = observation;
  }
  return latest;
}

function validCursorFollowupClaimRequest(request: CursorFollowupClaimRequest): boolean {
  return Boolean(
    firstString(request.parentSessionId)
    && /^[a-f0-9]{64}$/.test(request.expectedParentFingerprint)
    && firstString(request.toolCallId)
    && firstString(request.expectedLatestToolCallId)
    && VALID_AGENT_ROLES.has(request.role)
    && validCursorTranscriptId(request.childTranscriptId)
    && typeof request.expectedLatestStartedAtMs === 'number'
    && Number.isFinite(request.expectedLatestStartedAtMs)
    && request.expectedLatestStartedAtMs > 0
    && typeof request.directive === 'string'
    && request.directive.length > 0
    && request.directive.length <= 8_192
    && (request.prescribedModel === null
      || (typeof request.prescribedModel === 'string' && request.prescribedModel.length <= 300)),
  );
}

/**
 * Atomically owns one complete parent lifecycle continuation batch.
 *
 * The selector refreshes directives and computes liveness outside this lock,
 * then supplies an immutable fingerprint for each role. This function performs
 * no nested state calls: one unlocked store read, validation of the entire
 * batch, and one unlocked store write. Any stale row makes the whole batch lose
 * the CAS so concurrent Stop/subagentStop hooks can never partition roles.
 */
export function claimCursorFollowupsBatch(
  cwd: string,
  runId: string,
  requests: readonly CursorFollowupClaimRequest[],
  nowMs: number = Date.now(),
): CursorSpawnObservation[] {
  if (!runId || !requests.length || isNonProjectRoot(cwd)) return [];
  if (!requests.every(validCursorFollowupClaimRequest)) return [];
  const parentSessionId = requests[0]!.parentSessionId;
  if (requests.some((request) => request.parentSessionId !== parentSessionId)) return [];
  const expectedParentFingerprint = requests[0]!.expectedParentFingerprint;
  if (requests.some((request) => request.expectedParentFingerprint !== expectedParentFingerprint)) return [];
  if (new Set(requests.map((request) => request.role)).size !== requests.length) return [];
  if (new Set(requests.map((request) => request.childTranscriptId)).size !== requests.length) return [];
  const claimedAtMs = finiteMs(nowMs) || Date.now();

  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    if (cursorParentObservationFingerprint(store.observations, parentSessionId)
      !== expectedParentFingerprint) return [];
    const claimed: CursorSpawnObservation[] = [];

    for (const request of requests) {
      const target = store.observations.find((observation) => (
        observation.parentSessionId === request.parentSessionId
        && observation.role === request.role
        && observation.toolCallId === request.toolCallId
        && observation.childTranscriptId === request.childTranscriptId
      ));
      if (!target || !target.outcome || !target.consumedAtMs || !target.directive
        || target.retryHandled || target.followupEmitted || target.followupSuppressed
        || target.directive !== request.directive
        || target.prescribedModel !== request.prescribedModel) return [];

      const latestFinalized = latestCursorObservation(store.observations, (observation) => (
        observation.parentSessionId === request.parentSessionId
        && observation.role === request.role
        && observation.consumedAtMs !== null
      ));
      if (!latestFinalized || latestFinalized.toolCallId !== target.toolCallId
        || latestFinalized.childTranscriptId !== target.childTranscriptId) return [];

      const latest = latestCursorObservation(store.observations, (observation) => (
        observation.parentSessionId === request.parentSessionId
        && observation.role === request.role
      ));
      if (!latest || latest.toolCallId !== request.expectedLatestToolCallId
        || latest.startedAtMs !== request.expectedLatestStartedAtMs) return [];
      claimed.push(target);
    }

    for (const target of claimed) {
      target.followupEmitted = true;
      target.updatedAtMs = claimedAtMs;
    }
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return claimed.map((observation) => ({ ...observation }));
  }) || [];
}

function validCursorFollowupSuppressionRequest(request: CursorFollowupSuppressionRequest): boolean {
  if (!Number.isFinite(request.observedAtMs) || request.observedAtMs <= 0) return false;
  if (request.scope === 'child') {
    return request.reason === 'subagent-stop-user-abort'
      && Boolean(firstString(request.toolCallId))
      && (request.parentSessionId === undefined || Boolean(firstString(request.parentSessionId)));
  }
  return Boolean(firstString(request.parentSessionId))
    && CURSOR_PARENT_FOLLOWUP_SUPPRESSION_REASONS.has(request.reason);
}

/**
 * Durably suppress lifecycle continuation for observations that existed when a
 * user-abort signal was observed. Parent scope covers every pre-event row for
 * that parent; child scope is exact by immutable SubagentStart tool id. Future
 * starts are deliberately outside the observedAtMs watermark. First evidence
 * wins so duplicate lifecycle hooks cannot rewrite the audit reason/timestamp.
 */
export function suppressCursorFollowupsBatch(
  cwd: string,
  runId: string,
  request: CursorFollowupSuppressionRequest,
): CursorSpawnObservation[] {
  if (!runId || isNonProjectRoot(cwd) || !validCursorFollowupSuppressionRequest(request)) return [];
  const suppressedAtMs = request.observedAtMs;

  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    const changed = store.observations.filter((observation) => {
      if (observation.followupSuppressed || observation.startedAtMs > request.observedAtMs) return false;
      if (request.scope === 'child') {
        return observation.toolCallId === request.toolCallId
          && (!request.parentSessionId || observation.parentSessionId === request.parentSessionId);
      }
      return observation.parentSessionId === request.parentSessionId;
    });
    if (!changed.length) return [];
    for (const observation of changed) {
      observation.followupSuppressed = true;
      observation.followupSuppressedAtMs = suppressedAtMs;
      observation.followupSuppressionReason = request.reason;
      observation.updatedAtMs = suppressedAtMs;
    }
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return changed.map((observation) => ({ ...observation }));
  }) || [];
}

function markCursorSpawnObservationOnce(
  cwd: string,
  runId: string,
  childTranscriptId: string,
  field: 'followupEmitted' | 'retryHandled',
  nowMs: number,
): CursorSpawnObservation | null {
  const childId = validCursorTranscriptId(childTranscriptId);
  if (!runId || !childId || isNonProjectRoot(cwd)) return null;
  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    const target = store.observations.find((item) => item.childTranscriptId === childId);
    if (!target || target[field]
      || (field === 'followupEmitted' && (target.retryHandled || target.followupSuppressed))) return null;
    target[field] = true;
    target.updatedAtMs = finiteMs(nowMs) || Date.now();
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return target;
  });
}

// Atomic compare-and-set markers for hooks that may race. A null return means the
// transcript is unknown or another hook already owns the follow-up/retry action.
export function markCursorSpawnObservationFollowupEmitted(
  cwd: string,
  runId: string,
  childTranscriptId: string,
  nowMs: number = Date.now(),
): CursorSpawnObservation | null {
  return markCursorSpawnObservationOnce(cwd, runId, childTranscriptId, 'followupEmitted', nowMs);
}

export function markCursorSpawnObservationRetryHandled(
  cwd: string,
  runId: string,
  childTranscriptId: string,
  nowMs: number = Date.now(),
): CursorSpawnObservation | null {
  return markCursorSpawnObservationOnce(cwd, runId, childTranscriptId, 'retryHandled', nowMs);
}

export function consumeCursorSpawnObservation(
  cwd: string,
  runId: string,
  childTranscriptId: string,
  nowMs: number = Date.now(),
): CursorSpawnObservation | null {
  const childId = validCursorTranscriptId(childTranscriptId);
  if (!runId || !childId || isNonProjectRoot(cwd)) return null;
  return withCursorSpawnObservationLock(cwd, runId, () => {
    const store = readCursorSpawnObservationStore(cwd, runId);
    const target = store.observations.find((item) => item.childTranscriptId === childId);
    if (!target) return null;
    if (target.consumedAtMs) return target;
    target.consumedAtMs = finiteMs(nowMs) || Date.now();
    target.updatedAtMs = target.consumedAtMs;
    writeCursorSpawnObservationStore(cwd, runId, store.observations);
    return target;
  });
}

function cursorProjectsRoot(): string | null {
  const override = firstString(process.env.TRAFFIC_ONE_CURSOR_PROJECTS_DIR);
  if (override) return override;
  const home = firstString(process.env.HOME, os.homedir());
  return home ? path.join(home, '.cursor', 'projects') : null;
}

function cursorProjectDirNames(projectRoot: string): string[] {
  const roots: string[] = [projectRoot];
  try {
    const real = fs.realpathSync(projectRoot);
    if (real) roots.push(real);
  } catch {
    // best-effort; cwd may not exist in a unit test or after a deleted project
  }
  return uniqueStrings(roots.map((root) => {
    const normalized = path.resolve(root).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    return normalized.replace(/[/:\s]+/g, '-');
  }));
}

function workspaceRootsForCursorLookup(cwd: string, rawInput: unknown): string[] {
  const data = obj(rawInput) || {};
  const payload = obj(data.payload) || {};
  return uniqueStrings([
    cwd,
    ...stringValues(data.workspace_roots),
    ...stringValues(data.workspaceRoots),
    ...stringValues(payload.workspace_roots),
    ...stringValues(payload.workspaceRoots),
  ]);
}

export interface CursorTranscriptCandidate {
  filePath: string;
  parentSessionId: string;
  childTranscriptId: string;
  birthtimeMs: number;
  mtimeMs: number;
}

// Cursor appends to child transcripts, so mtime reflects the last write rather
// than the spawn. birthtime is the correlation anchor when the filesystem
// exposes it; mtime remains available (and is the fallback on filesystems whose
// birthtime is zero/invalid).
export function cursorTranscriptCandidateTimeMs(candidate: CursorTranscriptCandidate): number {
  return Number.isFinite(candidate.birthtimeMs) && candidate.birthtimeMs > 0
    ? candidate.birthtimeMs
    : candidate.mtimeMs;
}

function cursorTranscriptCandidate(
  filePath: string,
  parentSessionId: string,
  childTranscriptId: string,
): CursorTranscriptCandidate | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      filePath,
      parentSessionId,
      childTranscriptId,
      birthtimeMs: Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : 0,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

function sortCursorTranscriptCandidates(candidates: CursorTranscriptCandidate[]): CursorTranscriptCandidate[] {
  return candidates.sort((a, b) => (
    cursorTranscriptCandidateTimeMs(b) - cursorTranscriptCandidateTimeMs(a)
    || b.mtimeMs - a.mtimeMs
    || a.filePath.localeCompare(b.filePath)
  ));
}

function subagentTranscriptCandidates(projectDir: string, sessionId: string): CursorTranscriptCandidate[] {
  const out: CursorTranscriptCandidate[] = [];
  const agentTranscriptsDir = path.join(projectDir, 'agent-transcripts');
  try {
    for (const parent of fs.readdirSync(agentTranscriptsDir, { withFileTypes: true })) {
      if (!parent.isDirectory()) continue;
      const filePath = path.join(agentTranscriptsDir, parent.name, 'subagents', `${sessionId}.jsonl`);
      const candidate = cursorTranscriptCandidate(filePath, parent.name, sessionId);
      if (candidate) out.push(candidate);
    }
  } catch {
    // no Cursor transcript cache for this project
  }
  return out;
}

function allSubagentTranscriptCandidates(projectDir: string, parentSessionId?: string | null): CursorTranscriptCandidate[] {
  const out: CursorTranscriptCandidate[] = [];
  const agentTranscriptsDir = path.join(projectDir, 'agent-transcripts');
  try {
    for (const parent of fs.readdirSync(agentTranscriptsDir, { withFileTypes: true })) {
      if (!parent.isDirectory()) continue;
      if (parentSessionId && parent.name !== parentSessionId) continue;
      const dir = path.join(agentTranscriptsDir, parent.name, 'subagents');
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const filePath = path.join(dir, entry.name);
        const childTranscriptId = entry.name.slice(0, -'.jsonl'.length);
        const candidate = cursorTranscriptCandidate(filePath, parent.name, childTranscriptId);
        if (candidate) out.push(candidate);
      }
    }
  } catch {
    // no Cursor transcript cache for this project
  }
  return out;
}

// List Cursor CHILD transcripts for the current workspace (optionally one parent
// session). The traversal is intentionally rooted at `subagents/`; it never reads
// or returns the parent `<session>.jsonl`, whose terminal error can be an unrelated
// "User aborted request". Paths are de-duplicated because workspace_roots can name
// the same project through both a symlink and its real path.
export function listCursorSubagentTranscriptCandidates(
  cwd: string,
  rawInput: unknown,
  parentSessionId?: string | null,
): CursorTranscriptCandidate[] {
  if (isNonProjectRoot(cwd)) return [];
  const root = cursorProjectsRoot();
  if (!root) return [];

  const projectRoots = workspaceRootsForCursorLookup(cwd, rawInput);
  const projectDirs: string[] = [];
  for (const projectRoot of projectRoots) {
    for (const dirName of cursorProjectDirNames(projectRoot)) {
      projectDirs.push(path.join(root, dirName));
    }
  }

  const candidates: CursorTranscriptCandidate[] = [];
  for (const projectDir of uniqueStrings(projectDirs)) {
    candidates.push(...allSubagentTranscriptCandidates(projectDir, parentSessionId));
  }

  // Cursor has changed project-key encoding before. Fall back to directories
  // ending in the workspace basename only when exact keys yield no candidates.
  if (candidates.length === 0) {
    const basenames = uniqueStrings(projectRoots.map((projectRoot) => path.basename(projectRoot)).filter(Boolean));
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!basenames.some((base) => entry.name === base || entry.name.endsWith(`-${base}`))) continue;
        candidates.push(...allSubagentTranscriptCandidates(path.join(root, entry.name), parentSessionId));
      }
    } catch {
      // no Cursor projects root
    }
  }

  const unique = new Map<string, CursorTranscriptCandidate>();
  for (const candidate of candidates) {
    const key = path.resolve(candidate.filePath);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return sortCursorTranscriptCandidates([...unique.values()]);
}

// Cursor child tool events currently report only the child conversation/session id
// and `transcript_path: null`. The role marker lives in Cursor's local child
// transcript at:
//   ~/.cursor/projects/<project-key>/agent-transcripts/<parent>/subagents/<child>.jsonl
// Locate that file so the normal transcript role-inference path can bind the child
// session instead of denying it as "main agent".
function cursorSubagentTranscript(cwd: string, rawInput: unknown, sessionId: string | null): CursorTranscriptCandidate | null {
  if (!sessionId || /[\\/]/.test(sessionId) || sessionId.includes('..')) return null;
  const root = cursorProjectsRoot();
  if (!root) return null;

  const projectRoots = workspaceRootsForCursorLookup(cwd, rawInput);
  const projectDirs: string[] = [];
  for (const projectRoot of projectRoots) {
    for (const dirName of cursorProjectDirNames(projectRoot)) {
      projectDirs.push(path.join(root, dirName));
    }
  }

  const candidates: CursorTranscriptCandidate[] = [];
  for (const projectDir of uniqueStrings(projectDirs)) {
    candidates.push(...subagentTranscriptCandidates(projectDir, sessionId));
  }

  // Encoding has changed before; if the exact project key misses, fall back to
  // project dirs that end with the workspace basename. The child session id still
  // has to match exactly, so this remains deterministic in normal Cursor caches.
  if (candidates.length === 0) {
    const basenames = uniqueStrings(projectRoots.map((projectRoot) => path.basename(projectRoot)).filter(Boolean));
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!basenames.some((base) => entry.name === base || entry.name.endsWith(`-${base}`))) continue;
        candidates.push(...subagentTranscriptCandidates(path.join(root, entry.name), sessionId));
      }
    } catch {
      // no Cursor projects root
    }
  }

  if (candidates.length === 0) return null;
  return sortCursorTranscriptCandidates(candidates)[0]!;
}

function cursorSubagentTranscriptsForRole(
  cwd: string,
  rawInput: unknown,
  role: string,
  parentSessionId?: string | null,
): CursorTranscriptCandidate[] {
  if (!VALID_AGENT_ROLES.has(role)) return [];
  return listCursorSubagentTranscriptCandidates(cwd, rawInput, parentSessionId)
    .filter((candidate) => inferRoleFromTranscript(candidate.filePath) === role)
    .sort((a, b) => cursorTranscriptCandidateTimeMs(b) - cursorTranscriptCandidateTimeMs(a));
}

function candidateThreadId(candidate: CursorTranscriptCandidate): string | null {
  return isResumeCapableAgentId(candidate.childTranscriptId) ? candidate.childTranscriptId : null;
}

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

function listClaimedAgents(cwd: string, runId: string): Rec[] {
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
function releaseSupersededRoleClaimsLocked(
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

function nextSpawnIndex(cwd: string, state: unknown, runId: string, role: string): number {
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

function withRunAgentClaimsLock(cwd: string, runId: string, mutate: () => void): boolean {
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
      stackFingerprint: stackFingerprint(source),
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
      stackFingerprint: stackFingerprint(source),
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

function annotateClaimRoleSource(
  cwd: string,
  runId: string,
  key: string,
  expected: Rec,
  evidence: RoleEvidence,
): Rec | null {
  if (expected.roleSource === evidence.source) return expected;
  let result: Rec | null = null;
  const locked = withRunAgentClaimsLock(cwd, runId, () => {
    const file = runAgentFile(cwd, runId, key);
    const current = readClaimFile(file);
    if (!current || current.role !== expected.role || current.claimId !== expected.claimId) return;
    const source = strongestRoleSource(evidence.source, current.roleSource);
    const next = source === current.roleSource ? current : { ...current, roleSource: source };
    try {
      if (next !== current) writeJson(file, next);
      result = next;
    } catch {
      result = null;
    }
  });
  return locked ? result : null;
}

export function resolveRunAgentContext(
  cwd: string,
  state: unknown,
  rawInput: unknown,
  options: { claimPending?: boolean; allowSoleAnonymousPending?: boolean; host?: string } = {},
): RunAgentContext | null {
  const identity = hookSessionIdentity(rawInput);
  if (identity.declaredRoleConflict) return null;
  const hookCodexMeta = identity.transcriptPath
    ? readCodexSessionMetaIdentity(identity.transcriptPath)
    : null;
  if (hookCodexMeta?.role.kind === 'conflict') return null;
  const transcriptIdentifiesChild = Boolean(
    identity.threadId && identity.sessionId && identity.threadId !== identity.sessionId,
  );
  const effectiveParentSessionId = identity.parentSessionId
    || hookCodexMeta?.parentThreadId
    || (transcriptIdentifiesChild ? identity.sessionId : null);
  const effectiveIsSubagent = identity.isSubagent || transcriptIdentifiesChild;
  // Before any exact-claim reuse, first-write self-heal, or pending correlation,
  // bind the line-zero metadata to the hook's actual child and parent. A copied
  // rollout must not grant its authoritative role to another thread.
  if (hookCodexMeta?.threadId && identity.threadId
    && hookCodexMeta.threadId.toLowerCase() !== identity.threadId.toLowerCase()) return null;
  if (hookCodexMeta?.parentThreadId && effectiveParentSessionId
    && hookCodexMeta.parentThreadId !== effectiveParentSessionId) return null;
  if (identity.declaredRole
    && hookCodexMeta?.role.kind === 'evidence'
    && hookCodexMeta.role.evidence.source !== 'spawn-task-name'
    && hookCodexMeta.role.evidence.role !== identity.declaredRole) return null;
  const shouldClaimPending = options.claimPending !== false;
  const runIds = runIdsForLookup(cwd, state);
  const requiresCodexObservation = options.host === 'codex' || Boolean(hookCodexMeta?.parentThreadId);
  const codexChildIds = uniqueStrings([
    identity.agentId,
    identity.threadId,
    hookCodexMeta?.threadId,
    ...(identity.isSubagent ? [identity.sessionId] : []),
  ].filter((value): value is string => Boolean(value)));
  const verifiedCodexObservation = (runId: string, role?: string | null): CodexModelObservation | null => {
    if (!requiresCodexObservation) return null;
    const observed = readCodexModelObservation(cwd, runId, codexChildIds);
    if (!observed
      || observed.status !== 'verified'
      || !observed.actualModel
      || (role && observed.role !== role)
      || (identity.model && observed.actualModel !== identity.model)
      || (hookCodexMeta?.threadId && observed.childId.toLowerCase() !== hookCodexMeta.threadId.toLowerCase())
      || (hookCodexMeta?.parentThreadId && observed.parentSessionId
        && observed.parentSessionId !== hookCodexMeta.parentThreadId)) return null;
    return observed;
  };

  // Exact claim match. agentId (Claude agent-teams) is the most specific key, then
  // threadId (from transcript_path, the reliable Codex key — a subagent's tool-call
  // hook reports the parent's session_id), then session_id (per-thread id on Claude).
  const exactKeys = [identity.agentId, identity.threadId, identity.sessionId].filter((v): v is string => Boolean(v));
  for (const runId of runIds) {
    for (const key of exactKeys) {
      // A crash may leave the claim already corrected while exact-holder or
      // pending cleanup is incomplete. Gate every exact reuse (including hosts
      // with no transcript) on durable transaction replay before returning it.
      const replay = replayAuthoritativeRebindJournal(cwd, state, runId, key);
      if (replay.status === 'blocked') return null;
      const claim = replay.status === 'complete'
        ? replay.claim
        : readClaimFile(runAgentFile(cwd, runId, key));
      if (claim && claimAllowsState(state, claim)) {
        let observed = requiresCodexObservation
          ? verifiedCodexObservation(runId, typeof claim.role === 'string' ? claim.role : null)
          : null;
        if (requiresCodexObservation && !observed) {
          const authoritativeRole = hookCodexMeta?.role.kind === 'evidence'
            ? hookCodexMeta.role.evidence.role
            : null;
          if (!authoritativeRole) return null;
          const existing = readCodexModelObservation(cwd, runId, codexChildIds);
          // A provisional SubagentStart role may have classified the immutable
          // model as a mismatch. Line-zero Codex session metadata is the one
          // correction-grade signal allowed to re-evaluate that same model.
          // Conflict remains terminal in correctCodexChildObservationRole.
          if (!existing || existing.status === 'conflict') return null;
          observed = correctCodexChildObservationRole(cwd, runId, existing.childId, authoritativeRole);
          if (!observed || observed.status !== 'verified' || observed.actualModel !== existing.actualModel) return null;
        }
        // Legacy Codex claims can carry the wrong role while remaining fresh. When
        // this exact hook supplies the child rollout, inspect ONLY line zero
        // (session_meta). Prompt/tool content is never consulted for correction.
        if (identity.transcriptPath && identity.threadId === key) {
          const meta = readCodexSessionMetaIdentity(identity.transcriptPath);
          if (meta && meta.role.kind === 'conflict') return null;
          if (meta && meta.role.kind === 'evidence') {
            if (meta.threadId && meta.threadId.toLowerCase() !== key.toLowerCase()) return null;
            if (meta.parentThreadId && identity.sessionId && meta.parentThreadId !== identity.sessionId) return null;
            if (claim.role !== meta.role.evidence.role) {
              return authoritativeRebindThreadRole(cwd, state, runId, key, claim, meta.role.evidence, {
                transcriptPath: identity.transcriptPath,
                parentSessionId: meta.parentThreadId || identity.sessionId,
                model: observed?.actualModel || identity.model,
              });
            }
            const annotated = annotateClaimRoleSource(cwd, runId, key, claim, meta.role.evidence);
            return annotated ? contextFromClaim(annotated, 'run-agent') : null;
          }
        }
        return contextFromClaim(claim, 'run-agent');
      }
    }
  }

  // Claude agent-teams self-heal: the worker stamps its role (agent_type) + stable
  // id (agent_id) on the payload but provides no per-thread transcript, so the
  // transcript-inference path below never sees it. Bind the claim keyed by agent_id
  // with the declared role — no inference needed. This is what unblocks team
  // workers' feature-source writes (see project_agent_teams_claim_deadlock).
  if (shouldClaimPending && identity.agentId && identity.declaredRole) {
    const runId = runIds[0] || '';
    const observed = requiresCodexObservation ? verifiedCodexObservation(runId, identity.declaredRole) : null;
    if (requiresCodexObservation && !observed) return null;
    const ctx = claimThreadRole(cwd, state, identity.agentId, identity.declaredRole, {
      parentSessionId: identity.sessionId,
      model: observed?.actualModel || identity.model,
      evidence: { role: identity.declaredRole, source: 'host-declared-role', authority: 'authoritative' },
    });
    if (ctx) return ctx;
  }

  // Hosts with a per-child session id can bind the same authoritative role
  // without a separate agent_id. Keep this behind an explicit subagent signal
  // so a parent spawn payload can never claim its own session.
  if (shouldClaimPending && !identity.agentId && identity.isSubagent && identity.declaredRole) {
    const declaredThreadId = identity.threadId || identity.sessionId;
    const declaredParentId = identity.threadId && identity.sessionId && identity.threadId !== identity.sessionId
      ? identity.sessionId
      : identity.parentSessionId;
    if (declaredThreadId) {
      const runId = runIds[0] || '';
      const observed = requiresCodexObservation ? verifiedCodexObservation(runId, identity.declaredRole) : null;
      if (requiresCodexObservation && !observed) return null;
      const ctx = claimThreadRole(cwd, state, declaredThreadId, identity.declaredRole, {
        parentSessionId: declaredParentId || effectiveParentSessionId,
        model: observed?.actualModel || identity.model,
        transcriptPath: identity.transcriptPath,
        evidence: { role: identity.declaredRole, source: 'host-declared-role', authority: 'authoritative' },
      });
      if (ctx) return ctx;
    }
  }

  // Codex/Cursor self-heal: a subagent thread with no claim yet can still bind from
  // its own transcript. Codex sends transcript_path directly; Cursor child writes
  // omit it, so we locate the child transcript by conversation/session id.
  const cursorTranscript = shouldClaimPending && !identity.transcriptPath && identity.sessionId
    ? cursorSubagentTranscript(cwd, rawInput, identity.sessionId)
    : null;
  const cursorTranscriptPath = cursorTranscript ? cursorTranscript.filePath : null;
  const inferenceTranscriptPath = identity.transcriptPath || cursorTranscriptPath;
  const inferredResolution = shouldClaimPending && inferenceTranscriptPath
    ? inferRoleEvidenceFromTranscript(inferenceTranscriptPath)
    : { kind: 'none' } as RoleEvidenceResolution;
  const inferredEvidence = inferredResolution.kind === 'evidence' ? inferredResolution.evidence : null;
  const inferredRole = inferredEvidence?.role || null;
  const inferredThreadId = identity.threadId && identity.sessionId && identity.threadId !== identity.sessionId
    ? identity.threadId
    : (cursorTranscriptPath && identity.sessionId ? identity.sessionId : null);
  if (shouldClaimPending && inferredThreadId && inferredRole) {
    const runId = runIds[0] || '';
    const observed = requiresCodexObservation ? verifiedCodexObservation(runId, inferredRole) : null;
    if (requiresCodexObservation && !observed) return null;
    const parentSessionId = effectiveParentSessionId || cursorTranscript?.parentSessionId || null;
    const ctx = claimThreadRole(cwd, state, inferredThreadId, inferredRole, {
      parentSessionId,
      model: observed?.actualModel || identity.model,
      transcriptPath: inferenceTranscriptPath,
      evidence: inferredEvidence || undefined,
    });
    if (ctx) return ctx;
  }

  if (shouldClaimPending && effectiveIsSubagent && inferredResolution.kind !== 'conflict') {
    if (requiresCodexObservation) return null;
    for (const runId of runIds) {
      // When the thread's transcript reveals its role, never claim a different
      // role's pending file: parallel fix-cycle workers spawn near-simultaneously
      // and FIFO matching hands the frontend worker the backend claim (observed
      // live — the misclaimed worker then fails every scope check and the run
      // deadlocks until the orchestrator improvises).
      const pending = listPendingClaims(cwd, runId)
        .filter(({ claim }) => claimAllowsState(state, claim));
      const matched = inferredRole
        ? matchingPendingClaim(cwd, state, runId, inferredRole, effectiveParentSessionId, identity.model)
        : uniquelyCorrelatedPendingClaim(pending, effectiveParentSessionId, identity.model);
      if (!matched) continue;

      // Key the claimed file by the PER-THREAD id when we have one. On Codex,
      // identity.sessionId is the parent's session for every worker thread — using
      // it as the key made all parallel workers collide on one claim file (each
      // overwrite re-pointed every worker's resolution at the last-claimed role).
      const sessionId = identity.threadId || identity.sessionId || (matched.claim.sessionId as string) || (matched.claim.claimId as string);
      let claimed: Rec | null = null;
      const claimedUnderLock = withRunAgentClaimsLock(cwd, runId, () => {
        const currentPending = readClaimFile(matched.filePath);
        if (!currentPending
          || currentPending.claimId !== matched.claim.claimId
          || currentPending.role !== matched.claim.role
          || !claimAllowsState(state, currentPending)) return;
        const existingThreadClaim = readClaimFile(runAgentFile(cwd, runId, sessionId));
        if (existingThreadClaim && claimAllowsState(state, existingThreadClaim)) return;
        const ledger = ensureRunLedger(cwd, runId, {
          status: 'active',
          kind: 'agent-claim',
          stackFingerprint: stackFingerprint(state),
        });
        if (ledger?.status !== 'active') return;
        claimed = {
          ...currentPending,
          status: 'claimed',
          sessionId,
          parentSessionId: effectiveParentSessionId || currentPending.parentSessionId || null,
          claimedAt: stateTimestamp(),
          roleSource: strongestRoleSource(inferredEvidence?.source, currentPending.roleSource) || 'pending-correlation',
          transcriptPath: inferenceTranscriptPath || null,
        };
        fs.mkdirSync(runDir(cwd, runId), { recursive: true });
        writeJson(runAgentFile(cwd, runId, sessionId), claimed);
        removePendingClaim(matched.filePath);
        removeSiblingPendingClaims(
          cwd, state, runId, String(claimed!.role || ''),
          claimed!.parentSessionId as string | null,
          claimed!.claimId as string | null,
        );
        releaseSupersededRoleClaimsLocked(
          cwd, runId, String(claimed!.role || ''), sessionId, String(claimed!.claimId || ''),
        );
      });
      if (claimedUnderLock && claimed) return contextFromClaim(claimed, 'run-agent');
    }
  }

  // Devin Local's native PreToolUse payload currently contains no session,
  // parent, transcript, or subagent marker. `run_subagent` is foreground-only:
  // while it is running the parent is suspended, so one fresh pending claim is
  // unambiguously the active child. Keep the pending file in place so every
  // subsequent child write resolves the same role; PostToolUse owns completion.
  // This fallback is opt-in because it would be unsafe on hosts with background
  // or parallel anonymous workers.
  if (shouldClaimPending && options.allowSoleAnonymousPending && exactKeys.length === 0) {
    const pending = runIds
      .flatMap((runId) => listPendingClaims(cwd, runId))
      .filter(({ claim }) => claimAllowsState(state, claim));
    if (pending.length === 1) return contextFromClaim(pending[0]!.claim, 'sole-foreground-pending');
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
  options: {
    parentSessionId?: string | null;
    recordAgent?: boolean;
    model?: string | null;
    transcriptPath?: string | null;
    evidence?: RoleEvidence;
    /** Verified child binds must never replace another live thread for this role. */
    refuseOccupiedRole?: boolean;
  } = {},
): RunAgentContext | null {
  if (!VALID_AGENT_ROLES.has(role)) return null;
  if (typeof threadId !== 'string' || !threadId.trim()) return null;
  if (isNonProjectRoot(cwd)) return null; // never claim runs in the plugin's own repo
  const id = threadId.trim();
  const source: Rec = obj(state) ? { ...(state as Rec) } : {};
  // Same serialized-mint fallback as ensureRunAgentClaim (13c-codex sibling mints).
  const runId = typeof source.currentRunId === 'string' && source.currentRunId
    ? source.currentRunId
    : ensureCurrentRunId(cwd, state);
  if (!source.currentRunId) source.currentRunId = runId;
  const parentSessionId = firstString(options.parentSessionId);
  const model = firstString(options.model);
  const transcriptPath = firstString(options.transcriptPath);
  const evidence = options.evidence && options.evidence.role === role ? options.evidence : null;
  let claim: Rec | null = null;
  let rebindExpected: Rec | null = null;
  let created = false;
  const replay = replayAuthoritativeRebindJournal(cwd, state, runId, id);
  if (replay.status === 'blocked') return null;
  const locked = withRunAgentClaimsLock(cwd, runId, () => {
    const existing = readClaimFile(runAgentFile(cwd, runId, id));
    if (existing && claimAllowsState(state, existing)) {
      if (existing.role !== role) {
        if (isCorrectionGradeEvidence(evidence, existing.roleSource)) rebindExpected = existing;
        return;
      }
      // A released-but-fresh claim for THIS thread means the agent resumed after
      // an interrupt sweep: reactivate it in place (metadata intact) instead of
      // handing back a claim whose status contradicts the live agent. Only while
      // the run ledger is still active — never fight terminal settlement.
      const reclaiming = existing.status === 'released'
        && runLedgerStatusRecord(cwd, runId).status === 'active'
        // An explicitly retired claim must not come back while the parent is
        // replacing it, and an older thread must never displace a replacement
        // that already owns the live role slot.
        && !roleRegistryDisownsClaim(cwd, runId, role, existing)
        && !activeClaimForOtherThread(cwd, source, runId, role, id);
      // Released claims remain useful for read-only identity resolution, but a
      // SubagentStart bind may return one only after it was safely reactivated.
      // Otherwise the retired thread would keep receiving write authority even
      // though another thread owns this role.
      if (existing.status === 'released' && !reclaiming) return;
      const nextSource = strongestRoleSource(evidence?.source, existing.roleSource);
      const reactivatedAt = reclaiming ? stateTimestamp() : '';
      const next: Rec = {
        ...existing,
        ...(nextSource ? { roleSource: nextSource } : {}),
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(reclaiming ? {
          status: 'claimed',
          createdAt: reactivatedAt,
          claimedAt: reactivatedAt,
        } : {}),
      };
      if (reclaiming) {
        delete next.releasedAt;
        delete next.releasedReason;
      }
      if (reclaiming || nextSource !== existing.roleSource || (transcriptPath && transcriptPath !== existing.transcriptPath)) {
        try { writeJson(runAgentFile(cwd, runId, id), next); } catch { return; }
      }
      removeSiblingPendingClaims(
        cwd, source, runId, role,
        parentSessionId || firstString(existing.parentSessionId),
        firstString(existing.claimId),
      );
      claim = next;
      return;
    }

    if (options.refuseOccupiedRole
      && activeClaimForOtherThread(cwd, source, runId, role, id)) return;

    const ledger = ensureRunLedger(cwd, runId, {
      status: 'active',
      kind: 'agent-claim',
      stackFingerprint: stackFingerprint(source),
    });
    if (ledger?.status !== 'active') return;

    const pending = matchingPendingClaim(cwd, source, runId, role, parentSessionId, model);
    // Re-claim of THIS same thread after its earlier claim was released or aged
    // stale (interrupt/resume): the resume hook payload often carries no model,
    // so without the prior record the rebuilt claim forgets what the agent runs
    // on (observed live: model "opus" → null across a sleep interrupt).
    const prior = existing && existing.role === role ? existing : null;
    const spawnIndex = pending && typeof pending.claim.spawnIndex === 'number'
      ? pending.claim.spawnIndex
      : nextSpawnIndex(cwd, source, runId, role);
    const now = stateTimestamp();
    claim = {
      ...(pending ? pending.claim : {}),
      version: pending && typeof pending.claim.version === 'number' ? pending.claim.version : 1,
      runId: pending && typeof pending.claim.runId === 'string' ? pending.claim.runId : runId,
      claimId: pending && typeof pending.claim.claimId === 'string' ? pending.claim.claimId : `${role}-${spawnIndex}-${id.slice(-8)}`,
      role,
      spawnIndex,
      status: 'claimed',
      sessionId: id,
      parentSessionId: parentSessionId
        || (pending && typeof pending.claim.parentSessionId === 'string' ? pending.claim.parentSessionId : null)
        || (prior && typeof prior.parentSessionId === 'string' ? prior.parentSessionId : null),
      // createdAt stays fresh — claimAllowsState gates resolution on it; the
      // prior lineage is preserved in previousClaimId below instead.
      createdAt: pending && typeof pending.claim.createdAt === 'string' ? pending.claim.createdAt : now,
      claimedAt: now,
      stackFingerprint: pending && typeof pending.claim.stackFingerprint === 'string' ? pending.claim.stackFingerprint : stackFingerprint(source),
      model: model
        || (pending && typeof pending.claim.model === 'string' ? pending.claim.model : null)
        || (prior && typeof prior.model === 'string' ? prior.model : null),
      roleSource: strongestRoleSource(evidence?.source, pending?.claim.roleSource ?? prior?.roleSource) || 'explicit-bind',
      transcriptPath: transcriptPath
        || (pending && typeof pending.claim.transcriptPath === 'string' ? pending.claim.transcriptPath : null)
        || (prior && typeof prior.transcriptPath === 'string' ? prior.transcriptPath : null),
      ...(prior && typeof prior.claimId === 'string' ? { previousClaimId: prior.claimId } : {}),
    };
    fs.mkdirSync(runDir(cwd, runId), { recursive: true });
    writeJson(runAgentFile(cwd, runId, id), claim);
    if (pending) removePendingClaim(pending.filePath);
    removeSiblingPendingClaims(cwd, source, runId, role, claim!.parentSessionId as string | null, claim!.claimId as string | null);
    releaseSupersededRoleClaimsLocked(cwd, runId, role, id, String(claim!.claimId || ''));
    created = true;
  });
  if (!locked) return null;
  const expectedForRebind = rebindExpected as Rec | null;
  if (expectedForRebind && isCorrectionGradeEvidence(evidence, expectedForRebind.roleSource)) {
    return authoritativeRebindThreadRole(cwd, state, runId, id, expectedForRebind, evidence, {
      parentSessionId,
      model,
      transcriptPath,
    });
  }
  const boundClaim = claim as Rec | null;
  if (!boundClaim) return null;
  // Mirror the bind into the role-keyed reuse registry (agents.json), so the spawn
  // dedup gate sees a LIVE agent for the role and routes the next same-role task to
  // the host's continuation primitive — one agent per role instead of a fresh rule-reloading
  // spawn. Only the host's spawn-result recorder ran before, which never fires for
  // hosts that bind here (Codex SubagentStart; Claude agent-teams, whose workers
  // carry agent_id/agent_type but no separately-recorded spawn result). Gated on
  // continuation (the registry is dead weight without it) and best-effort.
  if (created && options.recordAgent !== false && subagentContinuationAvailable()) {
    recordRunAgent(cwd, runId, role, {
      agentId: id,
      parentSessionId,
      model: boundClaim.model as string | null,
      roleSource: boundClaim.roleSource as string | null,
      transcriptPath: boundClaim.transcriptPath as string | null,
    });
  }
  // Deliberately NOT writeState() here. Parallel subagents self-heal their claims
  // near-simultaneously on their first writes, and writeState does a non-atomic
  // read-modify-rewrite of the shared .one.json — concurrent calls would clobber it.
  // The per-thread claim file written above is the source of truth, and
  // runIdsForLookup() scans the runs/ dir on disk, so resolution needs no
  // currentRunId/spawnIndex stamp (the orchestrator already stamps currentRunId
  // during onboarding; nextSpawnIndex counts claim files on disk).
  return contextFromClaim(boundClaim, 'subagent-start');
}

function strictPendingForRoleRebind(
  cwd: string,
  state: unknown,
  runId: string,
  role: string,
  parentSessionId: string | null,
  model: string | null,
): { match: PendingClaim | null; ambiguous: boolean } {
  if (!parentSessionId || !model) return { match: null, ambiguous: false };
  const matches = listPendingClaims(cwd, runId)
    .filter(({ claim }) => claimAllowsState(state, claim))
    .filter(({ claim }) => claim.role === role)
    .filter(({ claim }) => claim.parentSessionId === parentSessionId)
    .filter(({ claim }) => claimModel(claim) === model);
  return matches.length === 1
    ? { match: matches[0]!, ambiguous: false }
    : { match: null, ambiguous: matches.length > 1 };
}

function activeClaimForOtherThread(
  cwd: string,
  state: unknown,
  runId: string,
  role: string,
  threadId: string,
): Rec | null {
  return listClaimedAgents(cwd, runId).find((claim) => (
    claimAllowsState(state, claim)
    && claim.status !== 'released'
    && claim.role === role
    && firstString(claim.sessionId) !== threadId
    // The parent-side replacement gate marks an exhausted/dead role in the
    // reuse registry before it starts the replacement child. That durable,
    // id-correlated marker is the authority to retire the old claim; freshness
    // alone cannot distinguish a just-crashed child from a live sibling. Keep
    // refusing an unmarked duplicate, but do not let the old claim deadlock the
    // verified replacement's SubagentStart bind.
    && !roleRegistryDisownsClaim(cwd, runId, role, claim)
  )) || null;
}

// The role registry is the durable ownership lineage when an interrupt sweep
// releases every claim file. A matching `replaced` entry retires that claim;
// once the replacement is recorded, its live entry also disowns every older
// same-role claim. Conversely, a replaced entry for the OLD agent must not
// reject the not-yet-recorded replacement whose id differs.
function roleRegistryDisownsClaim(
  cwd: string,
  runId: string,
  role: string,
  claim: Rec,
): boolean {
  const registry = obj(readJson(agentRegistryFile(cwd, runId), null));
  const entry = obj(obj(registry?.agents)?.[role]);
  if (!entry) return false;
  const sessionId = firstString(claim.sessionId);
  if (!sessionId) return false;
  const registryOwnsClaim = idsForRunAgent(entry).includes(sessionId);
  return registryOwnsClaim ? entry.replaced === true : entry.replaced !== true;
}

// A child whose observed model terminally conflicts with the immutable run
// policy can never act again — every tool call is denied. On hosts whose spawn
// results bind via SubagentStart (Codex), nothing ever set the registry's
// `replaced` marker for such a child, so the role slot stayed occupied and the
// parent's FRESH policy-compliant replacement was refused as a duplicate
// (observed 8c-codex: reviewer stranded after a followup model drift, all
// respawn paths dead-ended). Durably disown the dead child here — the existing
// machinery (activeClaimForOtherThread → roleRegistryDisownsClaim) then lets
// exactly the next verified same-role child claim the slot, and the recorder
// preserves this lineage in registry history. Only the entry actually owned by
// one of the given thread ids is marked; a live replacement is never touched.
export function disownConflictedRoleAgent(
  cwd: string,
  runId: string,
  role: string,
  threadIds: readonly string[],
  reason: string,
): boolean {
  if (!VALID_AGENT_ROLES.has(role) || !runId) return false;
  const ids = threadIds.map((id) => String(id || '').trim()).filter(Boolean);
  if (ids.length === 0) return false;
  let disowned = false;
  withAgentRegistryLock(cwd, runId, () => {
    const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
    const agents = obj(registry.agents) || {};
    const entry = obj(agents[role]);
    if (!entry) return;
    const entryIds = idsForRunAgent(entry);
    if (!ids.some((id) => entryIds.includes(id))) return;
    if (entry.replaced === true) {
      disowned = true;
      return;
    }
    agents[role] = {
      ...entry,
      replaced: true,
      replacedAt: stateTimestamp(),
      replacementReason: reason,
    };
    try {
      fs.mkdirSync(runDir(cwd, runId), { recursive: true });
      writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents });
      disowned = true;
    } catch {
      // best-effort: the deny still blocks the dead child; the parent can retry
    }
  });
  return disowned;
}

const AUTHORITATIVE_REBIND_JOURNAL_MAX_BYTES = 32 * 1024;
const AUTHORITATIVE_REBIND_PENDING_LIMIT = 8;

interface AuthoritativeRebindJournal {
  version: 1;
  kind: 'authoritative-role-rebind';
  runId: string;
  threadId: string;
  oldRole: string;
  targetRole: string;
  sourceClaimId: string;
  sourceClaimWasPresent: boolean;
  targetClaimId: string;
  targetClaim: Rec;
  registryEntry: Rec;
  pendingClaimIds: string[];
  createdAt: string;
}

type AuthoritativeRebindReplay =
  | { status: 'none' }
  | { status: 'complete'; claim: Rec }
  | { status: 'blocked' };

function boundedRebindRegistryEntry(entry: Rec, threadId: string): Rec {
  return {
    agentId: threadId,
    resumeId: firstString(entry.resumeId),
    toolCallId: firstString(entry.toolCallId),
    model: firstString(entry.model),
    agentType: firstString(entry.agentType),
    parentSessionId: firstString(entry.parentSessionId),
    recordedAt: firstString(entry.recordedAt) || stateTimestamp(),
    tasks: typeof entry.tasks === 'number' && Number.isInteger(entry.tasks) && entry.tasks > 0
      ? Math.min(entry.tasks, 1_000_000)
      : 1,
    replaced: false,
    roleSource: firstString(entry.roleSource),
    transcriptPath: firstString(entry.transcriptPath),
  };
}

function boundedRebindTargetClaim(claim: Rec, runId: string, threadId: string, targetRole: string): Rec {
  return {
    version: typeof claim.version === 'number' ? claim.version : 1,
    runId,
    claimId: firstString(claim.claimId),
    role: targetRole,
    spawnIndex: typeof claim.spawnIndex === 'number' && Number.isInteger(claim.spawnIndex) && claim.spawnIndex > 0
      ? claim.spawnIndex
      : 1,
    status: 'claimed',
    sessionId: threadId,
    parentSessionId: firstString(claim.parentSessionId),
    createdAt: firstString(claim.createdAt) || stateTimestamp(),
    claimedAt: firstString(claim.claimedAt) || stateTimestamp(),
    stackFingerprint: firstString(claim.stackFingerprint),
    toolName: firstString(claim.toolName),
    agentType: firstString(claim.agentType),
    model: firstString(claim.model),
    roleSource: firstString(claim.roleSource),
    transcriptPath: firstString(claim.transcriptPath),
    correctedAt: firstString(claim.correctedAt),
    correctedFromRole: firstString(claim.correctedFromRole),
  };
}

function readAuthoritativeRebindJournal(
  cwd: string,
  runId: string,
  threadId: string,
): AuthoritativeRebindJournal | null {
  const file = authoritativeRebindJournalFile(cwd, runId, threadId);
  try {
    if (fs.statSync(file).size > AUTHORITATIVE_REBIND_JOURNAL_MAX_BYTES) return null;
  } catch {
    return null;
  }
  const raw = obj(readJson(file, null));
  const registryEntry = obj(raw?.registryEntry);
  const targetClaim = obj(raw?.targetClaim);
  const oldRole = firstString(raw?.oldRole);
  const targetRole = firstString(raw?.targetRole);
  const sourceClaimId = firstString(raw?.sourceClaimId);
  const targetClaimId = firstString(raw?.targetClaimId);
  const storedThreadId = firstString(raw?.threadId);
  const storedRunId = firstString(raw?.runId);
  const pendingRaw = Array.isArray(raw?.pendingClaimIds) ? raw.pendingClaimIds : [];
  if (!raw
    || raw.version !== 1
    || raw.kind !== 'authoritative-role-rebind'
    || storedRunId !== runId
    || storedThreadId !== threadId
    || !oldRole || !VALID_AGENT_ROLES.has(oldRole)
    || !targetRole || !VALID_AGENT_ROLES.has(targetRole) || targetRole === oldRole
    || !sourceClaimId || !targetClaimId
    || !targetClaim
    || firstString(targetClaim.runId) !== runId
    || firstString(targetClaim.sessionId) !== threadId
    || firstString(targetClaim.role) !== targetRole
    || firstString(targetClaim.claimId) !== targetClaimId
    || !registryEntry || firstString(registryEntry.agentId) !== threadId
    || pendingRaw.length > AUTHORITATIVE_REBIND_PENDING_LIMIT
    || pendingRaw.some((value) => typeof value !== 'string' || !value.trim())) return null;
  return {
    version: 1,
    kind: 'authoritative-role-rebind',
    runId,
    threadId,
    oldRole,
    targetRole,
    sourceClaimId,
    sourceClaimWasPresent: raw.sourceClaimWasPresent === true,
    targetClaimId,
    targetClaim: boundedRebindTargetClaim(targetClaim, runId, threadId, targetRole),
    registryEntry: boundedRebindRegistryEntry(registryEntry, threadId),
    pendingClaimIds: uniqueStrings(pendingRaw.map((value) => String(value).trim()))
      .slice(0, AUTHORITATIVE_REBIND_PENDING_LIMIT),
    createdAt: firstString(raw.createdAt) || stateTimestamp(),
  };
}

function removePendingClaimsByIdUnlocked(
  cwd: string,
  runId: string,
  claimIds: readonly string[],
): boolean {
  for (const claimId of new Set(claimIds.filter(Boolean))) {
    const file = path.join(pendingDir(cwd, runId), `${safePathSegment(claimId)}.json`);
    if (!fs.existsSync(file)) continue;
    const claim = readClaimFile(file);
    // The filename and payload form the pending-claim CAS. If either cannot be
    // verified, retain the journal instead of declaring cleanup complete.
    if (!claim || firstString(claim.claimId) !== claimId) return false;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      return false;
    }
  }
  return true;
}

function completeAuthoritativeRebindJournalUnlocked(
  cwd: string,
  state: unknown,
  journal: AuthoritativeRebindJournal,
): AuthoritativeRebindReplay {
  const claimFile = runAgentFile(cwd, journal.runId, journal.threadId);
  const currentClaim = readClaimFile(claimFile);
  const currentClaimSessionId = firstString(currentClaim?.sessionId);
  const currentClaimThreadMatches = !currentClaimSessionId || currentClaimSessionId === journal.threadId;
  const targetClaimMatches = Boolean(
    currentClaim
    && firstString(currentClaim.runId) === journal.runId
    && currentClaimThreadMatches
    && firstString(currentClaim.role) === journal.targetRole
    && firstString(currentClaim.claimId) === journal.targetClaimId,
  );
  const sourceClaimMatches = Boolean(
    currentClaim
    && firstString(currentClaim.runId) === journal.runId
    && currentClaimThreadMatches
    && firstString(currentClaim.role) === journal.oldRole
    && firstString(currentClaim.claimId) === journal.sourceClaimId,
  );
  if (!targetClaimMatches && !sourceClaimMatches
    && (currentClaim || journal.sourceClaimWasPresent)) return { status: 'blocked' };

  const registryFile = agentRegistryFile(cwd, journal.runId);
  const registry = obj(readJson(registryFile, null)) || {};
  const agents = obj(registry.agents) || {};
  const targetEntry = obj(agents[journal.targetRole]);
  const targetMatches = Boolean(targetEntry && idsForRunAgent(targetEntry).includes(journal.threadId));
  if ((targetEntry && !targetMatches)
    || activeClaimForOtherThread(cwd, state, journal.runId, journal.targetRole, journal.threadId)) {
    return { status: 'blocked' };
  }

  const oldEntry = obj(agents[journal.oldRole]);
  const oldMatches = Boolean(oldEntry && idsForRunAgent(oldEntry).includes(journal.threadId));
  // A registry-only repair may legitimately start without a claim, but it must
  // still retain one exact registry identity as its source CAS until the target
  // claim is durable. Never invent both sides from an orphaned journal.
  if (!targetClaimMatches && !sourceClaimMatches && !oldMatches && !targetMatches) {
    return { status: 'blocked' };
  }

  if (!targetClaimMatches) {
    try {
      fs.mkdirSync(runDir(cwd, journal.runId), { recursive: true });
      writeJson(claimFile, journal.targetClaim);
    } catch {
      return { status: 'blocked' };
    }
  }

  let registryDirty = false;
  if (oldMatches) {
    delete agents[journal.oldRole];
    registryDirty = true;
  }
  if (!targetMatches) {
    agents[journal.targetRole] = journal.registryEntry;
    registryDirty = true;
  }
  if (registryDirty) {
    const history = Array.isArray(registry.history)
      ? registry.history.filter((item) => item && typeof item === 'object')
      : [];
    const alreadyRecorded = history.some((item) => {
      const record = obj(item);
      return record?.replacementReason === 'authoritative-role-rebind'
        && record.agentId === journal.threadId
        && record.oldRole === journal.oldRole
        && record.role === journal.targetRole;
    });
    if (!alreadyRecorded) {
      history.push({
        role: journal.targetRole,
        oldRole: journal.oldRole,
        agentId: journal.threadId,
        correctedAt: journal.createdAt,
        replacementReason: 'authoritative-role-rebind',
      });
    }
    try {
      writeJson(registryFile, {
        ...registry,
        version: 1,
        agents,
        history: history.slice(-100),
      });
    } catch {
      return { status: 'blocked' };
    }
  }

  const released = releaseFallbackClaimsForHolderUnlocked(cwd, journal.runId, journal.threadId);
  if (!released.ok) return { status: 'blocked' };
  if (!removePendingClaimsByIdUnlocked(cwd, journal.runId, journal.pendingClaimIds)) {
    return { status: 'blocked' };
  }
  try {
    fs.rmSync(authoritativeRebindJournalFile(cwd, journal.runId, journal.threadId), { force: true });
  } catch {
    return { status: 'blocked' };
  }
  const correctedClaim = readClaimFile(claimFile);
  return correctedClaim
    ? { status: 'complete', claim: correctedClaim }
    : { status: 'blocked' };
}

function replayAuthoritativeRebindJournal(
  cwd: string,
  state: unknown,
  runId: string,
  threadId: string,
): AuthoritativeRebindReplay {
  const journalFile = authoritativeRebindJournalFile(cwd, runId, threadId);
  if (!fs.existsSync(journalFile)) return { status: 'none' };
  let result: AuthoritativeRebindReplay = { status: 'blocked' };
  const identityLocked = withRunAgentClaimsLock(cwd, runId, () => {
    const registryLocked = withAgentRegistryLock(cwd, runId, () => {
      const fallbackLocked = withFallbackClaimsLock(cwd, runId, () => {
        if (!fs.existsSync(journalFile)) {
          result = { status: 'none' };
          return;
        }
        const journal = readAuthoritativeRebindJournal(cwd, runId, threadId);
        result = journal
          ? completeAuthoritativeRebindJournalUnlocked(cwd, state, journal)
          : { status: 'blocked' };
      });
      if (!fallbackLocked) result = { status: 'blocked' };
    });
    if (!registryLocked) result = { status: 'blocked' };
  });
  return identityLocked ? result : { status: 'blocked' };
}

function authoritativeRebindThreadRole(
  cwd: string,
  state: unknown,
  runId: string,
  threadId: string,
  expectedClaim: Rec,
  evidence: RoleEvidence,
  options: {
    parentSessionId?: string | null;
    model?: string | null;
    transcriptPath?: string | null;
    expectedRegistryRole?: string | null;
    expectedRegistryIds?: string[];
  } = {},
): RunAgentContext | null {
  if (!VALID_AGENT_ROLES.has(evidence.role)) return null;
  const targetRole = evidence.role;
  const claimRole = firstString(expectedClaim.role);
  const expectedRegistryRole = firstString(options.expectedRegistryRole);
  // A crash can occur after the claim was corrected but before the registry row
  // was re-keyed. Finishing that exact, stamped transaction is convergence, not
  // a second same-tier correction: the claim already carries this role/source
  // and records the registry role it was corrected from.
  const convergesInterruptedCorrection = Boolean(
    evidence.authority === 'authoritative'
    && claimRole === targetRole
    && expectedRegistryRole
    && firstString(expectedClaim.correctedFromRole) === expectedRegistryRole
    && firstString(expectedClaim.roleSource) === evidence.source,
  );
  if (!convergesInterruptedCorrection
    && !isCorrectionGradeEvidence(evidence, expectedClaim.roleSource)) return null;
  const oldRole = claimRole && claimRole !== targetRole
    ? claimRole
    : (expectedRegistryRole && expectedRegistryRole !== targetRole ? expectedRegistryRole : null);
  if (!oldRole) return null;
  const id = threadId.trim();
  const parentSessionId = firstString(options.parentSessionId, expectedClaim.parentSessionId);
  const model = firstString(options.model, expectedClaim.model);
  const transcriptPath = firstString(options.transcriptPath, expectedClaim.transcriptPath);
  let corrected: Rec | null = null;

  // Canonical mutation order: identity claim -> role registry -> fallback path
  // claims. Every other claim mutation uses the first lock only, so no caller can
  // overwrite a corrected claim from a stale pre-rebind snapshot.
  const identityLocked = withRunAgentClaimsLock(cwd, runId, () => {
    const registryLocked = withAgentRegistryLock(cwd, runId, () => {
      const claimsLocked = withFallbackClaimsLock(cwd, runId, () => {
      const claimFile = runAgentFile(cwd, runId, id);
      const current = readClaimFile(claimFile);
      const base = current || expectedClaim;
      if (current && expectedClaim.claimId && current.claimId !== expectedClaim.claimId) return;
      if (current && current.role !== oldRole && current.role !== targetRole) return;

      const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
      const agents = obj(registry.agents) || {};
      const history = Array.isArray(registry.history)
        ? registry.history.filter((item) => item && typeof item === 'object')
        : [];
      const conflicts = Array.isArray(registry.conflicts)
        ? registry.conflicts.filter((item) => item && typeof item === 'object')
        : [];
      if (options.expectedRegistryRole) {
        const inspected = obj(agents[options.expectedRegistryRole]);
        const expectedIds = new Set(options.expectedRegistryIds || [id]);
        if (!inspected || !idsForRunAgent(inspected).some((candidate) => expectedIds.has(candidate))) return;
      }
      const oldEntry = obj(agents[oldRole]);
      const oldEntryMatches = Boolean(oldEntry && idsForRunAgent(oldEntry).includes(id));
      // Registry-only legacy repair must CAS the exact inspected row. A child-hook
      // correction may legitimately have a claim but no registry row yet; however,
      // a newer row under the old role is never overwritten or re-keyed.
      if (!current && !oldEntryMatches) return;
      const targetEntry = obj(agents[targetRole]);
      const targetIds = idsForRunAgent(targetEntry);
      const targetParentMatches = !targetEntry
        || !parentSessionId
        || !firstString(targetEntry.parentSessionId)
        || firstString(targetEntry.parentSessionId) === parentSessionId;
      const targetIsLive = Boolean(
        targetEntry
        && targetEntry.replaced !== true
        && targetParentMatches
        && isFreshTimestamp(targetEntry.recordedAt, SUBAGENT_STALE_MS),
      );
      const occupiedTarget = targetIsLive && !targetIds.includes(id);
      const otherClaim = activeClaimForOtherThread(cwd, state, runId, targetRole, id);
      const pending = strictPendingForRoleRebind(cwd, state, runId, targetRole, parentSessionId, model);
      if (occupiedTarget || otherClaim || pending.ambiguous) {
        conflicts.push({
          role: targetRole,
          conflictingRole: oldRole,
          rejectedAgentId: id,
          conflictingAgentId: occupiedTarget ? firstString(targetEntry?.agentId) : firstString(otherClaim?.sessionId),
          recordedAt: stateTimestamp(),
          reason: pending.ambiguous
            ? 'authoritative-role-rebind-ambiguous-pending'
            : 'authoritative-role-rebind-target-occupied',
        });
        try {
          writeJson(agentRegistryFile(cwd, runId), {
            ...registry,
            version: 1,
            agents,
            history: history.slice(-100),
            conflicts: conflicts.slice(-50),
          });
        } catch {
          // best-effort conflict diagnostic
        }
        return;
      }

      const claimAlreadyCorrected = current?.role === targetRole;
      const matchingPending = claimAlreadyCorrected ? null : pending.match;
      const spawnIndex = claimAlreadyCorrected && typeof current.spawnIndex === 'number'
        ? current.spawnIndex
        : (matchingPending && typeof matchingPending.claim.spawnIndex === 'number'
          ? matchingPending.claim.spawnIndex
          : nextSpawnIndex(cwd, state, runId, targetRole));
      const claimId = claimAlreadyCorrected && typeof current.claimId === 'string'
        ? current.claimId
        : (matchingPending && typeof matchingPending.claim.claimId === 'string'
          ? matchingPending.claim.claimId
          : `${targetRole}-${spawnIndex}-${id.slice(-8)}`);
      const now = stateTimestamp();
      const nextClaim: Rec = {
        ...base,
        version: typeof base.version === 'number' ? base.version : 1,
        runId,
        claimId,
        role: targetRole,
        spawnIndex,
        status: 'claimed',
        sessionId: id,
        parentSessionId,
        createdAt: typeof base.createdAt === 'string' ? base.createdAt : now,
        claimedAt: typeof base.claimedAt === 'string' ? base.claimedAt : now,
        stackFingerprint: typeof base.stackFingerprint === 'string' ? base.stackFingerprint : stackFingerprint(state),
        model,
        roleSource: evidence.source,
        transcriptPath,
        correctedAt: firstString(base.correctedAt, now),
        correctedFromRole: firstString(base.correctedFromRole, oldRole),
      };

      const sourceEntry = oldEntryMatches ? oldEntry : null;
      const preserved = sourceEntry || (targetEntry && targetIds.includes(id) ? targetEntry : null) || {};
      const nextEntry: Rec = {
        ...preserved,
        agentId: id,
        resumeId: firstString(preserved.resumeId),
        toolCallId: firstString(preserved.toolCallId),
        model: firstString(preserved.model, model),
        agentType: firstString(preserved.agentType),
        parentSessionId: firstString(parentSessionId, preserved.parentSessionId),
        recordedAt: firstString(preserved.recordedAt, base.createdAt, now) || now,
        tasks: typeof preserved.tasks === 'number' && preserved.tasks > 0 ? preserved.tasks : 1,
        replaced: false,
        roleSource: evidence.source,
        transcriptPath,
      };
      const sourceClaimId = firstString(expectedClaim.claimId, base.claimId);
      if (!sourceClaimId) return;
      const journal: AuthoritativeRebindJournal = {
        version: 1,
        kind: 'authoritative-role-rebind',
        runId,
        threadId: id,
        oldRole,
        targetRole,
        sourceClaimId,
        sourceClaimWasPresent: Boolean(current),
        targetClaimId: claimId,
        targetClaim: boundedRebindTargetClaim(nextClaim, runId, id, targetRole),
        registryEntry: boundedRebindRegistryEntry(nextEntry, id),
        pendingClaimIds: uniqueStrings([
          firstString(matchingPending?.claim.claimId),
          firstString(base.claimId),
        ].filter((value): value is string => Boolean(value)))
          .slice(0, AUTHORITATIVE_REBIND_PENDING_LIMIT),
        createdAt: now,
      };
      // `writeJson` emits pretty JSON. Refuse the correction before its first
      // mutation when the durable transaction would exceed replay's hard cap;
      // never write a journal that the next process must reject as malformed.
      if (Buffer.byteLength(`${JSON.stringify(journal, null, 2)}\n`, 'utf8')
        > AUTHORITATIVE_REBIND_JOURNAL_MAX_BYTES) return;
      try {
        writeJson(authoritativeRebindJournalFile(cwd, runId, id), journal);
      } catch {
        return;
      }
      const completed = completeAuthoritativeRebindJournalUnlocked(cwd, state, journal);
      if (completed.status === 'complete') corrected = completed.claim;
      });
      if (!claimsLocked) corrected = null;
    });
    if (!registryLocked) corrected = null;
  });
  if (!identityLocked || !corrected) return null;
  return contextFromClaim(corrected, 'authoritative-role-rebind');
}

export function hasRunAgentState(cwd: string, state: unknown): boolean {
  const s = obj(state);
  const runId = s && typeof s.currentRunId === 'string' ? s.currentRunId : null;
  if (!runId) return false;
  if (listPendingClaims(cwd, runId).length > 0) return true;
  if (listClaimedAgents(cwd, runId).length > 0) return true;
  if (fs.existsSync(assignmentsFile(cwd, runId))) return true;
  const registry = obj(readJson(agentRegistryFile(cwd, runId), null));
  const agents = registry ? obj(registry.agents) : null;
  return Boolean(agents && Object.keys(agents).length > 0);
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
    if (listClaimedAgents(cwd, runId).some((claim) => (
      claim.status !== 'released'
      && isFreshTimestamp(claim.createdAt, SUBAGENT_STALE_MS)
      && afterWatermark(claim)
    ))) return true;
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
  const assignmentObject = obj(raw.assignments);
  if (assignmentObject) {
    const entries: unknown[] = [];
    for (const [role, value] of Object.entries(assignmentObject)) {
      const v = obj(value);
      if (!v) continue;
      const scope = obj(v.scope);
      const include = stringArray(scope?.include).length
        ? stringArray(scope?.include)
        : (stringArray(v.writeScope).length ? stringArray(v.writeScope) : stringArray(v.include));
      const exclude = stringArray(scope?.exclude).length ? stringArray(scope?.exclude) : stringArray(v.exclude);
      entries.push({
        role,
        summary: typeof v.description === 'string' ? v.description : (typeof v.summary === 'string' ? v.summary : undefined),
        scope: exclude.length ? { include, exclude } : { include },
      });
    }
    return entries;
  }
  const roles = obj(raw.roles);
  if (!roles) return [];
  const entries: unknown[] = [];
  for (const [role, value] of Object.entries(roles)) {
    const v = obj(value);
    if (!v) continue;
    const scope = obj(v.scope);
    const include = stringArray(v.ownedPaths).length
      ? stringArray(v.ownedPaths)
      : (stringArray(scope?.include).length ? stringArray(scope?.include) : stringArray(v.include));
    const exclude = stringArray(v.readOnlyPaths).length
      ? stringArray(v.readOnlyPaths)
      : (stringArray(scope?.exclude).length ? stringArray(scope?.exclude) : stringArray(v.exclude));
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
    if (name.startsWith('senior-')) return '';
    try {
      return fs.readFileSync(path.join(digestDir(cwd, runId), `senior-${name}`), 'utf8');
    } catch {
      return '';
    }
  }
}

function digestFile(cwd: string, runId: string, name: string): string | null {
  const direct = path.join(digestDir(cwd, runId), name);
  try {
    if (fs.statSync(direct).isFile()) return direct;
  } catch {
    // Try the legacy senior-* filename below.
  }
  if (name.startsWith('senior-')) return null;
  const legacy = path.join(digestDir(cwd, runId), `senior-${name}`);
  try {
    return fs.statSync(legacy).isFile() ? legacy : null;
  } catch {
    return null;
  }
}

function dirHasAnyFile(dir: string, suffixes: readonly string[]): boolean {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory() && dirHasAnyFile(p, suffixes)) return true;
      if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function runCreatedAtMs(cwd: string, runId: string): number {
  const rec = obj(readJson(runLedgerFile(cwd, runId), null));
  const raw = rec && typeof rec.createdAt === 'string' ? rec.createdAt : '';
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

// Strict QA evidence is scoped to the latest contract activation, not merely to
// the run's original creation. Resuming a blocked run or upgrading an active
// legacy run advances this watermark so a report from the previous attempt can
// never become green evidence in the resumed attempt.
function runQaContractActivatedAtMs(cwd: string, runId: string): number {
  const rec = obj(readJson(runLedgerFile(cwd, runId), null));
  const candidates = [rec?.createdAt, rec?.qaContractActivatedAt]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

function runUsesStrictQaContract(cwd: string, runId: string): boolean {
  const rec = obj(readJson(runLedgerFile(cwd, runId), null));
  return rec?.qaContractVersion === 1;
}

function canonicalQaReportRaw(cwd: string, runId: string): Rec | null {
  const memoryDir = '.traffic' + '-one';
  return obj(readJson(path.join(cwd, memoryDir, 'reports', 'qa', safePathSegment(runId), 'report.json'), null));
}

function strictQaReportResult(cwd: string, runId: string): QaReportValidationResult {
  const activatedAtMs = runQaContractActivatedAtMs(cwd, runId);
  let frontendDigestMtimeMs = 0;
  const frontendFile = digestFile(cwd, runId, 'frontend.md');
  if (frontendFile) {
    try { frontendDigestMtimeMs = Math.floor(fs.statSync(frontendFile).mtimeMs); } catch { /* missing digest */ }
  }
  const freshnessFloorMs = Math.max(activatedAtMs, frontendDigestMtimeMs);
  return readQaReportV1(cwd, runId, {
    ...(freshnessFloorMs > 0 ? { minimumGeneratedAtMs: freshnessFloorMs } : {}),
  });
}

export function runHasExplicitBlockedQaOutcome(cwd: string, runId: unknown): boolean {
  if (typeof runId !== 'string' || !runId) return false;
  if (runUsesStrictQaContract(cwd, runId)) {
    const result = strictQaReportResult(cwd, runId);
    return !result.ok
      && result.report !== undefined
      && typeof result.status === 'string'
      && /^blocked:(?:browser-unavailable|sandbox|usage-limit|timeout)$/.test(result.status);
  }
  const tester = readDigest(cwd, runId, 'tester.md');
  if (/\bblocked:(?:browser-unavailable|sandbox|usage-limit|timeout)\b/i.test(tester)) return true;
  const raw = canonicalQaReportRaw(cwd, runId);
  return typeof raw?.status === 'string'
    && /^blocked:(?:browser-unavailable|sandbox|usage-limit|timeout)$/.test(raw.status);
}

// Browser-unavailable is recoverable by the parent-browser bridge and must keep
// the run active. The other validated blocker classes require user-visible
// environment settlement. Legacy/raw reports cannot qualify for the bridge.
export function runHasEnvironmentBlockedQaOutcome(cwd: string, runId: unknown): boolean {
  if (typeof runId !== 'string' || !runId) return false;
  if (!runUsesStrictQaContract(cwd, runId)) return runHasExplicitBlockedQaOutcome(cwd, runId);
  const result = strictQaReportResult(cwd, runId);
  return !result.ok
    && result.report !== undefined
    && typeof result.status === 'string'
    && /^blocked:(?:browser-unavailable|sandbox|usage-limit|timeout)$/.test(result.status)
    && !isQaBrowserBridgeEligible(result);
}

function dirHasFreshFile(dir: string, suffixes: readonly string[], minMtimeMs: number): boolean {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory() && dirHasFreshFile(p, suffixes, minMtimeMs)) return true;
      if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
        if (minMtimeMs <= 0) return true;
        try {
          if (fs.statSync(p).mtimeMs + 1000 >= minMtimeMs) return true;
        } catch {
          // ignore unreadable candidates
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

function runHasQaEvidence(cwd: string, runId: string): boolean {
  // An explicit environment/browser blocker always wins, including for a run
  // that otherwise qualifies for the backend-only exemption.
  if (runHasExplicitBlockedQaOutcome(cwd, runId)) return false;
  // Backend-only is an exact per-run property: the current run has no frontend
  // implementer digest. Project stack detection and prose N/A claims cannot exempt
  // a run after the frontend implementer has emitted its digest.
  if (!readDigest(cwd, runId, 'frontend.md').trim()) return true;
  if (runUsesStrictQaContract(cwd, runId)) {
    const result = strictQaReportResult(cwd, runId);
    if (!result.ok) return false;
    // Every report is provisional until the tester role re-emits its canonical
    // verdict after the report. This covers both a tester-authored matrix and a
    // parent-browser replacement, and prevents a stale digest/report pairing
    // after a same-run implementation fix.
    const testerFile = digestFile(cwd, runId, 'tester.md');
    if (!testerFile) return false;
    try {
      const testerMtimeMs = Math.floor(fs.statSync(testerFile).mtimeMs);
      const reportMtimeMs = Math.floor(fs.statSync(result.reportPath).mtimeMs);
      // The canonical file write-time establishes whether the tester re-attested
      // after this report. generatedAt is already validated for freshness, but
      // may legitimately be a few milliseconds ahead of the filesystem clock.
      return testerMtimeMs >= reportMtimeMs;
    } catch {
      return false;
    }
  }

  // Pre-contract ledgers keep their historical artifact behavior for compatibility,
  // except that an explicit structured/digest blocker can never be interpreted as
  // passing evidence.
  const memoryDir = '.traffic' + '-one';
  const qaDir = path.join(cwd, memoryDir, 'reports', 'qa', safePathSegment(runId));
  if (fs.existsSync(path.join(qaDir, 'report.json'))) return true;
  if (dirHasAnyFile(qaDir, ['.png', '.jpg', '.jpeg', '.webp', '.json'])) return true;
  const lighthouseDir = path.join(cwd, memoryDir, 'reports', 'lighthouse');
  if (dirHasFreshFile(lighthouseDir, ['.json', '.html'], runCreatedAtMs(cwd, runId))) return true;
  return false;
}

function runLedgerStatusRecord(cwd: string, runId: string): {
  status: RunLedgerStatus | null;
  outcome: RunLedgerOutcome | null;
} {
  const ledger = obj(readJson(runLedgerFile(cwd, runId), null));
  return {
    status: isRunLedgerStatus(ledger?.status) ? ledger.status : null,
    outcome: isRunLedgerOutcome(ledger?.outcome) ? ledger.outcome : null,
  };
}

function shipperDigestCompleted(cwd: string, runId: string): boolean {
  const shipper = readDigest(cwd, runId, 'shipper.md');
  const shipped = /(?:^|\n)\s*(?:verdict\s*:\s*)?SHIPPED\s*(?:\r?\n|$)/im.test(shipper);
  const failed = /(?:^|\n)\s*(?:verdict\s*:\s*)?FAILED\s*(?:\r?\n|$)/im.test(shipper);
  return shipped && !failed;
}

function exactDigestVerdict(digest: string): string | null {
  const verdicts = [...digest.matchAll(/^\s*verdict\s*:\s*([A-Z][A-Z_-]*)\s*$/gim)]
    .map((match) => match[1]?.toUpperCase())
    .filter((verdict): verdict is string => typeof verdict === 'string');
  const firstVerdict = verdicts[0];
  if (!firstVerdict) return null;
  // Multiple identical lines are harmless, but conflicting machine verdicts fail
  // closed instead of letting prose order or a stale handoff line choose a winner.
  return verdicts.every((verdict) => verdict === firstVerdict) ? firstVerdict : null;
}

// True when run <runId>'s verification has TERMINALLY settled: a shipper digest
// (written only post-deploy, after reviewer+tester already passed) exists, OR
// reviewer PASSED and tester PASSED. The canonical tester token is `TESTS_GREEN`,
// but legacy orchestrators deviated (observed live: gpt-5.5 wrote the tester digest
// with `verdict: APPROVED`), so pre-contract runs retain that compatibility token.
// Contract-v1 runs require `TESTS_GREEN`. In both cases a NON-terminal token
// (`TESTS_FAILING` or delegated-but-unverified `DELEGATED_OK`) wins. A
// `CHANGES_REQUESTED` reviewer or a
// mid-fix-cycle `TESTS_FAILING` tester stays non-terminal. The "passing token present
// AND non-terminal token absent" shape avoids a false positive from a digest that
// merely mentions the other token.
function testerDigestPassedForRun(cwd: string, runId: string, tester: string): boolean {
  if (runUsesStrictQaContract(cwd, runId)) {
    return exactDigestVerdict(tester) === 'TESTS_GREEN';
  }
  const passingToken = /\b(TESTS_GREEN|APPROVED)\b/.test(tester);
  return passingToken && !/\b(TESTS_FAILING|DELEGATED_OK)\b/.test(tester);
}

function reviewerDigestApprovedForRun(cwd: string, runId: string, reviewer: string): boolean {
  if (runUsesStrictQaContract(cwd, runId)) {
    return exactDigestVerdict(reviewer) === 'APPROVED';
  }
  return /\bAPPROVED\b/.test(reviewer) && !/\bCHANGES_REQUESTED\b/.test(reviewer);
}

function runCompletionEvidenceAllows(
  cwd: string,
  runId: string,
  outcome: RunLedgerOutcome | undefined,
): boolean {
  if (outcome === 'shipped') return shipperDigestCompleted(cwd, runId);
  if (outcome !== 'verified') return false;
  const reviewer = readDigest(cwd, runId, 'reviewer.md');
  const tester = readDigest(cwd, runId, 'tester.md');
  return reviewerDigestApprovedForRun(cwd, runId, reviewer)
    && testerDigestPassedForRun(cwd, runId, tester)
    && runHasQaEvidence(cwd, runId);
}

function buildRunReachedTerminalVerdict(cwd: string, runId: string): boolean {
  const ledger = runLedgerStatusRecord(cwd, runId);
  if (ledger.status === 'blocked' || ledger.status === 'failed') return false;
  if (ledger.status === 'completed' && (ledger.outcome === 'verified' || ledger.outcome === 'shipped')) return true;
  if (shipperDigestCompleted(cwd, runId)) return true;
  const reviewer = readDigest(cwd, runId, 'reviewer.md');
  const tester = readDigest(cwd, runId, 'tester.md');
  const reviewerApproved = reviewerDigestApprovedForRun(cwd, runId, reviewer);
  const testerPassed = testerDigestPassedForRun(cwd, runId, tester);
  return reviewerApproved && testerPassed && runHasQaEvidence(cwd, runId);
}

export function runReachedTerminalVerdict(cwd: string, runId: unknown): boolean {
  if (typeof runId !== 'string' || !runId) return false;
  return maintenanceRunReachedTerminal(cwd, runId) || buildRunReachedTerminalVerdict(cwd, runId);
}

export type RunVerificationState = 'terminal' | 'not-started' | 'nonterminal' | 'empty';

function runProducedImplementerOutput(cwd: string, runId: string): boolean {
  return Boolean(readDigest(cwd, runId, 'frontend.md').trim() || readDigest(cwd, runId, 'backend.md').trim());
}

function runHasQaReportFile(cwd: string, runId: string): boolean {
  const memoryDir = '.traffic' + '-one';
  return fs.existsSync(path.join(cwd, memoryDir, 'reports', 'qa', safePathSegment(runId), 'report.json'));
}

// Machine-readable current-run classification for prompt-boundary lifecycle
// settlement. A verifier artifact without the complete terminal combination is
// always nonterminal, including delegated-only, requested-changes, failing, and
// blocked QA results.
export function runVerificationState(cwd: string, runId: unknown): RunVerificationState {
  if (typeof runId !== 'string' || !runId) return 'empty';
  const ledger = runLedgerStatusRecord(cwd, runId);
  if (ledger.status === 'blocked' || ledger.status === 'failed') return 'nonterminal';
  // Maintenance outcome markers have their own routing semantics. They must not
  // make a build terminal: build settlement is only strict verification or shipper.
  if (buildRunReachedTerminalVerdict(cwd, runId)) return 'terminal';
  const implementerOutput = runProducedImplementerOutput(cwd, runId);
  const verifierOutput = Boolean(
    readDigest(cwd, runId, 'reviewer.md').trim()
    || readDigest(cwd, runId, 'tester.md').trim()
    || readDigest(cwd, runId, 'shipper.md').trim()
    || runHasQaReportFile(cwd, runId),
  );
  if (verifierOutput) return 'nonterminal';
  return implementerOutput ? 'not-started' : 'empty';
}

// Reconcile a fully verified/shipped build into the central run ledger. This is
// intentionally separate from runReachedTerminalVerdict: callers performing a
// read-only probe do not mutate state, while lifecycle settlement can opt in.
export function settleTerminalRunLedger(
  cwd: string,
  runId: unknown,
  expectedOutcome?: Extract<RunLedgerOutcome, 'verified' | 'shipped'>,
): Rec | null {
  if (typeof runId !== 'string' || !runId) return null;
  const ledgerState = runLedgerStatusRecord(cwd, runId);
  if (ledgerState.status === 'completed'
    && (ledgerState.outcome === 'verified' || ledgerState.outcome === 'shipped')) {
    if (!expectedOutcome || expectedOutcome === ledgerState.outcome) {
      return transitionRunStatus(cwd, runId, {
        status: 'completed',
        outcome: ledgerState.outcome,
      });
    }
    if (ledgerState.outcome === 'shipped' && expectedOutcome === 'verified') return null;
    // verified→shipped continues below and still requires a positive shipper digest.
  }
  const preserveLegacyQaContract = !obj(readJson(runLedgerFile(cwd, runId), null));
  const shipperCompleted = shipperDigestCompleted(cwd, runId);
  if (expectedOutcome === 'shipped' && !shipperCompleted) return null;
  if (shipperCompleted && expectedOutcome !== 'verified') {
    return transitionRunStatus(cwd, runId, {
      status: 'completed',
      outcome: 'shipped',
      preserveLegacyQaContract,
    });
  }
  const reviewer = readDigest(cwd, runId, 'reviewer.md');
  const tester = readDigest(cwd, runId, 'tester.md');
  const reviewerApproved = reviewerDigestApprovedForRun(cwd, runId, reviewer);
  const testerPassed = testerDigestPassedForRun(cwd, runId, tester);
  if (!reviewerApproved || !testerPassed || !runHasQaEvidence(cwd, runId)) return null;
  return transitionRunStatus(cwd, runId, {
    status: 'completed',
    outcome: 'verified',
    preserveLegacyQaContract,
  });
}

// Prompt-boundary "settled enough to rotate the run id" — used ONLY by the maintenance
// run-id rotation guard (triage-directive.beginFreshMaintenanceRun), NEVER by the mid-turn
// maintenance flip. A run that produced implementer output AND earned reviewer APPROVED +
// tester TESTS_GREEN is finished; rotating away from it at a prompt boundary is safe even if
// the QA-evidence gate didn't pass — otherwise a frontend build that skipped QA artifacts
// (and omitted the N/A escape) pins currentRunId forever while the project still flips to
// maintenance via anyRunProducedImplementerOutput, and the next feature reuses the stale run
// id + spawnIndex. The STRICT bar (runReachedTerminalVerdict, incl. the QA gate) is kept
// everywhere else. Both green verdicts co-occur only after the run is done, so this never
// rotates a genuinely in-flight (still-verifying) run.
export function runSettledForRotation(cwd: string, runId: unknown): boolean {
  if (typeof runId !== 'string' || !runId) return false;
  // Contract-v1 runs never rotate on textual verdicts alone: the strict parser,
  // screenshots, freshness, and full matrix must all have passed. Generic
  // maintenance blocked/failed markers are legacy settlement, not a v1 bypass.
  if (runUsesStrictQaContract(cwd, runId)) return buildRunReachedTerminalVerdict(cwd, runId);
  if (runReachedTerminalVerdict(cwd, runId)) return true;
  if (!runProducedImplementerOutput(cwd, runId) || runHasExplicitBlockedQaOutcome(cwd, runId)) return false;
  const reviewer = readDigest(cwd, runId, 'reviewer.md');
  const tester = readDigest(cwd, runId, 'tester.md');
  const reviewerApproved = /\bAPPROVED\b/.test(reviewer) && !/\bCHANGES_REQUESTED\b/.test(reviewer);
  const testerPassed = /\b(TESTS_GREEN|APPROVED)\b/.test(tester) && !/\b(TESTS_FAILING|DELEGATED_OK)\b/.test(tester);
  return reviewerApproved && testerPassed;
}

function maintenanceRunReachedTerminal(cwd: string, runId: string): boolean {
  try {
    const parsed = readJson(path.join(runDir(cwd, runId), 'maintenance.json'), null);
    const rec = obj(parsed);
    if (!rec || rec.version !== 1) return false;
    const overall = typeof rec.overallOutcome === 'string' ? rec.overallOutcome : '';
    const outcome = overall || (typeof rec.outcome === 'string' ? rec.outcome : '');
    return outcome === 'success' || outcome === 'completed' || outcome === 'blocked'
      || outcome === 'failed' || outcome === 'skipped' || outcome === 'fallback-paid';
  } catch {
    return false;
  }
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
    return ['architect.md', 'frontend.md', 'backend.md', 'reviewer.md', 'tester.md',
      'senior-architect.md', 'senior-frontend.md', 'senior-backend.md', 'senior-reviewer.md', 'senior-tester.md']
      .some((n) => fs.existsSync(path.join(dd, n)));
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

// True when ANY run dir under .traffic-one/digests has an IMPLEMENTER digest
// (frontend.md or backend.md) — proof the orchestrator got past planning and an
// implementer actually wrote code. WEAKER than a terminal verdict: it does NOT
// require a reviewer `APPROVED` + tester `TESTS_GREEN`. Used only at the prompt
// boundary by the maintenance flip, where the build turn has already ended — a
// build that produced real implementer output but never recorded a clean
// reviewer/tester verdict (interrupted verification, a role that skipped its
// digest, a multi-session resume) must still settle to maintenance so follow-ups
// get triaged, instead of staying pinned in "building" forever. The strict
// terminal-verdict gate still guards the mid-turn (PostToolUse) flip.
export function anyRunProducedImplementerOutput(cwd: string): boolean {
  try {
    const base = path.join(cwd, '.traffic-one', 'digests');
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dd = digestDir(cwd, entry.name);
      // Accept both bare and senior-* implementer digest names. Cursor's write path can
      // emit senior-frontend.md / senior-backend.md; checking only the bare forms here
      // (while runHasOrchestratedArtifacts/readDigest accept both) would leave a
      // senior-*-only build wedged in 'building' at the prompt boundary.
      if (['frontend.md', 'backend.md', 'senior-frontend.md', 'senior-backend.md']
        .some((n) => fs.existsSync(path.join(dd, n)))) return true;
    }
  } catch {
    // best-effort — no digests dir means nothing has been implemented yet
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
const FALLBACK_CLAIMS_LOCK_TIMEOUT_MS = 2_000;
const FALLBACK_CLAIMS_LOCK_STALE_MS = 15_000;
const FALLBACK_CLAIMS_LOCK_RETRY_MS = 10;
const FALLBACK_CLAIMS_WAIT = new Int32Array(new SharedArrayBuffer(4));

interface OwnedDirLock {
  dir: string;
  ownerFile: string;
}

function processDefinitelyDead(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return obj(error)?.code === 'ESRCH';
  }
}

function readOwnedLock(filePath: string): { pid: number; acquiredAt: number } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const record = obj(parsed);
    if (!record || typeof record.pid !== 'number' || typeof record.acquiredAt !== 'number') return null;
    return { pid: record.pid, acquiredAt: record.acquiredAt };
  } catch {
    return null;
  }
}

// Reclaim only the exact owner sentinel observed in a stale directory. The
// successful unlink is the CAS: only that reaper may remove the now-empty
// directory, and neither an old owner nor a competing reaper can delete a new
// owner's replacement lease.
function reclaimStaleOwnedDirLock(lockDir: string, staleMs: number): boolean {
  let entries: string[];
  try { entries = fs.readdirSync(lockDir); } catch { return false; }
  const owners = entries.filter((name) => name.startsWith('.owner-') && name.endsWith('.json'));
  if (owners.length === 1) {
    const ownerFile = path.join(lockDir, owners[0]!);
    const owner = readOwnedLock(ownerFile);
    if (!owner || Date.now() - owner.acquiredAt <= staleMs || !processDefinitelyDead(owner.pid)) return false;
    try {
      fs.unlinkSync(ownerFile);
      fs.rmdirSync(lockDir);
      return true;
    } catch {
      return false;
    }
  }
  if (owners.length > 1) return false;

  // Compatibility with lock directories left by older builds/tests, which had
  // no owner sentinel. Serialize empty-directory reclamation with a fixed file;
  // malformed/non-empty directories are conservatively left to time out.
  let stat: fs.Stats;
  try { stat = fs.statSync(lockDir); } catch { return false; }
  if (Date.now() - stat.mtimeMs <= staleMs || entries.length !== 0) return false;
  const reaper = path.join(lockDir, '.reaper');
  let fd: number | undefined;
  try {
    fd = fs.openSync(reaper, 'wx');
    fs.closeSync(fd);
    fd = undefined;
    const after = fs.readdirSync(lockDir);
    if (after.length !== 1 || after[0] !== '.reaper') return false;
    fs.unlinkSync(reaper);
    fs.rmdirSync(lockDir);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best-effort */ }
    try { fs.unlinkSync(reaper); } catch { /* not ours or already removed */ }
  }
}

function acquireOwnedDirLock(
  lockDir: string,
  timeoutMs: number,
  staleMs: number,
  retryMs: number,
  waitArray: Int32Array,
): OwnedDirLock | null {
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const ownerFile = path.join(lockDir, `.owner-${token}.json`);
  try { fs.mkdirSync(path.dirname(lockDir), { recursive: true }); } catch { return null; }
  while (true) {
    let madeDir = false;
    try {
      fs.mkdirSync(lockDir);
      madeDir = true;
      fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), { flag: 'wx' });
      return { dir: lockDir, ownerFile };
    } catch {
      if (madeDir) {
        try { fs.unlinkSync(ownerFile); } catch { /* best-effort */ }
        try { fs.rmdirSync(lockDir); } catch { /* best-effort */ }
      }
      if (reclaimStaleOwnedDirLock(lockDir, staleMs)) continue;
      if (Date.now() >= deadline) return null;
      Atomics.wait(waitArray, 0, 0, retryMs);
    }
  }
}

function releaseOwnedDirLock(lease: OwnedDirLock): void {
  try {
    // The unique sentinel is the ownership token. If it vanished, this process
    // no longer owns the directory and must not remove anything else.
    fs.unlinkSync(lease.ownerFile);
  } catch {
    return;
  }
  try { fs.rmdirSync(lease.dir); } catch { /* a foreign/malformed entry stays fail-closed */ }
}

function withOwnedDirLock(
  lockDir: string,
  timeoutMs: number,
  staleMs: number,
  retryMs: number,
  waitArray: Int32Array,
  mutate: () => void,
): boolean {
  const lease = acquireOwnedDirLock(lockDir, timeoutMs, staleMs, retryMs, waitArray);
  if (!lease) return false;
  try {
    mutate();
    return true;
  } finally {
    releaseOwnedDirLock(lease);
  }
}

function fallbackClaimsLockDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), '.claims.lock');
}

function withFallbackClaimsLock(cwd: string, runId: string, mutate: () => void): boolean {
  return withOwnedDirLock(
    fallbackClaimsLockDir(cwd, runId),
    FALLBACK_CLAIMS_LOCK_TIMEOUT_MS,
    FALLBACK_CLAIMS_LOCK_STALE_MS,
    FALLBACK_CLAIMS_LOCK_RETRY_MS,
    FALLBACK_CLAIMS_WAIT,
    mutate,
  );
}

interface FallbackClaimBackup {
  filePath: string;
  raw: string;
}

function releaseFallbackClaimsForHolderUnlocked(
  cwd: string,
  runId: string,
  holder: string,
): { ok: boolean; removed: FallbackClaimBackup[] } {
  const dir = fallbackClaimsDir(cwd, runId);
  const removed: FallbackClaimBackup[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return obj(error)?.code === 'ENOENT'
      ? { ok: true, removed }
      : { ok: false, removed };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    const claim = obj(readJson(file, null));
    if (!claim || String(claim.runId || '') !== runId || claim.holder !== holder) continue;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      fs.rmSync(file, { force: true });
      removed.push({ filePath: file, raw });
    } catch {
      // The durable rebind journal owns forward recovery. Report the exact
      // partial deletion set instead of attempting rollback: restoring a subset
      // can itself fail and would erase the accounting needed for a safe retry.
      return { ok: false, removed };
    }
  }
  return { ok: true, removed };
}

export function tryFallbackClaim(
  cwd: string,
  ctx: RunAgentContext,
  target: string,
): { blocked: boolean; holder?: string } {
  const runId = ctx && ctx.runId != null ? String(ctx.runId) : '';
  if (!runId) return { blocked: false };
  if (isNonProjectRoot(cwd)) return { blocked: false }; // no claim files in the plugin's own repo
  const myKey = String(ctx.sessionId || ctx.claimId || ctx.role || '');
  const file = fallbackClaimFile(cwd, runId, normalizeRelPath(target));
  let result: { blocked: boolean; holder?: string } = { blocked: false };
  const locked = withFallbackClaimsLock(cwd, runId, () => {
    const existing = obj(readJson(file, null));
    if (existing
      && isFreshTimestamp(existing.createdAt, SUBAGENT_STALE_MS)
      && typeof existing.holder === 'string' && existing.holder
      && existing.holder !== myKey) {
      result = { blocked: true, holder: existing.holder };
      return;
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
  });
  return locked ? result : { blocked: false };
}

// ── Per-run live-agent registry (subagent reuse) ──────────────────────────────
// .traffic-one/runs/<runId>/agents.json maps role → the LIVE agent id returned
// by the host's spawn tool. The PostToolUse recorder writes it; the PreToolUse
// reuse gate denies a SECOND same-role spawn and points the orchestrator at the
// recorded id, so the role's later tasks continue ONE agent and the rules+skills
// context loads once per role instead of once per task.
// Entries are parent-session-bound: an in-process agent dies with its parent
// session, so an id recorded by ANOTHER session never blocks a spawn.

export const REPLACE_AGENT_MARKER = '[t1-replace-agent]';

// Continuation needs the host's send-to-agent tool. On current Codex that is
// followup_task/send_message — native to the collaboration toolset, with no flag (so
// the one-live-agent registry/dedup must be ON there by default; keying only on
// the Claude flag silently disabled the whole regime on Codex). Cursor and
// Copilot expose continuation through their native task/background-agent tools.
// On Claude it is SendMessage, which only registers when the agent-teams feature
// flag was set at session start. An explicit falsy flag still switches it off
// everywhere.
// `host` is the gate's already-resolved host (preferred — authoritative); env is the
// fallback signal when a caller has no host in hand. An explicit off-flag disables
// everywhere, on any host.
export function subagentContinuationAvailable(env: NodeJS.ProcessEnv = process.env, host?: string): boolean {
  const flag = String(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (host) {
    if (host === 'codex' || host === 'cursor' || host === 'copilot' || host === 'windsurf' || host === 'opencode' || host === 'kilo') return true;
    return flag !== '';
  }
  const envHost = String(env.TRAFFIC_ONE_HOST ?? '').trim().toLowerCase();
  // Codex: followup_task/send_message (native to the collaboration toolset).
  if (envHost === 'codex' || env.CODEX_PLUGIN_ROOT || env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || env.CODEX_THREAD_ID) return true;
  // Cursor: live Cursor builds surface Task continuation as `resume` to resume a
  // previous subagent with full context preserved — the analogue of
  // followup_task/SendMessage. Older docs/models may say `agentId`, so the gate
  // accepts both fields.
  // Without this every Cursor role task re-spawned a fresh subagent, re-loading rules+skills.
  if (envHost === 'cursor' || env.CURSOR_PLUGIN_ROOT) return true;
  // Copilot: the plugin hook env carries only TRAFFIC_ONE_HOST=copilot, so this
  // must not depend on a Claude feature flag or the registry stays inert.
  if (envHost === 'copilot') return true;
  // Windsurf/Devin Local: run_subagent + read_subagent (native custom profiles).
  if (envHost === 'windsurf') return true;
  // OpenCode has no resumable Task field in current builds, but Traffic One still
  // records the active role session so duplicate same-role spawns are routed to
  // wait/explicit replacement instead of silently creating another live role.
  if (envHost === 'opencode') return true;
  // Kilo has no true Task resume field, but the live-role registry still prevents
  // duplicate general workers and requires an explicit replacement after completion.
  if (envHost === 'kilo') return true;
  // Claude: SendMessage, gated by the agent-teams flag set at session start.
  return flag !== '';
}

function agentRegistryFile(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'agents.json');
}

const AGENT_REGISTRY_LOCK_TIMEOUT_MS = 2_000;
const AGENT_REGISTRY_LOCK_STALE_MS = 15_000;
const AGENT_REGISTRY_LOCK_RETRY_MS = 10;
const AGENT_REGISTRY_WAIT = new Int32Array(new SharedArrayBuffer(4));

function agentRegistryLockDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), '.agents.lock');
}

// agents.json is updated by independent PostToolUse/SubagentStart hook processes.
// Atomic rename prevents torn JSON but not lost read-modify-write updates, so
// serialize the tiny registry mutation behind a bounded mkdir lock. A stale lock
// from a crashed hook is reclaimed; on timeout we skip the best-effort registry
// write rather than overwrite another role with stale state.
function withAgentRegistryLock(cwd: string, runId: string, mutate: () => void): boolean {
  return withOwnedDirLock(
    agentRegistryLockDir(cwd, runId),
    AGENT_REGISTRY_LOCK_TIMEOUT_MS,
    AGENT_REGISTRY_LOCK_STALE_MS,
    AGENT_REGISTRY_LOCK_RETRY_MS,
    AGENT_REGISTRY_WAIT,
    mutate,
  );
}

export interface RunAgentEntry {
  agentId: string;
  /** Cursor Task `resume` id (UUID from spawn result). Never a `tool_*` tool-call id. */
  resumeId?: string | null;
  /** Cursor subagentStart `subagent_id` (= tool_<uuid>) when PostToolUse has not arrived yet. */
  toolCallId?: string | null;
  role: string;
  model: string | null;
  agentType: string | null;
  parentSessionId: string | null;
  recordedAt: string;
  tasks: number;
  replaced: boolean;
  roleSource?: string | null;
  transcriptPath?: string | null;
}

const VERDICT_AGENT_ROLES = new Set(['senior-reviewer', 'senior-tester']);

export interface VerdictAgentConflict {
  role: string;
  agentId: string;
  matchedId: string;
}

function idsForRunAgent(entry: RunAgentEntry | Rec | null | undefined): string[] {
  const e = obj(entry);
  if (!e) return [];
  return [e.agentId, e.resumeId, e.toolCallId]
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim());
}

function verdictConflictFromAgents(agents: Rec, role: string, ids: readonly string[]): VerdictAgentConflict | null {
  if (!VERDICT_AGENT_ROLES.has(role)) return null;
  const wanted = new Set(ids.map((id) => id.trim()).filter(Boolean));
  if (wanted.size === 0) return null;
  for (const [otherRole, value] of Object.entries(agents)) {
    if (otherRole === role) continue;
    const entry = obj(value);
    if (!entry || entry.replaced === true) continue;
    for (const id of idsForRunAgent(entry)) {
      if (wanted.has(id)) {
        return {
          role: otherRole,
          agentId: typeof entry.agentId === 'string' ? entry.agentId : id,
          matchedId: id,
        };
      }
    }
  }
  return null;
}

export function verdictAgentConflict(cwd: string, runId: string, role: string, agentId: unknown): VerdictAgentConflict | null {
  if (typeof agentId !== 'string' || !agentId.trim()) return null;
  return verdictConflictFromAgents(readRunAgentRegistry(cwd, runId), role, [agentId.trim()]);
}

/** Cursor surfaces spawn tool-call ids as `tool_<uuid>` — these do NOT work with Task `resume`. */
export function isCursorToolSubagentId(id: string): boolean {
  return /^tool_[0-9a-f-]{8,}$/i.test(id.trim());
}

/** True when the id can resume/continue the agent on Cursor (UUID/hex agent id, not tool_*). */
export function isResumeCapableAgentId(id: string): boolean {
  const t = id.trim();
  return t.length > 0 && !isCursorToolSubagentId(t);
}

/** Host-correct id for agent-reuse continuation denies (Cursor → Task `resume`). */
export function continuationAgentId(entry: RunAgentEntry, host: string): string {
  if (host !== 'cursor') return entry.agentId;
  if (entry.resumeId && isResumeCapableAgentId(entry.resumeId)) return entry.resumeId;
  if (isResumeCapableAgentId(entry.agentId)) return entry.agentId;
  return '';
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
      resumeId: typeof entry.resumeId === 'string' ? entry.resumeId : null,
      toolCallId: typeof entry.toolCallId === 'string' ? entry.toolCallId : null,
      role,
      model: typeof entry.model === 'string' ? entry.model : null,
      agentType: typeof entry.agentType === 'string' ? entry.agentType : null,
      parentSessionId: typeof entry.parentSessionId === 'string' ? entry.parentSessionId : null,
      recordedAt: typeof entry.recordedAt === 'string' ? entry.recordedAt : '',
      tasks: typeof entry.tasks === 'number' && Number.isInteger(entry.tasks) && entry.tasks > 0 ? entry.tasks : 1,
      replaced: entry.replaced === true,
      roleSource: typeof entry.roleSource === 'string' ? entry.roleSource : null,
      transcriptPath: typeof entry.transcriptPath === 'string' ? entry.transcriptPath : null,
    };
  }
  return out;
}

// Resolve the ROLE a hook session belongs to within a run: match the payload's
// sessionId against the per-run agent registry (agents.json), then against the
// run's agent claim files. Diagnostic-strength attribution for deny telemetry
// (observed 5c/8c: every plan-guard-deny row carried role:null/isSubagent:false
// even for subagent writes, because the shared state has no per-session role) —
// never a gate input.
export function roleForRunSessionId(
  cwd: string,
  runId: string | null | undefined,
  sessionId: string | null | undefined,
): string | null {
  if (!runId || !sessionId || isNonProjectRoot(cwd)) return null;
  try {
    for (const [role, entry] of Object.entries(readRunAgentRegistry(cwd, runId))) {
      if (entry.agentId === sessionId || entry.resumeId === sessionId) return role;
    }
  } catch {
    // registry unreadable — fall through to claims
  }
  for (const claim of listClaimedAgents(cwd, runId)) {
    if (firstString(claim.sessionId) === sessionId && typeof claim.role === 'string') return claim.role;
  }
  return null;
}

type RunAgentRecordInput = {
  agentId: string;
  resumeId?: string | null;
  toolCallId?: string | null;
  model?: string | null;
  agentType?: string | null;
  parentSessionId?: string | null;
  roleSource?: string | null;
  transcriptPath?: string | null;
};

export function recordRunAgent(
  cwd: string,
  runId: string,
  role: string,
  entry: RunAgentRecordInput,
): void {
  if (!VALID_AGENT_ROLES.has(role)) return;
  if (isNonProjectRoot(cwd)) return; // never write run state in the plugin's own repo
  if (typeof entry.agentId !== 'string' || !entry.agentId.trim()) return;
  withAgentRegistryLock(cwd, runId, () => recordRunAgentUnlocked(cwd, runId, role, entry));
}

function recordRunAgentUnlocked(cwd: string, runId: string, role: string, entry: RunAgentRecordInput): void {
  const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
  const agents = obj(registry.agents) || {};
  const history = Array.isArray(registry.history) ? registry.history.filter((item) => item && typeof item === 'object') : [];
  const prior = obj(agents[role]);
  const incomingId = entry.agentId.trim();
  const incomingResume = (entry.resumeId && isResumeCapableAgentId(entry.resumeId) ? entry.resumeId.trim() : null)
    || (isResumeCapableAgentId(incomingId) ? incomingId : null);
  const incomingTool = (entry.toolCallId && isCursorToolSubagentId(entry.toolCallId) ? entry.toolCallId.trim() : null)
    || (isCursorToolSubagentId(incomingId) ? incomingId : null);
  const priorResume = prior && typeof prior.resumeId === 'string' && isResumeCapableAgentId(prior.resumeId)
    ? (prior.resumeId as string)
    : (prior && typeof prior.agentId === 'string' && isResumeCapableAgentId(prior.agentId as string) ? (prior.agentId as string) : null);
  const resumeId = incomingResume || priorResume || null;
  const toolCallId = incomingTool
    || (prior && typeof prior.toolCallId === 'string' ? (prior.toolCallId as string) : null);
  // agentId stays backward-compatible: prefer the resume-capable id when known.
  const agentId = resumeId || incomingId || (prior && typeof prior.agentId === 'string' ? (prior.agentId as string) : incomingId);
  const conflict = verdictConflictFromAgents(agents, role, [agentId, resumeId || '', toolCallId || '']);
  if (conflict) {
    const conflicts = Array.isArray(registry.conflicts) ? registry.conflicts.filter((item) => item && typeof item === 'object') : [];
    conflicts.push({
      role,
      rejectedAgentId: agentId,
      rejectedResumeId: resumeId,
      rejectedToolCallId: toolCallId,
      conflictingRole: conflict.role,
      conflictingAgentId: conflict.agentId,
      matchedId: conflict.matchedId,
      recordedAt: stateTimestamp(),
      reason: 'verdict-role-cannot-reuse-another-role-agent',
    });
    try {
      fs.mkdirSync(runDir(cwd, runId), { recursive: true });
      writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents, history, conflicts: conflicts.slice(-50) });
    } catch {
      // best-effort diagnostic; never bind the unsafe cross-role agent
    }
    return;
  }
  const sameAgent = prior
    && prior.replaced !== true
    && ((prior.agentId === agentId)
      || (prior.resumeId && prior.resumeId === resumeId)
      || (prior.toolCallId && prior.toolCallId === toolCallId)
      // Cursor records `subagentStart` first with only `tool_<uuid>`, then later
      // PostToolUse(Task) can add the real resume UUID with no shared id. Duplicate
      // same-role fresh spawns are denied before they reach here, so treat this as
      // an upgrade of the same live agent unless the role was explicitly replaced.
      || (prior.toolCallId && !prior.resumeId && resumeId));
  const priorModel = prior && typeof prior.model === 'string' && prior.model ? prior.model : null;
  const priorAgentType = prior && typeof prior.agentType === 'string' && prior.agentType ? prior.agentType : null;
  const priorParentSessionId = prior && typeof prior.parentSessionId === 'string' && prior.parentSessionId ? prior.parentSessionId : null;
  const priorRoleSource = prior && typeof prior.roleSource === 'string' && prior.roleSource ? prior.roleSource : null;
  const priorTranscriptPath = prior && typeof prior.transcriptPath === 'string' && prior.transcriptPath ? prior.transcriptPath : null;
  const recordedAt = stateTimestamp();
  const nextHistory = history.slice(-99);
  if (prior && !sameAgent) {
    nextHistory.push({
      role,
      replacedAt: typeof prior.replacedAt === 'string' ? prior.replacedAt : recordedAt,
      replacementReason: typeof prior.replacementReason === 'string' ? prior.replacementReason : 'new-agent-recorded',
      oldAgentId: typeof prior.agentId === 'string' ? prior.agentId : null,
      oldResumeId: typeof prior.resumeId === 'string' ? prior.resumeId : null,
      oldToolCallId: typeof prior.toolCallId === 'string' ? prior.toolCallId : null,
      newAgentId: agentId,
      parentSessionId: priorParentSessionId,
    });
  }
  agents[role] = {
    agentId,
    resumeId,
    toolCallId,
    model: firstString(entry.model, sameAgent ? priorModel : null),
    agentType: firstString(entry.agentType, sameAgent ? priorAgentType : null),
    parentSessionId: firstString(entry.parentSessionId, sameAgent ? priorParentSessionId : null),
    roleSource: strongestRoleSource(entry.roleSource, sameAgent ? priorRoleSource : null),
    transcriptPath: firstString(entry.transcriptPath, sameAgent ? priorTranscriptPath : null),
    recordedAt,
    tasks: sameAgent && typeof prior?.tasks === 'number' ? (prior.tasks as number) + 1 : 1,
    replaced: false,
  };
  try {
    fs.mkdirSync(runDir(cwd, runId), { recursive: true });
    writeJson(agentRegistryFile(cwd, runId), { version: 1, agents, history: nextHistory });
  } catch {
    // best-effort registry; reuse falls back to fresh spawns when unwritable
  }
}

// Cursor sometimes exposes only `subagent_id: tool_<uuid>` at SubagentStart. That
// id proves a role was started, but it is not a valid Task `resume` target. Before
// the duplicate-spawn gate asks the orchestrator to continue or replace the role,
// actively scan Cursor's local subagent transcript cache for the real child
// conversation UUID and upgrade agents.json. This also covers read-only roles
// (reviewer) that may not write files, so resolveRunAgentContext never gets a
// chance to self-heal from a write hook.
export function refreshCursorRunAgentFromTranscriptCache(
  cwd: string,
  state: unknown,
  rawInput: unknown,
  runId: string,
  role: string,
  parentSessionId: string | null,
): RunAgentEntry | null {
  if (!runId || !VALID_AGENT_ROLES.has(role) || isNonProjectRoot(cwd)) return null;
  const expected = readRunAgentRegistry(cwd, runId)[role];
  if (!expected || expected.replaced) return null;
  if (expected.parentSessionId && parentSessionId
    && expected.parentSessionId !== parentSessionId) return null;
  const boundParentSessionId = expected.parentSessionId || parentSessionId;
  if (!boundParentSessionId) return null;
  if (continuationAgentId(expected, 'cursor')) return expected;

  const expectedIds = new Set(idsForRunAgent(expected));
  const candidates = cursorSubagentTranscriptsForRole(cwd, rawInput, role, boundParentSessionId);
  for (const candidate of candidates) {
    const childId = candidateThreadId(candidate);
    if (!childId) continue;
    const candidateParentId = candidate.parentSessionId || boundParentSessionId;

    // Hold the observation lock while validating transcript ownership and
    // conditionally upgrading agents.json. A concurrent transcript claim cannot
    // turn an apparently-unclaimed old child into another spawn's result between
    // those two operations, and the registry identity CAS prevents a late cache
    // scan from overwriting a newer tool_* start for the same role.
    const upgraded = withCursorSpawnObservationLock(cwd, runId, () => {
      const store = readCursorSpawnObservationStore(cwd, runId);
      const currentObservation = latestCursorObservation(store.observations, (observation) => (
        observation.parentSessionId === boundParentSessionId
        && observation.role === role
        && (expectedIds.has(observation.toolCallId)
          || Boolean(observation.childTranscriptId && expectedIds.has(observation.childTranscriptId)))
      ));
      const claimedObservation = store.observations.find((observation) => (
        observation.childTranscriptId === childId
      ));
      if (claimedObservation) {
        const belongsToCurrent = currentObservation
          ? claimedObservation.toolCallId === currentObservation.toolCallId
          : (expectedIds.has(claimedObservation.toolCallId)
            || Boolean(claimedObservation.childTranscriptId
              && expectedIds.has(claimedObservation.childTranscriptId)));
        if (!belongsToCurrent) return null;
      } else {
        const currentStartedAtMs = currentObservation?.startedAtMs || finiteMs(expected.recordedAt);
        const candidateStartedAtMs = cursorTranscriptCandidateTimeMs(candidate);
        if (!currentStartedAtMs
          || candidateStartedAtMs < currentStartedAtMs - CURSOR_TRANSCRIPT_EARLY_TOLERANCE_MS) return null;
      }

      let result: RunAgentEntry | null = null;
      withAgentRegistryLock(cwd, runId, () => {
        const latest = readRunAgentRegistry(cwd, runId)[role];
        if (!latest || latest.replaced) return;
        const sameExpectedStart = latest.agentId === expected.agentId
          && (latest.resumeId || null) === (expected.resumeId || null)
          && (latest.toolCallId || null) === (expected.toolCallId || null)
          && (latest.parentSessionId || null) === (expected.parentSessionId || null);
        if (!sameExpectedStart) {
          if ((latest.toolCallId || null) === (expected.toolCallId || null)
            && continuationAgentId(latest, 'cursor') === childId) result = latest;
          return;
        }
        recordRunAgentUnlocked(cwd, runId, role, {
          agentId: childId,
          resumeId: childId,
          parentSessionId: candidateParentId,
        });
        const next = readRunAgentRegistry(cwd, runId)[role];
        if (next && (next.toolCallId || null) === (expected.toolCallId || null)
          && continuationAgentId(next, 'cursor') === childId) result = next;
      });
      return result;
    });
    if (!upgraded) continue;
    claimThreadRole(cwd, state, childId, role, { parentSessionId: candidateParentId });
    return upgraded;
  }
  return null;
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
      stackFingerprint: stackFingerprint(state),
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
export function markRunAgentReplaced(cwd: string, runId: string, role: string): void {
  if (isNonProjectRoot(cwd)) return;
  withAgentRegistryLock(cwd, runId, () => markRunAgentReplacedUnlocked(cwd, runId, role));
}

// Transcript reconciliation knows the failed SubagentStart tool-call id. Retire
// the registry entry only while it still represents that spawn; a delayed child
// transcript must never retire a newer retry that already took over the role.
export function markRunAgentReplacedIfMatches(
  cwd: string,
  runId: string,
  role: string,
  expectedId: string,
): boolean {
  if (!expectedId || isNonProjectRoot(cwd)) return false;
  let replaced = false;
  withAgentRegistryLock(cwd, runId, () => {
    const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
    const agents = obj(registry.agents) || {};
    const entry = obj(agents[role]);
    if (!entry || entry.replaced === true || !idsForRunAgent(entry).includes(expectedId)) return;
    entry.replaced = true;
    entry.replacedAt = stateTimestamp();
    entry.replacementReason = 'correlated-cursor-transcript-failure';
    try {
      writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents });
      replaced = true;
    } catch {
      // best-effort; existing grace/hard timers remain the deadlock backstop
    }
  });
  return replaced;
}

function markRunAgentReplacedUnlocked(cwd: string, runId: string, role: string): void {
  const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
  const agents = obj(registry.agents) || {};
  const entry = obj(agents[role]);
  if (!entry) return;
  entry.replaced = true;
  entry.replacedAt = stateTimestamp();
  entry.replacementReason = 'explicit-replace-agent-marker';
  try {
    writeJson(agentRegistryFile(cwd, runId), { ...registry, version: 1, agents });
  } catch {
    // best-effort
  }
}
