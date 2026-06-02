---
name: traffic-one-onboarding-gate
description: Wording source for Traffic One setup gates — new-project onboarding, local preference prompts, chat fallbacks (shown when no host popup tool is available), and gate deny reasons. Read at runtime via skillBlock(); the step-routing + deny LOGIC lives in TS.
---

# Traffic One Onboarding Gate

Directive PROSE for the new-project onboarding and local preference flows. The step router, deny
conditions, and `permissionDecision:"deny"` live in
`src/modules/onboarding-gate/` + `src/shared/onboarding/`. `{{PLACEHOLDER}}`
tokens are filled by the gate. Each block has a verbatim fallback in code, so a
missing block never disables the gate.

<!-- T1BLOCK:BEGIN open-code -->
Traffic One can delegate bounded coding tasks to OpenCode — a free, local AI
agent — to save your paid token budget. Traffic One still plans, supervises,
and verifies; OpenCode executes, and every change is kept in a reviewable
digest. If you enable it, {{INSTALL}} runs automatically when needed and you
sign in after the CLI is available. The delegation feature ships in a later
update; this records your preference and install approval.

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
Selecting a provider approves Traffic One hooks to install or upgrade that
provider's local CLI when it is missing or below the minimum supported version.

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
Do not spawn subagent workers, do not write feature source, and do not set `team.source: "unavailable"` as a shortcut. If subagents are unavailable, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before any state rewrite.
{{SOURCE_NOTE}}
Use the host's interactive prompt/popup tool when available. This is onboarding popup 2. If no popup tool is exposed, show this plain-chat fallback verbatim:

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
Ask via the host's interactive prompt/popup tool when available. Only if no popup tool is exposed, ask in plain chat with the numbered options, tell the user to reply with the option number or label, and stop. Do NOT emit the plain-text fallback when a popup tool is working.
<!-- T1BLOCK:END host-popup-instruction -->

<!-- T1BLOCK:BEGIN current-thread-fallback -->
CURRENT-THREAD ONBOARDING FALLBACK (visible response, blocking):
If the host's interactive prompt tool cannot be called, do not use tools and do not keep detecting/scaffolding.
Before onboarding is resolved, mention only the project-detection/onboarding flow. Do not read, invoke, announce, or activate create-feature, create-page, frontend-design, tdd-workflow, or other implementation skills yet.
Your next visible assistant message must be the plain-chat fallback prompt below, then you must stop for the user answer:

{{OPEN_CODE_PROMPT}}

After the user answers, ask Agent Mode, Team Confirmation for High/Balanced, then show "Traffic One was successfully set up. Let's collect the project details next.", collect a rich dynamic MVP project context, ask Mobile App, then ask Code Graph. Ask only the next unresolved question and stop each time.
<!-- T1BLOCK:END current-thread-fallback -->

<!-- T1BLOCK:BEGIN onboarding-reminder -->
═══ traffic-one — onboarding still incomplete ═══

mode=new-project: complete Traffic One onboarding in the current thread before
implementation. If no popup/input tool is available, ask the required
onboarding question in chat and stop for the user's typed answer. Do not
scaffold, install, edit source, or choose defaults while onboarding answers are
pending.

{{CURRENT_THREAD_FALLBACK}}

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
Team confirmation: for balanced/high, ALSO ask the Team popup (popup 2) so the user approves the role→model line-up. On Approve, save `team.approved: true` in local preferences (REQUIRED — the PreToolUse spawn gate denies every subagent-spawn call until this flag is present). Save per-role overrides as `team.overrides` (role → tier) when the user customises; omit the field when the line-up was approved as-is.
Project context: REQUIRED after the Traffic One setup success message and before the Mobile App prompt. Ask the rich dynamic MVP questionnaire and save answers with suggested keys: audience, coreFlows, v1Features, rolesAuth, businessModel, payments, admin, dataModel, contentSource, integrations, engagement, successMetrics, constraints, domainSpecific.
Toolchain: REQUIRED in local preferences, initialized with gitnexus, graphify, gitleaks, and trufflehog null stamps.

