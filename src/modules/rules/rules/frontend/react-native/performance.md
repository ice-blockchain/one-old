---
paths:
  - "apps/**/app/**"
  - "apps/**/src/components/**"
  - "apps/**/src/features/**/components/**"
  - "packages/ui-native/**"
  - "src/components/**"
  - "src/features/**/components/**"
---

# React Native Performance Rules

## Runtime
- Hermes is the default engine.
- New apps use the React Native New Architecture; do not disable it to work around a library without documenting the tradeoff.
- Run Expo Doctor before adding native dependencies or upgrading SDK/RN versions.

## Rendering
- Keep component state narrow and close to the UI concern.
- Do not create style objects, arrays, or callbacks inline for memoized children.
- Use `React.memo`, `useMemo`, and `useCallback` only after profiling or for stable contract boundaries.
- Defer expensive non-urgent updates with transitions when supported.

## Lists and media
- Use `FlatList` / `SectionList` for dynamic lists; configure stable keys and pagination.
- Reach for `@shopify/flash-list` only after measuring a list bottleneck.
- Use Expo image tooling or React Native `Image` with explicit dimensions and cache strategy.
- Avoid decoding large base64 payloads in JS.

## Startup and bundles
- Keep route files thin so Expo Router can split work naturally.
- Lazy-load heavy feature modules at route or interaction boundaries.
- Avoid large all-platform imports in shared packages; isolate platform-specific code behind `.ios.ts`, `.android.ts`, or `.native.ts`.

## Real-time
- The real-time render budget (batch high-rate updates before they hit React, ~30 fps non-game cap, stale-state-under-degraded-network) is framework-agnostic — see `rules/frontend/performance.md`.
