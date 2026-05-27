// src/shared/onboarding/perf-directives.ts
// Per-performance-level directives injected into SessionStart: LOW (main-agent
// role checklist), BALANCED + HIGH (subagent team line-ups). Ported 1:1 from
// performance-{low,balanced,high}.cjs + performanceLevelDirective. Prose lives
// in the onboarding-gate skill; the dynamic role checklist / agent line-up come
// from PERFORMANCE_CONFIG + renderTeamLines.

import { PERFORMANCE_CONFIG } from '../performance-config';
import type { OnboardingBlock } from './fallbacks';
import { renderTeamLines } from './team-lines';

const DEFAULT_LOW_ROLES = ['senior-architect', 'senior-frontend', 'senior-backend', 'senior-reviewer', 'senior-tester'];

const MODEL_SET_INSTRUCTIONS = [
  'HOW TO ACTUALLY SET THE MODEL — mandatory, not advisory:',
  "  The subagent model is set ONLY by the spawn tool's `model` PARAMETER. A",
  '  model name written in the prompt text has ZERO effect — the subagent will',
  '  silently inherit the parent model if you omit the param.',
  "  Pass the value from YOUR host's column above:",
  '    Claude Code : `Task`/Agent tool — `model: "<claude value>"` (opus|sonnet|haiku).',
  '    Codex       : `spawn_agent` — `model: "<codex value>"`.',
  '    Cursor      : background-agent/task adapter — set `<cursor value>` per role.',
].join('\n');

function subagentModeVerbatim(header: string, summary: string[], agentLines: string): string {
  return [
    header,
    '',
    ...summary,
    '',
    'Agent model assignments (tier → host model):',
    agentLines,
    '',
    'Auto-launching the Traffic One subagent team (no extra confirmation needed):',
    '  architect → frontend/backend (parallel) → reviewer/tester (parallel)',
    '',
    MODEL_SET_INSTRUCTIONS,
    '',
    'The orchestrator MUST NOT write feature source files.',
  ].join('\n');
}

export function lowModeDirective(block: OnboardingBlock): string {
  const config = PERFORMANCE_CONFIG.low;
  const agents = (config && config.agents) || {};
  const roles = Object.keys(agents).length > 0 ? Object.keys(agents) : DEFAULT_LOW_ROLES;
  const checklist = roles.map((r) => `- [ ] ${r}`).join('\n');
  const verbatim = [
    '═══ traffic-one — performance: LOW (main agent + role checklist) ═══',
    '',
    'Performance level: LOW. Team mode: main-agent.',
    'All Traffic One agent roles run in this single thread.',
    '',
    'Work through the following role checklist in order, marking each [x] before advancing:',
    checklist,
    '',
    'Role responsibilities:',
    '  senior-architect  — Write .traffic-one/plan.md before any feature source.',
    '  senior-frontend   — Implement all UI/frontend changes.',
    '  senior-backend    — Implement all server/API/database changes.',
    '  senior-reviewer   — Review the diff for correctness, security, and style.',
    '  senior-tester     — Add/update tests. End with TESTS_GREEN or TESTS_FAILING.',
    '',
    'Complete each role scope fully before ticking it off and moving to the next.',
  ].join('\n');
  return block('perf-low', { CHECKLIST: checklist }, verbatim);
}

export function balancedModeDirective(overrides: unknown, block: OnboardingBlock): string {
  const agentLines = renderTeamLines('balanced', overrides).join('\n');
  const verbatim = subagentModeVerbatim(
    '═══ traffic-one — performance: BALANCED (subagent team, mid-tier models) ═══',
    ['Performance level: BALANCED. Team mode: subagents.', 'Cost-optimised team: implementation + review on the balanced tier, QA on the cheapest tier.'],
    agentLines,
  );
  return block('perf-balanced', { AGENT_LINES: agentLines }, verbatim);
}

export function highModeDirective(overrides: unknown, block: OnboardingBlock): string {
  const agentLines = renderTeamLines('high', overrides).join('\n');
  const verbatim = subagentModeVerbatim(
    '═══ traffic-one — performance: HIGH (subagent team, highest-tier models) ═══',
    ['Performance level: HIGH. Team mode: subagents.', 'Maximum-performance team: architect, frontend, backend, and reviewer on the highest tier.', 'QA (senior-tester) uses the cheapest tier to contain cost.'],
    agentLines,
  );
  return block('perf-high', { AGENT_LINES: agentLines }, verbatim);
}

export function performanceLevelDirective(level: string, overrides: unknown, block: OnboardingBlock): string {
  switch (level) {
    case 'low': return lowModeDirective(block);
    case 'balanced': return balancedModeDirective(overrides, block);
    case 'high': return highModeDirective(overrides, block);
    default: return '';
  }
}
