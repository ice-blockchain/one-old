---
paths:
  - "apps/**/src/**"
  - "packages/ui/**"
  - "src/**"
---

# Frontend Performance — framework-agnostic

Hard floors that apply to any browser app. React-specific hooks/memoisation rules
live in `frontend/react/performance.md`.

## Web Vitals targets (4G mid-range device)

| Metric | Target |
|---|---|
| LCP — Largest Contentful Paint | ≤ 2.5 s |
| FCP — First Contentful Paint | ≤ 1.5 s |
| INP — Interaction to Next Paint | ≤ 200 ms |
| TBT — Total Blocking Time | ≤ 200 ms |
| CLS — Cumulative Layout Shift | ≤ 0.1 |
| TTFB — Time to First Byte | ≤ 800 ms |

Wire `web-vitals` and ship to your observability backend. Alert on regressions per route.

## Bundle budgets (initial, gzipped)

- Critical path: ≤ 180 KB
- Per-route chunk: ≤ 80 KB

Analyse before every release with a bundle visualiser. Fail CI when over budget.

## Code splitting & loading

- Lazy-load routes; split heavy non-critical libs (3D, video, charts, PDF, editors) at usage site.
- Preload the next probable route on hover/focus.
- `<link rel="modulepreload">` for critical chunks identified via Lighthouse.
- `<link rel="preconnect">` to API and CDN origins.
- Load third-party scripts with `async`/`defer` and only on pages that actually need them.

## Tree-shaking

- Always import named exports (`import { debounce } from "lodash-es"`), never default imports of huge libs.
- Mark side-effect-free packages with `"sideEffects": false`.
- Dedup deps across the workspace (pnpm + Turborepo).

## Images & media

- All images have explicit `width` and `height` (prevents CLS).
- The primary hero image/media may use `loading="eager"` and `fetchpriority="high"`; do not apply that broadly.
- `loading="lazy"` and `decoding="async"` on below-the-fold images.
- Modern formats: AVIF/WebP with fallback. Pre-compress at build time.
- SVG icons: inline as code (no extra HTTP round-trips); larger SVGs as files.
- Video: `preload="metadata"` unless you need eager playback.

## Fonts

- Use at most two font families unless the product direction clearly requires more.
- `font-display: swap`. Preload only the primary critical weight/style.
- Subset to used glyphs.
- Self-host where possible; otherwise `<link rel="preconnect" crossorigin>` to the CDN.

## Animation performance

- Animate compositor-friendly properties (`transform`, `opacity`, `clip-path`, `filter` sparingly).
- Avoid animating layout-bound properties (`width`, `height`, `top`, `left`, `margin`, `padding`, `font-size`).
- Use `will-change` narrowly for active transitions only; remove it when the animation finishes.
- Prefer CSS for simple transitions; use `requestAnimationFrame` or the approved animation library for JS motion.

## Real-time render budget

- Cap re-renders triggered by streamed frames: ~30 fps for normal UI, 60 fps only for game canvases.
- Batch high-rate updates (>10 Hz) via `requestAnimationFrame` or a tick aggregator — never re-render per frame.
- Drop oldest non-critical frames when the buffer grows past threshold.

## Defensive UI under degraded network

- Show a "reconnecting…" banner when the live channel signals disconnect.
- Keep last-known-good values rendered; mark them stale with `aria-busy="true"` + reduced opacity.
- Disable optimistic actions that depend on a live socket; queue them and replay on reconnect (or surface as failed).
