---
name: create-native-component
description: >
  Use PROACTIVELY whenever the user asks to create, add, build, make, scaffold, or generate
  a React Native component, native UI element, card, modal, form, button, list item, or shared
  mobile primitive. Triggers: "create a native component", "add a React Native component",
  "make a mobile form", "build a native modal", "scaffold a mobile card", "new RN UI".
---

# Skill: Create Native Component

Use this for Expo/React Native UI. Keep React web component work in `create-component`.

Before creating files, state:
1. Placement: `apps/mobile/src/components/`, `apps/mobile/src/features/<name>/components/`, or `packages/ui-native/`.
2. Component name and explicit `ComponentNameProps` interface.
3. Style file: `ComponentName.styles.ts` using `StyleSheet.create`.
4. State/data boundary: presentational only, local state, or hook-backed.
5. Tests: colocated RNTL test when the component has interaction or state.

Scaffold rules:
- Named export only.
- Use React Native primitives or approved `@app/ui-native` primitives.
- No DOM tags, inline object styles, NativeWind/Tailwind, or axios calls.
- Loading/error/empty states are explicit when rendering async data.
- Accessibility labels/roles are part of the component contract for interactive UI.
