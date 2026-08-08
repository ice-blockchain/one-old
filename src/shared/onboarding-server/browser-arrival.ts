// src/shared/onboarding-server/browser-arrival.ts
// Ground truth for "the user actually got the setup link": the wizard server saw
// a real browser arrive.
//
// This replaces the old wizard-links marker, which recorded that some surface
// PRODUCED text containing the URLs — true of the bootstrap's collapsed stdout,
// of agent-facing additionalContext, and of deny reasons the user never reads.
// One invisible producer stamped it and every visible surface then stood down,
// which is how a run could end with the agent saying "link already shared above"
// when no link had ever appeared in the conversation (observed 2cu/5cu).
//
// Only a hit that PROVES a wizard UI loaded counts:
//   - GET /local  — the self-contained loopback wizard
//   - GET /state  — the hosted dashboard's first cross-origin call, which also
//                   proves the hosted page can talk to loopback at all
// Everything else is excluded on purpose:
//   - /healthz          our own liveness probe (runners/onboarding-server/index.ts)
//   - / and /index.html the redirect page; a preview pane or link-unfurler hits it
//   - /favicon.ico      browser chrome, not a user
//   - OPTIONS           CORS preflight, fires before any human sees anything
//   - token-rejected    an unauthenticated caller is not the user's wizard
// Without those exclusions any loopback poke would fabricate permanent silence.
//
// The token-rejected exclusion covers `/local` too, even though that route is
// PUBLIC and renders without a token: every link Traffic One produces carries
// `?t=` (config/dashboard.ts), so a tokenless `/local` is not the user's browser.
// server.ts enforces this — the route being reachable and the request counting as
// arrival are separate questions, and only the second one requires the token.
//
// The sentinel is TTL'd rather than absorbing: a user who opens the tab and walks
// away must be re-offered the link, not left in silence forever.

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

import { serverRecordPath } from './registry';

// Matches the window a setup message stays actionable. Shared by every surface
// so "the wizard is open" means the same thing everywhere.
const WIZARD_OPEN_TTL_MS = 15 * 60 * 1000;

// Refreshing on every single request would rewrite the file on each wizard poll;
// this keeps the mtime meaningfully fresh without the churn.
const REFRESH_INTERVAL_MS = 10 * 1000;

// A qualifying request path. `pathname` only — never the query, which carries the token.
export function isWizardArrivalPath(method: string, pathname: string): boolean {
  if ((method || 'GET').toUpperCase() !== 'GET') return false;
  return pathname === '/local' || pathname === '/state';
}

// The token never appears in the filename — only its digest, so the runtime dir
// cannot leak a live credential through a directory listing. A new server means a
// new token means a new sentinel, so stale evidence can never suppress a fresh
// onboarding.
function arrivalPath(cwd: string, env: NodeJS.ProcessEnv, host: unknown, token: string): string {
  const digest = createHash('sha256').update(token || 'pending', 'utf8').digest('hex').slice(0, 16);
  return path.join(path.dirname(serverRecordPath(cwd, env, host)), `browser-${digest}`);
}

export function noteBrowserArrival(
  cwd: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  host?: unknown,
): void {
  if (!token) return;
  const file = arrivalPath(cwd, env, host, token);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < REFRESH_INTERVAL_MS) return;
  } catch {
    // missing → first arrival
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${new Date().toISOString()}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // best-effort — failing to record arrival only means we keep offering the link
  }
}

// True while a browser demonstrably has the wizard open. Best-effort by design:
// on any error this returns false, so the failure mode is "offer the link again",
// never "go silent".
export function wizardOpenedByUser(
  cwd: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  host?: unknown,
  ttlMs: number = WIZARD_OPEN_TTL_MS,
): boolean {
  if (!token) return false;
  try {
    const stat = fs.statSync(arrivalPath(cwd, env, host, token));
    return Date.now() - stat.mtimeMs < ttlMs;
  } catch {
    return false;
  }
}
