// src/test-environment/core/preflight.ts
// Environment checks before a run: Node version (the build + tsx need >=22; the
// default `node` on this machine can be much older, so the npm script must run
// under nvm v22) and host-CLI availability.

import { spawnSync } from 'child_process';

import type { HostCommandConfig, HostId } from './types';

export interface Preflight {
  nodeMajor: number;
  nodeOk: boolean;
  hostAvailable: Record<HostId, boolean>;
}

export function nodeMajor(): number {
  const m = /^v?(\d+)/.exec(process.version);
  return m && m[1] ? Number(m[1]) : 0;
}

export function hostIsAvailable(cfg: HostCommandConfig): boolean {
  try {
    const res = spawnSync(cfg.bin, cfg.probeArgs ?? ['--version'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    return res.status === 0 || (res.status == null && !res.error);
  } catch {
    return false;
  }
}

export function preflight(hosts: Record<HostId, HostCommandConfig>, enabled: HostId[]): Preflight {
  const major = nodeMajor();
  const hostAvailable: Record<HostId, boolean> = { claude: false, codex: false, cursor: false };
  for (const h of enabled) hostAvailable[h] = hostIsAvailable(hosts[h]);
  return { nodeMajor: major, nodeOk: major >= 22, hostAvailable };
}
