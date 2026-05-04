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
- Every user-visible string must be inside `Text` and come from a translation key.
- Use `react-i18next` for visible copy, placeholders, accessibility labels, loading/error/empty states, and image accessibility copy.
- Keep translation catalogs in `packages/i18n` by default, using feature-based namespaces.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
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

## Must not do
- No DOM tags (`div`, `span`, `button`, `a`, `input`).
- No inline object styles or ad-hoc arrays created in JSX.
- No NativeWind/Tailwind class strings.
- No server data copied into local component state.
- No desktop-first card grids or cramped controls on phones.
- No fixed-height text containers that break dynamic type or localization.
