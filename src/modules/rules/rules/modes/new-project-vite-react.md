---
description: "Apply only when runtime selected the default stack with CompiledArchitectureV1 profileId=vite-react: route to the full pnpm/Turborepo, React/Vite, and Supabase scaffold."
---

# New Project Profile — Default Vite React

This rule is active only when both conditions are true:

- `.traffic-one/.one.json` selects the default stack (or its legacy
  `react-realtime-monorepo` alias); and
- the immutable runtime capability/architecture profile is `vite-react`.

Do not apply it to Next.js, Nuxt, Laravel, backend-only, native, or other custom
profiles, even when the repository is empty.

## Default architecture

The runtime compiles the pnpm + Turborepo workspace outputs for `apps/web`,
shared `packages/*`, and the backend baseline selected during onboarding. The
eligible implementer(s), not the architect, create those package/workspace,
Tailwind, barrel, source, test, and configuration files from their
`WorkUnitContractV1` allowlists. Backend-backed product features use the real
Supabase contract, env validation, migrations, and RLS baseline before demo
fixtures or local fallback data.

The complete annotated tree and package boundaries are read-on-demand at
`rules/modes/new-project-architecture.md`. The ordered implementation checklist
is read-on-demand at `rules/modes/new-project-setup.md`. Eligible implementers
read only the slices relevant to their compiled outputs before scaffolding this
profile.

## Required order

1. Workspace skeleton and deterministic toolchain.
2. Canonical project memory and runtime-materialized rules/skills.
3. Shared packages before application implementation.
4. Supabase baseline when selected by the compiled backend contract.
5. UI design, internationalization, accessibility, and route metadata gates.
6. `apps/web` scaffold, real tests, CI, deployment artifacts, and documentation.
7. Stack-selected verification and codebase graph after the first valid build.

Never start feature implementation while an earlier required baseline is
missing. Do not replace this profile with a flat root Vite application.
