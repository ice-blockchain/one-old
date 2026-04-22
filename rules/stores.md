---
paths:
  - "src/stores/**"
  - "src/features/**/stores/**"
---

# State Management Rules

## When to use what
| Need | Tool |
|------|------|
| Component-local ephemeral state | `useState` / `useReducer` |
| Shared UI/client state (modals, filters, selections) | Zustand store |
| Server data (API responses) | React Query — never copy into Zustand |
| Form state | react-hook-form |

## Zustand store rules
- Never store server data in Zustand — that belongs in React Query cache.
- One store per domain or feature. No single global mega-store.
- Export a typed interface for the store: `interface FeatureStore { ... }`.
- Use `immer` middleware only when state updates are deeply nested.
- Selectors: subscribe to slices, not the entire store object, to avoid unnecessary re-renders.
- Reset logic: expose a `reset()` action for cleanup on unmount or logout.

## React Query rules
- `queryKey` arrays must be stable and fully descriptive: `['users', userId, 'posts']`.
- Set `staleTime` explicitly — never rely on the default 0 (causes waterfalls).
- Use `select` to transform/reshape data rather than doing it in the component.
- Invalidate only the minimum necessary keys after mutations.
- Prefetch on hover/focus for anticipated navigations.
