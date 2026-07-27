---
name: create-feature
description: >
  Create or change a web feature/module under the runtime-compiled
  architecture. Trigger on feature, module, domain slice, CRUD flow, list/detail
  flow, or a coordinated set of web UI behavior.
---

# Create Feature

1. Read the active bootstrap envelope, `WorkUnitContractV1`,
   `architecture-v1.json`, and `verification-v2.json`.
2. Match the requested behavior to the compiled semantic module and route
   outputs. If they are absent, request re-planning; never invent a root or
   widen the allowlist.
3. Follow the detected framework and existing project convention. A Vite
   feature folder is not a Next, Nuxt, Blade, or Inertia convention.
4. Keep entrypoints and router shells thin. Put route targets, feature logic,
   reusable components, and data access in their compiled layers.
5. Give each module one product responsibility and keep public contracts
   explicit. Do not introduce a parallel state, form, translation, styling, or
   data-fetching system.
6. Cover reachable loading, empty, error, degraded/offline, permission,
   pending/optimistic, focus, and reduced-motion states.
7. Preserve route-level splitting. Lazy-load heavy feature-only dependencies
   and contain third-party scripts and media outside the critical path.
8. Add focused unit/component/integration tests in allowlisted test outputs.

Before handoff, run the touched-file structural check and relevant stack checks.
Follow `VerificationContractV2`: browser behavior only for `behavioral` or
`visual`, screenshots only for the listed visual widths, and Lighthouse only
when the performance contract requires it.
