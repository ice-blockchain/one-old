---
# No path filter — always loaded
---

# Core Rules (always active)

## Forced library stack — no exceptions
- react ^18 + typescript ^5 (.tsx/.ts only)
- Routing: react-router-dom v6
- Global state: zustand (no Redux, MobX, Context for state)
- Server state: @tanstack/react-query
- Styling: tailwindcss + shadcn/ui (no styled-components, @emotion, CSS modules)
- Forms: react-hook-form + zod + @hookform/resolvers
- HTTP: axios in service functions — never called directly in components
- Testing: vitest + @testing-library/react + msw
- Build: vite

## Absolute rules — never break these
- Function components only
- Named exports only — no `export default` for components
- No `any` — use `unknown` and narrow
- No inline `style={{}}` — Tailwind only
- Props always have an explicit `ComponentNameProps` interface
- All API calls go through `src/services/` — never axios in a component
- Server state lives in React Query — never duplicated in Zustand
- Features do not import from other features directly
