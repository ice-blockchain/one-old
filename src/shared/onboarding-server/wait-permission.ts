import * as fs from 'fs';
import * as path from 'path';

import { isNonProjectRoot } from '../authoring-root';
import { obj, type Rec } from '../obj';
import { shellQuote } from '../shell-quote';
import { onboardingWaitScriptPath } from './wait-command';
import { readRegularFileOrThrow } from '../bounded-read';

// Claude Code's auto-mode permission classifier can block the onboarding wait
// command (observed: the first wait attempt right after bootstrap), and the
// command re-runs several times before setup completes with a per-session
// argument tail no exact rule can anticipate. Pre-allow the runner script by
// prefix in the project's .claude/settings.local.json — permission rules are
// evaluated per call, so the rule covers the very next attempt. Merge-preserving
// and best-effort, mirroring ensureAgentTeamsEnv.
export function ensureOnboardingWaitPermission(cwd: string, host: unknown): void {
  if (host !== 'claude') return;
  if (isNonProjectRoot(cwd)) return;
  const rule = `Bash(node ${shellQuote(onboardingWaitScriptPath())}:*)`;
  const file = path.join(cwd, '.claude', 'settings.local.json');
  let settings: Rec = {};
  try {
    const parsed = JSON.parse(readRegularFileOrThrow(file));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as Rec;
  } catch {
    // missing or invalid → start fresh (preserving nothing we can't parse)
  }
  const permissions = obj(settings.permissions) || {};
  const allow = Array.isArray(permissions.allow) ? [...(permissions.allow as unknown[])] : [];
  if (allow.includes(rule)) return;
  allow.push(rule);
  permissions.allow = allow;
  settings.permissions = permissions;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  } catch {
    // unwritable → silent; the user approves the wait command manually
  }
}
