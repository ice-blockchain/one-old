// src/shared/state/run-agent/role-evidence.ts
// Transcript role inference: [t1-role] markers, identity normalization,
// Codex session-meta parsing, and capped head reads.

import { obj } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import {
  VALID_AGENT_ROLES,
} from '../../../config/state';

import {
  firstString,
} from './run-paths';
import { openRegularFd, readRegularFileOrThrow } from '../../bounded-read';

const ROLLOUT_THREAD_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export function transcriptThreadId(transcriptPath: unknown): string | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const base = transcriptPath.replace(/\\/g, '/').split('/').pop() || '';
  const match = base.match(ROLLOUT_THREAD_RE);
  return match ? (match[1] as string).toLowerCase() : null;
}

type RoleEvidenceAuthority = 'authoritative' | 'explicit' | 'heuristic';

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

export function isCorrectionGradeEvidence(
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

export function strongestRoleSource(incoming: unknown, existing: unknown): string | null {
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

interface CodexSessionMetaIdentity {
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
// Replacement suffixes a role name may carry and still bind to the base role: a
// numeric variant (`-2`), or a distinct reattach-dodging name (`_fix_1`, observed
// 15c). Deliberately a CLOSED vocabulary — `senior_architect_helper` is a
// different worker, not the architect, and must still resolve to null.
const ROLE_REPLACEMENT_SUFFIX_RE = /-(?:fix|retry|replacement|replace|redo|rework|rev)(?:-[1-9]\d*)?$/;

export function normalizeRoleIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const leaf = (value.trim().replace(/\\/g, '/').split(/[/:]/).pop() || '').trim().toLowerCase();
  const dashed = leaf.replace(/_/g, '-');
  if (VALID_AGENT_ROLES.has(dashed)) return dashed; // canonical (e.g. quick-fix) wins first
  // Legacy numeric replacement variant: senior-frontend-2.
  const numericStripped = dashed.replace(/-[1-9]\d*$/, '');
  if (numericStripped !== dashed && VALID_AGENT_ROLES.has(numericStripped)) return numericStripped;
  // Named reattach-dodging replacement: a plain same-name Codex respawn is
  // silently reattached to the retired runtime (→ hook-model-conflict), so root
  // spawns `senior_frontend_fix_1` for a genuinely fresh thread — which must
  // still bind to senior-frontend or the fix cycle deadlocks (observed 15c).
  const namedStripped = dashed.replace(ROLE_REPLACEMENT_SUFFIX_RE, '');
  if (namedStripped !== dashed && VALID_AGENT_ROLES.has(namedStripped)) return namedStripped;
  return null;
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
    fd = openRegularFd(filePath);
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
    fd = openRegularFd(filePath);
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
  // 13c/14c-codex: the architect looped on "role not observable" and the whole
  // team was unusable) — recover the role from the SPAWN PROMPT. The prompt is
  // plaintext in current child rollouts, but it is NOT the first user record:
  // the host injects its own context (e.g. `<recommended_plugins>`) as earlier
  // user records, so the marker rides the SECOND+ user record (14c). Scan every
  // readable user record in a head-capped read, but accept ONLY a LINE-ANCHORED
  // `[t1-role: …]` marker (start of a line) — that is the spawn-contract shape
  // and it excludes a marker quoted mid-prose in inherited/echoed context
  // ("Inherited context [t1-role: …]" is not evidence). A line-zero role
  // CONFLICT stays terminal (prose must not outvote contradictory host identity).
  const currentCodexMeta = readCodexSessionMetaIdentity(transcriptPath);
  if (currentCodexMeta && currentCodexMeta.role.kind !== 'none') return currentCodexMeta.role;
  if (currentCodexMeta) {
    const head = readHeadCapped(transcriptPath);
    if (!head) return { kind: 'none' };
    const anchored: RoleEvidence[] = [];
    for (const line of head.split('\n')) {
      if (!line.includes('"user"')) continue; // cheap prefilter before JSON.parse
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const text = userLineText(parsed);
      if (!text) continue;
      ROLE_MARKER_LINE_ANCHORED_RE.lastIndex = 0;
      for (let match = ROLE_MARKER_LINE_ANCHORED_RE.exec(text); match; match = ROLE_MARKER_LINE_ANCHORED_RE.exec(text)) {
        const candidate = roleCandidate(match[1], 'user-role-marker', 'explicit');
        if (candidate) anchored.push(candidate);
      }
    }
    return resolveRoleCandidates(anchored);
  }
  let raw: string;
  try {
    raw = readRegularFileOrThrow(transcriptPath);
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
