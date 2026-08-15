import {
  HOST_IDS,
  type HostModelKey,
} from '../config/model-tiers';
import { currentHostModelTarget } from '../shared/current-model-tiers';

function targetFor(host: HostModelKey, plan: unknown): { plan: string; appliedFingerprint: string; configVersion: number } {
  const target = currentHostModelTarget(host, plan);
  return {
    plan: target.snapshot.plan,
    appliedFingerprint: target.appliedFingerprint,
    configVersion: target.configVersion,
  };
}

export function hostScopedPerformancePrefs(
  performance: Record<string, unknown>,
  team: Record<string, unknown>,
  plan: unknown = 'pro',
  hosts: readonly HostModelKey[] = HOST_IDS,
): { hosts: Record<string, Record<string, unknown>> } {
  return {
    hosts: Object.fromEntries(hosts.map((host) => [host, {
      performance: { ...performance, target: targetFor(host, plan) },
      team: { ...team },
    }])),
  };
}

export function withCursorAvailableModels<T extends { hosts: Record<string, Record<string, unknown>> }>(
  prefs: T,
  models: readonly string[],
  plan: unknown = 'pro',
  options: { capturedAt?: string; appliedFingerprint?: string } = {},
): T {
  const cursor = prefs.hosts.cursor ?? {};
  prefs.hosts.cursor = {
    ...cursor,
    availableModels: {
      models: [...models],
      capturedAt: options.capturedAt ?? new Date().toISOString(),
      target: {
        ...targetFor('cursor', plan),
        ...(options.appliedFingerprint ? { appliedFingerprint: options.appliedFingerprint } : {}),
      },
    },
  };
  return prefs;
}
