// src/shared/auth/index.ts
// Offline auth-state READ service (the foundation every gate checks). Ported 1:1
// from scripts/traffic-one-auth/* (the read/freshness half). The write/login/
// credential-store/MCP client lives with the auth CLI runner (Step 5).

import * as net from 'net';
import * as path from 'path';

import {
  AUTH_ENABLED,
  AUTH_STATE_VERSION,
  DEFAULT_ENDPOINT,
  EXPIRY_SKEW_MS,
  FRESHNESS_REASON,
  REFRESH_BACKOFF_CAP_MS,
  REFRESH_FAILURE_THRESHOLD,
  REMOTE_AUTH_CHECK_INTERVAL_MS,
} from '../../config/auth';
import { oneSettingsPath, readOneSettings } from '../one-settings';
import { pluginRoot } from '../paths';

export type AuthState = Record<string, unknown>;
export interface Freshness {
  fresh: boolean;
  reason: string;
}

// Absolute path to the compiled auth CLI (legacy path preserved at cutover).
function entryFilename(): string {
  return path.join(pluginRoot(), 'scripts', 'traffic-one-auth.cjs');
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  const ipVersion = net.isIP(host);
  // 0.0.0.0 is the wildcard address, not loopback — it has no legitimate
  // client-connect use that 127.0.0.1 doesn't cover, so keep the plaintext-HTTP
  // exception to genuine loopback only.
  if (ipVersion === 4) return host.startsWith('127.');
  if (ipVersion === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1';
  return host === 'localhost' || host === 'localhost.';
}

export function authEndpointUrl(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid Traffic One MCP auth endpoint: ${endpoint}`);
  }
  if (url.username || url.password) {
    throw new Error('Traffic One MCP auth endpoint must not include URL credentials.');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url;
  throw new Error('Refusing to send Traffic One credentials to a non-HTTPS MCP auth endpoint. Use HTTPS for remote endpoints; HTTP is allowed only for loopback local development.');
}

export function endpointFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRAFFIC_ONE_MCP_KEY_ENDPOINT || DEFAULT_ENDPOINT;
}

// The auth session now lives in the `auth` section of the consolidated one.json
// (see shared/one-settings). authStatePath returns that file so the auth-required
// message + auth-choice path derivation keep pointing at the right place.
export function authStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return oneSettingsPath(env);
}

export function readAuthState(env: NodeJS.ProcessEnv = process.env): AuthState | null {
  return (readOneSettings(env).auth as AuthState | null) ?? null;
}

// Precise reason a stored session is (not) usable. Endpoint mismatch is reported
// ahead of expiry because it signals a config problem rather than the ordinary
// recoverable "timed out" case.
export function authStateFreshness(state: unknown, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): Freshness {
  if (!state || typeof state !== 'object') return { fresh: false, reason: FRESHNESS_REASON.MISSING };
  const s = state as AuthState;
  if (s.version !== AUTH_STATE_VERSION) return { fresh: false, reason: FRESHNESS_REASON.VERSION_MISMATCH };
  if (typeof s.sessionToken !== 'string' || !s.sessionToken.startsWith('tok_')) {
    return { fresh: false, reason: FRESHNESS_REASON.MALFORMED_TOKEN };
  }
  if (typeof s.expiresAt !== 'string') return { fresh: false, reason: FRESHNESS_REASON.MALFORMED_EXPIRY };
  const expires = Date.parse(s.expiresAt);
  if (!Number.isFinite(expires)) return { fresh: false, reason: FRESHNESS_REASON.MALFORMED_EXPIRY };
  if (s.endpoint !== endpointFromEnv(env)) return { fresh: false, reason: FRESHNESS_REASON.ENDPOINT_MISMATCH };
  if (expires - EXPIRY_SKEW_MS <= nowMs) return { fresh: false, reason: FRESHNESS_REASON.EXPIRED };
  return { fresh: true, reason: FRESHNESS_REASON.OK };
}

export function isAuthStateFresh(state: unknown, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): boolean {
  return authStateFreshness(state, env, nowMs).fresh;
}

export function isAuthenticatedLocal(env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): boolean {
  return isAuthStateFresh(readAuthState(env), env, nowMs);
}

// Effective auth ENFORCEMENT: committed default (config/auth AUTH_ENABLED),
// overridable per-process via TRAFFIC_ONE_AUTH (1/true/on → enforce, 0/false/off
// → bypass) for ops + tests. When auth is NOT enforced, callers may treat the
// user as authenticated (e.g. the one-mcp report fires in AUTH_ENABLED=false dev/
// test runs). Re-exported from session/auth-gate for back-compat.
export function authEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  const o = (env.TRAFFIC_ONE_AUTH ?? '').trim().toLowerCase();
  if (o === '1' || o === 'true' || o === 'on' || o === 'yes') return true;
  if (o === '0' || o === 'false' || o === 'off' || o === 'no') return false;
  return AUTH_ENABLED;
}

export function authRemoteCheckDue(state: AuthState | null = readAuthState(), env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): boolean {
  if (!isAuthStateFresh(state, env, nowMs)) return false;
  const lastChecked = Date.parse((state && typeof state.lastRemoteCheckedAt === 'string' ? state.lastRemoteCheckedAt : '') || '');
  return !Number.isFinite(lastChecked) || nowMs - lastChecked >= REMOTE_AUTH_CHECK_INTERVAL_MS;
}

// ── Silent-refresh backoff (pure; read the persisted auth state) ──────────────
export function refreshFailureCount(state: AuthState | null): number {
  const n = state && typeof state.refreshFailures === 'number' ? state.refreshFailures : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Exponential backoff for the Nth consecutive refresh failure: 2s, 4s, 8s, 16s,
// 32s, then capped. Keeps silent retries from hammering the endpoint or stalling
// every hook on the remote-check timeout.
export function refreshBackoffMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures) || 1);
  return Math.min(2 ** n * 1000, REFRESH_BACKOFF_CAP_MS);
}

// True while the next silent refresh attempt is still backing off — skip the
// remote call and keep the user on the last-known session in the meantime.
export function refreshBackoffActive(state: AuthState | null, nowMs = Date.now()): boolean {
  const next = Date.parse((state && typeof state.nextRefreshAt === 'string' ? state.nextRefreshAt : '') || '');
  return Number.isFinite(next) && nowMs < next;
}

// True once silent refresh has failed MORE than the threshold — stop retrying
// and prompt the user to re-authenticate.
export function refreshAttemptsExhausted(state: AuthState | null): boolean {
  return refreshFailureCount(state) > REFRESH_FAILURE_THRESHOLD;
}

export function isTrafficOneAuthCommand(command: unknown): boolean {
  const c = String(command || '');
  return /\bscripts\/traffic-one-auth\.cjs\b/.test(c) && /\b(login|refresh|status|logout)\b/.test(c);
}

export function isTrafficOneDoctorCommand(command: unknown): boolean {
  return /\bscripts\/doctor\.cjs\b/.test(String(command || ''));
}

export function authRequiredMessage(env: NodeJS.ProcessEnv = process.env): string {
  const endpoint = endpointFromEnv(env);
  const entry = entryFilename();
  return [
    'Traffic One authentication is required before this plugin can be used.',
    '',
    'Ask the user with a modal selector before continuing:',
    '  - Authenticate Traffic One (Recommended)',
    '  - Continue without Traffic One',
    '',
    'If the user chooses Authenticate Traffic One, ask for the API key using a secure host input/modal and stop. When the user submits the key, the hook runs login + status internally and stores the API key in the OS credential manager when available.',
    'Do NOT call the exposed mcp-auth MCP tools (`mcp__mcp_auth__auth_status`, `mcp__mcp_auth__refresh`, `mcp__mcp_auth__authenticate`, or `mcp__mcp_auth__logout`) for routine auth gate checks. The hook/auth client performs status and refresh silently behind the scenes.',
    `Hook-internal script: ${entry}. Do not run it yourself, do not use a cwd-relative path, and do not search the filesystem for a copy; a found copy may be stale or point at an outdated endpoint.`,
    'If a stored session expires, the auth client will try `refresh` with the OS credential manager key.',
    'Do not ask the user to run bash or shell commands for Traffic One authentication.',
    'If the user chooses Continue without Traffic One, remember that choice for the current project while it remains active and continue without Traffic One features.',
    `Endpoint: ${endpoint}`,
    `Script: ${entry}`,
    `Auth state: ${authStatePath(env)}`,
  ].join('\n');
}
