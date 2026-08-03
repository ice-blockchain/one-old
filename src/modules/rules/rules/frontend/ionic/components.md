---
paths:
  - "apps/**/src/components/**"
  - "apps/**/src/features/**/components/**"
  - "web/**/src/**"
  - "frontend/**/src/**"
  - "client/**/src/**"
  - "packages/**/src/**"
  - "packages/ui/**"
  - "src/components/**"
  - "src/features/**/components/**"
  - "src/**"
---

# Ionic Component Rules

The selected profile's component rules still apply. Ionic-specific components
are allowed only when building the matching full Ionic UI alternative (the
default-vs-rewrite decision is owned by `rules/frontend/ionic/core.md`) or when
an Ionic primitive solves a real mobile interaction better than the existing
shared UI primitive.

## Structure

- Follow the base framework's component/export/props conventions.
- Preserve its selected styling and design system; do not introduce Tailwind,
  shadcn, or a React component model into Vue or Angular solely for Ionic.
- Keep platform concerns at the screen/layout boundary; leaf components receive
  typed props and do not read Capacitor state directly.
- Components render loading, error, empty, offline, and permission-denied states
  when those states are possible.
- Mobile UI follows the active design brief: primary action, scan order,
  state coverage, and safe-area behavior are part of the component contract.

## Composing the selected design system inside Ionic chrome

- Existing primitives compose inside the matching Ionic content/page shell and
  keep the same design tokens through one reviewed theme bridge.
- Keep Ionic's own primitives for mobile-shell concerns where they earn their
  weight: `IonPage`, `IonContent`, `IonHeader`, `IonToolbar`, `IonTabs`, and
  modals/sheets that need native-feeling presentation. Inside `IonHeader` /
  `IonToolbar` prefer the matching Ionic adapter's tap states over a generic
  web button when the native-feeling interaction is material.
- Forms keep the base framework's validated form stack and accessible error
  presentation.

## Ionic primitives

- Use the equivalent Ionic page/content/header/toolbar/tabs/modal primitives
  only in full Ionic UI flows or thin mobile shell layouts.
- Do not mix Ionic layout primitives and custom nested card shells unless the
  hierarchy remains simple and scroll behavior is verified.
- Avoid copying desktop card grids into mobile shells. Reorder content, collapse
  secondary controls, and keep bottom actions reachable without blocking inputs.

## Copy and accessibility

- All visible copy, placeholders, helper text, error text, `aria-label`, and
  permission copy come from translation keys.
- Touch targets, icon-only labels, focus states, and reduced-motion follow
  `rules/frontend/ionic/accessibility.md`; do not restate those thresholds here.
- Run the mobile-UX visual QA (clipped text, hidden controls, keyboard overlap,
  safe-area collisions) before delivery per `rules/frontend/ionic/testing.md`.
