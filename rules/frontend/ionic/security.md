---
paths:
  - "capacitor.config.*"
  - "ionic.config.json"
  - "apps/**/capacitor.config.*"
  - "apps/**/ionic.config.json"
  - "apps/**/src/services/**"
  - "apps/**/src/features/**/services/**"
  - "src/services/**"
  - "src/features/**/services/**"
---

# Ionic Security Rules

React browser security rules still apply. Capacitor adds native shell, deep-link,
and permission surfaces.

## Secrets and storage

- Never store JWT access tokens or secrets in `localStorage`.
- Use httpOnly cookies or in-memory auth for web flows; use a reviewed
  Capacitor secure-storage plugin only when native persistence is required.
- No secrets in `VITE_` vars, Capacitor config, native project files, or store
  metadata.

## Native boundary

- Treat deep links, push payloads, clipboard text, camera/gallery results, file
  paths, and share targets as untrusted input.
- Validate every native-plugin payload before it reaches Redux, RTK Query cache,
  or business logic.
- Allowlist external URL schemes and hosts before opening them from the app.
- Production traffic uses HTTPS/WSS only.

## Permissions

- Request permissions at the feature boundary, not at app startup.
- Permission-denied states are explicit and recoverable.
- Native logs strip tokens, PII, exact location, contact data, and payment data.
