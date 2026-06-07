// src/shared/state/orchestration-plan.ts
// Run-scoped orchestration plan artifact — the bridge between the LLM orchestrator
// (which decides the per-prompt plan: roster, parallel/sequential graph, per-role
// model tier, per-role rule/skill scope) and the enforcement hooks (the spawn gate +
// subagent rule/skill scoping, which READ it). Persisted beside the per-agent run
// claims at .traffic-one/runs/<runId>/orchestration.json (gitignored, rotates with
// the run). Written ONCE by the orchestrator before spawning; read-only thereafter,
// so parallel frontend∥backend reads never race a write.
//
// Fail-open by design: a missing or malformed plan validates to `null`, so every
// reader falls back to today's static behavior. The validator is lenient on `graph`
// (consumed by the LLM for ordering, never by a hook) and never widens scope — the
// optional per-role `rules`/`skills` are NARROWINGS intersected downstream.

import * as path from 'path';

import { readJson, writeJson } from '../fsjson';
import { obj } from '../obj';
import { canonicalTier } from '../model-tiers';
import { VALID_AGENT_ROLES } from '../../config/state';
import type { TierId } from '../../config/model-tiers';
import { runDir } from './run-agent';

const PLAN_FILE = 'orchestration.json';
const TASK_CLASSES = new Set(['minor', 'standard', 'performance-critical']);

export interface OrchestrationRoleSpec {
  readonly tier: TierId | null;
  readonly rules: string[] | null;
  readonly skills: string[] | null;
}

export interface OrchestrationPlan {
  readonly version: number;
  readonly runId: string;
  readonly taskClass: string;
  readonly roster: string[];
  readonly graph: string[][];
  readonly roles: Record<string, OrchestrationRoleSpec>;
}

export function orchestrationPlanPath(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), PLAN_FILE);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : [];
}

// Structural validation. Returns null (→ callers fall open to static behavior) when
// the plan is absent, malformed, declares an empty/invalid roster, or — when `runId`
// is supplied — does not match the run folder it was read from.
export function validateOrchestrationPlan(raw: unknown, runId?: string): OrchestrationPlan | null {
  const r = obj(raw);
  if (!r) return null;

  const planRunId = typeof r.runId === 'string' ? r.runId.trim() : '';
  if (!planRunId) return null;
  if (runId && planRunId !== runId) return null;

  const roster = stringList(r.roster).filter((role) => VALID_AGENT_ROLES.has(role));
  if (roster.length === 0) return null;
  const rosterSet = new Set(roster);

  const taskClass = typeof r.taskClass === 'string' && TASK_CLASSES.has(r.taskClass) ? r.taskClass : 'standard';

  // Lenient: keep only roster roles per group, drop empty groups. No scheduler — the
  // graph is advisory ordering for the LLM, never read by a hook.
  const graph = (Array.isArray(r.graph) ? r.graph : [])
    .map((group) => stringList(group).filter((role) => rosterSet.has(role)))
    .filter((group) => group.length > 0);

  const rolesRaw = obj(r.roles) || {};
  const roles: Record<string, OrchestrationRoleSpec> = {};
  for (const role of roster) {
    const spec = obj(rolesRaw[role]) || {};
    // An absent OR empty rules/skills list means "no narrowing" (null → full static
    // scope downstream); only a non-empty list narrows. This keeps a plan from ever
    // accidentally stripping a role to zero rules/skills.
    const rules = spec.rules === undefined ? null : stringList(spec.rules);
    const skills = spec.skills === undefined ? null : stringList(spec.skills);
    roles[role] = {
      tier: canonicalTier(spec.tier),
      rules: rules && rules.length > 0 ? rules : null,
      skills: skills && skills.length > 0 ? skills : null,
    };
  }

  return {
    version: typeof r.version === 'number' ? r.version : 1,
    runId: planRunId,
    taskClass,
    roster,
    graph,
    roles,
  };
}

export function readOrchestrationPlan(cwd: string, runId: unknown): OrchestrationPlan | null {
  if (typeof runId !== 'string' || !runId) return null;
  return validateOrchestrationPlan(readJson(orchestrationPlanPath(cwd, runId), null), runId);
}

// Validate then persist. Returns the normalized plan on success, null when the input
// failed validation (nothing is written).
export function writeOrchestrationPlan(cwd: string, plan: unknown): OrchestrationPlan | null {
  const validated = validateOrchestrationPlan(plan);
  if (!validated) return null;
  writeJson(orchestrationPlanPath(cwd, validated.runId), validated);
  return validated;
}

export function planHasRole(plan: OrchestrationPlan | null, role: string): boolean {
  return Boolean(plan && plan.roster.includes(role));
}

export function planRoleTier(plan: OrchestrationPlan | null, role: string): TierId | null {
  return plan ? plan.roles[role]?.tier ?? null : null;
}

export function planRoleRules(plan: OrchestrationPlan | null, role: string): string[] | null {
  const rules = plan ? plan.roles[role]?.rules : null;
  return rules && rules.length > 0 ? rules : null;
}

export function planRoleSkills(plan: OrchestrationPlan | null, role: string): string[] | null {
  const skills = plan ? plan.roles[role]?.skills : null;
  return skills && skills.length > 0 ? skills : null;
}
