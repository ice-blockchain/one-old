// Prepare per-case user-level wrappers for hosts whose plugin contract is not a
// marketplace install. XDG paths come from the isolated CaseEnv, so this never
// mutates the maintainer's real OpenCode/Kilo configuration.

import { spawnSync } from 'child_process';
import * as path from 'path';

import { hostFlags } from '../../shared/host/capability-flags';
import type { HostId } from './types';

export interface HostIntegrationResult {
  ok: boolean;
  prepared: boolean;
  error?: string;
}

export function prepareCaseHostIntegration(
  host: HostId,
  distRoot: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): HostIntegrationResult {
  if (!hostFlags(host).opencodeSelfHosted) return { ok: true, prepared: false };
  const runner = path.join(distRoot, 'scripts', `${host}-host.cjs`);
  const commands = [
    ['install', '--yes'],
    ['enable', '--cwd', cwd, '--yes'],
  ];

  for (const args of commands) {
    const result = spawnSync(process.execPath, [runner, ...args], {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.status !== 0) {
      const detail = `${result.stderr || result.stdout || `exit ${String(result.status)}`}`.trim();
      return { ok: false, prepared: false, error: `${host} wrapper ${args[0]} failed: ${detail}` };
    }
  }
  return { ok: true, prepared: true };
}
