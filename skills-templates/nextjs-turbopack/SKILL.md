---
name: nextjs-turbopack
description: >
  Next.js 16+ and Turbopack, plus provider-first Next.js recommendations for
  App Router projects, auth, data, cache, storage, deployment, testing, and
  common app builds such as blogs and SaaS apps.
  Triggers: "Next.js", "NextJS", "next app", "Next.js blog", "App Router",
  "Turbopack", "NextAuth", "Auth.js", "next-auth".
  If hooks are absent or auth status is unknown, do not infer "Traffic One inactive";
  ask the auth choice or run doctor, then stop before implementation.
metadata:
  source: everything-claude-code
  source_path: skills/nextjs-turbopack/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

Traffic One precedence: follow this skill only where it does not conflict with Traffic One AGENTS.md and rules/*.md. Forced stack choices, approved libraries, i18n, styling, services, state, testing, accessibility, security, and backend technology rules from Traffic One take precedence.

## Traffic One Auth Preflight

Before applying this skill, verify Traffic One auth unless the user is explicitly
asking to authenticate, check auth status, log out, or run doctor.

If status is not authenticated, do not apply this skill yet. Present the auth
choice as a host modal selector when available:
- Authenticate Traffic One (Recommended)
- Continue without Traffic One

If the user chooses Authenticate Traffic One, ask for the API key and run the
authentication command internally with `TRAFFIC_ONE_AUTH_KEY`; then verify status
internally. Do not ask the user to run bash or shell commands. If the user chooses
Continue without Traffic One, continue the user's request without Traffic One
features and do not repeat the auth prompt while that choice remains active.
Stop and wait for the choice or API key as appropriate. Do not ask Traffic One
onboarding questions, write `.traffic-one/.one.json`, create `.traffic-one/`, run
Traffic One agents, or use Traffic One reporting unless the user authenticates.

If hooks are absent or auth status is unknown, do not infer "Traffic One
inactive" and continue. Treat Traffic One as unverified: run or recommend
`node scripts/doctor.cjs` (or `node scripts/doctor.cjs --session <id>` when
debugging a transcript), ask the auth choice, and stop before scaffolding,
installs, source edits, Traffic One agents, or implementation skills. Only
continue ordinary work without Traffic One after the user explicitly chooses
"Continue without Traffic One".

Traffic One onboarding guard: Do not read, invoke, or activate during Traffic One new-project
onboarding before `.traffic-one/.one.json` has `onboardingComplete: true` and
`.traffic-one/plan.md` exists. Use `detect-project` / `stack-setup` first, then
return here after the stack, mobile, code graph, and team gates are resolved.

# Next.js and Turbopack

Traffic One recommends the default React/Vite + Supabase stack first for new
complex projects. When the user explicitly chooses Next.js, or an existing repo
already has `next`, use `stack=custom-frontend` with `frontend=nextjs` and apply
provider-first Next.js defaults instead of the React/Vite forced stack.

Next.js 16+ uses Turbopack by default for local development: an incremental bundler written in Rust that significantly speeds up dev startup and hot updates.

## When to Use

- **Turbopack (default dev)**: Use for day-to-day development. Faster cold start and HMR, especially in large apps.
- **Webpack (legacy dev)**: Use only if you hit a Turbopack bug or rely on a webpack-only plugin in dev. Disable with `--webpack` (or `--no-turbopack` depending on your Next.js version; check the docs for your release).
- **Production**: Production build behavior (`next build`) may use Turbopack or webpack depending on Next.js version; check the official Next.js docs for your version.

Use when: building or reviewing a Next.js app, adding auth to a Next.js blog or
SaaS app, developing or debugging Next.js 16+ apps, diagnosing slow dev startup
or HMR, or optimizing production bundles.

## Provider-First Defaults

- Auth: use NextAuth/Auth.js unless the project already uses Supabase Auth,
  Clerk, Auth0, or another real provider. Do not hand-roll password/JWT/session
  auth for a blog or SaaS app.
- Server code: prefer App Router route handlers and server actions where they
  fit the workflow; keep authorization checks server-side.
- Database/ORM: prefer PostgreSQL; use Drizzle for new JS SQL layers unless an
  existing ORM is already established.
- Cache: use Next.js Cache primitives for framework-level caching before adding
  Redis. Use Redis/Upstash only for shared mutable cache, rate limits, queues,
  or cross-instance coordination.
- Storage: use Vercel Blob for app-owned files on Vercel; use Supabase Storage
  when the project already uses Supabase.
- Deployment: Vercel is the default for Next.js unless the user has an existing
  platform.
- Testing: follow the active repo, but prefer Vitest for new Next.js test setup
  when no Traffic One forced test stack is already active.
- Email/payments/observability: Resend, Stripe, and Sentry before custom code.

## How It Works

- **Turbopack**: Incremental bundler for Next.js dev. Uses file-system caching so restarts are much faster (e.g. 5–14x on large projects).
- **Default in dev**: From Next.js 16, `next dev` runs with Turbopack unless disabled.
- **File-system caching**: Restarts reuse previous work; cache is typically under `.next`; no extra config needed for basic use.
- **Bundle Analyzer (Next.js 16.1+)**: Experimental Bundle Analyzer to inspect output and find heavy dependencies; enable via config or experimental flag (see Next.js docs for your version).

## Examples

### Commands

```bash
next dev
next build
next start
```

### Usage

Run `next dev` for local development with Turbopack. Use the Bundle Analyzer (see Next.js docs) to optimize code-splitting and trim large dependencies. Prefer App Router and server components where possible.

## Best Practices

- Stay on a recent Next.js 16.x for stable Turbopack and caching behavior.
- If dev is slow, ensure you're on Turbopack (default) and that the cache isn't being cleared unnecessarily.
- For production bundle size issues, use the official Next.js bundle analysis tooling for your version.
- For auth requests, wire the provider and route/session helpers first; avoid
  custom JWT utilities unless validating provider-issued tokens at a boundary.
