---
name: senior-eng-orchestrator
description: "PROACTIVELY orchestrate the Traffic One senior-engineer team for multi-layer builds spanning UI, API, database, mobile, tests, or deployment. Trigger on build/make/create/scaffold/ship/end-to-end app/site/SaaS/dashboard requests or any UI+API+DB request. Before implementation, require the Performance level (Balanced/High/Low) and wait for the answer; skip single-component or single-skill work."
metadata:
  source: everything-claude-code
  source_path: skills/senior-eng-orchestrator/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Senior Engineering Orchestrator

## Traffic One Auth Preflight

Before applying this skill, verify Traffic One auth unless the user is explicitly
asking to authenticate, check auth status, log out, or run doctor.

If status is not authenticated, do not apply this skill yet. Present the auth
choice as a host modal selector when available:
- Authenticate Traffic One
- Continue without Traffic One

If the user chooses Authenticate Traffic One, ask for the API key and run the
authentication command internally with `TRAFFIC_ONE_AUTH_KEY`; then verify status
internally. Do not ask the user to run bash or shell commands. If the user chooses
Continue without Traffic One, continue the user's request without Traffic One
features and do not repeat the auth prompt while that choice remains active.
Stop and wait for the choice or API key as appropriate. Do not ask Traffic One
onboarding questions, write `.traffic-one.json`, create `.traffic-one/`, run
Traffic One agents, or use Traffic One reporting unless the user authenticates.

You are the conductor. The Traffic One workflow is identical across runtimes: same phase order, same parallelism, same verdict tokens, same loop caps, same deploy gate, same final summary. Only the host-specific subagent adapter and consent step change.

## Current-thread onboarding and consent gate — blocking

When this skill triggers for a new project, the first action is always to run the required Traffic One onboarding sequence in the current thread before any implementation work. Ask Performance / Agent Mode first. For High/Balanced ask Team Confirmation next, then show the Traffic One setup-success message, collect a rich dynamic MVP project context, ask Mobile App, and finally ask Code Graph. Explicit web/mobile/stack/no-subagents wording is implementation preference, not an onboarding answer.

Required behavior on Codex:

1. Do not print numbered options in chat when `request_user_input` is available. Call the popup tool and stop. Plain text fallback is allowed only when the popup tool is unavailable, and the fallback must say that first, ask the same blocking question directly in chat with numbered options, tell the user to reply with the option number or label, and stop. Do not choose a default, infer an answer, write `.traffic-one.json`, scaffold, or continue while the onboarding answer is pending.
2. If this is a new project, complete onboarding in the current thread before implementation. If no popup/input tool is exposed, ask fallback chat questions and stop for typed answers. Do not write `.traffic-one.json`, `.traffic-one/plan.md`, create files, edit code, run commands, or simulate roles until onboarding choices are resolved.
3. Current-thread fallback is a visible first-response requirement. If `request_user_input` cannot be called, do not run `detect-project`, Read/LS/Glob/Grep, Bash, `npm view`, scaffolds, or edits. The next assistant message must ask the Performance / Agent Mode question (`1. High (Recommended)`, `2. Balanced`, `3. Low`), tell the user to reply with the option number or label, and stop. Resume with only the next unresolved prompt.
4. After Agent Mode and any Team Confirmation are resolved, say "Traffic One was successfully set up. Let's collect the project details next.", ask one rich dynamic MVP-context questionnaire tailored to the original request, and persist `projectContext`.
5. Ask the mobile decision with Codex `request_user_input` even if the first prompt already named web, mobile, iOS, Android, Ionic, Capacitor, React Native, Expo, RN, Next.js, frontend-only, no backend, no subagents, or "just build it": header `Mobile App`, question `Do you want a mobile app too?`, options `Web only (Recommended)`, `Ionic + Capacitor`, and `React Native / Expo`. Stop and wait for the popup answer before continuing.
6. Ask the required codebase graph provider with Codex `request_user_input`: header `Code Graph`, question `Which provider should we use for the codebase graph?`, options `GitNexus` and `graphify`. Stop and wait for the popup answer before continuing. This is required before `.traffic-one.json`; no default and no skip.
7. Announce that Traffic One detected a non-trivial multi-layer build.
8. Name the role route: `architect → frontend/backend → reviewer/tester`, plus `shipper` only for explicit deploy intent.
9. Ask the **Performance level** using the host's popup/input mechanism:
     - Codex       : `request_user_input` popup (header `"Performance"`)
     - Claude Code : `AskUserQuestion` tool
     - Cursor      : task-UI prompt
     - All fallback: plain chat with the three numbered options below; stop for typed reply.
