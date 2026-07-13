// src/shared/state/traffic-one-paths.ts
// Resolves durable per-user prefs + machine settings paths. All hosts first use
// ~/.traffic-one/projects/<hash>/preferences.json and ~/.traffic-one/one.json.
// OpenCode gets an extra fallback to its stable desktop app-support state root
// before we fall back to project-local files beside the committed .one.json.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { HostId } from '../../core/types';
import { STATE_DIR } from '../../config/paths';
import { detectHost } from '../host';

export const PROJECT_LOCAL_PREFS_REL = path.join(STATE_DIR, 'preferences.json');
export const PROJECT_LOCAL_MACHINE_REL = path.join(STATE_DIR, 'machine.json');

const GITIGNORE_LINES = [
  '.traffic-one/preferences.json',
  '.traffic-one/machine.json',
  '.traffic-one/onboarding-server.json',
  '.traffic-one/onboarding-complete.json',
  '.traffic-one/onboarding-server.lock',
  '.traffic-one/onboarding/',
] as const;

export function projectLocalPrefsPath(cwd: string): string {
  return path.join(path.resolve(cwd), PROJECT_LOCAL_PREFS_REL);
}

export function projectLocalMachinePath(cwd: string): string {
  return path.join(path.resolve(cwd), PROJECT_LOCAL_MACHINE_REL);
}

export function globalTrafficOneDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'traffic-one')
    : path.join(env.HOME || os.homedir(), '.traffic-one');
}

export function openCodeStateHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'ai.opencode.desktop');
  }
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ai.opencode.desktop');
  }
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'ai.opencode.desktop');
}

// Probe whether the default machine-wide ~/.traffic-one tree is writable.
export function isGlobalTrafficOneWritable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TRAFFIC_ONE_PROJECT_PREFS_PATH || env.TRAFFIC_ONE_STATE_PATH) {
    return true;
  }
  const dir = globalTrafficOneDir(env);
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(probe, 'ok', { encoding: 'utf8', flag: 'wx' });
    fs.unlinkSync(probe);
    return true;
  } catch {
    try { fs.unlinkSync(probe); } catch { /* best-effort */ }
    return false;
  }
}

export function usesProjectLocalTrafficOnePaths(
  cwd: string,
  host: HostId,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.TRAFFIC_ONE_PROJECT_PREFS_PATH) {
    return path.resolve(env.TRAFFIC_ONE_PROJECT_PREFS_PATH) === projectLocalPrefsPath(cwd);
  }
  return !isGlobalTrafficOneWritable(env);
}

// OpenCode runs hooks inside Electron where process.env.HOME may point at a
// sandbox/container path. Pin the real user home for auth/tool discovery, but
// leave explicit Traffic One path overrides alone; tests and callers use them to
// deliberately isolate state.
export function normalizeElectronEnvForTrafficOne(
  env: NodeJS.ProcessEnv,
  host: HostId,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (host !== 'opencode') return out;

  const realHome = os.homedir();
  out.HOME = realHome;
  if (!env.USERPROFILE) out.USERPROFILE = realHome;

  delete out.XDG_STATE_HOME;
  return out;
}

export function resolveTrafficOneEnv(
  cwd: string,
  host: HostId,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = normalizeElectronEnvForTrafficOne(baseEnv, host);
  const resolved = path.resolve(cwd);

  if (env.TRAFFIC_ONE_PROJECT_PREFS_PATH || env.TRAFFIC_ONE_STATE_PATH) {
    return env;
  }

  if (isGlobalTrafficOneWritable(env)) {
    delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    delete env.TRAFFIC_ONE_STATE_PATH;
    return env;
  }

  if (host === 'opencode') {
    const appStateHome = openCodeStateHome(env);
    const appEnv: NodeJS.ProcessEnv = { ...env, XDG_STATE_HOME: appStateHome };
    if (isGlobalTrafficOneWritable(appEnv)) {
      env.XDG_STATE_HOME = appStateHome;
      delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
      delete env.TRAFFIC_ONE_STATE_PATH;
      return env;
    }
  }

  {
    env.TRAFFIC_ONE_PROJECT_PREFS_PATH = projectLocalPrefsPath(resolved);
    env.TRAFFIC_ONE_STATE_PATH = projectLocalMachinePath(resolved);
  }

  return env;
}

// Mutate process.env so in-process hook handlers read the same paths as spawned children.
export function applyTrafficOneEnv(
  cwd: string,
  host: HostId = detectHost(),
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const resolved = resolveTrafficOneEnv(cwd, host, baseEnv);
  const targets = baseEnv === process.env ? [process.env] : [baseEnv, process.env];
  for (const target of targets) {
    if (resolved.TRAFFIC_ONE_PROJECT_PREFS_PATH) {
      target.TRAFFIC_ONE_PROJECT_PREFS_PATH = resolved.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    } else {
      delete target.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    }
    if (resolved.TRAFFIC_ONE_STATE_PATH) {
      target.TRAFFIC_ONE_STATE_PATH = resolved.TRAFFIC_ONE_STATE_PATH;
    } else {
      delete target.TRAFFIC_ONE_STATE_PATH;
    }
    if (host === 'opencode' && resolved.HOME) {
      target.HOME = resolved.HOME;
      if (resolved.XDG_STATE_HOME) {
        target.XDG_STATE_HOME = resolved.XDG_STATE_HOME;
      } else {
        delete target.XDG_STATE_HOME;
      }
    }
  }
  return baseEnv;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function envAssignment(name: string, value: string | undefined): string {
  return `${name}=${shellQuote(value || '')}`;
}

// Shell prefix for onboarding-wait when Electron/sandbox env must be corrected.
export function trafficOneEnvShellPrefix(cwd: string, host?: HostId): string {
  if (!host) return '';
  const resolved = resolveTrafficOneEnv(cwd, host);
  const parts: string[] = [];

  if (host === 'opencode' && process.env.HOME && process.env.HOME !== resolved.HOME) {
    parts.push(envAssignment('HOME', resolved.HOME || os.homedir()));
  }
  if (host === 'opencode' && resolved.XDG_STATE_HOME && process.env.XDG_STATE_HOME !== resolved.XDG_STATE_HOME) {
    parts.push(envAssignment('XDG_STATE_HOME', resolved.XDG_STATE_HOME));
  }
  if (usesProjectLocalTrafficOnePaths(cwd, host, resolved)) {
    parts.push(envAssignment('TRAFFIC_ONE_PROJECT_PREFS_PATH', resolved.TRAFFIC_ONE_PROJECT_PREFS_PATH!));
    parts.push(envAssignment('TRAFFIC_ONE_STATE_PATH', resolved.TRAFFIC_ONE_STATE_PATH!));
  }
  return parts.length ? `${parts.join(' ')} ` : '';
}

/*
 * Best-effort: keep project-local runtime files out of git when using fallbacks.
 */
export function ensureProjectLocalTrafficOneGitignore(cwd: string): void {
  const gitignorePath = path.join(path.resolve(cwd), '.gitignore');
  let existing = '';
  try {
    existing = fs.readFileSync(gitignorePath, 'utf8');
  } catch {
    // no .gitignore yet
  }
  const missing = GITIGNORE_LINES.filter((line) => !existing.split('\n').some((l) => l.trim() === line));
  if (!missing.length) return;
  const block = [
    '',
    '# Traffic One — per-user / machine-local runtime (not committed)',
    ...missing,
    '',
  ].join('\n');
  try {
    fs.writeFileSync(gitignorePath, existing.trimEnd() + block, 'utf8');
  } catch {
    // best-effort
  }
}
