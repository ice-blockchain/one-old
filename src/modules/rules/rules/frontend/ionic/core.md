---
paths:
  - "capacitor.config.*"
  - "ionic.config.json"
  - "apps/**/capacitor.config.*"
  - "apps/**/ionic.config.json"
  - "apps/**/src/**"
  - "web/**/src/**"
  - "frontend/**/src/**"
  - "client/**/src/**"
  - "packages/**/src/**"
  - "src/**"
---

# Ionic Framework — Stack Core

Ionic is the approved hybrid-mobile overlay for a selected web product. The
default delivery model is a Capacitor shell around the existing/generated web
app while any selected compatible web profile remains authoritative. Full
Ionic UI adapters exist for React, Vue, and Angular; Next, Nuxt,
SvelteKit/Svelte, Astro, and generic-web normally use the wrapper form.
Use React Native / Expo only when the client explicitly asks for React Native,
Expo, RN, or a fully React Native implementation.

## Framework-preserving stack

- **Hybrid runtime:** Ionic Framework + Capacitor.
- **Recommended packaging:** `@capacitor/core`, `@capacitor/cli`, plus
  `@capacitor/ios` and/or `@capacitor/android` for requested targets.
- **Base application:** preserve the compiled profile's framework, router,
  source roots, state model, formatter, and design system. Do not install
  React or React-only rules for Vue or Angular.
- **Full Ionic UI adapter:** use `@ionic/react`, `@ionic/vue`, or
  `@ionic/angular` only when it matches the selected base framework and the
  user explicitly requests Ionic UI primitives.
- **Native APIs:** Capacitor plugins behind services/hooks, never ad hoc calls
  from random components.

## Full Ionic UI vs Capacitor-wrapper default (canonical)

This decision is stated once here; `components.md`, `navigation.md`, and
`capacitor.md` defer to it.

- **Default — Capacitor wrapper:** ship a Capacitor shell around the selected
  web application; keep one codebase, its existing router, and its shared
  design system. This is the recommended path for "make this site an app",
  "mobile version", "iOS/Android", or "publish to stores".
- **Full Ionic UI alternative:** use the matching React, Vue, or Angular Ionic
  adapter only when the user explicitly wants a mobile-first rewrite. Verify
  router compatibility before migrating routes; do not translate web routes
  one-for-one without checking mobile UX.
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
