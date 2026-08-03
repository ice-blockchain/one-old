---
name: ionic-mobile
description: >
  Use PROACTIVELY whenever the user asks for Ionic, Capacitor, a mobile app,
  mobile version, iOS/Android package, App Store/Play Store build, native
  plugin integration, mobile shell, or mobile wrapper from an existing/generated
  React web app, unless they explicitly ask for React Native, Expo, RN, or a
  fully React Native implementation. Recommend Ionic Framework with Capacitor
  packaging as the default path and present full Ionic React as the alternative.
metadata:
  source: mindrally-skills
  adapted_for: traffic-one
---

# Skill: Ionic Mobile Delivery

Use this for Ionic/Capacitor and generic mobile delivery from React web. Do not
use it for explicit React Native / Expo requests.

This skill merges the Mindrally Ionic guidance into Traffic One. Mindrally's
source skill is Angular/Cordova/Firebase-oriented; adapt its Ionic concepts to
this repo's forced stack: React, Capacitor, Supabase, Redux Toolkit/RTK Query,
**Tailwind v3.4 + shadcn/ui** (with the Ionic CSS-variable bridge from
`rules/frontend/ionic/styles.md`), i18next, Jest, and Playwright.

Apply `rules/frontend/ionic/*` together with the active React rules whenever
the work touches Capacitor config, native platform folders, mobile navigation,
mobile shell layout, Ionic components, permissions, native plugins, deep links,
or store packaging.

## Core principles

- Keep responses concise and technical, with Ionic/Capacitor examples only when
  they directly clarify the implementation.
- Use feature-based organization so mobile shell, services, components, and
  tests scale with the app.
- Prefer Ionic/Capacitor built-ins for mobile shell, overlays, platform
  behavior, and native APIs when they fit the requirement.
- Keep the React app as the source of truth unless the user explicitly accepts a
  full Ionic React migration.
- Follow `rules/frontend/ionic/*` first, then the React, frontend, core,
  security, and dependency rules.
- Treat mobile UX as a design task, not only packaging. Establish the target
  user, primary mobile action, first-screen hierarchy, safe-area/keyboard
  behavior, and visual QA plan before changing shell UI.

## Prompt to offer

Before implementation, offer this prompt in the user's language:

> I recommend Ionic Framework with Capacitor for the mobile version: we keep the
> generated React app, make the UX genuinely mobile-ready, then package the Vite
> build for iOS/Android. This is the fastest and least disruptive option.
> Alternative: a full Ionic React app if you want Ionic navigation/components and
> a mobile-first rewrite. Recommended option: Capacitor packaging. Should I
> proceed with Capacitor?

## Decision rules

- Recommended: Capacitor wrapper around the existing/generated React app.
- Alternative: full Ionic React app when the product needs Ionic navigation,
  Ionic components, or a mobile-first rewrite.
- React Native / Expo: only when the user explicitly names React Native, Expo,
  RN, or asks for a fully React Native implementation. "Mobile app",
  "iOS/Android", or "publish to stores" alone is not enough.
- Backend default: Supabase for new React + Supabase work. Do not introduce
  Firebase/AngularFire from the source skill unless preserving an existing
  project that already uses Firebase.
- Cordova/Ionic Native wrappers from the source skill are legacy guidance. Use
  Capacitor plugins and services/hooks instead.

## Project organization

For React + Capacitor, keep the existing Traffic One structure:

```text
apps/web/
|-- capacitor.config.ts
|-- src/
|   |-- features/<name>/
|   |   |-- components/
|   |   |-- hooks/
|   |   |-- api.ts
|   |   `-- services/
|   |-- services/
|   |   |-- mobile/
|   |   `-- ws/
|   |-- pages/
|   `-- styles/
`-- e2e/
```

- Put Capacitor/native integration in `services/mobile/` or feature services.
- Keep Ionic shell components thin and feature logic in hooks/services.
- Use `packages/i18n`, `packages/tailwind-config`, `packages/ui` (shadcn
  primitives), `packages/api-client`, and `packages/ws-client` for shared
  concerns.

## Capacitor wrapper checklist

1. Inspect the app's package manager, build script, and Vite output directory.
2. Add Capacitor packages through the repo package manager after the dependency
   quality gate: `@capacitor/core`, `@capacitor/cli`, and platform packages
   needed for the requested targets.
3. Initialize Capacitor with the app id/name and point `webDir` to the build
   output (`dist` by default for Vite).
4. Add iOS/Android platforms only as requested, then build and sync.
5. Wrap native APIs behind typed services/hooks with zod validation at the
   boundary.
6. Implement web fallbacks or clear unavailable states for native-only features.
7. Apply the design brief to mobile layout: reorder desktop content where needed,
   keep the primary action thumb-accessible, and avoid copying desktop card grids.
8. Verify responsive layouts, safe areas, keyboard behavior, Android back
   behavior, permissions, app icons/splash screens, deep links, and production
   build config.

## Store launch checklist

- Verify App Store Connect App Privacy answers, privacy policy/support URLs,
  age rating, review notes/demo access, and in-app account deletion when account
  creation exists.
- Include a valid iOS `PrivacyInfo.xcprivacy` for the app target and verify
  third-party SDK privacy manifests/signatures plus required-reason API
  declarations before submission.
