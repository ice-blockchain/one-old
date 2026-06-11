// src/shared/opencode-roles.ts
// Role-based OpenCode delegation: which senior subagent roles run on the free
// OpenCode agent instead of a paid subagent. Single source of truth for reading
// the configurable `openCode.delegateRoles` array + the per-run "already tried"
// marker the spawn gate uses to allow a fallback spawn after OpenCode declines.

import * as fs from 'fs';
import * as path from 'path';

import { DEFAULT_OPENCODE_DELEGATE_ROLES } from '../config/opencode';
import { obj } from './obj';

type Rec = Record<string, unknown>;

// The configured roles, sanitized. Falls back to the default array when unset or
// malformed, so a typo can't silently disable delegation.
export function openCodeDelegateRoles(state: unknown): string[] {
  const oc = obj(obj(state)?.openCode);
  const raw = oc?.delegateRoles;
  if (Array.isArray(raw)) {
    const cleaned = raw.filter((r): r is string => typeof r === 'string' && r.trim().length > 0).map((r) => r.trim());
    return cleaned.length > 0 ? cleaned : [];
  }
  return [...DEFAULT_OPENCODE_DELEGATE_ROLES];
}

// Is OpenCode delegation enabled at all? (CLI presence is checked by the runner,
// which falls back gracefully; eligibility for the gate is just the opt-in.)
export function openCodeEnabled(state: unknown): boolean {
  return obj(obj(state)?.openCode)?.enabled === true;
}

// Should this role run on OpenCode rather than a paid subagent? Host-agnostic:
// OpenCode is a locally-installed CLI invoked the same way on every host, so the
// only gate is the user's opt-in plus the role being in the configured set.
export function shouldRunRoleOnOpenCode(role: string, state: unknown): boolean {
  if (!role || !openCodeEnabled(state)) return false;
  return openCodeDelegateRoles(state).includes(role);
}

// Per-run marker that an OpenCode delegation reached the CLI for a role. The
// runner intentionally writes this only after setup/preconditions pass; sandbox
// worktree failures and host-policy rejections are not real OpenCode attempts.
// The spawn gate denies a configured role's paid spawn until this exists, then
// allows the fallback spawn once OpenCode has tried.
function attemptMarkerPath(cwd: string, runId: string, role: string): string {
  const safe = role.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-attempts', safe);
}

export function markOpenCodeRoleAttempted(cwd: string, runId: string, role: string): void {
  if (!runId || !role) return;
  try {
    const p = attemptMarkerPath(cwd, runId, role);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
  } catch {
    // best-effort; a missing marker only means one extra (harmless) gate nudge
  }
}

export function openCodeRoleAttempted(cwd: string, runId: string, role: string): boolean {
  if (!runId || !role) return false;
  try {
    return fs.existsSync(attemptMarkerPath(cwd, runId, role));
  } catch {
    return false;
  }
}

// Per-run marker that the GATE has already denied a paid spawn of this role
// once. The deny → delegate → re-spawn loop assumes the delegate tool CAN run;
// on Codex the host's safety reviewer can reject the opencode_delegate call
// ABOVE our code, so the runner's attempt marker is never written and a
// marker-only gate would deadlock (delegate blocked by the reviewer, spawn
// blocked by the gate). Host rejection is not an OpenCode attempt; it is a
// policy fallback. The gate therefore denies a (runId, role) at most ONCE: it
// records the denial here and lets the second spawn attempt through.
function denyMarkerPath(cwd: string, runId: string, role: string): string {
  const safe = role.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(cwd, '.traffic-one', 'runs', runId, 'opencode-gate-denies', safe);
}

export function markOpenCodeGateDenied(cwd: string, runId: string, role: string): void {
  if (!runId || !role) return;
  try {
    const p = denyMarkerPath(cwd, runId, role);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf8');
  } catch {
    // best-effort; a missing marker only risks one extra deny, never a deadlock
  }
}

export function openCodeGateDenied(cwd: string, runId: string, role: string): boolean {
  if (!runId || !role) return false;
  try {
    return fs.existsSync(denyMarkerPath(cwd, runId, role));
  } catch {
    return false;
  }
}
