// src/modules/agent-model/role-infer.ts
// Infer the Traffic One senior-* role from a spawn tool input. Ported 1:1 from
// inferTrafficOneSpawnRole / normalizeSubagentRole in gates.cjs.

import { VALID_AGENT_ROLES } from '../../shared/state';

export function normalizeSubagentRole(subagentType: unknown): string | null {
  if (typeof subagentType !== 'string' || !subagentType) return null;
  const role = subagentType.includes(':') ? (subagentType.split(':').pop() as string) : subagentType;
  return VALID_AGENT_ROLES.has(role) ? role : null;
}

export function inferTrafficOneSpawnRole(toolInput: Record<string, unknown>): string | null {
  const direct = normalizeSubagentRole(
    toolInput.subagent_type || toolInput.subagentType || toolInput.agent || toolInput.role || toolInput.type,
  );
  if (direct) return direct;

  const message = [toolInput.message, toolInput.prompt, toolInput.instructions, toolInput.description]
    .filter((value) => typeof value === 'string')
    .join('\n');
  if (!/\bTraffic One\b/i.test(message)) return null;

  const matches = Array.from(VALID_AGENT_ROLES).filter((role) => new RegExp(`\\b${role}\\b`, 'i').test(message));
  return matches.length === 1 ? (matches[0] as string) : null;
}
