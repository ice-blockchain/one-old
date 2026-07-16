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
  "subagents"` (spawn the host-native role subagents); `low` → `team.mode: "main-agent"`
  (run the phases manually in this thread as a role roadmap).
- **Team Confirmation** (only for `high`/`balanced`): the PreToolUse spawn gate
  denies every subagent-spawn call until local preferences contain
  `team.approved: true`. Auto-approving is forbidden — wait for the user's
  explicit Approve, then spawn.

### Low/main-agent branch (exclusive)

When Active State says `team.mode: "main-agent"` / `Team: main-agent (low)`, do
not call `run_subagent`, `Task`, `spawn_agent`, `task`, or another host subagent
primitive. Host-native role profiles are intentionally materialized only for
`team.mode: "subagents"`; their absence is not a subagent failure to retry.
You are the senior architect in this thread: write `.traffic-one/plan.md` and
the required `.traffic-one/` project memory **before** root configuration,
workspace-scaffold, or feature-source writes. Then carry out architect →
frontend → backend → review → test manually in that order and state once that
the Traffic One team is being simulated in the main thread. Every spawn,
parallel-worker, and continuation instruction below applies **only** when
`team.mode: "subagents"`.

Do not satisfy a subagents run with generic explorer/helper agents — a
Balanced/High run means the named senior-role workflow below: `senior-architect`
→ (`senior-frontend` ∥ `senior-backend`) → (`senior-reviewer` ∥ `senior-tester`),
plus `senior-shipper` only on explicit deploy intent. If the gate was missed and
work already started, pause at the next safe point, resolve it, then continue.

## Runtime compatibility

- **Per-agent model is set by the spawn tool's `model` PARAMETER — never by prompt text, but only on hosts whose spawn tool exposes that parameter.** The `agents/senior-*.md` files declare no portable model frontmatter, so a subagent spawned without a `model` param may inherit the parent model on hosts that support model-pinned spawns. For Balanced/High, pass the model param only on Claude and Cursor. Codex `spawn_agent` currently exposes only `task_name`, `message`, and `fork_turns`; pass no `model`. In current Codex Desktop rollouts the spawn `message` is encrypted at rest, so its role marker is structurally unreadable from the child transcript on this host. The exact `task_name` and line-zero `session_meta.agent_role`/`agent_path` are therefore the only usable Codex identity evidence, not merely preferred evidence. Use the canonical mapping `senior-architect` → `senior_architect`, `senior-frontend` → `senior_frontend`, `senior-backend` → `senior_backend`, `senior-reviewer` → `senior_reviewer`, `senior-tester` → `senior_tester`, and `senior-shipper` → `senior_shipper`. The role-attribution incident already used `task_name: "senior_architect"`; this contract codifies existing orchestrator behavior rather than adding a new prompting requirement. Keep `[t1-role: senior-<role>]` in the task message for readable-prompt hosts and cross-host compatibility, but never use a generic/default Codex task name and never rely on prompt text for Codex identity. Treat the local Codex lineup as the recommendation used for onboarding/session context. A user may configure a Codex custom-agent model globally, but Traffic One does not write project-local concrete model artifacts. OpenCode/Kilo/Copilot/Windsurf likewise use host-native task/profile facilities and Traffic One does not hard-deny a missing model parameter there. Each role is assigned a host-agnostic capability TIER (`highest`|`balanced`|`cheapest`, from the plugin's model-tiers config); resolve the tier to YOUR host's model when your host accepts a model parameter:
  - Balanced → architect/frontend/backend/reviewer/shipper = `balanced` tier, tester = `cheapest` tier.
  - High → architect/frontend/backend/reviewer = `highest` tier, tester = `cheapest` tier, shipper = `balanced` tier.
  - Tier → model: resolve each tier (`highest`|`balanced`|`cheapest`) to your host's concrete model via the plugin's tier→model table; the Team Confirmation line-up renders the resolved per-host models.
- **Spawn**: auto-spawn each role with your host's subagent tool when this skill triggers, passing the `model` parameter resolved to that role's tier whenever the host exposes one (a model name in prompt text has no effect). Where the host uses model aliases, the alias auto-tracks the newest model of that family.
- **Spawn tool per host (subagents mode only) — supported hosts expose one, never claim otherwise:** Claude = the `Task`/`Agent` tool; Codex = `spawn_agent` with the exact underscore-form task name from the mapping above; **Cursor = the `Task` tool**; Copilot = background `task`; Windsurf/Devin Local = `run_subagent` profile `subagent_general` plus the materialized role contract under `.devin/agents/<role>/AGENT.md`; OpenCode = `task`; Kilo = OpenCode-compatible `task` when exposed by the host. Cursor IS a first-class subagent host: Traffic One materializes model-agnostic `.cursor/agents/senior-<role>.md` role contracts and emits the exact per-role model map dynamically from local preferences. Pass the model from the model-gate spawn map. Do NOT assert "Cursor doesn't expose subagents" or simulate merely because you are on Cursor.
- **Windsurf / Devin Local spawn = `run_subagent` profile `subagent_general` — NEVER a freshly materialized role name and NEVER `opencode_delegate`.** Custom profiles created during onboarding are not registered until a new Devin session (live failure: `Unknown subagent profile 'senior-architect'; Available: subagent_general, subagent_explore`). Spawn every role with `profile: "subagent_general"`; put `[t1-role: senior-<role>]` as the FIRST task line and immediately tell the child to read `.devin/agents/<role>/AGENT.md`. Pass NO `model` param. Use `read_subagent` to collect a background result. If a role-name spawn failed, retry once with this built-in-profile protocol; never build the role inline.
- **OpenCode spawn — use the project-scoped global `traffic-one-<projectHash12>-senior-<role>` agent; never use `general` for Traffic One senior roles.** Do NOT pass `model` unless this exact OpenCode build documents a supported task model field: Traffic One pins the local role model in `~/.config/opencode/agents/traffic-one-<projectHash12>-senior-<role>.md`. Select the exact generated name shown by SessionStart/the spawn gate, omit `model`, and put `[t1-role: senior-<role>]` first. Built-in `general` inherits the parent model and is not a safe fallback. If the generated name is not listed, ensure materialization ran, then tell the user to restart OpenCode so its global agent registry reloads. Do not build inline; the spawn gate names the exact expected agent and recovery.
- **Kilo spawn — OpenCode-compatible hook path, built-in Task worker plus role contract.** Use Kilo's writable `task` subagent type `general`, always include `[t1-role: senior-<role>]` as the FIRST line, and immediately tell the child to read `.kilo/agents/senior-<role>.md` before acting. That file carries the full Traffic One role contract; it is not a Kilo Task type name in this host build. Omit `model` so Kilo inherits the model selected for the active session or agent. Do not use `explore`, and do not switch to main-agent simulation: `general` with the marker-and-contract protocol is the supported Kilo subagent path.
- Subagents do not inherit the parent's skills. Keep every `agents/senior-*.md` frontmatter `skills:` list complete for that role.
- **In subagents mode, a first spawn that is DENIED or "Couldn't start" → RE-SPAWN it once, do NOT build the role inline.** The very first spawn (usually the architect) commonly hits a one-time *readiness* deny: the gate converges materialization on the first gated call and denies-for-retry (deny prose: "rerun the same agent spawn now; materialization is current"). Cursor renders this as a terse "New subagent — Couldn't start". It is NOT a real failure — re-issue the SAME spawn and it succeeds. Treating it as terminal and implementing the role yourself silently breaks subagents mode (the parent must not write feature source). Only after a re-spawn ALSO fails is the spawn tool genuinely broken.
- If the host requires the setup gate cleared or explicit user consent before spawning, do that first (see "Before you orchestrate" above; `rules/common/setup-gate.md` + `rules/common/onboarding.md`). Simulate the same roles manually (same dependency order, mirrored `00-agent-senior-*` role contexts) ONLY when Low is chosen (`team.mode: "main-agent"`) or the spawn tool genuinely errors at runtime AFTER a re-spawn (per the bullet above) — all supported hosts expose a callable subagent tool, so never simulate merely because the project-scoped global OpenCode agent is temporarily missing (restart OpenCode so `~/.config/opencode/agents/` reloads) or because Kilo custom agent files are not Task types (use `general` and the materialized role contract).
- Role → write-scope mapping (use a writer-capable agent for implementers, scoped to its owned area; a read-only agent for the reviewer). For implementers the AUTHORITATIVE scope is the role's entry in the per-run assignments manifest `.traffic-one/runs/<runId>/assignments.json` (authored by the architect in Phase 1, enforced by the run-team gate). The lines below are the human summary:
  - `senior-architect` — owned write scope `.traffic-one/plan.md`, `.traffic-one/` project memory, docs, the per-run `assignments.json` manifest, and required workspace scaffold files. It may create empty package `src/index.ts` barrels as scaffold only; filling them is implementer-owned.
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
- Include the relevant `agents/senior-*.md` role text or a concise equivalent in every subagent prompt; Kilo's `.kilo/agents/senior-*.md` role-contract files carry the full role definition and must be read by its `general` task child.
- If subagents are unavailable or blocked, or the user picks Low: continue manually in the same dependency order and state that the Traffic One team is being simulated by the main agent.

## OpenCode delegation (token-saver — driven by the architect's plan queue)

When the current host is NOT OpenCode or Kilo, `openCode.enabled` is true in the effective Traffic One state, AND the OpenCode CLI is installed (`scripts/opencode-runner.cjs` present), bounded/low-risk units are delegated to OpenCode INSTEAD of paid subagents — **deterministically, from the plan**, NOT by per-unit improvisation. In a subagents run, work is split by LAYER (one frontend + one backend subagent), so there is no per-unit spawn to redirect; delegation therefore happens in a dedicated batch BEFORE the implementers spawn. The OpenCode and Kilo hosts never self-delegate: they omit the plan queue and run implementer work directly on the current host.

How it works:

1. **The architect classifies + queues (Phase 1, non-OpenCode/Kilo hosts only).** `senior-architect` emits an OpenCode delegation queue in `.traffic-one/plan.md` — a machine-readable block listing ONLY bounded units. This runs in a new-project build AND in a complex existing-codebase/maintenance build the architect was spawned for (e.g. a large revamp). The batch delegates ONLY a queue the architect wrote for THIS run (tied to `runs/<runId>/assignments.json`), so a stale block from a previous build is never re-run; small maintenance fixes that never invoke the architect keep using per-unit `opencode_delegate`, not this batch. When the current host is OpenCode or Kilo, the architect must omit this section and the `opencode-delegate` markers entirely.

   ```text
   <!-- opencode-delegate:start -->
   - id: fixtures-news | role: backend | kind: seed-data | files: src/lib/news-data.ts | task: <self-contained: dummy news articles + categories seed data, pure data, no deps>
   - id: news-card | role: frontend | kind: ui-stub | files: src/components/NewsCard.tsx | depends: fixtures-news | task: <self-contained: presentational card, props in, no data fetching>
   <!-- opencode-delegate:end -->
   ```

   The `files:` field is an enforced allowlist, not prose: OpenCode output is
   rejected before apply if it touches any path outside those file/area patterns,
   outside the role assignment, or inside generated/cache/internal output
   (`dist`, `.turbo`, `.next`, `*.tsbuildinfo`, `.traffic-one`, etc.). List every
   legitimate source path the unit may touch. If a unit mentions tests,
   testability, Vitest, Playwright, specs, or config/dependency changes, include
   the exact test/spec/config/package files it may touch; otherwise remove that
   acceptance and leave verification/config work to the paid implementer/reviewer.
   Dependency/package-manager work is paid-agent work unless the policy can prove
   safe lockfile handling: OpenCode must not install packages, update lockfiles,
   or apply package-manager side effects. If a delegated diff contains install
   churn, strip those side effects and route the dependency decision to the
   relevant paid role.

   Queue rows should include stable `id` values. If two units touch overlapping
   files/areas, the later unit must declare `depends: <earlier-id>`; otherwise
   the plan gate rejects the queue before `PLAN_READY`. `depends_on:` or
   `depends:` text inside the `task:` field is invalid; dependencies must be
   pipe-delimited fields so the runner can order them.

   The canonical catalog of queueable unit kinds lives in the plugin config
   (`config/opencode-delegation.ts` → `OPENCODE_DELEGATE_UNIT_KINDS`); when this prose and
   the config disagree, the config wins. In short: fixtures/seed data, pure
   helpers, i18n source catalogs + DRAFT translations, test scaffolding,
   QA-report sweeps, reviewer-input audit sweeps (npm audit / unused-deps /
   TODO inventory / i18n key-completeness / SEO meta presence — reports the
   paid reviewer consumes), ROOT human-docs drafts ONLY (`README`/`CONTRIBUTING`/
   `CHANGELOG`, incl. secret-free deploy manifests — NEVER the `.traffic-one/`
   memory baseline), Storybook story stubs, and mechanical refactors/codemods. A
   productive queue (new-project OR complex maintenance build) has 3–6 units — an EMPTY queue wastes the free tier
   (measured: a populated queue delivered 2–6 units/run at ~2 min each). NEVER
   queue what `OPENCODE_NEVER_DELEGATE` lists: architecture, public contracts,
   security/auth/RLS, data-model/migrations, cross-file invariants, deploys or
   credentials, and the `.traffic-one/` project-memory/docs baseline (product/
   stack/coding/security/api/database/deployment/environment-setup/known-issues/
   `.agentignore`/agent-log/schema.sql + decisions ADRs — the architect writes
   these DIRECTLY before `PLAN_READY`) — those stay on the named senior subagents.

2. **The orchestrator runs the batch FIRST in Phase 2** (before spawning implementers), exactly once, by calling the bundled `opencode_delegate_from_plan` MCP tool (server `opencode-worker`) with `{ runId: "$RUN_ID", projectRoot: "<absolute project root>" }`. This is run by the orchestrator (NOT a subagent spawn, NOT subject to the spawn `model` param). The tool runs the locally-installed OpenCode CLI from paid hosts, not from OpenCode or Kilo themselves. It reads the queue and delegates EVERY listed unit to OpenCode (each in an isolated worktree; only clean, error-free, assignment-scoped, source-only diffs applied to the tree; install/lockfile side effects stripped; a digest written per unit). It returns `{ total, delegated, units: [{ id, role, task, action, status, attempts, touched, error }] }`. Status is immutable-attempt aware: summary status precedence is `delegated > no_changes > failed`, and each retry appends to `attempts[]` instead of overwriting history. A zero-unit batch is explicit (`total: 0` plus a skipped/no-units status) and still satisfies the "attempted" marker without pretending work ran. It never throws and never fails the build. **Resumable:** if a call returns `running:true`, call `opencode_delegate_from_plan` again with the same args after the returned `pollAfterMs` (or a short delay if absent) until you get the terminal `{ total, delegated, units }` — do NOT use any shell fallback while `running:true`. Do not spawn backend, frontend, or any other implementer while the batch is merely running.

   Fallback (MCP unavailable ONLY — never while `running:true`): on Codex this usually means the auto-registered MCP server has not been loaded yet, so tell the user a one-time Codex restart enables it. Otherwise run the same engine via the shell runner (it writes the same terminal batch markers as the MCP tool — `batch.json` + `COMPLETE` under `.traffic-one/runs/<runId>/opencode-plan-batch/`). A bare JSON stdout line alone does not clear the spawn gate. For a stuck run with terminal unit rows but no `batch.json`, use `--finalize-only` instead of re-delegating:

   ```bash
   node ~/.traffic-one/bin/opencode-runner.cjs \
     --run-id "$RUN_ID" --from-plan
   ```

   Recovery when units are already terminal but `batch.json` is missing:

   ```bash
   node ~/.traffic-one/bin/opencode-runner.cjs \
     --run-id "$RUN_ID" --finalize-only
   ```

   If the shell runner cannot run (e.g. `.git` is read-only or worktree metadata cannot be written), treat the queued units as not delegated and continue with the internal senior subagents.

   **Fail-open:** a terminal batch (`success`, `failed`, `partial`, `abandoned`, or legacy COMPLETE) unblocks implementer spawns — per-role markers are diagnostic only.

3. **Then spawn implementers ONLY for the rest:** the senior units, plus any queued unit whose `action !== "delegated"` (skipped/failed/no-changes → fall back to the paid subagent). Tell each implementer which files OpenCode already produced (`touched`) so it builds ON them, not over them.

4. **`senior-reviewer` MUST verify the delegated diffs** in Phase 3 — they came from a weaker model.

(A single ad-hoc unit can be delegated with the `opencode_delegate` tool — `{ role, task, runId, projectRoot, allowedFiles }` — or the runner's `--role <r> --task-file <path> --allowed-files <patterns>` mode.) OpenCode picks its own free model by default; only non-sensitive bounded units are queued. Pin a specific model per project via `openCode.model` if needed.

**Forced role delegation (enforced by the spawn gate).** Roles listed in `openCode.delegateRoles` (default: `senior-tester`, `senior-frontend`, `quick-fix` — `senior-shipper` is deliberately excluded: deploys/credentials never ride the free tier) MUST run on OpenCode when `openCode.enabled` on paid hosts. The OpenCode and Kilo hosts never self-delegate. The PreToolUse spawn gate **denies** a paid spawn of such a role until you have delegated it for this run. **The Step-0 plan batch is the preferred way to satisfy it** — completing `opencode_delegate_from_plan` marks every queued role as attempted. For a role with no queued units, call the `opencode_delegate` tool (server `opencode-worker`) with `{ role, runId: "$RUN_ID", projectRoot, allowedFiles, task }` where `allowedFiles` is the exact repo-relative files/areas the unit may touch and `task` is ONE bounded unit per the rule above — NEVER the entire role implementation. While a delegation runs, your re-polls are its keep-alive — stopping polls for ~15+ minutes cancels the worker (your re-polls keep the child alive while the runner is alive); falling back to a paid worker is always safe after abandon. (No `model` — OpenCode picks its own free model). If it returns `running:true`, call again with the same args after `pollAfterMs` until terminal. On `ok:true` the work is applied (no paid spawn needed); on `ok:false` OpenCode declined or could not run, so spawn the paid subagent as the internal fallback. **If the host's safety reviewer rejects the call and offers a user-approval path** (e.g. Codex: "proceed only if the user explicitly approves"), ask the user once — naming the risk that it sends the task + relevant code to OpenCode's hosted model — and on explicit approval re-call with the same args (the reviewer sanctions this; treat the approval as covering the rest of this run); on decline, use the paid fallback. The gate denies each role at most once per run to prevent deadlocks, so if the tool is unavailable or its call could not complete, the fallback spawn still goes through. (Requires `currentRunId` set — Traffic One pre-mints it before Phase 0; you only read it.) The gate's deny message carries the exact tool arguments (including `projectRoot`). Adjust the set by editing `openCode.delegateRoles` in local preferences.

## When you fire

Auto-trigger keywords: "build me", "make me", "create me", "scaffold a", "ship a", "end to end", "I want an app", "I need a site for", "turn this into", "habit tracker", "dashboard", "SaaS", "mobile app", "MVP", "landing page that does X".

On all hosts these triggers mean: clear the setup gate (per `rules/common/setup-gate.md` + `rules/common/onboarding.md`), then run the Traffic One workflow at the approved performance level. The onboarding prompts are blocking — do not implement, write final `.traffic-one/.one.json`, or spawn while an answer is pending. A custom frontend/backend stack choice does not itself force subagents: Low/main-agent mode and genuinely small solo builds remain valid when the team/performance decision or maintenance triage chooses solo, but the QA/report/digest state must still be coherent.

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
  `task-triage` skill) routes those to a `quick-fix` worker or the directly owning implementation
  role(s). A bounded page plus an existing server/data seam may send frontend and backend directly in
  parallel; it does NOT need an architect or `plan-<feature>.md`. You run only for COMPLEX maintenance
  work (a feature spanning layers, data-model/auth/migration/integration changes).

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

- If `.traffic-one/.one.json` is missing or `mode` / `stack` is unset → complete onboarding (`rules/common/onboarding.md`) first. The user must commit to a stack before architect can plan. **Do NOT spawn ANY subagent (architect included) until onboarding is COMPLETE** (`.one.json` has `stack` + `onboardingComplete: true` and materialization has run). Onboarding runs in THIS main thread — you drive the setup wizard here; a subagent cannot (it can't show the wizard, and would get trapped on the "wait for setup" command). Spawning before onboarding is a protocol violation: finish setup in the main thread, THEN spawn the team.
- If `.traffic-one/plan.md` exists and is fresh (matches the current request scope) → skip Phase 1.

**Do NOT generate a run-id.** The run-id is `currentRunId` — a plain epoch-**millisecond
digit string** like `"1715091785000"`, **pre-minted by Traffic One into `.traffic-one/.one.json`
before Phase 0** (the onboarding gate announces it the moment the build starts). You and every
subagent **READ** it from there; you never create it, and NEVER use `date`/`date -u` or an
ISO/UTC string (e.g. `2026-06-17T10-08-00Z`) — that is the single most damaging mistake (it
splits run state). Read it FIRST, before building any spawn prompt:

```bash
RUN_ID=$(node -e "try{process.stdout.write((JSON.parse(require('fs').readFileSync('.traffic-one/.one.json','utf8')).currentRunId)||'')}catch(e){}")
```

This is now **doubly enforced**: the SPAWN gate DENIES a subagent spawn whose prompt
references any run-id other than `currentRunId` (you cannot hand a worker a fabricated id),
and the plan gate DENIES any write to `.traffic-one/runs/<id>/…` or `digests/<id>/…` whose
`<id>` is not `currentRunId` — both naming the correct value, so a stray `date` id is rejected
at the spawn and the write, never silently split.

The spawn gate, the run-team gate, and OpenCode delegation key EVERY per-run marker
(run-agent claims, `opencode-attempts/<role>`, `opencode-gate-denies/<role>`), the
`assignments.json` manifest, and every digest off this EXACT `currentRunId`. A second or
differently-formatted id creates a separate `.traffic-one/runs/<id>/` tree, so the run-team
gate finds no `assignments.json` and blocks every implementer write ("New subagent —
Couldn't start"). Each subagent template tells the subagent to read `currentRunId` itself
for its `.traffic-one/runs/<runId>/…` and `.traffic-one/digests/<runId>/…` paths — do not
substitute a literal. The full per-phase prompt templates live in
`resources/prompt-templates.md`; reference them rather than inlining their full text here.

Cleanup at the end (Phase 5): use the retention runner (`traffic-one-cleanup.cjs`) so runs, digests, reports, fix cycles, OpenCode state, backups, `.once`, stale locks, and debug logs are pruned together while durable project memory stays whitelisted.

**Cursor only — capture your subagent model list (before the first spawn).** Cursor's offered
subagent models are plan/build-specific and their reasoning suffixes differ per plan
(`-thinking-max`, `-extra-high`, `-thinking-max-fast`, …); only you (inside Cursor) can see the
list. Before spawning the team, list the exact ids your `Task` tool offers and run the internal
model-gate `--capture-models` command emitted by SessionStart/the capture gate. It stores the list
only in local per-user/project preferences; never create `.traffic-one/cursor-models.json`.
Then run model-gate and pass each exact role→model value from its spawn map. (If capture is
missing/stale, the spawn gate asks once and prints the command.)

### Cursor subagent failure recovery (transcript-backed)

Cursor startup failures can emit `subagentStart` without a matching Task
`postToolUse`/`subagentStop`, leaving a role falsely recorded as live. Traffic One therefore
reconciles terminal records only from Cursor child transcripts under `subagents/*.jsonl` and
ties them back to immutable observations recorded at actual `subagentStart`. A parent
`User aborted request` record is never a subagent result. If a role-less transcript cannot be
uniquely correlated, do not condemn its model: the existing 90-second corroborated grace and
270-second hard-dead timers recover the role without inventing a failure cause. Never announce or attempt a fallback named only by Cursor error prose. The next model is authoritative only when Traffic One supplies its exact slug. Issue the prescribed Task without a pre-tool model announcement, and do not say the replacement is running until a real `subagentStart` proves it.

Cursor failure handling has exactly three flows:

1. **Correlated API/usage limit** — retire the false-live agent immediately and retry
   automatically on the next exact captured model from the role's **original** tier. Never infer
   the tier from the failed model: the same family can occur in more than one tier. API-limit
   entries are isolated per run + role, so one role never rotates another role's model.
   Highest/balanced roles rotate automatically until the next candidate is the Composer floor;
   then stop once and show exactly:

   **enable** — Restore API budget for **<recommended-model>**, then reply **enable**; I’ll retry on the recommended model.

   **fallback** — Proceed now on **<composer-slug>**.

   Do not start Composer for that role until the user replies **fallback**. Composer is a normal
   cheapest-tier candidate, not a downgrade: a cheapest role that limits on Composer continues
   automatically to its next cheapest candidate. Once every eligible model actually started for
   a role has reached an API limit, stop that role with a terminal per-role marker. Individual
   limit entries may expire, but the terminal marker persists until **enable** or a new run; a
   disabled/absent model was never tried and cannot count toward “all exhausted”.
2. **Explicit model unavailable/not enabled** — use the Settings choice only when the runtime
   error explicitly ties a model to `not enabled`, `disabled`, `unavailable`, `invalid`,
   `unsupported`, `unknown`, or `not found` (the fresh captured model list remains the primary
   availability signal). Show exactly:

   **enable** — Open Cursor Settings → Models, enable **<failed-model>**, then reply **enable**; I’ll retry on the recommended model.

   **fallback** — Proceed now on **<next-tier-slug>**.

   **fallback** selects the next exact captured slug from each pending role's original tier;
   **enable** preserves the run-level choice semantics and clears the run's API-limit ledger and
   pending model decisions before retrying the recommended model.
3. **Every other non-API failure** — use generic recovery and report the actual cause. Never
   label authentication, network, user abort/cancel, context exhaustion, or a generic API error
   as a disabled model, and never show Cursor Settings → Models without the positive vocabulary
   above.

Cursor may append a synthetic `Briefly inform the user…` background-completion request. It is not
an **enable**/**fallback** decision. If the immediately preceding assistant turn already displayed
the pending choice and no new tool work ran, do not call tools or repeat the options; reply at most
`Awaiting your enable/fallback choice.` The run-level `model-choice-prompted` marker is not proof
that the initial choice was shown and must not suppress it.

