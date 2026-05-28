---
name: traffic-one-onboarding-gate
description: Wording source for the Traffic One new-project onboarding gate — chat fallbacks (shown when no host popup tool is available) and gate deny reasons. Read at runtime via skillBlock(); the step-routing + deny LOGIC lives in TS.
---

# Traffic One Onboarding Gate

Directive PROSE for the new-project onboarding flow. The step router, deny
conditions, and `permissionDecision:"deny"` live in
`src/modules/onboarding-gate/` + `src/shared/onboarding/`. `{{PLACEHOLDER}}`
tokens are filled by the gate. Each block has a verbatim fallback in code, so a
missing block never disables the gate.

<!-- T1BLOCK:BEGIN open-code -->
Traffic One can delegate bounded coding tasks to OpenCode — a free, local AI
agent — to save your paid token budget. Traffic One still plans, supervises,
and verifies; OpenCode executes, and every change is kept in a reviewable
digest. To actually use it you install OpenCode (`{{INSTALL}}`)
and sign in. The delegation feature ships in a later update; this only records
your preference.

Save tokens by delegating coding tasks to OpenCode?

  1. Enable OpenCode delegation
  2. Not now

Reply with the option number or label.
<!-- T1BLOCK:END open-code -->

<!-- T1BLOCK:BEGIN performance -->
Traffic One needs to know how you want to run agents for this build.
How do you want to run agents for this build?

  1. High (Recommended) — Subagent team with max-power models
  2. Balanced — Subagent team with efficient mid-tier models
  3. Low — Main agent only with role roadmap checklist

Reply with the option number or label.
<!-- T1BLOCK:END performance -->

<!-- T1BLOCK:BEGIN mobile -->
Traffic One needs the mobile app decision for this project.

Do you want a mobile app too?

  1. Web only (Recommended)
  2. Ionic + Capacitor
  3. React Native / Expo

Reply with the option number or label.
<!-- T1BLOCK:END mobile -->

<!-- T1BLOCK:BEGIN code-graph -->
Traffic One needs the code graph provider for this project.

Which provider should we use for the codebase graph?

  1. GitNexus
  2. graphify

Reply with the option number or label.
<!-- T1BLOCK:END code-graph -->

<!-- T1BLOCK:BEGIN project-context -->
Traffic One was successfully set up. Let's collect the project details next.

{{PROMPT_INTRO}}Answer these MVP-context questions in one reply so the build plan is complete:

1. Audience and jobs: who uses it, what problem they solve, and the top 2-3 user journeys.
2. V1 scope: must-have features, nice-to-haves to defer, and any launch deadline or demo expectation.
3. Roles and auth: anonymous, user, customer, creator/provider, staff/admin, permissions, and profile data.
4. Data model: core entities and relationships the MVP must store or seed.
5. Admin and operations: dashboards, CRUD, moderation, user/content/transaction management, analytics, support, and audit needs. Include this when the app has managed content, users, transactions, or operational workflows, even if the first request did not mention admin.
6. Business model and payments: free, paid, freemium, lead-gen, subscription, one-time purchase, marketplace commission, or internal tool? Are payments in or out for v1?
7. Content and integrations: source of seed/real data, uploads/files, search, notifications/email, realtime, maps/calendar/AI/external APIs, import/export.
8. Success criteria and product tone: what makes the MVP feel complete, what metrics matter, and what visual/brand direction should guide the UI.

Use these answer keys where possible: {{ANSWER_KEYS}}.

Dynamic questions for this request:
{{DOMAIN_QUESTIONS}}

Save the answer in `.traffic-one/.one.json` as `projectContext` with `source`, `originalPrompt`, `summary`, `answers`, and `collectedAt` before asking the Mobile App prompt.
<!-- T1BLOCK:END project-context -->

<!-- T1BLOCK:BEGIN team-confirmation-chat -->
Traffic One — confirm the subagent team for {{LEVEL_UPPER}} mode:

{{TEAM_LINES}}

  1. Approve — use the team above and launch the subagents.
  2. Re-pick performance — choose a different performance level.
  3. Customise — tell me which role(s) to retier (highest | balanced | cheapest).

Reply with the option number or label. For "Customise", also list the
role/tier changes, e.g. "senior-reviewer=highest, senior-tester=balanced".
<!-- T1BLOCK:END team-confirmation-chat -->

<!-- T1BLOCK:BEGIN team-confirmation-source-gate -->
Your next visible assistant message must ask this approval question and then stop for the user answer.
<!-- T1BLOCK:END team-confirmation-source-gate -->

<!-- T1BLOCK:BEGIN team-confirmation-source-user-prompt -->
If the latest user message is an explicit "Approve" answer to this Team Confirmation prompt, first save local Traffic One preferences with `team.approved: true` (and any collected `team.overrides`), then continue.
<!-- T1BLOCK:END team-confirmation-source-user-prompt -->

<!-- T1BLOCK:BEGIN team-confirmation-context -->
Traffic One Team Confirmation is still required before the {{LEVEL}} subagent run can start.
The user selected a multi-agent performance level, but local Traffic One preferences do not contain `team.approved: true`.
Do not spawn Task/spawn_agent/background-agent workers, do not write feature source, and do not set `team.source: "unavailable"` as a shortcut. If subagents are unavailable, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before any state rewrite.
{{SOURCE_NOTE}}
Use the host popup tool when available (Codex `request_user_input`, Claude Code `AskUserQuestion`, Cursor task-UI). This is onboarding popup 2. If no popup tool is exposed, show this plain-chat fallback verbatim:

{{TEAM_CHAT}}
<!-- T1BLOCK:END team-confirmation-context -->

<!-- T1BLOCK:BEGIN gate-fallback-reason -->
Traffic One onboarding gate: mode=new-project and onboarding is not complete.
Complete Traffic One onboarding in the current thread before using tools. If the popup tool is unavailable, the next unresolved fallback prompt must be displayed as the next visible assistant message.

The previous assistant turn tried to use tools before completing onboarding. Stop tool use now. Your next visible assistant message must ask only this unresolved step:

{{NEXT_STEP_PROMPT}}

The onboarding state remains incomplete until `.traffic-one/.one.json` contains shared project facts (stack, frontend, backend, projectContext, mobile, technologies, realtime, confirmed, onboardingComplete, confirmedAt) and local Traffic One preferences contain openCode, codeGraphProvider, performance, team (including `team.approved: true` after Team Confirmation for Balanced/High), and toolchain stamps.
After sending that prompt, stop. Do not choose defaults, inspect package versions, scaffold, install, edit files, spawn helper agents, or continue implementation until the typed answer is received and the remaining onboarding prompts are resolved.
<!-- T1BLOCK:END gate-fallback-reason -->

<!-- T1BLOCK:BEGIN team-confirmation-gate-reason -->
Traffic One Team Confirmation gate: the role/model lineup has not been approved.

