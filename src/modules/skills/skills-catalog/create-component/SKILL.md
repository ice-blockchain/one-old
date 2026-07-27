---
name: create-component
description: >
  Create or change a reusable or feature-scoped web UI component under the
  runtime-compiled architecture. Trigger on component, card, modal, form,
  button, table, list, or other web UI element.
---

# Create Component

1. Read the active bootstrap envelope, `WorkUnitContractV1`, and compiled
   architecture before choosing a path.
2. Place the component in the compiled component or feature output. Never add a
   new root, move it into the entrypoint, or widen the allowlist yourself.
3. Prefer an existing framework/design-system primitive. Use shadcn only when
   the active React profile already uses it; use the native framework primitive
   for Nuxt, Laravel, or another custom web stack.
4. Give the component one responsibility. Split coordinated compound-family
   files only under the controlled same-prefix/packages-ui exception.
5. Type its public inputs, keep data access in an existing hook/service layer,
   and cover loading, empty, error, disabled, focus, and reduced-motion states
   that callers can reach.
6. Reuse tokens and existing i18n/accessibility conventions. Do not introduce a
   parallel styling, translation, state, or form system.
7. Keep heavy optional dependencies out of shared/root bundles; lazy-load them
   at the usage boundary.
8. Add focused component tests. Use Storybook or screenshots only when the
   verification contract classifies the change as visual.

Before handoff, run the touched-file structural analyzer and relevant
unit/component checks. Browser E2E and Lighthouse are not automatic component
requirements; follow `VerificationContractV2`.
