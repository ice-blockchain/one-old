# traffic-one — Codex CLI
<!-- SOURCE OF TRUTH for rules content: rules/*.md — update there first, then mirror here -->

You are working in a React + TypeScript project. Every rule below is mandatory.
Never suggest an alternative library to those listed here.

---

## Clean-code baseline (always)
- KISS, DRY (only after 2–3 real repetitions), YAGNI.
- Immutability: return new objects/arrays, never mutate inputs. `const` by default.
- Names describe intent; booleans start with `is`/`has`/`should`/`can`; no `any`.
- Files 200–400 lines; functions do one thing (~50 lines max); early returns over nesting.
- Handle every error explicitly; validate all input at boundaries with a schema.

## Security baseline (always)
- No hardcoded secrets. All secrets via env vars, presence checked at startup.
- Parameterized SQL only. Validate every request body/query/params with Zod.
- Auth AND authorization checks on every protected endpoint — UI gating is not enough.
- No stack traces in production responses. `.env*` gitignored.

## Git baseline (always)
- Conventional commits: `<type>: <imperative>` (≤72 chars). One concern per commit.
- PR title ≤70 chars; body = *why* bullets + test-plan checklist.
- Analyze full `git diff <base>...HEAD` when writing PR descriptions.
- Never force-push main. Never `--no-verify`.

---

## Forced library stack — no exceptions
- **UI:** react ^18 + typescript ^5 (.tsx/.ts only)
- **Routing:** react-router-dom v6
- **Global state:** zustand (no Redux, no MobX, no Context for state)
- **Server state:** @tanstack/react-query (not the old `react-query` package)
- **Styling:** tailwindcss + shadcn/ui (no styled-components, no @emotion, no CSS modules)
- **Forms:** react-hook-form + zod + @hookform/resolvers
- **HTTP:** axios, inside service functions — never call axios directly in a component
- **Testing:** vitest + @testing-library/react + msw
- **Build:** vite

## Absolute rules
- Function components only. No class components.
- Named exports only. No `export default` for components.
- No `any` — use `unknown` and narrow.
- No inline `style={{}}` — Tailwind classes only.
- Props always have an explicit `ComponentNameProps` interface.
- All API calls go through `src/services/` — never axios in components.
- Server state lives in React Query. Never duplicate it in Zustand.
- Features do not import from other features. Share via `src/components/`, `src/hooks/`, `src/stores/`.

## Folder structure
```
src/
├── components/ui/          shadcn primitives — never edit
├── components/common/      shared app components
├── features/[name]/        components/ hooks/ stores/ services/ types.ts index.ts
├── pages/                  thin route wrappers only — no business logic
├── hooks/                  shared custom hooks (use* prefix)
├── stores/                 global Zustand stores
├── services/               api.ts (axios instance) + per-domain files
├── lib/                    third-party setup
├── types/                  global TS types
└── utils/                  pure functions, no side effects
```

## Component rules (applies when editing src/components/** or src/features/**/components/**)
- Keep components under 150 lines. Split if larger.
- One component per file, named `ComponentName.tsx`.
- Destructure props at the function signature level.
- Always handle `isLoading`, `isError`, and empty states explicitly.
- Lazy-load pages: `React.lazy` + `Suspense` with a skeleton fallback.

## Service layer rules (applies when editing src/services/** or src/features/**/services/**)
- Service functions are plain async functions — not hooks.
- Always type the return value explicitly.
- One file per domain: `users.ts`, `products.ts`.
- Shared axios instance in `src/services/api.ts` only.

## State rules
- Component-local state → `useState` / `useReducer`
- Shared UI state → Zustand (no server data in Zustand)
- Server data → React Query with explicit `staleTime`
- `queryKey` arrays must be fully descriptive: `['users', userId, 'posts']`

## Security rules (applies when editing src/services/** or src/lib/**)
- Never store JWT tokens in `localStorage` — use httpOnly cookies or in-memory
- Never log tokens, passwords, or PII to console
- Validate all mutation payloads with Zod before sending to the API
- No `dangerouslySetInnerHTML` without DOMPurify sanitisation
- Never put secrets in `VITE_`-prefixed env vars — they are public
- Document every env var in `.env.example`, never commit `.env`

## Testing rules (applies when editing **/*.test.* or **/*.spec.*)
- Test behaviour, not implementation details
- Query by role first (`getByRole`), then label, then text
- Use `userEvent` over `fireEvent`
- Always `await` async interactions
- MSW handlers in `src/test/handlers.ts`, reset in `afterEach`

## Backend rules (applies when editing SQL, migrations, src/services/**, server/**, api/**)
- Postgres types: `timestamptz` not `timestamp`; `numeric` for money; `text` not `varchar(n)`; `jsonb` not `json`.
- Every hot-path `WHERE`/`JOIN`/`ORDER BY` column indexed; composite indexes equality-first.
- RLS enabled on every user-data table (Supabase / multi-tenant PG); default-deny policies.
- Migration safety: non-null on large tables = add nullable → backfill → add NOT NULL. Drops are two-phase.
- API layering: route → controller → service → repository → db. No layer-skipping.
- All handler input validated with Zod; return 400 with flattened errors, never raw stack traces.

## Available skills (invoke with $skill-name or describe your intent)
- `$create-component` — scaffold a React component
- `$create-feature` — scaffold a full feature slice
- `$create-page` — scaffold a lazy-loaded page + route
- `$create-service` — scaffold a service function + React Query hook
- `$security-review` — audit code for security issues
- `$refactor` — clean up and improve existing code
- `$postgres-review` — review SQL, migrations, indexes, RLS
- `$context-budget` — audit token consumption across loaded rules/skills
- `$git-commit` — craft clean commits and PR descriptions
