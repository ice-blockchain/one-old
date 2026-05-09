---
name: senior-eng-orchestrator
description: >
  PROACTIVELY conduct the traffic-one senior-engineer team (`senior-architect`,
  `senior-frontend`, `senior-backend`, `senior-reviewer`, `senior-tester`,
  `senior-shipper`) when the user's request spans multiple layers of a build.
  TRIGGER on "build me", "make me", "create me", "scaffold a", "ship a",
  "create the whole thing", "end to end", "I want an app that", "I need a site
  for", "turn this into a SaaS", "make a habit tracker / dashboard / landing
  page / API / mobile app", or any phrasing that implies producing UI + API +
  DB together. Runs the same workflow on Claude Code, Codex, and Cursor:
  architect to frontend/backend to reviewer/tester to shipper; on Codex,
  MUST ask the user for subagent confirmation before starting matching
  multi-layer builds, then stop and wait for the answer. This happens
  automatically without waiting for the user to request subagents.
  Maintains in-session todos. Reads/writes `.traffic-one/plan.md`,
  `.traffic-one.json`, and the `.traffic-one/` project-memory baseline. Loops on
  `CHANGES_REQUESTED` from reviewer with a 2-cycle cap. Do NOT use for
  single-component / single-skill requests where a direct skill call is more
  appropriate.
---

# Senior Engineering Orchestrator

You are the conductor. The Traffic One workflow is identical across runtimes: same phase order, same parallelism, same verdict tokens, same loop caps, same deploy gate, same final summary. Only the host-specific subagent adapter and consent step change.

## Codex consent gate — blocking

When the host is Codex and this skill triggers, the first action is always a user-facing confirmation question before any implementation work.

Required behavior on Codex:

1. Announce that Traffic One detected a non-trivial multi-layer build.
2. Name the role route: `architect → frontend/backend → reviewer/tester`, plus `shipper` only for explicit deploy intent.
3. Ask whether to run the role subagents.
4. Stop and wait for the user's answer. Do not write `.traffic-one/plan.md`, create files, edit code, run implementation commands, or simulate the roles manually before the answer.
5. If the user confirms, call Codex `spawn_agent` using the role mapping below.
6. If the user declines, or subagents are unavailable/blocked, continue in the same phase order manually and explicitly state that the Traffic One team is being simulated by the main agent.

Recommended prompt, English only:

> Traffic One sees this as a multi-layer build. Do you want me to run the Traffic One subagent team: architect → frontend/backend → reviewer/tester?

Use this wording in English; do not translate this confirmation question based on the user's language.

If work has already started and this gate was missed, pause at the next safe point, acknowledge the missed gate, ask the confirmation question, and wait before continuing.

## Runtime compatibility

- Claude Code: auto-spawn the named Traffic One agents with the `Task` tool when this skill triggers.
- Claude Code agents do not inherit parent skills. Keep every `agents/senior-*.md` frontmatter `skills:` list complete for that role.
- Codex: before starting a non-trivial multi-layer build, announce the Traffic One route and automatically ask the user for subagent confirmation. Do this without waiting for the user to mention subagents. Because Codex requires explicit user intent before calling `spawn_agent`, this confirmation is mandatory and blocking; stop until the user answers. Do not silently simulate the team before asking. If confirmation is granted, spawn available Codex subagents. If confirmation is not granted or subagents are blocked, run the same role prompts manually in dependency order and say that the Traffic One team is being simulated by the main agent.
- Cursor: auto-spawn available Cursor/background-agent/task agents when this skill triggers. If Cursor exposes no callable agent facility, simulate the same roles manually in the same dependency order using the mirrored `00-agent-senior-*.mdc` role contexts.
- Codex role mapping:
  - `senior-architect` → `worker`, owned write scope `.traffic-one/plan.md`, `.traffic-one/` project memory, and docs only.
  - `senior-frontend` → `worker`, owned write scope frontend/UI/i18n files only.
  - `senior-backend` → `worker`, owned write scope backend/API/database files only.
  - `senior-reviewer` → `explorer` or `default`, read-only.
  - `senior-tester` → `worker`, owned write scope test files and test infrastructure only.
  - `senior-shipper` → `worker`, deploy/release only after the shipper gate is satisfied.
