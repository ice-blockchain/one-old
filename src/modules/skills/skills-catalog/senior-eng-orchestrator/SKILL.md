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

- **Per-agent model is set by the spawn tool's `model` PARAMETER — never by prompt text.** The `agents/senior-*.md` files declare no `model:` frontmatter, so a subagent spawned without a `model` param silently inherits the parent model. For Balanced/High you MUST pass the model param on every spawn. Each role is assigned a host-agnostic capability TIER (`highest`|`balanced`|`cheapest`, from the plugin's model-tiers config); resolve the tier to YOUR host's model:
  - Balanced → architect/frontend/backend/reviewer/shipper = `balanced` tier, tester = `cheapest` tier.
  - High → architect/frontend/backend/reviewer = `highest` tier, tester = `cheapest` tier, shipper = `balanced` tier.
  - Tier → model: resolve each tier (`highest`|`balanced`|`cheapest`) to your host's concrete model via the plugin's tier→model table; the Team Confirmation line-up renders the resolved per-host models.
- **Spawn**: auto-spawn each role with your host's subagent tool when this skill triggers, passing the `model` parameter resolved to that role's tier on EVERY spawn (a model name in prompt text has no effect). Where the host uses model aliases, the alias auto-tracks the newest model of that family.
- Subagents do not inherit the parent's skills. Keep every `agents/senior-*.md` frontmatter `skills:` list complete for that role.
- If the host requires the setup gate cleared or explicit user consent before spawning, do that first (see "Before you orchestrate" above; `rules/common/setup-gate.md` + `rules/common/onboarding.md`). If the host exposes no callable agent facility, Low is chosen, or subagents are blocked, simulate the same roles manually in the same dependency order using the mirrored `00-agent-senior-*` role contexts.
- Role → write-scope mapping (use a writer-capable agent for implementers, scoped to its owned area; a read-only agent for the reviewer). For implementers the AUTHORITATIVE scope is the role's entry in the per-run assignments manifest `.traffic-one/runs/<runId>/assignments.json` (authored by the architect in Phase 1, enforced by the run-team gate). The lines below are the human summary:
  - `senior-architect` — owned write scope `.traffic-one/plan.md`, `.traffic-one/` project memory, docs, and the per-run `assignments.json` manifest. Writes no feature source.
  - `senior-frontend` — owned write scope = its `assignments.json` entry (UI / routing / i18n / SEO for this project's actual layout).
  - `senior-backend` — owned write scope = its `assignments.json` entry (API / persistence / auth / migrations for this project's actual layout).
  - `senior-reviewer` — read-only.
  - `senior-tester` — owned write scope test files and test infrastructure only.
  - `senior-shipper` — deploy/release only after the shipper gate is satisfied.
  - Lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock*`)
    are install side-effects and ALWAYS in scope for whichever role runs the
    install — say so in every implementer spawn prompt. A role must never
    delete/revert a lockfile to satisfy its scope.
- The assignments manifest is stack-agnostic: the architect derives each scope from the project's REAL directories (Next `src/app`, Laravel `app/Http`+`routes`, Django `*/views.py`, Flutter `lib/`, …), not from hardcoded guesses. The format allows N implementer streams with arbitrary role labels (e.g. a future `senior-mobile`); this version spawns only `senior-frontend` and `senior-backend`.
- Include the relevant `agents/senior-*.md` role text or a concise equivalent in every subagent prompt.
- If subagents are unavailable or blocked, or the user picks Low: continue manually in the same dependency order and state that the Traffic One team is being simulated by the main agent.

## OpenCode delegation (token-saver — driven by the architect's plan queue)

When `openCode.enabled` is true in the effective Traffic One state AND the OpenCode CLI is installed (`scripts/opencode-runner.cjs` present), bounded/low-risk units are delegated to OpenCode INSTEAD of paid subagents — **deterministically, from the plan**, NOT by per-unit improvisation. In a subagents run, work is split by LAYER (one frontend + one backend subagent), so there is no per-unit spawn to redirect; delegation therefore happens in a dedicated batch BEFORE the implementers spawn.

How it works:

1. **The architect classifies + queues (Phase 1).** `senior-architect` emits an OpenCode delegation queue in `.traffic-one/plan.md` — a machine-readable block listing ONLY bounded units:

   ```text
   <!-- opencode-delegate:start -->
   - role: backend | files: src/lib/news-data.ts | task: <self-contained: dummy news articles + categories seed data, pure data, no deps>
   - role: frontend | files: src/components/NewsCard.tsx | task: <self-contained: presentational card, props in, no data fetching>
   <!-- opencode-delegate:end -->
   ```

   ONLY queue boilerplate/CRUD scaffolding, dummy/seed/fixture data, simple test scaffolding, mechanical refactors/renames, formatting/codemods. NEVER queue architecture, public contracts, security/auth, data-model, migrations, or cross-file-invariant work — those stay on the named senior subagents.

2. **The orchestrator runs the batch FIRST in Phase 2** (before spawning implementers), exactly once, by calling the bundled `opencode_delegate_from_plan` MCP tool (server `opencode-worker`) with `{ runId: "$RUN_ID", projectRoot: "<absolute project root>" }`. This is run by the orchestrator (NOT a subagent spawn, NOT subject to the spawn `model` param). The tool runs the locally-installed OpenCode CLI, identically on every host. It reads the queue and delegates EVERY listed unit to OpenCode (each in an isolated worktree; only clean, error-free diffs applied to the tree; a digest written per unit). It returns `{ total, delegated, units: [{ role, task, action, touched }] }`. It never throws and never fails the build. **Resumable:** if a call returns `running:true`, call `opencode_delegate_from_plan` again with the same args until you get the terminal `{ total, delegated, units }`.

   Fallback if the `opencode-worker` tool is unavailable: on Codex this usually means the auto-registered MCP server has not been loaded yet, so tell the user a one-time Codex restart enables it. Otherwise run the same engine via the shell runner:

   ```bash
   node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/opencode-runner.cjs" \
     --run-id "$RUN_ID" --from-plan
   ```

   If the shell runner cannot run (e.g. `.git` is read-only or worktree metadata cannot be written), treat the queued units as not delegated and continue with the internal senior subagents.

3. **Then spawn implementers ONLY for the rest:** the senior units, plus any queued unit whose `action !== "delegated"` (skipped/failed/no-changes → fall back to the paid subagent). Tell each implementer which files OpenCode already produced (`touched`) so it builds ON them, not over them.

4. **`senior-reviewer` MUST verify the delegated diffs** in Phase 3 — they came from a weaker model.

(A single ad-hoc unit can be delegated with the `opencode_delegate` tool — `{ role, task, runId, projectRoot }` — or the runner's `--role <r> --task-file <path>` mode.) OpenCode picks its own free model by default; only non-sensitive bounded units are queued. Pin a specific model per project via `openCode.model` if needed.

**Forced role delegation (enforced by the spawn gate).** Roles listed in `openCode.delegateRoles` (default: `senior-shipper`, `senior-tester`, `senior-frontend`, `quick-fix`) MUST run on OpenCode when `openCode.enabled`, on every host. The PreToolUse spawn gate **denies** a paid spawn of such a role until you have delegated it for this run — call the `opencode_delegate` tool (server `opencode-worker`) with `{ role, runId: "$RUN_ID", projectRoot, task }` (no `model` — OpenCode picks its own free model). If it returns `running:true`, call again with the same args until terminal. On `ok:true` the work is applied (no paid spawn needed); on `ok:false` OpenCode declined or could not run, so spawn the paid subagent as the internal fallback. **If the host's safety reviewer rejects the call and offers a user-approval path** (e.g. Codex: "proceed only if the user explicitly approves"), ask the user once — naming the risk that it sends the task + relevant code to OpenCode's hosted model — and on explicit approval re-call with the same args (the reviewer sanctions this; treat the approval as covering the rest of this run); on decline, use the paid fallback. The gate denies each role at most once per run to prevent deadlocks, so if the tool is unavailable or its call could not complete, the fallback spawn still goes through. (Requires `currentRunId` set — you write it in Phase 0.) The gate's deny message carries the exact tool arguments (including `projectRoot`). Adjust the set by editing `openCode.delegateRoles` in local preferences.

## When you fire

Auto-trigger keywords: "build me", "make me", "create me", "scaffold a", "ship a", "end to end", "I want an app", "I need a site for", "turn this into", "habit tracker", "dashboard", "SaaS", "mobile app", "MVP", "landing page that does X".

On all hosts these triggers mean: clear the setup gate (per `rules/common/setup-gate.md` + `rules/common/onboarding.md`), then run the Traffic One workflow at the approved performance level. The onboarding prompts are blocking — do not implement, write final `.traffic-one/.one.json`, or spawn while an answer is pending.

Skip if:
- The request is for a single component, page, or service ("add a logout button"). Route to the matching specialist skill (`create-component`, `create-page`, `create-service`) directly and do not ask for subagents.
- The user asks a research/audit question without intent to ship ("review this design", "what's the right stack here"). Route to a specialist skill or subagent.

## Maintenance-phase single-feature runs

If the project is already in **maintenance phase** (`lifecycle.phase: "maintenance"` in
`.traffic-one/.one.json` — set for existing codebases from first detection, and for new projects once
the initial build completes), a triggering request is a SINGLE FEATURE on top of a finished app, not a
greenfield build. Scope every phase to that one feature:

- **Architect (Phase 1)** plans ONLY the requested feature — the slice of new/changed files, the
  contracts it touches, and its risks. Do NOT re-plan or re-scaffold the whole app. Reuse the existing
  structure, stack, and conventions; the assignments manifest covers only this feature's files.
- **Decide the surface:** frontend-only, backend-only, or both, based on what the feature actually
  needs — skip a role whose layer the feature never touches (a UI-only tweak spawns no backend).
- **Tiers unchanged:** resolve per-role model tiers exactly as below; OpenCode delegation still applies.
- **Single-shot spec:** pass the user request VERBATIM plus all known constraints, the affected
  surfaces, and acceptance criteria in the architect's ONE spawn prompt. Do not drip-feed context
  across follow-up turns — a fully specified first turn maximizes the architect's autonomy and
  minimizes re-reasoning cost on current Claude models.
- Trivial/small requests should NOT reach this orchestrator — the post-build triage (see the
  `task-triage` skill) routes those to a `quick-fix` worker or a single role. You run only for COMPLEX
  maintenance work (a feature spanning layers, data-model/auth/migration/integration changes).

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

### Agent reuse — ONE live agent per role (continuation-first)

**Each role gets ONE agent for the whole run; every later task for that role goes to the SAME agent.** A fresh same-role spawn re-loads the entire rules+skills context (~20k tokens before any work) and re-explores the codebase — a measured build spent 7 senior-frontend spawns (≈46M tokens) where 1 agent should have served. Context must load once per role (5 roles ⇒ ~5 context loads), not once per task.

Mechanics on hosts with agent continuation (Claude with the agent-teams flag — `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in the session env enables the `SendMessage` tool; Codex equivalently via `send_input` to the agent thread):

1. **First task for a role** → normal spawn (model param per tier). The spawn tool result footer prints the agent id (`agentId: <id> (use SendMessage …)`). The PostToolUse hook records it automatically in `.traffic-one/runs/<runId>/agents.json`.
2. **Every later task for that role** — the next planned part (e.g. frontend: foundation → learner journey → admin area), a fix cycle, a re-review, a re-test — goes to the SAME agent: `SendMessage { to: "<agentId>", message: <task> }`. The PreToolUse gate DENIES a duplicate same-role spawn and names the recorded id, so following this protocol is also the only path the gate allows.
3. **The continuation message carries ONLY what is new**: task spec, exact file paths, acceptance criteria, reviewer/tester findings verbatim. The agent keeps everything it already read (rules, skills, plan, digests, source) — never re-paste those. Treat the reply exactly like a spawn's final report: same digest + terminal-token contract.
4. **Parallel roles stay parallel**: frontend ∥ backend follow-ups are two `SendMessage` calls in ONE message, exactly like parallel spawns.
5. **Big roles split into sequential parts on purpose**: each SendMessage turn gets a fresh tool/turn budget, so "foundation, then admin" runs as message 1, then message 2 to the SAME agent — splitting no longer costs a context reload per part.
6. **Replacement (rare)**: only when SendMessage errors ("agent not found") or the agent's replies show context exhaustion, re-spawn the role with the literal marker `[t1-replace-agent]` in the spawn prompt — the gate allows that one replacement and re-records the new id.
7. **No continuation available** (flag unset, non-teams host): the gate stays inert; fall back to the legacy re-spawn protocol below.

### Fix-cycle follow-up (CHANGES_REQUESTED loop)

When `senior-reviewer` returns `CHANGES_REQUESTED` and you loop back to `senior-frontend` / `senior-backend` to apply fixes, **do not run the full role flow again**. The role already has a prior digest and active rules; running the full flow re-explores the codebase and burns ~30M tokens per fix-cycle (real measured cost).

**Continuation-first:** with a live role agent (see "Agent reuse" above), a fix cycle is ONE SendMessage to that agent — the reviewer findings verbatim (`file:line` + concrete change per item) plus "apply ONLY these fixes, update your digest, end with `FIXES_APPLIED` (or `FIXES_FAILING <numbered list>`)" — plus one caution: "re-read any files OTHER roles changed since your last turn" (the live agent's memory of shared files may be stale). Still write the fix-cycle context file (step 1 below) for the audit trail. Steps 2–3 (spawnIndex bump + re-spawn) apply ONLY when no live agent can be continued:

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

4. **After the fix-cycle reply returns**, loop back to `senior-reviewer` — continuation-first there too: SendMessage to the live reviewer agent with "re-review ONLY the fixes for findings <list>" (fresh re-spawn with `spawnIndex[senior-reviewer]++` only when no live reviewer agent exists).

The 2-cycle reviewer cap (architect / orchestrator level) still applies — if the second fix cycle also gets `CHANGES_REQUESTED`, stop and surface the unresolved findings to the user.

### Phase 1 — Architect (sequential, blocking)

Spawn `senior-architect` via your host's subagent tool with the `model` param set. Architect tier = `balanced` for Balanced, `highest` for High — resolve to your host's model. After any required confirmation step, give the subagent the senior-architect role instructions and owned write scope `.traffic-one/plan.md` plus ADR/docs and the per-run `assignments.json` manifest. Block on its return.

On Codex, spawn the architect with **`fork_context: true`**: the architect benefits
from everything you already read (rules, memory, project shape), and a forked
context skips its ~35-file cold re-read (~300k tokens, measured live). If the
spawn call fails to PARSE (e.g. a duplicated field in your tool-call JSON),
re-issue it WITH `fork_context: true` again — do not silently drop the flag, that
is the whole saving. Implementers/reviewer/tester spawn COLD (no fork): they need
only the plan + their scoped rules, and forking your full context into four
workers would multiply it instead.

Synthetic prompt body — use the **Phase 1 — Architect** template from `resources/prompt-templates.md`. The template tells the architect to read `.traffic-one/.one.json` + project memory + graph if present, produce `.traffic-one/plan.md`, create/update `.traffic-one/` memory, write `.traffic-one/runs/<run-id>/assignments.json` (the machine-readable Module map: one disjoint owned-path scope per implementer role), and write `.traffic-one/digests/<run-id>/architect.md` before emitting `PLAN_READY`. The `assignments.json` partition is what lets Phase 2 run conflict-free on any stack.

Architect must end its reply with the literal token `PLAN_READY`. If it doesn't, surface to the user and do not proceed to Phase 2.

### Phase 2 — Implement (parallel)

**Step 0 — OpenCode delegation batch (when `openCode.enabled`).** BEFORE spawning any implementer, run the plan delegation batch ONCE (see "OpenCode delegation") by calling the `opencode_delegate_from_plan` MCP tool (server `opencode-worker`) with `{ runId: "$RUN_ID", projectRoot: "<absolute project root>" }`. It delegates every bounded unit the architect queued in `.traffic-one/plan.md` to OpenCode and returns `{ total, delegated, units }`; if it returns `running:true`, call again with the same args until terminal. This is the token-saver the user enabled, and it runs identically on every host. Fallback if the tool is unavailable (on Codex, a one-time restart loads the auto-registered server): run the same engine via the shell runner.

```bash
node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/opencode-runner.cjs" --run-id "$RUN_ID" --from-plan
```

If that shell runner cannot run (e.g. `.git` is read-only or worktree metadata cannot be written), continue with the senior subagents for those units.

Then run `senior-frontend` and `senior-backend` **concurrently** — they share the architect's plan/digest for contracts, so neither waits on the other. **Host concurrency mechanic:** on hosts where one assistant message carries multiple tool calls (Claude `Task`), issue both spawns in a single message. On Codex (`spawn_agent`/`wait_agent`), issue the `senior-frontend` and `senior-backend` `spawn_agent` calls **consecutively** and do **NOT** call `wait_agent` until BOTH have returned their `agent_id` — a `wait_agent` after the first spawn blocks the turn and serializes the roles (architect → backend → frontend instead of architect → frontend ∥ backend). Both use the implementation tier: `balanced` for Balanced, `highest` for High — pass the `model` param resolved to your host. Resolve each implementer's owned paths from `.traffic-one/runs/<runId>/assignments.json` (its role entry's `scope.include`/`scope.exclude`) and embed that exact list in its spawn prompt, so each role knows its boundary and that it is not alone in the codebase. If the manifest is absent (architect was skipped), fall back to the legacy role scopes and say so — the run-team gate still prevents collisions via per-path first-write locks, so no role can clobber another's files.

Synthetic prompts — use the **Phase 2 — Frontend** and **Phase 2 — Backend** templates from `resources/prompt-templates.md`. Substitute each role's resolved owned-path list into the template's `<FRONTEND_OWNED_PATHS>` / `<BACKEND_OWNED_PATHS>` placeholder. Each template instructs the implementer to read the architect digest first, then the relevant plan section, then graph nodes, raw files only as last resort. Each writes its own digest (`.traffic-one/digests/<run-id>/{frontend,backend}.md`) before reporting.

Implementers handle ONLY the senior units, plus any queued unit OpenCode did not deliver (Step 0 `units[].action !== "delegated"` → fall back). Pass each implementer the files OpenCode already produced (the batch's `touched`) so it builds on them, not over them. Architecture/contract/security/data work always uses the named subagents — never OpenCode.

Wait for both to return before Phase 3.

### Phase 3 — Verify (parallel)

**Pre-step — refresh the codebase graph** (cheap, parent-side, do not skip): the
implementers just wrote the real code, but the graph index still holds the empty
onboarding scan, so reviewer/tester would navigate a stale near-empty graph.
From the project root run the provider runner per `codeGraphProvider` — WITH
`--force`, because the runner's mtime freshness check cannot tell that a recent
index predates the new code (observed live: "fresh" answered for 2 indexed
files vs ~60 on disk):
`node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/gitnexus-runner.cjs" --force`
(or `graphify-runner.cjs --force`). Worker threads cannot trigger the post-build rescan
hook on every host, so this parent-side refresh is the deterministic path.

Run `senior-reviewer` and `senior-tester` **concurrently**, using the same host concurrency mechanic as Phase 2 (on Codex: issue both `spawn_agent` calls before any `wait_agent`, then `wait_agent` on each). Pass the `model` param on both: reviewer follows the level (`balanced` tier for Balanced, `highest` tier for High); tester is always the `cheapest` tier in both levels. Use a read-only agent for the reviewer, and a writer-capable agent for the tester restricted to test files and test infrastructure.

Synthetic prompts — use the **Phase 3 — Reviewer** and **Phase 3 — Tester** templates from `resources/prompt-templates.md`. Both templates instruct the verifier to read the implementer digests first (`.traffic-one/digests/<run-id>/{frontend,backend}.md`), then scoped `git diff` *only for files those digests flagged*, then graph neighbors, full file Reads only as last resort. Reviewer writes `reviewer.md` digest via Bash heredoc (no Write tool); tester writes `tester.md` directly.

If reviewer returns `CHANGES_REQUESTED` → Phase 3a (loop, max 2 cycles).
If tester returns `TESTS_FAILING` → Phase 3b (loop, max 2 cycles).
If both green → proceed.

### Phase 3a — Reviewer fix loop (capped at 2 cycles)

Send the numbered fix list to the relevant implementer (`senior-frontend` or `senior-backend` based on which file paths the reviewer flagged) — continuation-first: SendMessage to that role's live agent (see "Agent reuse"); re-spawn only when no live agent exists. After their reply, send the re-review to the live `senior-reviewer` the same way.

After 2 cycles, escalate to the user with both diffs and the latest review.

### Phase 3b — Tester fix loop (capped at 2 cycles)

Send the failing-test list to the relevant implementer (continuation-first, as above). After their reply, send the re-test to the live `senior-tester`.

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

**Then stamp the maintenance phase.** A completed orchestrator run means the
project's main build is done — flip `lifecycle.phase` to `maintenance` so the
NEXT prompt is routed through post-build triage (trivial → `quick-fix`, complex →
a single-feature orchestrator run) instead of re-running the full team from
scratch. Idempotent: a project already in maintenance is left untouched.

```bash
node -e "try{const root=process.env.TRAFFIC_ONE_PLUGIN_ROOT||process.env.CODEX_PLUGIN_ROOT||process.env.CLAUDE_PLUGIN_ROOT||'.'; const {markMaintenance}=require(require('path').join(root,'scripts/shared/state/lifecycle.js')); markMaintenance(process.cwd(),'orchestrator')}catch{}"
```

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
- ONE agent per role per run: after a role's first spawn, its later tasks are SendMessage continuations of that agent (the spawn gate denies duplicates). Never spawn `senior-frontend` twice for parts/fixes — same agent, next message.
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
- Refactor-only requests: route to `refactor`.
- The user already has a plan and just wants implementation: spawn `senior-frontend` + `senior-backend` directly, skip architect.
