---
name: create-native-component
description: >
  Use PROACTIVELY only when the user explicitly asks to create, add, build,
  make, scaffold, or generate a React Native / Expo component, RN UI element,
  native screen component, card, modal, form, button, list item, or shared
  React Native primitive. Triggers: "React Native component", "Expo component",
  "RN UI", "native component in React Native", "React Native form".
---

# Skill: Create Native Component

Use this for explicit Expo/React Native UI. Keep generic mobile variants in
`ionic-mobile` and React web component work in `create-component`.

Before creating files, state:
1. Placement: `apps/mobile/src/components/`, `apps/mobile/src/features/<name>/components/`, or `packages/ui-native/`.
2. Component name and explicit `ComponentNameProps` interface.
3. Style file: `ComponentName.styles.ts` using `StyleSheet.create`.
4. State/data boundary: presentational only, local state, or hook-backed.
5. Native design brief: user goal, primary action, visual direction, density, touch target needs, and required states.
6. Token plan: spacing, typography, color, radius, borders, motion, and safe-area/dynamic-type behavior from `@app/design-tokens`.
7. Tests: colocated RNTL test when the component has interaction or state.
8. i18n namespace/key pattern and catalog location in `packages/i18n`.
9. Translation consumption: `useTranslation`, `t`, or `<Trans>`.
10. Visual QA plan: small phone and larger device screenshots or Storybook/native preview states when available.

Scaffold rules:
- Named export only.
- Use React Native primitives or approved `@app/ui-native` primitives.
- No DOM tags, inline object styles, NativeWind/Tailwind, or axios calls.
- Loading/error/empty states are explicit when rendering async data.
- Visible copy, placeholders, accessibility labels/hints, image accessibility copy, and loading/error/empty states use translation keys.
- Accessibility labels/roles are part of the component contract for interactive UI.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
- Do not translate web card grids into native wrappers. Native components must be thumb-friendly, dynamic-type-safe, and visually quiet unless the brief calls for expressiveness.
