---
paths:
  - "apps/**/src/store/**"
  - "apps/**/src/features/**/slice.ts"
  - "apps/**/src/features/**/store.ts"
  - "web/**/src/**"
  - "frontend/**/src/**"
  - "client/**/src/**"
  - "packages/**/src/**"
  - "src/store/**"
  - "src/features/**/slice.ts"
  - "src/features/**/store.ts"
  - "src/**"
---

# Ionic State Management

The selected profile's state-ownership rules remain authoritative, including
the "server data lives in exactly one place" invariant. Ionic-specific state
describes mobile shell and native capability concerns without duplicating
server data or importing a React store into Vue/Angular.

## Mobile shell ownership delta

- Ephemeral mobile shell state stays in the base framework's selected local
  store: active sheet, transient scanner state, dismissed permission explainer,
  or temporary keyboard layout state.
- Native capability state is normalized before it enters application state.

## Persistence

- Persist only intentional preferences and session-safe shell state.
- Do not persist raw plugin payloads, secrets, tokens, or server entities.
- Hydrated state exposes loading and error states; never assume native storage
  or persisted state is available.

## Selectors

- Keep typed selectors/computed state in the base framework's store layer for
  derived shell state combining route, network, permission, or auth state.
