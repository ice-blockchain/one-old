// src/shared/node-floor-reexec.ts
// TypeScript half of the below-floor handoff. The generated ES5 guard in
// node-floor.ts can only see a cached managed Node (it cannot import this
// module). Hook entries go through guardedMain after the compiled tree loads,
// so they can call ensureManagedRuntime — cache first, download if allowed —
// and re-exec with the stdin the entry already consumed.

import { spawnSync } from 'child_process';

import { ensureManagedRuntime } from './managed-runtime';
import { NODE_FLOOR_MAJOR, NODE_FLOOR_REEXEC_ENV, writeNodeFloorWarning } from './node-floor';

export type NodeFloorReexecResult = 'ok' | 'warned';

export function hostNodeMajor(version: string = process.versions.node): number {
  return parseInt(String(version).split('.')[0] ?? '', 10);
}

export function hostNodeBelowFloor(version: string = process.versions.node): boolean {
  const major = hostNodeMajor(version);
  return Number.isFinite(major) && major < NODE_FLOOR_MAJOR;
}

/**
 * If this process is below NODE_FLOOR_MAJOR, re-exec argv under a managed Node
 * from ensureManagedRuntime when one is present. Warns and returns when none
 * is. Never throws. process.exit on a successful handoff — the child is the
 * rest of this invocation.
 */
export function reexecUnderManagedNodeIfBelowFloor(opts?: {
  stdin?: string;
}): NodeFloorReexecResult {
  if (process.env[NODE_FLOOR_REEXEC_ENV] === '1') return 'ok';
  if (!hostNodeBelowFloor()) return 'ok';

  const managed = ensureManagedRuntime('node', { minMajor: NODE_FLOOR_MAJOR });
  const bin = managed.ok ? managed.path : null;
  if (bin && bin !== process.execPath) {
    const env: NodeJS.ProcessEnv = { ...process.env, [NODE_FLOOR_REEXEC_ENV]: '1' };
    const args = process.argv.slice(1);
    try {
      const ran = opts && Object.prototype.hasOwnProperty.call(opts, 'stdin')
        ? spawnSync(bin, args, { env, input: opts.stdin ?? '', stdio: ['pipe', 'inherit', 'inherit'] })
        : spawnSync(bin, args, { env, stdio: 'inherit' });
      process.exit(typeof ran.status === 'number' ? ran.status : 1);
    } catch {
      /* fall through to the warning */
    }
  }
  writeNodeFloorWarning();
  return 'warned';
}
