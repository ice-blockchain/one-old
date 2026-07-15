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

export interface TierFallbackRequest {
  /** The role's tier at the time the failed subagent was started. */
  readonly tier: TierId;
  /** Models already proven API-limited for this role in the current run. */
  readonly exhaustedModels?: readonly string[];
  /** Models positively proven unavailable/disabled for this role. */
  readonly unavailableModels?: readonly string[];
  /**
   * Exact model slugs offered by the current runner. When supplied, candidates
   * without a matching offered slug are skipped and the returned `model` is the
   * exact slug. Omit on hosts whose tier ids are already directly runnable.
   */
  readonly capturedModels?: readonly string[];
}

export interface TierFallbackCandidate {
  /** Family entry from the configured tier row. */
  readonly family: string;
  /** Exact runnable slug (or the family itself when no capture is supplied). */
  readonly model: string;
}

function sameModelFamily(left: string, right: string): boolean {
  return modelMatchesExpected(left, right) || modelMatchesExpected(right, left);
}

/**
 * Resolve the first still-eligible model from a role's ORIGINAL tier row.
 *
 * Deliberately never derives a row from the failed model: a family may occur in
 * several rows, and deriving from it can silently move a highest-tier role into
 * the balanced chain. Callers persist `tier` at SubagentStart and pass it back
 * here for every retry.
 */
export function resolveTierFallback(
  request: TierFallbackRequest,
  hostInput: unknown,
  planInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): TierFallbackCandidate | null {
  const row = currentModelsForTier(request.tier, hostInput, planInput, env);
  const excluded = [
    ...(request.exhaustedModels ?? []),
    ...(request.unavailableModels ?? []),
  ].filter((model): model is string => typeof model === 'string' && model.trim().length > 0);
  const captured = request.capturedModels;

  for (const family of row) {
    if (excluded.some((model) => sameModelFamily(model, family))) continue;
    if (captured !== undefined) {
      // Captured runner slugs must satisfy the same one-way contract as the
      // spawn gate: an exact family id or a concrete `family-*` variant. A
      // shorter prefix (for example `claude-4.6` for `claude-4.6-sonnet`) is
      // not runnable proof for this tier entry and must never be prescribed.
      const slug = captured.find((model) => modelMatchesExpected(model, family));
      if (!slug) continue;
      return { family, model: slug };
    }
    return { family, model: family };
  }
  return null;
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

// The first model in `exhausted`'s tier row that is NOT the exhausted family and
// NOT in `alsoExhausted` — i.e. the next same-tier model still usable this session
// after one or more API-limit failures. Family-level id (the spawn gate accepts it;
// Cursor slug resolution happens at spawn time). '' when the row offers no untried
// same-tier model. Shared by the PreToolUse spawn gate (the only rotation point on
// Cursor, which emits no post-spawn stop event) and the PostToolUse stop recorder.
export function nextSameTierFallback(
  exhausted: unknown,
  hostInput: unknown,
  planInput: unknown,
  alsoExhausted: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const model = typeof exhausted === 'string' ? exhausted.trim() : '';
  if (!model) return '';
  const row = currentAcceptableModels(model, hostInput, planInput, env);
  const isExhausted = (candidate: string): boolean =>
    modelMatchesExpected(model, candidate)
    || alsoExhausted.some((x) => modelMatchesExpected(x, candidate) || modelMatchesExpected(candidate, x));
  return row.find((entry) => !isExhausted(entry)) || '';
}
