---
paths:
  - "apps/**/src/stores/**"
  - "apps/**/src/features/**/stores/**"
  - "apps/**/src/store/**"
  - "src/stores/**"
  - "src/features/**/stores/**"
  - "src/store/**"
---

# React Native State Management — Redux Toolkit + zustand

## Boundaries — pick exactly one

| Need | Tool |
|------|------|
| Server data (REST/WebSocket payloads, cached entities) | **RTK Query** (or a Redux slice fed by a WS service) |
| Cross-feature global business state (auth, session, game phase) | **Redux Toolkit slice** |
| Lightweight ephemeral UI state (modal open, active tab, drawer width) | **zustand** |
| Component-local state | `useState` / `useReducer` |
| Form state | `react-hook-form` |

**Hard rule**: server data lives in exactly one place — RTK Query (or a Redux slice). Never copy server data into zustand, route params, or component state.

RTK Query slice discipline (zod `transformResponse`, precise tags,
generated-hooks-only) lives in `rules/frontend/react-native/services.md`. This
file covers the RN deltas below.

## Redux Toolkit
- Store config lives in `apps/mobile/src/store/index.ts` or a shared package.
- Export `RootState`, `AppDispatch`, `useAppDispatch`, and `useAppSelector`.
- One slice per domain; export named actions and selectors.
- Use `createSelector` for non-trivial derivations.
- Middleware order: RTK Query api -> WS bridge / analytics -> defaults.

## zustand
- UI-only state: modal open, active tab hint, local draft visibility, transient ids.
- No arrays of server entities, fetched lists, auth tokens, or business state.
- One store per concern; export a typed interface and `reset()`.
- Subscribe to slices, not the whole store object.

## Persistence
- Use expo-secure-store for tokens and secrets.
- Use AsyncStorage only for non-sensitive preferences and cache hints.
- Hydration must expose loading/error states; never assume persisted state exists.