### Subagent token-economy: per-agent run claims

`currentRunId` is already persisted in `.traffic-one/.one.json` (Traffic One pre-mints it
before Phase 0) — you READ it, you do not write it. If it is somehow absent, the spawn gate
mints it on the first spawn; never substitute a `date` value.

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
`currentRunId` means the active or planned run id. When Traffic One pre-mints a
run for maintenance/OpenCode it may write only `.traffic-one/runs/<runId>/run.json`
with `status: "planned"`; do not create stub `assignments.json` or digest files.
That ledger alone is not an orchestrated artifact. After Phase 5 you may leave
`currentRunId` pointing at the completed/planned run until the next maintenance
prompt rotates it; `lastCompletedRunId` is optional correlation metadata, not a
requirement for solo builds.

### Agent reuse — ONE live agent per role (continuation-first)

**Each role gets ONE agent for the whole run; every later task for that role goes to the SAME agent.** A fresh same-role spawn re-loads the entire rules+skills context (~20k tokens before any work) and re-explores the codebase — a measured build spent 7 senior-frontend spawns (≈46M tokens) where 1 agent should have served. Context must load once per role (5 roles ⇒ ~5 context loads), not once per task.

Mechanics on hosts with agent continuation: Claude uses `SendMessage` when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` enables the tool; Codex uses `followup_task` for the next turn on the same agent (or `send_message` for an in-flight update); Cursor re-invokes the `Task` tool with `resume: "<agentId>"` (if a Cursor build exposes `agentId`, use the same id there); Copilot calls `task` with the recorded background `agent_id` (`name` alone creates a fresh task). OpenCode currently has no true Task resume field exposed to Traffic One: wait for the existing named role task while it runs; after it has completed, a follow-up/fix uses an explicit replacement spawn of the same named `senior-*` agent with `[t1-replace-agent]`, `[t1-role: senior-<role>]` first, and only the new findings inline. Kilo likewise waits for the live role and permits a new built-in `general` task only as an explicit `[t1-replace-agent]` replacement after completion, with `[t1-role: senior-<role>]` first and an immediate read of `.kilo/agents/senior-<role>.md`; never use `explore`.

1. **First task for a role** → normal spawn (model param per tier). The spawn tool result footer prints the agent id (`agentId: <id> (use SendMessage …)`). The PostToolUse hook records the resumable agent in `.traffic-one/runs/<runId>/agents.json` where the host emits one; on Cursor, `subagentStart` separately records the immutable role/model/original-tier observation used by transcript reconciliation.
2. **Every later task for that role** — the next planned part (e.g. frontend: foundation → learner journey → admin area), a fix cycle, a re-review, a re-test — goes to the SAME agent via the host-specific continuation primitive above. The PreToolUse gate DENIES a duplicate same-role spawn and names the recorded id, so following this protocol is also the only path the gate allows.
3. **The continuation message carries ONLY what is new**: task spec, exact file paths, acceptance criteria, reviewer/tester findings verbatim. The agent keeps everything it already read (rules, skills, plan, digests, source) — never re-paste those. Treat the reply exactly like a spawn's final report: same digest + terminal-token contract.
4. **Parallel roles stay parallel**: frontend ∥ backend follow-ups are two continuation calls in ONE message, exactly like parallel spawns.
5. **Big roles split into sequential parts on purpose**: each continuation turn gets a fresh tool/turn budget, so "foundation, then admin" runs as message 1, then message 2 to the SAME agent — splitting no longer costs a context reload per part.
6. **Replacement (rare)**: when a continuation call errors ("agent not found") or the agent's replies show context exhaustion, re-spawn the role with the literal marker `[t1-replace-agent]` in the spawn prompt — the gate allows that one replacement and re-records the new id. On Cursor, a transcript-correlated startup/mid-run failure follows the three-flow recovery above instead: reconciliation persists the result and tier anchor before retiring the false-live agent, and the prescribed retry is accepted even when it arrives without `[t1-replace-agent]`. React in the same turn rather than waiting for sibling roles, and pass only the exact prescribed fallback slug so a generic replacement cannot bypass model gates.
7. **Keep role threads open after MVP/maintenance** unless the user explicitly archives them, the agent is dead/replaced, or host active-agent caps require cleanup. A finished first MVP is often the start of the next feature, and the live role context is valuable.
8. **No continuation available** (flag unset, non-teams host): the gate stays inert; fall back to the legacy re-spawn protocol below. On OpenCode the gate is not inert: it records the child session id and denies bare duplicate spawns, so use the explicit replacement marker for completed-task follow-ups.

### Fix-cycle follow-up (CHANGES_REQUESTED loop)

When `senior-reviewer` returns `CHANGES_REQUESTED` and you loop back to `senior-frontend` / `senior-backend` to apply fixes, **do not run the full role flow again**. The role already has a prior digest and active rules; running the full flow re-explores the codebase and burns ~30M tokens per fix-cycle (real measured cost).

**Continuation-first** (the protocol in "Agent reuse" above governs — do not restate its host mechanics here): with a live role agent, a fix cycle is ONE continuation message carrying the reviewer findings verbatim (`file:line` + concrete change per item) plus "apply ONLY these fixes, update your digest, end with `FIXES_APPLIED` (or `FIXES_FAILING <numbered list>`)" — plus one caution unique to fix cycles: "re-read any files OTHER roles changed since your last turn" (the live agent's memory of shared files may be stale). Still write the fix-cycle context file (step 1 below) for the audit trail. Steps 2–3 (spawnIndex bump + re-spawn) apply ONLY when no live agent can be continued; on OpenCode, that re-spawn must use the same named role agent plus `[t1-replace-agent]`, and the prompt must include the exact findings inline so the role is not blocked if a fix-cycle context file is missing.

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

4. **After the fix-cycle reply returns**, loop back to `senior-reviewer` — continuation-first there too: the host-specific continuation call to the live reviewer agent with "re-review ONLY the fixes for findings <list>" (fresh re-spawn with `spawnIndex[senior-reviewer]++` only when no live reviewer agent exists).

The 2-cycle reviewer cap (architect / orchestrator level) still applies — if the second fix cycle also gets `CHANGES_REQUESTED`, stop and surface the unresolved findings to the user.

### Phase 1 — Architect (subagents mode, sequential, blocking)

This phase applies only when `team.mode: "subagents"`. In Low/main-agent mode, write the plan and project memory yourself before touching config, scaffold, or source; do not spawn a role. Otherwise, spawn `senior-architect` via your host's subagent tool. On Claude/Cursor, set the `model` param to the runtime lineup value (`balanced` for Balanced, `highest` for High). On Codex, use `spawn_agent` with `task_name: "senior_architect"`, no `model` field, and retain the matching role marker in the message for cross-host compatibility; the task name/session metadata, not marker placement, supplies Codex identity. On OpenCode, select the generated `traffic-one-<projectHash12>-senior-architect` global agent named by SessionStart/the gate and omit `model`. On Kilo, select built-in `general`, begin the prompt with `[t1-role: senior-<role>]` after substituting the architect role, then direct it to read `.kilo/agents/senior-architect.md`; omit `model`. On Windsurf, select `subagent_general`, begin with `[t1-role: senior-<role>]` after substituting the architect role, and direct it to read `.devin/agents/senior-architect/AGENT.md`; on Copilot omit `model` unless documented. Give the architect owned scope `.traffic-one/plan.md`, ADR/docs, and the per-run `assignments.json`; block on its return.

Spawn the architect COLD with the `model` param — do NOT use `fork_context`.
Two measured reasons: (1) Codex rejects a full-history fork combined with
`model`/`agent_type`/`reasoning_effort` overrides ("forked agents inherit the
parent model"), so a forked architect cannot be tier-pinned and every attempt
costs a rejected-spawn round-trip; (2) fork economics are negative — a forked
architect re-bills the parent's whole context every turn and measured ~2× the
cumulative tokens of a cold spawn that reads its ~10 role files once.
Implementers/reviewer/tester also spawn COLD: they need only the plan + their
scoped rules.

Synthetic prompt body — use the **Phase 1 — Architect** template from `resources/prompt-templates.md`. The template tells the architect to read `.traffic-one/.one.json` + project memory + graph if present, produce `.traffic-one/plan.md`, create/update `.traffic-one/` memory, write `.traffic-one/runs/<run-id>/assignments.json` (the machine-readable Module map: one disjoint owned-path scope per implementer role), and write `.traffic-one/digests/<run-id>/architect.md` before emitting `PLAN_READY`. The `assignments.json` partition is what lets Phase 2 run conflict-free on any stack.

Architect must end its reply with the literal token `PLAN_READY`. If it doesn't, surface to the user and do not proceed to Phase 2.

### Phase 2 — Implement (subagents mode, parallel)

This phase's delegation and parallel spawn mechanics apply only when `team.mode: "subagents"`. In Low/main-agent mode, implement the frontend and backend responsibilities yourself after the plan exists; do not issue a host subagent call.

**Step 0 — OpenCode delegation batch (when `openCode.enabled` on a paid host).** HARD STOP: before spawning any frontend/backend implementer, inspect `.traffic-one/plan.md`. If it contains an `opencode-delegate` queue, run the plan delegation batch ONCE (see "OpenCode delegation") by calling the `opencode_delegate_from_plan` MCP tool (server `opencode-worker`) with `{ runId: "$RUN_ID", projectRoot: "<absolute project root>" }`. It delegates every bounded unit the architect queued in `.traffic-one/plan.md` to OpenCode and returns `{ total, delegated, units }`; if it returns `running:true`, call again with the same args until terminal — do NOT use any shell fallback while `running:true`. This is the token-saver the user enabled, and it runs from paid hosts only, never from OpenCode or Kilo. Do not emit any implementer `Task` calls in the same assistant message as this Step-0 call. Do not spawn backend first while frontend is gated; that serializes the run and defeats the batch. Fallback (MCP unavailable ONLY — never while `running:true`): on Codex, a one-time restart loads the auto-registered server; otherwise run the shell runner (writes terminal `batch.json` + `COMPLETE`; JSON stdout alone is insufficient). Use `--finalize-only` to unblock a stuck run without re-delegating.

```bash
node ~/.traffic-one/bin/opencode-runner.cjs --run-id "$RUN_ID" --from-plan
```

If that shell runner cannot run (e.g. `.git` is read-only or worktree metadata cannot be written), continue with the senior subagents for those units.

Then run `senior-frontend` and `senior-backend` **concurrently** — they share the architect's plan/digest for contracts, so neither waits on the other. **Host concurrency mechanic:** on hosts where one assistant message carries multiple tool calls (Claude `Task`), issue both spawns in a single message. On Codex (`spawn_agent`/`wait_agent`), issue both `spawn_agent` calls consecutively with task names `senior_frontend` and `senior_backend` and do not wait until both return ids; pass no `model` field. Retain matching role markers in their messages for cross-host compatibility, but Codex identity comes from task name/session metadata. Both use the implementation tier recommendation: `balanced` for Balanced, `highest` for High. On Claude/Cursor, pass the runtime-resolved `model`; on OpenCode, use the matching project-scoped global `traffic-one-<projectHash12>-senior-*` agent; on Kilo, use built-in `general` with each role marker and contract path; on Windsurf, use `subagent_general` with marker/contract; on Copilot omit `model` unless documented. Resolve each implementer's owned paths from `.traffic-one/runs/<runId>/assignments.json` and embed that exact list in its spawn prompt. If absent, fall back to legacy role scopes and say so; the run-team gate still prevents collisions.

Synthetic prompts — use the **Phase 2 — Frontend** and **Phase 2 — Backend** templates from `resources/prompt-templates.md`. Substitute each role's resolved owned-path list into the template's `<FRONTEND_OWNED_PATHS>` / `<BACKEND_OWNED_PATHS>` placeholder. Each template instructs the implementer to read the architect digest first, then the relevant plan section, then graph nodes, raw files only as last resort. Each writes its own digest (`.traffic-one/digests/<run-id>/{frontend,backend}.md`) before reporting.

Implementers handle ONLY the senior units, plus any queued unit OpenCode did not deliver (Step 0 `units[].action !== "delegated"` → fall back). Pass each implementer the files OpenCode already produced (the batch's `touched`) so it builds on them, not over them. Architecture/contract/security/data work always uses the named subagents — never OpenCode.

Wait for both to return before Phase 3.

### Phase 3 — Verify (subagents mode, parallel)

This phase's reviewer/tester worker mechanics apply only when `team.mode: "subagents"`. In Low/main-agent mode, perform the review and test responsibilities yourself after implementation; do not issue a host subagent call.

**Pre-step — refresh the codebase graph** (cheap, parent-side, do not skip): the
implementers just wrote the real code, but the graph index still holds the empty
onboarding scan, so reviewer/tester would navigate a stale near-empty graph.
RESOLVE the provider via `readEffectiveState`, NEVER by reading `.one.json` directly:
`codeGraphProvider` is a MACHINE-WIDE setting in `~/.traffic-one/one.json`, intentionally
absent from the project's `.one.json` — an empty/missing `codeGraphProvider` field in
`.one.json` does NOT mean "no provider configured", so never skip the refresh on that basis.
Run it WITH `--force` (the runner's mtime freshness check cannot tell a recent index predates
the new code — observed live: "fresh" answered for 2 indexed files vs ~60 on disk):

```bash
PROVIDER=$(node -e "try{const root=process.env.TRAFFIC_ONE_PLUGIN_ROOT||process.env.CURSOR_PLUGIN_ROOT||process.env.CODEX_PLUGIN_ROOT||process.env.CLAUDE_PLUGIN_ROOT||'.'; const {readEffectiveState}=require(require('path').join(root,'scripts/shared/state/local-prefs.js')); console.log(readEffectiveState(process.cwd()).codeGraphProvider||'')}catch{}")
case "$PROVIDER" in
  gitnexus) node ~/.traffic-one/bin/gitnexus-runner.cjs --force ;;
  graphify) node ~/.traffic-one/bin/graphify-runner.cjs --force ;;
  *) : ;;  # genuinely unset (rare) — skip; do NOT infer "unset" from .one.json
