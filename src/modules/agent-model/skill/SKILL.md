---
name: traffic-one-agent-model-gate
description: Wording source for the Traffic One agent-spawn model-tier + team-confirmation gate. Read at runtime via skillBlock(); enforcement lives in TS.
---

# Traffic One Agent-Model Gate

Deny-reason wording for the PreToolUse spawn gate. Enforcement is implemented
by the installed Traffic One runtime; `{{PLACEHOLDER}}` tokens are filled by the
gate.

<!-- T1BLOCK:BEGIN agent-materialization-deny -->
Traffic One agent spawn gate: state was repaired/materialized before this agent spawn.
The role agent has been denied once so frontend/backend workers cannot start against stale `.traffic-one/.one.json`, rules, skills, or root agent context.
rerun the same agent spawn now; the canonical `.traffic-one/.one.json` and project-local materialization are current.
<!-- T1BLOCK:END agent-materialization-deny -->

<!-- T1BLOCK:BEGIN agent-materialization-missing -->
Traffic One agent spawn gate: project-local rules/skills are not materialized yet.
Do not spawn frontend/backend/reviewer/tester workers until `.traffic-one/.one.json` has current `materializedStack`, `materializedAt`, and `materializedVersion`, and `.traffic-one/manifest.json`, `.traffic-one/rules/**`, `.traffic-one/skills/**`, root `AGENTS.md`, and root `CLAUDE.md` exist.
Run `node -e "const p=require('node:path'),e=process.env,r=p.resolve(e.TRAFFIC_ONE_PLUGIN_ROOT||e.CURSOR_PLUGIN_ROOT||e.CODEX_PLUGIN_ROOT||e.CLAUDE_PLUGIN_ROOT||process.cwd());process.argv.splice(1,0,'traffic-one-runtime');require(p.join(r,'scripts','hook-runtime.cjs'))" materialize-project` from the project root, then retry the agent spawn.
<!-- T1BLOCK:END agent-materialization-missing -->

<!-- T1BLOCK:BEGIN performance-main-agent -->
Performance gate: local Traffic One preferences record performance.level="{{LEVEL}}" (main-agent only), but you are spawning the `{{ROLE}}` subagent. If the user chose Balanced or High, first correct local preferences (`performance.level` plus matching `team.mode="subagents"`) so the right model tier applies, then re-spawn with the runtime-resolved `model` when the host supports it. On Codex, also use the canonical underscore-form `task_name` and `fork_turns: "none"`. If the user really chose Low, do NOT spawn subagents — run the roles in this thread as the role roadmap checklist.
<!-- T1BLOCK:END performance-main-agent -->

<!-- T1BLOCK:BEGIN team-confirmation -->
Team gate: spawning subagents needs `team.approved: true`, which the Traffic One setup wizard sets AUTOMATICALLY from the performance choice (performance.level="{{LEVEL}}" ⇒ subagents). Local preferences currently have `team.approved !== true`, which means the wizard's performance/team step was not completed for this project — not that the user must approve a line-up in chat. Do NOT pop a chat "approve the team?" prompt and do NOT hand-edit preferences to set the flag. Re-open the Traffic One setup wizard and finish the performance/team step (it writes `team.approved: true` and shows the role→model line-up), then re-spawn with the per-role `model` on Claude, Cursor, or Codex. On Codex, also use the canonical underscore-form `task_name` and `fork_turns: "none"`. If the user wants Low/main-agent mode instead, they re-pick performance in the wizard; never bypass this gate for `team.mode="subagents"`.
<!-- T1BLOCK:END team-confirmation -->

<!-- T1BLOCK:BEGIN spawn-role-conflict -->
Traffic One spawn identity gate: this spawn carries conflicting valid Traffic One role evidence in the same highest-priority tier: {{CANDIDATES}}. The spawn was blocked before a child started. Do not retry it unchanged and do not guess which role won. Correct or remove the stale identity field or marker so every valid item in that tier agrees on exactly one canonical role, then retry the same task. On Codex, keep one exact canonical task_name and ensure higher-tier agent_path/agent_type metadata, when present, names the same role.
<!-- T1BLOCK:END spawn-role-conflict -->