Default complex-project recommendation is stack=default, frontend=react-vite,
backend=supabase. If the user explicitly chose a non-default frontend or
backend, record the matching custom stack and concrete technology fields.

Use the host's interactive prompt/popup tool for the next unresolved onboarding
choice in this order: OpenCode delegation opt-in (token economy), Agent
Mode/Performance, Team Confirmation for balanced/high subagents,
project context, Mobile App, then Code Graph. Ask the
mobile prompt even when the user's prompt already named web, mobile, Next.js,
Ionic, React Native, frontend-only, or any other implementation preference. Do
not print numbered option
lists in chat when a popup tool is available. If the popup tool is
unavailable, ask the same question in chat with numbered options, tell the user
to reply with the option number or label, and stop. Do not choose a default or
continue implementation while the answer is pending. See the FIRST-RUN
ONBOARDING directive for the full pitch script and decline-Supabase examples.
<!-- T1BLOCK:END onboarding-reminder -->

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
{{CURRENT_THREAD_FALLBACK}}
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
  Spawn via your host's subagent tool and set its `model` parameter to the
  resolved value for each role's tier (the per-host columns above come from
  `model-tiers.cjs`).

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
  Spawn via your host's subagent tool and set its `model` parameter to the
  resolved value for each role's tier (the per-host columns above come from
  `model-tiers.cjs`).

The orchestrator MUST NOT write feature source files.
<!-- T1BLOCK:END perf-high -->

