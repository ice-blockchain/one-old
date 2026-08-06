// src/shared/toolchain-paths.ts
// Pure path helpers for the Traffic One managed toolchain root
// (~/.traffic-one/toolchains by default). Shared between the toolchain runners
// and hook modules (e.g. the SessionStart OpenCode self-heal) — modules stay
// runner-free, runners re-export these for their existing import sites.

import * as path from 'path';

import { globalTrafficOneDir } from './state-root';

// TRAFFIC_ONE_TOOLCHAIN_ROOT wins outright and is deliberately NOT part of the
// shared base: it relocates only the gigabyte-scale half (venvs, npm prefixes,
// browser binaries), while XDG_STATE_HOME relocates the whole kilobyte-scale
// machine tree. Two complete, non-overlapping knobs — keep the fall-through
// second, so a machine that has moved its state home still keeps toolchains
// beside the rest of it.
export function toolchainRoot(): string {
  if (process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT) return path.resolve(process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT);
  return path.join(globalTrafficOneDir(), 'toolchains');
}

export function managedToolDir(toolName: string): string {
  return path.join(toolchainRoot(), toolName);
}

export function managedVenvBin(toolName: string, binName: string = toolName): string {
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(managedToolDir(toolName), 'venv', binDir, `${binName}${ext}`);
}

export function managedVenvPython(toolName: string): string {
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(managedToolDir(toolName), 'venv', binDir, `python${ext}`);
}

export function managedNpmPrefix(toolName: string): string {
  return path.join(managedToolDir(toolName), 'npm-prefix');
}

// npm config flags for a managed `npm install -g`. npm >= 11 REJECTS the same
// config file at two levels ("Exit prior to config file resolving / double-loading
// config <p> as global, previously loaded as user") — which broke every managed
// opencode/gitnexus install on node 25 / npm 11, leaving the tool unstamped and
// delegation silently off. Pass two DISTINCT managed paths instead: both absent →
// npm treats them as empty user+global config, still shielding the install from a
// real `~/.npmrc`/global `prefix=` that could redirect it out of the managed dir
// (the `--prefix` CLI flag sets the real target with highest precedence).
export function managedNpmConfigFlags(prefix: string): string[] {
  return [
    '--userconfig', path.join(prefix, 'managed-user.npmrc'),
    '--globalconfig', path.join(prefix, 'managed-global.npmrc'),
  ];
}

// Shared store for managed standalone language runtimes (Python/Node) fetched by
// src/shared/managed-runtime.ts. Keyed by kind+version (NOT per-tool) so a Node
// downloaded for gitnexus is reused by opencode instead of fetched twice.
export function managedRuntimeDir(kind: 'python' | 'node', version: string): string {
  return path.join(toolchainRoot(), '_runtimes', kind, version);
}

export function managedNpmBin(toolName: string, binName: string = toolName): string {
  // `npm install -g --prefix P` lays the bin shim out differently per OS:
  //   POSIX → P/bin/<name>;  Windows → FLAT at P/<name>.cmd (no bin/ subdir).
  if (process.platform === 'win32') {
    return path.join(managedNpmPrefix(toolName), `${binName}.cmd`);
  }
  return path.join(managedNpmPrefix(toolName), 'bin', binName);
}
