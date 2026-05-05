---
paths:
  - "apps/**/src/components/**"
  - "apps/**/src/features/**/components/**"
  - "apps/**/src/styles/**"
  - "packages/ui-native/**"
  - "**/global.css"
  - "**/tailwind.config.*"
  - "**/nativewind-env.d.ts"
---

# React Native Styling Rules

Stack: **NativeWind v4** (Tailwind for React Native) + **React Native
Reusables (RNR)** primitives + `rn-primitives` for accessible behaviour.

## Setup expectations

The scaffold puts these in place; rules just enforce that they stay there.

- `tailwindcss@^3.4` and `nativewind@^4` in `package.json`.
- `tailwind.config.js` extends `nativewind/preset` and points `content` at
  `app/`, `src/`, and `packages/ui-native/`.
- `babel.config.js` includes the `babel-preset-expo` `jsxImportSource: "nativewind"`
  setting and `nativewind/babel`.
- `metro.config.js` wraps the Expo default with `withNativeWind` and points at
  the project's `global.css`.
- `global.css` contains the Tailwind `@tailwind base/components/utilities`
  directives and the shadcn HSL theme block (light + dark).
- `nativewind-env.d.ts` carries the `<reference types="nativewind/types" />`
  triple-slash directive.

## Theme tokens

- Theme values are HSL CSS variables in `global.css`: `--background`,
  `--foreground`, `--primary`, `--primary-foreground`, `--muted`,
  `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`,
  `--destructive-foreground`, `--border`, `--ring`, `--card`, `--card-foreground`,
  `--popover`, `--popover-foreground`.
- Reference them via Tailwind utility classes (`bg-background`, `text-foreground`,
  `border-border`, …) — never hardcode hex / rgb values.
- For values that need to cross from CSS-vars into JS (e.g. animated colours),
  read them via NativeWind's `vars()` helper.

## className conventions

- Merge classes with `cn()` (= `clsx` + `tailwind-merge`). Define `cn()` once,
  in `packages/ui-native/src/lib/utils.ts` (RNR's init does this).
- Variants via `class-variance-authority` (`cva`) — required for shared
  primitives in `packages/ui-native/src/components/ui/`.
- Dark mode via the `dark:` variant. The `useColorScheme` hook from NativeWind
  controls the theme; do not branch on `Platform.OS` or `Appearance.getColorScheme()`
  for theming.

## Layout

- Tailwind utilities for spacing, flex, sizing. Avoid arbitrary values
  (`w-[373px]`) when a token (`w-96`) fits.
- Use `SafeAreaView` / `react-native-safe-area-context` at screen boundaries.
- Respect dynamic type: avoid fixed heights around text; use `numberOfLines`
  only when truncation is intentional.
- Use `hitSlop` for small icon-only actions instead of visually inflating icons.
- Use tokenized density tiers for compact, standard, and spacious layouts when a
  screen must work across small phones and tablets.
- Primary actions should remain reachable in one-handed use without covering
  text inputs, system gestures, or safe-area insets.
- Verify visual-heavy work on at least one small phone and one larger device
  size, including loading/empty/error states.

## Third-party RN components

- If a third-party component does not accept `className`, wrap it once with
  `cssInterop()` (NativeWind helper) in `packages/ui-native/src/lib/css-interop.ts`.
  Never add `cssInterop` calls scattered across feature code.

## Prohibited

- No vanilla-extract, `.css.ts`, styled-components, `@emotion`, CSS modules.
- No inline `style={{ ... }}` for static styling. Inline `style` is reserved
  for dynamic/animated values returned by Reanimated worklets or computed
  positioning that Tailwind cannot express.
- No raw `StyleSheet.create({ ... })` for static styles. `StyleSheet.create`
  is allowed only for dynamic/derived stylesheets that NativeWind cannot model.
- No magic numbers when a Tailwind token exists.
- No layout driven by JS media checks unless platform APIs are required.
