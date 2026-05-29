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
Team Confirmation gate: performance.level="{{LEVEL}}" requires the user to explicitly approve the subagent role/model line-up before ANY subagent can be spawned. Local Traffic One preferences currently have `team.approved !== true`, so the user has not yet confirmed. Ask the host popup tool (Codex `request_user_input`, Claude Code `AskUserQuestion`, Cursor task-UI) with header "Team", question "Here is the subagent team for {{LEVEL}} mode — approve or change?", body containing the role→tier→model line-up (use `tierModelTable` from `model-tiers.cjs`), and options "Approve" / "Re-pick performance" / "Customise". When the user replies "Approve", save local Traffic One preferences with `team.approved: true` (and any `team.overrides` collected), then re-spawn. If subagents or popup confirmation are genuinely unavailable, ask the user to explicitly say they no longer want subagents and want Low/main-agent mode before rewriting local preferences; do not bypass this gate for `team.mode="subagents"`.
<!-- T1BLOCK:END team-confirmation -->

<!-- T1BLOCK:BEGIN performance-model-param -->
Performance gate (level={{LEVEL}}, host={{HOST}}): spawning `{{ROLE}}` requires the `model` tool parameter set to "{{EXPECTED}}". {{PASSED_NOTE}}Re-issue the spawn with `model: "{{EXPECTED}}"`. The model is set ONLY by this parameter — a model name in the prompt text has no effect. Per-role model tiers live in `performance-config.cjs` / `model-tiers.cjs`.
<!-- T1BLOCK:END performance-model-param -->
