// src/shared/auth/simple-auth.ts
// The wizard-validated API-key gate. The key is entered on the onboarding
// wizard's api-key page and stored as the `auth` section of the secure canonical
// ~/.traffic-one/one.json envelope.
//
// The key is VALIDATED at intake against the auth endpoint before it is stored
// (runners/auth/validate-key.ts, wired into the wizard's /answer route) — a
// rejected/unverifiable key is never written. Anonymous public MCP config and
// report calls never carry or invalidate this credential.

import { deleteOneSection, readCanonicalOneSettings, writeOneSection } from '../one-settings';
import { nowIsoNoMs } from '../text';

const SIMPLE_AUTH_VERSION = 1;

interface SimpleAuth {
  authenticated: true;
  apiKey: string;
  updatedAt: string;
}

export function readSimpleAuth(env: NodeJS.ProcessEnv = process.env): SimpleAuth | null {
  const canonical = readCanonicalOneSettings(env);
  if (!canonical.ok) return null;
  const raw = canonical.settings.auth;
  if (!raw) return null;
  return {
    authenticated: raw.authenticated,
    apiKey: raw.apiKey,
    updatedAt: raw.updatedAt,
  };
}

// The gate predicate: true once the key has been entered and not since invalidated.
export function isLocallyAuthenticated(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSimpleAuth(env)?.authenticated === true;
}

// Store a key after the wizard route validates it through MCP tools/list.
export function writeSimpleAuth(apiKey: string, env: NodeJS.ProcessEnv = process.env): void {
  const key = String(apiKey || '').trim();
  if (!key) throw new TypeError('Traffic One API key must not be empty');
  writeOneSection('auth', {
    version: SIMPLE_AUTH_VERSION,
    authenticated: true,
    apiKey: key,
    updatedAt: nowIsoNoMs(),
  }, env);
}

// Invalidate only the auth section so hosts and code-graph settings survive
// and the wizard reopens.
// Return false when another writer prevents a safe locked update; callers must
// surface that failure instead of silently continuing to trust the rejected key.
export function clearAuthentication(env: NodeJS.ProcessEnv = process.env): boolean {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (deleteOneSection('auth', env)) return true;
    } catch {
      // Retry the bounded canonical lock. Never bypass it and risk clobbering
      // hosts/code-graph settings written by another process.
    }
  }
  return false;
}
