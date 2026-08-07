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
import { removePath } from '../fsjson';
import { detectHost } from '../host';
import { globalTrafficOneDir } from '../state-root';

// Re-exported, not redefined: this module is the historical home of the name and
// six callers import it from here, but the resolver itself now lives in the leaf
// shared/state-root.ts so shared/toolchain-paths.ts can share it without
// inheriting this module's fsjson/host/text/config dependencies.
export { globalTrafficOneDir };

const PROJECT_LOCAL_PREFS_REL = path.join(STATE_DIR, 'preferences.json');
const PROJECT_LOCAL_MACHINE_REL = path.join(STATE_DIR, 'machine.json');

const LEGACY_PROJECT_LOCAL_RUNTIME = [
  PROJECT_LOCAL_PREFS_REL,
  PROJECT_LOCAL_MACHINE_REL,
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

function isExactPath(value: string | undefined, expected: string): boolean {
  return typeof value === 'string' && path.resolve(value) === expected;
}

// Remove only files/directories created by the retired project-local fallback.
// The shared project state (.traffic-one/.one.json) is deliberately untouched.
// Guarded (fsjson.removePath): this runs from initializeTrafficOneEnv at the
// very top of SessionStart, before any consent check, so on a project whose
// use-plugin question is unanswered it was deleting six project-local paths
// before the user had said anything at all.
//
// Answers whether EVERY legacy path is gone, because the caller (state/runtime-env
// .ts) has to know: it deletes the only copy of the user's onboarding answers, so
// a refused delete means the bridge is unfinished and a later process must retry
// it. `removePath` reports `true` for a path that was already absent, so a project
// carrying none of these is a completed cleanup, not a failed one.
export function removeLegacyProjectLocalTrafficOneRuntime(cwd: string): boolean {
  const root = path.resolve(cwd);
  let removed = true;
  for (const relativePath of LEGACY_PROJECT_LOCAL_RUNTIME) {
    try {
      if (!removePath(path.join(root, relativePath))) removed = false;
    } catch {
      // Best-effort. Path selection remains global even when cleanup is denied.
      removed = false;
    }
  }
  return removed;
}

// Project-tree artifacts that a pre-guard plugin version could materialize INTO
// the machine dir when a session ran with cwd=$HOME — <$HOME>/.traffic-one IS
// the machine dir, so the "project" tree landed among machine state. These
// names are never legitimate at the machine dir's top level; remove on sight.
// Machine-owned entries (one.json, projects/, bin/, toolchains/, overrides/,
// windsurf-plugin-root, secret.env) are deliberately NOT listed — the
// authoritative set is MACHINE_OWNED_ENTRIES in state/plugin-use.ts, of which
// this array is the complement; keep the two in step.
const STRAY_PROJECT_ARTIFACTS = [
  '.one.json', 'manifest.json', 'rules', 'skills', 'plan.md', 'runs', 'digests',
  'graph-preview.md', '.gitnexus', 'graphify-out', '.codegraph-build-lock',
  '.agentignore', 'one-mcp-report.json', 'cursor-models.json', 'one-uid',
  '.onboarding-main-sessions.json', 'backups', 'reports',
] as const;

// Self-heal for machines the pre-guard bug already touched. Also drops the
// per-project prefs bucket the bogus "$HOME project" acquired (named by
// local-prefs/prefs-store.ts's projectRootHash — realpath, THEN sha256), which
// carries the stale onboarding server record — but ONLY while that bucket holds
// no recorded use-plugin ANSWER.
//
// The bucket is where a `$HOME` session's yes/no is stored, and this function
// runs unconditionally at the top of EVERY SessionStart in EVERY project, so the
// unconditional delete meant a `$HOME` answer could never survive: measured, a
// decline recorded for `$HOME` was gone after the next session in any unrelated
// directory, and the user was asked again — and answering "no" again re-ran the
// decline sweep against the machine dir (see removeDeclinedProjectArtifacts in
// state/plugin-use.ts, which is the half that used to delete it). Together those
// two made `$HOME` the one shape that could neither consent nor decline safely.
//
// The ARTIFACT sweep above stays unconditional on purpose. `$HOME` is an
// isMachineConfigRoot (shared/authoring-root.ts), so every hook entry stands
// down there and Traffic One never legitimately materializes a project tree into
// it — a `.one.json`/`plan.md`/`rules/` at the machine dir's top level is
// pre-guard residue whether or not an answer exists for `$HOME`.
//
// Lazy require, not an import: state/plugin-use.ts reads the per-user prefs
// through local-prefs, which resolves their path through THIS module, so a static
// import would close a cycle. Same documented escape shared/fsjson.ts uses.
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readPluginUseChoice } = require('./plugin-use') as typeof import('./plugin-use');
    if (readPluginUseChoice(home, env)) return;
    // The bucket NAME must come from the function that CREATES it, not from a
    // second derivation of the same idea. This line used to compute
    // `sha256(path.resolve(home))` while the bucket was created — and read, two
    // lines up, by readPluginUseChoice → readProjectPrefs → projectRootHash — as
    // `sha256(fs.realpathSync(path.resolve(home)))`. Under a SYMLINKED $HOME the
    // two names differ (measured), so the guard consulted one bucket and the
    // delete named a path nothing had ever written: the self-heal silently
    // no-opped on exactly the machines whose $HOME is a symlink. Deleting BOTH
    // spellings would only add a name no writer produces; deriving the one name
    // through the creator is what keeps them from drifting apart again.
    // Lazy require for the same documented reason as plugin-use above —
    // prefs-store resolves the machine dir through THIS module, so a static
    // import would close a cycle.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { projectRootHash } = require('./local-prefs/prefs-store') as typeof import('./local-prefs/prefs-store');
    fs.rmSync(path.join(dir, 'projects', projectRootHash(home)), { recursive: true, force: true });
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
