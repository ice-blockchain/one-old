// src/shared/state/run-agent/host-liveness.ts
// Host-identity probes for the three reuse stand-down hosts, on the
// validateCodexLiveRunAgent model: corroborate a recorded agent against
// something the HOST wrote, never against orchestrator-authored spawn text.
//
//   - OpenCode / Kilo: on-disk session storage
//     `$XDG_DATA_HOME|<home>/.local/share/<host>/storage/session/{projectID}/{sessionID}.json`
//     (the published legacy JSON layout). SQLite `opencode.db` is a residual —
//     this runtime is dependency-free and has no recorded sqlite fixture.
//   - Windsurf: the host-supplied `trajectory_id` already on the hook payload
//     (empty is the synthetic Devin Cascade duplicate, not evidence).
//
// A host leaves HOSTS_WITHOUT_VERIFIABLE_REUSE in registry.ts only when a
// live-captured fixture pins its probe. The files under tests/fixtures/host-liveness/
// document the published layouts and pin this module; they are not live captures,
// so the three hosts stay listed.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { obj, type Rec } from '../../obj';
import { SUBAGENT_STALE_MS } from '../../../config/state';
import { readJson } from '../../fsjson';

import { firstString } from './run-paths';
import { idsForRunAgent, type RunAgentEntry } from './registry';
import { timestampAgeMs } from './session-identity';

export type HostLiveAgentValidation =
  | { status: 'verified-match'; entry: RunAgentEntry }
  | { status: 'stale-retired'; entry: RunAgentEntry; reason: string }
  | { status: 'unverified'; entry: RunAgentEntry; reason: string }
  | { status: 'conflict'; entry: RunAgentEntry; reason: string };

const SESSION_WALK_CAP = 256;

export function openCodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = firstString(env.OPENCODE_DATA_DIR)?.split(',')[0]?.trim();
  if (explicit) return explicit;
  return path.join(xdgDataHome(env), 'opencode');
}

export function kiloDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = firstString(env.KILO_DATA_DIR, env.KILO_HOME);
  if (explicit) return explicit;
  return path.join(xdgDataHome(env), 'kilo');
}

