---
name: supabase-setup
description: PROACTIVELY walk a beginner through getting a real Supabase backend connected to a fresh project AND apply the local migrations to it. TRIGGER on "set up Supabase", "configure Supabase", "connect Supabase", "I don't have keys yet", "where do I get the URL", "where's my anon key", "how do I link my project", "run migrations", "apply schema", "auto run supabase", or whenever a `new-project` scaffold has just written `supabase/migrations/*.sql` and `.env.local` is still missing or empty. Cloud-first by default — also offers the fully-automatic local-first path (`pnpm db:start`, Docker required) for users who want zero dashboard work. After this skill runs, the schema is live and the `<EnvBanner />` is gone — do not finish a scaffold by listing manual SQL-editor steps in README; invoke this skill.
---

# Supabase setup — get keys, link, and push migrations

Goal: take a project that has `backend=supabase` in `.traffic-one/.one.json` plus
local migrations under `supabase/migrations/`, and end with a Supabase
project provisioned, keys pasted, **migrations applied to that project**,
types generated, and the `<EnvBanner />` gone.

## When to invoke this skill

- Right after scaffolding a new project that includes Supabase migrations —
  do not finish the scaffold with "open the SQL editor and run this file"
  in README. Run this skill so the schema actually lands.
- When the user explicitly asks ("set up Supabase", "where's my anon key",
  "how do I run migrations", "auto run the supabase scripts").
- When generating Supabase code in a project where `.env.local` is missing or
  `VITE_SUPABASE_URL` is empty.

## Pre-flight

1. Confirm `.traffic-one/.one.json` has `backend: "supabase"`. If not, this skill
   isn't the right call — invoke `stack-setup` first.
2. Confirm `package.json` has `supabase` as a `devDependency` and the standard
   scripts (`db:start`, `db:push`, `db:reset`, `gen:types`, `functions:deploy`,
   `link`). If missing, write them per `rules/modes/new-project.md` Step 6
   before continuing.
3. Confirm `supabase/` exists with at least `config.toml` and one
   `migrations/<timestamp>_*.sql` file. If empty, scaffold migrations first.

## Two paths — pick one with the user before you start

Ask once, in one short paragraph:

> "I can wire Supabase one of two ways:
>  **(A) Cloud** — you create a remote project at supabase.com (~2 min,
>  free tier), I link your repo and push the migrations for you. Best when
>  you want a real internet-reachable URL right away.
>  **(B) Local auto-run** — I run `pnpm db:start` (requires Docker Desktop)
>  which boots Postgres + Auth + Storage in containers, applies your
>  migrations on boot, and prints the local URL + keys — fully automatic,
>  zero dashboard. Best when you just want to keep building.
>  Which one?"

Default to **(A) Cloud** if the user gives no answer. Each path below is
self-contained — do not interleave.

---

## Path A — Cloud (link + push migrations)

