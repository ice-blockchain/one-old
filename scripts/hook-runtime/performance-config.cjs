'use strict';

// scripts/hook-runtime/performance-config.cjs
// Externalized defaults for each performance level so future automated testing
// can override agents/tiers without touching mode logic.
//
// `tier` is a host-agnostic capability tier (highest | balanced | cheapest, see
// model-tiers.cjs). The actual model id is resolved per host at spawn time. The
// model is set by the spawn tool's `model` PARAMETER — putting a model name in
// the subagent prompt text has no effect.

const PERFORMANCE_LEVEL_IDS = new Set(['low', 'balanced', 'high']);

// Each entry is the authoritative config for that level. Keys:
//   teamMode            — maps to local Traffic One preference team.mode
//   useRoadmapChecklist — only true for low; main agent walks roles as a checklist
//   agents              — map of role → { tier }; empty for low (no subagents)
const PERFORMANCE_CONFIG = {
  low: {
    teamMode: 'main-agent',
    useRoadmapChecklist: true,
    agents: {},
  },
  // Balanced: implementation + review on the mid tier, QA on the cheapest tier.
  balanced: {
    teamMode: 'subagents',
    useRoadmapChecklist: false,
    agents: {
      'senior-architect': { tier: 'balanced' },
      'senior-frontend':  { tier: 'balanced' },
      'senior-backend':   { tier: 'balanced' },
      'senior-reviewer':  { tier: 'balanced' },
      'senior-tester':    { tier: 'cheapest' },
      'senior-shipper':   { tier: 'balanced' },
    },
  },
  // High: reasoning-heavy roles on the highest tier, cheaper QA to contain cost.
  high: {
    teamMode: 'subagents',
    useRoadmapChecklist: false,
    agents: {
      'senior-architect': { tier: 'highest' },
      'senior-frontend':  { tier: 'highest' },
      'senior-backend':   { tier: 'highest' },
      'senior-reviewer':  { tier: 'highest' },
      'senior-tester':    { tier: 'cheapest' },
      'senior-shipper':   { tier: 'balanced' },
    },
  },
};

module.exports = { PERFORMANCE_LEVEL_IDS, PERFORMANCE_CONFIG };
