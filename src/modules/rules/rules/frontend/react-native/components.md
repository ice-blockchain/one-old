---
paths:
  - "apps/**/src/components/**"
  - "apps/**/src/features/**/components/**"
  - "packages/ui-native/**"
  - "src/components/**"
  - "src/features/**/components/**"
---

# React Native Component Rules

Framework-agnostic accessibility rules live in `frontend/accessibility.md`.
Native-specific accessibility lives in `frontend/react-native/accessibility.md`.

## Structure
- One component per file, file named `ComponentName.tsx`.
- Style in-file via NativeWind `className` strings; no sibling style files.
- Components stay under 150 lines; split render-only subcomponents when larger.
- Export rules (named-only, the Expo Router default-export exception) are owned by `rules/frontend/react-native/core.md`.

## Props & types
- Always declare an explicit `ComponentNameProps` interface above the component.
- Destructure props at the function signature level.
- Discriminated unions over boolean flags plus optional fields.
- Keep route params out of leaf components; parse them in the route/screen and pass typed props down.

## Rendering
- Compose UI from React Native Reusables primitives in `packages/ui-native/src/components/ui/`. Add new primitives via `npx @react-native-reusables/cli@latest add <name>`; never hand-roll a button / dialog / dropdown / form control.
- Underneath RNR, use the native primitives: `View`, `Text`, `Pressable`, `TextInput`, `Image`, `FlatList`, `SectionList`.
- Every user-visible string must be inside `Text`. i18n rules (translation keys, `react-i18next`, catalogs, hardcoded-string exceptions) live in `rules/frontend/i18n.md`.
- Use `Pressable` for actions; set `accessibilityRole` and `accessibilityLabel` when the visible label is not enough.
- Always handle loading, error, and empty states explicitly.
- Subscribe to real-time streams via hooks; components never instantiate WebSocket connections.
- Follow the design brief for hierarchy, primary action, density, and state
  treatment. Native UI should feel intentionally mobile, not like web cards
  translated into `View` wrappers.
- Use icon-only controls only when the icon is familiar and has a translated
  accessibility label; otherwise pair icon and text.

## Lists
- Use `FlatList` / `SectionList` for unbounded lists; never `.map()` large network lists in JSX.
- Provide stable `keyExtractor`, `ListEmptyComponent`, and pagination/loading footers.
- Use measured `@shopify/flash-list` only for proven list bottlenecks and document the measurement.

## Styling
- NativeWind `className` (with `cn()` / `cva`), HSL CSS-var tokens, and the dark variant are the project styling contract — see `rules/frontend/react-native/core.md` and `rules/frontend/react-native/styles.md`.

## Must not do
- No DOM tags (`div`, `span`, `button`, `a`, `input`).
- No server data copied into local component state.
- No desktop-first card grids or cramped controls on phones.
- No fixed-height text containers that break dynamic type or localization.