function xdgDataHome(env: NodeJS.ProcessEnv): string {
  return firstString(env.XDG_DATA_HOME) || path.join(os.homedir(), '.local', 'share');
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate a JSON session file for `sessionId` under the host data root.
 * Layout pinned by tests/fixtures/host-liveness/{opencode,kilo}-session.json.
 */
export function findHostSessionFile(dataRoot: string, sessionId: string): string | null {
  if (!sessionId) return null;
  const sessionRoot = path.join(dataRoot, 'storage', 'session');
  const direct = path.join(sessionRoot, `${sessionId}.json`);
  if (isFile(direct)) return direct;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  let scanned = 0;
  for (const entry of entries) {
    if (scanned >= SESSION_WALK_CAP) break;
    if (!entry.isDirectory()) continue;
    scanned += 1;
    const nested = path.join(sessionRoot, entry.name, `${sessionId}.json`);
    if (isFile(nested)) return nested;
  }
  return null;
}

export function readHostSessionRecord(file: string): Rec | null {
  return obj(readJson(file, null));
}

function sessionParentId(session: Rec): string | null {
  return firstString(session.parentID, session.parentId, session.parent_id, session.parent);
}

function sessionUpdatedMs(session: Rec): number {
  const time = obj(session.time);
  const updated = time && typeof time.updated === 'number' ? time.updated : NaN;
  if (Number.isFinite(updated) && updated > 0) return updated;
  const created = time && typeof time.created === 'number' ? time.created : NaN;
  return Number.isFinite(created) && created > 0 ? created : NaN;
}

function validateSessionStore(
  dataRoot: string,
  entry: RunAgentEntry,
  nowMs: number,
): HostLiveAgentValidation {
  const ids = idsForRunAgent(entry).filter(Boolean);
  if (ids.length === 0) return { status: 'unverified', entry, reason: 'host-session-id-missing' };

  let found: { file: string; session: Rec; id: string } | null = null;
  for (const id of ids) {
    const file = findHostSessionFile(dataRoot, id);
    if (!file) continue;
    const session = readHostSessionRecord(file);
    if (!session) return { status: 'unverified', entry, reason: 'host-session-unreadable' };
    found = { file, session, id };
    break;
  }
  if (!found) return { status: 'unverified', entry, reason: 'host-session-missing' };

  const recordedId = firstString(found.session.id) || path.basename(found.file, '.json');
  if (recordedId.toLowerCase() !== found.id.toLowerCase()) {
    return { status: 'conflict', entry, reason: 'host-session-id-mismatch' };
  }

  const parent = sessionParentId(found.session);
  if (parent && entry.parentSessionId && parent !== entry.parentSessionId) {
    return { status: 'conflict', entry, reason: 'host-session-parent-mismatch' };
  }

  const updatedMs = sessionUpdatedMs(found.session);
  if (Number.isFinite(updatedMs) && nowMs - updatedMs > SUBAGENT_STALE_MS) {
    return { status: 'stale-retired', entry, reason: 'host-session-stale' };
  }
  if (!Number.isFinite(updatedMs) && timestampAgeMs(entry.recordedAt) > SUBAGENT_STALE_MS) {
    return { status: 'stale-retired', entry, reason: 'host-session-recorded-stale' };
  }
  return { status: 'verified-match', entry };
}

export function validateOpenCodeLiveRunAgent(
  entry: RunAgentEntry,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): HostLiveAgentValidation {
  return validateSessionStore(openCodeDataDir(env), entry, nowMs);
}

export function validateKiloLiveRunAgent(
  entry: RunAgentEntry,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): HostLiveAgentValidation {
  return validateSessionStore(kiloDataDir(env), entry, nowMs);
}

export function windsurfTrajectoryId(rawInput: unknown): string | null {
  const raw = obj(rawInput) || {};
  const payload = obj(raw.payload) || {};
  return firstString(
    raw.trajectory_id, raw.trajectoryId,
    payload.trajectory_id, payload.trajectoryId,
  );
}

export function windsurfTrajectoryPresent(rawInput: unknown): boolean {
  const raw = obj(rawInput) || {};
  const payload = obj(raw.payload) || {};
  return Object.prototype.hasOwnProperty.call(raw, 'trajectory_id')
    || Object.prototype.hasOwnProperty.call(raw, 'trajectoryId')
    || Object.prototype.hasOwnProperty.call(payload, 'trajectory_id')
    || Object.prototype.hasOwnProperty.call(payload, 'trajectoryId');
}

/**
 * Windsurf / Cascade: the host stamps `trajectory_id` on genuine sessions.
 * An explicitly present empty id is the synthetic Devin bridge (windsurf-entry.ts)
 * and is not identity. A recorded row is corroborated only when the live
 * payload's trajectory matches the one stored on the row.
 */
export function validateWindsurfLiveRunAgent(
  entry: RunAgentEntry,
  rawInput: unknown,
): HostLiveAgentValidation {
  const present = windsurfTrajectoryPresent(rawInput);
  const trajectory = windsurfTrajectoryId(rawInput);
  if (present && !trajectory) {
    return { status: 'unverified', entry, reason: 'windsurf-trajectory-synthetic' };
  }
  if (!trajectory) {
    return { status: 'unverified', entry, reason: 'windsurf-trajectory-missing' };
  }
  const recorded = firstString(entry.trajectoryId, entry.parentSessionId);
  if (!recorded) {
    return { status: 'unverified', entry, reason: 'windsurf-trajectory-unrecorded' };
  }
  if (recorded !== trajectory) {
    return { status: 'conflict', entry, reason: 'windsurf-trajectory-mismatch' };
  }
  if (timestampAgeMs(entry.recordedAt) > SUBAGENT_STALE_MS) {
    return { status: 'stale-retired', entry, reason: 'windsurf-trajectory-stale' };
  }
  return { status: 'verified-match', entry };
}

export function validateHostLiveRunAgent(
  host: string,
  entry: RunAgentEntry,
  rawInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): HostLiveAgentValidation | null {
  if (host === 'opencode') return validateOpenCodeLiveRunAgent(entry, env, nowMs);
  if (host === 'kilo') return validateKiloLiveRunAgent(entry, env, nowMs);
  if (host === 'windsurf') return validateWindsurfLiveRunAgent(entry, rawInput);
  return null;
}
