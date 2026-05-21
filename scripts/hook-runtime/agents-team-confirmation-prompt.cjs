'use strict';

// scripts/hook-runtime/agents-team-confirmation-prompt.cjs
// Popup 4 of new-project onboarding (only for balanced / high performance
// levels): show the user the exact subagent line-up — role → tier → host
// model — and let them either Approve, Re-pick the performance level, or
// describe per-role overrides in free chat. Overrides are persisted to
// `.traffic-one.json` as `team.overrides` and read at spawn time so the
// configured model parameter matches what the user agreed to.

const { PERFORMANCE_CONFIG } = require('./performance-config.cjs');
const { canonicalTier, tierModelTable } = require('./model-tiers.cjs');

// Returns the effective tier map for a level after applying any user
// overrides. Overrides not matching a configured role are ignored; an
// override that is not a canonical tier is ignored too.
function resolveTeamTiers(level, overrides) {
  const cfg = PERFORMANCE_CONFIG[level];
  if (!cfg || !cfg.agents) return {};
  const out = {};
  for (const [role, roleCfg] of Object.entries(cfg.agents)) {
    let tier = roleCfg.tier;
    if (overrides && typeof overrides === 'object') {
      const override = overrides[role];
      const canonical = canonicalTier(override);
      if (canonical) tier = canonical;
    }
    out[role] = tier;
  }
  return out;
}

// Renders the role list as plain text. Used by both the popup directive and
// the chat fallback so the wording stays in sync.
function renderTeamLines(level, overrides) {
  const tiers = resolveTeamTiers(level, overrides);
  return Object.entries(tiers).map(([role, tier]) => {
    const t = tierModelTable(tier);
    const overridden = overrides && overrides[role] ? ' (override)' : '';
    return `  ${role}: ${t.tier}${overridden} → claude:${t.claude} · codex:${t.codex} · cursor:${t.cursor}`;
  });
}

