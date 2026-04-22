---
# No path filter — always loaded
---

# Core Rules (always active)

## Forced library stack — no exceptions
- **UI:** react ^18 + typescript ^5 (.tsx/.ts only)
- **Routing:** react-router-dom v6
- **Global state:** zustand (no Redux, no MobX, no Context for state)
- **Server state:** @tanstack/react-query (not the old react-query package)
- **Styling:** tailwindcss + shadcn/ui (no styled-components, no @emotion, no CSS modules)
- **Forms:** react-hook-form + zod + @hookform/resolvers
- **HTTP:** axios, wrapped in a service function — never called directly in components
- **Testing:** vitest + @testing-library/react + msw
- **Build:** vite

## Absolute rules — never break these
- Function components only. No class components.
- Named exports only. No `export default` for components.
- No `any` — use `unknown` and narrow.
- No inline `style={{}}` — Tailwind classes only.
- Props always have an explicit interface: `ComponentNameProps`.
- All API calls go through `src/services/` — never call axios in a component.
- Server state lives in React Query. Never duplicate it in Zustand.
- Features do not import from other features. Share via `src/components/`, `src/hooks/`, `src/stores/`.

## Folder structure (non-negotiable)
```
src/
├── components/ui/          shadcn primitives — never edit
├── components/common/      shared app components
├── features/[name]/        components/ hooks/ stores/ services/ types.ts index.ts
├── pages/                  thin route wrappers only — no business logic
├── hooks/                  shared custom hooks (use* prefix)
├── stores/                 global Zustand stores
├── services/               api.ts (axios instance) + per-domain files
├── lib/                    third-party setup (queryClient, etc.)
├── types/                  global TS types
└── utils/                  pure functions, no side effects
```
