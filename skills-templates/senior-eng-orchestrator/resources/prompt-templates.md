# Synthetic-prompt templates for senior-eng-orchestrator

These are the canonical templates the orchestrator uses when spawning each
subagent via `Task`. Substituting placeholders (`<run-id>`, `<user-request>`,
etc.) is the orchestrator's job; the templates stay lean so the subagent's
context stays clean.

## Run-id format

ISO-8601 UTC, second precision, filesystem-safe: `2026-05-07T14-23-05Z`. The
orchestrator generates it once in Phase 0 and passes it to every spawn. On
collision (two parallel orchestrator runs in the same second, rare), append
a 4-char random suffix: `2026-05-07T14-23-05Z-a3f2`.

## Phase 1 — Architect

```
Run-id: <run-id>. The user's request is:

> <user-request quoted verbatim>

Read .traffic-one.json plus existing project memory:
.traffic-one/product.md, .traffic-one/stack.md, .traffic-one/rules/*.md,
.traffic-one/known-issues.md, and .traffic-one/agent-log.md when present.
Also read the codebase-graph artefact at the active provider's location (per
rules/common/codebase-graph.md): `.gitnexus/` when codeGraphProvider is
"gitnexus", `graphify-out/GRAPH_REPORT.md` when "graphify". Skip silently if
missing.

Produce .traffic-one/plan.md (≤250 lines, six sections: Goal, Stack & rationale,
Module map, Public contracts, Risks, Cut-list). Cite skills by name; do not
inline their content.

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

On finish, write your handoff digest to:
  .traffic-one/digests/<run-id>/architect.md
Format and read protocol: rules/common/agent-handoff-digests.md.

Token budget: ~8k for reads, ~3k for writes. End your reply with the literal
token PLAN_READY on its own line.
```

## Phase 2 — Frontend (parallel with Backend)

```
Run-id: <run-id>. The architect digest is at:
  .traffic-one/digests/<run-id>/architect.md

Read in priority order:
  1. .traffic-one/digests/<run-id>/architect.md
  2. .traffic-one/product.md, .traffic-one/stack.md, .traffic-one/rules/coding.md,
     .traffic-one/known-issues.md if present
  3. .traffic-one/plan.md § Frontend + § Module map (only your scope)
  4. Codebase-graph artefact at active provider's location (per
     rules/common/codebase-graph.md): `.gitnexus/` for gitnexus,
     `graphify-out/GRAPH_REPORT.md` for graphify. Scope to `apps/*/src/`,
     `packages/ui*` nodes.
  5. Specific source files only when 1–4 don't answer the question.

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

On finish, write your digest to:
  .traffic-one/digests/<run-id>/frontend.md

Token budget: ~12k total. Don't read more than ~3 files outside the scope
above unless the digest/plan/graph all came up empty for the question.

End your reply with a one-line status of what you produced and what's
pending.
```

## Phase 2 — Backend (parallel with Frontend)

```
Run-id: <run-id>. The architect digest is at:
  .traffic-one/digests/<run-id>/architect.md

Read in priority order:
  1. .traffic-one/digests/<run-id>/architect.md
  2. .traffic-one/product.md, .traffic-one/stack.md, .traffic-one/rules/security.md,
     .traffic-one/schema.sql, .traffic-one/known-issues.md if present
  3. .traffic-one/plan.md § Backend + § Public contracts
  4. Codebase-graph artefact at active provider's location (per
     rules/common/codebase-graph.md): `.gitnexus/` for gitnexus,
     `graphify-out/GRAPH_REPORT.md` for graphify. Scope to `apps/*/server/`,
     `packages/api*`, `services/*`, `supabase/` nodes.
  5. Specific source / migration files only when 1–4 don't answer the question.

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
Run-id: <run-id>. The implementer digests are at:
  .traffic-one/digests/<run-id>/frontend.md
  .traffic-one/digests/<run-id>/backend.md

Read in priority order:
  1. Both implementer digests above.
  2. .traffic-one/rules/coding.md, .traffic-one/rules/security.md,
     .traffic-one/known-issues.md, and .traffic-one/.agentignore if present.
  3. `git diff --name-only HEAD`, then `git diff HEAD <file>` ONLY for files
     listed in the digests' "Touched" or "Next-phase reading hints" sections.
  4. Codebase-graph artefact at active provider's location (per
     rules/common/codebase-graph.md): `.gitnexus/` or
     `graphify-out/GRAPH_REPORT.md`. Use it to find neighbors of changed
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
Run-id: <run-id>. The implementer digests are at:
  .traffic-one/digests/<run-id>/frontend.md
  .traffic-one/digests/<run-id>/backend.md

Read in priority order:
  1. Both implementer digests above.
  2. .traffic-one/product.md, .traffic-one/known-issues.md, and
     .traffic-one/schema.sql if present.
  3. .traffic-one/plan.md § Public contracts.
  4. `git diff --name-only HEAD` + existing test files adjacent to the touched code.
  5. Codebase-graph artefact at active provider's location (per
     rules/common/codebase-graph.md): `.gitnexus/` or
     `graphify-out/GRAPH_REPORT.md`. Use it to find related modules and call
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
Run-id: <run-id>. The reviewer + tester digests are at:
  .traffic-one/digests/<run-id>/reviewer.md     (must contain "verdict: APPROVED")
  .traffic-one/digests/<run-id>/tester.md       (must contain "verdict: TESTS_GREEN")

Read in priority order:
  1. Both verifier digests above. If either is not green/approved, STOP and
     report; do not stamp shipper approval.
  2. .traffic-one/plan.md § Risks + § Cut-list.
  3. .traffic-one/deployments.jsonl, .traffic-one/stack.md,
     .traffic-one/known-issues.md, and .traffic-one/mcp.json if present.
  4. .env.example to surface missing env vars.

Run `predeploy-security-check --strict --stamp`, then run the `verification-loop`
Production-Readiness Score. If the score has hard blockers or is below 80/100
for a production deploy, STOP and route fixes back to the orchestrator.

If release-facing docs or project memory changed or are missing, run
`project-memory` and `auto-documentation-generator` before stamping shipper
approval.

Stamp .traffic-one.json's `lastShipperApprovalAt` field with `nowIso()` BEFORE
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