esac
```

Worker threads cannot trigger the post-build rescan
hook on every host, so this parent-side refresh is the in-run path that guarantees
reviewer/tester see fresh structure. If it is ever missed (crash/resume, or where worker
threads can't fire the post-build rescan hook — e.g. Cursor or Low/main-agent mode), the runner self-heals: a later no-force
invocation (Phase 5, the post-build hook, or the next session) still rebuilds, because
the index is now empty or stale vs the new source.

Run `senior-reviewer` and `senior-tester` **concurrently**, using the same host concurrency mechanic as Phase 2 (on Codex: issue both `spawn_agent` calls with task names `senior_reviewer` and `senior_tester` before any `wait_agent`, then `wait_agent` on each, with no `model` field; retain matching message markers for cross-host compatibility). On Claude/Cursor, pass the runtime-resolved model: reviewer follows the level (`balanced` tier for Balanced, `highest` tier for High); tester is always the `cheapest` tier in both levels. On other hosts the same tiers remain recommendations rather than spawn fields. Use a read-only agent for the reviewer, and a writer-capable agent for the tester restricted to test files and test infrastructure.

Before E2E/visual QA, require fresh build metadata. The tester must prove the
running preview is backed by a build newer than the last changed source file
(`dist/`, `.next/BUILD_ID`, Vite manifest, Expo/native bundle stamp, or a fresh
preview start after a successful build). A stale build blocks QA; it is not a
green pass.

Synthetic prompts — use the **Phase 3 — Reviewer** and **Phase 3 — Tester** templates from `resources/prompt-templates.md`. Both templates instruct the verifier to read the implementer digests first (`.traffic-one/digests/<run-id>/{frontend,backend}.md`), then scoped `git diff` *only for files those digests flagged*, then graph neighbors, full file Reads only as last resort. Reviewer writes `reviewer.md` digest via Bash heredoc (no Write tool) on every review and re-review pass; tester writes `tester.md` directly on every test and re-test pass.

If reviewer returns `CHANGES_REQUESTED` → Phase 3a (loop, max 2 cycles).
If tester returns `TESTS_FAILING` → Phase 3b (loop, max 2 cycles).
If both green → proceed.

### Phase 3a — Reviewer fix loop (capped at 2 cycles)

Send the numbered fix list to the relevant implementer (`senior-frontend` or `senior-backend` based on which file paths the reviewer flagged) — continuation-first: the host-specific continuation call to that role's live agent (see "Agent reuse"); re-spawn only when no live agent exists. After their reply, send the re-review to the live `senior-reviewer` the same way and require an updated `reviewer.md` digest. Repeat until `APPROVED` or the 2-cycle cap.

After 2 cycles, escalate to the user with both diffs and the latest review.

### Phase 3b — Tester fix loop (capped at 2 cycles)

Send the failing-test list to the relevant implementer (continuation-first, as above). After their reply, send the re-test to the live `senior-tester` and require an updated `tester.md` digest. Repeat until `TESTS_GREEN` or the 2-cycle cap. Structured blocked outcomes (`blocked:sandbox`, `blocked:usage-limit`) are not green; surface them like failing verification with the command/error and next repair step.

After 2 cycles, escalate to the user.

### Phase 3c — Parent integration pass (visual builds)

After reviewer `APPROVED` and tests are green, run the root verification
commands yourself (install/lint/typecheck/test/build). Re-use fresh evidence:
a Lighthouse report under `.traffic-one/reports/lighthouse/` or a QA sweep
under `.traffic-one/reports/qa/<runId>/` that is NEWER than the last code
change answers the gate by READING it — do not re-run audits the team just
ran. Then — for any build
with a UI — verify the RUNNING app visually before declaring completion: start
the dev server and check the key routes at desktop AND a mobile width
(overflow, console errors, primary actions reachable). Per host:
- **Claude Code**: `preview_start` (in-app preview) or the claude-in-chrome
  browser MCP; `preview_stop` when done.
- **Codex**: the in-app-browser recipe in the `browser-qa` skill
  (`.traffic-one/skills/browser-qa/SKILL.md`) — do NOT tool-search for or read
  the bundled `control-in-app-browser` skill (~8k tokens; the recipe is
  complete).
- **Cursor**: the built-in Simple Browser, or the browser automation MCP.
**The mechanical half of this pass belongs to `senior-tester`, not to you.**
The tester role owns the visual regression sweep (key routes render, console
errors, horizontal overflow at desktop + ~390px, screenshots saved under
`.traffic-one/reports/qa/<runId>/`) — it runs on the cheapest tier, it is a
delegateRole (the scripted sweep can ride OpenCode for free), and as a live
agent it re-runs the sweep after fix cycles via one continuation message. If
its Phase-3 pass ran before the final fixes, send the live tester a "re-run the
visual sweep" continuation now instead of doing the sweep yourself. Reserve
YOUR (parent) context for the judgment half only: read the tester's QA report
and view the 2–3 screenshots that need actual visual assessment — never stream
every screenshot into the orchestrator context. A one-element CSS finding goes
back through the fix-cycle continuation, not a fresh spawn. Your own in-app
browser spot-check (per host above) is optional polish on top, not the
mechanism of record. Leave the dev server running for the user.

### Phase 4 — Ship (only on explicit intent)

Spawn `senior-shipper` ONLY if the user prompt matches `/\b(ship|deploy|release|publish|to prod|to production|to staging|app store|play store)\b/i`.

Synthetic prompt — use the **Phase 4 — Shipper** template from `resources/prompt-templates.md`. The template tells the shipper to read `.traffic-one/digests/<run-id>/{reviewer,tester}.md` first (verifying APPROVED + TESTS_GREEN), then plan § Risks/Cut-list. Shipper runs `predeploy-security-check` with `--strict --stamp`, handles the `lastSecurityCheck*` and `lastShipperApprovalAt` stamps, performs the Traffic One deploy (web via Traffic One's own `/deploy`; mobile via EAS App Store / Play Store) — Traffic One does NOT deploy to third-party web hosts — then writes `shipper.md` digest.

If no deploy intent in the user message → end with a "next step: say 'ship it' and Traffic One ships it" line, do NOT spawn shipper.

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

**Delegated digests:** a digest produced by an OpenCode delegation carries
`verdict: DELEGATED_OK` with a `normalize_to:` hint — the runner applied a diff
but verified nothing, so it never claims the canonical token. After YOUR root
verification passes (typecheck/test/build green), normalize the verdict line to
the hinted token yourself with a one-line edit to the digest file (digests are
run bookkeeping under `.traffic-one/`, not feature source — the write gate
allows it). Do NOT spawn an agent just to rewrite a verdict line.

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
PROVIDER=$(node -e "try{const root=process.env.TRAFFIC_ONE_PLUGIN_ROOT||process.env.CURSOR_PLUGIN_ROOT||process.env.CODEX_PLUGIN_ROOT||process.env.CLAUDE_PLUGIN_ROOT||'.'; const {readEffectiveState}=require(require('path').join(root,'scripts/shared/state/local-prefs.js')); console.log(readEffectiveState(process.cwd()).codeGraphProvider||'')}catch{}")
case "$PROVIDER" in
  gitnexus)
    node ~/.traffic-one/bin/gitnexus-runner.cjs
    ;;
  graphify)
    node ~/.traffic-one/bin/graphify-runner.cjs
    ;;
  *)
    # Provider missing/unknown — the postWriteIncompleteWarning hook will
    # nag the user on the next state write. Skip silently here.
    ;;
esac
```

