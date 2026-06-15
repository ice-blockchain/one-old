---
description: "Apply when scaffolding a brand-new Traffic One project: the full setup flow, gates, and project structure."
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

## Mandatory frontend baselines

The blocking frontend baselines (i18n by default, per-route SEO metadata, the
shared EnvBanner/setup CTA to `https://traffic.io/`) are owned by the setup
steps — see `rules/modes/new-project-setup.md` (steps 2, 5, 7, 12).

## Target architecture

pnpm + Turborepo monorepo: `apps/web` (React/Vite) plus shared `packages/*`
(ui, api-client, i18n, config), Supabase under `supabase/`, project memory
under `.traffic-one/`. The full annotated tree and package boundaries live in
`rules/modes/new-project-architecture.md` — read it before scaffolding.

## Setup checklist (do these in order, do not skip)

The detailed steps live in `rules/modes/new-project-setup.md` — read it BEFORE
scaffolding and follow it step by step. The order is:

1. Workspace skeleton (package.json, pnpm-workspace, turbo, tsconfig, git).
2. Project memory baseline (`.traffic-one/` files + active stack bundle).
3. Shared packages first (`packages/*` before apps).
4. Supabase backend baseline (when backend is supabase/our-fork).
5. Mandatory frontend design gate.
6. App scaffold (`apps/web`).
7. Mandatory SEO baseline.
8. CI/CD pipeline (Turborepo caching).
9. Deployment artifact baseline.
10. Tooling guards.
11. Mandatory auto-documentation baseline.
12. Supabase setup details (when backend is supabase/our-fork).
13. Codebase graph (after first successful build).

Never start feature code with earlier steps unfinished or unverified.

## What happens when the user asks to build something

- Acknowledge mode: **new project, monorepo not yet scaffolded**.
- If the request implies backend-backed features, state that Supabase is the
  selected default backend and include it in the scaffold.
- Confirm with the user **once**: "I'll scaffold the Turborepo workspace as above before any feature code. Proceed?"
- On yes: scaffold in the order above. Stop after each step to verify (`pnpm install`, `pnpm -w turbo run lint typecheck`).
- On no: ask which constraint they want relaxed; do not silently skip steps.
- Never write feature code into a missing skeleton.
