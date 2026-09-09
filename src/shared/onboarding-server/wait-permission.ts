import * as fs from 'fs';
import * as path from 'path';

import { isNonProjectRoot } from '../authoring-root';
import { readRegularFileResult } from '../bounded-read';
import { obj, type Rec } from '../obj';
import { shellQuote } from '../shell-quote';
import { projectWritesPermitted } from '../state/plugin-use';
import { onboardingWaitScriptPath } from './wait-command';

// Claude Code's auto-mode permission classifier can block the onboarding wait
// command (observed: the first wait attempt right after bootstrap), and the
// command re-runs several times before setup completes with a per-session
// argument tail no exact rule can anticipate. Pre-allow the runner script by
// prefix in the project's .claude/settings.local.json — permission rules are
// evaluated per call, so the rule covers the very next attempt. Merge-preserving
// and best-effort, mirroring ensureAgentTeamsEnv.
//
// This path is NOT under `.traffic-one/`, so fsjson classifies it `plain` and
// the path fence does not apply. Consent here is an explicit
// projectWritesPermitted check. An existing file that cannot be parsed is left
// untouched — overwriting it would destroy bytes we could not read.

function waitPermissionRule(): string {
  return `Bash(node ${shellQuote(onboardingWaitScriptPath())}:*)`;
}

function settingsFile(cwd: string): string {
  return path.join(cwd, '.claude', 'settings.local.json');
}

type SettingsRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'ok'; readonly settings: Rec };

function readSettingsForUpdate(file: string): SettingsRead {
  const read = readRegularFileResult(file);
  if (read.kind === 'absent') return { kind: 'absent' };
  if (read.kind === 'unreadable') return { kind: 'skip' };
  try {
    const parsed = JSON.parse(read.text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'skip' };
    return { kind: 'ok', settings: parsed as Rec };
  } catch {
    return { kind: 'skip' };
  }
}

function writeSettingsFile(file: string, settings: Rec): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  } catch {
    // unwritable → silent; the user approves the wait command manually
  }
}

export function ensureOnboardingWaitPermission(cwd: string, host: unknown): void {
  if (host !== 'claude') return;
  if (isNonProjectRoot(cwd)) return;
  if (!projectWritesPermitted(cwd)) return;
  const rule = waitPermissionRule();
  const file = settingsFile(cwd);
  const read = readSettingsForUpdate(file);
  if (read.kind === 'skip') return;
  const settings: Rec = read.kind === 'ok' ? read.settings : {};
  const permissions = obj(settings.permissions) || {};
  const allow = Array.isArray(permissions.allow) ? [...(permissions.allow as unknown[])] : [];
  if (allow.includes(rule)) return;
  allow.push(rule);
  permissions.allow = allow;
  settings.permissions = permissions;
  writeSettingsFile(file, settings);
}

// Decline cleanup: remove the rule we may have written. Not gated on
// projectWritesPermitted — after a recorded no that fence is closed, and this
// is the one write that must still run. Host-agnostic: the file is Claude's
// even when `--decline` ran on another host. Parse failure leaves the file.
export function stripOnboardingWaitPermission(cwd: string): void {
  if (isNonProjectRoot(cwd)) return;
  const rule = waitPermissionRule();
  const file = settingsFile(cwd);
  const read = readSettingsForUpdate(file);
  if (read.kind !== 'ok') return;
  const permissions = obj(read.settings.permissions);
  if (!permissions || !Array.isArray(permissions.allow)) return;
  const allow = permissions.allow as unknown[];
  const next = allow.filter((entry) => entry !== rule);
  if (next.length === allow.length) return;
  permissions.allow = next;
  read.settings.permissions = permissions;
  try {
    fs.writeFileSync(file, `${JSON.stringify(read.settings, null, 2)}\n`, 'utf8');
  } catch {
    // unwritable → silent
  }
}
