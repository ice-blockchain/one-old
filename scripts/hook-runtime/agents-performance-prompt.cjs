'use strict';

// scripts/hook-runtime/agents-performance-prompt.cjs
// Builds and dispatches performance-level prompts/directives.
// Replaces the old "Run team / Main agent only" popup with a three-way
// Low / Balanced / High choice. Balanced and High auto-launch the subagent
// team without an extra confirmation step.

const { PERFORMANCE_LEVEL_IDS, PERFORMANCE_CONFIG } = require('./performance-config.cjs');
const { TIER_IDS, canonicalTier, resolveModel, tierModelTable } = require('./model-tiers.cjs');
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
    '    options (list "High (Recommended)" FIRST so the popup\'s default chip is High):',
    '      - "High (Recommended)" — Subagent team with max-power models; best output quality.',
    '      - "Balanced" — Subagent team with efficient mid-tier models; good cost/quality balance.',
    '      - "Low" — Main agent only; all roles run in this thread as a roadmap checklist; lowest cost.',
    '',
    '  Hold the answer in working memory; do NOT write `.traffic-one.json` yet',
    '  for Balanced/High — popup 4 (Team Confirmation) still has to confirm the',
    '  role → model line-up. The intended state per option:',
    '    - "Balanced" → performance.level="balanced", team.mode="subagents"',
    '    - "High"     → performance.level="high",     team.mode="subagents"',
    '    - "Low"      → performance.level="low",      team.mode="main-agent"',
    '',
    '  For "Balanced" or "High": IMMEDIATELY ask popup 4 (Team Confirmation)',
    '  using the agent line-up defined in `performance-config.cjs` for the',
    '  chosen level. Popup 4 is MANDATORY — auto-approving it on the user\'s',
    '  behalf, or skipping it with "the default looks fine / I\'ll proceed",',
    '  is a HARD VIOLATION of this directive. Do NOT write `.traffic-one.json`',
    '  and do NOT spawn any subagent (Task / spawn_agent / background-agent)',
    '  until the user has replied "Approve" in popup 4. If you cannot ask the',
    '  popup (no popup tool exposed AND no user available), use the chat',
    '  fallback in `teamConfirmationChatFallback` and STOP for the user reply;',
    '  do not invent an answer.',
    '  For "Low": skip popup 4, write `.traffic-one.json` with',
    '    "performance": { "level": "low", "source": "prompted" },',
    '    "team": { "mode": "main-agent", "source": "prompted" }',
    '  and continue in this thread using the role roadmap checklist directive.',
  ].join('\n');
}

function performanceChatFallback() {
  return [
    'Traffic One needs to know how you want to run agents for this build.',
    '',
    '  1. High (Recommended) — Subagent team with max-power models',
    '  2. Balanced — Subagent team with efficient mid-tier models',
    '  3. Low — Main agent only with role roadmap checklist',
    '',
    'Reply with the option number or label.',
  ].join('\n');
}

// ── Per-level directive injected into SessionStart ────────────────────────────

function performanceLevelDirective(level, overrides) {
  switch (level) {
    case 'low':      return lowModeDirective();
    case 'balanced': return balancedModeDirective(overrides);
    case 'high':     return highModeDirective(overrides);
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

// Returns the effective tier for a role at a level, honoring any user
// `team.overrides` from `.traffic-one.json`. Returns null when the level has
// no subagents (low) or the role isn't configured.
function effectiveTierForRole(level, role, overrides) {
  const cfg = PERFORMANCE_CONFIG[level];
  if (!cfg || !cfg.agents || !cfg.agents[role]) return null;
  if (overrides && typeof overrides === 'object') {
    const override = canonicalTier(overrides[role]);
    if (override) return override;
  }
  return cfg.agents[role].tier;
}

// Returns the configured tier for a role at a level, with the resolved model id
// for every host: { tier, claude, codex, cursor }. Null when the level has no
// subagents (low) or the role isn't configured. Honors `team.overrides`.
function modelForRole(level, role, overrides) {
  const tier = effectiveTierForRole(level, role, overrides);
  return tier ? tierModelTable(tier) : null;
}

// Resolve a role's model for a single host (claude | codex | cursor),
// honoring `team.overrides` when provided.
function modelForRoleHost(level, role, host, overrides) {
  const tier = effectiveTierForRole(level, role, overrides);
  return tier ? resolveModel(tier, host) : null;
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
  effectiveTierForRole,
  modelForRole,
  modelForRoleHost,
};
