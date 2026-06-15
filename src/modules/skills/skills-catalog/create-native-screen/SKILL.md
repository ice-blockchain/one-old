---
name: create-native-screen
description: >
  Use PROACTIVELY
  only when the user explicitly asks to create, add, or build a React Native /
  Expo screen, Expo Router route, RN tab, stack screen, modal route, or
  deep-linkable native page.
  Triggers: "React Native screen",
  "Expo route", "Expo Router screen", "RN tab", "React Native stack route".
---

# Skill: Create Native Screen

Use this for explicit Expo Router route work.

Before creating files, state:
1. Route file under `apps/mobile/app/` and resulting route path.
2. Named feature/components the route will compose.
3. Route params and the zod validation/normalization needed.
4. Loading/error/empty states owned by the screen.
5. Design brief and required states: see `rules/frontend/ui-quality.md` (design brief/states), including safe-area/keyboard and dynamic-type constraints.
6. RNTL or Maestro coverage for the route, if user-facing.
7. Visual QA plan: small phone and large device screenshots, plus loading/empty/error/focused states where practical.

i18n module detection, `<Trans>` vs `t()` preference, and the hardcoded-strings exception are owned by the `i18n-text` skill (auto-applied to generated/changed UI). Follow it for copy — do not restate the rules here.

Scaffold rules:
- Expo Router route files may use `export default`; reusable components must use named exports.
- Keep route files thin: navigation, param parsing, safe-area/status-bar concerns, and composition only.
- Use typed routes and absolute hrefs.
- Never pass full server entities through route params.
- Validate deep-link/native-intent params before use.
- Screens must feel native and one-handed: primary actions reachable, text readable without fixed-height clipping, and no desktop-first card grids.