10. Stop and wait for the user's answer. Do not write `.traffic-one/plan.md`, create files, edit code, run implementation commands, or simulate roles before the answer.
11. Persist the answer in `.traffic-one.json` (hold the performance answer in working memory; for High/Balanced, Team Confirmation confirms the team first — do not write `team.approved: true` until the user clicks Approve):
     - "High"     → `performance: { level: "high",     source: "prompted" }`, `team: { mode: "subagents", source: "prompted" }`
     - "Balanced" → `performance: { level: "balanced", source: "prompted" }`, `team: { mode: "subagents", source: "prompted" }`
     - "Low"      → `performance: { level: "low",      source: "prompted" }`, `team: { mode: "main-agent", source: "prompted" }`
12. For **High** or **Balanced**: ask Team Confirmation before spawning. List role → tier → model and ask Approve / Re-pick performance / Customise. The PreToolUse spawn gate denies every Task/spawn_agent call until `.traffic-one.json` contains `team: { ..., approved: true }`, so auto-approving is forbidden — wait for the user's explicit Approve, then persist `team.approved: true` (plus any `team.overrides` collected). Then spawn phases using the host adapter (Codex `spawn_agent`, Claude Code `Task`, Cursor task adapter). On EACH spawn, pass the `model` tool PARAMETER resolved from the role's capability tier to your host (see the Runtime compatibility tier→model table). The model is set by the parameter, not by prompt text — omitting it makes the subagent inherit the parent model.
13. For **Low** or when subagents are unavailable/blocked: run the same phases manually as a role roadmap checklist in this thread and explicitly state the Traffic One team is being simulated by the main agent.

Do not satisfy Traffic One team execution with generic explorer/helper agents. A High/Balanced Traffic One run means the named senior-role workflow below: spawn `senior-architect`, wait for `PLAN_READY`, then spawn `senior-frontend` and `senior-backend`, wait for both to return before Phase 3, then spawn the reviewer/tester roles.

Performance popup question, English only:

> How do you want to run agents for this build?
> 1. High (Recommended) — Subagent team with max-power models
> 2. Balanced — Subagent team with efficient mid-tier models
> 3. Low — Main agent only with role roadmap checklist

If the popup tool is unavailable on any host, ask this in plain text with the three numbered options and stop for the user's typed reply.

If work has already started and this gate was missed, pause at the next safe point, acknowledge the missed gate, ask the performance question, and wait before continuing.

## Runtime compatibility

- **Per-agent model is set by the spawn tool's `model` PARAMETER — never by prompt text.** The `agents/senior-*.md` files declare no `model:` frontmatter, so a subagent spawned without a `model` param silently inherits the parent model. For Balanced/High you MUST pass the model param on every spawn. Each role is assigned a host-agnostic capability TIER (`highest`|`balanced`|`cheapest`, see `model-tiers.cjs`); resolve the tier to YOUR host's model:
  - Balanced → architect/frontend/backend/reviewer/shipper = `balanced` tier, tester = `cheapest` tier.
  - High → architect/frontend/backend/reviewer = `highest` tier, tester = `cheapest` tier, shipper = `balanced` tier.
  - Tier → model: `highest` = claude:`opus` / codex:`gpt-5-codex` / cursor:`opus`; `balanced` = claude:`sonnet` / codex:`gpt-5` / cursor:`sonnet`; `cheapest` = claude:`haiku` / codex:`gpt-5-mini` / cursor:`haiku`.
