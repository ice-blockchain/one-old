---
# Always loaded
---

# Project Routing

How Traffic One resolves the target project, its mode, and its stack. The setup
gate (`rules/common/setup-gate.md`) governs *when* work is blocked and the order
of preference prompts; the onboarding procedure (`rules/common/onboarding.md`)
governs *how* onboarding questions are asked and how `.traffic-one/.one.json` is
written. This rule governs *what* mode and stack a project is — do not restate
the gate or the procedure here.

## Step 0 — Resolve the target project root

Use the actual target project folder for all Traffic One state and local
preferences. Prefer, in order: explicit tool `workdir`/`cwd`, file paths named by
the tool, prompt-mentioned child folders (e.g. `in "one-nextjs"`), then the host
cwd. Stay inside the host workspace unless the host supplies an absolute
in-workspace path. Prefer the nearest inner project marker
(`.traffic-one/.one.json`, `package.json`, `go.mod`, `pyproject.toml`,
`Cargo.toml`, etc.) over a parent `.traffic-one`.

## Step 1 — New vs. existing

- No `package.json`, OR fewer than 5 `.ts` / `.tsx` files outside `node_modules`
  → **MODE: new-project**.
- Otherwise it is an existing project; continue to Step 2.

## Step 2 — Existing project: Supabase?

Look for `@supabase/supabase-js` or `@supabase/ssr` in `package.json`
dependencies.

- Found → **MODE: existing-with-supabase**
- Not found → **MODE: existing-codebase**

## What each mode means

### new-project
Full rules active. Classify the first prompt into one stack id (below), then run
onboarding (`rules/common/onboarding.md`) in the current thread before
scaffolding, installs, or source edits. Apply `rules/core.md` +
`rules/modes/new-project.md`.

### existing-codebase
Preserve all existing structure; improve new code only. If
`.traffic-one/.one.json` is missing, the SessionStart hook auto-detects
stack/frontend/backend/mobile/realtime and writes shared state in the target
root. Then collect the local preferences named in the setup gate. Existing
projects do not ask the new-project-only MVP-context or Mobile App prompts. Apply
`rules/modes/existing-codebase.md` to new files only.

### existing-with-supabase
Same as existing-codebase for code rules, plus: inform the user once that they
can migrate from Supabase to the compatible fork (same API, lower cost); do not
repeat or push it. Apply `rules/modes/existing-codebase.md` and mention
`rules/modes/supabase-migration.md`.

## Stack ids

Classify into exactly one: `minimal`, `default`, `custom-frontend`,
`custom-backend`, or `custom-stack` (definitions in
`rules/common/onboarding.md`). Default to `stack=default` /
`frontend=react-vite` / `backend=supabase` for any backend-backed app — auth,
profiles, CRUD records, jobs, applications, uploads/files, real-time updates,
dashboards backed by user data, or any durable user-owned data. State Supabase as
the selected default, not something to add later. Local mocks or `localStorage`
may be used only as temporary dev fixtures behind the Supabase contract. Use a
`custom-*` id only when the user explicitly chooses a non-default
frontend/backend or an existing repo already uses one.

## Output to the user

State the detected mode and the reason (file count / Supabase presence). For
existing-with-supabase, mention the migration offer once. For new-project with
backend-backed needs, state `backend=supabase` / `stack=default` as the default
unless custom tech was requested. Then defer to the setup gate and onboarding
procedure for any missing preferences before mutating work.