<!-- T1BLOCK:BEGIN performance-model-param -->
ACTION: re-issue this spawn with `model: "{{EXPECTED}}"`. Nothing crashed — the host renders a declined spawn as an agent failure, but this is the Traffic One Performance gate (level={{LEVEL}}, host={{HOST}}) holding `{{ROLE}}` to the run's frozen model. {{PASSED_NOTE}}The model is set ONLY by this parameter — a model name in prompt text or a model-agnostic project agent contract has no effect. On Cursor, use the exact role→model value printed by model-gate; without the parameter the subagent inherits the parent model.{{ALTERNATES}} The runtime lineup comes from the active host snapshot in local Traffic One settings.
For Codex, also use the canonical underscore-form `task_name` and `fork_turns: "none"`; the child hook verifies the actual model exactly against the immutable run policy.
<!-- T1BLOCK:END performance-model-param -->

<!-- T1BLOCK:BEGIN cursor-exact-model-required -->
Cursor model gate (level={{LEVEL}}): spawning `{{ROLE}}` passed `model: "{{PASSED}}"`, which matches the right Traffic One tier family but is not an exact Cursor Task model id from the fresh captured list. Cursor can create a visible "New subagent / Couldn't start" card when Task receives an uncaptured model guess, so do NOT attempt the spawn with this value. Re-issue the same Task spawn with `model: "{{EXPECTED}}"` (or another exact captured id from the same tier). An exact captured id may equal its family anchor; membership in the captured list is authoritative. Captured ids for this build: {{CAPTURED}}.
<!-- T1BLOCK:END cursor-exact-model-required -->

<!-- T1BLOCK:BEGIN opencode-named-agent-required -->
{{HOST}} agent gate: `{{ROLE}}` must be spawned with the project-scoped global {{HOST}} subagent `{{EXPECTED_AGENT}}`, not `{{AGENT_TYPE}}`.

Traffic One materialized `{{AGENT_PATH}}`. {{MODEL_NOTE}}

Re-issue the same `task` spawn with the project-scoped global subagent name `{{EXPECTED_AGENT}}` and keep `[t1-role: {{ROLE}}]` as the FIRST line of the prompt. Do NOT pass `model` unless this exact host build documents a Task `model` field. If `{{EXPECTED_AGENT}}` is not offered after materialization, stop and tell the user to restart {{HOST}} so the global agent at `{{AGENT_PATH}}` is loaded; do not fall back to `general` and do not build the role inline.
<!-- T1BLOCK:END opencode-named-agent-required -->

<!-- T1BLOCK:BEGIN kilo-general-agent-required -->
Kilo agent gate: `{{ROLE}}` must use Kilo's built-in writable Task subagent type `general`, not `{{AGENT_TYPE}}`.

Traffic One materialized `{{AGENT_PATH}}` as the full role contract. This Kilo Task API exposes the built-in `general`/`explore` types, while `.kilo/agents/*.md` files are role-contract files rather than registered Task type names.

Re-issue the same `task` spawn with `subagent_type: "general"`. Keep `[t1-role: {{ROLE}}]` as the FIRST line, immediately tell the child to read `{{AGENT_PATH}}` before acting, and omit `model` so it inherits the user's active Kilo model. Do NOT use `explore`, and do NOT fall back to main-agent mode: `general` is the supported Kilo subagent path for this role.
<!-- T1BLOCK:END kilo-general-agent-required -->

<!-- T1BLOCK:BEGIN cursor-agent-type-required -->
Cursor agent gate: `{{ROLE}}` was spawned with subagent_type `{{AGENT_TYPE}}`, which is neither the role's own Cursor agent nor the supported built-in fallback.