- Verify Google Play Data Safety answers, Play App Signing, Android App Bundle
  readiness, and current target API compliance from official Google Play docs
  immediately before release.
- Prepare ASO assets: app name, subtitle/keywords for iOS, short/long Android
  descriptions, localized screenshots for required device sizes, content rating,
  app icon, and release notes.
- Use Apple In-App Purchase and Google Play Billing for digital goods unless a
  documented store-policy exception applies; do not ship Stripe in-app for
  digital goods.
- Ask camera, mic, location, notifications, contacts, files, and similar
  permissions in context after explaining the feature value; never batch native
  prompts on launch.
- Serve and verify `/.well-known/apple-app-site-association` and
  `/.well-known/assetlinks.json`; test auth callback deep links on a physical
  device.
- Run TestFlight and Play Internal Testing with at least five external testers
  before public release unless the user explicitly accepts a smaller private
  launch risk.

## Full Ionic React alternative

Use only when the user chooses the larger migration.

- Plan route stacks, tabs, modals, and page transitions before editing.
- Use Ionic primitives such as `IonPage`, `IonContent`, `IonHeader`,
  `IonFooter`, `IonList`, `IonItem`, `IonButton`, `IonFab`, `IonModal`, and
  `IonPopover` where they improve mobile behavior.
- Keep `react-hook-form` + zod for forms; adapt Ionic inputs to the form layer.
- Verify router compatibility before adding Ionic React routing packages.
- Do not convert the app to Angular patterns, SCSS component styling, or
  AngularFire.

## Styling and theming

The Ionic stack styles app content with **Tailwind v3.4 + shadcn/ui** and
bridges Ionic's `--ion-color-*` tokens to the shadcn HSL CSS variables. Full
recipe lives in `rules/frontend/ionic/styles.md` — apply it verbatim.

- `tailwindcss@^3.4` with `corePlugins.preflight: false` (Tailwind's reset
  collides with the styling Ionic primitives rely on).
- Single bridge file `src/styles/ionic-theme-bridge.css` defines the shadcn
  HSL vars (`--background`, `--foreground`, `--primary`, …) and maps them to
  `--ion-color-*` tokens. Imported once in `src/main.tsx` after Ionic core CSS.
- Inventory each UI need and search the official shadcn catalog by name,
  behavior, and synonyms. Add only the matching compiled identifiers via
  `npx shadcn@latest add <name>` into `packages/ui/src/components/ui/`; never
  hand-roll or duplicate a catalog primitive.
- Compose shadcn primitives inside `IonContent`. Inside `IonHeader` /
  `IonToolbar` prefer Ionic's tap states over shadcn buttons — the OS-feel is
  better.
- Do not add SCSS just because the source Ionic skill mentions it. Do not
  install `@aparajita/tailwind-ionic` (upstream is stale; we own the bridge).
- Use Ionic/platform-specific styling only where it solves real safe-area,
  overlay, or platform behavior. Keep all visual values in Tailwind tokens
  (`bg-primary`, `text-muted-foreground`, `rounded-lg`, …) backed by the
  shadcn HSL CSS variables, and verify mobile breakpoints.
- Modern mobile UI should be calm, clear, and task-first: tokenized spacing,
  readable type, clear state styling, and no decorative layers over controls.

## Performance

- Lazy-load page-level code and heavy native-plugin flows.
- Use virtualized/efficient list rendering for long lists.
- Optimize image loading and avoid desktop-only media in the mobile critical
  path.
- Minimize bundle size through named imports and route-level code splitting.
- Test WebView startup and scroll performance on requested mobile targets.

## Native integration

- Use Capacitor plugins for camera, geolocation, push, storage, share, files,
  and similar native capabilities.
- Never import plugin APIs directly in arbitrary components.
- Handle platform differences and permission-denied states explicitly.
- Treat native payloads as untrusted input and validate before updating app
  state.
- For real-time/native lifecycle work, handle pause, resume, reconnect, stale,
  offline, and degraded states in services.

## Environment and security

- Configure development, staging, and production endpoints explicitly.
- No secrets in `VITE_`, Capacitor config, native project files, store metadata,
  or client logs.
- Validate environment presence at startup.
- Production traffic uses HTTPS/WSS.
- Allowlist deep-link and external URL schemes/hosts.

## Testing

- Write unit tests for services, hooks, reducers, and components.
- Mock Capacitor plugins at the service/hook boundary.
- Use Playwright for responsive web routes and mobile viewport checks.
- Add native smoke checks for requested platforms before release.
- Cover app launch, auth/session restore, deep links, Android back behavior,
  keyboard input, offline/reconnect, permission prompts, and plugin errors.
- Capture mobile screenshots for visual-heavy work, including loading, empty,
  error, disabled, and permission-denied states when applicable.

## Differences to call out

- Capacitor runs the React app inside a native WebView shell.
- Native APIs are available through Capacitor plugins but require permissions
  and platform configuration.
- Full Ionic React changes more UI and routing surface than Capacitor wrapping;
  treat it as a larger migration.
- Ionic Angular/Cordova/Firebase examples from generic Ionic guidance are not
  the default here; Traffic One defaults to React + Capacitor + Supabase.
