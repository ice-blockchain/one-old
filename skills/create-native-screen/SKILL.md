---
name: create-native-screen
description: >
  Use PROACTIVELY only when the user explicitly asks to create, add, or build a
  React Native / Expo screen, Expo Router route, RN tab, stack screen, modal
  route, or deep-linkable native page. Triggers: "React Native screen",
  "Expo route", "Expo Router screen", "RN tab", "React Native stack route".
---

# Skill: Create Native Screen

Use this for explicit Expo Router route work.

Before creating files, state:
1. Route file under `apps/mobile/app/` and resulting route path.
2. Named feature/components the route will compose.
3. Route params and the zod validation/normalization needed.
4. Loading/error/empty states owned by the screen.
5. RNTL or Maestro coverage for the route, if user-facing.
6. i18n namespace/key pattern and catalog location in `packages/i18n`.
7. Translation consumption: `useTranslation`, `t`, or `<Trans>`.

Scaffold rules:
- Expo Router route files may use `export default`; reusable components must use named exports.
- Keep route files thin: navigation, param parsing, safe-area/status-bar concerns, and composition only.
- Use typed routes and absolute hrefs.
- Never pass full server entities through route params.
- Validate deep-link/native-intent params before use.
- Screen titles, tab labels, empty/loading/error copy, accessibility labels, and placeholders use translation keys.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
