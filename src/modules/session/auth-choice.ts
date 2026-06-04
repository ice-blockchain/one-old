// src/modules/session/auth-choice.ts
// The per-project "continue without" / global "authenticate" choice state.
// Ported 1:1 from the auth-choice cluster in scripts/hook-runtime/handlers/auth.cjs.
// Secure-write semantics (0o700 dir / 0o600 file) preserved.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { authStatePath } from '../../shared/auth';
import { readJson } from '../../shared/fsjson';
import { nowIsoNoMs, sha256 } from '../../shared/text';

import { AUTH_CHOICE_CONTINUE_TTL_MS, AUTH_CHOICE_STATE_VERSION } from '../../config/onboarding';

type Rec = Record<string, unknown>;

export function authChoiceStatePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH) return path.resolve(env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH);
  return path.join(path.dirname(authStatePath(env)), 'auth-choice.json');
}

function authChoiceFallbackStatePath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH) return null;
  const digest = sha256(authStatePath(env)).slice(0, 16);
  return path.join(os.tmpdir(), 'traffic-one', `auth-choice-${digest}.json`);
}

export function authChoiceStatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const primary = authChoiceStatePath(env);
  const fallback = authChoiceFallbackStatePath(env);
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

// Whether any auth-choice state file is present (primary or tmpdir fallback).
export function authChoiceStateExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return authChoiceStatePaths(env).some((filePath) => fs.existsSync(filePath));
}

// Clear the auth-choice state (both primary + fallback). Returns false if any
// removal threw. Called by the auth CLI on login (a fresh session supersedes a
// prior "continue without" choice) and on logout.
export function deleteAuthChoiceState(env: NodeJS.ProcessEnv = process.env): boolean {
  let ok = true;
  for (const filePath of authChoiceStatePaths(env)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      ok = false;
    }
  }
  return ok;
}

interface AuthChoiceState {
  version: number;
  globalChoice: Rec | null;
  choices: Record<string, Rec>;
}

export function normalizeAuthChoiceState(state: unknown): AuthChoiceState {
  const empty = (): AuthChoiceState => ({ version: AUTH_CHOICE_STATE_VERSION, globalChoice: null, choices: {} });
  if (!state || typeof state !== 'object') return empty();
  const s = state as Rec;
  if (s.version === AUTH_CHOICE_STATE_VERSION) {
    return {
      version: AUTH_CHOICE_STATE_VERSION,
      globalChoice: s.globalChoice && typeof s.globalChoice === 'object' ? (s.globalChoice as Rec) : null,
      choices: s.choices && typeof s.choices === 'object' ? (s.choices as Record<string, Rec>) : {},
    };
  }
  if (s.choice && typeof s.choice === 'object') {
    const choice = s.choice as Rec;
    const migrated: AuthChoiceState = empty();
    if (choice.status === 'authenticate') {
      migrated.globalChoice = { ...choice, scope: 'global' };
    } else if (typeof choice.cwd === 'string' && choice.cwd.trim()) {
      migrated.choices[path.resolve(choice.cwd)] = { ...choice, scope: 'project', cwd: path.resolve(choice.cwd) };
    }
    return migrated;
  }
  if (s.choices && typeof s.choices === 'object') {
    const choices: Record<string, Rec> = {};
    let globalChoice: Rec | null = null;
    for (const [key, raw] of Object.entries(s.choices as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const record = raw as Rec;
      if (typeof record.status !== 'string') continue;
      const cwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : key;
      if (record.status === 'authenticate') {
        if (!globalChoice || Date.parse((record.updatedAt as string) || '') > Date.parse((globalChoice.updatedAt as string) || '')) {
          globalChoice = { ...record, scope: 'global' };
        }
        continue;
      }
      choices[path.resolve(cwd)] = { ...record, scope: 'project', cwd: path.resolve(cwd) };
    }
    return { version: AUTH_CHOICE_STATE_VERSION, globalChoice, choices };
  }
  return empty();
}

export function readAuthChoiceState(env: NodeJS.ProcessEnv = process.env): AuthChoiceState {
  for (const filePath of authChoiceStatePaths(env)) {
    if (!fs.existsSync(filePath)) continue;
    const state = readJson<Rec | null>(filePath, null);
    if (state && typeof state === 'object') return normalizeAuthChoiceState(state);
  }
  return { version: AUTH_CHOICE_STATE_VERSION, globalChoice: null, choices: {} };
}

export interface WriteResult {
  ok: boolean;
  filePath?: string;
  fallback?: boolean;
  code?: string | null;
  message?: string;
}

export function writeAuthChoiceState(state: AuthChoiceState, env: NodeJS.ProcessEnv = process.env): WriteResult {
  const paths = authChoiceStatePaths(env);
  const errors: { filePath: string; error: NodeJS.ErrnoException }[] = [];
  for (const filePath of paths) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        // best-effort; some filesystems ignore chmod
      }
      return { ok: true, filePath, fallback: filePath !== paths[0] };
    } catch (error) {
      errors.push({ filePath, error: error as NodeJS.ErrnoException });
    }
  }
  const first = errors[0]?.error ?? new Error('auth choice state write failed');
  throw first;
}

export function readAuthChoice(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): Rec | null {
  const state = readAuthChoiceState(env);
  const key = path.resolve(cwd || process.cwd());
  const projectChoice = state.choices[key] && typeof state.choices[key] === 'object' ? state.choices[key] : null;
  if (projectChoice && projectChoice.status === 'continue-without-traffic-one') {
    const expires = Date.parse((projectChoice.expiresAt as string) || '');
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      return state.globalChoice || projectChoice;
    }
    return projectChoice;
  }
  if (state.globalChoice && state.globalChoice.status === 'authenticate') return state.globalChoice;
  return projectChoice || state.globalChoice || null;
}

export function authChoiceStatus(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | null {
  const record = readAuthChoice(cwd, env);
  return record && typeof record.status === 'string' ? record.status : null;
}

export function writeAuthChoice(status: string, cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): WriteResult {
  const state = readAuthChoiceState(env);
  const now = Date.now();
  const key = path.resolve(cwd || process.cwd());
  const record: Rec = {
    status,
    scope: status === 'authenticate' ? 'global' : 'project',
    ...(status === 'authenticate' ? {} : { cwd: key }),
    updatedAt: nowIsoNoMs(),
  };
  if (status === 'continue-without-traffic-one') {
    record.expiresAt = new Date(now + AUTH_CHOICE_CONTINUE_TTL_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  if (status === 'authenticate') {
    state.globalChoice = record;
    delete state.choices[key];
  } else {
    state.choices[key] = record;
  }
  return writeAuthChoiceState(state, env);
}

export function tryWriteAuthChoice(status: string, cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): WriteResult {
  try {
    return { ...writeAuthChoice(status, cwd, env), ok: true };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return { ok: false, code: err && err.code ? String(err.code) : null, message: (err && err.message) || 'auth choice state write failed' };
  }
}

export function authChoiceAllowsContinue(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()): boolean {
  const record = readAuthChoice(cwd, env);
  if (!record || record.status !== 'continue-without-traffic-one') return false;
  const expires = Date.parse((record.expiresAt as string) || '');
  return Number.isFinite(expires) && expires > nowMs;
}
