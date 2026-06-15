---
name: create-native-feature
description: >
  Use PROACTIVELY
  only when the user explicitly asks to create, add, build, or scaffold a React
  Native / Expo feature, RN module, native flow, Redux slice, RTK Query domain,
  or Expo app capability.
  Triggers: "React Native feature",
  "Expo feature", "build the RN module", "React Native CRUD", "Expo app capability".
---

# Skill: Create Native Feature

Use this for explicit Expo/React Native feature slices.

Before creating files, state:
1. Feature folder: `apps/mobile/src/features/<name>/`.
2. Files to create: `types.ts`, `api.ts` or `services/`, `hooks/`, `components/`, optional `slice.ts`, `index.ts`.
3. Route/screen files under `apps/mobile/app/` if the feature needs navigation.
4. API endpoints, schemas, and state ownership: RTK Query, Redux slice, zustand, or local state.
5. Design brief and state coverage: see `rules/frontend/ui-quality.md` (design brief/states), including safe-area/keyboard behavior.
6. Tests: reducer/selector/service unit tests, RNTL integration tests, and Maestro flow when critical.
7. Visual QA plan: small phone and larger device screenshots, plus loading/empty/error/offline states.

i18n module detection, `<Trans>` vs `t()` preference, and the hardcoded-strings exception are owned by the `i18n-text` skill (auto-applied to generated/changed UI). Follow it for copy — do not restate the rules here.

Scaffold rules:
- Server state goes in RTK Query or Redux fed by a WS service.
- UI-only ephemeral state may use zustand.
- Validate external input and responses with zod.
- Do not add native dependencies without the dependency quality gate and Expo Doctor compatibility check.
- Keep route files thin; feature logic lives in the feature folder.
- Keep server state in RTK Query/Redux and design the UI around native scan order, touch targets, and dynamic type instead of desktop layout parity.
