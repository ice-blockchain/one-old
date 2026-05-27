'use strict';

const { codexDefaultModeFallbackDirective } = require('../onboarding-prompts.cjs');

// ── Condensed reminder for UserPromptSubmit while onboarding is incomplete ───
// SessionStart's full directive can scroll out of context across long onboarding
// turns or compaction. This short reminder is re-injected on every prompt
// while `.traffic-one/.one.json` still lacks a valid `stack`.
function onboardingReminderShort() {
  return `═══ traffic-one — onboarding still incomplete ═══

mode=new-project: complete Traffic One onboarding in the current thread before
implementation. If no popup/input tool is available, ask the required
onboarding question in chat and stop for the user's typed answer. Do not
scaffold, install, edit source, or choose defaults while onboarding answers are
pending.

${codexDefaultModeFallbackDirective()}

Write the effective onboarding state to \`.traffic-one/.one.json\` (use the Write tool, RELATIVE path
\`.traffic-one/.one.json\` so it lands in the current working directory — never an
absolute guess) with the full required schema before continuing with feature
work. The PostToolUse hook will move local-only fields into per-user
preferences, rewrite committed \`.traffic-one/.one.json\` with shared project
facts only, and auto-load the matching rule bundle into THIS session — no
restart needed.

  {
    "version": "<current-plugin-version>",
    "mode": "new-project",
    "stack": "<chosen-id>",
    "frontend": "<chosen-frontend>",
    "backend": "<chosen-backend>",
    "projectContext": {
      "source": "prompted",
      "originalPrompt": "<user's original request>",
      "summary": "<short product summary>",
      "answers": {},
      "collectedAt": "<ISO-8601 UTC>"
    },
    "mobile": { "enabled": false, "framework": "none", "source": "<explicit|prompted|none>" },
    "technologies": { "frontend": [], "backend": [], "mobile": [] },
    "realtime": "<heavy|light|none>",
    "codeGraphProvider": "<gitnexus|graphify>",
    "openCode": { "enabled": <true|false>, "source": "prompted", "decidedAt": "<ISO-8601 UTC>" },
    "performance": { "level": "<low|balanced|high>", "source": "prompted" },
    "team": { "mode": "<subagents|main-agent>", "source": "prompted", "approved": true },
    "toolchain": {
      "gitnexus": { "installedVersion": null, "installedAt": null },
      "graphify": { "installedVersion": null, "installedAt": null },
      "gitleaks": { "installedVersion": null, "installedAt": null },
      "trufflehog": { "installedVersion": null, "installedAt": null }
    },
    "confirmed": true,
    "onboardingComplete": true,
    "confirmedAt": "<ISO-8601 UTC>"
  }

Stack ids: minimal · default · custom-frontend · custom-backend · custom-stack.
Backend values: supabase · our-fork · self-hosted · managed · other · external-api · none.
Realtime values: heavy · light · none.
Code-graph provider: gitnexus · graphify (REQUIRED, no default — ASK the user; stored in local preferences).
OpenCode opt-in: \`openCode.enabled\` true|false (REQUIRED — ask the OpenCode token-economy popup BEFORE Performance; save source "prompted" + decidedAt in local preferences).
Performance level: low · balanced · high (REQUIRED for new-project multi-layer builds — ASK the user with the Performance popup; stored in local preferences).
Team mode: derived from performance — balanced/high → subagents, low → main-agent. Save both fields locally. Omit \`team.approved\` for low.
Team confirmation: for balanced/high, ALSO ask the Team popup (popup 2) so the user approves the role→model line-up. On Approve, save \`team.approved: true\` in local preferences (REQUIRED — the PreToolUse spawn gate denies every Task/spawn_agent call until this flag is present). Save per-role overrides as \`team.overrides\` (role → tier) when the user customises; omit the field when the line-up was approved as-is.
Project context: REQUIRED after the Traffic One setup success message and before the Mobile App prompt. Ask the rich dynamic MVP questionnaire and save answers with suggested keys: audience, coreFlows, v1Features, rolesAuth, businessModel, payments, admin, dataModel, contentSource, integrations, engagement, successMetrics, constraints, domainSpecific.
Toolchain: REQUIRED in local preferences, initialized with gitnexus, graphify, gitleaks, and trufflehog null stamps.

Default complex-project recommendation is stack=default, frontend=react-vite,
backend=supabase. If the user explicitly chose a non-default frontend or
backend, record the matching custom stack and concrete technology fields.

Use the Codex \`request_user_input\` popup for the next unresolved onboarding
choice in this order: OpenCode delegation opt-in (token economy), Agent
Mode/Performance, Team Confirmation for balanced/high subagents,
project context, Mobile App, then Code Graph. Ask the
mobile prompt even when the user's prompt already named web, mobile, Next.js,
Ionic, React Native, frontend-only, or any other implementation preference. Do
not print numbered option
lists in chat when \`request_user_input\` is available. If the popup tool is
unavailable, ask the same question in chat with numbered options, tell the user
to reply with the option number or label, and stop. Do not choose a default or
continue implementation while the answer is pending. See the FIRST-RUN
ONBOARDING directive for the full pitch script and decline-Supabase examples.
`;
}

module.exports = { onboardingReminderShort };
