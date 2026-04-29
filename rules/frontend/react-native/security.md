---
paths:
  - "apps/**/app/**"
  - "apps/**/src/services/**"
  - "apps/**/src/features/**/api.ts"
  - "apps/**/src/features/**/services/**"
  - "packages/api-client/**"
  - "src/services/**"
---

# React Native Security Rules

## Secrets and config
- No hardcoded secrets in JS, app config, native config, or EAS public env.
- Tokens and refresh secrets live in expo-secure-store.
- AsyncStorage is only for non-sensitive preferences.
- Public runtime config uses `EXPO_PUBLIC_` and is validated at startup.

## Auth and authorization
- UI gating is not authorization; every protected endpoint still checks authz server-side.
- Prefer the backend/provider auth SDK already chosen for the app, such as
  Supabase Auth with Expo deep-link handling, before custom token handling.
- Refresh tokens retry once, then clear session and route to auth.
- Never log Authorization headers, tokens, cookies, exact location, contacts, or payment data.

## Deep links and input
- Validate deep-link paths and params with zod before use.
- Treat push notification payloads, clipboard content, QR scans, and native intents as untrusted input.
- Do not open arbitrary URLs; allowlist schemes/hosts for external links.

## Network
- Production traffic uses HTTPS/WSS only.
- Certificate pinning requires an explicit threat model and rotation plan before adoption.
- Map errors to typed `AppError`; production UI never shows stack traces or internal paths.

## Native modules
- Prefer Expo SDK modules.
- Before adding a native dependency, run the dependency quality gate and Expo Doctor compatibility check.
- Document rejected native alternatives in the commit body when adding a new native module.