<!-- T1BLOCK:BEGIN performance-popup -->
AGENT PERFORMANCE PREFLIGHT (popup 1, blocking for non-trivial multi-layer builds):
  After global Traffic One auth is resolved, ask the performance level using
  the host's popup/input mechanism:
    - Use your host's interactive prompt/popup tool when available.
    - Fallback: if no popup tool is exposed, ask in plain chat
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
  and do NOT spawn any subagent
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
  be physically denied by the spawn gate — any subagent-spawn call
  while local Traffic One preferences have `team.approved !== true` returns
  "Team Confirmation gate" denial. The following are all violations of this rule:
    - Saving local preferences with `team.approved: true` before the
      user has actually clicked Approve in popup 2.
    - Saying "I'll auto-approve the default", "the default looks fine",
      "I'll proceed with Balanced", "to keep moving I'll approve", or any
      phrasing that picks an answer on the user's behalf.
    - Spawning ANY subagent before
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

  TWO-STEP DISPLAY (mandatory; some host prompt tools have no body field, so the
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
      Ask via the host's interactive prompt/popup tool when available. If
      no popup is exposed, fall back to plain chat with the
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
      it, every subagent-spawn call will be denied. Then auto-launch
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
    gate denies every subagent-spawn call until this flag is present.
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
  paid model token usage.
  If the CLI is missing or below the minimum supported version, {{INSTALL}}
  runs automatically from the hook after this approval. The delegation wiring
  ships in a later update — for now this records your preference and install
  approval so a future performance update can split work between Traffic One
  subagents and free OpenCode agents.

    header: "OpenCode"
    question: "Save tokens with OpenCode and approve hook-owned CLI install/upgrade if needed?"
    options:
      - "Enable OpenCode delegation" — Allow Traffic One to hand bounded tasks to OpenCode later and install/upgrade the local CLI if needed.
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

This is a new project. Before writing any feature code, briefly understand what
the user is building, recommend our stack, and save the onboarding state. A
PostToolUse hook splits local-only preferences into a per-user file, rewrites
committed `.traffic-one/.one.json` with shared project facts, and auto-loads the
matching rule bundle into THIS session — no restart needed.

DEFAULT (end-to-end): stack=default, frontend=react-vite, backend={{DEFAULT_BACKEND}}, mobile=none, realtime=none.
Only deviate when the first prompt asks for a minimal/static project or explicit
custom frontend/backend/mobile technology. Explicit user requests influence the
eventual stack choice but never skip or auto-answer onboarding.

CURRENT-THREAD ONBOARDING GATE (all hosts):
  While `mode === "new-project"`, complete onboarding in the current thread
  before saving `.traffic-one/.one.json`, writing `.traffic-one/plan.md`,
  spawning/simulating subagents, creating files, editing code, installing, or
  scaffolding. Use the host popup tool when available; otherwise ask the next
  unresolved question in plain chat and stop for the user's typed answer.

ONBOARDING POPUP RULE (all hosts, blocking):
  Display these choices as host prompt popups, not numbered prose. {{HOST_POPUP}}
  Never choose a default, infer an answer, auto-approve a recommendation, save
  final state, scaffold, install, or spawn while an answer is pending — including
  popup 2 (Team Confirmation), which you may NOT auto-approve.

  Required popup order: OpenCode opt-in (before Performance) → 1. Agent Mode /
  Performance (High/Balanced/Low) → 2. Team Confirmation (MANDATORY for
  Balanced/High) → 3. success message ("Traffic One was successfully set up.
  Let's collect the project details next.") → 4. Project Context → 5. Mobile App
  → 6. Code Graph.

{{CURRENT_THREAD_FALLBACK}}

{{OPENCODE_POPUP}}

{{PERFORMANCE_POPUP}}

{{TEAM_CONFIRMATION_POPUP}}

── Stack recommendation (branch on the user's first message) ──

PATH A — user mentioned only FEATURES (no specific stack): pitch the end-to-end
default in one short, friendly paragraph:

  "I'd suggest our standard stack: React + TypeScript end-to-end — Turborepo
  monorepo (RTK + RTK Query, Tailwind + shadcn/ui, Jest + Playwright) backed by
  {{BACKEND_LABEL}}; {{DEPLOY_LABEL}}. Want to use this stack?"

  On yes / no-objection, set stack=default, frontend=react-vite,
  backend={{DEFAULT_BACKEND}}, realtime=none (ask about realtime only if it
  matters: gameplay / markets / trading).

PATH B — user named a SPECIFIC stack: pitch our stack briefly, layer by layer.
The default is still end-to-end {{BACKEND_LABEL}}; deviate only on explicit
refusal. Honor an explicitly chosen non-default frontend/backend by recording
the matching `custom-frontend` / `custom-backend` / `custom-stack` id plus the
concrete `frontend`/`backend`, and invoke `library-pick` for the chosen tech.
One pitch per layer; if they decline twice, accept and move on.

── Remaining prompts + state: follow rules/common/onboarding.md ──

The Project Context questionnaire, the Mobile App and Code Graph prompts, the
exact `.traffic-one/.one.json` schema, the stack ids, and the backend/realtime
values are all defined in `rules/common/onboarding.md` (the single source).
Follow it to ask each remaining prompt (popup or chat fallback) and to write the
full state with the Write tool to the RELATIVE path `.traffic-one/.one.json`.
`codeGraphProvider` is REQUIRED (no skip, no default). Do not drop required
fields; the hook splits local-only fields out and validates `onboardingComplete: true`.

── After the rule bundle loads (PostToolUse system message arrives) ──

The moment you see `traffic-one rules loaded for stack: <id>`, scaffold the
project structure BEFORE any feature code, following `rules/modes/new-project.md`
(now in the bundle): the Turborepo workspace (`apps/web` + `packages/*`) for the
default stack, with the mandatory `frontend-design`, i18n, SEO, and
auto-documentation baselines. For Supabase backends, run `supabase-setup` before
any `@supabase/supabase-js` code. A flat/root Vite app for `stack=default` is a
violation.

DO NOT tell the user to restart the host. Until onboarding completes, only the
minimal baseline rules are in effect; do not invoke scaffolding/design skills
(create-component, create-feature, frontend-design, tdd-workflow, …) before the
bundle loads.
<!-- T1BLOCK:END onboarding-directive-new-project -->
