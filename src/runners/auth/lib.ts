// src/runners/auth/lib.ts
// Auth state write side + key resolution + session-result persistence for the
// Traffic One auth CLI. The read side (paths, freshness, endpoint) is reused
// from shared/auth; the auth-choice state ops come from the session module
// (its canonical owner). Ported 1:1 from scripts/traffic-one-auth/{_helpers,
// writeAuthState,deleteAuthState}.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { deleteAuthChoiceState } from '../../modules/session/auth-choice';
import { AUTH_STATE_VERSION, REFRESH_FAILURE_THRESHOLD } from '../../config/auth';
import {
  authStatePath,
  refreshBackoffMs,
  refreshFailureCount,
} from '../../shared/auth';
import { nowIsoNoMs } from '../../shared/text';
import {
  type CredentialRef,
  type CredentialResult,
  credentialRefFor,
  readCredential,
  storeCredential,
} from './credential-store';

type Rec = Record<string, unknown>;

export function writeAuthState(state: Rec, env: NodeJS.ProcessEnv = process.env): string {
  const filePath = authStatePath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort; some filesystems ignore chmod.
  }
  return filePath;
}

export function deleteAuthState(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    fs.rmSync(authStatePath(env), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function isRemoteAuthRejection(error: unknown): boolean {
  const e = error as { statusCode?: number } | null;
  return Boolean(e && (e.statusCode === 401 || e.statusCode === 403));
}

// Node throws an AggregateError with an empty `.message` when a dual-stack
// `localhost` connection is refused on both ::1 and 127.0.0.1. Surface a useful
// string in that case so a failure is never opaque.
export function errorMessage(error: unknown): string {
  if (!error) return '';
  const e = error as { message?: string; errors?: unknown[]; code?: string };
  if (e.message) return e.message;
  if (Array.isArray(e.errors) && e.errors.length) {
    return e.errors.map((sub) => (sub && (sub as { message?: string }).message) || String(sub)).join('; ');
  }
  if (e.code) return String(e.code);
  return String(error);
}

export function stampRemoteCheck(state: Rec, patch: Rec, env: NodeJS.ProcessEnv = process.env): string {
  const next = { ...state, ...patch, lastRemoteCheckedAt: nowIsoNoMs() };
  return writeAuthState(next, env);
}

export interface RefreshFailureRecord { failures: number; exhausted: boolean; }

// Record a failed SILENT refresh: bump the consecutive-failure count and arm the
// exponential backoff, WITHOUT discarding the session token or credentialRef.
// Keeping them means the next attempt can retry from the keychain, and an
// exhausted state still reads as EXPIRED (→ the "re-authenticate" prompt, not the
// first-time auth gate). A successful (re)auth writes a fresh state via
// writeSessionResult, which omits these fields and so resets the counter to zero.
export function recordRefreshFailure(state: Rec | null, env: NodeJS.ProcessEnv = process.env): RefreshFailureRecord {
  const failures = refreshFailureCount(state) + 1;
  if (state && typeof state === 'object') {
    const next: Rec = {
      ...state,
      refreshFailures: failures,
      nextRefreshAt: new Date(Date.now() + refreshBackoffMs(failures)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      lastRefreshFailureAt: nowIsoNoMs(),
    };
    writeAuthState(next, env);
  }
  return { failures, exhausted: failures > REFRESH_FAILURE_THRESHOLD };
}

export interface KeyLookup { key: string; source: string; reason?: string; credentialRef?: CredentialRef; }
export interface KeyOptions { apiKey?: string; previousState?: Rec | null; priorReason?: string | null; }

export function keyLookupFromArgs(args: string[], _env: NodeJS.ProcessEnv = process.env, options: KeyOptions = {}): KeyLookup {
  if (options.apiKey) return { key: options.apiKey, source: 'internal' };
  if (args.includes('--stdin')) {
    return { key: fs.readFileSync(0, 'utf8').trim(), source: 'stdin' };
  }
  return { key: '', source: 'none' };
}

export function keyFromArgs(args: string[], env: NodeJS.ProcessEnv = process.env, options: KeyOptions = {}): string {
  return keyLookupFromArgs(args, env, options).key || '';
}

export function keyFromArgsOrCredential(args: string[], env: NodeJS.ProcessEnv = process.env, state: Rec | null = null, options: KeyOptions = {}): KeyLookup {
  const direct = keyLookupFromArgs(args, env, options);
  if (direct.key) return direct;
  const ref = state && state.credentialRef && typeof state.credentialRef === 'object'
    ? state.credentialRef as CredentialRef
    : null;
  if (!ref) return { key: '', source: 'none', reason: 'missing-api-key' };
  const credential = readCredential(ref, env);
  if (!credential.ok || !credential.secret) {
    return {
      key: '',
      source: 'credential-store',
      reason: credential.reason || 'credential-not-found',
      credentialRef: ref,
    };
  }
  return { key: credential.secret, source: 'credential-store', credentialRef: ref };
}

export function authStateFromResult(endpoint: string, result: Rec): Rec {
  return {
    version: AUTH_STATE_VERSION,
    endpoint,
    sessionToken: result.sessionToken,
    expiresAt: result.expiresAt,
    keyId: result.keyId,
    authenticatedAt: nowIsoNoMs(),
    lastRemoteCheckedAt: nowIsoNoMs(),
    lastRemoteCheckOkAt: nowIsoNoMs(),
  };
}

export interface SessionWrite { state: Rec; filePath: string; credential: CredentialResult; }

export function writeSessionResult(endpoint: string, result: Rec, env: NodeJS.ProcessEnv = process.env, options: KeyOptions = {}): SessionWrite {
  if (!result || result.authenticated !== true || typeof result.sessionToken !== 'string') {
    throw new Error('Authentication response did not include a session token');
  }
  const state = authStateFromResult(endpoint, result);
  let credential: CredentialResult = { ok: false, stored: false, reason: 'missing-api-key' };
  const previousRef = options.previousState && options.previousState.credentialRef
    && typeof options.previousState.credentialRef === 'object'
    ? options.previousState.credentialRef as CredentialRef
    : null;
  if (options.apiKey) {
    const ref = credentialRefFor(endpoint, state.keyId, env);
    if (ref) {
      credential = storeCredential(ref, options.apiKey, env);
      if (credential.ok) {
        state.credentialRef = ref;
      } else if (previousRef) {
        state.credentialRef = previousRef;
      }
    } else {
      credential = { ok: false, stored: false, reason: 'credential-store-unavailable' };
      if (previousRef) state.credentialRef = previousRef;
    }
  } else if (previousRef) {
    state.credentialRef = previousRef;
    credential = { ok: true, stored: false, reused: true, store: previousRef.store };
  }
  const filePath = writeAuthState(state, env);
  deleteAuthChoiceState(env);
  return { state, filePath, credential };
}
