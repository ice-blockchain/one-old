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
3. Inventory the component's controls, overlays, feedback, loading, empty, and
   error states. Inspect `@app/ui` first, then search the official catalog of
   the adapter selected by `profile.uiSystem` by name, behavior, and synonyms.
   If a match exists, add its exact `uiPrimitives` identifier through the
   adapter CLI into `packages/ui`, export it from the package API, and compose
   it here. Never hand-roll or duplicate a catalog primitive.
4. If no direct catalog match exists, compose active catalog primitives. A new
   custom base component is allowed only after the official lookup confirms no
   equivalent; record search terms, result, and justification in the handoff.
   Reusable domain-agnostic compositions use compiled
   `placement: "shared-ui"` outputs; feature-specific components remain in the
   application.
5. Give the component one responsibility. Split coordinated compound-family
   files only under the controlled same-prefix/packages-ui exception.
6. Type its public inputs, keep data access in an existing hook/service layer,
   and cover loading, empty, error, disabled, focus, and reduced-motion states
   that callers can reach.
7. Reuse tokens and existing i18n/accessibility conventions. Do not introduce a
   parallel styling, translation, state, or form system.
8. Keep heavy optional dependencies out of shared/root bundles; lazy-load them
   at the usage boundary.
9. Add focused component tests. Use Storybook or screenshots only when the
   verification contract classifies the change as visual.

Before handoff, run the touched-file structural analyzer and relevant
unit/component checks. Browser E2E and Lighthouse are not automatic component
requirements; follow `VerificationContractV2`.
