---
paths:
  - "apps/**/src/**"
  - "web/**/src/**"
  - "frontend/**/src/**"
  - "client/**/src/**"
  - "packages/**/src/**"
  - "src/**"
  - "capacitor.config.*"
  - "apps/**/capacitor.config.*"
---

# Ionic Performance Rules

The selected web profile's performance budgets still apply. Capacitor adds
WebView and native-startup constraints.

## Performance and WebView standard

- Verify the native package with the configured emulator/device adapter.
- When the compiled verification contract marks the hybrid web surface
  `behavioral` or `visual`, also verify its built preview with Playwright.
- Run Lighthouse only when the compiled performance contract requires it.
  Native smoke evidence and Lighthouse evidence are separate and neither may
  impersonate the other.

## Startup

- Keep the initial route lean; lazy-load page-level code and heavy plugins.
- Avoid blocking startup on native plugin calls. Show explicit loading states
  and defer non-critical checks.
- Preload the next likely route on hover/focus/touch intent where useful.

## WebView runtime

- Test on at least one real or emulated iOS/Android target before calling a
  mobile package ready.
- Avoid large fixed-position repaint areas and expensive scroll listeners.
- The high-rate / 30 fps real-time render budget lives in
  `rules/frontend/performance.md`.
- Use native plugin APIs sparingly and cache stable capability checks.

## Assets

- Size splash, icon, and primary media for target densities.
- Lazy-load below-the-fold images and media.
- Do not ship desktop-only assets into the mobile critical path.
- Reserve image/video dimensions and defer non-critical media so WebView startup
  and any contract-required performance audit stay within target.