Re-issue the same `Task` spawn with `subagent_type: "{{EXPECTED_AGENT}}"` — Traffic One materialized that role contract at `{{AGENT_PATH}}`.

If Cursor REJECTS that value (invalid enum / unknown subagent type), the agent files were written after this session captured its type list. That is NOT a broken spawn tool and NOT a reason to build the role inline: retry once with `subagent_type: "{{FALLBACK_AGENT}}"`, keep `[t1-role: {{ROLE}}]` as the FIRST line of the prompt, and immediately tell the child to read `{{AGENT_PATH}}` before acting. The role marker is what binds the child to its role and its frozen per-role model.

Keep the exact per-role `model` from the spawn map either way. Never send a Traffic One role to a generic worker WITHOUT the role marker, and never simulate the role in the parent thread.
<!-- T1BLOCK:END cursor-agent-type-required -->

<!-- T1BLOCK:BEGIN absolute-traffic-one-path -->
Spawn prompt path gate: the prompt references `.traffic-one` run/digest/fix-cycle paths outside this project root (`{{PROJECT_ROOT}}`): {{BAD_PATHS}}. Re-issue the same spawn using project-relative paths such as `.traffic-one/digests/<runId>/frontend.md` and `.traffic-one/fix-cycles/<runId>/senior-frontend-fix-1.md` (digest files use the short role name; fix-cycle files keep the full `senior-` prefix); do not paste absolute paths from another folder or a corrupted root.
<!-- T1BLOCK:END absolute-traffic-one-path -->

<!-- T1BLOCK:BEGIN cursor-models-capture -->
Cursor model-capture gate (required before the first team spawn, run {{RUN_ID}}). The spawn is blocked until Traffic One freezes the exact model ids offered by this Cursor build.
Missing captured tiers for this run: {{MISSING_TIERS}}.
Do this once before retrying:
1. List the model ids your `Task` tool offers for spawning subagents (the same list Cursor shows when you pick a subagent model).
2. Run `{{CAPTURE_CMD}}`, replacing the placeholders with those EXACT ids verbatim (e.g. `claude-fable-5-thinking-high`, `gpt-5.6-terra-medium`, `composer-2.5-fast`, or `gpt-5.4-mini`). A valid picker id may or may not include a reasoning suffix; never invent one. Include at least one id per tier the team needs — highest + balanced + cheapest. This internal command writes only your local per-user/project Cursor preferences; do not create `.traffic-one/cursor-models.json`.
3. Re-run model-gate, then retry the spawn with the exact role→model value it prints. Project `.cursor/agents` contracts remain model-agnostic.
Do not retry with an uncaptured family guess and do not build the project inline because of this gate.
<!-- T1BLOCK:END cursor-models-capture -->

<!-- T1BLOCK:BEGIN model-unavailable-choice -->
Model availability gate (level={{LEVEL}}, host={{HOST}}): Cursor's fresh captured model list does not offer the recommended model **{{EXPECTED}}** for `{{ROLE}}`. Do not silently switch models.

**enable** — Open Cursor Settings → Models, enable **{{EXPECTED}}**, then reply **enable**; I’ll retry on the recommended model.

**fallback** — Proceed now on **{{FALLBACK}}**.

Do not proceed until the user replies **enable** or **fallback**. The fallback is the next exact captured slug in this role's original tier; reaching the Composer floor for a highest/balanced role still requires this explicit choice.
<!-- T1BLOCK:END model-unavailable-choice -->

<!-- T1BLOCK:BEGIN cursor-api-limit-auto-retry -->
Traffic One correlated `{{ROLE}}`'s Cursor child transcript to an API/usage-limit failure on **{{FAILED}}**. The failed agent is retired. Retry the same role now, without asking the user, on `model: "{{NEXT}}"` — the next exact captured slug from this role's original tier. Never announce or attempt a fallback named only by Cursor error prose. The next model is authoritative only when Traffic One supplies its exact slug. Issue the prescribed Task without a pre-tool model announcement, and do not say the replacement is running until a real `subagentStart` proves it.
<!-- T1BLOCK:END cursor-api-limit-auto-retry -->

