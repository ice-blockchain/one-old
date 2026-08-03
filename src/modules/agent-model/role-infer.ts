// src/modules/agent-model/role-infer.ts
// Resolve Traffic One role identity from an orchestrator-owned spawn input.

import {
  normalizeRoleIdentity,
  type RoleEvidence,
  type RoleEvidenceResolution,
} from '../../shared/state';

type CandidateField = readonly [value: unknown, source: string];

function evidence(value: unknown, source: string, authority: RoleEvidence['authority']): RoleEvidence | null {
  const role = normalizeRoleIdentity(value);
  return role ? { role, source, authority } : null;
}

function candidates(fields: CandidateField[], authority: RoleEvidence['authority']): RoleEvidence[] {
  return fields
    .map(([value, source]) => evidence(value, source, authority))
    .filter((candidate): candidate is RoleEvidence => Boolean(candidate));
}

function resolve(candidatesForTier: RoleEvidence[]): RoleEvidenceResolution {
  if (candidatesForTier.length === 0) return { kind: 'none' };
  const roles = new Set(candidatesForTier.map((candidate) => candidate.role));
  return roles.size === 1
    ? { kind: 'evidence', evidence: candidatesForTier[0]! }
    : { kind: 'conflict', candidates: candidatesForTier };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textFields(...values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function markerEvidence(texts: string[]): RoleEvidenceResolution {
  const found: RoleEvidence[] = [];
  const marker = /\[t1-role:\s*((?:senior[-_](?:architect|frontend|backend|reviewer|tester|shipper)|quick[-_]fix)(?:[-_]\d+)?)\s*\]/ig;
  for (const text of texts) {
    marker.lastIndex = 0;
    for (let match = marker.exec(text); match; match = marker.exec(text)) {
      const candidate = evidence(match[1], 'spawn-role-marker', 'explicit');
      if (candidate) found.push(candidate);
    }
  }
  return resolve(found);
}

function firstHeuristicTier(texts: string[], expressions: readonly RegExp[]): RoleEvidenceResolution {
  const found: RoleEvidence[] = [];
  for (const text of texts) {
    for (const expression of expressions) {
      const match = expression.exec(text);
      const candidate = match ? evidence(match[1], 'spawn-role-declaration', 'heuristic') : null;
      if (candidate) found.push(candidate);
    }
  }
  return resolve(found);
}

/**
 * Resolve spawn identity tier-by-tier. Non-role values are absent evidence; only
 * different valid roles inside the same tier conflict. Structured host metadata
 * outranks task_name, which outranks recognized prompt evidence.
 */
export function inferTrafficOneSpawnRoleEvidence(toolInput: Record<string, unknown>): RoleEvidenceResolution {
  const payload = object(toolInput.payload);
  // Host wrappers may preserve an event-level `source` while carrying the actual
  // child identity under `payload.source`. Inspect both independently: using a
  // nullish fallback would let an irrelevant (or merely empty) top-level source mask
  // the authoritative nested thread_spawn record. Accept the camelCase outer key
  // too; inner fields already support both host spellings below.
  const threadSpawns = [object(toolInput.source), object(payload.source)].map((source) => {
    const subagent = object(source.subagent);
    return object(subagent.thread_spawn ?? subagent.threadSpawn);
  });

  const hostResolution = resolve(candidates([
    [toolInput.subagent_type, 'host-subagent-type'],
    [toolInput.subagentType, 'host-subagent-type'],
    [toolInput.agent_type, 'host-agent-type'],
    [toolInput.agentType, 'host-agent-type'],
    [toolInput.agent_role, 'host-agent-role'],
    [toolInput.agentRole, 'host-agent-role'],
    [toolInput.agent_path, 'host-agent-path'],
    [toolInput.agentPath, 'host-agent-path'],
    [payload.subagent_type, 'host-subagent-type'],
    [payload.subagentType, 'host-subagent-type'],
    [payload.agent_type, 'host-agent-type'],
    [payload.agentType, 'host-agent-type'],
    [payload.agent_role, 'host-agent-role'],
    [payload.agentRole, 'host-agent-role'],
    [payload.agent_path, 'host-agent-path'],
    [payload.agentPath, 'host-agent-path'],
    ...threadSpawns.flatMap((threadSpawn): CandidateField[] => [
      [threadSpawn.agent_role, 'host-agent-role'],
      [threadSpawn.agentRole, 'host-agent-role'],
      [threadSpawn.agent_path, 'host-agent-path'],
      [threadSpawn.agentPath, 'host-agent-path'],
    ]),
    // Preserve existing host bindings whose canonical role is carried in a
    // profile/name field rather than an agent_type field.
    [toolInput.subagent_profile, 'host-profile'],
    [toolInput.subagentProfile, 'host-profile'],
    [toolInput.profile, 'host-profile'],
    [toolInput.profile_name, 'host-profile'],
    [toolInput.profileName, 'host-profile'],
    [toolInput.name, 'host-agent-name'],
    [toolInput.agent, 'host-agent-name'],
    [toolInput.role, 'host-agent-role'],
    [toolInput.type, 'host-agent-type'],
    [toolInput.agentName, 'host-agent-name'],
    [toolInput.agent_name, 'host-agent-name'],
  ], 'authoritative'));
  if (hostResolution.kind !== 'none') return hostResolution;

  const taskNameResolution = resolve(candidates([
    [toolInput.task_name, 'spawn-task-name'],
    [toolInput.taskName, 'spawn-task-name'],
    [payload.task_name, 'spawn-task-name'],
    [payload.taskName, 'spawn-task-name'],
    ...threadSpawns.flatMap((threadSpawn): CandidateField[] => [
      [threadSpawn.task_name, 'spawn-task-name'],
      [threadSpawn.taskName, 'spawn-task-name'],
    ]),
  ], 'authoritative'));
  if (taskNameResolution.kind !== 'none') return taskNameResolution;

  const texts = textFields(
    toolInput.message, toolInput.prompt, toolInput.task, toolInput.instructions, toolInput.description,
    payload.message, payload.prompt, payload.task, payload.instructions, payload.description,
  );
  const markerResolution = markerEvidence(texts);
  if (markerResolution.kind !== 'none') return markerResolution;

  const joined = texts.join('\n');
  const hasTrafficOneLiteral = /\bTraffic One\b/i.test(joined);

  // Fix-cycle prompts routinely omit the literal "Traffic One" (observed 7c: the
  // orchestrator spawned generic `general-purpose` workers with "Fix
  // CHANGES_REQUESTED items owned by senior-frontend" — role unresolved, the
  // unbound child died as "Couldn't start"). The explicit ownership/continuation
  // phrasings below name a canonical role directly, so they resolve without the
  // literal; the weaker bare-mention tier at the bottom stays gated behind it.
  const primary = firstHeuristicTier(texts, [
    /\bowned by\b[^.\n]{0,24}?\b(senior-(?:architect|frontend|backend|reviewer|tester|shipper))\b/i,
    /\bcontinuing as\b[^.\n]{0,24}?\b(senior-(?:architect|frontend|backend|reviewer|tester|shipper))\b/i,
    ...(hasTrafficOneLiteral ? [
      /(?:acting as|you are)(?:\s+the)?\s+Traffic One[\s`'"*]*([a-z][a-z-]+)/i,
      /\byou are\b[^.\n]{0,40}?\b(senior-(?:architect|frontend|backend|reviewer|tester|shipper))\b/i,
      /\btraffic[\s-]?one\b[^.\n]{0,60}?\b(senior-(?:architect|frontend|backend|reviewer|tester|shipper))\b/i,
    ] : []),
  ]);
  if (primary.kind !== 'none') return primary;

  if (!hasTrafficOneLiteral) return { kind: 'none' };

  const mentioned = Array.from(new Set(
    Array.from(joined.matchAll(/\b(senior-(?:architect|frontend|backend|reviewer|tester|shipper)|quick-fix)\b/ig))
      .map((match) => normalizeRoleIdentity(match[1]))
      .filter((role): role is string => Boolean(role)),
  )).map((role) => ({ role, source: 'spawn-role-mention', authority: 'heuristic' as const }));
  return resolve(mentioned);
}


// Backward-compatible string API used by the existing gates and recorders.
export function inferTrafficOneSpawnRole(toolInput: Record<string, unknown>): string | null {
  const resolution = inferTrafficOneSpawnRoleEvidence(toolInput);
  return resolution.kind === 'evidence' ? resolution.evidence.role : null;
}