// Onboarding popup directive. Inserted into the new-project SessionStart
// directive right after the Performance popup so the orchestrator asks the
// user to approve / re-pick / customise BEFORE writing `.traffic-one.json`.
function teamConfirmationPopupBlock() {
  const balancedRows = renderTeamLines('balanced').join('\n');
  const highRows     = renderTeamLines('high').join('\n');
  return [
    'TEAM CONFIRMATION PREFLIGHT (popup 4, MANDATORY for balanced/high; ENFORCED by spawn gate):',
    '  This popup is NON-NEGOTIABLE for balanced/high. You MUST stop, render',
    '  the team line-up, ASK the user via the host popup tool, and wait for',
    '  an explicit user answer. Auto-approving is a hard violation AND will',
    '  be physically denied by the spawn gate — any Task/spawn_agent call',
    '  while `.traffic-one.json` has `team.approved !== true` returns',
    '  "Popup 4 gate" denial. The following are all violations of this rule:',
    '    - Writing `.traffic-one.json` with `team.approved: true` before the',
    '      user has actually clicked Approve in popup 4.',
    '    - Saying "I\'ll auto-approve the default", "the default looks fine",',
    '      "I\'ll proceed with Balanced", "to keep moving I\'ll approve", or any',
    '      phrasing that picks an answer on the user\'s behalf.',
    '    - Spawning ANY subagent (Task / spawn_agent / background-agent) before',
    '      the user replied "Approve" in this popup.',
    '    - Treating popup 4 as optional polish because the team list "looks',
    '      right" — the user explicitly asked for this confirmation step.',
    '    - Setting `team.source: "unavailable"` to bypass the gate without',
    '      explicit user direction. "unavailable" means the popup truly cannot',
    '      be shown (no popup tool AND no user present); it is not a shortcut.',
    '  After the Performance popup is answered with "Balanced" or "High",',
    '  render the configured subagent line-up and ask the user to approve it',
    '  BEFORE writing `.traffic-one.json` and BEFORE auto-launching the team.',
    '  Skip this popup entirely ONLY when the Performance answer is "Low" —',
    '  Low runs all roles in this thread with no per-agent model assignment.',
    '',
    '  CANONICAL TEAM TABLES — display the matching block VERBATIM as the popup',
    '  body. Do NOT paraphrase, do NOT substitute friendly names like "Opus 4.7"',
    '  or "Sonnet 4.6", do NOT swap rows, do NOT infer models. The tier and',
    '  per-host model ids below are the single source of truth (generated from',
    '  `performance-config.cjs` + `model-tiers.cjs` at hook-injection time):',
    '',
    '  --- HIGH ---',
    highRows,
    '  --- end HIGH ---',
    '',
    '  --- BALANCED ---',
    balancedRows,
    '  --- end BALANCED ---',
    '',
    '  If the user collected per-role overrides during a Customise loop this',
    '  session, re-derive the table by calling `renderTeamLines(level, overrides)`',
    '  exposed from `agents-team-confirmation-prompt.cjs` (or rebuild the lines',
    '  by hand using ONLY the canonical tier→model rows above with the',
    '  override\'s tier substituted in and a trailing "(override)" tag). Do not',
    '  invent model strings under any circumstance.',
    '',
    '  TWO-STEP DISPLAY (mandatory; AskUserQuestion has no body field, so the',
    '  table must be printed as an assistant message BEFORE the popup opens):',
    '',
    '    STEP 1 (assistant message, BEFORE calling the popup tool):',
    '      Print exactly this text — the markdown is fine, the per-role list',
    '      is REQUIRED, and every role + tier + model must appear unchanged:',
    '',
    '        **<level> performance team line-up:**',
    '        ```',
    '        <paste the matching --- HIGH --- or --- BALANCED --- block here,',
    '         VERBATIM, every role on its own line, tier and host model ids',
    '         exactly as shown in this directive — do NOT compress, do NOT',
    '         summarise, do NOT say "all on top-tier" or similar>',
    '        ```',
    '',
    '      Forbidden summarisations include but are not limited to:',
    '        - "all on top-tier models"',
    '        - "all on highest tier"',
    '        - "everyone on opus / sonnet / haiku"',
    '        - dropping tester or shipper because they "stand out"',
    '        - condensing roles into a comma list',
    '      These hide the tester=cheapest and shipper=balanced rows the user',
    '      explicitly asked to see. The whole point of popup 4 is per-role',
    '      visibility — collapsing it defeats the purpose.',
    '',
    '    STEP 2 (call the host popup tool):',
    '      Ask via the host popup tool when available (Codex',
    '      `request_user_input`, Claude Code `AskUserQuestion`, Cursor task-UI',
    '      prompt). If no popup is exposed, fall back to plain chat with the',
    '      numbered options below, tell the user to reply with the option',
    '      number or label, and stop.',
    '',
    '      header: "Team"',
    '      question: "Approve the <level> team line-up above?"',
    '        (Keep the question short — the per-role detail already lives in',
    '        the assistant message printed in STEP 1. The question MUST NOT',
    '        try to compress the table into the headline.)',
    '      options:',
    '      - "Approve" — Write `.traffic-one.json` with the listed team and auto-launch the subagents.',
    '      - "Re-pick performance" — Reopen the Performance popup so the user can choose a different level.',
    '      - "Customise" — Ask the user (free chat) which roles to override and to which tier (highest|balanced|cheapest).',
    '',
    '  Answer handling:',
    '    - "Approve" → write `.traffic-one.json` with',
    '          "team": { "mode": "subagents", "source": "prompted",',
    '                    "approved": true,',
    '                    "overrides": <collected overrides or omitted if empty> }',
    '      The `approved: true` field is what unlocks the spawn gate — without',
    '      it, every Task/spawn_agent call will be denied. Then auto-launch',
    '      the Traffic One subagent team.',
    '    - "Re-pick performance" → discard any pending overrides and re-show',
    '      the Performance popup (popup 3). Do NOT write `.traffic-one.json`',
    '      until the user has approved a team for the new level.',
    '    - "Customise" → ask the user which roles/tiers to change',
    '      (e.g. "senior-reviewer = highest, senior-tester = balanced").',
    '      Validate each role name against the level\'s configured roles and',
    '      each tier against highest|balanced|cheapest. Merge accepted',
    '      overrides into `team.overrides` and re-render this popup with the',
    '      new line-up so the user can re-approve. Loop until "Approve" or',
    '      "Re-pick performance".',
    '',
    '  Final schema in `.traffic-one.json` after Approve:',
    '      "team": {',
    '        "mode": "subagents",',
    '        "source": "prompted",',
    '        "approved": true,',
    '        "overrides": { "<role>": "<highest|balanced|cheapest>", ... }',
    '      }',
    '    Omit the `overrides` field entirely when there are none.',
    '    `approved: true` is REQUIRED for balanced/high — the PreToolUse spawn',
    '    gate denies every Task/spawn_agent call until this flag is present.',
    '    The hook gate (`scripts/hook-runtime/handlers.cjs`) reads `overrides`',
    '    at spawn time and enforces the resulting model parameter per host —',
    '    a model id written in prompt text has no effect.',
  ].join('\n');
}

function teamConfirmationChatFallback(level, overrides) {
  const lines = renderTeamLines(level, overrides);
  return [
    `Traffic One — confirm the subagent team for ${level.toUpperCase()} mode:`,
    '',
    ...lines,
    '',
    '  1. Approve — use the team above and launch the subagents.',
    '  2. Re-pick performance — choose a different performance level.',
    '  3. Customise — tell me which role(s) to retier (highest | balanced | cheapest).',
    '',
    'Reply with the option number or label. For "Customise", also list the',
    'role/tier changes, e.g. "senior-reviewer=highest, senior-tester=balanced".',
  ].join('\n');
}

module.exports = {
  resolveTeamTiers,
  renderTeamLines,
  teamConfirmationPopupBlock,
  teamConfirmationChatFallback,
};
