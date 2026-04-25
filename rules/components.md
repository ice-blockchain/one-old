---
paths:
  - "apps/**/src/components/**"
  - "apps/**/src/features/**/components/**"
  - "packages/ui/**"
  - "src/components/**"
  - "src/features/**/components/**"
---

# Component Rules

## Structure
- One component per file, file named `ComponentName.tsx`.
- Co-locate styles: `ComponentName.tsx` + `ComponentName.css.ts` (vanilla-extract).
- Co-locate stories: `ComponentName.stories.tsx` for shared/reusable components in `packages/ui` and key app components.
- Components <150 lines; split into sub-components if larger.
- Named exports only — no `export default`.

## Props & types
- Always declare an explicit `ComponentNameProps` interface above the component.
- Destructure props at the function signature level.
- Discriminated unions over boolean flags + optional fields (`{ kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; error: Error }`).
- Forward `ref` for DOM-wrapping primitives (`Button`, `Input`) using `React.forwardRef`.

## Rendering & data
- If the component fetches data, extract into a `useComponentName` hook — keep the component presentational.
- Always handle `isLoading`, `isError`, and empty states explicitly — never render undefined data.
- Subscribe to real-time streams via a hook (e.g. `useGameTick(gameId)`) — components never instantiate WebSocket connections.
- Lazy-load page-level components: `React.lazy` + `Suspense` with a skeleton fallback.

## Performance
- `React.memo` only after a profiled render bottleneck — not preemptively.
- `useCallback` for stable callbacks passed to memoized children.
- `useMemo` for expensive computations only — measured, not assumed.
- Virtualize long lists (`@tanstack/react-virtual`) above ~100 items.
- Avoid prop drilling more than 2 levels — lift to a Redux slice or zustand store.

## Styling (vanilla-extract)
- Define every style in a sibling `.css.ts` file using `style({})` or `recipe({})`.
- Pull all design values from `@app/design-tokens` — never hardcode colours, spacing, font sizes, or radii.
- Themes via `createTheme` + `themeContract`; light/dark expressed as theme variants.
- Responsive: `@media` queries inside the `.css.ts` — no JS-driven media checks for layout.

## Accessibility
- Semantic HTML first. Buttons render `<button>`, links render `<a>`.
- Every interactive element keyboard-reachable; focus styles must be visible.
- Modals trap focus and restore on close; use `role="dialog"` + `aria-labelledby`.
- Form inputs paired with `<label htmlFor>`; errors announced via `aria-describedby`.
- Live regions for real-time updates: `aria-live="polite"` for non-critical, `"assertive"` for urgent.

## Stories (Storybook)
- Every shared `packages/ui` component has at minimum: default, all variants, loading, error, empty states.
- Use Controls for prop fiddling, not separate stories per prop value.
- Mock real-time subscriptions and HTTP via msw at the story level.
