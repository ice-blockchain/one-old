---
paths:
  - "apps/**/src/App.tsx"
  - "apps/**/src/routes.tsx"
  - "apps/**/src/pages/**"
  - "apps/**/src/features/**/routes/**"
  - "src/App.tsx"
  - "src/routes.tsx"
  - "src/pages/**"
---

# Ionic Navigation Rules

The Capacitor-wrapper-default vs full-Ionic-React-rewrite decision is owned by
`rules/frontend/ionic/core.md`. This file covers the routing specifics for each.

## Capacitor wrapper routing

- Keep `react-router-dom v6` as the source routing model for packaged React apps.
- Route params contain ids and filters only; validate external/deep-link params
  before use (the zod inbound-payload rule is owned by
  `rules/frontend/ionic/security.md`).
- Android back button maps to route pop, modal close, or explicit app-exit
  behavior. Do not let it close the app from an inner route unexpectedly.
- Deep links enter through a small boundary that normalizes URLs before routing.

## Full Ionic React routing

- `IonRouterOutlet`, tabs, and stack navigation must be planned per top-level
  workflow; do not translate web routes one-for-one without checking mobile UX.
- Verify router compatibility before adding Ionic React Router packages.
- Keep route wrappers thin; feature logic stays in hooks/services/components.

## State and auth

- Auth guards live at route/layout boundaries and still require server-side
  authorization.
- Do not pass full server entities through navigation state.
- Persist only intentional navigation state across app restarts.
