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

# Performance Rules

Real-time UIs degrade fastest under (1) too much render churn, (2) bloated initial bundles, (3) network or socket back-pressure. Address each layer.

## Code splitting & loading

- Every page is lazy-loaded: `const Page = React.lazy(() => import("./Page"))`.
- Lazy pages wrapped in `<Suspense fallback={<PageSkeleton />}>` at the router level.
- Heavy third-party libs (3D, video, charts, PDF, editors) are dynamic-imported at the usage site, not at module top.
- Preload the next probable route on hover/focus: `<Link onPointerEnter={() => preload()}>`.
- Use `<link rel="modulepreload">` for critical chunks identified via Lighthouse.

## Renders

- Never create objects or arrays inline in JSX props — `useMemo` or module-level const.
- Never define functions inline as props to memoised children — `useCallback`.
- Subscribe narrowly: `useAppSelector(s => s.game.phase)` not the whole state slice.
- zustand: select slices, not the store object.
- RTK Query: use `selectFromResult` to project only the fields the component needs.
- Virtualise lists above ~100 items (`@tanstack/react-virtual`).
- Profile with React DevTools Profiler before adding `memo` / `useMemo` — measure, don't guess.

## Real-time render budget

- Cap re-renders triggered by WebSocket frames at ~30 fps for non-game UIs (60 fps only for game canvases).
- Batch WS-driven dispatches via `requestAnimationFrame` or a tick aggregator — never dispatch on every frame for high-rate streams (>10 Hz).
- Use `startTransition` for non-urgent updates (e.g. updating a leaderboard while user is interacting).

## Images & assets

- All images have explicit `width` and `height` to prevent layout shift.
- `loading="lazy"` and `decoding="async"` on below-the-fold images.
- SVG icons inlined as React components (`@svgr/rollup`/`vite-plugin-svgr`); larger SVGs as files.
- Modern formats: AVIF/WebP with fallback. Pre-compress at build time.
- Fonts: `font-display: swap`, preload the primary weight, subset to used glyphs.

## Bundle

- Per-app bundle budget (initial, gzipped):
  - Critical path: ≤ 180 KB
  - Per route chunk: ≤ 80 KB
- Analyse before every release: `vite-bundle-visualizer` or `rollup-plugin-visualizer`.
- Tree-shake aggressively:
  - Always import named exports (`import { debounce } from "lodash-es"`, never `import _ from "lodash"`).
  - Mark side-effect-free packages with `"sideEffects": false`.
- vanilla-extract is build-time CSS — no runtime style cost.
- Dedup deps across the monorepo via Turborepo + pnpm.

## Web Vitals targets

- LCP ≤ 2.5 s on 4G mid-range device
- INP ≤ 200 ms
- CLS ≤ 0.1
- TTFB ≤ 800 ms

Wire up `web-vitals` and ship to your observability backend; alert on regressions per route.

## Defensive UI under degraded network

- Show a "reconnecting…" banner when the WS service signals disconnect.
- Keep last-known-good values rendered; mark them stale (`opacity` + `aria-busy="true"`).
- Disable optimistic actions that depend on a live socket; queue them and replay on reconnect (or surface as failed).