### A1. Create the Supabase project (Dashboard)
> "Open https://supabase.com/dashboard in a new tab → click **New project**.
>  Pick the region closest to your users, set a strong DB password (save it
>  in a password manager — you'll need it in a moment for `supabase link`).
>  Free plan is fine to start. Click Create. Wait ~60 seconds for
>  provisioning."

Sign-up takes a minute if they don't have an account.

### A2. Copy the keys
> "Once provisioned, go to **Settings → API**. Copy three values:
>  - **Project URL** (looks like `https://abcd1234.supabase.co`)
>  - **anon public** key (long JWT, safe to expose to the browser)
>  - **service_role** key (long JWT, **server-side only — never put in browser code**)
>
>  Paste them into chat — I'll write `.env.local` for you."

### A3. Write the env files

When the user pastes keys, write **both**:

`.env.local` (gitignored — actual values):
```env
VITE_SUPABASE_URL=https://abcd1234.supabase.co
VITE_SUPABASE_ANON_KEY=<paste-anon-here>
SUPABASE_SERVICE_ROLE_KEY=<paste-service-role-here>
```

`.env.example` (committed — placeholder values for teammates):
```env
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # server-side only — never VITE_*
```

Confirm `.env.local` is in `.gitignore` (and `.env.example` is **not**).

### A4. Link the local project to the remote

> "Linking your local `supabase/` folder to the remote project. The project
>  ref is the bit before `.supabase.co` in your URL — e.g. `abcd1234`."

Run: `pnpm link <project-ref>`

(Maps to `supabase link --project-ref <project-ref>` via the npm script.)

If the CLI asks for the DB password, the user pastes what they set in A1.

### A5. Push migrations to the linked project

> "Now applying every file under `supabase/migrations/` to your remote
>  project. This is the step that creates the tables, indexes, RLS policies,
>  triggers, and storage buckets your code expects."

Run: `pnpm db:push`

(Maps to `supabase db push --linked`.)

If it errors:
- "no remote linked" → repeat A4.
- migration syntax error → fix the SQL file, re-run.
- shadow DB / Docker error on `db:push` → not all CLI versions need Docker
  for `db:push --linked`; if Docker is required and unavailable, fall back
  to pasting the migration into **SQL Editor** in the dashboard (still acceptable
  for the very first run, but not the default).

### A6. Generate types from the live schema

```bash
pnpm gen:types
```

Writes `packages/api-client/src/database.types.ts` from the now-applied
schema. Re-run any time the schema changes.

### A7. Restart Vite & verify

> "Stop `pnpm dev` (Ctrl-C), restart it. The `<EnvBanner />` should
>  disappear. If it doesn't, double-check `VITE_SUPABASE_URL` doesn't have
>  surrounding quotes and that you restarted after editing `.env.local`
>  (Vite caches env vars per-build)."

### A8. Confirm in one short line

> "Saved keys to `.env.local`. Linked project `<project-ref>`. Pushed
>  N migrations. Generated types. Continuing with your build."

---

## Path B — Local auto-run (Docker)

### B1. Confirm Docker

> "`pnpm db:start` needs Docker Desktop running. Quick check: is Docker
>  Desktop open and the whale icon green? If not, open it and let it
>  finish booting before I continue."

If Docker is not installed, fall back to Path A — do not block on
installing Docker mid-session.

### B2. Start the local Supabase stack

```bash
pnpm db:start
```

(Maps to `supabase start`.) On first run this pulls images (~1–2 min).
The CLI applies every file under `supabase/migrations/` on boot and prints,
on success:

```
Started supabase local development setup.

         API URL: http://127.0.0.1:54321
          DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
      Studio URL: http://127.0.0.1:54323
        anon key: eyJhbGciOiJI…
service_role key: eyJhbGciOiJI…
```

### B3. Write `.env.local` from the printed values

Copy `API URL` into `VITE_SUPABASE_URL`, `anon key` into
`VITE_SUPABASE_ANON_KEY`, `service_role key` into `SUPABASE_SERVICE_ROLE_KEY`
(server-side only). Also write `.env.example` with the documented placeholders
(same shape as Path A3).

### B4. Generate types from the local schema

```bash
pnpm gen:types
```

Local-flavoured invocation: if the project script targets `--linked`,
either swap to `--local` for this run, or run `pnpm gen:types` after
`pnpm link <ref>` once a cloud project exists.

### B5. Restart Vite & verify

Same as A7 — banner gone, app live against `http://127.0.0.1:54321`.

### B6. Confirm in one short line

> "Started local Supabase (Docker), migrations applied on boot, keys
>  written to `.env.local`. Studio at http://127.0.0.1:54323. Continuing
>  with your build."

Note: local Supabase data lives in Docker volumes — `pnpm db:reset`
re-applies migrations from scratch; `pnpm db:stop` stops the containers
without deleting state.

---

## Variations the user might ask for

### "I already have a Supabase project, just need to connect it"
Path A; skip A1, jump to A2 (they read keys from their existing project's
Settings → API).

### "I want to use our own Supabase fork"
Path A. The fork's API is identical to vanilla Supabase. Set
`VITE_SUPABASE_URL` to the fork URL and use the fork's keys. State file
`.traffic-one/.one.json` should have `backend: "our-fork"` instead of `"supabase"`.

### "Migrations changed — re-apply"
- Cloud (linked): `pnpm db:push`.
- Local (Docker): `pnpm db:reset` to wipe + re-apply, or write a new
  timestamped migration and `pnpm db:reset`.
Always follow with `pnpm gen:types`.

## Don't
- Don't run `supabase init` if `supabase/` already exists — it overwrites config.
- Don't commit `.env.local`. Don't put `SUPABASE_SERVICE_ROLE_KEY` behind a
  `VITE_*` prefix; Vite inlines `VITE_*` into the client bundle.
- Don't finish a scaffold by listing "open the SQL editor and paste this"
  in README. Push migrations through `pnpm db:push` (Path A) or boot the
  local stack with `pnpm db:start` (Path B).
- Don't pitch "our fork" again in this skill — the migration pitch is in the
  auto-detect banner; this skill is purely setup.
- Don't proceed to feature code until either Path A or Path B has produced
  a working `.env.local` and the `<EnvBanner />` is gone.
