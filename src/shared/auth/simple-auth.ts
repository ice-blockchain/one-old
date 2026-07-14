// src/shared/auth/simple-auth.ts
// The simple, web-entered API-key auth model. Replaces the retired session-token /
// keychain / remote-refresh flow: the key is entered once on the onboarding
// wizard's api-key page and stored in its OWN small local file — auth.json beside
// one.json (~/.traffic-one/auth.json by default) — NOT as a section of the
// consolidated one.json. Entering the key must never create the full one.json:
// that file exists to share cross-project settings (codeGraphProvider etc.), and
// root-level cross-project files are exactly what leaks state between projects.
// The record is flat `{ version, authenticated, apiKey, updatedAt }`, written
// 0o600; the key is a telemetry / "make the plugin better" key, not a security
// secret, so plaintext-at-rest under a 0o600 file is acceptable.
//
// The key is VALIDATED at intake against the auth endpoint before it is stored
// (runners/auth/validate-key.ts, wired into the wizard's /answer route) — a
// rejected/unverifiable key is never written. `authenticated` is additionally
// flipped back to false on a 401 from the one-mcp report call (secondary safety;
// see runners/one-mcp-report/runReport.ts), which re-opens the api-key page on the
// next session (computeOnboarding returns the 'api-key' step while unauthenticated).

import * as fs from 'fs';
import * as path from 'path';

import { readJson } from '../fsjson';
import { oneSettingsPath } from '../one-settings';
import {
  PROJECT_LOCAL_MACHINE_REL,
  ensureProjectLocalTrafficOneGitignore,
} from '../state/traffic-one-paths';
import { nowIsoNoMs } from '../text';

export const SIMPLE_AUTH_VERSION = 1;

export interface SimpleAuth {
  authenticated: boolean;
  apiKey: string;
  updatedAt: string;
}

// auth.json lives NEXT TO one.json (same settings dir), so every existing state
// isolation (TRAFFIC_ONE_STATE_PATH / TRAFFIC_ONE_AUTH_STATE_PATH, XDG_STATE_HOME,
// the unwritable-home project-local fallback) isolates the auth file for free —
// tests and Electron hosts never point auth at the real ~/.traffic-one by accident.
export function simpleAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(oneSettingsPath(env)), 'auth.json');
}

export function readSimpleAuth(env: NodeJS.ProcessEnv = process.env): SimpleAuth | null {
  const raw = readJson<Record<string, unknown> | null>(simpleAuthPath(env), null);
  if (!raw || typeof raw !== 'object') return null;
  return {
    authenticated: raw.authenticated === true,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

// The gate predicate: true once the key has been entered and not since invalidated.
export function isLocallyAuthenticated(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSimpleAuth(env)?.authenticated === true;
}

// 0700 dir + 0600 file, atomic (temp + rename) — same discipline as the other
// secure state writers, so a concurrent reader never sees a torn record.
function writeAuthFile(filePath: string, value: SimpleAuth): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: SIMPLE_AUTH_VERSION, ...value }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort; some filesystems ignore chmod
  }
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

// Under the unwritable-home fallback the settings dir is the PROJECT's
// .traffic-one/ — the plaintext key must never become committable, so mirror the
// gitignore-ensure one-settings performs on its own project-local writes.
function ensureGitignoreForProjectLocal(env: NodeJS.ProcessEnv, authPath: string): void {
  const oneNormalized = oneSettingsPath(env).replace(/\\/g, '/');
  if (oneNormalized.endsWith(`/${PROJECT_LOCAL_MACHINE_REL.replace(/\\/g, '/')}`)) {
    ensureProjectLocalTrafficOneGitignore(path.dirname(path.dirname(authPath)));
  }
}

// Store the entered key and mark authenticated. Called from the wizard's api-key
// answer (shared/onboarding-server/flow.ts).
export function writeSimpleAuth(apiKey: string, env: NodeJS.ProcessEnv = process.env): void {
  const authPath = simpleAuthPath(env);
  writeAuthFile(authPath, { authenticated: true, apiKey: String(apiKey || ''), updatedAt: nowIsoNoMs() });
  ensureGitignoreForProjectLocal(env, authPath);
}

// Flip `authenticated` → false on a 401, PRESERVING the stored key (a transient
// 401 shouldn't wipe it, and the api-key page can prefill it). Resilient to a
// missing file — this runs from the detached one-mcp report worker.
export function clearAuthentication(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const current = readSimpleAuth(env);
    writeAuthFile(simpleAuthPath(env), { authenticated: false, apiKey: current?.apiKey ?? '', updatedAt: nowIsoNoMs() });
  } catch {
    // best-effort
  }
}
