'use strict';

// scripts/hook-runtime/performance-low.cjs
// Directive for LOW performance mode.
// Uses only the main agent; all Traffic One roles run inline as a roadmap checklist.

const { PERFORMANCE_CONFIG } = require('./performance-config.cjs');

function lowModeDirective() {
  const config = PERFORMANCE_CONFIG.low;
  const roles = Object.keys(config.agents).length > 0
    ? Object.keys(config.agents)
    : ['senior-architect', 'senior-frontend', 'senior-backend', 'senior-reviewer', 'senior-tester'];

  const checklist = roles.map((r) => `- [ ] ${r}`).join('\n');

  return [
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
}

module.exports = { lowModeDirective };
