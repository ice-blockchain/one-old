---
description: "Apply when executing new-project scaffolding: the detailed 12-step setup checklist (workspace, memory, packages, Supabase, design/SEO gates, CI, deployment, docs, code graph)."
---

# New Project — Setup Checklist (full detail)

Read-on-demand slice of `rules/modes/new-project.md`. Do the steps in order;
do not skip. The spine carries the step index — this file is the detail.

1. **Workspace skeleton**
   - `package.json` with `"private": true`, `"packageManager": "pnpm@<latest>"`.
   - `pnpm-workspace.yaml` listing `apps/*` and `packages/*`.
   - `turbo.json` with the pipeline shown above.
   - `tsconfig.base.json` with strict settings.
   - `.gitignore`, `.nvmrc`, `.editorconfig`, `.prettierrc`.
   - Initialise git, set Gitflow branches: `main`, `develop`.

2. **Project memory baseline**
   - Create `.traffic-one/` before feature work and invoke `project-memory`.
   - Confirm root `.traffic-one/.one.json` exists with the full Traffic One state
     schema. `.traffic-one/` is memory; `.traffic-one/.one.json` is stack/state.
   - Write `.traffic-one/product.md`, `.traffic-one/stack.md`,
     `.traffic-one/coding.md`, `.traffic-one/security.md`,
     `.traffic-one/known-issues.md`,
     `.traffic-one/agent-log.md`, `.traffic-one/.agentignore`,
     `.traffic-one/deployments.jsonl`, `.traffic-one/schema.sql`,
     `.traffic-one/decisions/`, and
     `.traffic-one/skills/` when reusable commands are needed.
   - Ensure the generated active stack bundle exists before feature-source
     writes: `.traffic-one/rules/**`,
     `.traffic-one/manifest.json`, `.traffic-one/skills/**`, root `AGENTS.md`
     containing the compact active rule kernel/index by default, and root
     `CLAUDE.md`. Existing `AGENTS.md` and `CLAUDE.md` files must be preserved
     and merged with Traffic One managed blocks; symlink `CLAUDE.md` to
     `AGENTS.md` only when no `CLAUDE.md` exists. The generic post-tool hook
     normally converges this
     after any host tool event once `.traffic-one/.one.json` is complete; if the host
     runtime does not emit the hook, run
     `node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/hook-runtime.cjs" materialize-project`
     from the project root and verify `.traffic-one/.one.json` has `version`,
     `materializedStack`, `materializedAt`, and `materializedVersion`. Never
     write those `materialized*` fields manually; they are output from the
     materializer and are valid only with the generated manifest, rules, skills,
     root `AGENTS.md`, and root `CLAUDE.md`. Never replace existing root
     `AGENTS.md` or `CLAUDE.md`; merge the Traffic One generated context into
     managed blocks.
   - Root `AGENTS.md` is the canonical active agent context. Do not generate
     `.traffic-one/rules/AGENTS.md`; `.traffic-one/rules/` must contain only
     generated rule files. Root `CLAUDE.md` should be a symlink to root
     `AGENTS.md` for host compatibility only when `CLAUDE.md` is absent.
   - If the project has no DB yet, `.traffic-one/schema.sql` says
     `Not applicable` with the reason. Once migrations exist, refresh it after
     every migration.
   - Keep `.traffic-one/digests/`, `.traffic-one/reports/`,
     `.traffic-one/backups/`, `graphify-out/`, and `.gitnexus/` gitignored
     as local caches; the memory baseline files above are source.

3. **Shared packages first**
   - `packages/tsconfig` and `packages/eslint-config` — used by everything else.
   - `packages/tailwind-config` — shared Tailwind preset + `globals.css`
     containing the shadcn HSL theme block (light + `.dark`). This is the only
     home for design tokens; do **not** create a `packages/design-tokens`.
   - `packages/i18n` — typed i18next/react-i18next resources, provider,
     namespace helpers, and source-language catalogs. It is required for new
     frontend stacks before generated page/component copy is written.
   - `packages/utils` — empty barrel; populate as needed.
   - `packages/api-client` — Supabase browser client, axios instance, AppError type, RTK Query baseQuery.
   - `packages/ws-client` — transport + protocol scaffolding (per `rules/realtime.md`).
   - `packages/ui` — run `npx shadcn@latest init` here, then add the first batch:
     `npx shadcn@latest add button input label card dialog dropdown-menu form sheet tabs select sonner badge separator`.
     The CLI populates `src/components/ui/` and `src/lib/utils.ts` (`cn()`).
     Storybook stories cover the primitives.

