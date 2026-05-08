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

Read .traffic-one.json. If graphify-out/GRAPH_REPORT.md exists, read it too.

Produce .traffic-one/plan.md (≤250 lines, six sections: Goal, Stack & rationale,
Module map, Public contracts, Risks, Cut-list). Cite skills by name; do not
inline their content.

For `mode: new-project`, run `auto-documentation-generator` after the plan even
when the user did not ask for docs, and create/update the canonical docs needed
for the generated scaffold. For `mode: existing-codebase` or
`existing-with-supabase`, run it before normal feature work to create missing
canonical docs and update existing docs in place.

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
  2. .traffic-one/plan.md § Frontend + § Module map (only your scope)
  3. graphify-out/GRAPH_REPORT.md nodes for `apps/*/src/`, `packages/ui*` (if exists)
  4. Specific source files only when 1–3 don't answer the question.

Implement only the frontend layer of the plan. The other implementer
(senior-backend) is running in parallel — assume their public contract from
the plan; do not invent it. Surface contract gaps in your digest's
"Open questions / blockers" section.

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
  2. .traffic-one/plan.md § Backend + § Public contracts
  3. graphify-out/GRAPH_REPORT.md nodes for `apps/*/server/`, `packages/api*`,
     `services/*`, `supabase/` (if exists)
  4. Specific source / migration files only when 1–3 don't answer the question.

Implement only the backend layer of the plan. The other implementer
(senior-frontend) is running in parallel — assume their public contract from
the plan; do not invent it. If you change a public contract, write the new
signature in your digest's "Public contracts (delta only)" section.

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
  2. `git diff --name-only HEAD`, then `git diff HEAD <file>` ONLY for files
     listed in the digests' "Touched" or "Next-phase reading hints" sections.
  3. graphify-out/GRAPH_REPORT.md nodes that neighbor those files (if exists).
  4. Full file Reads only when a violation requires it.

Verdict format: end with one of
  APPROVED — <one line on why this passes>.
  CHANGES_REQUESTED — <one line summary>.
    1. <file:line> — <issue> — <suggested fix>.
    2. …

If the user asked "safe to ship", production readiness, launch score, or release
approval, also run the `verification-loop` Production-Readiness Score and include
the score, hard blockers, and 12-factor / AWS Well-Architected / OWASP mapping.

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
  2. .traffic-one/plan.md § Public contracts.
  3. `git diff --name-only HEAD` + existing test files adjacent to the touched code.
  4. graphify-out/GRAPH_REPORT.md for related modules (if exists).

Add or update tests for the changed surface. Run them. Verdict format:
  TESTS_GREEN — <count> tests passed; coverage <%> on changed files.
  TESTS_FAILING — <count> failing.
    1. <test name> — <file:line> — <error excerpt>.
    2. …

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
  3. .env.example to surface missing env vars.

Run `predeploy-security-check --strict --stamp`, then run the `verification-loop`
Production-Readiness Score. If the score has hard blockers or is below 80/100
for a production deploy, STOP and route fixes back to the orchestrator.

If release-facing docs changed or are missing, run `auto-documentation-generator`
before stamping shipper approval.

Stamp .traffic-one.json's `lastShipperApprovalAt` field with `nowIso()` BEFORE
running any deploy command (the deploy-gate hook reads this stamp; 10-min
window).

Run the active-stack deploy command. Capture the URL, git SHA, and rollback
command in your digest. Include the Production-Readiness Score in the digest.

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
