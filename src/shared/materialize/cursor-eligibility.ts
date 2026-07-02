// src/shared/materialize/cursor-eligibility.ts
// Which senior-team roles have a PICKED tier model that this Cursor build does NOT offer (the
// model is disabled in Settings → Models, or not on the user's plan). Shared by the user-facing
// notice (converge-from-write), the beforeShellExecution model-gate prompt (agent-model), and the
// model-gate runner — one source of truth so all three name the same model + fallback.
//
// cursor-models.json only exists on Cursor, so callers are implicitly Cursor-scoped. Dependency-
// free; never throws (returns []).

import { AGENT_ROLES } from '../../config/performance';
import { detectHostPlan } from '../host-plan';
import { acceptableModelsFor } from '../model-tiers';
import { obj } from '../obj';
import { modelForRoleHost, openCodeDelegationActive } from '../performance';
import { freshCursorModels, pickCursorSlug } from './cursor-models';

export interface UnavailablePick {
  role: string;     // senior-<role>
  expected: string; // the tier-family model the user PICKED (e.g. claude-4.6-sonnet)
  fallback: string; // the same-tier alternate the build DOES offer (e.g. gpt-5.5-medium)
}

// Roles whose picked NON-composer tier model is absent from the fresh captured list. Empty when
// nothing is captured (can't judge), when every pick is offered, or when state is unreadable.
export function cursorUnavailablePicks(cwd: string, state: Record<string, unknown>): UnavailablePick[] {
  try {
    const performance = obj(state.performance);
    const level = performance && typeof performance.level === 'string' ? performance.level : '';
    if (!level) return [];
    const team = obj(state.team);
    const overrides = team && obj(team.overrides) ? (team.overrides as Record<string, unknown>) : null;
    const plan = detectHostPlan('cursor');
    const planCtx = { host: 'cursor', plan, useOpenCode: openCodeDelegationActive(state, 'cursor') };
    const captured = freshCursorModels(cwd, plan);
    if (!captured.length) return [];
    const out: UnavailablePick[] = [];
    for (const role of AGENT_ROLES) {
      const expected = modelForRoleHost(level, role, 'cursor', overrides, planCtx);
      if (!expected || /^composer/i.test(expected)) continue;   // cheapest tier wants Composer — nothing to enable
      if (pickCursorSlug([expected], captured)) continue;        // the picked model IS offered → fine
      const alts = acceptableModelsFor(expected, 'cursor').slice(1);
      const fallback = pickCursorSlug(alts, captured) || alts[0] || expected;
      out.push({ role, expected, fallback });
    }
    return out;
  } catch {
    return [];
  }
}

// Shared STOP copy for model-gate + orchestrator: fail closed until the user replies
// `fallback` or `enable` in chat (recorded in model-choice.json via prompt-submit).
export function formatModelChoiceRequiredStop(cwd: string, state: Record<string, unknown>): string {
  const picks = cursorUnavailablePicks(cwd, state);
  if (!picks.length) return '';
  const rows = picks.map((p) => `  • ${p.role}: ${p.expected} → would run on ${p.fallback}`);
  const enable = Array.from(new Set(picks.map((p) => p.expected))).join(', ');
  return (
    'traffic-one model-gate: STOP — model choice required (build paused).\n'
    + `${rows.join('\n')}\n\n`
    + `Reply **fallback** in chat to proceed on the listed model(s).\n`
    + `Reply **enable** to turn on ${enable} (Cursor Settings → Models), re-capture cursor-models.json, then retry.\n`
    + 'Do not spawn subagents, scaffold directly, or edit project files until you reply.'
  );
}

// User-visible notice when cursor-models.json is captured (PostToolUse systemMessage).
export function cursorPickedModelUnavailableNotice(projectRoot: string, state: Record<string, unknown>): string {
  const picks = cursorUnavailablePicks(projectRoot, state);
  if (!picks.length) return '';
  const rows = picks.map((p) => `• ${p.role}: you picked ${p.expected} → it isn't available, would run on ${p.fallback}`);
  const enable = Array.from(new Set(picks.map((p) => p.expected))).join(', ');
  return (
    'traffic-one — model choice required (Cursor, build paused):\n'
    + `${rows.join('\n')}\n\n`
    + `Reply **fallback** to proceed on the listed model(s).\n`
    + `Reply **enable** to turn ${enable} on (Cmd/Ctrl+Shift+J → Models), re-capture models, then retry.\n`
    + 'The team will NOT spawn until you reply; do not scaffold directly or edit project files.'
  );
}
