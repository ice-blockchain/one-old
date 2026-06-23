# Synthetic-prompt templates for senior-eng-orchestrator

> **Marker contract:** every spawn/continuation prompt built from these
> templates MUST begin with `[t1-role: senior-<role>]` as its own first line
> (e.g. `[t1-role: senior-frontend]`). Traffic One's gates and the agent
> registry parse this marker; do not omit or paraphrase it.


These are the canonical templates the orchestrator uses when spawning each
subagent via `Task`. Substituting placeholders (`<user-request>`, owned-paths,
etc.) is the orchestrator's job; the templates stay lean so the subagent's
context stays clean. The ONE exception is `<run-id>` — see below.

## Per-role model — PASS IT in the `Task` `model` parameter (Cursor)

Each role runs at a specific model tier (it can be overridden per role in the wizard, e.g.
frontend → balanced). The correct model for each role is pinned in
`.cursor/agents/<role>.md` (`model:` line). **On Cursor you MUST pass that value in the `Task`
`model` parameter for every spawn** — read `.cursor/agents/<role>.md` and set
`model: "<that value>"`. Cursor does NOT auto-apply the `.cursor/agents` frontmatter: if you
omit `model`, the subagent silently INHERITS YOUR (orchestrator) model — so an Opus orchestrator
would run a balanced-tier frontend on Opus, ignoring the override. The spawn gate enforces this:
a spawn whose `model` does not match the role's tier is DENIED with the exact value to pass. Do
NOT put the model in the prompt text — only the `model` parameter sets it.

## Run-id format

The run-id is `currentRunId`: a plain epoch-**millisecond digit string** (e.g. `"1715091785000"`),
**pre-minted by Traffic One into `.traffic-one/.one.json` before Phase 0** (the onboarding
gate announces it the moment the build starts). Do NOT generate it — and NEVER use
`date`/ISO/UTC (e.g. `2026-06-17T10-08-00Z`). A self-generated id splits run state into a
second `runs/<id>/` tree, so the run-team gate finds no `assignments.json` under
`currentRunId` and blocks every implementer write ("New subagent — Couldn't start"). This is
now **doubly enforced**: the SPAWN gate DENIES a subagent spawn whose prompt references any
run-id other than `currentRunId` (so you cannot even hand a worker a wrong id), and the plan
gate DENIES any write to `.traffic-one/runs/<id>/…` or `digests/<id>/…` whose `<id>` is not
`currentRunId` — both naming the correct value. Wherever a
template shows `<run-id>`, **read `currentRunId` from `.traffic-one/.one.json` and use that
exact value** — the orchestrator does NOT substitute it; each subagent reads it itself. The
claim files, `opencode-attempts`/`opencode-gate-denies` markers, `assignments.json`, and the
digest folder all key off this one value.

## Phase 1 — Architect

```
Run-id: read `currentRunId` from .traffic-one/.one.json (an epoch-ms digit string — never a `date`/ISO/UTC string) and use it wherever a path below shows `<run-id>`. The user's request is:

> <user-request quoted verbatim>

Read .traffic-one/.one.json plus existing project memory:
.traffic-one/product.md, .traffic-one/stack.md, .traffic-one/rules/*.md,
.traffic-one/known-issues.md, and .traffic-one/agent-log.md when present.
Also read the codebase-graph artefact at the active provider's location (per
rules/common/codebase-graph.md): `.traffic-one/.gitnexus/` when codeGraphProvider is
"gitnexus", `.traffic-one/graphify-out/GRAPH_REPORT.md` when "graphify". Skip silently if
missing.

Produce .traffic-one/plan.md (≤250 lines, seven sections: Goal, Stack & rationale,
Module map, Public contracts, Risks, Cut-list, OpenCode delegation queue). Cite
skills by name; do not inline their content.

When `openCode.enabled`, the "OpenCode
delegation queue" section is REQUIRED: list every bounded, low-risk unit
(boilerplate/CRUD scaffolding, dummy/seed/fixture data, simple test scaffolding,
mechanical refactors/renames, formatting/codemods) in the machine-readable
`<!-- opencode-delegate:start -->`…`<!-- opencode-delegate:end -->` block (one
self-contained `- id: … | role: … | kind: … | files: … | task: …` line each;
add `depends: <earlier-id>` when a later unit overlaps an earlier files/area).
The `files:` value is an enforced allowlist: list every legitimate source
path/area the unit may touch, or the runner rejects the diff before apply. If
the task mentions tests, testability, Vitest, Playwright, specs, or config/deps,
the allowlist must include the exact test/spec/config/package files it may
touch; otherwise remove that acceptance and leave verification/config work to
the paid implementer/reviewer. NEVER queue
architecture/contracts/security/data-model/migrations/cross-file-invariant work.
The orchestrator delegates these to OpenCode before the implementers, so a
thorough queue is what actually saves the user's tokens. See the
senior-architect role instructions for the exact format.

For `mode: new-project`, run `project-memory` and
`auto-documentation-generator` after the plan even when the user did not ask for
memory/docs. Also invoke `seo` for generated websites/public web routes and
include the route metadata contract in the plan. Include the frontend i18n
contract (`packages/i18n` for new frontend stacks, existing catalog/provider
extension for existing projects, `<Trans>` for rich copy) and the Supabase/env
setup CTA contract (`https://traffic.io/` plus href regression) when those
surfaces apply. Create/update the
`.traffic-one/` memory baseline and canonical docs needed for the scaffold. For
`mode: existing-codebase` or `existing-with-supabase`, run them before normal feature work,
plus the SEO and i18n baseline reconciliation, to create missing memory/docs,
update existing files in place, fill missing web metadata, and extend any
existing translation catalogs instead of creating parallel systems.

