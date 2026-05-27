'use strict';

// scripts/hook-runtime/opencode-prompt.cjs
// Builds the OpenCode "token economy" opt-in prompt blocks.
//
// Traffic One can delegate bounded implementation work to OpenCode
// (https://opencode.ai/), a free local AI coding agent, so it plans/supervises/
// verifies while OpenCode executes — cutting paid Claude/Codex token usage. This
// module only produces the OPT-IN prompt + persistence guidance; the delegation
// MCP/runtime is a separate follow-up task. The choice is collected BEFORE the
// Performance popup because a later performance update will split the agent
// line-up across Traffic One subagents and free OpenCode agents.
//
// Internal name is `openCode` (not `tokenEconomy`) to avoid colliding with the
// existing `tokenEconomyBanner` toolchain nudge and the handoff-digest
// "token-economy layer".

const { hostPopupInstruction } = require('./onboarding-prompts.cjs');

const OPEN_CODE_INSTALL = 'curl -fsSL https://opencode.ai/install | bash';

// ── New-project onboarding popup (asked FIRST, before the Performance popup) ──

function openCodePopupBlock() {
  return [
    'OPENCODE DELEGATION PREFLIGHT (asked first, before the Performance popup; blocking):',
    '  After global Traffic One auth is resolved and before the Performance popup,',
    '  offer the OpenCode token-economy opt-in using the host popup/input mechanism.',
    '  ' + hostPopupInstruction(),
    '',
    '  What to tell the user: Traffic One can delegate bounded implementation tasks',
    '  (features, UI changes, bug fixes, refactors, test/build fixes) to OpenCode — a',
    '  free, local AI coding agent. Traffic One still plans, supervises, and verifies;',
    '  OpenCode executes. Every delegated change is kept in a reviewable digest',
    '  (changed files + run summary) before it is accepted. Enabling this can cut your',
    '  paid Claude/Codex token usage.',
    '  Prerequisite to actually use it: install OpenCode with `' + OPEN_CODE_INSTALL + '`',
    '  and sign in. The delegation wiring ships in a later update — for now this only',
    '  records your preference so a future performance update can split work between',
    '  Traffic One subagents and free OpenCode agents.',
    '',
    '    header: "OpenCode"',
    '    question: "Save tokens by delegating coding tasks to OpenCode (a free local agent)?"',
    '    options:',
    '      - "Enable OpenCode delegation" — Allow Traffic One to hand bounded tasks to OpenCode later (requires installing OpenCode).',
    '      - "Not now" — Keep everything on Traffic One\'s own agents for now; you can enable this later.',
    '',
    '  Persist the answer in `.traffic-one/.one.json` as:',
    '    "openCode": { "enabled": <true|false>, "source": "prompted", "decidedAt": "<ISO-8601 UTC>" }',
    '  "Enable OpenCode delegation" -> enabled: true; "Not now" -> enabled: false.',
    '  This step is REQUIRED to be asked, but either answer resolves it. Do NOT pick a',
    '  default or auto-answer on the user\'s behalf. After it is recorded, continue to',
    '  the Performance popup.',
  ].join('\n');
}

function openCodeChatFallback() {
  return [
    'Traffic One can delegate bounded coding tasks to OpenCode — a free, local AI',
    'agent — to save your paid token budget. Traffic One still plans, supervises,',
    'and verifies; OpenCode executes, and every change is kept in a reviewable',
    'digest. To actually use it you install OpenCode (`' + OPEN_CODE_INSTALL + '`)',
    'and sign in. The delegation feature ships in a later update; this only records',
    'your preference.',
    '',
    'Save tokens by delegating coding tasks to OpenCode?',
    '',
    '  1. Enable OpenCode delegation',
    '  2. Not now',
    '',
    'Reply with the option number or label.',
  ].join('\n');
}

// ── Existing-codebase one-time opt-in (non-blocking, surfaced via UserPromptSubmit) ──

function openCodeOptInDirective() {
  return [
    'OPENCODE DELEGATION OPT-IN (one-time, non-blocking):',
    '  Traffic One can delegate bounded implementation tasks to OpenCode, a free',
    '  local AI coding agent, so it plans/supervises/verifies while OpenCode executes',
    '  — cutting paid token usage. Every delegated change stays in a reviewable',
    '  digest. To use it the user installs OpenCode (`' + OPEN_CODE_INSTALL + '`) and',
    '  signs in; the delegation wiring ships in a later update.',
    '  ' + hostPopupInstruction(),
    '  Then record the answer in `.traffic-one/.one.json` (preserve all existing fields):',
    '    "openCode": { "enabled": <true|false>, "source": "prompted", "decidedAt": "<ISO-8601 UTC>" }',
    '  "Enable" -> enabled: true; "Not now" -> enabled: false. Do NOT re-ask once it is',
    '  recorded, and do NOT let this block the user\'s current request.',
    '',
    openCodeChatFallback(),
  ].join('\n');
}

module.exports = {
  OPEN_CODE_INSTALL,
  openCodePopupBlock,
  openCodeChatFallback,
  openCodeOptInDirective,
};
