---
paths:
  - "src/pages/**"
  - "src/components/**"
  - "src/features/**/components/**"
---

# Performance Rules

## Code splitting
- Every page is lazy-loaded: `const Page = React.lazy(() => import('./Page'))`.
- Wrap lazy pages with `<Suspense fallback={<PageSkeleton />}>` in the router.
- Heavy third-party libs (charts, editors, PDF renderers) are dynamic-imported at the usage site.

## Renders
- Never create objects or arrays inline in JSX props — extract to `useMemo` or module-level const.
- Never define functions inline in JSX props that will be passed to memoised children — use `useCallback`.
- Zustand: subscribe to slices (`useStore(s => s.field)`), never the whole store object.
- React Query: use `select` to return only the data the component needs.

## Images & assets
- All images have explicit `width` and `height` to prevent layout shift.
- Use `loading="lazy"` on below-the-fold images.
- SVGs used as icons are inlined as React components (vite-plugin-svgr), not `<img>` tags.

## Bundle
- Analyse with `vite-bundle-visualizer` before each release.
- Keep initial JS bundle under 200 KB gzipped.
- Tree-shake: import named exports, never `import _ from 'lodash'`.