- Include the relevant `agents/senior-*.md` role text or a concise equivalent in every Codex/Cursor subagent prompt.
- If subagents are unavailable, blocked, or not confirmed where confirmation is required, continue manually in the same dependency order and state that the Traffic One team is being simulated by the main agent.

## When you fire

Auto-trigger keywords: "build me", "make me", "create me", "scaffold a", "ship a", "end to end", "I want an app", "I need a site for", "turn this into", "habit tracker", "dashboard", "SaaS", "mobile app", "MVP", "landing page that does X".

On Claude Code and Cursor, these triggers mean "run the identical Traffic One workflow with subagents" when the runtime exposes a callable agent facility. On Codex, these triggers mean "announce the role plan and ask for subagent confirmation automatically before starting the role workflow, then wait for the answer before doing any implementation work."

Skip if:
- The request is for a single component, page, or service ("add a logout button"). Route to the matching specialist skill (`create-component`, `create-page`, `create-service`) directly and do not ask for subagents.
- The user asks a research/audit question without intent to ship ("review this design", "what's the right stack here"). Route to a specialist skill or subagent.

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

Cleanup at the end (Phase 5): keep the last 3 run folders under `.traffic-one/digests/`, remove older ones.

### Phase 1 — Architect (sequential, blocking)

Spawn `senior-architect` via the available subagent tool. On Claude Code, use `Task` with `subagent_type: "senior-architect"`. On Codex, after the required confirmation step, use a `worker` subagent with the senior-architect role instructions, owned write scope `.traffic-one/plan.md` plus ADR/docs only. On Cursor, use the closest available background-agent/task adapter with the same role instructions and write scope. Block on its return.

Synthetic prompt body — use the **Phase 1 — Architect** template from `resources/prompt-templates.md`. The template tells the architect to read `.traffic-one.json` + project memory + graph if present, produce `.traffic-one/plan.md`, create/update `.traffic-one/` memory, and write `.traffic-one/digests/<run-id>/architect.md` before emitting `PLAN_READY`.

Architect must end its reply with the literal token `PLAN_READY`. If it doesn't, surface to the user and do not proceed to Phase 2.

### Phase 2 — Implement (parallel)

Single message with TWO subagent calls in the same turn (`senior-frontend` + `senior-backend`). On Codex, use `worker` subagents with disjoint write scopes and tell each worker they are not alone in the codebase.

Synthetic prompts — use the **Phase 2 — Frontend** and **Phase 2 — Backend** templates from `resources/prompt-templates.md`. Each template instructs the implementer to read the architect digest first, then the relevant plan section, then graph nodes, raw files only as last resort. Each writes its own digest (`.traffic-one/digests/<run-id>/{frontend,backend}.md`) before reporting.

Wait for both to return before Phase 3.

### Phase 3 — Verify (parallel)

Single message with TWO subagent calls (`senior-reviewer` + `senior-tester`). On Codex, use a read-only `explorer` or `default` subagent for reviewer, and a `worker` subagent for tester restricted to test files and test infrastructure.

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

### Phase 5 — Cleanup + sanity check (orchestrator only, no subagent)

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
- When subagents are available and permitted, you do NOT write feature source files. You do NOT run deploy commands. You only spawn subagents and summarise. If subagents are unavailable, unconfirmed, or blocked, execute the same phases manually with the role prompts and clearly say so.

## When NOT to use this orchestrator

- Single-component requests: route to `create-component` / `create-native-component` skill.
- Single-page or single-route additions on an existing project: route to `create-page` / `create-native-screen`.
- Single-service or single-endpoint additions: route to `create-service`.
- Read-only audits: route to `design-audit`, `security-review`, `repo-scan`.
- Refactor-only requests: route to `refactor` / `simplify`.
- The user already has a plan and just wants implementation: spawn `senior-frontend` + `senior-backend` directly, skip architect.
