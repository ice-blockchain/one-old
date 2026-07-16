import {
  HOST_IDS,
  HOST_MODELS,
  type HostModelKey,
} from '../config/model-tiers';
import { canonicalPlan } from '../shared/model-tiers';

export function hostScopedPerformancePrefs(
  performance: Record<string, unknown>,
  team: Record<string, unknown>,
  plan: unknown = 'pro',
  hosts: readonly HostModelKey[] = HOST_IDS,
): { hosts: Record<string, Record<string, unknown>> } {
  return {
    hosts: Object.fromEntries(hosts.map((host) => [host, {
      performance: { ...performance },
      team: { ...team },
      configuredFor: {
        plan: canonicalPlan(host, plan),
        modelsUpdatedAt: HOST_MODELS[host].updatedAt,
      },
    }])),
  };
}

export function withCursorAvailableModels<T extends { hosts: Record<string, Record<string, unknown>> }>(
  prefs: T,
  models: readonly string[],
  plan: unknown = 'pro',
  options: { modelsUpdatedAt?: string; capturedAt?: string } = {},
): T {
  const cursor = prefs.hosts.cursor ?? {};
  prefs.hosts.cursor = {
    ...cursor,
    availableModels: {
      models: [...models],
      plan: canonicalPlan('cursor', plan),
      modelsUpdatedAt: options.modelsUpdatedAt ?? HOST_MODELS.cursor.updatedAt,
      capturedAt: options.capturedAt ?? new Date().toISOString(),
    },
  };
  return prefs;
}
