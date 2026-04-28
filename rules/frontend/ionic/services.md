---
paths:
  - "apps/**/src/services/**"
  - "apps/**/src/features/**/api.ts"
  - "apps/**/src/features/**/services/**"
  - "packages/api-client/**"
  - "src/services/**"
  - "src/features/**/api.ts"
  - "src/features/**/services/**"
---

# Ionic Service Layer

React service rules still apply. Ionic adds a native-plugin boundary through
Capacitor.

## API services

- Cached server data lives in RTK Query.
- Plain axios services are only for uploads, downloads, and non-cacheable
  commands.
- Validate request inputs and response bodies with zod.
- Map failures to typed `AppError`; production UI never shows raw plugin,
  network, or native stack errors.

## Capacitor services

- Wrap every Capacitor plugin in a small domain service or feature hook.
- Services expose explicit return types and normalized DTOs.
- Components do not import Capacitor plugins directly.
- Permission checks, capability checks, and native result parsing happen in the
  service layer.

## Offline and platform behavior

- Network-aware services expose stale, offline, reconnecting, and retry states
  where the UI needs them.
- Queue optimistic native or network actions only when the product explicitly
  needs it; otherwise fail clearly and recoverably.
- Keep platform-specific code behind `.ios.ts`, `.android.ts`, or service
  branches that are easy to test.
