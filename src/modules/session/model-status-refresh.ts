// Synchronous bridge from SessionStart to the asynchronous public model-status
// runner. Best-effort by design: a missing runner, timeout, or malformed output
// leaves existing local preferences untouched.

import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { MODEL_STATUS_TIMEOUT_MS } from '../../config/model-status';
import { canonicalHost } from '../../shared/model-tiers';
import { pluginRoot } from '../../shared/paths';

type Spawn = typeof spawnSync;

export function refreshModelStatusForSession(
  cwd: string,
  host: unknown,
  env: NodeJS.ProcessEnv = process.env,
  spawn: Spawn = spawnSync,
  runnerPath?: string,
): SpawnSyncReturns<string> | null {
  if (/^(1|true|on)$/i.test(String(env.TRAFFIC_ONE_MODEL_STATUS_OFF || ''))) return null;
  const runner = runnerPath || path.resolve(pluginRoot(), 'scripts', 'model-status.cjs');
  if (!fs.existsSync(runner)) return null;
  try {
    return spawn(process.execPath, [runner, canonicalHost(host)], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: MODEL_STATUS_TIMEOUT_MS + 750,
      maxBuffer: 64 * 1024,
    }) as SpawnSyncReturns<string>;
  } catch {
    return null;
  }
}
