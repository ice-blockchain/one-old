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
Run `node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}}/scripts/hook-runtime.cjs" materialize-project` from the project root, then retry the agent spawn.
<!-- T1BLOCK:END agent-materialization-missing -->

<!-- T1BLOCK:BEGIN performance-main-agent -->
Performance gate: local Traffic One preferences record performance.level="{{LEVEL}}" (main-agent only), but you are spawning the `{{ROLE}}` subagent. If the user chose Balanced or High, first correct local preferences (`performance.level` plus matching `team.mode="subagents"`) so the right model tier applies, then re-spawn passing the `model` parameter. If the user really chose Low, do NOT spawn subagents — run the roles in this thread as the role roadmap checklist.
<!-- T1BLOCK:END performance-main-agent -->

<!-- T1BLOCK:BEGIN team-confirmation -->
Team gate: spawning subagents needs `team.approved: true`, which the Traffic One setup wizard sets AUTOMATICALLY from the performance choice (performance.level="{{LEVEL}}" ⇒ subagents). Local preferences currently have `team.approved !== true`, which means the wizard's performance/team step was not completed for this project — not that the user must approve a line-up in chat. Do NOT pop a chat "approve the team?" prompt and do NOT hand-edit preferences to set the flag. Re-open the Traffic One setup wizard and finish the performance/team step (it writes `team.approved: true` and shows the role→model line-up), then re-spawn passing the per-role `model` parameter. If the user wants Low/main-agent mode instead, they re-pick performance in the wizard; never bypass this gate for `team.mode="subagents"`.
<!-- T1BLOCK:END team-confirmation -->

<!-- T1BLOCK:BEGIN performance-model-param -->
Performance gate (level={{LEVEL}}, host={{HOST}}): spawning `{{ROLE}}` requires the `model` tool parameter set to "{{EXPECTED}}". {{PASSED_NOTE}}Re-issue the spawn with `model: "{{EXPECTED}}"`. The model is set ONLY by this parameter — a model name in the prompt text has no effect, and on Cursor the `.cursor/agents/{{ROLE}}.md` frontmatter is NOT auto-applied: without this `model` parameter the subagent INHERITS the parent (orchestrator) model, so you MUST pass `model` per role (the correct value is also pinned in `.cursor/agents/{{ROLE}}.md`).{{ALTERNATES}} Per-role model tiers are defined by the plugin's model-tiers config (`scripts/config/model-tiers.js` in the installed plugin).
<!-- T1BLOCK:END performance-model-param -->

<!-- T1BLOCK:BEGIN cursor-models-capture -->
Cursor model-capture gate (asked once per run, run {{RUN_ID}}). Capture is OPTIONAL and you are NOT blocked.
**To proceed RIGHT NOW: RE-ISSUE THE SAME `Task` spawn, unchanged.** Traffic One then falls back to family-aware matching and the spawn goes through — pass any model whose family fits the tier (an `claude-opus-4-8…` slug for highest, a `claude-4.6-sonnet…`/`gpt-5.5…` slug for balanced, a `composer-2.5…` slug for cheapest).
To pin the EXACT slugs your build offers FIRST (recommended — it avoids a silent downgrade where a balanced/highest role drops to the Composer floor), do this once before re-issuing:
1. List the model ids your `Task` tool offers for spawning subagents (the same list Cursor shows when you pick a subagent model).
2. Write them to `.traffic-one/cursor-models.json` (in {{PROJECT_ROOT}}) as exactly `{ "models": ["<id-1>", "<id-2>", "..."] }`, using the EXACT ids with their reasoning suffixes (e.g. `claude-opus-4-8-thinking-max-fast`, `gpt-5.5-extra-high`, `composer-2.5-fast`). Include at least one id per tier the team needs — highest + balanced + cheapest — so no tier silently degrades; do not invent ids, list only what your Task tool actually offers.
3. Re-issue the spawn. Traffic One re-materializes `.cursor/agents/<role>.md` with the real slug for each role's tier.
Either way the very next spawn proceeds — NEVER build the project inline because of this gate.
<!-- T1BLOCK:END cursor-models-capture -->

