// src/shared/auth/index.ts
// Offline auth-state READ service (the foundation every gate checks). Ported 1:1
// from scripts/traffic-one-auth/* (the read/freshness half). The write/login/
// credential-store/MCP client lives with the auth CLI runner (Step 5).

import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { readJson } from '../fsjson';
import { pluginRoot } from '../paths';

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787/mcp';
export const AUTH_STATE_VERSION = 1;
export const EXPIRY_SKEW_MS = 30 * 1000;
export const REMOTE_AUTH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const FRESHNESS_REASON = {
  OK: 'ok',
  MISSING: 'missing-auth-state',
  VERSION_MISMATCH: 'version-mismatch',
  MALFORMED_TOKEN: 'malformed-token',
  MALFORMED_EXPIRY: 'malformed-expiry',
  ENDPOINT_MISMATCH: 'endpoint-mismatch',
  EXPIRED: 'expired',
} as const;

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
  if (ipVersion === 4) return host === '0.0.0.0' || host.startsWith('127.');
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

export function authStatePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TRAFFIC_ONE_AUTH_STATE_PATH) return path.resolve(env.TRAFFIC_ONE_AUTH_STATE_PATH);
  const base = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'traffic-one')
    : path.join(env.HOME || os.homedir(), '.traffic-one');
  return path.join(base, 'auth.json');
}

export function readAuthState(env: NodeJS.ProcessEnv = process.env): AuthState | null {
  return readJson<AuthState | null>(authStatePath(env), null);
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

export function authRemoteCheckDue(state: AuthState | null = readAuthState(), env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): boolean {
  if (!isAuthStateFresh(state, env, nowMs)) return false;
  const lastChecked = Date.parse((state && typeof state.lastRemoteCheckedAt === 'string' ? state.lastRemoteCheckedAt : '') || '');
  return !Number.isFinite(lastChecked) || nowMs - lastChecked >= REMOTE_AUTH_CHECK_INTERVAL_MS;
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
