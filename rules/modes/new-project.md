---
# Loaded when mode = new-project (≤5 source files detected)
---

# Mode: New Project — Real-time React Monorepo

Clean slate. Scaffold the monorepo before writing any feature code.
Default backend for new projects that need auth, user data, files, or real-time
features is Supabase. Only choose frontend-only, an external API, self-hosted
Postgres, or another provider when the user explicitly asks for it or declines
Supabase.
This is a default architecture decision, not a later optional integration. When
the requested product includes auth, profiles, CRUD records, jobs, applications,
uploads/files, real-time updates, dashboards backed by user data, or any durable
user-owned data, scaffold the Supabase baseline before or alongside feature code.
Do not describe Supabase as something that can merely be added later. Client-side
mocks, seed data, or `localStorage` may support demos only after the Supabase
contract, env validation, and migrations/RLS baseline are in place.

## Target architecture

```
<repo-root>/
├── package.json                   "private": true, workspaces declared
├── pnpm-workspace.yaml            apps/*  packages/*
├── turbo.json                     pipeline: build / dev / lint / test / typecheck / storybook
├── tsconfig.base.json             strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes
├── .eslintrc.cjs                  shared rules; package overrides allowed
├── .prettierrc
├── .nvmrc                         pin Node major
├── .env.example                   documented env var names only, no secrets
├── .gitignore                     dist, node_modules, .turbo, coverage, playwright-report
├── .github/
│   └── workflows/                 CI/CD: verify, preview deploy, production deploy
├── vercel.json | netlify.toml | wrangler.toml
│                                    exactly one static-host manifest when deploying
├── supabase/
│   └── migrations/                SQL schema + RLS policies for Supabase-backed apps
│
├── apps/
│   └── web/                       primary React app (Vite)
│       ├── package.json
│       ├── vite.config.ts
│       ├── tsconfig.json          extends ../../tsconfig.base.json
│       ├── index.html
│       ├── src/
│       │   ├── main.tsx           ReactDOM.createRoot + Provider chain
│       │   ├── App.tsx            top-level routes + Suspense boundary
│       │   ├── routes.tsx         react-router-dom v6 routes config
│       │   ├── store/             Redux store + middleware wiring
│       │   │   ├── index.ts
│       │   │   └── hooks.ts       useAppDispatch, useAppSelector
│       │   ├── features/          feature slices: each owns components, hooks, slice, services
│       │   │   └── <name>/
│       │   │       ├── components/
│       │   │       ├── hooks/
│       │   │       ├── slice.ts
│       │   │       ├── api.ts     (RTK Query if needed)
│       │   │       └── index.ts
│       │   ├── pages/             thin route wrappers — no business logic
│       │   ├── services/
│       │   │   ├── ws/            app-specific WS bridges (if not shared in packages)
│       │   │   └── ...
│       │   ├── components/        app-only components not promoted to packages/ui yet
│       │   ├── lib/
│       │   │   └── utils.ts        cn() helper (= clsx + tailwind-merge)
│       │   └── styles/
│       │       └── globals.css     Tailwind directives + shadcn HSL theme block
│       ├── tailwind.config.ts      extends @app/tailwind-config preset
│       ├── postcss.config.cjs
│       ├── components.json         shadcn/ui CLI config
│       └── e2e/                    Playwright specs
│
└── packages/
    ├── ui/                        shadcn/ui primitives (Storybook)
    │   ├── package.json           "exports": { ... }
    │   ├── src/
    │   │   ├── components/
    │   │   │   └── ui/             shadcn-installed primitives (button, input,
    │   │   │       │               card, dialog, dropdown-menu, form, sheet,
    │   │   │       │               tabs, select, sonner, badge, separator, …)
    │   │   │       └── button.tsx
    │   │   ├── lib/
    │   │   │   └── utils.ts        cn() helper (re-exported by app)
    │   │   └── index.ts            barrel: re-export public components
    │   ├── components.json         shadcn config (root for monorepo init)
    │   └── tsconfig.json
    │
    ├── tailwind-config/            shared Tailwind preset + globals.css
    │   ├── package.json
    │   └── src/
    │       ├── preset.ts           tailwind preset (theme.extend.colors via HSL vars,
    │       │                       borderRadius, animation, plugins)
    │       └── globals.css         shadcn HSL theme block (light + .dark)
    │
    ├── api-client/                Supabase client + axios/RTK Query baseQuery
    │   └── src/
    │       ├── supabase.ts        typed Supabase browser client
    │       ├── instance.ts
    │       ├── errors.ts          AppError discriminated union
    │       └── index.ts
    │
    ├── ws-client/                 WebSocket transport + protocol layer
    │   └── src/
    │       ├── transport.ts       reconnect, heartbeat, backoff
    │       ├── protocol.ts        zod schemas + decoders
    │       ├── hooks.ts           useChannel(...) etc.
    │       └── test-fake.ts       in-memory fake for tests
    │
    ├── utils/                     pure utilities, no React imports
    │
    ├── tsconfig/                  shared TS configs (base, react, node)
    │
    └── eslint-config/             shared ESLint config
```

