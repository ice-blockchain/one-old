// src/shared/state/traffic-one-paths.ts
// Resolves durable per-user prefs + machine settings paths. Every host uses
// ~/.traffic-one/projects/<hash>/preferences.json and ~/.traffic-one/one.json.
// These paths are identity, not capability: a sandbox write denial must never
// redirect private user state into the shared project.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { HostId } from '../../core/types';
import { STATE_DIR } from '../../config/paths';
import { detectHost } from '../host';
import { sha256 } from '../text';

export const PROJECT_LOCAL_PREFS_REL = path.join(STATE_DIR, 'preferences.json');
export const PROJECT_LOCAL_MACHINE_REL = path.join(STATE_DIR, 'machine.json');

const LEGACY_PROJECT_LOCAL_RUNTIME = [
  PROJECT_LOCAL_PREFS_REL,
  PROJECT_LOCAL_MACHINE_REL,
  path.join(STATE_DIR, 'auth.json'),
  path.join(STATE_DIR, 'onboarding-server.json'),
  path.join(STATE_DIR, 'onboarding-complete.json'),
  path.join(STATE_DIR, 'onboarding-server.lock'),
  path.join(STATE_DIR, 'onboarding'),
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

function isExactPath(value: string | undefined, expected: string): boolean {
  return typeof value === 'string' && path.resolve(value) === expected;
}

// Remove only files/directories created by the retired project-local fallback.
// The shared project state (.traffic-one/.one.json) is deliberately untouched.
export function removeLegacyProjectLocalTrafficOneRuntime(cwd: string): void {
  const root = path.resolve(cwd);
  for (const relativePath of LEGACY_PROJECT_LOCAL_RUNTIME) {
    try {
      fs.rmSync(path.join(root, relativePath), { recursive: true, force: true });
    } catch {
      // Best-effort. Path selection remains global even when cleanup is denied.
    }
  }
}

// Project-tree artifacts that a pre-guard plugin version could materialize INTO
// the machine dir when a session ran with cwd=$HOME — <$HOME>/.traffic-one IS
// the machine dir, so the "project" tree landed among machine state. These
// names are never legitimate at the machine dir's top level; remove on sight.
// Machine-owned entries (one.json, projects/, bin/, toolchains/,
// windsurf-plugin-root, secret.env) are deliberately NOT listed.
const STRAY_PROJECT_ARTIFACTS = [
  '.one.json', 'manifest.json', 'rules', 'skills', 'plan.md', 'runs', 'digests',
  'graph-preview.md', '.gitnexus', 'graphify-out', '.codegraph-build-lock',
  '.agentignore', 'one-mcp-report.json', 'cursor-models.json', 'one-uid',
  '.onboarding-main-sessions.json', 'backups', 'reports',
] as const;

// Self-heal for machines the pre-guard bug already touched. Also drops the
// per-project prefs bucket the bogus "$HOME project" acquired (its hash is the
// sha256 of the home dir), which carries the stale onboarding server record.
export function removeStrayProjectArtifactsFromGlobalDir(env: NodeJS.ProcessEnv = process.env): void {
  const dir = globalTrafficOneDir(env);
  for (const name of STRAY_PROJECT_ARTIFACTS) {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      // Best-effort — a denied delete never blocks the session.
    }
  }
  try {
    const home = path.resolve(env.HOME || os.homedir());
    fs.rmSync(path.join(dir, 'projects', sha256(home)), { recursive: true, force: true });
  } catch {
    // best-effort
  }
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

  // Strip overrides emitted by plugin versions that redirected sandboxed hosts
  // into the project. Deliberate non-project overrides remain available to tests
  // and embedded callers.
  if (isExactPath(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, projectLocalPrefsPath(resolved))) {
    delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  }
  if (isExactPath(env.TRAFFIC_ONE_STATE_PATH, projectLocalMachinePath(resolved))) {
    delete env.TRAFFIC_ONE_STATE_PATH;
  }
  if (env.TRAFFIC_ONE_PROJECT_PREFS_PATH || env.TRAFFIC_ONE_STATE_PATH) {
    return env;
  }

  delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  delete env.TRAFFIC_ONE_STATE_PATH;
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
  if (host === 'opencode' && process.env.XDG_STATE_HOME !== resolved.XDG_STATE_HOME) {
    parts.push(envAssignment('XDG_STATE_HOME', resolved.XDG_STATE_HOME));
  }
  return parts.length ? `${parts.join(' ')} ` : '';
}
