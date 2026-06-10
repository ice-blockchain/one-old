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

<!-- T1BLOCK:BEGIN opencode-role-delegate -->
OpenCode role gate: `{{ROLE}}` is configured to run on the free OpenCode agent (it is in `openCode.delegateRoles`, and `openCode.enabled` is true), so do NOT spawn it as a paid subagent yet. First delegate its work to OpenCode via the bundled `opencode-worker` MCP tool — it runs OpenCode in a host-launched process OUTSIDE the per-tool sandbox, so the network + git it needs work even where your own shell is sandboxed (e.g. Codex):
{{AUTHORIZATION}}
1. Call the `opencode_delegate` tool (MCP server `opencode-worker`) with:
   - `role`: `{{ROLE}}`
   - `runId`: `{{RUN_ID}}`
   - `projectRoot`: `{{PROJECT_ROOT}}`  (absolute path — the directory holding `.traffic-one`)
   - `task`: the role's self-contained task (its assigned scope + acceptance criteria, no external context the run can't see).
   Do NOT pass `model` — a FREE hosted model is selected automatically (no account/API key needed; it falls back to the next free model if one was retired). The user enabled this delegation in the Traffic One setup wizard.
2. **If the result has `running:true`** → the run is proceeding in the BACKGROUND; call `opencode_delegate` AGAIN with the SAME arguments to keep waiting. Repeat until you get a terminal `ok`. (This is how a multi-minute run survives the host's ~120s tool-call timeout — do NOT treat `running:true` as a failure and do NOT fall back yet.)
3. On `ok:true` (delegated) → the change is applied to the tree and a digest is written; proceed to review (`senior-reviewer` verifies the weaker model's diff). Do NOT spawn the paid `{{ROLE}}`.
4. On `ok:false` (skipped/failed/no-changes) → the attempt for this run is recorded, so just re-spawn `{{ROLE}}` exactly as usual — this gate now allows it (fallback).
5. **If the `opencode_delegate` call itself was rejected by the host's safety reviewer** (e.g. Codex: "rejected due to unacceptable risk") → that is also a completed attempt: re-spawn `{{ROLE}}` as usual; this gate denies each role at most once per run, so the second spawn goes through. Do NOT loop on the rejected tool call and do NOT stall the build waiting for a decision.
Fallback if the `opencode-worker` tool is unavailable: on Codex this usually means the auto-registered MCP server has not been loaded yet — tell the user a ONE-TIME Codex restart enables it. Meanwhile: write the task to `.traffic-one/opencode-task.md` and run `node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/opencode-runner.cjs" --run-id {{RUN_ID}} --role {{ROLE}} --task-file .traffic-one/opencode-task.md` (same `ok:true`/`ok:false` semantics; no `running` — it blocks to completion). On a sandboxed host the shell path may fail to reach the network, so prefer the tool.
To stop routing this role through OpenCode, remove it from `openCode.delegateRoles` in local preferences.
<!-- T1BLOCK:END opencode-role-delegate -->
