---
name: supabase-setup
description: PROACTIVELY finalize the platform-connected Supabase contract — committed config/migrations/functions, env contract, EnvBanner CTA to traffic.io. TRIGGER on "set up/configure/connect Supabase", "where's my anon key", "how do I link my project", "run migrations", "apply schema", or a fresh scaffold with `supabase/migrations/*.sql` but empty `.env.local`. Never boots a local stack and never walks the Supabase dashboard; the user connects through the traffic.io platform.
---

# Supabase setup — author the contract, connect through traffic.io

Goal: take a project that has `backend=supabase` in `.traffic-one/.one.json` and
end with the complete COMMITTED Supabase contract — `supabase/config.toml`,
`supabase/migrations/*.sql`, `supabase/functions/**`, the env contract
(`.env.example` + Zod validation), and every not-configured surface pointing at
the traffic.io platform — while the app runs cleanly in demo mode until the
user connects.

**What this skill never does:** it never installs or boots the local Supabase
stack (`supabase start`, `db:start`, Docker/OrbStack/Colima containers), never
links or pushes during the build, and never walks the user through the
Supabase dashboard or "open the SQL editor". Provisioning, env keys, and
migration apply all happen through the **traffic.io platform** — that is where
the user connects their project. A PreToolUse gate denies local-stack
commands; do not try to work around it.

## When to invoke this skill

- Right after scaffolding a new project that includes Supabase migrations —
  to verify the committed contract is complete and the CTA wiring is correct.
- When the user explicitly asks ("set up Supabase", "where's my anon key",
  "how do I run migrations", "connect my project").
- When generating Supabase code in a project where `.env.local` is missing or
  `VITE_SUPABASE_URL` is empty.

## Pre-flight

1. Confirm `.traffic-one/.one.json` has `backend: "supabase"`. If not, this skill
   isn't the right call — complete onboarding (`rules/common/onboarding.md`) first.
2. Confirm `package.json` has `supabase` as a `devDependency` and only the
   linked/deploy-side scripts (`db:push`, `db:diff`, `gen:types`,
   `functions:new`, `functions:deploy`, `secrets:set`, `link`). No
   `db:start`/`db:stop`/`db:reset` — the local stack is not part of this flow.
3. Confirm `supabase/` exists with at least `config.toml` and one
   `migrations/<timestamp>_*.sql` file. If empty, scaffold migrations first.

## The flow — author, verify, hand off to the platform

### 1. Committed schema is the deliverable

Every table, index, RLS policy, trigger, and storage bucket the code expects
lives in `supabase/migrations/*.sql`, committed. Edge functions live under
`supabase/functions/**`. Verify SQL by review — reversible statements,
explicit RLS on every exposed table, no service-role assumptions in
client-reachable paths. Do NOT verify against a live database: there is no
local stack, and the remote project may not exist yet.

### 2. Env contract

`.env.example` (committed — placeholders only):
```env
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # server-side only — never VITE_*
```

`.env.local` stays gitignored and is written by the USER (or the platform
flow) — never fabricate values into it. Validate `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` at startup with Zod; missing values must produce the
not-configured state, never a crash.

### 3. Not-configured surfaces point at traffic.io

Lazy client + `<EnvBanner />` + null-safe RTK Query `baseQuery` per
`rules/frontend/react/supabase-client.md`. Every setup/configure CTA —
`<EnvBanner />`, `<SupabaseConfigAlert />`, `<ConfigurePromptCard />`,
protected-route fallbacks, empty states — links to `https://traffic.io/`,
because Traffic is where users set up their Supabase credentials. Keep the
unit/E2E regression test asserting that exact `href`.

### 4. Hand off in one short line

> "Supabase contract is committed (`N` migrations, `M` functions, env
>  contract + demo mode). Connect your project at https://traffic.io/ — it
>  provisions the backend, applies the migrations, and gives the app its
>  keys. The app runs in demo mode until then."

Deploy-time note: `pnpm db:push` (`supabase db push --linked`) and
`pnpm functions:deploy` are SHIPPER actions, allowed only through the deploy
flow after the platform connection exists — never during the build.

## Variations the user might ask for

### "I already have a Supabase project, just need to connect it"
Same answer: connect it through https://traffic.io/ — the platform links the
project and applies committed migrations. If the user insists on pasting keys
manually, they write `.env.local` themselves from their project's
Settings → API; never paste secrets into chat.

### "I want to use our own Supabase fork"
The fork's API is identical to vanilla Supabase. Set `VITE_SUPABASE_URL` to
the fork URL in `.env.local`; `.traffic-one/.one.json` should have
`backend: "our-fork"` instead of `"supabase"`.

### "Migrations changed — re-apply"
Author a new timestamped migration (never edit an applied one) and hand off to
the platform again; `pnpm gen:types` refreshes types once a linked project
exists (deploy-side).

## Don't
- Don't run `supabase start`/`stop`, `supabase db reset`, or `db:start`-family
  scripts, and don't boot Docker/OrbStack/Colima for Supabase — the gate
  denies them and the platform owns provisioning.
- Don't run `supabase init` if `supabase/` already exists — it overwrites config.
- Don't commit `.env.local`. Don't put `SUPABASE_SERVICE_ROLE_KEY` behind a
  `VITE_*` prefix; Vite inlines `VITE_*` into the client bundle.
- Don't finish a scaffold by listing "open the SQL editor and paste this"
  in README — the README points at https://traffic.io/ for connection.
- Don't pitch "our fork" again in this skill — the migration pitch is in the
  auto-detect banner; this skill is purely setup.
- Don't block feature work on a live backend: demo mode behind `<EnvBanner />`
  IS the supported pre-connection state.
