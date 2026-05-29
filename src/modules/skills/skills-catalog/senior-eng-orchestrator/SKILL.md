---
name: senior-eng-orchestrator
description: "PROACTIVELY orchestrate the Traffic One senior-engineer team for multi-layer builds spanning UI, API, database, mobile, tests, or deployment. Trigger on build/make/create/scaffold/ship/end-to-end app/site/SaaS/dashboard requests or any UI+API+DB request. Before implementation, require missing local preferences in order (OpenCode, Performance, Team for Balanced/High, Code Graph) and wait for each answer; skip single-component or single-skill work."
metadata:
  source: everything-claude-code
  source_path: skills/senior-eng-orchestrator/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Senior Engineering Orchestrator

You are the conductor. The Traffic One workflow is identical across runtimes: same phase order, same parallelism, same verdict tokens, same loop caps, same deploy gate, same final summary. Only the host-specific subagent adapter and consent step change.

## Before you orchestrate — the setup gate is blocking

Do not spawn, scaffold, or edit until the Traffic One setup gate is clear for the
resolved target root. Follow `rules/common/setup-gate.md` (when work is blocked
plus the preference order) and `rules/common/onboarding.md` (how to ask each
prompt and write `.traffic-one/.one.json`). If a local preference is missing, ask
only the next unresolved prompt and stop. Explicit web/mobile/stack/"no
subagents" wording is an implementation preference, not an onboarding answer.

Two resolved preferences drive orchestration:

- **Performance level** sets the team mode: `high`/`balanced` → `team.mode:
  "subagents"` (spawn the named role agents); `low` → `team.mode: "main-agent"`
  (run the phases manually in this thread as a role roadmap).
- **Team Confirmation** (only for `high`/`balanced`): the PreToolUse spawn gate
  denies every subagent-spawn call until local preferences contain
  `team.approved: true`. Auto-approving is forbidden — wait for the user's
  explicit Approve, then spawn.

Do not satisfy a subagents run with generic explorer/helper agents — a
Balanced/High run means the named senior-role workflow below: `senior-architect`
→ (`senior-frontend` ∥ `senior-backend`) → (`senior-reviewer` ∥ `senior-tester`),
plus `senior-shipper` only on explicit deploy intent. If the gate was missed and
work already started, pause at the next safe point, resolve it, then continue.

## Runtime compatibility

- **Per-agent model is set by the spawn tool's `model` PARAMETER — never by prompt text.** The `agents/senior-*.md` files declare no `model:` frontmatter, so a subagent spawned without a `model` param silently inherits the parent model. For Balanced/High you MUST pass the model param on every spawn. Each role is assigned a host-agnostic capability TIER (`highest`|`balanced`|`cheapest`, see `model-tiers.cjs`); resolve the tier to YOUR host's model:
  - Balanced → architect/frontend/backend/reviewer/shipper = `balanced` tier, tester = `cheapest` tier.
  - High → architect/frontend/backend/reviewer = `highest` tier, tester = `cheapest` tier, shipper = `balanced` tier.
  - Tier → model: resolve each tier (`highest`|`balanced`|`cheapest`) to your host's concrete model via the tier→model table in `model-tiers.cjs`; the Team Confirmation line-up renders the resolved per-host models.
- **Spawn**: auto-spawn each role with your host's subagent tool when this skill triggers, passing the `model` parameter resolved to that role's tier on EVERY spawn (a model name in prompt text has no effect). Where the host uses model aliases, the alias auto-tracks the newest model of that family.
- Subagents do not inherit the parent's skills. Keep every `agents/senior-*.md` frontmatter `skills:` list complete for that role.
- If the host requires the setup gate cleared or explicit user consent before spawning, do that first (see "Before you orchestrate" above; `rules/common/setup-gate.md` + `rules/common/onboarding.md`). If the host exposes no callable agent facility, Low is chosen, or subagents are blocked, simulate the same roles manually in the same dependency order using the mirrored `00-agent-senior-*` role contexts.
- Role → write-scope mapping (use a writer-capable agent for implementers, scoped to its owned area; a read-only agent for the reviewer):
  - `senior-architect` — owned write scope `.traffic-one/plan.md`, `.traffic-one/` project memory, and docs only.
  - `senior-frontend` — owned write scope frontend/UI/i18n files only.
  - `senior-backend` — owned write scope backend/API/database files only.
  - `senior-reviewer` — read-only.
  - `senior-tester` — owned write scope test files and test infrastructure only.
  - `senior-shipper` — deploy/release only after the shipper gate is satisfied.
- Include the relevant `agents/senior-*.md` role text or a concise equivalent in every subagent prompt.
- If subagents are unavailable or blocked, or the user picks Low: continue manually in the same dependency order and state that the Traffic One team is being simulated by the main agent.

## When you fire

