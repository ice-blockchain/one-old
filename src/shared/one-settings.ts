// src/shared/one-settings.ts
// The single owner of ~/.traffic-one/one.json — the consolidated GLOBAL, per-user
// settings file. It replaces the old three-way split (auth.json + auth-choice.json
// + a per-project codeGraphProvider): auth state, the auth-choice state, and the
// machine-wide code-graph provider now live as top-level SECTIONS of one file.
//
// Why consolidate: the code-graph provider becomes a machine-level setting so a
// provider already chosen/installed locally is reused across projects (onboarding
// stops re-prompting). Keeping auth + auth-choice alongside it means one secure
// (0o600) settings file instead of three.
//
// Concurrency: `auth` is written by the auth CLI process (scripts/traffic-one-auth.cjs)
// while `authChoice` is written by session hooks — possibly overlapping. Every
// mutation therefore RE-READS the file, patches only the touched section(s), and
// writes atomically (temp file + rename) so a reader never sees a torn file and a
// concurrent writer of a DIFFERENT section is not clobbered. A lost update across
// processes writing the SAME section is still possible (as it already was for the
// old single-file auth-choice writers); both auth and auth-choice state are
// self-healing (a missed refresh re-refreshes; a missed choice re-prompts), so we
// do not take a cross-process lock.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ONE_SETTINGS_VERSION } from '../config/one-settings';
import { readJson } from './fsjson';
import {
  PROJECT_LOCAL_MACHINE_REL,
  ensureProjectLocalTrafficOneGitignore,
} from './state/traffic-one-paths';

export type OneSection = 'auth' | 'authChoice' | 'codeGraphProvider';

export interface OneSettings {
  version: number;
  auth?: Record<string, unknown> | null;
  authChoice?: Record<string, unknown> | null;
  codeGraphProvider?: string | null;
}

// Legacy global files superseded by one.json. Hard cutover: never READ, just
// best-effort removed on the first write so stale copies don't linger.
const LEGACY_BASENAMES = ['auth.json', 'auth-choice.json'];

function settingsDir(env: NodeJS.ProcessEnv): string {
  return env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'traffic-one')
    : path.join(env.HOME || os.homedir(), '.traffic-one');
}

// TRAFFIC_ONE_STATE_PATH is the new canonical override; TRAFFIC_ONE_AUTH_STATE_PATH
// is honored as a back-compat alias (it used to point at auth.json — now it points
// the whole file at one.json) so existing callers/tests keep working.
export function oneSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TRAFFIC_ONE_STATE_PATH || env.TRAFFIC_ONE_AUTH_STATE_PATH;
  if (override) return path.resolve(override);
  return path.join(settingsDir(env), 'one.json');
}

export function readOneSettings(env: NodeJS.ProcessEnv = process.env): OneSettings {
  const raw = readJson<Record<string, unknown> | null>(oneSettingsPath(env), null);
  if (!raw || typeof raw !== 'object') {
    return { version: ONE_SETTINGS_VERSION, auth: null, authChoice: null, codeGraphProvider: null };
  }
  return {
    version: typeof raw.version === 'number' ? raw.version : ONE_SETTINGS_VERSION,
    auth: raw.auth && typeof raw.auth === 'object' ? (raw.auth as Record<string, unknown>) : null,
    authChoice: raw.authChoice && typeof raw.authChoice === 'object' ? (raw.authChoice as Record<string, unknown>) : null,
    codeGraphProvider: typeof raw.codeGraphProvider === 'string' ? raw.codeGraphProvider : null,
  };
}

// Best-effort removal of the legacy split files (hard cutover). Silent on any error.
// ONLY at the DEFAULT location: when a path override/alias is set (tests, custom
// installs) the active one.json may itself be named auth.json — or sit beside an
// auth-choice override file — and must never be deleted.
function removeLegacyFiles(env: NodeJS.ProcessEnv): void {
  if (env.TRAFFIC_ONE_STATE_PATH || env.TRAFFIC_ONE_AUTH_STATE_PATH) return;
  const dir = path.dirname(oneSettingsPath(env));
  for (const name of LEGACY_BASENAMES) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // best-effort
    }
  }
}

function writeWholeFile(filePath: string, settings: OneSettings): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
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

// Atomically apply a partial patch (read-merge-write + temp/rename). This is the
// single low-level mutator everything goes through. A section set to null is
// retained as null (read as empty); use deleteOneSection to drop a key entirely.
export function updateOneSettings(patch: Partial<OneSettings>, env: NodeJS.ProcessEnv = process.env): string {
  const filePath = oneSettingsPath(env);
  const current = readOneSettings(env);
  writeWholeFile(filePath, { ...current, ...patch, version: ONE_SETTINGS_VERSION });
  removeLegacyFiles(env);
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.endsWith(`/${PROJECT_LOCAL_MACHINE_REL.replace(/\\/g, '/')}`)) {
    ensureProjectLocalTrafficOneGitignore(path.dirname(path.dirname(filePath)));
  }
  return filePath;
}

export function writeOneSection<T>(section: OneSection, value: T, env: NodeJS.ProcessEnv = process.env): string {
  return updateOneSettings({ [section]: value } as Partial<OneSettings>, env);
}

// Remove ONE section (used by auth logout / clear). No-op if the file is absent.
export function deleteOneSection(section: OneSection, env: NodeJS.ProcessEnv = process.env): boolean {
  const filePath = oneSettingsPath(env);
  if (!fs.existsSync(filePath)) return true;
  try {
    const current = readOneSettings(env);
    delete current[section];
    writeWholeFile(filePath, { ...current, version: ONE_SETTINGS_VERSION });
    return true;
  } catch {
    return false;
  }
}