Each runner self-heals and is otherwise a cheap no-op: it rebuilds when the
artefact is missing, older than 7 days, EMPTY (the 0-node onboarding scan), or
STALE (a project source file is newer than the index), and short-circuits as
`fresh` only when none of those hold. So this no-`--force` Phase 5 call still
refreshes an empty/stale index left by a missed Phase 3 step, and is the refresh
that lands on Cursor/Low. (`*LastRunAt` in state is telemetry, not the freshness
gate — the gate is report mtime + empty-guard + source-mtime.) Opt out
per-project with `"codeGraphAutoRun": false`
(provider-agnostic; legacy `"graphifyAutoRun": false` honoured for one
version). This step never blocks the run summary — the runner returns a
structured result and the orchestrator notes the outcome in one line of the
summary, including the PolyForm Noncommercial license reminder when the
provider is gitnexus.

**Then run correlated retention.** Use the cleanup runner rather than ad-hoc
`rm`: it preserves the current/planned run and durable project memory, then
prunes old runs, digests, reports, fix cycles, OpenCode state, backups, `.once`,
stale locks, and debug logs by count/age policy. First dry-run if the summary
needs to show what would change; use `--apply` only for actual cleanup.

```bash
node ~/.traffic-one/bin/traffic-one-cleanup.cjs --dry-run
node ~/.traffic-one/bin/traffic-one-cleanup.cjs --apply
```

