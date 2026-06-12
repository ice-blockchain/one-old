// src/shared/toolchain-paths.ts
// Pure path helpers for the Traffic One managed toolchain root
// (~/.traffic-one/toolchains by default). Shared between the toolchain runners
// and hook modules (e.g. the SessionStart OpenCode self-heal) — modules stay
// runner-free, runners re-export these for their existing import sites.

import * as os from 'os';
import * as path from 'path';

export function toolchainRoot(): string {
  if (process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT) return path.resolve(process.env.TRAFFIC_ONE_TOOLCHAIN_ROOT);
  const stateHome = process.env.XDG_STATE_HOME
    ? path.join(process.env.XDG_STATE_HOME, 'traffic-one')
    : path.join(process.env.HOME || os.homedir(), '.traffic-one');
  return path.join(stateHome, 'toolchains');
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

export function managedNpmBin(toolName: string, binName: string = toolName): string {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  return path.join(managedNpmPrefix(toolName), 'bin', `${binName}${ext}`);
}