{{CONTEXT}}
<!-- T1BLOCK:END team-confirmation-gate-reason -->

<!-- T1BLOCK:BEGIN repaired-materialization -->
Traffic One state was repaired/materialized before this tool use.
The attempted mutating tool has been denied once so it cannot run against stale `.traffic-one/.one.json`, rules, skills, or root agent context.
rerun the same tool now; the canonical `.traffic-one/.one.json` and project-local materialization are current.
<!-- T1BLOCK:END repaired-materialization -->

<!-- T1BLOCK:BEGIN team-mode-marker-guard -->
Traffic One team mode guard: `team.modeChangeApproval` is an internal, single-use marker that can only be written by the UserPromptSubmit hook after an explicit user request. Do not add or refresh it in `.traffic-one/.one.json` manually.
<!-- T1BLOCK:END team-mode-marker-guard -->

<!-- T1BLOCK:BEGIN team-mode-downgrade-guard -->
Traffic One team mode guard: local Traffic One preferences currently record `team.mode="subagents"`. This write would switch the project to `team.mode="main-agent"`, but the latest user prompt did not explicitly say they no longer want subagents and want Low/main-agent mode. Ask the user to say that explicitly before rewriting local `performance.level="low"` and `team.mode="main-agent"`. Do not use `team.source="unavailable"` or a state rewrite as a workaround.
<!-- T1BLOCK:END team-mode-downgrade-guard -->

<!-- T1BLOCK:BEGIN agent-mode-prompt -->
Traffic One needs to know how you want to run agents for this build.
How do you want to run agents for this build?

1. High (Recommended) — Subagent team with max-power models
2. Balanced — Subagent team with efficient mid-tier models
3. Low — Main agent only with role roadmap checklist

Reply with the option number or label.
<!-- T1BLOCK:END agent-mode-prompt -->

<!-- T1BLOCK:BEGIN host-popup-instruction -->
Ask via the host popup tool when available: Codex `request_user_input`, Claude Code `AskUserQuestion`, or the Cursor task-UI prompt. Only if no popup tool is exposed, ask in plain chat with the numbered options, tell the user to reply with the option number or label, and stop. Do NOT emit the plain-text fallback when a popup tool is working.
<!-- T1BLOCK:END host-popup-instruction -->

<!-- T1BLOCK:BEGIN codex-fallback -->
CURRENT-THREAD ONBOARDING FALLBACK (visible response, blocking):
If `request_user_input` cannot be called, do not use tools and do not keep detecting/scaffolding.
Before onboarding is resolved, mention only the project-detection/onboarding flow. Do not read, invoke, announce, or activate create-feature, create-page, frontend-design, tdd-workflow, or other implementation skills yet.
Your next visible assistant message must be the plain-chat fallback prompt below, then you must stop for the user answer:

{{AGENT_MODE_PROMPT}}

After the user answers, ask Team Confirmation for High/Balanced, then show "Traffic One was successfully set up. Let's collect the project details next.", collect a rich dynamic MVP project context, ask Mobile App, then ask Code Graph. Ask only the next unresolved question and stop each time.
<!-- T1BLOCK:END codex-fallback -->

<!-- T1BLOCK:BEGIN onboarding-reminder -->
═══ traffic-one — onboarding still incomplete ═══

mode=new-project: complete Traffic One onboarding in the current thread before
implementation. If no popup/input tool is available, ask the required
onboarding question in chat and stop for the user's typed answer. Do not
scaffold, install, edit source, or choose defaults while onboarding answers are
pending.

{{CODEX_FALLBACK}}

Write the effective onboarding state to `.traffic-one/.one.json` (use the Write tool, RELATIVE path
`.traffic-one/.one.json` so it lands in the current working directory — never an
absolute guess) with the full required schema before continuing with feature
work. The PostToolUse hook will move local-only fields into per-user
preferences, rewrite committed `.traffic-one/.one.json` with shared project
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
OpenCode opt-in: `openCode.enabled` true|false (REQUIRED — ask the OpenCode token-economy popup BEFORE Performance; save source "prompted" + decidedAt in local preferences).
Performance level: low · balanced · high (REQUIRED for new-project multi-layer builds — ASK the user with the Performance popup; stored in local preferences).
Team mode: derived from performance — balanced/high → subagents, low → main-agent. Save both fields locally. Omit `team.approved` for low.
Team confirmation: for balanced/high, ALSO ask the Team popup (popup 2) so the user approves the role→model line-up. On Approve, save `team.approved: true` in local preferences (REQUIRED — the PreToolUse spawn gate denies every Task/spawn_agent call until this flag is present). Save per-role overrides as `team.overrides` (role → tier) when the user customises; omit the field when the line-up was approved as-is.
Project context: REQUIRED after the Traffic One setup success message and before the Mobile App prompt. Ask the rich dynamic MVP questionnaire and save answers with suggested keys: audience, coreFlows, v1Features, rolesAuth, businessModel, payments, admin, dataModel, contentSource, integrations, engagement, successMetrics, constraints, domainSpecific.
Toolchain: REQUIRED in local preferences, initialized with gitnexus, graphify, gitleaks, and trufflehog null stamps.

Default complex-project recommendation is stack=default, frontend=react-vite,
backend=supabase. If the user explicitly chose a non-default frontend or
backend, record the matching custom stack and concrete technology fields.

Use the Codex `request_user_input` popup for the next unresolved onboarding
choice in this order: OpenCode delegation opt-in (token economy), Agent
Mode/Performance, Team Confirmation for balanced/high subagents,
project context, Mobile App, then Code Graph. Ask the
mobile prompt even when the user's prompt already named web, mobile, Next.js,
Ionic, React Native, frontend-only, or any other implementation preference. Do
not print numbered option
lists in chat when `request_user_input` is available. If the popup tool is
unavailable, ask the same question in chat with numbered options, tell the user
to reply with the option number or label, and stop. Do not choose a default or
continue implementation while the answer is pending. See the FIRST-RUN
ONBOARDING directive for the full pitch script and decline-Supabase examples.
<!-- T1BLOCK:END onboarding-reminder -->

<!-- T1BLOCK:BEGIN opencode-optin -->
OPENCODE DELEGATION OPT-IN (one-time, non-blocking):
  Traffic One can delegate bounded implementation tasks to OpenCode, a free
  local AI coding agent, so it plans/supervises/verifies while OpenCode executes
  — cutting paid token usage. Every delegated change stays in a reviewable
  digest. To use it the user installs OpenCode (`{{INSTALL}}`) and
  signs in; the delegation wiring ships in a later update.
  {{HOST_POPUP}}
  Then record the answer in local Traffic One preferences:
    "openCode": { "enabled": <true|false>, "source": "prompted", "decidedAt": "<ISO-8601 UTC>" }
  "Enable" -> enabled: true; "Not now" -> enabled: false. Do NOT re-ask once it is
  recorded, and do NOT let this block the user's current request.

