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

The NativeWind/RNR styling stack is owned by `rules/frontend/react-native/core.md`.
This file holds the styling deltas (theme tokens, layout, cssInterop, prohibited
patterns).

## Setup expectations

The scaffold wires up `tailwind.config.js` (`nativewind/preset`), `babel.config.js`,
`metro.config.js` (`withNativeWind`), `global.css`, and `nativewind-env.d.ts`;
rules just enforce that they stay in place.

- `tailwindcss@^3.4` and `nativewind@^4` in `package.json` (NativeWind v4
  requires Tailwind v3 — this pin is deliberate; do not "upgrade" it to match
  the web stack's v4).

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

`cn()` / `cva` / the `dark:` variant are defined in
`rules/frontend/react-native/core.md`. RN-specific placement deltas:

- Define `cn()` once, in `packages/ui-native/src/lib/utils.ts` (RNR's init does this).
- `cva` is required for shared primitives in `packages/ui-native/src/components/ui/`.
- The `useColorScheme` hook from NativeWind controls the theme; do not branch on
  `Platform.OS` or `Appearance.getColorScheme()` for theming.

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
