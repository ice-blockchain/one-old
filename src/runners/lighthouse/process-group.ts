// POSIX process-group helpers for the standalone Lighthouse runner.
// Kept local to this ESM tree — do not import qa-evidence (CJS).

import type { ChildProcess, SpawnOptions } from 'node:child_process';

export function groupKillsAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

export function spawnGroupOptions(base: SpawnOptions, platform: NodeJS.Platform = process.platform): SpawnOptions {
  return { ...base, detached: groupKillsAvailable(platform) };
}

export function killProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: NodeJS.Signals = 'SIGTERM',
  platform: NodeJS.Platform = process.platform,
): void {
  if (typeof child.pid === 'number' && child.pid > 0 && groupKillsAvailable(platform)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall through to the leader
    }
  }
  try {
    child.kill(signal);
  } catch {
    // best-effort cleanup
  }
}
