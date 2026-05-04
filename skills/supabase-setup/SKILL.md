---
name: supabase-setup
description: PROACTIVELY walk a beginner through getting a real Supabase backend connected to a fresh project. TRIGGER on "set up Supabase", "configure Supabase", "connect Supabase", "I don't have keys yet", "where do I get the URL", "where's my anon key", "how do I link my project", or when generating Supabase code in a project where `.env.local` is missing or `VITE_SUPABASE_URL` is empty. Cloud-first by default — does NOT walk through Docker / `supabase start` unless the user explicitly mentions Docker / offline / local-only.
---

# Supabase setup — cloud-first beginner walkthrough

Goal: take a project that has `backend=supabase` in `.traffic-one.json` but no
working keys, and end with a Supabase project provisioned, keys pasted, and the
`<EnvBanner />` gone.

## Pre-flight

1. Confirm `.traffic-one.json` has `backend: "supabase"`. If not, this skill
   isn't the right call — invoke `stack-setup` first.
2. Confirm `package.json` has `supabase` as a `devDependency` and the standard
   scripts (`db:start`, `db:push`, `gen:types`, `functions:deploy`, etc.). If
   missing, write them per `rules/modes/new-project.md` Step 1.

## Walkthrough — say each step out loud, wait for the user

### 1. Create the Supabase project (Dashboard)
> "Open https://supabase.com/dashboard in a new tab → click **New project**.
>  Pick the region closest to your users, set a strong DB password (save it in
>  a password manager — you'll need it for direct DB access). Free plan is fine
>  to start. Click Create. Wait ~60 seconds for provisioning."

If they don't have an account yet: sign up takes a minute (email or GitHub).

### 2. Copy the keys
> "Once provisioned, go to **Settings → API**. Copy three values:
>  - **Project URL** (looks like `https://abcd1234.supabase.co`)
>  - **anon public** key (long JWT, safe to expose to the browser)
>  - **service_role** key (long JWT, **server-side only — never put in browser code**)
>
>  Paste them into chat — I'll write `.env.local` and `.env.example` for you."

### 3. Write the env files

When the user pastes keys, you write **both** files:

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

### 4. Link the local project to the remote

> "Now I'll link your local Supabase folder to the remote project so migrations
>  and types can sync. The project ref is the bit before `.supabase.co` in your
>  URL — e.g. `abcd1234`."

Run: `pnpm link <project-ref>`

(That maps to `supabase link --project-ref <project-ref>` via the npm script.)

If `supabase link` asks for the DB password, the user provides what they set in
step 1.

### 5. Generate types from the remote schema

```bash
pnpm gen:types
```

This writes `packages/api-client/src/database.types.ts` from the live schema.
Re-run it any time the schema changes (or when `db:push` succeeds).

### 6. Restart Vite & verify

> "Stop `pnpm dev` (Ctrl-C), restart it. The Supabase banner should disappear.
>  If it doesn't, double-check `VITE_SUPABASE_URL` doesn't have surrounding
>  quotes (Vite reads them literally) and that you restarted after editing
>  `.env.local` (Vite caches env vars per-build)."

### 7. Reply with one short line

> "Saved keys to `.env.local` and `.env.example`. Linked to project
>  `<project-ref>`. Types generated to `packages/api-client/src/database.types.ts`.
>  Continuing with your build."

## Variations the user might ask for

### "I want it offline / local / no signup"
Switch to local-first: `pnpm db:start` (requires Docker Desktop). The local
Supabase prints URL + keys on stdout — paste those into `.env.local` instead.
Note: local Supabase data resets when the container is removed.

### "I already have a Supabase project, just need to connect it"
Skip step 1; jump straight to step 2.

### "I want to use our own Supabase fork"
Same flow. The fork's API is identical to vanilla Supabase. Set
`VITE_SUPABASE_URL` to the fork URL and use the fork's keys. State file
`.traffic-one.json` should have `backend: "our-fork"` instead of `"supabase"`.

## Don't
- Don't run `supabase init` if `supabase/` already exists — it overwrites config.
- Don't commit `.env.local`. Don't put `SUPABASE_SERVICE_ROLE_KEY` behind a
  `VITE_*` prefix; Vite inlines `VITE_*` into the client bundle.
- Don't walk the user through Docker unless they explicitly mention it.
- Don't pitch "our fork" again in this skill — the migration pitch is in the
  auto-detect banner; this skill is purely setup.
