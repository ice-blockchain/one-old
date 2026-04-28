---
paths:
  - "apps/**/app/**"
  - "apps/**/src/**"
  - "packages/ui-native/**"
  - "src/**"
---

# React Native (Expo) — Stack Core

Forced library list and absolute rules for Expo-first React Native apps. Detail
rules live in `rules/frontend/react-native/*`.

Use this stack only when the client explicitly asks for React Native, Expo, RN,
or a fully React Native implementation. Generic mobile variants of React web
products use Ionic Framework with Capacitor instead.

## Forced library stack — no exceptions

### Runtime
- **App:** Expo SDK + React Native + TypeScript, Hermes, New Architecture.
- **Routing:** Expo Router with typed routes.
- **State:** Redux Toolkit + RTK Query for server/business state; zustand only for ephemeral UI.
- **I/O:** axios in services or RTK Query; WebSocket/socket.io-client behind service singletons.
- **Forms/storage:** react-hook-form + zod; expo-secure-store for secrets.
- **i18n:** i18next + react-i18next; expo-localization for device locale detection; shared typed resources default to `packages/i18n`.
- **Animation/gestures:** react-native-reanimated + react-native-gesture-handler.

### Build, styling, testing
- Expo CLI locally, EAS Build/Submit for native builds, Metro bundler.
- `StyleSheet.create` in sibling `*.styles.ts`; design tokens from `packages/design-tokens`.
- No NativeWind, Tailwind, styled-components, @emotion, CSS modules, DOM tags, or inline object styles.
- jest + jest-expo + @testing-library/react-native; msw/fakes for services; Maestro for device E2E.

## Absolute rules

- Function components only. Named exports for reusable components.
- Expo Router route files may use `export default` because the router requires it; keep them thin and compose named feature components.
- Explicit `ComponentNameProps`; native primitives or approved shared primitives only.
- API calls via services/RTK Query; never axios or `new WebSocket()` in components.
- User-facing text, placeholders, labels, loading/error/empty copy, image accessibility copy, and accessibility labels come from translation keys.
- Server state in RTK Query/Redux only; never duplicate into zustand/component state.
- Cross-package imports use workspace names (`@app/ui-native`, `@app/utils`).
- Monorepo default: `apps/mobile/app`, `apps/mobile/src/features/*`, `packages/ui-native`.

## i18n defaults

- New apps use `packages/i18n` for locale config, typed resources, and feature-based namespaces.
- React Native apps read the device locale through `expo-localization` and feed it into i18next.
- Existing apps with a mature i18n package may keep it, but new UI copy still uses `i18next`/`react-i18next`.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
