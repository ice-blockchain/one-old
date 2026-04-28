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
- Co-locate styles: `ComponentName.tsx` + `ComponentName.styles.ts`.
- Components stay under 150 lines; split render-only subcomponents when larger.
- Named exports only for reusable components — no `export default`.
- Expo Router route files in `app/**` are the only default-export exception.

## Props & types
- Always declare an explicit `ComponentNameProps` interface above the component.
- Destructure props at the function signature level.
- Discriminated unions over boolean flags plus optional fields.
- Keep route params out of leaf components; parse them in the route/screen and pass typed props down.

## Rendering
- Use `View`, `Text`, `Pressable`, `TextInput`, `Image`, `FlatList`, `SectionList`, and approved shared primitives.
- Every user-visible string must be inside `Text`.
- Use `Pressable` for actions; set `accessibilityRole` and `accessibilityLabel` when the visible label is not enough.
- Always handle loading, error, and empty states explicitly.
- Subscribe to real-time streams via hooks; components never instantiate WebSocket connections.

## Lists
- Use `FlatList` / `SectionList` for unbounded lists; never `.map()` large network lists in JSX.
- Provide stable `keyExtractor`, `ListEmptyComponent`, and pagination/loading footers.
- Use measured `@shopify/flash-list` only for proven list bottlenecks and document the measurement.

## Must not do
- No DOM tags (`div`, `span`, `button`, `a`, `input`).
- No inline object styles or ad-hoc arrays created in JSX.
- No NativeWind/Tailwind class strings.
- No server data copied into local component state.