Projects may override retention counts with `.traffic-one/retention.json`.

## In-session bookkeeping

- Maintain the host's todo/plan list across the phases. Each phase is one item; subagent runs are sub-items.
- Keep the canonical plan in `.traffic-one/plan.md`. Do NOT duplicate it into the todo/plan list.
- Log each subagent's verdict (`PLAN_READY`, `APPROVED` / `CHANGES_REQUESTED`, `TESTS_GREEN` / `TESTS_FAILING`, Traffic One deploy result) in a single summary at the end.

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
Shipper:     <Traffic One /deploy status, or "not run — say 'ship it' and Traffic One ships it">

Next steps:
- <bullet>
- <bullet>
```

## Hard rules

- The architect runs first on any new project (`mode === "new-project"`) or whenever `.traffic-one/plan.md` is missing.
- On every host, do not silently skip the Traffic One team for matching end-to-end tasks when `team.mode="subagents"` is approved. Auto-spawn the role agents when the runtime exposes an agent adapter and the host permits it. Where the host requires explicit user intent before spawning, always ask for subagent confirmation first for matching multi-layer builds and stop until the user answers; never write plans/files/code or simulate before asking. If confirmation is declined, the user chose Low/main-agent mode, or subagents are unavailable, simulate the same phases manually and state why.
- Frontend ∥ backend in parallel — single message, two subagent calls.
- Reviewer ∥ tester in parallel — single message, two subagent calls.
- ONE agent per role per run: after a role's first spawn, its later tasks are host-specific continuations of that agent (the spawn gate denies duplicates). Never spawn `senior-frontend` twice for parts/fixes — same agent, next message.
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

<!-- GENERATED BY traffic-one: project-local active rules -->
