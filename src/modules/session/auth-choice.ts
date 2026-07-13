// src/modules/session/auth-choice.ts
// The per-project "continue without" / global "authenticate" choice state. It now
// lives in the `authChoice` SECTION of the consolidated one.json (see
// shared/one-settings); the public surface (read/write/delete/exists + the choice
// helpers) is unchanged. Secure-write semantics (0o700 dir / 0o600 file) preserved.
//
// Two side files keep the previous resilience WITHOUT ever holding the auth token:
//   - TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH → a standalone, section-only override file
//     (same shape as the old auth-choice.json) for isolation in tests/tooling;
//   - an os.tmpdir() fallback (section-only) used when one.json is not writable.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { deleteOneSection, oneSettingsPath, readOneSettings, writeOneSection } from '../../shared/one-settings';
import { readJson } from '../../shared/fsjson';
import { nowIsoNoMs, sha256 } from '../../shared/text';

import { AUTH_CHOICE_CONTINUE_TTL_MS, AUTH_CHOICE_STATE_VERSION } from '../../config/onboarding';

type Rec = Record<string, unknown>;

interface AuthChoiceState {
  version: number;
  globalChoice: Rec | null;
  choices: Record<string, Rec>;
}

function emptyAuthChoiceState(): AuthChoiceState {
  return { version: AUTH_CHOICE_STATE_VERSION, globalChoice: null, choices: {} };
}

// A standalone, section-only file (NOT one.json) holding just the auth-choice
// state. Set in tests/tooling to isolate the choice without touching one.json.
function authChoiceOverridePath(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH ? path.resolve(env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH) : null;
}

// Tmpdir fallback (section-only) for when one.json cannot be written. Never holds
// the token. Keyed off the one.json path so isolated state dirs don't collide.
function authChoiceFallbackStatePath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (authChoiceOverridePath(env)) return null;
  const digest = sha256(oneSettingsPath(env)).slice(0, 16);
  return path.join(os.tmpdir(), 'traffic-one', `one-choice-${digest}.json`);
}

// The canonical auth-choice location (the override file, or one.json). Informational
// (e.g. logout output); the actual store is the `authChoice` section of one.json.
export function authChoiceStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return authChoiceOverridePath(env) ?? oneSettingsPath(env);
}

export function authChoiceStatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const primary = authChoiceStatePath(env);
  const fallback = authChoiceFallbackStatePath(env);
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

// Whether an auth-choice is present anywhere (override file, one.json section, or
// the tmpdir fallback).
export function authChoiceStateExists(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = authChoiceOverridePath(env);
  if (override) return fs.existsSync(override);
  if (readOneSettings(env).authChoice) return true;
  const fb = authChoiceFallbackStatePath(env);
  return Boolean(fb && fs.existsSync(fb));
}

function writeChoiceFile(filePath: string, state: AuthChoiceState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort; some filesystems ignore chmod
  }
}

// Clear the auth-choice state (override file, one.json section, AND tmpdir
// fallback). Returns false if any removal threw. Called by the auth CLI on logout.
export function deleteAuthChoiceState(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = authChoiceOverridePath(env);
  if (override) {
    try {
      fs.rmSync(override, { force: true });
      return true;
    } catch {
      return false;
    }
  }
  let ok = true;
  try {
    if (!deleteOneSection('authChoice', env)) ok = false;
  } catch {
    ok = false;
  }
  const fb = authChoiceFallbackStatePath(env);
  if (fb) {
    try {
      fs.rmSync(fb, { force: true });
    } catch {
      ok = false;
    }
  }
  return ok;
}

// Remove ONLY the auth-choice side files (override + tmpdir fallback) WITHOUT
// touching one.json — used by writeSessionResult, which already clears the one.json
// authChoice section in its single atomic auth write (a fresh session supersedes a
// prior "continue without" choice).
export function clearAuthChoiceSideFiles(env: NodeJS.ProcessEnv = process.env): void {
  for (const p of [authChoiceOverridePath(env), authChoiceFallbackStatePath(env)]) {
    if (!p) continue;
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // best-effort
    }
  }
}

export function normalizeAuthChoiceState(state: unknown): AuthChoiceState {
  if (!state || typeof state !== 'object') return emptyAuthChoiceState();
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
    const migrated: AuthChoiceState = emptyAuthChoiceState();
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
  return emptyAuthChoiceState();
}

export function readAuthChoiceState(env: NodeJS.ProcessEnv = process.env): AuthChoiceState {
  const override = authChoiceOverridePath(env);
  if (override) {
    const raw = readJson<Rec | null>(override, null);
    return raw && typeof raw === 'object' ? normalizeAuthChoiceState(raw) : emptyAuthChoiceState();
  }
  const section = readOneSettings(env).authChoice;
  if (section && typeof section === 'object') return normalizeAuthChoiceState(section);
  // one.json had no choice (or wasn't writable when the choice was made) → fallback.
  const fb = authChoiceFallbackStatePath(env);
  if (fb && fs.existsSync(fb)) {
    const raw = readJson<Rec | null>(fb, null);
    if (raw && typeof raw === 'object') return normalizeAuthChoiceState(raw);
  }
  return emptyAuthChoiceState();
}

export interface WriteResult {
  ok: boolean;
  filePath?: string;
  fallback?: boolean;
  code?: string | null;
  message?: string;
}

export function writeAuthChoiceState(state: AuthChoiceState, env: NodeJS.ProcessEnv = process.env): WriteResult {
  const override = authChoiceOverridePath(env);
  if (override) {
    writeChoiceFile(override, state);
    return { ok: true, filePath: override, fallback: false };
  }
  try {
    const filePath = writeOneSection('authChoice', state, env);
    return { ok: true, filePath, fallback: false };
  } catch (primaryError) {
    // home not writable → section-only tmpdir fallback (NEVER holds the token).
    const fb = authChoiceFallbackStatePath(env);
    if (fb) {
      try {
        writeChoiceFile(fb, state);
        return { ok: true, filePath: fb, fallback: true };
      } catch {
        // fall through to throw the primary error
      }
    }
    throw primaryError;
  }
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