4. **Supabase backend baseline**
   - Add `@supabase/supabase-js` and validate `VITE_SUPABASE_URL` /
     `VITE_SUPABASE_ANON_KEY` at startup with Zod.
   - Create `supabase/migrations/` for schema, indexes, and RLS policies.
   - For auth/profile/candidate/job/application features, include the first
     required tables and default-deny RLS policies in the initial migration.
   - Use Supabase Auth for users, Supabase Storage for app files, Supabase
     Realtime only when needed, and RLS-backed authorization for every
     user-data table.
   - Do not store service-role keys or other secrets in frontend env vars.

5. **Mandatory frontend design gate**
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

6. **App scaffold (`apps/web`)**
   - Vite + React + TS template.
   - Tailwind v3.4 + PostCSS: `tailwind.config.ts` extends
     `@app/tailwind-config/preset`; `postcss.config.cjs` wires `tailwindcss`
     and `autoprefixer`; `src/main.tsx` imports `@app/tailwind-config/globals.css`.
   - `components.json` (shadcn CLI config) points the alias `ui` at
     `@app/ui/components/ui` so future `npx shadcn add` calls in the app land
     in the shared package.
   - Wire `packages/i18n` into the app provider chain before adding generated
     page/feature UI. All starter copy, navigation labels, setup banners, and
     state text use catalog keys; rich copy with links uses `<Trans>`.
   - Wire Redux store with `api-client` RTK Query and one starter feature slice.
   - Set up Storybook for `packages/ui` (Vite builder).
   - Set up Playwright with one smoke spec hitting `/`.

