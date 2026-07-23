---
description: "Apply when spawning, resuming, or completing subagent/role work: the handoff digest contract between agents (write digests/<runId>/<role>.md, read predecessors first)."
# Always loaded. The handoff contract between subagents in the
# senior-eng-orchestrator flow. Cuts redundant codebase reads across phases.
---

# Agent handoff digests — token-cheap phase-to-phase contract

Each subagent in the senior-engineer orchestrator flow (`senior-architect`,
`senior-frontend`, `senior-backend`, `senior-reviewer`, `senior-tester`,
`senior-shipper`) writes a small digest file at the end of its run. Downstream
subagents **read the digest first** instead of re-reading the diff or
re-grepping the repo.

## Digest path

`.traffic-one/digests/<run-id>/<role>.md`

- `<run-id>` — the exact `currentRunId` persisted by Traffic One (new runs use
  an epoch-millisecond digit string). The orchestrator reads it once in Phase 0
  and passes that exact value to every subagent; roles never synthesize or
  reformat a run id.
- `<role>` — one of `architect`, `frontend`, `backend`, `reviewer`, `tester`,
  `shipper`. One file per role, overwritten on re-spawn within the same run
  (e.g. when reviewer requests changes and the implementer runs again).

## Digest shape (target ≤2 KB / ~500 tokens)

```markdown
# <role> digest — run <run-id>

verdict: <YOUR OWN role's token ONLY — architect: PLAN_READY · frontend/backend: IMPLEMENTED or BLOCKED <one-line reason> · reviewer: APPROVED or CHANGES_REQUESTED · tester: TESTS_GREEN or TESTS_FAILING · shipper: SHIPPED or FAILED. Never borrow another role's token: an implementer digest must not say PLAN_READY, APPROVED, or CHANGES_REQUESTED (observed live: a backend digest claiming PLAN_READY and a frontend digest claiming CHANGES_REQUESTED).>
finished_at: <ISO-8601 UTC — run `date -u +%Y-%m-%dT%H:%M:%SZ` for the real value; never guess, hand-compute an elapsed time, or write a midnight/future placeholder. Traffic One host-stamps this line with the real write-time and OVERWRITES any value that is malformed, in the future, dated before the run began, or minutes older than the actual write (stale/backdated) — a fabricated timestamp is silently corrected, not trusted.>

## Touched
- path/to/file.ts        # one-line note on what changed
- path/to/other.tsx      # …

## Public contracts (delta only)
- `getJobs(filter)` → `Promise<Job[]>` — added `filter.status?: JobStatus`.

## Open questions / blockers / assumptions
- Backend assumed `Job.status` is a string union; if it's an enum, frontend hook breaks.

## Next-phase reading hints
- reviewer: focus on `apps/web/src/features/jobs/api.ts` and `supabase/migrations/0002_jobs.sql`.
- tester: cover the four new endpoints; existing fixtures at `tests/fixtures/jobs.ts`.
```

Sections are markdown headers; the verdict + finished_at lines at the top are
machine-readable. **No prose preambles, no full-file dumps.** If you want to
explain something at length, link out to a doc — don't inline it.

## Read protocol (every downstream subagent follows this order)

1. **Predecessor digest(s)** — `.traffic-one/digests/<run-id>/<predecessor>.md`.
   Architect-frontend-backend → reviewer reads `frontend.md` + `backend.md`.
   Reviewer-tester → shipper reads both.
2. **The plan section** the digest pointed at (`.traffic-one/plan.md` § X).
3. **Codebase-graph artefact** per `rules/common/codebase-graph.md`
   (provider-specific path).
4. **Raw `git diff`, `Glob`, `Grep`, `Read`** — only when 1–3 don't answer it.

The orchestrator passes digest paths in synthetic prompts; subagents read the
digest themselves rather than receiving content inline.

## Size cap — STRICT

**Target ≤ 2 KB. Hard cap 3 KB.** A PostToolUse hook (`runPostStackSetup` →
digest branch) emits a `systemMessage` reminder when a digest write exceeds 3 KB
and instructs the subagent to re-write before completing its turn.

Write less. The downstream subagent reads this digest INSTEAD of the diff;
bloat directly defeats the token-economy layer.

## Touched section — paths only, no commentary

**BAD** (counted: ~280 chars per line, parenthetical bloat):

```
- /Users/john/Documents/projects/test-project/packages/ui/{package.json,tsconfig.json,src/globals.css,src/lib/utils.ts,src/index.ts,src/components/ui/*.tsx} (24 shadcn primitives + Toaster + Spinner + EmptyState + Form helpers)
```

**GOOD** (~70 chars; repo-relative; no annotation):

```
- packages/ui/{components/ui/*.tsx,lib/utils.ts,index.ts}
- packages/ui/src/globals.css
```

Rules for this section:

- **Repo-relative paths only.** Drop `/Users/...`, `/Volumes/...`, `~/`. The
  reader is looking at the same repo.
- **No parenthetical descriptions** ("4-step + framer-motion stepper",
  "real Supabase helpers when env present, mock fallback otherwise").
  If a fact matters that much, put it in "Public contracts (delta only)".
- **Glob-collapse siblings.** `packages/ui/components/ui/*.tsx` is enough;
  don't enumerate 24 file names.

## Public contracts — delta only

**BAD** (lists every existing hook):

```
- `useGetMyProfileQuery`, `useUpdateMyProfileMutation`, `useSetMockRoleMutation`,
  `useListJobsQuery(filters)`, `useListFeaturedJobsQuery()`, `useGetJobBySlugQuery(slug)`,
  `useGetRelatedJobsQuery(slug)`, `useListMyJobsQuery()`, `useListCategoriesQuery()`,
  `useCreateJobMutation`, …
```

**GOOD** (only what changed vs the plan, with a one-liner for context):

```
- All RTK Query hooks per plan § Frontend — no signature changes.
- Added: `useUpdateApplicationStatusMutation({id, status, jobId})`.
  `jobId` is consumed by tag invalidation only; not part of the URL.
- Removed: `useDeleteJobMutation` — moved server-side via Edge Function.
```

If nothing in your scope changed the public surface, write
"No contract delta vs plan." — that's the entire section. Don't pad.

## Open questions / blockers / assumptions

≤3 bullets. Each ≤2 lines. Link to the plan section by name (`§ Public
contracts`, `§ Risks`) instead of restating it.

## Next-phase reading hints

≤4 bullets. Tell the next subagent which **2–4 files** are most important.
Do not list everything.

## Reviewer findings — ≤3 sentences per blocker, link out for depth

The reviewer digest tends to bloat: deep audits naturally want full
reproduction steps, line-by-line analysis, and three-paragraph remediation
plans per blocker. **The digest is not the place for that.** Implementer
subagents read the verdict + the file:line + the one-sentence fix and act
on it; they do not re-read the entire reviewer reasoning.

**BAD** (one blocker = ~40 lines of prose):

```
1. supabase/migrations/0002_rls.sql:46-52 (RLS policy) ↔ apps/web/src/features/auth/useSession.ts:35-45 (`applyPendingSignUpProfile()`) — **role-self-promotion via authenticated profiles.update**. The `profiles_update_own` policy permits the owner to update ANY column on their own row, including `role`. The new auth flow stashes `{ email, role, fullName, companyName }` in sessionStorage and, on the first authenticated session, runs `client.from('profiles').update({ role: pending.role, ... }).eq('id', userId)`. A user can sign up as `candidate`, tamper with `sessionStorage[...]` to set `"role":"employer"`, sign in, and the update succeeds (RLS allows owner-writes on every column). … [continues for 30 more lines with three fix alternatives]
```

**GOOD** (one blocker = ≤3 sentences; depth in a sibling note):

```
1. supabase/migrations/0002_rls.sql:46 — `profiles_update_own` allows
   role self-promotion. Combined with `useSession.ts:38`
   (`applyPendingSignUpProfile` writing `pending.role`), any candidate can
   become employer by tampering with sessionStorage. Fix:
   `with check (… and role = (select p.role from profiles p where p.id =
   auth.uid()))`. **Detail:** see `.traffic-one/digests/<run-id>/reviewer-detail-1.md`.
```

The **spillover note** (`.traffic-one/digests/<run-id>/reviewer-detail-<n>.md`)
is the place for full reproduction steps, three alternative fixes,
threat-model context, and ADR cross-references. Implementer subagents read
the spillover note ONLY when the one-sentence fix is ambiguous; the
orchestrator's read protocol still puts the digest first. The hard cap
(3 KB) applies to the digest, not to spillover notes — those can be as long
as the audit needs.

## Hard rules

- Write your digest **before** emitting the terminal status token (PLAN_READY,
  APPROVED, etc.) — the orchestrator reads the digest after the spawn returns.
- **Repo-relative paths.** Absolute paths cost ~60 chars per line for nothing.
- **No parenthetical annotations on Touched.** Use "Public contracts (delta only)"
  for facts that matter.
- **Cap your digest at 2 KB target / 3 KB hard.** If you exceed 3 KB the hook
  will warn — re-write before completing the turn.
- Overwrite, don't append. Re-spawned implementers replace their previous
  digest entirely.
- Never put credentials, env values, or full file contents in a digest.
- The digest path is exempt from the plan-gate hook (it's under
  `.traffic-one/`) — for the Write/Edit tools AND for Bash heredocs/redirects
  whose only write targets are `.traffic-one/digests/`, `fix-cycles/`, or
  `runs/` paths (read-only roles persist digests this way); architect can
  write `digests/<run-id>/architect.md` before `plan.md` exists if needed,
  but normal order is plan first.
