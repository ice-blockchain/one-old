'use strict';

// scripts/hook-runtime/performance-high.cjs
// Directive for HIGH performance mode.
// Full subagent team on the highest tier; QA uses the cheapest tier.

const { PERFORMANCE_CONFIG } = require('./performance-config.cjs');
const { canonicalTier, tierModelTable } = require('./model-tiers.cjs');

function highModeDirective(overrides) {
  const config = PERFORMANCE_CONFIG.high;
  const agentLines = Object.entries(config.agents)
    .map(([role, cfg]) => {
      const override = overrides && typeof overrides === 'object' ? canonicalTier(overrides[role]) : null;
      const tier = override || cfg.tier;
      const t = tierModelTable(tier);
      const tag = override ? ' (override)' : '';
      return `  ${role}: ${t.tier}${tag} → claude:${t.claude} · codex:${t.codex} · cursor:${t.cursor}`;
    })
    .join('\n');

  return [
    '═══ traffic-one — performance: HIGH (subagent team, highest-tier models) ═══',
    '',
    'Performance level: HIGH. Team mode: subagents.',
    'Maximum-performance team: architect, frontend, backend, and reviewer on the highest tier.',
    'QA (senior-tester) uses the cheapest tier to contain cost.',
    '',
    'Agent model assignments (tier → host model):',
    agentLines,
    '',
    'Auto-launching the Traffic One subagent team (no extra confirmation needed):',
    '  architect → frontend/backend (parallel) → reviewer/tester (parallel)',
    '',
    'HOW TO ACTUALLY SET THE MODEL — mandatory, not advisory:',
    '  The subagent model is set ONLY by the spawn tool\'s `model` PARAMETER. A',
    '  model name written in the prompt text has ZERO effect — the subagent will',
    '  silently inherit the parent model if you omit the param.',
    '  Pass the value from YOUR host\'s column above:',
    '    Claude Code : `Task`/Agent tool — `model: "<claude value>"` (opus|sonnet|haiku).',
    '    Codex       : `spawn_agent` — `model: "<codex value>"`.',
    '    Cursor      : background-agent/task adapter — set `<cursor value>` per role.',
    '',
    'The orchestrator MUST NOT write feature source files.',
  ].join('\n');
}

module.exports = { highModeDirective };