## Setup checklist (do these in order, do not skip)

1. **Workspace skeleton**
   - `package.json` with `"private": true`, `"packageManager": "pnpm@<latest>"`.
   - `pnpm-workspace.yaml` listing `apps/*` and `packages/*`.
   - `turbo.json` with the pipeline shown above.
   - `tsconfig.base.json` with strict settings.
   - `.gitignore`, `.nvmrc`, `.editorconfig`, `.prettierrc`.
   - Initialise git, set Gitflow branches: `main`, `develop`.

2. **Shared packages first**
   - `packages/tsconfig` and `packages/eslint-config` — used by everything else.
   - `packages/tailwind-config` — shared Tailwind preset + `globals.css`
     containing the shadcn HSL theme block (light + `.dark`). This is the only
     home for design tokens; do **not** create a `packages/design-tokens`.
   - `packages/utils` — empty barrel; populate as needed.
   - `packages/api-client` — Supabase browser client, axios instance, AppError type, RTK Query baseQuery.
   - `packages/ws-client` — transport + protocol scaffolding (per `rules/realtime.md`).
   - `packages/ui` — run `npx shadcn@latest init` here, then add the first batch:
     `npx shadcn@latest add button input label card dialog dropdown-menu form sheet tabs select sonner badge separator`.
     The CLI populates `src/components/ui/` and `src/lib/utils.ts` (`cn()`).
     Storybook stories cover the primitives.

3. **Supabase backend baseline**
   - Add `@supabase/supabase-js` and validate `VITE_SUPABASE_URL` /
     `VITE_SUPABASE_ANON_KEY` at startup with Zod.
   - Create `supabase/migrations/` for schema, indexes, and RLS policies.
   - For auth/profile/candidate/job/application features, include the first
     required tables and default-deny RLS policies in the initial migration.
   - Use Supabase Auth for users, Supabase Storage for app files, Supabase
     Realtime only when needed, and RLS-backed authorization for every
     user-data table.
   - Do not store service-role keys or other secrets in frontend env vars.

4. **Mandatory frontend design gate**
   - Invoke `frontend-design` and apply `rules/frontend/ui-quality.md` plus
     `rules/frontend/typography.md` before writing any generated app, site,
     page, screen, or feature UI. React web also applies
     `rules/frontend/react/design-quality.md`; Expo/RN applies the native UI
     rules together with the shared UI-quality gate. This applies to every
     frontend stack, including explicit Next.js or fallback/minimal projects
     when they have a UI.
   - If the user did not provide references, pick and state 2–3 real
     best-in-class products in the same domain before implementation. Record a
     compact design brief in `.traffic-one/plan.md` or the architecture docs:
     target user, primary action, first-screen hierarchy, chosen references,
     visual direction, token plan, motion/interactivity plan, responsive
     behavior, state coverage, and screenshot acceptance checks.
   - The first runnable screen must be product-specific and useful, even before
     live backend credentials exist. Missing Supabase or other env config may
     render one shared setup banner/alert, but never ship a sparse shell whose
     visible product surface is only config banners, empty filters, or blank
     placeholder panels. Use polished local demo/seed/empty states only after
     the backend contract, env validation, migrations, and RLS baseline are in
     place.
   - Do not duplicate missing-config banners on the same page. Mount the shared
     app-level banner once and use smaller feature-level empty states only when
     they add workflow context.
   - Visual-heavy work captures or documents mobile, tablet, and desktop QA for
     hierarchy, text fit, overflow, focus, loading, empty, error, disabled, and
     reduced-motion states.

