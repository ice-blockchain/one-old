// src/runners/auth/commands.ts
// The four auth CLI commands: login / refresh / status / logout. Ported 1:1
// from scripts/traffic-one-auth/{login,refresh,status,logout,currentSessionToken}.cjs.
// status/refresh stay silent — they are the hook/auth-client path, not a
// user-facing prompt. All network goes through mcpRequest (injectable-free here;
// tests drive the local/pure branches + a dead-port endpoint).

import * as fs from 'fs';

import {
  authStateFreshness,
  authStatePath,
  endpointFromEnv,
  isAuthStateFresh,
  readAuthState,
} from '../../shared/auth';
import { authChoiceStatePath, authChoiceStateExists, deleteAuthChoiceState } from '../../modules/session/auth-choice';
import { nowIsoNoMs } from '../../shared/text';
import { deleteCredential } from './credential-store';
import {
  type KeyOptions,
  deleteAuthState,
  errorMessage,
  isRemoteAuthRejection,
  keyFromArgsOrCredential,
  keyLookupFromArgs,
  stampRemoteCheck,
  writeSessionResult,
} from './lib';
import { type McpError, mcpRequest } from './mcp-client';

type Rec = Record<string, unknown>;

export function currentSessionToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const state = readAuthState(env);
  return isAuthStateFresh(state, env) && state ? (state.sessionToken as string) : null;
}

export async function login(args: string[] = process.argv.slice(3), env: NodeJS.ProcessEnv = process.env, options: KeyOptions = {}): Promise<Rec> {
  const endpoint = endpointFromEnv(env);
  const filePath = authStatePath(env);
  const keyLookup = keyLookupFromArgs(args, env, options);
  const apiKey = keyLookup.key;
  if (!apiKey) {
    return {
      ok: false,
      authenticated: false,
      reason: 'missing-api-key',
      detail: 'Pass the key through secure input/stdin.',
      endpoint,
      filePath,
    };
  }
  let result: Rec;
  try {
    result = await mcpRequest(endpoint, 'authenticate', apiKey, {});
  } catch (error) {
    const e = error as McpError;
    return {
      ok: false,
      authenticated: false,
      reason: isRemoteAuthRejection(error) ? 'invalid-api-key' : 'auth-endpoint-unreachable',
      endpoint,
      filePath,
      error: errorMessage(error),
      ...(e.statusCode ? { statusCode: e.statusCode } : {}),
    };
  }
  try {
    const { state, filePath: written, credential } = writeSessionResult(endpoint, result, env, { apiKey });
    return {
      ok: true,
      authenticated: true,
      filePath: written,
      keyId: state.keyId,
      expiresAt: state.expiresAt,
      endpoint,
      keySource: keyLookup.source,
      credentialStored: credential && credential.ok === true && credential.stored === true,
      ...(credential && credential.store ? { credentialStore: credential.store } : {}),
      ...(credential && credential.ok === false ? { credentialStoreReason: credential.reason || 'credential-store-failed' } : {}),
    };
  } catch (error) {
    return { ok: false, authenticated: false, reason: 'invalid-auth-response', endpoint, filePath, error: errorMessage(error) };
  }
}