<!-- T1BLOCK:BEGIN cursor-api-limit-composer-choice -->
Traffic One correlated `{{ROLE}}`'s Cursor child transcript to an API/usage-limit failure. The next eligible model in this highest/balanced role's original tier is the Composer floor, so pause once for the user's choice:

**enable** — Restore API budget for **{{RECOMMENDED}}**, then reply **enable**; I’ll retry on the recommended model.

**fallback** — Proceed now on **{{FALLBACK}}**.

Do not start Composer until the user replies **fallback**. A cheapest-tier role treats Composer as its normal tier model and rotates automatically to its next candidate instead of showing this downgrade choice.
<!-- T1BLOCK:END cursor-api-limit-composer-choice -->

<!-- T1BLOCK:BEGIN cursor-model-unavailable-runtime-choice -->
Traffic One correlated `{{ROLE}}`'s Cursor child transcript to an explicit model-unavailable failure for **{{FAILED}}**. This Settings prompt is valid only when the error text explicitly ties a model to “not enabled”, “disabled”, “unavailable”, “invalid”, “unsupported”, “unknown”, or “not found”.

**enable** — Open Cursor Settings → Models, enable **{{FAILED}}**, then reply **enable**; I’ll retry on the recommended model.

**fallback** — Proceed now on **{{FALLBACK}}**.

Do not proceed until the user replies **enable** or **fallback**. The fallback is the next exact captured slug from this role's original tier.
<!-- T1BLOCK:END cursor-model-unavailable-runtime-choice -->

<!-- T1BLOCK:BEGIN cursor-model-failure-generic -->
Traffic One correlated `{{ROLE}}`'s Cursor child transcript to a non-API failure on **{{FAILED}}**. Use generic recovery and preserve the actual error; do not tell the user to enable a model. Authentication, network, user abort/cancel, context exhaustion, and generic API errors are not evidence that a model is disabled.
<!-- T1BLOCK:END cursor-model-failure-generic -->

<!-- T1BLOCK:BEGIN cursor-api-limit-terminal -->
Traffic One model rotation is terminal for `{{ROLE}}` in this run: every eligible model that was actually started from the role's original tier reached an API/usage limit ({{TRIED}}). Stop retrying this role. The terminal marker remains after individual limit entries expire and clears only when the user replies **enable** or a new run starts; a model absent from Cursor's captured list never counts as API-limited.
<!-- T1BLOCK:END cursor-api-limit-terminal -->

<!-- T1BLOCK:BEGIN model-choice-enable-required -->
Model tier gate (level={{LEVEL}}, host={{HOST}}): the user chose **enable/retry**, so do NOT proceed on a fallback for `{{ROLE}}`. {{PASSED_NOTE}} Finish the selected remedy — restore API budget after an API-limit result, or enable/re-capture "{{EXPECTED}}" in Cursor Settings → Models after an availability result — then re-run the model-gate step and spawn with the recommended model. Do not advertise fallback alternates again for this build unless the user explicitly replies `fallback`.
<!-- T1BLOCK:END model-choice-enable-required -->

<!-- T1BLOCK:BEGIN model-availability-advisory -->
Traffic One — this build will pass these exact Cursor models to its subagents: {{MODELS}}. A correlated API/usage-limit failure rotates automatically through the role's original tier; restore API budget to retry the recommended model, and a highest/balanced drop to the Composer floor requires an explicit **enable**/**fallback** choice. An explicit model-not-enabled/unavailable error offers Cursor Settings → Models or the next tier candidate. Authentication, network, abort/cancel, context exhaustion, and other generic failures use generic recovery and are never presented as a disabled model.
<!-- T1BLOCK:END model-availability-advisory -->