{{OPENCODE_CHAT}}
<!-- T1BLOCK:END opencode-optin -->

<!-- T1BLOCK:BEGIN team-mode-switch-authorized -->
The latest user prompt explicitly requested switching away from subagents to Low/main-agent mode. The next local Traffic One preference write may change `performance.level` to "low" and `team.mode` to "main-agent"; this authorization is single-use and expires in 10 minutes.
<!-- T1BLOCK:END team-mode-switch-authorized -->

<!-- T1BLOCK:BEGIN first-prompt-classification -->
[FIRST PROMPT STACK CLASSIFICATION]
stack={{STACK}}
frontend={{FRONTEND}}
backend={{BACKEND}}
mobile={{MOBILE}}
mode=new-project: complete Traffic One onboarding in the current thread before implementation. If no popup/input tool is available, ask fallback chat questions and stop for typed answers.
{{CODEX_FALLBACK}}
Onboarding choices must be prompt popups. {{HOST_POPUP}} Do not print numbered option lists in chat when a popup tool is available; never choose a default or continue implementation while an answer is pending.
Required order: Agent mode (High/Balanced/Low), Team role/model confirmation for High/Balanced, success message, rich MVP-context questionnaire, Mobile App, then Code Graph provider.
Ask only the next unresolved onboarding step below:
{{NEXT_STEP}}
<!-- T1BLOCK:END first-prompt-classification -->

<!-- T1BLOCK:BEGIN perf-low -->
═══ traffic-one — performance: LOW (main agent + role checklist) ═══

Performance level: LOW. Team mode: main-agent.
All Traffic One agent roles run in this single thread.

Work through the following role checklist in order, marking each [x] before advancing:
{{CHECKLIST}}

Role responsibilities:
  senior-architect  — Write .traffic-one/plan.md before any feature source.
  senior-frontend   — Implement all UI/frontend changes.
  senior-backend    — Implement all server/API/database changes.
  senior-reviewer   — Review the diff for correctness, security, and style.
  senior-tester     — Add/update tests. End with TESTS_GREEN or TESTS_FAILING.

Complete each role scope fully before ticking it off and moving to the next.
<!-- T1BLOCK:END perf-low -->

<!-- T1BLOCK:BEGIN perf-balanced -->
═══ traffic-one — performance: BALANCED (subagent team, mid-tier models) ═══

Performance level: BALANCED. Team mode: subagents.
Cost-optimised team: implementation + review on the balanced tier, QA on the cheapest tier.

Agent model assignments (tier → host model):
{{AGENT_LINES}}

Auto-launching the Traffic One subagent team (no extra confirmation needed):
  architect → frontend/backend (parallel) → reviewer/tester (parallel)

HOW TO ACTUALLY SET THE MODEL — mandatory, not advisory:
  The subagent model is set ONLY by the spawn tool's `model` PARAMETER. A
  model name written in the prompt text has ZERO effect — the subagent will
  silently inherit the parent model if you omit the param.
  Pass the value from YOUR host's column above:
    Claude Code : `Task`/Agent tool — `model: "<claude value>"` (opus|sonnet|haiku).
    Codex       : `spawn_agent` — `model: "<codex value>"`.
    Cursor      : background-agent/task adapter — set `<cursor value>` per role.

The orchestrator MUST NOT write feature source files.
<!-- T1BLOCK:END perf-balanced -->

<!-- T1BLOCK:BEGIN perf-high -->
═══ traffic-one — performance: HIGH (subagent team, highest-tier models) ═══

Performance level: HIGH. Team mode: subagents.
Maximum-performance team: architect, frontend, backend, and reviewer on the highest tier.
QA (senior-tester) uses the cheapest tier to contain cost.

Agent model assignments (tier → host model):
{{AGENT_LINES}}

Auto-launching the Traffic One subagent team (no extra confirmation needed):
  architect → frontend/backend (parallel) → reviewer/tester (parallel)

HOW TO ACTUALLY SET THE MODEL — mandatory, not advisory:
  The subagent model is set ONLY by the spawn tool's `model` PARAMETER. A
  model name written in the prompt text has ZERO effect — the subagent will
  silently inherit the parent model if you omit the param.
  Pass the value from YOUR host's column above:
    Claude Code : `Task`/Agent tool — `model: "<claude value>"` (opus|sonnet|haiku).
    Codex       : `spawn_agent` — `model: "<codex value>"`.
    Cursor      : background-agent/task adapter — set `<cursor value>` per role.

The orchestrator MUST NOT write feature source files.
<!-- T1BLOCK:END perf-high -->

