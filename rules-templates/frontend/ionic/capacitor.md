---
paths:
  - "capacitor.config.*"
  - "ionic.config.json"
  - "apps/**/capacitor.config.*"
  - "apps/**/ionic.config.json"
  - "apps/**/ios/**"
  - "apps/**/android/**"
  - "ios/**"
  - "android/**"
---

# Ionic Capacitor Packaging Rules

## App configuration

- `webDir` points to the Vite build output (`dist` by default).
- App id uses reverse-DNS format and is stable before native platforms are added.
- App name, bundle id, version, build number, icon, and splash config are
  treated as release settings, not incidental defaults.
- Deep-link scheme and production web domain are decided before store builds.
- Native platform folders are generated through Capacitor and then kept under
  review like source code.

## Build flow

- Run the web build before syncing native projects.
- Use `npx cap sync` after dependency, plugin, or build-output changes.
- Do not edit generated native files unless the change is required for store,
  permission, signing, or plugin configuration.
- Keep iOS and Android changes separate when the platform requirements differ.

## Native plugins

- Add Capacitor plugins only for a concrete user-facing requirement.
- Wrap plugin calls in `services/` or feature hooks with explicit return types.
- Validate plugin results with zod when data crosses into app state.
- Permission prompts are just-in-time and explain the feature value in product
  copy before the native dialog appears.

## Release readiness

- Check signing, bundle identifiers, version codes, deep links, app icons, splash
  screens, privacy manifests, and store metadata before calling a mobile build
  complete.
- iOS provisioning profile/signing identity and Android keystore/alias/passwords
  live in CI/store secrets, not in git or `VITE_` env vars.
- Serve Apple Universal Links and Android App Links from the production web
  domain: `/.well-known/apple-app-site-association` and
  `/.well-known/assetlinks.json`.
- Store submission metadata includes bundle/application id, version/build bump,
  required screenshots, App Privacy/Data Safety answers, age rating, privacy
  policy URL, support URL, review notes/demo access, and iOS
  `PrivacyInfo.xcprivacy` for the app plus required third-party SDK privacy
  manifests and required-reason API usage.
- App Store Connect launch evidence includes App Privacy answers and account
  deletion inside the app when account creation is supported. Since May 1, 2024,
  Apple requires approved reasons for listed APIs used by app code or
  third-party SDKs when submitting new or updated apps.
- Google Play launch evidence includes Data Safety answers, Play App Signing,
  Android App Bundle readiness, and current target API compliance. Verify the
  current requirement in official docs before release; the documented baseline
  for new apps/updates starting August 31, 2025 is Android 15 / API level 35 or
  higher, with listed platform exceptions.
- ASO assets are release inputs: app name, subtitle and keywords for iOS,
  short/long description for Android, localized screenshots for required device
  sizes, app icon, content rating, and release notes.
- Digital goods sold in mobile apps use Apple In-App Purchase and Google Play
  Billing unless the project has a documented store-policy exception. Do not
  ship Stripe in-app for digital goods.
- Permission prompts are asked in context after a value explanation screen, not
  at app launch.
- Verify Universal Links/App Links and auth callback deep links on a physical
  device before public release.
- Run TestFlight and Play Internal Testing with at least five external testers
  before public release unless the user explicitly accepts a smaller
  private-launch risk.
- Ship a force-update/version check before release and document the OTA/live
  update provider or explain why store review is required for every fix.
