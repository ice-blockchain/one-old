// model-resolution-matches: given the seeded performance level + overrides, the
// integrated resolver (modelForRoleHost) agrees with the HOST_MODELS table for
// every role x host, and any team.overrides take precedence over the level
// default. Locks the performance→tier→model contract.

import type { Assertion } from '../core/types';
import { AGENT_ROLES } from '../../config/performance';
import { HOST_IDS, HOST_MODELS, TIER_ALIASES, TIER_IDS, type TierId } from '../../config/model-tiers';
import { effectiveTierForRole, modelForRoleHost } from '../../shared/performance';
import { result } from './util';

function canonTier(v: unknown): TierId | null {
  if (typeof v !== 'string') return null;
  if ((TIER_IDS as readonly string[]).includes(v)) return v as TierId;
  return TIER_ALIASES[v] ?? null;
}

export const assertion: Assertion = {
  id: 'model-resolution-matches',
  title: 'Model resolution matches performance selection',
  appliesTo: (c) => c.preSeed.performance !== undefined,
  run: (ctx) => {
    const level = ctx.testCase.preSeed.performance as string;
    const overrides = ctx.testCase.preSeed.team?.overrides ?? null;
    const mismatches: string[] = [];
    const table: Record<string, Record<string, string | null>> = {};

    for (const role of AGENT_ROLES) {
      const tier = effectiveTierForRole(level, role, overrides, null);
      table[role] = {};
      // Override precedence: if the case pinned this role, the resolved tier must equal it.
      const wanted = overrides ? canonTier(overrides[role]) : null;
      if (wanted && tier !== wanted) {
        mismatches.push(`${role}: override tier ${wanted} not applied (got ${tier})`);
      }
      for (const host of HOST_IDS) {
        const model = modelForRoleHost(level, role, host, overrides, null);
        table[role][host] = model;
        const expected = tier ? HOST_MODELS[host].tiers[tier][0] : null;
        if (model !== expected) {
          mismatches.push(`${role}@${host}: expected ${JSON.stringify(expected)} (tier ${tier}), got ${JSON.stringify(model)}`);
        }
      }
    }

    const detail = `level=${level}${overrides ? ` overrides=${JSON.stringify(overrides)}` : ''}\n${JSON.stringify(table, null, 2)}`;
    if (mismatches.length === 0) return result(ctx, 'PASS', detail);
    return result(ctx, 'FAIL', `Mismatches:\n - ${mismatches.join('\n - ')}\n${detail}`, { actual: table });
  },
};
