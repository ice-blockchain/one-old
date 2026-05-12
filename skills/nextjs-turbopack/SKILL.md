---
name: nextjs-turbopack
description: >
  Next.js 16+ and Turbopack, plus provider-first Next.js recommendations for
  App Router projects, auth, data, cache, storage, deployment, testing, and
  common app builds such as blogs and SaaS apps.
  Triggers: "Next.js", "NextJS", "next app", "Next.js blog", "App Router",
  "Turbopack", "NextAuth", "Auth.js", "next-auth".
metadata:
  source: everything-claude-code
  source_path: skills/nextjs-turbopack/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

Traffic One precedence: follow this skill only where it does not conflict with Traffic One AGENTS.md and rules/*.md. Forced stack choices, approved libraries, i18n, styling, services, state, testing, accessibility, security, and backend technology rules from Traffic One take precedence.

# Next.js and Turbopack

Next.js is not a first-class Traffic One stack id. When the user explicitly
chooses Next.js, or an existing repo already has `next`, keep `stack=minimal`
with `frontend=nextjs` and apply provider-first Next.js defaults instead of the
React/Vite forced stack.

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
