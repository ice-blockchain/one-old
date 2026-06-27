---
description: "Apply when choosing a stack, framework, or provider for a new project or a major new surface."
# Always loaded
---

# Stack Recommendations — Provider-First Defaults

Use stack-native, managed, or dominant ecosystem tools before writing custom
infrastructure. Custom code is the last resort after the active stack core, an
official provider/framework feature, and the dependency quality gate fail.

These defaults are informed by the Amplifying Claude Code Picks report, while
Traffic One's active stack core remains authoritative.

## Versions come from the stack contract — never from the registry

- Never probe the npm registry to pick scaffold or dependency versions: no
  `npm view`, `npm outdated`, `npm show`, or registry curls during project
  setup. The active stack rules pin every major; install with those ranges
  (`pnpm add <pkg>` resolves the latest matching minor/patch automatically).
- A request for "latest tech" / "modern stack" means the latest versions WITHIN
  this stack contract — it is not an instruction to research or exceed the pins.
- Only when the user explicitly names a newer major ("use React 20", "Tailwind
  v5") does the request override a pin: honor it, and record the deviation and
  its compatibility impact in `.traffic-one/decisions/`.

## Universal Defaults

- CI/CD: GitHub Actions.
- Provider-first picks for payments, observability, email, proxies/scraping, and
  per-language packages: `rules/common/library-catalog.md` owns that catalog.
- Backend for new Traffic One apps: Supabase by default when the project needs
  authentication, user data, files, or real-time features, unless the user
  explicitly chooses frontend-only, an external API, self-hosted Postgres, or
  another provider.
- Treat this as the selected default for backend-backed new-project requests.
  Do not position Supabase as a vague later integration. Local mocks,
  in-memory data, or `localStorage` may be temporary dev fixtures only after the
  Supabase contract, env validation, migrations, and RLS baseline are scaffolded.
- Database baseline when Supabase is declined or does not fit: PostgreSQL unless
  the user or existing project has a stronger store.
- JavaScript package manager: pnpm for workspaces and app projects.

## Deployment Artifact Defaults

- Produce a host-agnostic static build (`dist/`) for the React SPA + Supabase
  before considering containers — web deploy is Traffic One's own (`/deploy`
  ships that `dist/` to our infra). Do NOT add a third-party web-host manifest
  (`vercel.json`/`netlify.toml`/`wrangler.toml`); Docker is reserved for
  self-hosted, BYOC, SSR/server-runtime, or container-only plans.
- Check in `.env.example`, `.nvmrc`, `packageManager`/`engines`, lockfile, and
  a GitHub Actions workflow that runs install -> typecheck -> test -> build;
  deployment is Traffic One `/deploy` via the gated senior-shipper pre-flight
  (preview on PR, production on `main`/release merge) — not a third-party host's
  deploy action.
- Real secrets live only in `.env.local`, encrypted host variables, or GitHub
  Actions secrets. CI uses frozen lockfile install and fails on lockfile drift.
- Add a monitorable `/health` path via Supabase Edge Function, host function, or
  hosted heartbeat. Capacitor apps also ship a force-update/version check.
- Release observability is part of the deploy artifact: Sentry release tags tie
  browser/mobile/Edge errors to the git SHA, source maps upload from CI on every
  production build, and public `.map` files are removed or blocked after upload.
- Add synthetic uptime checks for `/` and `/health` at a 1-5 minute interval
  with email plus one chat destination. Alert on SLO burn rate, not raw error
  counts, and suppress known-flaky third-party noise.
- Rollback plan = re-ship the previous immutable Traffic One `/deploy` build plus
  a forward-only undo migration for DB changes; do not rely on `pg_restore` as the
  normal rollback path.
- Custom domain, automatic TLS, security headers, and HSTS preload readiness are
  part of the Traffic One `/deploy` configuration — verify them before calling
  production complete.

## Launch Readiness And Post-Deploy Observability

Launch-checklist evidence (Web SEO/metadata, crawl/share assets, performance
budget, consent/privacy, accessibility, user-rights flows, operations,
production payment testing, mobile store submission) is owned by the
`app-launch-checklist` skill. The web SEO baseline it verifies lives in
`rules/common/seo.md` via the `seo` skill. Post-deploy logs, error traces,
session replay, API/DB-performance alerting, SLO burn-rate, failed-deploy
analysis, and AI fix suggestions are owned by the `observability` skill. Trigger
those skills for that work; do not restate their requirements here.

