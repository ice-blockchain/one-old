---
name: create-native-screen
description: >
  Prerequisite: do not read, invoke, or activate this skill during Traffic One
  new-project onboarding. Use `detect-project` / `stack-setup` first, then use
  this skill only after `.traffic-one/.one.json` has `onboardingComplete: true` and
  `.traffic-one/plan.md` exists. Once onboarding is resolved, use PROACTIVELY
  only when the user explicitly asks to create, add, or build a React Native /
  Expo screen, Expo Router route, RN tab, stack screen, modal route, or
  deep-linkable native page.
  Triggers: "React Native screen",
  "Expo route", "Expo Router screen", "RN tab", "React Native stack route".
---

# Skill: Create Native Screen

Traffic One onboarding guard: Do not read, invoke, or activate during Traffic One new-project
onboarding before `.traffic-one/.one.json` has `onboardingComplete: true` and
`.traffic-one/plan.md` exists. Use `detect-project` / `stack-setup` first, then
return here after the stack, mobile, code graph, and team gates are resolved.

Use this for explicit Expo Router route work.

Before creating files, state:
1. Route file under `apps/mobile/app/` and resulting route path.
2. Named feature/components the route will compose.
3. Route params and the zod validation/normalization needed.
4. Loading/error/empty states owned by the screen.
5. Native design brief: target user, primary task, first-screen hierarchy, CTA placement, visual direction, safe-area/keyboard needs, and dynamic type constraints.
6. RNTL or Maestro coverage for the route, if user-facing.
7. i18n namespace/key pattern and catalog location in `packages/i18n`.
8. Translation consumption: `useTranslation`, `t`, or `<Trans>`.
9. Visual QA plan: small phone and large device screenshots, plus loading/empty/error/focused states where practical.

Scaffold rules:
- Expo Router route files may use `export default`; reusable components must use named exports.
- Keep route files thin: navigation, param parsing, safe-area/status-bar concerns, and composition only.
- Use typed routes and absolute hrefs.
- Never pass full server entities through route params.
- Validate deep-link/native-intent params before use.
- Screen titles, tab labels, empty/loading/error copy, accessibility labels, and placeholders use translation keys.
- Hardcoded UI strings are allowed only for brand names, user-generated/server-provided content, technical IDs, and test fixtures.
- Screens must feel native and one-handed: primary actions reachable, text readable without fixed-height clipping, and no desktop-first card grids.
