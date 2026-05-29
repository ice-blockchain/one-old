// src/shared/onboarding/perf-directives.ts
// Per-performance-level directives injected into SessionStart: LOW (main-agent
// role checklist), BALANCED + HIGH (subagent team line-ups). The prose lives in
// the onboarding-gate SKILL.md; the dynamic role checklist / agent line-up come
// from PERFORMANCE_CONFIG + renderTeamLines and are passed in as vars.

import { PERFORMANCE_CONFIG } from '../performance-config';
import type { OnboardingBlock } from './fallbacks';
import { renderTeamLines } from './team-lines';

const DEFAULT_LOW_ROLES = ['senior-architect', 'senior-frontend', 'senior-backend', 'senior-reviewer', 'senior-tester'];

export function lowModeDirective(block: OnboardingBlock): string {
  const config = PERFORMANCE_CONFIG.low;
  const agents = (config && config.agents) || {};
  const roles = Object.keys(agents).length > 0 ? Object.keys(agents) : DEFAULT_LOW_ROLES;
  const checklist = roles.map((r) => `- [ ] ${r}`).join('\n');
  return block('perf-low', { CHECKLIST: checklist });
}

export function balancedModeDirective(overrides: unknown, block: OnboardingBlock): string {
  const agentLines = renderTeamLines('balanced', overrides).join('\n');
  return block('perf-balanced', { AGENT_LINES: agentLines });
}

export function highModeDirective(overrides: unknown, block: OnboardingBlock): string {
  const agentLines = renderTeamLines('high', overrides).join('\n');
  return block('perf-high', { AGENT_LINES: agentLines });
}

export function performanceLevelDirective(level: string, overrides: unknown, block: OnboardingBlock): string {
  switch (level) {
    case 'low': return lowModeDirective(block);
    case 'balanced': return balancedModeDirective(overrides, block);
    case 'high': return highModeDirective(overrides, block);
    default: return '';
  }
}

// SessionStart "popup 1": the Performance preflight.
export function performancePopupBlock(block: OnboardingBlock): string {
  return block('performance-popup', {});
}

// SessionStart "popup 2": the Team Confirmation preflight, with the canonical
// HIGH/BALANCED role line-up tables rendered from the config and passed as vars.
export function teamConfirmationPopupBlock(block: OnboardingBlock): string {
  const highRows = renderTeamLines('high').join('\n');
  const balancedRows = renderTeamLines('balanced').join('\n');
  return block('team-confirmation-popup', { HIGH_ROWS: highRows, BALANCED_ROWS: balancedRows });
}
