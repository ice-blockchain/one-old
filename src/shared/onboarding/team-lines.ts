// src/shared/onboarding/team-lines.ts
// Renders the subagent role → tier → per-host model line-up for the Team
// Confirmation popup + chat fallback. Pure (config + model-tier lookups only).
// Ported 1:1 from resolveTeamTiers/renderTeamLines (agents-team-confirmation-prompt.cjs).

import { canonicalTier, type TierId, tierModelTable } from '../model-tiers';
import { PERFORMANCE_CONFIG } from '../performance-config';

type Rec = Record<string, unknown>;

// Effective tier map for a level after applying user overrides. Overrides that
// don't match a configured role, or aren't a canonical tier, are ignored.
export function resolveTeamTiers(level: string, overrides?: unknown): Record<string, TierId> {
  const cfg = PERFORMANCE_CONFIG[level as keyof typeof PERFORMANCE_CONFIG];
  if (!cfg || !cfg.agents) return {};
  const ov = overrides && typeof overrides === 'object' ? (overrides as Rec) : null;
  const out: Record<string, TierId> = {};
  for (const [role, roleCfg] of Object.entries(cfg.agents)) {
    let tier: TierId = roleCfg.tier;
    if (ov) {
      const canonical = canonicalTier(ov[role]);
      if (canonical) tier = canonical;
    }
    out[role] = tier;
  }
  return out;
}

// Plain-text role lines, shared by the popup directive and the chat fallback so
// the wording stays in sync.
export function renderTeamLines(level: string, overrides?: unknown): string[] {
  const tiers = resolveTeamTiers(level, overrides);
  const ov = overrides && typeof overrides === 'object' ? (overrides as Rec) : null;
  return Object.entries(tiers).map(([role, tier]) => {
    const t = tierModelTable(tier);
    const overridden = ov && ov[role] ? ' (override)' : '';
    const cols = t ? `${t.tier}${overridden} → claude:${t.claude} · codex:${t.codex} · cursor:${t.cursor}` : String(tier);
    return `  ${role}: ${cols}`;
  });
}
