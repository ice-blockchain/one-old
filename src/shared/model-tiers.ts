// src/shared/model-tiers.ts
// Host-agnostic capability tiers. Ported 1:1 from scripts/hook-runtime/model-tiers.cjs.
// To adopt newer models, edit ONLY HOST_MODELS.

export const TIER_IDS = ['highest', 'balanced', 'cheapest'] as const;
export type TierId = (typeof TIER_IDS)[number];

const TIER_ALIASES: Readonly<Record<string, TierId>> = {
  max: 'highest', maximum: 'highest', top: 'highest', best: 'highest', high: 'highest',
  mid: 'balanced', medium: 'balanced', standard: 'balanced', default: 'balanced', balance: 'balanced',
  low: 'cheapest', min: 'cheapest', minimal: 'cheapest', cheap: 'cheapest', fast: 'cheapest', lite: 'cheapest',
};

export const HOST_IDS = ['claude', 'codex', 'cursor'] as const;
export type HostModelKey = (typeof HOST_IDS)[number];

export const HOST_MODELS: Readonly<Record<HostModelKey, Record<TierId, string>>> = {
  claude: { highest: 'opus', balanced: 'sonnet', cheapest: 'haiku' },
  cursor: { highest: 'opus', balanced: 'sonnet', cheapest: 'haiku' },
  codex: { highest: 'gpt-5.5', balanced: 'gpt-5', cheapest: 'gpt-5-mini' },
};

export function canonicalTier(tier: unknown): TierId | null {
  if (typeof tier !== 'string') return null;
  const value = tier.trim().toLowerCase();
  if ((TIER_IDS as readonly string[]).includes(value)) return value as TierId;
  return TIER_ALIASES[value] ?? null;
}

export function canonicalHost(host: unknown): HostModelKey {
  if (typeof host !== 'string') return 'claude';
  const value = host.trim().toLowerCase();
  return (HOST_IDS as readonly string[]).includes(value) ? (value as HostModelKey) : 'claude';
}

export function resolveModel(tier: unknown, host: unknown): string | null {
  const canonical = canonicalTier(tier);
  if (!canonical) return null;
  return HOST_MODELS[canonicalHost(host)][canonical];
}

export function tierModelTable(
  tier: unknown,
): { tier: TierId; claude: string; codex: string; cursor: string } | null {
  const canonical = canonicalTier(tier);
  if (!canonical) return null;
  return {
    tier: canonical,
    claude: HOST_MODELS.claude[canonical],
    codex: HOST_MODELS.codex[canonical],
    cursor: HOST_MODELS.cursor[canonical],
  };
}