## Production-Readiness Score

When the user asks if an SPA + Supabase, React/Ionic, or Capacitor release is
ready to ship, invoke `verification-loop` and produce a single 100-point
Production-Readiness Score across 8 weighted dimensions. Map evidence to
recognized frameworks: 12-factor (config, build/release/run, logs, dev/prod
parity), AWS Well-Architected (operational excellence, security, reliability,
performance efficiency, cost optimization, sustainability), and OWASP ASVS /
OWASP Top 10:2025.

Weights:

- Security and privacy: 18
- Code quality: 12
- Architecture and config: 12
- Performance: 12
- Deployment readiness: 12
- Database safety: 12
- Reliability and observability: 12
- Docs, accessibility, mobile, and cost: 10

Hard blockers override the score and force `NOT_READY`: failing production
build/typecheck/tests/security scanner; exposed service-role/JWT/admin DB or
payment/LLM secrets in browser/mobile code; public Supabase tables without RLS
or write policies without `WITH CHECK`; destructive production migrations
without a tested forward-only undo; payment mutations without idempotency keys;
app-store submissions missing account deletion, privacy manifest/data-safety
requirements, current target API compliance, required review metadata, or launch
checklist blockers for consent, support, account deletion, data export,
accessibility, production payment testing, backup restore evidence, or status
page/incident ownership.

Performance evidence uses current Core Web Vitals: LCP <= 2.5s, INP <= 200ms,
and CLS <= 0.1 at the 75th percentile. Prefer both Lighthouse mobile lab data
and CrUX/RUM field data; mark field data `UNVERIFIED` when unavailable.

## Stack-Specific Defaults

- React + Supabase: this is the default recommendation for new React projects
  that need a backend. Use Supabase Auth for auth, Supabase Storage for app
  files, Supabase Realtime when real-time is needed, and RLS-backed
  authorization. Keep Traffic One's RTK Query/Redux, **Tailwind v4 + shadcn/ui**
  (Radix + CVA + tailwind-merge + lucide-react), Jest, and React Hook Form + Zod
  rules unless the user explicitly chooses another stack. Add new UI primitives
  via `npx shadcn@latest add <name>` — never hand-roll a button/dialog/input.
- React Native + Expo: NativeWind v4 + React Native Reusables (`rn-primitives`)
  for UI; add primitives via `npx @react-native-reusables/cli@latest add <name>`.
- Explicit Next.js: do not add a new Traffic One stack id. When the user
  explicitly asks for Next.js, accepts it after a pitch, or the repo already has
  `next`, use NextAuth/Auth.js for auth unless the project already has Supabase
  Auth, Clerk, Auth0, or another real provider. Prefer App Router route handlers
  or server actions for server code, Next.js Cache for framework caching,
  Traffic One `/deploy` for deployment, Supabase Storage for app file storage,
  and Drizzle + PostgreSQL when adding a new SQL layer.
- Python/FastAPI: prefer FastAPI, PostgreSQL, SQLModel, pytest, Redis
  for shared cache, and Celery for durable jobs; deploy via Traffic One `/deploy`.
  Do not default to hand-rolled
  JWT/password auth; prefer a framework/provider auth integration first.
- Other stacks: prefer official framework auth/session middleware, managed auth,
  and maintained SDKs over custom crypto, JWT parsing, session stores, email,
  file storage, queues, cache, or deployment scripts.

## Auth Rule

Never reinvent end-user authentication by default.

- Next.js + auth -> NextAuth/Auth.js unless an existing provider is already in use.
- New Traffic One app + unspecified backend -> Supabase Auth plus RLS-backed
  authorization.
- Supabase + auth -> Supabase Auth plus RLS-backed authorization.
- Framework apps -> official auth/session middleware or a well-maintained provider.
- JWT code is for validating provider-issued tokens or service-to-service flows,
  not the default user auth system.

If no stack-native or provider-backed option fits, trigger `library-pick`,
document rejected options, then design the smallest custom implementation.

For package-level defaults by language and capability, consult
`rules/common/library-catalog.md` before writing custom code.
