---
paths:
  - "capacitor.config.*"
  - "ionic.config.json"
  - "apps/**/capacitor.config.*"
  - "apps/**/ionic.config.json"
  - "apps/**/src/services/**"
  - "apps/**/src/features/**/services/**"
  - "web/**/src/**"
  - "frontend/**/src/**"
  - "client/**/src/**"
  - "packages/**/src/**"
  - "src/services/**"
  - "src/features/**/services/**"
  - "src/**"
---

# Ionic Security Rules

The selected web profile's browser security rules still apply. Capacitor adds
native shell, deep-link, and permission surfaces.

## Secrets and storage

- Never store JWT access tokens or secrets in `localStorage`.
- Use httpOnly cookies or in-memory auth for web flows; use a reviewed
  Capacitor secure-storage plugin only when native persistence is required.
- No secrets in `VITE_` vars, Capacitor config, native project files, or store
  metadata.

## Native boundary

- Treat deep links, push payloads, clipboard text, camera/gallery results, file
  paths, and share targets as untrusted input.
- **Inbound-payload validation (canonical for the Ionic stack):** validate
  every native-plugin / deep-link / realtime payload with the schema validator
  selected by the base profile before it reaches application state or business
  logic. `capacitor.md`,
  `navigation.md`, `realtime.md`, and `services` rules point here.
- Allowlist external URL schemes and hosts before opening them from the app.
- Production traffic uses HTTPS/WSS only.

## Permissions

- Request permissions at the feature boundary — the just-in-time prompt rule is
  owned by `rules/frontend/ionic/capacitor.md`.
- Native logs strip tokens, PII, exact location, contact data, and payment data.

## Native crash reporting

- Capacitor releases need native crash reporting for failures the browser SDK
  cannot see. Prefer the Sentry Capacitor SDK when Sentry is already the app's
  error tracker; Firebase Crashlytics is acceptable only when the project
  already uses Firebase or the user explicitly chooses it.
- Upload iOS dSYM and Android mapping/native symbols in CI for every release,
  tied to the same commit-SHA release/version used by the web bundle.
- Crash breadcrumbs and custom keys must avoid tokens, emails, payment fields,
  precise location, contacts, and other PII.