- **Claude Code**: auto-spawn with the `Task`/Agent tool and pass `model: "<alias>"` (`opus`|`sonnet`|`haiku`) on EACH spawn per the tier mapping above. The alias auto-tracks the newest model of that family.
- Claude Code agents do not inherit parent skills. Keep every `agents/senior-*.md` frontmatter `skills:` list complete for that role.
- **Codex**: complete new-project onboarding in the current thread before implementation. Before starting a non-trivial multi-layer build, ask the Performance popup automatically (no waiting for the user to mention subagents). If Balanced or High is chosen, ask Team Confirmation next and wait for explicit approval before spawning. Then call Codex `spawn_agent` and pass `model:` set to the codex column for each role's tier. If Low is chosen or subagents are blocked, simulate manually.
- **Cursor**: auto-spawn available Cursor/background-agent/task agents when this skill triggers. Include the per-role model directive in each agent prompt header. If Cursor exposes no callable agent facility, simulate the same roles manually in the same dependency order using the mirrored `00-agent-senior-*.mdc` role contexts.
- Codex role mapping:
  - `senior-architect` → `worker`, owned write scope `.traffic-one/plan.md`, `.traffic-one/` project memory, and docs only.
  - `senior-frontend` → `worker`, owned write scope frontend/UI/i18n files only.
  - `senior-backend` → `worker`, owned write scope backend/API/database files only.
  - `senior-reviewer` → `explorer` or `default`, read-only.
  - `senior-tester` → `worker`, owned write scope test files and test infrastructure only.
  - `senior-shipper` → `worker`, deploy/release only after the shipper gate is satisfied.
- Include the relevant `agents/senior-*.md` role text or a concise equivalent in every Codex/Cursor subagent prompt.
- If subagents are unavailable or blocked, or the user picks Low: continue manually in the same dependency order and state that the Traffic One team is being simulated by the main agent.

## When you fire

Auto-trigger keywords: "build me", "make me", "create me", "scaffold a", "ship a", "end to end", "I want an app", "I need a site for", "turn this into", "habit tracker", "dashboard", "SaaS", "mobile app", "MVP", "landing page that does X".

On all hosts (Claude Code, Codex, Cursor), these triggers mean "ask the Performance popup automatically, ask Team Confirmation for Balanced/High, then run the Traffic One workflow at the approved level." On Codex, both questions are mandatory and blocking — wait for the answers before any implementation work. On Claude Code and Cursor, follow the host popup/approval path before writing final `.traffic-one.json` and spawning.

Skip if:
- The request is for a single component, page, or service ("add a logout button"). Route to the matching specialist skill (`create-component`, `create-page`, `create-service`) directly and do not ask for subagents.
- The user asks a research/audit question without intent to ship ("review this design", "what's the right stack here"). Route to a specialist skill or subagent.

## Agentic quality lane

- Give every role explicit acceptance criteria and at least one regression check
  before implementation starts.
- Split work into independently verifiable units with one dominant risk and one
  clear owner. If a unit spans too many surfaces, narrow it before assigning it.
- Route deeper reasoning to architecture, security, root-cause debugging, data
  integrity, auth boundaries, and cross-file invariants. Routine transforms,
  docs updates, and mechanical fixes should stay on normal effort.
- Reviewer and tester prompts must inspect AI-generated code for hidden coupling,
  stale state, async races, edge cases, data/auth assumptions, and rollout risk
  before style preferences.
- Completion means the user-visible capability and the regression guard both
  pass, or the blocker is reported with the exact unverified risk.
- Frontend completion criteria always include the automatic baselines when
  applicable, regardless of whether the user mentioned them: existing/new i18n
  integration with same-change catalog entries and `<Trans>` for rich copy,
  SEO metadata/tests for every created or changed public route, and
  `https://traffic.io/` setup CTA href regression for touched missing-config
  surfaces.