<!-- T1BLOCK:BEGIN model-availability-banner -->
traffic-one — team models: {{MODELS}}. Correlated API limits rotate within each role's original tier; restore API budget for the recommended model, and Composer-floor downgrades require your explicit choice.
<!-- T1BLOCK:END model-availability-banner -->

<!-- T1BLOCK:BEGIN model-choice-recorded-enable -->
Recorded: you'll retry on the recommended model. Traffic One cleared this run's API-limit ledger and pending model decisions. Re-run your request after completing the remedy you selected — restored API budget or Cursor Settings → Models — and the team will use the recommended model.
<!-- T1BLOCK:END model-choice-recorded-enable -->

<!-- T1BLOCK:BEGIN model-choice-recorded-fallback -->
Recorded: the team will use the next-eligible fallback model when the recommended one isn't available, for the rest of this build. Re-run your request to continue — I won't ask again this build.
<!-- T1BLOCK:END model-choice-recorded-fallback -->

<!-- T1BLOCK:BEGIN architect-phase-incomplete -->
Architect phase gate: `{{ROLE}}` cannot start yet — spawn `senior-architect` for run `{{RUN_ID}}` FIRST, in your next message. Do NOT retry `{{ROLE}}` unchanged and do NOT run the OpenCode Step-0 plan batch instead; neither clears this gate.

Missing on disk: {{MISSING}}

The architect must finish the project-memory baseline, semantic `.traffic-one/runs/{{RUN_ID}}/architecture-input-v1.json`, and `.traffic-one/digests/{{RUN_ID}}/architect.md` containing `PLAN_READY`. Runtime then compiles architecture/verification, generates assignments, and publishes work-unit bootstraps. Only after that succeeds may you retry `{{ROLE}}` with the same task. Do not spawn other implementers or patch runtime-owned coordination artifacts yourself.
<!-- T1BLOCK:END architect-phase-incomplete -->

<!-- T1BLOCK:BEGIN opencode-plan-batch-required -->
OpenCode plan-batch gate: do NOT spawn `{{ROLE}}` yet. The architect queued Step-0 OpenCode work in `.traffic-one/plan.md`, and the `opencode_delegate_from_plan` batch has not finished for queued role(s): {{QUEUED_ROLES}}.

Do NOT retry Task/spawn_agent for any queued or capability-eligible implementer in this turn — run OpenCode Step 0 first instead.

Run the batch FIRST, before any capability-eligible implementer starts:
1. Call the `opencode_delegate_from_plan` tool (MCP server `opencode-worker`) with:
   - `runId`: `{{RUN_ID}}`
   - `projectRoot`: `{{PROJECT_ROOT}}`
   Do NOT pass `model` unless the project explicitly pinned one; OpenCode selects its own free model by default.
2. If it returns `running:true`, the batch worker keeps ITSELF alive in the background — your calls are not its keep-alive. Do useful work now (read digests, prepare the next phase), then collect the terminal `{ total, delegated, units }` in ONE bounded long wait: `opencode_status` with `{ runId, waitMs: 90000 }` (re-calling `opencode_delegate_from_plan` with the SAME arguments also waits). Do NOT use any shell fallback while `running:true`; to abandon the batch, call `opencode_status` with `{ runId, cancel: true }` — never just go silent.
3. Only after the terminal result, spawn exactly the implementation roles present in the compiled capability profile and assignments manifest in the NEXT assistant message. Run multiple eligible roles in parallel; never invent a missing frontend/backend sibling. Pass each implementer the batch `units` summary, including `touched` files and any unit whose `action !== "delegated"` so the paid role finishes only what OpenCode skipped/failed/no-changed.
4. Fail-open: if the batch returns a terminal failure (`ok:false`, `action: "abandoned"`, or every unit failed/skipped/no-changes) OR the MCP tool is unavailable, proceed with paid implementer spawns — do NOT block the build on OpenCode.
Fallback (MCP unavailable ONLY — never while `running:true`): `node ~/.traffic-one/bin/opencode-runner.cjs --run-id "{{RUN_ID}}" --from-plan` from `{{PROJECT_ROOT}}`.

