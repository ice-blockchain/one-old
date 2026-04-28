---
paths:
  - "apps/**/src/components/**"
  - "apps/**/src/features/**/components/**"
  - "packages/ui/**"
  - "src/components/**"
  - "src/features/**/components/**"
---

# React Component Rules

Framework-agnostic accessibility and styling rules live in `frontend/accessibility.md`.
Performance hooks (`React.memo`, `useCallback`) live in `frontend/react/performance.md`.

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
- Render all user-facing copy through `react-i18next` translation keys, including labels, placeholders, alt text, ARIA labels, loading/error/empty states, and button text.
- Keep translation catalogs in `packages/i18n` by default, using feature-based namespaces; use `<Trans>` when copy contains React elements or links.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
- Subscribe to real-time streams via a hook (e.g. `useGameTick(gameId)`) — components never instantiate WebSocket connections.
- Lazy-load page-level components: `React.lazy` + `Suspense` with a skeleton fallback.

## Styling (vanilla-extract)
- Define every style in a sibling `.css.ts` file using `style({})` or `recipe({})`.
- Pull all design values from `@app/design-tokens` — never hardcode colours, spacing, font sizes, or radii.
- Themes via `createTheme` + `themeContract`; light/dark expressed as theme variants.
- Responsive: `@media` queries inside the `.css.ts` — no JS-driven media checks for layout.

## Stories (Storybook)
- Every shared `packages/ui` component has at minimum: default, all variants, loading, error, empty states.
- Use Controls for prop fiddling, not separate stories per prop value.
- Mock real-time subscriptions and HTTP via msw at the story level.
