---
paths:
  - "src/components/**"
  - "src/features/**/components/**"
---

# Component Rules

- Keep components under 150 lines. Split into sub-components if larger.
- One component per file, file named `ComponentName.tsx`.
- Destructure props at the function signature level.
- Extract complex JSX expressions into named variables above the `return`.
- Wrap pure child components with `React.memo` only when there is a **proven** render bottleneck — not preemptively.
- Memoize stable callbacks passed to children with `useCallback`.
- Memoize expensive calculations with `useMemo`.
- If the component fetches data, extract that into a `useComponentName` hook — keep the component presentational.
- Always handle `isLoading`, `isError`, and empty states explicitly — never render undefined data.
- Lazy-load page-level components: `React.lazy` + `Suspense` with a skeleton fallback.