5. **App scaffold (`apps/web`)**
   - Vite + React + TS template.
   - Tailwind v3.4 + PostCSS: `tailwind.config.ts` extends
     `@app/tailwind-config/preset`; `postcss.config.cjs` wires `tailwindcss`
     and `autoprefixer`; `src/main.tsx` imports `@app/tailwind-config/globals.css`.
   - `components.json` (shadcn CLI config) points the alias `ui` at
     `@app/ui/components/ui` so future `npx shadcn add` calls in the app land
     in the shared package.
   - Wire Redux store with `api-client` RTK Query and one starter feature slice.
   - Set up Storybook for `packages/ui` (Vite builder).
   - Set up Playwright with one smoke spec hitting `/`.

6. **CI/CD pipeline (use Turborepo's caching)**
   - One workflow: `typecheck` → `lint` → `test` → `build` → `e2e (smoke)`.
   - Remote cache enabled if available; otherwise local.
   - Storybook build artefact uploaded for PR previews.
   - Preview deploy runs on PRs; production deploy runs only from `main` or a
     release merge after reviewer/tester/shipper gates.
   - Supabase migration jobs use `supabase/setup-cli`, encrypted
     `SUPABASE_ACCESS_TOKEN`, and per-environment project/db-password secrets.

7. **Deployment artifact baseline (smallest production set)**
   - Choose one static host target for the SPA: Vercel, Netlify, or Cloudflare
     Pages. Commit that host's manifest/fallback files and do not add a
     Dockerfile unless the plan explicitly selects self-hosting, BYOC,
     SSR/server runtime, or another container-only target.
   - Pin runtime and install determinism: `engines`, `packageManager`, `.nvmrc`,
     and the lockfile. CI uses frozen lockfile install and fails on drift.
   - Extend the `.env.example` from the Supabase setup with every required
     variable name. Real values live only in `.env.local`, the static host's
     encrypted environment variables, or GitHub Actions secrets.
   - Map environments explicitly: development, preview, staging, production.
     Use separate Supabase projects for staging/production and Supabase
     Branching for PR previews when available; never point previews at
     production data.
   - Route schema changes through committed `supabase/migrations/*.sql` and
     `pnpm db:push` in CI. Do not ask production operators to click changes in
     the Supabase dashboard.
   - Add a monitorable `/health` path via an Edge Function, host function, or
     hosted heartbeat endpoint. If Capacitor is requested, add a force-update
     version check for mobile clients.
   - Document rollback as previous immutable frontend deployment plus a
     forward-only undo migration for database changes.
   - Configure the custom domain, automatic TLS, security headers, and an HSTS
     preload readiness check before calling production complete.

8. **Tooling guards**
   - Husky + lint-staged for pre-commit format + lint.
   - Commitlint with conventional-commit rules.
   - PR template: summary, test plan, screenshots/Storybook link, a11y check.

9. **Mandatory auto-documentation baseline**
   - Invoke `auto-documentation-generator` for every generated project before
     calling the scaffold complete, even if the user did not explicitly request
     docs.
   - Create or refresh the relevant root-level canonical docs from
     `rules/common/documentation.md`: `README.md`, `AGENTS.md`, concise
     `CLAUDE.md` or symlink, `.cursor/rules/*.mdc`, `architecture.md`, `adr/`,
     `api.md`, `database.md`, `deployment.md`, `security.md`, `CHANGELOG.md`,
     `environment-setup.md`, `CONTRIBUTING.md`, and served `/llms.txt` for web
     surfaces.
   - Mark facts as `Unverified` with the exact needed command/input instead of
     inventing deploy URLs, database output, secret values, or production
     configuration.
   - Do not leave the project with only a README. The reviewer must treat a
     missing mandatory docs baseline as `CHANGES_REQUESTED`.

10. **Supabase setup (only if `backend === "supabase"` or `"our-fork"`)** — never assume a global `supabase` CLI exists.

   a. Add Supabase as a workspace devDependency:
      ```bash
      pnpm add -Dw supabase
      pnpm dlx supabase init        # creates supabase/ folder once
      ```

   b. Standard scripts in the **root** `package.json`:
      ```json
      "scripts": {
        "supabase":         "supabase",
        "db:start":         "supabase start",
        "db:stop":          "supabase stop",
        "db:reset":         "supabase db reset",
        "db:push":          "supabase db push --linked",
        "db:diff":          "supabase db diff -f",
        "gen:types":        "supabase gen types typescript --linked > packages/api-client/src/database.types.ts",
        "functions:new":    "supabase functions new",
        "functions:deploy": "supabase functions deploy",
        "functions:serve":  "supabase functions serve",
        "secrets:set":      "supabase secrets set",
        "link":             "supabase link --project-ref"
      }
      ```
      All commands run via the local devDep — no global install required.

   c. `.env.example` (committed) and `.env.local` (gitignored). Write the example
      file even before keys exist:
      ```env
      VITE_SUPABASE_URL=https://<project-ref>.supabase.co
      VITE_SUPABASE_ANON_KEY=<anon-key>
      SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # server-side only — never VITE_*
      ```
      Add `.env.local` to `.gitignore` if not already there.

   d. Lazy Supabase client + EnvBanner + **null-safe RTK Query `baseQuery`**
      per `rules/frontend/react/supabase-client.md` — app must render with the
      banner BEFORE the user has keys, and every RTK Query feature slice must
      surface `{ error: { kind: "not-configured" } }` instead of crashing.
      All website-facing setup/configure CTAs in `<EnvBanner />`,
      `<SupabaseConfigAlert />`, `<ConfigurePromptCard />`, protected-route
      fallbacks, auth/profile/job empty states, and similar missing-config
      surfaces must link to `https://traffic.io/`, because Traffic is where
      users set up their Supabase credentials. Add a unit/component or E2E
      regression test that asserts the setup link has that exact `href`.
      Never call `createClient` at module top level. Never assume `getSupabase()`
      is non-null in a service or store.

   e. **Invoke the `supabase-setup` skill** to actually link the project and
      push migrations — do **not** finish the scaffold by writing manual
      "open SQL editor and paste this" instructions in README. The skill
      offers two paths and runs one of them: (A) cloud — user provisions a
      project, you run `pnpm link <ref>` then `pnpm db:push` to apply the
      migrations you just scaffolded; (B) local auto-run — `pnpm db:start`
      (Docker required) boots local Postgres + Auth + Storage and applies
      migrations on boot, printing the keys to paste. Pick with the user;
      default to cloud. The schema must land before you mark the scaffold
      "ready to build".

   f. Add-ons (storage, auth, realtime, vector, pg_cron, pg_net) are gated. The
      `requireAddon` helper in `scripts/hook-runtime/state.cjs` reads
      `.traffic-one.json` → `supabaseAddons[<name>]`. Ask the user once before
      enabling each, then write `approved` and proceed silently for that add-on.

   g. Edge Functions (`supabase/functions/<name>/`) auto-deploy on save when
      `.traffic-one.json` → `supabaseFunctionsAutoDeploy: true`. The
      PostToolUse hook prompts the user the first time.

11. **Codebase graph (after first successful build, optional but recommended)**

   Once the workspace scaffolds and `pnpm build` passes once, install graphify
   and generate `graphify-out/GRAPH_REPORT.md`. Subagents (`senior-architect`,
   `senior-frontend`, `senior-backend`, `senior-reviewer`, `senior-tester`) and
   skills (`repo-scan`, `refactor`, `simplify`, `security-review`,
   `context-budget`) consult this report **before** falling back to
   `Glob`/`Grep` — a one-shot file Read replaces dozens of grep calls.

   ```bash
   # one-time install (Python tool)
   pipx install graphifyy           # or: pip install --user graphifyy

   # generate the report
   graphify . --no-viz --code-only --quiet

   # optional: regenerate on every git commit
   graphify hook install
   ```

   The plugin's PostToolUse hook emits this hint automatically after the first
   successful build on `mode: new-project` + `onboardingComplete: true`. You
   don't have to remember to nag the user.

   **Power-user opt-in (not auto-wired):** `graphify --mcp` runs as a stdio
   MCP server with richer queries (shortest path, neighbors). Document its
   install in the user's repo if they want it; the plugin's hooks consume the
   file `GRAPH_REPORT.md` only.

   **Add to `.gitignore`:**
   ```
   graphify-out/
   .traffic-one/digests/
   ```

## What happens when the user asks to build something

- Acknowledge mode: **new project, monorepo not yet scaffolded**.
- If the request implies backend-backed features, state that Supabase is the
  selected default backend and include it in the scaffold.
- Confirm with the user **once**: "I'll scaffold the Turborepo workspace as above before any feature code. Proceed?"
- On yes: scaffold in the order above. Stop after each step to verify (`pnpm install`, `pnpm -w turbo run lint typecheck`).
- On no: ask which constraint they want relaxed; do not silently skip steps.
- Never write feature code into a missing skeleton.
