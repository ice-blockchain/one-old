// Runtime view of the active host's model catalog. SessionStart keeps one.json
// fresh; gates and dynamic directives consume this local snapshot so project
// artifacts never need to persist a plan or concrete model id.

import type { TierId } from '../config/model-tiers';
import {
  canonicalHost,
  canonicalPlan,
  canonicalTier,
  hostModelSnapshot,
  modelMatchesExpected,
  type HostModelSnapshot,
} from './model-tiers';
import { readOneHostSettings } from './one-settings';

export function currentHostModelSnapshot(
  hostInput: unknown,
  planInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): HostModelSnapshot {
  const host = canonicalHost(hostInput);
  const plan = canonicalPlan(host, planInput);
  try {
    const local = readOneHostSettings(host, env);
    if (local && local.plan === plan) return local;
  } catch {
    // A busy/corrupt settings file must not disable the bundled safe catalog.
  }
  return hostModelSnapshot(host, plan);
}

export function currentModelsForTier(
  tierInput: unknown,
  hostInput: unknown,
  planInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const tier = canonicalTier(tierInput);
  if (!tier) return [];
  return currentHostModelSnapshot(hostInput, planInput, env).tiers[tier as TierId];
}

export function currentModelForTier(
  tierInput: unknown,
  hostInput: unknown,
  planInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return currentModelsForTier(tierInput, hostInput, planInput, env)[0] ?? null;
}

// Find the complete preferred+fallback row that owns a model family. Runtime
// spawn gates use this instead of the bundled alternates table so an API catalog
// change takes effect without writing concrete models into the project.
export function currentAcceptableModels(
  expected: unknown,
  hostInput: unknown,
  planInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const model = typeof expected === 'string' ? expected.trim() : '';
  if (!model) return [];
  const snapshot = currentHostModelSnapshot(hostInput, planInput, env);
  // Prefer the row where this family is the tier's primary. A universal floor
  // such as Composer can also appear as a fallback in highest/balanced; treating
  // that occurrence as its owning row would incorrectly resolve a Composer-only
  // request back up to Opus/Sonnet.
  for (const tier of Object.values(snapshot.tiers)) {
    const preferred = tier[0];
    if (preferred && (modelMatchesExpected(model, preferred) || modelMatchesExpected(preferred, model))) return tier;
  }
  for (const tier of Object.values(snapshot.tiers)) {
    if (tier.some((candidate) => modelMatchesExpected(model, candidate) || modelMatchesExpected(candidate, model))) {
      return tier;
    }
  }
  return [model];
}