## Phases (run in order)

### Phase 0 — Detect + run-id

Read `.traffic-one.json`, `.traffic-one/product.md`, `.traffic-one/stack.md`,
`.traffic-one/rules/*.md`, `.traffic-one/known-issues.md`, and
`.traffic-one/plan.md` when they exist.

- If `.traffic-one.json` is missing or `mode` / `stack` is unset → invoke the `stack-setup` skill first. The user must commit to a stack before architect can plan.
- If `.traffic-one/plan.md` exists and is fresh (matches the current request scope) → skip Phase 1.

**Generate a run-id** (UTC, second precision, filesystem-safe):

```bash
RUN_ID=$(node -e "console.log(new Date().toISOString().replace(/[:.]/g,'-').replace(/-\d{3}Z$/,'Z'))")
mkdir -p ".traffic-one/digests/$RUN_ID"
```

Expected shape: `2026-05-07T14-23-05Z`. Pass this run-id verbatim to every subagent in the synthetic prompt. The full per-phase prompt templates live in `resources/prompt-templates.md`; reference them rather than inlining their full text in this skill body.

Cleanup at the end (Phase 5): keep the last 3 run folders under `.traffic-one/digests/`, remove older ones. (Note: the SessionStart hook also sweeps to the last 5 automatically.)

### Subagent token-economy: write `currentRunId` + `activeAgentRole` before each spawn

Before EACH subagent spawn, update `.traffic-one.json` with two fields the SessionStart hook reads to emit a slim, role-scoped rule bundle (~5KB instead of ~117KB). This saves roughly 28K tokens per subagent SessionStart:

```jsonc
{
  // ...existing fields...
  "currentRunId": "<the RUN_ID computed above>",
  "activeAgentRole": "senior-architect"   // or senior-frontend / -backend / -reviewer / -tester / -shipper
}
```

Write order:

1. After computing `RUN_ID`, write `currentRunId` once.
2. Before each `Task` (Claude Code) / `spawn_agent` (Codex) / Cursor task call, overwrite `activeAgentRole` with the role you're about to spawn.
3. After the orchestrator run finishes (Phase 5), clear both fields (or leave them — the hook ignores them after 30 minutes).

For parallel spawns (frontend + backend in Phase 2), write the field for the FIRST role just before that Task call. The second role gets the slim bundle on the next SessionStart even if the field doesn't match — the safety fallback emits a slim-but-unscoped bundle when `currentRunId` is set but `activeAgentRole` is stale, still saving ~115KB vs the full parent bundle.

### Fix-cycle re-spawn (CHANGES_REQUESTED loop)

When `senior-reviewer` returns `CHANGES_REQUESTED` and you loop back to `senior-frontend` / `senior-backend` to apply fixes, **do not run the full role flow again**. The role already has a prior digest and active rules; running the full flow re-explores the codebase and burns ~30M tokens per fix-cycle (real measured cost).

Instead, follow this protocol for each fix-cycle re-spawn:

1. **Write the fix-cycle context file** with exact reviewer findings. Use the reviewer's `CHANGES_REQUESTED <numbered list>` verbatim — paste `file:line` references and concrete suggested changes; do not paraphrase. Save to:

   ```
   .traffic-one/fix-cycles/<currentRunId>/<role>-fix-<n>.md
   ```

   where `<n>` is the fix-cycle number (1 for the first fix, 2 for the second, etc.).

2. **Bump `spawnIndex[role]`** in `.traffic-one.json` before the re-spawn:

   ```jsonc
   {
     "currentRunId": "<unchanged>",
     "activeAgentRole": "senior-frontend",
     "spawnIndex": { "senior-frontend": 2 }   // was 1, now 2 for fix-1
   }
   ```

   The SessionStart hook reads `spawnIndex[role] > 1` and emits an ultra-slim ~500-byte bundle that points to the fix-cycle file + the role's prior digest, with explicit instructions not to re-explore.

