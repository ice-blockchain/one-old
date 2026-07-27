---
name: create-service
description: >
  Create or change a web-facing data service, API client, repository, composable,
  or server action under the runtime-compiled architecture. Trigger on API call,
  endpoint integration, data fetching, mutation, or backend connection for a
  web UI.
---

# Create Service

1. Read the active bootstrap envelope, capability profile,
   `WorkUnitContractV1`, and compiled architecture.
2. Use only the compiled service/feature output and allowlist. If no suitable
   output exists, request re-planning; never default to `apps/web`,
   `src/services`, or `packages/api-client`.
3. Match the framework boundary already present: client/server module for Next,
   composable/server route for Nuxt, request/action layer for Laravel
   Blade/Inertia, or the established client pattern for Vite/custom web.
4. Match the detected backend and existing transport. Reuse its HTTP client,
   schema validator, query/cache layer, auth propagation, error model, and
   cancellation conventions instead of adding a second stack.
5. Keep secrets and privileged credentials server-side. Validate untrusted
   responses at the boundary and return a typed domain result.
6. Make timeout, retry, pagination, idempotency, empty/error, and offline
   behavior explicit where the operation needs them.
7. For Supabase, reuse the project client factory; never construct a privileged
   client at browser module load or expose a service-role key. Use the existing
   runtime add-on approval gate before enabling paid/optional capabilities.
8. Add deterministic service tests with mocked transport and failure paths.

Do not ask for a redundant confirmation when the user already requested the
change. Run the relevant unit/integration checks; browser and Lighthouse work
is governed only by `VerificationContractV2`.