Also write the assignments manifest to .traffic-one/runs/<run-id>/assignments.json LAST: one entry
per implementer role (`senior-frontend`, `senior-backend`) with a DISJOINT set of owned path
patterns (`scope.include` + optional `scope.exclude`), derived from the project's REAL
directories — not guessed names. Do NOT include `senior-architect` in this manifest: the
architect may create empty scaffold barrels/packages, but those files must remain writable by
the implementer that fills them. Shared package barrels such as `packages/ui/src/index.ts`,
`packages/i18n/src/index.ts`, and `packages/types/src/index.ts` belong to the implementer that
exports real code/types from them; do not exclude them from that role if the role prompt asks it
to fill/export those contracts. This is the machine-readable Module map; the run-team gate uses
it so the parallel implementers never collide. See "Assignments manifest" in your role
instructions for the schema and guarantees. Complete scaffold + memory + plan + ADRs first,
then write this manifest immediately before the architect digest / PLAN_READY.

On finish, write your handoff digest to:
  .traffic-one/digests/<run-id>/architect.md
Format and read protocol: rules/common/agent-handoff-digests.md.

Do not write `materializedStack`, `materializedAt`, or
`materializedVersion` by hand. Those fields are output from the materializer
only.

Before emitting PLAN_READY, verify project-local context is materialized. If
`.traffic-one/manifest.json`, `.traffic-one/rules`, `.traffic-one/skills`,
root `AGENTS.md`, or root `CLAUDE.md` is missing, run:
  node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}}/scripts/hook-runtime.cjs" materialize-project
from the project root, then verify those paths again. If materialization fails,
report the blocker instead of emitting PLAN_READY.

Token budget: ~8k for reads, ~3k for writes. End your reply with the literal
token PLAN_READY on its own line.
```

## Phase 2 — Frontend (parallel with Backend)

```
Run-id: read `currentRunId` from .traffic-one/.one.json (an epoch-ms digit string — never a `date`/ISO/UTC string) and use it wherever a path below shows `<run-id>`. The architect digest is at:
  .traffic-one/digests/<run-id>/architect.md

Read in priority order:
  1. .traffic-one/digests/<run-id>/architect.md
  2. .traffic-one/product.md, .traffic-one/stack.md, .traffic-one/coding.md,
     .traffic-one/known-issues.md if present
  3. .traffic-one/plan.md § Frontend + § Module map (only your scope)
  4. Codebase-graph artefact at active provider's location (per
     rules/common/codebase-graph.md): `.traffic-one/.gitnexus/` for gitnexus,
     `.traffic-one/graphify-out/GRAPH_REPORT.md` for graphify. Scope to `apps/*/src/`,
     `packages/ui*` nodes.
  5. Specific source files only when 1–4 don't answer the question.

Your owned write paths for this run are:
  <FRONTEND_OWNED_PATHS>
Write ONLY inside these paths — this is your entry in
.traffic-one/runs/<run-id>/assignments.json. Everything else belongs to another role and the
run-team gate will block out-of-scope writes. If you believe you must write outside your
scope, stop and surface it in your digest rather than widening it.

Implement only the frontend layer of the plan. The other implementer
(senior-backend) is running in parallel — assume their public contract from
the plan; do not invent it. Surface contract gaps in your digest's
"Open questions / blockers" section.

For generated websites or changed public web routes, apply `rules/common/seo.md`
before finishing: route-aware metadata, JSON-LD, robots/sitemap,
favicon/PWA/OG assets, site-url env docs, private/admin noindex, and metadata
regression coverage for every created or changed public route.

