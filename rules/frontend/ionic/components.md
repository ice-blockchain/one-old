---
paths:
  - "apps/**/src/components/**"
  - "apps/**/src/features/**/components/**"
  - "packages/ui/**"
  - "src/components/**"
  - "src/features/**/components/**"
---

# Ionic Component Rules

React component rules still apply. Ionic-specific components are allowed only
when building the full Ionic React alternative or when an Ionic primitive solves
a real mobile interaction better than the existing shared UI primitive.

## Structure

- One component per file, named export, explicit `ComponentNameProps`.
- Co-locate vanilla-extract styles in `ComponentName.css.ts`.
- Keep platform concerns at the screen/layout boundary; leaf components receive
  typed props and do not read Capacitor state directly.
- Components render loading, error, empty, offline, and permission-denied states
  when those states are possible.

## Ionic primitives

- Use `IonPage`, `IonContent`, `IonHeader`, `IonToolbar`, `IonTabs`, and
  `IonModal` only in full Ionic React flows or thin mobile shell layouts.
- Do not mix Ionic layout primitives and custom nested card shells unless the
  hierarchy remains simple and scroll behavior is verified.
- Keep forms on `react-hook-form` + zod; Ionic inputs adapt to the form layer,
  not the other way around.

## Copy and accessibility

- All visible copy, placeholders, helper text, error text, `aria-label`, and
  permission copy come from translation keys.
- Buttons and links keep semantic meaning. Icon-only controls need translated
  labels and visible focus states.
- Touch targets meet mobile accessibility requirements without relying on color
  alone for state.