3. **Spawn the subagent with a tight task description**:

   > "You are continuing as `<role>` in run `<currentRunId>`, fix cycle #N. Read your prior digest at `.traffic-one/digests/<runId>/<role-name>.md` to recall your previous work, then apply ONLY the exact fixes listed in `.traffic-one/fix-cycles/<runId>/<role>-fix-<n>.md`. Do not re-read source files except those the fix-cycle context names. Re-emit your digest when done. End with `FIXES_APPLIED` (or `FIXES_FAILING <numbered list>` on partial failure)."

4. **After the fix-cycle subagent returns**, loop back to `senior-reviewer` (which also gets a fresh spawn with its own `spawnIndex[senior-reviewer]++` to leverage the same fix-cycle saving on re-reviews).

The 2-cycle reviewer cap (architect / orchestrator level) still applies — if the second fix cycle also gets `CHANGES_REQUESTED`, stop and surface the unresolved findings to the user.

### Phase 1 — Architect (sequential, blocking)

Spawn `senior-architect` via the available subagent tool. Architect tier = `balanced` for Balanced, `highest` for High — resolve to your host's model (claude `sonnet`/`opus`, codex `gpt-5`/`gpt-5-codex`). On Claude Code, use `Task` with `subagent_type: "senior-architect"` AND the `model` param. On Codex, after the required confirmation step, use a `worker` subagent with the senior-architect role instructions, the `model` param, owned write scope `.traffic-one/plan.md` plus ADR/docs only. On Cursor, use the closest available background-agent/task adapter with the same role instructions, model, and write scope. Block on its return.

Synthetic prompt body — use the **Phase 1 — Architect** template from `resources/prompt-templates.md`. The template tells the architect to read `.traffic-one.json` + project memory + graph if present, produce `.traffic-one/plan.md`, create/update `.traffic-one/` memory, and write `.traffic-one/digests/<run-id>/architect.md` before emitting `PLAN_READY`.

Architect must end its reply with the literal token `PLAN_READY`. If it doesn't, surface to the user and do not proceed to Phase 2.

### Phase 2 — Implement (parallel)

Single message with TWO subagent calls in the same turn (`senior-frontend` + `senior-backend`). Both use the implementation tier: `balanced` for Balanced, `highest` for High — pass the `model` param resolved to your host (claude `sonnet`/`opus`, codex `gpt-5`/`gpt-5-codex`). On Codex, use `worker` subagents with disjoint write scopes and tell each worker they are not alone in the codebase.

Synthetic prompts — use the **Phase 2 — Frontend** and **Phase 2 — Backend** templates from `resources/prompt-templates.md`. Each template instructs the implementer to read the architect digest first, then the relevant plan section, then graph nodes, raw files only as last resort. Each writes its own digest (`.traffic-one/digests/<run-id>/{frontend,backend}.md`) before reporting.

Wait for both to return before Phase 3.

### Phase 3 — Verify (parallel)

Single message with TWO subagent calls (`senior-reviewer` + `senior-tester`). Pass the `model` param on both: reviewer follows the level (`balanced` tier for Balanced, `highest` tier for High); tester is always the `cheapest` tier (claude `haiku`, codex `gpt-5-mini`) in both levels. On Codex, use a read-only `explorer` or `default` subagent for reviewer, and a `worker` subagent for tester restricted to test files and test infrastructure.

Synthetic prompts — use the **Phase 3 — Reviewer** and **Phase 3 — Tester** templates from `resources/prompt-templates.md`. Both templates instruct the verifier to read the implementer digests first (`.traffic-one/digests/<run-id>/{frontend,backend}.md`), then scoped `git diff` *only for files those digests flagged*, then graph neighbors, full file Reads only as last resort. Reviewer writes `reviewer.md` digest via Bash heredoc (no Write tool); tester writes `tester.md` directly.

