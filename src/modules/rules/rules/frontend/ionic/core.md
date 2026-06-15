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
- **React source app:** React ^18 (Ionic React's validated peer range — this
  pin is deliberate), Vite, react-router-dom v6 (`@ionic/react-router` peer),
  Redux Toolkit, RTK Query, zustand, Tailwind + shadcn/ui, i18next, and the
  React rules remain the source of truth. Styling stack, the deliberate Tailwind
  v3.4 pin, and the Ionic ↔ shadcn theme bridge are owned by
  `rules/frontend/ionic/styles.md`.
- **Native APIs:** Capacitor plugins behind services/hooks, never ad hoc calls
  from random components.

## Full Ionic React vs Capacitor-wrapper default (canonical)

This decision is stated once here; `components.md`, `navigation.md`, and
`capacitor.md` defer to it.

- **Default — Capacitor wrapper:** ship a Capacitor shell around the
  existing/generated React app; keep one React codebase, `react-router-dom v6`
  routing, and the shared shadcn UI. This is the recommended path for "make this
  site an app", "mobile version", "iOS/Android", or "publish to stores".
- **Full Ionic React alternative:** `@ionic/react` with Ionic
  navigation/components and `IonRouterOutlet`, only when the user explicitly
  wants a mobile-first rewrite. Verify router compatibility before migrating
  routes; do not translate web routes one-for-one without checking mobile UX.
- Do not create a parallel React Native app unless React Native / Expo is named
  explicitly.

## Decision rules

- Use React Native / Expo only when the client explicitly asks for React Native,
  Expo, RN, or a fully React Native implementation (see the canonical
  default-vs-rewrite decision above).
- Document app id, app name, target platforms, native plugins, and store
  requirements before adding native platform folders.

## Required UX checks

- Mobile-UX visual QA — no horizontal overflow or clipped controls, safe areas on
  notched and edge-to-edge devices, keyboard not hiding inputs or action buttons —
  follows `rules/frontend/ionic/testing.md`.
- Android back button behavior matches the current route/modal stack.
- Touch targets, focus, icon labels, and reduced-motion follow
  `rules/frontend/ionic/accessibility.md` and feel native enough for repeated use.
