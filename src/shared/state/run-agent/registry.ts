// src/shared/state/run-agent/registry.ts
// The per-run live-agent registry (subagent reuse): entry shapes, verdict
// conflicts, the registry lock, record/read/refresh, and replacement.

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
  firstString,
  runDir,
} from './run-paths';
import {
  withOwnedDirLock,
} from './locks';
import {
  strongestRoleSource,
} from './role-evidence';
import {
  isFreshTimestamp,
} from './session-identity';
import {
  CURSOR_TRANSCRIPT_EARLY_TOLERANCE_MS,
  finiteMs,
  readCursorSpawnObservationStore,
  withCursorSpawnObservationLock,
} from './cursor-observations';
import {
  latestCursorObservation,
} from './cursor-followups';
import {
  candidateThreadId,
  cursorSubagentTranscriptsForRole,
  cursorTranscriptCandidateTimeMs,
} from './cursor-transcripts';
import {
  listClaimedAgents,
} from './claims-store';
import {
  claimThreadRole,
} from './claim-thread-role';
import {
  resolveRunAgentContext,
} from './context-resolve';
import { markRunAgentReplaced } from './registry-refresh';

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

export function agentRegistryFile(cwd: string, runId: string): string {
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
export function withAgentRegistryLock(cwd: string, runId: string, mutate: () => void): boolean {
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

interface VerdictAgentConflict {
  role: string;
  agentId: string;
  matchedId: string;
}

export function idsForRunAgent(entry: RunAgentEntry | Rec | null | undefined): string[] {
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

/**
 * Cursor surfaces spawn tool-call ids as `tool_<uuid>` (legacy) or `fc_<call-id>`
 * (3.13.10 sends `subagent_id === tool_call_id`). Neither works with Task `resume`.
 * Misfiling `fc_…` as resume-capable made every continuation overwrite the child's
 * real UUID in agents.json and forge a `new-agent-recorded` history row.
 */
export function isCursorToolSubagentId(id: string): boolean {
  const t = id.trim();
  return /^tool_[0-9a-f-]{8,}$/i.test(t) || /^fc_[A-Za-z0-9_-]{6,}$/.test(t);
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

export function recordRunAgentUnlocked(cwd: string, runId: string, role: string, entry: RunAgentRecordInput): void {
  const registry = obj(readJson(agentRegistryFile(cwd, runId), null)) || {};
  const agents = obj(registry.agents) || {};
  const history = Array.isArray(registry.history) ? registry.history.filter((item) => item && typeof item === 'object') : [];
  const prior = obj(agents[role]);
  const incomingId = entry.agentId.trim();
  const incomingResume = (entry.resumeId && isResumeCapableAgentId(entry.resumeId) ? entry.resumeId.trim() : null)
    || (isResumeCapableAgentId(incomingId) ? incomingId : null);
  const incomingTool = (entry.toolCallId && isCursorToolSubagentId(entry.toolCallId) ? entry.toolCallId.trim() : null)
    || (isCursorToolSubagentId(incomingId) ? incomingId : null);
  // A row explicitly retired via `markRunAgentReplaced` must never lend its ids to
  // the replacement spawn: inheriting them would point continuation at the DEAD
  // agent forever. Only a live prior row carries ids forward.
  const priorLive = prior && prior.replaced !== true ? prior : null;
  const priorResume = priorLive && typeof priorLive.resumeId === 'string' && isResumeCapableAgentId(priorLive.resumeId)
    ? (priorLive.resumeId as string)
    : (priorLive && typeof priorLive.agentId === 'string' && isResumeCapableAgentId(priorLive.agentId as string) ? (priorLive.agentId as string) : null);
  const resumeId = incomingResume || priorResume || null;
  const toolCallId = incomingTool
    || (priorLive && typeof priorLive.toolCallId === 'string' ? (priorLive.toolCallId as string) : null);
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



// Transcript reconciliation knows the failed SubagentStart tool-call id. Retire
// the registry entry only while it still represents that spawn; a delayed child
// transcript must never retire a newer retry that already took over the role.

export { markRunAgentReplaced, markRunAgentReplacedIfMatches, refreshCursorRunAgentFromTranscriptCache } from './registry-refresh';