<!-- T1BLOCK:BEGIN model-unavailable-choice -->
Model tier gate (level={{LEVEL}}, host={{HOST}}): `{{ROLE}}` should run on the recommended model "{{EXPECTED}}", but this Cursor build is about to use "{{FALLBACK}}" instead. Cursor does not report WHY to a plugin, so it is one of the two cases below. Reply with the number or the word:
1. **enable** — fix the cause, then re-run and I will use "{{EXPECTED}}":
   • **API budget exhausted** (most common): your premium/API usage is spent, so Cursor marks "{{EXPECTED}}" unavailable and drops to Composer. Turn on usage-based / on-demand spend, or upgrade your plan, in Cursor → Settings (Billing) — or wait for the budget to reset. Then reply `enable`.
   • **Model disabled**: "{{EXPECTED}}" is toggled off in your model list. Open Cursor Settings (Cmd/Ctrl+Shift+J) → Models and enable it (or click "Add Model" if it isn't listed). Then reply `enable`.
2. **fallback** — proceed now on "{{FALLBACK}}" (available immediately; it may be a same-tier alternate or the Composer floor depending on what Cursor offers).
Asked once per build; if you do not answer, I proceed on "{{FALLBACK}}" so the team is never blocked.
<!-- T1BLOCK:END model-unavailable-choice -->

<!-- T1BLOCK:BEGIN model-choice-enable-required -->
Model tier gate (level={{LEVEL}}, host={{HOST}}): the user chose **enable/retry**, so do NOT proceed on a fallback for `{{ROLE}}`. {{PASSED_NOTE}} Stop the fallback spawn, enable or re-capture "{{EXPECTED}}" in Cursor Settings → Models, then re-run the model capture/model-gate step and spawn with the recommended model. Do not advertise fallback alternates again for this build unless the user explicitly replies `fallback`.
<!-- T1BLOCK:END model-choice-enable-required -->

<!-- T1BLOCK:BEGIN model-availability-advisory -->
Traffic One — heads up before the team spawns: this build will pass these Cursor models to its subagents: {{MODELS}}. Cursor may SILENTLY fall back from a passed model (usually to Composer) with NO error and NO signal a plugin can read when one of these applies:
  • **API budget exhausted** (most common): once your premium/API usage is spent, Cursor makes the premium models unavailable and runs subagents on Composer instead. Restore it via Cursor → Settings (Billing) — enable usage-based / on-demand spend, or upgrade, or wait for the reset.
  • **Model disabled / not on plan**: enable it in Cursor Settings (Cmd/Ctrl+Shift+J) → Models (or "Add Model" if it isn't listed).
If a role ends up running on Composer despite the pin above, it is almost always the budget case — top it up to run the team on the intended models.
<!-- T1BLOCK:END model-availability-advisory -->

<!-- T1BLOCK:BEGIN model-availability-banner -->
traffic-one — team models: {{MODELS}}. If a role runs on Composer instead, your Cursor premium/API budget is likely exhausted → enable usage-based spend / upgrade / wait for reset (Cursor → Settings → Billing) to run on the pinned models.
<!-- T1BLOCK:END model-availability-banner -->

<!-- T1BLOCK:BEGIN model-choice-recorded-enable -->
Recorded: you'll use the recommended model. Enable it now in Cursor Settings → Models (Cmd/Ctrl+Shift+J → Models; click "Add Model" if it isn't listed), then re-run your request — the team will spawn on the recommended model and I won't ask again this build.
<!-- T1BLOCK:END model-choice-recorded-enable -->

<!-- T1BLOCK:BEGIN model-choice-recorded-fallback -->
Recorded: the team will use the next-eligible fallback model when the recommended one isn't available, for the rest of this build. Re-run your request to continue — I won't ask again this build.
<!-- T1BLOCK:END model-choice-recorded-fallback -->

<!-- T1BLOCK:BEGIN opencode-role-delegate -->
OpenCode role gate: `{{ROLE}}` is configured to run on OpenCode (it is in `openCode.delegateRoles` and `openCode.enabled` is true), so do NOT spawn it as a paid subagent yet. The user enabled this delegation in the Traffic One setup wizard. First hand its work to the locally-installed OpenCode CLI via the bundled `opencode-worker` MCP tool:
1. Call the `opencode_delegate` tool (MCP server `opencode-worker`) with:
   - `role`: `{{ROLE}}`
   - `runId`: `{{RUN_ID}}`
   - `projectRoot`: `{{PROJECT_ROOT}}`  (absolute path — the directory holding `.traffic-one`)
   - `task`: ONE bounded unit for this role — 1–2 named files with concrete acceptance criteria. NEVER the entire role implementation: free models deliver a bounded unit in ~2 minutes but produce nothing useful from a whole-role dump (measured live: zero output after minutes of serialized waiting). If the architect's plan queued units for this role, run the Step-0 `opencode_delegate_from_plan` batch instead — completing it marks every queued role as attempted and satisfies this gate.
   Do NOT pass `model` — OpenCode selects its own free model automatically (no account/API key needed).
2. **If the result has `running:true`** → the run is proceeding in the background; call `opencode_delegate` AGAIN with the SAME arguments to keep waiting. Repeat until you get a terminal `ok`. (This is how a multi-minute run survives the host's ~120s tool-call timeout — do NOT treat `running:true` as a failure and do NOT fall back yet.) Your polls are the keep-alive: a run you stop polling for ~6 minutes is cancelled automatically (the worker is killed BEFORE any diff applies), so if you decide to move on to the paid fallback, simply stop polling — no stale diff can land later.
3. On `ok:true` (delegated) → the change is applied to the tree and a digest is written; proceed to review (`senior-reviewer` verifies the diff). Do NOT spawn the paid `{{ROLE}}`.
4. On `ok:false` (skipped/failed/no-changes) → OpenCode declined or could not run. Re-spawn `{{ROLE}}` exactly as usual; this gate denies each role at most once per run, so the fallback spawn goes through.
5. **If the host's safety reviewer rejects the `opencode_delegate` call** (e.g. Codex: "rejected due to unacceptable risk" because it would send code to an external service) AND the rejection says you may proceed if the user explicitly approves → do NOT silently fall back. Ask the user, in one line, for explicit approval, naming the risk: e.g. *"Codex flagged OpenCode delegation because it sends this bounded task and the relevant code to OpenCode's hosted model. Approve sending it to OpenCode for this run? (Otherwise I'll use the paid worker.)"* If the user explicitly approves, call `opencode_delegate` again with the SAME arguments — the reviewer names this as the sanctioned path, so it is NOT a workaround/circumvention; treat that approval as covering the rest of this run's delegations. If the user declines or does not answer, re-spawn `{{ROLE}}` as the paid fallback.
6. **If the `opencode_delegate` tool is unavailable or its call could not complete** → re-spawn `{{ROLE}}` as the internal fallback; the one-denial guard prevents a loop. On Codex, an unavailable tool usually means the auto-registered MCP server has not been loaded yet — tell the user a ONE-TIME Codex restart enables it.
To stop routing this role through OpenCode, remove it from `openCode.delegateRoles` in local preferences.
<!-- T1BLOCK:END opencode-role-delegate -->

<!-- T1BLOCK:BEGIN agent-reuse-continue -->
Agent-reuse gate: run {{RUN_ID}} already has a LIVE `{{ROLE}}` agent — id `{{AGENT_ID}}`. Do NOT spawn a fresh `{{ROLE}}`: every fresh spawn re-loads the full rules+skills context (~20k tokens before any work) and re-explores the codebase. Continue the SAME agent instead:
1. {{CONTINUE_CALL}} The message carries ONLY what is NEW: the task spec, exact file paths, acceptance criteria, and (for fix cycles) the reviewer/tester findings VERBATIM. The agent keeps everything it already read — rules, skills, plan, digests, prior source — so do not re-paste any of that.
2. Treat the reply exactly like a fresh spawn's final report (same digest + verdict-token contract: it must still end with its terminal token and update its digest under `.traffic-one/digests/<runId>/`).
3. Parallel roles stay parallel: continuations of different roles (e.g. frontend + backend follow-ups) go out together in ONE turn, like parallel spawns.
4. Only if that agent is genuinely unusable — {{CONTINUE_TOOL}} errors ("agent not found"/unavailable), or its replies show context exhaustion — re-spawn `{{ROLE}}` with the literal marker `{{MARKER}}` anywhere in the spawn prompt. The gate then allows ONE replacement spawn (same model-tier rules) and records the new agent id automatically.
<!-- T1BLOCK:END agent-reuse-continue -->