<!-- T1BLOCK:BEGIN performance-popup -->
AGENT PERFORMANCE PREFLIGHT (popup 1, blocking for non-trivial multi-layer builds):
  After global Traffic One auth is resolved, ask the performance level using
  the host's popup/input mechanism:
    - Codex        : use `request_user_input` popup when available.
    - Claude Code  : use the `AskUserQuestion` tool when available.
    - Cursor       : use the Cursor task-UI prompt when available.
    - All hosts (fallback): if no popup tool is exposed, ask in plain chat
      with the three numbered options below, tell the user to reply with the
      option number or label, and stop.

    header: "Performance"
    question: "How do you want to run agents for this build?"
    options (default/recommended is High; list "High (Recommended)" FIRST so the popup's default chip is High):
      - "High (Recommended)" — Subagent team with max-power models; best output quality.
      - "Balanced" — Subagent team with efficient mid-tier models; good cost/quality balance.
      - "Low" — Main agent only; all roles run in this thread as a roadmap checklist; lowest cost.

  Hold the answer in working memory; do NOT save final onboarding state yet
  for Balanced/High — popup 2 (Team Confirmation) still has to confirm the
  role → model line-up. The intended state per option:
    - "Balanced" → performance.level="balanced", team.mode="subagents"
    - "High"     → performance.level="high",     team.mode="subagents"
    - "Low"      → performance.level="low",      team.mode="main-agent"

  For "Balanced" or "High": IMMEDIATELY ask popup 2 (Team Confirmation)
  using the agent line-up defined in `performance-config.cjs` for the
  chosen level. Popup 2 is MANDATORY — auto-approving it on the user's
  behalf, or skipping it with "the default looks fine / I'll proceed",
  is a HARD VIOLATION of this directive. Do NOT save final onboarding state
  and do NOT spawn any subagent (Task / spawn_agent / background-agent)
  until the user has replied "Approve" in popup 2. If you cannot ask the
  popup (no popup tool exposed AND no user available), use the chat
  fallback in `teamConfirmationChatFallback` and STOP for the user reply;
  do not invent an answer.
  For "Low": skip popup 2, save local Traffic One preferences with
    "performance": { "level": "low", "source": "prompted" },
    "team": { "mode": "main-agent", "source": "prompted" }
  and continue in this thread using the role roadmap checklist directive.
<!-- T1BLOCK:END performance-popup -->

<!-- T1BLOCK:BEGIN team-confirmation-popup -->
TEAM CONFIRMATION PREFLIGHT (popup 2, MANDATORY for balanced/high; ENFORCED by spawn gate):
  This popup is NON-NEGOTIABLE for balanced/high. You MUST stop, render
  the team line-up, ASK the user via the host popup tool, and wait for
  an explicit user answer. Auto-approving is a hard violation AND will
  be physically denied by the spawn gate — any Task/spawn_agent call
  while local Traffic One preferences have `team.approved !== true` returns
  "Team Confirmation gate" denial. The following are all violations of this rule:
    - Saving local preferences with `team.approved: true` before the
      user has actually clicked Approve in popup 2.
    - Saying "I'll auto-approve the default", "the default looks fine",
      "I'll proceed with Balanced", "to keep moving I'll approve", or any
      phrasing that picks an answer on the user's behalf.
    - Spawning ANY subagent (Task / spawn_agent / background-agent) before
      the user replied "Approve" in this popup.
    - Treating popup 2 as optional polish because the team list "looks
      right" — the user explicitly asked for this confirmation step.
    - Setting `team.source: "unavailable"` while keeping
      `team.mode: "subagents"` to bypass the gate, or rewriting
      `team.mode: "main-agent"` without a fresh user prompt that
      explicitly says they no longer want subagents and want
      Low/main-agent mode. `unavailable` never unlocks or downgrades
      a Balanced/High multi-agent run.
  After the Performance popup is answered with "Balanced" or "High",
  render the configured subagent line-up and ask the user to approve it
  BEFORE saving local preferences and BEFORE auto-launching the team.
  Skip this popup entirely ONLY when the Performance answer is "Low" —
  Low runs all roles in this thread with no per-agent model assignment.

  CANONICAL TEAM TABLES — display the matching block VERBATIM as the popup
  body. Do NOT paraphrase, do NOT substitute friendly names like "Opus 4.7"
  or "Sonnet 4.6", do NOT swap rows, do NOT infer models. The tier and
  per-host model ids below are the single source of truth (generated from
  `performance-config.cjs` + `model-tiers.cjs` at hook-injection time):

  --- HIGH ---
{{HIGH_ROWS}}
  --- end HIGH ---

  --- BALANCED ---
{{BALANCED_ROWS}}
  --- end BALANCED ---

  If the user collected per-role overrides during a Customise loop this
  session, re-derive the table by calling `renderTeamLines(level, overrides)`
  exposed from `agents-team-confirmation-prompt.cjs` (or rebuild the lines
  by hand using ONLY the canonical tier→model rows above with the
  override's tier substituted in and a trailing "(override)" tag). Do not
  invent model strings under any circumstance.

  TWO-STEP DISPLAY (mandatory; AskUserQuestion has no body field, so the
  table must be printed as an assistant message BEFORE the popup opens):

    STEP 1 (assistant message, BEFORE calling the popup tool):
      Print exactly this text — the markdown is fine, the per-role list
      is REQUIRED, and every role + tier + model must appear unchanged:

        **<level> performance team line-up:**
        ```
        <paste the matching --- HIGH --- or --- BALANCED --- block here,
         VERBATIM, every role on its own line, tier and host model ids
         exactly as shown in this directive — do NOT compress, do NOT
         summarise, do NOT say "all on top-tier" or similar>
        ```

      Forbidden summarisations include but are not limited to:
        - "all on top-tier models"
        - "all on highest tier"
        - "everyone on opus / sonnet / haiku"
        - dropping tester or shipper because they "stand out"
        - condensing roles into a comma list
      These hide the tester=cheapest and shipper=balanced rows the user
      explicitly asked to see. The whole point of popup 2 is per-role
      visibility — collapsing it defeats the purpose.

    STEP 2 (call the host popup tool):
      Ask via the host popup tool when available (Codex
      `request_user_input`, Claude Code `AskUserQuestion`, Cursor task-UI
      prompt). If no popup is exposed, fall back to plain chat with the
      numbered options below, tell the user to reply with the option
      number or label, and stop.

      header: "Team"
      question: "Approve the <level> team line-up above?"
        (Keep the question short — the per-role detail already lives in
        the assistant message printed in STEP 1. The question MUST NOT
        try to compress the table into the headline.)
      options:
      - "Approve" — Save local preferences with the listed team and auto-launch the subagents.
      - "Re-pick performance" — Reopen the Performance popup so the user can choose a different level.
      - "Customise" — Ask the user (free chat) which roles to override and to which tier (highest|balanced|cheapest).

  Answer handling:
    - "Approve" → save local Traffic One preferences with
          "team": { "mode": "subagents", "source": "prompted",
                    "approved": true,
                    "overrides": <collected overrides or omitted if empty> }
      The `approved: true` field is what unlocks the spawn gate — without
      it, every Task/spawn_agent call will be denied. Then auto-launch
      the Traffic One subagent team.
    - "Re-pick performance" → discard any pending overrides and re-show
      the Performance popup (popup 1). Do NOT save final onboarding state
      until the user has approved a team for the new level.
    - "Customise" → ask the user which roles/tiers to change
      (e.g. "senior-reviewer = highest, senior-tester = balanced").
      Validate each role name against the level's configured roles and
      each tier against highest|balanced|cheapest. Merge accepted
      overrides into `team.overrides` and re-render this popup with the
      new line-up so the user can re-approve. Loop until "Approve" or
      "Re-pick performance".

  Final local preference shape after Approve:
      "team": {
        "mode": "subagents",
        "source": "prompted",
        "approved": true,
        "overrides": { "<role>": "<highest|balanced|cheapest>", ... }
      }
    Omit the `overrides` field entirely when there are none.
    `approved: true` is REQUIRED for balanced/high — the PreToolUse spawn
    gate denies every Task/spawn_agent call until this flag is present.
    The hook gate reads `overrides` at spawn time and enforces the
    resulting model parameter per host — a model id written in prompt text
    has no effect.
<!-- T1BLOCK:END team-confirmation-popup -->

<!-- T1BLOCK:BEGIN opencode-popup -->
OPENCODE DELEGATION PREFLIGHT (asked first, before the Performance popup; blocking):
  After global Traffic One auth is resolved and before the Performance popup,
  offer the OpenCode token-economy opt-in using the host popup/input mechanism.
  {{HOST_POPUP}}

  What to tell the user: Traffic One can delegate bounded implementation tasks
  (features, UI changes, bug fixes, refactors, test/build fixes) to OpenCode — a
  free, local AI coding agent. Traffic One still plans, supervises, and verifies;
  OpenCode executes. Every delegated change is kept in a reviewable digest
  (changed files + run summary) before it is accepted. Enabling this can cut your
  paid Claude/Codex token usage.
  Prerequisite to actually use it: install OpenCode with `{{INSTALL}}`
  and sign in. The delegation wiring ships in a later update — for now this only
  records your preference so a future performance update can split work between
  Traffic One subagents and free OpenCode agents.

    header: "OpenCode"
    question: "Save tokens by delegating coding tasks to OpenCode (a free local agent)?"
    options:
      - "Enable OpenCode delegation" — Allow Traffic One to hand bounded tasks to OpenCode later (requires installing OpenCode).
      - "Not now" — Keep everything on Traffic One's own agents for now; you can enable this later.

  Persist the answer in local Traffic One preferences as:
    "openCode": { "enabled": <true|false>, "source": "prompted", "decidedAt": "<ISO-8601 UTC>" }
  "Enable OpenCode delegation" -> enabled: true; "Not now" -> enabled: false.
  This step is REQUIRED to be asked, but either answer resolves it. Do NOT pick a
  default or auto-answer on the user's behalf. After it is recorded, continue to
  the Performance popup.
<!-- T1BLOCK:END opencode-popup -->

<!-- T1BLOCK:BEGIN onboarding-directive-new-project -->
═══ traffic-one — FIRST-RUN ONBOARDING (new project) ═══

This is a new project. Before writing any feature code, briefly understand
what the user is building, recommend our stack, and save the onboarding state.
A PostToolUse hook will split local-only preferences into a per-user file,
rewrite committed `.traffic-one/.one.json` with shared project facts, and
auto-load the matching rule bundle into THIS session — no restart needed.

DEFAULT (end-to-end): stack=default, frontend=react-vite, backend={{DEFAULT_BACKEND}}, mobile=none, realtime=none.
Only deviate when the first user prompt asks for a minimal/static project or
explicit custom frontend/backend/mobile technology.
Explicit user requests influence the eventual stack choice, but they never
skip or auto-answer Traffic One onboarding. Always ask the required Agent Mode,
Team role/model confirmation, project context, Mobile App, and Code Graph
preflight questions in order before writing final state, planning, scaffolding,
installing, editing files, or simulating roles.

CURRENT-THREAD ONBOARDING GATE (all hosts):
  When project mode resolves to `new-project` (`mode === "new-project"`),
  complete Traffic One onboarding in the current thread before saving
  `.traffic-one/.one.json`, writing `.traffic-one/plan.md`, spawning/simulating
  subagents, creating files, editing code, running installs, or scaffolding.

  Use the host popup/input mechanism when available. If no popup/input tool is
  exposed, ask the same next unresolved onboarding question in plain chat and
  stop for the user's typed answer. Do not continue implementation while
  `mode === "new-project"` and onboarding or the post-onboarding architecture
  plan gate is unresolved.

ONBOARDING POPUP RULE (all hosts, blocking):
  These onboarding choices must be displayed as host prompt popups, not as
  prose questions with numbered options. {{HOST_POPUP}}
  Do NOT print "Options:" or a numbered list in chat when a popup tool is
  available. Never choose a default, infer an answer, auto-approve a
  recommendation on the user's behalf, save final onboarding state, scaffold,
  run installs, spawn subagents, or continue implementation while an onboarding
  answer is still pending. This includes popup 2 (Team Confirmation): you may
  NOT auto-approve the default Balanced/High line-up to "keep moving" — wait
  for the user's explicit reply.

  Required popup order for complex new projects:
    First (before popup 1): OpenCode delegation opt-in (token economy) — asked
       before Performance so a later performance update can split work across
       Traffic One subagents and free OpenCode agents. Persist local `openCode`.
    1. Agent Mode / Performance (High, Balanced, Low).
    2. Team Confirmation (MANDATORY for Balanced / High; lists the configured
       subagent line-up so the user can approve, re-pick, or customise
       per-role tiers before local preferences are saved and before ANY
       subagent is spawned). Auto-approving this popup is a hard violation.
    3. Success message: "Traffic One was successfully set up. Let's collect
       the project details next."
    4. Project Context (dynamic questions based on the user's original request).
    5. Mobile App (always; explicit web/mobile/stack requests do not skip it).
    6. Code Graph (always required before onboarding is complete; stored locally).

{{CODEX_FALLBACK}}

{{OPENCODE_POPUP}}

{{PERFORMANCE_POPUP}}

{{TEAM_CONFIRMATION_POPUP}}

PROJECT CONTEXT PREFLIGHT (after Traffic One setup success, blocking before mobile):
  After Agent Mode and any required Team Confirmation are resolved, say:
  "Traffic One was successfully set up. Let's collect the project details next."
  Then ask one rich, dynamic MVP-context questionnaire based on the user's
  original request. Collect target users, core jobs, v1 feature priorities,
  user roles/auth, key data entities, admin/ops needs, business model, payment
  needs, integrations, content/data source, notifications/search/uploads/
  realtime, success metrics, launch constraints, and visual/product tone.
  Add domain-specific questions when the request implies a learning platform,
  marketplace, ecommerce, booking product, SaaS/admin tool, community,
  content/media product, portfolio, or internal tool. Ask payment-provider
  details only when the product may charge money. Ask admin-area questions
  when the app has managed content, users, transactions, moderation, reporting,
  or operational workflows, even if the first request did not mention admin.
  For a learning platform, ask about course structure, lessons/progress,
  free vs paid courses, enrollment, learner/admin roles, admin CRUD, seeded
  demo content, analytics, and whether payments are in or out for v1.

  Persist this in `.traffic-one/.one.json` as:
    "projectContext": {
      "source": "prompted",
      "originalPrompt": "<user's original request>",
      "summary": "<short product summary>",
      "answers": {
        "audience": "<answer>",
        "coreFlows": "<answer>",
        "v1Features": "<answer>",
        "rolesAuth": "<answer>",
        "businessModel": "<answer>",
        "payments": "<answer>",
        "admin": "<answer>",
        "dataModel": "<answer>",
        "contentSource": "<answer>",
        "integrations": "<answer>",
        "engagement": "<answer>",
        "successMetrics": "<answer>",
        "constraints": "<answer>",
        "domainSpecific": "<answer>"
      },
      "collectedAt": "<ISO-8601 UTC>"
    }

MOBILE DECISION PREFLIGHT (popup 5, blocking before code graph):
  For every new project, ask the mobile question after project context and
  before the codebase graph provider. Do this even when the
  first prompt explicitly says web only, site, mobile app, iOS, Android, Ionic,
  Capacitor, React Native, Expo, RN, Next.js, frontend only, no backend, no
  subagents, or "just build it"; those are implementation preferences, not
  onboarding answers. {{HOST_POPUP}}

    header: "Mobile App"
    question: "Do you want a mobile app too?"
    options:
      - "Web only (Recommended)" — Build the responsive web/admin app only for v1; no mobile wrapper/native app.
      - "Ionic + Capacitor" — Add the default hybrid iOS/Android mobile app path around the web app.
      - "React Native / Expo" — Add an explicit React Native/Expo mobile app stack.

  Stop and wait for the user's popup answer before writing
  final onboarding state, asking for codeGraphProvider, writing a plan,
  creating files, editing code, scaffolding the
  repo, or simulating Traffic One roles manually. Do not assume "web only"
  just because a popup is unavailable.

CODEBASE GRAPH PROVIDER PREFLIGHT (popup 6, always required):
  After the mobile decision is resolved, ask the codebase-graph provider choice.
  {{HOST_POPUP}}

    header: "Code Graph"
    question: "Which provider should we use for the codebase graph?"
    options:
      - "GitNexus" — Node CLI; writes .gitnexus/; PolyForm Noncommercial; requires Node >=22.
      - "graphify" — Python CLI; writes graphify-out/GRAPH_REPORT.md + graph.json; MIT license.

  This choice is REQUIRED — no skip and no default. Do NOT complete onboarding
  with local `codeGraphProvider` absent. If the user expresses uncertainty,
  explain the license/runtime trade-off and ask the popup again.
  Do not pick either provider.

── Branch on the user's first message ──

PATH A — User mentioned only FEATURES (no specific tech stack):
  Pitch the end-to-end default in one short, friendly paragraph:

    "I'd suggest our standard stack: React + TypeScript end-to-end —
    Turborepo monorepo (typed state with RTK + RTK Query, Tailwind + shadcn/ui
    for the UI layer, Jest + Playwright for tests) backed by {{BACKEND_LABEL}};
    {{DEPLOY_LABEL}}. Want to use this stack?"

  If yes (or no objection), run the Agent Mode preflight first, then Team
  Confirmation for High/Balanced, then project context, then mobile, then code
  graph. Do not skip these because the first prompt already requested web,
  mobile, Ionic, Capacitor, React Native, Expo, or another stack. Then write
  final onboarding state with
                stack=default, frontend=react-vite, backend={{DEFAULT_BACKEND}}, realtime=none
                (ask only if real-time matters: gameplay/markets/trading).

PATH B — User mentioned a SPECIFIC TECH STACK:
  Pitch our stack layer by layer. Be brief; one short paragraph total.
  The default is STILL end-to-end Supabase; only deviate on explicit refusal.

    Frontend:
      • React → great, point out battle-tested rules for monorepo, RTK Query,
        Tailwind + shadcn/ui, accessibility, real-time.
      • Any non-default frontend (Next.js / Vue / Svelte / Angular / etc.) →
        say the default first recommendation is React/Vite + Supabase, then
        honor the user's explicit choice if they keep it. Set
        stack=custom-frontend (or custom-stack if they also chose a custom
        backend) and record the concrete frontend, e.g. frontend=nextjs.
        Apply that frontend's provider/framework recommendations instead of
        React/Vite-only rules.

    Backend (default to {{DEFAULT_BACKEND}} unless user explicitly refuses):
      • If user did NOT name a backend → silently set backend={{DEFAULT_BACKEND}}.
        In your one-line confirmation, mention: "Backend: {{BACKEND_LABEL}}."
      • If user said "frontend only" / "no backend" / "I have my own API" →
        still pitch {{BACKEND_LABEL}} ONCE in a sentence. Only fall back to
        `external-api` (frontend has its own API) or `none` (no backend
        intended) when they explicitly decline.
      • If user named a different backend (Firebase / Mongo / own Postgres) →
        pitch {{BACKEND_LABEL}} ONCE: "{{BACKEND_LABEL}} is our default because it
        gives the app Postgres, Auth, Storage, Realtime, and RLS without custom
        backend plumbing; {{DEPLOY_LABEL}}. Worth a try?"
        – If they accept → set backend={{DEFAULT_BACKEND}}.
        – If they decline → set backend to their named one (firebase / mongo /
          self-hosted / other / external-api) AND invoke the `library-pick`
          skill to surface the right rules and integration patterns for that
          backend choice.

  Codebase-graph provider (REQUIRED — no skip / no default):
    The plugin builds a structural cache of the codebase that subagents and
    skills read BEFORE falling back to grep / glob. Estimated effect: 50–70%
    lower token usage on multi-file work + measurably better cross-file
    refactor and "where does X live" answers. Two options — gitnexus is
    listed first; pick one:

      • `gitnexus` — Node CLI (`npm install -g gitnexus`); writes a
        knowledge graph + auto-generated context to `.gitnexus/`. Optional
        MCP server (`gitnexus mcp`) for richer queries.
        **Requires Node >=22.** The plugin auto-detects the current Node and
        refuses to install on older versions with a one-line `nvm` upgrade
        command (`nvm install 22 && nvm alias default 22`). If the user is
        on Node <22 and doesn't want to upgrade, recommend `graphify`.
        **License: PolyForm Noncommercial — only usable on non-commercial
        projects. The plugin surfaces this again at install time.**
      • `graphify` — Python CLI (`pipx install graphifyy`); writes
        `graphify-out/GRAPH_REPORT.md` + `graph.json`. License: MIT.
        Currently auto-runs after first build.

    Ask with the CODEBASE GRAPH PROVIDER PREFLIGHT popup above. If the
    host cannot show popups, ask verbatim in English: "Which provider should we
    use for the codebase graph: **gitnexus** or **graphify**?"
    Treat as REQUIRED. Do NOT complete onboarding with local
    `codeGraphProvider` absent. If the user expresses uncertainty, repeat the
    one-line license trade-off above and ask again. NEVER default-pick.

GENERAL RULES:
  - One pitch per layer. If they say no twice, accept it and move on.
  - Don't be pushy; sound like a senior dev recommending what works.
  - The OpenCode delegation opt-in (token economy) is asked FIRST, before the
    Performance popup. Save local `openCode` with `enabled` (true|false),
    `source: "prompted"`, and `decidedAt`. Either answer resolves it — never
    auto-pick on the user's behalf.
  - The codeGraphProvider question above is REQUIRED — no skip, no default,
    and is stored in local per-user preferences.
  - `projectContext` is REQUIRED and must be collected after Traffic One setup
    success and before the mobile prompt.
  - `version` is the current Traffic One plugin semver. Do NOT write a
    separate `pluginVersion` field.
  - `mobile.source` is an exact enum. Use only `prompted` for the required
    Mobile App popup/chat answer, `explicit` for an explicit mobile request,
    or `none` when no mobile decision has been collected. Never write
    descriptive variants such as `user-onboarding`.
  - Write the effective onboarding state to `.traffic-one/.one.json` (use the Write tool) with EXACTLY THIS SHAPE.
    Use the RELATIVE path `.traffic-one/.one.json` so it lands in the project root
    (your current working directory). Do NOT pass an absolute path and do NOT try
    to detect/confirm the directory first — the onboarding gate reads
    `<cwd>/.traffic-one/.one.json`, so a relative write always lands where the gate
    looks. (If you want to confirm the directory, read-only `pwd`/`ls`/`Read`
    are allowed before onboarding completes.)
    The hook will move local-only fields (`openCode`, `codeGraphProvider`,
    `performance`, `team`, `toolchain`, and graph runner stamps) into local preferences and
    rewrite committed `.traffic-one/.one.json` with shared project facts only.
    All required top-level fields are REQUIRED — do NOT drop any. Subsequent
    hooks validate the effective merged state and rely on `onboardingComplete: true`
    and `mode` being present:

    {
      "version": "<current-plugin-version>",
      "mode": "new-project",
      "stack": "<chosen-id>",
      "frontend": "<none|react-vite|nextjs|vue|svelte|angular|astro|solid|remix|other>",
      "backend": "<chosen-backend>",
      "projectContext": {
        "source": "prompted",
        "originalPrompt": "<user's original request>",
        "summary": "<short product summary>",
        "answers": {},
        "collectedAt": "<ISO-8601 UTC>"
      },
      "mobile": { "enabled": false, "framework": "none", "source": "prompted" },
      "technologies": { "frontend": [], "backend": [], "mobile": [] },
      "realtime": "<heavy|light|none>",
      "codeGraphProvider": "<gitnexus|graphify>",
      "openCode": { "enabled": <true|false>, "source": "prompted", "decidedAt": "<ISO-8601 UTC>" },
      "performance": { "level": "<low|balanced|high>", "source": "prompted" },
      "team": { "mode": "<subagents|main-agent>", "source": "prompted",
                "approved": <true after popup 2 Approve | omit for low> },
      "toolchain": {
        "gitnexus": { "installedVersion": null, "installedAt": null },
        "graphify": { "installedVersion": null, "installedAt": null },
        "gitleaks": { "installedVersion": null, "installedAt": null },
        "trufflehog": { "installedVersion": null, "installedAt": null }
      },
      "confirmed": true,
      "onboardingComplete": true,
      "confirmedAt": "<ISO-8601 UTC, e.g. 2026-04-30T10:00:00Z>"
    }

    For balanced/high: `team.approved: true` is REQUIRED — it is what unlocks
    the PreToolUse spawn gate. Set it ONLY after the user clicked Approve in
    popup 2. For low: omit the field; the in-thread role checklist runs without
    subagent spawns. Optional `team.overrides`: set only when the user
    customised the team in popup 2 (keys are role ids; values are canonical
    tiers highest|balanced|cheapest); omit when there are none.

    Stack ids are: minimal · default · custom-frontend · custom-backend ·
    custom-stack. Recommend the default stack first; if the user explicitly
    chose another frontend/backend, record the matching custom stack plus the
    concrete `frontend` and/or `backend` fields.

  EXAMPLES — non-default backend branches (write the full effective state; the
  hook splits local preferences from committed project state):

    User declined the recommended backend + has own API + picked graphify:
    { "version": "<current-plugin-version>", "mode": "new-project", "stack": "custom-backend",
      "frontend": "react-vite", "backend": "external-api",
      "mobile": { "enabled": false, "framework": "none", "source": "prompted" },
      "technologies": { "frontend": ["react", "vite"], "backend": [], "mobile": [] },
      "realtime": "none", "toolchain": "<initialized>",
      "codeGraphProvider": "graphify",
      "openCode": { "enabled": <true|false>, "source": "prompted", "decidedAt": "<ISO-8601 UTC>" },
      "performance": { "level": "<low|balanced|high>", "source": "prompted" },
      "team": { "mode": "<subagents|main-agent>", "source": "prompted", "approved": true },
      "confirmed": true, "onboardingComplete": true, "confirmedAt": "<ISO>" }

    User declined the recommended backend + no backend planned + picked gitnexus:
    { "version": "<current-plugin-version>", "mode": "new-project", "stack": "custom-backend",
      "frontend": "react-vite", "backend": "none",
      "mobile": { "enabled": false, "framework": "none", "source": "prompted" },
      "technologies": { "frontend": ["react", "vite"], "backend": [], "mobile": [] },
      "realtime": "none", "toolchain": "<initialized>",
      "codeGraphProvider": "gitnexus",
      "openCode": { "enabled": <true|false>, "source": "prompted", "decidedAt": "<ISO-8601 UTC>" },
      "performance": { "level": "<low|balanced|high>", "source": "prompted" },
      "team": { "mode": "<subagents|main-agent>", "source": "prompted", "approved": true },
      "confirmed": true, "onboardingComplete": true, "confirmedAt": "<ISO>" }

    User chose Firebase / Mongo / their own Postgres + picked graphify:
    { "version": "<current-plugin-version>", "mode": "new-project", "stack": "custom-backend",
      "frontend": "react-vite", "backend": "other",
      "mobile": { "enabled": false, "framework": "none", "source": "prompted" },
      "technologies": { "frontend": ["react", "vite"], "backend": ["other"], "mobile": [] },
      "realtime": "none", "toolchain": "<initialized>",
      "codeGraphProvider": "graphify",
      "openCode": { "enabled": <true|false>, "source": "prompted", "decidedAt": "<ISO-8601 UTC>" },
      "performance": { "level": "<low|balanced|high>", "source": "prompted" },
      "team": { "mode": "<subagents|main-agent>", "source": "prompted", "approved": true },
      "confirmed": true, "onboardingComplete": true, "confirmedAt": "<ISO>" }

  Stack ids: minimal · default · custom-frontend · custom-backend · custom-stack.

  Backend values: supabase · our-fork · self-hosted · managed · other · external-api · none
    Default = {{DEFAULT_BACKEND}}.
  Realtime values: heavy · light · none
  Code-graph provider values: gitnexus · graphify (REQUIRED, no default; stored locally).

── After the rule bundle loads (PostToolUse system message arrives) ──

THIS IS NOT OPTIONAL: the moment you see `traffic-one rules loaded for stack: <id>`,
SCAFFOLD THE PROJECT STRUCTURE BEFORE writing any feature code.

For the recommended default stack (`default` with frontend=react-vite and backend=supabase), that means:
  1. Workspace skeleton: `turbo.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`,
     `.gitignore`, root `package.json` (private, workspaces declared, packageManager: pnpm).
  2. `apps/web/`: package.json, vite.config.ts, tsconfig.json, index.html,
     src/main.tsx, src/App.tsx, src/routes.tsx, src/store/index.ts,
     `src/styles/globals.css` (Tailwind directives + shadcn HSL theme block),
     `tailwind.config.ts` (extends `@app/tailwind-config` preset), `postcss.config.cjs`.
     Run `npx shadcn@latest init` here, then add the first batch:
     `npx shadcn@latest add button input label card dialog dropdown-menu form sheet tabs select sonner badge separator`.
  3. Project memory baseline: create `.traffic-one/` and run
     `project-memory`. Verify the root companion state file
     `.traffic-one/.one.json` exists with the full onboarding schema, then write
     product.md, stack.md, coding.md, security.md,
     known-issues.md, agent-log.md, .agentignore, deployments.jsonl,
     schema.sql, decisions/, and skills/ when reusable team commands are
     needed. Root AGENTS.md contains the compact active rule kernel/index by
     default. Existing root AGENTS.md and CLAUDE.md files must be preserved and
     merged with Traffic One managed blocks. Do not generate
     `.traffic-one/rules/AGENTS.md`; `.traffic-one/rules/` contains only
     generated rule files. Root CLAUDE.md should symlink to root AGENTS.md only
     when CLAUDE.md is absent.
  4. `packages/`: ui/ (shadcn components live here), tailwind-config/ (shared
     Tailwind preset + `globals.css`), i18n/ (typed i18next/react-i18next
     resources and provider), api-client/, ws-client/, utils/, tsconfig/,
     eslint-config/. Each gets package.json + README.md + `architecture.md` (REQUIRED).
     Do NOT create a `packages/design-tokens` package — design tokens live in the
     Tailwind preset and the HSL CSS variables in `globals.css`.
  5. Mandatory design gate: before writing any generated UI, invoke
     `frontend-design` and apply `rules/frontend/ui-quality.md`,
     `rules/frontend/typography.md`, and the active stack's design rules.
     State 2–3 real product references when the user did not provide any,
     record a compact design brief, and make the first screen product-specific
     and content-rich. Missing Supabase/env config may show one shared setup
     banner, but never ship only duplicated config banners, empty filters, or
     blank placeholder panels.
  6. Mandatory i18n baseline: apply `rules/frontend/i18n.md` before writing
     generated UI. Create/use `packages/i18n`, wire the provider, add
     source-language catalog entries for every generated string, and prefer
     `<Trans>` for rich copy with links or React elements. Do not wait for the
     user to request translations.
  7. Mandatory SEO baseline: invoke `seo` before calling a generated website
     or app complete. Add route-aware metadata (`Seo.tsx` +
     `src/lib/seo.ts` for React/Vite/Ionic SPA output, or framework-native
     metadata APIs when explicit Next.js/minimal stacks apply), fallback
     metadata in `index.html`, `VITE_SITE_URL` in `.env.example`,
     `robots.txt`, `sitemap.xml`, `manifest.webmanifest`,
     `favicon.ico`, `apple-touch-icon`, app icons, a 1200x630 OG image,
     and regression coverage for every generated public route's title,
     description, canonical, OG image, JSON-LD, sitemap inclusion, and noindex
     admin/private routes. If an SPA public route must rank, document the
     prerender/static-rendering or host-support plan.
  8. Mandatory docs baseline: run `auto-documentation-generator` before calling
     the scaffold complete. New generated sites/apps/services MUST include the
     relevant root-level canonical docs from `rules/common/documentation.md`:
     README.md, AGENTS.md, concise CLAUDE.md or symlink, .cursor/rules/*.mdc,
     architecture.md, .traffic-one/decisions/, api.md, database.md,
     deployment.md, security.md, CHANGELOG.md, environment-setup.md,
     CONTRIBUTING.md, and served /llms.txt for web surfaces. Mark unknown facts
     as Unverified; do not leave only a lightweight README.
  9. Initialise git with Gitflow branches (`main`, `develop`).

For `custom-backend` with frontend=react-vite and backend=none: a single Vite app under root `src/` (no apps/, no packages/).
`src/styles/globals.css` + `tailwind.config.ts` + `npx shadcn@latest init` + the
same first-batch components under `src/components/ui/`. The mandatory docs
baseline and mandatory design gate still apply.

For mobile.framework=`react-native-expo`: see `rules/modes/new-project.md` and `rules/frontend/react-native/core.md`.
Scaffold uses NativeWind v4 (metro/babel/global.css/nativewind-env.d.ts) and
React Native Reusables (`npx @react-native-reusables/cli@latest init` + first-batch
components under `packages/ui-native/src/components/ui/`). The mandatory
design gate still applies with native-first layout, touch targets, device
states, and real product references.

HARD GATE: before any scaffold or feature write after onboarding, read
`rules/modes/new-project.md` from the active bundle. For `stack=default` or
a React/Vite new project with backend data, a flat/root Vite app is a violation:
do not create root `src/`, root `index.html`, root `vite.config.ts`, or a
root `package.json` without pnpm workspaces. The first scaffold must be the
Turborepo workspace from that rule: root workspaces + `apps/web` +
`packages/{ui,tailwind-config,api-client,ws-client,utils,tsconfig,eslint-config}`
+ Supabase migrations/RLS baseline.

The full step-by-step is in `rules/modes/new-project.md` — that file IS in the bundle
once onboarding completes. Read it before scaffolding.

── Supabase backend (when backend === "supabase" or "our-fork") ──

If the chosen backend is Supabase, after the scaffold is in place but BEFORE
writing any code that uses `@supabase/supabase-js`:
  1. Trigger the `supabase-setup` skill if `.env.local` is missing — it walks
     the user through the dashboard, copies keys, and writes the env files.
  2. Use the lazy-client + EnvBanner pattern from `rules/frontend/react/supabase-client.md`
     so the app renders fine even before keys are pasted.
     Every website-facing missing-config CTA (`<EnvBanner />`,
     `<SupabaseConfigAlert />`, `<ConfigurePromptCard />`, auth/profile/job
     empty states, protected-route fallbacks) MUST link to
     `https://traffic.io/`, and the scaffold must include a regression test
     that asserts that exact href.
  3. Treat add-ons (storage / auth / realtime / vector / pg_cron / pg_net) as
     gated. The `requireAddon` helper reads `.traffic-one/.one.json` →
     `supabaseAddons[<name>]`. Ask the user once before enabling, then write
     `approved` and proceed silently for that add-on.
  4. Edge Functions auto-deploy on save when
     `.traffic-one/.one.json` → `supabaseFunctionsAutoDeploy: true`. The PostToolUse
     hook prompts the user the first time and stores their preference.

After the scaffold is in place, address the user's original feature request inside
the new structure (e.g. `apps/web/src/features/<name>/` for the React monorepo).

DO NOT tell the user to restart Claude Code.

Until onboarding is complete, the minimal baseline rules below are in effect.
Do not read, invoke, announce, or activate scaffolding/design skills
(create-component, create-feature, frontend-design, tdd-workflow, etc.) before
the rule bundle has loaded — the scaffold above sets up the directory tree those
skills depend on.
<!-- T1BLOCK:END onboarding-directive-new-project -->