Auto-trigger keywords: "build me", "make me", "create me", "scaffold a", "ship a", "end to end", "I want an app", "I need a site for", "turn this into", "habit tracker", "dashboard", "SaaS", "mobile app", "MVP", "landing page that does X".

On all hosts these triggers mean: clear the setup gate (per `rules/common/setup-gate.md` + `rules/common/onboarding.md`), then run the Traffic One workflow at the approved performance level. The onboarding prompts are blocking — do not implement, write final `.traffic-one/.one.json`, or spawn while an answer is pending.

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

Read `.traffic-one/.one.json`, `.traffic-one/product.md`, `.traffic-one/stack.md`,
`.traffic-one/rules/*.md`, `.traffic-one/known-issues.md`, and
`.traffic-one/plan.md` when they exist.

- If `.traffic-one/.one.json` is missing or `mode` / `stack` is unset → complete onboarding (`rules/common/onboarding.md`) first. The user must commit to a stack before architect can plan.
- If `.traffic-one/plan.md` exists and is fresh (matches the current request scope) → skip Phase 1.

**Generate a run-id** (Unix epoch milliseconds, filesystem-safe):

```bash
RUN_ID=$(node -e "console.log(Date.now().toString())")
mkdir -p ".traffic-one/digests/$RUN_ID"
```

Expected shape: a 13-digit epoch-millisecond string such as `1715091785000`. Pass this run-id verbatim to every subagent in the synthetic prompt. The full per-phase prompt templates live in `resources/prompt-templates.md`; reference them rather than inlining their full text in this skill body.

Cleanup at the end (Phase 5): keep the last 3 run folders under `.traffic-one/digests/`, remove older ones. (Note: the SessionStart hook also sweeps to the last 5 automatically.)

### Subagent token-economy: per-agent run claims

After computing `RUN_ID`, persist only the active run pointer in `.traffic-one/.one.json`:

```jsonc
{
  // ...existing fields...
  "currentRunId": "<the RUN_ID computed above>"
}
```

Do **not** write `activeAgentRole` for new runs. It is a legacy fallback only.
The spawn preflight hook creates a pending per-agent claim for each valid role
spawn at:

```text
.traffic-one/runs/<runId>/pending/<claimId>.json
```

When the spawned worker session starts, the SessionStart hook claims that file
to the real child session id:

```text
.traffic-one/runs/<runId>/<agentSessionId>.json
```

That claimed file is the source of truth for role-scoped rule bundles and
feature-source write permission. Parallel frontend/backend spawns no longer
race through a shared `activeAgentRole`; each worker gets its own role claim.

If a host bypasses the spawn preflight hook, create the pending claim manually
before spawning with at least `runId`, `claimId`, `role`, `spawnIndex`,
`status: "pending"`, `parentSessionId`, `createdAt`, and `stackFingerprint`.
After the orchestrator run finishes (Phase 5), clear `currentRunId` or leave it;
the hook ignores stale runs after 30 minutes.

### Fix-cycle re-spawn (CHANGES_REQUESTED loop)

When `senior-reviewer` returns `CHANGES_REQUESTED` and you loop back to `senior-frontend` / `senior-backend` to apply fixes, **do not run the full role flow again**. The role already has a prior digest and active rules; running the full flow re-explores the codebase and burns ~30M tokens per fix-cycle (real measured cost).

Instead, follow this protocol for each fix-cycle re-spawn:

1. **Write the fix-cycle context file** with exact reviewer findings. Use the reviewer's `CHANGES_REQUESTED <numbered list>` verbatim — paste `file:line` references and concrete suggested changes; do not paraphrase. Save to:

   ```
   .traffic-one/fix-cycles/<currentRunId>/<role>-fix-<n>.md
   ```

   where `<n>` is the fix-cycle number (1 for the first fix, 2 for the second, etc.).

2. **Bump `spawnIndex[role]`** in `.traffic-one/.one.json` before the re-spawn:

   ```jsonc
   {
     "currentRunId": "<unchanged>",
     "spawnIndex": { "senior-frontend": 2 }   // was 1, now 2 for fix-1
   }
   ```

   The SessionStart hook reads `spawnIndex[role] > 1` and emits an ultra-slim ~500-byte bundle that points to the fix-cycle file + the role's prior digest, with explicit instructions not to re-explore.

3. **Spawn the subagent with a tight task description**:

   > "You are continuing as `<role>` in run `<currentRunId>`, fix cycle #N. Read your prior digest at `.traffic-one/digests/<runId>/<role-name>.md` to recall your previous work, then apply ONLY the exact fixes listed in `.traffic-one/fix-cycles/<runId>/<role>-fix-<n>.md`. Do not re-read source files except those the fix-cycle context names. Re-emit your digest when done. End with `FIXES_APPLIED` (or `FIXES_FAILING <numbered list>` on partial failure)."