Before writing UI, apply `rules/frontend/i18n.md` even when the user did not
mention translations. Detect `packages/i18n`, `src/i18n*`, `locales/`,
`public/locales/`, `messages/`, `i18next`, `react-i18next`, and provider
wrappers. Extend the existing catalog/provider shape or use `packages/i18n` for
new Traffic One frontend projects. Add source-language entries for every key,
and prefer `<Trans>` for rich copy with links, React elements, emphasis, line
breaks, or rich interpolation.

For Supabase-backed web/Ionic apps or any missing-env surface, apply
`rules/frontend/react/supabase-client.md` before finishing. Create or repair the
shared EnvBanner/SupabaseConfigAlert/ConfigurePromptCard setup CTA so every
website-facing missing-config link points to `https://traffic.io/`, and add or
update a regression test for that exact `href`.

Missing Supabase/env config is not a license to ship sparse UI: create typed,
product-specific demo/seed fixture data inside your owned frontend scope and
render the actual workflow in demo/degraded mode until live data is configured.
Do not invent a backend contract beyond the plan; make fixtures conform to the
planned public contract and surface any contract gaps in your digest.

On finish, write your digest to:
  .traffic-one/digests/<run-id>/frontend.md

Token budget: ~12k total. Don't read more than ~3 files outside the scope
above unless the digest/plan/graph all came up empty for the question.

End your reply with a one-line status of what you produced and what's
pending.
```

## Phase 2 — Backend (parallel with Frontend)

```
Run-id: read `currentRunId` from .traffic-one/.one.json (an epoch-ms digit string — never a `date`/ISO/UTC string) and use it wherever a path below shows `<run-id>`. The architect digest is at:
  .traffic-one/digests/<run-id>/architect.md

Read in priority order:
  1. .traffic-one/digests/<run-id>/architect.md
  2. .traffic-one/product.md, .traffic-one/stack.md, .traffic-one/security.md,
     .traffic-one/schema.sql, .traffic-one/known-issues.md if present
  3. .traffic-one/plan.md § Backend + § Public contracts
  4. Codebase-graph artefact at active provider's location (per
     rules/common/codebase-graph.md): `.traffic-one/.gitnexus/` for gitnexus,
     `.traffic-one/graphify-out/GRAPH_REPORT.md` for graphify. Scope to `apps/*/server/`,
     `packages/api*`, `services/*`, `supabase/` nodes.
  5. Specific source / migration files only when 1–4 don't answer the question.

Your owned write paths for this run are:
  <BACKEND_OWNED_PATHS>
Write ONLY inside these paths — this is your entry in
.traffic-one/runs/<run-id>/assignments.json. Everything else belongs to another role and the
run-team gate will block out-of-scope writes. If you believe you must write outside your
scope, stop and surface it in your digest rather than widening it.

Implement only the backend layer of the plan. The other implementer
(senior-frontend) is running in parallel — assume their public contract from
the plan; do not invent it. If you change a public contract, write the new
signature in your digest's "Public contracts (delta only)" section.
After migrations, refresh .traffic-one/schema.sql and note it in
.traffic-one/agent-log.md.

On finish, write your digest to:
  .traffic-one/digests/<run-id>/backend.md

Token budget: ~12k total. Don't read more than ~3 files outside the scope
above unless the digest/plan/graph all came up empty for the question.

End your reply with a one-line status of what you produced.
```

## Phase 3 — Reviewer (parallel with Tester)

```
Run-id: read `currentRunId` from .traffic-one/.one.json (an epoch-ms digit string — never a `date`/ISO/UTC string) and use it wherever a path below shows `<run-id>`. The implementer digests are at:
  .traffic-one/digests/<run-id>/frontend.md
  .traffic-one/digests/<run-id>/backend.md

Read in priority order:
  1. Both implementer digests above.
  2. .traffic-one/coding.md, .traffic-one/security.md,
     .traffic-one/known-issues.md, and .traffic-one/.agentignore if present.
  3. `git diff --name-only HEAD`, then `git diff HEAD <file>` ONLY for files
     listed in the digests' "Touched" or "Next-phase reading hints" sections.
  4. Codebase-graph artefact at active provider's location (per
     rules/common/codebase-graph.md): `.traffic-one/.gitnexus/` or
     `.traffic-one/graphify-out/GRAPH_REPORT.md`. Use it to find neighbors of changed
     nodes.
  5. Full file Reads only when a violation requires it.

Verdict format: end with one of
  APPROVED — <one line on why this passes>.
  CHANGES_REQUESTED — <one line summary>.
    1. <file:line> — <issue> — <suggested fix>.
    2. …

