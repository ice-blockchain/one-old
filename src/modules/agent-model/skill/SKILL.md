---
name: traffic-one-agent-model-gate
description: Wording source for the Traffic One agent-spawn model-tier + team-confirmation gate. Read at runtime via skillBlock(); enforcement lives in TS.
---

# Traffic One Agent-Model Gate

Deny-reason wording for the PreToolUse spawn gate. Enforcement (the actual deny)
lives in `src/modules/agent-model/handler.ts`. `{{PLACEHOLDER}}` tokens are filled
by the gate.

<!-- T1BLOCK:BEGIN agent-materialization-deny -->
Traffic One agent spawn gate: state was repaired/materialized before this agent spawn.
The role agent has been denied once so frontend/backend workers cannot start against stale `.traffic-one/.one.json`, rules, skills, or root agent context.
rerun the same agent spawn now; the canonical `.traffic-one/.one.json` and project-local materialization are current.
<!-- T1BLOCK:END agent-materialization-deny -->

<!-- T1BLOCK:BEGIN agent-materialization-missing -->
Traffic One agent spawn gate: project-local rules/skills are not materialized yet.
Do not spawn frontend/backend/reviewer/tester workers until `.traffic-one/.one.json` has current `materializedStack`, `materializedAt`, and `materializedVersion`, and `.traffic-one/manifest.json`, `.traffic-one/rules/**`, `.traffic-one/skills/**`, root `AGENTS.md`, and root `CLAUDE.md` exist.
Run `node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/hook-runtime.cjs" materialize-project` from the project root, then retry the agent spawn.
<!-- T1BLOCK:END agent-materialization-missing -->

<!-- T1BLOCK:BEGIN performance-main-agent -->
Performance gate: local Traffic One preferences record performance.level="{{LEVEL}}" (main-agent only), but you are spawning the `{{ROLE}}` subagent. If the user chose Balanced or High, first correct local preferences (`performance.level` plus matching `team.mode="subagents"`) so the right model tier applies, then re-spawn passing the `model` parameter. If the user really chose Low, do NOT spawn subagents — run the roles in this thread as the role roadmap checklist.
<!-- T1BLOCK:END performance-main-agent -->

<!-- T1BLOCK:BEGIN team-confirmation -->
Team gate: spawning subagents needs `team.approved: true`, which the Traffic One setup wizard sets AUTOMATICALLY from the performance choice (performance.level="{{LEVEL}}" ⇒ subagents). Local preferences currently have `team.approved !== true`, which means the wizard's performance/team step was not completed for this project — not that the user must approve a line-up in chat. Do NOT pop a chat "approve the team?" prompt and do NOT hand-edit preferences to set the flag. Re-open the Traffic One setup wizard and finish the performance/team step (it writes `team.approved: true` and shows the role→model line-up), then re-spawn passing the per-role `model` parameter. If the user wants Low/main-agent mode instead, they re-pick performance in the wizard; never bypass this gate for `team.mode="subagents"`.
<!-- T1BLOCK:END team-confirmation -->

<!-- T1BLOCK:BEGIN performance-model-param -->
Performance gate (level={{LEVEL}}, host={{HOST}}): spawning `{{ROLE}}` requires the `model` tool parameter set to "{{EXPECTED}}". {{PASSED_NOTE}}Re-issue the spawn with `model: "{{EXPECTED}}"`. The model is set ONLY by this parameter — a model name in the prompt text has no effect. Per-role model tiers live in `performance-config.cjs` / `model-tiers.cjs`.
<!-- T1BLOCK:END performance-model-param -->

<!-- T1BLOCK:BEGIN role-not-in-plan -->
Orchestration gate: `{{ROLE}}` is not in this run's declared roster [{{ROSTER}}]. The orchestrator's plan at `.traffic-one/runs/<currentRunId>/orchestration.json` decides which roles run for this request. If `{{ROLE}}` is genuinely needed (e.g. the task is bigger than first classified), add it to the plan's `roster` (and a `roles.{{ROLE}}` tier) and re-spawn. If it is not needed, do not spawn it. Never bypass the plan by spawning an off-roster role.
<!-- T1BLOCK:END role-not-in-plan -->

<!-- T1BLOCK:BEGIN orchestration-directive -->
[ORCHESTRATION] You are the orchestrator — work only through subagents; do not edit code yourself. Before spawning, classify this request and DECLARE a plan by writing `.traffic-one/runs/<currentRunId>/orchestration.json` (see the senior-eng-orchestrator skill for the schema + roster/tier catalog), then spawn only the declared roster, in the declared order, each at its declared `model` tier:
- minor (text/copy edit, small UI tweak, single-file fix) → ONE cheapest-tier subagent of the relevant role (usually senior-frontend); skip architect/backend/tester; optional light reviewer.
- standard build → senior-architect first, then senior-frontend ∥ senior-backend, then senior-reviewer ∥ senior-tester. Include senior-backend only when the request actually touches server/data/API (else drop it from the roster).
- performance-critical work → raise the owning role's tier (e.g. `highest`).
The spawn gate enforces this: a role absent from the roster is denied, and each spawn's `model` must match its declared tier.
<!-- T1BLOCK:END orchestration-directive -->
