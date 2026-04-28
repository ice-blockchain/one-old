---
name: create-native-screen
description: >
  Use PROACTIVELY whenever the user asks to create, add, or build a React Native screen,
  Expo Router route, mobile view, tab, stack screen, modal route, or deep-linkable native page.
  Triggers: "create a native screen", "add an Expo route", "new mobile screen",
  "build the [name] screen", "add a tab", "add a stack route".
---

# Skill: Create Native Screen

Use this for Expo Router route work.

Before creating files, state:
1. Route file under `apps/mobile/app/` and resulting route path.
2. Named feature/components the route will compose.
3. Route params and the zod validation/normalization needed.
4. Loading/error/empty states owned by the screen.
5. RNTL or Maestro coverage for the route, if user-facing.

Scaffold rules:
- Expo Router route files may use `export default`; reusable components must use named exports.
- Keep route files thin: navigation, param parsing, safe-area/status-bar concerns, and composition only.
- Use typed routes and absolute hrefs.
- Never pass full server entities through route params.
- Validate deep-link/native-intent params before use.
