---
paths:
  - "apps/**/src/**"
  - "packages/ui/**"
  - "src/**"
---

# Frontend Performance — framework-agnostic

Hard floors that apply to any browser app. React-specific hooks/memoisation rules
live in `frontend/react/performance.md`.

## Lighthouse standard

- Default launch standard: Lighthouse Performance >= 90 on mobile against a
  built production preview, with 100 as the ideal.
- Use the Traffic One runner by default for React/Vite and Ionic web routes:
  `node ~/.traffic-one/bin/lighthouse-runner.cjs --route /`.
  The runner builds the app, starts production preview, runs Lighthouse mobile,
  writes JSON/HTML reports under `.traffic-one/reports/lighthouse/`, and exits
  non-zero below the default thresholds.
- Run the audit for the primary generated route and any route whose above-the-fold content, media, or third-party scripts changed.
- Use Lighthouse findings to fix avoidable page-speed regressions before delivery.
- If Lighthouse cannot be run, report page speed as unverified and list concrete risks such as heavy initial JS, unoptimized media, blocking fonts, third-party scripts, or layout shifts.

## Web Vitals targets (4G mid-range device)

| Metric | Target |
|---|---|
| LCP — Largest Contentful Paint | ≤ 2.5 s |
| FCP — First Contentful Paint | ≤ 1.5 s |
| INP — Interaction to Next Paint | ≤ 200 ms |
| TBT — Total Blocking Time | ≤ 200 ms |
| CLS — Cumulative Layout Shift | ≤ 0.1 |
| TTFB — Time to First Byte | ≤ 800 ms |

Wire `web-vitals` and ship to your observability backend. Alert on regressions
per route. Prefer CrUX/RUM field data for launch decisions; if the property has
no field data yet, mark Core Web Vitals field evidence `UNVERIFIED` instead of
claiming it passed.

## Bundle budgets (initial, gzipped)

- Critical path: ≤ 180 KB
- Per-route chunk: ≤ 80 KB
- Page-type ceilings are upper bounds, and the stricter route budget wins:
  - Marketing / landing / brochure page: ≤ 160 KB initial JS
  - Content microsite or SEO page: ≤ 120 KB initial JS
  - Authenticated app shell / dashboard: ≤ 220 KB initial JS, with heavy tools
    split into route-level chunks
  - Specialist heavy routes (charts, maps, editors, 3D, video) must lazy-load
    the heavy library at the usage site and document the reason if over budget
- Keep each generated route inside its budget before declaring page-speed work complete.

Analyse before every release with a bundle visualiser. Fail CI when over budget.

## Code splitting & loading

- Lazy-load routes; split heavy non-critical libs (3D, video, charts, PDF, editors) at usage site.
- Preload the next probable route on hover/focus.
- `<link rel="modulepreload">` for critical chunks identified via Lighthouse.
- `<link rel="preconnect">` to API and CDN origins.
- Load third-party scripts with `async`/`defer`, only on pages that actually need them, and never in the root bundle for a route-specific feature.

## Tree-shaking

- Always import named exports (`import { debounce } from "lodash-es"`), never default imports of huge libs.
- Mark side-effect-free packages with `"sideEffects": false`.
- Dedup deps across the workspace (pnpm + Turborepo).

## Images & media

- All images have explicit `width` and `height` (prevents CLS).
- The primary hero image/media may use `loading="eager"` and `fetchpriority="high"`; do not apply that broadly.
- `loading="lazy"` and `decoding="async"` on below-the-fold images.
- Modern formats: AVIF/WebP with fallback. Pre-compress at build time.
- Do not ship oversized source images; resize to the maximum rendered breakpoint before committing assets.
- SVG icons: inline as code (no extra HTTP round-trips); larger SVGs as files.
- Video: `preload="metadata"` unless you need eager playback.

## Fonts

- Use at most two font families unless the product direction clearly requires more.
- `font-display: swap`. Preload only the primary critical weight/style.
- Subset to used glyphs.
- Self-host where possible; otherwise `<link rel="preconnect" crossorigin>` to the CDN.
- Avoid font choices that require many weights or external blocking requests just to make the first screen work.

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
