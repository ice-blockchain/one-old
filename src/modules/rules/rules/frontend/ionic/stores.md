---
paths:
  - "apps/**/src/store/**"
  - "apps/**/src/features/**/slice.ts"
  - "apps/**/src/features/**/store.ts"
  - "src/store/**"
  - "src/features/**/slice.ts"
  - "src/features/**/store.ts"
---

# Ionic State Management

The state-ownership boundary table and the "server data lives in exactly one
place" hard rule live in `rules/frontend/react/stores.md` and apply in full.
Ionic-specific state describes mobile shell and native capability concerns
without duplicating server data.

## Mobile shell ownership delta

- Ephemeral mobile shell state may use zustand: active sheet, transient scanner
  state, dismissed permission explainer, or temporary keyboard layout state.
- Native capability state is normalized before it enters Redux/zustand.

## Persistence

- Persist only intentional preferences and session-safe shell state.
- Do not persist raw plugin payloads, secrets, tokens, or server entities.
- Hydrated state exposes loading and error states; never assume native storage
  or persisted state is available.

## Selectors

- Use typed `useAppSelector` / `useAppDispatch`.
- Use `createSelector` for derived mobile shell state that combines route,
  network, permission, or auth state.