If the user asked "safe to ship", production readiness, launch score, or release
approval, also run the `verification-loop` Production-Readiness Score and include
the score, hard blockers, and 12-factor / AWS Well-Architected / OWASP mapping.

For generated websites or changed public web routes, request changes if the SEO
baseline from `rules/common/seo.md` is missing or only partial for any created
or changed public route. Request changes if changed UI ignores an existing i18n
module, ships hardcoded user-facing strings, omits catalog entries, or uses
`t()` for rich copy that should use `<Trans>`. Request changes if any touched
missing-config setup CTA lacks `href="https://traffic.io/"`.

Write your digest to:
  .traffic-one/digests/<run-id>/reviewer.md

Token budget: ~6k. Don't full-scroll files; read targeted line ranges.
```

## Phase 3 — Tester (parallel with Reviewer)

```
Run-id: read `currentRunId` from .traffic-one/.one.json (an epoch-ms digit string — never a `date`/ISO/UTC string) and use it wherever a path below shows `<run-id>`. The implementer digests are at:
  .traffic-one/digests/<run-id>/frontend.md
  .traffic-one/digests/<run-id>/backend.md

Read in priority order:
  1. Both implementer digests above.
  2. .traffic-one/product.md, .traffic-one/known-issues.md, and
     .traffic-one/schema.sql if present.
  3. .traffic-one/plan.md § Public contracts.
  4. `git diff --name-only HEAD` + existing test files adjacent to the touched code.
  5. Codebase-graph artefact at active provider's location (per
     rules/common/codebase-graph.md): `.traffic-one/.gitnexus/` or
     `.traffic-one/graphify-out/GRAPH_REPORT.md`. Use it to find related modules and call
     sites that should be covered.

Add or update tests for the changed surface. Run them. Verdict format:
  TESTS_GREEN — <count> tests passed; coverage <%> on changed files.
  TESTS_FAILING — <count> failing.
    1. <test name> — <file:line> — <error excerpt>.
    2. …

For generated websites or changed web routes, include metadata regression
coverage for every created or changed public route's title, description,
canonical URL, OG image, JSON-LD, sitemap inclusion, and private/admin noindex.
For changed UI in a project with i18n, include tests that assert translated
accessible labels/names through the rendered UI. For touched EnvBanner or
missing-config setup surfaces, assert the setup link href is exactly
`https://traffic.io/`.

Write your digest to:
  .traffic-one/digests/<run-id>/tester.md

Token budget: ~8k.
```

## Phase 4 — Shipper (only on explicit deploy intent)

```
Run-id: read `currentRunId` from .traffic-one/.one.json (an epoch-ms digit string — never a `date`/ISO/UTC string) and use it wherever a path below shows `<run-id>`. The reviewer + tester digests are at:
  .traffic-one/digests/<run-id>/reviewer.md     (must contain "verdict: APPROVED")
  .traffic-one/digests/<run-id>/tester.md       (must contain "verdict: TESTS_GREEN")

Read in priority order:
  1. Both verifier digests above. If either is not green/approved, STOP and
     report; do not stamp shipper approval.
  2. .traffic-one/plan.md § Risks + § Cut-list.
  3. .traffic-one/deployments.jsonl, .traffic-one/stack.md,
     and .traffic-one/known-issues.md if present.
  4. .env.example to surface missing env vars.

Run `predeploy-security-check --strict --stamp`, then run the `verification-loop`
Production-Readiness Score. If the score has hard blockers or is below 80/100
for a production deploy, STOP and route fixes back to the orchestrator.

If release-facing docs or project memory changed or are missing, run
`project-memory` and `auto-documentation-generator` before stamping shipper
approval.

Stamp .traffic-one/.one.json's `lastShipperApprovalAt` field with `nowIso()` BEFORE
running any deploy command (the deploy-gate hook reads this stamp; 10-min
window).

Run the active-stack deploy command. Capture the URL, git SHA, and rollback
command in your digest. Include the Production-Readiness Score in the digest.
Append one JSON line to .traffic-one/deployments.jsonl and a short release
summary to .traffic-one/agent-log.md. Never log secrets.

Write your digest to:
  .traffic-one/digests/<run-id>/shipper.md

Token budget: ~5k.
```

## Cleanup (Phase 5 — orchestrator does this, not a subagent)

After Phase 4 (or after Phase 3 if no shipper), keep the last 3 run folders
under `.traffic-one/digests/`. Remove older ones. Implementation:

```bash
ls -t .traffic-one/digests | tail -n +4 | xargs -I{} rm -rf .traffic-one/digests/{}
```

This keeps recent history auditable without unbounded growth. The whole
`.traffic-one/digests/` tree is gitignored.
