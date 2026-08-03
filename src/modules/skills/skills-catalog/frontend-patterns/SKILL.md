---
name: frontend-patterns
description: React/Next.js code patterns — component composition, state management (Context/reducer/hooks), data fetching, forms with validation, performance (memoization, virtualization, code splitting), and error boundaries. (Visual design → frontend-design.)
metadata:
  source: everything-claude-code
  source_path: skills/frontend-patterns/SKILL.md
  source_commit: 4e66b2882da9afb9747468b08a253ca2f09c85f3
  adapted_for: traffic-one
---

# Frontend Development Patterns

Modern frontend patterns for React, Next.js, and performant user interfaces.

## Runtime contract first

Activate this skill only for React-family profiles selected by the capability
registry. Read the active `WorkUnitContractV1` and compiled architecture before
choosing files. Keep entrypoints/router shells free of page implementations,
put route targets and features in their compiled modules, and never widen the
allowlist. Nuxt, Laravel Blade/Inertia, and native profiles use their own
framework skills instead.

## When to Activate

- Building React components (composition, props, rendering)
- Managing state (useState, useReducer, Zustand, Context)
- Implementing data fetching (SWR, React Query, server components)
- Optimizing performance (memoization, virtualization, code splitting)
- Working with forms (validation, controlled inputs, Zod schemas)
- Handling client-side routing and navigation
- Building accessible, responsive UI patterns

Each pattern below is name + when-to-use + one anchor snippet. Generate the full
implementation from the snippet; do not copy boilerplate you can write yourself.
Prefer shadcn/Reusables primitives over hand-rolled dialogs, tabs, and dropdowns.

## Component Patterns

- **Composition over inheritance** — split a component into a parent plus named
  sub-parts (`Card` / `CardHeader` / `CardBody`) so callers arrange the pieces.
  Use when a component has optional regions or many layout variants.
- **Compound components** — share state across sub-parts via context (`Tabs`
  holds `activeTab`, `Tab` reads it). Use when sub-parts must coordinate without
  prop-drilling.
- **Render props** — pass a function child that receives loaded state. Use when
  one component owns async/lifecycle logic but callers control the markup.

```typescript
// Compound: parent owns state, children consume via context
const TabsContext = createContext<{ active: string; set: (t: string) => void } | undefined>(undefined)
export function Tabs({ defaultTab, children }: { defaultTab: string; children: React.ReactNode }) {
  const [active, set] = useState(defaultTab)
  return <TabsContext.Provider value={{ active, set }}>{children}</TabsContext.Provider>
}
```

## Custom Hooks

- **`useToggle`** — boolean + memoized toggler. Use for open/closed UI flags.
- **`useDebounce`** — delay a fast-changing value (search input → query). Use to
  throttle expensive effects.
- **`useQuery`-style fetch hook** — data/error/loading + `refetch`. Prefer
  TanStack Query / SWR in real apps; hand-roll only for trivial cases.

```typescript
export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}
```

## State Management

- **`useState`** for local component state; **lift state up** before reaching
  for a store.
- **Context + `useReducer`** — typed actions through a reducer, exposed via a
  provider + a `useX()` hook that throws outside the provider. Use for
  cross-cutting state shared by a subtree without external deps.
- For app-wide/global state prefer **Zustand**; keep Context for low-frequency,
  scoped state to avoid re-render storms.

```typescript
const Ctx = createContext<{ state: State; dispatch: Dispatch<Action> } | undefined>(undefined)
export function useStore() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useStore must be used within Provider')
  return c
}
```

## Data Fetching

- Reach for **TanStack Query** or **SWR** (or RSC/server components in Next.js)
  rather than ad-hoc `useEffect` + `fetch` — they handle caching, dedupe,
  revalidation, and loading/error states for you.
- Co-locate the query with the component that needs it; pass a stable query key.

## Performance Optimization

- **`useMemo`** for expensive derived values; **`useCallback`** for functions
  passed to memoized children; **`React.memo`** for pure presentational
  components. Measure first — do not memoize reflexively.
- **Code splitting** — `lazy()` + `<Suspense>` for heavy/below-the-fold
  components (charts, editors, 3D).
- **Virtualization** — `@tanstack/react-virtual` for long lists so only visible
  rows render.

```typescript
const HeavyChart = lazy(() => import('./HeavyChart'))
// <Suspense fallback={<ChartSkeleton />}><HeavyChart data={data} /></Suspense>
```

## Form Handling

- For non-trivial forms use **React Hook Form + Zod** (`zodResolver`) — schema is
  the single source of truth for types and validation. Hand-roll controlled
  inputs + a `validate()` only for the simplest one-field cases.
- Show field errors inline; disable submit while pending; surface server errors.

```typescript
const schema = z.object({ name: z.string().min(1).max(200), endDate: z.string().min(1) })
const form = useForm({ resolver: zodResolver(schema) })
```

## Error Boundaries

Wrap risky subtrees in a class `ErrorBoundary` (`getDerivedStateFromError` +
`componentDidCatch`) with a styled fallback and a retry. Use at route and
heavy-widget boundaries so one crash does not blank the app.

```typescript
static getDerivedStateFromError(error: Error) { return { hasError: true, error } }
```

## Accessibility & Motion

- Keyboard nav (Arrow/Enter/Escape), focus management (save/restore
  `document.activeElement`, focus-trap modals), correct ARIA roles, and visible
  focus rings are mandatory — see `rules/frontend/accessibility.md`.
- Animation, motion language, and reduced-motion handling are owned by the
  `frontend-design` skill and `rules/frontend/ui-quality.md`.

**Remember**: pick patterns that fit project complexity — do not introduce a
store, reducer, or boundary that has no real caller.
