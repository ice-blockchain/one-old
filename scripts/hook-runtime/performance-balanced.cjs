'use strict';

// scripts/hook-runtime/performance-balanced.cjs
// Directive for BALANCED performance mode.
// Full subagent team; each agent runs at its configured capability tier.

const { PERFORMANCE_CONFIG } = require('./performance-config.cjs');
const { tierModelTable } = require('./model-tiers.cjs');

function balancedModeDirective() {
  const config = PERFORMANCE_CONFIG.balanced;
  const agentLines = Object.entries(config.agents)
    .map(([role, cfg]) => {
      const t = tierModelTable(cfg.tier);
      return `  ${role}: ${t.tier} → claude:${t.claude} · codex:${t.codex} · cursor:${t.cursor}`;
    })
    .join('\n');

  return [
    '═══ traffic-one — performance: BALANCED (subagent team, mid-tier models) ═══',
    '',
    'Performance level: BALANCED. Team mode: subagents.',
    'Cost-optimised team: implementation + review on the balanced tier, QA on the cheapest tier.',
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

module.exports = { balancedModeDirective };
