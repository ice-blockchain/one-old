---
paths:
  - "apps/**/src/pages/**"
  - "apps/**/src/components/**"
  - "apps/**/src/features/**/components/**"
  - "packages/ui/**"
  - "src/pages/**"
  - "src/components/**"
  - "src/features/**/components/**"
---

# React Performance Rules

Framework-agnostic perf rules (Web Vitals, bundle budgets, image/font handling, frame
batching) live in `frontend/performance.md`. This file covers React-specific patterns.

## Code splitting (React)

- Every page is lazy-loaded: `const Page = React.lazy(() => import("./Page"))`.
- Lazy pages wrapped in `<Suspense fallback={<PageSkeleton />}>` at the router level.
- Heavy third-party libs (3D, video, charts, PDF, editors) are dynamic-imported at the usage site, not at module top.
- Preload the next probable route on hover/focus: `<Link onPointerEnter={() => preload()}>`.
- Do not import route-only components, charting, maps, editors, 3D, video, analytics widgets, or demo data in `main.tsx`, `App.tsx`, store setup, or shared layout shells.
- Keep above-the-fold route data and media lean enough to maximize mobile Lighthouse Performance on a built preview.

## Renders

- Never create objects or arrays inline in JSX props — `useMemo` or module-level const.
- Never define functions inline as props to memoised children — `useCallback`.
- Subscribe narrowly: `useAppSelector(s => s.game.phase)` not the whole state slice.
- zustand: select slices, not the store object.
- RTK Query: use `selectFromResult` to project only the fields the component needs.
- Virtualise lists above ~100 items (`@tanstack/react-virtual`).
- Keep expensive sorting/filtering/formatting out of render paths; derive it in selectors, RTK Query transforms, or memoized hooks after profiling.
- Profile with React DevTools Profiler before adding `memo` / `useMemo` — measure, don't guess.

## Real-time render budget (React-side, canonical)

- Cap re-renders triggered by streamed frames: ~30 fps for normal UI, 60 fps only for game canvases.
- Batch high-rate updates (>10 Hz) via `requestAnimationFrame` or a tick aggregator hook — never re-render per frame, and never dispatch direct in the bridge.
- Drop oldest non-critical frames when the buffer grows past threshold.
- Use `startTransition` for non-urgent updates (e.g. updating a leaderboard while the user is interacting).

## Hooks discipline

- Custom hooks named `useThing`. One responsibility per hook.
- `useEffect` dependencies: list everything used; never `// eslint-disable-next-line`.
- Cleanup every effect that subscribes (event listeners, timers, sockets).
- Prefer `useSyncExternalStore` for external mutable sources (zustand and Redux already implement this internally).
