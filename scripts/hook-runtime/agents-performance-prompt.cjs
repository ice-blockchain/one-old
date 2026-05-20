'use strict';

// scripts/hook-runtime/agents-performance-prompt.cjs
// Builds and dispatches performance-level prompts/directives.
// Replaces the old "Run team / Main agent only" popup with a three-way
// Low / Balanced / High choice. Balanced and High auto-launch the subagent
// team without an extra confirmation step.

const { PERFORMANCE_LEVEL_IDS, PERFORMANCE_CONFIG } = require('./performance-config.cjs');
const { TIER_IDS, resolveModel, tierModelTable } = require('./model-tiers.cjs');
const { lowModeDirective }      = require('./performance-low.cjs');
const { balancedModeDirective } = require('./performance-balanced.cjs');
const { highModeDirective }     = require('./performance-high.cjs');

// ── Onboarding popup (replaces the "Run team / Main agent only" popup 3) ─────

function performancePopupBlock() {
  return [
    'AGENT PERFORMANCE PREFLIGHT (popup 3, blocking for non-trivial multi-layer builds):',
    '  After the codebase graph choice is resolved, ask the performance level using',
    '  the host\'s popup/input mechanism:',
    '    - Codex        : use `request_user_input` popup when available.',
    '    - Claude Code  : use the `AskUserQuestion` tool when available.',
    '    - Cursor       : use the Cursor task-UI prompt when available.',
    '    - All hosts (fallback): if no popup tool is exposed, ask in plain chat',
    '      with the three numbered options below, tell the user to reply with the',
    '      option number or label, and stop.',
    '',
    '    header: "Performance"',
    '    question: "How do you want to run agents for this build?"',
    '    options:',
    '      - "Balanced (Recommended)" — Subagent team with efficient models; best cost/quality balance.',
    '      - "High" — Subagent team with max-power models; best output, higher cost.',
    '      - "Low" — Main agent only; all roles run in this thread as a roadmap checklist; lowest cost.',
    '',
    '  Persist the answer in `.traffic-one.json`:',
    '    - "Balanced" → "performance": { "level": "balanced", "source": "prompted" },',
    '                   "team": { "mode": "subagents", "source": "prompted" }',
    '    - "High"     → "performance": { "level": "high",     "source": "prompted" },',
    '                   "team": { "mode": "subagents", "source": "prompted" }',
    '    - "Low"      → "performance": { "level": "low",      "source": "prompted" },',
    '                   "team": { "mode": "main-agent", "source": "prompted" }',
    '',
    '  For "Balanced" or "High": auto-launch the subagent team immediately after',
    '  `.traffic-one.json` is written — do NOT ask a separate "Run team?" confirmation.',
    '  For "Low": continue in this thread using the role roadmap checklist directive.',
  ].join('\n');
}

function performanceChatFallback() {
  return [
    'Traffic One needs to know how you want to run agents for this build.',
    '',
    '  1. Balanced (Recommended) — Subagent team with efficient models',
    '  2. High — Subagent team with max-power models',
    '  3. Low — Main agent only with role roadmap checklist',
    '',
    'Reply with the option number or label.',
  ].join('\n');
}

// ── Per-level directive injected into SessionStart ────────────────────────────

function performanceLevelDirective(level) {
  switch (level) {
    case 'low':      return lowModeDirective();
    case 'balanced': return balancedModeDirective();
    case 'high':     return highModeDirective();
    default:         return '';
  }
}

// ── Helpers used by state normalisation and validation ────────────────────────

function teamModeForLevel(level) {
  const cfg = PERFORMANCE_CONFIG[level];
  return cfg ? cfg.teamMode : 'main-agent';
}

function autoLaunchesTeam(level) {
  return level === 'balanced' || level === 'high';
}

// Returns the configured tier for a role at a level, with the resolved model id
// for every host: { tier, claude, codex, cursor }. Null when the level has no
// subagents (low) or the role isn't configured.
function modelForRole(level, role) {
  const cfg = PERFORMANCE_CONFIG[level];
  if (!cfg || !cfg.agents || !cfg.agents[role]) return null;
  return tierModelTable(cfg.agents[role].tier);
}

// Resolve a role's model for a single host (claude | codex | cursor).
function modelForRoleHost(level, role, host) {
  const cfg = PERFORMANCE_CONFIG[level];
  if (!cfg || !cfg.agents || !cfg.agents[role]) return null;
  return resolveModel(cfg.agents[role].tier, host);
}

module.exports = {
  PERFORMANCE_LEVEL_IDS,
  PERFORMANCE_CONFIG,
  TIER_IDS,
  performancePopupBlock,
  performanceChatFallback,
  performanceLevelDirective,
  teamModeForLevel,
  autoLaunchesTeam,
  modelForRole,
  modelForRoleHost,
};
