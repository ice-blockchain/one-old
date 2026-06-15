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
- Style in-file via Tailwind utility classes; no sibling style files.
- Co-locate stories: `ComponentName.stories.tsx` for shared/reusable components in `packages/ui` and key app components.
- Components <150 lines; split into sub-components if larger.
- Named exports only — no `export default` (shadcn-generated primitives keep their named exports).

## Props & types
- Always declare an explicit `ComponentNameProps` interface above the component.
- Destructure props at the function signature level.
- Discriminated unions over boolean flags + optional fields (`{ kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; error: Error }`).
- Forward `ref` for DOM-wrapping primitives (`Button`, `Input`) using `React.forwardRef`.

## Rendering & data
- If the component fetches data, extract into a `useComponentName` hook — keep the component presentational.
- Always handle `isLoading`, `isError`, and empty states explicitly — never render undefined data.
- Render all user-facing copy through translation keys — see `rules/frontend/i18n.md`.
- Subscribe to real-time streams via a hook (e.g. `useGameTick(gameId)`) — components never instantiate WebSocket connections.
- Lazy-load page-level components: `React.lazy` + `Suspense` with a skeleton fallback.

## Styling
- Styling stack & shadcn composition (Tailwind utilities, `cn()`, `cva`, design tokens, no hardcoded values): see `rules/frontend/react/core.md`. Finish states (hover/focus/active/loading/empty/error) and anti-template guidance: see `rules/frontend/react/design-quality.md`.
- Responsive: Tailwind breakpoints (`sm:` / `md:` / `lg:` / `xl:`) — no JS-driven media checks for layout.
- Dark mode: shadcn's `class` strategy on `<html>` or `<body>`; the same HSL vars get redefined under `.dark` in `globals.css`.

## Stories (Storybook)
- Every shared `packages/ui` component has at minimum: default, all variants, loading, error, empty states.
- Use Controls for prop fiddling, not separate stories per prop value.
- Mock real-time subscriptions and HTTP via msw at the story level.