7. **Mandatory SEO baseline**
   - Invoke the `seo` skill before calling a generated website/app complete.
   - Add a route-aware SEO layer for every public web surface:
     `apps/web/src/components/Seo.tsx` and `apps/web/src/lib/seo.ts` for
     React/Vite/Ionic SPA output, or the active framework's native metadata
     API for explicit Next.js/minimal stacks.
   - Add or update fallback metadata in `apps/web/index.html`: title,
     description, canonical, Open Graph, Twitter Card, favicon links, and
     `manifest.webmanifest`.
   - Add public crawl/share assets: `robots.txt`, `sitemap.xml`,
     `manifest.webmanifest`, `favicon.ico`, `apple-touch-icon`, `icon-192.png`,
     `icon-512.png`, and a default `1200x630` `og-default.png` or JPG.
   - Add `VITE_SITE_URL` (or the framework's public site-url env var) to
     `.env.example`. Mark the production domain `Unverified` until the user or
     host provides it; do not invent deploy URLs.
   - Add Playwright or unit regression coverage for every generated public
     route's title, description, canonical, Open Graph image, JSON-LD, and
     sitemap inclusion, plus `noindex,nofollow` on private/admin routes.
   - If an SPA public route must rank, document the prerender/static rendering
     or host-support plan in `.traffic-one/deployment.md` or
     `.traffic-one/known-issues.md`.
     Do not claim SEO parity from a client-rendered shell alone.

8. **CI/CD pipeline (use Turborepo's caching)**
   - One workflow: `typecheck` → `lint` → `test` → `build` → `e2e (smoke)`.
   - Remote cache enabled if available; otherwise local.
   - Storybook build artefact uploaded for PR previews.
   - Preview deploy runs on PRs; production deploy runs only from `main` or a
     release merge after reviewer/tester/shipper gates.
   - Supabase migration jobs use `supabase/setup-cli`, encrypted
     `SUPABASE_ACCESS_TOKEN`, and per-environment project/db-password secrets.

9. **Deployment artifact baseline (smallest production set)**
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
   - Add the post-deploy observability baseline from
     `rules/common/stack-recommendations.md`: Sentry release/source-map upload,
     Supabase Logs visibility, PostHog or explicitly chosen LogRocket replay
     with privacy masking, `/` and `/health` synthetic uptime checks, email plus
     chat alert routing, SLO burn-rate alerts, failed-deploy log analysis, and
     AI fix suggestions that require approval before PR/deploy actions.
   - Document rollback as previous immutable frontend deployment plus a
     forward-only undo migration for database changes.
   - Configure the custom domain, automatic TLS, security headers, and an HSTS
     preload readiness check before calling production complete.

10. **Tooling guards**
   - Husky + lint-staged for pre-commit format + lint.
   - Commitlint with conventional-commit rules.
   - PR template: summary, test plan, screenshots/Storybook link, a11y check.

11. **Mandatory auto-documentation baseline**
   - Invoke `auto-documentation-generator` for every generated project before
     calling the scaffold complete, even if the user did not explicitly request
     docs.
   - Create or refresh the relevant canonical docs from
     `rules/common/documentation.md`: `README.md`, `AGENTS.md`, concise
     `CLAUDE.md` or symlink, `.cursor/rules/*.mdc`, `.traffic-one/plan.md`,
     `.traffic-one/decisions/`, `.traffic-one/api.md`,
     `.traffic-one/database.md`, `.traffic-one/deployment.md`,
     `.traffic-one/security.md`, `CHANGELOG.md`,
     `.traffic-one/environment-setup.md`, `CONTRIBUTING.md`, and served
     `/llms.txt` for web surfaces. Do not create duplicate root-level
     `api.md`, `database.md`, `deployment.md`, `environment-setup.md`, or
     `security.md`; merge legacy copies into `.traffic-one/`.
   - Mark facts as `Unverified` with the exact needed command/input instead of
     inventing deploy URLs, database output, secret values, or production
     configuration.
   - Do not leave the project with only a README. The reviewer must treat a
     missing mandatory docs baseline as `CHANGES_REQUESTED`.

12. **Supabase setup (only if `backend === "supabase"` or `"our-fork"`)** — never assume a global `supabase` CLI exists.

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
      plugin's `requireAddon` gate (`scripts/shared/state/normalize.js` in the installed plugin) reads
      `.traffic-one/.one.json` → `supabaseAddons[<name>]`. Ask the user once before
      enabling each, then write `approved` and proceed silently for that add-on.

   g. Edge Functions (`supabase/functions/<name>/`) auto-deploy on save when
      `.traffic-one/.one.json` → `supabaseFunctionsAutoDeploy: true`. The
      PostToolUse hook prompts the user the first time.

12. **Codebase graph (after first successful build, REQUIRED at onboarding)**

   The user picks `codeGraphProvider: "gitnexus" | "graphify"` during
   onboarding (8th required field in `.traffic-one/.one.json`). After the
   workspace scaffolds and the first `pnpm build` passes, the post-build
   hook auto-installs and runs the chosen provider. Subagents
   (`senior-architect`, `senior-frontend`, `senior-backend`,
   `senior-reviewer`, `senior-tester`) and skills (`repo-scan`, `refactor`,
   `security-review`, `context-budget`) consult the resulting
   on-disk artefact **before** falling back to `Glob`/`Grep` — a one-shot
   Read replaces dozens of grep calls and cuts cross-session token usage by
   an estimated 50–70% on multi-file work.

   **When `codeGraphProvider: "gitnexus"`** (PolyForm Noncommercial license):
   ```bash
   npm install -g gitnexus    # one-time install (Node CLI)
   gitnexus analyze .         # index lands at .traffic-one/.gitnexus/ (the plugin runner relocates it)
   ```
   GitNexus auto-writes `AGENTS.md`, `CLAUDE.md`, and `.claude/skills/`,
   which conflict with traffic-one's own. The runner
   (`scripts/gitnexus-runner.cjs`) backs those three up to
   `.traffic-one/backups/<run-stamp>/` before each run and restores
   traffic-one's versions if changed.

   **When `codeGraphProvider: "graphify"`** (MIT license):
   ```bash
   pipx install graphifyy     # one-time install (Python tool)
   graphify update .          # report lands at .traffic-one/graphify-out/GRAPH_REPORT.md (the plugin runner relocates it)
   graphify hook install      # optional: regenerate on every git commit
   ```

   The plugin's PostToolUse hook emits this hint automatically after the first
   successful build on `mode: new-project` + `onboardingComplete: true` and
   dispatches to the right runner. You don't have to remember to nag the
   user. Opt out per-project with `"codeGraphAutoRun": false` in
   `.traffic-one/.one.json` (provider-agnostic; legacy `"graphifyAutoRun": false`
   honoured for one version).

   **Add to `.gitignore`:**
   ```
   graphify-out/
   .gitnexus/
   .traffic-one/digests/
   .traffic-one/reports/
   .traffic-one/backups/
   ```