If reviewer returns `CHANGES_REQUESTED` → Phase 3a (loop, max 2 cycles).
If tester returns `TESTS_FAILING` → Phase 3b (loop, max 2 cycles).
If both green → proceed.

### Phase 3a — Reviewer fix loop (capped at 2 cycles)

Re-spawn the relevant implementer (`senior-frontend` or `senior-backend` based on which file paths the reviewer flagged) with the numbered fix list. After their reply, re-spawn `senior-reviewer`.

After 2 cycles, escalate to the user with both diffs and the latest review.

### Phase 3b — Tester fix loop (capped at 2 cycles)

Re-spawn the relevant implementer with the failing-test list. After their reply, re-spawn `senior-tester`.

After 2 cycles, escalate to the user.

### Phase 4 — Ship (only on explicit intent)

Spawn `senior-shipper` ONLY if the user prompt matches `/\b(ship|deploy|release|publish|to prod|to production|to staging|app store|play store)\b/i`.

Synthetic prompt — use the **Phase 4 — Shipper** template from `resources/prompt-templates.md`. The template tells the shipper to read `.traffic-one/digests/<run-id>/{reviewer,tester}.md` first (verifying APPROVED + TESTS_GREEN), then plan § Risks/Cut-list. Shipper runs `predeploy-security-check` with `--strict --stamp`, handles the `lastSecurityCheck*` and `lastShipperApprovalAt` stamps, performs the platform-specific deploy, then writes `shipper.md` digest.

If no deploy intent in the user message → end with a "next step: say 'ship it' to deploy" line, do NOT spawn shipper.

### Phase 5 — Cleanup + sanity check + codebase-graph bootstrap (orchestrator only, no subagent)

**Sanity check first.** Before rotating, verify the expected digests landed
for this run. Each phase that ran must have produced its digest; a missing
digest means a subagent skipped its handoff write and downstream phases lost
the token-savings benefit.

```bash
RUN_DIR=".traffic-one/digests/${RUN_ID}"
expected=("architect.md" "frontend.md" "backend.md")
[ "$REVIEWED" = "true" ] && expected+=("reviewer.md")
[ "$TESTED"   = "true" ] && expected+=("tester.md")
[ "$SHIPPED"  = "true" ] && expected+=("shipper.md")
missing=()
for f in "${expected[@]}"; do
  [ -f "$RUN_DIR/$f" ] || missing+=("$f")
done
```

If `missing` is non-empty, surface a one-line warning in the run summary:

```
⚠ Digest sanity: <comma-separated missing files> not produced this run.
  Re-spawn the relevant subagent or instruct it to write the digest before
  emitting its terminal status token.
```

This catches the most common regression: a subagent emits its verdict (e.g.
`TESTS_GREEN`) but forgets to write `tester.md`, so the next run's reviewer /
shipper can't read the predecessor digest and falls back to re-reading the
diff.

**Then bootstrap the codebase-graph provider** so the cross-run cache lands
even when this orchestrator run never invoked a build command. Every
completed orchestrator session is a strong "the project is in a meaningful
state, index it now" signal — don't rely on the post-build hook to fire,
because most orchestrator runs end at `APPROVED` / `TESTS_GREEN` without
the user typing `pnpm build`.

Dispatch on `codeGraphProvider` from `.traffic-one.json`:

```bash
PROVIDER=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('.traffic-one.json','utf8')).codeGraphProvider||'')}catch{}")
case "$PROVIDER" in
  gitnexus)
    node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/gitnexus-runner.cjs"
    ;;
  graphify)
    node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/graphify-runner.cjs"
    ;;
  *)
    # Provider missing/unknown — the postWriteIncompleteWarning hook will
    # nag the user on the next state write. Skip silently here.
    ;;
esac
```

