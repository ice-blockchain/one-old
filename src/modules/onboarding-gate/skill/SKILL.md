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