export async function refresh(args: string[] = process.argv.slice(3), env: NodeJS.ProcessEnv = process.env, options: KeyOptions = {}): Promise<Rec> {
  const previousState = readAuthState(env);
  const keyLookup = keyFromArgsOrCredential(args, env, previousState, options);
  const apiKey = keyLookup.key;
  const endpoint = endpointFromEnv(env);
  const filePath = authStatePath(env);
  const priorReason = options.priorReason || null;
  if (!apiKey) {
    return {
      ok: false,
      authenticated: false,
      reauthenticated: false,
      reason: 'reauthentication-not-possible',
      detail: keyLookup.reason || 'missing-api-key',
      ...(priorReason ? { priorReason } : {}),
      endpoint,
      filePath,
    };
  }

  let result: Rec;
  try {
    result = await mcpRequest(endpoint, 'refresh', apiKey, {});
  } catch (error) {
    return {
      ok: false,
      authenticated: false,
      reauthenticated: false,
      reason: 'reauthentication-failed',
      error: errorMessage(error),
      ...(priorReason ? { priorReason } : {}),
      endpoint,
      filePath,
    };
  }

  try {
    const written = writeSessionResult(endpoint, result, env, { apiKey, previousState });
    return {
      ok: true,
      authenticated: true,
      reauthenticated: true,
      ...(priorReason ? { priorReason } : {}),
      filePath: written.filePath,
      keyId: written.state.keyId,
      expiresAt: written.state.expiresAt,
      endpoint,
      keySource: keyLookup.source,
      credentialStored: written.credential && written.credential.ok === true && written.credential.stored === true,
      ...(written.credential && written.credential.store ? { credentialStore: written.credential.store } : {}),
      ...(written.credential && written.credential.ok === false ? { credentialStoreReason: written.credential.reason || 'credential-store-failed' } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      authenticated: false,
      reauthenticated: false,
      reason: 'reauthentication-failed',
      error: errorMessage(error),
      ...(priorReason ? { priorReason } : {}),
      endpoint,
      filePath,
    };
  }
}

export async function status(args: string[] = process.argv.slice(3), env: NodeJS.ProcessEnv = process.env): Promise<Rec> {
  const state = readAuthState(env);
  const freshness = authStateFreshness(state, env);
  if (!freshness.fresh) {
    const localReason = freshness.reason;
    if (state) {
      return refresh(args, env, { priorReason: localReason });
    }
    return { ok: false, authenticated: false, reason: localReason, filePath: authStatePath(env), endpoint: endpointFromEnv(env) };
  }
  const s = state as Rec;
  if (!args.includes('--remote')) {
    return { ok: true, authenticated: true, keyId: s.keyId, expiresAt: s.expiresAt, endpoint: s.endpoint, filePath: authStatePath(env) };
  }
  let result: Rec;
  try {
    result = await mcpRequest(String(s.endpoint), 'auth_status', String(s.sessionToken), {});
  } catch (error) {
    if (isRemoteAuthRejection(error)) {
      const refreshed = await refresh(args, env, { priorReason: 'remote-auth-rejected' });
      if (refreshed.ok) return { ...refreshed, remoteChecked: true };
      deleteAuthState(env);
      return refreshed;
    }
    stampRemoteCheck(s, { lastRemoteCheckError: errorMessage(error) }, env);
    return {
      ok: false,
      authenticated: true,
      localAuthenticated: true,
      remoteChecked: false,
      reason: 'remote-check-failed',
      error: errorMessage(error),
      keyId: s.keyId,
      expiresAt: s.expiresAt,
      endpoint: s.endpoint,
      filePath: authStatePath(env),
    };
  }
  if (result.authenticated !== true) {
    const refreshed = await refresh(args, env, { priorReason: (result.reason as string) || 'remote-auth-rejected' });
    if (refreshed.ok) return { ...refreshed, remoteChecked: true };
    deleteAuthState(env);
    return refreshed;
  }
  if (result.authenticated === true) {
    stampRemoteCheck(s, {
      keyId: result.keyId || s.keyId,
      expiresAt: result.expiresAt || s.expiresAt,
      lastRemoteCheckOkAt: nowIsoNoMs(),
      lastRemoteCheckError: null,
    }, env);
  }
  return { ok: result.authenticated === true, authenticated: result.authenticated === true, keyId: result.keyId, expiresAt: result.expiresAt, endpoint: s.endpoint, filePath: authStatePath(env) };
}

export async function logout(_args: string[] = process.argv.slice(3), env: NodeJS.ProcessEnv = process.env): Promise<Rec> {
  const state = readAuthState(env);
  const token = currentSessionToken(env);
  const endpoint = endpointFromEnv(env);
  const filePath = authStatePath(env);
  if (token) {
    try {
      await mcpRequest(endpoint, 'logout', token, {}, 5000);
    } catch {
      // Stateless server sessions; local deletion is the important part.
    }
  }
  const credentialRef = state && typeof state.credentialRef === 'object' ? state.credentialRef as Parameters<typeof deleteCredential>[0] : null;
  const credentialDeleted = deleteCredential(credentialRef, env);
  const deleted = deleteAuthState(env);
  const authChoicePath = authChoiceStatePath(env);
  const choiceDeleted = deleteAuthChoiceState(env);
  if (!deleted && fs.existsSync(filePath)) {
    return { ok: false, authenticated: true, reason: 'delete-auth-state-failed', filePath };
  }
  if (!choiceDeleted && authChoiceStateExists(env)) {
    return { ok: false, authenticated: true, reason: 'delete-auth-choice-state-failed', filePath, authChoicePath };
  }
  return {
    ok: true,
    authenticated: false,
    filePath,
    authChoicePath,
    credentialDeleted: credentialDeleted.deleted === true,
    ...(credentialDeleted.store ? { credentialStore: credentialDeleted.store } : {}),
  };
}
