---
paths:
  - "capacitor.config.*"
  - "ionic.config.json"
  - "apps/**/capacitor.config.*"
  - "apps/**/ionic.config.json"
  - "apps/**/src/**"
  - "src/**"
---

# Ionic Framework — Stack Core

Ionic is the approved hybrid-mobile path for React web products. The default
delivery model is a Capacitor shell around the existing/generated React app.
Use React Native / Expo only when the client explicitly asks for React Native,
Expo, RN, or a fully React Native implementation.

## Forced library stack — no exceptions

- **Hybrid runtime:** Ionic Framework + Capacitor.
- **Recommended packaging:** `@capacitor/core`, `@capacitor/cli`, plus
  `@capacitor/ios` and/or `@capacitor/android` for requested targets.
- **React source app:** React ^18, Vite, react-router-dom v6, Redux Toolkit,
  RTK Query, zustand, vanilla-extract, i18next, and the React rules remain the
  source of truth.
- **Native APIs:** Capacitor plugins behind services/hooks, never ad hoc calls
  from random components.
- **Full Ionic React alternative:** `@ionic/react` and Ionic navigation/components
  only when the user wants a mobile-first rewrite; verify router compatibility
  before migrating routes.

## Decision rules

- For "make this site an app", "mobile version", "iOS/Android", or
  "publish to stores", recommend Capacitor packaging first.
- Keep one React codebase unless the user accepts the larger full Ionic React
  migration.
- Do not create a parallel React Native app unless React Native / Expo is named
  explicitly.
- Document app id, app name, target platforms, native plugins, and store
  requirements before adding native platform folders.

## Required UX checks

- Mobile breakpoints have no horizontal overflow or clipped controls.
- Safe areas work on notched devices and edge-to-edge Android layouts.
- Keyboard opening does not hide active inputs or action buttons.
- Android back button behavior matches the current route/modal stack.
- Touch targets follow the frontend accessibility rules and feel native enough
  for repeated use.
