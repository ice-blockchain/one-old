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
- Validate plugin results before they cross into app state — the zod inbound-
  payload rule is owned by `rules/frontend/ionic/security.md`.

## Permissions (canonical for the Ionic stack)

`security.md`, `components.md`, and `services` rules point here.

- Permission prompts are just-in-time: ask in context, after a screen that
  explains the feature value in product copy, never at app launch.
- Permission-denied states are explicit and recoverable.

## Release readiness

Highest-value compliance gates before calling a mobile build complete (verify
the current store requirements in official docs at release time):

- **Signing & secrets:** iOS provisioning profile/signing identity and Android
  keystore/alias/passwords live in CI/store secrets, never in git or `VITE_`
  vars. Confirm bundle/application ids and version/build codes are bumped.
- **Privacy disclosures:** iOS App Privacy answers + `PrivacyInfo.xcprivacy`
  (app and required third-party SDK manifests). Since **May 1, 2024** Apple
  requires approved reasons for listed (required-reason) APIs used by app code or
  third-party SDKs. Android Data Safety answers + Play App Signing. Offer in-app
  account deletion when account creation is supported.
- **Target-API baseline:** confirm current store target-API compliance — the
  documented baseline for new apps/updates from **Aug 31, 2025** is Android 15 /
  API level 35+ (with listed platform exceptions); verify the requirement in
  official docs at release time.
- **Store listing / ASO assets** (release inputs): app name, iOS subtitle +
  keywords, Android short/long description, localized screenshots for required
  device sizes, app icon, content rating, age rating, privacy-policy + support
  URLs, review notes/demo access, and release notes.
- **Deep links:** serve Universal Links / App Links from the production web
  domain (`/.well-known/apple-app-site-association`, `.well-known/assetlinks.json`)
  and verify them plus auth-callback deep links on a physical device.
- **Digital goods:** use Apple IAP / Google Play Billing for digital goods
  unless a documented store-policy exception exists — never Stripe in-app.
- **Pre-launch testing:** run TestFlight + Play Internal Testing with external
  testers before public release unless the user accepts a smaller private-launch
  risk; ship a force-update/version check and document the OTA/live-update path.