Same cooldown / freshness logic as the post-build hook applies for either
provider (each runner checks its own `*LastRunAt` field and is a no-op when
the artefact is fresh). Opt out per-project with `"codeGraphAutoRun": false`
(provider-agnostic; legacy `"graphifyAutoRun": false` honoured for one
version). This step never blocks the run summary — the runner returns a
structured result and the orchestrator notes the outcome in one line of the
summary, including the PolyForm Noncommercial license reminder when the
provider is gitnexus.

**Then rotate.** Keep the last 3 run folders under `.traffic-one/digests/`,
remove older ones:

```bash
ls -t .traffic-one/digests | tail -n +4 | xargs -I{} rm -rf ".traffic-one/digests/{}"
```

The whole `.traffic-one/digests/` tree is gitignored.

## In-session bookkeeping

- Maintain the host's todo/plan list across the phases. Each phase is one item; subagent runs are sub-items.
- Keep the canonical plan in `.traffic-one/plan.md`. Do NOT duplicate it into the todo/plan list.
- Log each subagent's verdict (`PLAN_READY`, `APPROVED` / `CHANGES_REQUESTED`, `TESTS_GREEN` / `TESTS_FAILING`, deploy URL) in a single summary at the end.

## Handoff back to user

After Phase 3 (or Phase 4 if shipped), reply with:

```
Senior Engineering Orchestrator — summary

Plan:        .traffic-one/plan.md
Memory:      .traffic-one/product.md · .traffic-one/stack.md · .traffic-one/agent-log.md
Architect:   PLAN_READY
Frontend:    <one-line status>
Backend:     <one-line status>
Reviewer:    APPROVED
Tester:      TESTS_GREEN — <count> tests, <coverage>%
Shipper:     <URL or "not run; say 'ship it' to deploy">

Next steps:
- <bullet>
- <bullet>
```

## Hard rules

- The architect runs first on any new project (`mode === "new-project"`) or whenever `.traffic-one/plan.md` is missing.
- On Claude Code, Codex, and Cursor, do not silently skip the Traffic One team for matching end-to-end tasks. Auto-spawn the role agents when the runtime exposes an agent adapter and the host permits it. On Codex, always ask for explicit subagent confirmation first for matching multi-layer builds and stop until the user answers; never write plans/files/code or simulate before asking. If confirmation is declined or subagents are unavailable, simulate the same phases manually and state why.
- Frontend ∥ backend in parallel — single message, two subagent calls.
- Reviewer ∥ tester in parallel — single message, two subagent calls.
- Shipper only on explicit deploy intent in the user's most recent message.
- Cycle cap = 2 for both reviewer and tester loops; after that, escalate.
- The plan-gate hook (`runCheckArchitectureWrite`) will deny feature writes if `.traffic-one/plan.md` is missing — even if you skipped Phase 1, the implementers will fail fast. Do not try to bypass.
- The deploy-gate hook (`runCheckLibraryAllowlist`) will deny `vercel deploy`, `eas submit`, `supabase db push --linked`, `gh release create`, etc. without both a fresh `lastShipperApprovalAt` stamp and a fresh passing `lastSecurityCheck*` stamp whose fingerprint matches the current worktree. Only `senior-shipper` writes the shipper stamp; `predeploy-security-check` writes the security stamp.
- When subagents are available and permitted (Balanced or High), you do NOT write feature source files. You do NOT run deploy commands. You only spawn subagents and summarise. If subagents are unavailable, blocked, or the user chose Low, execute the same phases manually with the role roadmap checklist and clearly say so.

## When NOT to use this orchestrator

- Single-component requests: route to `create-component` / `create-native-component` skill.
- Single-page or single-route additions on an existing project: route to `create-page` / `create-native-screen`.
- Single-service or single-endpoint additions: route to `create-service`.
- Read-only audits: route to `design-audit`, `security-review`, `repo-scan`.
- Refactor-only requests: route to `refactor` / `simplify`.
- The user already has a plan and just wants implementation: spawn `senior-frontend` + `senior-backend` directly, skip architect.

<!-- GENERATED BY traffic-one: project-local active rules -->