4. **After the fix-cycle subagent returns**, loop back to `senior-reviewer` (which also gets a fresh spawn with its own `spawnIndex[senior-reviewer]++` to leverage the same fix-cycle saving on re-reviews).

The 2-cycle reviewer cap (architect / orchestrator level) still applies — if the second fix cycle also gets `CHANGES_REQUESTED`, stop and surface the unresolved findings to the user.

### Phase 1 — Architect (sequential, blocking)

Spawn `senior-architect` via your host's subagent tool with the `model` param set. Architect tier = `balanced` for Balanced, `highest` for High — resolve to your host's model. After any required confirmation step, give the subagent the senior-architect role instructions and owned write scope `.traffic-one/plan.md` plus ADR/docs only. Block on its return.

Synthetic prompt body — use the **Phase 1 — Architect** template from `resources/prompt-templates.md`. The template tells the architect to read `.traffic-one/.one.json` + project memory + graph if present, produce `.traffic-one/plan.md`, create/update `.traffic-one/` memory, and write `.traffic-one/digests/<run-id>/architect.md` before emitting `PLAN_READY`.

Architect must end its reply with the literal token `PLAN_READY`. If it doesn't, surface to the user and do not proceed to Phase 2.

### Phase 2 — Implement (parallel)

Single message with TWO subagent calls in the same turn (`senior-frontend` + `senior-backend`). Both use the implementation tier: `balanced` for Balanced, `highest` for High — pass the `model` param resolved to your host. Give the implementers disjoint write scopes and tell each they are not alone in the codebase.

Synthetic prompts — use the **Phase 2 — Frontend** and **Phase 2 — Backend** templates from `resources/prompt-templates.md`. Each template instructs the implementer to read the architect digest first, then the relevant plan section, then graph nodes, raw files only as last resort. Each writes its own digest (`.traffic-one/digests/<run-id>/{frontend,backend}.md`) before reporting.

Wait for both to return before Phase 3.

### Phase 3 — Verify (parallel)

Single message with TWO subagent calls (`senior-reviewer` + `senior-tester`). Pass the `model` param on both: reviewer follows the level (`balanced` tier for Balanced, `highest` tier for High); tester is always the `cheapest` tier in both levels. Use a read-only agent for the reviewer, and a writer-capable agent for the tester restricted to test files and test infrastructure.

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

Dispatch on `codeGraphProvider` from the effective Traffic One state, which merges shared `.traffic-one/.one.json` with the current user's local preferences:

```bash
PROVIDER=$(node -e "try{const root=process.env.TRAFFIC_ONE_PLUGIN_ROOT||process.env.CODEX_PLUGIN_ROOT||process.env.CLAUDE_PLUGIN_ROOT||'.'; const {readEffectiveState}=require(require('path').join(root,'scripts/shared/state/local-prefs.js')); console.log(readEffectiveState(process.cwd()).codeGraphProvider||'')}catch{}")
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
- On every host, do not silently skip the Traffic One team for matching end-to-end tasks. Auto-spawn the role agents when the runtime exposes an agent adapter and the host permits it. Where the host requires explicit user intent before spawning, always ask for subagent confirmation first for matching multi-layer builds and stop until the user answers; never write plans/files/code or simulate before asking. If confirmation is declined or subagents are unavailable, simulate the same phases manually and state why.
- Frontend ∥ backend in parallel — single message, two subagent calls.
- Reviewer ∥ tester in parallel — single message, two subagent calls.
- Shipper only on explicit deploy intent in the user's most recent message.
- Cycle cap = 2 for both reviewer and tester loops; after that, escalate.
- The plan-gate hook (`check-plan-write`) will deny feature writes if `.traffic-one/plan.md` is missing — even if you skipped Phase 1, the implementers will fail fast. Do not try to bypass.
- The deploy-gate hook (`runCheckLibraryAllowlist`) will deny `vercel deploy`, `eas submit`, `supabase db push --linked`, `gh release create`, etc. without both a fresh `lastShipperApprovalAt` stamp and a fresh passing `lastSecurityCheck*` stamp whose fingerprint matches the current worktree. Only `senior-shipper` writes the shipper stamp; `predeploy-security-check` writes the security stamp.
- When subagents are available and permitted (Balanced or High), you do NOT write feature source files. You do NOT run deploy commands. You only spawn subagents and summarise. If subagents are unavailable, blocked, or the user chose Low, execute the same phases manually with the role roadmap checklist and clearly say so.

## When NOT to use this orchestrator

- Single-component requests: route to `create-component` / `create-native-component` skill.
- Single-page or single-route additions on an existing project: route to `create-page` / `create-native-screen`.
- Single-service or single-endpoint additions: route to `create-service`.
- Read-only audits: route to `design-audit`, `security-review`, `repo-scan`.
- Refactor-only requests: route to `refactor` / `simplify`.
- The user already has a plan and just wants implementation: spawn `senior-frontend` + `senior-backend` directly, skip architect.
