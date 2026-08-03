---
paths:
  - "apps/**/src/services/**"
  - "apps/**/src/features/**/api.ts"
  - "apps/**/src/features/**/services/**"
  - "web/**/src/**"
  - "frontend/**/src/**"
  - "client/**/src/**"
  - "packages/**/src/**"
  - "packages/api-client/**"
  - "src/services/**"
  - "src/features/**/api.ts"
  - "src/features/**/services/**"
  - "src/**"
---

# Ionic Service Layer

The selected profile's service-layer contract remains authoritative for server
data, transport, schema validation, and sanitized error mapping. Ionic adds a
native-plugin boundary through Capacitor; it does not replace Vue/Angular
services with React-specific state or request libraries.

## Capacitor services

- Wrap every Capacitor plugin in a small domain service or feature hook.
- Services expose explicit return types and normalized DTOs.
- Components do not import Capacitor plugins directly.
- Permission checks, capability checks, and native result parsing happen in the
  service layer.

## Offline and platform behavior

- For connection-state labels (idle/connecting/live/reconnecting/offline/
  degraded) surfaced to network-aware UI, follow `rules/frontend/ionic/realtime.md`.
- Queue optimistic native or network actions only when the product explicitly
  needs it; otherwise fail clearly and recoverably.
- Keep platform-specific code behind `.ios.ts`, `.android.ts`, or service
  branches that are easy to test.
