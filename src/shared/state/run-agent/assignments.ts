// src/shared/state/run-agent/assignments.ts
// The per-run write-assignment manifest readers and per-context lookup.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import {  readJson } from '../../fsjson';
import {  type AssignedScope } from '../../scope';
import {
  VALID_AGENT_ROLES,
} from '../../../config/state';
import {
  stackFingerprint,
} from '../materialization';
import {
  readRuntimeAssignments,
} from '../../architecture-contract';

import {
  assignmentsFile,
} from './run-paths';
import {
  type RunAgentContext,
} from './context-resolve';
import {
  tryFallbackClaim,
} from './fallback-claims';

// --- Explicit per-run write assignments (scope manifest) -------------------
// The architect authors .traffic-one/runs/<runId>/assignments.json: a disjoint
// partition of the writable surface into role-owned scopes. The run-team gate reads
// it to allow/deny feature-source writes by ASSIGNED SCOPE rather than by guessed
// path-kind. Any feature path outside every assignment is governed by tryFallbackClaim,
// so the gate can never hard-deadlock. Roles here are free-form (NOT validated against
// VALID_AGENT_ROLES) so future streams (e.g. senior-mobile) are purely additive.

interface AssignmentEntry {
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
  schemaVersion?: number;
  architectureHash?: string;
  verificationHash?: string;
  assignmentsHash?: string;
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
  if (raw.createdBy === 'traffic-one-runtime' && !readRuntimeAssignments(cwd, runId)) return null;
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
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : undefined,
    architectureHash: typeof raw.architectureHash === 'string' ? raw.architectureHash : undefined,
    verificationHash: typeof raw.verificationHash === 'string' ? raw.verificationHash : undefined,
    assignmentsHash: typeof raw.assignmentsHash === 'string' ? raw.assignmentsHash : undefined,
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
  if (typeof preferredRunId === 'string' && preferredRunId) {
    // A compiled run has exact, runtime-owned assignments. Missing/corrupt
    // evidence must fail closed rather than borrowing a stale manifest from a
    // sibling run id.
    const compiled = path.join(cwd, '.traffic-one', 'runs', preferredRunId, 'architecture-v1.json');
    if (fs.existsSync(compiled)) return null;
  }
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
