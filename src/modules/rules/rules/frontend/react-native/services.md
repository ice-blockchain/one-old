---
paths:
  - "apps/**/src/services/**"
  - "apps/**/src/features/**/services/**"
  - "apps/**/src/features/**/api.ts"
  - "packages/api-client/**"
  - "src/services/**"
  - "src/features/**/services/**"
---

# React Native Service Layer

The REST/RTK-Query split, zod boundary validation, and the typed `AppError`
contract are framework-agnostic — see `rules/frontend/services.md`. This file
covers only the Expo/React Native deltas.

## Mobile concerns
- Read auth tokens from `expo-secure-store` in the shared api-client layer, not in UI.
- Retry token refresh once on 401; then dispatch logout/session-expired.
- Respect offline state: fail fast for non-queueable actions and clearly mark stale data.
- File uploads use Expo file APIs in services; components pass typed file descriptors.

## RTK Query placement
- App endpoints live in `apps/mobile/src/features/<feature>/api.ts`.
- Shared endpoints live in `packages/<name>/src/api.ts`.
- Set `keepUnusedDataFor`, `refetchOnReconnect`, and polling intentionally per endpoint.
- Optimistic updates must roll back on failure (`onQueryStarted` + `queryFulfilled` catch).

## Environment
- Public Expo config values use the approved `EXPO_PUBLIC_` surface.
- Secrets never ship in app config, JS bundles, or EAS public env.
- Validate required config at startup and map missing values to an explicit app error screen.
