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

  // Primary declaration wins. Every orchestrator spawn prompt opens with
  // "You are acting as Traffic One `<role>`" (the host with no structured
  // subagent_type field — e.g. Codex's generic `agent_type: "worker"` — carries
  // the role only here). Anchoring on that declaration is essential because the
  // prompt also names SIBLING roles in scope-coordination notes ("senior-backend
  // owns …"), which would otherwise make the count-the-mentions fallback below
  // ambiguous and silently disable the gate for every parallel role spawn.
  const declared = /(?:acting as|you are)(?:\s+the)?\s+Traffic One[\s`'"*]*([a-z][a-z-]+)/i.exec(message);
  if (declared && VALID_AGENT_ROLES.has(declared[1] as string)) return declared[1] as string;

  // Clause-anchored declaration ("Traffic One `senior-X` for run … / role …"):
  // the dominant real prompt shape opens with it, and same-sentence anchoring
  // picks the DECLARED role even though later sentences name sibling roles
  // (observed live: "You are the Traffic One senior-architect for run …" plus
  // scope notes mentioning senior-frontend/senior-backend → the
  // count-the-mentions fallback below returned null and the spawn recorder
  // silently skipped every registry write).
  const clause = /\btraffic[\s-]?one\b[^.\n]{0,60}?\b(senior-(?:architect|frontend|backend|reviewer|tester|shipper))\b/i.exec(message);
  if (clause && VALID_AGENT_ROLES.has(clause[1] as string)) return clause[1] as string;

  const matches = Array.from(VALID_AGENT_ROLES).filter((role) => new RegExp(`\\b${role}\\b`, 'i').test(message));
  return matches.length === 1 ? (matches[0] as string) : null;
}
