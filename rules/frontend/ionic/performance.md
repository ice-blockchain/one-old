---
paths:
  - "apps/**/src/**"
  - "src/**"
  - "capacitor.config.*"
  - "apps/**/capacitor.config.*"
---

# Ionic Performance Rules

React and frontend performance budgets still apply. Capacitor adds WebView and
native-startup constraints.

## Startup

- Keep the initial route lean; lazy-load page-level code and heavy plugins.
- Avoid blocking startup on native plugin calls. Show explicit loading states
  and defer non-critical checks.
- Preload the next likely route on hover/focus/touch intent where useful.

## WebView runtime

- Test on at least one real or emulated iOS/Android target before calling a
  mobile package ready.
- Avoid large fixed-position repaint areas and expensive scroll listeners.
- Batch high-rate real-time updates with the existing frame-budget rules.
- Use native plugin APIs sparingly and cache stable capability checks.

## Assets

- Size splash, icon, and primary media for target densities.
- Lazy-load below-the-fold images and media.
- Do not ship desktop-only assets into the mobile critical path.
