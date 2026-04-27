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

## Renders

- Never create objects or arrays inline in JSX props — `useMemo` or module-level const.
- Never define functions inline as props to memoised children — `useCallback`.
- Subscribe narrowly: `useAppSelector(s => s.game.phase)` not the whole state slice.
- zustand: select slices, not the store object.
- RTK Query: use `selectFromResult` to project only the fields the component needs.
- Virtualise lists above ~100 items (`@tanstack/react-virtual`).
- Profile with React DevTools Profiler before adding `memo` / `useMemo` — measure, don't guess.

## Real-time render budget (React-side)

- Apply the framework-agnostic frame-batching rules from `frontend/performance.md`.
- Use `startTransition` for non-urgent updates (e.g. updating a leaderboard while user is interacting).
- Wrap WS-driven setState in a tick aggregator hook, not direct dispatch in the bridge.

## Hooks discipline

- Custom hooks named `useThing`. One responsibility per hook.
- `useEffect` dependencies: list everything used; never `// eslint-disable-next-line`.
- Cleanup every effect that subscribes (event listeners, timers, sockets).
- Prefer `useSyncExternalStore` for external mutable sources (zustand and Redux already implement this internally).