Do not work around this by spawning backend first, building inline, or using a whole-role `opencode_delegate` task. The Step-0 plan batch is what prevents serialized paid subagents and satisfies the OpenCode-first contract.
<!-- T1BLOCK:END opencode-plan-batch-required -->

<!-- T1BLOCK:BEGIN opencode-role-delegate -->
OpenCode role gate: `{{ROLE}}` is configured to run on OpenCode (it is in `openCode.delegateRoles` and `openCode.enabled` is true), so do NOT spawn it as a paid subagent yet. The user enabled this delegation in the Traffic One setup wizard. First hand its work to the locally-installed OpenCode CLI via the bundled `opencode-worker` MCP tool:
1. Call the `opencode_delegate` tool (MCP server `opencode-worker`) with:
   - `role`: `{{ROLE}}`
   - `runId`: `{{RUN_ID}}`
   - `projectRoot`: `{{PROJECT_ROOT}}`  (absolute path — the directory holding `.traffic-one`)
   - `allowedFiles`: the exact comma-separated repo-relative files/areas this bounded unit may touch. Any diff outside this allowlist is rejected before apply.
   - `task`: ONE bounded unit for this role — 1–2 named files with concrete acceptance criteria. NEVER the entire role implementation: free models deliver a bounded unit in ~2 minutes but produce nothing useful from a whole-role dump (measured live: zero output after minutes of serialized waiting). If the architect's plan queued units for this role, run the Step-0 `opencode_delegate_from_plan` batch instead — completing it marks every queued role as attempted and satisfies this gate.
   Do NOT pass `model` — OpenCode selects its own free model automatically (no account/API key needed).
