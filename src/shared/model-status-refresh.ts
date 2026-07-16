// Reconcile the active host's locally detected plan and model catalog. Remote
// failures are fail-open, but a newer bundled snapshot still advances local
// state so a plugin model update can refresh Performance while the endpoint is
// unavailable. Older bundled/API data never downgrades a newer local snapshot.

import type { HostModelKey } from '../config/model-tiers';
import { modelStatusEndpoint } from '../config/model-status';
import { detectHostPlan } from './host-plan';
import {
  canonicalHost,
  hostModelSnapshot,
  parseModelStatusResponse,
  type HostModelSnapshot,
} from './model-tiers';
import { requestModelStatus } from './model-status-client';
import { readOneHostSettings, writeOneHostSettings } from './one-settings';

export type ModelStatusRefreshOutcome =
  | 'unchanged'
  | 'remote-updated'
  | 'bundled-plan-updated'
  | 'unavailable'
  | 'invalid';

export interface ModelStatusRefreshResult {
  readonly host: HostModelKey;
  readonly plan: string;
  readonly outcome: ModelStatusRefreshOutcome;
  readonly changed: boolean;
  readonly snapshot: HostModelSnapshot | null;
}

export interface ModelStatusRefreshOptions {
  env?: NodeJS.ProcessEnv;
  readHost?: (host: HostModelKey, env: NodeJS.ProcessEnv) => HostModelSnapshot | null;
  writeHost?: (host: HostModelKey, snapshot: HostModelSnapshot, env: NodeJS.ProcessEnv) => unknown;
  fetchStatus?: (host: HostModelKey, plan: string, env: NodeJS.ProcessEnv) => Promise<unknown>;
}

function equalSnapshot(left: HostModelSnapshot | null, right: HostModelSnapshot): boolean {
  if (!left) return false;
  return left.plan === right.plan
    && left.updatedAt === right.updatedAt
    && JSON.stringify(left.tiers) === JSON.stringify(right.tiers);
}

type SnapshotSource = 'bundled' | 'current' | 'remote';

interface SnapshotCandidate {
  readonly source: SnapshotSource;
  readonly snapshot: HostModelSnapshot;
}

function newestSnapshot(
  current: HostModelSnapshot | null,
  bundled: HostModelSnapshot,
  remote: HostModelSnapshot | null,
): SnapshotCandidate {
  // Equal dates are semantic versions: a validated remote may replace bundled,
  // while the persisted local value wins the final tie so refresh never rewrites
  // an equal-version snapshot or repairs unversioned tier drift silently.
  let selected: SnapshotCandidate = { source: 'bundled', snapshot: bundled };
  if (remote && remote.updatedAt >= selected.snapshot.updatedAt) {
    selected = { source: 'remote', snapshot: remote };
  }
  if (current?.plan === bundled.plan && current.updatedAt >= selected.snapshot.updatedAt) {
    selected = { source: 'current', snapshot: current };
  }
  return selected;
}

function transportDisabled(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|on)$/i.test(String(env.TRAFFIC_ONE_MODEL_STATUS_OFF || ''));
}

export async function refreshHostModelStatus(
  hostInput: unknown,
  options: ModelStatusRefreshOptions = {},
): Promise<ModelStatusRefreshResult> {
  const env = options.env || process.env;
  const host = canonicalHost(hostInput);
  const plan = detectHostPlan(host, env);
  const readHost = options.readHost || readOneHostSettings;
  const writeHost = options.writeHost || writeOneHostSettings;
  const current = readHost(host, env);
  const bundled = hostModelSnapshot(host, plan);
  let remotePayload: unknown;
  let unavailable = false;

  try {
    if (transportDisabled(env)) throw new Error('model-status transport disabled');
    remotePayload = options.fetchStatus
      ? await options.fetchStatus(host, plan, env)
      : await requestModelStatus(modelStatusEndpoint(env), host, plan);
  } catch {
    unavailable = true;
  }

  let remote: HostModelSnapshot | null = null;
  if (!unavailable) {
    remote = parseModelStatusResponse(remotePayload, {
      expectedHost: host,
      expectedPlan: plan,
      current,
    });
  }

  const selected = newestSnapshot(current, bundled, remote);
  if (!equalSnapshot(current, selected.snapshot)) {
    writeHost(host, selected.snapshot, env);
    return {
      host,
      plan,
      outcome: selected.source === 'remote' ? 'remote-updated' : 'bundled-plan-updated',
      changed: true,
      snapshot: selected.snapshot,
    };
  }

  return {
    host,
    plan,
    outcome: unavailable ? 'unavailable' : remote ? 'unchanged' : 'invalid',
    changed: false,
    snapshot: current,
  };
}