2. **If the result has `running:true`** → the run is proceeding in the background and the worker keeps ITSELF alive; your calls are NOT its keep-alive. Do NOT treat `running:true` as a failure and do NOT fall back yet. Instead of re-polling in a tight loop, do useful work (transcribe digests, prepare fix-cycle context, update the ledger), then collect the terminal result in ONE bounded long wait: `opencode_status` with `{ runId, role, waitMs: 90000 }` — it blocks safely under the host's ~120s tool-call ceiling and returns the moment the run finishes (re-calling `opencode_delegate` with the SAME arguments also waits a bounded window). **To move on to the paid fallback, cancel EXPLICITLY**: `opencode_status` with `{ runId, role, cancel: true }` kills the worker before any FURTHER diff applies (a cancel refused with `applying:true` means a clean diff is landing right now — call status once more without cancel and take that result; after any cancel, check the role digest and `git status` before the paid fallback in case an earlier unit already landed). Never abandon by silence: an unwatched run keeps working and its clean diff still lands. **A real unit legitimately takes MINUTES** (measured: ~8 minutes for a 6-file feature unit on a free model), so `running:true` after one long wait is normal progress, not a hang.
3. On `ok:true` (delegated) → the change is applied to the tree and a digest is written; proceed to review (`senior-reviewer` verifies the diff). Do NOT spawn the paid `{{ROLE}}`.
4. On `ok:false` (skipped/failed/no-changes) → OpenCode declined or could not run. Re-spawn `{{ROLE}}` exactly as usual; this gate denies each role at most once per run, so the fallback spawn goes through.
5. **If the host's safety reviewer rejects the `opencode_delegate` call** (e.g. Codex: "rejected due to unacceptable risk" because it would send code to an external service) AND the rejection says you may proceed if the user explicitly approves → do NOT silently fall back. Ask the user, in one line, for explicit approval, naming the risk: e.g. *"Codex flagged OpenCode delegation because it sends this bounded task and the relevant code to OpenCode's hosted model. Approve sending it to OpenCode for this run? (Otherwise I'll use the paid worker.)"* If the user explicitly approves, call `opencode_delegate` again with the SAME arguments — the reviewer names this as the sanctioned path, so it is NOT a workaround/circumvention; treat that approval as covering the rest of this run's delegations. If the user declines or does not answer, re-spawn `{{ROLE}}` as the paid fallback.
6. **If the `opencode_delegate` tool is unavailable or its call could not complete** → re-spawn `{{ROLE}}` as the internal fallback; the one-denial guard prevents a loop. On Codex, an unavailable tool usually means the auto-registered MCP server has not been loaded yet — tell the user a ONE-TIME Codex restart enables it.
To stop routing this role through OpenCode, remove it from `openCode.delegateRoles` in local preferences.
<!-- T1BLOCK:END opencode-role-delegate -->

<!-- T1BLOCK:BEGIN agent-reuse-continue -->
Agent-reuse gate: run {{RUN_ID}} already has a LIVE `{{ROLE}}` agent — id `{{AGENT_ID}}`. Do NOT spawn a fresh `{{ROLE}}`: every fresh spawn re-loads the full rules+skills context (~20k tokens before any work) and re-explores the codebase. Continue the SAME agent instead:
1. {{CONTINUE_CALL}} The message carries ONLY what is NEW: the task spec, exact file paths, acceptance criteria, and (for fix cycles) the reviewer/tester findings VERBATIM. The agent keeps everything it already read — rules, skills, plan, digests, prior source — so do not re-paste any of that. On Cursor, `{{AGENT_ID}}` is the Task `resume` UUID from the spawn result (`Agent ID: …`), never the `tool_*` subagentStart id.
2. Treat the reply exactly like a fresh spawn's final report (same digest + verdict-token contract: it must still end with its terminal token and update its digest under `.traffic-one/digests/<runId>/`).
3. Parallel roles stay parallel: continuations of different roles (e.g. frontend + backend follow-ups) go out together in ONE turn, like parallel spawns.
4. Only if that agent is genuinely unusable — {{CONTINUE_TOOL}} errors ("agent not found"/unavailable), or its replies show context exhaustion — re-spawn `{{ROLE}}` with the literal marker `{{MARKER}}` anywhere in the spawn prompt. The gate then allows ONE replacement spawn (same model-tier rules) and records the new agent id automatically.
<!-- T1BLOCK:END agent-reuse-continue -->

<!-- T1BLOCK:BEGIN agent-reuse-await-cursor-id -->
Agent-reuse gate: run {{RUN_ID}} already has a LIVE `{{ROLE}}` Cursor subagent, but Cursor has not exposed a valid Task `resume` UUID for it yet. The recorded `tool_*` id is only the subagentStart tool-call id and cannot resume the agent. Do NOT spawn a replacement and do NOT use `[t1-replace-agent]` unless the existing agent has actually failed or exhausted context. Wait for the current `{{ROLE}}` subagent to finish or produce a child transcript, then retry the same continuation; Traffic One will upgrade the registry to the real Cursor conversation id automatically.
<!-- T1BLOCK:END agent-reuse-await-cursor-id -->

<!-- T1BLOCK:BEGIN agent-reuse-await-codex-meta -->
Agent-reuse gate: run {{RUN_ID}} has a fresh Codex `{{ROLE}}` registry row for child `{{AGENT_ID}}`, but Traffic One cannot verify that child's role from line-zero `session_meta` ({{REASON}}). Do not route `followup_task`/`send_message` to this unverified id and do not start a duplicate. Retry after the child rollout is flushed. If the child is genuinely unusable, use `{{MARKER}}` with the concrete failure reason to retire it and spawn a replacement using the exact task-name contract (`quick_fix`, `senior_architect`, `senior_frontend`, `senior_backend`, `senior_reviewer`, `senior_tester`, or `senior_shipper`). Current Codex child rollouts encrypt spawn-message content, so prompt prose cannot substitute for `task_name` plus line-zero `session_meta` identity.
<!-- T1BLOCK:END agent-reuse-await-codex-meta -->
